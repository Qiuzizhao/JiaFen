(() => {
  const s = { list: [], selected: null, editing: false, records: [], preview: null, request: 0, busy: false, dirty: false, pending: false, scale: 3, recordFilter: 'all', showIgnored: false, context: null };
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
    if (!$('#lessons-class').value) { s.list=[]; s.selected=null; s.overview=null; renderOverview(); renderCircles({}); renderDetail(); return; }
    const version = ++s.request;
    const context={classId:$('#lessons-class').value,month:$('#lessons-month').value};
    if(s.context?.classId!==context.classId||s.context?.month!==context.month){
      s.list=[];s.selected=null;s.records=[];s.preview=null;s.overview=null;
      $('#lessons-overview').textContent='正在读取课堂…';
      $('#lesson-detail').innerHTML='';
    }
    try {
      const data = await api(`/api/classes/${$('#lessons-class').value}/lessons?month=${$('#lessons-month').value}`);
      if (version !== s.request || !visible()) return;
      s.list = data.lessons;
      s.selected = s.list.find(l => l.id === selected) || s.list.at(-1) || null;
      s.pending = false;
      s.context=context;
      s.overview=data;renderOverview();
      $('#lessons-error').textContent = '';
      renderCircles(data);
      renderDetail();
      return true;
    } catch (e) { if (version === s.request) { $('#lessons-error').textContent = e.message; renderOverview(); renderCircles({}); renderDetail(); } }
  }
  function renderOverview() {
    const counts={recognized:0,review:0,unknown:0};
    s.list.forEach(l=>counts[l.status]++);
    $('#lessons-overview').innerHTML=`<span>已识别 <b>${counts.recognized}</b> 节</span>${counts.review?`<span class="lesson-quality-review">待校正 <b>${counts.review}</b> 节</span>`:''}${counts.unknown?`<span>未知 <b>${counts.unknown}</b> 节</span>`:''}${s.overview?.unassigned?`<button type="button" data-review-unassigned class="lesson-quality-review">${s.overview.unassigned} 条待归属 <span aria-hidden="true">→</span></button>`:''}<button type="button" id="lessons-refresh" class="lesson-refresh" title="刷新当前记录">刷新</button>`;
  }
  function titleOf(l) {
    const number=s.list.filter(row=>row.start_at.slice(0,10)===l.start_at.slice(0,10)).findIndex(row=>row.id===l.id)+1;
    return `${Number(l.start_at.slice(5,7))}月${Number(l.start_at.slice(8,10))}日 · 第${number}节`;
  }
  function renderCircles(data) {
    const ordinal = new Map();
    $('#lessons-circles').innerHTML = '<div class="lesson-circle-row">' + s.list.map(l => {
      const day=l.start_at.slice(0,10),n=(ordinal.get(day)||0)+1;ordinal.set(day,n);
      return `<button type="button" class="lesson-circle-item ${s.selected?.id===l.id?'on':''} ${l.status} ${l.summary.net<0?'negative':l.summary.net===0?'zero':''}" data-lesson="${l.id}" aria-pressed="${s.selected?.id===l.id}" aria-label="${esc(titleOf(l))}，净积分${sign(l.summary.net)}，${statusName[l.status]}" title="${esc(l.start_at)} — ${esc(l.end_at)}"><span class="lesson-circle">${sign(l.summary.net)}</span><strong>${day.slice(5).replace('-','/')}</strong><small>第${n}节 · ${statusName[l.status]}</small></button>`;
    }).join('')+'</div>';
    if(!s.list.length)$('#lessons-circles').innerHTML='<div class="lesson-empty"><strong>这个月还没有课堂记录</strong><p>选择其他月份，或补建一堂没有记分的课堂。</p><button class="ghost" type="button" data-empty-create>补建课堂</button></div>';
  }
  function stats(summary) {
    return `<div class="lesson-stats"><span class="lesson-stat-net">净积分 <b>${sign(summary.net)}</b></span><span>加分 <b class="lesson-positive">${summary.positive?'+'+summary.positive:'0'}</b></span><span>扣分 <b class="lesson-negative">${summary.negative}</b></span></div>`;
  }
  function groupTable(summary) {
    return `<div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>小组</th><th>加分</th><th>扣分</th><th>净积分</th></tr></thead><tbody>${summary.groups.map(g=>`<tr><td>${esc(g.name)}</td><td class="lesson-numeric">${g.positive?'+'+g.positive:'0'}</td><td class="lesson-numeric">${g.negative}</td><td class="lesson-numeric lesson-net-cell ${g.net>0?'positive':g.net<0?'negative':''}">${sign(g.net)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function groupChanges(data) {
    const before=new Map(data.before.groups.map(g=>[g.group_id,g]));
    const after=new Map(data.summary.groups.map(g=>[g.group_id,g]));
    const ids=[...new Set([...before.keys(),...after.keys()])];
    return `<div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>小组</th><th>调整前</th><th>调整后</th><th>变化</th></tr></thead><tbody>${ids.map(id=>{
      const a=before.get(id)?.net||0,b=after.get(id)?.net||0,change=b-a;
      return `<tr><td>${esc((after.get(id)||before.get(id)).name)}</td><td class="lesson-numeric">${sign(a)}</td><td class="lesson-numeric">${sign(b)}</td><td class="lesson-numeric lesson-net-cell ${change>0?'positive':change<0?'negative':''}">${sign(change)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function workflow(data=s.preview,verified=true) {
    $('#lesson-workflow-bar').hidden=!s.editing;
    const ready=Boolean(s.selected&&data&&verified&&data.can_save&&!s.busy&&s.dirty&&!drag);
    $('#lesson-save').disabled=!ready;
    $('#lesson-revert').disabled=!s.dirty||s.busy;
    $('#lesson-split').disabled=!s.selected||s.dirty||s.busy;
    $('#lesson-merge').disabled=!s.selected||s.dirty||s.busy;
    $('#lessons-new').disabled=s.busy||s.dirty||!$('#lessons-class').value;
    $('#lessons-new').title=s.dirty?'请先保存或取消当前调整':'';
    const note=!s.selected?'选择一堂课以编辑边界':s.busy?'正在保存…':!s.dirty?'未修改':!verified?'正在核对…':!data?.can_save?'请先处理冲突':'有未保存的调整';
    const change=data&&s.dirty?`<b>${sign(data.before.net)}</b><span aria-hidden="true"> → </span><b>${sign(data.summary.net)}</b><small>净积分</small>`:'';
    $('#lesson-workflow-state').innerHTML=`<span class="${s.dirty?'unsaved':''}">${note}</span>${change}`;
  }
  function setBusy(value) {
    s.busy=value;
    for(const id of ['lessons-class','lessons-month','lessons-prev-month','lessons-next-month','lessons-current-month','lessons-settings'])$('#'+id).disabled=value;
    $('#lesson-edit').disabled=value||!$('#lessons-class').value;
    if(visible())workflow(s.preview,!value);
  }
  function renderDetail() {
    const l=s.selected;
    $('#lesson-edit').textContent=s.editing?'返回课堂':'编辑时间轴';
    $('#lessons-modal').classList.toggle('is-editing',s.editing);
    $('#lesson-edit').disabled=!$('#lessons-class').value;
    $('#lessons-circles').hidden=s.editing;
    workflow();
    if (!l && !s.editing) { $('#lesson-detail').innerHTML=''; return; }
    $('#lesson-detail').innerHTML = `
      ${l ? `<section class="lesson-detail-head"><div><h4>${titleOf(l)} <span class="lesson-status-badge ${l.status}">${statusName[l.status]}</span></h4><p>${esc(l.start_at.slice(11))} — ${esc(l.end_at.slice(0,10)===l.start_at.slice(0,10)?l.end_at.slice(11):l.end_at)} · 北京时间 · ${l.summary.count}条有效记分</p></div><div class="lesson-detail-nav"><button type="button" data-lesson-step="-1" aria-label="上一节课堂" ${s.list[0]?.id===l.id?'disabled':''}>‹</button><button type="button" data-lesson-step="1" aria-label="下一节课堂" ${s.list.at(-1)?.id===l.id?'disabled':''}>›</button>${l.status!=='recognized'&&!s.editing?'<button type="button" class="ghost" id="lesson-confirm-status">确认课堂</button>':''}</div></section>${l.note&&!s.editing?`<details class="lesson-source-details"><summary>记录说明</summary><p>${esc(l.note)}</p></details>`:''}${!s.editing?stats(l.summary):''}` : ''}
      <div id="lesson-normal-summary" ${s.editing?'hidden':''}>${l?groupTable(l.summary):''}</div>
      <section id="lesson-editor" ${s.editing?'':'hidden'}>
        <div class="timeline-toolbar"><span>${esc($('#lessons-month').value)} · 完整积分时间轴</span><select id="lesson-window-select" aria-label="选择要编辑的课堂"><option value="">查看全部记录</option>${s.list.map(row=>`<option value="${row.id}" ${row.id===l?.id?'selected':''}>${esc(row.start_at.slice(5,16))} · 净分${sign(row.summary.net)}</option>`).join('')}</select><label>缩放 <select id="lesson-zoom" aria-label="时间轴缩放">${[[0.1,'远景'],[0.5,'概览'],[3,'标准'],[8,'近景'],[120,'秒级']].map(([v,n])=>`<option value="${v}" ${s.scale===v?'selected':''}>${n}</option>`).join('')}</select></label><button id="lesson-locate" class="ghost" type="button">定位课堂</button></div>
        <div class="lesson-axis-legend"><span class="positive">● 加分</span><span class="negative">● 扣分</span><label><input id="lesson-show-ignored" type="checkbox" ${s.showIgnored?'checked':''}> 已撤销及历史痕迹</label><span id="lesson-visible-range"></span></div>
        <div id="lesson-timeline-scroll" class="lesson-timeline-scroll"><div id="lesson-timeline"></div></div>
        <p class="lesson-axis-hint">左右拖动查看记录 · 点击分值查看详情${l?' · 拖动绿色边界调整归属':''}</p>
        <div id="lesson-event-detail" aria-live="polite"></div>
        ${l ? `<details class="lesson-precision"><summary>精确调整时间与状态</summary><div class="lesson-edit-controls"><label>开始<input id="lesson-start" type="datetime-local" step="1" value="${local(l.start_at)}"></label><label>结束<input id="lesson-end" type="datetime-local" step="1" value="${local(l.end_at)}"></label><select id="lesson-status" aria-label="课堂状态">${Object.entries(statusName).map(([v,n])=>`<option value="${v}" ${v===l.status?'selected':''}>${n}</option>`).join('')}</select></div></details>` : '<p class="lesson-notice">可先查看未归属记录，点击“补建课堂”建立时间窗口。</p>'}
        <div id="lesson-preview" aria-live="polite"></div>
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
    for(const e of s.records.filter(e=>s.showIgnored||(!e.voided_at&&!e.observed_only))) {
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
    $('#lesson-timeline-scroll').addEventListener('scroll',updateVisibleRange,{passive:true});
    updateVisibleRange();
    $('#lesson-timeline-scroll').scrollTop=Math.max(0,axisY-230);
  }
  function updateVisibleRange() {
    const scroller=$('#lesson-timeline-scroll'),label=$('#lesson-visible-range');
    if(!scroller||!label||!s.dayStart)return;
    const start=milliseconds(s.dayStart)+scroller.scrollLeft/s.scale*60000;
    const end=Math.min(milliseconds(s.dayEnd),start+scroller.clientWidth/s.scale*60000);
    label.textContent=stamp(start).slice(5,16)+' — '+stamp(end).slice(5,16);
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
  function renderRecordList(included=new Set(s.preview?.entries.map(e=>e.id)||[])) {
    const previousOpen=$('#lesson-records-details')?.open||false;
    const filter=s.recordFilter;
    const rows=s.records.filter(e=>filter==='all'||filter==='effective'&& !e.voided_at&&!e.observed_only||filter==='unassigned'&&!e.lesson_id&&!e.voided_at&&!e.observed_only||filter==='selected'&&included.has(e.id)||filter==='ignored'&&(e.voided_at||e.observed_only));
    $('#lesson-records').innerHTML=`<details id="lesson-records-details" class="lesson-records-details" ${previousOpen?'open':''}><summary>查看完整记分记录 <span>${s.records.length}条</span></summary><div class="lesson-records-tools"><label>显示 <select id="lesson-record-filter" aria-label="筛选积分记录">${[['all','全部记录'],['effective','有效记分'],['selected','当前课堂'],['unassigned','待归属'],['ignored','已撤销及历史痕迹']].map(([v,n])=>`<option value="${v}" ${filter===v?'selected':''}>${n}</option>`).join('')}</select></label><span>${rows.length}条</span></div><div class="lesson-table-wrap"><table class="lesson-table"><thead><tr><th>发生时间</th><th>小组</th><th>分值</th><th>归属预览</th><th></th></tr></thead><tbody>${rows.map(e=>`<tr class="${e.observed_only?'observed':e.voided_at?'voided':''}"><td>${esc(e.occurred_at)}</td><td>${esc(e.group_name||'小组#'+e.group_id)}</td><td>${sign(e.delta)}</td><td>${e.observed_only?'历史状态痕迹，不计分':e.voided_at?'已撤销，不计分':included.has(e.id)?'当前课堂':e.lesson_id?'其他课堂':'待归属'}</td><td>${!e.voided_at&&!e.observed_only?`<button type="button" class="history-undo" data-undo-entry="${e.id}">撤销</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">当前筛选下没有记录。</td></tr>'}</tbody></table></div></details>`;
  }
  function renderPreview(data,verified=false) {
    const included=new Set(data.entries.map(e=>e.id));
    $('#lesson-preview').innerHTML=`<div class="lesson-preview-net">调整前 <b>${sign(data.before.net)}</b><span>→</span>调整后 <b>${sign(data.summary.net)}</b></div><div class="lesson-preview-breakdown">加分 ${sign(data.summary.positive)} · 扣分 ${data.summary.negative} · ${data.summary.count}条有效记分</div>`+
      (data.conflicts.length?'<p class="err">与其他课堂时间重叠，不能保存或重复归属。</p>':'')+
      (data.split_batches.length?'<p class="err">边界拆分了全班记分批次，请调整。</p>':'')+
      `<details class="lesson-preview-groups"><summary>查看各组变化</summary>${groupChanges(data)}</details>`;
    const affected=s.list.filter(l=>l.id!==s.selected.id&&s.records.some(e=>e.lesson_id===l.id&&included.has(e.id)&&!e.voided_at&&!e.observed_only));
    if(affected.length)$('#lesson-preview').insertAdjacentHTML('beforeend',`<div class="lesson-affected"><h4>其他课堂影响预览</h4>${affected.map(l=>{const remaining=s.records.filter(e=>e.lesson_id===l.id&&!included.has(e.id));return `<p>${esc(l.start_at)}：${sign(l.summary.net)} → ${sign(summarize(remaining).net)}</p>`;}).join('')}<p class="err">当前存在重叠，以上变更不会保存。</p></div>`);
    const circle=document.querySelector(`[data-lesson="${s.selected.id}"] .lesson-circle`);
    if(circle)circle.textContent=sign(data.summary.net);
    workflow(data,verified);
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
    }catch(e){if(version===previewVersion&&s.editing){s.preview=null;$('#lesson-preview').textContent=e.message;workflow(null,true);$('#lesson-workflow-state').textContent='核对失败，请调整时间后重试';}}
  }
  function updateDraft() {
    s.dirty=Boolean(s.selected&&(milliseconds($('#lesson-start').value)!==milliseconds(s.selected.start_at)||milliseconds($('#lesson-end').value)!==milliseconds(s.selected.end_at)||$('#lesson-status').value!==s.selected.status));
    previewVersion++;s.preview=null;placeBoundaries();
    const data=localPreview();
    if(data)renderPreview(data,false);else{workflow(null,true);$('#lesson-preview').textContent='结束时间须晚于开始时间';}
    clearTimeout(previewTimer);previewTimer=setTimeout(preview,120);
  }
  function eventDetail(id) {
    const e=s.records.find(e=>String(e.id)===String(id));if(!e)return;
    const valid=!e.voided_at&&!e.observed_only;
    $('#lesson-event-detail').innerHTML=`<div class="lesson-event-card"><button type="button" class="icon-btn lesson-event-close" aria-label="关闭记录详情">✕</button><strong>${esc(e.group_name||'小组#'+e.group_id)} · ${sign(e.delta)}分</strong><p>${esc(e.occurred_at)}（北京时间）</p><p>${e.observed_only?'历史状态痕迹，不计分':e.voided_at?'已撤销，不计分':e.batch_id?'全班记分批次中的一条':'单组记分'}${e.reason?' · '+esc(e.reason):''}</p>${valid?`<button class="history-undo" type="button" data-undo-entry="${e.id}">撤销这条记分</button>`:''}</div>`;
  }
  async function mutate(path, body, method = 'POST') {
    if (s.busy) return;
    setBusy(true); $('#lessons-error').textContent = '';
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
    } finally { setBusy(false); }
  }
  $('#btn-lessons').addEventListener('click', async () => {
    closeBackupMenu();
    s.ownerId = state.user?.id;
    $('#lessons-class').innerHTML = state.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#lessons-class').value = String(state.currentClassId || state.classes[0]?.id || '');
    $('#lessons-month').value = s.context?.month || beijingMonth();
    s.editing = false; s.dirty = false;
    $('#lessons-modal').classList.remove('hidden');
    await load(null); $('#lessons-close').focus();
  });
  $('#lessons-close').addEventListener('click', close);
  $('#lessons-modal').addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
  async function changeContext() {
    const restore=()=>{if(s.context){$('#lessons-class').value=s.context.classId;$('#lessons-month').value=s.context.month;}};
    if(s.busy||!$('#lessons-month').value){restore();return;}
    if(s.dirty&&!confirm('切换后将放弃尚未保存的调整，是否继续？')){restore();return;}
    const keepEditing=s.editing;
    s.editing=false;s.dirty=false;s.preview=null;previewVersion++;
    $('#lessons-circles').innerHTML='<div class="empty">正在读取课堂…</div>';
    $('#lesson-detail').innerHTML='';$('#lesson-workflow-bar').hidden=true;
    const loaded=await load(null);
    if(loaded&&keepEditing)await edit();
  }
  for(const id of ['lessons-class','lessons-month'])$('#'+id).addEventListener('change',changeContext);
  function shiftMonth(offset) {
    const [year,month]=$('#lessons-month').value.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1+offset,1));
    if(date.getUTCFullYear()<1900||date.getUTCFullYear()>9998)return;
    $('#lessons-month').value=date.getUTCFullYear()+'-'+String(date.getUTCMonth()+1).padStart(2,'0');
    void changeContext();
  }
  $('#lessons-prev-month').addEventListener('click',()=>shiftMonth(-1));
  $('#lessons-next-month').addEventListener('click',()=>shiftMonth(1));
  $('#lessons-current-month').addEventListener('click',()=>{$('#lessons-month').value=beijingMonth();void changeContext();});
  async function reloadView(discard=false) {
    if(s.busy)return;
    if(s.dirty&&!discard&&!confirm('刷新后将放弃尚未保存的调整，是否继续？'))return;
    const id=s.selected?.id,keepEditing=s.editing;
    s.editing=false;s.dirty=false;s.preview=null;previewVersion++;
    const loaded=await load(id);
    if(loaded&&keepEditing)await edit();
  }
  $('#lessons-overview').addEventListener('click',async e=>{
    if(e.target.closest('#lessons-refresh'))return reloadView();
    if(e.target.closest('[data-review-unassigned]')){
      if(!s.editing)await edit();
      s.recordFilter='unassigned';renderRecordList();
      $('#lesson-records-details').open=true;$('#lesson-records-details').scrollIntoView({block:'nearest',behavior:'smooth'});
    }
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
    if(e.target.closest('[data-empty-create]'))$('#lessons-new').click();
  });
  async function handleLessonAction(e) {
    const undoButton = e.target.closest('[data-undo-entry]');
    if (undoButton) {
      if (s.busy) return;
      const entry = s.records.find(r => r.id === Number(undoButton.dataset.undoEntry));
      if (!entry || entry.voided_at || entry.observed_only) return;
      if (s.dirty && !confirm('撤销记分会放弃尚未保存的边界调整，是否继续？')) return;
      const selectedId = s.selected?.id;
      setBusy(true);
      try {
        const ok = await undoHistoryRecord(entry.transaction_id, `${entry.occurred_at} · ${entry.group_name || '小组'} · ${sign(entry.delta)}分`, !!entry.batch_id);
        if (ok) {
          s.editing = false; s.dirty = false;
          await load(selectedId);
          setBusy(false); await edit();
        }
      } finally { setBusy(false); }
      return;
    }
    if(e.target.closest('.lesson-event-close')){$('#lesson-event-detail').innerHTML='';return;}
    const eventNode=e.target.closest('[data-timeline-event]');
    if(eventNode)return eventDetail(eventNode.dataset.timelineEvent);
    const windowNode=e.target.closest('[data-lesson-window]');
    if(windowNode)return selectLesson(Number(windowNode.dataset.lessonWindow));
    if(e.target.closest('#lesson-locate'))return locateCurrent();
    if (e.target.closest('#lesson-save')) {
      if (!s.preview?.can_save || !s.dirty) return;
      return mutate('/api/lessons/' + s.selected.id, { revision: s.selected.revision, start_at: $('#lesson-start').value, end_at: $('#lesson-end').value, status: $('#lesson-status').value }, 'PUT');
    }
    if(e.target.closest('#lesson-revert'))return reloadView(true);
    const step=e.target.closest('[data-lesson-step]');
    if(step){const index=s.list.findIndex(l=>l.id===s.selected?.id);const target=s.list[index+Number(step.dataset.lessonStep)];if(target)return selectLesson(target.id);}
    if(e.target.closest('#lesson-confirm-status')) {
      if(!confirm('确认这是一节实际课堂？确认后将纳入课均统计。'))return;
      return mutate('/api/lessons/'+s.selected.id,{revision:s.selected.revision,start_at:s.selected.start_at,end_at:s.selected.end_at,status:'recognized'},'PUT');
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
  }
  $('#lesson-detail').addEventListener('click',handleLessonAction);
  $('#lesson-workflow-bar').addEventListener('click',handleLessonAction);
  $('#lesson-workflow-bar').addEventListener('click',e=>{if(e.target.closest('.lesson-more-actions button'))$('.lesson-more-actions').open=false;});
  document.addEventListener('click',e=>{if(!e.target.closest('.lesson-more-actions'))$('.lesson-more-actions').open=false;});
  $('#lesson-detail').addEventListener('change',async e=>{
    if(e.target.id==='lesson-window-select')return selectLesson(Number(e.target.value));
    if(e.target.id==='lesson-record-filter'){s.recordFilter=e.target.value;renderRecordList();$('#lesson-records-details').open=true;return;}
    if(e.target.id==='lesson-show-ignored'){s.showIgnored=e.target.checked;timeline();locateCurrent();return;}
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
      workflow(s.preview,true);boundary.setPointerCapture(e.pointerId);e.preventDefault();return;
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
    e.preventDefault(); if (s.busy) return; setBusy(true);
    try {
      const result = await api(`/api/classes/${$('#lessons-class').value}/lessons`, { method: 'POST', body: { start_at: $('#lesson-form-start').value, end_at: $('#lesson-form-end').value } });
      $('#lessons-month').value = $('#lesson-form-start').value.slice(0,7);
      $('#lesson-form-modal').classList.add('hidden'); s.editing = false; s.dirty = false;
      await load(result.id);
    } catch (e) { $('#lesson-form-error').textContent = e.message; }
    finally { setBusy(false); }
  });
  $('#lessons-settings').addEventListener('click', async () => {
    try {
      const data = await api('/api/lessons/settings'); $('#lesson-window').value = data.window_minutes;
      $('#lesson-settings-error').textContent = ''; $('#lesson-settings-modal').classList.remove('hidden');
    } catch (e) { $('#lessons-error').textContent = e.message; }
  });
  $('#lesson-settings-cancel').addEventListener('click', () => $('#lesson-settings-modal').classList.add('hidden'));
  $('#lesson-settings-form').addEventListener('submit', async e => {
    e.preventDefault(); if (s.busy) return; setBusy(true);
    try {
      await api('/api/lessons/settings', { method: 'PUT', body: { window_minutes: Number($('#lesson-window').value) } });
      $('#lesson-settings-modal').classList.add('hidden');
    } catch (e) { $('#lesson-settings-error').textContent = e.message; }
    finally { setBusy(false); }
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
    s.request++; s.editing = false; s.dirty = false; s.list = []; s.selected = null; s.splitTarget=null;s.context=null;s.overview=null;
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
    if(e.key==='Tab'&&visible()) {
      const active=['lesson-split-modal','lesson-settings-modal','lesson-form-modal','lessons-modal'].map(id=>$('#'+id)).find(el=>!el.classList.contains('hidden'));
      const items=[...active.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=items[0],last=items.at(-1);
      if(e.shiftKey&&(document.activeElement===first||!active.contains(document.activeElement))){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&(document.activeElement===last||!active.contains(document.activeElement))){e.preventDefault();first?.focus();}
    }
    if (e.key !== 'Escape' || !visible()) return;
    if (!$('#lesson-split-modal').classList.contains('hidden')) return closeSplit();
    if (!$('#lesson-form-modal').classList.contains('hidden')) return closeForm();
    if (!$('#lesson-settings-modal').classList.contains('hidden')) return $('#lesson-settings-modal').classList.add('hidden');
    close();
  });
})();
