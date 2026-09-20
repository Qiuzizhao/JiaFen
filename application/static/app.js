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
  rosterAddGid: '',
  rosterAdded: [],     // 本次连续添加的学生 id（栈顶＝撤销上一个）
  rosterImport: null,        // 批量导入面板的状态：见 rosterImportOpen()
  rosterImportSig: '',       // 面板指纹，没变就不重画（免得打字时输入框被重建）
  rosterMsg: '',
  rosterSig: '',       // 上次渲染的名单指纹，名单没变就不重画
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
  // 名单窗口开着的话，组头上的「小组分」也跟着变，但不动名单本身
  const pill = document.querySelector('#roster-body .roster-group[data-gid="' + gid + '"] .rg-score');
  if (pill) pill.textContent = '小组分 ' + score;
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
    // 名单不进分数刷新链路：只有名单本身变了才重画，且拖拽中绝不重建 DOM
    if (state.rosterOpen && !state.dragActive && rosterSig(getCurrentClass()) !== state.rosterSig) renderRoster();
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

// 只同步一个班的名单（别的设备加/改/删/排序时用），不重建记分板和历史
async function syncClassRoster(cid) {
  if (!cid) { refresh(); return; }
  try {
    const list = await api(`/api/classes/${cid}/students`);
    const cls = state.classes.find(c => c.id === cid);
    if (cls) cls.students = list;
    renderSidebar();
    if (state.rosterOpen && state.currentClassId === cid
        && rosterSig(getCurrentClass()) !== state.rosterSig) renderRoster();
  } catch (e) { refresh(); }
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
    // 别的设备改了名单：只拉这个班的名单，不重建看板和历史
    if (data.groups_changed) { refresh(); return; }
    syncClassRoster(data.class_id);
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
  state.rosterImport = null;
  state.rosterImportSig = '';
  state.rosterAdded = [];
  state.rosterMsg = '';
  state.rosterAddGid = cls.groups.length ? String(cls.groups[0].id) : '';
  const msg = $('#roster-msg'); if (msg) msg.textContent = '';
  const search = $('#roster-search'); if (search) search.value = '';
  $('#roster-modal').classList.remove('hidden');
  renderRoster();
}
function closeRoster() {
  state.rosterOpen = false;
  state.rosterMenu = null;
  state.rosterImport = null;
  state.rosterImportSig = '';
  state.rosterAdded = [];
  state.rosterSig = '';
  closeRowMenus();
  hideImportPanel();
  $('#roster-modal').classList.add('hidden');
  renderSidebar();   // 名单人数变了，左边班级列表的「N人」跟着更新
}
function hideImportPanel() {
  const panel = $('#roster-import');
  if (panel) panel.classList.add('hidden');
  const box = document.querySelector('#roster-modal .roster-box');
  if (box) box.classList.remove('importing');
}
function rosterMsg(text) {
  state.rosterMsg = text || '';
  const el = $('#roster-msg');
  if (el) el.textContent = state.rosterMsg;
}

function groupOf(cls, gid) {
  const want = (gid == null || gid === '') ? '' : String(gid);
  if (want === '' || !cls) return null;
  return (cls.groups || []).find(g => String(g.id) === want) || null;
}
function studentGroupId(s) {
  return (s.group_id == null || s.group_id === '') ? '' : String(s.group_id);
}
function nextStudentOrder(cls) {
  return rosterStudents(cls).reduce((m, s) => Math.max(m, Number(s.sort_order) || 0), 0) + 1;
}
// 名单指纹：内容没变就不重画，这样加减分时的对账刷新不会重建整个名单
function rosterSig(cls) {
  if (!cls) return '';
  const stu = rosterStudents(cls).map(s => `${s.id}:${studentGroupId(s)}:${s.sort_order}:${s.name}`).join('|');
  // 分数不进指纹：加减分只更新那一张卡和名单里的「小组分」小标签，不重建名单
  const grp = (cls.groups || []).map(g => `${g.id}:${g.name}:${g.color}`).join(',');
  return stu + '#' + grp;
}
function isTouchDevice() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
function quickGroupName(cls, gid) {
  const g = groupOf(cls, gid);
  return g ? g.name : '未分组';
}
function rosterGroupItems(cls) {
  const items = (cls.groups || []).map(g => ({ gid: String(g.id), name: g.name, color: g.color || '#5b9bd5' }));
  items.push({ gid: '', name: '未分组', color: '#cbd5e1' });
  return items;
}
function groupOptionsHTML(cls, sel) {
  return '<option value="">未分组</option>' + (cls.groups || []).map(g =>
    `<option value="${g.id}"${String(sel) === String(g.id) ? ' selected' : ''}>${esc(g.name)}</option>`
  ).join('');
}

function rosterRowHTML(cls, s) {
  const gid = studentGroupId(s);
  const g = groupOf(cls, gid);
  const color = g ? (g.color || '#5b9bd5') : '#94a3b8';
  return `<div class="stu-row" data-sid="${s.id}" data-gid="${esc(gid)}">`
    + `<button class="stu-grip" title="按住拖动可以换组" aria-label="拖动排序">⠿</button>`
    + `<span class="stu-av" style="--c:${esc(color)}">${esc(stuInitial(s.name))}</span>`
    + `<span class="stu-name">${esc(s.name)}</span>`
    + `<button class="stu-more" title="改名 / 换组 / 删除" aria-label="更多操作">⋯</button>`
    + `</div>`;
}

