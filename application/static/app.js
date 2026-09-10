const $ = (s) => document.querySelector(s);
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];
let colorIndex = 0;

// 本设备的随机标识：服务端广播变更时带上它，用来忽略自己触发的回显
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

const state = {
  authed: false,
  classes: [],
  currentClassId: null,
  history: [],
  dragActive: false,
  pendingRefresh: false,
  leaderboardMode: 'class',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function pickColor() { return PALETTE[colorIndex++ % PALETTE.length]; }
function saveSel() { localStorage.setItem('jiafen.currentClassId', String(state.currentClassId || '')); }
function loadSel() { const v = localStorage.getItem('jiafen.currentClassId'); return v ? Number(v) : null; }
function getCurrentClass() { return state.classes.find(c => c.id === state.currentClassId) || null; }
function findGroup(gid) {
  for (const c of state.classes) {
    const g = c.groups.find(x => x.id === gid);
    if (g) return g;
  }
  return null;
}
function findClassOfGroup(gid) {
  for (const c of state.classes) {
    if (c.groups.some(x => x.id === gid)) return c;
  }
  return null;
}
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function api(path, opts = {}) {
  const cfg = { ...opts, headers: { ...(opts.headers || {}) } };
  if (cfg.body && typeof cfg.body !== 'string') {
    cfg.body = JSON.stringify(cfg.body);
    cfg.headers['Content-Type'] = 'application/json';
  }
  const mutating = (cfg.method || 'GET').toUpperCase() !== 'GET';
  if (mutating) { pendingOps++; renderSyncStatus(); }
  try {
    const res = await fetch(path, cfg);
    if (res.status === 401) { showLogin(); throw new Error('未登录'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  } finally {
    if (mutating) { pendingOps--; renderSyncStatus(); }
  }
}

function showLogin() {
  state.authed = false;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pw').value = '';
  $('#login-err').textContent = '';
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

// 移动端班级弹窗（桌面端这些函数为空操作）
function openMobileClassPanel() {
  $('#class-backdrop').classList.add('open');
  document.querySelector('.sidebar').classList.add('open');
}
function closeMobileClassPanel() {
  $('#class-backdrop').classList.remove('open');
  document.querySelector('.sidebar').classList.remove('open');
}

// ---------------- 渲染 ----------------
function renderSidebar() {
  const el = $('#class-list');
  if (!state.classes.length) {
    el.innerHTML = '<div class="empty">还没有班级，先新建一个吧</div>';
    return;
  }
  el.innerHTML = state.classes.map(c => `
    <div class="class-item ${c.id === state.currentClassId ? 'active' : ''}" data-id="${c.id}">
      <div class="name">${esc(c.name)} <span class="muted" style="font-size:12px">${c.groups.length}组</span></div>
      <div class="tools">
        <button class="icon-btn" onclick="renameClass(${c.id})">✎</button>
        <button class="icon-btn danger" onclick="delClass(${c.id})">✕</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('.class-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      state.currentClassId = Number(item.dataset.id);
      saveSel();
      refresh();
      closeMobileClassPanel();
    });
  });
}

function renderMobileClassSelect() {
  const sel = $('#mobile-class-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">请选择班级</option>' + state.classes.map(c =>
    `<option value="${c.id}"${c.id === state.currentClassId ? ' selected' : ''}>${esc(c.name)}</option>`
  ).join('');
}

function schoolRankMap() {
  const all = [];
  state.classes.forEach(c => c.groups.forEach(g => all.push({ id: g.id, score: g.score })));
  all.sort((a, b) => b.score - a.score);
  const m = new Map();
  all.forEach((g, i) => m.set(g.id, i + 1));
  return m;
}

const RANK_MEDALS = ['🥇', '🥈', '🥉'];
function rankBadgeHTML(rk) {
  const medal = rk <= 3 ? `<span class="rk-medal">${RANK_MEDALS[rk - 1]}</span>` : '';
  return `<div class="school-rank rk${Math.min(rk, 3)}" title="全校排名第 ${rk} 名">${medal}<span class="rk-num">#${rk}</span></div>`;
}

// 分数变化后只原位刷新卡片右下角的全校排名角标，不重建整个看板
function updateSchoolRanks() {
  const ranks = schoolRankMap();
  document.querySelectorAll('#board .group-card').forEach(card => {
    const rk = ranks.get(Number(card.dataset.gid));
    const badge = card.querySelector('.school-rank');
    if (rk == null) { if (badge) badge.remove(); return; }
    if (badge) badge.outerHTML = rankBadgeHTML(rk);
    else card.insertAdjacentHTML('beforeend', rankBadgeHTML(rk));
  });
}

// 分数变动后统一刷新：排行榜 + 投屏 + 全校排名角标
function refreshScoreViews() {
  renderLeaderboard();
  renderProjector();
  updateSchoolRanks();
}

function groupCard(g, ranks) {
  const q = [[1, '+1'], [2, '+2'], [5, '+5'], [-1, '-1'], [-2, '-2'], [-5, '-5']];
  const rk = ranks.get(g.id);
  const rankBadge = rk != null ? rankBadgeHTML(rk) : '';
  return `
  <div class="group-card" data-gid="${g.id}" style="--c:${esc(g.color)}">
    <div class="group-head">
      <span class="dot"></span>
      <span class="gname" title="${esc(g.name)}">${esc(g.name)}</span>
      <button class="icon-btn drag-handle" drag-gid="${g.id}" title="长按拖拽调整顺序">☰</button>
      <button class="icon-btn" onclick="renameGroup(${g.id})">✎</button>
      <button class="icon-btn danger" onclick="delGroup(${g.id})">✕</button>
    </div>
    <div class="gscore">${g.score}</div>
    <div class="quick">
      ${q.map(([v, l]) => `<button class="qbtn ${v > 0 ? 'up' : 'down'}" onclick="addScore(${g.id},${v})">${l}</button>`).join('')}
    </div>
    <div class="custom">
      <div class="row">
        <input type="number" id="amount-${g.id}" class="amount" placeholder="分值">
        <button onclick="applyCustom(${g.id})">记分</button>
      </div>
    </div>
    ${rankBadge}
  </div>`;
}

function renderBoard() {
  const cls = getCurrentClass();
  const title = $('#current-class-name');
  const board = $('#board');
  const addBtn = $('#btn-add-group');
  const resetBtn = $('#btn-reset');
  const csBar = $('#class-score');
  csBar.classList.toggle('disabled', !cls || !cls.groups.length);
  if (!cls) {
    title.textContent = '请选择班级';
    board.innerHTML = '<div class="empty">请先在左侧选择或新建一个班级</div>';
    addBtn.disabled = true;
    resetBtn.disabled = true;
    return;
  }
  title.textContent = cls.name;
  addBtn.disabled = false;
  resetBtn.disabled = false;
  if (!cls.groups.length) {
    board.innerHTML = '<div class="empty">这个班级还没有小组，点击右上角「添加小组」</div>';
    return;
  }
  const ranks = schoolRankMap();
  board.innerHTML = cls.groups.map(g => groupCard(g, ranks)).join('');
}

function renderLeaderboard() {
  const el = $('#leaderboard');
  const medals = ['🥇', '🥈', '🥉'];
  let items = [];
  let empty = '暂无小组';
  if (state.leaderboardMode === 'school') {
    state.classes.forEach(c => c.groups.forEach(g => items.push({ ...g, tag: c.name + ' · ' + g.name })));
  } else if (state.leaderboardMode === 'classes') {
    // 班级排行：以整个班级为单位，班级分数 = 全班所有小组积分之和
    empty = '暂无班级';
    items = state.classes.map(c => ({
      id: 'c' + c.id,
      tag: c.name,
      color: (c.groups[0] && c.groups[0].color) || '#3b82f6',
      score: c.groups.reduce((sum, g) => sum + g.score, 0),
    }));
  } else {
    const cls = getCurrentClass();
    if (cls) items = cls.groups.map(g => ({ ...g, tag: g.name }));
  }
  if (!items.length) { el.innerHTML = `<div class="empty">${empty}</div>`; return; }
  items.sort((a, b) => b.score - a.score);
  el.innerHTML = items.map((g, i) => `
    <div class="lb-item ${i < 3 ? 'rank' + (i + 1) : ''}" style="--c:${esc(g.color)}">
      <span class="rank">${medals[i] || (i + 1)}</span>
      <span class="dot"></span>
      <span class="lb-name" title="${esc(g.tag)}">${esc(g.tag)}</span>
      <span class="lb-score">${g.score}</span>
    </div>`).join('');
}

function setLeaderboardMode(mode) {
  state.leaderboardMode = mode;
  $('#lb-class-btn').classList.toggle('on', mode === 'class');
  $('#lb-school-btn').classList.toggle('on', mode === 'school');
  $('#lb-classes-btn').classList.toggle('on', mode === 'classes');
  renderLeaderboard();
}

function renderHistory() {
  const el = $('#history');
  if (!state.history.length) { el.innerHTML = '<div class="empty">暂无记分记录</div>'; return; }
  // 全班加减分同一批次插入多条记录，这里合并成一条显示
  const items = [];
  state.history.forEach(h => {
    const prev = items[items.length - 1];
    if (h.batch_id && prev && prev.batch_id === h.batch_id) { prev.count++; return; }
    items.push({ ...h, count: 1 });
  });
  el.innerHTML = items.map(h => {
    const base = h.batch_id ? `全班 · ${h.count}组` : h.group_name;
    const label = h.class_name ? `${h.class_name} · ${base}` : base;
    return `
    <div class="hist-item">
      <span class="hist-delta ${h.delta > 0 ? 'pos' : 'neg'}">${h.delta > 0 ? '+' : ''}${h.delta}</span>
      <span class="hist-group${h.batch_id ? ' batch' : ''}" title="${esc(label)}">${esc(label)}</span>
      ${h.reason ? `<span class="hist-reason" title="${esc(h.reason)}">${esc(h.reason)}</span>` : ''}
      <span class="hist-time">${esc(h.created_at.slice(5, 16))}</span>
    </div>`;
  }).join('');
}

function renderProjector() {
  const cls = getCurrentClass();
  const el = $('#projector-board');
  const title = $('#projector-title');
  if (!cls) { title.textContent = '课堂小组积分'; el.innerHTML = ''; return; }
  title.textContent = cls.name;
  if (!cls.groups.length) { el.innerHTML = '<div class="empty">暂无小组</div>'; return; }
  // Projector board lists groups in their fixed custom order (backend returns sort_order), not by score.
  const order = cls.groups;
  el.innerHTML = order.map(g => `
    <div class="proj-card" data-gid="${g.id}" style="--c:${esc(g.color)}">
      <div class="p-name">${esc(g.name)}</div>
      <div class="p-score">${g.score}</div>
      <div class="p-actions">
        <button class="pbtn plus" onclick="addScore(${g.id},1)" title="加 1 分">+1</button>
        <button class="pbtn minus" onclick="addScore(${g.id},-1)" title="减 1 分">-1</button>
      </div>
    </div>`).join('');
}

// 只更新一个小组的分数，不重建整个看板（重建会丢焦点、引发布局抖动）
function setGroupScore(gid, score, rerender = true) {
  const g = findGroup(gid);
  if (g) g.score = score;
  const el = document.querySelector('#board .group-card[data-gid="' + gid + '"] .gscore');
  if (el) el.textContent = score;
  if (rerender) refreshScoreViews();
}
function setGroupScores(list) {
  (list || []).forEach(s => setGroupScore(s.id, s.score, false));
  refreshScoreViews();
}
function prependHistoryLocal(entry) {
  state.history.unshift(entry);
  if (state.history.length > 100) state.history.length = 100;
  renderHistory();
}

let refreshing = false;
let refreshQueued = false;
let lastRefreshAt = 0;
async function refresh() {
  // 已有请求在跑时排队一次，而不是直接丢弃（连点时不再漏掉最新状态）
  if (refreshing) { refreshQueued = true; return; }
  if (state.dragActive) { state.pendingRefresh = true; return; }
  refreshing = true;
  try {
    const [classes, history] = await Promise.all([
      api('/api/classes'),
      api('/api/history'),
    ]);
    state.classes = classes;
    state.history = history;
    lastRefreshAt = Date.now();
    renderSidebar();
    renderMobileClassSelect();
    renderBoard();
    renderLeaderboard();
    renderHistory();
    renderProjector();
  } catch (e) { /* 忽略瞬时错误 */ } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}

// 切回本页/重新聚焦时对账一次，避免长时间不刷新造成状态漂移
function reconcileIfStale() {
  if (Date.now() - lastRefreshAt > 20000) refresh();
}

// ---------------- 操作 ----------------
// 记分：先本地立即生效（点击零延迟），再发请求；失败回滚
async function addScore(gid, delta, reason = '') {
  const g = findGroup(gid);
  if (!g) { alert('小组不存在，请刷新页面'); return; }
  const prev = g.score;
  setGroupScore(gid, prev + delta);
  announceScore(g.name, delta);
  try {
    const res = await api('/api/score', {
      method: 'POST',
      body: { group_id: gid, delta, reason, client: CLIENT_ID },
    });
    if (typeof res.score === 'number') setGroupScore(gid, res.score);
    const cls = state.classes.find(c => c.groups.includes(g));
    prependHistoryLocal({
      id: 'local-' + Date.now(), delta, reason, created_at: localStamp(),
      group_id: gid, batch_id: null, group_name: g.name,
      class_name: cls ? cls.name : '',
    });
  } catch (e) {
    setGroupScore(gid, prev);
    alert(e.message);
  }
}
function applyCustom(gid) {
  const amt = $('#amount-' + gid).value.trim();
  if (!amt) { alert('请输入分值'); return; }
  const v = parseInt(amt, 10);
  if (isNaN(v) || v === 0) { alert('请输入有效的分值'); return; }
  addScore(gid, v);
  $('#amount-' + gid).value = '';
}
// 全班加减分：本班每个小组同时加减同一个分值
async function addClassScore(delta, reason = '') {
  const cls = getCurrentClass();
  if (!cls) { alert('请先选择班级'); return; }
  if (!cls.groups.length) { alert('这个班级还没有小组'); return; }
  const prev = cls.groups.map(g => ({ id: g.id, score: g.score }));
  cls.groups.forEach(g => setGroupScore(g.id, g.score + delta, false));
  refreshScoreViews();
  announceScore('全班', delta);
  try {
    const res = await api('/api/classes/' + cls.id + '/score', {
      method: 'POST',
      body: { delta, reason, client: CLIENT_ID },
    });
    if (Array.isArray(res.scores)) setGroupScores(res.scores);
    const batchId = res.batch_id || ('local-' + Date.now());
    const stamp = localStamp();
    const entries = cls.groups.map(g => ({
      id: 'local-' + g.id + '-' + stamp, delta, reason, created_at: stamp,
      group_id: g.id, batch_id: batchId, group_name: g.name, class_name: cls.name,
    }));
    entries.reverse().forEach(prependHistoryLocal);
  } catch (e) {
    prev.forEach(p => setGroupScore(p.id, p.score, false));
    refreshScoreViews();
    alert(e.message);
  }
}
function applyClassCustom() {
  const input = $('#class-amount');
  const amt = input.value.trim();
  if (!amt) { alert('请输入分值'); return; }
  const v = parseInt(amt, 10);
  if (isNaN(v) || v === 0) { alert('请输入有效的分值'); return; }
  addClassScore(v);
  input.value = '';
}
async function doUndo() {
  const last = state.history[0];
  if (!last) { alert('没有可撤销的记录'); return; }
  // 本地先按最后一条记录回退，立即反馈
  const targets = last.batch_id ? state.history.filter(h => h.batch_id === last.batch_id) : [last];
  const snapshot = targets.map(h => {
    const g = findGroup(h.group_id);
    return { id: h.group_id, score: g ? g.score : 0 };
  });
  targets.forEach(h => {
    const g = findGroup(h.group_id);
    if (g) setGroupScore(g.id, g.score - h.delta, false);
  });
  refreshScoreViews();
  try {
    const res = await api('/api/undo', { method: 'POST', body: { client: CLIENT_ID } });
    if (!res.undone) {
      snapshot.forEach(s => setGroupScore(s.id, s.score, false));
      refreshScoreViews();
      alert('没有可撤销的记录');
      return;
    }
    if (Array.isArray(res.scores)) setGroupScores(res.scores);
    state.history = last.batch_id
      ? state.history.filter(h => h.batch_id !== last.batch_id)
      : state.history.slice(1);
    renderHistory();
    refresh();   // 后台对账，不阻塞界面
  } catch (e) {
    snapshot.forEach(s => setGroupScore(s.id, s.score, false));
    refreshScoreViews();
    alert(e.message);
  }
}
function openReset() {
  const cls = getCurrentClass();
  if (!cls) return;
  $('#reset-class-name').textContent = cls.name;
  $('#reset-pw').value = '';
  $('#reset-err').textContent = '';
  $('#reset-modal').classList.remove('hidden');
  setTimeout(() => { try { $('#reset-pw').focus(); } catch (_) {} }, 60);
}
function closeReset() {
  $('#reset-modal').classList.add('hidden');
}
async function confirmReset() {
  const cls = getCurrentClass();
  if (!cls) return;
  const pw = $('#reset-pw').value;
  try {
    await api('/api/classes/' + cls.id + '/reset', { method: 'POST', body: { password: pw } });
    closeReset();
    await refresh();
  } catch (e) {
    $('#reset-err').textContent = e.message;
  }
}

// ---------------- 班级/小组管理 ----------------
async function createClass() {
  const input = $('#class-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await api('/api/classes', { method: 'POST', body: { name } });
    input.value = '';
    state.currentClassId = res.id;
    saveSel();
    await refresh();
    closeMobileClassPanel();
  } catch (e) { alert(e.message); }
}
async function renameClass(id) {
  const cls = state.classes.find(c => c.id === id);
  const name = prompt('重命名班级', cls ? cls.name : '');
  if (name === null) return;
  try {
    await api('/api/classes/' + id, { method: 'PATCH', body: { name: name.trim() } });
    await refresh();
  } catch (e) { alert(e.message); }
}
async function delClass(id) {
  const cls = state.classes.find(c => c.id === id);
  if (!confirm('确定删除班级「' + (cls ? cls.name : '') + '」？该班级的小组和记分也会被清空。')) return;
  try {
    await api('/api/classes/' + id, { method: 'DELETE' });
    if (state.currentClassId === id) { state.currentClassId = null; saveSel(); }
    await refresh();
  } catch (e) { alert(e.message); }
}
async function createGroup() {
  const cls = getCurrentClass();
  if (!cls) { alert('请先选择班级'); return; }
  const name = prompt('输入小组名称');
  if (name === null || !name.trim()) return;
  try {
    await api('/api/classes/' + cls.id + '/groups', { method: 'POST', body: { name: name.trim(), color: pickColor() } });
    await refresh();
  } catch (e) { alert(e.message); }
}
async function renameGroup(id) {
  const g = state.classes.flatMap(c => c.groups).find(x => x.id === id);
  const name = prompt('重命名小组', g ? g.name : '');
  if (name === null) return;
  try {
    await api('/api/groups/' + id, { method: 'PATCH', body: { name: name.trim() } });
    await refresh();
  } catch (e) { alert(e.message); }
}
async function delGroup(id) {
  const g = state.classes.flatMap(c => c.groups).find(x => x.id === id);
  if (!confirm('确定删除小组「' + (g ? g.name : '') + '」？')) return;
  try {
    await api('/api/groups/' + id, { method: 'DELETE' });
    await refresh();
  } catch (e) { alert(e.message); }
}

// ---------------- 备份 ----------------
async function doExport() {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '课堂积分备份_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}
function doImport() { $('#import-file').click(); }
async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('导入会覆盖当前所有数据，确定继续？')) { e.target.value = ''; return; }
    await api('/api/import', { method: 'POST', body: data });
    state.currentClassId = null;
    saveSel();
    await refresh();
  } catch (err) { alert('导入失败：' + err.message); }
  e.target.value = '';
}

// ---------------- 登录/SSE ----------------
async function doLogin() {
  const pw = $('#login-pw').value;
  try {
    await api('/api/login', { method: 'POST', body: { password: pw } });
    await bootstrap();
  } catch (e) { $('#login-err').textContent = e.message; }
}
async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  if (es) es.close();
  state.authed = false;
  showLogin();
}
let es = null;
let lastSeq = 0;
let sseOpened = 0;
let lastSseAt = 0;
let sseWatchdog = null;
let sseConnected = false;
let pendingOps = 0;

function renderSyncStatus() {
  const el = $('#sync-status');
  if (!el) return;
  let cls = 'synced', text = '已同步', title = '实时同步已连接';
  if (!sseConnected) { cls = 'offline'; text = '未连接'; title = '实时同步连接中断，正在重连…'; }
  else if (pendingOps > 0) { cls = 'syncing'; text = '同步中…'; title = '正在保存到服务器'; }
  el.className = 'sync-status ' + cls;
  el.textContent = text;
  el.title = title;
}

function openSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');

  es.addEventListener('connected', (ev) => {
    sseOpened++;
    lastSseAt = Date.now();
    sseConnected = true;
    renderSyncStatus();
    let d = {};
    try { d = JSON.parse(ev.data || '{}'); } catch (_) { d = {}; }
    if (typeof d.seq === 'number') lastSeq = d.seq;
    // 首次连接与重连都对账一次，确保连接建立前后的变更不漏
    refresh();
  });

  es.addEventListener('update', (ev) => {
    lastSseAt = Date.now();
    let data = {};
    try { data = JSON.parse(ev.data || '{}'); } catch (_) { data = {}; }
    if (typeof data.seq === 'number') {
      // 序号跳号=漏事件；序号变小=服务端重启。两种情况都整页对账。
      if (lastSeq && (data.seq > lastSeq + 1 || data.seq < lastSeq)) {
        lastSeq = data.seq;
        refresh();
        return;
      }
      lastSeq = data.seq;
    }
    handleRemoteUpdate(data);
  });

  es.addEventListener('ping', () => {
    lastSseAt = Date.now();
    sseConnected = true;
    renderSyncStatus();
  });

  es.onerror = () => { sseConnected = false; renderSyncStatus(); };
}

function startSseWatchdog() {
  if (sseWatchdog) return;
  lastSseAt = Date.now();
  sseWatchdog = setInterval(() => {
    if (document.hidden) return;
    // 服务端每 15 秒发一次 ping；超过 45 秒无任何消息视为连接卡死，重连并对账
    if (Date.now() - lastSseAt > 45000) {
      try { if (es) es.close(); } catch (_) {}
      openSSE();
      refresh();
    }
  }, 15000);
}

// 其它设备的改动：能局部更新就局部更新，只有结构性变化才整页重新拉取
function handleRemoteUpdate(data) {
  if (data.client && data.client === CLIENT_ID) return;   // 自己的改动已本地生效
  if (data.kind === 'score' && typeof data.score === 'number') {
    setGroupScore(data.group_id, data.score);
    const g = findGroup(data.group_id);
    const cls = findClassOfGroup(data.group_id);
    announceScore(g ? g.name : '小组', data.delta);
    prependHistoryLocal({
      id: 'remote-' + Date.now() + '-' + data.group_id, delta: data.delta,
      reason: data.reason || '', created_at: data.at || localStamp(),
      group_id: data.group_id, batch_id: null,
      group_name: g ? g.name : '', class_name: cls ? cls.name : '',
    });
    return;
  }
  if (data.kind === 'class_score' && Array.isArray(data.scores)) {
    setGroupScores(data.scores);
    announceScore('全班', data.delta);
    const stamp = data.at || localStamp();
    const cls = state.classes.find(c => c.id === data.class_id);
    const entries = data.scores.map(s => {
      const g = findGroup(s.id);
      return {
        id: 'remote-' + s.id + '-' + stamp, delta: data.delta,
        reason: data.reason || '', created_at: stamp,
        group_id: s.id, batch_id: data.batch_id || ('remote-' + stamp),
        group_name: g ? g.name : '', class_name: cls ? cls.name : '',
      };
    });
    entries.reverse().forEach(prependHistoryLocal);
    return;
  }
  if (data.kind === 'undo') {
    if (Array.isArray(data.scores)) setGroupScores(data.scores);
    refresh();   // 历史记录需要对账
    return;
  }
  refresh();
}
async function bootstrap() {
  state.authed = true;
  showApp();
  state.currentClassId = loadSel();
  await refresh();
  openSSE();
  startSseWatchdog();
}
async function init() {
  try {
    const m = await fetch('/api/me').then(r => r.json());
    if (m.authed) await bootstrap();
    else showLogin();
  } catch (e) { showLogin(); }
}

// ---------------- 投屏 ----------------
function openProjector() {
  renderProjector();
  $('#projector').classList.remove('hidden');
}
function closeProjector() { $('#projector').classList.add('hidden'); }

// ---------------- 语音播报（浏览器自带 TTS） ----------------
const VOICE_KEY = 'jiafen.voiceOn';
const VOICE_MERGE_MS = 500;        // 连点合并窗口：同一对象同方向的连续操作合成一句
let voiceOn = localStorage.getItem(VOICE_KEY) === '1';
let voiceQueue = [];
let voiceSpeaking = false;
let voicePending = null;
let voiceTimer = null;

function voiceSupported() {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

// 分数读成中文，避免个别语音包把数字念成英文
function cnNum(n) {
  const d = '零一二三四五六七八九';
  n = Math.abs(Math.round(n));
  if (n < 10) return d[n];
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
  if (n < 1000) {
    const rest = n % 100;
    return d[Math.floor(n / 100)] + '百' + (rest === 0 ? '' : rest < 10 ? '零' + d[rest] : cnNum(rest));
  }
  return String(n);
}

function pickVoice() {
  if (!voiceSupported()) return null;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  const zh = voices.filter(v => /^zh/i.test(v.lang));
  const pool = zh.length ? zh : voices;
  return pool.find(v => /zh[-_]CN/i.test(v.lang) && /xiaoxiao|yunxi|huihui|yaoyao|kangkang|xiaoyi|tingting|female/i.test(v.name))
    || pool.find(v => /zh[-_]CN/i.test(v.lang))
    || pool[0];
}

function drainVoiceQueue() {
  if (voiceSpeaking || !voiceQueue.length || !voiceSupported()) return;
  voiceSpeaking = true;
  const text = voiceQueue.shift();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.1;
  u.pitch = 1;
  u.volume = 1;
  const done = () => { voiceSpeaking = false; drainVoiceQueue(); };
  u.onend = done;
  u.onerror = done;
  try { speechSynthesis.speak(u); } catch (_) { done(); }
}

function speak(text) {
  if (!voiceOn || !voiceSupported()) return;
  if (voiceQueue.length > 5) voiceQueue.length = 5;   // 积压太多就丢弃，避免无限延迟
  voiceQueue.push(text);
  drainVoiceQueue();
}

function flushVoicePending() {
  clearTimeout(voiceTimer);
  const p = voicePending;
  voicePending = null;
  if (!p) return;
  speak(p.label + (p.sign > 0 ? '加' : '扣') + cnNum(p.amount) + '分');
}

// label 用小组名或「全班」
function announceScore(label, delta) {
  if (!voiceOn || !voiceSupported() || !delta) return;
  const sign = delta > 0 ? 1 : -1;
  if (voicePending && voicePending.label === label && voicePending.sign === sign) {
    voicePending.amount += Math.abs(delta);
  } else {
    flushVoicePending();
    voicePending = { label, sign, amount: Math.abs(delta) };
  }
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(flushVoicePending, VOICE_MERGE_MS);
}

function renderVoiceButtons() {
  const top = $('#btn-voice');
  if (top) {
    top.classList.toggle('voice-on', voiceOn);
    top.textContent = voiceOn ? '🔊 语音播报' : '🔈 语音播报';
    top.title = voiceOn ? '语音播报已开启，点一下关闭' : '语音播报已关闭，点一下开启';
  }
  const pj = $('#projector-voice');
  if (pj) {
    pj.classList.toggle('voice-on', voiceOn);
    pj.textContent = voiceOn ? '🔊 语音：开' : '🔈 语音：关';
  }
}

function setVoiceOn(on) {
  voiceOn = !!on;
  localStorage.setItem(VOICE_KEY, voiceOn ? '1' : '0');
  if (!voiceOn) {
    voiceQueue = [];
    voicePending = null;
    clearTimeout(voiceTimer);
    voiceSpeaking = false;
    if (voiceSupported()) { try { speechSynthesis.cancel(); } catch (_) {} }
  }
  renderVoiceButtons();
}

// ---------------- 长按拖拽排序 ----------------
let drag = null;
let dragFrame = null;
let lastMove = null;

function onBoardPointerDown(e) {
  if (drag) return;
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  e.preventDefault();
  const card = handle.closest('.group-card');
  if (!card) return;
  drag = {
    card,
    gid: Number(card.dataset.gid),
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    armed: false,
    timer: null,
    type: e.pointerType,
  };
  if (e.pointerType === 'touch') {
    drag.timer = setTimeout(() => { if (drag && !drag.active) drag.armed = true; }, 380);
  }
}

function onDocPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) > 8) {
      if (drag.type === 'mouse' || drag.armed) {
        activateDrag(e);
      } else {
        clearTimeout(drag.timer);
        drag = null;
      }
    }
    return;
  }
  e.preventDefault();
  lastMove = e;
  if (!dragFrame) dragFrame = requestAnimationFrame(processReorder);
}

