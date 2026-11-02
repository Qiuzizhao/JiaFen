const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('三个范围切换、指定历史月、真实双页面SSE同步及北京时间月初切换', async () => {
  const port = 5039, url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.TEST_PYTHON || 'python3', [path.join(__dirname, 'monthly_server.py')], { env: { ...process.env, MONTHLY_TEST_PORT: String(port) }, stdio: 'pipe' });
  let stderr = ''; server.stderr.on('data', d => stderr += d);
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
      await pause(100);
    }
    assert.ok(ready, stderr);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await context.newPage(), q = await context.newPage();
    const errors = [];
    for (const page of [p, q]) {
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({ time: new Date('2026-11-30T23:59:50+08:00') });
      await page.addInitScript(() => { localStorage.setItem('jiafen.voiceOn', '0'); localStorage.setItem('jiafen.currentClassId', '1'); });
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#leaderboard .lb-score'));
    }
    const scores = page => page.locator('#leaderboard .lb-score').allTextContents();
    assert.deepEqual(await scores(p), ['+3分', '-1分']);
    await p.click('#lb-school-btn');
    assert.deepEqual(await scores(p), ['+4分', '+3分', '-1分']);
    await p.click('#lb-classes-btn');
    assert.deepEqual(await scores(p), ['+4分', '+2分']);
    await p.click('#lb-history-btn');
    assert.deepEqual(await scores(p), ['+14分', '+4分']);
    await p.click('#lb-current-btn');
    await p.fill('#lb-month', '2026-10'); await p.dispatchEvent('#lb-month', 'change');
    await p.waitForFunction(() => document.querySelector('#lb-period-label').textContent.includes('10月') && document.querySelector('#leaderboard .lb-score')?.textContent === '+7分');
    await q.click('#lb-school-btn');
    const scoreResponse = await p.request.post(url + '/api/score', { data: { group_id: 1, delta: 2 } });
    assert.equal(scoreResponse.status(), 200);
    // Real EventSource on the second page must trigger a monthly refresh.
    await q.clock.runFor(300);
    await q.waitForFunction(() => document.querySelector('#leaderboard .lb-score')?.textContent === '+5分');
    await p.click('#lb-current-btn');
    await p.waitForFunction(() => document.querySelector('#leaderboard .lb-score')?.textContent === '+4分');
    // Fix second page to November; it must not follow the new month.
    await q.fill('#lb-month', '2026-11'); await q.dispatchEvent('#lb-month', 'change');
    await q.clock.runFor(200);
    await p.request.post(url + '/__test_clock', { data: { time: '2026-12-01T00:00:10+08:00' } });
    await p.clock.fastForward(20000);
    await p.waitForFunction(() => document.querySelector('#lb-period-label').textContent.includes('12月') && document.querySelector('#leaderboard .lb-score')?.textContent === '0分');
    await q.clock.fastForward(20000);
    await q.waitForFunction(() => document.querySelector('#leaderboard .lb-score')?.textContent === '+5分');
    assert.match(await q.locator('#lb-period-label').textContent(), /11月/);
    // A new December operation affects December only.
    await p.request.post(url + '/api/score', { data: { group_id: 1, delta: 1 } });
    await p.clock.runFor(300); await q.clock.runFor(300);
    await p.waitForFunction(() => document.querySelector('#leaderboard .lb-score')?.textContent === '+1分');
    assert.equal((await scores(q))[0], '+5分');
    await p.click('#lb-history-btn');
    assert.equal((await scores(p))[0], '+17分'); // A: (5+7+3+2+1)-1
    // Mobile layout does not overflow horizontally.
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const width of [320, 1440]) {
      await p.setViewportSize({ width, height: 900 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
});
