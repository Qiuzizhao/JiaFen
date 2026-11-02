const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(r => setTimeout(r, ms));
test('圆圈、完整时间轴、拖动预览、重叠拦截、补建与多设备编辑同步', async () => {
  const url = 'http://127.0.0.1:5040';
  const server = spawn(process.env.TEST_PYTHON || 'python3', [path.join(__dirname, 'monthly_server.py')], { env: { ...process.env, MONTHLY_TEST_PORT: '5040' }, stdio: 'pipe' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await pause(100); }
    assert.ok(ready);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { localStorage.setItem('jiafen.currentClassId','1'); localStorage.setItem('jiafen.voiceOn','0'); });
    const p = await context.newPage(), q = await context.newPage(), errors = [];
    for (const page of [p,q]) {
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', d => d.accept());
      await page.goto(url);
      await page.waitForFunction(() => state.authed && dataReady);
    }
    await p.request.post(url + '/__test_clock', { data: { time: '2026-11-10T10:30+08:00' } });
    await p.request.post(url + '/api/score', { data: { group_id: 1, delta: 5 } });
    for (const page of [p,q]) {
      await page.click('#btn-lessons');
      await page.fill('#lessons-month','2026-11'); await page.dispatchEvent('#lessons-month','change');
      await page.waitForFunction(() => document.querySelector('.lesson-circle')?.textContent === '+7');
    }
    const cumulativeBefore = await p.request.get(url + '/api/classes').then(r => r.json());
    const monthlyBefore = await p.request.get(url + '/api/statistics/monthly?month=2026-11').then(r => r.json());
    assert.equal(await p.locator('#lesson-editor').isVisible(), false);
    await p.click('#lesson-edit');
    await p.waitForSelector('#lesson-boundary-start');
    assert.equal(await p.locator('#lesson-records tbody tr').count(), 3);
    const start = p.locator('#lesson-boundary-start');
    await start.scrollIntoViewIfNeeded();
    const box = await start.boundingBox();
    await p.mouse.move(box.x + 6, box.y + 45); await p.mouse.down(); await p.mouse.move(box.x + 36, box.y + 45, {steps:5}); await p.mouse.up();
    await p.waitForFunction(() => document.querySelector('#lesson-start').value.includes('10:10'),null,{timeout:3000});
    await p.waitForFunction(() => document.querySelector('#lesson-preview .lesson-preview-net')?.textContent.includes('+5'));
    await p.fill('#lesson-end','2026-11-10T10:20'); await p.dispatchEvent('#lesson-end','change');
    await p.waitForFunction(() => !document.querySelector('#lesson-save').disabled && document.querySelector('#lesson-preview .lesson-preview-net').textContent.endsWith('0'));
    await p.click('#lesson-save');
    await p.waitForFunction(() => document.querySelector('.lesson-circle')?.textContent === '0');
    await q.waitForFunction(() => document.querySelector('.lesson-circle')?.textContent === '0');
    // Boundary edits neither score nor reward.
    assert.deepEqual(await p.request.get(url + '/api/classes').then(r => r.json()), cumulativeBefore);
    assert.deepEqual(await p.request.get(url + '/api/statistics/monthly?month=2026-11').then(r => r.json()), monthlyBefore);
    await p.click('#lessons-new');
    await p.fill('#lesson-form-start','2026-11-10T10:20');
    await p.fill('#lesson-form-end','2026-11-10T11:00');
    await p.click('#lesson-form button[type=submit]');
    await p.waitForFunction(() => document.querySelectorAll('.lesson-circle').length === 2);
    await p.locator('[data-lesson]').first().click(); await p.click('#lesson-edit');
    await p.waitForSelector('#lesson-boundary-start');
    await p.fill('#lesson-end','2026-11-10T10:40'); await p.dispatchEvent('#lesson-end','change');
    await p.waitForFunction(() => document.querySelector('#lesson-preview').textContent.includes('重叠'));
    assert.equal(await p.locator('#lesson-save').isDisabled(), true);
    await p.click('#lesson-edit');  // discard dirty changes
    await p.click('#lessons-settings');
    await p.fill('#lesson-window', '45'); await p.click('#lesson-settings-form button[type=submit]');
    assert.equal((await p.request.get(url+'/api/lessons/settings').then(r=>r.json())).window_minutes,45);
    // A manually added class can have no scoring records.
    await p.click('#lessons-new');
    await p.fill('#lesson-form-start','2026-11-11T08:00');
    await p.fill('#lesson-form-end','2026-11-11T08:45');
    await p.click('#lesson-form button[type=submit]');
    await p.waitForFunction(() => document.querySelectorAll('.lesson-circle').length===3);
    await p.setViewportSize({width:390,height:844});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if (process.env.LESSONS_SCREENSHOT) await p.screenshot({path:process.env.LESSONS_SCREENSHOT});
    assert.deepEqual(errors,[]);
  } finally { if(browser)await browser.close();server.kill('SIGTERM'); }
});
