const $ = (s) => document.querySelector(s);
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];
let colorIndex = 0;

// 本设备的随机标识：服务端广播变更时带上它，用来忽略自己触发的回显
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

const state = {
  authed: false,
  user: null,
  classes: [],
  currentClassId: null,
  history: [],
  dragActive: false,
  pendingRefresh: false,
  leaderboardMode: 'class',
  // 班级名单弹窗的状态（展开哪一行的菜单、批量导入面板是否打开等）
  rosterOpen: false,
  rosterMenu: null,
  rosterAdd: false,
  rosterAddGid: '',
  rosterImport: false,
  rosterFocus: false,
  rosterMsg: '',
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
  state.user = null;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pw').value = '';
  $('#reg-pw').value = '';
  showLoginView(true);
  $('#login-err').textContent = '';
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

// 浏览器会把「只有密码框、没有账号框」的表单当成登录表单，保存提示里还会把
// 密码本身当成用户名显示出来。处理办法：
// 1) 页面里放一个离屏的账号框（值是「管理员」），密码管理器优先用它当用户名；
// 2) 支持的浏览器把密码框改成普通文本框 + CSS 打码，密码管理器就完全不认它，
//    连保存提示都不会弹（不支持的浏览器保持原生密码框，靠第 1 条兜底）。
function hardenPasswordFields() {
  const canMask = !!(window.CSS && CSS.supports && CSS.supports('-webkit-text-security', 'disc'));
  // 登录框现在有真正的用户名字段，交给浏览器正常保存即可；
  // 这里只处理「没有用户名、要求重新输密码」的框，避免浏览器把它们当登录表单存起来
  ['#reset-pw', '#pw-old', '#pw-new', '#reg-pw'].forEach(sel => {
    const el = $(sel);
    if (!el || el.dataset.hardened) return;
    el.dataset.hardened = '1';
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    if (canMask) { el.type = 'text'; el.classList.add('masked'); }
  });
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
      <div class="name">${esc(c.name)} <span class="muted" style="font-size:12px">${c.groups.length}组${rosterStudents(c).length ? ` · ${rosterStudents(c).length}人` : ''}</span></div>
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
  updateProjectorScores();
  updateSchoolRanks();
}

// 投屏看板只原位改分数，不重建卡片。
// 重建会让「按下还没抬起」的那次点击被浏览器丢掉（点了没反应），也会把滚动位置带跑。
function updateProjectorScores() {
  const cls = getCurrentClass();
  const el = $('#projector-board');
  if (!el) return;
  if (!cls || !cls.groups.length) { renderProjector(); return; }
  const cards = el.querySelectorAll('.proj-card');
  const sameSet = cards.length === cls.groups.length
    && Array.prototype.every.call(cards, (card, i) => Number(card.dataset.gid) === cls.groups[i].id);
  if (!sameSet) { renderProjector(); return; }   // 换班/增减小组这类结构变化才重建
  cls.groups.forEach(g => {
    const scoreEl = el.querySelector('.proj-card[data-gid="' + g.id + '"] .p-score');
    if (scoreEl && scoreEl.textContent !== String(g.score)) scoreEl.textContent = g.score;
  });
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
  const keepScroll = el.scrollTop;   // 重建时保留滚动位置，避免卡片在手指底下移位
  el.innerHTML = order.map(g => `
    <div class="proj-card" data-gid="${g.id}" style="--c:${esc(g.color)}">
      <div class="p-name">${esc(g.name)}</div>
      <div class="p-score">${g.score}</div>
      <div class="p-actions">
        <button class="pbtn plus" data-gid="${g.id}" data-delta="1" title="加 1 分">+1</button>
        <button class="pbtn minus" data-gid="${g.id}" data-delta="-1" title="减 1 分">-1</button>
      </div>
    </div>`).join('');
  el.scrollTop = keepScroll;
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

// 还没得到服务端确认的加减分：gid -> 净增量。
// 后台对账（refresh）拉到的数据如果比这次点击旧，就把这个增量补回去，
// 否则表现就是「刚点的分被刷回去了，像没生效」。
const pendingDeltas = new Map();
function addPendingDelta(gid, delta) {
  pendingDeltas.set(gid, (pendingDeltas.get(gid) || 0) + delta);
}
function dropPendingDelta(gid, delta) {
  const left = (pendingDeltas.get(gid) || 0) - delta;
  if (left) pendingDeltas.set(gid, left);
  else pendingDeltas.delete(gid);
  return pendingDeltas.get(gid) || 0;
}
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
    if (pendingDeltas.size) {
      state.classes.forEach(c => c.groups.forEach(g => {
        const d = pendingDeltas.get(g.id);
        if (d) g.score += d;
      }));
    }
    lastRefreshAt = Date.now();
    renderSidebar();
    renderMobileClassSelect();
    renderBoard();
    renderLeaderboard();
    renderHistory();
    renderProjector();
    if (state.rosterOpen) renderRoster();
  } catch (e) { /* 忽略瞬时错误 */ } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}

