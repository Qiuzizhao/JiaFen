"""Per-account website settings."""
import re
from datetime import date


def init_app_settings(db):
    db.execute('CREATE TABLE IF NOT EXISTS app_settings ('
               'owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, average_start_date TEXT)')


def account_settings(db, uid):
    row = db.execute('SELECT average_start_date FROM app_settings WHERE owner_id=?', (uid,)).fetchone()
    return dict(row) if row else {'average_start_date': None}


def validate_settings(data):
    if not isinstance(data, dict) or 'average_start_date' not in data:
        raise ValueError('请设置课均统计起始日期')
    value = data['average_start_date']
    if value is None or value == '':
        return {'average_start_date': None}
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        raise ValueError('请选择有效的起始日期')
    try:
        parsed = date.fromisoformat(value)
        if not 1900 <= parsed.year <= 9998:
            raise ValueError()
    except ValueError:
        raise ValueError('请选择1900年至9998年之间的有效日期') from None
    return {'average_start_date': value}


def save_account_settings(db, uid, data):
    db.execute('INSERT INTO app_settings(owner_id,average_start_date) VALUES(?,?) '
               'ON CONFLICT(owner_id) DO UPDATE SET average_start_date=excluded.average_start_date',
               (uid, data['average_start_date']))


def register_settings_routes(app, get_db, current_user, login_required, broadcast):
    from flask import request, jsonify

    @app.route('/api/settings', methods=['GET', 'PUT'])
    @login_required
    def settings():
        db, uid = get_db(), current_user()['id']
        if request.method == 'PUT':
            data = request.get_json(silent=True)
            try:
                settings = validate_settings(data)
            except ValueError as exc:
                return jsonify({'error': str(exc)}), 400
            save_account_settings(db, uid, settings)
            db.commit()
            broadcast({'kind': 'settings', 'client': (data.get('client') or '')[:32]})
        return jsonify(account_settings(db, uid))
