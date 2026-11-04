const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('account settings date, average recalculation, real two-page SSE and responsive modal', async () => {
  const url = 'http://127.0.0.1:5047';
  const server = spawn(process.env.TEST_PYTHON || 'python3', [path.join(__dirname, 'monthly_server.py')], { windowsHide: true, env: { ...process.env, MONTHLY_TEST_PORT: '5047' }, stdio: 'pipe' });
  let browser, stderr = '';
  server.stderr.on('data', data => { stderr += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await new Promise(r=>setTimeout(r,100)); }
    assert.ok(ready, stderr);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('jiafen.voiceOn', '0'); localStorage.setItem('jiafen.currentClassId', '1'); });
    const p = await context.newPage(), q = await context.newPage(), errors = [];
    for (const page of [p,q]) {
      page.on('pageerror', error=>errors.push(error.message));
      await page.clock.install({ time: new Date('2026-11-30T12:00:00+08:00') });
      await page.goto(url); await page.waitForFunction(()=>state.authed);
    }
    for (const cid of [1,2]) for (const month of ['2026-09','2026-10','2026-11']) {
      const { lessons } = await (await p.request.get(`${url}/api/classes/${cid}/lessons?month=${month}`)).json();
      for (const lesson of lessons) {
        const r = await p.request.put(`${url}/api/lessons/${lesson.id}`, { data: { revision: lesson.revision, start_at: lesson.start_at, end_at: lesson.end_at, status: 'recognized' } });
        assert.equal(r.status(),200);
      }
    }
    async function firstScore(page, text) {
      await page.waitForFunction(text => document.querySelector('#leaderboard').getAttribute('aria-busy')!=='true' && document.querySelector('#leaderboard .lb-score')?.textContent === text, text);
    }
    for (const page of [p,q]) { await page.click('#lb-history-btn'); await page.click('#lb-average-btn'); await firstScore(page, '5.00分/节'); }
    await p.click('#btn-settings');
    await p.waitForFunction(()=>!document.querySelector('#average-start-date').disabled);
    assert.equal(await p.inputValue('#average-start-date'), '');
    await p.fill('#average-start-date','2026-11-01');
    await p.screenshot({ path: path.join(__dirname,'../desktop/test-output/site-settings-date.png') });
    await p.click('#site-settings-save');
    await p.waitForFunction(()=>document.querySelector('#site-settings-modal').classList.contains('hidden'));
    await firstScore(p,'3.00分/节'); await firstScore(q,'3.00分/节');
    await p.click('#lb-classes-btn'); await firstScore(p,'4.00分/节');
    await p.click('#lb-school-btn'); await firstScore(p,'4.00分/节');
    await p.click('#lb-class-btn'); await firstScore(p,'3.00分/节');
    await p.click('#lb-current-btn'); await p.fill('#lb-month','2026-10'); await p.dispatchEvent('#lb-month','change');
    await firstScore(p,'无课堂');
    await p.click('#btn-settings'); await p.waitForFunction(()=>!document.querySelector('#average-start-date').disabled);
    assert.equal(await p.inputValue('#average-start-date'),'2026-11-01');
    await p.fill('#average-start-date','2026-10-01'); await p.click('#site-settings-save');
    await firstScore(p,'7.00分/节'); await firstScore(q,'5.00分/节');
    await p.click('#btn-settings'); await p.waitForFunction(()=>!document.querySelector('#average-start-date').disabled);
    await p.fill('#average-start-date','2026-11-02'); await p.click('#site-settings-cancel');
    assert.equal((await (await p.request.get(url+'/api/settings')).json()).average_start_date,'2026-10-01');
    for (const width of [390,320]) {
      await p.setViewportSize({width,height:780}); await p.click('#btn-settings');
      await p.waitForFunction(()=>!document.querySelector('#average-start-date').disabled);
      const box=await p.locator('.site-settings-box').boundingBox(); assert.ok(box.x>=0 && box.x+box.width<=width);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await p.press('#average-start-date','Escape');
    }
    await p.click('#btn-settings'); await p.waitForFunction(()=>!document.querySelector('#average-start-date').disabled);
    await p.click('#average-start-clear'); await p.click('#site-settings-save');
    await p.waitForFunction(()=>document.querySelector('#site-settings-modal').classList.contains('hidden'));
    assert.equal((await (await p.request.get(url+'/api/settings')).json()).average_start_date,null);
    await p.click('#lb-total-btn'); await firstScore(p,'+7分');
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); server.kill(); }
});