// 切回本页/重新聚焦时对账一次，避免长时间不刷新造成状态漂移
function reconcileIfStale() {
  // 手正在屏幕上操作时先别刷，否则重建会把「按下的那一次点击」吞掉
  if (Date.now() - lastInteractAt < 1500) return;
  if (Date.now() - lastRefreshAt > 20000) refresh();
}

// ---------------- 操作 ----------------
// 记分：先本地立即生效（点击零延迟），再发请求；失败回滚
async function addScore(gid, delta, reason = '') {
  const g = findGroup(gid);
  if (!g) { alert('小组不存在，请刷新页面'); return; }
  const prev = g.score;
  addPendingDelta(gid, delta);
  setGroupScore(gid, prev + delta);
  announceScore(g.name, delta);
  try {
    const res = await api('/api/score', {
      method: 'POST',
      body: { group_id: gid, delta, reason, client: CLIENT_ID },
    });
    // 还有别的加分在路上时，按服务端的权威值 + 未落地的增量显示，避免来回跳
    const stillPending = dropPendingDelta(gid, delta);
    if (typeof res.score === 'number') setGroupScore(gid, res.score + stillPending);
    const cls = state.classes.find(c => c.groups.includes(g));
    prependHistoryLocal({
      id: 'local-' + Date.now(), delta, reason, created_at: localStamp(),
      group_id: gid, batch_id: null, group_name: g.name,
      class_name: cls ? cls.name : '',
    });
  } catch (e) {
    dropPendingDelta(gid, delta);
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
  cls.groups.forEach(g => addPendingDelta(g.id, delta));
  cls.groups.forEach(g => setGroupScore(g.id, g.score + delta, false));
  refreshScoreViews();
  announceScore('全班', delta);
  try {
    const res = await api('/api/classes/' + cls.id + '/score', {
      method: 'POST',
      body: { delta, reason, client: CLIENT_ID },
    });
    cls.groups.forEach(g => dropPendingDelta(g.id, delta));
    if (Array.isArray(res.scores)) {
      setGroupScores(res.scores.map(s => ({ id: s.id, score: s.score + (pendingDeltas.get(s.id) || 0) })));
    }
    const batchId = res.batch_id || ('local-' + Date.now());
    const stamp = localStamp();
    const entries = cls.groups.map(g => ({
      id: 'local-' + g.id + '-' + stamp, delta, reason, created_at: stamp,
      group_id: g.id, batch_id: batchId, group_name: g.name, class_name: cls.name,
    }));
    entries.reverse().forEach(prependHistoryLocal);
  } catch (e) {
    cls.groups.forEach(g => dropPendingDelta(g.id, delta));
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
    $('#reset-pw').value = '';
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
  const username = $('#login-name').value.trim();
  const pw = $('#login-pw').value;
  if (!username || !pw) { $('#login-err').textContent = '请输入用户名和密码'; return; }
  try {
    const res = await api('/api/login', { method: 'POST', body: { username, password: pw } });
    state.user = res.user || null;
    $('#login-pw').value = '';   // 登录成功后立刻清空，别把密码留在输入框里
    await bootstrap();
  } catch (e) { $('#login-err').textContent = e.message; }
}
async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  if (es) es.close();
  state.authed = false;
  showLogin();
}

// ---------------- 账号 ----------------
function renderAccount() {
  const u = state.user;
  const who = $('#who');
  if (who) who.textContent = u ? (u.display_name || u.username) : '';
}

function openAccount() {
  const u = state.user;
  $('#account-err').textContent = '';
  $('#pw-old').value = '';
  $('#pw-new').value = '';
  $('#profile-name').value = u ? (u.display_name || '') : '';
  $('#account-me').textContent = u
    ? `当前账号：${u.display_name || u.username}（${u.username}）`
    : '';
  renderAccount();
  $('#account-modal').classList.remove('hidden');
}
function closeAccount() { $('#account-modal').classList.add('hidden'); }

async function saveMyPassword() {
  const oldPw = $('#pw-old').value, newPw = $('#pw-new').value;
  if (!oldPw || !newPw) { $('#account-err').textContent = '请填写当前密码和新密码'; return; }
  try {
    await api('/api/me/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
    $('#pw-old').value = '';
    $('#pw-new').value = '';
    $('#account-err').textContent = '密码已更新';
  } catch (e) { $('#account-err').textContent = e.message; }
}

async function saveProfile() {
  const display_name = $('#profile-name').value.trim();
  try {
    const res = await api('/api/me/profile', { method: 'POST', body: { display_name } });
    state.user = { ...state.user, display_name: res.display_name };
    renderAccount();
    openAccount();
    $('#account-err').textContent = '显示名已更新';
  } catch (e) { $('#account-err').textContent = e.message; }
}

// 注册新账号（需要注册口令）
async function doRegister() {
  const username = $('#reg-name').value.trim();
  const password = $('#reg-pw').value;
  if (!username || !password) { $('#login-err').textContent = '请填写用户名和密码'; return; }
  try {
    const res = await api('/api/register', { method: 'POST', body: { username, password } });
    state.user = res.user || null;
    $('#reg-pw').value = '';
    showLoginView(true);   // 收起注册表单
    await bootstrap();
  } catch (e) { $('#login-err').textContent = e.message; }
}

function showLoginView(isLogin) {
  $('#login-form').classList.toggle('hidden', !isLogin);
  $('#register-form').classList.toggle('hidden', isLogin);
  $('#login-err').textContent = '';
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
  if (data.kind === 'roster') {
    refresh();   // 名单有变化：拉最新名单，弹窗开着会一起重画
    return;
  }
  refresh();
}
async function bootstrap() {
  state.authed = true;
  showApp();
  renderAccount();
  state.currentClassId = loadSel();
  await refresh();
  openSSE();
  startSseWatchdog();
}
async function init() {
  try {
    const m = await fetch('/api/me').then(r => r.json());
    if (m.authed) { state.user = m.user || null; await bootstrap(); }
    else showLogin();
  } catch (e) { showLogin(); }
}

// ---------------- 投屏 ----------------
function openProjector() {
  renderProjector();
  $('#projector').classList.remove('hidden');
}
function closeProjector() { $('#projector').classList.add('hidden'); }

// 投屏卡片上的 +1 / -1：按下时先记住「哪个按钮、在什么位置」，抬起时再按坐标重新找按钮。
// 这样即使按下和抬起之间卡片被重建（后台对账刷新、别台设备推送），这一次点击也不会丢，
// 同时用位移阈值把「滑动/拖拽」排除在外，不会误记分。
let projPress = null;
let lastInteractAt = 0;

function noteInteraction() { lastInteractAt = Date.now(); }

function onProjectorPointerDown(e) {
  const btn = e.target && e.target.closest ? e.target.closest('#projector-board .pbtn') : null;
  if (!btn) { projPress = null; return; }
  projPress = {
    x: e.clientX, y: e.clientY,
    gid: Number(btn.dataset.gid),
    delta: Number(btn.dataset.delta),
    at: Date.now(),
  };
}

function onProjectorPointerUp(e) {
  const press = projPress;
  projPress = null;
  if (!press || !press.gid || !press.delta) return;
  if (Date.now() - press.at > 1500) return;                         // 按住太久，当作不是点击
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) return;  // 滑动/拖拽不算点击
  let gid = press.gid, delta = press.delta;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const btn = el && el.closest ? el.closest('#projector-board .pbtn') : null;
  if (btn) { gid = Number(btn.dataset.gid); delta = Number(btn.dataset.delta); }
  addScore(gid, delta);
}

function cancelProjectorPress() { projPress = null; }

// ---------------- 语音播报（浏览器自带 TTS） ----------------
const VOICE_KEY = 'jiafen.voiceOn';
// 默认开启：只有本机明确关过（存了 '0'）才保持关闭
const voiceStored = localStorage.getItem(VOICE_KEY);
let voiceOn = voiceStored === null ? true : voiceStored === '1';
let voicePrimed = false;
let voiceQueue = [];
let voiceSpeaking = false;

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
  const isOnline = (v) => /online|natural/i.test(v.name);
  const zh = voices.filter(v => /^zh/i.test(v.lang));
  const pool = zh.length ? zh : voices;
  const zhCN = pool.filter(v => /zh[-_]CN/i.test(v.lang));
  // 优先设备本地音色（Windows 自带，如 Microsoft Huihui）：延迟低、断网也能用；
  // 在线音色（Microsoft Xiaoxiao Online 等）要联网合成、首字延迟高，只作兜底
  const local = (zhCN.length ? zhCN : pool).filter(v => !isOnline(v));
  return local.find(v => /huihui|yaoyao|kangkang|xiaoxiao|yunxi|xiaoyi|tingting|female/i.test(v.name))
    || local[0]
    || zhCN.find(isOnline)
    || pool.find(isOnline)
    || zhCN[0]
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

// 浏览器要求页面被用户操作过才允许发声。默认开启时，第一次点击/按键先放一条
// 静音语音解锁，这样即使第一条播报是别台设备触发的，也能正常出声。
function primeVoiceOnce() {
  if (voicePrimed || !voiceSupported()) return;
  voicePrimed = true;
  document.removeEventListener('pointerdown', primeVoiceOnce);
  document.removeEventListener('keydown', primeVoiceOnce);
  if (!voiceOn) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'zh-CN';
    speechSynthesis.speak(u);
  } catch (_) {}
}

