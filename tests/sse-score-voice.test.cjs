const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../application/static/app.js'), 'utf8');
const connect = source.slice(source.indexOf('function openSSE() {'), source.indexOf('function startSseWatchdog()'));
const remote = source.slice(source.indexOf('function handleRemoteUpdate(data) {'), source.indexOf('async function bootstrap()'));

function desktop() {
  const listeners = {};
  const calls = [];
  const context = {
    es: null, lastSeq: 100, lastSseAt: 0, sseOpened: 0, sseConnected: true,
    CLIENT_ID: 'desktop', state: { rewardOpen: false, classes: [{ id: 1, name: '班级' }] },
    Date, Set,
    EventSource: class { addEventListener(name, fn) { listeners[name] = fn; } close() {} },
    renderSyncStatus() {},
    refresh() { calls.push(['refresh']); },
    refreshRewards() {},
    setGroupScore(id, score) { calls.push(['score', id, score]); },
    setGroupScores(scores) { calls.push(['scores', scores]); },
    findGroup() { return { name: '第一组' }; },
    findClassOfGroup() { return { name: '班级' }; },
    announceScore(label, delta) { calls.push(['voice', label, delta]); },
    prependHistoryLocal() {}, localStamp() { return 'now'; },
  };
  vm.createContext(context);
  vm.runInContext(connect + '\n' + remote + '\nopenSSE();', context);
  const send = (data) => listeners.update({ data: JSON.stringify(data) });
  const score = (seq, extra = {}) => send({ kind: 'score', seq, time: 'today', client: 'phone', group_id: 1, class_id: 1, score: 11, delta: 1, ...extra });
  return { context, calls, send, score };
}

test('正常与跳号的手机加分都播报；跳号后核对数据', () => {
  for (const seq of [101, 102]) {
    const d = desktop(); d.score(seq);
    assert.deepEqual(d.calls.slice(0, 2), [['score', 1, 11], ['voice', '第一组', 1]]);
    assert.equal(d.calls.filter(x => x[0] === 'refresh').length, seq === 102 ? 1 : 0);
  }
});

test('全班扣分跳号仍播报一次，再核对', () => {
  const d = desktop();
  d.send({ kind: 'class_score', seq: 105, time: 'today', client: 'phone', class_id: 1, delta: -2, scores: [{ id: 1, score: 8 }] });
  assert.deepEqual(d.calls.map(x => x[0]), ['scores', 'voice', 'refresh']);
  assert.deepEqual(d.calls[1], ['voice', '全班', -2]);
});

test('重复事件不重复加分播报，下一次不同事件仍播报', () => {
  const d = desktop(); d.score(102); d.score(102); d.score(103, { score: 12 });
  assert.equal(d.calls.filter(x => x[0] === 'voice').length, 2);
  assert.equal(d.calls.filter(x => x[0] === 'score').length, 2);
});

test('服务重启序号回落或复用，仍播报新的操作', () => {
  const d = desktop(); d.score(101); d.score(1, { time: 'restart' }); d.score(101, { time: 'later' });
  assert.equal(d.calls.filter(x => x[0] === 'voice').length, 3);
  assert.equal(d.calls.filter(x => x[0] === 'refresh').length, 2);
});

test('本机操作的回推不重复播报；收到更新恢复连接状态', () => {
  const d = desktop(); d.context.sseConnected = false;
  d.score(102, { client: 'desktop' });
  assert.equal(d.calls.filter(x => x[0] === 'voice').length, 0);
  assert.equal(d.context.sseConnected, true);
  assert.equal(d.calls.filter(x => x[0] === 'refresh').length, 1);
});
