import os
import json
import queue
import sqlite3
import threading
import hmac
from datetime import datetime
from functools import wraps

from flask import Flask, request, jsonify, session, g, Response, send_from_directory


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DB_DIR, "jiafen.db")

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "jiafen123")


app = Flask(__name__, static_folder="static", static_url_path="")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or os.urandom(32).hex()
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA busy_timeout = 5000")
    return db


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#5B9BD5',
            score INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        """
    )
    # 迁移：老库补 sort_order 列，并按原顺序回填
    cols = [r[1] for r in conn.execute("PRAGMA table_info(groups)").fetchall()]
    if "sort_order" not in cols:
        conn.execute("ALTER TABLE groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            """
            UPDATE groups SET sort_order = (
                SELECT COUNT(*) FROM groups g2
                WHERE g2.class_id = groups.class_id AND g2.id <= groups.id
            )
            """
        )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# 实时推送（SSE）：任一设备改动后，在线设备自动刷新
# ---------------------------------------------------------------------------
class EventBroker:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs = set()

    def subscribe(self):
        q = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, event_type, data):
        msg = "event: %s\ndata: %s\n\n" % (event_type, json.dumps(data, ensure_ascii=False))
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


BROKER = EventBroker()


def broadcast():
    BROKER.publish("update", {"time": datetime.now().isoformat()})


@app.route("/api/events")
def stream():
    if not is_authenticated():
        return Response("unauthorized", status=401)
    q = BROKER.subscribe()

    def gen():
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                try:
                    msg = q.get(timeout=1.0)
                    yield msg
                except queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            BROKER.unsubscribe(q)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# 登录鉴权（单管理员）
# ---------------------------------------------------------------------------
def is_authenticated():
    return session.get("authed") is True


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not is_authenticated():
            return jsonify({"error": "未登录"}), 401
        return f(*args, **kwargs)

    return wrapper


@app.route("/api/me")
def me():
    return jsonify({"authed": is_authenticated()})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    pw = data.get("password", "")
    if hmac.compare_digest(pw, ADMIN_PASSWORD):
        session["authed"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "密码错误"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 班级
# ---------------------------------------------------------------------------
@app.route("/api/classes")
@login_required
def list_classes():
    db = get_db()
    classes = db.execute("SELECT * FROM classes ORDER BY id").fetchall()
    result = []
    for c in classes:
        groups = db.execute(
            "SELECT * FROM groups WHERE class_id=? ORDER BY sort_order ASC, id", (c["id"],)
        ).fetchall()
        result.append({**dict(c), "groups": [dict(g) for g in groups]})
    return jsonify(result)


@app.route("/api/classes", methods=["POST"])
@login_required
def create_class():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "班级名称不能为空"}), 400
    db = get_db()
    cur = db.execute("INSERT INTO classes(name) VALUES(?)", (name,))
    db.commit()
    broadcast()
    return jsonify({"id": cur.lastrowid, "name": name})


@app.route("/api/classes/<int:cid>", methods=["PATCH"])
@login_required
def update_class(cid):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "班级名称不能为空"}), 400
    db = get_db()
    db.execute("UPDATE classes SET name=? WHERE id=?", (name, cid))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


@app.route("/api/classes/<int:cid>", methods=["DELETE"])
@login_required
def delete_class(cid):
    db = get_db()
    db.execute("DELETE FROM classes WHERE id=?", (cid,))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


@app.route("/api/classes/<int:cid>/reset", methods=["POST"])
@login_required
def reset_class(cid):
    db = get_db()
    db.execute("UPDATE groups SET score=0 WHERE class_id=?", (cid,))
    db.execute("DELETE FROM transactions WHERE class_id=?", (cid,))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 小组
# ---------------------------------------------------------------------------
@app.route("/api/classes/<int:cid>/groups", methods=["POST"])
@login_required
def create_group(cid):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    color = (data.get("color") or "#5B9BD5").strip()
    if not name:
        return jsonify({"error": "小组名称不能为空"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO groups(class_id, name, color, sort_order) "
        "VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM groups WHERE class_id=?))",
        (cid, name, color, cid),
    )
    db.commit()
    broadcast()
    return jsonify({"id": cur.lastrowid})


@app.route("/api/classes/<int:cid>/groups/reorder", methods=["POST"])
@login_required
def reorder_groups(cid):
    data = request.get_json(silent=True) or {}
    order = data.get("order", [])
    db = get_db()
    rows = db.execute("SELECT id FROM groups WHERE class_id=?", (cid,)).fetchall()
    valid = {r["id"] for r in rows}
    if not order or set(order) != valid:
        return jsonify({"error": "排序数据与小组不匹配"}), 400
    for idx, gid in enumerate(order):
        db.execute("UPDATE groups SET sort_order=? WHERE id=?", (idx, gid))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


@app.route("/api/groups/<int:gid>", methods=["PATCH"])
@login_required
def update_group(gid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    if "name" in data:
        name = (data.get("name") or "").strip()
        if name:
            db.execute("UPDATE groups SET name=? WHERE id=?", (name, gid))
    if "color" in data:
        color = (data.get("color") or "").strip()
        if color:
            db.execute("UPDATE groups SET color=? WHERE id=?", (color, gid))
    if "score" in data and data["score"] is not None:
        db.execute("UPDATE groups SET score=? WHERE id=?", (int(data["score"]), gid))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


@app.route("/api/groups/<int:gid>", methods=["DELETE"])
@login_required
def delete_group(gid):
    db = get_db()
    db.execute("DELETE FROM groups WHERE id=?", (gid,))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 记分、撤销、历史
# ---------------------------------------------------------------------------
@app.route("/api/score", methods=["POST"])
@login_required
def add_score():
    data = request.get_json(silent=True) or {}
    gid = data.get("group_id")
    try:
        delta = int(data.get("delta", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "分值无效"}), 400
    reason = (data.get("reason") or "").strip()
    if not gid or delta == 0:
        return jsonify({"error": "参数错误"}), 400
    db = get_db()
    row = db.execute("SELECT class_id FROM groups WHERE id=?", (gid,)).fetchone()
    if not row:
        return jsonify({"error": "小组不存在"}), 404
    db.execute(
        "INSERT INTO transactions(group_id, class_id, delta, reason) VALUES(?,?,?,?)",
        (gid, row["class_id"], delta, reason),
    )
    db.execute("UPDATE groups SET score = score + ? WHERE id=?", (delta, gid))
    db.commit()
    broadcast()
    return jsonify({"ok": True})


@app.route("/api/undo", methods=["POST"])
@login_required
def undo():
    db = get_db()
    t = db.execute(
        "SELECT id, group_id, delta FROM transactions ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not t:
        return jsonify({"ok": True, "undone": False})
    db.execute("UPDATE groups SET score = score - ? WHERE id=?", (t["delta"], t["group_id"]))
    db.execute("DELETE FROM transactions WHERE id=?", (t["id"],))
    db.commit()
    broadcast()
    return jsonify({"ok": True, "undone": True, "group_id": t["group_id"]})


@app.route("/api/history")
@login_required
def history():
    cid = request.args.get("class_id")
    db = get_db()
    query = (
        "SELECT t.id, t.delta, t.reason, t.created_at, t.group_id, "
        "g.name AS group_name, c.name AS class_name "
        "FROM transactions t "
        "JOIN groups g ON g.id = t.group_id "
        "JOIN classes c ON c.id = t.class_id"
    )
    params = []
    if cid:
        query += " WHERE t.class_id = ?"
        params.append(cid)
    query += " ORDER BY t.id DESC LIMIT 100"
    rows = db.execute(query, params).fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------------------
# 导出 / 导入（学期备份）
# ---------------------------------------------------------------------------
@app.route("/api/export")
@login_required
def export_data():
    db = get_db()
    classes = db.execute("SELECT * FROM classes ORDER BY id").fetchall()
    data = []
    for c in classes:
        groups = db.execute("SELECT * FROM groups WHERE class_id=? ORDER BY id", (c["id"],)).fetchall()
        data.append(
            {
                "id": c["id"],
                "name": c["name"],
                "groups": [dict(g) for g in groups],
            }
        )
    return jsonify(
        {"version": 1, "exported_at": datetime.now().isoformat(), "classes": data}
    )


@app.route("/api/import", methods=["POST"])
@login_required
def import_data():
    data = request.get_json(silent=True) or {}
    classes = data.get("classes", [])
    db = get_db()
    db.execute("DELETE FROM transactions")
    db.execute("DELETE FROM groups")
    db.execute("DELETE FROM classes")
    for c in classes:
        cur = db.execute("INSERT INTO classes(name) VALUES(?)", (c.get("name", ""),))
        cid = cur.lastrowid
        for g in c.get("groups", []):
            db.execute(
                "INSERT INTO groups(class_id, name, color, score) VALUES(?,?,?,?)",
                (cid, g.get("name", ""), g.get("color", "#5B9BD5"), int(g.get("score", 0))),
            )
    db.commit()
    broadcast()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 页面
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    print(f"课堂小组积分系统运行在 http://0.0.0.0:{port}")
    try:
        from waitress import serve

        serve(app, host="0.0.0.0", port=port, threads=16)
    except ImportError:
        app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
