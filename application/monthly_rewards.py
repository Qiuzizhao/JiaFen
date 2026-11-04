"""Account-scoped monthly goals, independent of cumulative reward tiers."""
import re
import json
from datetime import timedelta


def valid_month(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[1-9][0-9]{3}-(0[1-9]|1[0-2])", value)) and '1900-01' <= value <= '9998-12'


def valid_months(value):
    return isinstance(value, list) and len(value) <= 120 and all(valid_month(month) for month in value)


def init_monthly_rewards(db):
    db.execute("""CREATE TABLE IF NOT EXISTS monthly_reward_settings (
        owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        target INTEGER NOT NULL DEFAULT 10 CHECK(target BETWEEN 1 AND 10000),
        start_month TEXT
    )""")
    if 'months' not in {r[1] for r in db.execute('PRAGMA table_info(monthly_reward_settings)')}:
        # NULL retains the previous recurring behavior until the user selects specific months.
        db.execute('ALTER TABLE monthly_reward_settings ADD COLUMN months TEXT')
    cols = {r[1] for r in db.execute('PRAGMA table_info(reward_opportunities)')}
    if 'monthly_period' not in cols:
        db.execute('ALTER TABLE reward_opportunities ADD COLUMN monthly_period TEXT')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS reward_once_per_month '
               'ON reward_opportunities(group_id,monthly_period) WHERE monthly_period IS NOT NULL')


def monthly_settings(db, uid):
    row = db.execute('SELECT enabled,target,start_month,months FROM monthly_reward_settings WHERE owner_id=?', (uid,)).fetchone()
    return {**dict(row), 'enabled': bool(row['enabled']), 'months': json.loads(row['months']) if row['months'] is not None else None} if row else {'enabled': False, 'target': 10, 'start_month': None, 'months': None}


def record_monthly_rewards(db, uid, now, gids=None, periods=None, reconcile=False):
    settings = monthly_settings(db, uid)
    if not settings['enabled']:
        return
    current = now.strftime('%Y-%m')
    selected = settings['months']
    candidates = selected if reconcile and selected is not None else (periods or [current])
    for month in sorted(set(candidates)):
        if month > current:
            continue
        if selected is not None:
            if month not in selected:
                continue
        elif not settings['start_month'] or month < settings['start_month']:
            continue
        _record_month(db, uid, now, month, settings['target'], gids)


def _record_month(db, uid, now, month, target, gids):
    year, number = map(int, month.split('-'))
    start = now.replace(year=year, month=number, day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    params = [uid, start.strftime('%Y-%m-%d %H:%M:%S'), end.strftime('%Y-%m-%d %H:%M:%S')]
    group_filter = ''
    if gids is not None:
        if not gids:
            return
        group_filter = ' AND m.group_id IN (' + ','.join('?' for _ in gids) + ')'
        params.extend(gids)
    rows = db.execute('SELECT m.group_id,SUM(m.delta) AS score FROM monthly_score_entries m '
                      'JOIN groups g ON g.id=m.group_id JOIN classes c ON c.id=g.class_id '
                      'WHERE m.owner_id=? AND c.owner_id=m.owner_id AND m.voided_at IS NULL '
                      'AND m.occurred_at>=? AND m.occurred_at<?' + group_filter +
                      ' GROUP BY m.group_id HAVING SUM(m.delta)>=?', params + [target]).fetchall()
    for row in rows:
        # A separate month key prevents duplicate awards after undo, toggles or target edits.
        db.execute("INSERT OR IGNORE INTO reward_opportunities "
                   "(group_id,kind,note,monthly_period,created_at) VALUES(?,'manual',?,?,?)",
                   (row['group_id'], f"{month}月目标·{target}分", month, now.strftime('%Y-%m-%d %H:%M:%S')))


def register_monthly_reward_routes(app, get_db, current_user, login_required, now, broadcast):
    from flask import request, jsonify

    @app.route('/api/rewards/monthly-goal', methods=['GET', 'PUT'])
    @login_required
    def monthly_goal():
        db, uid = get_db(), current_user()['id']
        if request.method == 'PUT':
            data = request.get_json(silent=True) or {}
            if type(data.get('enabled')) is not bool or type(data.get('target')) is not int or not 1 <= data['target'] <= 10000:
                return jsonify({'error': '请输入 1 到 10000 之间的整数目标分数'}), 400
            db.execute('BEGIN IMMEDIATE')
            previous = monthly_settings(db, uid)
            months = data.get('months', previous['months'])
            if ('months' in data and not valid_months(months)) or (data['enabled'] and months == []):
                db.rollback()
                return jsonify({'error': '请添加需要计算的月份（最多120个月）'}), 400
            if months is not None:
                months = sorted(set(months))
            start = previous['start_month']
            if data['enabled'] and not previous['enabled']:
                start = now().strftime('%Y-%m')
            db.execute('INSERT INTO monthly_reward_settings(owner_id,enabled,target,start_month,months) VALUES(?,?,?,?,?) '
                       'ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,target=excluded.target,start_month=excluded.start_month,months=excluded.months',
                       (uid, int(data['enabled']), data['target'], start, json.dumps(months) if months is not None else None))
            record_monthly_rewards(db, uid, now(), reconcile=True)
            db.commit()
            broadcast({'kind': 'rewards', 'client': (data.get('client') or '')[:32]})
        return jsonify(monthly_settings(db, uid))