function rosterGroupHTML(cls, gid) {
  const want = (gid == null || gid === '') ? '' : String(gid);
  const g = groupOf(cls, want);
  const list = studentsOfGroup(cls, want);
  const color = g ? (g.color || '#5b9bd5') : '#cbd5e1';
  const rows = list.map(s => rosterRowHTML(cls, s)).join('');
  const empty = want === ''
    ? '没有学生'
    : '还没有学生';
  const score = g ? (Number(g.score) || 0) : null;
  return `<section class="roster-group${want === '' ? ' rg-ungrouped' : ''}" data-gid="${esc(want)}" style="--c:${esc(color)}">
      <div class="rg-head">
        <span class="rg-dot"></span>
        <span class="rg-name">${esc(g ? g.name : '未分组')}</span>
        <span class="rg-count">${list.length}人</span>
        ${score == null ? '' : `<span class="rg-score">小组分 ${score}</span>`}
        <span class="rg-btns">
          <button class="rg-add" data-gid="${esc(want)}">＋ 加学生</button>
          <button class="rg-import" data-gid="${esc(want)}" title="把一份名单批量粘进这一组">⇩ 批量导入</button>
        </span>
      </div>
      <div class="rg-rows">${rows || `<div class="rg-none">${empty}</div>`}</div>
    </section>`;
}

// ---- 顶部快速添加条：选一次组，然后一直敲名字回车 ----
function renderRosterChips(cls) {
  const box = $('#roster-chips');
  if (!box) return;
  box.innerHTML = rosterGroupItems(cls).map(it =>
    `<button type="button" class="rq-chip${String(state.rosterAddGid) === it.gid ? ' on' : ''}" data-gid="${esc(it.gid)}">`
    + `<i style="background:${esc(it.color)}"></i>${esc(it.name)}<span class="rq-n">0</span></button>`
  ).join('');
  updateQuickPlaceholder(cls);
}
function updateQuickPlaceholder(cls) {
  const input = $('#stu-new-name');
  if (input) input.placeholder = `输入姓名，回车加进「${quickGroupName(cls, state.rosterAddGid)}」`;
}
function renderRosterNav(cls) {
  const nav = $('#roster-nav');
  if (!nav) return;
  nav.innerHTML = '<div class="rn-title">快速跳转</div>' + rosterGroupItems(cls).map(it =>
    `<button type="button" class="rn-item" data-gid="${esc(it.gid)}"><i style="background:${esc(it.color)}"></i>`
    + `<span>${esc(it.name)}</span><b>0</b></button>`
  ).join('');
}
function refreshRosterCounts() {
  const cls = getCurrentClass();
  if (!cls) return;
  const all = rosterStudents(cls);
  const un = studentsOfGroup(cls, '').length;
  const sub = $('#roster-sub');
  if (sub) sub.textContent = `${cls.name} · ${all.length}人 · ${cls.groups.length}组` + (un ? ` · 未分组 ${un}人` : '');
  const chipBox = $('#roster-chips');
  if (chipBox) chipBox.querySelectorAll('.rq-chip').forEach(chip => {
    const el = chip.querySelector('.rq-n');
    if (el) el.textContent = studentsOfGroup(cls, chip.dataset.gid || '').length;
  });
  const nav = $('#roster-nav');
  if (nav) nav.querySelectorAll('.rn-item').forEach(item => {
    const b = item.querySelector('b');
    if (b) b.textContent = studentsOfGroup(cls, item.dataset.gid || '').length;
  });
  const body = $('#roster-body');
  if (!body) { state.rosterSig = rosterSig(cls); return; }
  body.querySelectorAll('.roster-group').forEach(sec => {
    const gid = sec.dataset.gid || '';
    const list = studentsOfGroup(cls, gid);
    const pill = sec.querySelector('.rg-count');
    if (pill) pill.textContent = list.length + '人';
    const rows = sec.querySelector('.rg-rows');
    if (!rows) return;
    const ph = rows.querySelector('.rg-none');
    const tip = gid === '' ? '没有学生' : '还没有学生';
    if (list.length && ph) ph.remove();
    else if (!list.length && !ph) rows.insertAdjacentHTML('beforeend', `<div class="rg-none">${tip}</div>`);
  });
  // 本地改完就把指纹更新掉，后台对账时才知道「名单没变，不用重画」
  state.rosterSig = rosterSig(cls);
}
function renderUndoBtn() {
  const btn = $('#roster-undo');
  if (!btn) return;
  const sid = state.rosterAdded[state.rosterAdded.length - 1];
  const found = (sid == null) ? null : findStudent(sid);
  if (!found) { btn.classList.add('hidden'); btn.textContent = ''; return; }
  btn.classList.remove('hidden');
  btn.textContent = `撤销上一个：${found.stu.name}`;
}
function rosterQuickFocus(gid) {
  const cls = getCurrentClass();
  if (!cls) return;
  state.rosterAddGid = (gid == null || gid === '') ? '' : String(gid);
  const box = $('#roster-chips');
  if (box) box.querySelectorAll('.rq-chip').forEach(chip =>
    chip.classList.toggle('on', (chip.dataset.gid || '') === state.rosterAddGid));
  updateQuickPlaceholder(cls);
  const input = $('#stu-new-name');
  if (input) { input.focus(); if (!isTouchDevice()) input.select(); }
}
function rosterScrollToGroup(gid) {
  const body = $('#roster-body');
  const sec = groupSection(gid);
  if (!body || !sec) return;
  const top = sec.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 2;
  if (body.scrollTo) body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  else body.scrollTop = Math.max(0, top);
  const want = (gid == null || gid === '') ? '' : String(gid);
  document.querySelectorAll('#roster-nav .rn-item').forEach(item =>
    item.classList.toggle('on', (item.dataset.gid || '') === want));
}
function stuRowEl(sid) {
  const body = $('#roster-body');
  return body ? body.querySelector(`.stu-row[data-sid="${Number(sid)}"]`) : null;
}
function groupSection(gid) {
  const body = $('#roster-body');
  if (!body) return null;
  const want = (gid == null || gid === '') ? '' : String(gid);
  let found = null;
  body.querySelectorAll('.roster-group').forEach(sec => {
    if (!found && (sec.dataset.gid || '') === want) found = sec;
  });
  return found;
}
function insertStudentRow(cls, stu) {
  const sec = groupSection(studentGroupId(stu));
  if (!sec) return null;
  const rows = sec.querySelector('.rg-rows');
  const ph = rows.querySelector('.rg-none');
  if (ph) ph.remove();
  rows.insertAdjacentHTML('beforeend', rosterRowHTML(cls, stu));
  const row = rows.lastElementChild;
  applyRosterSearchToRow(row);
  return row;
}
// ---- 搜索：本地过滤，不重新请求 ----
function applyRosterSearch() {
  const input = $('#roster-search');
  const q = input ? input.value.trim().toLowerCase() : '';
  const body = $('#roster-body');
  if (!body) return;
  body.querySelectorAll('.roster-group').forEach(sec => {
    let visible = 0;
    sec.querySelectorAll('.stu-row').forEach(row => {
      const nm = (row.querySelector('.stu-name') || {}).textContent || '';
      const hit = !q || nm.toLowerCase().indexOf(q) >= 0;
      row.classList.toggle('search-hidden', !hit);
      if (hit) visible++;
    });
    sec.classList.toggle('search-dim', !!q && visible === 0);
    const none = sec.querySelector('.rg-none');
    if (none) none.classList.toggle('search-hidden', !!q);
  });
}
function applyRosterSearchToRow(row) {
  if (!row) return;
  const input = $('#roster-search');
  const q = input ? input.value.trim().toLowerCase() : '';
  const nm = (row.querySelector('.stu-name') || {}).textContent || '';
  row.classList.toggle('search-hidden', !!q && nm.toLowerCase().indexOf(q) < 0);
}
// ---- 行内「⋯」：贴着这一行的小浮层，不再把下面的学生顶下去 ----
function buildRowMenu(cls, s) {
  const menu = document.createElement('div');
  menu.className = 'stu-menu';
  menu.innerHTML = `<div class="sm-grp">改名</div>
    <div class="sm-row"><input class="sm-name" value="${esc(s.name)}" maxlength="20" placeholder="学生姓名"><button class="sm-save primary">保存</button></div>
    <div class="sm-grp">换到哪一组</div>
    <div class="sm-row"><select class="sm-group">${groupOptionsHTML(cls, studentGroupId(s))}</select><button class="sm-del danger-ghost">删除</button></div>`;
  menu.querySelector('.sm-save').addEventListener('click', () => rosterRename(s.id));
  menu.querySelector('.sm-del').addEventListener('click', () => rosterDelete(s.id));
  menu.querySelector('.sm-group').addEventListener('change', e => rosterMove(s.id, e.target.value));
  const nameInput = menu.querySelector('.sm-name');
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); rosterRename(s.id); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeRowMenus(); }
  });
  return menu;
}
function rosterToggleMenu(sid) {
  const row = stuRowEl(sid);
  if (!row) return;
  if (state.rosterMenu === sid) { closeRowMenus(); return; }
  closeRowMenus();
  const found = findStudent(sid);
  if (!found) return;
  const menu = buildRowMenu(found.cls, found.stu);
  row.appendChild(menu);
  row.classList.add('menu-open');
  const more = row.querySelector('.stu-more');
  if (more) more.classList.add('on');
  state.rosterMenu = sid;
  // 下面放不下就翻到行的上方，保证不用滚动也能看清
  const body = $('#roster-body');
  if (body) {
    const br = body.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.bottom + menu.offsetHeight + 8 > br.bottom && rr.top - menu.offsetHeight - 8 > br.top) menu.classList.add('up');
  }
  const inp = menu.querySelector('.sm-name');
  if (inp && !isTouchDevice()) { inp.focus(); inp.select(); }
}
function closeRowMenus() {
  document.querySelectorAll('#roster-body .stu-menu').forEach(m => m.remove());
  document.querySelectorAll('#roster-body .stu-row.menu-open').forEach(r => r.classList.remove('menu-open'));
  document.querySelectorAll('#roster-body .stu-more.on').forEach(b => b.classList.remove('on'));
  state.rosterMenu = null;
}

