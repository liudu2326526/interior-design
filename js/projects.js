/* 项目、多方案、后台识别和项目存储。
 * 依赖 App.core、App.plan、App.store、App.geom、App.draw2d、App.panel、App.interact、App.io、App.assistant、App.importer。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 项目与后台识别 ======================= */
  const projectEndpoint = App.core.studioPath('/api/jobs/plan-import');
  const projectActiveKey = 'interior-active-project-v1' + App.core.projectScope;
  const projectRows = new Map();
  const jobProgress = new Map();
  const projectOpening = new Set();
  const projectPanel = App.core.$('#projectPanel'), projectToggle = App.core.$('#projectToggle'), projectList = App.core.$('#projectList');
  const projectPending = row => row.phase === 'queued' || row.phase === 'running';
  const projectReview = row => row?.review && typeof row.review === 'object' ? row.review : null;
  const projectReviewPending = row => ['pending', 'running'].includes(projectReview(row)?.state);
  const projectBusy = row => projectPending(row) || projectReviewPending(row);
  const projectAi = App.core.PUBLIC_ACCESS !== 'guest' && /^https?:$/.test(location.protocol);
  let activeProjectId = '', projectSwitching = false, projectStorageIssue = false, projectSyncIssue = '';
  let projectTimer = 0, projectSyncing = false, projectSyncAgain = false;
  let renderedProjectRows = '';

  const projectDb = new Promise(resolve => {
    try {
      const request = indexedDB.open('interior-projects-v1' + App.core.projectScope, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects', {keyPath:'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch(e){ resolve(null); }
  });
  async function projectTransaction(mode, run){
    const db = await projectDb;
    if (!db) throw new Error('Project storage unavailable');
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('projects', mode);
      const request = run(transaction.objectStore('projects'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
    });
  }
  async function putProject(row){
    projectRows.set(row.id, row);
    try { await projectTransaction('readwrite', store => store.put(row)); }
    catch(e){ projectStorageIssue = true; renderProjects(); }
  }
  function projectCurrent(){
    const snapshot = App.io.studio.projectJSON();
    return {
      ...projectRows.get(activeProjectId), id:activeProjectId, name:snapshot.plan.name,
      phase:'saved', snapshot, updatedAt:Date.now(),
    };
  }
  function projectRecordActive(row){
    try {
      sessionStorage.setItem(projectActiveKey, row.id);
      localStorage.setItem(projectActiveKey, JSON.stringify({id:row.id, updatedAt:row.updatedAt}));
    } catch(e){}
  }
  function saveActiveProject(){
    if (!activeProjectId || projectSwitching) return;
    const row = projectCurrent();
    projectRecordActive(row);
    void putProject(row);
    if (!projectPanel.hidden) renderProjects();
  }
  function loadProjectScene(snapshot){
    const result = App.plan.sanitizePlan(snapshot.plan);
    if (!result.ok) return result;
    App.store.installPlan(result.plan);
    App.store.state = App.store.fixState({...App.core.deepCopy(snapshot.state || App.store.defaultState()), renders:snapshot.state?.renders || []});
    return result;
  }
  function refreshProjectScene(){
    App.dimensions.clearDraft();
    App.dimensions.closeEditor();
    clearTimeout(App.assistant.chatState.focusT);
    App.assistant.resetChatHistory();
    App.assistant.resetRenderReference();
    App.assistant.renderState.last = null;
    App.assistant.renderEls.out.removeAttribute('src');
    App.assistant.renderEls.outCap.textContent = ''; App.assistant.renderEls.actions.hidden = true;
    App.assistant.renderErr(''); App.assistant.renderStatus('', false);
    const last = App.store.state.renders.at(-1);
    if (last) App.assistant.renderShowRec(last, false);
    else { App.assistant.renderHistory(); App.assistant.renderAvailability(); }
    App.assistant.chatPane('props');
    App.store.undoStack.length = App.store.redoStack.length = 0;
    App.store.ui.sel = App.store.ui.mA = App.store.ui.mCur = null;
    App.view3d?.resetWalk();
    App.store.save();
    App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings(); App.draw2d.renderAll(); App.io.refit();
    if (App.io.studio.is3D()) App.view3d?.flyIso?.();
  }
  async function switchProject(row, install){
    await projectBoot;
    if (projectSwitching || document.body.classList.contains('busy') || App.assistant.chatState.sending || App.assistant.renderState.busy){
      const message = App.core.tr('请等当前操作完成后再切换项目。', 'Finish the current operation before switching projects.');
      App.core.toast(message); return {ok:false, errors:[message]};
    }
    projectSwitching = true;
    try {
      if (activeProjectId){
        App.view3d?.rememberWalkExit();
        await putProject(projectCurrent());
        // 等待浏览器存储时，最后一次键盘操作也归到原来的项目。
        void putProject(projectCurrent());
      }
      const result = install();
      if (!result.ok) return result;
      activeProjectId = row.id;
      projectRows.set(row.id, {...row, result:undefined, snapshot:undefined, phase:'saved'});
      refreshProjectScene();
      const saved = projectCurrent();
      projectRecordActive(saved); await putProject(saved);
      closeProjects();
      return result;
    } finally {
      projectSwitching = false;
      saveActiveProject();
      renderProjects();
    }
  }
  async function openNewProject(snapshot){
    const row = {id:App.geom.uid(), createdAt:Date.now()};
    const result = await switchProject(row, () => loadProjectScene(snapshot));
    if (!result.ok && result.errors?.[0]) App.core.toast(result.errors[0]);
    return result.ok;
  }
  async function startBlankProject(){
    const plan = await App.io.loadPlanFile('data/empty-plan.json') || App.plan.FALLBACK_PLAN;
    await openNewProject({plan, state:App.store.defaultState()});
  }

  function projectFormatTime(value){
    return new Intl.DateTimeFormat(App.core.LANG === 'en' ? 'en' : App.core.LANG === 'zht' ? 'zh-TW' : 'zh-CN',
      {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(value);
  }
  // 应用修正时记录的现场指纹：户型的可比较投影（渲染记录等无关字段不参与）。
  function sceneSignature(snapshot){
    return JSON.stringify({
      plan:snapshot?.plan ?? null,
      furniture:snapshot?.state?.furniture ?? [],
      demolished:snapshot?.state?.demolished ?? [],
    });
  }
  // 「已应用」只在场景与复核版本都还是应用时那一份时有效；撤销、编辑或复核重跑后自动失效。
  function projectReviewApplied(row){
    if (!row?.reviewApplied) return false;
    // 复核重跑出新结果（updatedAt 变化）后，应重新提供对比入口。
    if (Number.isFinite(+row.reviewAppliedReview) &&
        +row.reviewAppliedReview !== (+projectReview(row)?.updatedAt || 0)) return false;
    if (!row.reviewAppliedSig) return true;   // 旧数据：没有指纹时沿用原行为
    return Boolean(row.snapshot) && row.reviewAppliedSig === sceneSignature(row.snapshot);
  }
  const sameReview = (a, b) => (a?.state || '') === (b?.state || '') &&
    (+a?.count || 0) === (+b?.count || 0) && (+a?.updatedAt || 0) === (+b?.updatedAt || 0);
  function projectReviewMessage(row){
    const review = projectReview(row);
    if (!review) return '';
    const count = Number.isFinite(+review.count) ? +review.count : 0;
    const differ = App.core.tr(`自动复核发现 ${count} 处与原图不一致，建议先查看修正。`,
      count === 1 ? 'Auto review found 1 difference from the source drawing. Review the corrections first.'
        : `Auto review found ${count} differences from the source drawing. Review the corrections first.`);
    if (review.state === 'differ'){
      if (row.phase === 'done') return differ;
      if (row.phase === 'saved' && row.jobId && !projectReviewApplied(row)) return differ;
    }
    return '';
  }

  const progressSteps = {
    queued:[1, '等待任务开始', 'Waiting its turn'],
    preparing:[2, '正在准备图纸', 'Preparing the drawing'],
    'waiting-model':[2, '正在等待模型响应', 'Waiting for the model'],
    recognizing:[3, '模型正在识别图纸', 'Analyzing the drawing'],
    comparing:[3, '模型正在对照原图', 'Comparing with the source'],
    validating:[4, '正在校验并保存结果', 'Validating and saving'],
    done:[4, '识别结果已就绪', 'Recognition complete'],
    failed:[0, '图纸识别失败', 'Recognition failed'],
    canceled:[0, '图纸识别已取消', 'Recognition canceled'],
    unavailable:[0, '未能完成图纸复核', 'Review unavailable'],
  };

  function projectProgress(row){
    const {tr, esc} = App.core;
    const progress = jobProgress.get(row.jobId), review = projectReview(row);
    const reviewing = projectReviewPending(row);
    const reviewFinished = progress?.review && ['match', 'differ', 'unavailable'].includes(review?.state);
    const isReview = reviewing || reviewFinished;
    if (!isReview && !projectPending(row) && !(progress?.import && row.phase !== 'saved')) return '';
    const snapshot = isReview ? progress?.review : progress?.import;
    const active = isReview ? reviewing : projectPending(row);
    const fallback = isReview ? {pending:'queued', running:'comparing', unavailable:'unavailable'}[review.state] || 'done'
      : {running:'recognizing'}[row.phase] || row.phase;
    const stage = active && Object.hasOwn(progressSteps, snapshot?.stage) ? snapshot.stage : fallback;
    if (!Object.hasOwn(progressSteps, stage)) return '';
    const [step, zh, en] = progressSteps[stage];
    const category = isReview ? tr('图纸复核', 'Drawing review') : tr('图纸识别', 'Drawing recognition');
    const title = isReview && stage === 'done' ? tr('图纸复核已完成', 'Review complete') : tr(zh,en);
    const steps = [tr('排队','Queue'), tr('准备','Prepare'), isReview ? tr('复核','Compare') : tr('识别','Analyze'), tr('校验','Validate')];
    const badge = active ? tr(`阶段 ${step}/${steps.length}`, `Step ${step}/${steps.length}`)
      : stage === 'done' ? tr('已完成','Complete') : stage === 'canceled' ? tr('已取消','Canceled') : tr('未完成','Incomplete');
    const began = isReview ? review.updatedAt : row.startedAt || row.createdAt;
    const mins = Math.max(0, Math.floor((Date.now() - (began || Date.now())) / 60000));
    const time = mins ? tr(`已用 ${mins} 分钟`, `${mins} min elapsed`) : tr('已用不到 1 分钟', 'Less than 1 min elapsed');
    const recognitionSummary = reviewing && row.phase === 'done' && !snapshot?.message && progress?.import?.message;
    const output = recognitionSummary || snapshot?.message;
    const message = typeof output === 'string' ? output.trim().slice(0,600) : '';
    const outputLabel = recognitionSummary ? tr('识别摘要','Recognition summary')
      : stage === 'done' ? tr('模型摘要','Model summary') : tr('模型进展','Model update');
    const range = stage === 'done' || active ? ` aria-valuenow="${step}"` : '';
    return `<section class="project-progress${isReview ? ' is-review' : ''}${step === 0 ? ' is-ended' : ''}" aria-label="${esc(category)}">
      <div class="project-progress-head"><div><span class="project-progress-label">${esc(category)}</span>
        <strong>${esc(title)}</strong></div><span class="project-progress-badge">${esc(badge)}</span></div>
      <div class="project-progress-track" role="progressbar" aria-label="${esc(category)}" aria-valuemin="0" aria-valuemax="${steps.length}"${range} aria-valuetext="${esc(`${badge} · ${title}`)}">
        ${steps.map((label, i) => `<span class="project-progress-step${stage === 'done' || i + 1 < step ? ' is-done' : i + 1 === step ? ' is-active' : ''}" aria-hidden="true">${esc(label)}</span>`).join('')}
      </div>
      ${active ? `<div class="project-progress-time">${esc(time)}</div>` : ''}
      ${message ? `<div class="project-progress-output"><span>${esc(outputLabel)}</span><p>${esc(message)}</p></div>` : ''}
    </section>`;
  }

  function projectStatus(row){
    if (row.id === activeProjectId) return [App.core.tr('当前项目', 'Current'), 'is-ready'];
    if (projectOpening.has(row.id)) return [App.core.tr('打开中', 'Opening'), 'is-running'];
    switch (row.phase){
    case 'queued': return [App.core.tr('排队中', 'Queued'), 'is-running'];
    case 'running': return [App.core.tr('识别中', 'Analyzing'), 'is-running'];
    case 'done': return [App.core.tr('待预览', 'Ready to review'), 'is-ready'];
    case 'failed': return [App.core.tr('识别失败', 'Failed'), 'is-failed'];
    case 'canceled': return [App.core.tr('已取消', 'Canceled'), ''];
    default: return [App.core.tr('已保存', 'Saved'), 'is-ready'];
    }
  }
  function projectDetails(row){
    const plan = row.snapshot?.plan || row.result?.plan;
    if (plan) {
      const rooms = plan.rooms.filter(room => room.counted !== false);
      const count = (row.snapshot?.state?.furniture || row.result?.furniture || []).length;
      return App.core.tr(`${rooms.length} 个房间 · ${count} 件家具与构件`, `${rooms.length} rooms · ${count} furnishings and components`);
    }
    return row.error || (row.phase === 'canceled' ? App.core.tr('图纸识别已停止。', 'Drawing recognition was canceled.') : '');
  }
  function projectActions(row){
    const button = (action, label, primary = false) =>
      `<button type="button" class="btn${primary ? ' primary' : ''}" data-project-action="${action}" ${projectOpening.has(row.id) ? 'disabled' : ''}>${App.core.esc(label)}</button>`;
    const review = projectReview(row);
    const reviewBusy = projectReviewPending(row);
    // 只要不是正在复核，就给一个主动触发的入口（包括已有差异、复核失败、还没复核）。
    const rerunButton = row.jobId && (row.phase === 'done' || row.phase === 'saved') && !reviewBusy
      ? button('rerun', App.core.tr('重新复核', 'Run review again')) : '';
    const reviewButton = row.phase === 'saved' && row.jobId && review?.state === 'differ' && !projectReviewApplied(row)
      ? button('review', App.core.tr('查看对比', 'Compare')) : '';
    if (row.id === activeProjectId) return reviewButton + rerunButton;
    if (projectPending(row)) return button('cancel', App.core.tr('取消识别', 'Cancel analysis'));
    if (row.phase === 'done') return button('preview', App.core.tr('查看识别结果', 'Review result'), true) + rerunButton;
    if (row.phase === 'failed' || row.phase === 'canceled'){
      return button('retry', App.core.tr('重新导入', 'Import again'), true) + button('hide', App.core.tr('移除记录', 'Remove entry'));
    }
    return button('open', App.core.tr('打开项目', 'Open project'), true) + reviewButton + rerunButton;
  }
  function renderProjects(){
    const rows = [...projectRows.values()].filter(row => !row.hidden).sort((a, b) =>
      Number(b.id === activeProjectId) - Number(a.id === activeProjectId) || b.updatedAt - a.updatedAt);
    const pending = rows.filter(projectBusy).length, count = App.core.$('#projectCount');
    count.hidden = pending === 0;
    count.textContent = pending > 99 ? '99+' : String(pending);
    projectToggle.setAttribute('aria-label', pending
      ? App.core.tr(`项目，${pending} 个任务进行中`, `Projects, ${pending} tasks in progress`) : App.core.tr('项目','Projects'));
    if (projectPanel.hidden) return;
    const warning = App.core.$('#projectWarning');
    warning.textContent = projectSyncIssue || (projectStorageIssue
      ? App.core.tr('浏览器存储不可用，项目请及时导出备份。', 'Browser storage is unavailable. Export projects to keep a copy.') : '');
    warning.hidden = !warning.textContent;
    App.core.$('#projectEmpty').hidden = rows.length > 0;
    const expanded = new Map([...projectList.children].map(el => [el.dataset.projectId, el.open]));
    const focus = document.activeElement, focusRow = focus?.closest('[data-project-id]')?.dataset.projectId;
    const scroll = projectList.scrollTop;
    const markup = rows.map(row => {
      const [status, tone] = projectStatus(row), detail = projectDetails(row), note = projectReviewMessage(row);
      const review = projectReview(row);
      const chip = row.jobId && review?.state === 'differ' && !projectReviewApplied(row) &&
        (row.phase === 'done' || row.phase === 'saved')
        ? `<span class="project-chip is-diff">${App.core.esc(App.core.tr('有差异', 'Differences'))}</span>`
        : row.jobId && projectReviewPending(row) &&
          (row.phase === 'done' || row.phase === 'saved')
          ? `<span class="project-chip is-review">${App.core.esc(App.core.tr('复核中', 'Reviewing'))}</span>` : '';
      const icon = projectPending(row) || projectOpening.has(row.id) ? 'project-spinner' : 'project-folder';
      return `<details class="project-row" data-project-id="${App.core.esc(row.id)}" ${(expanded.get(row.id) ?? projectBusy(row)) ? 'open' : ''}>
      <summary class="project-row-head"><span class="project-row-icon" aria-hidden="true"><i class="${icon}"></i></span>
        <span class="project-row-title"><b title="${App.core.esc(row.name)}">${App.core.esc(row.name)}</b><span class="project-row-meta">${App.core.esc(projectFormatTime(row.createdAt || row.updatedAt))}</span></span>
        <span class="project-status ${tone}">${App.core.esc(status)}</span>${chip}</summary>
      <div class="project-row-body">${detail ? `<p class="project-row-message">${App.core.esc(detail)}</p>` : ''}
        ${projectProgress(row)}${note ? `<p class="project-row-note">${App.core.esc(note)}</p>` : ''}
        <div class="project-row-actions">${projectActions(row) || ''}</div></div></details>`;
    }).join('');
    if (markup === renderedProjectRows) return;
    renderedProjectRows = markup;
    projectList.innerHTML = markup;
    projectList.scrollTop = scroll;
    if (focusRow){
      const node = [...projectList.children].find(el => el.dataset.projectId === focusRow);
      (node?.querySelector(focus.dataset.projectAction ? `[data-project-action="${focus.dataset.projectAction}"]` : 'summary')
        || node?.querySelector('summary'))?.focus({preventScroll:true});
    }
  }

  async function projectResult(row){
    let raw = '', cursor = 0;
    const signal = AbortSignal.timeout(16000);
    for (;;){
      const response = await fetch(App.core.studioPath(`/api/jobs/${encodeURIComponent(row.jobId)}?cursor=${cursor}`), {cache:'no-store', signal});
      if (!response.ok) throw new Error(App.assistant.aiResponseMessage(response.status, await response.text()));
      const data = await response.json();
      raw += data.chunks.join('');
      if (data.done){
        if (data.status >= 300) throw new Error(data.error || App.assistant.aiResponseMessage(data.status, raw));
        const result = JSON.parse(raw);
        if (!result?.plan) throw new Error(App.core.tr('识别结果缺少户型数据。','The result has no floor plan.'));
        return result;
      }
      if (data.cursor <= cursor) throw new Error(App.core.tr('结果尚未就绪，请稍后重试。','The result is still loading. Try again in a moment.'));
      cursor = data.cursor;
    }
  }
  function scheduleProjectSync(milliseconds){
    clearTimeout(projectTimer);
    projectTimer = setTimeout(syncProjectJobs, milliseconds);
  }
  async function syncProjectJobs(){
    if (!projectAi) return;
    if (projectSyncing){ projectSyncAgain = true; return; }
    projectSyncing = true;
    try {
      const response = await fetch(projectEndpoint, {cache:'no-store', signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error(App.assistant.aiResponseMessage(response.status, await response.text()));
      const {jobs} = await response.json();
      const seen = new Set();
      for (const job of jobs){
        if (!/^import-[a-f0-9-]{36}$/.test(job.id)) continue;
        seen.add(job.id);
        if ([...projectRows.values()].some(row => row.oldJobs?.includes(job.id))) continue;
        const prev = [...projectRows.values()].find(row => row.jobId === job.id);
        if (prev?.hidden) continue;
        const {progress, review:rawReview, ...meta} = job;
        const {progress:reviewProgress, ...reviewMeta} = rawReview ?? {};
        const review = rawReview && typeof rawReview === 'object' ? reviewMeta : null;
        jobProgress.set(job.id, {import:progress, review:reviewProgress});
        // 已打开的项目保留本地快照，只按 jobId 合并最新的复核状态
        if (prev?.snapshot){
          const latest = job.review === undefined ? (prev.review ?? null) : review;
          if (!sameReview(prev.review, latest)) await putProject({...prev, review:latest});
          continue;
        }
        const row = {...meta, ...prev, id:prev?.id || job.id, jobId:job.id,
          phase:job.phase, startedAt:job.startedAt, updatedAt:job.updatedAt,
          review:job.review === undefined ? (prev?.review ?? null) : review};
        if ((job.phase === 'done' && !row.result) || (job.phase === 'failed' && !row.error)){
          try { row.result = await projectResult(row); row.name = row.result.plan.name || row.name; }
          catch(e){ if (job.phase === 'failed') row.error = e.message; }
        }
        const latest = projectRows.get(row.id);
        if (latest && (latest.jobId !== row.jobId || latest.hidden || latest.snapshot)) continue;
        if (!prev || prev.phase !== row.phase || row.result !== prev.result || row.error !== prev.error ||
            prev.updatedAt !== row.updatedAt || !sameReview(prev.review, row.review)) await putProject(row);
      }
      for (const row of projectRows.values()){
        const waiting = projectPending(row) || (row.phase === 'done' && !row.result);
        if (waiting && !seen.has(row.jobId) && Date.now() - row.createdAt > 120000){
          await putProject({...row, phase:'failed', error:App.core.tr('这条任务记录已过期，请重新导入。','This job expired. Import the drawing again.')});
        }
      }
      for (const id of jobProgress.keys()) if (!seen.has(id)) jobProgress.delete(id);
      projectSyncIssue = '';
    } catch(e){
      projectSyncIssue = e instanceof TypeError || e.name === 'TimeoutError'
        ? App.core.tr('暂未同步任务进度，正在重连。','Job status is unavailable. Reconnecting.') : e.message;
    } finally {
      projectSyncing = false;
      renderProjects();
      const pending = [...projectRows.values()].some(row => !row.hidden && projectBusy(row));
      const again = projectSyncAgain; projectSyncAgain = false;
      const activePanel = !document.hidden && !projectPanel.hidden;
      if (again || pending || activePanel){
        scheduleProjectSync(again ? 0 : pending && activePanel ? 1500 : pending && !document.hidden ? 5000 : 12000);
      }
    }
  }

  async function projectImportSubmitted({jobId, name, note, retryId}){
    await projectBoot;
    const prev = projectRows.get(retryId) || projectRows.get(jobId);
    const id = prev?.id || jobId;
    await putProject({
      id, jobId, name:name.replace(/\.[a-z\d]{1,8}$/i, '') || name, note,
      oldJobs:prev?.jobId && prev.jobId !== jobId ? [...(prev.oldJobs || []), prev.jobId] : prev?.oldJobs,
      phase:'queued', createdAt:Date.now(), updatedAt:Date.now(),
    });
    renderProjects(); scheduleProjectSync(0);
    return id;
  }
  // 手动触发一次复核：服务端异步跑模型回合，结果通过任务列表的 review 字段回传。
  async function projectReviewAgain(row){
    if (!row?.jobId) return;
    let response;
    try {
      response = await fetch(App.core.studioPath('/api/jobs/' + encodeURIComponent(row.jobId) + '/review'),
        {method:'POST', signal:AbortSignal.timeout(15000)});
    } catch(e){
      App.core.toast(App.core.tr('无法连接复核服务，请稍后重试。', 'Could not reach the review service. Try again.'));
      return;
    }
    if (response.status === 202){
      const current = projectRows.get(row.id);
      if (current && current.jobId === row.jobId && !current.hidden && sameReview(current.review, row.review)){
        const progress = jobProgress.get(row.jobId);
        if (progress) jobProgress.set(row.jobId, {...progress, review:null});
        await putProject({...current, review:{...(current.review || {}), state:'pending', count:0, updatedAt:Date.now()}});
        renderProjects();
      }
      scheduleProjectSync(0);
      App.core.toast(App.core.tr('已开始重新复核，完成后会提示差异。', 'Review started. Differences will show when it finishes.'));
      return;
    }
    if (response.status === 409){
      App.core.toast(App.core.tr('复核正在进行，请稍候。', 'A review is already running.'));
      scheduleProjectSync(0);
      return;
    }
    if (response.status === 404){
      App.core.toast(App.core.tr('无法重新复核：原图已清理或复核未启用，可重新导入图纸。',
        'Cannot re-run the review: the source drawing was cleaned up or reviews are disabled. Import the drawing again.'));
      return;
    }
    if (response.status === 503){
      App.core.toast(App.core.tr('codex 不可用，暂时无法复核。', 'codex is unavailable, so the review cannot run right now.'));
      return;
    }
    App.core.toast(App.core.tr('无法开始复核，请稍后重试。', 'Could not start the review. Try again later.'));
  }

  async function projectClick(e){
    const button = e.target.closest('[data-project-action]');
    if (!button) return;
    const row = projectRows.get(button.closest('[data-project-id]').dataset.projectId);
    if (!row || button.disabled || projectOpening.has(row.id)) return;
    const action = button.dataset.projectAction, opening = action === 'open' || action === 'preview' || action === 'review';
    button.disabled = true;
    if (opening){ projectOpening.add(row.id); renderProjects(); }
    try {
      switch (action){
      case 'open':
        await switchProject(row, () => loadProjectScene(row.snapshot));
        break;
      case 'preview': {
        const result = row.result || await projectResult(row);
        const current = projectRows.get(row.id);
        if (!current || current.snapshot || current.jobId !== row.jobId) break;
        closeProjects();
        App.importer.impOpenResult(result, ({plan,furniture}) => switchProject(
          {...row, reviewApplied:Boolean(App.importer.impState.reviewApplied)}, () => {
            App.store.state = {...App.store.defaultState(), renders:[]};
            return App.io.applyPlan(plan, {furniture, clearFurniture:true, freshState:true, history:false});
          }), {jobId:row.jobId, reviewState:projectReview(row)?.state, mode:'preview'});
        break;
      }
      case 'review': {
        if (!row.jobId || !row.snapshot) break;
        // 对比和「应用到当前项目」都针对当前打开的方案：不是当前项目时先切换过去
        if (row.id !== activeProjectId){
          const result = await switchProject(row, () => loadProjectScene(row.snapshot));
          if (!result.ok) break;
        }
        closeProjects();
        App.importer.impOpenResult({plan:row.snapshot.plan, furniture:row.snapshot.state?.furniture || []}, null,
          {jobId:row.jobId, reviewState:projectReview(row)?.state, mode:'project', rowId:row.id});
        break;
      }
      case 'rerun': await projectReviewAgain(row); break;
      case 'cancel': {
        const response = await fetch(App.core.studioPath(`/api/jobs/${encodeURIComponent(row.jobId)}`), {method:'DELETE'});
        if (!response.ok) throw new Error(App.assistant.aiResponseMessage(response.status, await response.text()));
        scheduleProjectSync(0);
        break;
      }
      case 'retry': closeProjects(); App.importer.impOpen({retryId:row.id, note:row.note}); break;
      case 'hide': await putProject({...row, hidden:true}); renderProjects(); break;
      }
    } catch(e){ App.core.toast(e.message || App.core.tr('项目操作失败。','Project action failed.')); }
    finally {
      button.disabled = false;
      if (opening){ projectOpening.delete(row.id); renderProjects(); }
    }
  }
  function resizeProjects(){
    const trigger = projectToggle.getBoundingClientRect();
    projectPanel.style.setProperty('--project-panel-space', Math.max(90, window.innerHeight - trigger.bottom - 18) + 'px');
  }
  function closeProjects(returnFocus = false){
    projectPanel.hidden = true;
    projectToggle.setAttribute('aria-expanded','false');
    if (returnFocus) projectToggle.focus({preventScroll:true});
  }
  function openProjects(expandId){
    App.core.$('details.menu').open = false;
    App.panel.closeDrawers();
    projectPanel.hidden = false;
    projectToggle.setAttribute('aria-expanded','true');
    const findRow = () => [...projectList.children].find(el => el.dataset.projectId === expandId);
    const row = expandId && findRow();
    if (row) row.open = true;
    resizeProjects(); renderProjects(); scheduleProjectSync(0);
    if (expandId){
      const expanded = findRow();
      expanded?.scrollIntoView({block:'nearest'});
      expanded?.querySelector('summary')?.focus({preventScroll:true});
    }
  }
  projectToggle.onclick = () => projectPanel.hidden ? openProjects() : closeProjects();
  App.core.$('#projectClose').onclick = () => closeProjects(true);
  App.core.$('#projectNew').onclick = startBlankProject;
  App.core.$('#projectImport').onclick = () => { closeProjects(); App.importer.impOpen(); };
  projectList.onclick = projectClick;
  addEventListener('resize', () => { if (!projectPanel.hidden) resizeProjects(); });
  document.addEventListener('pointerdown', e => { if (!projectPanel.hidden && !e.target.closest('#projectShelf')) closeProjects(); });
  document.addEventListener('keydown', e => {
    if (projectPanel.hidden) return;
    if (e.key === 'Escape'){ e.stopPropagation(); closeProjects(true); }
    else if (projectPanel.contains(e.target)) e.stopPropagation();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleProjectSync(0); });

  let projectBoot;
  function initialize(){
    App.assistant.chatInit();
    App.assistant.renderInit();
    App.importer.impInit();
    App.core.applyStaticLang(); App.io.syncFullscreen();
    App.geom.buildDefs(); App.interact.buildLib(); App.draw2d.renderOpenings(); App.draw2d.renderDims();
    App.core.$('#tip').textContent = App.io.TIPS()['2d'];
    App.interact.fitView(); App.draw2d.renderAll();
    projectBoot = (async () => {
      await App.io.hydrateDefaultPlan();
      let recent, tabId;
      try {
        recent = JSON.parse(localStorage.getItem(projectActiveKey) || 'null');
        tabId = sessionStorage.getItem(projectActiveKey);
      } catch(e){}
      try {
        const rows = await projectTransaction('readonly', store => store.getAll());
        rows.forEach(row => projectRows.set(row.id, row));
      } catch(e){ projectStorageIssue = true; }
      const id = tabId || recent?.id, row = projectRows.get(id);
      activeProjectId = id || App.geom.uid();
      if (row?.snapshot && !(recent?.id === id && recent.updatedAt >= row.updatedAt && App.io.hasStoredPlan())){
        if (loadProjectScene(row.snapshot).ok) refreshProjectScene();
      }
      if (!row) projectRows.set(activeProjectId, {id:activeProjectId, createdAt:Date.now()});
      App.store.onProjectSave = saveActiveProject;
      App.store.save();
      renderProjects();
      scheduleProjectSync(0);
    })();
  }

  Object.assign(App.projects, {
    projectEndpoint, projectRows, putProject, openNewProject, sceneSignature, renderProjects,
    projectImportSubmitted, openProjects,
  });
  Object.defineProperties(App.projects, {
    activeProjectId: {get: () => activeProjectId},
  });
  initialize();
})();