function processReorder() {
  dragFrame = null;
  if (!drag || !drag.active || !lastMove) return;
  const e = lastMove;
  // 靠近视口边缘自动滚动，方便拖到下面的位置
  if (e.clientY < 120) window.scrollBy(0, -8);
  else if (e.clientY > window.innerHeight - 120) window.scrollBy(0, 8);
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const target = el && el.closest ? el.closest('.group-card') : null;
  if (!target || target === drag.card) return;
  const rect = target.getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width / 2);
  const dy = e.clientY - (rect.top + rect.height / 2);
  // 网格布局：按指针相对目标中心的主轴决定插前还是插后（同行看水平，跨行看垂直）
  const after = Math.abs(dx) > Math.abs(dy) ? dx > 0 : dy > 0;
  const board = drag.card.parentNode;
  const ref = after ? target.nextSibling : target;
  if (drag.card !== ref) {
    drag.card.remove();
    if (ref) board.insertBefore(drag.card, ref);
    else board.appendChild(drag.card);
  }
}

function activateDrag(e) {
  drag.active = true;
  drag.card.classList.add('dragging');
  state.dragActive = true;
  const board = $('#board');
  if (board) board.classList.add('reordering');
  try { drag.card.setPointerCapture(e.pointerId); } catch (_) {}
}