// ---------------- 批量导入到小组 ----------------
// 两个入口都进同一个面板：小组卡片上的「⇩ 批量导入」（目标组已锁定）、顶部的「批量导入」（自己选组）
// 四步：选目标组 → 粘贴名单（实时解析）→ 确认 → 完成（可一键撤销）
const IMPORT_SEP = /[,，、;；/\s]+/;
const NEW_GROUP_COLOR = '#8b5cf6';

// 解析粘贴的内容：谁落到哪一组、会不会撞上已有的同名（规则和服务器一致）
function importParseItems(cls, text, gid, dedupe) {
  const want = (gid == null || gid === '') ? '' : String(gid);
  const byName = new Map();
  (cls.groups || []).forEach(g => { if (!byName.has(g.name)) byName.set(g.name, String(g.id)); });
  const inGroup = new Map();
  const remember = (g, name) => {
    if (!inGroup.has(g)) inGroup.set(g, new Set());
    inGroup.get(g).add(name);
  };
  rosterStudents(cls).forEach(s => remember(studentGroupId(s), s.name));
  const out = [];
  String(text || '').replace(/\r/g, '').split('\n').forEach(line => {
    const parts = line.trim().split(IMPORT_SEP).map(x => x.trim()).filter(Boolean);
    if (!parts.length) return;
    let target = want;
    let names = parts;
    let fresh = '';
    const head = parts[0];
    // 行首是已知组名、或以「组」结尾时，这一行剩下的名字落到那个组
    if (parts.length >= 2 && (byName.has(head) || /组$/.test(head))) {
      names = parts.slice(1);
      if (byName.has(head)) {
        target = byName.get(head);
      } else {
        fresh = head.slice(0, 20);
        target = 'new:' + fresh;
      }
    }
    names.forEach(raw => {
      const nm = raw.slice(0, 20);
      if (!nm) return;
      const seen = inGroup.get(target);
      let kind = 'new';
      let note = '';
      if (seen && seen.has(nm)) {
        kind = dedupe === 'skip' ? 'dup' : 'same';
        note = '已有同名';
      } else {
        let other = '';
        inGroup.forEach((names2, g) => { if (!other && g !== target && names2.has(nm)) other = g; });
        if (other) { kind = 'other'; note = '别组也有'; }
      }
      const take = kind !== 'dup';
      if (take) remember(target, nm);
      out.push({
        name: nm,
        gid: target,
        group: fresh || quickGroupName(cls, target),
        color: fresh ? NEW_GROUP_COLOR : groupColor(cls, target),
        kind: kind,
        note: note,
        take: take,
      });
    });
  });
  return out;
}
function importItems() {
  const cls = getCurrentClass();
  const ri = state.rosterImport;
  if (!cls || !ri) return [];
  return importParseItems(cls, ri.text, ri.gid, ri.dedupe);
}
function importTake(items) { return (items || []).filter(x => x.take); }

