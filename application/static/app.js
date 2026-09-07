const $ = (s) => document.querySelector(s);
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];
let colorIndex = 0;

const state = {
  authed: false,
  classes: [],
  currentClassId: null,
  history: [],
  dragActive: false,
  pendingRefresh: false,
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

async function api(path, opts = {}) {
  const cfg = { ...opts, headers: { ...(opts.headers || {}) } };
  if (cfg.body && typeof cfg.body !== 'string') {
    cfg.body = JSON.stringify(cfg.body);
    cfg.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, cfg);
  if (res.status === 401) { showLogin(); return Promise.reject(new Error('未登录')); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
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

function groupCard(g) {
  const q = [[1, '+1'], [2, '+2'], [5, '+5'], [-1, '-1'], [-2, '-2'], [-5, '-5']];
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
  </div>`;
}

function renderBoard() {
  const cls = getCurrentClass();
  const title = $('#current-class-name');
  const board = $('#board');
  const addBtn = $('#btn-add-group');
  const resetBtn = $('#btn-reset');
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
  board.innerHTML = cls.groups.map(groupCard).join('');
}

function renderLeaderboard() {
  const cls = getCurrentClass();
  const el = $('#leaderboard');
  if (!cls || !cls.groups.length) { el.innerHTML = '<div class="empty">暂无小组</div>'; return; }
  const sorted = [...cls.groups].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = sorted.map((g, i) => `
    <div class="lb-item ${i < 3 ? 'rank' + (i + 1) : ''}" style="--c:${esc(g.color)}">
      <span class="rank">${medals[i] || (i + 1)}</span>
      <span class="dot"></span>
      <span class="lb-name">${esc(g.name)}</span>
      <span class="lb-score">${g.score}</span>
    </div>`).join('');
}

function renderHistory() {
  const el = $('#history');
  if (!state.history.length) { el.innerHTML = '<div class="empty">暂无记分记录</div>'; return; }
  el.innerHTML = state.history.map(h => `
    <div class="hist-item">
      <span class="hist-delta ${h.delta > 0 ? 'pos' : 'neg'}">${h.delta > 0 ? '+' : ''}${h.delta}</span>
      <span class="hist-group" title="${esc(h.group_name)}">${esc(h.group_name)}</span>
      ${h.reason ? `<span class="hist-reason" title="${esc(h.reason)}">${esc(h.reason)}</span>` : ''}
      <span class="hist-time">${esc(h.created_at.slice(5, 16))}</span>
    </div>`).join('');
}

function renderProjector() {
  const cls = getCurrentClass();
  const el = $('#projector-board');
  const title = $('#projector-title');
  if (!cls) { title.textContent = '课堂小组积分'; el.innerHTML = ''; return; }
  title.textContent = cls.name;
  if (!cls.groups.length) { el.innerHTML = '<div class="empty">暂无小组</div>'; return; }
  const sorted = [...cls.groups].sort((a, b) => b.score - a.score);
  el.innerHTML = sorted.map((g, i) => `
    <div class="proj-card ${i === 0 ? 'first' : ''}" style="--c:${esc(g.color)}">
      <div class="p-name">${esc(g.name)}</div>
      <div class="p-score">${g.score}</div>
    </div>`).join('');
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  if (state.dragActive) { state.pendingRefresh = true; return; }
  refreshing = true;
  try {
    const [classes, history] = await Promise.all([
      api('/api/classes'),
      api('/api/history'),
    ]);
    state.classes = classes;
    state.history = history;
    renderSidebar();
    renderMobileClassSelect();
    renderBoard();
    renderLeaderboard();
    renderHistory();
    renderProjector();
  } catch (e) { /* 忽略瞬时错误 */ } finally { refreshing = false; }
}

// ---------------- 操作 ----------------
async function addScore(gid, delta, reason = '') {
  try {
    await api('/api/score', { method: 'POST', body: { group_id: gid, delta, reason } });
    refresh();
  } catch (e) { alert(e.message); }
}
function applyCustom(gid) {
  const amt = $('#amount-' + gid).value.trim();
  if (!amt) { alert('请输入分值'); return; }
  const v = parseInt(amt, 10);
  if (isNaN(v) || v === 0) { alert('请输入有效的分值'); return; }
  addScore(gid, v);
  $('#amount-' + gid).value = '';
}
async function doUndo() {
  try {
    const res = await api('/api/undo', { method: 'POST' });
    if (res.undone) await refresh();
    else alert('没有可撤销的记录');
  } catch (e) { alert(e.message); }
}
async function doReset() {
  const cls = getCurrentClass();
  if (!cls) return;
  if (!confirm('确定把「' + cls.name + '」所有小组分数清零？')) return;
  try {
    await api('/api/classes/' + cls.id + '/reset', { method: 'POST' });
    await refresh();
  } catch (e) { alert(e.message); }
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
function openSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('update', () => refresh());
}
async function bootstrap() {
  state.authed = true;
  showApp();
  state.currentClassId = loadSel();
  await refresh();
  openSSE();
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
  $('#btn-reset').addEventListener('click', doReset);
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-import').addEventListener('click', doImport);
  $('#import-file').addEventListener('change', handleImportFile);
  $('#btn-projector').addEventListener('click', openProjector);
  $('#projector-close').addEventListener('click', closeProjector);
  $('#board').addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerUp);
  init();
});