// label 用小组名或「全班」；每次加减分立刻播一句，不做连点合并
function announceScore(label, delta) {
  if (!voiceOn || !voiceSupported() || !delta) return;
  speak(label + (delta > 0 ? '加' : '扣') + cnNum(delta) + '分');
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
  const was = voiceOn;
  voiceOn = !!on;
  localStorage.setItem(VOICE_KEY, voiceOn ? '1' : '0');
  if (!voiceOn) {
    voiceQueue = [];
    voiceSpeaking = false;
    if (voiceSupported()) { try { speechSynthesis.cancel(); } catch (_) {} }
  }
  renderVoiceButtons();
  // 打开时念一句试听，方便当场确认音量和音色
  if (voiceOn && !was) speak('语音播报已开启');
}

// ---------------- 班级名单 ----------------
// 每个小组一份名单，汇总起来就是这个班的班级名单（group_id 为空 = 未分组）
function rosterStudents(cls) {
  return (cls && Array.isArray(cls.students)) ? cls.students : [];
}
function studentsOfGroup(cls, gid) {
  const want = (gid == null || gid === '') ? '' : String(gid);
  return rosterStudents(cls)
    .filter(s => ((s.group_id == null || s.group_id === '') ? '' : String(s.group_id)) === want)
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}
function findStudent(sid) {
  for (const c of state.classes) {
    const s = rosterStudents(c).find(x => x.id === sid);
    if (s) return { cls: c, stu: s };
  }
  return null;
}
function groupColor(cls, gid) {
  const g = cls.groups.find(x => x.id === gid);
  return g ? g.color : '#94a3b8';
}
function stuInitial(name) { return (String(name || '?').trim().charAt(0)) || '?'; }

