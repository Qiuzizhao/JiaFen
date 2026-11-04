const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('12种排行榜组合、课堂编辑SSE、质量拦截、零分母及原始比值排序', async () => {
  const url = 'http://127.0.0.1:5041';
  const server = spawn(process.env.TEST_PYTHON || 'python3', [path.join(__dirname, 'monthly_server.py')], { windowsHide: true, env: { ...process.env, MONTHLY_TEST_PORT: '5041' }, stdio: 'pipe' });
  let browser, stderr = '';
  server.stderr.on('data', data => { stderr += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch (_) {} await pause(100); }
    assert.ok(ready, stderr);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('jiafen.voiceOn', '0'); localStorage.setItem('jiafen.currentClassId', '1'); });
    const p = await context.newPage(), q = await context.newPage(), errors = [];
    for (const page of [p, q]) {
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-11-30T20:00:00+08:00') });
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#leaderboard .lb-score'));
    }
    // Confirm the fixture's automatically detected windows using the real lesson API.
    for (const cid of [1, 2]) for (const month of ['2026-09', '2026-10', '2026-11']) {
      const data = await (await q.request.get(`${url}/api/classes/${cid}/lessons?month=${month}`)).json();
      for (const lesson of data.lessons) {
        const res = await q.request.put(`${url}/api/lessons/${lesson.id}`, { data: { revision: lesson.revision, start_at: lesson.start_at, end_at: lesson.end_at, status: 'recognized' } });
        assert.equal(res.status(), 200, await res.text());
      }
    }
    const expected = {
      month: { total: { class: ['+3分', '-1分'], school: ['+4分', '+3分', '-1分'], classes: ['+4分', '+2分'] }, average: { class: ['3.00分/节', '-1.00分/节'], school: ['4.00分/节', '3.00分/节', '-1.00分/节'], classes: ['4.00分/节', '2.00分/节'] } },
      history: { total: { class: ['+15分', '-1分'], school: ['+15分', '+4分', '-1分'], classes: ['+14分', '+4分'] }, average: { class: ['5.00分/节', '-0.33分/节'], school: ['5.00分/节', '4.00分/节', '-0.33分/节'], classes: ['4.67分/节', '4.00分/节'] } },
    };
    const scopeButtons = { class: '#lb-class-btn', school: '#lb-school-btn', classes: '#lb-classes-btn' };
    async function scores(wanted) {
      await p.clock.runFor(250);
      await p.waitForFunction(values => document.querySelector('#leaderboard').getAttribute('aria-busy') !== 'true' && JSON.stringify([...document.querySelectorAll('#leaderboard .lb-score')].map(el => el.textContent)) === JSON.stringify(values), wanted);
    }
    await p.evaluate(() => {
      window.rankingEmptyFrames = 0;
      new MutationObserver(() => { if (!document.querySelector('#leaderboard .lb-item')) window.rankingEmptyFrames++; }).observe(document.querySelector('#leaderboard'), { childList: true, subtree: true });
    });
    for (const period of ['month', 'history']) {
      if (period === 'month') { await p.fill('#lb-month', '2026-11'); await p.dispatchEvent('#lb-month', 'change'); }
      else await p.click('#lb-history-btn');
      for (const metric of ['total', 'average']) {
        await p.click(metric === 'total' ? '#lb-total-btn' : '#lb-average-btn');
        for (const scope of ['class', 'school', 'classes']) { await p.click(scopeButtons[scope]); await scores(expected[period][metric][scope]); }
      }
    }
    assert.equal(await p.evaluate(() => window.rankingEmptyFrames), 0);
    await p.evaluate(() => { window.rankingFirstRow = document.querySelector('#leaderboard').firstElementChild; scheduleMonthlyLeaderboardRefresh(); });
    await scores(expected.history.average.classes);
    assert.equal(await p.evaluate(() => window.rankingFirstRow === document.querySelector('#leaderboard').firstElementChild), true);
    await p.clock.fastForward(15000);
    await scores(expected.history.average.classes);
    assert.equal(await p.evaluate(() => window.rankingFirstRow === document.querySelector('#leaderboard').firstElementChild), true);
    await p.click('#lb-current-btn');
    await p.fill('#lb-month', '2026-11'); await p.dispatchEvent('#lb-month', 'change');
    await scores(['4.00分/节', '2.00分/节']);
    // A zero-score manual lesson changes the shared denominator; a second device sees it live.
    const created = await q.request.post(url + '/api/classes/1/lessons', { data: { start_at: '2026-11-20 08:00:00', end_at: '2026-11-20 08:45:00' } });
    assert.equal(created.status(), 201);
    await scores(['4.00分/节', '1.00分/节']);
    const lessonId = (await created.json()).id;
    let lesson = await (await q.request.get(url + '/api/lessons/' + lessonId)).json();
    const changed = await q.request.put(url + '/api/lessons/' + lessonId, { data: { revision: lesson.revision, start_at: lesson.start_at, end_at: lesson.end_at, status: 'review' } });
    assert.equal(changed.status(), 200);
    await scores(['4.00分/节', '待校正']);
    assert.equal(await p.locator('#leaderboard [data-average-ranked="false"] .rank').textContent(), '—');
    await p.fill('#lb-month', '2026-10'); await p.dispatchEvent('#lb-month', 'change');
    await scores(['7.00分/节', '无课堂']);
    // Both displayed values round to .33; rank by exact cross-products, then test a true tie.
    let tied = false;
    await context.route('**/api/statistics/averages?*', async route => {
      const response = await route.fetch(), data = await response.json();
      for (const cls of data.classes) {
        cls.quality.can_compute = true;
        for (const group of cls.groups) {
          group.average = 0; group.exact_ratio = { numerator: 0, denominator: 3 };
          if (group.group_id === 1) { group.average = .33; group.exact_ratio = { numerator: 1, denominator: 3 }; }
          if (group.group_id === 3) { group.average = .33; group.exact_ratio = tied ? { numerator: 3333, denominator: 9999 } : { numerator: 3334, denominator: 10000 }; }
        }
      }
      await route.fulfill({ response, json: data });
    });
    await p.click('#lb-school-btn'); await p.click('#lb-history-btn');
    await scores(['0.33分/节', '0.33分/节', '0.00分/节']);
    assert.match(await p.locator('#leaderboard .lb-name').first().textContent(), /B班/);
    tied = true;
    await p.evaluate(() => scheduleMonthlyLeaderboardRefresh());
    await scores(['0.33分/节', '0.33分/节', '0.00分/节']);
    assert.deepEqual(await p.locator('#leaderboard .rank').allTextContents(), ['1', '1', '3']);
    for (const width of [320, 390, 1440]) {
      await p.setViewportSize({ width, height: 900 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
});
