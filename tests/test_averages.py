"""JF-004 calculation tests: every database is temporary."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime
from contextlib import contextmanager

spec = importlib.util.spec_from_file_location("jiafen_average_tests", Path(__file__).resolve().parents[1] / "application/app.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class AverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path, self.old_clock = m.DB_PATH, m.beijing_now
        m.DB_PATH = str(Path(self.tmp.name) / "averages.db"); m.init_db()
        self.c = m.app.test_client()
        with self.c.session_transaction() as s: s["uid"] = 1
        self.a = self.c.post("/api/classes", json={"name": "A班"}).json["id"]
        self.b = self.c.post("/api/classes", json={"name": "B班"}).json["id"]
        self.ag = [self.c.post(f"/api/classes/{self.a}/groups", json={"name": f"A{i+1}组"}).json["id"] for i in range(3)]
        self.bg = [self.c.post(f"/api/classes/{self.b}/groups", json={"name": f"B{i+1}组"}).json["id"] for i in range(2)]
        self.at("2026-11-03 18:00:00")

    def tearDown(self):
        m.DB_PATH, m.beijing_now = self.old_path, self.old_clock
        self.tmp.cleanup()

    def at(self, at):
        m.beijing_now = lambda: datetime.fromisoformat(at + "+08:00")

    def lesson(self, cid, day, begin="08:00:00", end="08:45:00"):
        r = self.c.post(f"/api/classes/{cid}/lessons", json={"start_at": day+" "+begin, "end_at": day+" "+end})
        self.assertEqual(r.status_code, 201, r.json)
        return r.json["id"]

    def score(self, gid, at, delta):
        self.at(at)
        r = self.c.post("/api/score", json={"group_id": gid, "delta": delta})
        self.assertEqual(r.status_code, 200, r.json)

    def fixture(self):
        # Two real zero-score lessons in A's four lessons.
        self.al = [self.lesson(self.a, f"2026-09-0{i}") for i in range(1,5)]
        self.bl = [self.lesson(self.b, f"2026-09-0{i}") for i in range(1,6)]
        for i, values in [(1,[6,4,3]),(2,[6,6,5])]:
            for gid, delta in zip(self.ag, values):
                self.score(gid, f"2026-09-0{i} 08:10:00", delta)
        for i in range(1,6):
            self.score(self.bg[0], f"2026-09-0{i} 08:10:00", 3)
            self.score(self.bg[1], f"2026-09-0{i} 08:15:00", -1)
        self.at("2026-11-03 18:00:00")

    def result(self, cid=None, month="2026-09", period="month", gid=None):
        args = f"period={period}" + (f"&month={month}" if period=="month" else "")
        if cid: args += f"&class_id={cid}"
        if gid: args += f"&group_id={gid}"
        r = self.c.get("/api/statistics/averages?" + args)
        self.assertEqual(r.status_code, 200, r.json)
        return r.json["classes"][0] if cid or gid else r.json["classes"]

    def by_group(self, result, gid):
        return next(g for g in result["groups"] if g["group_id"]==gid)

    @contextmanager
    def database(self):
        db=sqlite3.connect(m.DB_PATH)
        try:
            with db:
                yield db
        finally:
            db.close()

    def snapshot(self):
        with self.database() as db:
            return {t[0]: db.execute("SELECT * FROM "+t[0]+" ORDER BY 1").fetchall()
                    for t in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def test_four_vs_five_lessons_group_and_class_formulas(self):
        self.fixture()
        a,b = self.result()
        self.assertEqual([g["period_net_score"] for g in a["groups"]], [12,10,8])
        self.assertEqual([g["lesson_count"] for g in a["groups"]], [4,4,4])
        self.assertEqual([g["average"] for g in a["groups"]], [3.0,2.5,2.0])
        self.assertEqual(a["average"],7.5)  # 30/4, not mean([3,2.5,2])
        self.assertEqual(b["lesson_count"],5)
        self.assertEqual([g["average"] for g in b["groups"]], [3.0,-1.0])
        self.assertEqual(b["average"],2.0)  # (15-5)/5
        self.assertEqual(a["quality"]["status"],"recorded_only")
        self.assertEqual(a["quality"]["historical_completeness"],"not_attested")

    def test_zero_score_lessons_and_zero_score_groups_share_denominator(self):
        self.fixture()
        a = self.result(self.a)
        self.assertEqual([l["net_score"] for l in a["lessons"]],[13,17,0,0])
        self.assertEqual(len(a["groups"][0]["lessons"]),4)
        extra=self.c.post(f"/api/classes/{self.a}/groups",json={"name":"没有记分的组"}).json["id"]
        g=self.by_group(self.result(self.a),extra)
        self.assertEqual(g["lesson_count"],4);self.assertEqual(g["average"],0)
        self.assertTrue(all(l["net_score"]==0 for l in g["lessons"]))

    def test_month_and_history_use_effective_records_not_score_baseline(self):
        self.fixture()
        self.lesson(self.a,"2026-10-01");self.lesson(self.a,"2026-10-02")
        self.score(self.ag[0],"2026-10-01 08:10:00",8)
        self.at("2026-11-03 18:00:00")
        september=self.result(self.a)
        october=self.result(self.a,month="2026-10")
        history=self.result(self.a,period="history")
        self.assertEqual((september["period_net_score"],september["lesson_count"]),(30,4))
        self.assertEqual((october["period_net_score"],october["lesson_count"]),(8,2))
        self.assertEqual((history["period_net_score"],history["lesson_count"],history["average"]),(38,6,6.33))
        self.assertEqual(self.by_group(history,self.ag[0])["average"],3.33)
        # Administrative score override does not fabricate teaching score.
        self.c.patch(f"/api/groups/{self.ag[0]}",json={"score":999})
        self.assertEqual(self.result(self.a,period="history")["period_net_score"],38)

    def test_unassigned_records_are_explained_not_silently_averaged(self):
        self.fixture()
        row=self.c.get(f"/api/lessons/{self.al[0]}").json
        before=self.result(self.a)
        saved=self.c.put(f"/api/lessons/{row['id']}",json={"revision":row["revision"],"start_at":row["start_at"],"end_at":"2026-09-01 08:05:00"})
        self.assertEqual(saved.status_code,200,saved.json)
        after=self.result(self.a)
        self.assertEqual(after["period_net_score"],30)
        self.assertEqual(after["recognized_net_score"],17)
        self.assertEqual(after["unresolved_net_score"],13)
        self.assertEqual(after["lesson_count"],4)
        self.assertIsNone(after["average"])
        self.assertEqual(after["partial_average"],4.25)
        self.assertEqual(len(after["exclusions"]),3)
        self.assertTrue(all(e["reason"]=="unassigned" for e in after["exclusions"]))
        self.assertNotEqual(before["data_revision"],after["data_revision"])

    def test_review_and_unknown_lessons_do_not_pretend_history_is_complete(self):
        self.fixture()
        row=self.c.get(f"/api/lessons/{self.al[1]}").json
        r=self.c.put(f"/api/lessons/{row['id']}",json={"revision":row["revision"],"start_at":row["start_at"],"end_at":row["end_at"],"status":"unknown"})
        self.assertEqual(r.status_code,200)
        a=self.result(self.a,period="history")
        self.assertEqual(a["lesson_count"],3)
        self.assertIsNone(a["average"])
        self.assertEqual(a["partial_average"],4.33)
        self.assertEqual(a["quality"]["status"],"partial")
        self.assertEqual(a["quality"]["pending_lessons"][0]["status"],"unknown")
        self.assertEqual(len(a["exclusions"]),3)

    def test_cross_month_undo_recomputes_original_month_and_history(self):
        self.fixture()
        self.score(self.ag[0],"2026-09-02 08:20:00",4)
        self.at("2026-11-03 18:00:00")
        before=self.result(self.a)
        self.assertEqual(before["average"],8.5)
        self.c.post("/api/undo",json={})
        after=self.result(self.a)
        self.assertEqual(after["average"],7.5)
        self.assertEqual(after["lesson_count"],4)
        self.assertEqual(after["quality"]["voided_entries"],1)
        self.assertNotEqual(before["data_revision"],after["data_revision"])
        self.assertEqual(self.result(self.a,period="history")["average"],7.5)

    def test_split_merge_recompute_denominator_without_rewriting_scores(self):
        self.fixture()
        before=self.snapshot()
        row=self.c.get(f"/api/lessons/{self.al[0]}").json
        r=self.c.post(f"/api/lessons/{row['id']}/split",json={"revision":row["revision"],"at":"2026-09-01 08:20:00"})
        self.assertEqual(r.status_code,200,r.json)
        a=self.result(self.a)
        self.assertEqual((a["period_net_score"],a["lesson_count"],a["average"]),(30,5,6.0))
        new_a,new_b=[self.c.get(f"/api/lessons/{lid}").json for lid in r.json["ids"]]
        self.c.post(f"/api/lessons/{new_a['id']}/merge",json={"revision":new_a["revision"],"other_id":new_b["id"],"other_revision":new_b["revision"]})
        self.assertEqual(self.result(self.a)["average"],7.5)
        after=self.snapshot()
        for table in ["transactions","monthly_score_entries","groups","reward_opportunities","ranking_archives"]:
            self.assertEqual(before[table],after[table])

    def test_one_group_filter_does_not_change_class_total_or_denominator(self):
        self.fixture()
        a=self.result(self.a,gid=self.ag[1])
        self.assertEqual(a["period_net_score"],30)
        self.assertEqual(a["lesson_count"],4)
        self.assertEqual(a["class_group_count"],3)
        self.assertEqual(len(a["groups"]),1)
        self.assertEqual(a["groups"][0]["average"],2.5)
        self.assertEqual(self.result(gid=self.ag[0])["groups"][0]["group_id"],self.ag[0])

    def test_no_lessons_negative_zero_denominator_and_future(self):
        self.assertIsNone(self.result(self.a)["average"])
        self.assertEqual(self.result(self.a)["quality"]["status"],"unknown")
        self.fixture()
        self.at("2026-09-02 09:00:00")
        a=self.result(self.a)
        self.assertEqual((a["lesson_count"],a["period_net_score"]),(2,30))
        future=self.result(self.a,month="2026-10")
        self.assertIsNone(future["average"]);self.assertEqual(future["lesson_count"],0)
        self.assertIn("period_not_started",future["quality"]["warnings"])

    def test_response_explanations_reconcile_to_every_group_and_class(self):
        self.fixture()
        a=self.result(self.a)
        self.assertEqual(sum(l["net_score"] for l in a["lessons"]),a["recognized_net_score"])
        for g in a["groups"]:
            self.assertEqual(sum(l["net_score"] for l in g["lessons"]),g["recognized_net_score"])
            for l in g["lessons"]:
                self.assertEqual(sum(e["delta"] for e in l["entries"]),l["net_score"])
            self.assertEqual(g["exact_ratio"]["denominator"],a["lesson_count"])

    def test_reads_are_side_effect_free_and_deterministic(self):
        self.fixture()
        before=self.snapshot()
        one=self.result(self.a)
        two=self.result(self.a)
        self.assertEqual(one,two)
        self.result(period="history")
        self.result(self.b,month="2026-08")
        self.assertEqual(before,self.snapshot())

    def test_invalid_inputs_and_account_isolation(self):
        self.fixture()
        for args in ["period=x","period=history&month=2026-09","period=month&month=2026-13","class_id=0","class_id=-1","class_id=1e1","group_id=x"]:
            self.assertEqual(self.c.get("/api/statistics/averages?"+args).status_code,400,args)
        self.assertEqual(self.c.get(f"/api/statistics/averages?class_id={self.b}&group_id={self.ag[0]}").status_code,400)
        with self.database() as db:db.execute("INSERT INTO users(username,password_hash) VALUES('other','x')")
        other=m.app.test_client()
        with other.session_transaction() as s:s["uid"]=2
        self.assertEqual(other.get(f"/api/statistics/averages?class_id={self.a}").status_code,404)
        self.assertEqual(other.get(f"/api/statistics/averages?group_id={self.ag[0]}").status_code,404)
        self.assertEqual(other.get("/api/statistics/averages").json["classes"],[])
        self.assertEqual(m.app.test_client().get("/api/statistics/averages").status_code,401)

    def test_corrupt_overlap_fails_closed(self):
        self.fixture()
        with self.database() as db:
            db.execute("UPDATE lessons SET start_at='2026-09-01 08:20:00',end_at='2026-09-01 09:00:00' WHERE id=?",(self.al[1],))
        a=self.result(self.a)
        self.assertIsNone(a["average"])
        self.assertIn("overlapping_lessons",a["quality"]["warnings"])

    def test_cross_month_lesson_is_explicit_not_double_counted(self):
        lid=self.lesson(self.a,"2026-09-30",begin="23:30:00",end="23:59:59")
        row=self.c.get(f"/api/lessons/{lid}").json
        self.c.put(f"/api/lessons/{lid}",json={"revision":row["revision"],"start_at":row["start_at"],"end_at":"2026-10-01 00:30:00"})
        self.score(self.ag[0],"2026-09-30 23:40:00",2)
        self.score(self.ag[0],"2026-10-01 00:10:00",3)
        self.at("2026-11-03 18:00:00")
        sep=self.result(self.a)
        octo=self.result(self.a,month="2026-10")
        self.assertEqual((sep["period_net_score"],sep["lesson_count"]),(2,1))
        self.assertEqual((octo["period_net_score"],octo["lesson_count"]),(3,0))
        self.assertIsNone(octo["average"])
        self.assertEqual(octo["exclusions"][0]["reason"],"lesson_outside_period")
        history=self.result(self.a,period="history")
        self.assertEqual((history["period_net_score"],history["lesson_count"],history["average"]),(5,1,5.0))

    def test_all_undone_automatic_test_window_does_not_count_as_class(self):
        self.score(self.ag[0],"2026-09-01 10:00:00",1)
        self.c.post("/api/undo",json={})
        self.at("2026-11-03 18:00:00")
        a=self.result(self.a)
        self.assertEqual(a["lesson_count"],0)
        self.assertEqual(len(a["quality"]["ignored_automatic_windows"]),1)
        self.assertIsNone(a["average"])

    def test_decimal_half_up_and_preserved_exact_ratio(self):
        for i in range(1,9):
            self.lesson(self.a,f"2026-09-{i:02d}")
        self.score(self.ag[0],"2026-09-01 08:10:00",-1)
        self.at("2026-11-03 18:00:00")
        a=self.result(self.a)
        self.assertEqual(a["average"],-0.13)
        self.assertEqual(a["exact_ratio"],{"numerator":-1,"denominator":8})
        self.assertEqual(self.by_group(a,self.ag[1])["average"],0.0)

    def test_zero_net_unassigned_entries_still_block_formal_result(self):
        self.fixture()
        with self.database() as db:
            for delta,at in [(1,"2026-09-01 10:00:00"),(-1,"2026-09-01 10:00:05")]:
                db.execute("INSERT INTO transactions(group_id,class_id,delta,created_at) VALUES(?,?,?,?)",(self.ag[0],self.a,delta,at))
        a=self.result(self.a)
        self.assertEqual(a["unresolved_net_score"],0)
        self.assertEqual(a["partial_average"],7.5)
        self.assertIsNone(a["average"])
        self.assertEqual(len(a["exclusions"]),2)

    def test_removed_groups_are_kept_in_historical_class_total(self):
        self.fixture()
        self.c.delete(f"/api/groups/{self.ag[2]}")
        a=self.result(self.a)
        self.assertEqual(a["period_net_score"],30)
        self.assertEqual(a["average"],7.5)
        removed=self.by_group(a,self.ag[2])
        self.assertTrue(removed["removed"])
        self.assertEqual(removed["period_net_score"],8)

if __name__ == "__main__": unittest.main()
