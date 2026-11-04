"""JF-003: classroom windows and assignments, independent of score/reward values."""
import json
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))
DEFAULT_WINDOW_MINUTES = 120


def stamp(value):
    if not isinstance(value, str):
        raise ValueError("时间无效")
    at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if at.tzinfo:
        at = at.astimezone(BJ)
    return at.strftime("%Y-%m-%d %H:%M:%S")


def init_lessons(db):
    cols = {r[1] for r in db.execute("PRAGMA table_info(monthly_score_entries)")}
    if "reason" not in cols:
        db.execute("ALTER TABLE monthly_score_entries ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE monthly_score_entries ADD COLUMN batch_id TEXT")
        db.execute("UPDATE monthly_score_entries SET reason=COALESCE((SELECT reason FROM transactions WHERE id=transaction_id),''),batch_id=(SELECT batch_id FROM transactions WHERE id=transaction_id)")
    db.executescript("""
        DROP TRIGGER IF EXISTS monthly_transaction_insert;
        CREATE TRIGGER monthly_transaction_insert AFTER INSERT ON transactions BEGIN
            INSERT INTO monthly_score_entries(transaction_id,owner_id,class_id,group_id,delta,occurred_at,reason,batch_id)
            SELECT NEW.id,c.owner_id,NEW.class_id,NEW.group_id,NEW.delta,NEW.created_at,NEW.reason,NEW.batch_id
            FROM classes c WHERE c.id=NEW.class_id;
        END;
        CREATE TABLE IF NOT EXISTS lesson_settings (
            owner_id INTEGER PRIMARY KEY,
            window_minutes INTEGER NOT NULL DEFAULT 120 CHECK(window_minutes BETWEEN 5 AND 360),
            history_seeded INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,class_id INTEGER NOT NULL,
            start_at TEXT NOT NULL,end_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('recognized','review','unknown')),
            source TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
            archived_at TEXT,created_at TEXT NOT NULL,
            CHECK(start_at<end_at)
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_class_time ON lessons(owner_id,class_id,start_at,end_at);
        CREATE TABLE IF NOT EXISTS lesson_entries (
            entry_id INTEGER PRIMARY KEY REFERENCES monthly_score_entries(id),
            lesson_id INTEGER NOT NULL REFERENCES lessons(id)
        );
        CREATE INDEX IF NOT EXISTS idx_lesson_entries_lesson ON lesson_entries(lesson_id,entry_id);
        CREATE TABLE IF NOT EXISTS lesson_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,lesson_id INTEGER NOT NULL,
            action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,at TEXT NOT NULL
        );
    """)
    for user in db.execute("SELECT id FROM users").fetchall():
        uid = user[0]
        db.execute("INSERT OR IGNORE INTO lesson_settings(owner_id) VALUES(?)", (uid,))
        if not db.execute("SELECT history_seeded FROM lesson_settings WHERE owner_id=?", (uid,)).fetchone()[0]:
            seed_history(db, uid)
            db.execute("UPDATE lesson_settings SET history_seeded=1 WHERE owner_id=?", (uid,))
    normalize_automatic_windows(db)