function importGroupChipsHTML(cls) {
  const ri = state.rosterImport;
  const want = String(ri.gid == null ? '' : ri.gid);
  return rosterGroupItems(cls).map(it =>
    `<button type="button" class="ri-chip${it.gid === want ? ' on' : ''}" data-rig="${esc(it.gid)}" style="--c:${esc(it.color)}">`
    + `<i></i>${esc(it.name)}<small>${studentsOfGroup(cls, it.gid).length}人</small>`
    + (it.gid === want ? '<b>✓</b>' : '')
    + '</button>'
  ).join('');
}

function importParseHTML(items) {
  const n = importTake(items).length;
  const names = items.length
    ? items.map(it => `<span class="ri-nm ${it.kind}">${esc(it.name)}${it.note ? `<small>${esc(it.note)}</small>` : ''}</span>`).join('')
    : '<span class="ri-nm empty">还没有内容</span>';
  return `<div class="ri-parse" id="ri-parse">
      ${items.length ? `<div class="ri-psum" aria-live="polite">将导入 <b class="ok">${n}</b> 人 · 跳过 <b class="warn">${items.length - n}</b> 人</div>` : ''}
      <div class="ri-names">${names}</div>
    </div>`;
}

// 按「落到哪一组」把要导入的人分组，确认页就按这个分区显示
function importSections(take) {
  const order = [];
  const map = new Map();
  take.forEach(it => {
    if (!map.has(it.gid)) { map.set(it.gid, { gid: it.gid, name: it.group, color: it.color, list: [] }); order.push(it.gid); }
    map.get(it.gid).list.push(it);
  });
  return order.map(k => map.get(k));
}

function importPreviewHTML(list, skip) {
  const shown = list.slice(0, 8);
  const rows = shown.map(it => {
    const note = skip ? '跳过' : (it.kind === 'other' ? it.note : '');
    return `<div class="ri-prow${skip ? ' skip' : ''}">`
      + `<span class="ri-pav" style="--c:${esc(skip ? '#cbd5e1' : it.color)}">${esc(stuInitial(it.name))}</span>`
      + `<span class="ri-pname">${esc(it.name)}</span>`
      + (note ? `<span class="ri-pnote">${esc(note)}</span>` : '')
      + '</div>';
  }).join('');
  const more = list.length > shown.length
    ? `<div class="ri-more">还有 ${list.length - shown.length} 人（共 ${list.length} 人）</div>` : '';
  return rows + more;
}

function importHeadHTML(cls, ri) {
  const color = ri.gid === '' ? '#cbd5e1' : groupColor(cls, ri.gid);
  return `<span class="ri-bar" style="--c:${esc(color)}"></span>`
    + '<span class="ri-title">批量导入</span>'
    + `<span class="ri-lock" style="--c:${esc(color)}"><i></i>${esc(quickGroupName(cls, ri.gid))} · 现有 ${studentsOfGroup(cls, ri.gid).length} 人`
    + '<button type="button" data-rigo="step1">换组</button></span>'
    + '<button type="button" class="ri-close" id="ri-close-btn" aria-label="关闭导入面板">✕</button>';
}

function importStepsHTML(ri) {
  return ['目标组', '粘贴名单', '确认', '完成'].map((label, i) => {
    const k = i + 1;
    const cls = [(k === ri.step ? 'on' : ''), (k < ri.step ? 'done' : '')].join(' ').trim();
    return `<button type="button" class="${cls}" data-rigo="step${k}"${k === ri.step ? ' aria-current="step"' : ''}>`
      + `<i>${k < ri.step ? '✓' : k}</i>${label}</button>`;
  }).join('');
}