function openRoster() {
  const cls = getCurrentClass();
  if (!cls) { alert('请先选择班级'); return; }
  state.rosterOpen = true;
  state.rosterMenu = null;
  state.rosterAdd = false;
  state.rosterImport = false;
  state.rosterMsg = '';
  $('#roster-msg').textContent = '';
  $('#roster-modal').classList.remove('hidden');
  renderRoster();
}
function closeRoster() {
  state.rosterOpen = false;
  state.rosterMenu = null;
  state.rosterAdd = false;
  state.rosterImport = false;
  $('#roster-modal').classList.add('hidden');
}
function rosterMsg(text) {
  state.rosterMsg = text || '';
  const el = $('#roster-msg');
  if (el) el.textContent = state.rosterMsg;
}

function rosterOptions(cls, sel) {
  return '<option value="">未分组</option>' + cls.groups.map(g =>
    `<option value="${g.id}"${String(sel) === String(g.id) ? ' selected' : ''}>${esc(g.name)}</option>`
  ).join('');
}

function rosterRowHTML(cls, s, gid) {
  const open = state.rosterMenu === s.id;
  const color = gid === '' ? '#94a3b8' : groupColor(cls, gid);
  return `
    <div class="stu-row" data-sid="${s.id}">
      <button class="stu-grip" title="按住拖动可以换组">⠿</button>
      <span class="stu-av" style="--c:${esc(color)}">${esc(stuInitial(s.name))}</span>
      <span class="stu-name">${esc(s.name)}</span>
      <button class="stu-more${open ? ' on' : ''}" onclick="rosterToggleMenu(${s.id})" title="改名 / 换组 / 删除">⋯</button>
    </div>` + (open ? `
    <div class="stu-menu">
      <div class="sm-row">
        <input id="stu-name-input" value="${esc(s.name)}" maxlength="20" placeholder="学生姓名">
        <button class="ghost" onclick="rosterRename(${s.id})">保存</button>
      </div>
      <div class="sm-row">
        <select onchange="rosterMove(${s.id}, this.value)">${rosterOptions(cls, gid)}</select>
        <button class="ghost danger-ghost" onclick="rosterDelete(${s.id})">删除</button>
      </div>
    </div>` : '');
}

