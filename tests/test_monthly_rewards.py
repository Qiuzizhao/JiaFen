import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime

spec = importlib.util.spec_from_file_location('monthly_reward_tests', Path(__file__).resolve().parents[1] / 'application/app.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MonthlyRewardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path, self.old_clock = m.DB_PATH, m.beijing_now
        m.DB_PATH = str(Path(self.tmp.name) / 'test.db')
        m.init_db()
        self.at('2026-11-04 10:00:00')
        self.c = m.app.test_client()
        with self.c.session_transaction() as s:
            s['uid'] = 1
        self.cid = self.c.post('/api/classes', json={'name': 'A班'}).json['id']
        self.gid = self.c.post(f'/api/classes/{self.cid}/groups', json={'name': '第一组'}).json['id']

    def tearDown(self):
        m.DB_PATH, m.beijing_now = self.old_path, self.old_clock
        self.tmp.cleanup()

    def at(self, at):
        m.beijing_now = lambda: datetime.fromisoformat(at + '+08:00')

    def setting(self, enabled=True, target=10):
        r = self.c.put('/api/rewards/monthly-goal', json={'enabled': enabled, 'target': target})
        self.assertEqual(r.status_code, 200, r.json)
        return r.json

    def score(self, delta):
        r = self.c.post('/api/score', json={'group_id': self.gid, 'delta': delta})
        self.assertEqual(r.status_code, 200, r.json)
        return r.json['transaction_id']

    def awards(self):
        return [o for c in self.c.get('/api/rewards').json['classes'] for g in c['groups']
                for o in g['opportunities'] if o['monthly_period']]

    def test_disabled_by_default_and_no_previous_month_award(self):
        self.at('2026-10-20 10:00:00'); self.score(100)
        self.at('2026-11-04 10:00:00'); self.score(9)
        self.assertFalse(self.c.get('/api/rewards/monthly-goal').json['enabled'])
        self.assertEqual(self.awards(), [])
        self.setting()
        self.assertEqual(self.awards(), [])
        self.score(1)
        self.assertEqual([o['monthly_period'] for o in self.awards()], ['2026-11'])
        # Cumulative milestones still coexist with the independent monthly award.
        self.assertTrue(any(o['kind'] == 'score' for o in self.c.get('/api/rewards').json['classes'][0]['groups'][0]['opportunities']))

    def test_net_points_and_no_duplicate_after_undo_toggle_target_edit(self):
        self.score(-5); self.setting()
        self.score(10); self.assertEqual(self.awards(), [])
        tid = self.score(5); self.assertEqual(len(self.awards()), 1)
        self.assertEqual(self.c.post(f'/api/transactions/{tid}/undo').status_code, 200)
        self.score(5)
        self.setting(False); self.setting(True); self.setting(True, 3)
        self.assertEqual(len(self.awards()), 1)

    def test_enable_reconciles_current_month_and_month_rollover(self):
        self.score(10); self.setting()
        self.assertEqual(len(self.awards()), 1)
        self.at('2026-12-01 00:00:00')
        self.score(9); self.assertEqual(len(self.awards()), 1)
        self.score(1)
        self.assertEqual({o['monthly_period'] for o in self.awards()}, {'2026-11', '2026-12'})

    def test_batch_and_account_isolation(self):
        self.c.post(f'/api/classes/{self.cid}/groups', json={'name': '第二组'})
        self.setting()
        r = self.c.post(f'/api/classes/{self.cid}/score', json={'delta': 10})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.awards()), 2)
        db = sqlite3.connect(m.DB_PATH)
        try:
            uid = db.execute("INSERT INTO users(username,display_name,password_hash) VALUES('other','other','unused')").lastrowid
            db.commit()
        finally:
            db.close()
        other = m.app.test_client()
        with other.session_transaction() as s: s['uid'] = uid
        self.assertFalse(other.get('/api/rewards/monthly-goal').json['enabled'])
        self.assertEqual(other.get('/api/rewards').json['classes'], [])
        self.assertEqual(other.post(f'/api/rewards/opportunities/{self.awards()[0]["id"]}/toggle', json={'completed': True}).status_code, 404)

    def test_disable_preserves_awards_and_stops_new_month(self):
        self.setting(); self.score(10); self.setting(False)
        self.at('2026-12-01 00:00:00'); self.score(20)
        self.assertEqual(len(self.awards()), 1)
        self.setting(True)
        self.assertEqual(len(self.awards()), 2)

    def test_backup_and_repeated_migration(self):
        self.setting(); self.score(10)
        backup = self.c.get('/api/export').json
        self.assertEqual(backup['monthly_reward_goal']['target'], 10)
        self.assertEqual(self.c.post('/api/import', json=backup).status_code, 200)
        self.assertEqual(len(self.awards()), 1)
        self.gid = self.c.get('/api/rewards').json['classes'][0]['groups'][0]['id']
        self.score(10)
        self.assertEqual(len(self.awards()), 1)
        m.init_db()
        self.assertEqual(len(self.awards()), 1)

    def test_validation_and_authentication(self):
        for body in [{'enabled': True, 'target': t} for t in [0, -1, 10001, True, '10', 1.5, None]]:
            self.assertEqual(self.c.put('/api/rewards/monthly-goal', json=body).status_code, 400)
        self.assertEqual(self.c.put('/api/rewards/monthly-goal', json={'enabled': 'true', 'target': 10}).status_code, 400)
        self.assertEqual(m.app.test_client().put('/api/rewards/monthly-goal', json={'enabled': True, 'target': 10}).status_code, 401)


if __name__ == '__main__':
    unittest.main()
