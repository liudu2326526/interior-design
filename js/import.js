/* 图纸上传、预览与自动复核。
 * 依赖 App.core、App.store、App.geom、App.plan、App.draw2d、App.io、App.assistant、App.projects。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 图纸上传与结果预览 ======================= */
  // 上传完成即登记项目。项目列表负责在后台查询识别进度与保存结果。
  const IMP_MAX_BYTES = 25 * 1024 * 1024;    // 服务端上限 40 MiB，给 base64 留余量
  const IMP_MAX_FILES = 20;
  const IMP_UPLOAD_TIMEOUT = 5 * 60_000;
  const impState = {files:[], result:null, onApply:null, retryId:null, submission:null, applying:false,
    review:null, reviewJobId:null, reviewState:null, reviewMode:'preview', reviewRowId:null, reviewSceneKey:null,
    reviewVariant:'fixed', reviewBase:null, reviewApplied:false, reviewTimer:0,
    reviewRerun:true, reviewGen:0, reviewLastActiveAt:0};
  const impEls = {};

  const impSize = n => n >= 1048576 ? (n/1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n/1024) + ' KB' : n + ' B';

  function impStatus(text, pct = null){
    impEls.st.textContent = text;
    impEls.bar.classList.toggle('indet', pct === null);
    if (pct === null){
      impEls.bar.removeAttribute('aria-valuenow');
      impEls.bar.firstElementChild.style.width = '';
    } else {
      impEls.bar.setAttribute('aria-valuenow', String(pct));
      impEls.bar.firstElementChild.style.width = pct + '%';
    }
  }

  function impShow(view){
    impEls.pick.hidden = view !== 'pick';
    impEls.prog.hidden = view !== 'prog';
    impEls.body.hidden = view !== 'preview';
  }

  function impShowDialog(view){
    impShow(view);
    impEls.wrap.classList.add('on');
    impEls.wrap.setAttribute('aria-hidden', 'false');
    impRelang();
  }

  function impErrShow(msg){
    impEls.err.textContent = msg;
    impEls.err.classList.toggle('on', Boolean(msg));
  }

  function impUploadReady(){
    impState.submission = null;
    impEls.cancel.disabled = false;
    impEls.close.disabled = false;
    impUpdateStart();
  }

  function impFail(msg){
    impUploadReady();
    impShow('pick');
    impErrShow(msg);
  }

  function impUpdateStart(){
    impEls.start.disabled = Boolean(impState.submission) || !impState.files.length;
    impEls.start.textContent = App.core.tr('上传并识别', 'Upload and analyze');
  }

  function impRenderFiles(){
    impEls.files.innerHTML = '';
    impState.files.forEach((f, i) => {
      const row = document.createElement('div'); row.className = 'imp-file';
      const name = document.createElement('span'); name.textContent = f.name; name.title = f.name;
      const size = document.createElement('small'); size.textContent = impSize(f.size);
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'imp-rm';
      rm.textContent = '×'; rm.title = App.core.tr('移除', 'Remove'); rm.setAttribute('aria-label', App.core.tr('移除', 'Remove'));
      rm.onclick = () => { impState.files.splice(i, 1); impRenderFiles(); };
      row.append(name, size, rm);
      impEls.files.appendChild(row);
    });
    impUpdateStart();
  }

  function impAddFiles(list){
    if (impState.submission) return;
    impErrShow('');
    let total = impState.files.reduce((a, f) => a + f.size, 0), tooBig = false, empty = false;
    for (const f of list || []){
      if (impState.files.length >= IMP_MAX_FILES) break;
      if (!f.size){ empty = true; continue; }
      if (total + f.size > IMP_MAX_BYTES){ tooBig = true; continue; }
      impState.files.push(f); total += f.size;
    }
    impRenderFiles();
    if (tooBig) impErrShow(App.core.tr('文件过大：一次最多约 25 MB。', 'Files too large: about 25 MB max per import.'));
    else if (empty) impErrShow(App.core.tr('选中的文件是空的。', 'The selected file is empty.'));
  }

  function impOpen({retryId, note} = {}){
    if (impState.submission || impState.applying) return false;
    const menu = App.core.$('#importPlanFile').closest('details');
    if (menu) menu.open = false;
    impState.files = []; impState.result = impState.onApply = null;
    impState.retryId = typeof retryId === 'string' ? retryId : null;
    impReviewReset();
    impEls.note.value = typeof note === 'string' ? note : '';
    impEls.file.value = '';
    impErrShow('');
    impRenderFiles();
    impShowDialog('pick');
    return true;
  }

  function impClose(){
    if (impState.applying || impState.submission?.jobId) return;
    if (impState.submission) impAbort();
    impViewClose();
    impState.files = []; impState.result = impState.onApply = impState.retryId = null;
    impReviewReset();
    impEls.wrap.classList.remove('on');
    impEls.wrap.setAttribute('aria-hidden', 'true');
  }

  function impAbort(){
    const submission = impState.submission;
    if (!submission || submission.jobId) return;
    impUploadReady();
    submission.xhr?.abort();
    impShow('pick');
    App.core.toast(App.core.tr('已取消上传', 'Upload cancelled'));
  }

  // File → base64（分块，避免展开运算符在大文件上爆栈）
  async function impFileB64(file){
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function impStart(){
    if (impState.submission || !impState.files.length) return;
    const submission = {xhr:null, jobId:null};
    impState.submission = submission;
    impErrShow('');
    impShow('prog');
    impUpdateStart();
    impStatus(App.core.tr('正在读取文件…', 'Reading files…'));

    const files = [];
    try {
      for (const f of impState.files){
        const data = await impFileB64(f);
        if (impState.submission !== submission) return;
        files.push({name:f.name, mime:f.type || 'application/octet-stream', data});
      }
    } catch(e){
      if (impState.submission === submission) impFail(App.core.tr('读取文件失败。', 'Could not read the file.'));
      return;
    }

    const xhr = new XMLHttpRequest();
    const note = impEls.note.value.trim();
    const retryId = impState.retryId;
    const name = files[0].name;
    submission.xhr = xhr;
    xhr.upload.onprogress = e => {
      if (impState.submission !== submission || !e.lengthComputable || !e.total) return;
      impStatus(App.core.tr('正在上传图纸…', 'Uploading the drawing…'), Math.round(e.loaded / e.total * 100));
    };
    xhr.upload.onload = () => {
      if (impState.submission === submission) impStatus(App.core.tr('正在提交识别任务…', 'Submitting the recognition job…'));
    };
    xhr.onload = async () => {
      if (impState.submission !== submission) return;
      if (xhr.status !== 202) return impFail(App.assistant.aiResponseMessage(xhr.status, xhr.responseText));
      let jobId;
      try { jobId = JSON.parse(xhr.responseText).id; } catch(e){}
      if (typeof jobId !== 'string' || !/^[\w-]{1,128}$/.test(jobId)){
        return impFail(App.core.tr('服务未返回任务编号。', 'The service did not return a job ID.'));
      }

      submission.jobId = jobId;
      impEls.cancel.disabled = true;
      impEls.close.disabled = true;
      impStatus(App.core.tr('正在保存项目记录…', 'Saving the project entry…'));
      let rowId;
      try {
        rowId = await App.projects.projectImportSubmitted({jobId, name, note, retryId});
      } catch(e){
        void fetch(App.core.studioPath('/api/jobs/' + jobId), {method:'DELETE', keepalive:true}).catch(() => {});
        return impFail(App.core.tr('无法保存项目记录。', 'Could not save the project entry.'));
      }
      impUploadReady();
      impClose();
      App.projects.openProjects(rowId);
    };
    xhr.onerror = () => {
      if (impState.submission !== submission) return;
      impFail(App.core.PUBLIC_ACCESS === 'owner'
        ? App.core.tr('无法连接公网服务，请重试。', 'Cannot reach the public service. Try again.')
        : App.core.tr('无法连接本机服务，请确认户型装修设计服务正在运行。', 'Cannot reach the local studio service. Make sure it is running.'));
    };
    xhr.ontimeout = () => {
      if (impState.submission === submission) impFail(App.core.tr('上传图纸超时，请重试。', 'Drawing upload timed out. Try again.'));
    };

    try {
      xhr.open('POST', App.projects.projectEndpoint);
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.timeout = IMP_UPLOAD_TIMEOUT;
      impStatus(App.core.tr('正在上传图纸…', 'Uploading the drawing…'), 0);
      xhr.send(JSON.stringify({files, note}));
    } catch(e){
      impFail(App.core.tr('无法提交图纸识别任务。', 'Could not submit the drawing job.'));
    }
  }

  function impOpenResult(data, onApply, meta = {}){
    if (impState.submission || impState.applying) return false;
    const result = App.plan.sanitizePlan(data?.plan);
    if (!result.ok){
      App.core.toast(App.core.tr('识别结果不是有效户型。', 'The result is not a valid floor plan.'));
      return false;
    }
    impState.result = {
      plan:result.plan,
      furniture:App.io.drawingFurniture(data.furniture),
      explanation:typeof data.explanation === 'string' ? data.explanation.trim() : '',
    };
    impState.onApply = onApply;
    impState.review = null;
    impState.reviewJobId = typeof meta.jobId === 'string' ? meta.jobId : null;
    impState.reviewState = typeof meta.reviewState === 'string' ? meta.reviewState : null;
    impState.reviewMode = meta.mode === 'project' ? 'project' : 'preview';
    impState.reviewRowId = typeof meta.rowId === 'string' ? meta.rowId : null;
    impState.reviewSceneKey = impState.reviewMode === 'project' ? meta.sceneKey ?? App.projects.activeSceneKey : null;
    impState.reviewVariant = 'fixed';
    impState.reviewBase = null;
    impState.reviewApplied = false;
    impErrShow('');
    impShowDialog('preview');
    impReviewStart();
    return true;
  }

  /* ---------- 自动复核（服务端契约：GET/POST /api/jobs/<id>/review） ---------- */
  const IMP_REVIEW_POLL = 5000;
  // 单次模型回合最长 60 分钟。仅在一直读不到有效状态或报告时停止轮询。
  const IMP_REVIEW_GIVEUP = 61 * 60_000;
  const IMP_REVIEW_STATES = ['pending', 'running', 'match', 'differ', 'unavailable'];
  const impReviewURL = jobId => App.core.studioPath('/api/jobs/' + encodeURIComponent(jobId) + '/review');

  function impReviewStop(){
    clearTimeout(impState.reviewTimer);
    impState.reviewTimer = 0;
    // 代次递增让在途请求的结果作废，避免旧轮询把新状态覆盖掉。
    impState.reviewGen++;
  }

  function impReviewReset(){
    impReviewStop();
    impState.review = null; impState.reviewJobId = null; impState.reviewState = null;
    impState.reviewMode = 'preview'; impState.reviewRowId = impState.reviewSceneKey = null;
    impState.reviewVariant = 'fixed'; impState.reviewBase = null; impState.reviewApplied = false;
    impState.reviewRerun = true; impState.reviewLastActiveAt = 0;
    impReviewRender();
  }

  async function impReviewFetch(jobId){
    try {
      const response = await fetch(impReviewURL(jobId), {cache:'no-store', signal:AbortSignal.timeout(15000)});
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' ? data : null;
    } catch(e){ return null; }
  }

  async function impReviewJobState(jobId){
    // 识别结果已加载，cursor=1 只读取任务元数据。
    const url = App.core.studioPath('/api/jobs/' + encodeURIComponent(jobId) + '?cursor=1');
    try {
      const response = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(15000)});
      if (response.status === 404) return 'unavailable';
      if (!response.ok) return null;
      const {review} = await response.json();
      return review?.state ?? null;
    } catch(e){ return null; }
  }

  function impReviewAccept(raw){
    const s = raw && typeof raw === 'object' ? raw : {};
    const now = IMP_REVIEW_STATES.includes(s.state) ? s.state : 'unavailable';
    impState.review = {
      state: now,
      summary: typeof s.summary === 'string' ? s.summary : '',
      issues: Array.isArray(s.issues) ? s.issues.filter(i => i && typeof i === 'object') : [],
      fixed: s.fixed && typeof s.fixed === 'object' ? s.fixed : null,
      delta: s.delta && typeof s.delta === 'object' ? s.delta : null,
      updatedAt: Number.isFinite(+s.updatedAt) ? +s.updatedAt : Date.now(),
    };
    // 旧服务端不带 rerun 字段：按可重跑处理，保持原行为。
    impState.reviewRerun = s.rerun !== false;
    impState.reviewState = now;
    impReviewRender();
  }

  // 轮询的任务、弹窗和编辑会话应仍是打开复核时的那一份。
  function impReviewAlive(jobId, gen){
    return impState.reviewJobId === jobId && impState.reviewGen === gen &&
      (impState.reviewMode === 'preview' || impState.reviewSceneKey === App.projects.activeSceneKey) &&
      Boolean(impEls.wrap) && impEls.wrap.classList.contains('on');
  }

  function impReviewStart(){
    impReviewStop();
    const jobId = impState.reviewJobId, now = impState.reviewState, gen = impState.reviewGen;
    if (!jobId || !['differ', 'pending', 'running'].includes(now)){
      impReviewRender();
      return;
    }
    impState.reviewLastActiveAt = Date.now();
    if (now === 'differ'){ void impReviewInitial(jobId, gen); return; }
    impReviewRender();
    impReviewPoll(jobId, gen);
  }

  async function impReviewInitial(jobId, gen){
    const data = await impReviewFetch(jobId);
    if (!impReviewAlive(jobId, gen)) return;
    if (!data){ impState.reviewState = 'unavailable'; impReviewRender(); return; }
    impReviewAccept(data);
    if (impState.review.state === 'pending' || impState.review.state === 'running') impReviewPoll(jobId, gen);
  }

  function impReviewPoll(jobId, gen){
    clearTimeout(impState.reviewTimer);
    impState.reviewTimer = 0;
    const tick = async () => {
      impState.reviewTimer = 0;
      if (!impReviewAlive(jobId, gen)) return;
      const state = await impReviewJobState(jobId);
      if (!impReviewAlive(jobId, gen)) return;
      if (state === 'pending' || state === 'running'){
        impState.reviewLastActiveAt = Date.now();
        impState.reviewState = state;
        impReviewRender();
        impState.reviewTimer = setTimeout(tick, IMP_REVIEW_POLL);
        return;
      }
      if (state === 'unavailable'){
        impReviewAccept({state});
        return;
      }
      const data = await impReviewFetch(jobId);
      if (!impReviewAlive(jobId, gen)) return;
      if (!data){
        if (Date.now() - impState.reviewLastActiveAt > IMP_REVIEW_GIVEUP){
          impReviewAccept({state:'unavailable'});
          return;
        }
        impState.reviewTimer = setTimeout(tick, IMP_REVIEW_POLL);
        return;
      }
      impReviewAccept(data);
      if (impState.review.state === 'pending' || impState.review.state === 'running')
        impState.reviewTimer = setTimeout(tick, IMP_REVIEW_POLL);
    };
    void tick();
  }

  async function impReviewRetry(){
    const jobId = impState.reviewJobId, requestGen = impState.reviewGen;
    if (!jobId || !impReviewAlive(jobId, requestGen)) return;
    try {
      const response = await fetch(impReviewURL(jobId), {method:'POST', signal:AbortSignal.timeout(15000)});
      if (!response.ok) return;
    } catch(e){ return; }
    if (!impReviewAlive(jobId, requestGen)) return;
    impReviewStop();
    const gen = impState.reviewGen;
    impState.review = null;
    impState.reviewState = 'pending';
    impState.reviewApplied = false;
    impState.reviewLastActiveAt = Date.now();
    impReviewRender();
    impReviewPoll(jobId, gen);
  }

  // 服务端修正数据：户型走 sanitizePlan，家具沿用图纸导入的过滤口径
  function impReviewFixedData(){
    const fixed = impState.review?.fixed;
    if (!fixed) return null;
    const result = App.plan.sanitizePlan(fixed.plan);
    if (!result.ok) return null;
    const plan = {...result.plan, name:impState.result?.plan?.name ?? result.plan.name};
    return {plan, furniture:App.io.drawingFurniture(fixed.furniture)};
  }

  function impReviewApply(){
    const fixed = impReviewFixedData();
    if (!fixed) return;
    if (!impState.reviewApplied) impState.reviewBase = impState.result;
    impState.reviewApplied = true;
    impState.reviewVariant = 'fixed';
    impState.result = {...impState.result, plan:fixed.plan, furniture:fixed.furniture};
    impRenderPreview();
  }

  function impReviewUndo(){
    if (!impState.reviewBase) return;
    impState.result = impState.reviewBase;
    impState.reviewBase = null;
    impState.reviewApplied = false;
    impState.reviewVariant = 'fixed';
    impRenderPreview();
  }

  async function impReviewCreateScheme(){
    const fixed = impReviewFixedData();
    if (!fixed) return;
    const project = App.projects.getActiveProject(), expectedSceneKey = impState.reviewSceneKey;
    if (!project || project.id !== impState.reviewRowId || expectedSceneKey !== App.projects.activeSceneKey){
      impClose();
      App.core.toast(App.core.tr('当前方案已切换，请重新打开图纸复核。', 'The active design changed. Reopen the drawing review.'));
      return;
    }
    const label = App.core.tr('图纸修正版', 'Corrected drawing');
    const names = new Set(project.schemes.map(scheme => scheme.name));
    let name = label;
    for (let n = 2; names.has(name); n++) name = `${label} ${n}`;
    const snapshot = App.io.snapshotFromRecognition(fixed.plan, fixed.furniture);
    if (!snapshot) return;
    const created = await App.projects.createScheme({
      from:'baseline', name, snapshot, origin:'review', expectedSceneKey,
      reviewVersion:Number.isFinite(+impState.review?.updatedAt) ? +impState.review.updatedAt : 0,
    });
    if (!created) return;
    if (impState.reviewSceneKey === expectedSceneKey) impClose();
    App.core.toast(App.core.tr(`已创建方案「${name}」`, `Created design “${name}”`));
  }

  function impReviewDelta(delta){
    if (!delta || typeof delta !== 'object') return '';
    const parts = [];
    const pair = (label, item, digits, unit) => {
      if (!item || typeof item !== 'object') return;
      const before = Number(item.before), after = Number(item.after);
      if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return;
      const show = v => digits ? v.toFixed(digits) : String(v);
      parts.push(`${label} ${show(before)}→${show(after)}${unit || ''}`);
    };
    pair(App.core.tr('房间', 'Rooms'), delta.rooms);
    pair(App.core.tr('面积', 'Area'), delta.area, 1, ' m²');
    pair(App.core.tr('墙', 'Walls'), delta.walls);
    pair(App.core.tr('窗', 'Windows'), delta.wins);
    pair(App.core.tr('门', 'Doors'), delta.doors);
    pair(App.core.tr('家具', 'Furniture'), delta.furniture);
    return parts.join(' · ');
  }

  // 墙体 / 窗：sanitizePlan 的弧线条目是对象，转成渲染层使用的数组形态
  function impReviewWall(w){
    if (Array.isArray(w)) return w;
    const curve = App.geom.curvedSpan(w);
    return [...App.geom.curveBounds(curve), w.kind, w.height, curve];
  }
  function impReviewWin(w){
    if (Array.isArray(w)) return w;
    return [...App.geom.curveBounds(App.geom.curvedSpan(w)), App.geom.curvedSpan(w)];
  }

  // 整图 SVG：按 bounds 适配，只画房间、墙体、门窗和家具，不做标注与尺寸线
  function impReviewViewBox(plans){
    const list = plans.filter(p => p && p.bounds);
    if (!list.length) return '0 0 1 1';
    const x0 = Math.min(...list.map(p => p.bounds.x)), y0 = Math.min(...list.map(p => p.bounds.y));
    const x1 = Math.max(...list.map(p => p.bounds.x + p.bounds.w));
    const y1 = Math.max(...list.map(p => p.bounds.y + p.bounds.h));
    const pad = Math.max(200, Math.max(x1-x0, y1-y0) * .02);
    return `${x0-pad} ${y0-pad} ${x1-x0+pad*2} ${y1-y0+pad*2}`;
  }
  function impReviewMap(plan, furniture, changedIds, viewBox){
    const changed = new Set((Array.isArray(changedIds) ? changedIds : []).map(String));
    let s = '';
    const rooms = plan.rooms;
    [...rooms.filter(room => room.outdoor), ...rooms.filter(room => !room.outdoor)].forEach(r => {
      const room = r.arcs?.length ? {...r, vertices:r.poly, poly:App.geom.roomOutline(r)} : r;
      s += App.draw2d.roomShape(room, changed.has(String(r.id))
        ? 'fill="#f3e3d8" stroke="#b5653a" stroke-width="1.6" vector-effect="non-scaling-stroke"'
        : `fill="${r.outdoor ? '#d3e2c9' : r.bay ? '#ece3d4' : '#faf6ef'}" stroke="#ded5c7" stroke-width="1" vector-effect="non-scaling-stroke"`);
    });
    plan.slides.forEach(({rect:[x0, y0, x1, y1]}) => {
      s += `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="#fffdf9" stroke="#b9b0a0" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    });
    plan.doors.forEach(d => {
      const [x0, y0, x1, y1] = d.rect;
      s += `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="#e2dacb" stroke="#b9b0a0" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    });
    plan.walls.forEach(w => { s += App.draw2d.wallShape(impReviewWall(w), 'fill="#a7a195"'); });
    plan.wins.forEach(w => {
      const [x0, y0, x1, y1, curve] = impReviewWin(w);
      s += curve ? `<path d="${App.draw2d.curveBandPath(curve)}" fill="#f7fbfd" stroke="#4f7394" stroke-width="1" vector-effect="non-scaling-stroke"/>`
        : `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="#f7fbfd" stroke="#4f7394" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    });
    const list = (Array.isArray(furniture) ? furniture : []).map(App.geom.normalizeFurn).filter(Boolean);
    const paint = f => `<g transform="translate(${f.cx} ${f.cy}) rotate(${f.rot})">${App.draw2d.furnitureShape(f)}</g>`;
    s += list.filter(f => f.type === 'rug').map(paint).join('') +
      list.filter(f => f.type === 'component').map(paint).join('') +
      list.filter(f => f.type !== 'rug' && f.type !== 'component').map(paint).join('');
    return `<svg viewBox="${viewBox || impReviewViewBox([plan])}" role="img" aria-label="${App.core.esc(App.core.tr('户型对比图', 'Plan comparison'))}">${s}</svg>`;
  }

  function impReviewButton(label, primary, onClick){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  /* ---------- 复核大图：滚轮缩放 / 拖动平移 / 悬浮对比切换 ---------- */
  // 缩放和位移只作用在 canvas 上；分段切换与缩放控件是覆盖层，不随图片变换。
  const impView = {open:false, x:0, y:0, scale:1, baseW:0, baseH:0, vb:[0, 0, 1, 1], pointers:new Map(), pinch:null};

  function impReviewShown(){
    const fixed = impReviewFixedData();
    const variant = fixed && impState.reviewVariant === 'fixed' ? 'fixed' : 'recognized';
    return {
      variant,
      fixed,
      shown: variant === 'fixed' ? fixed : {plan:impState.result.plan, furniture:impState.result.furniture},
    };
  }

  function impReviewSetVariant(value){
    impState.reviewVariant = value === 'fixed' ? 'fixed' : 'recognized';
    impReviewRender();
    if (impView.open) impViewRender();
  }

  function impViewEls(){
    return {
      wrap: App.core.$('#impView'), stage: App.core.$('#impViewStage'), canvas: App.core.$('#impViewCanvas'), seg: App.core.$('#impViewSeg'),
      title: App.core.$('#impViewTitle'), note: App.core.$('#impViewNote'), pct: App.core.$('#impViewPct'),
      delta: App.core.$('#impViewDelta'), hint: App.core.$('#impViewHint'),
    };
  }

  function impViewApply(){
    const els = impViewEls();
    if (!els.canvas) return;
    els.canvas.style.transform = `translate(${impView.x}px, ${impView.y}px) scale(${impView.scale})`;
    els.pct.textContent = Math.round(impView.scale * 100) + '%';
  }

  function impViewFit(){
    const els = impViewEls();
    if (!impView.open || !els.stage) return;
    const stageW = els.stage.clientWidth, stageH = els.stage.clientHeight;
    const [vx, vy, vw, vh] = impView.vb;
    if (!stageW || !stageH || !(vw > 0) || !(vh > 0)) return;
    const fit = Math.min(stageW / vw, stageH / vh) * .92;
    const w = Math.max(1, vw * fit), h = Math.max(1, vh * fit);
    els.canvas.style.width = w + 'px';
    els.canvas.style.height = h + 'px';
    impView.baseW = w; impView.baseH = h;
    impView.scale = 1;
    impView.x = (stageW - w) / 2;
    impView.y = (stageH - h) / 2;
    impViewApply();
  }

  function impViewZoomAt(cx, cy, factor){
    const next = Math.min(8, Math.max(.2, impView.scale * factor));
    if (next === impView.scale) return;
    const k = next / impView.scale;
    impView.x = cx - (cx - impView.x) * k;
    impView.y = cy - (cy - impView.y) * k;
    impView.scale = next;
    impViewApply();
  }

  function impViewZoomCenter(factor){
    const els = impViewEls();
    if (!els.stage) return;
    impViewZoomAt(els.stage.clientWidth / 2, els.stage.clientHeight / 2, factor);
  }

  function impViewPointers(){
    const [a, b] = [...impView.pointers.values()];
    if (!a || !b) return null;
    return {dist:Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid:{x:(a.x + b.x) / 2, y:(a.y + b.y) / 2}};
  }

  function impViewPinchStart(){
    const span = impViewPointers();
    impView.pinch = span ? {...span, scale:impView.scale, x:impView.x, y:impView.y} : null;
  }

  function impViewPinchMove(){
    const base = impView.pinch, span = impViewPointers();
    if (!base || !span) return;
    const next = Math.min(8, Math.max(.2, base.scale * span.dist / base.dist));
    const k = next / base.scale;
    impView.x = span.mid.x - (base.mid.x - base.x) * k;
    impView.y = span.mid.y - (base.mid.y - base.y) * k;
    impView.scale = next;
    impViewApply();
  }

  function impViewRender(){
    const els = impViewEls();
    if (!impView.open || !impState.result) return;
    const {variant, fixed, shown} = impReviewShown();
    const data = impState.review;
    const viewBox = impReviewViewBox([impState.result.plan, fixed?.plan]);
    impView.vb = viewBox.split(/\s+/).map(Number);
    const changed = variant === 'fixed' ? data?.delta?.changedRooms : [];
    els.canvas.innerHTML = impReviewMap(shown.plan, shown.furniture, changed, viewBox);
    // 悬浮切换：与卡片共用状态，镜像到当前的识别 / 修正两版
    const projectMode = impState.reviewMode === 'project';
    const segLabel = projectMode ? App.core.tr('项目底稿', 'Project baseline') : App.core.tr('识别结果', 'Recognized');
    const segButton = (label, value) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(variant === value));
      if (value === 'fixed' && !fixed) b.disabled = true;
      b.onclick = () => impReviewSetVariant(value);
      return b;
    };
    els.seg.replaceChildren(segButton(segLabel, 'recognized'), segButton(App.core.tr('修正后', 'Corrected'), 'fixed'));
    els.title.textContent = App.core.tr('户型对比', 'Plan comparison');
    els.note.textContent = data?.issues?.length ? App.core.tr(`${data.issues.length} 处差异`, `${data.issues.length} differences`) : '';
    const deltaText = impReviewDelta(data?.delta);
    els.delta.textContent = deltaText;
    els.delta.hidden = !deltaText;
    els.hint.textContent = App.core.tr('滚轮缩放 · 拖动平移 · 双击适应', 'Scroll to zoom · Drag to pan · Double-click to fit');
  }

  function impViewOpen(){
    if (!impState.result) return;
    const els = impViewEls();
    if (!els.wrap) return;
    impView.open = true;
    els.wrap.classList.add('on');
    els.wrap.setAttribute('aria-hidden', 'false');
    impViewRender();
    impViewFit();
    App.core.$('#impViewClose')?.focus?.({preventScroll:true});
  }

  function impViewClose(){
    const els = impViewEls();
    impView.open = false;
    impView.pointers.clear();
    impView.pinch = null;
    if (!els.wrap) return;
    els.wrap.classList.remove('on');
    els.wrap.setAttribute('aria-hidden', 'true');
    els.wrap.querySelector('#impViewStage')?.classList.remove('grabbing');
  }

  function impReviewRender(){
    const box = impEls.review, note = impEls.reviewNote;
    if (!box) return;
    const data = impState.review;
    const now = data?.state || impState.reviewState;
    const projectMode = impState.reviewMode === 'project';
    if (note){
      const match = !projectMode && now === 'match' && impState.result;
      note.hidden = !match;
      note.textContent = match ? App.core.tr('已对照原图复核，未发现明显差异。', 'Auto review found no obvious differences from the source drawing.') : '';
    }
    box.replaceChildren();
    if (!impState.reviewJobId || !now || now === 'match' || now === 'unavailable'){
      box.hidden = true;
      impViewClose();
      return;
    }
    box.hidden = false;
    // differ 的任务在首次拉取回来前先按「复核中」显示，避免闪一张 0 处差异的空卡
    const waiting = now === 'pending' || now === 'running' || (now === 'differ' && !data);
    if (waiting){
      const row = document.createElement('div');
      row.className = 'imp-review-pending';
      row.textContent = App.core.tr('正在对照原图复核…', 'Comparing with the source drawing…');
      box.append(row);
      return;
    }
    if (impState.reviewApplied && !projectMode){
      const row = document.createElement('div');
      row.className = 'imp-review-applied';
      const text = document.createElement('span');
      text.textContent = App.core.tr('已应用自动修正', 'Corrections applied');
      row.append(text, impReviewButton(App.core.tr('撤销', 'Undo'), false, impReviewUndo));
      box.append(row);
      return;
    }
    const fixed = impReviewFixedData();
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const head = document.createElement('div');
    head.className = 'imp-review-head';
    // differ 但模型没列出条目（只给了修正图纸）时，不能显示「发现 0 处差异」。
    head.textContent = issues.length
      ? App.core.tr(`自动复核发现 ${issues.length} 处与原图不一致`,
        issues.length === 1 ? 'Auto review found 1 difference from the source drawing'
          : `Auto review found ${issues.length} differences from the source drawing`)
      : App.core.tr('自动复核发现差异，详见修正后的图纸', 'Auto review found differences. See the corrected drawing.');
    const segLabel = projectMode ? App.core.tr('项目底稿', 'Project baseline') : App.core.tr('识别结果', 'Recognized');
    const variant = fixed && impState.reviewVariant === 'fixed' ? 'fixed' : 'recognized';
    const seg = document.createElement('div');
    seg.className = 'imp-review-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', App.core.tr('对比视图', 'Comparison view'));
    const segButton = (label, value) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(variant === value));
      if (value === 'fixed' && !fixed) b.disabled = true;
      b.onclick = () => impReviewSetVariant(value);
      return b;
    };
    seg.append(segButton(segLabel, 'recognized'), segButton(App.core.tr('修正后', 'Corrected'), 'fixed'));
    const shown = variant === 'fixed' ? fixed : {plan:impState.result.plan, furniture:impState.result.furniture};
    const viewBox = impReviewViewBox([impState.result?.plan, fixed?.plan]);
    const map = document.createElement('div');
    map.className = 'imp-review-map';
    map.tabIndex = 0;
    map.setAttribute('role', 'button');
    map.setAttribute('aria-label', App.core.tr('打开大图查看户型对比', 'Open the large plan comparison'));
    map.innerHTML = impReviewMap(shown.plan, shown.furniture, variant === 'fixed' ? data?.delta?.changedRooms : [], viewBox);
    map.onclick = () => impViewOpen();
    map.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); impViewOpen(); } };
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'imp-review-expand';
    expand.textContent = App.core.tr('看大图', 'Large view');
    expand.onclick = e => { e.stopPropagation(); impViewOpen(); };
    map.append(expand);
    const deltaText = impReviewDelta(data?.delta);
    const deltaEl = document.createElement('div');
    deltaEl.className = 'imp-review-delta';
    deltaEl.textContent = deltaText;
    deltaEl.hidden = !deltaText;
    const summary = typeof data?.summary === 'string' ? data.summary.trim() : '';
    const summaryEl = document.createElement('p');
    summaryEl.className = 'imp-review-summary';
    summaryEl.textContent = summary;
    summaryEl.hidden = !summary;
    // 服务端已把 where / detail 截断，这里只用 textContent 渲染
    const issueList = document.createElement('ul');
    issueList.className = 'imp-review-issues';
    issueList.hidden = issues.length === 0;
    for (const issue of issues){
      const item = document.createElement('li');
      const where = typeof issue?.where === 'string' ? issue.where.trim() : '';
      const detail = typeof issue?.detail === 'string' ? issue.detail.trim() : '';
      item.textContent = where && detail ? `${where}：${detail}` : (detail || where);
      if (!item.textContent) continue;
      issueList.append(item);
    }
    const foot = document.createElement('div');
    foot.className = 'imp-review-foot';
    const hint = document.createElement('div');
    hint.className = 'imp-review-hint';
    if (projectMode){
      const apply = impReviewButton(App.core.tr('用修正版新建方案', 'Create design from corrections'), true, async () => {
        apply.disabled = true;
        try { await impReviewCreateScheme(); }
        catch(e){ App.core.toast(e?.message || App.core.tr('创建方案失败，请重试。', 'Could not create the design. Try again.')); }
        finally { apply.disabled = false; }
      });
      apply.disabled = !fixed;
      foot.append(apply);
      hint.textContent = App.core.tr('从修正后的户型与家具开始设计。', 'Start designing from the corrected floor plan and furniture.');
    } else {
      const keep = impReviewButton(App.core.tr('保留原识别', 'Keep recognized'), false, () => {
        impReviewStop();
        impState.review = null;
        impState.reviewState = 'unavailable';
        impReviewRender();
      });
      const apply = impReviewButton(App.core.tr('应用修正', 'Apply corrections'), true, () => {
        apply.disabled = true;
        impReviewApply();
      });
      apply.disabled = !fixed;
      foot.append(keep, apply);
    }
    box.append(head, seg, map);
    if (deltaText) box.append(deltaEl);
    if (summary) box.append(summaryEl);
    if (issues.length) box.append(issueList);
    box.append(foot);
    if (projectMode) box.append(hint);
    // 工作目录已清理（公网任务或服务重启）时服务端无法重跑，隐藏按钮而不是留一个死按钮。
    if (impState.reviewRerun !== false){
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'imp-review-retry';
      retry.textContent = App.core.tr('重新复核', 'Re-run review');
      retry.onclick = () => void impReviewRetry();
      box.append(retry);
    }
  }

  function impRenderRoomReview(plan, furniture){
    const select = App.core.$('#impRoomReview'), drawing = App.core.$('#impRoomDrawing');
    const previous = select.value;
    select.replaceChildren(...plan.rooms.map(room => new Option(App.core.nm(room.name), room.id)));
    if (plan.rooms.some(room => room.id === previous)) select.value = previous;
    App.core.$('#impRoomReviewLabel').textContent = App.core.tr('对照原图复核房间布置', 'Compare room layout with the source drawing');
    select.onchange = () => {
      const room = plan.rooms.find(r => r.id === select.value);
      const outline = App.geom.roomOutline(room), [x0,y0,x1,y1] = App.geom.bbox(outline);
      const margin = Math.max(120, Math.max(x1-x0, y1-y0)*.06);
      drawing.setAttribute('viewBox', `${x0-margin} ${y0-margin} ${x1-x0+2*margin} ${y1-y0+2*margin}`);
      const floor = App.draw2d.roomShape(room, 'fill="#fffdf9" stroke="#b5a491" stroke-width="1" vector-effect="non-scaling-stroke"');
      const layout = furniture.filter(f => App.assistant.pointInPoly(f.cx, f.cy, outline)).map(App.geom.normalizeFurn).filter(Boolean);
      const paint = f => `<g transform="translate(${f.cx} ${f.cy}) rotate(${f.rot})"><title>${App.core.esc(App.core.nm(f.name))}</title>${App.draw2d.furnitureShape(f)}</g>`;
      drawing.innerHTML = floor + layout.filter(f => f.type === 'rug').map(paint).join('') +
        layout.filter(f => f.type !== 'rug').map(paint).join('');
    };
    select.onchange();
  }

  function impRenderPreview(){
    const {plan:p, furniture, explanation} = impState.result;
    impEls.planName.textContent = p.name;
    impEls.planSrc.textContent = App.core.tr('来自图纸', 'From drawing');
    const total = p.rooms.filter(r => r.counted !== false).reduce((a, r) => a + App.geom.roomArea(r), 0);
    const components = App.geom.componentCount(furniture);
    impEls.stats.innerHTML = '';
    const cell = (label, value) => {
      const d = document.createElement('div');
      const s = document.createElement('small'); s.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      d.append(s, b); return d;
    };
    const openings = cell(App.core.tr('墙 / 窗 / 门', 'Walls / Windows / Doors'), `${p.walls.length} / ${p.wins.length} / ${p.doors.length}`);
    openings.classList.toggle('wide', components > 0);
    impEls.stats.append(
      cell(App.core.tr('房间', 'Rooms'), String(p.rooms.length)),
      cell(App.core.tr('总面积', 'Total area'), App.geom.fmt(total) + ' m²'),
      openings,
      cell(App.core.tr('识别到的家具', 'Recognized furniture'), String(furniture.length - components)),
    );
    if (components) impEls.stats.append(cell(App.core.tr('识别到的构件', 'Recognized components'), String(components)));
    impRenderRoomReview(p, furniture);
    impEls.rooms.innerHTML = '';
    p.rooms.forEach(r => {
      const li = document.createElement('li');
      const nmEl = document.createElement('span'); nmEl.textContent = App.core.nm(r.name);
      const ar = document.createElement('small'); ar.textContent = App.geom.fmt(App.geom.roomArea(r)) + ' m²';
      li.append(nmEl, ar);
      impEls.rooms.appendChild(li);
    });
    impEls.exp.textContent = explanation;
    impEls.exp.hidden = !explanation;
    impReviewRender();
  }

  async function impApplyPlan(){
    if (!impState.result || impState.applying || typeof impState.onApply !== 'function') return;
    const {plan, furniture} = impState.result;
    impState.applying = true;
    impEls.apply.disabled = impEls.cancelApply.disabled = impEls.close.disabled = true;
    impErrShow('');
    let result;
    try {
      result = await impState.onApply({plan, furniture, keep:false});
    } catch(e) {
      result = {ok:false};
    } finally {
      impState.applying = false;
      impEls.apply.disabled = impEls.cancelApply.disabled = impEls.close.disabled = false;
    }
    if (!result?.ok){
      return impErrShow(App.core.tr('无法打开新项目。', 'Could not open the new project.') + (result?.errors?.[0] ? ' ' + result.errors[0] : ''));
    }
    const name = result.plan?.name || plan.name;
    impClose();
    App.core.toast(App.core.tr(`已打开项目「${name}」`, `Opened project “${name}”`));
  }

  function impRelang(){
    if (!impEls.wrap) return;
    const compareMode = impState.reviewMode === 'project' && impState.result && typeof impState.onApply !== 'function';
    impEls.title.textContent = compareMode ? App.core.tr('图纸复核', 'Drawing review') : impState.result
      ? App.core.tr('识别结果', 'Recognition result') : App.core.tr('导入图纸', 'Import drawing');
    impEls.close.title = App.core.tr('关闭', 'Close');
    impEls.dropTitle.textContent = App.core.tr('选择图纸文件', 'Choose drawing files');
    impEls.dropHint.textContent = App.core.tr('支持图片、PDF、CAD 导出、JSON，不限格式', 'Images, PDF, CAD exports or JSON — any format');
    impEls.note.placeholder = App.core.tr('备注（可选，如：只识别一层）', 'Note (optional, e.g. "ground floor only")');
    impEls.pickHint.textContent = impState.retryId
      ? App.core.tr('请重新选择图纸文件以重试识别。', 'Choose the drawing files again to retry recognition.')
      : App.core.tr('上传后会在后台识别，完成后可从「项目」确认底稿并打开方案一。',
        'Recognition runs in the background. Confirm the baseline in Projects to open the first design.');
    impEls.pickCancel.textContent = App.core.tr('取消', 'Cancel');
    impEls.cancel.textContent = App.core.tr('取消上传', 'Cancel upload');
    impEls.cancelApply.textContent = App.core.tr('关闭', 'Close');
    impEls.apply.textContent = App.core.tr('打开新项目', 'Open new project');
    impEls.resultHint.textContent = App.core.tr('确认后会保存项目底稿并打开方案一。', 'Confirm the baseline to save the project and open the first design.');
    impEls.apply.hidden = Boolean(compareMode);
    impEls.resultHint.hidden = Boolean(compareMode);
    impUpdateStart();
    if (impState.result) impRenderPreview();
  }

  function impInit(){
    Object.assign(impEls, {
      wrap: App.core.$('#impWrap'), title: App.core.$('#impTitle'), close: App.core.$('#impClose'),
      pick: App.core.$('#impPick'), drop: App.core.$('#impDrop'), dropTitle: App.core.$('#impDropTitle'), dropHint: App.core.$('#impDropHint'),
      files: App.core.$('#impFiles'), file: App.core.$('#impFile'), note: App.core.$('#impNote'),
      pickCancel: App.core.$('#impPickCancel'), start: App.core.$('#impStart'), pickHint: App.core.$('#impPickHint'),
      prog: App.core.$('#impProg'), bar: App.core.$('#impBar'), st: App.core.$('#impSt'), cancel: App.core.$('#impCancel'),
      body: App.core.$('#impBody'), planName: App.core.$('#impPlanName'), planSrc: App.core.$('#impPlanSrc'), stats: App.core.$('#impStats'),
      review: App.core.$('#impReview'), reviewNote: App.core.$('#impReviewNote'),
      rooms: App.core.$('#impRooms'), exp: App.core.$('#impExp'), resultHint: App.core.$('#impResultHint'),
      cancelApply: App.core.$('#impCancelApply'), apply: App.core.$('#impApply'), err: App.core.$('#impErr'),
    });
    impEls.drop.onclick = () => impEls.file.click();
    impEls.drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); impEls.file.click(); } };
    impEls.file.onchange = e => { impAddFiles(e.target.files); e.target.value = ''; };
    impEls.start.onclick = impStart;
    impEls.pickCancel.onclick = impClose;
    impEls.cancel.onclick = impAbort;
    impEls.cancelApply.onclick = impClose;
    impEls.close.onclick = impClose;
    impEls.apply.onclick = impApplyPlan;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && impEls.wrap.classList.contains('on')) impClose(); });
    // 复核大图：关闭 / 缩放控件 / 滚轮 / 拖动 / 双指 / 双击适应
    const viewStage = App.core.$('#impViewStage');
    App.core.$('#impViewClose').onclick = impViewClose;
    App.core.$('#impViewIn').onclick = () => impViewZoomCenter(1.25);
    App.core.$('#impViewOut').onclick = () => impViewZoomCenter(1 / 1.25);
    App.core.$('#impViewFit').onclick = () => impViewFit();
    App.core.$('#impViewPct').onclick = () => impViewFit();
    App.core.$('#impView').onclick = e => { if (e.target === App.core.$('#impView')) impViewClose(); };
    viewStage.addEventListener('wheel', e => {
      if (!impView.open) return;
      e.preventDefault();
      const rect = viewStage.getBoundingClientRect();
      impViewZoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * .0015));
    }, {passive:false});
    const stagePoint = e => {
      const rect = viewStage.getBoundingClientRect();
      return {x:e.clientX - rect.left, y:e.clientY - rect.top};
    };
    viewStage.addEventListener('pointerdown', e => {
      if (!impView.open || (e.pointerType === 'mouse' && e.button !== 0)) return;
      viewStage.setPointerCapture?.(e.pointerId);
      impView.pointers.set(e.pointerId, stagePoint(e));
      if (impView.pointers.size >= 2) impViewPinchStart();
      else viewStage.classList.add('grabbing');
    });
    viewStage.addEventListener('pointermove', e => {
      if (!impView.open || !impView.pointers.has(e.pointerId)) return;
      const last = impView.pointers.get(e.pointerId), point = stagePoint(e);
      impView.pointers.set(e.pointerId, point);
      if (impView.pointers.size >= 2){ impViewPinchMove(); return; }
      impView.x += point.x - last.x;
      impView.y += point.y - last.y;
      impViewApply();
    });
    const endPointer = e => {
      impView.pointers.delete(e.pointerId);
      if (impView.pointers.size < 2) impView.pinch = null;
      if (!impView.pointers.size) viewStage.classList.remove('grabbing');
    };
    viewStage.addEventListener('pointerup', endPointer);
    viewStage.addEventListener('pointercancel', endPointer);
    viewStage.addEventListener('dblclick', () => impViewFit());
    addEventListener('resize', () => { if (impView.open) impViewFit(); });
    document.addEventListener('keydown', e => {
      if (!impView.open) return;
      if (e.key === 'Escape'){ e.preventDefault(); e.stopImmediatePropagation(); impViewClose(); }
      else if (e.key === '+' || e.key === '='){ e.preventDefault(); impViewZoomCenter(1.2); }
      else if (e.key === '-' || e.key === '_'){ e.preventDefault(); impViewZoomCenter(1 / 1.2); }
      else if (e.key === '0'){ e.preventDefault(); impViewFit(); }
    }, true);
    App.core.$('#importPlanFile').onclick = () => impOpen();
    impRelang();
  }

  Object.assign(App.importer, {
    impState, impOpen, impClose, impOpenResult, impRelang, impInit, impReviewMap, impFileB64,
  });
})();
