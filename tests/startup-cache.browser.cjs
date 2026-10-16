// Run with PLAYWRIGHT_MODULE and optionally CHROME_PATH pointing to the local browser runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '../application/static');
const user = (id) => ({ id, username: 'user-' + id, display_name: '账号' + id });
const classes = (id, score) => [{ id, name: '班级' + id, students: [], groups: [{ id, name: '小组' + id, score, color: '#3b82f6' }] }];

async function fixture({ nextUser = 1, invalid = false, broken = false } = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [], dialogs = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  let allowAuth, allowData;
  const authGate = new Promise(resolve => { allowAuth = resolve; });
  const dataGate = new Promise(resolve => { allowData = resolve; });
  const state = { offline: false, authRequests: 0, rejectWrites: false };
  await context.addInitScript(({ user, classes, broken }) => {
    if (!sessionStorage.getItem('fixture-seeded')) {
      localStorage.setItem('jiafen.startup.user.v1', '1');
      localStorage.setItem('jiafen.startup.data.v1.1', broken ? '{bad-json' : JSON.stringify({ user, classes, history: [], at: Date.now() }));
      localStorage.setItem('jiafen.currentClassId', '1');
      localStorage.setItem('jiafen.voiceOn', '0');
      sessionStorage.setItem('fixture-seeded', '1');
    }
    window.EventSource = class {
      constructor() {
        this.readyState = 1; this.handlers = {};
        queueMicrotask(() => this.handlers.connected?.({ data: JSON.stringify({ seq: 100 }) }));
      }
      addEventListener(name, fn) { this.handlers[name] = fn; }
      close() { this.readyState = 2; }
    };
  }, { user: user(1), classes: classes(1, 10), broken });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/me') {
        state.authRequests++;
        if (state.offline) { await route.abort('internetdisconnected'); return; }
        await authGate;
        await route.fulfill({ json: { authed: !invalid, user: invalid ? null : user(nextUser) } });
        return;
      }
      await dataGate;
      if (url.pathname === '/api/score') {
        await route.fulfill(state.rejectWrites ? { status: 500, json: { error: '测试写入失败' } } : { json: { ok: true, score: 21 } });
        return;
      }
      await route.fulfill({ json: url.pathname === '/api/classes' ? classes(nextUser, 20) : [] });
      return;
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
    if (!fs.existsSync(file)) { await route.fulfill({ status: 404, body: '' }); return; }
    await route.fulfill({ path: file });
  });
  await page.goto('https://jiafen.invalid/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'));
  return { page, state, errors, dialogs, writes, allowAuth, allowData, close: () => browser.close() };
}

test('登录检查未返回就显示缓存；后台同步前拒绝写入；同步后更新快照；离线重开保留界面', async () => {
  const f = await fixture();
  try {
    assert.match(await f.page.locator('#board').innerText(), /小组1/);
    assert.equal(await f.page.locator('#sync-status').innerText(), '未同步');
    await f.page.evaluate(() => addScore(1, 1));
    assert.equal(f.writes.length, 0);
    assert.match(f.dialogs[0], /该操作未生效/);
    assert.equal(await f.page.evaluate(() => state.classes[0].groups[0].score), 10);
    f.allowAuth();
    await f.page.waitForFunction(() => sessionVerified && sseConnected);
    assert.equal(await f.page.locator('#sync-status').innerText(), '未同步');
    await f.page.evaluate(() => addScore(1, 1));
    assert.equal(f.writes.length, 0);
    f.allowData();
    await f.page.waitForFunction(() => dataReady);
    assert.equal(await f.page.locator('#sync-status').innerText(), '已同步');
    assert.equal(await f.page.evaluate(() => state.classes[0].groups[0].score), 20);
    await f.page.evaluate(() => addScore(1, 1));
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('jiafen.startup.data.v1.1')).classes[0].groups[0].score === 21);
    f.state.rejectWrites = true;
    await f.page.evaluate(() => addScore(1, 1));
    assert.equal(await f.page.evaluate(() => state.classes[0].groups[0].score), 21);
    assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('jiafen.startup.data.v1.1')).classes[0].groups[0].score), 21);
    f.state.offline = true;
    await f.page.reload({ waitUntil: 'domcontentloaded' });
    await f.page.waitForFunction(() => state.classes.length === 1);
    assert.equal(await f.page.evaluate(() => state.classes[0].groups[0].score), 21);
    assert.equal(await f.page.locator('#sync-status').innerText(), '未同步');
    assert.equal(await f.page.locator('#app').isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('登录失效隐藏并清除快照，后台检查不反复清空登录输入', async () => {
  const f = await fixture({ invalid: true });
  try {
    f.allowAuth();
    await f.page.waitForFunction(() => !document.querySelector('#login').classList.contains('hidden'));
    assert.equal(await f.page.evaluate(() => localStorage.getItem('jiafen.startup.user.v1')), null);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('jiafen.startup.data.v1.1')), null);
    await f.page.locator('#login-name').fill('正在输入');
    await f.page.evaluate(async () => { await verifyStartupSession(); await verifyStartupSession(); });
    assert.equal(f.state.authRequests, 1);
    assert.equal(await f.page.locator('#login-name').inputValue(), '正在输入');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('验证为其他账号后立即清空旧账号界面，数据与快照不会串号', async () => {
  const f = await fixture({ nextUser: 2 });
  try {
    f.allowAuth();
    await f.page.waitForFunction(() => sessionVerified);
    assert.equal(await f.page.evaluate(() => state.classes.length), 0);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('jiafen.startup.user.v1')), null);
    assert.doesNotMatch(await f.page.locator('#board').innerText(), /小组1/);
    f.allowData();
    await f.page.waitForFunction(() => dataReady);
    assert.equal(await f.page.evaluate(() => state.classes[0].id), 2);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('jiafen.startup.user.v1')), '2');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('损坏的缓存不会白屏，仍可完成后台验证和数据同步', async () => {
  const f = await fixture({ broken: true });
  try {
    assert.equal(await f.page.locator('#sync-status').innerText(), '未同步');
    f.allowAuth(); f.allowData();
    await f.page.waitForFunction(() => dataReady);
    assert.equal(await f.page.evaluate(() => state.classes[0].groups[0].score), 20);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