function rosterGroupHTML(cls, gid, name, color, isNone) {
  const list = studentsOfGroup(cls, gid);
  const rows = list.map(s => rosterRowHTML(cls, s, gid)).join('');
  const empty = isNone
    ? '还没有未分组的学生'
    : '这一组还没有学生，点右边「＋ 添加学生」，或把别的学生拖过来';
  return `
    <section class="roster-group" data-gid="${gid}">
      <div class="rg-head">
        <span class="rg-dot"${color ? ` style="background:${esc(color)}"` : ''}></span>
        <span class="rg-name">${esc(name)}</span>
        <span class="rg-meta">${list.length}人</span>
        <button class="rg-add" onclick="rosterAddTo('${gid}')">＋ 添加学生</button>
      </div>
      <div class="rg-rows">${rows || `<div class="rg-none">${empty}</div>`}</div>
    </section>`;
}

function rosterImportHTML() {
  return `
    <div class="roster-import">
      <textarea id="roster-import-text" placeholder="一行一个学生，例如：&#10;张三&#10;李四&#10;王五&#10;&#10;也可以直接写成「第1组,张三」，就会分到第1组（组不存在会自动新建）"></textarea>
      <div class="ri-foot">
        <p class="hint">换行、逗号、顿号都能当分隔；Excel 里复制一列名字直接粘进来就行。</p>
        <button class="ghost" onclick="rosterImportCancel()">取消</button>
        <button class="primary" onclick="rosterImportSubmit()">导入</button>
      </div>
    </div>`;
}

function rosterAddHTML(cls) {
  return `
    <div class="roster-add">
      <input id="stu-new-name" placeholder="学生姓名，回车即可连续添加" maxlength="20">
      <select id="stu-new-group">${rosterOptions(cls, state.rosterAddGid)}</select>
      <button class="primary" onclick="rosterCreate()">添加</button>
      <button class="ghost" onclick="rosterAddCancel()">取消</button>
    </div>`;
}

function renderRoster() {
  if (!state.rosterOpen) return;
  const cls = getCurrentClass();
  if (!cls) { closeRoster(); return; }
  const all = rosterStudents(cls);
  $('#roster-sub').textContent = `${cls.name} · ${all.length}人 · ${cls.groups.length}组`;

  let html = '';
  if (state.rosterImport) html += rosterImportHTML();
  if (state.rosterAdd) html += rosterAddHTML(cls);
  if (!cls.groups.length && !all.length) {
    html += '<div class="roster-empty">这个班还没有小组，也还没有学生。<br>先在记分板上「＋ 添加小组」建好小组，再点上面的「批量导入」，把班级名单一行一个粘进来。</div>';
  } else {
    cls.groups.forEach(g => { html += rosterGroupHTML(cls, g.id, g.name, g.color, false); });
    html += rosterGroupHTML(cls, '', '未分组', '', true);
  }
  const body = $('#roster-body');
  body.innerHTML = html;

  const nameEl = $('#stu-new-name');
  if (nameEl) {
    nameEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); rosterCreate(); }
      else if (e.key === 'Escape') { rosterAddCancel(); }
    });
    if (state.rosterFocus) { nameEl.focus(); state.rosterFocus = false; }
  }
}

function rosterToggleMenu(sid) {
  state.rosterMenu = (state.rosterMenu === sid) ? null : sid;
  renderRoster();
  const box = $('#roster-body');
  const input = $('#stu-name-input');
  if (input && state.rosterMenu === sid) { input.focus(); input.select(); }
  else if (box && state.rosterMenu === sid) box.focus();
}

