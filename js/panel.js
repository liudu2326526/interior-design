/* 属性面板、构件编辑和侧栏。
 * 依赖 App.core、App.store、App.plan、App.geom、App.interact、App.io、App.assistant。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 右侧面板 ======================= */

  function renderPanel(){
    renderFab();
    const p = App.core.$('#panel');
    if (App.ceilingEditor?.active() && App.store.ui.ceilingPreview){ App.ceilingEditor.renderPanel(); return; }
    if (App.store.ui.sel?.kind === 'furn'){ const f = App.store.getF(App.store.ui.sel.id); if (f){ p.innerHTML = furnPanel(f); bindFurnPanel(f); return; } }
    if (App.ceilingEditor?.active()){ App.ceilingEditor.renderPanel(); return; }
    if (App.store.ui.sel?.kind === 'room'){ const r = App.plan.roomDef(App.store.ui.sel.id); if (r){ p.innerHTML = roomPanel(r); bindRoomPanel(); return; } }
    if (App.store.ui.sel?.kind === 'wall'){ const w = App.plan.wallOf(App.store.ui.sel.id); if (w){ p.innerHTML = wallPanel(App.store.ui.sel.id); bindWallPanel(App.store.ui.sel.id); return; } }
    p.innerHTML = overviewPanel(); bindOverview();
  }

  function wallPanel(id){
    const w = App.plan.wallOf(id), dem = App.store.state.demolished.includes(id);
    const KINDS = {e:App.core.tr('外墙','Exterior'), b:App.core.tr('承重墙','Load-bearing'), n:App.core.tr('非承重墙','Partition'), low:App.core.tr('矮墙','Low wall')};
    const canDem = w[4] === 'n' || w[4] === 'low';
    return `<section><h3>${App.core.tr('墙体','Wall')} <small>${App.core.esc(id)}</small></h3>
    <div class="stats">
      <div><small>${App.core.tr('类型','Kind')}</small><span class="big" style="font-size:15px">${App.core.esc(KINDS[w[4]] || w[4])}</span></div>
      <div><small>${App.core.tr('长度','Length')}</small><span class="big">${App.geom.fmt(App.geom.wallLength(w)/1000, 1)}</span> m</div></div>
    <div class="muted" style="font-size:12px;margin-top:6px">${App.core.tr('厚度','Thickness')} ${Math.round(w[6]?.thickness ?? Math.min(w[2]-w[0], w[3]-w[1]))} mm · ${App.core.tr('高度','Height')} ${App.plan.wallHeight(w)} mm</div>
    <div class="actions">
      ${canDem ? `<button class="btn ${dem ? '' : 'danger'}" id="wToggle">${dem ? App.core.tr('恢复墙体','Restore wall') : App.core.tr('标记拆除','Mark for removal')}</button>`
                 : `<span class="muted">${App.core.tr('承重墙与外墙不可拆除','Bearing and exterior walls cannot be removed')}</span>`}
      <button class="btn" id="back">${App.core.tr('← 返回','← Back')}</button></div></section>`;
  }
  function bindWallPanel(id){
    if (App.core.$('#wToggle')) App.core.$('#wToggle').onclick = () => App.interact.toggleWall(id);
    App.core.$('#back').onclick = () => App.interact.select(null);
  }

  function overviewPanel(){
    const rows = App.store.ROOMS.map(r => {
      const st = App.store.roomState(r.id), m = App.plan.matInfo(st.mat);
      return `<tr class="click" data-room="${App.core.esc(r.id)}"><td><span class="sw" style="background:${m.sw}"></span>${App.core.esc(App.core.nm(st.name))}${r.counted===false?' <span class="muted">*</span>':''}</td>
      <td class="r">${App.geom.fmt(App.geom.roomArea(r))} m²</td></tr>`;
    }).join('');
    const tot = App.store.ROOMS.filter(r => r.counted !== false).reduce((a,r) => a + App.geom.roomArea(r), 0);
    const byMat = {};
    App.store.ROOMS.forEach(r => { const m = App.store.roomState(r.id).mat; byMat[m] = (byMat[m]||0) + App.geom.roomArea(r); });
    let cost = 0;
    const matRows = Object.entries(byMat).map(([m,a]) => { const info = App.plan.matInfo(m), c = a*info.price*1.05; cost += c;
      return `<tr><td><span class="sw" style="background:${info.sw}"></span>${App.core.esc(App.core.nm(info.name))}</td><td class="r">${App.geom.fmt(a,1)} m²</td><td class="r">¥${Math.round(c).toLocaleString()}</td></tr>`; }).join('');
    const dem = App.store.state.demolished.map(App.plan.wallOf).filter(Boolean);
    const demLen = dem.reduce((a,w) => a + App.geom.wallLength(w), 0) / 1000;
    const components = App.geom.componentCount(App.store.state.furniture);
    return `
  <section><h3>${App.core.tr('房间面积','Room Areas')} <small>${App.core.tr('点击编辑地面与天花','Edit flooring and ceilings')}</small></h3>
    <table>${rows}</table>
    <div class="total"><span>${App.core.tr('套内使用面积','Net floor area')}</span><b>${App.geom.fmt(tot)} m²</b></div>
    <div class="muted" style="font-size:11px;margin-top:4px">${App.core.tr('带 * 的区域不计入套内使用面积，面积按墙体内净尺寸计算。','Areas marked * are excluded from the net interior area. Room areas use inner wall dimensions.')}</div></section>
  <section><h3>${App.core.tr('地面材料估算','Flooring Estimate')} <small>${App.core.tr('含 5% 损耗','incl. 5% waste')}</small></h3>
    <table>${matRows}</table>
    <div class="total"><span>${App.core.tr('地面材料合计','Flooring total')}</span><b>¥${Math.round(cost).toLocaleString()}</b></div></section>
  <section><h3>${App.core.tr('方案统计','Plan Stats')}</h3>
    <div class="stats"><div><small>${App.core.tr('家具数量','Furniture')}</small><span class="big">${App.store.state.furniture.length - components}</span></div>
      ${components ? `<div><small>${App.core.tr('构件数量','Components')}</small><span class="big">${components}</span></div>` : ''}
      <div><small>${App.core.tr('拆除墙体','Walls removed')}</small><span class="big">${App.geom.fmt(demLen,1)}</span> m</div></div>
    <div class="actions"><button class="btn" id="clearMeasure">${App.core.tr('清除测量','Clear measures')} (${App.store.state.measures.length})</button>
      <button class="btn danger" id="clearFurn">${App.core.tr('清空布置','Clear layout')}</button></div></section>
  ${App.core.COARSE ? App.core.tr(`<section><h3>触屏操作</h3><div class="kbd">
    <kbd>单指拖动</kbd><span>空白处平移画面</span><kbd>双指</kbd><span>捏合缩放、拖动平移</span>
    <kbd>家具库</kbd><span>点一下放到画面中央，或按住向右拖到指定位置</span>
    <kbd>点家具</kbd><span>选中后拖动移动；拖顶部圆点旋转、右下方块改尺寸</span>
    <kbd>工具条</kbd><span>选中后底部可旋转 / 复制 / 删除</span>
    <kbd>测量</kbd><span>按住拖出一条线，或依次点两点</span>
    <kbd>3D 漫游</kbd><span>左下摇杆移动，拖动屏幕转向，点门旁按钮开关</span>
  </div></section>`, `<section><h3>Touch Controls</h3><div class="kbd">
    <kbd>1-finger drag</kbd><span>Pan on empty space</span><kbd>2 fingers</kbd><span>Pinch to zoom, drag to pan</span>
    <kbd>Library</kbd><span>Tap to place at center, or hold and drag right to a spot</span>
    <kbd>Tap item</kbd><span>Drag to move; top dot rotates, bottom-right square resizes</span>
    <kbd>Toolbar</kbd><span>Bottom bar can rotate / duplicate / delete</span>
    <kbd>Measure</kbd><span>Hold and drag a line, or tap two points</span>
    <kbd>3D walk</kbd><span>Joystick moves, drag to look, tap doors to open</span>
  </div></section>`) : ''}
  ${App.core.tr(`<section><h3>键盘快捷键</h3><div class="kbd">
    <kbd>拖拽</kbd><span>左侧家具拖入平面图</span><kbd>V</kbd><span>选择 / 移动</span><kbd>M</kbd><span>测量（Shift 水平/垂直）</span>
    <kbd>X</kbd><span>拆改非承重墙（黑色为承重墙）</span><kbd>R</kbd><span>旋转 90°（Shift 反向）</span><kbd>方向键</kbd><span>微调 10mm（Shift 100mm）</span>
    <kbd>⌘/Ctrl D</kbd><span>复制</span><kbd>Delete</kbd><span>删除</span><kbd>⌘/Ctrl Z</kbd><span>撤销</span><kbd>T</kbd><span>切换 2D / 3D</span><kbd>F</kbd><span>适应窗口</span><kbd>Esc</kbd><span>取消选择</span>
  </div></section>`, `<section><h3>Keyboard Shortcuts</h3><div class="kbd">
    <kbd>Drag</kbd><span>Drag furniture onto the plan</span><kbd>V</kbd><span>Select / move</span><kbd>M</kbd><span>Measure (Shift: horizontal/vertical)</span>
    <kbd>X</kbd><span>Demolish non-bearing walls (black = bearing)</span><kbd>R</kbd><span>Rotate 90° (Shift reverses)</span><kbd>Arrows</kbd><span>Nudge 10mm (Shift 100mm)</span>
    <kbd>⌘/Ctrl D</kbd><span>Duplicate</span><kbd>Delete</kbd><span>Delete</span><kbd>⌘/Ctrl Z</kbd><span>Undo</span><kbd>T</kbd><span>Toggle 2D / 3D</span><kbd>F</kbd><span>Fit to window</span><kbd>Esc</kbd><span>Deselect</span>
  </div></section>`)}`;
  }
  function bindOverview(){
    document.querySelectorAll('#panel tr[data-room]').forEach(tr => tr.onclick = () => {
      const id = tr.dataset.room;
      App.interact.select({kind:'room', id});
      if (!App.io.is3D()) return;
      // 已在室内时点总览里的房间 = 平滑飞到那个房间，而不是飞到鸟瞰机位（裁切会错位）
      if (App.view3d?.roomViewing?.()) App.view3d.enterRoom(id);
      else App.view3d.flyToRoom(id);
    });
    App.core.$('#clearMeasure').onclick = () => App.store.state.measures.length && App.store.mutate(() => App.store.state.measures = []);
    App.core.$('#clearFurn').onclick = clearLayout;
  }

  // 底部浮动工具条：触屏没有键盘，旋转 / 复制 / 删除都放在这里
  function renderFab(){
    const fab = App.core.$('#fab'), f = App.store.ui.sel?.kind === 'furn' && App.store.getF(App.store.ui.sel.id), r = App.store.ui.sel?.kind === 'room' && App.plan.roomDef(App.store.ui.sel.id);
    fab.classList.toggle('has-ceiling-item',App.ceilingFurniture.is(f) && !App.store.ui.ceilingPreview);
    if (!f && !r){ fab.classList.remove('show'); return; }
    fab.innerHTML = f
      ? `<span class="name">${App.core.esc(App.core.nm(f.name))}</span><button class="btn" data-a="rotL">↺</button><button class="btn" data-a="rotR">↻ ${App.core.tr('旋转','Rotate')}</button>
       <button class="btn" data-a="dup">${App.core.tr('复制','Duplicate')}</button><button class="btn danger" data-a="del">${App.core.tr('删除','Delete')}</button><span class="sep"></span>
       <button class="btn narrow-only" data-a="prop">${App.core.tr('属性','Properties')}</button><button class="btn" data-a="done">${App.core.tr('完成','Done')}</button>`
      : `<span class="name">${App.core.esc(App.core.nm(App.store.roomState(r.id).name))}</span><button class="btn narrow-only" data-a="prop">${App.core.tr('房间属性','Room properties')}</button><button class="btn" data-a="done">${App.core.tr('完成','Done')}</button>`;
    fab.classList.add('show');
    fab.querySelectorAll('[data-a]').forEach(b => b.onclick = () => ({
      rotL:() => App.interact.rotateSel(-90), rotR:() => App.interact.rotateSel(90), dup:App.interact.duplicateSel, del:App.interact.deleteSel,
      prop:() => drawer('panel', true), done:() => { App.interact.select(null); closeDrawers(); },
    })[b.dataset.a]());
  }

  function clearLayout(){
    const n = App.store.state.furniture.length;
    if (!n) return App.core.toast(App.core.tr('当前没有布置任何家具', 'There is no furniture to clear'));
    const prompt = App.geom.componentCount(App.store.state.furniture)
      ? App.core.tr(`确定清空全部 ${n} 件家具、家电和构件吗？`, `Remove all ${n} furniture, appliance and component items?`)
      : App.core.tr(`确定清空全部 ${n} 件家具 / 家电吗？`, `Remove all ${n} furniture / appliance items?`);
    if (!confirm(prompt + '\n' + App.core.tr('墙体、地面材料和测量线会保留，可点「撤销」恢复。', 'Walls, flooring and measurements are kept. You can Undo this.'))) return;
    App.store.ui.sel = null; App.store.mutate(() => App.store.state.furniture = []);
    App.core.toast(App.core.tr('已清空布置，可点「撤销」恢复', 'Layout cleared — Undo to restore'));
  }

  /* 侧栏开合：which = 'lib' | 'panel' | null，open 不传则切换。
   * 宽屏：侧栏在布局中收起 / 展开（记住选择）；窄屏：侧栏是浮层抽屉，一次只开一个，which = null 表示全部关闭 */
  const PANES = 'huxing-panes';
  const panes = (() => { try { return JSON.parse(localStorage.getItem(PANES)) || {}; } catch(e) { return {}; } })();
  function drawer(which, open){
    const app = App.core.$('.app'), els = {lib:App.core.$('aside.lib'), panel:App.core.$('aside.right')}, n = App.core.narrow();
    if (n){
      Object.entries(els).forEach(([k, el]) => el.classList.toggle('open', k === which && (open ?? !el.classList.contains('open'))));
    } else {
      Object.values(els).forEach(el => el.classList.remove('open'));
      if (which){
        const k = which === 'lib' ? 'hideLib' : 'hidePanel';
        panes[k] = open === undefined ? !panes[k] : !open;
        try { localStorage.setItem(PANES, JSON.stringify(panes)); } catch(e) {}
      }
    }
    app.classList.toggle('hide-lib', !!panes.hideLib); app.classList.toggle('hide-panel', !!panes.hidePanel);
    syncPaneBtns();
  }
  function syncPaneBtns(){
    const els = {lib:App.core.$('aside.lib'), panel:App.core.$('aside.right')}, n = App.core.narrow();
    const vis = k => n ? els[k].classList.contains('open') : !panes[k === 'lib' ? 'hideLib' : 'hidePanel'];
    App.core.$('#tgLib').classList.toggle('on', vis('lib')); App.core.$('#tgPanel').classList.toggle('on', vis('panel'));
    App.core.$('#tgLib').title = vis('lib') ? App.core.tr('收起家具库 ( [ )', 'Hide library ( [ )') : App.core.tr('展开家具库 ( [ )', 'Show library ( [ )');
    App.core.$('#tgPanel').title = vis('panel') ? App.core.tr('收起属性面板 ( ] )', 'Hide properties ( ] )') : App.core.tr('展开属性面板 ( ] )', 'Show properties ( ] )');
    App.core.$('#stage').classList.toggle('drawer-panel', n && vis('panel'));   // 属性抽屉盖住画面时让出底部工具条
  }
  function closeDrawers(){ if (App.core.narrow()) drawer(null); }

  const paints = [
    {color:'#ffffff', label:['哑光白','Matte white'],finish:['哑光乳胶漆','Matte emulsion paint']},
    {color:'#f6f1e8', label:['暖白','Warm white'],finish:['哑光乳胶漆','Matte emulsion paint']},
    {color:'#e4e5e3', label:['浅灰','Light grey'],finish:['矿物涂料','Mineral paint']},
    {color:'#d9c5ab', label:['米杏色','Soft beige'],finish:['艺术涂料','Decorative paint']},
  ];
  function ceilingRoomSection(r){
    if(r.bay)return '';
    const {tr,esc}=App.core, ceiling=App.ceilingFurniture.view();
    const data=App.ceilingModel.room(ceiling,r.id),height=App.ceilingModel.baseHeight(ceiling,r.id);
    const lowest=r.outdoor && !data.zones.length?null:height-Math.max(0,...data.zones.map(zone=>zone.drop));
    const color=data.color||App.ceilingModel.defaultColor, finish=data.finish||paints[0].finish[0];
    const preset=paints.find(paint=>paint.finish.includes(finish));
    const paintButtons=paints.map((paint,i)=>{
      const on=paint.color.toLowerCase()===color.toLowerCase() && paint.finish.includes(finish);
      return `<button type="button" class="mat ${on?'on':''}" aria-pressed="${on}" data-ceiling-paint="${i}"><i style="background:${paint.color}"></i><span>${tr(...paint.label)}<small>${tr(...paint.finish)}</small></span></button>`;
    }).join('');
    const actions=App.ceilingEditor.active()?'':`<button class="btn" id="roomCeilingDesign">${tr('编辑吊顶造型','Edit ceiling shapes')}</button><button class="btn" id="roomCeilingLibrary">${tr('添加顶装家具','Add a ceiling fixture')}</button>`;
    return `<section id="roomCeilingProps"><h3>${tr('天花','Ceiling')}</h3>
      <div class="stats">
        <div><small>${r.outdoor?tr('房间投影面积','Room plan area'):tr('顶面投影面积','Ceiling plan area')}</small><span class="big">${App.geom.fmt(App.geom.roomArea(r))}</span> m²</div>
        <div><small>${tr('吊顶分区 / 顶装件','Ceiling zones / fixtures')}</small><span class="big">${data.zones.length} / ${data.fixtures.length}</span></div>
        <div style="grid-column:1/-1"><small>${tr('最低完成面净高','Lowest finished ceiling')}</small><span class="big" id="roomCeilingClear">${lowest===null?'—':App.geom.fmt(lowest,1)}</span>${lowest===null?'':' mm'}</div>
      </div>
      <div class="form"><label>${tr('原顶净高','Base height')} (mm)<input type="number" id="roomCeilingHeight" min="1" max="30000" step="1" value="${height}"></label>
      ${r.outdoor?'':`<label>${tr('原顶颜色','Base color')}<input type="color" id="roomCeilingColor" value="${esc(color)}"></label>`}</div>
      ${r.outdoor?`<p class="ceiling-note">${tr('露台仅在已绘制的吊顶范围内显示顶面。','Outdoor ceilings appear within the shapes you draw.')}</p>`:
        `<h4>${tr('原顶饰面','Base finish')}</h4><div class="mats">${paintButtons}</div>
        <div class="form" style="margin-top:8px"><label class="full">${tr('饰面名称','Finish name')}<input id="roomCeilingFinish" maxlength="120" value="${esc(preset?tr(...preset.finish):finish)}"></label></div>`}
      <div class="actions">${data.baseHeight===undefined?'':`<button class="btn" id="roomCeilingInherit">${tr('沿用全屋高度','Use project height')}</button>`}${actions}</div></section>`;
  }
  function bindCeilingRoom(r){
    const section=App.core.$('#roomCeilingProps');
    if(!section)return;
    if(App.store.ui.ceilingPreview){
      section.querySelectorAll('button,input').forEach(el=>{el.disabled=true;});
      return;
    }
    const apply=patch=>{
      try{App.ceilingFurniture.applyRoom(r.id,patch);}
      catch(error){App.core.toast(error.message);renderPanel();}
    };
    const height=section.querySelector('#roomCeilingHeight');
    height.onchange=()=>{if(height.reportValidity() && Number.isFinite(height.valueAsNumber))apply({baseHeight:height.valueAsNumber});else renderPanel();};
    const color=section.querySelector('#roomCeilingColor');
    if(color)color.onchange=()=>apply({color:color.value});
    const finish=section.querySelector('#roomCeilingFinish');
    if(finish)finish.onchange=()=>{
      const label=finish.value.trim(), paint=paints.find(p=>p.finish.includes(label));
      apply({finish:paint?.finish[0]||label||null});
    };
    section.querySelectorAll('[data-ceiling-paint]').forEach(b=>b.onclick=()=>{
      const paint=paints[Number(b.dataset.ceilingPaint)];
      apply({finish:paint.finish[0],color:paint.color});
    });
    const inherit=section.querySelector('#roomCeilingInherit');
    if(inherit)inherit.onclick=()=>apply({baseHeight:null});
    const library=section.querySelector('#roomCeilingLibrary');
    if(library)library.onclick=App.interact.openCeilingLibrary;
    const edit=section.querySelector('#roomCeilingDesign');
    if(edit)edit.onclick=()=>{App.ceilingEditor.open(r.id);if(App.core.narrow())drawer('lib',true);};
  }

  function roomPanel(r){
    const st = App.store.roomState(r.id), info = App.plan.matInfo(st.mat);
    const a = App.geom.roomArea(r), height=App.ceilingModel.baseHeight(App.store.state.ceiling,r.id)/1000;
    const inside = App.store.state.furniture.filter(f => App.ceilingFurniture.is(f) ? f.ceiling.roomId===r.id : App.assistant.pointInPoly(f.cx,f.cy,r.poly));
    const spans = App.dimensionGeometry.roomSpans(r, App.store.ui.dimensionRoomPoint);
    const clear = axis => spans ? Math.round((spans[axis][1].value - spans[axis][0].value) * 10) / 10 : '—';
    const mats = Object.entries(App.store.MATS).map(([k,m]) => `<button class="mat ${k===st.mat?'on':''}" data-mat="${App.core.esc(k)}"><i style="background:${m.sw}"></i><span>${App.core.esc(App.core.nm(m.name))}<small>¥${m.price}/m²</small></span></button>`).join('');
    // 房间效果图：显示该房间最近一张（标题条 / 效果图页签生成的都算）
    const latest = App.assistant.roomLatestRender(r.id);
    const shotHtml = latest
      ? `<button class="roomshot" id="roomThumb" title="${App.core.esc(App.core.tr('点击放大','Click to enlarge'))}"><img src="${App.core.esc(App.core.renderAssetUrl(latest.url))}" alt=""><span>${App.core.esc(App.assistant.rRecTitle(latest))}</span></button>`
      : `<div class="muted" style="font-size:12px">${App.core.tr('进入房间后可在顶部标题条生成房间效果图','Enter the room, then generate a room render from the top bar')}</div>`;
    return `<section><h3>${App.core.tr('房间','Room')}</h3>
    <div class="form"><label class="full">${App.core.tr('名称','Name')}<input id="rName" value="${App.core.esc(App.core.nm(st.name))}"></label></div>
    <div class="stats" style="margin-top:10px">
      <div><small>${App.core.tr('使用面积','Floor area')}</small><span class="big">${App.geom.fmt(a)}</span> m²</div>
      <div><small>${App.core.tr('周长','Perimeter')}</small><span class="big">${App.geom.fmt(App.geom.roomPerimeter(r),1)}</span> m</div>
      <div><small>${App.core.tr('截面净宽','Section clear width')}</small><span class="big">${clear('x')}</span> mm</div>
      <div><small>${App.core.tr('截面净深','Section clear depth')}</small><span class="big">${clear('y')}</span> mm</div></div>
    <div class="muted">${App.core.tr(`墙面面积（原顶高 ${height} m，未扣门窗）约 ${App.geom.fmt(App.geom.roomPerimeter(r)*height,1)} m²`, `Wall area (${height} m base ceiling, openings not deducted) ≈ ${App.geom.fmt(App.geom.roomPerimeter(r)*height,1)} m²`)}</div>
    <div class="actions"><button class="btn primary" id="enterRoomBtn">${App.core.tr('进入房间','Enter room')}</button></div></section>
  <section><h3>${App.core.tr('地面材料','Flooring')}</h3><div class="mats">${mats}</div>
    <div class="total"><span>${App.core.tr('材料估价','Estimated cost')}</span><b>¥${Math.round(a*info.price*1.05).toLocaleString()}</b></div></section>
  ${ceilingRoomSection(r)}
  <section><h3>${App.core.tr('房间效果图','Room render')} ${latest ? `<small>${App.core.tr('最近一张','Latest')}</small>` : ''}</h3>${shotHtml}</section>
  <section><h3>${App.geom.componentCount(inside) ? App.core.tr('房间内家具和构件','Furniture and components in room') : App.core.tr('房间内家具','Furniture in room')} <small>${App.core.tr(`${inside.length} 件`, `${inside.length} items`)}</small></h3>
    <table>${inside.map(f => `<tr class="click" data-fid="${App.core.esc(f.id)}"><td>${App.core.esc(App.core.nm(f.name))}</td><td class="r muted">${f.w}×${f.d}</td></tr>`).join('') || `<tr><td class="muted">${App.core.tr('暂无','None')}</td></tr>`}</table>
    <div class="actions"><button class="btn" id="back">${App.core.tr('← 返回总览','← Back to overview')}</button></div></section>`;
  }
  function bindRoomPanel(){
    const id = App.store.ui.sel.id;
    bindCeilingRoom(App.plan.roomDef(id));
    App.core.$('#rName').onchange = e => App.store.mutate(() => App.store.roomState(id).name = e.target.value.trim() || App.store.roomState(id).name);
    document.querySelectorAll('#panel [data-mat]').forEach(b => b.onclick = () => App.store.mutate(() => App.store.roomState(id).mat = App.plan.matKey(b.dataset.mat)));
    document.querySelectorAll('#panel tr[data-fid]').forEach(tr => tr.onclick = () => App.interact.select({kind:'furn', id:tr.dataset.fid}));
    if (App.core.$('#enterRoomBtn')) App.core.$('#enterRoomBtn').onclick = () => { closeDrawers(); App.io.studioEnterRoom(id); };
    if (App.core.$('#roomThumb')) App.core.$('#roomThumb').onclick = () => { const rec = App.assistant.roomLatestRender(id); if (rec) App.assistant.openLightbox(rec.url, App.assistant.rRecTitle(rec), rec); };
    App.core.$('#back').onclick = () => App.interact.select(null);
  }

  function mountingPanel(f){
    if(!App.ceilingFurniture.is(f))return '';
    const {tr,esc}=App.core,fixture=App.ceilingFurniture.toFixture(f), ceiling=App.ceilingFurniture.view();
    const room=App.plan.roomDef(f.ceiling.roomId);
    if(!room)return '';
    const height=Math.round(App.ceilingModel.fixtureHeight(ceiling,room,fixture));
    const options=App.ceilingModel.room(ceiling,room.id).zones.map(zone=>
      `<option value="${esc(zone.id)}" ${zone.id===fixture.zoneId?'selected':''}>${esc(zone.name)}</option>`).join('');
    const light=['downlight','spot','pendant','linear','track'].includes(fixture.type);
    return `<section><h3>${tr('顶面安装','Ceiling mounting')} <small>${esc(App.core.nm(App.store.roomState(room.id).name))}</small></h3>
      <div class="form"><label class="full">${tr('安装面','Mounting surface')}<select id="fMountZone"><option value="">${tr('随所在顶面','Automatic at this position')}</option>${options}</select></label>
        ${fixture.type==='pendant'?`<label>${tr('吊长','Pendant drop')} (mm)<input id="fHang" type="number" min="0" max="${height-1}" step="any" value="${fixture.hang??Math.min(480,height*.35)}"></label>`:''}
        ${light?`<label>${tr('色温','Color temperature')} (K)<input id="fKelvin" type="number" min="1800" max="10000" step="any" value="${fixture.kelvin??3000}"></label>
        <label>${tr('亮度','Brightness')} (%)<input id="fIntensity" type="number" min="0" max="100" step="any" value="${fixture.intensity??100}"></label>`:''}
        ${['spot','track'].includes(fixture.type)?`<label>${tr('倾角','Tilt')} (°)<input id="fTilt" type="number" min="-85" max="85" step="any" value="${fixture.tilt??0}"></label>`:''}
      </div>
      <p class="ceiling-note">${tr('安装面标高','Mount elevation')} ${height} mm · ${tr('移至另一房间时自动更新安装位置。','Moving to another room updates the mount.')}</p></section>`;
  }
  function furnPanel(f){
    const component = f.type === 'component', mounted=App.ceilingFurniture.is(f);
    const table = App.geom.tableTopType(f.type), top = App.geom.tableTopShape(f);
    const circular = table && top !== 'rect';
    const cornerDepth = Math.min(950, f.d*.56, f.w*.4);
    const footprint = f.type === 'cornersofa' ? cornerDepth * (f.w + f.d - cornerDepth)
      : f.w*f.d * (circular ? Math.PI/4 : 1);
    return `<section><h3>${component ? App.core.tr('构件属性','Component') : App.core.tr('家具属性','Furniture')}</h3>
    <div class="form">
      <label class="full">${App.core.tr('名称','Name')}<input id="fName" value="${App.core.esc(App.core.nm(f.name))}"></label>
      <label>${App.core.tr('宽','Width')} (mm)<input type="number" id="fW" value="${f.w}" min="${mounted?1:50}" step="${mounted?'any':10}"></label>
      <label>${App.core.tr('深','Depth')} (mm)<input type="number" id="fD" value="${f.d}" min="${mounted?1:50}" step="${mounted?'any':10}"></label>
      <label>${App.core.tr('中心','Center')} X (mm)<input type="number" id="fX" value="${mounted?f.cx:Math.round(f.cx)}" step="${mounted?'any':10}"></label>
      <label>${App.core.tr('中心','Center')} Y (mm)<input type="number" id="fY" value="${mounted?f.cy:Math.round(f.cy)}" step="${mounted?'any':10}"></label>
      <label>${App.core.tr('旋转','Rotation')} (°)<input type="number" id="fR" value="${f.rot}" step="${mounted?'any':15}"></label>
      <label>${component ? App.core.tr('默认颜色','Default color') : App.core.tr('颜色','Color')}<input type="color" id="fC" value="${f.color}"></label>
      ${f.type === 'cornersofa' ? `<label class="full">${App.core.tr('转角所在侧（未旋转时）','Return side at 0°')}
        <select id="fHandedness"><option value="left">${App.core.tr('左侧','Left')}</option>
          <option value="right" ${f.handedness === 'right' ? 'selected' : ''}>${App.core.tr('右侧','Right')}</option></select></label>` : ''}
      ${table ? `<label>${App.core.tr('台面形状','Top shape')}<select id="fTopShape">
        <option value="">${App.core.tr('家具库默认','Library default')}</option>
        <option value="rect" ${f.topShape === 'rect' ? 'selected' : ''}>${App.core.tr('矩形','Rectangle')}</option>
        <option value="round" ${f.topShape === 'round' ? 'selected' : ''}>${App.core.tr('圆形','Round')}</option>
        <option value="oval" ${f.topShape === 'oval' ? 'selected' : ''}>${App.core.tr('椭圆','Oval')}</option></select></label>
        <label>${App.core.tr('台面高度','Top height')} (mm)<input type="number" id="fHeight" value="${f.height ?? ''}" placeholder="${App.geom.tableHeight(f)}" min="200" max="800" step="any"></label>` : ''}
    </div>
    <div class="muted" style="margin-top:8px">${mounted?App.core.tr('顶面投影面积','Ceiling footprint'):App.core.tr('占地面积','Footprint')} ${App.geom.fmt(footprint/1e6)} m²${component
        ? App.core.tr(` · ${f.parts.length} 个部件 · 最高点 ${Math.round(Math.max(...f.parts.map(p => p.y + p.h)))} mm`,
          ` · ${f.parts.length} parts · max elevation ${Math.round(Math.max(...f.parts.map(p => p.y + p.h)))} mm`) : ''}</div>
    <div class="actions">
      <button class="btn" id="aRot">${App.core.tr('旋转 90°','Rotate 90°')}</button><button class="btn" id="aDup">${App.core.tr('复制','Duplicate')}</button>
      <button class="btn" id="aTop">${App.core.tr('置于顶层','Bring to front')}</button><button class="btn" id="aBot">${App.core.tr('置于底层','Send to back')}</button>
      <button class="btn danger" id="aDel">${App.core.tr('删除','Delete')}</button><button class="btn" id="back">${App.core.tr('← 返回','← Back')}</button>
    </div></section>
  ${mountingPanel(f)}
  <section class="muted" style="font-size:12px">${App.core.tr('拖动移动；拖动上方圆点旋转；拖动右下角方块调整尺寸。开启「贴墙吸附」后靠近墙面会自动贴齐。', 'Drag to move; drag the top dot to rotate; drag the bottom-right square to resize. With "Wall snap" on, items snap flush to nearby walls.')}</section>`;
  }
  function bindFurnPanel(f){
    const mounted=App.ceilingFurniture.is(f);
    const upd=(fn,move=false)=>{
      const current=App.store.getF(f.id);
      if(!current)return;
      if(!mounted){App.store.mutate(()=>fn(current));return;}
      try{
        let next={...current,ceiling:{...current.ceiling}};
        fn(next);
        if(move){
          next=App.ceilingFurniture.place(next);
          if(!next)throw new Error(App.core.tr('请把顶装件放在房间顶面内','Place the fixture within a room ceiling'));
        }
        App.ceilingFurniture.update(next);
      }catch(error){App.core.toast(error.message);renderPanel();}
    };
    const num=(id,fn,move=false)=>{
      const input=App.core.$(id);
      if(!input)return;
      input.onchange=()=>{
        if(!Number.isFinite(input.valueAsNumber) || (mounted&&!input.reportValidity())){renderPanel();return;}
        upd(g=>fn(g,input.valueAsNumber),move);
      };
    };
    App.core.$('#fName').onchange = e => upd(g => g.name = e.target.value.trim() || g.name);
    num('#fW',(g,v)=>g.w=mounted?v:Math.max(50,Math.round(v)));
    num('#fD',(g,v)=>g.d=mounted?v:Math.max(50,Math.round(v)));
    num('#fX',(g,v)=>g.cx=v,true);num('#fY',(g,v)=>g.cy=v,true);num('#fR',(g,v)=>g.rot=App.geom.norm(v));
    const mountZone=App.core.$('#fMountZone');
    if(mountZone)mountZone.onchange=()=>upd(g=>{if(mountZone.value)g.ceiling.zoneId=mountZone.value;else delete g.ceiling.zoneId;});
    for(const [id,key] of [['#fHang','hang'],['#fKelvin','kelvin'],['#fIntensity','intensity'],['#fTilt','tilt']]){
      num(id,(g,v)=>g.ceiling[key]=v);
    }
    App.core.$('#fC').onchange = e => upd(g => g.color = e.target.value);
    if (App.core.$('#fHandedness')) App.core.$('#fHandedness').onchange = e => upd(g => { g.handedness = e.target.value; });
    if (App.core.$('#fTopShape')) App.core.$('#fTopShape').onchange = e => upd(g => {
      if (e.target.value) g.topShape = e.target.value;
      else delete g.topShape;
    });
    if (App.core.$('#fHeight')) App.core.$('#fHeight').onchange = e => upd(g => {
      const height = e.target.valueAsNumber;
      if (Number.isFinite(height)) g.height = Math.min(800, Math.max(200, height));
      else delete g.height;
    });
    App.core.$('#aRot').onclick = () => App.interact.rotateSel(90);
    App.core.$('#aDup').onclick = App.interact.duplicateSel;
    App.core.$('#aDel').onclick = App.interact.deleteSel;
    App.core.$('#aTop').onclick = () => App.store.mutate(() => { const i = App.store.state.furniture.findIndex(g => g.id===f.id); App.store.state.furniture.push(...App.store.state.furniture.splice(i,1)); });
    App.core.$('#aBot').onclick = () => App.store.mutate(() => { const i = App.store.state.furniture.findIndex(g => g.id===f.id); App.store.state.furniture.unshift(...App.store.state.furniture.splice(i,1)); });
    App.core.$('#back').onclick = () => App.interact.select(null);
  }

  Object.assign(App.panel, {
    renderPanel, clearLayout, drawer, syncPaneBtns, closeDrawers, ceilingRoomSection, bindCeilingRoom,
  });
})();