function importStepHTML(cls, ri, items) {
  const take = importTake(items);
  const skip = items.filter(x => !x.take);
  const gname = quickGroupName(cls, ri.gid);

  if (ri.step === 1) {
    return `<div class="ri-chips" role="group" aria-label="目标小组">${importGroupChipsHTML(cls)}</div>`
      + `<p class="ri-tip">${ri.locked ? '目标已选好，可以换组。' : '点一个小组，名字就进这一组。'}</p>`;
  }

  if (ri.step === 2) {
    return `<div class="ri-paste">
        <div class="ri-ph"><span>一行一个，空格 / 逗号 / 顿号都当分隔</span></div>
        <textarea id="ri-text" placeholder="张明轩&#10;李文博&#10;王雨欣，陈嘉禾&#10;第3组,宋佳琪" autocomplete="off" spellcheck="false"></textarea>
        <div class="ri-tools">
          <button type="button" class="ghost" id="ri-paste-btn">从剪贴板粘贴</button>
          <button type="button" class="ghost" id="ri-clear-btn">清空</button>
        </div>
      </div>
      ${importParseHTML(items)}
      <div class="ri-rule">
        <span>本组同名</span>
        <div class="ri-seg">
          <button type="button" data-ridedupe="skip" class="${ri.dedupe === 'skip' ? 'on' : ''}">自动跳过</button>
          <button type="button" data-ridedupe="allow" class="${ri.dedupe === 'allow' ? 'on' : ''}">仍然导入</button>
        </div>
      </div>`;
  }

  if (ri.step === 3) {
    const sections = importSections(take);
    const body = sections.map(sec => {
      const isNew = sec.gid.indexOf('new:') === 0;
      const label = isNew
        ? `${sec.name} +${sec.list.length}（新建）`
        : `${sec.name} +${sec.list.length}（现有 ${studentsOfGroup(cls, sec.gid).length} 人）`;
      return `<div class="ri-plabel">${esc(label)}</div>${importPreviewHTML(sec.list, false)}`;
    }).join('');
    const skipBlock = skip.length
      ? `<div class="ri-plabel">跳过 ${skip.length} 人</div>${importPreviewHTML(skip, true)}`
      : '';
    const tags = sections.map(sec => `<span class="ri-gtag" style="--c:${esc(sec.color)}"><i></i>${esc(sec.name)} +${sec.list.length}</span>`).join('');
    const mine = take.filter(x => x.gid === ri.gid).length;
    const before = studentsOfGroup(cls, ri.gid).length;
    const extra = take.length - mine;
    return `<div class="ri-confirm">将导入 <b>${take.length}</b> 人${tags}`
      + `<span class="ri-delta">${esc(gname)} ${before}人 → ${before + mine}人</span></div>`
      + `<div class="ri-preview">${body}${skipBlock}</div>`;
  }

  const round = ri.round || { added: 0, skipped: 0, groups: [] };
  const gl = round.groups || [];
  const head = gl.length === 1
    ? `已加到 ${esc(gl[0].name)}：${round.added} 人`
    : `已导入 ${round.added} 人：${gl.map(g => `${esc(g.name)} ${g.added}`).join('、')}`;
  return `<div class="ri-done" role="status"><span>${head}</span>`
    + '<button type="button" id="ri-undo-btn">撤销本次导入</button></div>'
    + (round.skipped ? `<p class="ri-tip">跳过 ${round.skipped} 个同名。</p>` : '');
}

function importFootHTML(cls, ri, items) {
  const n = importTake(items).length;
  if (ri.step === 1) {
    return '<button type="button" class="ghost" data-rigo="close">取消</button><span class="ri-gap"></span>'
      + '<button type="button" class="primary" data-rigo="next">下一步</button>';
  }
  if (ri.step === 2) {
    return '<button type="button" class="ghost" data-rigo="back">上一步</button><span class="ri-gap"></span>'
      + `<button type="button" class="primary" id="ri-submit" data-rigo="next"${n ? '' : ' disabled'}>下一步（${n} 人）</button>`;
  }
  if (ri.step === 3) {
    return '<button type="button" class="ghost" data-rigo="back">返回修改</button><span class="ri-gap"></span>'
      + `<button type="button" class="primary" id="ri-submit" data-rigo="submit">导入 ${n} 人</button>`;
  }
  return '<button type="button" class="ghost" data-rigo="again">再导入一批</button><span class="ri-gap"></span>'
    + '<button type="button" class="primary" data-rigo="close">完成</button>';
}

function renderImportPanel(focusText) {
  const panel = $('#roster-import');
  if (!panel) return;
  const cls = getCurrentClass();
  const ri = state.rosterImport;
  if (!cls || !ri) { hideImportPanel(); state.rosterImportSig = ''; return; }
  panel.classList.remove('hidden');
  const box = document.querySelector('#roster-modal .roster-box');
  if (box) box.classList.add('importing');
  const roundKey = ri.round ? `${ri.round.added}:${(ri.round.ids || []).length}` : '';
  const sig = [ri.step, ri.gid, ri.locked ? 1 : 0, ri.dedupe, roundKey, rosterSig(cls)].join('|');
  if (sig === state.rosterImportSig) { refreshImportParse(); return; }
  state.rosterImportSig = sig;
  const items = importItems();
  $('#ri-head').innerHTML = importHeadHTML(cls, ri);
  $('#ri-steps').innerHTML = importStepsHTML(ri);
  $('#ri-body').innerHTML = importStepHTML(cls, ri, items);
  $('#ri-foot').innerHTML = importFootHTML(cls, ri, items);
  const ta = $('#ri-text');
  if (ta) ta.value = ri.text;
  if (focusText && ta) { ta.focus(); if (!isTouchDevice()) ta.select(); }
}

// 只刷新「解析结果 + 底部按钮」：输入框和光标留在原地，打字不会卡
function refreshImportParse() {
  const cls = getCurrentClass();
  const ri = state.rosterImport;
  if (!cls || !ri) return;
  const items = importItems();
  const parse = $('#ri-parse');
  if (parse && ri.step === 2) parse.outerHTML = importParseHTML(items);
  const foot = $('#ri-foot');
  if (foot) foot.innerHTML = importFootHTML(cls, ri, items);
}

// 刚导入进来的学生在名单里闪一下蓝底
function flashStudents(ids) {
  const rows = (ids || []).map(sid => stuRowEl(sid)).filter(Boolean);
  if (!rows.length) return;
  rows.forEach(r => r.classList.add('flash'));
  setTimeout(() => rows.forEach(r => r.classList.remove('flash')), 3200);
}