function rosterAddTo(gid) {
  state.rosterAddGid = (gid == null ? '' : String(gid));
  state.rosterAdd = true;
  state.rosterImport = false;
  state.rosterMenu = null;
  state.rosterFocus = true;
  renderRoster();
}
function rosterAddCancel() {
  state.rosterAdd = false;
  state.rosterFocus = false;
  renderRoster();
}

async function rosterCreate() {
  const cls = getCurrentClass();
  if (!cls) return;
  const nameEl = $('#stu-new-name');
  if (!nameEl) return;
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); return; }
  const gid = $('#stu-new-group').value;
  try {
    await api(`/api/classes/${cls.id}/students`, {
      method: 'POST',
      body: { name, group_id: gid || null, client: CLIENT_ID },
    });
    state.rosterAdd = true;          // 连续录入：添加行留着
    state.rosterFocus = true;
    rosterMsg(`已添加「${name}」`);
    await refresh();
    renderRoster();
  } catch (e) { alert(e.message); }
}

async function rosterRename(sid) {
  const found = findStudent(sid);
  if (!found) return;
  const el = $('#stu-name-input');
  const name = ((el && el.value) || '').trim();
  if (!name) { alert('姓名不能为空'); return; }
  if (name === found.stu.name) { state.rosterMenu = null; renderRoster(); return; }
  try {
    await api('/api/students/' + sid, { method: 'PATCH', body: { name, client: CLIENT_ID } });
    state.rosterMenu = null;
    rosterMsg(`「${found.stu.name}」改名为「${name}」`);
    await refresh();
    renderRoster();
  } catch (e) { alert(e.message); }
}

async function rosterMove(sid, gid) {
  const found = findStudent(sid);
  if (!found) return;
  try {
    await api('/api/students/' + sid, {
      method: 'PATCH',
      body: { group_id: gid || null, client: CLIENT_ID },
    });
    state.rosterMenu = null;
    const g = gid ? found.cls.groups.find(x => String(x.id) === String(gid)) : null;
    rosterMsg(`「${found.stu.name}」${g ? '移到' + g.name : '移到未分组'}`);
    await refresh();
    renderRoster();
  } catch (e) { alert(e.message); }
}

async function rosterDelete(sid) {
  const found = findStudent(sid);
  if (!found) return;
  if (!confirm(`把「${found.stu.name}」从班级名单里删除？\n（只是名单里去掉这个人，小组分数不受影响）`)) { renderRoster(); return; }
  try {
    await api('/api/students/' + sid, { method: 'DELETE', body: { client: CLIENT_ID } });
    state.rosterMenu = null;
    rosterMsg(`已删除「${found.stu.name}」`);
    await refresh();
    renderRoster();
  } catch (e) { alert(e.message); }
}

function rosterImportOpen() {
  state.rosterImport = true;
  state.rosterAdd = false;
  state.rosterMenu = null;
  renderRoster();
  const ta = $('#roster-import-text');
  if (ta) ta.focus();
}
function rosterImportCancel() {
  state.rosterImport = false;
  renderRoster();
}
async function rosterImportSubmit() {
  const cls = getCurrentClass();
  if (!cls) return;
  const ta = $('#roster-import-text');
  const text = ((ta && ta.value) || '').trim();
  if (!text) { if (ta) ta.focus(); return; }
  try {
    const res = await api(`/api/classes/${cls.id}/students/import`, {
      method: 'POST',
      body: { text, client: CLIENT_ID },
    });
    state.rosterImport = false;
    let msg = `已导入 ${res.added} 名学生`;
    if (res.groups_created && res.groups_created.length) {
      msg += `，并新建了小组：${res.groups_created.join('、')}`;
    }
    rosterMsg(msg);
    await refresh();
    renderRoster();
  } catch (e) { alert(e.message); }
}

