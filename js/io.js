/* 导入导出、视图切换与 Studio 公开接口。
 * 依赖 App.core、App.store、App.plan、App.geom、App.dimensions、App.draw2d、App.panel、App.interact、App.importer、App.assistant、App.projects、App.tour。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 导入导出 ======================= */
  function download(name, blob){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  function dataURLBlob(url){
    const [head, b64] = url.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], {type:mime});
  }

  // 2D 平面图快照：克隆 SVG 离屏画到 canvas；clean 时去掉房间名 / 测量 / 尺寸 / 选中框
  function planSnapshotURL(opts = {}){
    const scale = Math.max(.25, Math.min(6, App.core.numOr(opts.scale, 1)));
    const clean = !!opts.clean;
    return new Promise(resolve => {
      try {
        // 长宽比极端（超出 1:6）或画布像素超过浏览器上限时压低倍率，避免 toDataURL 返回空串
        const b = App.store.BOUNDS, ratio = Math.max(.05, b.h/b.w);
        const MAXPX = 24e6, k = Math.min(1, Math.sqrt(MAXPX / (3200*scale * (3200*scale*ratio))));
        const W = Math.round(3200*scale*k), H = Math.max(1, Math.round(W*ratio));
        const clone = App.core.svg.cloneNode(true);
        clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
        clone.setAttribute('width', W); clone.setAttribute('height', H);
        const q = s => clone.querySelector(s);
        if (q('#gSel')) q('#gSel').innerHTML = '';
        if (clean) ['#gLabels', '#gMeasure', '#gDims', '#gSel'].forEach(s => { const el = q(s); if (el) el.innerHTML = ''; });
        if (q('#gGrid')) q('#gGrid').innerHTML = `<rect x="${b.x-8000}" y="${b.y-8000}" width="${b.w+16000}" height="${b.h+16000}" fill="${App.store.ui.layers.grid && !clean ? 'url(#grid)' : 'transparent'}"/>`;
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        Object.entries({x:b.x, y:b.y, width:b.w, height:b.h, fill:'#f7f4ee'}).forEach(([k,v]) => bg.setAttribute(k,v));
        clone.insertBefore(bg, clone.querySelector('#gGrid'));
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          cv.getContext('2d').drawImage(img, 0, 0, W, H);
          resolve(cv.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      } catch(e){ resolve(null); }
    });
  }

  // 统一截图入口（契约 §3 shot）：2D 走 SVG 快照，3D 走 WebGL 离屏放大
  async function studioShot(opts = {}){
    if (is3D()) return App.view3d?.shotURL(opts) || null;
    return planSnapshotURL(opts);
  }

  async function exportPNG(){
    const url = await studioShot({scale:is3D() ? 2 : 1, clean:is3D()});
    if (!url) return App.core.toast(App.core.tr('导出失败', 'Export failed'));
    download(App.core.tr('户型装修方案', 'floor-plan-design') + '.png', dataURLBlob(url));
  }

  const dwgButton = App.core.$('#exportDwg');
  const dwgLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  dwgButton.hidden = !/^https?:$/.test(location.protocol) || App.core.PUBLIC_ACCESS === 'guest' ||
    !(dwgLoopback || App.core.PUBLIC_ACCESS === 'owner');
  async function exportDWG(){
    if (dwgButton.hidden || dwgButton.disabled) return;
    const {tr, toast, studioPath} = App.core;
    dwgButton.disabled = true;
    toast(tr('正在生成 DWG…', 'Generating DWG…'));
    try {
      const plan = App.store.PLAN;
      const {furniture, rooms, demolished} = App.store.state;
      const name = (plan.name || '').trim().replace(/\.dwg$/i, '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || tr('户型装修方案', 'floor-plan-design');
      const response = await fetch(studioPath('/api/export/dwg'), {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        signal:AbortSignal.timeout(30_000),
        body:JSON.stringify({plan, state:{furniture, rooms, demolished}, dimensions:App.dimensions.forCad()}),
      });
      if (response.status === 503) return toast(tr('DWG 转换服务暂不可用。', 'The DWG converter is unavailable.'));
      if (response.status === 401) return toast(tr('请重新登录后导出 DWG。', 'Sign in again to export DWG.'));
      if (!response.ok){
        const details = response.status === 422 ? await response.json().catch(() => null) : null;
        return toast(typeof details?.error === 'string' ? details.error.slice(0, 160) :
          tr('DWG 生成失败，请稍后重试。', 'Could not generate DWG. Try again.'));
      }
      const file = await response.blob();
      if (!/^AC10\d{2}$/.test(await file.slice(0, 6).text())){
        return toast(tr('服务返回的文件无法识别为 DWG。', 'The server response is not a DWG file.'));
      }
      download(name + '.dwg', file);
      toast(tr('已生成 DWG，开始下载。', 'DWG generated. Download started.'));
    } catch (error) {
      toast(tr('DWG 导出中断，请检查服务连接后重试。', 'DWG export was interrupted. Check the server and try again.'));
    } finally {
      dwgButton.disabled = false;
    }
  }
  dwgButton.onclick = exportDWG;

  /* ======================= 2D / 3D 切换 ======================= */
  let viewMode = '2d', switching = false;
  const is3D = () => viewMode === '3d';
  const TIPS = () => App.core.COARSE
    ? {'2d':App.core.tr('点或拖动家具库添加 · 单指拖动平移 · 双指缩放 · 选中家具后底部工具条可旋转 / 复制 / 删除', 'Tap or drag from the library · 1 finger pans · pinch zooms · bottom bar rotates / duplicates / deletes'),
       '3d':App.core.tr('单指旋转 · 双指缩放 / 平移 · 点家具或地面编辑 · 点门旁按钮开关', '1 finger orbits · 2 fingers zoom / pan · tap furniture or floor to edit · tap the door button')}
    : {'2d':App.core.tr('拖动左侧家具到平面图 · 滚轮缩放 · 拖动空白处平移 · T 切换 3D', 'Drag furniture onto the plan · scroll to zoom · drag empty space to pan · T for 3D'),
       '3d':App.core.tr('3D 场景与平面方案实时同步 · 右侧面板修改会立即生效 · T 返回 2D', '3D stays in sync with the plan · panel edits apply instantly · T for 2D')};
  async function setView(m){
    if (m === viewMode || switching) return;
    if (!App.view3d) return App.core.toast(App.core.tr('3D 引擎仍在加载或加载失败（需要联网加载 three.js）', '3D engine is still loading or failed to load (three.js needs a network connection)'));
    switching = true; document.body.classList.add('busy');
    viewMode = m;
    try {
      if (m === '3d'){ if (App.store.ui.tool !== 'select') App.interact.setTool('select'); App.store.ui.mA = null; document.body.classList.add('m3d'); await App.view3d.enter(); }
      else { document.body.classList.remove('m3d'); await App.view3d.exit(); App.interact.applyView(); }
    } catch (e) {
      // WebGL 不可用（旧设备、无 GPU 环境）时退回 2D，避免停在半个状态
      document.body.classList.remove('m3d'); viewMode = '2d';
      App.interact.applyView();
      App.core.toast(App.core.tr('3D 场景无法启动（当前浏览器不支持 WebGL）', '3D could not start (WebGL is not available here)'));
    }
    App.core.$('#tip').textContent = TIPS()[viewMode];
    switching = false; document.body.classList.remove('busy');
    App.ceilingEditor?.syncView();
    App.assistant.renderViewSync();
  }
  // 2D 房间面板 / 房间列表的「进入房间」：必要时先切 3D，再飞到室内机位
  async function studioEnterRoom(id, options){
    if (!App.plan.roomDef(id)) return;
    if (!is3D()){
      await setView('3d');
      if (!is3D()) return;                       // WebGL 不可用，setView 已提示
    }
    App.view3d?.enterRoom?.(id, options);
  }
  document.querySelectorAll('.menu-pop .btn').forEach(b => b.addEventListener('click', () => b.closest('details').open = false));
  document.querySelectorAll('#viewSeg .btn').forEach(b => b.onclick = () => {
    const room = App.ceilingEditor?.active() && App.ceilingEditor.context()?.roomId;
    if (b.dataset.view === '3d' && room) return studioEnterRoom(room, {ceiling:true});
    return setView(b.dataset.view);
  });

  document.querySelectorAll('#tools .btn').forEach(b => b.onclick = () => App.interact.setTool(b.dataset.tool));
  document.querySelectorAll('#layers [data-layer]').forEach(b => b.onclick = () => {
    const k = b.dataset.layer; App.store.ui.layers[k] = !App.store.ui.layers[k]; b.classList.toggle('on', App.store.ui.layers[k]);
    if (k === 'dims'){
      if (!App.store.ui.layers.dims && App.store.ui.tool === 'dimension') App.interact.setTool('select');
      App.draw2d.renderDims();
    }
    else if (k !== 'wallSnap') App.draw2d.renderAll();
  });
  App.core.$('#zoomIn').onclick = () => App.interact.zoomCenter(1.25);
  App.core.$('#zoomOut').onclick = () => App.interact.zoomCenter(.8);
  App.core.$('#fit').onclick = App.interact.fitView;
  App.core.$('#s60').onclick = () => { App.interact.setRatio(60); App.core.toast(App.core.tr('已按 1:60 显示（与原始户型图同比例）', 'Showing at 1:60 (same scale as the original plan)')); };
  App.core.$('#s100').onclick = () => App.interact.setRatio(100);
  App.core.$('#undo').onclick = App.store.undo; App.core.$('#redo').onclick = App.store.redo;
  App.core.$('#clearAll').onclick = App.panel.clearLayout;

  /* 全屏：标准 API + Safari（iPad）的 webkit 前缀版本 */
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function toggleFullscreen(){
    const de = document.documentElement;
    if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else {
      const req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (!req) return App.core.toast(App.core.tr('当前浏览器不支持网页全屏，可在 Safari 中「添加到主屏幕」后以全屏方式打开', 'Fullscreen is not supported here — in Safari, use "Add to Home Screen" to open it fullscreen'));
      Promise.resolve(req.call(de)).catch(() => App.core.toast(App.core.tr('无法进入全屏', 'Could not enter fullscreen')));
    }
  }
  function syncFullscreen(){
    const on = !!fsEl(), b = App.core.$('#fullscreen');
    b.textContent = '⛶ ' + (on ? App.core.tr('退出全屏', 'Exit fullscreen') : App.core.tr('全屏', 'Fullscreen'));
    b.title = (on ? App.core.tr('退出全屏', 'Exit fullscreen') : App.core.tr('全屏', 'Fullscreen')) + ' (Shift+F)';
  }
  App.core.$('#fullscreen').onclick = toggleFullscreen;
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(t => document.addEventListener(t, syncFullscreen));
  // 已从主屏幕以独立 App 方式打开时本就是全屏，隐藏按钮
  if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) App.core.$('#fullscreen').hidden = true;
  App.core.$('#tgLib').onclick = () => App.panel.drawer('lib');
  App.core.$('#tgPanel').onclick = () => App.panel.drawer('panel');
  // 触屏上点菜单以外的地方收起「文件」菜单
  document.addEventListener('pointerdown', e => { const m = App.core.$('details.menu'); if (m.open && !m.contains(e.target)) m.open = false; });
  matchMedia('(max-width:1100px)').addEventListener('change', () => App.panel.drawer(null));
  App.panel.drawer(null);                                  // 恢复上次的面板收起状态
  App.core.$('#exportPng').onclick = exportPNG;
  // 项目文件：plan + state + 效果图记录，换机 / 备份时完整带走
  App.core.$('#exportProj').onclick = () => {
    const {renders, ...rest} = App.store.state;
    const doc = {version:2, plan:App.core.deepCopy(App.store.PLAN), state:App.core.deepCopy(rest), renders:App.core.deepCopy(renders || [])};
    download(App.core.tr('户型装修项目', 'floor-plan-project') + '.json',
      new Blob([JSON.stringify(doc, null, 2)], {type:'application/json'}));
  };
  App.core.$('#importProj').onclick = () => App.core.$('#fileIn').click();
  App.core.$('#exportJson').onclick = () => download(App.core.tr('户型装修方案', 'floor-plan-design') + '.json',
    new Blob([JSON.stringify({version:2, plan:App.store.PLAN, state: App.store.state}, null, 2)], {type:'application/json'}));
  App.core.$('#importJson').onclick = () => App.core.$('#fileIn').click();
  App.core.$('#fileIn').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    file.text().then(importProject).catch(() => App.core.toast(App.core.tr('读取文件失败', 'Could not read the file')));
    e.target.value = '';
  };
  App.core.$('#reset').onclick = () => {
    if (confirm(App.core.tr('恢复为默认空方案？（清空户型与家具，可撤销）', 'Reset to the default empty plan? (clears plan and furniture, undoable)'))) resetProject();
  };
  if (App.core.$('#load125c')) App.core.$('#load125c').onclick = () => loadSamplePlan();
  // 横竖屏切换、表头换行等都会改变画布尺寸；尺寸从 0 恢复（如首次布局）时重新适应窗口
  // 其余尺寸变化（收起 / 展开面板等）保持画面中心不动
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const w = App.core.svg.clientWidth, h = App.core.svg.clientHeight; if (!w) return;
    if (!lastW) App.interact.fitView();
    else { App.store.view.x0 -= (w - lastW)/2/App.store.view.s; App.store.view.y0 -= (h - lastH)/2/App.store.view.s; App.interact.applyView(); }
    lastW = w; lastH = h;
  }).observe(App.core.svg);

  function setLang(l){
    App.core.LANG = l; try { localStorage.setItem(App.core.LANG_KEY, l); } catch(e) {}
    App.core.applyStaticLang(); syncFullscreen(); App.interact.syncModeHint(); App.panel.syncPaneBtns();
    App.interact.buildLib(); App.draw2d.renderOpenings(); App.draw2d.renderAll();
    App.core.$('#tip').textContent = TIPS()[viewMode];
    App.assistant.chatRelang();
    App.assistant.renderRelang();
    App.importer.impRelang();
    App.tour.tourRelang();
    App.projects.renderProjects();
    App.view3d?.relang();
  }
  App.core.$('#langSel').onclick = e => { const l = e.target.closest('[data-lang]')?.dataset.lang; if (l && l !== App.core.LANG) setLang(l); };

  /* ======================= 方案切换 / 项目文件 ======================= */
  function drawingFurniture(list){
    return Array.isArray(list) ? list.filter(f => App.geom.drawingItemTypes.has(f?.type) &&
      [f.cx, f.cy, f.w, f.d, f.rot].every(Number.isFinite) && f.w > 0 && f.d > 0 &&
      (f.type !== 'component' || App.geom.normalizeComponentParts(f.parts).length > 0)) : [];
  }

  // 换方案：校验 → 安装 PLAN → 按新房间重建 state → 清越界拆除索引 / 无效选中 → 入撤销栈
  // opts.furniture：导入的家具；opts.clearFurniture：移除原有家具；opts.freshState：清除拆改、测量和房间覆盖项
  function applyPlan(plan, opts = {}){
    const b = opts.history === false ? null : App.store.snap();
    const res = App.plan.sanitizePlan(plan);
    if (!res.ok) return {ok:false, errors:res.errors};
    const old = App.store.PLAN;
    const roomEdges = rooms => rooms.map(({id, poly, arcs}) => [id, poly, arcs]);
    const sameRooms = JSON.stringify(roomEdges(res.plan.rooms)) === JSON.stringify(roomEdges(old.rooms));
    const sameAnchors = JSON.stringify(res.plan.walls) === JSON.stringify(old.walls) && sameRooms;
    if (opts.freshState || !sameAnchors){
      App.store.state.dimensionMarks = [];
      App.dimensions.clearDraft();
      App.dimensions.closeEditor();
    }
    const recognized = drawingFurniture(opts.furniture);
    if (opts.clearFurniture || recognized.length){
      const current = opts.clearFurniture ? [] : App.store.state.furniture;
      const ids = new Set(current.map(f => f.id));
      const imported = recognized.map(f => {
        let id = App.geom.uid();
        while (ids.has(id)) id = App.geom.uid();
        ids.add(id);
        return {...f, id};
      });
      // 图纸位置不做避让，二维图先绘制地毯和构件，再绘制家具。
      App.store.state.furniture = [
        ...imported.filter(f => f.type === 'rug'),
        ...imported.filter(f => f.type === 'component'),
        ...current,
        ...imported.filter(f => f.type !== 'rug' && f.type !== 'component'),
      ];
    }
    App.store.installPlan(res.plan);
    if (opts.freshState || opts.resetCeiling) delete App.store.state.ceiling;
    if (opts.freshState){ App.store.state.demolished = []; App.store.state.measures = []; App.store.state.rooms = {}; }
    App.store.state = App.store.fixState(App.store.state);
    App.store.ui.sel = null; App.store.ui.mA = App.store.ui.mCur = null;
    if (b !== null) App.store.commit(b);
    App.store.save();
    App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings();
    App.draw2d.renderAll(); refit();
    return {ok:true, errors:res.errors, plan:res.plan};
  }

  // 默认空方案：fetch 优先，失败（file://）用内置副本
  async function loadPlanFile(url){
    try {
      const r = await fetch(url, {cache:'no-store'});
      if (!r.ok) throw 0;
      const res = App.plan.sanitizePlan(await r.json());
      if (!res.ok) throw 0;
      return res.plan;
    } catch(e){ return null; }
  }
  async function loadSamplePlan(){
    const plan = await loadPlanFile('data/125c-plan.json');
    if (!plan) return App.core.toast(App.core.tr('示例户型加载失败（file:// 打开时不可用）', 'Could not load the example (unavailable under file://)'));
    applyPlan(plan, {resetCeiling:true});
    App.core.toast(App.core.tr('已加载示例户型 125-C', 'Loaded the 125-C example plan'));
  }

  // 导入：新版 {version:2, plan, state, renders}；旧版 {furniture,...} 按 125-C 示例户型导入（失败时退到空壳）
  async function importProject(txt){
    let o; try { o = JSON.parse(txt); } catch(e){ return App.core.toast(App.core.tr('文件格式不正确', 'Invalid file format')); }
    let project, note;
    if (o && o.plan){
      const res = App.plan.sanitizePlan(o.plan);
      if (!res.ok) return App.core.toast(App.core.tr('方案数据无效：' + res.errors[0], 'Invalid plan: ' + res.errors[0]));
      // 效果图记录：项目文件里的顶层 renders 优先，其次 state.renders。
      const inc = Array.isArray(o.renders) ? o.renders : (o.state && Array.isArray(o.state.renders) ? o.state.renders : null);
      project = {plan:res.plan, state:{...(o.state || App.store.defaultState()), renders:inc || []}};
      note = App.core.tr('方案已导入（含户型与家具）', 'Project imported (plan + furniture)');
    } else if (o && Array.isArray(o.furniture)){
      // 旧文件只有家具（来自 125-C 站点）：优先套用 125-C 示例户型，取不到再退回空壳
      const sample = await loadPlanFile('data/125c-plan.json');
      project = {plan:sample || App.plan.sanitizePlan(App.plan.FALLBACK_PLAN).plan, state:{...o, renders:[]}};
      note = sample
        ? App.core.tr('旧版文件（仅家具）已按 125-C 示例户型导入', 'Legacy file (furniture only) imported onto the 125-C example plan')
        : App.core.tr('旧版文件（仅家具）已导入到空壳户型', 'Legacy file (furniture only) imported onto the empty plan');
    } else {
      return App.core.toast(App.core.tr('文件格式不正确', 'Invalid file format'));
    }
    if (await App.projects.openNewProject(project)) App.core.toast(note);
  }

  async function resetProject(){
    // 优先用 data/empty-plan.json（可被用户改），取不到再退回内置副本
    const plan = (await loadPlanFile('data/empty-plan.json')) || App.plan.sanitizePlan(App.plan.FALLBACK_PLAN).plan;
    applyPlan(plan);                               // 自带一次撤销快照
    App.store.state = App.store.fixState(App.store.defaultState());
    App.store.save(); App.draw2d.renderAll(); refit();
    App.core.toast(App.core.tr('已恢复默认空方案', 'Reset to the empty plan'));
  }

  // 未存过方案时载入 data/empty-plan.json（只在用户还没有任何改动时执行）
  const hasStoredPlan = () => { try { return !!localStorage.getItem(App.store.PLAN_KEY); } catch(e){ return false; } };
  async function hydrateDefaultPlan(){
    if (hasStoredPlan()) return;
    const plan = await loadPlanFile('data/empty-plan.json');
    if (!plan || hasStoredPlan() || App.store.undoStack.length) return;
    App.store.installPlan(plan);
    App.store.state = App.store.fixState(App.store.state);
    App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings(); App.draw2d.renderAll(); refit();
  }

  function refit(){ App.interact.fitView(); lastW = App.core.svg.clientWidth; lastH = App.core.svg.clientHeight; }

  /* ======================= window.Studio（契约 §3） ======================= */
  const neat = v => Math.max(50, Math.round(App.core.numOr(v, 8000) / 10) * 10);
  function findFreeSpot(w, d){
    // 落在当前画面中心，被墙压住时按手动放置的规则推出来
    const f = {cx:App.store.view.x0 + App.core.svg.clientWidth/2/App.store.view.s, cy:App.store.view.y0 + App.core.svg.clientHeight/2/App.store.view.s, w, d, rot:0};
    App.interact.pushOut(f);
    return [Math.round(f.cx/10)*10, Math.round(f.cy/10)*10];
  }

  const sceneFields = {
    plan: new Set(['name', 'bounds', 'walls', 'wins', 'doors', 'slides', 'rooms', 'materials']),
    state: new Set(['furniture', 'rooms', 'demolished', 'measures', 'ceiling']),
  };
  const unsafeSceneKeys = new Set(['__proto__', 'prototype', 'constructor']);
  const sceneActions = new Set(['add', 'replace', 'remove']);
  const isSceneRecord = value => Object.prototype.toString.call(value) === '[object Object]';
  const isSceneIndex = value => Number.isInteger(value) && value >= 0 && value < 2 ** 32 - 1;

  function isSceneData(value, depth = 0){
    if (depth > 32) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return true;
    if (Array.isArray(value)) return Array.from(value).every(item => isSceneData(item, depth + 1));
    return isSceneRecord(value) && Object.entries(value).every(([key, item]) => !unsafeSceneKeys.has(key) && isSceneData(item, depth + 1));
  }

  function patchSceneValue(draft, change){
    const {action, path} = change || {};
    if (!sceneActions.has(action) || !Array.isArray(path) || path.length < 2 ||
        typeof path[0] !== 'string' || !Object.hasOwn(sceneFields, path[0]) || !sceneFields[path[0]].has(path[1]) ||
        !path.every(key => isSceneIndex(key) || (typeof key === 'string' && key && !unsafeSceneKeys.has(key)))){
      throw new Error(App.core.tr('场景编辑路径或操作无效', 'Invalid scene edit path or action'));
    }
    if (action !== 'remove' && (!Object.hasOwn(change, 'value') || !isSceneData(change.value))){
      throw new Error(App.core.tr('缺少有效的场景编辑数据', 'Missing valid scene edit data'));
    }
    const invalidTarget = () => new Error(App.core.tr(`目标不存在或索引无效：${path.join('.')}`, `Missing target or invalid index: ${path.join('.')}`));
    let node = draft;
    for (const step of path.slice(0, -1)){
      const validKey = Array.isArray(node) ? isSceneIndex(step) : isSceneRecord(node) && typeof step === 'string' && step !== '-';
      if (!validKey || !Object.hasOwn(node, step)) throw invalidTarget();
      node = node[step];
    }
    const key = path.at(-1), value = action === 'remove' ? undefined : App.core.deepCopy(change.value);
    if (Array.isArray(node)){
      const index = key === '-' && action === 'add' ? node.length : key;
      if (!isSceneIndex(index) || (action === 'add' ? index > node.length : index >= node.length)) throw invalidTarget();
      if (action === 'add') node.splice(index, 0, value);
      else if (action === 'remove') node.splice(index, 1);
      else node[index] = value;
    } else {
      if (!isSceneRecord(node) || typeof key !== 'string' || key === '-' ||
          (action !== 'add' && !Object.hasOwn(node, key))) throw invalidTarget();
      if (action === 'remove') delete node[key];
      else node[key] = value;
    }
  }

  // 允许模型省略能自动补全的字段，但不能让宽容的导入校验悄悄丢掉用户请求的改动。
  function sceneDataRetained(input, normalized){
    if (Array.isArray(input)){
      return Array.isArray(normalized) && input.length === normalized.length &&
        input.every((item, i) => sceneDataRetained(item, normalized[i]));
    }
    if (isSceneRecord(input)){
      return isSceneRecord(normalized) && Object.entries(input).every(([key, item]) =>
        Object.hasOwn(normalized, key) && sceneDataRetained(item, normalized[key]));
    }
    return input === normalized;
  }

  function uniqueWallValues(walls){
    const byValue = new Map();
    for (const wall of Array.isArray(walls) ? walls : []){
      const key = JSON.stringify(wall);
      byValue.set(key, byValue.has(key) ? null : wall);
    }
    return byValue;
  }

  const ceilingChange = change => change?.path?.[0] === 'state' && change.path[1] === 'ceiling';

  function validateCeiling(draft, rooms){
    if (!Object.hasOwn(draft, 'ceiling')) return App.ceilingModel.normalize(undefined, rooms);
    return App.ceilingModel.validate(draft.ceiling, rooms);
  }

  function prepareCeilingEdit(changes){
    if (!Array.isArray(changes) || !changes.length || changes.length > 200 || !changes.every(ceilingChange)){
      throw new Error(App.core.tr('天花编辑需要 1 至 200 项顶面改动', 'A ceiling edit needs 1 to 200 ceiling changes'));
    }
    const draft = {state:{ceiling:App.core.deepCopy(App.store.state.ceiling)}};
    changes.forEach(change => patchSceneValue(draft, change));
    return validateCeiling(draft.state, App.store.PLAN.rooms);
  }

  function applySceneEdit(changes){
    if (!Array.isArray(changes) || !changes.length || changes.length > 200){
      throw new Error(App.core.tr('场景编辑需要 1 至 200 项改动', 'A scene edit needs 1 to 200 changes'));
    }
    if (changes.every(ceilingChange)){
      const ceiling = prepareCeilingEdit(changes);
      if (JSON.stringify(ceiling) === JSON.stringify(App.store.state.ceiling)) return null;
      App.store.state.ceiling = ceiling;
      return true;
    }
    const draft = JSON.parse(App.store.snap());
    // 保留旧索引对应的墙对象，使插入和删除后的拆除标记与选中对象仍指向同一面墙。
    let oldWalls = [...draft.plan.walls];
    for (const change of changes){
      const prev = draft.plan.walls, path = change?.path;
      const replacedWall = Array.isArray(path) && path[0] === 'plan' && path[1] === 'walls' &&
        path.length === 3 && change.action === 'replace' && Array.isArray(prev) ? prev[path[2]] : undefined;
      patchSceneValue(draft, change);
      if (path[0] !== 'plan' || path[1] !== 'walls') continue;
      if (path.length === 2){
        const oldValues = uniqueWallValues(prev), newValues = uniqueWallValues(draft.plan.walls);
        oldWalls = oldWalls.map(wall => {
          const key = JSON.stringify(wall);
          return oldValues.get(key) === wall ? newValues.get(key) : undefined;
        });
      } else if (replacedWall){
        const oldIndex = oldWalls.indexOf(replacedWall);
        if (oldIndex >= 0) oldWalls[oldIndex] = draft.plan.walls[path[2]];
      }
    }
    const normalized = App.plan.sanitizePlan(draft.plan);
    if (!normalized.ok || normalized.errors.length || !sceneDataRetained(draft.plan, normalized.plan)){
      throw new Error(App.core.tr('户型几何或属性无效，本次编辑未应用', 'Invalid plan geometry or properties; the edit was not applied'));
    }
    const plan = normalized.plan;
    const oldWallValues = new Set(App.store.PLAN.walls.map(w => JSON.stringify(w)));
    if (plan.walls.some(w => Array.isArray(w) && (w[0] === w[2] || w[1] === w[3]) && !oldWallValues.has(JSON.stringify(w))) ||
        plan.rooms.some(r => unsafeSceneKeys.has(r.id) || !Object.hasOwn(plan.materials, r.mat))){
      throw new Error(App.core.tr('墙体尺寸、房间编号或材料无效', 'Invalid wall dimensions, room identifier or material'));
    }
    const remapWall = id => {
      const wall = oldWalls[Number(id.slice(1))], index = draft.plan.walls?.indexOf(wall) ?? -1;
      return index < 0 ? null : 'w' + index;
    };
    const explicitDemolished = changes.some(({path}) => path[0] === 'state' && path[1] === 'demolished');
    const stateDraft = draft.state;
    if (changes.some(ceilingChange)) stateDraft.ceiling = validateCeiling(stateDraft, plan.rooms);
    else if (stateDraft.ceiling && changes.some(({path}) => path[0] === 'plan' && path[1] === 'rooms')){
      const nextRoomIds = new Set(plan.rooms.map(room => room.id));
      const ceilingRooms = Object.fromEntries(Object.entries(stateDraft.ceiling.rooms).filter(([id]) => nextRoomIds.has(id)));
      stateDraft.ceiling = App.ceilingModel.validate({...stateDraft.ceiling, rooms:ceilingRooms}, plan.rooms);
    }
    const furniture = Object.hasOwn(stateDraft, 'furniture') ? stateDraft.furniture : [];
    const measures = Object.hasOwn(stateDraft, 'measures') ? stateDraft.measures : [];
    const rooms = Object.hasOwn(stateDraft, 'rooms') ? stateDraft.rooms : {};
    const demolished = explicitDemolished
      ? (Object.hasOwn(stateDraft, 'demolished') ? stateDraft.demolished : [])
      : App.store.state.demolished.map(remapWall).filter(Boolean);
    if (!Array.isArray(furniture) || !Array.isArray(measures) || !Array.isArray(demolished) || !isSceneRecord(rooms) ||
        measures.some(m => !m || ![m.a?.x, m.a?.y, m.b?.x, m.b?.y].every(Number.isFinite)) ||
        demolished.some(id => typeof id !== 'string' || !/^w(?:0|[1-9]\d*)$/.test(id) || +id.slice(1) >= plan.walls.length)){
      throw new Error(App.core.tr('家具、房间、拆除标记或测量数据无效', 'Invalid furniture, rooms, wall removal marks or measurements'));
    }

    const ids = new Set();
    const items = furniture.map(item => {
      const hasId = isSceneRecord(item) && Object.hasOwn(item, 'id');
      const normalizedItem = isSceneRecord(item) ? App.geom.normalizeFurn({...item, id: hasId ? item.id || 'draft' : 'draft'}) : null;
      if (!normalizedItem || !sceneDataRetained(item, normalizedItem) ||
          (hasId && (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)))){
        throw new Error(App.core.tr('家具数据、部件几何或唯一编号无效', 'Invalid furniture data, component geometry or unique identifier'));
      }
      if (hasId) ids.add(item.id);
      else delete normalizedItem.id;
      return normalizedItem;
    });
    const byRoomId = new Map(plan.rooms.map(r => [r.id, r]));
    const previousRoom = new Map(App.store.PLAN.rooms.map(r => [r.id, r]));
    const roomWasEdited = (id, field) => changes.some(({path}) => path[0] === 'state' && path[1] === 'rooms' &&
      (path.length === 2 || path[2] === id && (path.length === 3 || !field || path[3] === field)));
    for (const [id, room] of Object.entries(rooms)){
      const def = byRoomId.get(id), prior = previousRoom.get(id);
      if (!def && prior && !roomWasEdited(id)) continue;  // 删除房间时自动丢弃旧覆盖项
      const invalidRoom = () => new Error(App.core.tr(`房间属性无效：${id}`, `Invalid room properties: ${id}`));
      if (!def || !isSceneRecord(room) || Object.keys(room).some(k => k !== 'name' && k !== 'mat')) throw invalidRoom();
      for (const field of ['name', 'mat']){
        if (prior && !roomWasEdited(id, field) && room[field] === prior[field]) room[field] = def[field];
      }
      if ((Object.hasOwn(room, 'name') && (typeof room.name !== 'string' || !room.name.trim())) ||
          (Object.hasOwn(room, 'mat') && (typeof room.mat !== 'string' || !Object.hasOwn(plan.materials, room.mat)))) throw invalidRoom();
    }
    for (const item of items){
      if (item.id) continue;
      do { item.id = App.geom.uid(); } while (ids.has(item.id));
      ids.add(item.id);
    }

    const selectedWall = App.store.ui.sel?.kind === 'wall' ? remapWall(App.store.ui.sel.id) : null;
    const dimensionMarks = App.dimensions.remapMarks(App.store.state.dimensionMarks, remapWall);
    const boundsChanged = JSON.stringify(plan.bounds) !== JSON.stringify(App.store.PLAN.bounds);
    if (JSON.stringify(plan) !== JSON.stringify(App.store.PLAN)) App.store.installPlan(plan);
    const {renders, walk} = App.store.state;
    App.store.state = App.store.fixState({...stateDraft, furniture:items, measures, rooms, demolished, dimensionMarks, renders, walk});
    if (App.store.ui.sel?.kind === 'wall') App.store.ui.sel = selectedWall ? {kind:'wall', id:selectedWall} : null;
    App.store.validateSel();
    if (boundsChanged) refit();
    return true;
  }

  // 契约 §4 的操作；返回 true 表示生效，null 表示目标不存在或参数无效。
  const OPS = {
    editScene(op){ return applySceneEdit(op.changes); },
    moveFurniture(op){
      const f = App.store.getF(op.id); if (!f) return null;
      f.cx = Number.isFinite(+op.cx) ? +op.cx : f.cx + App.core.numOr(op.dx);
      f.cy = Number.isFinite(+op.cy) ? +op.cy : f.cy + App.core.numOr(op.dy);
      return true;
    },
    rotateFurniture(op){
      const f = App.store.getF(op.id); if (!f) return null;
      f.rot = App.geom.norm(App.core.numOr(op.rot, f.rot));
      return true;
    },
    resizeFurniture(op){
      const f = App.store.getF(op.id); if (!f) return null;
      if (Number.isFinite(+op.w)) f.w = Math.max(50, Math.round(+op.w));
      if (Number.isFinite(+op.d)) f.d = Math.max(50, Math.round(+op.d));
      if (Number.isFinite(+op.rot)) f.rot = App.geom.norm(+op.rot);
      return true;
    },
    addFurniture(op){
      const type = String(op.type || 'box'), w = neat(op.w), d = neat(op.d);
      if (type === 'component') return null;       // 通用构件由图纸或项目导入提供有效的部件几何
      let cx = Number.isFinite(+op.cx) ? +op.cx : null, cy = Number.isFinite(+op.cy) ? +op.cy : null;
      if (cx === null || cy === null){ const p = findFreeSpot(w, d); cx = p[0]; cy = p[1]; }
      const f = App.geom.normalizeFurn({...op, type, name:op.name || '家具', cx, cy, w, d, rot:App.geom.norm(App.core.numOr(op.rot))});
      if (!f) return null;
      if (App.store.getF(f.id)) f.id = App.geom.uid();
      App.interact.pushOut(f);
      App.store.state.furniture.push(f);
      return f.id;
    },
    deleteFurniture(op){
      const f = App.store.getF(op.id); if (!f) return null;
      App.store.state.furniture = App.store.state.furniture.filter(x => x !== f);
      if (App.store.ui.sel?.kind === 'furn' && App.store.ui.sel.id === f.id) App.store.ui.sel = null;
      return true;
    },
    setRoom(op){
      const id = op.room || op.id, def = App.plan.roomDef(id);
      if (!def) return null;
      if (typeof op.mat === 'string' && !App.store.MATS[op.mat]) return null;
      const st = App.store.roomState(id);
      if (typeof op.name === 'string' && op.name.trim()) st.name = op.name.trim();
      if (typeof op.mat === 'string') st.mat = op.mat;
      return true;
    },
    demolishWall(op){
      const id = op.id; if (!App.plan.validWallId(id)) return null;
      if (!App.store.state.demolished.includes(id)) App.store.state.demolished.push(id);
      return true;
    },
    restoreWall(op){
      const id = op.id; if (!App.plan.validWallId(id) || !App.store.state.demolished.includes(id)) return null;
      App.store.state.demolished = App.store.state.demolished.filter(x => x !== id);
      return true;
    },
    setPlan(op){
      const res = applyPlan(op.plan, {history:false});
      if (!res.ok) throw new Error(res.errors.join('；'));
      return true;
    },
  };

  // 一批操作整体作为一个撤销步骤；未知 id 跳过不抛错，返回 {applied, skipped, errors}
  function applyOps(ops){
    const list = Array.isArray(ops) ? ops : [], res = {applied:0, skipped:0, errors:[]};
    if (!list.length) return res;
    const b = App.store.snap();
    let touch = false;
    list.forEach((op, i) => {
      const name = op && op.op;
      if (typeof name !== 'string' || !Object.hasOwn(OPS, name)){
        res.skipped++; res.errors.push(App.core.tr(`第 ${i + 1} 条：未知操作 ${name}`, `#${i + 1}: unknown op ${name}`)); return;
      }
      try {
        const out = OPS[name](op);
        if (out === null || out === false){
          res.skipped++; res.errors.push(App.core.tr(`第 ${i + 1} 条（${name}）：目标不存在或参数无效`, `#${i + 1} (${name}): missing target or invalid arguments`));
        } else { res.applied++; touch = true; }
      } catch(e){ res.skipped++; res.errors.push(App.core.tr(`第 ${i + 1} 条（${name}）：${e.message}`, `#${i + 1} (${name}): ${e.message}`)); }
    });
    if (touch){ App.store.commit(b); App.store.save(); App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings(); App.draw2d.renderAll(); }
    return res;
  }

  const studio = window.Studio = {
    getPlan: () => App.core.deepCopy(App.store.PLAN),
    getState: () => App.core.deepCopy(App.store.state),
    applyPlan,
    applyOps,
    prepareCeilingEdit,
    getSelection: () => App.store.ui.sel ? {kind:App.store.ui.sel.kind, id:App.store.ui.sel.id} : {kind:null, id:null},
    select: sel => App.interact.select(sel),
    flyToRoom(id){ if (is3D() && App.view3d?.flyToRoom){
        // 室内视角下复用「进入房间」，保证裁切盒跟着目标房间走
        if (App.view3d.roomViewing?.() && App.plan.roomDef(id)) App.view3d.enterRoom(id);
        else App.view3d.flyToRoom(id);
      } else if (App.plan.roomDef(id)) App.interact.select({kind:'room', id}); },
    renderAll: () => App.draw2d.renderAll(),
    sync: () => { App.view3d?.sync(); },
    toast: msg => App.core.toast(String(msg ?? '')),
    is3D: () => is3D(),
    shot: opts => studioShot(opts || {}),
    // 任务 1 额外的便利方法（非契约）：导出工程 JSON、撤销重做
    projectJSON: () => ({version:2, plan:App.core.deepCopy(App.store.PLAN), state:App.core.deepCopy(App.store.state)}),
    undo: App.store.undo, redo: App.store.redo,
  };

  Object.assign(App.io, {
    download, dataURLBlob, is3D, TIPS, setView, studioEnterRoom, toggleFullscreen, syncFullscreen,
    drawingFurniture, applyPlan, loadPlanFile, hasStoredPlan, hydrateDefaultPlan, refit, studio,
  });
})();