function renderRoster() {
  if (!state.rosterOpen) return;
  const cls = getCurrentClass();
  if (!cls) { closeRoster(); return; }
  const body = $('#roster-body');
  if (!body) return;
  const all = rosterStudents(cls);
  const keepScroll = body.scrollTop;
  if (state.rosterAddGid !== '' && !groupOf(cls, state.rosterAddGid)) {
    state.rosterAddGid = cls.groups.length ? String(cls.groups[0].id) : '';
  }

  let html = '';
  if (!cls.groups.length && !all.length) {
    html += '<div class="roster-empty">还没有小组和学生。<br>先在记分板「＋ 添加小组」，再回来「批量导入」名单。</div>';
  } else {
    cls.groups.forEach(g => { html += rosterGroupHTML(cls, g.id); });
    html += rosterGroupHTML(cls, '');
  }
  body.innerHTML = html;
  body.scrollTop = keepScroll;

  renderRosterChips(cls);
  renderRosterNav(cls);
  refreshRosterCounts();
  renderUndoBtn();
  applyRosterSearch();
  state.rosterSig = rosterSig(cls);
  renderImportPanel();
}

// 一个名字框里可以用空格 / 逗号一次敲好几个人
function parseStudentNames(raw) {
  return String(raw || '').split(/[\s,，、;；\/]+/).map(s => s.trim()).filter(Boolean).slice(0, 60);
}

// 连续添加：加完光标和键盘都留在输入框，一个接一个敲；加错了用「撤销上一个」退回
async function rosterCreate() {
  const cls = getCurrentClass();
  if (!cls) return;
  const input = $('#stu-new-name');
  if (!input) return;
  const names = parseStudentNames(input.value);
  if (!names.length) { input.focus(); return; }
  const gid = state.rosterAddGid || '';
  const btn = $('#roster-add-btn');
  if (btn) btn.disabled = true;
  let added = 0;
  try {
    for (const name of names) {
      const res = await api(`/api/classes/${cls.id}/students`, {
        method: 'POST',
        body: { name, group_id: gid || null, client: CLIENT_ID },
      });
      const stu = {
        id: res.id, class_id: cls.id,
        group_id: gid ? Number(gid) : null,
        name: res.name || name,
        sort_order: nextStudentOrder(cls),
      };
      cls.students = rosterStudents(cls).concat([stu]);
      state.rosterAdded.push(stu.id);
      insertStudentRow(cls, stu);
      added += 1;
    }
    input.value = '';
    refreshRosterCounts();
    renderUndoBtn();
    rosterMsg(`已把 ${added} 人加进「${quickGroupName(cls, gid)}」`);
  } catch (e) {
    alert(e.message);
    if (added) { refreshRosterCounts(); renderUndoBtn(); }
  } finally {
    if (btn) btn.disabled = false;
    input.focus();
  }
}

// 撤销上一个：把刚加进名单的那个人删掉（只动名单，不影响小组分）
async function rosterUndoLast() {
  const sid = state.rosterAdded.pop();
  if (sid == null) { rosterMsg('没有刚添加的学生可以撤销'); return; }
  const found = findStudent(sid);
  if (!found) { renderUndoBtn(); return; }
  const name = found.stu.name;
  try {
    await api('/api/students/' + sid, { method: 'DELETE', body: { client: CLIENT_ID } });
    found.cls.students = rosterStudents(found.cls).filter(s => s.id !== sid);
    const row = stuRowEl(sid);
    if (row) row.remove();
    refreshRosterCounts();
    renderUndoBtn();
    applyRosterSearch();
    rosterMsg(`已撤销添加「${name}」`);
  } catch (e) {
    state.rosterAdded.push(sid);
    alert(e.message);
  }
}

async function rosterRename(sid) {
  const found = findStudent(sid);
  const row = stuRowEl(sid);
  if (!found || !row) { closeRowMenus(); return; }
  const el = row.querySelector('.sm-name');
  const name = ((el && el.value) || '').trim();
  if (!name) { alert('姓名不能为空'); return; }
  if (name === found.stu.name) { closeRowMenus(); return; }
  const old = found.stu.name;
  try {
    await api('/api/students/' + sid, { method: 'PATCH', body: { name, client: CLIENT_ID } });
    found.stu.name = name;
    const nm = row.querySelector('.stu-name'); if (nm) nm.textContent = name;
    const av = row.querySelector('.stu-av'); if (av) av.textContent = stuInitial(name);
    state.rosterSig = rosterSig(found.cls);
    closeRowMenus();
    applyRosterSearch();
    rosterMsg(`「${old}」改名为「${name}」`);
  } catch (e) { alert(e.message); }
}

async function rosterMove(sid, gid) {
  const found = findStudent(sid);
  const row = stuRowEl(sid);
  if (!found || !row) { closeRowMenus(); return; }
  const want = (gid == null || gid === '') ? '' : String(gid);
  if (studentGroupId(found.stu) === want) { closeRowMenus(); return; }
  try {
    await api('/api/students/' + sid, {
      method: 'PATCH',
      body: { group_id: want || null, client: CLIENT_ID },
    });
    found.stu.group_id = want ? Number(want) : null;
    found.stu.sort_order = nextStudentOrder(found.cls);
    const sec = groupSection(want);
    if (sec) {
      const rows = sec.querySelector('.rg-rows');
      const ph = rows.querySelector('.rg-none');
      if (ph) ph.remove();
      rows.appendChild(row);
      row.dataset.gid = want;
      const g = groupOf(found.cls, want);
      const av = row.querySelector('.stu-av');
      if (av) av.style.setProperty('--c', g ? (g.color || '#5b9bd5') : '#94a3b8');
    }
    closeRowMenus();
    refreshRosterCounts();
    applyRosterSearch();
    rosterMsg(`「${found.stu.name}」移到${quickGroupName(found.cls, want)}`);
  } catch (e) { alert(e.message); }
}

