(() => {
  const archiveState = { list: [], availableFrom: null, data: null, mode: 'class', classIndex: 0, request: 0, saving: false };
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
    const classes = data.classes;
    const mode = archiveState.mode;
    let items = [];
    if (mode === 'school') items = classes.flatMap(c => c.groups.map(g => ({ name: `${c.name} ${g.name}`, score: g.score })));
    else if (mode === 'classes') items = classes.map(c => ({ name: c.name, score: c.groups.reduce((sum, g) => sum + g.score, 0) }));
    else items = classes[archiveState.classIndex]?.groups || [];
    const sorted = [...items].sort((a, b) => b.score - a.score);
    $('#archives-detail').innerHTML = `
      <p class="archive-cutoff-label">截止 ${esc(displayTime(data.cutoff_at))}（北京时间）</p>
      <div class="reward-tabs archive-rank-tabs" role="tablist" aria-label="归档排名">
        ${[['class','全班'],['school','全校'],['classes','班级']].map(([value,label]) => `<button type="button" role="tab" aria-selected="${mode === value}" data-archive-mode="${value}" class="${mode === value ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      ${mode === 'class' ? `<nav class="reward-class-nav archive-class-nav" aria-label="选择班级">${classes.map((c,i) => `<button type="button" class="reward-class-chip ${i === archiveState.classIndex ? 'on' : ''}" data-archive-class="${i}" aria-pressed="${i === archiveState.classIndex}">${esc(c.name)}</button>`).join('')}</nav>` : ''}
      <div class="archive-rank-list">${sorted.length ? sorted.map((item,i) => `<div class="lb-item ${i < 3 ? 'rank'+(i+1) : ''}"><span class="rank">${['🥇','🥈','🥉'][i] || i+1}</span><span class="lb-name">${esc(item.name)}</span><span class="lb-score">${item.score}</span></div>`).join('') : '<div class="empty">暂无小组</div>'}</div>`;
  }
  async function loadArchive(id) {
    const version = ++archiveState.request;
    archiveState.data = null;
    $('#archives-error').textContent = '';
    $('#archives-detail').innerHTML = '<div class="empty">加载中…</div>';
    try {
      const data = await api(`/api/archives/${id}`);
      if (version !== archiveState.request) return;
      archiveState.data = data;
      archiveState.classIndex = 0;
      archiveState.mode = 'class';
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
    $('#archives-select').innerHTML = data.archives.length ? data.archives.map(a => `<option value="${a.id}">${esc(a.title)}</option>`).join('') : '<option value="">暂无归档</option>';
    $('#archives-select').disabled = !data.archives.length;
    const id = selectedId || data.archives[0]?.id;
    if (id) {
      $('#archives-select').value = String(id);
      await loadArchive(id);
    } else {
      archiveState.data = null;
      $('#archives-detail').innerHTML = '<div class="empty">暂无归档</div>';
    }
  }
  document.addEventListener('jiafen:archives', async () => {
    if ($('#archives-modal').classList.contains('hidden') || archiveState.saving) return;
    try { await refreshList(Number($('#archives-select').value) || undefined); }
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
  $('#archives-select').addEventListener('change', e => { if (e.target.value) loadArchive(e.target.value); });
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
