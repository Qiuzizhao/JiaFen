"""Isolated browser fixture. Never deploy: auto-login and clock overrides are test-only."""
import sys,os,tempfile
from pathlib import Path
import atexit
from datetime import datetime
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'application'))
tmp = tempfile.TemporaryDirectory(prefix='jiafen-monthly-ui-')
atexit.register(tmp.cleanup)
os.environ['JIAFEN_DB_PATH']=str(Path(tmp.name) / 'test.db')
import app as m
from flask import request,session
clock=datetime.fromisoformat('2026-11-30T23:59:50+08:00')
m.beijing_now=lambda:clock
m.init_db()
@m.app.before_request
def auth():
 if request.path=='/api/me':session['uid']=1
@m.app.post('/__test_clock')
def set_clock():
 global clock
 clock=datetime.fromisoformat(request.json['time']);return {'ok':True}
c=m.app.test_client()
with c.session_transaction() as s:s['uid']=1
a=c.post('/api/classes',json={'name':'A班'}).json['id'];b=c.post('/api/classes',json={'name':'B班'}).json['id']
g=[]
for cid,name in [(a,'第1组'),(a,'第2组'),(b,'第3组')]:g.append(c.post(f'/api/classes/{cid}/groups',json={'name':name}).json['id'])
for at,gid,delta in [('2026-09-10T10:00:00+08:00',g[0],5),('2026-10-10T10:00:00+08:00',g[0],7),('2026-11-10T10:00:00+08:00',g[0],3),('2026-11-10T10:00:00+08:00',g[1],-1),('2026-11-10T10:00:00+08:00',g[2],4)]:
 clock=datetime.fromisoformat(at);c.post('/api/score',json={'group_id':gid,'delta':delta})
clock=datetime.fromisoformat('2026-11-30T23:59:50+08:00')
from waitress import serve
serve(m.app,host='127.0.0.1',port=int(os.environ.get('MONTHLY_TEST_PORT', '5039')),threads=8)
