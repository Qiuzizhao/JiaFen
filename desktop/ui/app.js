'use strict';
const $ = s => document.querySelector(s);
const bridge = window.desktop;
const DEFAULT_SERVER = 'https://jiafen.qiuzizhao.com';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const client = crypto.randomUUID().replaceAll('-', '').slice(0, 32);
const state = { classes: [], user: null, cls: null, connected: false, ready: false, busy: false, tab: 'score', scope: 'class', mode: localStorage.getItem('desktop.voice') || 'all', seen: new Set(), refreshAgain: false, revision: 0, seq: null };
let refreshing = null, pin = true;
const current = () => state.classes.find(c => c.id === state.cls);
// Measure intrinsic panel content instead of the flex area's allocated height.
// Only changing content resizes the window; hovering a card never changes its bounds.
let fitFrame = 0;
function scheduleFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    if (document.body.classList.contains('compact')) return;
    const height = selector => { const el = $(selector); if (!el || !el.getClientRects().length) return 0; const css = getComputedStyle(el); return el.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom); };
    let desired = height('#chrome') + height('#notice') + height('#retry') + 2;
    if (!$('#workspace').hidden) {
      const panel = $('#' + state.tab + '-panel');
      const css = getComputedStyle($('.scroll-area'));
      const panelCSS = getComputedStyle(panel);
      const panelHeight = panel.scrollHeight + parseFloat(panelCSS.borderTopWidth) + parseFloat(panelCSS.borderBottomWidth);
      desired += height('nav') + panelHeight + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + height('footer') + height('.voice-strip') + height('.last-action') + height('#custom') + height('#undo-confirm');
      desired = Math.min(desired, state.tab === 'voice' ? 520 : 460);
    } else if (!$('#login').hidden) desired += height('#login');
    else return;
    void call('fit', Math.ceil(desired)).catch(() => {});
  });
}
const group = id => state.classes.flatMap(c => c.groups).find(g => g.id === id);
function groupColor(element, color) { element.style.setProperty('--c', CSS.supports('color', color) ? color : '#3b82f6'); }
async function call(method, ...args) {
  const result = await bridge[method](...args);
  if (!result.ok) throw new Error(result.error || '操作失败');
  return result.value;
}
const api = (route, method = 'GET', body) => call('request', route, method, body);
function notice(message = '') { $('#notice').hidden = !message; $('#notice').textContent = message; }
function status() {
  const good = state.connected && state.ready;
  $('#sync').textContent = state.busy ? '保存中…' : good ? '● 已同步' : '○ 未同步';
  $('#sync').classList.toggle('online', good);
  $('#compact-status').textContent = good ? '● 在线' : '○ 未同步';
  document.querySelectorAll('[data-delta],#all-plus,#undo,#open-custom,#custom button[type="submit"]').forEach(b => { b.disabled = !good || state.busy; });
}
function rankItems() {
  if (state.scope === 'classes') return state.classes.map(c => ({ name: c.name, score: c.groups.reduce((a, g) => a + g.score, 0), color: '#3b82f6' }));
  if (state.scope === 'school') return state.classes.flatMap(c => c.groups.map(g => ({ name: c.name + ' · ' + g.name, score: g.score, color: g.color })));
  return (current()?.groups || []).map(g => ({ name: g.name, score: g.score, color: g.color }));
}
function render() {
  document.body.classList.toggle('signed-in', !!state.user);
  const customTarget = $('#custom-target').value;
  $('#class-select').innerHTML = state.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#class-select').value = state.cls ?? '';
  const c = current();
  $('#groups').classList.toggle('dense', (c?.groups.length || 0) > 8);
  $('#compact-name').textContent = c?.name || '加分助手';
  $('#groups').innerHTML = (c?.groups || []).map(g => `<div class="group-row"><div class="group-summary"><span class="group-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="group-score" data-score="${g.id}">${g.score}</span></div><div class="group-actions" role="group" aria-label="${esc(g.name)}加减分"><button class="minus" data-group="${g.id}" data-delta="-1" aria-label="${esc(g.name)}扣一分" title="${esc(g.name)}扣一分">−</button><button class="plus" data-group="${g.id}" data-delta="1" aria-label="${esc(g.name)}加一分" title="${esc(g.name)}加一分">+</button></div></div>`).join('');
  document.querySelectorAll('.group-row').forEach((row, i) => groupColor(row, c.groups[i].color));
  $('#empty').hidden = !!c?.groups.length;
  const items = rankItems().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
  let rank = 1;
  $('#ranking').innerHTML = items.map((g, i) => {
    if (i && items[i - 1].score !== g.score) rank = i + 1;
    return `<div class="rank-row rank${Math.min(rank, 4)}"><span class="rank-number">${rank}</span><span class="rank-name" title="${esc(g.name)}"><span class="rank-dot" aria-hidden="true"></span><span class="rank-label">${esc(g.name)}</span></span><span class="rank-value">${g.score} 分</span></div>`;
  }).join('') || '<p class="hint">暂无排名</p>';
  document.querySelectorAll('.rank-row').forEach((row, i) => groupColor(row, items[i].color));
  $('#custom-target').innerHTML = (c?.groups || []).map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('') + (c?.groups.length ? '<option value="all">全班小组</option>' : '');
  if ([...$('#custom-target').options].some(option => option.value === customTarget)) $('#custom-target').value = customTarget;
  $('#voice-class').textContent = c?.name || '未选择';
  $('#voice-mode').value = state.mode;
  $('#voice-label').textContent = state.mode === 'off' ? '语音已关闭' : state.mode === 'local' ? '仅播报本机操作' : '🔊 ' + (c?.name || '当前班级') + ' · 全部操作';
  $('#mute').textContent = state.mode === 'off' ? '开启' : '静音';
  $('#account-name').textContent = state.user?.display_name || state.user?.username || '';
  status();
}
function selectTab(tab) {
  state.tab = tab;
  document.body.dataset.view = tab;
  $('#custom').hidden = true; $('#undo-confirm').hidden = true;
  for (const name of ['score', 'rank', 'voice']) $('#' + name + '-panel').hidden = name !== tab;
  document.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-pressed', String(b.dataset.tab === tab)); });
}
function rememberClass() { localStorage.setItem('desktop.class.' + state.user.id, String(state.cls || '')); }
async function refresh() {
  if (!state.user) return;
  if (state.busy) { state.refreshAgain = true; return; }
  if (refreshing) { state.refreshAgain = true; return refreshing; }
  const owner = state.user.id, revision = state.revision;
  refreshing = (async () => {
    try {
      const data = await api('/api/classes');
      if (state.user?.id !== owner) return;
      if (state.busy || state.revision !== revision) { state.refreshAgain = true; return; }
      state.classes = data;
      if (!current()) state.cls = data[0]?.id ?? null;
      state.ready = true; $('#retry').hidden = true; rememberClass(); render();
    } catch (e) { state.ready = false; notice(e.message); $('#retry').hidden = false; status(); }
    finally {
      refreshing = null;
      if (state.refreshAgain && state.user && !state.busy) { state.refreshAgain = false; void refresh(); }
    }
  })();
  return refreshing;
}
function loginView() {
  state.user = null; state.classes = []; state.cls = null; state.ready = false; state.connected = false; state.seen.clear();
  $('#workspace').hidden = true; $('#login').hidden = false;
  $('#custom').hidden = true; $('#undo-confirm').hidden = true;
  void call('stopVoice').catch(() => {}); void call('connect', false).catch(() => {});
  document.body.classList.remove('compact'); void call('window', 'expand').catch(() => {});
  render();
}
async function enter(user) {
  state.user = user;
  state.cls = Number(localStorage.getItem('desktop.class.' + user.id)) || null;
  $('#login').hidden = true; $('#workspace').hidden = false; $('#password').value = '';
  await refresh(); await call('connect', true);
}
function say(label, delta, cls, remote) {
  if (state.mode === 'off' || cls !== state.cls || (remote && state.mode === 'local')) return;
  const text = label + (delta > 0 ? '加' : '扣') + Math.abs(delta) + '分';
  $('#announcement').textContent = text;
  void call('speak', text).catch(e => { $('#announcement').textContent = e.message; });
}
function setScores(scores) { for (const item of scores || []) { const g = group(item.id); if (g) g.score = item.score; } }
async function changeScore(target, delta) {
  if (!state.ready || !state.connected || state.busy) return;
  const c = current(), g = target === 'all' ? null : group(Number(target));
  if (!c || (!g && target !== 'all') || !Number.isInteger(delta) || !delta || Math.abs(delta) > 1000) { notice('请输入 −1000 到 1000 之间的非零整数'); return; }
  state.busy = true; state.revision++; notice(); const affected = g ? [g] : c.groups;
  for (const item of affected) item.score += delta;
  render();
  try {
    const result = await api(g ? '/api/score' : `/api/classes/${c.id}/score`, 'POST', { ...(g ? { group_id: g.id } : {}), delta, client });
    if (g) g.score = result.score; else setScores(result.scores);
    say(g ? g.name : '全班', delta, c.id, false);
    $('#custom').hidden = true;
  } catch (e) {
    // A timeout may occur after the server committed: never retry or replay the write.
    state.ready = false; notice(e.message + '。正在核对服务器分数，请勿重复点击。');
  } finally { state.busy = false; render(); await refresh(); }
}
bridge.onEvent(({ type, data }) => {
  if (type === 'unauthorized') { loginView(); return; }
  if (type === 'compact') { document.body.classList.toggle('compact', !!data); $('#compact-bar').hidden = !data; return; }
  if (type === 'voice') {
    if (data.state === 'speaking') $('#announcement').textContent = '♪ ' + data.text;
    if (data.state === 'error') $('#announcement').textContent = data.message || '播报失败，请检查中文语音包';
    if (data.state === 'stopped') $('#announcement').textContent = '已停止播报';
    return;
  }
  if (type === 'notice') { notice(data); return; }
  if (!state.user) return;
  if (type === 'connection') { state.connected = data.connected; status(); return; }
  if (type === 'resume') { void refresh(); void call('connect', true); return; }
  if (type === 'connected') { state.seen.clear(); state.seq = data.seq; void refresh(); return; }
  if (type !== 'update') return;
  const id = data.seq + ':' + data.time;
  if (state.seen.has(id)) return;
  state.seen.add(id); if (state.seen.size > 256) state.seen.delete(state.seen.values().next().value);
  state.revision++;
  const gap = typeof data.seq === 'number' && state.seq !== null && data.seq !== state.seq + 1;
  state.seq = data.seq;
  if (gap) void refresh();
  if (data.client === client) return;
  if (data.kind === 'score') { const g = group(data.group_id); if (g) { g.score = data.score; say(g.name, data.delta, data.class_id, true); } }
  else if (data.kind === 'class_score') { setScores(data.scores); say('全班', data.delta, data.class_id, true); }
  else if (data.kind === 'undo') setScores(data.scores);
  else { void refresh(); return; }
  render();
});
$('#login').addEventListener('submit', async e => {
  e.preventDefault(); $('#login-submit').disabled = true; notice();
  try { $('#server').value = $('#server').value.trim() || DEFAULT_SERVER; await call('server', $('#server').value); const result = await api('/api/login', 'POST', { username: $('#username').value.trim(), password: $('#password').value }); await enter(result.user); }
  catch (error) { notice(error.message); }
  finally { $('#password').value = ''; $('#login-submit').disabled = false; }
});
$('#server').addEventListener('blur', () => { if (!$('#server').value.trim()) $('#server').value = DEFAULT_SERVER; });
$('#groups').addEventListener('click', e => { const b = e.target.closest('[data-delta]'); if (b) void changeScore(Number(b.dataset.group), Number(b.dataset.delta)); });
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
document.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { state.scope = b.dataset.scope; document.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('active', x === b)); render(); }));
$('#class-select').addEventListener('change', e => { state.cls = Number(e.target.value); rememberClass(); $('#custom').hidden = true; $('#undo-confirm').hidden = true; void call('stopVoice'); render(); });
$('#all-plus').addEventListener('click', () => void changeScore('all', 1));
$('#open-custom').addEventListener('click', () => { $('#custom').hidden = !$('#custom').hidden; $('#undo-confirm').hidden = true; if (!$('#custom').hidden) $('#custom-delta').focus(); });
$('#close-custom').addEventListener('click', () => { $('#custom').hidden = true; });
$('#custom').addEventListener('submit', e => { e.preventDefault(); void changeScore($('#custom-target').value, Number($('#custom-delta').value)); });
$('#undo').addEventListener('click', async () => {
  if (state.busy) return;
  try { const history = await api('/api/history'); const h = history[0]; if (!h) { notice('还没有可撤销的记录'); return; }
    $('#undo-description').textContent = `撤销账号最近操作：${h.class_name} · ${h.batch_id ? '全班' : h.group_name} ${h.delta > 0 ? '+' : ''}${h.delta} 分？（包含手机操作）`;
    $('#undo-confirm').hidden = false; $('#custom').hidden = true;
  } catch (e) { notice(e.message); }
});
$('#cancel-undo').addEventListener('click', () => { $('#undo-confirm').hidden = true; });
$('#do-undo').addEventListener('click', async () => {
  if (!state.ready || !state.connected || state.busy) return;
  state.busy = true; status(); $('#do-undo').disabled = true;
  try { const result = await api('/api/undo', 'POST', { client }); setScores(result.scores); $('#announcement').textContent = result.undone ? '已撤销最近一次操作' : '没有可撤销的记录'; $('#undo-confirm').hidden = true; }
  catch (e) { notice(e.message); }
  finally { state.busy = false; $('#do-undo').disabled = false; await refresh(); }
});
function voiceMode(value) { state.mode = value; localStorage.setItem('desktop.voice', value); if (value === 'off') void call('stopVoice'); render(); }
$('#voice-mode').addEventListener('change', e => voiceMode(e.target.value));
$('#mute').addEventListener('click', () => voiceMode(state.mode === 'off' ? 'all' : 'off'));
$('#test-voice').addEventListener('click', () => { void call('speak', '语音播报已就绪，第一组加一分').catch(e => notice(e.message)); });
$('#stop-voice').addEventListener('click', () => { void call('stopVoice'); });
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', 'POST'); loginView(); notice(); } catch (e) { notice(e.message); } });
$('#collapse').addEventListener('click', () => void call('window', 'compact'));
$('#expand').addEventListener('click', () => void call('window', 'expand'));
$('#hide').addEventListener('click', () => void call('window', 'hide'));
$('#pin').classList.add('on');
$('#pin').addEventListener('click', async () => { pin = await call('window', 'pin'); $('#pin').classList.toggle('on', pin); $('#pin').setAttribute('aria-label', pin ? '取消置顶' : '启用置顶'); });
$('#sync').addEventListener('click', () => { notice(); void refresh(); void call('connect', true); });
async function boot() {
  notice(); $('#retry').hidden = true;
  try { const config = await call('config'); $('#server').value = config.server || DEFAULT_SERVER;
    const result = await api('/api/me');
    if (result.authed) await enter(result.user); else loginView();
  } catch (e) { notice(e.message); $('#login').hidden = false; $('#retry').hidden = false; }
}
$('#retry').addEventListener('click', () => { if (state.user) { void refresh(); void call('connect', true); } else void boot(); });
document.body.dataset.view = state.tab;
new MutationObserver(scheduleFit).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-view'] });
const panelSizes = new ResizeObserver(scheduleFit);
document.querySelectorAll('#login,#score-panel,#rank-panel,#voice-panel,#custom,#undo-confirm,#notice').forEach(el => panelSizes.observe(el));
void boot();