function onDocPointerUp() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = null;
    processReorder();
  }
  lastMove = null;
  const wasActive = drag.active;
  const card = drag.card;
  drag = null;
  state.dragActive = false;
  const board = $('#board');
  if (board) board.classList.remove('reordering');
  if (card) card.classList.remove('dragging');
  if (wasActive) commitOrder();
}

async function commitOrder() {
  const cid = state.currentClassId;
  if (!cid) return;
  const ids = Array.from(document.querySelectorAll('#board .group-card')).map(c => Number(c.dataset.gid));
  const cls = getCurrentClass();
  const curIds = (cls && cls.groups) ? cls.groups.map(g => g.id) : [];
  if (ids.length && ids.length === curIds.length && ids.every((v, i) => v === curIds[i])) {
    if (state.pendingRefresh) { state.pendingRefresh = false; refresh(); }
    return;
  }
  try {
    await api(`/api/classes/${cid}/groups/reorder`, { method: 'POST', body: { order: ids } });
  } catch (e) { alert(e.message); }
  if (state.pendingRefresh) state.pendingRefresh = false;
  refresh();
}

// ---------------- 绑定 ----------------
document.addEventListener('DOMContentLoaded', () => {
  $('#login-btn').addEventListener('click', doLogin);
  $('#login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-add-class').addEventListener('click', createClass);
  $('#class-name').addEventListener('keydown', e => { if (e.key === 'Enter') createClass(); });
  $('#mobile-class-select').addEventListener('change', e => {
    const v = e.target.value;
    if (!v) return;
    state.currentClassId = Number(v);
    saveSel();
    refresh();
  });
  $('#btn-classes').addEventListener('click', openMobileClassPanel);
  $('#btn-class-close').addEventListener('click', closeMobileClassPanel);
  $('#class-backdrop').addEventListener('click', closeMobileClassPanel);
  $('#btn-add-group').addEventListener('click', createGroup);
  $('#btn-class-score').addEventListener('click', applyClassCustom);
  $('#class-amount').addEventListener('keydown', e => { if (e.key === 'Enter') applyClassCustom(); });
  $('#btn-reset').addEventListener('click', openReset);
  $('#reset-confirm').addEventListener('click', confirmReset);
  $('#reset-cancel').addEventListener('click', closeReset);
  $('#reset-pw').addEventListener('keydown', e => { if (e.key === 'Enter') confirmReset(); });
  $('#reset-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeReset(); });
  $('#btn-undo').addEventListener('click', doUndo);
  $('#lb-class-btn').addEventListener('click', () => setLeaderboardMode('class'));
  $('#lb-school-btn').addEventListener('click', () => setLeaderboardMode('school'));
  $('#lb-classes-btn').addEventListener('click', () => setLeaderboardMode('classes'));
  if (voiceSupported()) {
    $('#btn-voice').addEventListener('click', () => setVoiceOn(!voiceOn));
    $('#projector-voice').addEventListener('click', () => setVoiceOn(!voiceOn));
    // 部分浏览器首次取语音列表为空，等 voiceschanged 后再预热一次
    if (!speechSynthesis.getVoices().length) speechSynthesis.onvoiceschanged = () => { pickVoice(); };
  } else {
    $('#btn-voice').classList.add('hidden');
    $('#projector-voice').classList.add('hidden');
  }
  renderVoiceButtons();
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-import').addEventListener('click', doImport);
  $('#import-file').addEventListener('change', handleImportFile);
  $('#btn-projector').addEventListener('click', openProjector);
  $('#projector-close').addEventListener('click', closeProjector);
  $('#board').addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerUp);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcileIfStale(); });
  window.addEventListener('focus', reconcileIfStale);
  init();
});
