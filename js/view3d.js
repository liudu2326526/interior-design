/* Three.js 场景、相机和室内交互。
 * 依赖 App.core、App.store、App.geom、App.plan、App.draw2d、App.interact、App.assistant、App.view3dModels。
 */
(async () => {
  'use strict';
  const App = globalThis.App;
  // 外置经典脚本支持 file:// 打开，Three.js 继续通过 importmap 从 CDN 加载。
  const [THREE, {OrbitControls}, {PointerLockControls}, {RoundedBoxGeometry}, {RoomEnvironment}, {CSS2DRenderer, CSS2DObject}] = await Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/controls/PointerLockControls.js'),
    import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/environments/RoomEnvironment.js'),
    import('three/addons/renderers/CSS2DRenderer.js'),
  ]);

  /* ============================================================
   *  3D 场景（three.js）—— 与 2D 共用 state / ui，切换时带过渡动画：
   *  2D → 3D：3D 相机先以正俯视对齐当前 2D 视口（比例、位置一致），
   *           交叉淡入后镜头倾斜环绕、墙体从地面升起、家具随后立起；
   *  3D → 2D：反向——家具收起、墙体下沉、镜头回到正俯视并淡出到平面图。
   * ============================================================ */

  const stage = App.core.$('#stage'), host = App.core.$('#view3d');
  const FULL_WALL_MODE = 2.8, FOV = 45;   // 全高按钮的值；实际顶面标高来自项目
  const ceilingModel = App.ceilingModel;
  const ceiling = () => App.store.ui.ceilingPreview || App.store.state.ceiling;
  const ceilingY = id => ceilingModel.baseHeight(ceiling(),id) / 1000;
  // 世界原点跟着方案范围中心走，换户型时 2D / 3D 坐标系仍然对齐
  const PC = () => App.store.PLAN ? {x: App.store.PLAN.bounds.x + App.store.PLAN.bounds.w/2, y: App.store.PLAN.bounds.y + App.store.PLAN.bounds.h/2} : {x:6000, y:5300};
  const wx = x => (x - PC().x) / 1000, wz = y => (y - PC().y) / 1000, M = v => v / 1000;
  const SW = () => stage.clientWidth, SH = () => stage.clientHeight;
  const opt = {cut:2.8, furn:true, labels:true, night:false, hour:10, mode:'orbit'};

  let inited = false, active = false, raf = 0, anim = null, fly = null;
  let renderer, labelRenderer, scene, camera, orbit, walkCtl, hemi, sun, ground, glassMat, wallMat, capMat, frameMat;
  let archFloor, archUp, furnG, labelG, doorG, lampG, ceilingG, colliders = [], selKey = null, selHelper = null;
  let attachedBays = [];
  let sigArch = '', sigFurn = '', sigLabels = '', grow = 1, furnGrow = 1;
  const doors = [], keys = {};
  let doorPlanRev = -1, lastDoorVisibility = -Infinity;

  /* ======================= 初始化 ======================= */
  function init(){
    if (inited) return; inited = true;
    // 先探测 WebGL：不支持时告诉调用方，由 setView 退回 2D，而不是留下半初始化的场景
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')){ inited = false; throw new Error('WebGL unavailable'); }
    renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
    clipDefault = renderer.clippingPlanes ?? null;      // 室内裁切退出时恢复到该值（r160 为 null）
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(SW(), SH());
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    host.prepend(renderer.domElement);
    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(SW(), SH());
    Object.assign(labelRenderer.domElement.style, {position:'absolute', inset:'0', pointerEvents:'none'});
    host.appendChild(labelRenderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, SW()/SH(), .05, 300);
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI*.495; orbit.minDistance = 1.5; orbit.maxDistance = 45;
    walkCtl = new PointerLockControls(camera, document.body);
    walkCtl.pointerSpeed = 0;
    walkCtl.addEventListener('lock', () => {
      resetWalkLook();
      App.core.$('#walkOverlay').style.display = 'none'; App.core.$('#cross').style.display = 'block';
    });
    walkCtl.addEventListener('unlock', () => {
      clearWalkKeys();
      if (opt.mode !== 'walk') return;
      App.core.$('#walkOverlay').style.display = 'flex'; App.core.$('#cross').style.display = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!active || opt.mode !== 'walk' || !walkCtl.isLocked) return;
      const dx = e.movementX || e.mozMovementX || e.webkitMovementX || 0;
      const dy = e.movementY || e.mozMovementY || e.webkitMovementY || 0;
      lookBy(dx,dy,-.002,Math.PI/2);
    });

    hemi = new THREE.HemisphereLight(0xfffcf7, 0xf0efeb, 2.1);
    sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
    sun.castShadow = true; sun.shadow.mapSize.setScalar(App.core.COARSE ? 2048 : 4096);   // 平板 GPU 用小一点的阴影贴图
    Object.assign(sun.shadow.camera, {left:-11, right:11, top:11, bottom:-11, near:1, far:60});
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({color:0xf2eee7, roughness:1}));
    ground.rotation.x = -Math.PI/2; ground.position.y = -0.015; ground.receiveShadow = true;
    scene.add(hemi, sun, sun.target, ground);

    const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromScene(new RoomEnvironment(), .04).texture; pm.dispose();
    glassMat = new THREE.MeshPhysicalMaterial({color:0xcfe6ef, roughness:.05, transparent:true, opacity:.28, depthWrite:false, side:THREE.DoubleSide});
    wallMat = mat('#ffffff', {roughness:.93}); capMat = mat('#34312d', {roughness:.9}); frameMat = mat('#5d6166', {roughness:.5, metalness:.4});

    archFloor = new THREE.Group(); archUp = new THREE.Group(); furnG = new THREE.Group(); labelG = new THREE.Group();
    doorG = new THREE.Group(); lampG = new THREE.Group(); ceilingG = new THREE.Group();
    scene.add(archFloor, archUp, furnG, labelG, doorG, lampG, ceilingG);

    const cv = renderer.domElement; let downAt = null, look = null;
    cv.addEventListener('pointerdown', e => {
      downAt = [e.clientX, e.clientY]; App.panel.closeDrawers();
      if (touchWalk && !look){ look = {id:e.pointerId, x:e.clientX, y:e.clientY}; cv.setPointerCapture(e.pointerId); }
    });
    cv.addEventListener('pointermove', e => {
      if (!touchWalk || !look || e.pointerId !== look.id) return;
      lookBy(e.clientX - look.x, e.clientY - look.y); look.x = e.clientX; look.y = e.clientY;
    });
    cv.addEventListener('pointercancel', e => { if (look?.id === e.pointerId) look = null; });

    // 按住已选中的家具拖动：沿地面摆放（与 2D 共用网格和贴墙吸附）。
    // 在父元素上用捕获阶段监听，赶在 OrbitControls 之前关掉它，避免同时旋转镜头
    let fdrag = null;
    host.addEventListener('pointerdown', e => {
      if (e.target !== cv || !e.isPrimary || anim || opt.mode !== 'orbit' || App.store.ui.sel?.kind !== 'furn') return;
      const h = pick(e), f = h?.fid === App.store.ui.sel.id && App.store.getF(h.fid), g = f && groundAt(e.clientX, e.clientY);
      if (!g) return;
      fdrag = {id:f.id, pid:e.pointerId, sx:e.clientX, sy:e.clientY, ox:g.x - f.cx, oy:g.y - f.cy, before:App.store.snap(), moved:false};
      orbit.enabled = false; fly = null; cv.setPointerCapture(e.pointerId);
    }, true);
    cv.addEventListener('pointermove', e => {
      if (!fdrag || e.pointerId !== fdrag.pid) return;
      if (!fdrag.moved && Math.hypot(e.clientX - fdrag.sx, e.clientY - fdrag.sy) < App.core.TAP) return;
      const f = App.store.getF(fdrag.id), g = groundAt(e.clientX, e.clientY); if (!f || !g) return;
      fdrag.moved = true; cv.style.cursor = 'grabbing';
      [f.cx, f.cy] = App.interact.snapMove(f, g.x - fdrag.ox, g.y - fdrag.oy);
      furnG.children.find(o => o.userData.fid === f.id)?.position.set(wx(f.cx), 0, wz(f.cy));   // 拖动中只挪模型，松手再整体同步
    });
    const endF = e => {
      if (!fdrag || e.pointerId !== fdrag.pid) return;
      const d = fdrag; fdrag = null; orbit.enabled = true; cv.style.cursor = '';
      if (d.moved){ App.store.commit(d.before); App.draw2d.renderAll(); }
    };
    cv.addEventListener('pointerup', endF); cv.addEventListener('pointercancel', endF);

    cv.addEventListener('pointerup', e => {
      const tap = downAt && Math.hypot(e.clientX-downAt[0], e.clientY-downAt[1]) <= App.core.TAP;
      downAt = null;
      if (look?.id === e.pointerId){
        look = null;
        if (tap){ const h = pick(e); if (h?.door && h.dist < 3.5) toggleDoor(h.door); }
        return;
      }
      if (anim || opt.mode !== 'orbit' || !tap) return;
      const h = pick(e);
      if (h?.door){ if (e.button === 0) toggleDoor(h.door); }
      else if (h?.fid) App.interact.select({kind:'furn', id:h.fid});
      else if (h?.room) App.interact.select({kind:'room', id:h.room});
      else App.interact.select(null);
    });
    new ResizeObserver(() => {
      renderer.setSize(SW(), SH()); labelRenderer.setSize(SW(), SH());
      camera.aspect = SW()/SH(); camera.updateProjectionMatrix();
    }).observe(stage);
    bindUI();
  }

  /* ======================= 材质 ======================= */
  const matCache = new Map();
  let envTex = null, envK = 1;
  function mat(color, o = {}){
    const key = color + JSON.stringify(o);
    if (!matCache.has(key)){
      const m = new THREE.MeshStandardMaterial({color, roughness:.7, ...o});
      // 金属 / 光滑表面挂环境反射，墙面等哑光材质不挂，避免整体变亮
      if (envTex && (m.metalness > 0 || m.roughness < .4)){ m.envMap = envTex; m.userData.env = m.metalness > .5 ? 1 : .5; m.envMapIntensity = m.userData.env*envK; }
      matCache.set(key, m);
    }
    return matCache.get(key);
  }
  function rng(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const rgbK = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(v*k))); return `rgb(${f(n>>16&255)},${f(n>>8&255)},${f(n&255)})`; };
  // 地面贴图按真实尺寸平铺（UV 单位 = 米）
  const TEX = {
    wood:{sx:1.8, sy:.36, base:'#d6b58a', rough:.55}, walnut:{sx:1.8, sy:.36, base:'#9a6f4b', rough:.5},
    tile800:{sx:.8, sy:.8, base:'#ebe6dd', grout:'#cfc6b7', rough:.3}, tile600:{sx:.6, sy:.6, base:'#dfe3e0', grout:'#bfc6c1', rough:.35},
    antislip:{sx:.3, sy:.3, base:'#d3d8d4', grout:'#aab2ac', rough:.8}, marble:{sx:1.2, sy:1.2, base:'#f2efe9', grout:'#d9d2c4', rough:.18},
    terrazzo:{sx:.5, sy:.5, base:'#e6dfd3', rough:.4}, carpet:{sx:.3, sy:.3, base:'#c6bfd2', rough:1},
  };
  const floorMats = {};
  function floorMat(kind){
    if (floorMats[kind]) return floorMats[kind];
    // 方案里自定义的材料没有贴图参数时，按它的色板生成一块素色地砖
    const sw = App.plan.matInfo(kind).sw;
    const s = TEX[kind] || {sx:.6, sy:.6, base:/^#[0-9a-f]{3,8}$/i.test(sw) ? sw : '#dfe3e0', grout:App.geom.shade(/^#[0-9a-f]{3,8}$/i.test(sw) ? sw : '#dfe3e0', .88), rough:.35}, R = rng(kind.length*977 + 13), cv = document.createElement('canvas');
    const wood = kind === 'wood' || kind === 'walnut';
    cv.width = wood ? 1024 : 512; cv.height = wood ? 205 : 512;
    const g = cv.getContext('2d'), W = cv.width, Hh = cv.height;
    g.fillStyle = s.base; g.fillRect(0, 0, W, Hh);
    if (wood){
      const rowH = Hh/2, joints = [[W*2/3], [W/3]];
      for (let r = 0; r < 2; r++){
        let x0 = 0;
        [...joints[r], W].forEach(x1 => {
          g.fillStyle = rgbK(s.base, .9 + R()*.2); g.fillRect(x0, r*rowH, x1-x0, rowH);
          g.strokeStyle = rgbK(s.base, .8); g.globalAlpha = .35; g.lineWidth = 1.2;
          for (let k = 0; k < 7; k++){ const y = r*rowH + 6 + R()*(rowH-12); g.beginPath(); g.moveTo(x0, y);
            for (let x = x0; x <= x1; x += 40) g.lineTo(x, y + Math.sin(x*.02 + k)*2.5); g.stroke(); }
          g.globalAlpha = 1; g.fillStyle = rgbK(s.base, .62); g.fillRect(x1-1.5, r*rowH, 3, rowH); x0 = x1;
        });
        g.fillStyle = rgbK(s.base, .62); g.fillRect(0, r*rowH, W, 2.5);
      }
    } else if (kind === 'marble'){
      g.strokeStyle = 'rgba(160,150,135,.35)';
      for (let k = 0; k < 6; k++){ g.lineWidth = 1 + R()*3; g.beginPath(); g.moveTo(R()*W, 0); g.bezierCurveTo(R()*W, R()*Hh, R()*W, R()*Hh, R()*W, Hh); g.stroke(); }
    } else if (kind === 'terrazzo'){
      const cs = ['#b9a58c','#8fa3a0','#c9b7a2','#a88f76','#7e8a86'];
      for (let k = 0; k < 160; k++){ g.fillStyle = cs[k%5]; g.beginPath(); g.arc(R()*W, R()*Hh, 2 + R()*7, 0, 7); g.fill(); }
    } else {
      for (let k = 0; k < 1500; k++){ g.fillStyle = `rgba(0,0,0,${R()*.04})`; g.fillRect(R()*W, R()*Hh, 2, 2); }
    }
    if (s.grout){ g.fillStyle = s.grout; g.fillRect(0, 0, W, 3); g.fillRect(0, 0, 3, Hh); }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1/s.sx, 1/s.sy);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return floorMats[kind] = new THREE.MeshStandardMaterial({map:t, roughness:s.rough});
  }

  const {box, metal, buildFurniture} = App.view3dModels.create({THREE, RoundedBoxGeometry, wx, wz, M, mat, rng,
    materials:{get glassMat(){ return glassMat; }, get frameMat(){ return frameMat; }},
  });

  /* ======================= 建筑 ======================= */
  function clearGroup(g){ g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); g.clear(); }
  function wallBox([x0, y0, x1, y1], yb, yt, m){
    if (yt <= yb) return;
    const o = new THREE.Mesh(new THREE.BoxGeometry(M(x1-x0), yt-yb, M(y1-y0)), m || [wallMat, wallMat, capMat, wallMat, wallMat, wallMat]);
    o.position.set(wx((x0+x1)/2), (yb+yt)/2, wz((y0+y1)/2)); o.castShadow = o.receiveShadow = true; archUp.add(o);
    // 漫游辅助：墙体棱线 + 踢脚线，让相邻墙面、墙角一眼可分（仅漫游模式显示）
    const ln = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry), edgeMat); ln.position.copy(o.position); ln.userData.walkOnly = true; ln.visible = opt.mode === 'walk'; archUp.add(ln);
    if (yb <= .001){
      const p = o.geometry.parameters, sh = Math.min(.12, yt), sk = new THREE.Mesh(new THREE.BoxGeometry(p.width + .02, sh, p.depth + .02), skirtMat);
      sk.position.set(o.position.x, sh/2, o.position.z); sk.userData.walkOnly = true; sk.visible = opt.mode === 'walk'; archUp.add(sk);
    }
    return o;
  }
  const edgeMat = new THREE.LineBasicMaterial({color:0x6f675b}), skirtMat = new THREE.MeshStandardMaterial({color:'#8b7f6e', roughness:.6});
  function shapeOf(poly, flip){ const s = new THREE.Shape(); poly.forEach(([x, y], i) => s[i ? 'lineTo' : 'moveTo'](wx(x), flip ? wz(y) : -wz(y))); return s; }

  function curvedSolid(curve, width, bottom, top, material){
    const outline = App.geom.curveOutline(curve, Math.min(width, curve.radius * 1.999));
    const geometry = new THREE.ExtrudeGeometry(shapeOf(outline), {depth:top-bottom, bevelEnabled:false});
    geometry.rotateX(-Math.PI/2);
    const solid = new THREE.Mesh(geometry, material);
    solid.position.y = bottom;
    archUp.add(solid);
    return solid;
  }
  function curvedWall(curve, bottom, top){
    if (top <= bottom) return;
    const solid = curvedSolid(curve, curve.thickness, bottom, top, [capMat, wallMat]);
    solid.castShadow = solid.receiveShadow = true;
    // 圆弧采样之间的细小折线不作为漫游时的墙体棱线。
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(solid.geometry, 30), edgeMat);
    edges.position.copy(solid.position);
    edges.userData.walkOnly = true; edges.visible = opt.mode === 'walk';
    archUp.add(edges);
    if (bottom <= .001){
      const skirt = curvedSolid(curve, curve.thickness + 20, 0, Math.min(.12, top), skirtMat);
      skirt.userData.walkOnly = true; skirt.visible = opt.mode === 'walk';
    }
  }
  function curvedWindow(curve, sill, head, top){
    const glassTop = Math.min(head, top), height = glassTop - sill;
    if (height <= 0) return;
    curvedSolid(curve, Math.min(10, curve.thickness), sill, glassTop, glassMat);
    const frameWidth = Math.min(60, curve.thickness), frameHeight = Math.min(.04, height / 2);
    curvedSolid(curve, frameWidth, sill, sill + frameHeight, frameMat).castShadow = true;
    curvedSolid(curve, frameWidth, glassTop - frameHeight, glassTop, frameMat).castShadow = true;
    const segments = Math.min(96, Math.max(1, Math.round(M(curve.radius * Math.abs(curve.sweep)) / .9)));
    for (let i = 0; i <= segments; i++){
      const t = i / segments, [x, y] = App.geom.curvePoint(curve, t);
      const mullion = box(.04, height, M(frameWidth), frameMat, wx(x), sill, wz(y));
      mullion.rotation.y = -(curve.start + curve.sweep * t + Math.PI/2);
      archUp.add(mullion);
    }
  }

  const windowHead = 2.4;
  const contact = 20; // mm，容纳识别图上的端点误差
  const turn = 2 * Math.PI;
  const wrapped = angle => ((angle % turn) + turn) % turn;
  const alongAxis = r => r[2] - r[0] >= r[3] - r[1] ? 0 : 1;
  const outdoors = room => room.outdoor === true || (!room.bay && room.counted === false &&
    /露[台臺]|庭院|花[园園]|天井|室外|\b(?:terrace|garden|courtyard|patio)\b/i.test(room.name));
  // 不计面积也可能是公共前室或楼梯间。旧方案只有明确的窗台名称才沿用抬高表现。
  const isBay = room => !outdoors(room) && (Boolean(room.bay) || (room.counted === false &&
    /[飘飄凸]窗|窗[台臺]|^bay$|\bbay[- ]window\b|\bwindow[- ](?:seat|sill)\b/i.test(room.name)));
  const baySill = room => Number.isFinite(room.bay?.sillHeight) ? M(room.bay.sillHeight) : .45;

  function roomEdges(room){
    const vertices = room.vertices || room.poly, curves = App.geom.roomCurves(room);
    const area = vertices.reduce((sum, a, i) => {
      const b = vertices[(i + 1) % vertices.length];
      return sum + a[0]*b[1] - a[1]*b[0];
    }, 0);
    const direction = Math.sign(area) || 1;
    return vertices.flatMap((a, i) => {
      const b = vertices[(i + 1) % vertices.length], dx = b[0]-a[0], dy = b[1]-a[1], length = Math.hypot(dx,dy);
      if (!length) return [];
      const u = [dx/length,dy/length], normal = [-u[1]*direction,u[0]*direction];
      return [{a, b, u, normal, length, i, curve:curves.get(i)}];
    });
  }

  const projection = (point, origin, direction) =>
    (point[0] - origin[0]) * direction[0] + (point[1] - origin[1]) * direction[1];
  const alongEdge = (edge, distance) => [edge.a[0] + edge.u[0]*distance, edge.a[1] + edge.u[1]*distance];
  function segmentDistance(a, b, x, y){
    const dx = b[0]-a[0], dy = b[1]-a[1], squared = dx*dx + dy*dy;
    const t = squared ? Math.max(0, Math.min(1, ((x-a[0])*dx + (y-a[1])*dy) / squared)) : 0;
    return Math.hypot(x-a[0]-t*dx, y-a[1]-t*dy);
  }

  // 飘窗洞口从与室内相接的轮廓段确定，窗台进深与长短边无关。
  function sharedBayEdge(edge, roomEdge){
    if (edge.curve || roomEdge.curve || edge.normal[0]*roomEdge.normal[0] + edge.normal[1]*roomEdge.normal[1] > -.97) return null;
    if ([roomEdge.a,roomEdge.b].some(point => Math.abs(projection(point,edge.a,edge.normal)) > contact)) return null;
    const a = projection(roomEdge.a,edge.a,edge.u), b = projection(roomEdge.b,edge.a,edge.u);
    const from = Math.max(0,Math.min(a,b)), to = Math.min(edge.length,Math.max(a,b));
    return to - from > contact ? {from,to} : null;
  }

  function bayOpenings(edges, room, indoorEdges){
    const explicit = room.bay?.openingEdges;
    const selected = explicit?.length ? edges.filter(edge => explicit.includes(edge.i)) : edges;
    const candidates = room.bay?.roomId ? indoorEdges.filter(entry => entry.id === room.bay.roomId) : indoorEdges;
    const shared = selected.flatMap(edge => candidates.flatMap(({id,edges:boundary}) => {
      const ranges = boundary.flatMap(side => {
        const range = sharedBayEdge(edge,side);
        return range ? [range] : [];
      }).sort((a,b) => a.from-b.from);
      const runs = [];
      for (const range of ranges){
        const previous = runs.at(-1);
        if (previous && range.from <= previous.to+contact) previous.to = Math.max(previous.to,range.to);
        else runs.push({edge,roomId:id,...range});
      }
      return runs;
    })).sort((a,b) => (b.to-b.from) - (a.to-a.from));
    if (explicit?.length) return selected.map(edge => ({
      ...edge,roomId:room.bay.roomId || shared.find(run => run.edge === edge)?.roomId,
    }));
    const best = shared[0];
    if (!best) return [];
    const {edge,roomId,from,to} = best;
    return [{...edge,roomId,a:alongEdge(edge,from),b:alongEdge(edge,to),length:to-from}];
  }

  function bayLintel(edge, walls){
    if (edge.curve || Math.min(Math.abs(edge.u[0]),Math.abs(edge.u[1])) > 1e-6) return null;
    const along = Math.abs(edge.u[0]) > .5 ? 0 : 1, across = 1 - along;
    const face = edge.a[across], side = edge.normal[across];
    const start = Math.min(edge.a[along],edge.b[along]), end = Math.max(edge.a[along],edge.b[along]);
    const adjacent = walls.filter(w => {
      if (w[6] || alongAxis(w) !== along) return false;
      const near = side > 0 ? w[across] : w[across+2];
      const touches = [start,end].some(at => at >= w[along]-contact && at <= w[along+2]+contact);
      return touches && Math.abs(near-face) <= contact;
    });
    if (!adjacent.length) return null;
    const depth = Math.min(...adjacent.map(w => w[across+2] - w[across]));
    const far = face + side * depth, rect = [];
    rect[along] = start; rect[along+2] = end;
    rect[across] = Math.min(face,far); rect[across+2] = Math.max(face,far);
    return rect;
  }
  function visibleWallHeight(wall, cut){
    const height = M(App.plan.wallHeight(wall));
    return opt.cut === FULL_WALL_MODE ? height : Math.min(height,cut);
  }
  function openingTop(rect, walls, cut){
    // 洞口与相邻墙段的端点相接。有实测高度时，过梁与较低的一侧对齐。
    const along = rect[2] - rect[0] >= rect[3] - rect[1] ? 0 : 1, across = 1 - along;
    const adjacent = walls.filter(w => !w[6] && (w[along + 2] === rect[along] || w[along] === rect[along + 2])
      && w[across] < rect[across + 2] && w[across + 2] > rect[across]);
    return adjacent.some(w => w[5] !== undefined) ? Math.min(...adjacent.map(w => visibleWallHeight(w, cut))) : cut;
  }

  function spanPart(span, from, to){
    if (span.curve){
      const {curve} = span;
      return {curve:{...curve,start:curve.start+curve.sweep*from,sweep:curve.sweep*(to-from)}};
    }
    const rect = [...span.rect], along = alongAxis(rect), start = rect[along], length = rect[along+2]-start;
    rect[along] = start + length*from;
    rect[along+2] = start + length*to;
    return {rect};
  }

  function openingRange(span, opening){
    if (Boolean(span.curve) !== Boolean(opening.curve)) return null;
    if (span.curve){
      const a = span.curve, b = opening.curve;
      if (Math.hypot(a.cx-b.cx,a.cy-b.cy) > contact ||
          Math.abs(a.radius-b.radius) >= (a.thickness+b.thickness)/2) return null;
      const sign = Math.sign(a.sweep), length = Math.abs(a.sweep), extent = Math.abs(b.sweep);
      const start = sign === Math.sign(b.sweep) ? b.start : b.start + b.sweep;
      const delta = wrapped((start-a.start)*sign);
      for (const candidate of [delta-turn,delta]){
        const from = Math.max(0,candidate), to = Math.min(length,candidate+extent);
        if ((to-from)*a.radius > 1e-4) return [from/length,to/length];
      }
      return null;
    }
    const a = span.rect, b = opening.rect, along = alongAxis(a), across = 1-along;
    if (along !== alongAxis(b)) return null;
    const breadth = Math.min(a[across+2],b[across+2])-Math.max(a[across],b[across]);
    const depth = Math.min(a[across+2]-a[across],b[across+2]-b[across]);
    const from = Math.max(a[along],b[along]), to = Math.min(a[along+2],b[along+2]);
    if (breadth <= 0 || breadth < depth*.5 || to <= from) return null;
    const length = a[along+2]-a[along];
    return [(from-a[along])/length,(to-a[along])/length];
  }

  function openingSections(cuts){
    const limits = [...new Set([0,1,...cuts.flatMap(({range}) => range)])].sort((a,b) => a-b);
    return limits.slice(1).flatMap((to,i) => {
      const from = limits[i], mid = (from+to)/2;
      if (to-from < 1e-8) return [];
      return [{from,to,cuts:cuts.filter(({range:[a,b]}) => a < mid && mid < b)}];
    });
  }

  function wallSpan(span, bottom, top){
    if (span.curve) curvedWall(span.curve,bottom,top);
    else wallBox(span.rect,bottom,top);
  }

  function modelWindowEnds([x0,y0,x1,y1,curve]){
    if (curve) return [App.geom.curvePoint(curve,0),App.geom.curvePoint(curve,1)];
    if (x1-x0 >= y1-y0) return [[x0,(y0+y1)/2],[x1,(y0+y1)/2]];
    return [[(x0+x1)/2,y0],[(x0+x1)/2,y1]];
  }

  function bayWindowSill(window, bays){
    const curve = window[4], [a,b] = modelWindowEnds(window);
    const across = 1-alongAxis(window);
    const thickness = curve?.thickness ?? window[across+2]-window[across];
    const samples = [.2,.5,.8].map(t => curve ? App.geom.curvePoint(curve,t) :
      [a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
    const tolerance = thickness/2 + contact;
    const matches = bays.find(({facade}) => samples.every(([x,y]) => facade.some(edge => {
      const distance = edge.curve ? App.geom.curveDistance(edge.curve,x,y) : segmentDistance(edge.a,edge.b,x,y);
      return distance <= tolerance;
    })));
    return matches?.sill;
  }

  function windowSills(windows, bays, topY){
    // 同一排相接的直窗与转角弧窗统一下沿；明确的飘窗台面优先。
    const baySills = windows.map(window => bayWindowSill(window,bays));
    const sills = windows.map((r,i) => baySills[i] ?? (Math.abs(r[1] - topY) < 60 ? 1.4 : .9));
    if (!windows.some(r => r[4])) return sills;

    const tolerance = 20, buckets = new Map();
    const bucketKey = (x, y) => `${x}:${y}`;
    const ends = windows.map((window, index) => {
      return modelWindowEnds(window).map(([x,y]) => {
        const col = Math.floor(x / tolerance), row = Math.floor(y / tolerance);
        const point = {x, y, col, row, index}, key = bucketKey(col, row);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(point);
        return point;
      });
    });

    const visited = new Set();
    windows.forEach((window, index) => {
      if (!window[4] || visited.has(index)) return;
      const run = [index];
      visited.add(index);
      for (let queue = 0; queue < run.length; queue++){
        for (const {x,y,col,row} of ends[run[queue]]){
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++){
            for (const point of buckets.get(bucketKey(col + dx, row + dy)) || []){
              if (visited.has(point.index) || baySills[point.index] !== baySills[index] ||
                  Math.hypot(x - point.x, y - point.y) > tolerance) continue;
              visited.add(point.index);
              run.push(point.index);
            }
          }
        }
      }
      const sill = run.reduce((height, i) => Math.min(height, sills[i]), Infinity);
      run.forEach(i => { sills[i] = sill; });
    });
    return sills;
  }

  function bayStructures(rooms, walls){
    const interiors = rooms.filter(room => !isBay(room) && !outdoors(room))
      .map(room => ({id:room.id,edges:roomEdges(room)}));
    return rooms.filter(isBay).map(room => {
      const edges = roomEdges(room), mouths = bayOpenings(edges,room,interiors);
      const facade = edges.filter(edge => !mouths.some(mouth => mouth.i === edge.i));
      return {id:room.id,roomId:mouths.find(edge => edge.roomId)?.roomId,
        bounds:App.geom.bbox(room.poly),sill:baySill(room),mouths,facade,
        lintels:mouths.map(edge => bayLintel(edge,walls)).filter(Boolean)};
    });
  }

  function buildOpenings(walls, windows, bays, cut){
    const wallSpans = walls.map(wall => ({
      rect:wall,curve:wall[6],top:visibleWallHeight(wall,cut),wall,cuts:[],
    }));
    const topY = Math.min(...walls.map(w => w[1]),...windows.map(w => w[1]));
    const sills = windowSills(windows,bays,topY);
    const glazing = windows.map((rect,i) => ({rect,curve:rect[4],sill:sills[i],head:windowHead,
      top:rect[4] ? cut : openingTop(rect,walls,cut)}));
    const mouths = bays.flatMap(({sill,lintels}) => lintels.map(rect => ({
      rect,sill,head:windowHead,top:openingTop(rect,walls,cut),bay:true,
    })));
    const openings = [...glazing,...mouths];
    for (const opening of openings){
      opening.supports = wallSpans.flatMap(span => {
        const range = openingRange(opening,span);
        if (!range) return [];
        const wallRange = openingRange(span,opening);
        if (wallRange) span.cuts.push({range:wallRange,opening});
        return [{range,span}];
      });
      const heights = opening.supports.filter(({span}) => span.wall[4] !== 'low' && span.wall[5] !== undefined)
        .map(({span}) => span.top);
      if (heights.length) opening.top = Math.min(opening.top,...heights);
    }
    for (const span of wallSpans){
      for (const {from,to,cuts:part} of openingSections(span.cuts)){
        const piece = spanPart(span,from,to);
        if (!part.length) wallSpan(piece,0,span.top);
        else {
          const sill = Math.min(...part.map(({opening}) => opening.sill));
          const head = Math.max(...part.map(({opening}) => opening.head));
          if (part.some(({opening}) => !opening.bay)) wallSpan(piece,0,Math.min(span.top,sill));
          wallSpan(piece,head,span.top);
        }
      }
      colliders.push({rect:span.rect,curve:span.curve});
    }
    // 旧方案将墙在洞口处断开；仅在没有宿主墙的区段补窗台和过梁。
    for (const opening of openings){
      for (const {from,to,cuts} of openingSections(opening.supports)){
        if (cuts.length) continue;
        const piece = spanPart(opening,from,to);
        if (!opening.bay) wallSpan(piece,0,Math.min(opening.sill,opening.top));
        wallSpan(piece,opening.head,opening.top);
      }
    }
    return glazing;
  }

  function labelDoor(door){
    const action = door.open ? App.core.tr('关门','Close door') : App.core.tr('开门','Open door');
    const label = `${action} · ${door.name ? App.core.nm(door.name) : App.core.tr('推拉门','Sliding door')}`;
    const button = door.marker.element;
    door.text.textContent = action;
    button.dataset.open = String(door.open);
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  function toggleDoor(door){
    door.open = !door.open;
    labelDoor(door);
  }
  function addDoor({key, name, open, rect, height, move, blocks}){
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'door-control';
    const icon = document.createElement('i'), text = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true'); button.append(icon, text);
    const marker = new CSS2DObject(button);
    marker.position.set(wx((rect[0]+rect[2])/2), Math.max(.12, height - .12), wz((rect[1]+rect[3])/2));
    marker.center.y = .85;
    marker.visible = false;
    marker.renderOrder = 1;
    const door = {key, name, open, marker, text, progress:Number(open), move, blocks};
    move(door.progress);
    labelDoor(door);
    button.onclick = () => toggleDoor(door);
    doors.push(door); doorG.add(marker);
    return door;
  }

  // An unspecified full wall follows its adjacent rooms. A measured wall and a parapet
  // retain their own height. Mesh generation uses a derived span, never edits the Plan.
  function ceilingWallHeights(walls){
    const scene=ceiling();
    if (!scene || (scene.baseHeight===2800 && !Object.values(scene.rooms).some(r=>r.baseHeight))) return walls;
    const boundaries=App.store.ROOMS.filter(r=>!outdoors(r)).map(r=>({height:ceilingModel.baseHeight(scene,r.id),outline:r.poly}));
    return walls.map(w=>{
      if (w[5]!==undefined || w[4]==='low') return w;
      const along=alongAxis(w), across=1-along, curve=w[6];
      const tolerance=(curve ? curve.thickness : w[across+2]-w[across])/2+contact;
      const nearby=boundaries.filter(({outline})=>outline.some((a,i)=>{
        const b=outline[(i+1)%outline.length];
        if (curve) return App.geom.curveDistance(curve,(a[0]+b[0])/2,(a[1]+b[1])/2)<=tolerance;
        const overlap=Math.min(w[along+2],Math.max(a[along],b[along]))-Math.max(w[along],Math.min(a[along],b[along]));
        return overlap>contact && Math.abs(b[across]-a[across])<contact &&
          Math.abs((a[across]+b[across]-w[across]-w[across+2])/2)<=tolerance;
      }));
      const span=[...w];
      span[5]=nearby.length ? Math.max(...nearby.map(r=>r.height)) : scene.baseHeight;
      return span;
    });
  }

  const lightSites=[], furnitureLightSites=[], lensMaterials=new Map();
  const pointPool=[], spotPool=[];
  const upAxis=new THREE.Vector3(0,1,0);
  const isClockwise=poly=>poly.reduce((sum,p,i)=>{
    const q=poly[(i+1)%poly.length]; return sum+p[0]*q[1]-p[1]*q[0];
  },0)>0; // in plan coordinates, Y points down
  const ceilingJointMat = new THREE.MeshBasicMaterial({
    vertexColors:true, transparent:true, depthWrite:false, side:THREE.DoubleSide,
    polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-3,
  });
  // A narrow ambient-occlusion gradient follows the actual junction: on the slab just
  // outside an exposed return, or on the soffit where a perimeter drop meets the wall.
  function ceilingJoints(panel, loop, hole, footprint, rise, floating){
    const positions=[], colors=[], indices=[];
    const sign=(isClockwise(loop)?1:-1)*(hole?-1:1);
    const width=Math.min(80,Math.max(18,rise*280));
    const add=(p,y,alpha)=>{
      positions.push(wx(p[0]),y,wz(p[1])); colors.push(.035,.04,.045,alpha);
    };
    const normals=loop.map((p,i)=>{
      const q=loop[(i+1)%loop.length], dx=q[0]-p[0], dz=q[1]-p[1], len=Math.hypot(dx,dz)||1;
      return [sign*dz/len,-sign*dx/len];
    });
    const offsets=normals.map((n,i)=>{
      const prev=normals[(i+normals.length-1)%normals.length];
      const k=1/Math.max(.4,1+n[0]*prev[0]+n[1]*prev[1]);
      return [(n[0]+prev[0])*k,(n[1]+prev[1])*k];
    });
    for(let i=0;i<loop.length;i++){
      const j=(i+1)%loop.length, a=loop[i], b=loop[j], n=normals[i];
      const open=App.assistant.pointInPoly((a[0]+b[0])/2+n[0]*width,(a[1]+b[1])/2+n[1]*width,footprint);
      const w=open?width:-Math.min(32,width), y=open?rise-.0015:-.0015;
      const offset=(p,v)=>[p[0]+w*v[0],p[1]+w*v[1]];
      const idx=positions.length/3, alpha=open ? (floating ? .13 : .19) : .11;
      add(a,y,alpha);add(b,y,alpha);add(offset(b,offsets[j]),y,0);add(offset(a,offsets[i]),y,0);
      indices.push(idx,idx+1,idx+2,idx,idx+2,idx+3);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,4));geo.setIndex(indices);
    const wash=new THREE.Mesh(geo,ceilingJointMat);wash.renderOrder=panel.renderOrder+1;panel.add(wash);
  }
  function surfaceMesh(zone,top,room,index){
    const {poly,holes,color}=zone, bottom=M(zone.height), rise=Math.max(.001,top-bottom);
    const floating=zone.preset?.type==='island' && rise>.03;
    const thickness=floating?Math.min(.085,Math.max(.023,rise*.42)):rise;
    const outer=isClockwise(poly)?poly:poly.slice().reverse();
    const shape=shapeOf(outer);
    for (const h of holes) shape.holes.push(shapeOf(isClockwise(h)?h.slice().reverse():h));
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false});
    geometry.rotateX(-Math.PI/2);
    const pos=geometry.getAttribute('position'), normal=geometry.getAttribute('normal');
    const shades=new Float32Array(pos.count*3);
    const soffitLight=1-.14*Math.min(1,rise/.16);
    for(let i=0;i<pos.count;i++){
      const along=THREE.MathUtils.clamp(pos.getY(i)/thickness,0,1);
      // Recessed vertical returns and the underside receive less indirect skylight.
      const ny=normal.getY(i);
      let shade=.92-along*(floating ? .18 : .27);
      if(ny<-.85) shade=soffitLight;
      else if(ny>.85) shade=1;
      shades.fill(shade,i*3,i*3+3);
    }
    geometry.setAttribute('color',new THREE.BufferAttribute(shades,3));
    const panel=new THREE.Mesh(geometry,mat(color,{vertexColors:true,roughness:.91,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-index-1}));
    panel.position.y=bottom; panel.receiveShadow=true; panel.renderOrder=index+1;
    if(rise>.004){
      ceilingJoints(panel,poly,false,room.poly,rise,floating);
      for(const h of holes)ceilingJoints(panel,h,true,room.poly,rise,floating);
    }
    if(floating){
      const [x0,y0,x1,y1]=App.geom.bbox(poly), gap=rise-thickness;
      const stem=mat('#858b8b',{roughness:.57,metalness:.4});
      for(const u of [.24,.76]) for(const v of [.24,.76]){
        const x=x0+(x1-x0)*u, y=y0+(y1-y0)*v;
        if(!App.assistant.pointInPoly(x,y,poly)||holes.some(h=>App.assistant.pointInPoly(x,y,h)))continue;
        const hanger=new THREE.Mesh(new THREE.CylinderGeometry(.006,.006,gap,8),stem);
        hanger.position.set(wx(x),thickness+gap/2,wz(y)); panel.add(hanger);
      }
    }
    return panel;
  }
  function warmLight(kelvin){
    // Visual white balance anchors for warm, neutral daylight and cool-white lamps.
    const k=kelvin??3000;
    return k<=5000 ? new THREE.Color('#ffac61').lerp(new THREE.Color('#fff6e8'),(k-1800)/3200)
      : new THREE.Color('#fff6e8').lerp(new THREE.Color('#c4d9ff'),(k-5000)/5000);
  }
  function lens(color,brightness=1){
    const key=color+':'+brightness;
    if (!lensMaterials.has(key)){
      const m=new THREE.MeshStandardMaterial({color,emissive:color,roughness:.45});
      m.userData.brightness=brightness;
      lensMaterials.set(key,m);
    }
    return lensMaterials.get(key);
  }
  function fixtureMesh(room,group,f,mount,implicit=false){
    const type=f.type, root=new THREE.Group(), pitch=(f.tilt??0)*Math.PI/180;
    root.position.set(wx(f.x),mount,wz(f.y)); root.rotation.y=-(f.rotation??0)*Math.PI/180;
    root.userData.fixtureType=type; group.add(root);
    const width=M(f.width ?? ({vent:160,curtain:180,access:400,pendant:240,track:37,linear:48}[type] || 90));
    const length=M(f.length ?? ({linear:1000,track:1200,vent:600,curtain:1800,access:400}[type] || 240));
    const power=(f.intensity??100)/100, lightColor='#'+warmLight(f.kelvin).getHexString();
    const painted=f.color || (['track','spot'].includes(type)?'#303437':'#f8f9f7');
    const body=mat(painted,{roughness:.56,metalness:.13});
    const luminous=lens(lightColor,power), dark=mat('#282c2d',{roughness:.87});
    const alloy=mat('#b6bcbe',{roughness:.38,metalness:.64}), reflector=mat('#939b9c',{roughness:.25,metalness:.72});
    const mesh=(geo,m,x,y,z,parent=root)=>{
      const obj=new THREE.Mesh(geo,m);
      obj.position.set(x,y,z);obj.receiveShadow=true;parent.add(obj);return obj;
    };
    const solid=(w,h,d,x,y,z,m=body,parent=root)=>mesh(new THREE.BoxGeometry(w,h,d),m,x,y,z,parent);
    const cylinder=(r,h,x,y,m=body,parent=root,z=0)=>mesh(new THREE.CylinderGeometry(r,r,h,32),m,x,y,z,parent);
    const ring=(inner,outer,x,y,m,parent=root)=>{
      const rim=mesh(new THREE.RingGeometry(inner,outer,40),m,x,y,0,parent);
      rim.rotation.x=Math.PI/2;
    };
    const cone=(top,bottom,h,x,y,m,parent=root)=>mesh(new THREE.CylinderGeometry(top,bottom,h,40),m,x,y,0,parent);
    let offset=.05;
    if (type==='linear'){
      const depth=Math.min(.038,width*.72), trim=Math.min(.012,length*.035);
      solid(length,depth,width,0,-depth/2,0,f.color ? body : alloy);
      solid(length-2*trim,depth*.26,width*.83,0,-depth,0,luminous);
      for(const end of [-1,1]) solid(trim,depth*1.04,width*1.015,end*(length-trim)/2,-depth/2,0);
      offset=depth*1.3;
    } else if(type==='track' || type==='spot'){
      const centers=type==='track'?[-.33*length,0,.33*length]:[0];
      if(type==='track'){
        solid(length,.016,width,0,-.008,0,dark);
        for(const side of [-1,1]) solid(length,.032,width*.17,0,-.02,side*width*.41);
      }else{
        cylinder(width*.55,.016,0,-.008);
        cylinder(width*.22,.035,0,-.028,alloy);
      }
      for(const x of centers){
        const r=type==='track'?Math.min(.047,Math.max(.022,width*.86)):width*.47;
        if(type==='track') solid(r*2.1,.021,width*.74,x,-.03,0);
        const pivotY=-.047-r*.37, len=Math.max(.031,r*1.94);
        for(const side of [-1,1]) solid(r*.27,r*.63,r*.32,x+side*r*.91,pivotY+r*.19,0,alloy);
        const head=new THREE.Group();
        head.position.set(x,pivotY,0);head.rotation.z=pitch;root.add(head);
        cylinder(r,len,0,-len*.34,body,head);
        const face=-len*.84;
        cylinder(r*.87,.004,0,face-.001,dark,head);
        ring(r*.67,r*.8,0,face-.0032,reflector,head);
        cylinder(r*.61,.004,0,face-.004,luminous,head);
        const pin=cylinder(r*.16,r*2.04,0,0,alloy,head);
        pin.rotation.z=Math.PI/2;
        offset=Math.max(offset,-(pivotY+face)+.012);
      }
    } else if(type==='pendant'){
      const hang=M(f.hang??Math.min(480,mount*1000*.35)),radius=width/2,shadeH=Math.min(.32,radius*.87);
      cylinder(Math.min(.055,radius*.45),.028,0,-.014);
      cylinder(.0028,Math.max(.001,hang-.025),0,-(hang+.025)/2,dark);
      cylinder(Math.min(.027,radius*.2),.025,0,-hang,alloy);
      const shade=new THREE.CylinderGeometry(radius*.32,radius,shadeH,96), p=shade.getAttribute('position');
      for(let i=0;i<p.count;i++){
        const x=p.getX(i),z=p.getZ(i),flute=1+.013*Math.cos(24*Math.atan2(z,x));
        p.setXYZ(i,x*flute,p.getY(i),z*flute);
      }
      shade.computeVertexNormals();mesh(shade,body,0,-hang-shadeH/2,0);
      const base=-hang-shadeH;
      cylinder(radius,.009,0,base,alloy);cylinder(radius*.92,.008,0,base-.005,luminous);
      offset=hang+shadeH+.018;
    } else if(type==='vent'){
      const rim=Math.min(.012,width*.085,length*.055), inner=width-rim*2, run=length-rim*2;
      solid(length,.009,width,0,-.0045,0,dark);
      for(const side of [-1,1]){
        solid(length,.016,rim,0,-.008,side*(width-rim)/2);
        solid(rim,.016,inner,side*(length-rim)/2,-.008,0);
      }
      const n=Math.max(2,Math.min(12,Math.round(inner/.022)));
      for(let i=0;i<n;i++){
        const blade=solid(run,.003,inner*.68/n,0,-.016,inner*((i+.5)/n-.5),alloy);
        blade.rotation.x=-.40;
      }
    } else if(type==='access'){
      const frame=Math.min(length,width)*.022, latchRadius=Math.min(.009,frame);
      solid(length,.009,width,0,-.0045,0,alloy);
      solid(length-frame,.004,width-frame,0,-.01,0,dark);
      solid(length-2*frame,.005,width-2*frame,0,-.014,0);
      for(const side of [-1,1]) solid(length*.08,.003,frame*.65,side*length*.27,-.017,-width*.47,alloy);
      cylinder(latchRadius,.004,0,-.018,alloy,root,width*.40);
      solid(latchRadius,.0015,Math.min(.002,frame*.2),0,-.020,width*.40,dark);
    } else if(type==='curtain'){
      const depth=Math.min(.07,width*.28), lip=width*.055;
      solid(length,.006,width,0,-.003,0,mat('#4e5456',{roughness:.85}));
      for(const side of [-1,1]){
        solid(length,depth,lip,0,-depth/2,side*(width-lip)/2);
        solid(length*.98,depth*.21,lip*.94,0,-depth*.19,side*width*.20,alloy);
      }
      const count=Math.max(2,Math.min(18,Math.round(length/.16)));
      for(let i=0;i<count;i++) solid(lip,depth*.15,lip,length*((i+.5)/count-.5),-depth*.32,width*.20);
    } else {
      const radius=width/2,depth=Math.min(.022,radius*.32);
      cone(radius,radius*.98,depth,0,-depth/2,body);
      ring(radius*.71,radius*.95,0,-depth-.001,alloy);
      cylinder(radius*.72,.004,0,-depth-.0013,dark);
      cone(radius*.48,radius*.60,.005,0,-depth-.0038,reflector);
      cylinder(radius*.44,.003,0,-depth-.006,luminous);
      offset=depth+.011;
    }
    registerFixtureLights(room,root,f,mount,offset,length,implicit);
  }
  function registerFixtureLights(room, root, fixture, mount, offset, length, implicit){
    const type=fixture.type, level=(fixture.intensity??100)/100;
    if (!level || ['vent','access','curtain'].includes(type)) return;
    const color='#'+warmLight(fixture.kelvin).getHexString();
    const pitch=(fixture.tilt??0)*Math.PI/180, rotation=root.rotation.y;
    const directed=!implicit && ['track','spot','downlight'].includes(type);
    const direction=directed ? new THREE.Vector3(Math.sin(pitch),-Math.cos(pitch),0).applyAxisAngle(upAxis,rotation) : null;
    let positions=[];
    if (type==='track'||type==='spot'){
      // Derive the origin from the visible lens, including its head pivot, tilt and rotation.
      root.updateWorldMatrix(true,true);
      root.traverse(part=>{
        if (part.isMesh && part.material.userData.brightness!==undefined){
          positions.push(part.getWorldPosition(new THREE.Vector3()).addScaledVector(direction,.008));
        }
      });
    } else {
      const offsets=type==='linear' && length>.55 ? [-length*.28,length*.28] : [0];
      positions=offsets.map(x=>{
        const position=new THREE.Vector3(x,0,0).applyAxisAngle(upAxis,rotation).add(root.position);
        position.y=mount-offset;
        return position;
      });
    }
    const power=implicit ? 10 : ({spot:20,track:14,downlight:16,pendant:9,linear:8})[type];
    for (const position of positions){
      lightSites.push({roomId:room.id,position,direction,color,power:level*power/(type==='linear'?positions.length:1),
        range:directed?9:7,angle:type==='downlight'?.67:.39});
    }
  }
  function ceilingEdge(group,def,zones,edge,base){
    const zone=zones.find(z=>z.id===edge.zoneId);
    const surface=edge.hole!=null ? {poly:zone.holes[edge.hole]} : (zone||def);
    const points=ceilingModel.edgePoints(surface,edge.edge);
    const width=M(edge.width), depth=M(edge.depth), mount=base-M(zone?.drop||0);
    const sign=(isClockwise(ceilingModel.outline(surface)) ? 1 : -1)*(edge.hole!=null ? -1 : 1);
    const cove=edge.type==='cove', material=cove ? lens(edge.color,.65) : mat(edge.color,{roughness:.75});
    const spans=[]; let totalLength=0;
    for (let i=1;i<points.length;i++){
      const [a,b]=[points[i-1],points[i]], dx=M(b[0]-a[0]), dz=M(b[1]-a[1]);
      const len=Math.hypot(dx,dz); if (!len) continue;
      const strip=new THREE.Group();
      strip.position.set(wx((a[0]+b[0])/2)-sign*dz/len*width/2,mount,wz((a[1]+b[1])/2)+sign*dx/len*width/2);
      strip.rotation.y=-Math.atan2(dz,dx); group.add(strip);
      if (cove){
        const liner=mat('#c3b9a6');
        for (const side of [-1,1]){
          const lip=new THREE.Mesh(new THREE.BoxGeometry(len,depth,width*.12),liner);
          lip.position.set(0,-depth/2,side*width*.44); strip.add(lip);
        }
        const led=new THREE.Mesh(new THREE.BoxGeometry(len,.003,width*.70),material);
        led.position.y=-Math.max(.003,depth*.22); strip.add(led);
        spans.push({a,b,len,start:totalLength}); totalLength+=len;
      }else{
        const trim=new THREE.Mesh(new THREE.BoxGeometry(len,depth,width),material);
        trim.position.y=-depth/2; strip.add(trim);
      }
    }
    // Sample by arclength so curved and long coves wash the wall along their length.
    const samples=Math.min(6,Math.ceil(totalLength/1.65));
    for(let i=0;i<samples;i++){
      const along=totalLength*(i+.5)/samples;
      const span=spans.find(s=>along<=s.start+s.len);
      const t=(along-span.start)/span.len, dx=span.b[0]-span.a[0], dz=span.b[1]-span.a[1];
      const inset=width*.5+.035;
      const position=new THREE.Vector3(wx(span.a[0]+t*dx)-sign*M(dz)/span.len*inset,mount-depth-.042,
        wz(span.a[1]+t*dz)+sign*M(dx)/span.len*inset);
      lightSites.push({roomId:def.id,position,color:edge.color,power:Math.min(2.4,1.25*totalLength/samples),range:2.6,direction:null});
    }
  }
  function buildCeiling(def,openAir,bay){
    const data=ceiling(), design=ceilingModel.room(data,def.id), h=ceilingY(def.id);
    const group=new THREE.Group();
    group.userData.room=def.id; group.userData.height=h; group.userData.footprint=def.poly; ceilingG.add(group);
    if (!openAir){
      const geom=new THREE.ShapeGeometry(shapeOf(def.poly,true)); geom.rotateX(Math.PI/2);
      const original=new THREE.Mesh(geom,mat('#ffffff',{roughness:.97}));
      original.position.y=h; group.add(original);
    }
    ceilingModel.shapes(data,def).forEach((shape,i)=>{
      const mesh=surfaceMesh(shape,h,def,i);
      mesh.userData.zone=shape.id; group.add(mesh);
    });
    for(const edge of design.edges) ceilingEdge(group,def,design.zones,edge,h);
    for(const f of design.fixtures) fixtureMesh(def,group,f,M(ceilingModel.fixtureHeight(data,def,f)));
    // Previously saved designs did not store lamps. Retain their implied room light until edited.
    if (!openAir && !bay && def.at && !Object.hasOwn(data?.rooms||{},def.id)){
      fixtureMesh(def,group,{type:'downlight',width:440,x:def.at[0],y:def.at[1]},h,true);
    }
  }
  function updateCeilingVisibility(){
    const full=opt.cut===FULL_WALL_MODE && grow>.99;
    ceilingG.visible=full;
    lampG.visible=opt.night && grow>.99;
    if (!full) return;
    const planOrigin=PC(), px=planOrigin.x+camera.position.x*1000, py=planOrigin.y+camera.position.z*1000;
    for(const group of ceilingG.children){
      const {room,footprint,height}=group.userData;
      const selected=roomView.id===room || attachedBays.some(b=>b.roomId===roomView.id && b.id===room);
      group.visible=opt.mode==='walk' || (camera.position.y<height+.05 &&
        (roomView.id ? selected : App.assistant.pointInPoly(px,py,footprint)));
    }
  }
  function resizeLightPool(pool, count, spot){
    while (pool.length>count){
      const light=pool.pop();
      lampG.remove(light);
      light.shadow.dispose();
    }
    while (pool.length<count){
      const light=spot ? new THREE.SpotLight(0xffffff,0,8,.6,.42,2) : new THREE.PointLight(0xffffff,0,8,2);
      // Only the nearest light of each kind gets a shadow map. Shadow maps are reused between edits.
      light.castShadow=pool.length===0 && (spot || !App.core.COARSE);
      if (light.castShadow){
        light.shadow.mapSize.setScalar(spot ? 512 : 256);
        light.shadow.camera.near=.035;
        light.shadow.bias=-.00035; light.shadow.normalBias=.012;
        light.shadow.autoUpdate=false; light.shadow.needsUpdate=true;
      }
      pool.push(light); lampG.add(light);
    }
  }

  function syncLightPool(){
    const all=lightSites.concat(opt.furn ? furnitureLightSites : []);
    const spots=all.filter(s=>s.direction).length, points=all.length-spots;
    const budget=App.core.COARSE ? 6 : 8;
    const pointCount=Math.min(points,Math.max(Math.floor(budget/2),budget-spots));
    resizeLightPool(pointPool,pointCount,false);
    resizeLightPool(spotPool,Math.min(spots,budget-pointCount),true);
  }

  const lastLightPosition=new THREE.Vector3(Infinity,Infinity,Infinity);
  let lastLightUpdate=-Infinity, lastLightRoom, furnitureWasLit=false;
  function updateRoomLights(force, now=performance.now()){
    lampG.visible=opt.night && grow>.99;
    if (!force && (!lampG.visible || now-lastLightUpdate<160)) return;
    lastLightUpdate=now;
    const focus=opt.mode==='walk' || roomView.id ? camera.position : orbit.target;
    const includeFurniture=opt.furn && furnGrow>.99;
    const doorsMoving=doors.some(d=>Math.abs(Number(d.open)-d.progress)>.003);
    if (!force && !doorsMoving && lastLightRoom===roomView.id && includeFurniture===furnitureWasLit &&
        focus.distanceToSquared(lastLightPosition)<.015) return;
    lastLightRoom=roomView.id;
    furnitureWasLit=includeFurniture;
    if (lampG.visible) lastLightPosition.copy(focus);
    else lastLightPosition.set(Infinity,Infinity,Infinity);
    const visible=lampG.visible ? lightSites.concat(includeFurniture ? furnitureLightSites : []) : [];
    let nearRoom=roomView.id;
    if (!nearRoom && opt.mode==='walk'){
      const origin=PC(), x=origin.x+focus.x*1000, y=origin.y+focus.z*1000;
      nearRoom=App.store.ROOMS.find(r=>App.assistant.pointInPoly(x,y,r.poly))?.id;
    }
    const points=[], spots=[];
    for(const site of visible){
      if (roomView.id && site.roomId!==roomView.id &&
          !attachedBays.some(bay=>bay.id===site.roomId && bay.roomId===roomView.id)) continue;
      // Rank neighboring rooms behind the walker's room; within it keep nearby task lighting active.
      const score=site.position.distanceToSquared(focus)+(nearRoom && site.roomId!==nearRoom ? 64 : 0);
      (site.direction ? spots : points).push({site,score});
    }
    function assign(pool,list){
      list.sort((a,b)=>a.score-b.score);
      pool.forEach((light,i)=>{
        const site=list[i]?.site;
        light.intensity=site?.power??0;
        if (!site){ light.userData.site=null; return; }
        const changed=light.userData.site!==site;
        light.userData.site=site;
        light.position.copy(site.position); light.color.set(site.color); light.distance=site.range;
        if (light.isSpotLight){
          light.angle=site.angle;
          light.target.position.copy(site.position).add(site.direction); light.target.updateMatrixWorld();
        }
        if (light.castShadow && (force || changed || doorsMoving)) light.shadow.needsUpdate=true;
      });
    }
    assign(pointPool,points); assign(spotPool,spots);
  }

  function buildArch(){
    const previousDoors = new Map(doorPlanRev === App.store.planRev ? doors.map(d => [d.key, d.open]) : []);
    doorPlanRev = App.store.planRev;
    doorG.clear(); lastDoorVisibility = -Infinity;
    clearGroup(archFloor); clearGroup(archUp); clearGroup(ceilingG);
    lensMaterials.forEach(m=>m.dispose()); lensMaterials.clear(); lightSites.length = 0; doors.length = 0; colliders = [];
    const top = opt.cut === FULL_WALL_MODE ? ceilingY() : opt.cut;
    const walls = ceilingWallHeights(App.store.WALLS.filter((_, i) => !App.store.state.demolished.includes('w'+i)));
    // 阴影相机跟着方案大小走，换大户型也不会被裁掉
    const ext = Math.max(App.store.BOUNDS.w, App.store.BOUNDS.h) / 2000 + 3;
    Object.assign(sun.shadow.camera, {left:-ext, right:ext, top:ext, bottom:-ext, near:1, far:ext*4});
    sun.shadow.camera.updateProjectionMatrix();
    const bays = bayStructures(App.store.ROOMS,walls);
    attachedBays = bays;
    const bayById = new Map(bays.map(bay => [bay.id,bay]));
    App.store.ROOMS.forEach(r => {
      const m = floorMat(App.store.roomState(r.id).mat), bay = bayById.get(r.id), openAir = outdoors(r);
      const geo = bay ? new THREE.ExtrudeGeometry(shapeOf(r.poly), {depth:bay.sill, bevelEnabled:false}) : new THREE.ShapeGeometry(shapeOf(r.poly));
      geo.rotateX(-Math.PI/2);
      const fl = new THREE.Mesh(geo, bay ? [m, mat('#e9e4da')] : m);
      fl.receiveShadow = true; fl.userData.room = r.id;
      if (bay){ fl.castShadow = true; archUp.add(fl); } else archFloor.add(fl);
      buildCeiling(r,openAir,bay);
    });
    [...App.store.DOORS, ...App.store.SLIDES].forEach(d => { const [x0, y0, x1, y1] = d.rect; const s = box(M(x1-x0), .012, M(y1-y0), mat('#d8d0c0', {roughness:.3}), wx((x0+x1)/2), 0, wz((y0+y1)/2)); s.castShadow = false; archFloor.add(s); });
    const glazing = buildOpenings(walls,App.store.WINS,bays,top);
    bays.forEach(bay => bay.mouths.forEach(edge => {
      const rect = edge.curve ? App.geom.curveBounds(edge.curve) : App.geom.bbox([edge.a,edge.b]);
      colliders.push({rect,edge});
    }));
    glazing.forEach(({rect:r,curve,sill,head,top:windowTop}) => {
      colliders.push({rect:r,curve});
      if (curve){ curvedWindow(curve,sill,head,windowTop); return; }
      const gTop = Math.min(head, windowTop); if (gTop <= sill) return;
      const [x0, y0, x1, y1] = r, hz = (x1-x0) >= (y1-y0), L = M(hz ? x1-x0 : y1-y0), gh = gTop - sill, cx = wx((x0+x1)/2), cz = wz((y0+y1)/2);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .01, gh, hz ? .01 : L), glassMat); pane.position.set(cx, sill + gh/2, cz); archUp.add(pane);
      const n = Math.max(1, Math.round(L/.9));
      for (let k = 0; k <= n; k++){ const t = -L/2 + k*L/n, mu = new THREE.Mesh(new THREE.BoxGeometry(hz ? .04 : .06, gh, hz ? .06 : .04), frameMat);
        mu.position.set(cx + (hz ? t : 0), sill + gh/2, cz + (hz ? 0 : t)); mu.castShadow = true; archUp.add(mu); }
      [sill + .02, gTop - .02].forEach(y => { const tr = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .06, .04, hz ? .06 : L), frameMat); tr.position.set(cx, y, cz); archUp.add(tr); });
    });
    App.store.DOORS.forEach((d, i) => {
      const doorTop = openingTop(d.rect, walls, top);
      const lintel = wallBox(d.rect, 2.1, doorTop);
      const pivot = new THREE.Group(), L = M(d.len), dh = Math.min(2.05, doorTop);
      pivot.position.set(wx(d.h[0]), 0, wz(d.h[1]));
      const leaf = box(L, dh, .04, mat(d.entry ? '#6b4f3a' : '#efe6d8', {roughness:.5}), L/2);
      const a0 = Math.atan2(-d.c[1], d.c[0]), a1 = Math.atan2(-d.o[1], d.o[0]);
      const turn = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)), key = `swing-${i}`;
      const door = addDoor({key, name:d.name, open:previousDoors.get(key) ?? true, rect:d.rect, height:dh,
        move: t => { pivot.rotation.y = a0 + turn*t; },
        blocks(x, z, r){
          const a = pivot.rotation.y, px = pivot.position.x, pz = pivot.position.z;
          const dx = Math.cos(a)*L, dz = -Math.sin(a)*L;
          const t = clamp01(((x-px)*dx + (z-pz)*dz)/(L*L));
          return Math.hypot(x - px - t*dx, z - pz - t*dz) < r*.8;
        }});
      door.lintel = lintel;
      leaf.userData.door = door; pivot.add(leaf);
      if (dh > .05){
        const knob = new THREE.Mesh(new THREE.SphereGeometry(.03, 12, 8), metal());
        knob.position.set(L - .07, Math.min(1, dh - .05), 0); knob.scale.z = 2.2;
        knob.userData.door = door; pivot.add(knob);
      }
      archUp.add(pivot);
    });
    App.store.SLIDES.forEach(({rect, v}, i) => {
      const [x0, y0, x1, y1] = rect, head = v ? 2.4 : 2.1, slideTop = openingTop(rect, walls, top);
      const lintel = wallBox(rect, head, slideTop);
      const L = M(v ? y1-y0 : x1-x0), ph = Math.min(head, slideTop), pl = L*.55;
      const start = v ? wz(y0) : wx(x0), across = v ? wx((x0+x1)/2) : wz((y0+y1)/2);
      const axis = v ? 'z' : 'x', travel = L - pl, key = `slide-${i}`;
      const panels = [-.02, .02].map(off => {
        const group = new THREE.Group();
        group.position[v ? 'x' : 'z'] = across + off;
        const pane = new THREE.Mesh(new THREE.BoxGeometry(v ? .02 : pl, ph, v ? pl : .02), glassMat);
        pane.position.y = ph/2; group.add(pane);
        if (ph > .06) [ph - .03, .03].forEach(y => {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(v ? .04 : pl, .05, v ? pl : .04), frameMat);
          frame.position.y = y; group.add(frame);
        });
        [-pl/2, pl/2].forEach(at => {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(.04, ph, .04), frameMat);
          frame.position.y = ph/2; frame.position[axis] = at; group.add(frame);
        });
        archUp.add(group);
        return group;
      });
      panels[0].position[axis] = start + pl/2;
      const door = addDoor({key, name:'', open:previousDoors.get(key) ?? false, rect, height:ph,
        move: t => { panels[1].position[axis] = start + pl/2 + travel*(1-t); },
        blocks(x, z, r){
          const along = v ? z : x, distance = Math.abs((v ? x : z) - across);
          return distance < r*.8 && along > start - r*.65 && along < panels[1].position[axis] + pl/2 + r*.65;
        }});
      door.lintel = lintel;
      panels.forEach(p => p.children.forEach(mesh => { mesh.userData.door = door; }));
    });
    applyGrow();
  }

  function buildFurn(){
    clearGroup(furnG);
    furnitureLightSites.length=0;
    const origin=PC();
    for (const f of App.store.state.furniture){
      const group=buildFurniture(f);
      furnG.add(group);
      if (!group.userData.emitters) continue;
      group.updateMatrix();
      for (const source of group.userData.emitters){
        const position=source.position.clone().applyMatrix4(group.matrix);
        const x=origin.x+position.x*1000, y=origin.y+position.z*1000;
        const room=App.store.ROOMS.find(r=>App.assistant.pointInPoly(x,y,r.poly));
        const direction=source.direction?.clone().transformDirection(group.matrix);
        furnitureLightSites.push({...source,position,direction,roomId:room?.id});
      }
    }
    furnG.visible = opt.furn; selKey = null; applyGrow();
  }

  function buildLabels(){
    labelG.children.slice().forEach(o => { o.element.remove(); labelG.remove(o); });
    App.store.ROOMS.filter(r => r.at).forEach(r => {
      const el = document.createElement('div'); el.className = 'rlabel';
      el.innerHTML = `${App.core.esc(App.core.nm(App.store.roomState(r.id).name))}<small>${App.geom.roomArea(r).toFixed(1)}m²</small>`;
      const o = new CSS2DObject(el); o.position.set(wx(r.at[0]), (opt.cut === FULL_WALL_MODE ? ceilingY(r.id) : opt.cut) + .15, wz(r.at[1])); o.visible = labelG.visible; labelG.add(o);
    });
    const counted = App.store.ROOMS.filter(r => r.counted !== false);
    App.core.$('#roomList').innerHTML = counted.map(r => `<div class="rrow">
      <button data-room="${App.core.esc(r.id)}"><span>${App.core.esc(App.core.nm(App.store.roomState(r.id).name))}</span><small>${App.geom.roomArea(r).toFixed(2)} m²</small></button>
      <button class="rent" data-enter="${App.core.esc(r.id)}"></button></div>`).join('')
      + `<div class="rrow"><button data-room="__all"><span>${App.core.tr('全屋', 'Whole home')}</span><small>${counted.reduce((a, r) => a + App.geom.roomArea(r), 0).toFixed(2)} m²</small></button></div>`;
    syncRoomListSel();
    document.querySelectorAll('#roomList button[data-room]').forEach(b => b.onclick = () => {
      const id = b.dataset.room;
      if (id === roomView.id){ exitRoom(); return; }
      if (id === '__all'){
        if (roomView.id) exitRoom();
        else if (opt.mode !== 'walk') flyTo(isoWhole());
        syncRoomListSel(id);
        return;
      }
      if (opt.mode === 'walk') setMode('orbit');
      if (roomView.id){
        enterRoom(id);
      } else {
        flyToRoom(id);
        syncRoomListSel(id);
      }
    });
    document.querySelectorAll('#roomList button[data-enter]').forEach(b => b.onclick = () => {
      const id = b.dataset.enter;
      if (id === roomView.id) exitRoom();
      else enterRoom(id);
    });
  }

  // 只重建变化的部分（换方案也算变化：planRev）
  function sync(force){
    if (!inited || (!active && !force)) return;
    // 家具的 3D 坐标由 PLAN.bounds 中心换算（wx/wz），换方案时必须一起重建
    const a = JSON.stringify([App.store.planRev, App.store.PLAN.name, App.store.state.rooms, App.store.state.demolished, ceiling(), opt.cut]), f = JSON.stringify([App.store.planRev, App.store.state.furniture]), l = JSON.stringify([App.store.planRev, App.store.state.rooms, ceiling(), opt.cut]);
    const sourcesChanged=force || a!==sigArch || f!==sigFurn;
    if (force || a !== sigArch){ sigArch = a; buildArch(); }
    if (force || f !== sigFurn){ sigFurn = f; buildFurn(); }
    if (sourcesChanged){ syncLightPool(); applyLight(); }
    if (force || l !== sigLabels){ sigLabels = l; buildLabels(); }
    // 室内视角：面积 / 地面材质 / 名称变化后标题条实时更新，房间轮廓变了就重算裁切面
    if (roomView.id){
      if (!App.plan.roomDef(roomView.id)) exitRoom({silent: true});
      else {
        renderRoomBar();
        if (roomView.arrived && !roomView.fallback) applyRoomClip(roomView.id);
      }
    }
  }

  // CSS2DRenderer 只看标签自身的 visible，不继承父级，所以逐个设置
  function showLabels(v){ labelG.visible = v; labelG.children.forEach(o => o.visible = v); }
  function applyGrow(){
    if (!inited) return;
    archUp.scale.y = Math.max(grow, .001);
    furnG.scale.y = Math.max(furnGrow, .001);
    updateCeilingVisibility();
  }

  /* ======================= 日照 / 夜景 ======================= */
  function applyLight(){
    const t = (opt.hour - 6) / 12, az = Math.PI * (.15 + t*.7), el = Math.sin(Math.PI*t) * 1.05 + .15, warm = 1 - Math.sin(Math.PI*t);
    sun.position.set(Math.cos(az)*18, Math.sin(el)*20 + 3, -Math.sin(az)*10 + 8); sun.target.position.set(0, 0, 0);
    sun.color.setHSL(.095, .42 + warm*.36, .97 - warm*.13);
    sun.intensity = opt.night ? .05 : 1.4 + Math.sin(Math.PI*t)*1.6;
    sun.castShadow=!opt.night;
    hemi.color.set(opt.night ? 0xdce7ff : 0xfffcf7);
    hemi.groundColor.set(opt.night ? 0xb8bfd1 : 0xf0efeb);
    hemi.intensity = opt.night ? .14 : 2.1;
    scene.background = new THREE.Color(opt.night ? 0x1c2130 : 0xf7f4ee);
    ground.material.color.set(opt.night ? 0x2a2e38 : 0xf2eee7);
    for (const m of lensMaterials.values()) m.emissiveIntensity=m.userData.brightness*(opt.night ? 2 : .22);
    for (const m of matCache.values()){
      if (m.userData.lampGlow) m.emissiveIntensity=m.userData.lampGlow*(opt.night ? 1.8 : .22);
    }
    updateRoomLights(true);
    renderer.toneMappingExposure = opt.night ? 1.25 : 1.05;
    envK = opt.night ? .15 : 1; matCache.forEach(m => { if (m.envMap) m.envMapIntensity = m.userData.env*envK; });
    const h = Math.floor(opt.hour), m = Math.round((opt.hour - h)*60);
    App.core.$('#sunT').textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  /* ======================= 相机位姿 / 动画 ======================= */
  const ease = t => t < .5 ? 4*t*t*t : 1 - (-2*t + 2)**3/2;
  const clamp01 = t => Math.max(0, Math.min(1, t));
  const pose = (t, p) => ({t, p});
  // 与当前 2D 视口完全重合的正俯视位姿：透视相机在该高度下，地面可视高度 = 2D 视口高度
  function planPose(){
    const cx = App.store.view.x0 + SW()/2/App.store.view.s, cy = App.store.view.y0 + SH()/2/App.store.view.s, visH = SH()/App.store.view.s/1000;
    const dist = visH / 2 / Math.tan(FOV/2*Math.PI/180), t = new THREE.Vector3(wx(cx), 0, wz(cy));
    return pose(t, new THREE.Vector3(t.x, dist, t.z + 1e-4));
  }
  function isoFrom(P){
    const d = THREE.MathUtils.clamp(P.p.y, 5, 30), dir = new THREE.Vector3(.3, .82, .49).normalize();
    return pose(P.t.clone(), P.t.clone().addScaledVector(dir, d));
  }
  const isoWhole = () => pose(new THREE.Vector3(0, 0, 0), new THREE.Vector3(.29, .80, .52).normalize().multiplyScalar(wholeDist()));
  const topWhole = () => pose(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, wholeDist()*.98, 1e-4));
  // 鸟瞰距离跟着方案大小走（125-C 约 19，空壳约 12）
  const wholeDist = () => Math.max(7, Math.max(App.store.BOUNDS.w, App.store.BOUNDS.h) / 1000 * 1.22);
  const curPose = () => pose(orbit.target.clone(), camera.position.clone());
  // 以目标点为中心做球坐标插值：镜头沿弧线倾斜环绕，而不是直线穿越
  function camTween(A, B, e){
    const t = A.t.clone().lerp(B.t, e);
    const sa = new THREE.Spherical().setFromVector3(A.p.clone().sub(A.t)), sb = new THREE.Spherical().setFromVector3(B.p.clone().sub(B.t));
    let dth = sb.theta - sa.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    const s = new THREE.Spherical(sa.radius + (sb.radius - sa.radius)*e, sa.phi + (sb.phi - sa.phi)*e, sa.theta + dth*e);
    camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(s)); camera.lookAt(t); orbit.target.copy(t);
  }
  function setPose(P){ camera.position.copy(P.p); orbit.target.copy(P.t); camera.lookAt(P.t); }
  function animate(dur, fn){ return new Promise(res => { anim = {t0:performance.now(), dur, fn, res}; }); }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function flyTo(B, dur = 900, done = null){ fly = {t0:performance.now(), dur, A:curPose(), B, done}; }
  function flyToRoom(id){
    const r = App.plan.roomDef(id); if (!r) return;
    const xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]);
    const t = new THREE.Vector3(wx((Math.min(...xs)+Math.max(...xs))/2), .6, wz((Math.min(...ys)+Math.max(...ys))/2));
    const size = M(Math.max(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)));
    const dir = camera.position.clone().sub(orbit.target).setY(0); if (dir.lengthSq() < .01) dir.set(.6, 0, .8); dir.normalize();
    const dist = size*1.3 + 2.2;
    flyTo(pose(t, new THREE.Vector3(t.x + dir.x*dist*.7, dist*1.05, t.z + dir.z*dist*.7)));
  }
  // 效果图机位（任务 4）：目标 / 相机都用 2D 世界坐标 mm（y 轴向下，高度另给 mm）
  function flyToWorld(tx, ty, th, cx, cy, ch){
    const t = new THREE.Vector3(wx(tx), Math.max(0, (Number(th) || 0)/1000), wz(ty));
    const p = new THREE.Vector3(wx(cx), Math.max(.3, (Number.isFinite(+ch) ? +ch : 1500)/1000), wz(cy));
    flyTo(pose(t, p));
  }

  /* ======================= 房间内部视角（任务 5） =======================
   * 进房 → 眼高 1.55m 站在房间一端朝长轴看；室内用 renderer.clippingPlanes
   * 六面按房间 AABB 裁切，退出 / 换 2D 时恢复默认（null = 无全局裁切面）。
   * 材质 / 驱动不支持裁切时退回「剖切墙」（opt.cut = 1.2）。
   * ===================================================================== */
  const ROOM_EYE = 1.55, ROOM_LOOK = 1.18, ROOM_PAD = .2;   // 眼高 / 视线高 / 裁切外扩（米）
  const roomView = {id: null, arrived: false, fallback: false, planes: null};
  let clipDefault = null;                                   // renderer.clippingPlanes 的出厂值（r160 为 null）

  // 房间 AABB（世界米）
  function roomBox(id){
    const r = App.plan.roomDef(id); if (!r) return null;
    const [x0, y0, x1, y1] = App.geom.bbox(r.poly);
    return {X0: wx(x0), X1: wx(x1), Z0: wz(y0), Z1: wz(y1)};
  }
  // 进房位姿：站在长轴一端，沿长轴看向房间另一侧；AABB 落在异形房间里时回退到多边形重心
  function interiorPose(id){
    const r = App.plan.roomDef(id); if (!r) return null;
    const [x0, y0, x1, y1] = App.geom.bbox(r.poly), w = x1 - x0, d = y1 - y0;
    if (!(w > 0) || !(d > 0)) return null;
    const longX = w >= d, len = longX ? w : d;
    const end = Math.min(Math.max(len * .1, 260), Math.min(750, len * .34));   // 离开短边一点，避免穿墙
    let cx = longX ? x0 + end : x0 + w / 2;
    let cy = longX ? y0 + d / 2 : y0 + end;
    if (!App.assistant.pointInPoly(cx, cy, r.poly)){ const c = App.geom.polyCenter(r.poly); cx = c[0]; cy = c[1]; }
    const tx = longX ? x0 + w * .64 : cx, ty = longX ? cy : y0 + d * .64;
    return pose(new THREE.Vector3(wx(tx), ROOM_LOOK, wz(ty)), new THREE.Vector3(wx(cx), ROOM_EYE, wz(cy)));
  }
  function ceilingPose(id){
    const def=App.plan.roomDef(id), poly=def.poly, h=ceilingY(id);
    const [x0,y0,x1,y1]=App.geom.bbox(poly), w=x1-x0, d=y1-y0;
    const at=(u,v)=>[x0+w*u,y0+d*v];
    const inside=p=>App.assistant.pointInPoly(p[0],p[1],poly);
    const xMargin=Math.min(.18,650/w), yMargin=Math.min(.18,650/d);
    // A diagonal catches two walls, the ceiling's depth and the opposite corner in one view.
    // Additional points accommodate concave or curved rooms with inaccessible AABB corners.
    const corners=[[xMargin,yMargin],[1-xMargin,1-yMargin],[xMargin,1-yMargin],[1-xMargin,yMargin]];
    const candidates=corners.map(([u,v])=>at(u,v)).filter(inside);
    for(const u of [.14,.5,.86]) for(const v of [.14,.5,.86]){
      const p=at(u,v); if(inside(p)) candidates.push(p);
    }
    let best;
    for(const from of candidates) for(const to of candidates){
      const dx=to[0]-from[0], dy=to[1]-from[1], span=dx*dx+dy*dy;
      if (span<1 || (best && best.span>=span)) continue;
      if ([.2,.4,.6,.8].every(t=>inside([from[0]+dx*t,from[1]+dy*t]))) best={from,dx,dy,span};
    }
    if (!best) return interiorPose(id);
    const {from,dx,dy}=best;
    const eye=Math.min(1.12,h*.39), targetHeight=h*.88;
    return pose(new THREE.Vector3(wx(from[0]+dx*.62),targetHeight,wz(from[1]+dy*.62)),
      new THREE.Vector3(wx(from[0]),eye,wz(from[1])));
  }
  function roomLens(wide){
    const fov=wide ? 68 : FOV;
    if(camera.fov!==fov){camera.fov=fov;camera.updateProjectionMatrix();}
  }
  function interiorWalkPose(id){
    const P = interiorPose(id); if (!P) return entryPose();
    return [P.p.x, P.p.y, P.p.z, P.t.x, P.t.y, P.t.z];
  }
  // 室内裁切保留与此房间有洞口连接的飘窗及其外侧窗框。
  function roomClipBox(id){
    const b = roomBox(id); if (!b) return null;
    const out = {...b};
    for (const bay of attachedBays){
      if (bay.roomId !== id) continue;
      const [x0,y0,x1,y1] = bay.bounds;
      out.X0 = Math.min(out.X0,wx(x0)); out.X1 = Math.max(out.X1,wx(x1));
      out.Z0 = Math.min(out.Z0,wz(y0)); out.Z1 = Math.max(out.Z1,wz(y1));
    }
    return out;
  }
  // 六面裁切：AABB 外扩 ROOM_PAD，让贴墙的墙体内表面 / 窗框留下来；
  // 地面 y=0 与天花 y=H 正好落在裁切面上会产生条纹，所以上下各留 5cm 余量
  function roomClipPlanes(id){
    const b = roomClipBox(id); if (!b) return null;
    const N = THREE.Plane, V = THREE.Vector3;
    const X0 = b.X0 - ROOM_PAD, X1 = b.X1 + ROOM_PAD, Z0 = b.Z0 - ROOM_PAD, Z1 = b.Z1 + ROOM_PAD;
    return [
      new N(new V(1, 0, 0), -X0),  new N(new V(-1, 0, 0), X1),
      new N(new V(0, 0, 1), -Z0),  new N(new V(0, 0, -1), Z1),
      new N(new V(0, 1, 0), .05),  new N(new V(0, -1, 0), ceilingY(id) + .05),
    ];
  }
  // 应用 / 清除裁切；出错时退回剖切墙
  function applyRoomClip(id){
    if (!renderer) return false;
    if (!id){
      renderer.clippingPlanes = clipDefault ?? null;
      roomView.planes = null;
      return false;
    }
    try {
      if (!('clippingPlanes' in renderer)) throw new Error('clipping unsupported');
      const planes = roomClipPlanes(id);
      if (!planes) throw new Error('room not found');
      renderer.clippingPlanes = planes;
      roomView.planes = planes;
      return true;
    } catch(e){
      roomView.fallback = true;
      roomView.planes = null;
      try { renderer.clippingPlanes = clipDefault ?? null; } catch(_) {}
      if (opt.cut === FULL_WALL_MODE){
        opt.cut = 1.2; syncCutBtns(); sync(true);             // 退回剖切墙：墙切到 1.2m，仍能看见室内
        App.core.toast(App.core.tr('当前环境不支持室内裁切，已退回剖切墙视图', 'Interior clipping is not supported here — using the cut-wall view'));
      }
      return false;
    }
  }
  function clipCount(){ return renderer && Array.isArray(renderer.clippingPlanes) ? renderer.clippingPlanes.length : 0; }
  // 左侧列表保留相机目标的高亮，只有当前室内房间提供退出按钮。
  function syncRoomListSel(id = roomView.id ?? (opt.mode === 'walk' ? '__all' : null)){
    document.querySelectorAll('#roomList button[data-room]').forEach(b => b.classList.toggle('on', !!id && b.dataset.room === id));
    document.querySelectorAll('#roomList button[data-enter]').forEach(b => {
      const inside = b.dataset.enter === roomView.id;
      b.textContent = inside ? App.core.tr('退出房间', 'Exit room') : App.core.tr('进入房间', 'Enter room');
      b.title = inside ? App.core.tr('退出当前房间', 'Exit the current room')
        : App.core.tr('进入房间，从室内查看', 'Enter the room and look around from inside');
    });
  }

  // 标题条：房间名 / 面积 / 地面材质，随 state 变化实时刷新
  function renderRoomBar(){
    const bar = App.core.$('#roomBar'); if (!bar) return;
    const id = roomView.id, def = id && App.plan.roomDef(id);
    if (!def || !active || opt.mode === 'walk'){
      bar.hidden = true;
      return;
    }
    const st = App.store.roomState(id), m = App.plan.matInfo(st.mat);
    bar.hidden = false;
    App.core.$('#rbName').textContent = App.core.nm(st.name);
    App.core.$('#rbMeta').innerHTML = `<i class="sw" style="background:${App.core.esc(m.sw)}"></i><span>${App.geom.fmt(App.geom.roomArea(def))} m² · ${App.core.esc(App.core.nm(m.name))}</span>`;
    const btn = App.core.$('#rbRender');
    if (btn) btn.disabled = !!(App.assistant.renderState && App.assistant.renderState.busy);
  }

  function enterRoom(id, opts = {}){
    if (!inited || !active || !App.plan.roomDef(id)) return false;
    // 3D 入场 / 退场动画期间收到请求：等动画结束再进，避免和 animate() 抢相机
    if (anim){ setTimeout(() => { if (active && App.plan.roomDef(id)) enterRoom(id, opts); }, 140); return true; }
    if (App.ceilingShowcase?.roomChanged(id)) sync();
    const P = opts.ceiling ? ceilingPose(id) : interiorPose(id);
    if (!P) return false;
    if (opt.mode === 'walk') setMode('orbit');
    roomLens(Boolean(opts.ceiling));
    if (opt.cut !== FULL_WALL_MODE){ opt.cut = FULL_WALL_MODE; syncCutBtns(); sync(); }   // 室内需要整墙与天花
    roomView.id = id; roomView.arrived = false; roomView.fallback = false;
    stage.classList.add('roomview');
    orbit.enabled = false; fly = null;
    syncRoomListSel(id);
    applyRoomClip(null);                                      // 飞行途中先不裁，落地再按目标房间裁
    showLabels(false);
    renderRoomBar();
    const msg = App.core.$('#rbMsg'); if (msg) msg.textContent = '';
    App.interact.select?.({kind: 'room', id});                      // 右侧面板同步到该房间
    flyTo(P, opts.instant ? 1 : 950, () => {
      roomView.arrived = true;
      applyRoomClip(roomView.id);
      orbit.enabled = false;
      showLabels(false);
      renderRoomBar();
    });
    return true;
  }

  function exitRoom(opts = {}){
    if (!roomView.id) return;
    if (App.ceilingShowcase?.roomChanged(null)) sync();
    roomLens(false);
    roomView.id = null; roomView.arrived = false; roomView.fallback = false;
    stage.classList.remove('roomview');
    syncRoomListSel();
    applyRoomClip(null);                                      // 清除裁切（恢复默认 null）
    const msg = App.core.$('#rbMsg'); if (msg) msg.textContent = '';
    renderRoomBar();
    if (!active) return;
    orbit.enabled = opt.mode === 'orbit';
    showLabels(opt.labels && opt.mode === 'orbit');
    if (!opts.silent){
      if (opt.mode === 'walk') rememberWalkExit();       // 原地解除房间限制，保存全屋漫游的站立点
      else flyTo(isoWhole(), 900);
    }
  }

  /* ======================= 进入 / 退出 3D ======================= */
  async function enter(){
    init(); active = true;
    renderer.setSize(SW(), SH()); labelRenderer.setSize(SW(), SH()); camera.aspect = SW()/SH(); camera.updateProjectionMatrix();
    roomView.id = null; roomView.arrived = false; roomView.fallback = false;
    stage.classList.remove('roomview'); renderRoomBar();
    sync(true);
    opt.mode = 'orbit'; orbit.enabled = false; showLabels(false);
    const A = planPose(), B = isoFrom(A);
    grow = 0; furnGrow = 0; applyGrow(); setPose(A);
    stage.classList.add('animating');
    startLoop(); renderer.render(scene, camera);
    stage.classList.add('is3d');                       // 交叉淡入：此刻 3D 画面与 2D 平面完全重合
    await wait(420);
    await animate(1700, t => {
      camTween(A, B, ease(clamp01(t/.85)));
      grow = ease(clamp01((t - .1)/.55));
      furnGrow = ease(clamp01((t - .45)/.5));
      applyGrow();
    });
    orbit.enabled = true; showLabels(opt.labels);
    stage.classList.remove('animating');
  }
  async function exit(){
    if (opt.mode === 'walk'){ rememberWalkExit(); walkCtl.unlock(); stopTouchWalk(); clearWalkKeys(); App.core.$('#walkOverlay').style.display = 'none'; App.core.$('#cross').style.display = 'none';
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir); orbit.target.copy(camera.position).addScaledVector(dir, 3).setY(0); opt.mode = 'orbit'; syncModeBtns(); syncHint3d(); }
    exitRoom({silent: true});                             // 清室内裁切 / 标题条，再走 3D → 2D 动画
    fly = null; orbit.enabled = false; showLabels(false); stage.classList.add('animating');
    const A = curPose(), B = planPose();
    await animate(1300, t => {
      camTween(A, B, ease(clamp01((t - .1)/.9)));
      furnGrow = 1 - ease(clamp01(t/.45));
      grow = 1 - ease(clamp01((t - .2)/.6));
      applyGrow();
    });
    stage.classList.remove('is3d');                    // 此刻 3D 已压平为正俯视，与 2D 重合后淡出
    await wait(450);
    active = false; cancelAnimationFrame(raf); raf = 0;
    stage.classList.remove('animating');
    grow = furnGrow = 1; applyGrow();
  }

  /* ======================= 选择 / 拾取 ======================= */
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  const doorRay = new THREE.Raycaster(), doorDirection = new THREE.Vector3(), doorScreen = new THREE.Vector3();
  const clipped = p => roomView.planes?.some(plane => plane.distanceToPoint(p) < -.005);

  function updateDoorControls(now){
    if (fly || stage.classList.contains('animating') || opt.mode === 'walk' && !touchWalk){
      doors.forEach(d => { d.marker.visible = false; });
      lastDoorVisibility = -Infinity;
      return;
    }
    if (now - lastDoorVisibility < 85) return;
    lastDoorVisibility = now;
    const w = SW(), h = SH(), candidates = [];
    const gapX = App.core.LANG === 'en' ? 92 : App.core.COARSE ? 68 : 54, gapY = App.core.COARSE ? 48 : 31;
    for (const door of doors){
      const {marker} = door, at = marker.position;
      marker.visible = false;
      if (clipped(at) || touchWalk && at.distanceTo(camera.position) > 3.5) continue;
      doorScreen.copy(at).project(camera);
      const x = (1 + doorScreen.x)*w/2, y = (1 - doorScreen.y)*h/2;
      if (doorScreen.z < -1 || doorScreen.z > 1 || x < gapX/2 || x > w - gapX/2 || y < gapY || y > h - gapY/2) continue;
      candidates.push({door, x, y, depth:doorScreen.z});
    }
    candidates.sort((a, b) => a.depth - b.depth);
    const placed = [];
    for (const {door, x, y} of candidates){
      if (placed.some(p => Math.abs(p.x - x) < gapX && Math.abs(p.y - y) < gapY)) continue;
      doorDirection.copy(door.marker.position).sub(camera.position);
      const distance = doorDirection.length();
      if (distance <= .07) continue;
      doorRay.far = distance - .07;
      doorRay.set(camera.position, doorDirection.divideScalar(distance));
      const hidden = doorRay.intersectObjects(archUp.children, true).some(hit =>
        hit.object.isMesh && hit.object.visible && hit.object.material !== glassMat &&
        hit.object !== door.lintel && hit.object.userData.door !== door && !clipped(hit.point));
      if (hidden) continue;
      door.marker.visible = true;
      placed.push({x, y});
    }
  }

  function pick(e){
    if (!e) ptr.set(0, 0);
    else { const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX - r.left)/r.width*2 - 1, -(e.clientY - r.top)/r.height*2 + 1); }
    ray.setFromCamera(ptr, camera);
    const hits = ray.intersectObjects([...(opt.furn ? [furnG] : []), archUp, archFloor], true);
    for (const h of hits){
      let o = h.object;
      if (!o.visible || clipped(h.point)) continue;
      if (o.userData.door) return {door:o.userData.door, dist:h.distance};
      if (o.material === glassMat) continue;
      if (o.userData.room) return {room:o.userData.room};
      while (o && !o.userData.fid && o !== scene) o = o.parent;
      if (o?.userData.fid) return {fid:o.userData.fid};
      return null;                                     // 被墙体挡住
    }
    return null;
  }
  // 屏幕点 → 地面（y = 0）上的户型坐标 mm；s = 该处每 mm 对应的屏幕像素，用于拖放时的幽灵图大小
  const ground0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundAt(x, y){
    if (!active || anim) return null;
    const r = renderer.domElement.getBoundingClientRect(), hit = new THREE.Vector3();
    ptr.set((x - r.left)/r.width*2 - 1, -(y - r.top)/r.height*2 + 1);
    ray.setFromCamera(ptr, camera);
    if (!ray.ray.intersectPlane(ground0, hit) || hit.distanceTo(camera.position) > 60) return null;
    // 视线先碰到墙体（或飘窗台）时，落点取碰到的位置，而不是穿过墙落到看不见的墙后
    const wall = ray.intersectObjects([archUp, archFloor], true).find(h => h.object.material !== glassMat && h.object.visible);
    if (wall && wall.distance < hit.distanceTo(camera.position) - .01) hit.set(wall.point.x, 0, wall.point.z);
    const px = v => new THREE.Vector2(v.x*r.width/2, v.y*r.height/2), a = px(hit.clone().project(camera));
    const s = Math.max(a.distanceTo(px(hit.clone().add(new THREE.Vector3(1, 0, 0)).project(camera))),
                       a.distanceTo(px(hit.clone().add(new THREE.Vector3(0, 0, 1)).project(camera)))) / 1000;
    return {x:hit.x*1000 + PC().x, y:hit.z*1000 + PC().y, s};
  }
  function updateSel(){
    const key = App.store.ui.sel?.kind === 'furn' ? App.store.ui.sel.id : '';
    if (key !== selKey){
      selKey = key;
      if (selHelper){ scene.remove(selHelper); selHelper.geometry.dispose(); selHelper = null; }
      const g = key && furnG.children.find(g => g.userData.fid === key);
      if (g){ selHelper = new THREE.BoxHelper(g, 0xb5653a); scene.add(selHelper); }
    }
    if (selHelper) selHelper.update();
  }

  /* ======================= 漫游 ======================= */
  // 触屏漫游：左下虚拟摇杆移动，在画面上拖动转向（iPad 不支持鼠标指针锁定）
  const HINT_ORBIT = () => App.core.COARSE ? App.core.tr('单指旋转 · 双指缩放 / 平移 · 点选家具后可拖动摆放 · 点门旁按钮开关', '1 finger orbits · 2 fingers zoom / pan · select furniture to drag it · tap the door button')
    : App.core.tr('左键旋转 · 右键平移 · 滚轮缩放 · 选中家具后可拖动 · 点门旁按钮开关', 'Left-drag orbits · right-drag pans · scroll zooms · drag selected furniture · click the door button');
  const HINT_TOUCHWALK = () => App.core.tr('左下摇杆移动 · 拖动画面转向 · 点门旁按钮开关', 'Joystick moves · drag to look · tap the door button');
  const HINT_WALK = () => App.core.tr('WASD 移动 · 鼠标转向 · P 设为效果参考图 · Esc 暂停', 'WASD moves · mouse looks · P captures a render reference · Esc pauses');
  function syncHint3d(){ App.core.$('#hint3d').textContent = opt.mode === 'orbit' ? HINT_ORBIT() : touchWalk ? HINT_TOUCHWALK() : HINT_WALK(); }
  let touchWalk = false;
  const joy = {x:0, y:0, id:null}, walkLook = new THREE.Euler(0, 0, 0, 'YXZ');
  let targetYaw = 0, targetPitch = 0;
  function resetWalkLook(){
    walkLook.setFromQuaternion(camera.quaternion);
    targetYaw = walkLook.y;
    targetPitch = walkLook.x;
  }
  function lookBy(dx, dy, sensitivity = .005, pitchLimit = 1.35){
    targetYaw += dx * sensitivity;
    targetPitch = THREE.MathUtils.clamp(targetPitch + dy * sensitivity, -pitchLimit, pitchLimit);
  }
  function stepWalkLook(dt){
    if (walkLook.y === targetYaw && walkLook.x === targetPitch) return;
    // 输入累计到目标角度，按实际帧间隔追踪，避免鼠标高速采样或不同刷新率改变手感。
    const alpha = -Math.expm1(-dt/.045);
    const approach = (angle, target) => Math.abs(target-angle) < 1e-4 ? target : angle + (target-angle)*alpha;
    walkLook.set(approach(walkLook.x,targetPitch),approach(walkLook.y,targetYaw),0);
    camera.quaternion.setFromEuler(walkLook);
  }
  const clearWalkKeys = () => { for (const key of Object.keys(keys)) keys[key] = false; };

  function currentWalkPose(){
    const center = PC(), angle = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    return {x:camera.position.x*1000 + center.x, y:camera.position.z*1000 + center.y,
      height:camera.position.y, yaw:angle.y, pitch:angle.x, roomId:roomView.id};
  }
  function validWalkPoint(point){
    if (point.height < .3 || point.height > 3 || blocked(wx(point.x), wz(point.y))) return false;
    if (point.roomId){
      const room = App.plan.roomDef(point.roomId);
      return !!room && !isBay(room) && App.assistant.pointInPoly(point.x, point.y, room.poly);
    }
    const b = App.store.BOUNDS;
    return point.x >= b.x - 2000 && point.x <= b.x + b.w + 2000 &&
      point.y >= b.y - 2000 && point.y <= b.y + b.h + 2000;
  }
  function lastWalkExit(roomId){
    for (const saved of App.store.state.walk.recent){
      if (saved.roomId && saved.roomId !== roomId) continue; // 全屋漫游只恢复全屋站立点
      const point = roomId && !saved.roomId ? {...saved, roomId} : saved;
      if (validWalkPoint(point)) return point;
    }
    return null;
  }
  function rememberWalkExit(){
    if (!active || opt.mode !== 'walk') return;
    const point = currentWalkPose(), recent = App.store.state.walk.recent, previous = recent[0];
    if (!validWalkPoint(point) || (previous?.roomId === point.roomId && previous.x === point.x && previous.y === point.y &&
        previous.height === point.height && previous.yaw === point.yaw && previous.pitch === point.pitch)) return;
    App.store.state.walk.recent = [point, ...recent.filter(item => item.roomId !== point.roomId)].slice(0, 30);
    App.store.save();
  }
  function resetWalk(){
    const {$} = App.core;
    if ($('#walkPicker').open) $('#walkPicker').close();
    if (!inited) return;
    opt.mode = 'orbit'; walkCtl.unlock(); stopTouchWalk(); clearWalkKeys();
    fly = null; orbit.enabled = active;
    $('#walkOverlay').style.display = 'none'; $('#cross').style.display = 'none';
    exitRoom({silent:true});
    archUp.traverse(o => { if (o.userData.walkOnly) o.visible = false; });
    showLabels(opt.labels);
    syncModeBtns(); syncHint3d();
  }
  function pauseWalkForDialog(){
    if (opt.mode !== 'walk') return;
    if (walkCtl.isLocked) walkCtl.unlock();
    stopTouchWalk(); clearWalkKeys();
    App.core.$('#walkOverlay').style.display = 'flex';
  }
  function walkRooms(){
    return App.store.ROOMS.filter(room => (!roomView.id || room.id === roomView.id) && !isBay(room));
  }
  function openWalkPicker(){
    if (!active || anim || stage.classList.contains('animating')) return;
    const {$, esc, nm} = App.core, rooms = walkRooms(), map = $('#walkMap');
    const bounds = App.store.BOUNDS;
    const lastExit = lastWalkExit(roomView.id);
    const base = roomView.id && rooms[0] ? App.geom.bbox(rooms[0].poly) : [bounds.x,bounds.y,bounds.x+bounds.w,bounds.y+bounds.h];
    const [x0,y0,x1,y1] = lastExit ? [Math.min(base[0],lastExit.x), Math.min(base[1],lastExit.y),
      Math.max(base[2],lastExit.x), Math.max(base[3],lastExit.y)] : base;
    const pad = Math.max(160, Math.max(x1-x0,y1-y0)*.035);
    const labelSize = Math.max(90, Math.max(x1-x0,y1-y0)*.017);
    map.setAttribute('viewBox', `${x0-pad} ${y0-pad} ${x1-x0+2*pad} ${y1-y0+2*pad}`);
    const names = rooms.map(room => nm(App.store.roomState(room.id).name));
    const floor = rooms.map((room,i) => App.draw2d.roomShape(room,
      `class="walk-map-room" fill="${outdoors(room) ? '#dce8d5' : '#ece0ce'}" stroke="#b8aa97" vector-effect="non-scaling-stroke" data-walk-room="${esc(room.id)}" tabindex="0" role="button" aria-label="${esc(names[i])}"`)).join('');
    const walls = App.store.WALLS.map((wall,i) => App.store.state.demolished.includes('w'+i) ? '' : App.draw2d.wallShape(wall, 'fill="#8b8579"')).join('');
    const labels = rooms.map((room,i) => `<text x="${room.at[0]}" y="${room.at[1]}" text-anchor="middle" dominant-baseline="middle" fill="#403831" font-size="${labelSize}">${esc(names[i])}</text>`).join('');
    const marker = lastExit ? `<circle data-walk-last cx="${lastExit.x}" cy="${lastExit.y}" r="${labelSize*.52}" fill="#a95732" stroke="#fff" vector-effect="non-scaling-stroke"/>` : '';
    map.innerHTML = `${floor}<g pointer-events="none">${walls}${labels}</g>${marker}`;
    $('#walkLastPoint').hidden = !lastExit;
    $('#walkPointStatus').textContent = '';
    pauseWalkForDialog(); $('#walkPicker').showModal(); map.focus();
  }
  function chooseWalkPoint(x, y){
    const {$, tr} = App.core;
    const room = walkRooms().find(item => App.assistant.pointInPoly(x, y, item.poly));
    if (!room || blocked(wx(x), wz(y))){
      $('#walkPointStatus').textContent = tr('请选择房间内避开墙和门的位置。', 'Choose a spot inside a room, clear of walls and doors.');
      return;
    }
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const dx = room.at[0] - x, dy = room.at[1] - y;
    const yaw = Math.hypot(dx, dy) > 30 ? Math.atan2(-dx, -dy) : Math.atan2(-dir.x, -dir.z);
    if (setMode('walk', {x, y, height:ROOM_EYE, yaw, pitch:0, roomId:roomView.id})) $('#walkPicker').close();
  }
  function chooseLastWalkExit(){
    const point = lastWalkExit(roomView.id);
    if (point && setMode('walk', point)) App.core.$('#walkPicker').close();
  }
  function startTouchWalk(){
    touchWalk = true;
    resetWalkLook();
    App.core.$('#walkOverlay').style.display = 'none'; App.core.$('#joy').style.display = 'block'; App.core.$('#walkExit').style.display = 'block';
    syncHint3d();
  }
  function stopTouchWalk(){
    touchWalk = false; joy.x = joy.y = 0; joy.id = null; App.core.$('#joy i').style.transform = '';
    App.core.$('#joy').style.display = 'none'; App.core.$('#walkExit').style.display = 'none';
  }
  function bindJoystick(){
    const el = App.core.$('#joy'), knob = App.core.$('#joy i'), R = 50;
    const upd = e => {
      const r = el.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width/2), dy = e.clientY - (r.top + r.height/2);
      const L = Math.hypot(dx, dy); if (L > R){ dx *= R/L; dy *= R/L; }
      joy.x = dx/R; joy.y = dy/R; knob.style.transform = `translate(${dx}px,${dy}px)`;
    };
    el.addEventListener('pointerdown', e => { e.preventDefault(); joy.id = e.pointerId; el.setPointerCapture(e.pointerId); upd(e); });
    el.addEventListener('pointermove', e => { if (e.pointerId === joy.id) upd(e); });
    const end = e => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  function entryPose(){
    // 漫游起点：入户门（没有 entry 标记时取第一扇门）外 0.6m，朝门内看
    const d = App.store.DOORS.find(x => x.entry) || App.store.DOORS[0];
    const [x0, y0, x1, y1] = d ? d.rect : [0, 0, 0, 0];
    const cx = (x0 + x1)/2, cy = (y0 + y1)/2, c = PC();
    if (!d) return [wx(c.x), 1.6, wz(c.y), wx(c.x), 1.5, wz(c.y) - 1];
    const thinX = (x1 - x0) <= (y1 - y0);                 // 门洞在竖墙里 → 从 x 方向进出
    const s = thinX ? (cx <= c.x ? -1 : 1) : (cy <= c.y ? -1 : 1);
    const off = (thinX ? (x1 - x0) : (y1 - y0))/2 + 600;
    const px = cx + (thinX ? s*off : 0), py = cy + (thinX ? 0 : s*off);
    return [wx(px), 1.6, wz(py), wx(cx), 1.5, wz(cy)];
  }
  function setMode(m, requestedPoint){
    if (!active || anim || stage.classList.contains('animating') || (m === opt.mode && !requestedPoint)) return false;
    const currentRoom = roomView.id;
    if (requestedPoint && !validWalkPoint(requestedPoint)){
      App.core.toast(App.core.tr('这个站立点已不可用，请重新选点。', 'This standing point is unavailable. Pick another spot.'));
      return false;
    }
    if (opt.mode === 'walk' && m === 'orbit') rememberWalkExit();
    opt.mode = m; roomLens(false); syncModeBtns();
    if (m === 'walk'){
      App.interact.select(null);
      if (opt.cut !== FULL_WALL_MODE){ opt.cut = FULL_WALL_MODE; syncCutBtns(); sync(); }
      orbit.enabled = false; fly = null;
      const roomId = requestedPoint ? requestedPoint.roomId : currentRoom;
      const start = requestedPoint || lastWalkExit(roomId);
      roomView.id = roomId; roomView.arrived = !!roomId; roomView.fallback = false;
      stage.classList.toggle('roomview', !!roomId);
      syncRoomListSel();
      if (start){
        camera.position.set(wx(start.x), start.height, wz(start.y));
        camera.quaternion.setFromEuler(new THREE.Euler(start.pitch, start.yaw, 0, 'YXZ'));
      } else {
        const e = roomId ? interiorWalkPose(roomId) : entryPose();
        camera.position.set(e[0], e[1], e[2]); camera.lookAt(e[3], e[4], e[5]);
      }
      resetWalkLook();
      applyRoomClip(roomId);
      App.core.$('#walkOverlay').style.display = walkCtl.isLocked || touchWalk ? 'none' : 'flex';
      clearWalkKeys();
      syncHint3d();
    } else {
      walkCtl.unlock(); stopTouchWalk(); clearWalkKeys(); orbit.enabled = true;
      App.core.$('#walkOverlay').style.display = 'none'; App.core.$('#cross').style.display = 'none';
      syncHint3d();
      if (roomView.id && App.plan.roomDef(roomView.id)){
        // 室内漫游结束：回到该房间的进房机位，重新裁切
        orbit.enabled = false; fly = null;
        roomView.arrived = false; applyRoomClip(null);
        App.interact.select?.({kind: 'room', id: roomView.id});
        const P = interiorPose(roomView.id);
        if (P) flyTo(P, 800, () => { roomView.arrived = true; applyRoomClip(roomView.id); renderRoomBar(); });
      } else {
        syncRoomListSel();
        orbit.target.set(0, 0, 0); flyTo(isoWhole());
      }
    }
    showLabels(opt.labels && m === 'orbit' && !roomView.id);
    renderRoomBar();
    archUp.traverse(o => { if (o.userData.walkOnly) o.visible = m === 'walk'; });
    return true;
  }
  function curveBandDistance(curve,x,y){
    const half = curve.thickness/2;
    const angle = Math.atan2(y-curve.cy,x-curve.cx);
    const offset = wrapped((angle-curve.start)*Math.sign(curve.sweep));
    if (offset <= Math.abs(curve.sweep)){
      const radial = Math.hypot(x-curve.cx,y-curve.cy);
      return Math.max(0,Math.abs(radial-curve.radius)-half);
    }
    // 弧带端面沿半径平切；圆弧外侧只与实际端面比较。
    return Math.min(...[0,1].map(t => segmentDistance(
      App.geom.curvePoint(curve,t,-half),App.geom.curvePoint(curve,t,half),x,y)));
  }
  function blocked(x, z, r = .22){
    const center = PC(), px = x*1000+center.x, py = z*1000+center.y, radius = r*1000;
    for (const {rect:[x0,y0,x1,y1],curve,edge} of colliders){
      const distance = Math.hypot(Math.max(x0-px,0,px-x1),Math.max(y0-py,0,py-y1));
      if (distance >= radius) continue;
      if (edge){
        const step = edge.curve ? curveBandDistance(edge.curve,px,py) : segmentDistance(edge.a,edge.b,px,py);
        if (step < radius) return true;
      } else if (!curve || curveBandDistance(curve,px,py) < radius) return true;
    }
    return doors.some(door => door.blocks(x, z, r));
  }
  function stepWalk(dt){
    if (!walkCtl.isLocked && !touchWalk) return;
    stepWalkLook(dt);
    const sp = (keys.ShiftLeft || keys.ShiftRight ? 2.6 : 1.4) * dt, fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x), mv = new THREE.Vector3();
    if (keys.KeyW || keys.ArrowUp) mv.add(fwd); if (keys.KeyS || keys.ArrowDown) mv.sub(fwd);
    if (keys.KeyD || keys.ArrowRight) mv.add(right); if (keys.KeyA || keys.ArrowLeft) mv.sub(right);
    if (touchWalk){ mv.addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x); }
    const mag = Math.min(1, mv.length());        // 摇杆推得越远走得越快
    if (mag < .05) return;
    mv.normalize().multiplyScalar(sp * mag);
    const p = camera.position;
    if (!blocked(p.x + mv.x, p.z)) p.x += mv.x;
    if (!blocked(p.x, p.z + mv.z)) p.z += mv.z;
    // 室内漫游：限制在房间 AABB 内，裁切之外不会出现「走出墙外」的空白
    if (roomView.id){
      const b = roomBox(roomView.id); if (b){
        const m = .18;
        if (b.X1 - b.X0 > m*2) p.x = THREE.MathUtils.clamp(p.x, b.X0 + m, b.X1 - m);
        if (b.Z1 - b.Z0 > m*2) p.z = THREE.MathUtils.clamp(p.z, b.Z0 + m, b.Z1 - m);
      }
    }
  }
  function toggleDoorAhead(){
    const hit = pick();
    if (hit?.door && hit.dist < 2.5) toggleDoor(hit.door);
  }
  addEventListener('pointerup', e => {
    if (active && opt.mode === 'walk' && walkCtl.isLocked && e.button === 0) toggleDoorAhead();
  });
  addEventListener('keydown', e => {
    if (!active || opt.mode !== 'walk' || e.defaultPrevented || e.isComposing ||
        e.target.closest?.('input,select,textarea,[contenteditable],dialog[open]')) return;
    if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey && !e.altKey && App.core.PUBLIC_ACCESS !== 'guest'){
      e.preventDefault();
      if (!e.repeat) void App.assistant.captureWalkReference();
      return;
    }
    keys[e.code] = true;
    if (e.code === 'KeyE' && !e.repeat) toggleDoorAhead();
  });
  addEventListener('keyup', e => keys[e.code] = false);
  addEventListener('blur', clearWalkKeys);
  addEventListener('pagehide', rememberWalkExit);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearWalkKeys(); });

  /* ======================= 工具栏 ======================= */
  function syncModeBtns(){
    document.querySelectorAll('#modes3d .btn').forEach(b => b.classList.toggle('on', b.dataset.mode === opt.mode));
    App.core.$('#walkShot').hidden = opt.mode !== 'walk' || App.core.PUBLIC_ACCESS === 'guest';
  }
  function syncCutBtns(){ document.querySelectorAll('[data-cut]').forEach(b => b.classList.toggle('on', +b.dataset.cut === opt.cut)); }
  function syncWalkTexts(){
    const t = App.core.COARSE
      ? [App.core.tr('从当前站立点继续', 'Continue from the current standing point'), App.core.tr('左下摇杆移动 · 在画面上拖动转向', 'Joystick moves · drag on screen to look'),
         App.core.tr('点门旁按钮开关 · 点「退出漫游」回到鸟瞰', 'Tap the door button · "Exit walk" returns to orbit')]
      : [App.core.tr('从当前站立点继续', 'Continue from the current standing point'),
         App.core.tr('<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> 移动 · 鼠标转向 · <kbd>Shift</kbd> 快走', '<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> move · mouse looks · <kbd>Shift</kbd> runs'),
         App.core.tr('<kbd>E</kbd> 开关门 · <kbd>P</kbd> 设为效果参考图 · <kbd>Esc</kbd> 暂停', '<kbd>E</kbd> toggles doors · <kbd>P</kbd> captures a render reference · <kbd>Esc</kbd> pauses')];
    t.forEach((h, i) => App.core.$('#wo' + (i + 1)).innerHTML = h);
    syncHint3d();
  }
  function bindUI(){
    const {$} = App.core;
    document.querySelectorAll('#modes3d .btn').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $('#walkChoose').onclick = $('#rbStand').onclick = openWalkPicker;
    $('#walkLastPoint').onclick = chooseLastWalkExit;
    const map = $('#walkMap');
    map.onclick = e => {
      if (e.target.closest('[data-walk-last]')) return chooseLastWalkExit();
      const transform = map.getScreenCTM(); if (!transform) return;
      const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(transform.inverse());
      chooseWalkPoint(point.x, point.y);
    };
    map.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const room = App.plan.roomDef(e.target.dataset.walkRoom);
      if (room){ e.preventDefault(); chooseWalkPoint(...room.at); }
    });
    $('#walkShot').onclick = () => void App.assistant.captureWalkReference();
    // 触屏设备用摇杆漫游；桌面端锁定鼠标，锁定失败时也退回到摇杆
    $('#walkStart').onclick = () => App.core.COARSE ? startTouchWalk() : walkCtl.lock();
    document.addEventListener('pointerlockerror', () => {
      if (active && opt.mode === 'walk' && !$('#walkPicker').open) startTouchWalk();
    });
    App.core.$('#walkExit').onclick = () => setMode('orbit');
    bindJoystick();
    syncModeBtns();
    syncWalkTexts();
    App.core.$('#vIso').onclick = () => { if (opt.mode === 'walk') setMode('orbit'); if (roomView.id) exitRoom({silent: true}); flyTo(isoWhole()); };
    App.core.$('#vTop').onclick = () => { if (opt.mode === 'walk') setMode('orbit'); if (roomView.id) exitRoom({silent: true}); flyTo(topWhole()); };
    document.querySelectorAll('[data-cut]').forEach(b => b.onclick = () => { if (opt.mode === 'walk') return; opt.cut = +b.dataset.cut; syncCutBtns(); sync(); });
    document.querySelectorAll('#toggles3d .btn').forEach(b => b.onclick = () => {
      const k = b.dataset.t; opt[k] = !opt[k]; b.classList.toggle('on', opt[k]);
      if (k === 'furn'){ furnG.visible = opt.furn; syncLightPool(); updateRoomLights(true); if (!opt.furn && App.store.ui.sel?.kind === 'furn') App.interact.select(null); }
      if (k === 'labels') showLabels(opt.labels && opt.mode === 'orbit' && !roomView.id);
      if (k === 'night') applyLight();
    });
    App.core.$('#sun').oninput = e => { opt.hour = +e.target.value; applyLight(); };
    // 室内标题条：返回鸟瞰 / 室内漫游 / 房间效果图
    App.core.$('#rbBack').onclick = () => exitRoom();
    App.core.$('#rbWalk').onclick = () => { if (roomView.id && opt.mode !== 'walk') setMode('walk'); };
    App.core.$('#rbRender').onclick = async () => {
      const id = roomView.id; if (!id || !App.assistant.renderGenerate) return;
      if (App.assistant.renderState && App.assistant.renderState.busy) return;
      if (App.assistant.renderState && App.assistant.renderState.online === false){
        App.core.toast(App.core.PUBLIC_ACCESS === 'owner' ? App.assistant.publicAiOffline() :
          App.core.tr('本地服务未连接：请先在项目根运行 node server.mjs', 'Local service is not running — start node server.mjs in the project root'));
        return;
      }
      const msg = App.core.$('#rbMsg');
      if (msg) msg.textContent = App.core.tr('正在截图…', 'Capturing…');
      const rec = await App.assistant.renderGenerate({kind: 'room', roomId: id});
      if (msg) msg.textContent = rec ? App.core.tr('已生成', 'Done') : '';
      if (!rec) App.core.toast(App.core.tr('房间效果图生成失败，详情见右侧「效果图」页签', 'Room render failed — see the Renders tab for details'));
    };
  }

  /* ======================= 主循环 ======================= */
  const clock = new THREE.Clock();
  function startLoop(){ if (!raf){ clock.getDelta(); raf = requestAnimationFrame(loop); } }
  function loop(){
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), .05), now = performance.now();
    if (anim){ const t = clamp01((now - anim.t0)/anim.dur); anim.fn(t); if (t >= 1){ const r = anim.res; anim = null; r(); } }
    else if (fly){ const t = clamp01((now - fly.t0)/fly.dur); camTween(fly.A, fly.B, ease(t)); if (t >= 1){ const f = fly; fly = null; f.done && f.done(); } }
    else if (opt.mode === 'walk') stepWalk(dt);
    else if (orbit.enabled) orbit.update();
    doors.forEach(d => {
      d.progress += (Number(d.open) - d.progress) * Math.min(1, dt*6);
      d.move(d.progress);
    });
    updateSel(); updateCeilingVisibility(); updateRoomLights(false,now);
    renderer.render(scene, camera);
    updateDoorControls(now);
    labelRenderer.render(scene, camera);
  }

  // 截图：scale 放大时按比例改渲染尺寸离屏渲染，再恢复；clean 隐藏房间标签与选中框
  function shotURL(opts = {}){
    if (!inited) return null;
    const scale = Math.max(.25, Math.min(4, Number(opts.scale) || 1));
    const clean = !!opts.clean;
    if (opt.night) updateRoomLights(true);
    const labelVis = labelG.children.map(o => o.visible), labelsOn = labelG.visible;
    labelRenderer.render(scene, camera);
    if (!clean && scale === 1){ renderer.render(scene,camera); return renderer.domElement.toDataURL('image/png'); }
    try {
      if (selHelper){ scene.remove(selHelper); selHelper.geometry.dispose(); selHelper = null; selKey = null; }
      if (clean){ labelG.children.forEach(o => { o.visible = false; }); labelG.visible = false; }
      renderer.setSize(Math.round(SW()*scale), Math.round(SH()*scale), false);
      camera.aspect = SW()/SH(); camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    } finally {
      if (clean){ labelG.children.forEach((o, i) => { o.visible = labelVis[i]; }); labelG.visible = labelsOn; }
      renderer.setSize(SW(), SH(), false);
      camera.aspect = SW()/SH(); camera.updateProjectionMatrix();
      updateSel();
      renderer.render(scene, camera);
    }
  }

  // 相机位姿（契约外的小扩展，供对话上下文使用）：未在 3D 时返回 null
  function viewInfo(){
    if (!active || !camera) return null;
    const r3 = v => ({x:+v.x.toFixed(3), y:+v.y.toFixed(3), z:+v.z.toFixed(3)});
    const target = opt.mode === 'walk' ? camera.getWorldDirection(new THREE.Vector3()).add(camera.position) : orbit.target;
    return {mode: opt.mode, fov: camera.fov, position: r3(camera.position), target: r3(target), room: roomView.id || null};
  }

  function relang(){ syncWalkTexts(); if (inited){ buildLabels(); doors.forEach(labelDoor); renderRoomBar(); } }

  App.view3d = window.View3D = {enter, exit, relang, sync:() => sync(), shotURL, groundAt, flyToRoom:id => active && !anim && flyToRoom(id),
    flyIso: () => active && !anim && flyTo(isoWhole()),
    flyTop: () => active && !anim && flyTo(topWhole()),
    flyToWorld: (...a) => active && !anim && flyToWorld(...a),
    flying: () => !!fly || !!anim, walking: () => active && opt.mode === 'walk', viewInfo, resetWalk, rememberWalkExit,
    // 房间内部视角（任务 5）
    enterRoom: (id, opts) => enterRoom(id, opts),
    exitRoom: (opts) => exitRoom(opts),
    roomViewing: () => !!roomView.id,
    roomId: () => roomView.id,
    clipCount,
    syncBar: renderRoomBar,
    roomPose: id => interiorPose(id),
  };
})().catch(error => console.error('Could not load the 3D engine', error));
