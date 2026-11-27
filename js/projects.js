/* 项目、多方案、后台识别和项目存储。
 * 依赖 App.core、App.plan、App.store、App.geom、App.draw2d、App.panel、App.interact、App.io、App.assistant、App.importer。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 项目与后台识别 ======================= */
  const projectEndpoint = App.core.studioPath('/api/jobs/plan-import');
  const projectActiveKey = 'interior-active-project-v1' + App.core.projectScope;
  const projectOrderKey = 'interior-project-order-v1' + App.core.projectScope;
  const projectRows = new Map();
  const jobProgress = new Map();
  const projectOpening = new Set();
  const expandedProjects = new Map();
  const projectPanel = App.core.$('#projectPanel'), projectToggle = App.core.$('#projectToggle'), projectList = App.core.$('#projectList');
  const projectSearch = App.core.$('#projectSearch'), projectSort = App.core.$('#projectSort');
  const renameForm = App.core.$('#projectRenameForm'), renameInput = App.core.$('#projectRenameInput');
  const nameSubmit = renameForm.querySelector('[type="submit"]'), newProject = App.core.$('#projectNew');
  const projectPending = row => row.phase === 'queued' || row.phase === 'running';
  const projectReview = row => row?.review && typeof row.review === 'object' ? row.review : null;
  const projectReviewPending = row => ['pending', 'running'].includes(projectReview(row)?.state);
  const projectBusy = row => projectPending(row) || projectReviewPending(row);
  const projectAi = App.core.PUBLIC_ACCESS !== 'guest' && /^https?:$/.test(location.protocol);
  const schemeHistory = new Map();
  const baselineRecovery = new Set();
  const projectWrites = new Map();
  let pendingSceneSave = false;
  let activeProjectId = '', activeSchemeId = '', projectSwitching = false, projectStorageIssue = false, projectSyncIssue = '';
  let projectTimer = 0, projectSyncing = false, projectSyncAgain = false;
  let renderedProjectRows = '', namingProject = '', projectSorting = false, draggedProjectId = '';

  function parseProjectOrder(raw){
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) return [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 128))];
    } catch(e){}
    return [];
  }
  let projectOrder = [];
  try { projectOrder = parseProjectOrder(localStorage.getItem(projectOrderKey)); } catch(e){}

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
  async function updateStoredProject(id, update, {optimistic, memoryFallback = false} = {}){
    const write = (projectWrites.get(id) || 0) + 1;
    projectWrites.set(id, write);
    if (optimistic) projectRows.set(id, optimistic);

    let row;
    try {
      const db = await projectDb;
      if (!db && memoryFallback){
        row = optimistic || update(projectRows.get(id));
      } else {
        if (!db) throw new Error('Project storage unavailable');
        row = await new Promise((resolve, reject) => {
          const transaction = db.transaction('projects', 'readwrite');
          const store = transaction.objectStore('projects');
          const request = store.get(id);
          let result, error;
          request.onsuccess = () => {
            try {
              result = update(request.result);
              if (result) store.put(result);
            } catch(e){
              error = e;
              transaction.abort();
            }
          };
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = transaction.onerror = () => reject(error || transaction.error || request.error);
        });
      }
    } catch(e){
      projectStorageIssue = true;
      renderProjects();
      return null;
    }
    if (row && projectWrites.get(id) === write) projectRows.set(id, row);
    return row || null;
  }
  async function putProject(row){
    return Boolean(await updateStoredProject(row.id, () => row, {optimistic:row, memoryFallback:true}));
  }

  const sceneKey = (projectId, schemeId) => `${projectId}:${schemeId}`;
  const activeSceneKey = () => activeSchemeId ? sceneKey(activeProjectId, activeSchemeId) : '';
  function getActiveProject(){
    const row = projectRows.get(activeProjectId);
    return row && row.activeSchemeId !== activeSchemeId ? {...row,activeSchemeId} : row || null;
  }
  const savedProject = row => Boolean(row?.schemes?.length || row?.snapshot);
  const selectedScheme = row => row?.schemes?.find(scheme => scheme.id === row.activeSchemeId) || row?.schemes?.[0];
  const selectedSnapshot = row => selectedScheme(row)?.snapshot || row?.snapshot;
  const initialName = number => App.core.tr('方案' + ('一二三四五六七八九十'[number - 1] || ' ' + number), 'Scheme ' + number);
  const cleanName = name => typeof name === 'string' ? name.trim().slice(0, 60) : '';
  const newProjectId = () => globalThis.crypto?.randomUUID?.() || App.geom.uid();
  function nextSchemeNumber(row, requestedName = ''){
    let number = row.nextSchemeNumber || row.schemes.length + 1;
    while (row.schemes.some(scheme => scheme.id === `scheme-${number}` ||
      (!requestedName && scheme.name === initialName(number)))) number++;
    return number;
  }
  function defaultSchemeName(){
    const row = getActiveProject();
    return initialName(row ? nextSchemeNumber(row) : 1);
  }

  function updateScheme(row, id, update){
    return {...row, schemes:row.schemes.map(scheme => scheme.id === id ? {...scheme,...update} : scheme)};
  }
  function updateSchemesUI(){
    renderProjects();
    App.schemesUI?.render?.();
  }
  function projectWithFirstScheme(row, snapshot, baselineSource, reviewVersion){
    const {result, customName, snapshot:oldSnapshot, reviewApplied, reviewAppliedSig, reviewAppliedReview, ...metadata} = row;
    const time = row.updatedAt || Date.now();
    const id = 'scheme-1';
    const scheme = {
      id, name:initialName(1), snapshot, origin:oldSnapshot ? 'legacy' : 'initial',
      createdAt:row.createdAt || time, updatedAt:time,
    };
    if (reviewApplied){
      Object.assign(scheme, {reviewApplied, reviewAppliedSig, reviewAppliedReview});
    } else if (Number.isFinite(reviewVersion)){
      Object.assign(scheme, {reviewApplied:true, reviewAppliedSig:null, reviewAppliedReview:reviewVersion});
    }
    return {
      ...metadata,
      name:row.customName || row.name || snapshot.plan?.name || App.core.tr('未命名项目', 'Untitled project'),
      phase:'saved', activeSchemeId:id, nextSchemeNumber:2,
      baseline:App.core.deepCopy(snapshot), baselineSource, schemes:[scheme],
      updatedAt:time,
    };
  }
  function migrateSavedProject(row){
    return row?.snapshot && !row.schemes?.length ? projectWithFirstScheme(row, row.snapshot, 'saved') : row;
  }
  async function recoverLegacyBaseline(row){
    if (!projectAi || row.baselineSource !== 'saved' || !row.jobId || baselineRecovery.has(row.id)) return;
    baselineRecovery.add(row.id);
    try {
      const {plan,furniture,ceiling,ceilingMeta} = await projectResult(row);
      const baseline = App.io.snapshotFromRecognition(plan, furniture, {ceiling, ceilingMeta});
      if (!baseline) return;
      const recovered = await updateStoredProject(row.id, current =>
        current?.baselineSource === 'saved' && current.jobId === row.jobId
          ? {...current, baseline, baselineSource:'recognized'} : null);
      if (recovered) updateSchemesUI();
    } catch(e){}  // 已保存的旧方案仍可作为项目底稿。
  }

  function projectCurrent(row = getActiveProject()){
    if (!row || !row.schemes?.some(scheme => scheme.id === activeSchemeId)) return null;
    const snapshot = App.io.studio.projectJSON();
    const updatedAt = Date.now();
    return updateScheme({...row, activeSchemeId, updatedAt}, activeSchemeId, {snapshot, updatedAt});
  }
  function projectRecordActive(row){
    const pointer = {id:row.id, schemeId:row.activeSchemeId, updatedAt:row.updatedAt};
    try {
      const value = JSON.stringify(pointer);
      sessionStorage.setItem(projectActiveKey, value);
      localStorage.setItem(projectActiveKey, value);
    } catch(e){}
  }
  function writeSceneSnapshot(row, {optimistic = true, memoryFallback = false, preserveSelection = false} = {}){
    const scene = selectedScheme(row);
    return updateStoredProject(row.id, stored => {
      const current = migrateSavedProject(stored) || row;
      if (!current.schemes?.some(scheme => scheme.id === scene.id)) return null;
      const activeSchemeId = preserveSelection ? current.activeSchemeId : scene.id;
      return updateScheme({...current, activeSchemeId, updatedAt:Date.now()}, scene.id, {
        snapshot:scene.snapshot, updatedAt:scene.updatedAt,
      });
    }, {optimistic:optimistic ? row : undefined, memoryFallback});
  }
  function saveActiveProject(){
    if (projectSwitching){ pendingSceneSave = true; return; }
    pendingSceneSave = false;
    const row = projectCurrent();
    if (!row) return;
    projectRecordActive(row);
    void writeSceneSnapshot(row, {memoryFallback:true}).then(updateSchemesUI);
    updateSchemesUI();
  }
  async function flushActiveProject(){
    await projectBoot;
    if (projectSwitching) return null;
    const row = projectCurrent();
    if (!row) return null;
    const saved = await writeSceneSnapshot(row);
    updateSchemesUI();
    return saved;
  }

  function loadProjectScene(snapshot){
    const result = App.plan.sanitizePlan(snapshot?.plan);
    if (!result.ok) return result;
    App.store.installPlan(result.plan);
    const state = App.core.deepCopy(snapshot.state || {});
    App.store.state = App.store.fixState({...state, renders:Array.isArray(state.renders) ? state.renders : []});
    return result;
  }
  function saveSchemeHistory(){
    const key = activeSceneKey();
    if (key) schemeHistory.set(key, {undo:App.store.undoStack.slice(), redo:App.store.redoStack.slice()});
  }
  function refreshProjectScene(){
    App.dimensions.clearDraft();
    App.dimensions.closeEditor();
    clearTimeout(App.assistant.chatState.focusT);
    App.assistant.resetChatHistory();
    App.assistant.resetRenderReference({closeOutput:true});
    App.assistant.renderState.last = null;
    App.assistant.renderEls.out.removeAttribute('src');
    App.assistant.renderEls.outCap.textContent = ''; App.assistant.renderEls.actions.hidden = true;
    App.assistant.renderErr(''); App.assistant.renderStatus('', false);
    const last = App.store.state.renders.at(-1);
    if (last) App.assistant.renderShowRec(last, false);
    else { App.assistant.renderHistory(); App.assistant.renderAvailability(); }
    App.assistant.chatPane('props');
    const history = schemeHistory.get(activeSceneKey());
    App.store.undoStack.splice(0, App.store.undoStack.length, ...(history?.undo || []));
    App.store.redoStack.splice(0, App.store.redoStack.length, ...(history?.redo || []));
    App.store.ui.sel = App.store.ui.mA = App.store.ui.mCur = null;
    App.view3d?.resetWalk();
    App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings(); App.draw2d.renderAll(); App.io.refit();
    if (App.io.studio.is3D()) App.view3d?.flyIso?.();
  }

  async function changeProjectScene(targetId, prepare, {closePanel = false, memoryFallback = false} = {}){
    await projectBoot;
    if (projectSwitching || document.body.classList.contains('busy') || App.assistant.chatState.sending || App.assistant.renderState.busy){
      const message = App.core.tr('请等当前操作完成后再切换方案。', 'Finish the current operation before switching schemes.');
      App.core.toast(message);
      return {ok:false, errors:[]};
    }

    projectSwitching = true;
    try {
      App.view3d?.rememberWalkExit();
      pendingSceneSave = false;
      const leavingProject = activeProjectId !== targetId;
      if (leavingProject){
        const previous = projectCurrent();
        if (previous && !await writeSceneSnapshot(previous, {memoryFallback})) return {ok:false, errors:[]};
      }

      let errors = [];
      const saved = await updateStoredProject(targetId, stored => {
        const current = migrateSavedProject(stored ?? projectRows.get(targetId));
        const captured = leavingProject ? null : projectCurrent(current);
        const candidate = prepare(captured || current);
        if (!candidate) return null;
        const scheme = selectedScheme(candidate);
        const result = App.plan.sanitizePlan(scheme?.snapshot?.plan);
        if (!result.ok){ errors = result.errors; return null; }
        if (captured) pendingSceneSave = false;
        return candidate;
      }, {memoryFallback});
      if (!saved) return {ok:false, errors};
      const scheme = selectedScheme(saved);
      if (saved.id === activeProjectId && scheme.id === activeSchemeId) return {ok:true, scheme};

      let selectedProject = saved;
      while (pendingSceneSave){
        // 保存事务期间发生的最后一次编辑仍归离开的方案。
        pendingSceneSave = false;
        const current = leavingProject ? getActiveProject() : selectedProject;
        const previous = current?.schemes.some(item => item.id === activeSchemeId) && projectCurrent(current);
        if (previous){
          const written = await writeSceneSnapshot(previous, {memoryFallback, preserveSelection:!leavingProject});
          if (!written) return {ok:false, errors:[]};
          if (!leavingProject) selectedProject = written;
        }
      }
      const result = loadProjectScene(scheme.snapshot);
      if (!result.ok) return result;

      saveSchemeHistory();
      activeProjectId = saved.id;
      activeSchemeId = scheme.id;
      projectRows.set(saved.id, selectedProject);
      refreshProjectScene();
      // 活动指针在目标方案与离开前的设计成功写入后更新。
      App.store.save();
      let active = projectCurrent();
      if (scheme.reviewAppliedSig === null){
        active = updateScheme(active, scheme.id, {reviewAppliedSig:sceneSignature(selectedScheme(active).snapshot)});
        void updateStoredProject(active.id, latest => latest && updateScheme(latest,scheme.id, {
          reviewAppliedSig:sceneSignature(selectedScheme(active).snapshot),
        }), {optimistic:active, memoryFallback});
      }
      projectRecordActive(active);
      if (closePanel) closeProjects();
      void recoverLegacyBaseline(active);
      return {...result, scheme:selectedScheme(active)};
    } finally {
      projectSwitching = false;
      if (pendingSceneSave) saveActiveProject();
      updateSchemesUI();
    }
  }

  async function switchProject(row, {snapshot, reviewVersion} = {}){
    return changeProjectScene(row.id, stored => {
      const current = stored || row;
      if (current.hidden || current.jobId !== row.jobId) return null;
      if (savedProject(current)) return current;
      return snapshot && projectWithFirstScheme(current, snapshot, current.jobId ? 'recognized' : 'blank', reviewVersion);
    }, {closePanel:true, memoryFallback:true});
  }
  async function openNewProject(snapshot){
    const row = {id:newProjectId(), name:snapshot.plan.name, createdAt:Date.now()};
    const result = await switchProject(row, {snapshot});
    if (!result.ok && result.errors?.[0]) App.core.toast(result.errors[0]);
    return result.ok;
  }

  async function switchScheme(id){
    const expectedSceneKey = activeSceneKey();
    const result = await changeProjectScene(activeProjectId, row => row && activeSceneKey() === expectedSceneKey &&
      row.schemes.some(scheme => scheme.id === id) ? {...row,activeSchemeId:id} : null);
    return result.ok;
  }
  async function createScheme({from = 'baseline', name, snapshot, origin, expectedSceneKey, reviewVersion} = {}){
    const sourceKey = expectedSceneKey ?? activeSceneKey();
    const requestedName = cleanName(name);
    const result = await changeProjectScene(activeProjectId, row => {
      if (!row || activeSceneKey() !== sourceKey ||
          (requestedName && row.schemes.some(scheme => scheme.name === requestedName))) return null;
      const source = row.schemes.find(scheme => scheme.id === activeSchemeId);
      if (!source) return null;
      const scene = App.core.deepCopy(snapshot || (from === 'current' ? source.snapshot : row.baseline));
      if (!scene?.plan) return null;
      scene.state = {...scene.state, renders:[]};
      const createdAt = Date.now();
      const number = nextSchemeNumber(row, requestedName);
      const scheme = {
        id:`scheme-${number}`, name:requestedName || initialName(number), snapshot:scene,
        origin:origin || (from === 'current' ? 'copy' : 'baseline'), createdAt, updatedAt:createdAt,
        ...(from === 'current' ? {copiedFrom:source.name} : {}),
      };
      if (Number.isFinite(reviewVersion)){
        Object.assign(scheme, {reviewApplied:true, reviewAppliedSig:null, reviewAppliedReview:reviewVersion});
      }
      return {...row, schemes:[...row.schemes,scheme], activeSchemeId:scheme.id, nextSchemeNumber:number+1};
    });
    return result.ok ? result.scheme : null;
  }
  async function renameScheme(id, name){
    const sourceKey = activeSceneKey();
    await projectBoot;
    const row = getActiveProject(), nextName = cleanName(name);
    if (projectSwitching || activeSceneKey() !== sourceKey || !nextName || !row) return false;
    const saved = await updateStoredProject(row.id, stored => {
      const current = migrateSavedProject(stored);
      if (!current?.schemes.some(scheme => scheme.id === id) ||
          current.schemes.some(scheme => scheme.id !== id && scheme.name === nextName)) return null;
      return updateScheme({...current, updatedAt:Date.now()}, id, {name:nextName});
    });
    updateSchemesUI();
    return Boolean(saved);
  }
  async function deleteScheme(id){
    const sourceKey = activeSceneKey();
    await projectBoot;
    const row = getActiveProject();
    if (projectSwitching || activeSceneKey() !== sourceKey || !row) return false;
    const remove = current => {
      const schemes = current?.schemes;
      if (!schemes || schemes.length < 2) return null;
      const index = schemes.findIndex(scheme => scheme.id === id);
      if (index < 0) return null;
      const remaining = schemes.filter(scheme => scheme.id !== id);
      return {...current, schemes:remaining, updatedAt:Date.now(),
        activeSchemeId:current.activeSchemeId === id
          ? remaining[Math.min(index, remaining.length - 1)].id : current.activeSchemeId};
    };
    if (id === activeSchemeId){
      const result = await changeProjectScene(row.id, current => activeSceneKey() === sourceKey ? remove(current) : null);
      if (!result.ok) return false;
    } else if (!await updateStoredProject(row.id, current => remove(migrateSavedProject(current)))) return false;
    schemeHistory.delete(sceneKey(row.id, id));
    updateSchemesUI();
    return true;
  }
  async function renameProject(name){
    const id = activeProjectId;
    await projectBoot;
    const row = getActiveProject(), nextName = cleanName(name);
    if (projectSwitching || activeProjectId !== id || !row || !nextName) return false;
    const saved = await updateStoredProject(id, current =>
      current && {...current, name:nextName, updatedAt:Date.now()}, {memoryFallback:true});
    if (saved){
      App.draw2d.renderAll();
      updateSchemesUI();
    }
    return Boolean(saved);
  }

  function projectSchemesJSON(){
    const row = projectCurrent();
    if (!row) return null;
    const {name, baseline, baselineSource, schemes, activeSchemeId, nextSchemeNumber} = row;
    return App.core.deepCopy({version:3, name, baseline, baselineSource, schemes, activeSchemeId, nextSchemeNumber});
  }
  function importSnapshot(snapshot){
    const result = App.plan.sanitizePlan(snapshot?.plan);
    if (!result.ok || (snapshot.state != null && (typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)))) return null;
    return {version:2, plan:result.plan, state:App.core.deepCopy(snapshot.state || {})};
  }
  async function openImportedProject(data){
    const invalid = () => {
      App.core.toast(App.core.tr('完整项目文件包含无效的底稿或方案。', 'The project file contains an invalid baseline or scheme.'));
      return false;
    };
    const name = cleanName(data?.name);
    const baseline = importSnapshot(data?.baseline);
    if (!name || !baseline || !Array.isArray(data.schemes) || !data.schemes.length) return invalid();

    const ids = new Set(), names = new Set(), schemes = [], time = Date.now();
    for (const scheme of data.schemes){
      const snapshot = importSnapshot(scheme?.snapshot), schemeName = cleanName(scheme?.name);
      if (!snapshot || !schemeName || typeof scheme.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,48}$/.test(scheme.id) || ids.has(scheme.id) || names.has(schemeName)) return invalid();
      ids.add(scheme.id);
      names.add(schemeName);
      schemes.push({
        id:scheme.id, name:schemeName, snapshot,
        origin:['initial','legacy','copy','baseline','review'].includes(scheme.origin) ? scheme.origin : 'legacy',
        ...(cleanName(scheme.copiedFrom) ? {copiedFrom:cleanName(scheme.copiedFrom)} : {}),
        createdAt:Number.isFinite(scheme.createdAt) ? scheme.createdAt : time,
        updatedAt:Number.isFinite(scheme.updatedAt) ? scheme.updatedAt : time,
      });
    }
    const row = {
      id:newProjectId(), name, baseline, schemes, phase:'saved', createdAt:time, updatedAt:time,
      baselineSource:['recognized','saved','blank'].includes(data.baselineSource) ? data.baselineSource : 'saved',
      activeSchemeId:ids.has(data.activeSchemeId) ? data.activeSchemeId : schemes[0].id,
      nextSchemeNumber:Number.isSafeInteger(data.nextSchemeNumber) && data.nextSchemeNumber > 0 &&
        data.nextSchemeNumber < Number.MAX_SAFE_INTEGER - schemes.length ? data.nextSchemeNumber : schemes.length + 1,
    };
    const result = await switchProject(row);
    return result.ok;
  }
  async function startBlankProject(name, request){
    const plan = await App.io.loadPlanFile('data/empty-plan.json') || App.plan.FALLBACK_PLAN;
    if (namingProject === request && renameInput.value.trim() === name){
      await openNewProject({plan:{...plan, name}});
    }
  }

  function projectFormatTime(value){
    return new Intl.DateTimeFormat(App.core.LANG === 'en' ? 'en' : App.core.LANG === 'zht' ? 'zh-TW' : 'zh-CN',
      {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(value);
  }

  function orderedProjects(){
    const positions = new Map(projectOrder.map((id, index) => [id,index]));
    return [...projectRows.values()].filter(row => !row.hidden).sort((a,b) =>
      (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      Number(b.id === activeProjectId) - Number(a.id === activeProjectId) || b.updatedAt - a.updatedAt);
  }
  const projectSearchKey = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  function projectPartialMatch(name, query){
    if (name.includes(query)) return true;
    let start = 0;
    for (const character of query){
      const next = name.indexOf(character, start);
      if (next === -1) return false;
      start = next + character.length;
    }
    return true;
  }
  function visibleProjects(rows){
    const terms = projectSearch.value.normalize('NFKC').split(/\s+/u).map(projectSearchKey).filter(Boolean);
    if (!terms.length) return rows;
    return rows.filter(row => {
      const keys = [row.name,row.sourceName].map(projectSearchKey);
      return terms.every(term => keys.some(name => projectPartialMatch(name,term)));
    });
  }
  function moveProject(id, targetId, after){
    const rows = orderedProjects(), matches = visibleProjects(rows).map(row => row.id);
    if (id === targetId || !matches.includes(id) || !matches.includes(targetId)) return;
    const reordered = matches.filter(key => key !== id);
    reordered.splice(reordered.indexOf(targetId) + Number(after), 0, id);
    if (reordered.every((key,index) => key === matches[index])) return;
    const visible = new Set(matches);
    let index = 0;
    projectOrder = rows.map(row => visible.has(row.id) ? reordered[index++] : row.id);
    try { localStorage.setItem(projectOrderKey, JSON.stringify(projectOrder)); }
    catch(e){ projectStorageIssue = true; }
    renderProjects();
  }

  // 应用修正时记录户型、家具与顶面几何，效果图等字段不参与。
  function sceneSignature(snapshot, includeCeiling = true){
    const plan = snapshot?.plan ? {...snapshot.plan} : null;
    if (plan){
      delete plan.name;
      if (plan.materials){
        plan.materials = Object.fromEntries(Object.entries(plan.materials)
          .map(([key, {price, ...material}]) => [key, material]));
      }
    }
    return JSON.stringify({
      plan,
      furniture:snapshot?.state?.furniture ?? [],
      demolished:snapshot?.state?.demolished ?? [],
      ...(includeCeiling ? {ceiling:snapshot?.state?.ceiling ?? null} : {}),
    });
  }
  // 「已应用」只在场景与复核版本都还是应用时那一份时有效；撤销、编辑或复核重跑后自动失效。
  function projectReviewApplied(row){
    const scheme = selectedScheme(row) || row;
    if (!scheme?.reviewApplied) return false;
    if (Number.isFinite(+scheme.reviewAppliedReview) &&
        +scheme.reviewAppliedReview !== (+projectReview(row)?.updatedAt || 0)) return false;
    if (!scheme.reviewAppliedSig) return true;
    const snapshot = scheme.snapshot;
    if (!snapshot) return false;
    const current = sceneSignature(snapshot);
    if (scheme.reviewAppliedSig === current) return true;
    try {
      const legacy = JSON.parse(scheme.reviewAppliedSig);
      const includeCeiling = Object.hasOwn(legacy, 'ceiling');
      return sceneSignature({plan:legacy.plan,state:legacy}, includeCeiling) ===
        (includeCeiling ? current : sceneSignature(snapshot, false));
    } catch(e){ return false; }
  }
  const sameReview = (a, b) => (a?.state || '') === (b?.state || '') &&
    (+a?.count || 0) === (+b?.count || 0) && (+a?.updatedAt || 0) === (+b?.updatedAt || 0);
  function projectReviewMessage(row){
    const review = projectReview(row);
    if (!review) return '';
    const count = Number.isFinite(+review.count) ? +review.count : 0;
    const differ = App.core.tr(`自动复核发现 ${count} 项需要核对的内容。`,
      count === 1 ? 'Auto review found 1 item to check.' : `Auto review found ${count} items to check.`);
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
    const snapshot = selectedSnapshot(row);
    const plan = snapshot?.plan || row.result?.plan;
    if (plan) {
      const rooms = plan.rooms.filter(room => room.counted !== false).length;
      const count = (snapshot?.state?.furniture || row.result?.furniture || []).length;
      const designCount = savedProject(row) ? row.schemes?.length || 1 : 0;
      const details = App.core.tr(`${rooms} 个房间 · ${count} 件家具与构件`, `${rooms} rooms · ${count} furnishings and components`);
      return designCount ? App.core.tr(`${designCount} 个方案 · ${details}`, `${designCount} ${designCount === 1 ? 'scheme' : 'schemes'} · ${details}`) : details;
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
    const reviewReady = (review?.state === 'differ' && !projectReviewApplied(row)) ||
      (review?.state === 'match' && row.baseline?.state?.ceilingMeta);
    const reviewButton = row.phase === 'saved' && row.jobId && reviewReady
      ? button('review', App.core.tr('查看图纸复核', 'View drawing review')) : '';
    const rename = button('rename', App.core.tr('重命名','Rename'));
    if (row.id === activeProjectId) return reviewButton + rename + rerunButton;
    if (projectPending(row)) return rename + button('cancel', App.core.tr('取消识别', 'Cancel analysis'));
    if (row.phase === 'done') return button('preview', App.core.tr('查看识别结果', 'Review result'), true) + rename + rerunButton;
    if (row.phase === 'failed' || row.phase === 'canceled'){
      return button('retry', App.core.tr('重新导入', 'Import again'), true) + rename + button('hide', App.core.tr('移除记录', 'Remove entry'));
    }
    return button('open', App.core.tr('打开项目', 'Open project'), true) + rename + reviewButton + rerunButton;
  }

  const findProjectRow = id => [...projectList.children].find(el => el.dataset.projectId === id);
  function syncProjectNameForm(){
    const {tr} = App.core;
    nameSubmit.textContent = typeof namingProject === 'symbol' ? tr('创建','Create') : tr('保存','Save');
  }
  function beginProjectName(action, name){
    namingProject = action;
    renameInput.value = name;
    renameInput.setCustomValidity('');
    renameForm.hidden = false;
    syncProjectNameForm();
    renameInput.focus(); renameInput.select();
  }
  function beginProjectRename(row){ beginProjectName(row.id, row.name); }
  function beginNewProject(){
    const existing = new Set([...projectRows.values()].filter(row => !row.hidden).map(row => row.name));
    const title = App.core.tr('新项目','New project');
    let name = title;
    for(let n = 2; existing.has(name); n++) name = `${title} ${n}`;
    beginProjectName(Symbol('new project'), name);
  }
  function closeProjectRename(returnFocus = false){
    const action = namingProject;
    renameForm.hidden = true;
    namingProject = '';
    if (returnFocus){
      const button = typeof action === 'symbol' ? newProject : findProjectRow(action)?.querySelector('[data-project-action="rename"]');
      (button || projectSearch).focus();
    }
  }
  async function submitProjectName(event){
    event.preventDefault();
    const action = namingProject, name = renameInput.value.trim();
    if (!action || projectSwitching || nameSubmit.disabled) return;
    if (!name){
      renameInput.setCustomValidity(App.core.tr('请输入项目名称。','Enter a project name.'));
      renameInput.reportValidity();
      return;
    }
    if (typeof action === 'symbol'){
      nameSubmit.disabled = true;
      try { await startBlankProject(name, action); }
      finally { nameSubmit.disabled = false; }
      return;
    }
    const row = projectRows.get(action);
    if (!row || row.hidden) return;
    if (name === row.name){ closeProjectRename(true); return; }
    closeProjectRename();
    if (row.id === activeProjectId) await renameProject(name);
    else await updateStoredProject(row.id, current => {
      if (!current || current.hidden) return null;
      return savedProject(current) ? {...current, name, updatedAt:Date.now()}
        : {...current, name, sourceName:current.sourceName || current.name, customName:name};
    }, {memoryFallback:true});
    renderProjects();
    if (!projectPanel.hidden && !namingProject) (findProjectRow(row.id)?.querySelector('[data-project-action="rename"]') || projectSearch).focus();
  }

  function projectSortRow(row, title, index, length){
    const {tr,esc} = App.core;
    return `<div class="project-row project-sort-row" data-project-id="${esc(row.id)}">
      <span class="project-drag-handle" data-project-drag draggable="true" aria-hidden="true" title="${esc(tr('拖动调整顺序','Drag to reorder'))}"></span>
      ${title}${row.id === activeProjectId ? `<span class="project-status is-ready">${esc(tr('当前','Current'))}</span>` : ''}
      <div class="project-sort-actions">
        <button class="btn" type="button" data-project-move="up" aria-label="${esc(tr('上移','Move up') + ' ' + row.name)}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn" type="button" data-project-move="down" aria-label="${esc(tr('下移','Move down') + ' ' + row.name)}" ${index === length - 1 ? 'disabled' : ''}>↓</button>
      </div></div>`;
  }
  function renderProjects(){
    const {tr,esc} = App.core, allProjects = orderedProjects();
    const pending = allProjects.filter(projectBusy).length, count = App.core.$('#projectCount');
    count.hidden = pending === 0;
    count.textContent = pending > 99 ? '99+' : String(pending);
    projectToggle.setAttribute('aria-label', pending
      ? App.core.tr(`项目，${pending} 个任务进行中`, `Projects, ${pending} tasks in progress`) : App.core.tr('项目','Projects'));
    if (projectPanel.hidden || draggedProjectId) return;
    if (!renameForm.hidden) syncProjectNameForm();
    const rows = visibleProjects(allProjects);
    const searchLabel = tr('搜索项目','Search projects');
    projectSearch.placeholder = searchLabel; projectSearch.setAttribute('aria-label',searchLabel);
    projectSort.textContent = projectSorting ? tr('完成','Done') : tr('排序','Reorder');
    projectSort.setAttribute('aria-pressed',String(projectSorting));
    projectSort.disabled = !projectSorting && rows.length < 2;
    const warning = App.core.$('#projectWarning');
    warning.textContent = projectSyncIssue || (projectStorageIssue
      ? App.core.tr('浏览器存储不可用，项目请及时导出备份。', 'Browser storage is unavailable. Export projects to keep a copy.') : '');
    warning.hidden = !warning.textContent;
    const empty = App.core.$('#projectEmpty');
    empty.hidden = rows.length > 0;
    empty.querySelector('strong').textContent = allProjects.length ? tr('没有匹配的项目','No matching projects')
      : tr('还没有项目','No projects yet');
    for (const el of projectList.children) if (el.matches('details')) expandedProjects.set(el.dataset.projectId, el.open);
    const focus = document.activeElement, focusRow = focus?.closest('[data-project-id]')?.dataset.projectId;
    const scroll = projectList.scrollTop;
    const markup = rows.map((row,index) => {
      const title = `<span class="project-row-title"><b title="${esc(row.name)}">${esc(row.name)}</b><span class="project-row-meta">${esc(projectFormatTime(row.createdAt || row.updatedAt))}</span></span>`;
      if (projectSorting) return projectSortRow(row,title,index,rows.length);
      const [status, tone] = projectStatus(row), detail = projectDetails(row), note = projectReviewMessage(row);
      const review = projectReview(row);
      const chip = row.jobId && review?.state === 'differ' && !projectReviewApplied(row) &&
        (row.phase === 'done' || row.phase === 'saved')
        ? `<span class="project-chip is-diff">${App.core.esc(App.core.tr('有差异', 'Differences'))}</span>`
        : row.jobId && projectReviewPending(row) &&
          (row.phase === 'done' || row.phase === 'saved')
          ? `<span class="project-chip is-review">${App.core.esc(App.core.tr('复核中', 'Reviewing'))}</span>` : '';
      const icon = projectPending(row) || projectOpening.has(row.id) ? 'project-spinner' : 'project-folder';
      return `<details class="project-row" data-project-id="${App.core.esc(row.id)}" ${(expandedProjects.get(row.id) ?? projectBusy(row)) ? 'open' : ''}>
      <summary class="project-row-head"><span class="project-row-icon" aria-hidden="true"><i class="${icon}"></i></span>
        ${title}
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
      const node = findProjectRow(focusRow);
      const action = focus.dataset.projectAction, move = focus.dataset.projectMove;
      const restored = node?.querySelector(action ? `[data-project-action="${action}"]` : move ? `[data-project-move="${move}"]` : 'summary');
      (restored && !restored.disabled ? restored : node?.querySelector('summary, [data-project-move]:not(:disabled)'))?.focus({preventScroll:true});
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
      // 旧任务仍可复核。把当前查看或等待中的项目加入查询，避免受最近任务列表的数量限制。
      const ids = [...new Set([...projectRows.values()]
        .filter(row => !row.hidden && row.jobId &&
          (projectBusy(row) || row.id === activeProjectId || expandedProjects.get(row.id) === true))
        .map(row => row.jobId))].slice(0, 64);
      const query = new URLSearchParams(ids.map(id => ['id', id])).toString();
      const endpoint = query ? `${projectEndpoint}?${query}` : projectEndpoint;
      const response = await fetch(endpoint, {cache:'no-store', signal:AbortSignal.timeout(12000)});
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
        if (savedProject(prev)){
          const latest = job.review === undefined ? (prev.review ?? null) : review;
          const sourceName = prev.sourceName || meta.name;
          if (!sameReview(prev.review, latest) || prev.sourceName !== sourceName){
            await updateStoredProject(prev.id, current => current?.jobId === job.id && !current.hidden
              ? {...current, sourceName:current.sourceName || sourceName,
                review:job.review === undefined ? current.review : review} : null, {memoryFallback:true});
          }
          continue;
        }
        const id = prev?.id || job.id;
        let result = prev?.result, error = prev?.error;
        if ((job.phase === 'done' && !result) || (job.phase === 'failed' && !error)){
          try { result = await projectResult({jobId:job.id}); }
          catch(e){ if (job.phase === 'failed') error = e.message; }
        }
        const latest = projectRows.get(id);
        if (latest && (latest.jobId !== job.id || latest.hidden || savedProject(latest))) continue;
        const row = {...meta, ...latest, id, jobId:job.id, result, error,
          name:latest?.customName || result?.plan?.name || latest?.name || meta.name,
          sourceName:latest?.sourceName || meta.name, phase:job.phase, startedAt:job.startedAt, updatedAt:job.updatedAt,
          review:job.review === undefined ? (latest?.review ?? null) : review};
        if (!latest || latest.phase !== row.phase || latest.name !== row.name || latest.sourceName !== row.sourceName ||
            row.result !== latest.result || row.error !== latest.error || latest.updatedAt !== row.updatedAt ||
            !sameReview(latest.review, row.review)){
          await updateStoredProject(row.id, stored => {
            if (stored && (stored.hidden || stored.jobId !== job.id)) return null;
            if (savedProject(stored)) return {...stored, sourceName:stored.sourceName || row.sourceName,
              review:job.review === undefined ? stored.review : review};
            return {...row, ...(stored?.customName ? {name:stored.customName,customName:stored.customName} : {})};
          }, {memoryFallback:true});
        }
      }
      for (const row of projectRows.values()){
        const waiting = projectPending(row) || (row.phase === 'done' && !row.result);
        if (waiting && !seen.has(row.jobId) && Date.now() - row.createdAt > 120000){
          await updateStoredProject(row.id, current => current?.jobId === row.jobId && !savedProject(current)
            ? {...current, phase:'failed', error:App.core.tr('这条任务记录已过期，请重新导入。','This job expired. Import the drawing again.')} : null, {memoryFallback:true});
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
    const retry = projectRows.get(retryId);
    const prev = (!savedProject(retry) && retry) || projectRows.get(jobId);
    const id = prev?.id || jobId;
    const sourceName = name;
    await putProject({
      id, jobId, name:prev?.customName || name.replace(/\.[a-z\d]{1,8}$/i, '') || name, sourceName, note,
      customName:prev?.customName,
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
        await updateStoredProject(row.id, stored => stored?.jobId === row.jobId && !stored.hidden && sameReview(stored.review, row.review)
          ? {...stored, review:{...(stored.review || {}), state:'pending', count:0, updatedAt:Date.now()}} : null, {memoryFallback:true});
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
      const data = await response.json().catch(() => null);
      App.core.toast(data?.error || App.core.tr('复核暂不可用，可重新导入图纸。',
        'The review is unavailable. You can import the drawing again.'));
      return;
    }
    if (response.status === 503){
      App.core.toast(App.core.tr('codex 不可用，暂时无法复核。', 'codex is unavailable, so the review cannot run right now.'));
      return;
    }
    App.core.toast(App.core.tr('无法开始复核，请稍后重试。', 'Could not start the review. Try again later.'));
  }

  async function projectClick(e){
    const direction = e.target.closest('[data-project-move]');
    if (direction && !direction.disabled){
      const row = direction.closest('[data-project-id]');
      const target = direction.dataset.projectMove === 'up' ? row.previousElementSibling : row.nextElementSibling;
      if (target) moveProject(row.dataset.projectId, target.dataset.projectId, direction.dataset.projectMove === 'down');
      return;
    }
    const button = e.target.closest('[data-project-action]');
    if (!button) return;
    const row = projectRows.get(button.closest('[data-project-id]').dataset.projectId);
    if (!row || button.disabled || projectOpening.has(row.id)) return;
    const action = button.dataset.projectAction, opening = action === 'open' || action === 'preview' || action === 'review';
    button.disabled = true;
    if (opening){ projectOpening.add(row.id); renderProjects(); }
    try {
      switch (action){
      case 'rename': beginProjectRename(row); break;
      case 'open':
        await switchProject(row);
        break;
      case 'preview': {
        const result = row.result || await projectResult(row);
        const current = projectRows.get(row.id);
        if (!current || savedProject(current) || current.jobId !== row.jobId) break;
        closeProjects();
        const preview = current.customName ? {...result, plan:{...result.plan,name:current.customName}} : result;
        App.importer.impOpenResult(preview, ({plan,furniture,ceiling,ceilingMeta}) => {
          const {reviewApplied,review} = App.importer.impState;
          const snapshot = App.io.snapshotFromRecognition(plan, furniture, {ceiling, ceilingMeta});
          if (!snapshot) return {ok:false, errors:[App.core.tr('识别结果缺少有效户型。','The result contains no valid floor plan.')]};
          return switchProject(current, {snapshot, reviewVersion:reviewApplied ? review?.updatedAt : undefined});
        }, {jobId:current.jobId, reviewState:projectReview(current)?.state, mode:'preview'});
        break;
      }
      case 'review': {
        if (!row.jobId || !savedProject(row)) break;
        if (row.id !== activeProjectId){
          const result = await switchProject(row);
          if (!result.ok) break;
        }
        closeProjects();
        const current = getActiveProject();
        const {plan, state} = current.baseline;
        const storedCeiling = App.ceilingModel.normalize(state?.ceiling, plan.rooms);
        const items = Array.isArray(state?.furniture) ? state.furniture : [];
        const {ceiling, furniture} = App.ceilingFurniture.split(storedCeiling, items);
        const projected = App.ceilingFurniture.project(ceiling, furniture, plan.rooms);
        const hasCeiling = Object.keys(projected.rooms).length || projected.baseHeight !== App.ceilingModel.baseHeight();
        App.importer.impOpenResult({plan, furniture, ceiling:hasCeiling ? projected : undefined, ceilingMeta:state?.ceilingMeta}, null,
          {jobId:current.jobId, reviewState:projectReview(current)?.state, mode:'project', rowId:current.id,
            schemeId:activeSchemeId, sceneKey:activeSceneKey()});
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
      case 'hide':
        await updateStoredProject(row.id, current => current?.jobId === row.jobId && !savedProject(current)
          ? {...current, hidden:true} : null, {memoryFallback:true});
        renderProjects();
        break;
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
    closeProjectRename();
    projectSorting = false;
    endProjectDrag();
    projectPanel.hidden = true;
    projectToggle.setAttribute('aria-expanded','false');
    if (returnFocus) projectToggle.focus({preventScroll:true});
  }
  function openProjects(expandId){
    App.core.$('details.menu').open = false;
    App.panel.closeDrawers();
    projectPanel.hidden = false;
    projectToggle.setAttribute('aria-expanded','true');
    if (expandId){
      projectSearch.value = '';
      projectSorting = false;
      expandedProjects.set(expandId,true);
      const row = findProjectRow(expandId);
      if (row?.matches('details')) row.open = true;
    }
    resizeProjects(); renderProjects(); scheduleProjectSync(0);
    if (expandId){
      const expanded = findProjectRow(expandId);
      expanded?.scrollIntoView({block:'nearest'});
      expanded?.querySelector('summary')?.focus({preventScroll:true});
    }
  }
  function clearProjectDropMarker(){
    projectList.querySelector('.is-drop-before,.is-drop-after')?.classList.remove('is-drop-before','is-drop-after');
  }
  function endProjectDrag(){
    if (!draggedProjectId) return;
    findProjectRow(draggedProjectId)?.classList.remove('is-dragging');
    clearProjectDropMarker();
    draggedProjectId = '';
  }
  function dropAfter(event,row){
    const box = row.getBoundingClientRect();
    return event.clientY > box.top + box.height/2;
  }
  projectToggle.onclick = () => projectPanel.hidden ? openProjects() : closeProjects();
  App.core.$('#projectClose').onclick = () => closeProjects(true);
  newProject.onclick = beginNewProject;
  App.core.$('#projectImport').onclick = () => { closeProjects(); App.importer.impOpen(); };
  projectSearch.oninput = () => { projectList.scrollTop = 0; renderProjects(); };
  projectSort.onclick = () => { closeProjectRename(); projectSorting = !projectSorting; renderProjects(); };
  renameForm.onsubmit = submitProjectName;
  renameInput.oninput = () => renameInput.setCustomValidity('');
  App.core.$('#projectRenameCancel').onclick = () => closeProjectRename(true);
  projectList.onclick = projectClick;
  projectList.addEventListener('dragstart', e => {
    const handle = e.target.closest('[data-project-drag]');
    if (!projectSorting || !handle || !e.dataTransfer) return;
    const row = handle.closest('[data-project-id]');
    draggedProjectId = row.dataset.projectId;
    e.dataTransfer.setData('text/plain', draggedProjectId);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
  });
  projectList.addEventListener('dragover', e => {
    if (!draggedProjectId) return;
    clearProjectDropMarker();
    const row = e.target.closest('[data-project-id]');
    if (!row || row.dataset.projectId === draggedProjectId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add(dropAfter(e,row) ? 'is-drop-after' : 'is-drop-before');
  });
  projectList.addEventListener('dragleave', e => {
    if (draggedProjectId && !projectList.contains(e.relatedTarget)) clearProjectDropMarker();
  });
  projectList.addEventListener('drop', e => {
    if (!draggedProjectId) return;
    e.preventDefault();
    const id = draggedProjectId, target = e.target.closest('[data-project-id]');
    endProjectDrag();
    if (target) moveProject(id,target.dataset.projectId,dropAfter(e,target));
    renderProjects();
  });
  projectList.addEventListener('dragend', () => { endProjectDrag(); renderProjects(); });
  addEventListener('storage', e => {
    if (e.key === projectOrderKey){ projectOrder = parseProjectOrder(e.newValue); renderProjects(); }
  });
  addEventListener('resize', () => { if (!projectPanel.hidden) resizeProjects(); });
  document.addEventListener('pointerdown', e => { if (!projectPanel.hidden && !e.target.closest('#projectShelf')) closeProjects(); });
  projectPanel.addEventListener('keydown', e => e.stopPropagation());
  document.addEventListener('keydown', e => {
    if (projectPanel.hidden || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    if (namingProject) closeProjectRename(true);
    else if (e.target === projectSearch && projectSearch.value){ projectSearch.value = ''; renderProjects(); }
    else if (projectSorting){ projectSorting = false; renderProjects(); projectSort.focus(); }
    else closeProjects(true);
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
      let recent, tab;
      try {
        recent = JSON.parse(localStorage.getItem(projectActiveKey) || 'null');
        const pointer = sessionStorage.getItem(projectActiveKey);
        try { tab = JSON.parse(pointer); } catch(e){ tab = {id:pointer}; }
      } catch(e){}
      try {
        const rows = await projectTransaction('readonly', store => store.getAll());
        rows.forEach(row => projectRows.set(row.id, row));
      } catch(e){ projectStorageIssue = true; }
      const id = tab?.id || recent?.id || newProjectId();
      const restored = projectRows.get(id);
      let row = savedProject(restored) ? migrateSavedProject(restored) : null;
      if (row){
        const requested = tab?.id === id ? tab.schemeId : recent?.schemeId;
        if (row.schemes.some(scheme => scheme.id === requested)) row = {...row, activeSchemeId:requested};
        const scheme = selectedScheme(row);
        const cachedScheme = recent?.schemeId || (restored.snapshot ? 'scheme-1' : '');
        const fromCache = recent?.id === id && cachedScheme === scheme.id &&
          recent.updatedAt > scheme.updatedAt && App.io.hasStoredPlan();
        if (!fromCache && !loadProjectScene(scheme.snapshot).ok) row = null;
      }
      if (!row){
        const newId = restored ? newProjectId() : id;
        row = projectWithFirstScheme({id:newId, createdAt:Date.now()}, App.io.studio.projectJSON(), 'blank');
      }
      activeProjectId = row.id;
      activeSchemeId = selectedScheme(row).id;
      projectRows.set(row.id, row);
      refreshProjectScene();
      App.store.onProjectSave = saveActiveProject;
      App.store.save();
      void recoverLegacyBaseline(row);
      updateSchemesUI();
      scheduleProjectSync(0);
    })();
  }

  Object.assign(App.projects, {
    projectEndpoint, projectRows, putProject, openNewProject, sceneSignature, renderProjects,
    projectImportSubmitted, openProjects, getActiveProject, switchScheme, createScheme, renameScheme,
    deleteScheme, renameProject, flushActiveProject, openImportedProject, projectSchemesJSON, defaultSchemeName,
  });
  Object.defineProperties(App.projects, {
    activeProjectId: {get: () => activeProjectId},
    activeSchemeId: {get: () => activeSchemeId},
    activeSceneKey: {get: activeSceneKey},
  });
  initialize();
})();
