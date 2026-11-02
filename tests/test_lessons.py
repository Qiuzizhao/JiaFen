import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime

spec = importlib.util.spec_from_file_location("jiafen_lesson_tests", Path(__file__).resolve().parents[1] / "application/app.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class LessonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path, self.old_clock = m.DB_PATH, m.beijing_now
        m.DB_PATH = str(Path(self.tmp.name) / "lessons.db"); m.init_db()
        self.c = m.app.test_client()
        with self.c.session_transaction() as s: s["uid"] = 1
        self.cid = self.c.post("/api/classes", json={"name": "A班"}).json["id"]
        self.gids = [self.c.post(f"/api/classes/{self.cid}/groups", json={"name": f"第{i}组"}).json["id"] for i in [1, 2]]
        with sqlite3.connect(m.DB_PATH) as db:
            db.executemany("INSERT INTO reward_progress(group_id,max_score) VALUES(?,0)", [(gid,) for gid in self.gids])
        self.at("2026-11-02 08:10:00")

    def tearDown(self):
        m.DB_PATH, m.beijing_now = self.old_path, self.old_clock
        self.tmp.cleanup()

    def at(self, at):
        m.beijing_now = lambda: datetime.fromisoformat(at + "+08:00")

    def score(self, at, delta, gid=None):
        self.at(at)
        r = self.c.post("/api/score", json={"group_id": gid or self.gids[0], "delta": delta, "reason": "课堂记录"})
        self.assertEqual(r.status_code, 200, r.json)
        return r.json

    def lessons(self, month="2026-11"):
        r = self.c.get(f"/api/classes/{self.cid}/lessons?month={month}")
        self.assertEqual(r.status_code, 200, r.json)
        return r.json

    def save(self, lesson, start, end, **extra):
        return self.c.put(f"/api/lessons/{lesson['id']}", json={"revision": lesson["revision"], "start_at": start, "end_at": end, **extra})

    def originals(self):
        with sqlite3.connect(m.DB_PATH) as db:
            return {t: db.execute("SELECT * FROM " + t + " ORDER BY 1").fetchall() for t in [
                "groups", "transactions", "monthly_score_entries", "reward_opportunities",
                "reward_progress", "ranking_group_history", "ranking_archives"]}

    def test_default_two_hour_fixed_window_and_settings_not_retroactive(self):
        self.score("2026-11-02 08:10:00", 1)
        self.score("2026-11-02 08:18:00", 2, self.gids[1])
        self.score("2026-11-02 08:35:00", -1)
        self.score("2026-11-02 09:10:00", 1)
        rows = self.lessons()["lessons"]
        self.assertEqual(len(rows), 1)  # Explicit 2h requirement, not a fabricated timetable
        self.assertEqual(rows[0]["end_at"], "2026-11-02 10:10:00")
        self.assertEqual(rows[0]["summary"]["net"], 3)
        self.assertEqual(self.c.put("/api/lessons/settings", json={"window_minutes": 30}).status_code, 200)
        self.score("2026-11-02 10:10:00", 4)  # end-exclusive
        self.score("2026-11-02 10:40:00", 1)
        rows = self.lessons()["lessons"]
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["end_at"], "2026-11-02 10:10:00")
        self.assertEqual(rows[1]["end_at"], "2026-11-02 10:40:00")

    def test_preview_and_boundary_edit_reassign_without_touching_score_sources(self):
        self.score("2026-11-02 08:10:00", 5)
        self.score("2026-11-02 08:30:00", -2)
        self.score("2026-11-02 08:45:00", 3, self.gids[1])
        row = self.lessons()["lessons"][0]; before = self.originals()
        p = self.c.post(f"/api/lessons/{row['id']}/preview", json={"start_at": row["start_at"], "end_at": "2026-11-02 08:40:00"}).json
        self.assertEqual(p["before"]["net"], 6); self.assertEqual(p["summary"]["net"], 3)
        self.assertTrue(p["can_save"])
        r = self.save(row, row["start_at"], "2026-11-02 08:40:00")
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(r.json["summary"]["positive"], 5)
        self.assertEqual(r.json["summary"]["negative"], -2)
        self.assertEqual(self.lessons()["unassigned"], 1)
        self.assertEqual(before, self.originals())
        self.assertEqual(self.save(row, row["start_at"], row["end_at"]).status_code, 409)

    def test_overlap_is_previewed_and_save_is_atomic(self):
        self.score("2026-11-02 08:10:00", 1)
        self.score("2026-11-02 10:10:00", 2)
        first, second = self.lessons()["lessons"]
        before = self.originals()
        p = self.c.post(f"/api/lessons/{first['id']}/preview", json={"start_at": first["start_at"], "end_at": "2026-11-02 11:00:00"}).json
        self.assertFalse(p["can_save"]); self.assertEqual(p["conflicts"][0]["id"], second["id"])
        self.assertEqual(self.save(first, first["start_at"], "2026-11-02 11:00:00").status_code, 400)
        self.assertEqual(before, self.originals())
        self.assertEqual(self.lessons()["lessons"][0]["summary"]["net"], 1)

    def test_batch_cannot_split_and_undo_keeps_all_raw_details(self):
        self.at("2026-11-02 08:00:00")
        self.c.post(f"/api/classes/{self.cid}/score", json={"delta": 2, "reason": "全班"})
        row = self.lessons()["lessons"][0]
        self.assertEqual(row["summary"]["net"], 4)
        self.c.post("/api/undo", json={})
        listed = self.lessons()
        self.assertEqual(listed["lessons"], []); self.assertEqual(listed["voided_only"], 1)
        detail = self.c.get(f"/api/lessons/{row['id']}").json
        self.assertEqual(len(detail["entries"]), 2)
        self.assertTrue(all(e["voided_at"] and e["reason"] == "全班" and e["batch_id"] for e in detail["entries"]))
        self.assertEqual(detail["summary"]["net"], 0)

    def test_split_merge_and_revision_history(self):
        self.score("2026-11-02 08:10:00", 4)
        self.score("2026-11-02 09:10:00", -1)
        row = self.lessons()["lessons"][0]; before = self.originals()
        r = self.c.post(f"/api/lessons/{row['id']}/split", json={"revision": row["revision"], "at": "2026-11-02 09:00:00"})
        self.assertEqual(r.status_code, 200, r.json)
        a, b = self.lessons()["lessons"]
        self.assertEqual([a["summary"]["net"], b["summary"]["net"]], [4, -1])
        r = self.c.post(f"/api/lessons/{a['id']}/merge", json={"revision": a["revision"], "other_id": b["id"], "other_revision": b["revision"]})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(len(self.lessons()["lessons"]), 1)
        self.assertEqual(self.lessons()["lessons"][0]["summary"]["net"], 3)
        self.assertEqual(before, self.originals())
        with sqlite3.connect(m.DB_PATH) as db:
            actions = [r[0] for r in db.execute("SELECT action FROM lesson_revisions")]
            self.assertIn("split", actions); self.assertIn("merge", actions)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_entries").fetchone()[0], 2)

    def test_manual_zero_score_class_unknown_status_and_owner_isolation(self):
        r = self.c.post(f"/api/classes/{self.cid}/lessons", json={"start_at": "2026-09-02 08:00:00", "end_at": "2026-09-02 08:40:00"})
        self.assertEqual(r.status_code, 201)
        row = self.lessons("2026-09")["lessons"][0]
        self.assertEqual(row["summary"]["count"], 0); self.assertEqual(row["source"], "manual")
        r = self.save(row, row["start_at"], row["end_at"], status="unknown")
        self.assertEqual(r.json["status"], "unknown")
        other = m.app.test_client()
        with other.session_transaction() as s: s["uid"] = 999
        self.assertEqual(other.get(f"/api/lessons/{row['id']}").status_code, 401)
        with sqlite3.connect(m.DB_PATH) as db: db.execute("INSERT INTO users(username,password_hash) VALUES('other','x')")
        with other.session_transaction() as s: s["uid"] = 2
        self.assertEqual(other.get(f"/api/lessons/{row['id']}").status_code, 404)
        self.assertEqual(other.get(f"/api/classes/{self.cid}/lesson-records?start=2026-09-02&end=2026-09-03").status_code, 404)

    def test_history_backfill_idempotent_not_two_hour_merging(self):
        # Remove only fixture-generated lesson objects; source rows remain intact.
        self.score("2026-09-09 08:10:00", 1)
        self.score("2026-09-09 08:35:00", -1)
        self.score("2026-09-09 09:10:00", 3)
        with sqlite3.connect(m.DB_PATH) as db:
            db.execute("DELETE FROM lesson_entries"); db.execute("DELETE FROM lesson_revisions"); db.execute("DELETE FROM lessons")
            db.execute("UPDATE lesson_settings SET history_seeded=0")
        before = self.originals()
        m.init_db()
        rows = self.lessons("2026-09")["lessons"]
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["status"] for r in rows], ["review", "review"])
        self.assertEqual(before, self.originals())
        m.init_db()
        self.assertEqual(len(self.lessons("2026-09")["lessons"]), 2)

    def test_new_score_and_undo_invalidate_edit_revision(self):
        self.score("2026-11-02 08:10:00", 1); row = self.lessons()["lessons"][0]
        self.score("2026-11-02 08:20:00", 1)
        self.assertEqual(self.save(row, row["start_at"], row["end_at"]).status_code, 409)
        row = self.lessons()["lessons"][0]
        self.c.post("/api/undo", json={})
        self.assertEqual(self.save(row, row["start_at"], row["end_at"]).status_code, 409)

    def test_real_september_class_backfill_edit_and_original_logs_retained(self):
        import json
        fixture = json.loads((Path(__file__).parent / "fixtures/lessons-real-september.json").read_text())
        while len(self.gids) < 9:
            self.gids.append(self.c.post(f"/api/classes/{self.cid}/groups", json={"name": f"第{len(self.gids)+1}组"}).json["id"])
        with sqlite3.connect(m.DB_PATH) as db:
            db.row_factory = sqlite3.Row
            for t in fixture["transactions"]:
                db.execute("INSERT INTO transactions(id,group_id,class_id,delta,reason,batch_id,created_at) VALUES(?,?,?,?,?,?,?)",
                           (t["id"], t["group_id"], self.cid, t["delta"], t["reason"], t.get("batch_id"), t["created_at"]))
            for gid in self.gids:
                db.execute("UPDATE groups SET score=(SELECT COALESCE(SUM(delta),0) FROM transactions WHERE group_id=?) WHERE id=?", (gid,gid))
                m.record_reward_milestones(db,gid)
            db.execute("UPDATE lesson_settings SET history_seeded=0")
        before = self.originals()
        m.init_db()
        rows = self.lessons("2026-09")["lessons"]
        self.assertEqual(len(rows), 4)
        self.assertEqual([r["start_at"][:10] for r in rows], ["2026-09-08","2026-09-14","2026-09-21","2026-09-28"])
        self.assertEqual([r["summary"]["net"] for r in rows], [0,11,11,23])
        self.assertIn("疑似测试",rows[0]["note"])
        row = rows[1]
        new_end = "2026-09-14 11:50:00"
        expected = sum(e["delta"] for e in row["entries"] if e["occurred_at"] < new_end)
        preview = self.c.post(f"/api/lessons/{row['id']}/preview", json={"start_at": row["start_at"],"end_at":new_end}).json
        self.assertEqual(preview["summary"]["net"],expected)
        saved = self.save(row,row["start_at"],new_end)
        self.assertEqual(saved.status_code,200,saved.json)
        self.assertEqual(saved.json["summary"]["net"],expected)
        self.assertNotEqual(expected,row["summary"]["net"])
        self.assertEqual(self.originals(),before)
        with sqlite3.connect(m.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],53)

    def test_old_state_traces_visible_but_not_counted_as_teaching(self):
        with sqlite3.connect(m.DB_PATH) as db:
            for at, score in [("2026-09-01 00:00:00.000",10),("2026-09-02 00:00:00.000",11),("2026-09-02 00:00:05.000",10)]:
                db.execute("INSERT INTO ranking_group_history(owner_id,group_id,class_id,name,score,sort_order,active,at) VALUES(1,?,?,?, ?,0,1,?)",
                           (self.gids[0],self.cid,"第1组",score,at))
        records = self.c.get(f"/api/classes/{self.cid}/lesson-records?start=2026-09-02&end=2026-09-03").json
        self.assertEqual(len(records),2)
        self.assertTrue(all(r["observed_only"] for r in records))
        self.assertEqual([r["delta"] for r in records],[1,-1])
        self.c.post(f"/api/classes/{self.cid}/lessons",json={"start_at":"2026-09-02 08:00:00","end_at":"2026-09-02 09:00:00"})
        self.assertEqual(self.lessons("2026-09")["lessons"][0]["summary"]["count"],0)

    def test_legacy_batch_at_different_seconds_cannot_be_cut(self):
        with sqlite3.connect(m.DB_PATH) as db:
            for gid, at in zip(self.gids,["2026-11-02 08:00:00","2026-11-02 08:02:00"]):
                db.execute("INSERT INTO transactions(group_id,class_id,delta,batch_id,created_at) VALUES(?,?,1,'legacy-batch',?)",(gid,self.cid,at))
        before = self.originals()
        r=self.c.post(f"/api/classes/{self.cid}/lessons",json={"start_at":"2026-11-02 08:00:00","end_at":"2026-11-02 08:01:00"})
        self.assertEqual(r.status_code,400,r.json)
        self.assertEqual(before,self.originals())


if __name__ == "__main__": unittest.main()