def normalize_automatic_windows(db):
    """Remove legacy fixed-duration guesses; never change manually reviewed windows."""
    for row in db.execute("SELECT * FROM lessons WHERE source='automatic' AND archived_at IS NULL").fetchall():
        bounds = db.execute(
            "SELECT MIN(m.occurred_at),MAX(m.occurred_at) FROM lesson_entries le "
            "JOIN monthly_score_entries m ON m.id=le.entry_id WHERE le.lesson_id=? AND m.voided_at IS NULL",
            (row["id"],)).fetchone()
        if not bounds[0]:
            continue
        start = bounds[0]
        end = (datetime.fromisoformat(bounds[1])+timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
        if start == row["start_at"] and end == row["end_at"]:
            continue
        if db.execute("SELECT 1 FROM lessons WHERE owner_id=? AND class_id=? AND id<>? AND archived_at IS NULL AND start_at<? AND end_at>?",
                      (row["owner_id"],row["class_id"],row["id"],end,start)).fetchone():
            continue
        audit(db,row["id"],row["owner_id"],"normalize_recognition_interval",dict(row),{"start_at":start,"end_at":end})
        db.execute("UPDATE lessons SET start_at=?,end_at=?,revision=revision+1 WHERE id=?", (start,end,row["id"]))


def now_stamp():
    return datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


def audit(db, lesson_id, uid, action, before, after):
    db.execute("INSERT INTO lesson_revisions(owner_id,lesson_id,action,before_json,after_json,at) VALUES(?,?,?,?,?,?)",
               (uid, lesson_id, action, json.dumps(before, ensure_ascii=False),
                json.dumps(after, ensure_ascii=False), now_stamp()))


def new_lesson(db, uid, cid, start, end, source, status="review", note=""):
    cur = db.execute("INSERT INTO lessons(owner_id,class_id,start_at,end_at,status,source,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
                     (uid, cid, start, end, status, source, note, now_stamp()))
    row = dict(db.execute("SELECT * FROM lessons WHERE id=?", (cur.lastrowid,)).fetchone())
    audit(db, cur.lastrowid, uid, "create", {}, row)
    return cur.lastrowid


def seed_history(db, uid):
    """Recognize unassigned history per class, using the same gap as live scoring."""
    setting = db.execute("SELECT window_minutes FROM lesson_settings WHERE owner_id=?", (uid,)).fetchone()
    gap = timedelta(minutes=setting[0] if setting else DEFAULT_WINDOW_MINUTES)
    rows = db.execute(
        "SELECT m.* FROM monthly_score_entries m LEFT JOIN lesson_entries le ON le.entry_id=m.id "
        "WHERE m.owner_id=? AND m.voided_at IS NULL AND le.entry_id IS NULL ORDER BY m.class_id,m.occurred_at,m.id",
        (uid,)).fetchall()
    clusters = []
    for row in rows:
        if not clusters or row["class_id"] != clusters[-1][-1]["class_id"] or (
                datetime.fromisoformat(row["occurred_at"]) - datetime.fromisoformat(clusters[-1][-1]["occurred_at"])) > gap:
            clusters.append([])
        clusters[-1].append(row)
    made = []
    for entries in clusters:
        start = entries[0]["occurred_at"]
        end = (datetime.fromisoformat(entries[-1]["occurred_at"]) + timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
        if db.execute("SELECT 1 FROM lessons WHERE owner_id=? AND class_id=? AND archived_at IS NULL AND start_at<? AND end_at>?",
                      (uid, entries[0]["class_id"], end, start)).fetchone():
            continue
        note = "历史日志自动回溯；时间为记分活动边界，待核对。"
        if len({e["group_id"] for e in entries}) == 1 and sum(e["delta"] for e in entries) == 0 and (
                datetime.fromisoformat(end)-datetime.fromisoformat(start)).total_seconds() <= 121:
            note = "孤立的短时正反记分，疑似测试，待确认；不能据此认定上过课。"
        lid = new_lesson(db, uid, entries[0]["class_id"], start, end, "historical", note=note)
        db.executemany("INSERT INTO lesson_entries(entry_id,lesson_id) VALUES(?,?)", [(e["id"], lid) for e in entries])
        made.append(lid)
    return made


def assign_new_scores(db, transaction_ids):
    for tid in transaction_ids:
        e = db.execute("SELECT * FROM monthly_score_entries WHERE transaction_id=?", (tid,)).fetchone()
        if not e or db.execute("SELECT 1 FROM lesson_entries WHERE entry_id=?", (e["id"],)).fetchone():
            continue
        uid, cid, at = e["owner_id"], e["class_id"], e["occurred_at"]
        db.execute("INSERT OR IGNORE INTO lesson_settings(owner_id,history_seeded) VALUES(?,1)", (uid,))
        row = db.execute("SELECT id FROM lessons WHERE owner_id=? AND class_id=? AND archived_at IS NULL AND start_at<=? AND end_at>? ORDER BY start_at DESC",
                         (uid, cid, at, at)).fetchall()
        if len(row) > 1:
            raise ValueError("课堂时间存在重叠，请先校正")
        if row:
            lid = row[0]["id"]
        else:
            minutes = db.execute("SELECT window_minutes FROM lesson_settings WHERE owner_id=?", (uid,)).fetchone()[0]
            end = (datetime.fromisoformat(at)+timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
            previous = db.execute(
                "SELECT l.*, (SELECT MAX(m.occurred_at) FROM lesson_entries le JOIN monthly_score_entries m ON m.id=le.entry_id "
                "WHERE le.lesson_id=l.id AND m.voided_at IS NULL) AS last_at "
                "FROM lessons l WHERE l.owner_id=? AND l.class_id=? AND l.archived_at IS NULL "
                "AND l.start_at<=? ORDER BY l.start_at DESC LIMIT 1", (uid,cid,at)).fetchone()
            can_extend = bool(previous and previous["last_at"] and
                              (previous["source"] == "automatic" or
                               (previous["source"] == "historical" and previous["status"] == "review")) and
                              0 <= (datetime.fromisoformat(at)-datetime.fromisoformat(previous["last_at"])).total_seconds() <= minutes*60)
            if can_extend:
                can_extend = not db.execute(
                    "SELECT 1 FROM lessons WHERE owner_id=? AND class_id=? AND id<>? AND archived_at IS NULL AND start_at<? AND end_at>?",
                    (uid,cid,previous["id"],end,previous["start_at"])).fetchone()
            if can_extend:
                lid = previous["id"]
                audit(db,lid,uid,"auto_extend_interval",dict(previous),{"end_at":end})
                db.execute("UPDATE lessons SET end_at=?,revision=revision+1 WHERE id=?", (end,lid))
            else:
                lid = new_lesson(db,uid,cid,at,end,"automatic","recognized")
        db.execute("INSERT INTO lesson_entries(entry_id,lesson_id) VALUES(?,?)", (e["id"], lid))
        db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (lid,))


def touch_lesson_records(db, transaction_ids):
    lids = set()
    for tid in transaction_ids:
        row = db.execute("SELECT le.lesson_id FROM lesson_entries le JOIN monthly_score_entries m ON m.id=le.entry_id WHERE m.transaction_id=?", (tid,)).fetchone()
        if row:
            lids.add(row[0])
    for lid in lids:
        db.execute("UPDATE lessons SET revision=revision+1 WHERE id=?", (lid,))


def entries_json(db, uid, cid, start=None, end=None, lid=None):
    where, args = ["m.owner_id=?", "m.class_id=?"], [uid, cid]
    if lid is not None:
        where.append("le.lesson_id=?"); args.append(lid)
    if start is not None:
        where.append("m.occurred_at>=? AND m.occurred_at<?"); args += [start, end]
    return [dict(r) for r in db.execute(
        "SELECT m.*,g.name AS group_name,le.lesson_id FROM monthly_score_entries m "
        "LEFT JOIN groups g ON g.id=m.group_id LEFT JOIN lesson_entries le ON le.entry_id=m.id "
        "WHERE " + " AND ".join(where) + " ORDER BY m.occurred_at,m.id", args)]


def observed_history(db, uid, cid, start, end, entries):
    """Expose unclassified historical state changes as evidence, never as score entries."""
    begin_utc = (datetime.fromisoformat(start) - timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
    end_utc = (datetime.fromisoformat(end) - timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
    rows = db.execute(
        "SELECT h.*, (SELECT p.score FROM ranking_group_history p WHERE p.owner_id=h.owner_id "
        "AND p.group_id=h.group_id AND (p.at<h.at OR (p.at=h.at AND p.id<h.id)) "
        "ORDER BY p.at DESC,p.id DESC LIMIT 1) AS before_score "
        "FROM ranking_group_history h WHERE h.owner_id=? AND h.class_id=? AND h.at>=? AND h.at<? "
        "AND h.active=1 ORDER BY h.at,h.id", (uid, cid, begin_utc, end_utc)).fetchall()
    used, result = set(), []
    for h in rows:
        if h["before_score"] is None:
            continue
        delta = h["score"] - h["before_score"]
        if not delta:
            continue
        at = datetime.fromisoformat(h["at"]) + timedelta(hours=8)
        match = next((e for e in entries if e["id"] not in used and e["group_id"] == h["group_id"]
                      and e["delta"] == delta and 0 <= (at-datetime.fromisoformat(e["occurred_at"])).total_seconds() < 2), None)
        if match:
            used.add(match["id"])
            continue
        result.append({"id": f"history-{h['id']}", "group_id": h["group_id"], "group_name": h["name"],
                       "delta": delta, "occurred_at": at.strftime("%Y-%m-%d %H:%M:%S"),
                       "voided_at": None, "lesson_id": None, "observed_only": True,
                       "reason": "仅有积分状态历史；操作类型未记录，不计入有效积分"})
    return result


def summary(entries, roster=()):
    groups = {g["id"]: {"group_id": g["id"], "name": g["name"], "positive": 0, "negative": 0, "net": 0, "count": 0} for g in roster}
    for e in entries:
        if e["voided_at"]:
            continue
        g = groups.setdefault(e["group_id"], {"group_id": e["group_id"], "name": e["group_name"] or f"小组#{e['group_id']}",
                                              "positive": 0, "negative": 0, "net": 0, "count": 0})
        g["positive"] += max(e["delta"], 0)
        g["negative"] += min(e["delta"], 0)
        g["net"] += e["delta"]; g["count"] += 1
    return {"positive": sum(g["positive"] for g in groups.values()), "negative": sum(g["negative"] for g in groups.values()),
            "net": sum(g["net"] for g in groups.values()), "count": sum(g["count"] for g in groups.values()),
            "groups": list(groups.values())}


def preview_window(db, uid, cid, start, end, exclude=()):
    if start >= end:
        raise ValueError("结束时间须晚于开始时间")
    if datetime.fromisoformat(end)-datetime.fromisoformat(start) > timedelta(days=2):
        raise ValueError("一节课堂最多覆盖两天")
    conflicts = [dict(r) for r in db.execute(
        "SELECT id,start_at,end_at FROM lessons WHERE owner_id=? AND class_id=? AND archived_at IS NULL AND start_at<? AND end_at>?",
        (uid, cid, end, start)) if r["id"] not in exclude]
    entries = entries_json(db, uid, cid, start, end)
    batches = {e["batch_id"] for e in entries if e["batch_id"]}
    split_batches = []
    for batch in batches:
        outside = db.execute("SELECT 1 FROM monthly_score_entries WHERE owner_id=? AND class_id=? AND batch_id=? AND (occurred_at<? OR occurred_at>=?) LIMIT 1",
                             (uid, cid, batch, start, end)).fetchone()
        if outside:
            split_batches.append(batch)
    roster = db.execute("SELECT id,name FROM groups WHERE class_id=? ORDER BY sort_order,id", (cid,)).fetchall()
    return {"entries": entries, "summary": summary(entries, roster), "conflicts": conflicts,
            "split_batches": split_batches, "can_save": not conflicts and not split_batches}


def apply_window(db, lid, uid, cid, start, end):
    preview = preview_window(db, uid, cid, start, end, (lid,))
    if not preview["can_save"]:
        raise ValueError("课堂重叠或全班批次被拆分，请调整边界")
    db.execute("DELETE FROM lesson_entries WHERE lesson_id=?", (lid,))
    db.executemany("INSERT INTO lesson_entries(entry_id,lesson_id) VALUES(?,?) "
                   "ON CONFLICT(entry_id) DO UPDATE SET lesson_id=excluded.lesson_id",
                   [(e["id"], lid) for e in preview["entries"]])
    return preview


def register_lesson_routes(app, get_db, current_user, login_required, own_class, broadcast):
    from flask import request, jsonify

    def owned(lid):
        return get_db().execute("SELECT * FROM lessons WHERE id=? AND owner_id=? AND archived_at IS NULL",
                                (lid, current_user()["id"])).fetchone()

    def detail(row):
        entries = entries_json(get_db(), row["owner_id"], row["class_id"], lid=row["id"])
        roster = get_db().execute("SELECT id,name FROM groups WHERE class_id=? ORDER BY sort_order,id", (row["class_id"],)).fetchall()
        return {**dict(row), "summary": summary(entries, roster), "entries": entries}

    @app.errorhandler(LessonError)
    def lesson_error(error):
        get_db().rollback()
        return jsonify({"error": str(error)}), error.code

    @app.route("/api/lessons/settings", methods=["GET", "PUT"])
    @login_required
    def lesson_settings():
        db, uid = get_db(), current_user()["id"]
        if request.method == "PUT":
            value = (request.get_json(silent=True) or {}).get("window_minutes")
            if type(value) is not int or not 5 <= value <= 360:
                raise LessonError("时间窗口须为5至360分钟")
            db.execute("INSERT INTO lesson_settings(owner_id,window_minutes,history_seeded) VALUES(?,?,1) "
                       "ON CONFLICT(owner_id) DO UPDATE SET window_minutes=excluded.window_minutes", (uid, value))
            db.commit(); broadcast({"kind": "lessons"})
        row = db.execute("SELECT window_minutes FROM lesson_settings WHERE owner_id=?", (uid,)).fetchone()
        return jsonify({"window_minutes": row[0] if row else DEFAULT_WINDOW_MINUTES})

    @app.route("/api/classes/<int:cid>/lessons")
    @login_required
    def list_lessons(cid):
        if not own_class(cid):
            raise LessonError("班级不存在", 404)
        db, uid = get_db(), current_user()["id"]
        month = request.args.get("month", datetime.now(BJ).strftime("%Y-%m"))
        try:
            start = stamp(month + "-01T00:00:00")
            dt = datetime.fromisoformat(start)
            end = dt.replace(year=dt.year+1, month=1) if dt.month == 12 else dt.replace(month=dt.month+1)
            end = end.strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError, OverflowError):
            raise LessonError("月份无效")
        rows = db.execute("SELECT * FROM lessons WHERE owner_id=? AND class_id=? AND archived_at IS NULL AND end_at>? AND start_at<? ORDER BY start_at,id",
                          (uid, cid, start, end)).fetchall()
        items, voided_only = [], 0
        for row in rows:
            item = detail(row)
            if row["source"] == "automatic" and not item["summary"]["count"] and item["entries"]:
                voided_only += 1
            else:
                items.append(item)
        return jsonify({"lessons": items, "voided_only": voided_only,
                        "unassigned": db.execute(
                            "SELECT COUNT(*) FROM monthly_score_entries m LEFT JOIN lesson_entries le ON le.entry_id=m.id WHERE m.owner_id=? AND m.class_id=? AND m.occurred_at>=? AND m.occurred_at<? AND m.voided_at IS NULL AND le.entry_id IS NULL",
                            (uid, cid, start, end)).fetchone()[0]})

    @app.route("/api/lessons/<int:lid>")
    @login_required
    def get_lesson(lid):
        row = owned(lid)
        if not row:
            raise LessonError("课堂不存在", 404)
        return jsonify(detail(row))

    @app.route("/api/classes/<int:cid>/lesson-records")
    @login_required
    def lesson_records(cid):
        if not own_class(cid):
            raise LessonError("班级不存在", 404)
        try:
            start = stamp(request.args.get("start"))
            end = stamp(request.args.get("end"))
            if start >= end or datetime.fromisoformat(end)-datetime.fromisoformat(start) > timedelta(days=62):
                raise ValueError()
        except (ValueError, TypeError):
            raise LessonError("记录范围无效")
        db, uid = get_db(), current_user()["id"]
        entries = entries_json(db, uid, cid, start, end)
        return jsonify(sorted(entries + observed_history(db, uid, cid, start, end, entries),
                              key=lambda e: (e["occurred_at"], str(e["id"]))))

    @app.route("/api/lessons/<int:lid>/preview", methods=["POST"])
    @login_required
    def lesson_preview(lid):
        row = owned(lid)
        if not row:
            raise LessonError("课堂不存在", 404)
        data = request.get_json(silent=True) or {}
        try:
            result = preview_window(get_db(), row["owner_id"], row["class_id"],
                                    stamp(data.get("start_at")), stamp(data.get("end_at")), (lid,))
        except (ValueError, TypeError) as e:
            raise LessonError(str(e))
        result["before"] = detail(row)["summary"]
        return jsonify(result)

    @app.route("/api/classes/<int:cid>/lessons", methods=["POST"])
    @login_required
    def create_manual_lesson(cid):
        if not own_class(cid):
            raise LessonError("班级不存在", 404)
        data = request.get_json(silent=True) or {}
        db, uid = get_db(), current_user()["id"]
        db.execute("BEGIN IMMEDIATE")
        try:
            start, end = stamp(data.get("start_at")), stamp(data.get("end_at"))
            preview = preview_window(db, uid, cid, start, end)
            if not preview["can_save"]:
                raise ValueError("时间与其他课堂重叠，或拆分了全班批次")
            lid = new_lesson(db, uid, cid, start, end, "manual", "recognized", "手动补建")
            apply_window(db, lid, uid, cid, start, end)
        except (ValueError, TypeError) as e:
            raise LessonError(str(e))
        db.commit(); broadcast({"kind": "lessons"})
        return jsonify({"id": lid}), 201

    @app.route("/api/lessons/<int:lid>", methods=["PUT"])
    @login_required
    def save_lesson(lid):
        data, db = request.get_json(silent=True) or {}, get_db()
        db.execute("BEGIN IMMEDIATE")
        row = owned(lid)
        if not row:
            raise LessonError("课堂不存在", 404)
        if data.get("revision") != row["revision"]:
            raise LessonError("课堂已被其他设备修改，请重新打开", 409)
        status = data.get("status", row["status"])
        if status not in ("recognized", "review", "unknown"):
            raise LessonError("课堂状态无效")
        before = detail(row)
        try:
            start, end = stamp(data.get("start_at")), stamp(data.get("end_at"))
            result = apply_window(db, lid, row["owner_id"], row["class_id"], start, end)
        except (ValueError, TypeError) as e:
            raise LessonError(str(e))
        after = {"start_at": start, "end_at": end, "status": status, "summary": result["summary"]}
        audit(db, lid, row["owner_id"], "edit", before, after)
        db.execute("UPDATE lessons SET start_at=?,end_at=?,status=?,source='manual',revision=revision+1 WHERE id=?",
                   (start, end, status, lid))
        db.commit(); broadcast({"kind": "lessons"})
        return jsonify(detail(owned(lid)))

    @app.route("/api/lessons/<int:lid>/split", methods=["POST"])
    @login_required
    def split_lesson(lid):
        db, data = get_db(), request.get_json(silent=True) or {}
        db.execute("BEGIN IMMEDIATE"); row = owned(lid)
        if not row:
            raise LessonError("课堂不存在", 404)
        if data.get("revision") != row["revision"]:
            raise LessonError("课堂已变更，请重新打开", 409)
        try:
            cut = stamp(data.get("at"))
            if not row["start_at"] < cut < row["end_at"]:
                raise ValueError("拆分时间须位于课堂内部")
            for start, end in [(row["start_at"], cut), (cut, row["end_at"])]:
                if not preview_window(db, row["owner_id"], row["class_id"], start, end, (lid,))["can_save"]:
                    raise ValueError("拆分会分开全班批次")
        except (ValueError, TypeError) as e:
            raise LessonError(str(e))
        before = detail(row)
        db.execute("UPDATE lessons SET archived_at=?,revision=revision+1 WHERE id=?", (now_stamp(), lid))
        db.execute("DELETE FROM lesson_entries WHERE lesson_id=?", (lid,))
        ids = []
        for start, end in [(row["start_at"], cut), (cut, row["end_at"])]:
            child = new_lesson(db, row["owner_id"], row["class_id"], start, end, "manual", row["status"], f"拆分自课堂#{lid}")
            apply_window(db, child, row["owner_id"], row["class_id"], start, end); ids.append(child)
        audit(db, lid, row["owner_id"], "split", before, {"children": ids})
        db.commit(); broadcast({"kind": "lessons"})
        return jsonify({"ids": ids})

    @app.route("/api/lessons/<int:lid>/merge", methods=["POST"])
    @login_required
    def merge_lessons(lid):
        db, data = get_db(), request.get_json(silent=True) or {}
        db.execute("BEGIN IMMEDIATE"); row, other = owned(lid), owned(data.get("other_id", 0))
        if not row or not other or lid == other["id"] or row["class_id"] != other["class_id"]:
            raise LessonError("只能合并本班两节不同课堂")
        if data.get("revision") != row["revision"] or data.get("other_revision") != other["revision"]:
            raise LessonError("课堂已变更，请重新打开", 409)
        start, end = min(row["start_at"], other["start_at"]), max(row["end_at"], other["end_at"])
        try:
            result = preview_window(db, row["owner_id"], row["class_id"], start, end, (lid, other["id"]))
            if not result["can_save"]:
                raise ValueError("只能合并相邻课堂，不能覆盖其他课堂或拆分批次")
        except ValueError as e:
            raise LessonError(str(e))
        before = [detail(row), detail(other)]
        db.execute("UPDATE lessons SET archived_at=?,revision=revision+1 WHERE id IN (?,?)", (now_stamp(), lid, other["id"]))
        db.execute("DELETE FROM lesson_entries WHERE lesson_id IN (?,?)", (lid, other["id"]))
        child = new_lesson(db, row["owner_id"], row["class_id"], start, end, "manual",
                           "recognized" if row["status"] == other["status"] == "recognized" else "review",
                           f"合并自课堂#{lid}、#{other['id']}")
        apply_window(db, child, row["owner_id"], row["class_id"], start, end)
        audit(db, child, row["owner_id"], "merge", before, detail(owned(child)))
        db.commit(); broadcast({"kind": "lessons"})
        return jsonify({"id": child})


class LessonError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code