async function rosterDelete(sid) {
  const found = findStudent(sid);
  if (!found) { closeRowMenus(); return; }
  if (!confirm(`把「${found.stu.name}」从班级名单里删除？\n（只是名单里去掉这个人，小组分数不受影响）`)) { closeRowMenus(); return; }
  try {
    await api('/api/students/' + sid, { method: 'DELETE', body: { client: CLIENT_ID } });
    found.cls.students = rosterStudents(found.cls).filter(s => s.id !== sid);
    const row = stuRowEl(sid);
    if (row) row.remove();
    state.rosterAdded = state.rosterAdded.filter(x => x !== sid);
    closeRowMenus();
    refreshRosterCounts();
    renderUndoBtn();
    applyRosterSearch();
    rosterMsg(`已删除「${found.stu.name}」`);
  } catch (e) { alert(e.message); }
}

// 打开面板：从小组卡片进来（locked）时目标组已经定好，直接从「粘贴名单」开始
function rosterImportOpen(gid, locked) {
  const cls = getCurrentClass();
  if (!cls) return;
  const want = (gid == null || gid === '') ? '' : String(gid);
  const last = localStorage.getItem('jiafen.importGid');
  const fallback = cls.groups.length ? String(cls.groups[0].id) : '';
  state.rosterImport = {
    step: locked ? 2 : 1,
    gid: locked ? want : (last == null ? fallback : last),
    locked: !!locked,
    dedupe: localStorage.getItem('jiafen.importDedupe') === 'allow' ? 'allow' : 'skip',
    text: '',
    round: null,
  };
  state.rosterImportSig = '';
  closeRowMenus();
  renderImportPanel(true);
}

function rosterImportClose() {
  state.rosterImport = null;
  state.rosterImportSig = '';
  hideImportPanel();
  rosterMsg('');
}

function importSetStep(n) {
  const ri = state.rosterImport;
  if (!ri) return;
  let to = Math.max(1, Math.min(4, n));
  if (to >= 3 && !importTake(importItems()).length) to = 2;
  ri.step = to;
  renderImportPanel(to === 2);
}

// 从剪贴板直接粘（手机上没有键盘，长按选择太麻烦）
async function rosterImportPaste() {
  const ri = state.rosterImport;
  if (!ri) return;
  const ta = $('#ri-text');
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) throw new Error('empty');
    ri.text = text;
    if (ta) ta.value = text;
    refreshImportParse();
    rosterMsg(`已粘进来 ${importItems().length} 个姓名`);
  } catch (e) {
    if (ta) ta.focus();
    rosterMsg('浏览器不允许读取剪贴板，请手动粘贴');
  }
}

async function rosterImportSubmit() {
  const cls = getCurrentClass();
  const ri = state.rosterImport;
  if (!cls || !ri) return;
  if (!importTake(importItems()).length) {
    rosterMsg('还没有可以导入的姓名');
    const ta = $('#ri-text'); if (ta) ta.focus();
    return;
  }
  const btn = $('#ri-submit');
  if (btn) btn.disabled = true;
  try {
    const res = await api(`/api/classes/${cls.id}/students/import`, {
      method: 'POST',
      body: {
        text: ri.text,
        default_group_id: ri.gid || null,
        dedupe: ri.dedupe,
        client: CLIENT_ID,
      },
    });
    localStorage.setItem('jiafen.importGid', ri.gid);
    localStorage.setItem('jiafen.importDedupe', ri.dedupe);
    ri.round = res;
    ri.step = 4;
    state.rosterImportSig = '';
    await refresh();          // 名单变了：拉一次最新的，也让「现有 N 人」跟上
    renderImportPanel();
    flashStudents(res.ids || []);
    let msg = `已导入 ${res.added} 人`;
    if (res.skipped) msg += `（跳过 ${res.skipped} 个同名）`;
    if (res.groups_created && res.groups_created.length) msg += `；新建 ${res.groups_created.join('、')}`;
    rosterMsg(msg);
  } catch (e) {
    alert(e.message);
    if (btn) btn.disabled = false;
  }
}

// 撤销本次导入：一次删掉这次加进来的所有人，名单内容留在上一步，改一改还能再导
async function rosterImportUndo() {
  const ri = state.rosterImport;
  if (!ri || !ri.round) return;
  const ids = (ri.round.ids || []).slice();
  if (!ids.length) return;
  const btn = $('#ri-undo-btn');
  if (btn) btn.disabled = true;
  try {
    await api('/api/students/batch-delete', { method: 'POST', body: { ids, client: CLIENT_ID } });
    ri.round = null;
    ri.step = 2;
    state.rosterImportSig = '';
    await refresh();
    renderImportPanel(true);
    rosterMsg('已撤回本次导入');
  } catch (e) {
    if (btn) btn.disabled = false;
    alert(e.message);
  }
}

