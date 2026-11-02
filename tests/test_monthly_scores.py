"""JF-001: isolated databases only; no production data or credentials."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

spec = importlib.util.spec_from_file_location("jiafen_monthly_test", Path(__file__).resolve().parents[1] / "application/app.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BJ = timezone(timedelta(hours=8))


class MonthlyScoresTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path, self.old_clock = m.DB_PATH, m.beijing_now
        m.DB_PATH = str(Path(self.tmp.name) / "test.db")
        m.init_db()
        self.client = m.app.test_client()
        with self.client.session_transaction() as session:
            session["uid"] = 1
        self.cid = self.client.post("/api/classes", json={"name": "A班"}).json["id"]
        self.gids = [self.client.post(f"/api/classes/{self.cid}/groups", json={"name": f"第{i}组"}).json["id"] for i in [1, 2]]
        self.at("2026-11-02T09:00:00+08:00")

    def tearDown(self):
        m.DB_PATH, m.beijing_now = self.old_path, self.old_clock
        self.tmp.cleanup()

    def at(self, value):
        stamp = datetime.fromisoformat(value).astimezone(BJ)
        m.beijing_now = lambda: stamp

    def score(self, delta, gid=None):
        response = self.client.post("/api/score", json={"group_id": gid or self.gids[0], "delta": delta})
        self.assertEqual(response.status_code, 200)
        return response.json

    def monthly(self, month=None, client=None):
        response = (client or self.client).get("/api/statistics/monthly" + ("?month=" + month if month else ""))
        self.assertEqual(response.status_code, 200)
        return {r["group_id"]: r["score"] for r in response.json["scores"]}

    def snapshot(self):
        with sqlite3.connect(m.DB_PATH) as db:
            tables = ["users", "classes", "groups", "transactions", "students", "reward_settings",
                      "reward_progress", "reward_opportunities", "reward_locks", "ranking_history_bounds",
                      "ranking_class_history", "ranking_group_history", "ranking_archives", "meta"]
            return {t: db.execute("SELECT * FROM " + t + " ORDER BY 1").fetchall() for t in tables}

    def test_beijing_month_boundary_and_deductions(self):
        self.at("2026-10-31T15:59:59+00:00")
        self.score(12)
        self.at("2026-10-31T16:00:00+00:00")
        self.score(5)
        self.score(-2)
        self.assertEqual(self.monthly("2026-10")[self.gids[0]], 12)
        self.assertEqual(self.monthly("2026-11")[self.gids[0]], 3)
        self.assertEqual(self.client.get("/api/classes").json[0]["groups"][0]["score"], 15)
        self.assertEqual(self.client.get("/api/statistics/monthly").json["month"], "2026-11")

    def test_december_rollover_and_leap_day(self):
        self.at("2026-12-31T23:59:59+08:00"); self.score(2)
        self.at("2027-01-01T00:00:00+08:00"); self.score(-1)
        self.at("2028-02-29T23:59:59+08:00"); self.score(4)
        self.at("2028-03-01T00:00:00+08:00"); self.score(1)
        for month, expected in [("2026-12", 2), ("2027-01", -1), ("2028-02", 4), ("2028-03", 1)]:
            self.assertEqual(self.monthly(month)[self.gids[0]], expected)

    def test_cross_month_undo_corrects_original_month(self):
        self.at("2026-10-31T23:59:59+08:00"); self.score(7)
        self.at("2026-11-01T00:00:00+08:00")
        self.assertTrue(self.client.post("/api/undo", json={}).json["undone"])
        self.assertEqual(self.monthly("2026-10")[self.gids[0]], 0)
        self.assertEqual(self.monthly("2026-11")[self.gids[0]], 0)
        self.assertEqual(self.client.get("/api/classes").json[0]["groups"][0]["score"], 0)
        with sqlite3.connect(m.DB_PATH) as db:
            self.assertIsNotNone(db.execute("SELECT voided_at FROM monthly_score_entries").fetchone()[0])

    def test_batch_uses_one_timestamp_and_undo_voids_whole_batch(self):
        self.at("2026-10-31T23:59:59+08:00")
        response = self.client.post(f"/api/classes/{self.cid}/score", json={"delta": 3})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(list(self.monthly("2026-10").values()), [3, 3])
        with sqlite3.connect(m.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(DISTINCT occurred_at) FROM monthly_score_entries").fetchone()[0], 1)
        self.at("2026-11-01T00:00:00+08:00")
        self.client.post("/api/undo", json={})
        self.assertEqual(list(self.monthly("2026-10").values()), [0, 0])

    def test_reset_preserves_monthly_but_is_not_teaching_deduction(self):
        self.score(8)
        response = self.client.post(f"/api/classes/{self.cid}/reset", json={"password": m.ADMIN_PASSWORD})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.monthly()[self.gids[0]], 8)
        self.score(2)
        m.init_db()  # repeated startup must not duplicate seed or reactivate voided entries
        self.assertEqual(self.monthly()[self.gids[0]], 10)
        self.assertEqual(self.client.get("/api/classes").json[0]["groups"][0]["score"], 2)

    def test_direct_setting_is_not_teaching_score(self):
        self.score(3)
        self.client.patch(f"/api/groups/{self.gids[0]}", json={"score": 50})
        self.assertEqual(self.monthly()[self.gids[0]], 3)

    def test_additive_migration_preserves_all_original_tables_and_is_idempotent(self):
        self.score(12)
        self.client.post("/api/rewards/groups/%s/opportunities" % self.gids[0], json={"note": "赠送"})
        # Make a pre-monthly schema with real legacy entries, preserving original tables.
        with sqlite3.connect(m.DB_PATH) as db:
            db.execute("DROP TRIGGER monthly_transaction_insert")
            db.execute("DROP TABLE monthly_score_entries")
            db.row_factory = sqlite3.Row
            for gid in self.gids: m.record_reward_milestones(db, gid)
        before = self.snapshot()
        m.init_db()
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.monthly()[self.gids[0]], 12)
        m.init_db()
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.monthly()[self.gids[0]], 12)

    def test_reads_do_not_change_original_scores_rewards_or_archives(self):
        self.score(15)
        before = self.snapshot()
        for month in ["2026-09", "2026-10", "2026-11", "2027-01"]:
            self.monthly(month)
        self.assertEqual(before, self.snapshot())

    def test_two_devices_sse_and_monthly_reconciliation(self):
        other = m.app.test_client()
        with other.session_transaction() as session: session["uid"] = 1
        stream = other.get("/api/events", buffered=False)
        self.assertIn(b"event: connected", next(stream.response))
        self.score(4)
        event = next(stream.response)
        self.assertIn(b"event: update", event)
        self.assertIn(b'"delta": 4', event)
        self.assertEqual(self.monthly(client=other)[self.gids[0]], 4)
        self.client.post("/api/undo", json={})
        self.assertIn(b'"kind": "undo"', next(stream.response))
        self.assertEqual(self.monthly(client=other)[self.gids[0]], 0)
        stream.close()

    def test_owner_isolation_validation_and_empty_month(self):
        with sqlite3.connect(m.DB_PATH) as db:
            db.execute("INSERT INTO users(username,password_hash) VALUES('other',?)", (m.hash_password("fixture"),))
        other = m.app.test_client()
        with other.session_transaction() as session: session["uid"] = 2
        self.score(9)
        self.assertEqual(self.monthly(client=other), {})
        self.assertEqual(list(self.monthly("2026-09").values()), [0, 0])
        for month in ["2026-13", "2026-1", "0000-01", "9999-12", "x"]:
            self.assertEqual(self.client.get("/api/statistics/monthly?month=" + month).status_code, 400)
        self.assertEqual(m.app.test_client().get("/api/statistics/monthly").status_code, 401)

if __name__ == "__main__":
    unittest.main()
