const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('monthly goal modal, award once, remote scoring and next month', async () => {
  const url = 'http://127.0.0.1:5042';
  const server = spawn(process.env.TEST_PYTHON || 'python3', [path.join(__dirname, 'monthly_server.py')], { windowsHide: true, env: { ...process.env, MONTHLY_TEST_PORT: '5042' }, stdio: 'pipe' });
  let browser, stderr = '';
  server.stderr.on('data', d => { stderr += d; });
  try {
    let ready = false;
    for (let i=0; i<100; i++) { try { if ((await fetch(url)).ok) { ready=true; break; } } catch {} await new Promise(r=>setTimeout(r,100)); }
    assert.ok(ready, stderr);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('jiafen.voiceOn', '0'); localStorage.setItem('jiafen.currentClassId', '1'); });
    const p = await context.newPage(), q = await context.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    for (const page of [p,q]) { await page.goto(url); await page.waitForFunction(() => state.authed); }
    await p.click('#btn-rewards');
    await p.click('#reward-monthly-open');
    assert.equal(await p.isChecked('#reward-monthly-enabled'), false);
    assert.equal(await p.isDisabled('#reward-monthly-target'), true);
    await p.check('#reward-monthly-enabled');
    await p.fill('#reward-monthly-target', '3');
    // Select historical and future months explicitly, with duplicate protection.
    await p.fill('#reward-monthly-month', '2026-10'); await p.click('#reward-monthly-add');
    await p.click('#reward-monthly-add');
    assert.equal(await p.locator('[data-month="2026-10"]').count(), 1);
    await p.fill('#reward-monthly-month', '2026-12'); await p.click('#reward-monthly-add');
    await p.screenshot({ path: path.join(__dirname, '../desktop/test-output/monthly-goal-modal.png') });
    await p.click('#reward-monthly-save');
    await p.waitForFunction(() => document.querySelector('#reward-monthly-modal').classList.contains('hidden'));
    const monthlyTokens = p.locator('[data-monthly-period="2026-11"]');
    await monthlyTokens.first().waitFor();
    assert.equal(await monthlyTokens.count(), 1);
    assert.equal(await p.locator('[data-monthly-period="2026-10"]').count(), 1);
    assert.equal(await p.locator('[data-monthly-period="2026-12"]').count(), 0);
    // Another device scores; the open rewards screen receives the goal award through SSE.
    const score = await q.request.post(url + '/api/score', { data: { group_id: 2, delta: 4 } });
    assert.equal(score.status(), 200);
    await p.waitForFunction(() => document.querySelectorAll('[data-monthly-period="2026-11"]').length===2);
    await p.click('#reward-monthly-open');
    assert.equal(await p.inputValue('#reward-monthly-target'), '3');
    assert.equal(await p.locator('#reward-monthly-months .reward-month-chip').count(), 3);
    // Removing a month and cancelling leaves the saved selection intact.
    await p.click('[data-month="2026-10"]');
    await p.click('#reward-monthly-cancel');
    await p.click('#reward-monthly-open');
    assert.equal(await p.locator('[data-month="2026-10"]').count(), 1);
    await p.click('#reward-monthly-cancel');
    const tid = (await score.json()).transaction_id;
    await q.request.post(url + `/api/transactions/${tid}/undo`);
    await q.request.post(url + '/api/score', { data: { group_id: 2, delta: 4 } });
    await p.waitForTimeout(350);
    assert.equal(await monthlyTokens.count(), 2);
    await q.request.post(url + '/__test_clock', { data: { time: '2026-12-01T00:00:00+08:00' } });
    await q.request.post(url + '/api/score', { data: { group_id: 1, delta: 3 } });
    await p.locator('[data-monthly-period="2026-12"]').waitFor();
    for (const width of [390,320]) {
      await p.setViewportSize({ width, height: 780 });
      await p.click('#reward-monthly-open');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const box = await p.locator('#reward-monthly-modal .modal-box').boundingBox();
      assert.ok(box.x >= 0 && box.x+box.width <= width);
      await p.press('#reward-monthly-enabled', 'Escape');
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); server.kill(); }
});