function onRosterImportClick(e) {
  const ri = state.rosterImport;
  if (!ri) return;
  const btn = e.target.closest ? e.target.closest('button') : null;
  if (!btn) return;
  const go = btn.dataset.rigo || '';
  if (btn.hasAttribute('data-rig')) { ri.gid = btn.dataset.rig || ''; renderImportPanel(); return; }
  if (btn.dataset.ridedupe) {
    ri.dedupe = btn.dataset.ridedupe;
    localStorage.setItem('jiafen.importDedupe', ri.dedupe);
    renderImportPanel();
    return;
  }
  if (go === 'close') { rosterImportClose(); return; }
  if (go === 'back') { importSetStep(ri.step - 1); return; }
  if (go === 'next') { importSetStep(ri.step + 1); return; }
  if (go === 'submit') { rosterImportSubmit(); return; }
  if (go === 'again') { ri.text = ''; ri.round = null; ri.step = 2; renderImportPanel(true); return; }
  if (go.indexOf('step') === 0) { importSetStep(Number(go.slice(4))); return; }
  if (btn.id === 'ri-clear-btn') {
    ri.text = '';
    const ta = $('#ri-text');
    if (ta) { ta.value = ''; ta.focus(); }
    refreshImportParse();
    return;
  }
  if (btn.id === 'ri-paste-btn') { rosterImportPaste(); return; }
  if (btn.id === 'ri-undo-btn') { rosterImportUndo(); }
}

function onRosterImportInput(e) {
  const ri = state.rosterImport;
  if (!ri || !e.target || e.target.id !== 'ri-text') return;
  ri.text = e.target.value;
  refreshImportParse();
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
  if (same) { refreshRosterCounts(); return; }
  // 先按界面上的顺序落到本地（不用等网络），再后台提交
  applyLocalRosterOrder(cls, items);
  refreshRosterCounts();
  applyRosterSearch();
  try {
    await api(`/api/classes/${cls.id}/students/reorder`, {
      method: 'POST',
      body: { items, client: CLIENT_ID },
    });
    rosterMsg('名单顺序已保存');
  } catch (e) {
    alert(e.message);
    await refresh();   // 提交失败：拉回服务端的权威顺序
  }
}

function applyLocalRosterOrder(cls, items) {
  const byId = new Map(rosterStudents(cls).map(s => [s.id, s]));
  items.forEach((it, idx) => {
    const s = byId.get(it.id);
    if (!s) return;
    s.group_id = it.group_id;
    s.sort_order = idx;
  });
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
  $('#roster-import-btn').addEventListener('click', () => rosterImportOpen('', false));
  $('#roster-export-btn').addEventListener('click', rosterExport);
  $('#roster-add-btn').addEventListener('click', rosterCreate);
  $('#roster-undo').addEventListener('click', rosterUndoLast);
  $('#roster-search').addEventListener('input', applyRosterSearch);
  $('#stu-new-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); rosterCreate(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; }
  });
  // 点组标签＝把「快速添加」切到这一组；点组头「＋ 加学生」＝切到这一组并直接聚焦输入框
  $('#roster-chips').addEventListener('click', e => {
    const chip = e.target.closest ? e.target.closest('.rq-chip') : null;
    if (chip) rosterQuickFocus(chip.dataset.gid || '');
  });
  $('#roster-nav').addEventListener('click', e => {
    const item = e.target.closest ? e.target.closest('.rn-item') : null;
    if (item) rosterScrollToGroup(item.dataset.gid || '');
  });
  $('#roster-body').addEventListener('click', e => {
    const imp = e.target.closest ? e.target.closest('.rg-import') : null;
    if (imp) { rosterImportOpen(imp.dataset.gid || '', true); return; }
    const add = e.target.closest ? e.target.closest('.rg-add') : null;
    if (add) { rosterQuickFocus(add.dataset.gid || ''); return; }
    const more = e.target.closest ? e.target.closest('.stu-more') : null;
    if (more) {
      const row = more.closest('.stu-row');
      if (row) rosterToggleMenu(Number(row.dataset.sid));
    }
  });
  // 批量导入面板：选组、切换步骤、粘贴、提交都在这里代理
  $('#roster-import').addEventListener('click', onRosterImportClick);
  $('#roster-import').addEventListener('input', onRosterImportInput);
  $('#roster-import').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    if (!state.rosterImport || e.target.id !== 'ri-text') return;
    e.preventDefault();
    importSetStep(state.rosterImport.step + 1);
  });
  document.addEventListener('pointerdown', e => {
    if (!state.rosterOpen || state.rosterMenu == null) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.stu-menu') || t.closest('.stu-more')) return;
    closeRowMenus();
  }, true);
  $('#roster-modal').addEventListener('click', e => { if (e.target === $('#roster-modal')) closeRoster(); });
  // 名单里按住拖动手柄排序（监听挂在容器上，重画之后依然有效）
  $('#roster-body').addEventListener('pointerdown', onRosterPointerDown);
  document.addEventListener('pointermove', onRosterPointerMove);
  document.addEventListener('pointerup', onRosterPointerUp);
  document.addEventListener('pointercancel', onRosterPointerUp);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !state.rosterOpen) return;
    if (state.rosterMenu != null) { closeRowMenus(); return; }   // 先收浮层，再关窗口
    if (state.rosterImport) { rosterImportClose(); return; }     // 再收导入面板，才轮到关窗口
    if (!rdrag) closeRoster();
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

/* ---- 弹窗打开时锁住背后的页面滚动 ----
   名单、账号、清零这些窗口内部都有各自的滚动区，滚到头以后滚轮会「接力」传给背后的
   页面，看起来就是窗口还开着、底下的整页却在动。这里在弹窗打开期间把 body 的滚动关掉
   （名单里各个滚动区再靠 CSS 的 overscroll-behavior: contain 兜一层）。 */
(function lockPageBehindModals() {
  const sync = () => {
    const open = !!document.querySelector('.modal:not(.hidden)');
    if (open === document.body.classList.contains('modal-open')) return;
    // 先量再锁：滚动条消失会让页面宽度跳一下，用右边距补回来
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.classList.toggle('modal-open', open);
    document.body.style.paddingRight = open && gap > 0 ? gap + 'px' : '';
  };
  document.querySelectorAll('.modal').forEach(m =>
    new MutationObserver(sync).observe(m, { attributes: true, attributeFilter: ['class'] }));
  window.addEventListener('resize', sync);
  sync();
})();
