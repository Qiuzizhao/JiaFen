(() => {
  const s = { list: [], selected: null, editing: false, records: [], preview: null, request: 0, busy: false, dirty: false, pending: false };
  const statusName = { recognized: '已识别', review: '待校正', unknown: '未知' };
  const sign = n => n > 0 ? '+' + n : String(n);
  const local = at => at.replace(' ', 'T');
  const milliseconds = at => new Date(at.replace(' ', 'T') + (/[Z+]\d|Z$/.test(at) ? '' : '+08:00')).getTime();
  const stamp = ms => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
  const visible = () => !$('#lessons-modal').classList.contains('hidden');
  function close() {
    if (s.busy || (s.dirty && !confirm('放弃尚未保存的课堂调整？'))) return;
    s.request++; s.editing = false; s.dirty = false;
    $('#lessons-modal').classList.add('hidden');
    $('#btn-lessons').focus();
  }
  async function load(selected = s.selected?.id) {
    if (!visible() || !$('#lessons-class').value) return;
    const version = ++s.request;
    try {
      const data = await api(`/api/classes/${$('#lessons-class').value}/lessons?month=${$('#lessons-month').value}`);
      if (version !== s.request || !visible()) return;
      s.list = data.lessons;
      s.selected = s.list.find(l => l.id === selected) || s.list[0] || null;
      s.pending = false;
      $('#lessons-error').textContent = '';
      renderCircles(data);
      renderDetail();
    } catch (e) { if (version === s.request) $('#lessons-error').textContent = e.message; }
  }
  function renderCircles(data) {
    const days = new Map();
    for (const lesson of s.list) {
      const day = lesson.start_at.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(lesson);
    }
    $('#lessons-circles').innerHTML = [...days].map(([day, items]) => `
      <section class="lesson-day"><h4>${esc(day)}</h4><div class="lesson-circle-row">
      ${items.map((l, i) => `<button type="button" class="lesson-circle-item ${s.selected?.id === l.id ? 'on' : ''} ${l.status}" data-lesson="${l.id}" aria-pressed="${s.selected?.id === l.id}">
      <span class="lesson-circle">${sign(l.summary.net)}</span><strong>第${i + 1}节</strong><small>${statusName[l.status]}</small></button>`).join('')}</div></section>`).join('') ||
      '<div class="empty">该月暂无课堂记录。没有记分记录不代表没有上课，可手动补建。</div>';
    if (data.unassigned) $('#lessons-circles').insertAdjacentHTML('beforeend', `<p class="lesson-notice">有 ${data.unassigned} 条有效记分未归属课堂，可通过补建课堂或编辑边界归入。</p>`);
    if (data.voided_only) $('#lessons-circles').insertAdjacentHTML('beforeend', `<p class="muted">另有 ${data.voided_only} 个自动窗口内的记分已全部回退，未计为有效课堂；原始明细在编辑时间轴中保留。</p>`);
  }
  function stats(summary) {
    return `<div class="lesson-stats"><span>加分 <b class="lesson-positive">+${summary.positive}</b></span><span>扣分 <b class="lesson-negative">${summary.negative}</b></span><span>净分 <b>${sign(summary.net)}</b></span></div>`;
  }
  function groupTable(summary) {
    return `<div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>小组</th><th>加分</th><th>扣分</th><th>净分</th></tr></thead><tbody>${summary.groups.map(g => `<tr><td>${esc(g.name)}</td><td>+${g.positive}</td><td>${g.negative}</td><td>${sign(g.net)}</td></tr>`).join('') || '<tr><td colspan="4">暂无有效记分</td></tr>'}</tbody></table></div>`;
  }
  function renderDetail() {
    const l = s.selected;
    if (!l) { $('#lesson-detail').innerHTML = ''; return; }
    $('#lesson-detail').innerHTML = `
      <section class="lesson-detail-head"><div><h4>${esc(l.start_at.slice(0, 10))} · ${statusName[l.status]}</h4><p>${esc(l.start_at.slice(11))}—${esc(l.end_at.slice(11))}（北京时间）</p></div>
      <button id="lesson-edit" class="ghost" type="button">${s.editing ? '退出编辑' : '编辑时间轴'}</button></section>
      ${l.note ? `<p class="lesson-note">${esc(l.note)}</p>` : ''}
      ${stats(l.summary)}
      <div id="lesson-normal-summary" ${s.editing ? 'hidden' : ''}>${groupTable(l.summary)}</div>
      <section id="lesson-editor" ${s.editing ? '' : 'hidden'}>
        <p class="lesson-note">拖动左右边界；横向滑动查看完整时间轴。灰色为已撤销记录或仅供核对的历史状态痕迹，不计分。</p>
        <div class="lesson-edit-controls">
          <label>开始 <input id="lesson-start" type="datetime-local" step="1" value="${local(l.start_at)}"></label>
          <label>结束 <input id="lesson-end" type="datetime-local" step="1" value="${local(l.end_at)}"></label>
          <select id="lesson-status" aria-label="课堂状态">${Object.entries(statusName).map(([v,n]) => `<option value="${v}" ${v === l.status ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
        <div id="lesson-timeline-scroll" class="lesson-timeline-scroll"><div id="lesson-timeline"></div></div>
        <div id="lesson-preview" aria-live="polite"></div>
        <div class="lesson-editor-actions"><button id="lesson-split" class="ghost" type="button">拆分课堂</button><button id="lesson-merge" class="ghost" type="button">合并下一节</button><button id="lesson-save" class="primary" type="button" disabled>确认保存</button></div>
        <div id="lesson-records"></div>
      </section>`;
  }
  async function edit() {
    if (s.busy) return;
    if (s.editing) {
      if (s.dirty && !confirm('放弃尚未保存的课堂调整？')) return;
      s.editing = false; s.dirty = false; renderDetail();
      if (s.pending) await load();
      return;
    }
    s.editing = true; s.dirty = false; s.request++; renderDetail();
    await records();
    await preview();
  }
  async function records() {
    const l = s.selected, version = s.request;
    // Include all operations of the selected Beijing day(s), not just assigned ones.
    s.dayStart = l.start_at.slice(0, 10) + ' 00:00:00';
    s.dayEnd = stamp(milliseconds(l.end_at.slice(0, 10) + ' 00:00:00') + 86400000);
    try {
      const data = await api(`/api/classes/${l.class_id}/lesson-records?start=${encodeURIComponent(s.dayStart)}&end=${encodeURIComponent(s.dayEnd)}`);
      if (!s.editing || version !== s.request || s.selected?.id !== l.id) return;
      s.records = data;
      timeline();
      $('#lesson-timeline-scroll').scrollLeft = Math.max(0, x(l.start_at) - 60);
    } catch (e) { $('#lessons-error').textContent = e.message; }
  }
  const pxMinute = 3;
  const x = at => (milliseconds(at) - milliseconds(s.dayStart)) / 60000 * pxMinute;
  function timeline() {
    const total = (milliseconds(s.dayEnd) - milliseconds(s.dayStart)) / 60000;
    const width = total * pxMinute, height = Math.max(135, 60 + s.records.length * 28);
    $('#lesson-timeline').style.cssText = `width:${width}px;height:${height}px`;
    $('#lesson-timeline').innerHTML = `
      ${Array.from({ length: Math.ceil(total / 30) }, (_, i) => `<span class="lesson-tick" style="left:${i * 30 * pxMinute}px">${stamp(milliseconds(s.dayStart) + i * 1800000).slice(11,16)}</span>`).join('')}
      <div id="lesson-window-shade" class="lesson-window-shade"></div>
      ${s.records.map((e,i) => `<div class="lesson-timeline-entry ${e.observed_only ? 'observed' : e.voided_at ? 'voided' : ''}" style="left:${x(e.occurred_at)}px;top:${44 + i * 28}px" title="${esc(e.occurred_at)} · ${esc(e.group_name || '小组#' + e.group_id)} · ${sign(e.delta)}${e.observed_only ? '（仅状态痕迹，不计分）' : e.voided_at ? '（已撤销）' : ''}"><span>●</span> ${esc(e.occurred_at.slice(11))} ${esc(e.group_name || '小组#' + e.group_id)} ${sign(e.delta)}${e.observed_only ? ' 状态痕迹' : e.voided_at ? ' 已撤销' : ''}</div>`).join('')}
      <button id="lesson-boundary-start" class="lesson-boundary" data-boundary="start" type="button" role="slider" aria-label="课堂开始边界" aria-valuemin="0" aria-valuemax="${total}"><span>开始</span></button>
      <button id="lesson-boundary-end" class="lesson-boundary" data-boundary="end" type="button" role="slider" aria-label="课堂结束边界" aria-valuemin="0" aria-valuemax="${total}"><span>结束</span></button>`;
    placeBoundaries();
  }
  function placeBoundaries() {
    const a = $('#lesson-start'), b = $('#lesson-end');
    if (!a || !b || !a.value || !b.value || !$('#lesson-boundary-start')) return;
    const left = x(a.value), right = x(b.value);
    $('#lesson-boundary-start').style.left = left + 'px';
    $('#lesson-boundary-end').style.left = right + 'px';
    for (const [kind, input] of [['start',a],['end',b]]) {
      const button = $('#lesson-boundary-' + kind);
      button.setAttribute('aria-valuenow', String(Math.round(x(input.value) / pxMinute)));
      button.setAttribute('aria-valuetext', input.value.replace('T',' '));
    }
    $('#lesson-window-shade').style.cssText = `left:${left}px;width:${Math.max(0,right-left)}px`;
  }
  let previewVersion = 0;
  async function preview() {
    if (!s.editing || !$('#lesson-start')) return;
    const version = ++previewVersion;
    $('#lesson-save').disabled = true;
    try {
      const data = await api(`/api/lessons/${s.selected.id}/preview`, { method: 'POST', body: { start_at: $('#lesson-start').value, end_at: $('#lesson-end').value } });
      if (version !== previewVersion || !s.editing) return;
      s.preview = data;
      $('#lesson-preview').innerHTML = `<div class="lesson-preview-net">调整前 <b>${sign(data.before.net)}</b><span>→</span>调整后 <b>${sign(data.summary.net)}</b></div>` +
        (data.conflicts.length ? '<p class="err">与其他课堂时间重叠，请调整边界；不能重复归属。</p>' : '') +
        (data.split_batches.length ? '<p class="err">边界拆分了全班记分批次，请调整。</p>' : '') +
        stats(data.summary) + groupTable(data.summary);
      $('#lesson-save').disabled = !data.can_save || s.busy;
      const included = new Set(data.entries.map(e => e.id));
      $('#lesson-records').innerHTML = `<h4>全部记分记录</h4><div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>发生时间</th><th>小组</th><th>分值</th><th>归属预览</th></tr></thead><tbody>${s.records.map(e => `<tr class="${e.observed_only ? 'observed' : e.voided_at ? 'voided' : ''}"><td>${esc(e.occurred_at)}</td><td>${esc(e.group_name || '小组#'+e.group_id)}</td><td>${sign(e.delta)}</td><td>${e.observed_only ? '历史状态痕迹，不计分' : e.voided_at ? '已撤销，不计分' : included.has(e.id) ? '本节课堂' : e.lesson_id ? '其他课堂' : '未归属'}</td></tr>`).join('') || '<tr><td colspan="4">当日无积分记录，可保留手动补建课堂。</td></tr>'}</tbody></table></div>`;
    } catch (e) { if (version === previewVersion && s.editing) $('#lesson-preview').textContent = e.message; }
  }
  async function mutate(path, body, method = 'POST') {
    if (s.busy) return;
    s.busy = true; $('#lessons-error').textContent = '';
    if ($('#lesson-save')) $('#lesson-save').disabled = true;
    try {
      const result = await api(path, { method, body });
      s.editing = false; s.dirty = false;
      await load(result.id || result.ids?.[0] || s.selected?.id);
    } catch (e) {
      $('#lessons-error').textContent = e.message;
      if (s.editing) await preview();
    } finally { s.busy = false; if (s.editing && s.preview?.can_save) $('#lesson-save').disabled = false; }
  }
  $('#btn-lessons').addEventListener('click', async () => {
    closeBackupMenu();
    s.ownerId = state.user?.id;
    $('#lessons-class').innerHTML = state.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#lessons-class').value = String(state.currentClassId || state.classes[0]?.id || '');
    $('#lessons-month').value = beijingMonth();
    s.editing = false; s.dirty = false;
    $('#lessons-modal').classList.remove('hidden');
    await load(); $('#lessons-close').focus();
  });
  $('#lessons-close').addEventListener('click', close);
  $('#lessons-modal').addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
  for (const id of ['lessons-class','lessons-month']) $('#' + id).addEventListener('change', async () => {
    if (s.dirty && !confirm('放弃尚未保存的课堂调整？')) {
      $('#lessons-class').value = String(s.selected.class_id);
      $('#lessons-month').value = s.selected.start_at.slice(0,7); return;
    }
    s.editing = false; s.dirty = false; await load(null);
  });
  $('#lessons-circles').addEventListener('click', e => {
    const button = e.target.closest('[data-lesson]');
    if (!button || s.busy || (s.dirty && !confirm('放弃尚未保存的课堂调整？'))) return;
    s.request++;
    s.selected = s.list.find(l => l.id === Number(button.dataset.lesson));
    s.editing = false; s.dirty = false;
    $('#lessons-circles').querySelectorAll('[data-lesson]').forEach(el => {
      const on = Number(el.dataset.lesson) === s.selected.id;
      el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on));
    });
    renderDetail();
  });
  $('#lesson-detail').addEventListener('click', async e => {
    if (e.target.closest('#lesson-edit')) return edit();
    if (e.target.closest('#lesson-save')) {
      if (!s.preview?.can_save || !confirm('确认保存课堂边界和记录归属？原始积分保持不变。')) return;
      return mutate('/api/lessons/' + s.selected.id, { revision: s.selected.revision, start_at: $('#lesson-start').value, end_at: $('#lesson-end').value, status: $('#lesson-status').value }, 'PUT');
    }
    if (e.target.closest('#lesson-split')) {
      const at = prompt('拆分时间（北京时间，格式 YYYY-MM-DD HH:mm:ss）', s.selected.start_at.slice(0, 10) + ' 12:00:00');
      if (!at || !confirm('确认将本节课堂拆分为两节？')) return;
      return mutate('/api/lessons/' + s.selected.id + '/split', { at, revision: s.selected.revision });
    }
    if (e.target.closest('#lesson-merge')) {
      const index = s.list.findIndex(l => l.id === s.selected.id), next = s.list[index + 1];
      if (!next) { $('#lessons-error').textContent = '本月没有下一节课堂'; return; }
      if (!confirm(`合并至 ${next.end_at}？两节之间的有效记录也会归入合并后的课堂。`)) return;
      return mutate('/api/lessons/' + s.selected.id + '/merge', { revision: s.selected.revision, other_id: next.id, other_revision: next.revision });
    }
  });
  $('#lesson-detail').addEventListener('change', async e => {
    if (!['lesson-start','lesson-end','lesson-status'].includes(e.target.id)) return;
    s.dirty = true; placeBoundaries();
    // Date inputs can extend the editor to another day.
    if (e.target.id !== 'lesson-status' && $('#lesson-start').value && $('#lesson-end').value) {
      const a = $('#lesson-start').value, b = $('#lesson-end').value;
      if (a.slice(0,10) !== s.dayStart.slice(0,10) || b.slice(0,10) !== stamp(milliseconds(s.dayEnd)-86400000).slice(0,10)) {
        try {
          s.dayStart = a.slice(0,10) + ' 00:00:00';
          s.dayEnd = stamp(milliseconds(b.slice(0,10)+' 00:00:00')+86400000);
          if (milliseconds(s.dayEnd)-milliseconds(s.dayStart) <= 3*86400000 && milliseconds(s.dayEnd)>milliseconds(s.dayStart)) {
            s.records = await api(`/api/classes/${s.selected.class_id}/lesson-records?start=${encodeURIComponent(s.dayStart)}&end=${encodeURIComponent(s.dayEnd)}`);
            timeline();
          }
        } catch (e) { $('#lessons-error').textContent = e.message; }
      }
    }
    await preview();
  });
  let drag = null;
  $('#lesson-detail').addEventListener('pointerdown', e => {
    const boundary = e.target.closest('[data-boundary]');
    if (!boundary || s.busy) return;
    drag = { kind: boundary.dataset.boundary, x: e.clientX, value: milliseconds($('#lesson-' + boundary.dataset.boundary).value), scroll: $('#lesson-timeline-scroll').scrollLeft };
    boundary.setPointerCapture(e.pointerId); e.preventDefault();
  });
  $('#lesson-detail').addEventListener('pointermove', e => {
    if (!drag) return;
    const scroller = $('#lesson-timeline-scroll'), rect = scroller.getBoundingClientRect();
    if (e.clientX > rect.right - 25) scroller.scrollLeft += 12;
    if (e.clientX < rect.left + 25) scroller.scrollLeft -= 12;
    const minutes = Math.round((e.clientX - drag.x + scroller.scrollLeft - drag.scroll) / pxMinute);
    const value = Math.max(milliseconds(s.dayStart), Math.min(milliseconds(s.dayEnd), drag.value + minutes * 60000));
    $('#lesson-' + drag.kind).value = local(stamp(value));
    s.dirty = true; $('#lesson-save').disabled = true; placeBoundaries();
  });
  for (const event of ['pointerup','pointercancel']) $('#lesson-detail').addEventListener(event, () => {
    if (!drag) return; drag = null; void preview();
  });
  $('#lesson-detail').addEventListener('keydown', e => {
    const boundary = e.target.closest('[data-boundary]');
    if (!boundary || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault(); const input = $('#lesson-' + boundary.dataset.boundary);
    input.value = local(stamp(milliseconds(input.value) + (e.key === 'ArrowLeft' ? -60000 : 60000)));
    s.dirty = true; placeBoundaries(); void preview();
  });
  $('#lessons-new').addEventListener('click', () => {
    if (!$('#lessons-class').value || s.busy) return;
    $('#lesson-form-start').value = $('#lessons-month').value + '-01T08:00:00';
    $('#lesson-form-end').value = $('#lessons-month').value + '-01T10:00:00';
    $('#lesson-form-error').textContent = '';
    $('#lesson-form-modal').classList.remove('hidden');
  });
  function closeForm() { if (!s.busy) $('#lesson-form-modal').classList.add('hidden'); }
  $('#lesson-form-close').addEventListener('click', closeForm);
  $('#lesson-form-cancel').addEventListener('click', closeForm);
  $('#lesson-form').addEventListener('submit', async e => {
    e.preventDefault(); if (s.busy) return; s.busy = true;
    try {
      const result = await api(`/api/classes/${$('#lessons-class').value}/lessons`, { method: 'POST', body: { start_at: $('#lesson-form-start').value, end_at: $('#lesson-form-end').value } });
      $('#lessons-month').value = $('#lesson-form-start').value.slice(0,7);
      $('#lesson-form-modal').classList.add('hidden'); s.editing = false; s.dirty = false;
      await load(result.id);
    } catch (e) { $('#lesson-form-error').textContent = e.message; }
    finally { s.busy = false; }
  });
  $('#lessons-settings').addEventListener('click', async () => {
    try {
      const data = await api('/api/lessons/settings'); $('#lesson-window').value = data.window_minutes;
      $('#lesson-settings-error').textContent = ''; $('#lesson-settings-modal').classList.remove('hidden');
    } catch (e) { $('#lessons-error').textContent = e.message; }
  });
  $('#lesson-settings-cancel').addEventListener('click', () => $('#lesson-settings-modal').classList.add('hidden'));
  $('#lesson-settings-form').addEventListener('submit', async e => {
    e.preventDefault(); if (s.busy) return; s.busy = true;
    try {
      await api('/api/lessons/settings', { method: 'PUT', body: { window_minutes: Number($('#lesson-window').value) } });
      $('#lesson-settings-modal').classList.add('hidden');
    } catch (e) { $('#lesson-settings-error').textContent = e.message; }
    finally { s.busy = false; }
  });
  function clearSession() {
    s.request++; s.editing = false; s.dirty = false; s.list = []; s.selected = null;
    for (const id of ['lessons-modal','lesson-form-modal','lesson-settings-modal']) $('#' + id).classList.add('hidden');
    $('#lessons-circles').innerHTML = ''; $('#lesson-detail').innerHTML = '';
  }
  document.addEventListener('jiafen:lesson-session-ended', clearSession);
  let timer;
  document.addEventListener('jiafen:lessons', () => {
    if (!visible() || s.busy) return;
    if (s.ownerId !== state.user?.id) return clearSession();
    if (s.editing) { s.pending = true; $('#lessons-error').textContent = '有新的数据变更；退出编辑后刷新。保存时会重新核对归属与版本。'; return; }
    clearTimeout(timer); timer = setTimeout(() => load(), 100);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !visible()) return;
    if (!$('#lesson-form-modal').classList.contains('hidden')) return closeForm();
    if (!$('#lesson-settings-modal').classList.contains('hidden')) return $('#lesson-settings-modal').classList.add('hidden');
    close();
  });
})();
