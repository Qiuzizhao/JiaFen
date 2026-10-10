(() => {
  const archiveState = { list: [], selectedId: null, availableFrom: null, data: null, mode: 'class', classIndex: 0, request: 0, saving: false };
  const beijingParts = value => {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    return Object.fromEntries(parts.map(p => [p.type, p.value]));
  };
  const inputTime = value => {
    const p = beijingParts(value);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  };
  const displayTime = value => inputTime(value).replace('T', ' ');
  const closeCreate = () => {
    if (archiveState.saving) return;
    $('#archive-create-modal').classList.add('hidden');
    $('#archives-new').focus();
  };
  const closeArchives = () => {
    if (archiveState.saving) return;
    closeCreate();
    archiveState.request++;
    $('#archives-modal').classList.add('hidden');
    $('#btn-archives').focus();
  };
  function renderRanking() {
    const data = archiveState.data;
    if (!data) return;
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316'];
    const classes = data.classes.map(c => ({ ...c, groups: c.groups.map((g, i) => ({ ...g, color: g.color || colors[i % colors.length] })) }));
    const mode = archiveState.mode;
    let items = [];
    if (mode === 'school') items = classes.flatMap(c => c.groups.map(g => ({ name: `${c.name} · ${g.name}`, score: g.score, color: g.color })));
    else if (mode === 'classes') items = classes.map(c => ({ name: c.name, color: c.groups[0]?.color || colors[0], score: c.groups.reduce((sum, g) => sum + g.score, 0) }));
    else items = classes[archiveState.classIndex]?.groups || [];
    const sorted = [...items].sort((a, b) => b.score - a.score);
    $('#archives-detail').innerHTML = `
      <h4 class="archive-detail-title">${esc(data.title)}</h4>
      <p class="archive-cutoff-label">截止 ${esc(displayTime(data.cutoff_at))}（北京时间）</p>
      <div class="lb-toggle archive-rank-tabs" role="tablist" aria-label="归档排名">
        ${[['class','全班'],['school','全校'],['classes','班级']].map(([value,label]) => `<button type="button" role="tab" aria-selected="${mode === value}" data-archive-mode="${value}" class="${mode === value ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      ${mode === 'class' ? `<nav class="reward-class-nav archive-class-nav" aria-label="选择班级">${classes.map((c,i) => `<button type="button" class="reward-class-chip ${i === archiveState.classIndex ? 'on' : ''}" data-archive-class="${i}" aria-pressed="${i === archiveState.classIndex}">${esc(c.name)}</button>`).join('')}</nav>` : ''}
      <div class="leaderboard archive-rank-list">${sorted.length ? sorted.map((item,i) => `<div class="lb-item ${i < 3 ? 'rank'+(i+1) : ''}" style="--c:${esc(item.color)}"><span class="rank">${['🥇','🥈','🥉'][i] || i+1}</span><span class="dot"></span><span class="lb-name">${esc(item.name)}</span><span class="lb-score">${item.score}</span></div>`).join('') : '<div class="empty">暂无小组</div>'}</div>`;
  }
  const archiveIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5h18v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-12Z" fill="currentColor" opacity=".12"/><path d="M3 7.5h18v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-12ZM2 3h20v4.5H2V3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  function renderArchiveList() {
    $('#archives-list').innerHTML = archiveState.list.length ? archiveState.list.map(a => `
      <button type="button" class="archive-tile ${String(a.id) === String(archiveState.selectedId) ? 'on' : ''}" data-archive-id="${a.id}" aria-pressed="${String(a.id) === String(archiveState.selectedId)}">
        <span class="archive-tile-icon">${archiveIcon}</span>
        <span class="archive-tile-info"><span class="archive-tile-name">${esc(a.title)}</span><span class="archive-tile-time">${esc(displayTime(a.cutoff_at).slice(0,16))}</span></span>
      </button>`).join('') : '<div class="empty">暂无归档</div>';
  }
  async function loadArchive(id) {
    archiveState.selectedId = id;
    $('#archives-list').querySelectorAll('[data-archive-id]').forEach(tile => {
      const selected = tile.dataset.archiveId === String(id);
      tile.classList.toggle('on', selected);
      tile.setAttribute('aria-pressed', String(selected));
    });
    const version = ++archiveState.request;
    archiveState.data = null;
    $('#archives-error').textContent = '';
    $('#archives-detail').innerHTML = '<div class="empty">加载中…</div>';
    try {
      const data = await api(`/api/archives/${id}`);
      if (version !== archiveState.request) return;
      archiveState.data = data;
      archiveState.classIndex = Math.min(archiveState.classIndex, Math.max(0, data.classes.length - 1));
      renderRanking();
    } catch (e) {
      if (version !== archiveState.request) return;
      $('#archives-detail').innerHTML = '';
      $('#archives-error').textContent = e.message;
    }
  }
  async function refreshList(selectedId) {
    const data = await api('/api/archives');
    archiveState.list = data.archives;
    archiveState.availableFrom = data.available_from;
    const id = archiveState.list.find(a => String(a.id) === String(selectedId))?.id || data.archives[0]?.id;
    archiveState.selectedId = id || null;
    renderArchiveList();
    if (id) {
      await loadArchive(id);
    } else {
      archiveState.data = null;
      $('#archives-detail').innerHTML = '<div class="empty">暂无归档</div>';
    }
  }
  document.addEventListener('jiafen:archives', async () => {
    if ($('#archives-modal').classList.contains('hidden') || archiveState.saving) return;
    try { await refreshList(archiveState.selectedId); }
    catch (e) { $('#archives-error').textContent = e.message; }
  });
  $('#btn-archives').addEventListener('click', async () => {
    closeBackupMenu();
    $('#archives-modal').classList.remove('hidden');
    $('#archives-error').textContent = '';
    $('#archives-detail').innerHTML = '<div class="empty">加载中…</div>';
    $('#archives-new').disabled = true;
    try { await refreshList(); }
    catch (e) { $('#archives-detail').innerHTML = ''; $('#archives-error').textContent = e.message; }
    finally { $('#archives-new').disabled = false; }
    $('#archives-close').focus();
  });
  $('#archives-close').addEventListener('click', closeArchives);
  $('#archives-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeArchives(); });
  $('#archives-list').addEventListener('click', e => {
    const tile = e.target.closest('[data-archive-id]');
    if (tile) loadArchive(tile.dataset.archiveId);
  });
  $('#archives-detail').addEventListener('click', e => {
    const mode = e.target.closest('[data-archive-mode]');
    const cls = e.target.closest('[data-archive-class]');
    if (mode) archiveState.mode = mode.dataset.archiveMode;
    if (cls) archiveState.classIndex = Number(cls.dataset.archiveClass);
    if (mode || cls) renderRanking();
  });
  $('#archives-new').addEventListener('click', () => {
    $('#archive-name').value = '';
    $('#archive-cutoff').value = inputTime(Date.now());
    $('#archive-cutoff').min = archiveState.availableFrom ? inputTime(archiveState.availableFrom) : '';
    $('#archive-available').textContent = archiveState.availableFrom ? `最早可归档：${displayTime(archiveState.availableFrom)}` : '';
    $('#archive-create-error').textContent = '';
    $('#archive-create-modal').classList.remove('hidden');
    $('#archive-name').focus();
  });
  $('#archive-create-cancel').addEventListener('click', closeCreate);
  $('#archive-create-close').addEventListener('click', closeCreate);
  $('#archive-create-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeCreate(); });
  $('#archive-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (archiveState.saving) return;
    archiveState.saving = true;
    $('#archive-create-save').disabled = true;
    $('#archive-create-error').textContent = '';
    let created;
    try {
      created = await api('/api/archives', { method: 'POST', body: {
        title: $('#archive-name').value.trim(), cutoff_at: $('#archive-cutoff').value + '+08:00', client: CLIENT_ID,
      }});
    } catch (error) { $('#archive-create-error').textContent = error.message; }
    finally { archiveState.saving = false; $('#archive-create-save').disabled = false; }
    if (created) {
      closeCreate();
      try { await refreshList(created.id); }
      catch (error) { $('#archives-error').textContent = error.message; }
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#archive-create-modal').classList.contains('hidden')) closeCreate();
    else if (!$('#archives-modal').classList.contains('hidden')) closeArchives();
  });
})();