// 导出名单：按「小组,姓名」两列导出成 CSV，Excel/WPS 直接打开
function rosterExport() {
  const cls = getCurrentClass();
  if (!cls) return;
  const rows = [];
  cls.groups.forEach(g => studentsOfGroup(cls, g.id).forEach(s => rows.push([g.name, s.name])));
  studentsOfGroup(cls, '').forEach(s => rows.push(['未分组', s.name]));
  if (!rows.length) { rosterMsg('名单还是空的，先导入或添加学生'); return; }
  const cell = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const csv = '\ufeff' + '小组,姓名\n' + rows.map(r => r.map(cell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = String(cls.name).replace(/[\\/:*?"<>|]/g, '_');
  a.href = url;
  a.download = `班级名单_${safe}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  rosterMsg(`已导出 ${rows.length} 名学生`);
}

// ---- 名单里按住 ⠿ 拖动排序 / 跨组移动 ----
let rdrag = null;
let rframe = null;
let rlast = null;

function onRosterPointerDown(e) {
  if (rdrag || !state.rosterOpen) return;
  const grip = e.target.closest ? e.target.closest('.stu-grip') : null;
  if (!grip) return;
  const row = grip.closest('.stu-row');
  if (!row) return;
  e.preventDefault();
  rdrag = {
    row,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    armed: false,
    timer: null,
    type: e.pointerType,
  };
  if (e.pointerType === 'touch') {
    rdrag.timer = setTimeout(() => { if (rdrag && !rdrag.active) rdrag.armed = true; }, 320);
  }
}

function onRosterPointerMove(e) {
  if (!rdrag) return;
  const dx = e.clientX - rdrag.startX;
  const dy = e.clientY - rdrag.startY;
  if (!rdrag.active) {
    if (Math.hypot(dx, dy) > 8) {
      if (rdrag.type === 'mouse' || rdrag.armed) activateRosterDrag(e);
      else { clearTimeout(rdrag.timer); rdrag = null; }
    }
    return;
  }
  e.preventDefault();
  rlast = e;
  if (!rframe) rframe = requestAnimationFrame(processRosterDrag);
}

function activateRosterDrag(e) {
  rdrag.active = true;
  rdrag.row.classList.add('dragging');
  state.dragActive = true;          // 拖动期间先别让后台刷新重建 DOM
  try { rdrag.row.setPointerCapture(e.pointerId); } catch (_) {}
}

function processRosterDrag() {
  rframe = null;
  if (!rdrag || !rdrag.active || !rlast) return;
  const e = rlast;
  const body = $('#roster-body');
  if (body) {
    const br = body.getBoundingClientRect();
    if (e.clientY < br.top + 44) body.scrollTop -= 12;
    else if (e.clientY > br.bottom - 44) body.scrollTop += 12;
  }
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const section = el && el.closest ? el.closest('.roster-group') : null;
  if (!section) return;
  const rowsBox = section.querySelector('.rg-rows');
  if (!rowsBox) return;
  const placeholder = rowsBox.querySelector('.rg-none');
  if (placeholder) placeholder.remove();
  const row = rdrag.row;
  const target = el.closest('.stu-row');
  if (!target || target === row) {
    if (!target && row.parentNode !== rowsBox) rowsBox.appendChild(row);
    return;
  }
  const rect = target.getBoundingClientRect();
  const after = (e.clientY - (rect.top + rect.height / 2)) > 0;
  const ref = after ? target.nextSibling : target;
  if (row !== ref) {
    row.remove();
    if (ref) rowsBox.insertBefore(row, ref);
    else rowsBox.appendChild(row);
  }
}

async function onRosterPointerUp() {
  if (!rdrag) return;
  clearTimeout(rdrag.timer);
  if (rframe) { cancelAnimationFrame(rframe); rframe = null; processRosterDrag(); }
  const wasActive = rdrag.active;
  const row = rdrag.row;
  rdrag = null;
  rlast = null;
  state.dragActive = false;
  if (row) row.classList.remove('dragging');
  if (wasActive) await commitRosterOrder();
}

async function commitRosterOrder() {
  const cls = getCurrentClass();
  if (!cls) return;
  const items = [];
  document.querySelectorAll('#roster-body .roster-group').forEach(sec => {
    const gid = sec.dataset.gid || '';
    sec.querySelectorAll('.rg-rows .stu-row').forEach(r => {
      items.push({ id: Number(r.dataset.sid), group_id: gid ? Number(gid) : null });
    });
  });
  const before = rosterStudents(cls)
    .slice()
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    .map(s => ({ id: s.id, group_id: (s.group_id == null || s.group_id === '') ? null : s.group_id }));
  const same = items.length === before.length
    && items.every((it, i) => it.id === before[i].id && it.group_id === before[i].group_id);
  if (same) { renderRoster(); return; }
  try {
    await api(`/api/classes/${cls.id}/students/reorder`, {
      method: 'POST',
      body: { items, client: CLIENT_ID },
    });
    rosterMsg('名单顺序已保存');
  } catch (e) { alert(e.message); }
  await refresh();
  renderRoster();
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
  hardenPasswordFields();
  $('#login-btn').addEventListener('click', doLogin);
  $('#login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#login-name').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
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
  $('#btn-roster').addEventListener('click', openRoster);
  $('#roster-close').addEventListener('click', closeRoster);
  $('#roster-import-btn').addEventListener('click', rosterImportOpen);
  $('#roster-export-btn').addEventListener('click', rosterExport);
  $('#roster-add-btn').addEventListener('click', () => rosterAddTo(''));
  $('#roster-modal').addEventListener('click', e => { if (e.target === $('#roster-modal')) closeRoster(); });
  // 名单里按住拖动手柄排序（监听挂在容器上，重画之后依然有效）
  $('#roster-body').addEventListener('pointerdown', onRosterPointerDown);
  document.addEventListener('pointermove', onRosterPointerMove);
  document.addEventListener('pointerup', onRosterPointerUp);
  document.addEventListener('pointercancel', onRosterPointerUp);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.rosterOpen && !rdrag) closeRoster();
  });
  $('#btn-class-score').addEventListener('click', applyClassCustom);
  $('#class-amount').addEventListener('keydown', e => { if (e.key === 'Enter') applyClassCustom(); });
  $('#btn-reset').addEventListener('click', openReset);
  $('#reset-confirm').addEventListener('click', confirmReset);
  $('#reset-cancel').addEventListener('click', closeReset);
  $('#reset-pw').addEventListener('keydown', e => { if (e.key === 'Enter') confirmReset(); });
  $('#reset-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeReset(); });
  $('#btn-account').addEventListener('click', openAccount);
  $('#account-close').addEventListener('click', closeAccount);
  $('#account-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAccount(); });
  $('#pw-save').addEventListener('click', saveMyPassword);
  $('#profile-save').addEventListener('click', saveProfile);
  $('#show-register').addEventListener('click', e => { e.preventDefault(); showLoginView(false); });
  $('#show-login').addEventListener('click', e => { e.preventDefault(); showLoginView(true); });
  $('#register-btn').addEventListener('click', doRegister);
  $('#reg-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  $('#btn-undo').addEventListener('click', doUndo);
  $('#lb-class-btn').addEventListener('click', () => setLeaderboardMode('class'));
  $('#lb-school-btn').addEventListener('click', () => setLeaderboardMode('school'));
  $('#lb-classes-btn').addEventListener('click', () => setLeaderboardMode('classes'));
  if (voiceSupported()) {
    $('#btn-voice').addEventListener('click', () => setVoiceOn(!voiceOn));
    $('#projector-voice').addEventListener('click', () => setVoiceOn(!voiceOn));
    // 默认开启时，第一次交互先解锁浏览器发声权限
    document.addEventListener('pointerdown', primeVoiceOnce);
    document.addEventListener('keydown', primeVoiceOnce);
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
  // 投屏加减分：用 pointerup 兜底，卡片被重建也不丢点击
  $('#projector-board').addEventListener('pointerdown', onProjectorPointerDown);
  document.addEventListener('pointerup', onProjectorPointerUp);
  document.addEventListener('pointercancel', cancelProjectorPress);
  // 记录最近一次操作时间：手在屏幕上时不要触发后台对账刷新
  document.addEventListener('pointerdown', noteInteraction, true);
  document.addEventListener('keydown', noteInteraction, true);
  $('#board').addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerUp);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcileIfStale(); });
  window.addEventListener('focus', reconcileIfStale);
  init();
});

/* ---- 禁用移动端浏览器的页面缩放：双指捏合 / 双击放大 / iOS 手势事件 ---- */
(function blockPageZoom() {
  const block = e => { if (e.cancelable) e.preventDefault(); };
  // iOS Safari 的专有手势事件（新版 iOS 已忽略 viewport 里的 user-scalable=no，只能拦事件）
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
    document.addEventListener(t, block, { passive: false }));
  // 两根手指同时落在屏幕上：拦掉缩放，单指滚动和卡片拖拽不受影响
  document.addEventListener('touchstart', e => { if (e.touches.length > 1) block(e); }, { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) block(e); }, { passive: false });
  // 双击放大
  document.addEventListener('dblclick', block, { passive: false });
  // 少数机型会忽略 viewport 设置，用内联样式再兜一层
  document.documentElement.style.touchAction = 'pan-x pan-y';
})();
