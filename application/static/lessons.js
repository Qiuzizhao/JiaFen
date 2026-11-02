(() => {
  const s = { list: [], selected: null, editing: false, records: [], preview: null, request: 0, busy: false, dirty: false, pending: false, scale: 3 };
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
    s.request++; s.editing = false; s.dirty = false; previewVersion++; clearTimeout(previewTimer); drag=null; pan=null;
    $('#lessons-modal').classList.add('hidden');
    $('#btn-lessons').focus();
  }
  async function load(selected = s.selected?.id) {
    if (!visible()) return;
    if (!$('#lessons-class').value) { s.list=[]; s.selected=null; renderCircles({}); renderDetail(); return; }
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
    const ordinal = new Map();
    $('#lessons-circles').innerHTML = '<div class="lesson-circle-row">' + s.list.map(l => {
      const day = l.start_at.slice(0,10), n = (ordinal.get(day) || 0) + 1;
      ordinal.set(day,n);
      return `<button type="button" class="lesson-circle-item ${s.selected?.id===l.id?'on':''} ${l.status}" data-lesson="${l.id}" aria-pressed="${s.selected?.id===l.id}"><span class="lesson-circle">${sign(l.summary.net)}</span><strong>${day.slice(5).replace('-','/')}</strong><small>第${n}节 · ${statusName[l.status]}</small></button>`;
    }).join('') + '</div>';
    if (!s.list.length) $('#lessons-circles').innerHTML = '<div class="empty">暂无已登记课堂。没有记分不代表没有上课，可手动补建。</div>';
    if (data.unassigned) $('#lessons-circles').insertAdjacentHTML('beforeend', `<p class="lesson-notice">${data.unassigned} 条有效记分待归属，编辑时间轴可查看。</p>`);
    if (data.voided_only) $('#lessons-circles').insertAdjacentHTML('beforeend', `<p class="muted">${data.voided_only} 个自动窗口内记分已全部回退，原始记录保留在时间轴中。</p>`);
  }
  function stats(summary) {
    return `<div class="lesson-stats"><span>加分 <b class="lesson-positive">+${summary.positive}</b></span><span>扣分 <b class="lesson-negative">${summary.negative}</b></span><span>净分 <b>${sign(summary.net)}</b></span></div>`;
  }
  function groupTable(summary) {
    return `<div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>小组</th><th>加分</th><th>扣分</th><th>净积分</th></tr></thead><tbody>${summary.groups.map(g=>`<tr><td>${esc(g.name)}</td><td>+${g.positive}</td><td>${g.negative}</td><td>${sign(g.net)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderDetail() {
    const l=s.selected;
    $('#lesson-edit').textContent=s.editing?'普通模式':'编辑时间轴';
    $('#lesson-edit').disabled=!$('#lessons-class').value;
    $('#lessons-circles').hidden=s.editing;
    if (!l && !s.editing) { $('#lesson-detail').innerHTML=''; return; }
    $('#lesson-detail').innerHTML = `
      ${l ? `<section class="lesson-detail-head"><div><h4>${esc(l.start_at.slice(0,10))} · ${statusName[l.status]}</h4><p>${esc(l.start_at.slice(11))} — ${esc(l.end_at.slice(0,10)===l.start_at.slice(0,10)?l.end_at.slice(11):l.end_at)}（北京时间）</p></div></section>${l.note&&!s.editing?`<p class="lesson-note">${esc(l.note)}</p>`:''}${!s.editing?stats(l.summary):''}` : ''}
      <div id="lesson-normal-summary" ${s.editing?'hidden':''}>${l?groupTable(l.summary):''}</div>
      <section id="lesson-editor" ${s.editing?'':'hidden'}>
        <div class="timeline-toolbar"><span>${esc($('#lessons-month').value)} · 完整积分时间轴</span><select id="lesson-window-select" aria-label="选择要编辑的课堂"><option value="">查看全部记录</option>${s.list.map(row=>`<option value="${row.id}" ${row.id===l?.id?'selected':''}>${esc(row.start_at.slice(5,16))} · 净分${sign(row.summary.net)}</option>`).join('')}</select><label>缩放 <select id="lesson-zoom" aria-label="时间轴缩放">${[[0.1,'概览'],[0.5,'30分钟'],[3,'10分钟'],[8,'精细'],[120,'秒级']].map(([v,n])=>`<option value="${v}" ${s.scale===v?'selected':''}>${n}</option>`).join('')}</select></label><button id="lesson-locate" class="ghost" type="button">定位当前课堂</button></div>
        <p class="lesson-note">横向拖动浏览。绿色为加分，红色为扣分；灰色记录不计分。点击节点查看详情。</p>
        <div id="lesson-timeline-scroll" class="lesson-timeline-scroll"><div id="lesson-timeline"></div></div>
        <div id="lesson-event-detail" aria-live="polite"></div>
        ${l ? `<div class="lesson-edit-controls"><label>开始<input id="lesson-start" type="datetime-local" step="1" value="${local(l.start_at)}"></label><label>结束<input id="lesson-end" type="datetime-local" step="1" value="${local(l.end_at)}"></label><select id="lesson-status" aria-label="课堂状态">${Object.entries(statusName).map(([v,n])=>`<option value="${v}" ${v===l.status?'selected':''}>${n}</option>`).join('')}</select></div>` : '<p class="lesson-notice">可先查看未归属记录，点击“补建课堂”建立时间窗口。</p>'}
        <div id="lesson-preview" aria-live="polite"></div>
        ${l ? '<div class="lesson-editor-actions"><button id="lesson-split" class="ghost" type="button">拆分课堂</button><button id="lesson-merge" class="ghost" type="button">合并下一节</button><button id="lesson-save" class="primary" type="button" disabled>保存调整</button></div>' : ''}
        <div id="lesson-records"></div>
      </section>`;
  }
  async function edit() {
    if (s.busy) return;
    if (s.editing) {
      if(s.dirty&&!confirm('放弃尚未保存的课堂调整？'))return;
      s.editing=false;s.dirty=false;previewVersion++;renderDetail();
      if(s.pending)await load();
      return;
    }
    s.editing=true;s.dirty=false;s.request++;renderDetail();
    await records(true);
    if(s.selected)await preview();
  }
  function axisRange() {
    const month=$('#lessons-month').value, [year,number]=month.split('-').map(Number);
    let a=month+'-01 00:00:00';
    let b=`${year+(number===12?1:0)}-${String(number%12+1).padStart(2,'0')}-01 00:00:00`;
    const start=$('#lesson-start')?.value,end=$('#lesson-end')?.value;
    if(start&&milliseconds(start)<milliseconds(a))a=start.slice(0,10)+' 00:00:00';
    if(end&&milliseconds(end)>=milliseconds(b))b=stamp(milliseconds(end.slice(0,10)+' 00:00:00')+86400000);
    return [a,b];
  }
  async function records(locate=false) {
    const cid=Number($('#lessons-class').value),version=s.request;
    if(!cid)return;
    const [start,end]=axisRange();
    if(milliseconds(end)-milliseconds(start)>62*86400000||milliseconds(end)<=milliseconds(start))return;
    try {
      const data=await api(`/api/classes/${cid}/lesson-records?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      if(!s.editing||version!==s.request||Number($('#lessons-class').value)!==cid)return;
      const scroll=$('#lesson-timeline-scroll').scrollLeft;
      s.dayStart=start;s.dayEnd=end;s.records=data;
      timeline();
      renderRecordList();
      if(locate)locateCurrent();else $('#lesson-timeline-scroll').scrollLeft=scroll;
    }catch(e){if(version===s.request)$('#lessons-error').textContent=e.message;}
  }
  const x=at=>(milliseconds(at)-milliseconds(s.dayStart))/60000*s.scale;
  function locateCurrent() {
    const at=$('#lesson-start')?.value||s.records[0]?.occurred_at||s.dayStart;
    $('#lesson-timeline-scroll').scrollLeft=Math.max(0,x(at)-80);
  }
  function timeline() {
    const minutes=(milliseconds(s.dayEnd)-milliseconds(s.dayStart))/60000;
    const width=minutes*s.scale;
    const last=[],layout=[];
    for(const e of s.records) {
      const position=x(e.occurred_at);
      let lane=last.findIndex(v=>position-v>44);
      if(lane<0)lane=last.length;
      last[lane]=position;layout.push({e,position,lane});
    }
    const axisY=Math.max(150,last.length*28+55),height=axisY+55;
    s.axisY=axisY;
    const step=s.scale<0.3?720:s.scale<1?120:30;
    $('#lesson-timeline').style.cssText=`width:${width}px;height:${height}px`;
    $('#lesson-timeline').innerHTML=`
      <div class="lesson-axis-line" style="top:${axisY}px"></div>
      ${Array.from({length:Math.ceil(minutes/step)},(_,i)=>{
        const at=stamp(milliseconds(s.dayStart)+i*step*60000);
        return `<span class="lesson-tick" style="left:${i*step*s.scale}px;height:${height}px">${at.slice(5,10).replace('-','/')} ${at.slice(11,16)}</span><span class="lesson-axis-time" style="left:${i*step*s.scale}px;top:${axisY+15}px">${at.slice(5,10).replace('-','/')} ${at.slice(11,16)}</span>`;
      }).join('')}
      ${s.list.filter(l=>l.id!==s.selected?.id).map(l=>`<div class="lesson-other-window" style="left:${Math.max(0,x(l.start_at))}px;width:${Math.max(2,x(l.end_at)-Math.max(0,x(l.start_at)))}px"><button type="button" data-lesson-window="${l.id}" title="${esc(l.start_at)} — ${esc(l.end_at)}">${l.start_at.slice(5,10).replace('-','/')}课堂</button></div>`).join('')}
      ${s.selected?'<div id="lesson-window-shade" class="lesson-window-shade"></div>':''}
      ${layout.map(({e,position,lane})=>`<button type="button" class="lesson-event ${e.observed_only?'observed':e.voided_at?'voided':e.delta>0?'positive':'negative'}" data-timeline-event="${e.id}" style="left:${position}px;top:${axisY}px;--stem:${(lane+1)*28}px" aria-label="${esc(e.occurred_at+' '+(e.group_name||'小组#'+e.group_id)+' '+sign(e.delta))}"><span class="lesson-event-stem"></span><span class="lesson-event-value">${sign(e.delta)}</span><span class="lesson-event-dot"></span></button>`).join('')}
      ${s.selected?`<button id="lesson-boundary-start" class="lesson-boundary" data-boundary="start" type="button" role="slider" aria-label="课堂开始边界" aria-valuemin="0" aria-valuemax="${minutes}"><span>开始</span></button><button id="lesson-boundary-end" class="lesson-boundary" data-boundary="end" type="button" role="slider" aria-label="课堂结束边界" aria-valuemin="0" aria-valuemax="${minutes}"><span>结束</span></button>`:''}`;
    placeBoundaries();
    $('#lesson-timeline-scroll').scrollTop=Math.max(0,axisY-230);
  }
  function placeBoundaries() {
    if(!s.selected||!$('#lesson-boundary-start'))return;
    const a=$('#lesson-start').value,b=$('#lesson-end').value;
    if(!a||!b)return;
    const left=x(a),right=x(b);
    for(const [kind,value]of[['start',a],['end',b]]) {
      const button=$('#lesson-boundary-'+kind);
      button.style.left=x(value)+'px';
      button.setAttribute('aria-valuenow',String(Math.round(x(value)/s.scale)));
      button.setAttribute('aria-valuetext',value.replace('T',' '));
    }
    $('#lesson-window-shade').style.cssText=`left:${left}px;width:${Math.max(0,right-left)}px`;
    const ids=new Set(s.records.filter(e=>!e.voided_at&&!e.observed_only&&milliseconds(e.occurred_at)>=milliseconds(a)&&milliseconds(e.occurred_at)<milliseconds(b)).map(e=>String(e.id)));
    $('#lesson-timeline').querySelectorAll('[data-timeline-event]').forEach(el=>el.classList.toggle('in-window',ids.has(el.dataset.timelineEvent)));
  }
  function summarize(entries) {
    const roster=state.classes.find(c=>c.id===Number($('#lessons-class').value))?.groups||[];
    const groups=new Map(roster.map(g=>[g.id,{group_id:g.id,name:g.name,positive:0,negative:0,net:0,count:0}]));
    for(const e of entries) {
      if(e.voided_at||e.observed_only)continue;
      if(!groups.has(e.group_id))groups.set(e.group_id,{group_id:e.group_id,name:e.group_name||'小组#'+e.group_id,positive:0,negative:0,net:0,count:0});
      const g=groups.get(e.group_id);g.positive+=Math.max(e.delta,0);g.negative+=Math.min(e.delta,0);g.net+=e.delta;g.count++;
    }
    const values=[...groups.values()];
    return {positive:values.reduce((a,g)=>a+g.positive,0),negative:values.reduce((a,g)=>a+g.negative,0),net:values.reduce((a,g)=>a+g.net,0),count:values.reduce((a,g)=>a+g.count,0),groups:values};
  }
  function localPreview() {
    if(!s.selected||!$('#lesson-start').value||!$('#lesson-end').value)return null;
    const start=$('#lesson-start').value,end=$('#lesson-end').value,a=milliseconds(start),b=milliseconds(end);
    if(!(a<b))return null;
    const entries=s.records.filter(e=>milliseconds(e.occurred_at)>=a&&milliseconds(e.occurred_at)<b&&!e.observed_only);
    const conflicts=s.list.filter(l=>l.id!==s.selected.id&&milliseconds(l.start_at)<b&&milliseconds(l.end_at)>a);
    const batches=new Set(entries.map(e=>e.batch_id).filter(Boolean));
    const split=[...batches].filter(batch=>s.records.some(e=>e.batch_id===batch&&(milliseconds(e.occurred_at)<a||milliseconds(e.occurred_at)>=b)));
    return {before:s.selected.summary,summary:summarize(entries),entries,conflicts,split_batches:split,can_save:!conflicts.length&&!split.length};
  }
  function renderRecordList(included=new Set()) {
    $('#lesson-records').innerHTML=`<h4>完整记分记录 · ${s.records.length}条</h4><div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>发生时间</th><th>小组</th><th>分值</th><th>归属预览</th><th></th></tr></thead><tbody>${s.records.map(e=>`<tr class="${e.observed_only?'observed':e.voided_at?'voided':''}"><td>${esc(e.occurred_at)}</td><td>${esc(e.group_name||'小组#'+e.group_id)}</td><td>${sign(e.delta)}</td><td>${e.observed_only?'历史状态痕迹，不计分':e.voided_at?'已撤销，不计分':included.has(e.id)?'当前课堂':e.lesson_id?'其他课堂':'待归属'}</td><td>${!e.voided_at&&!e.observed_only?`<button type="button" class="history-undo" data-undo-entry="${e.id}">撤销</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">该范围无积分记录；可补建实际课堂。</td></tr>'}</tbody></table></div>`;
  }
  function renderPreview(data,verified=false) {
    const included=new Set(data.entries.map(e=>e.id));
    $('#lesson-preview').innerHTML=`<div class="lesson-preview-net">调整前 <b>${sign(data.before.net)}</b><span>→</span>调整后 <b>${sign(data.summary.net)}</b></div>`+
      (data.conflicts.length?'<p class="err">与其他课堂时间重叠，不能保存或重复归属。</p>':'')+
      (data.split_batches.length?'<p class="err">边界拆分了全班记分批次，请调整。</p>':'')+
      stats(data.summary)+groupTable(data.summary)+`<p class="lesson-note">${verified?'预览已核对；保存前原始归属保持不变。':'正在核对预览…'}</p>`;
    const affected=s.list.filter(l=>l.id!==s.selected.id&&s.records.some(e=>e.lesson_id===l.id&&included.has(e.id)&&!e.voided_at&&!e.observed_only));
    if(affected.length)$('#lesson-preview').insertAdjacentHTML('beforeend',`<div class="lesson-affected"><h4>其他课堂影响预览</h4>${affected.map(l=>{const remaining=s.records.filter(e=>e.lesson_id===l.id&&!included.has(e.id));return `<p>${esc(l.start_at)}：${sign(l.summary.net)} → ${sign(summarize(remaining).net)}</p>`;}).join('')}<p class="err">当前存在重叠，以上变更不会保存。</p></div>`);
    const circle=document.querySelector(`[data-lesson="${s.selected.id}"] .lesson-circle`);
    if(circle)circle.textContent=sign(data.summary.net);
    $('#lesson-save').disabled=!verified||!data.can_save||s.busy||!!drag;
    $('#lesson-split').disabled=s.dirty||s.busy;$('#lesson-merge').disabled=s.dirty||s.busy;
    renderRecordList(included);
  }
  let previewVersion=0,previewTimer=null,drag=null,pan=null;
  async function preview() {
    if(!s.editing||!s.selected||!$('#lesson-start'))return;
    const version=++previewVersion,lid=s.selected.id;
    const start=$('#lesson-start').value,end=$('#lesson-end').value;
    $('#lesson-save').disabled=true;
    try {
      const data=await api(`/api/lessons/${lid}/preview`,{method:'POST',body:{start_at:start,end_at:end}});
      if(version!==previewVersion||!s.editing||s.selected?.id!==lid||start!==$('#lesson-start').value||end!==$('#lesson-end').value)return;
      s.preview=data;renderPreview(data,true);
    }catch(e){if(version===previewVersion&&s.editing){s.preview=null;$('#lesson-preview').textContent=e.message;}}
  }
  function updateDraft() {
    s.dirty=true;previewVersion++;s.preview=null;placeBoundaries();
    const data=localPreview();
    if(data)renderPreview(data,false);else{$('#lesson-save').disabled=true;$('#lesson-preview').textContent='结束时间须晚于开始时间';}
    clearTimeout(previewTimer);previewTimer=setTimeout(preview,120);
  }
  function eventDetail(id) {
    const e=s.records.find(e=>String(e.id)===String(id));if(!e)return;
    const valid=!e.voided_at&&!e.observed_only;
    $('#lesson-event-detail').innerHTML=`<div class="lesson-event-card"><strong>${esc(e.group_name||'小组#'+e.group_id)} · ${sign(e.delta)}分</strong><p>${esc(e.occurred_at)}（北京时间）</p><p>${e.observed_only?'历史状态痕迹，不计分':e.voided_at?'已撤销，不计分':e.batch_id?'全班记分批次中的一条':'单组记分'}${e.reason?' · '+esc(e.reason):''}</p>${valid?`<button class="history-undo" type="button" data-undo-entry="${e.id}">撤销这条记分</button>`:''}</div>`;
  }
  async function mutate(path, body, method = 'POST') {
    if (s.busy) return;
    s.busy = true; $('#lessons-error').textContent = '';
    if ($('#lesson-save')) $('#lesson-save').disabled = true;
    try {
      const result = await api(path, { method, body });
      s.editing = false; s.dirty = false;
      await load(result.id || result.ids?.[0] || s.selected?.id);
      return true;
    } catch (e) {
      $('#lessons-error').textContent = e.message;
      if (s.editing) await preview();
      return false;
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
    const keepEditing=s.editing;
    s.editing = false; s.dirty = false; await load(null);
    if(keepEditing)await edit();
  });
  async function selectLesson(id) {
    if(s.busy||(s.dirty&&!confirm('放弃尚未保存的课堂调整？')))return;
    const keepEditing=s.editing;
    s.request++;previewVersion++;s.selected=s.list.find(l=>l.id===id)||null;s.dirty=false;s.preview=null;
    $('#lessons-circles').querySelectorAll('[data-lesson]').forEach(el=>{
      const l=s.list.find(l=>l.id===Number(el.dataset.lesson));
      const on=l?.id===s.selected?.id;
      el.classList.toggle('on',on);el.setAttribute('aria-pressed',String(on));
      if(l)el.querySelector('.lesson-circle').textContent=sign(l.summary.net);
    });
    renderDetail();
    if(keepEditing){await records(true);if(s.selected)await preview();}
  }
  $('#lesson-edit').addEventListener('click',edit);
  $('#lessons-circles').addEventListener('click',e=>{
    const button=e.target.closest('[data-lesson]');
    if(button)void selectLesson(Number(button.dataset.lesson));
  });
  $('#lesson-detail').addEventListener('click', async e => {
    const undoButton = e.target.closest('[data-undo-entry]');
    if (undoButton) {
      if (s.busy) return;
      const entry = s.records.find(r => r.id === Number(undoButton.dataset.undoEntry));
      if (!entry || entry.voided_at || entry.observed_only) return;
      if (s.dirty && !confirm('撤销记分会放弃尚未保存的边界调整，是否继续？')) return;
      const selectedId = s.selected?.id;
      s.busy = true;
      try {
        const ok = await undoHistoryRecord(entry.transaction_id, `${entry.occurred_at} · ${entry.group_name || '小组'} · ${sign(entry.delta)}分`, !!entry.batch_id);
        if (ok) {
          s.editing = false; s.dirty = false;
          await load(selectedId);
          s.busy = false; await edit();
        }
      } finally { s.busy = false; }
      return;
    }
    const eventNode=e.target.closest('[data-timeline-event]');
    if(eventNode)return eventDetail(eventNode.dataset.timelineEvent);
    const windowNode=e.target.closest('[data-lesson-window]');
    if(windowNode)return selectLesson(Number(windowNode.dataset.lessonWindow));
    if(e.target.closest('#lesson-locate'))return locateCurrent();
    if (e.target.closest('#lesson-save')) {
      if (!s.preview?.can_save || !confirm('确认保存课堂边界和记录归属？原始积分保持不变。')) return;
      return mutate('/api/lessons/' + s.selected.id, { revision: s.selected.revision, start_at: $('#lesson-start').value, end_at: $('#lesson-end').value, status: $('#lesson-status').value }, 'PUT');
    }
    if (e.target.closest('#lesson-split')) {
      s.splitTarget={...s.selected};
      const midpoint=Math.floor((milliseconds(s.selected.start_at)+milliseconds(s.selected.end_at))/2000)*1000;
      $('#lesson-split-at').value=local(stamp(midpoint));
      $('#lesson-split-error').textContent='';
      $('#lesson-split-modal').classList.remove('hidden');
      splitPreview();$('#lesson-split-at').focus();return;
    }
    if (e.target.closest('#lesson-merge')) {
      const index = s.list.findIndex(l => l.id === s.selected.id), next = s.list[index + 1];
      if (!next) { $('#lessons-error').textContent = '本月没有下一节课堂'; return; }
      if (!confirm(`合并至 ${next.end_at}？两节之间的有效记录也会归入合并后的课堂。`)) return;
      return mutate('/api/lessons/' + s.selected.id + '/merge', { revision: s.selected.revision, other_id: next.id, other_revision: next.revision });
    }
  });
  $('#lesson-detail').addEventListener('change',async e=>{
    if(e.target.id==='lesson-window-select')return selectLesson(Number(e.target.value));
    if(e.target.id==='lesson-zoom') {
      s.scale=Number(e.target.value);timeline();locateCurrent();return;
    }
    if(!['lesson-start','lesson-end','lesson-status'].includes(e.target.id))return;
    if(e.target.id!=='lesson-status'){
      const [start,end]=axisRange();
      if(start!==s.dayStart||end!==s.dayEnd)await records();
    }
    updateDraft();
  });
  $('#lesson-detail').addEventListener('pointerdown',e=>{
    const boundary=e.target.closest('[data-boundary]');
    if(boundary&&!s.busy){
      drag={kind:boundary.dataset.boundary,x:e.clientX,value:milliseconds($('#lesson-'+boundary.dataset.boundary).value),scroll:$('#lesson-timeline-scroll').scrollLeft};
      boundary.setPointerCapture(e.pointerId);e.preventDefault();return;
    }
    if(e.pointerType==='mouse'&&e.target.closest('#lesson-timeline')&&!e.target.closest('button')){
      const scroller=$('#lesson-timeline-scroll');
      pan={x:e.clientX,scroll:scroller.scrollLeft};
      scroller.setPointerCapture(e.pointerId);scroller.classList.add('panning');e.preventDefault();
    }
  });
  $('#lesson-detail').addEventListener('pointermove',e=>{
    const scroller=$('#lesson-timeline-scroll');
    if(pan){scroller.scrollLeft=pan.scroll-(e.clientX-pan.x);return;}
    if(!drag)return;
    const rect=scroller.getBoundingClientRect();
    if(e.clientX>rect.right-25)scroller.scrollLeft+=12;
    if(e.clientX<rect.left+25)scroller.scrollLeft-=12;
    const seconds=Math.round((e.clientX-drag.x+scroller.scrollLeft-drag.scroll)/s.scale*60);
    const value=Math.max(milliseconds(s.dayStart),Math.min(milliseconds(s.dayEnd),drag.value+seconds*1000));
    $('#lesson-'+drag.kind).value=local(stamp(value));
    updateDraft();
  });
  for(const event of ['pointerup','pointercancel'])$('#lesson-detail').addEventListener(event,()=>{
    if(pan){pan=null;$('#lesson-timeline-scroll')?.classList.remove('panning');}
    if(!drag)return;
    drag=null;clearTimeout(previewTimer);void preview();
  });
  $('#lesson-detail').addEventListener('keydown',e=>{
    const boundary=e.target.closest('[data-boundary]');
    if(!boundary||!['ArrowLeft','ArrowRight'].includes(e.key))return;
    e.preventDefault();const input=$('#lesson-'+boundary.dataset.boundary);
    const value=Math.max(milliseconds(s.dayStart),Math.min(milliseconds(s.dayEnd),milliseconds(input.value)+(e.key==='ArrowLeft'?-60000:60000)));
    input.value=local(stamp(value));updateDraft();
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
  function splitPreview() {
    const row=s.splitTarget,value=$('#lesson-split-at').value;
    if(!row||!value)return;
    const cut=milliseconds(value),a=milliseconds(row.start_at),b=milliseconds(row.end_at);
    if(!(a<cut&&cut<b)){$('#lesson-split-preview').textContent='请选择课堂内部的时间';return;}
    const first=summarize(s.records.filter(e=>milliseconds(e.occurred_at)>=a&&milliseconds(e.occurred_at)<cut));
    const second=summarize(s.records.filter(e=>milliseconds(e.occurred_at)>=cut&&milliseconds(e.occurred_at)<b));
    $('#lesson-split-preview').textContent='拆分后：第一节 '+sign(first.net)+' 分，第二节 '+sign(second.net)+' 分';
  }
  function closeSplit(){if(!s.busy)$('#lesson-split-modal').classList.add('hidden');}
  $('#lesson-split-at').addEventListener('input',splitPreview);
  $('#lesson-split-close').addEventListener('click',closeSplit);
  $('#lesson-split-cancel').addEventListener('click',closeSplit);
  $('#lesson-split-form').addEventListener('submit',async e=>{
    e.preventDefault();if(s.busy||!s.splitTarget)return;
    const row=s.splitTarget,at=$('#lesson-split-at').value;
    const ok=await mutate('/api/lessons/'+row.id+'/split',{at,revision:row.revision});
    if(ok)$('#lesson-split-modal').classList.add('hidden');
    else $('#lesson-split-error').textContent=$('#lessons-error').textContent||'拆分未保存，请重试';
  });
  function clearSession() {
    s.request++; s.editing = false; s.dirty = false; s.list = []; s.selected = null; s.splitTarget=null;
    for (const id of ['lessons-modal','lesson-form-modal','lesson-settings-modal','lesson-split-modal']) $('#' + id).classList.add('hidden');
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
    if (!$('#lesson-split-modal').classList.contains('hidden')) return closeSplit();
    if (!$('#lesson-form-modal').classList.contains('hidden')) return closeForm();
    if (!$('#lesson-settings-modal').classList.contains('hidden')) return $('#lesson-settings-modal').classList.add('hidden');
    close();
  });
})();
