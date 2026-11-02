'use strict';
const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, globalShortcut, screen, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serverOrigin, allowedRequest, SSEParser, trustedFileURL } = require('./core.cjs');
const DEFAULT_SERVER = 'https://jiafen.qiuzizhao.com';
let win, tray, store, settings = {}, quitting = false, compact = false, timer, controller, generation = 0;
let connected = false, reconnectDelay = 1000, expandedHeight = 500;
let speaker, voiceReady = false, voiceBusy = false, voiceQueue = [], voiceWatchdog;
if (process.env.JIAFEN_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.JIAFEN_DESKTOP_DATA));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
const emit = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('event', { type, data }); };
function save() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(path.join(app.getPath('userData'), 'desktop.json'), JSON.stringify(settings)); }
function status(on, message) { connected = on; emit('connection', { connected: on, message }); }
function stopEvents() { generation++; clearTimeout(timer); controller?.abort(); controller = null; status(false, '未连接'); }
function startEvents() {
  stopEvents(); const token = generation;
  async function run() {
    if (token !== generation || quitting) return;
    const abort = controller = new AbortController();
    let watchdog = setTimeout(() => abort.abort(), 20000);
    try {
      const res = await store.fetch(settings.server + '/api/events', { credentials: 'include', signal: abort.signal, redirect: 'error' });
      if (res.status === 401) { emit('unauthorized'); return; }
      if (!res.ok) throw new Error('实时连接失败');
      const parser = new SSEParser((type, data) => {
        clearTimeout(watchdog); watchdog = setTimeout(() => abort.abort(), 50000);
        reconnectDelay = 1000; status(true, '已同步'); emit(type, data);
      });
      const reader = res.body.getReader();
      while (token === generation) { const { done, value } = await reader.read(); if (done) break; parser.feed(value); }
    } catch (_) { /* reconnect below; no replay of old announcements */ }
    finally { clearTimeout(watchdog); }
    if (token === generation && !quitting) {
      status(false, '连接中断，正在重连'); timer = setTimeout(run, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  }
  void run();
}
function stopVoice() {
  voiceQueue = []; voiceReady = false; voiceBusy = false; clearTimeout(voiceWatchdog);
  const old = speaker; speaker = null; old?.kill(); emit('voice', { state: 'stopped' });
}
function pumpVoice() {
  while (voiceQueue.length && Date.now() - voiceQueue[0].at > 15000) voiceQueue.shift();
  if (!speaker || !voiceReady || voiceBusy || !voiceQueue.length) return;
  const item = voiceQueue.shift(); voiceBusy = true;
  speaker.stdin.write(JSON.stringify({ text: item.text }) + '\n');
  emit('voice', { state: 'speaking', text: item.text });
  voiceWatchdog = setTimeout(() => { stopVoice(); emit('voice', { state: 'error', message: '语音超时，请重试' }); }, 25000);
}
function speak(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 180) throw new Error('播报内容无效');
  if (process.platform !== 'win32') throw new Error('当前版本使用 Windows 本地语音');
  if (voiceQueue.length >= 6) voiceQueue.shift();
  voiceQueue.push({ text, at: Date.now() });
  if (!speaker) {
    let file = path.join(__dirname, 'voice.ps1');
    if (app.isPackaged) file = file.replace('app.asar', 'app.asar.unpacked');
    const child = speaker = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (speaker !== child) return;
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line === 'ready') { clearTimeout(voiceWatchdog); voiceReady = true; }
        if (line === 'done' || line === 'failed') {
          clearTimeout(voiceWatchdog); voiceBusy = false;
          emit('voice', { state: line === 'done' ? 'done' : 'error', message: '语音播放失败' });
        }
        pumpVoice();
      }
    });
    const fail = () => { if (speaker === child) { stopVoice(); emit('voice', { state: 'error', message: '无法启动 Windows 语音，请安装中文语音包' }); } };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    // Drain errors without displaying process command lines or user data.
    child.stderr.resume();
    voiceWatchdog = setTimeout(fail, 15000);
  }
  pumpVoice(); return { ok: true };
}
function keepVisible(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  return { x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) };
}
function show() { if (win) { win.show(); win.focus(); } }
function resize(small) {
  compact = small; const b = win.getBounds(); const [width, height] = small ? [210, 44] : [320, Math.min(expandedHeight, screen.getDisplayMatching(b).workArea.height)];
  win.setBounds({ width, height, ...keepVisible({ ...b, width, height }) }); emit('compact', small);
}
function register(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
        !trustedFileURL(event.senderFrame.url, path.join(__dirname, 'ui/index.html'))) throw new Error('不允许的调用');
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}
async function init() {
  try { settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop.json'), 'utf8')); } catch (_) {}
  try { settings.server = serverOrigin(process.env.JIAFEN_SERVER || settings.server || DEFAULT_SERVER); } catch (_) { settings.server = DEFAULT_SERVER; }
  store = session.fromPartition('persist:jiafen-account');
  store.setPermissionRequestHandler((_, __, callback) => callback(false));
  const work = screen.getPrimaryDisplay().workArea;
  const b = { width: 320, height: Math.min(expandedHeight, work.height), x: settings.x ?? (work.x + work.width - 336), y: settings.y ?? (work.y + 55) };
  win = new BrowserWindow({ ...b, ...keepVisible(b), frame: false, alwaysOnTop: true, resizable: false, maximizable: false, fullscreenable: false, show: false, backgroundColor: '#f5f7f9', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  register('config', () => ({ server: settings.server, compact, connected, shortcut: 'Ctrl+Alt+J' }));
  register('server', async value => { const origin = serverOrigin(value?.trim() || DEFAULT_SERVER); stopEvents(); stopVoice(); settings.server = origin; save(); return origin; });
  register('request', async ({ route, method, body }) => {
    if (!allowedRequest(route, method)) throw new Error('不允许的接口');
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await store.fetch(settings.server + route, { method, credentials: 'include', redirect: 'error', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
      const data = await res.json();
      if (res.status === 401) { stopEvents(); stopVoice(); emit('unauthorized'); }
      if (!res.ok) throw new Error(data.error || '请求失败');
      if (route === '/api/logout') { stopEvents(); stopVoice(); }
      return data;
    } catch (e) { if (e.name === 'AbortError') throw new Error('网络超时，请先核对分数，再决定是否重新操作'); throw e; }
    finally { clearTimeout(timeout); }
  });
  register('connect', on => { if (on) startEvents(); else stopEvents(); });
  register('fit', height => {
    if (typeof height !== 'number' || !Number.isFinite(height)) throw new Error('窗口高度无效');
    if (compact) return;
    const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea;
    expandedHeight = Math.min(Math.max(180, Math.ceil(height)), 600, area.height);
    if (b.width !== 320 || b.height !== expandedHeight) win.setBounds({ width: 320, height: expandedHeight, ...keepVisible({ ...b, width: 320, height: expandedHeight }) });
  });
  register('window', action => { if (action === 'compact') resize(true); else if (action === 'expand') resize(false); else if (action === 'hide') win.hide(); else if (action === 'quit') app.quit(); else if (action === 'pin') { win.setAlwaysOnTop(!win.isAlwaysOnTop()); return win.isAlwaysOnTop(); } });
  register('speak', speak); register('stop-voice', stopVoice);
  await win.loadFile(path.join(__dirname, 'ui/index.html'));
  win.showInactive();
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
  win.on('moved', () => { const pos = win.getPosition(); settings.x = pos[0]; settings.y = pos[1]; save(); });
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const cross = (x >= 14 && x <= 17 && y >= 7 && y <= 24) || (y >= 14 && y <= 17 && x >= 7 && x <= 24);
    const i = (y * 32 + x) * 4;
    pixels[i] = cross ? 255 : 246; pixels[i + 1] = cross ? 255 : 130; pixels[i + 2] = cross ? 255 : 59; pixels[i + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
  tray = new Tray(icon); tray.setToolTip('加分助手 · 后台同步与播报');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示加分助手', click: show }, { label: '收起为悬浮条', click: () => { resize(true); show(); } }, { label: '停止当前播报', click: stopVoice }, { type: 'separator' }, { label: '彻底退出', click: () => app.quit() }]));
  tray.on('double-click', show);
  const shortcutOK = globalShortcut.register('CommandOrControl+Alt+J', () => { if (win.isVisible()) win.hide(); else show(); });
  if (!shortcutOK) emit('notice', 'Ctrl+Alt+J 被其他程序占用，请使用托盘打开');
  powerMonitor.on('resume', () => emit('resume'));
}
app.on('second-instance', show);
if (locked) app.whenReady().then(init).catch(() => { app.quit(); });
app.on('before-quit', () => { quitting = true; stopEvents(); stopVoice(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
