/* Room-based ceiling editing shares the plan's viewBox, project history and selection tools. */
(() => {
  'use strict';
  const App = globalThis.App;
  const { $, tr, esc } = App.core;
  const model = App.ceilingModel;
  const state = () => App.store.state.ceiling;
  const displayed = () => App.ceilingFurniture.view();
  const isPreview = () => Boolean(App.store.ui.ceilingPreview);
  const path = points => points?.length ? 'M'+points.map(p=>p.join(' ')).join('L') : '';
  const closed = points => path(points)+'Z';
  const names = {
    side:['单侧边吊','Single-edge drop'], flat:['整面平吊','Flat ceiling'], perimeter:['回形边吊','Perimeter drop'], island:['悬浮顶','Floating island'],
    rectangle:['矩形吊顶','Rectangular zone'], polygon:['自由轮廓','Custom outline'], hole:['绘制镂空','Draw opening'],
    downlight:['筒灯','Downlight'], spot:['射灯','Spotlight'], pendant:['吊灯','Pendant'],
    linear:['线性灯','Linear light'], track:['磁吸轨道','Lighting track'],
    ceilingac:['四面出风天花机','Ceiling cassette AC'], ductac:['风管机','Ducted AC'], vent:['条形风口','Air grille'], access:['检修口','Access hatch'], curtain:['窗帘盒','Curtain pocket'], cove:['灯槽','Light cove'], trim:['收边','Trim'],
  };
  const title = k => names[k] ? tr(...names[k]) : k;
  const lights = ['downlight','spot','pendant','linear','track'];
  const groups = {zone:'zones',edge:'edges',fixture:'fixtures'};
  const defaultCeilingColor = () => model.defaultColor || '#ffffff';
  let presetWidth=400, arrayType='downlight', projectId='', lastPreset=null, pendingPreset=null;
  let enabled=false, overlay=false, roomId='', selected=null, tool=null, points=[], hoverPoint=null, dragPreview=null, edgeIndex=0, vertexIndex=0, count=4;
  const active = () => enabled && !App.io.is3D?.();
  const rooms = () => App.store.ROOMS.filter(r => !r.bay);
  const firstRoom = () => rooms().find(r=>!r.outdoor) || rooms()[0];
  const roomDef = () => rooms().find(r=>r.id===roomId);
  const roomData = (ceiling=displayed()) => model.room(ceiling,roomId);
  const collection = (data,kind) => data[groups[kind]] || [];
  const selectedObject = (data=roomData()) => selected && collection(data, selected.kind).find(item=>item.id===selected.id);
  const uid = () => App.geom.uid();
  const roomName = r => App.core.nm(App.store.roomState(r.id).name);
  const isInside = (point,poly) => App.assistant.pointInPoly(point[0],point[1],poly);
  const roomAt = point => rooms().find(r=>isInside(point,r.poly));
  function reconcile(){
    if (!roomDef()){
      const preferred=App.store.ui.sel?.kind==='room' && rooms().find(r=>r.id===App.store.ui.sel.id);
      roomId=(preferred||firstRoom())?.id || '';
      selected=null; clearTool();
    }
    if (selected && !selectedObject()) selected=null;
    const furniture=selectedFurniture();
    if (furniture && !tool && !selected) setRoom(furniture.ceiling.roomId);
    if(lastPreset && (lastPreset.room!==roomId || selected?.kind!=='zone' || lastPreset.id!==selected.id))lastPreset=null;
    if(holeIndex>=0 && !selectedObject()?.holes?.[holeIndex])holeIndex=-1;
  }
  function presetActive(type){return Boolean(lastPreset && lastPreset.type===type && lastPreset.room===roomId && selected?.kind==='zone' && lastPreset.id===selected.id && !tool);}
  function clearTool(){ tool=null; points=[]; hoverPoint=null; dragPreview=null; pendingPreset=null; }
  function setRoom(id){
    if(!rooms().some(r=>r.id===id))return;
    if(roomId!==id){roomId=id; selected=null; clearTool(); edgeIndex=vertexIndex=0;holeIndex=-1;}
  }
  function selectedFurniture(){
    const sel=App.store.ui.sel;
    const item=sel?.kind==='furn' && App.store.getF(sel.id);
    return item && App.ceilingFurniture.is(item) ? item : null;
  }
  function selectFurniture(item){
    if (!active() || !App.ceilingFurniture.is(item))return;
    setRoom(item.ceiling.roomId);
    selected=null;clearTool();edgeIndex=vertexIndex=0;holeIndex=-1;
    render();
  }
  function selectRoomSurface(kind,id){
    selected=(kind==='zone'||kind==='edge')&&id?{kind,id}:null;
    App.store.ui.sel=roomId?{kind:'room',id:roomId}:null;
    App.store.ui.dimensionRoomPoint=null;
    edgeIndex=vertexIndex=0;holeIndex=-1;
  }
  function enter(id,kind,itemId){
    const was=active(); enabled=true;
    const furniture=selectedFurniture();
    const selectedRoom=App.store.ui.sel?.kind==='room'?App.store.ui.sel.id:furniture?.ceiling.roomId;
    setRoom(id||selectedRoom||roomId||firstRoom()?.id);
    if(kind==='fixture')select(kind,itemId);
    else if(id || kind || !furniture)selectRoomSurface(kind,itemId);
    if(!was)App.interact.setTool('select');
    syncView();
  }
  async function open(id,kind,itemId){
    if(App.io.is3D?.()){ await App.io.setView('2d'); if(App.io.is3D())return; }
    enter(id,kind,itemId);
  }
  function close(){enabled=false;clearTool();syncView();}
  function syncView(){
    document.body.classList.toggle('ceiling-edit',active());
    App.draw2d.renderAll();
  }
  function context(){
    if(!active())return null;
    const f=selectedFurniture();
    return {roomId:f?.ceiling.roomId||roomId,kind:f?'fixture':selected?.kind||'room',id:f?.id||selected?.id||roomId,tool:tool||'select'};
  }
  function select(kind,id){
    if(kind==='fixture' && App.store.getF(id)){
      App.interact.select({kind:'furn',id});
      return;
    }
    selectRoomSurface(kind,id);
    App.draw2d.renderSel();render();App.panel.renderPanel();
  }
  function change(patch,nextSelection=selected){
    if(isPreview()||!roomDef())return false;
    const previous=selected,previousUi=App.store.ui.sel;
    try{
      selected=nextSelection?.kind==='fixture'?null:nextSelection;
      App.store.ui.sel={kind:'room',id:roomId};
      App.ceilingFurniture.applyRoom(roomId,patch);
      if(nextSelection?.kind==='fixture')select('fixture',nextSelection.id);
      return true;
    }catch(error){
      selected=previous;App.store.ui.sel=previousUi;
      App.core.toast(tr('天花编辑未应用','Ceiling change was not applied')+' · '+error.message);
      render();App.panel.renderPanel();return false;
    }
  }
  function replaceItem(kind,obj){
    const key=groups[kind], items=roomData()[key];
    return change({[key]:items.map(i=>i.id===obj.id?obj:i)},{kind,id:obj.id});
  }
  function removeSelection(){
    if(!selected||isPreview())return;
    const {kind,id}=selected,data=roomData(),key=groups[kind];
    const patch={[key]:data[key].filter(item=>item.id!==id)};
    if(kind==='zone'){
      patch.edges=data.edges.filter(e=>e.zoneId!==id);
      patch.fixtures=data.fixtures.map(f=>{if(f.zoneId!==id)return f;const copy={...f};delete copy.zoneId;return copy;});
    }
    change(patch,null);
  }
  // Artwork uses the same front faces for the reflected ceiling plan and the library.
  // Outer dimensions come from the fixture. Thin strokes stay legible at drawing scales.
  function fixtureSymbol(type, customColor){
    const finish=/^#[0-9a-f]{6}$/i.test(customColor||'')?customColor:null;
    const ink='#514c43', shell=finish||'#d9d6c9', optic='#494a44', brass='#ab8550', lens='#f6dfa5';
    const line=(d,color=ink,sw=.65)=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`;
    const face=(d,fill,stroke=ink,sw=.85)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    const oval=(x,y,rx,ry,fill,stroke='none',sw=.75)=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`;
    const box=(x,y,w,h,rx,fill,stroke=ink,sw=.85)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${Math.min(rx,h/2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`;
    switch(type){
      case 'downlight':
        return oval(0,0,48,48,shell,ink)+oval(0,0,36,36,optic)+oval(0,0,25,25,lens,brass,.45)
          +line('M-16 4Q-18 -14 -2 -17','#fff9e7',.8)+oval(8,9,6,5,'#e5bf75');
      case 'spot':
        return '<g transform="rotate(-32)">'+oval(0,-12,36,35,shell,ink)+oval(0,-12,25,24,optic)
          +face('M-26 -20Q-26 -26 -20 -26H20Q26 -26 26 -20L31 20H-31Z',finish||'#777669')
          +line('M-33 -10v21M33 -10v21','#80775f',1.3)+oval(0,20,31,22,'#b8a782',ink,.8)
          +oval(0,20,24,16,lens)+line('M-16 18Q-7 9 6 13','#fff8db',.7)+'</g>';
      case 'pendant': {
        const rim=oval(0,0,49,49,finish||'#f4f0e7',ink);
        const ribs=Array.from({length:8},(_,i)=>`<g transform="rotate(${i*45})">${line('M0 -48Q5 -36 0 -22','#b4a88d',.55)}</g>`).join('');
        return rim+ribs+oval(0,0,23,23,'#b9aa8e',ink,.6)+oval(0,0,18,18,'#fff6e3')+line('M-12 -5Q-8 -13 2 -14','#fffaf0',.7);
      }
      case 'linear':
        return box(-49,-47,98,94,3,finish||'#a9a9a0')+box(-45,-29,90,58,2,'#fbebc6','#8e8066',.6)
          +line('M-39 -10H39','#fff9e9',.65)+line('M-46 -31V31M46 -31V31','#73766e',.55);
      case 'track': {
        const heads=[-32,0,32].map((x,i)=>`<g transform="translate(${x} 0) scale(${i===1?-1:1} 1)">`+
          face('M-4 -14L4 -24L10 18L4 36L-4 21Z',finish||'#53534c')+
          face('M2 23L8 12L10 24L4 42Z','#dfc18a',ink,.55)+'</g>').join('');
        return box(-49,-15,98,30,2,'#4b4b46')+line('M-46 -5H46','#a5a297',.55)+heads;
      }
      case 'ceilingac': {
        const louvers=[0,90,180,270].map(a=>`<g transform="rotate(${a})">${face('M-40 -40H40L32 -32H-32Z','#737e7d','#626f6d',.5)}</g>`).join('');
        return box(-49,-49,98,98,5,finish||'#e2e6e2')+louvers+box(-27,-27,54,54,3,'#bbc5c1')+
          [-18,-12,-6,0,6,12,18].map(y=>line(`M-22 ${y}H22`,'#899590',.55)).join('')+oval(39,42,2,2,'#91bc97');
      }
      case 'ductac':
        return box(-49,-45,98,90,3,finish||'#cbd2ce')+box(-46,14,92,24,1,'#63736e')+
          [-27,-13,0,13,27].map(x=>line(`M${x} 16v19`,'#bfc8c2',.65)).join('')+
          box(-41,-28,63,26,1,'#dfe4df','#9aa59c',.55)+line('M27 -31v34','#8e9c94',.6);
      case 'vent':
        return box(-49,-48,98,96,2,finish||'#bcc7bd')+box(-46,-34,92,68,1,'#627770','#51655e',.6)
          +[-20,0,20].map(y=>line(`M-44 ${y}H44`,'#d7e0d5',.7)).join('')
          +line('M0 -31V31','#85948a',.85);
      case 'access':
        return box(-48,-48,96,96,3,finish||'#c6cfc4')+box(-40,-40,80,80,2,'#edf0e7','#788578',.6)
          +box(-41,-25,5,12,1,'#8a998d','none')+box(-41,12,5,12,1,'#8a998d','none')+
          box(26,-7,6,14,2,'#6c796d','none')+line('M-31 -33H32','#fffdf3',.55);
      case 'curtain':
        return box(-49,-48,98,96,2,finish||'#d8d7c9')+line('M-46 -29H46M-46 -13H46','#797c70',.65)
          +face('M-46 0Q-42 28 -38 8T-30 8T-22 8T-14 8T-6 8T2 8T10 8T18 8T26 8T34 8T42 8Q45 18 46 2V36H-46Z','#eee8d8','#9b9c8a',.55);
      default: return '';
    }
  }
  const shapeGlyphs={
    flat:'<rect x="-16" y="-11" width="32" height="22" rx="1" fill="#f9f8f1"/>',
    perimeter:'<path fill="#e1d9c8" fill-rule="evenodd" d="M-17 -11h34v22h-34zM-12 -7v14h24V-7z"/>',
    island:'<rect x="-14" y="-9" width="28" height="18" rx="6" fill="#f9f6ee"/><rect x="-11" y="-6" width="22" height="12" rx="4" fill="none" stroke="#b99e71" stroke-width=".7"/>',
    side:'<rect x="-17" y="-11" width="34" height="22" rx="1" fill="#faf8f0"/><path d="M-17 -11h34v7h-34z" fill="#d9c6a4"/>',
    rectangle:'<rect x="-15" y="-10" width="30" height="20" fill="#f8f6ed"/><path d="M-17 -12h4v4h-4zM13 8h4v4h-4z" fill="#c48859" stroke="#845c3d" stroke-width=".65"/>',
    polygon:'<path d="M-16 7l4-15 15-4 14 11-8 12Z" fill="#f6efdd"/><circle cx="3" cy="-12" r="1.8" fill="#ad7952"/>'
  };
  const glyphSize={downlight:[22,22],spot:[23,23],pendant:[27,27],linear:[43,7],track:[45,16],vent:[40,13],ceilingac:[26,26],ductac:[36,18],access:[24,24],curtain:[42,12]};
  function toolThumbnail(type){
    const size=glyphSize[type];
    const art=size?`<g transform="scale(${size[0]/100} ${size[1]/100})">${fixtureSymbol(type)}</g>`:
      `<g stroke="#746d60" stroke-width="1.05" stroke-linejoin="round">${shapeGlyphs[type]||''}</g>`;
    return `<svg viewBox="-28 -18 56 36" width="56" height="36" aria-hidden="true" focusable="false">${art}</svg>`;
  }
  function symbolScale(type,l,w,s){
    const point=['downlight','spot','pendant'].includes(type);
    const minSide=point?10:(type==='track'||type==='vent'||type==='curtain'?5:3);
    // At whole-home scale the point symbol is centred on its true mounting point.
    const factor=point?Math.max(1,10/(Math.max(l,w)*s)):1;
    return `scale(${l*factor/100} ${(point?w*factor:Math.max(w,Math.min(l,minSide/s)))/100})`;
  }
  let symbolViewScale=0;
  function resizeSymbols(){
    const s=App.store.view.s;
    if(symbolViewScale===s)return;
    symbolViewScale=s;
    for(const symbol of $('#gCeiling').querySelectorAll('[data-ceil-symbol]')){
      const {ceilSymbol,length,width}=symbol.dataset;
      symbol.setAttribute('transform',symbolScale(ceilSymbol,Number(length),Number(width),s));
    }
  }
  function attrs(kind,item,id){
    const selectedHere=active()&&id===roomId&&selected?.id===item.id&&selected.kind===kind;
    return `data-ceil-id="${esc(item.id)}" data-ceil-kind="${kind}" data-ceil-room="${esc(id)}" ${selectedHere?'class="ceil-selected"':''}`;
  }
  function drawRoom(r,ceiling){
    const data=model.room(ceiling,r.id);
    const base=!r.outdoor && (active() || data.color) ? App.draw2d.roomShape(r,`fill="${data.color||defaultCeilingColor()}" fill-opacity="${active() ? .76 : .44}" pointer-events="none"`) : '';
    const zones=[...data.zones].sort((a,b)=>a.drop-b.drop).map(z=>{
      const d=closed(model.outline(z))+(z.holes||[]).map(closed).join('');
      return `<path ${attrs('zone',z,r.id)} d="${d}" fill-rule="evenodd" fill="${z.color}" fill-opacity=".68" stroke="#a97145" stroke-width="1.4" vector-effect="non-scaling-stroke"><title>${esc(z.name)} · ${Math.round(model.baseHeight(ceiling,r.id)-z.drop)} mm</title></path>`;
    });
    const edges=data.edges.map(edge=>{
      const region=edge.zoneId?data.zones.find(z=>z.id===edge.zoneId):r;
      if(!region)return '';
      const boundary=edge.hole!==undefined&&region.holes?.[edge.hole]?{poly:region.holes[edge.hole]}:region;
      return `<g ${attrs('edge',edge,r.id)}><path d="${path(model.edgePoints(boundary,edge.edge))}" stroke="${edge.type==='cove'?'#d39728':'#846a56'}" fill="none" stroke-width="3" vector-effect="non-scaling-stroke"/><path d="${path(model.edgePoints(boundary,edge.edge))}" stroke="transparent" fill="none" stroke-width="9" vector-effect="non-scaling-stroke"/></g>`;
    });
    const fixtures=(isPreview()?data.fixtures:[]).map(f=>{
      const def=App.ceilingFurniture.defaults(f.type),l=f.length||def.w,w=f.width||def.d;
      const symbol=`<g data-ceil-symbol="${f.type}" data-length="${l}" data-width="${w}" transform="${symbolScale(f.type,l,w,App.store.view.s)}">${fixtureSymbol(f.type,f.color)}</g>`;
      return `<g ${attrs('fixture',f,r.id)} transform="translate(${f.x} ${f.y}) rotate(${f.rotation||0})"><title>${esc(title(f.type))} · ${l}×${w} mm</title>${symbol}<circle r="${Math.max(60,5/App.store.view.s)}" fill="transparent" stroke="none"/></g>`;
    });
    return base+[...zones,...edges,...fixtures].join('');
  }
  function button(label,cmd,value='',on=false){return `<button type="button" class="btn ${on?'on':''}" data-cmd="${cmd}" data-value="${esc(value)}"${(cmd==='tool'||cmd==='preset')?' aria-pressed="'+on+'"':''}>${label}</button>`;}
  const actionButtons=(vs,cmd)=>vs.map(v=>button(toolThumbnail(v)+'<span>'+title(v)+'</span>',cmd,v,cmd==='preset'?presetActive(v):tool===v)).join('');
  function options(list,value){return list.map(([key,label])=>`<option value="${esc(String(key))}" ${String(key)===String(value)?'selected':''}>${esc(label)}</option>`).join('');}
  function presetChoices(def){
    if(!pendingPreset||!def||isPreview())return '';
    const zones=roomData().zones;
    if(!zones.length)return '';
    return `<section id="ceilingPresetChoices" aria-labelledby="ceilingPresetChoiceTitle">
      <h4 id="ceilingPresetChoiceTitle">${tr('应用「','Apply “')}${esc(title(pendingPreset.type))}${tr('」','”')}</h4>
      <label class="ceil-field">${tr('要替换的顶面','Ceiling surface to replace')}<select id="ceilingPresetTarget">
        ${options(zones.map(zone=>[zone.id,`${zone.name} · ${zone.drop} mm`]),pendingPreset.target)}
      </select></label>
      <div class="ceil-buttons">${button(tr('替换所选顶面','Replace selected surface'),'preset-replace')}</div>
      <label class="ceil-field">${tr('新增层下吊量（mm）','New layer drop (mm)')}<input id="ceilingPresetDrop"
        type="number" min="0" max="${model.baseHeight(state(),def.id)-1}" step="any" required value="${pendingPreset.drop}"></label>
      <div class="ceil-buttons">${button(tr('新增顶面','Add surface'),'preset-add')}${button(tr('取消','Cancel'),'preset-cancel')}</div>
    </section>`;
  }
  function library(){
    const lib=$('#ceilingLibrary'), available=rooms(), def=roomDef();
    lib.innerHTML=`<h3>${tr('天花板设计','Ceiling design')}</h3><label class="ceil-field">${tr('设计房间','Room')}<select id="ceilingRoom">${options(available.map(r=>[r.id,roomName(r)]),roomId)}</select></label>
    <div class="ceil-buttons">${button(tr('室内 3D 预览','Preview in 3D'),'preview')}${button(tr('3D 样式展示','3D style gallery'),'showcase')}</div>
    <h4>${tr('吊顶造型','Ceiling shapes')}</h4><label class="ceil-field">${tr('边宽 / 悬浮顶退距（mm）','Band width / island inset (mm)')}<input id="ceilingPresetWidth" type="number" min="10" max="10000" step="10" value="${presetWidth}"></label><div class="ceiling-tools fixture-catalog">${actionButtons(['flat','perimeter','island'],'preset')}${actionButtons(['side','rectangle','polygon'],'tool')}</div>
    ${presetChoices(def)}
    <h4>${tr('等距布灯','Light array')}</h4><div class="ceiling-tools">${button(tr('两点等距布置','Place between two points'),'tool','array',tool==='array')}</div>
    <div class="ceil-buttons">${button(tr('AI 识别天花','Recognize ceiling'),'scan')}${button(tr('顶装家具与设备','Ceiling furniture & equipment'),'furniture')}</div>`;
    if(!def||isPreview())lib.querySelectorAll('[data-cmd]').forEach(b=>{if (b.dataset.cmd!=='preview' && !(!def&&b.dataset.cmd==='scan'))b.disabled=true;});
  }
  function render(){
    const project=App.projects.activeProjectId;
    if(projectId && project && project!==projectId){roomId='';selected=null;edgeIndex=vertexIndex=0;holeIndex=-1;clearTool();}
    if(project)projectId=project;
    const edit=active(); if(edit)reconcile();
    document.body.classList.toggle('ceiling-edit',edit);
    const libName=tr('家具库','Library');
    $('#tgLib').textContent='◧ '+libName;
    if(App.io.TIPS)$('#tip').textContent=edit?tr('从家具库拖入灯具与顶装设备 · 点击吊顶造型编辑轮廓','Drag ceiling fixtures from the furniture library · select a ceiling shape to edit its outline'):App.io.TIPS()[App.io.is3D()?'3d':'2d'];
    $('#ceilingMode').classList.toggle('on',edit);$('#ceilingMode').setAttribute('aria-pressed',String(edit));
    const overlayBtn=$('#ceilingOverlay'); overlayBtn.hidden=edit;overlayBtn.classList.toggle('on',overlay);overlayBtn.setAttribute('aria-pressed',String(overlay));
    const shown=edit||overlay||isPreview();
    const ceiling=shown && displayed();
    $('#gCeiling').innerHTML=shown?rooms().filter(r=>ceiling.rooms[r.id] || (edit && !r.outdoor)).map(r=>drawRoom(r,ceiling)).join(''):'';
    $('#gCeiling').classList.toggle('edit',edit);
    if(edit)library();
    renderSketch();
  }
  function snap(p){
    if(App.store.ui.layers.wallSnap){const v=App.interact.snapPoint(p,false);return [Math.round(v.x),Math.round(v.y)];}
    return [Math.round(p.x/10)*10,Math.round(p.y/10)*10];
  }
  const freeTool=()=>tool==='polygon'||tool==='hole';
  function renderSketch(){
    resizeSymbols();
    const g=$('#ceilingSketch'), task=$('#ceilingTask'),edit=active();
    task.hidden=!edit||!tool||isPreview();document.body.classList.toggle('ceiling-draw',edit&&!!tool);
    if(!edit||!roomDef()){g.innerHTML='';return;}
    const r=roomDef(), k=1/App.store.view.s, pieces=[];
    if(!tool && !selected && !selectedFurniture())pieces.push(App.draw2d.roomShape(r,'fill="none" stroke="#c18250" stroke-width="1.2" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"'));
    if(!isPreview()&&selected?.kind==='zone'&&!tool){
      const z=selectedObject();if(z){
        const onHole=holeIndex>=0 && z.holes?.[holeIndex];
        const contour=onHole?{poly:z.holes[holeIndex]}:z;
        const vertices=contour.poly.map((v,i)=>dragPreview?.vertex===i?dragPreview.point:v);
        pieces.push(`<path d="${closed(model.outline({...contour,poly:vertices}))}" class="ceiling-outline"/>`);
        if(!dragPreview)pieces.push(`<path d="${path(model.edgePoints(contour,edgeIndex))}" fill="none" stroke="#cf8643" stroke-width="3" vector-effect="non-scaling-stroke"/>`);
        vertices.forEach(([x,y],i)=>pieces.push(`<circle data-ceil-vertex="${i}" cx="${x}" cy="${y}" r="${16*k}" fill="transparent" aria-hidden="true"/>
          <circle cx="${x}" cy="${y}" r="${4*k}" fill="${i===vertexIndex?'#b5653a':'#fff'}" stroke="#b5653a"
            stroke-width="1.5" vector-effect="non-scaling-stroke" pointer-events="none" aria-hidden="true"/>`));
      }
    }
    if(tool){
      const partial=[...points,...(hoverPoint?[hoverPoint]:[])];
      if(partial.length){
        let d=path(partial);
        if(tool==='rectangle'&&partial.length===2){const [[x,y],[u,v]]=partial;d=closed([[x,y],[u,y],[u,v],[x,v]]);}
        pieces.push(`<path d="${d}" class="ceiling-outline"/>`);
      }
      for(const [x,y] of points)pieces.push(`<circle cx="${x}" cy="${y}" r="${3*k}" fill="#b5653a"/>`);
      $('#ceilingTaskHint').textContent=freeTool()?tr(`逐点绘制 · ${points.length} 个点`,`Click vertices · ${points.length} points`):
        tool==='rectangle'?tr(points.length?'点击对角完成矩形':'点击矩形的第一个角',points.length?'Pick opposite corner':'Pick first corner'):
        tool==='side'?tr('点击需要边吊的一侧墙边','Pick the room edge to lower'):
        tool==='array'?tr(points.length?'点击终点完成等距布灯':'点击灯列起点',points.length?'Pick array end':'Pick array start'):
        tr('点击房间内放置','Click in room to place')+' · '+title(tool);
      $('#ceilingFinish').hidden=!freeTool();$('#ceilingFinish').disabled=points.length<3;
    }
    g.innerHTML=pieces.join('');
  }
  function field(label,key,value,type='number',extra=''){
    return `<label class="ceil-field">${label}<input type="${type}" value="${esc(String(value??''))}" data-ceil-field="${key}" ${extra}></label>`;
  }
  function pick(label,key,values,current,full=false){return `<label class="ceil-field ${full?'full':''}">${label}<select data-ceil-field="${key}">${options(values,current)}</select></label>`;}
  function elevation(data,z){
    const h=model.baseHeight(displayed(),roomId);
    const value=z?h-z.drop:h;
    const offset=z?Math.max(1,Math.min(21,z.drop/14)):1;
    return `<p class="ceiling-note">${tr('完成面净高','Clear height')} <b>${Math.round(value)} mm</b></p>
    <svg viewBox="0 0 220 38" width="100%" height="38" role="img" aria-label="${tr('顶面示意剖面','Ceiling section diagram')}"><path d="M5 3h210v4H5Z" fill="#776f62"/><path d="M40 7v${offset}h140V7" fill="${z?.color||defaultCeilingColor()}" stroke="#ad7a51"/><path d="M12 7v${offset}m-4 0h8" fill="none" stroke="#716859"/></svg>`;
  }
  const edgesList = z => z?.poly || [];
  let holeIndex=-1;
  function boundary(z){return holeIndex>=0&&z.holes?.[holeIndex]?{poly:z.holes[holeIndex]}:z;}
  function edgeFields(z){
    const poly=edgesList(boundary(z));edgeIndex=Math.min(edgeIndex,Math.max(0,poly.length-1));
    vertexIndex=Math.min(vertexIndex,poly.length-1);
    const arc=holeIndex<0?z.arcs?.find(a=>a.edge===edgeIndex):null;
    return `<section><h3>${tr('轮廓与边部','Outline and edges')}</h3><div class="ceil-fields">${pick(tr('轮廓','Boundary'),'boundary',[[-1,tr('外轮廓','Outer outline')],...(z.holes||[]).map((_,i)=>[i,tr('内圈','Opening')+' '+(i+1)])],holeIndex)}${pick(tr('边段','Edge'),'edgeIndex',poly.map((_,i)=>[i,tr('边','Edge')+' '+(i+1)]),edgeIndex)}
    ${holeIndex<0?field(tr('圆弧角度（°）','Arc sweep (°)'),'sweep',arc?.sweep||0,'number','min="-180" max="180" step="any"'):''}</div>
    <div class="ceil-buttons">${button(tr('沿此边加灯槽','Add light cove'),'edge','cove')}${button(tr('沿此边加收边','Add trim'),'edge','trim')}${button(title('hole'),'tool','hole',tool==='hole')}</div>
    <p class="ceiling-note">${tr('拖动节点或输入坐标调整轮廓。圆弧角度为 0 时按直线绘制。','Drag a vertex or edit its coordinates. A sweep of 0 gives a straight edge.')}</p>
    <div class="ceil-fields">${pick(tr('编辑节点','Edit vertex'),'vertex',poly.map((_,i)=>[i,tr('节点','Vertex')+' '+(i+1)]),vertexIndex,true)}
    ${field(tr('节点 X（mm）','Vertex X (mm)'),'vertexX',poly[vertexIndex][0],'number','step="any"')}
    ${field(tr('节点 Y（mm）','Vertex Y (mm)'),'vertexY',poly[vertexIndex][1],'number','step="any"')}</div></section>`;
  }
  function renderPanel(){
    const panel=$('#panel'), def=roomDef();
    if(!def){panel.innerHTML='<section>'+tr('当前户型没有可编辑天花的区域。','No rooms are available.')+'</section>';return;}
    const d=roomData(displayed()),rTitle=esc(roomName(def)),z=selectedObject(d);
    const heading=z?(selected.kind==='zone'?z.name:title(z.type)):tr('房间天花','Room ceiling');
    let html=`<section><h3>${esc(heading)} <small>${rTitle}</small></h3>`;
    if(isPreview()){panel.innerHTML=html+'<p class="ceiling-note">'+tr('正在预览待确认的天花方案。','Previewing the proposed ceiling design.')+'</p></section>';return;}
    if(tool==='array')html+=pick(tr('灯列类型','Array fixture'),'arrayType',lights.map(t=>[t,title(t)]),arrayType)+field(tr('灯具数量','Fixture count'),'count',count,'number','min="2" max="32" step="1"');
    if(!z){
      html+=field(tr('全屋默认原顶净高（mm）','Project default ceiling height (mm)'),'globalHeight',state()?.baseHeight||2800,'number','min="1" max="30000" step="1"');
    }else if(selected.kind==='zone'){
      html+=`<div class="ceil-fields">${field(tr('名称','Name'),'name',z.name,'text','maxlength="100"')}${field(tr('下吊量（mm）','Drop (mm)'),'drop',z.drop,'number','min="0" step="10"')}${(['perimeter','island'].includes(z.preset?.type)?field(tr('边宽 / 退距（mm）','Band width / inset (mm)'),'presetWidth',z.preset.width,'number','min="1" max="30000"'):'')}${field(tr('饰面','Finish'),'finish',z.finish||'','text','maxlength="100"')}${field(tr('颜色','Color'),'color',z.color,'color')}</div>`+elevation(d,z);
    }else{
      html+=`<div class="ceil-fields">${field(tr('宽度（mm）','Width (mm)'),'width',z.width,'number','min="1"')}${field(tr('深度（mm）','Depth (mm)'),'depth',z.depth,'number','min="1"')}${field(tr('颜色','Color'),'color',z.color||'#f7d59b','color')}</div>`;
    }
    html+='</section>';
    if(!z)html+=App.panel.ceilingRoomSection(def);
    if(z&&selected.kind==='zone')html+=edgeFields(z);
    if(z)html+=`<section class="ceil-buttons">${button(tr('返回房间','Room properties'),'back')}${button(tr('删除选中对象','Delete selected'),'delete')}</section>`;
    html+='<section><h3>'+tr('房间对象','Room objects')+'</h3><div class="ceil-list">';
    let total=0;
    for(const [kind,key] of Object.entries(groups)){
      for(const item of d[key]){
        total++;
        html+=`<button type="button" class="btn chip ${selected?.kind===kind&&selected.id===item.id?'on':''}" data-ceil-select="${kind}" data-id="${esc(item.id)}">${esc(kind==='fixture' ? App.core.nm(App.store.getF(item.id)?.name||title(item.type)) : item.name||title(item.type))}</button>`;
      }
    }
    if(!total)html+=`<p class="ceiling-note">${tr('从左侧添加吊顶造型，或从家具库拖入灯具与顶装设备。','Add a ceiling shape or drag a ceiling fixture from the furniture library.')}</p>`;
    panel.innerHTML=html+'</div></section>';
    if(!z)App.panel.bindCeilingRoom(def);
  }
  function startTool(next,trigger){
    if(!roomDef()||isPreview())return;
    if(next==='hole'&&selected?.kind!=='zone')return;
    const toggledOff=tool===next;
    const keyboard=trigger?.matches(':focus-visible'), container=trigger?.closest('#ceilingLibrary,#panel');
    clearTool();
    if(!toggledOff){if(selectedFurniture())selectRoomSurface(null,null);lastPreset=null;tool=next;App.panel.closeDrawers();}
    render();App.panel.renderPanel();
    if(keyboard && (toggledOff||!App.core.narrow()))container?.querySelector(`[data-cmd="tool"][data-value="${CSS.escape(next)}"]`)?.focus({preventScroll:true});
  }
  function newZoneFinish(){
    const {color,finish}=model.room(state(),roomId);
    return {color:color||defaultCeilingColor(),...(finish?{finish}:{})};
  }
  function preset(type,trigger){
    const def=roomDef();if(!def||isPreview())return;
    const keyboard=trigger?.matches(':focus-visible');
    if(presetActive(type)){
      clearTool();select(null,null);
    }else if(roomData().zones.length){
      pendingPreset={type,target:selected?.kind==='zone'?selected.id:roomData().zones[0].id,
        drop:Math.min(180,model.baseHeight(state(),def.id)-1)};
      render();
      const choices=$('#ceilingPresetChoices');
      choices?.scrollIntoView({block:'nearest'});
      if(keyboard)$('#ceilingPresetTarget')?.focus({preventScroll:true});
      return;
    }else applyPreset(type);
    if(keyboard&&!App.core.narrow())$('#ceilingLibrary').querySelector(`[data-cmd="preset"][data-value="${CSS.escape(type)}"]`)?.focus({preventScroll:true});
  }
  function applyPreset(type,existing,drop=180){
    const def=roomDef(), data=roomData();
    if(!def||isPreview())return;
    try{
      const appearance=existing?{color:existing.color,...(existing.finish?{finish:existing.finish}:{})}:newZoneFinish();
      const zone={...model.preset(type,def,{id:existing?.id||uid(),width:presetWidth,drop:existing?.drop??drop,
        name:title(type)}),...appearance};
      const patch={zones:existing?data.zones.map(z=>z.id===existing.id?zone:z):[...data.zones,zone]};
      if(existing){
        patch.edges=data.edges.map(edge=>{
          if(edge.zoneId!==existing.id)return edge;
          const from=edge.hole===undefined?existing:{poly:existing.holes[edge.hole]};
          const to=edge.hole===undefined?zone:{poly:zone.holes?.[edge.hole]};
          const previous=JSON.stringify(model.edgePoints(from,edge.edge));
          const index=to.poly?.findIndex((_,i)=>JSON.stringify(model.edgePoints(to,i))===previous)??-1;
          if(index===-1)throw new Error(tr('替换会改变灯槽或收边所在的边段，请先调整该附属对象。','Replacing this surface changes a cove or trim edge. Adjust that edge first.'));
          return {...edge,edge:index};
        });
      }
      if(change(patch,{kind:'zone',id:zone.id})){
        clearTool();holeIndex=-1;edgeIndex=vertexIndex=0;lastPreset={room:roomId,type,id:zone.id};
        render();App.panel.renderPanel();App.panel.closeDrawers();
      }
    }catch(e){App.core.toast(e.message);}
  }
  function confirmPreset(command){
    if(!pendingPreset)return;
    const {type,target}=pendingPreset;
    if(command==='preset-cancel'){pendingPreset=null;render();return;}
    if(command==='preset-replace'){
      const selectedZone=roomData().zones.find(z=>z.id===target);
      if(selectedZone)applyPreset(type,selectedZone);
    }else if(command==='preset-add'){
      const field=$('#ceilingPresetDrop');
      if(field.reportValidity())applyPreset(type,null,field.valueAsNumber);
    }
  }
  function addEdge(type){
    const z=selectedObject();if(!z||selected.kind!=='zone')return;
    const data=roomData(),edge={id:uid(),type,zoneId:z.id,edge:edgeIndex,width:55,depth:45,color:type==='cove'?'#f8d79a':'#ad9271'};
    if(holeIndex>=0)edge.hole=holeIndex;
    const old=data.edges.find(e=>e.zoneId===z.id&&e.edge===edgeIndex&&e.hole===edge.hole&&e.type===type);
    if(old){select('edge',old.id);return;}
    change({edges:[...data.edges,edge]},{kind:'edge',id:edge.id});
  }
  function addPolygon(poly){
    const data=roomData();
    if(tool==='hole'){
      const z=selectedObject();if(!z||selected.kind!=='zone')return false;
      const edited={...z,holes:[...(z.holes||[]),poly]};delete edited.preset;
      return replaceItem('zone',edited);
    }
    const zone={id:uid(),name:title(tool==='rectangle'?'rectangle':'polygon'),poly,drop:180,...newZoneFinish()};
    return change({zones:[...data.zones,zone]},{kind:'zone',id:zone.id});
  }
  function finishPolygon(){
    if(!freeTool()||points.length<3)return;
    if(addPolygon(points)){clearTool();holeIndex=-1;edgeIndex=0;render();App.panel.renderPanel();}
  }
  function fixturesAt(type,locations){
    const {w:length,d:width,hang=0}=App.ceilingFurniture.defaults(type),data=roomData();
    const fixtures=locations.map(([x,y])=>({id:uid(),type,x,y,length,width,hang,rotation:0}));
    return change({fixtures:[...data.fixtures,...fixtures]},{kind:'fixture',id:fixtures[0].id});
  }
  function fixturePoint(fixture,p){
    const position={...fixture,x:Math.round(p.x/10)*10,y:Math.round(p.y/10)*10};
    return App.store.ui.layers.wallSnap
      ? model.snapFixture(state(),roomDef(),position,8/App.store.view.s)
      : [position.x,position.y];
  }
  function fixtureToolPoint(type,[x,y]){
    const {w:length,d:width}=App.ceilingFurniture.defaults(type);
    return fixturePoint({type,length,width},{x,y});
  }
  function setVertex(zone,index,point){
    const edited=boundary(zone).poly.map((v,i)=>i===index?point:v);
    const next=zone.holes?.[holeIndex]?{...zone,holes:zone.holes.map((h,i)=>i===holeIndex?edited:h)}:{...zone,poly:edited};
    delete next.preset;
    vertexIndex=index;
    replaceItem('zone',next);
  }
  function tap(d){
    if(isPreview())return;
    if(!tool){
      const dest=d.room||roomAt(d.point)?.id;
      if(dest)setRoom(dest);
      if(dest)select(d.itemKind,d.id);else select(null,null);
      return;
    }
    const fixtureType=tool==='array'?arrayType:null;
    const p=fixtureType?fixtureToolPoint(fixtureType,d.origin):d.point, def=roomDef();
    if(!def)return;
    if(fixtureType&&!isInside(d.origin,def.poly)){
      App.core.toast(tr('请在当前房间内放置','Place inside the selected room'));
      return;
    }
    if(tool==='side'){
      const poly=def.vertices||def.poly, outline=model.outline(def);
      const direction=Math.sign(outline.reduce((sum,a,i)=>{const b=outline[(i+1)%outline.length];return sum+a[0]*b[1]-b[0]*a[1];},0));
      let nearest=null, distance=Infinity;
      for(let i=0;i<poly.length;i++){
        const line=model.edgePoints(def,i);
        for(let j=1;j<line.length;j++){
          const a=line[j-1],b=line[j],dx=b[0]-a[0],dy=b[1]-a[1];
          const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));
          const n=Math.hypot(a[0]+t*dx-p[0],a[1]+t*dy-p[1]);
          if(n<distance){distance=n;nearest=line;}
        }
      }
      if(!nearest || distance*App.store.view.s>26){App.core.toast(tr('请点击所选房间的边缘','Pick an edge of this room'));return;}
      const inner=nearest.map((v,i)=>{
        const prev=nearest[Math.max(0,i-1)],next=nearest[Math.min(nearest.length-1,i+1)],dx=next[0]-prev[0],dy=next[1]-prev[1],len=Math.hypot(dx,dy);
        return [v[0]-direction*dy/len*presetWidth,v[1]+direction*dx/len*presetWidth];
      });
      const zone={id:uid(),name:title('side'),poly:[...nearest,...inner.reverse()],drop:180,...newZoneFinish()};
      if(change({zones:[...roomData().zones,zone]},{kind:'zone',id:zone.id})){clearTool();holeIndex=-1;edgeIndex=0;render();App.panel.renderPanel();}
      return;
    }
    if(freeTool()){
      if(points.length>=3 && Math.hypot(p[0]-points[0][0],p[1]-points[0][1])*App.store.view.s<8){finishPolygon();return;}
      if(points.at(-1)?.every((v,i)=>v===p[i]))return;
      points.push(p);renderSketch();return;
    }
    if(tool==='rectangle'||tool==='array'){
      if(!points.length){points=[p];renderSketch();return;}
      const [a,b]=points[0], [x,y]=p;
      if(tool==='rectangle'){
        if(Math.abs(a-x)<20||Math.abs(b-y)<20)return;
        if(!addPolygon([[a,b],[x,b],[x,y],[a,y]]))return;
      }else{
        if(Math.hypot(x-a,y-b)<50)return;
        if(!fixturesAt(arrayType,Array.from({length:count},(_,i)=>[Math.round(a+(x-a)*i/(count-1)),Math.round(b+(y-b)*i/(count-1))])))return;
      }
      clearTool();render();App.panel.renderPanel();
    }
  }
  function startPointer(e,p){
    const target=e.target.closest('[data-ceil-id]'),vertex=e.target.closest('[data-ceil-vertex]');
    const zone=vertex&&selectedObject();
    const vertices=zone?boundary(zone).poly:null;
    const nearest=vertices?.reduce((best,[x,y],index)=>{
      const distance=Math.hypot(x-p.x,y-p.y);
      return distance<best.distance ? {index,distance} : best;
    },{distance:Infinity});
    return {kind:'ceiling',sx:e.clientX,sy:e.clientY,point:snap(p),x0:App.store.view.x0,y0:App.store.view.y0,
      room:target?.dataset.ceilRoom||e.target.closest('[data-room]')?.dataset.room,id:target?.dataset.ceilId,itemKind:target?.dataset.ceilKind,
      vertex:nearest?.index,moved:false,origin:[p.x,p.y],panning:false};
  }
  function movePointer(d,e,p,far){
    if(!d.moved&&!far)return;
    d.moved=true;
    if(!tool&&!isPreview()&&d.vertex!==undefined){
      const zone=selectedObject();
      if(!zone)return;
      const [x,y]=boundary(zone).poly[d.vertex];
      dragPreview={vertex:d.vertex,point:snap({x:x+p.x-d.origin[0],y:y+p.y-d.origin[1]})};
      renderSketch();return;
    }
    d.panning=true;App.core.svg.classList.add('panning');
    App.store.view.x0=d.x0-(e.clientX-d.sx)/App.store.view.s;App.store.view.y0=d.y0-(e.clientY-d.sy)/App.store.view.s;App.interact.applyView();
  }
  function endPointer(d,cancel){
    const ghost=dragPreview;dragPreview=null;
    if(!cancel&&!d.moved){
      if(d.vertex===undefined)tap(d);
      else {vertexIndex=d.vertex;App.panel.renderPanel();}
    }
    if(!cancel&&ghost&&!isPreview()){
      const obj=selectedObject();
      if(obj && selected.kind==='zone' && ghost.vertex!==undefined)setVertex(obj,ghost.vertex,ghost.point);
    }
    renderSketch();
  }
  function hover(p){if(tool && points.length){hoverPoint=tool==='array'?fixtureToolPoint(arrayType,[p.x,p.y]):snap(p);renderSketch();}}
  function key(e){
    const k=e.key.toLowerCase(), mod=e.metaKey||e.ctrlKey;
    if(k==='enter' && e.target.closest?.('button'))return false;
    if(!tool && selectedFurniture() && !isPreview())return false;
    if(mod){if(k==='d'){e.preventDefault();return true;}return false;}
    if(k==='escape'){if(tool){clearTool();render();App.panel.renderPanel();}else select(null,null);}
    else if(k==='enter'&&freeTool())finishPolygon();
    else if(k==='backspace'&&freeTool()){points.pop();renderSketch();}
    else if(k==='backspace'||k==='delete')removeSelection();
    else if(k==='v'){clearTool();render();App.panel.renderPanel();}
    else if(!['m','d','x','r'].includes(k)&&!k.startsWith('arrow'))return false;
    e.preventDefault();return true;
  }
  function handleClick(e){
    const target=e.target.closest('[data-cmd],[data-ceil-select]');if(!target||!active())return;
    const cmd=target.dataset.cmd,value=target.dataset.value;
    if(target.dataset.ceilSelect){clearTool();holeIndex=-1;select(target.dataset.ceilSelect,target.dataset.id);return;}
    if(cmd==='scan'){App.importer.openCeilingImport(roomId||null);return;}
    if(cmd==='preview'){
      if(roomDef()){
        App.panel.closeDrawers();
        App.io.studioEnterRoom(roomId,{ceiling:true});
      }
      return;
    }
    if(isPreview())return;
    if(cmd==='furniture'){clearTool();render();App.panel.renderPanel();App.interact.openCeilingLibrary();return;}
    if(cmd==='showcase'){if(roomDef())App.ceilingShowcase.open(roomId);return;}
    if(cmd==='preset')preset(value,target);
    else if(cmd.startsWith('preset-'))confirmPreset(cmd);
    else if(cmd==='tool')startTool(value,target);
    else if(cmd==='edge')addEdge(value);
    else if(cmd==='back'){clearTool();select(null,null);}
    else if(cmd==='delete')removeSelection();
  }
  function handleField(e){
    if(!active()||isPreview())return;
    const el=e.target,key=el.dataset.ceilField;if(!key)return;
    const value=el.type==='number'?el.valueAsNumber:el.value;
    if(el.type==='number' && (!el.checkValidity()||!Number.isFinite(value))){el.reportValidity();renderPanel();return;}
    if(key==='globalHeight'){
      try{
        model.validate({...displayed(),baseHeight:value},App.store.ROOMS);
        App.store.mutate(()=>{App.store.state.ceiling.baseHeight=value;});
      }catch(error){App.core.toast(error.message);renderPanel();}
      return;
    }
    if(key==='arrayType'){arrayType=value;return;}
    if(key==='count'){count=Math.max(2,Math.min(32,Math.round(value)));return;}
    if(key==='boundary'){holeIndex=Number(value);edgeIndex=vertexIndex=0;renderSketch();renderPanel();return;}
    if(key==='edgeIndex'){edgeIndex=Number(value);renderSketch();renderPanel();return;}
    if(key==='vertex'){
      vertexIndex=Number(value);renderSketch();renderPanel();
      $('#panel [data-ceil-field="vertex"]')?.focus({preventScroll:true});
      return;
    }
    const obj=selectedObject();if(!obj)return;
    if(key==='vertexX'||key==='vertexY'){
      const point=[...boundary(obj).poly[vertexIndex]];
      point[key==='vertexX'?0:1]=value;
      setVertex(obj,vertexIndex,point);
      return;
    }
    const updated={...obj};
    if(key==='presetWidth'){
      try{
        const next=model.preset(obj.preset.type,roomDef(),{id:obj.id,name:obj.name,width:value,drop:obj.drop,color:obj.color});
        if(obj.finish)next.finish=obj.finish;
        replaceItem('zone',next);
      }catch(error){App.core.toast(error.message);renderPanel();}
      return;
    }
    if(key==='sweep'){
      delete updated.preset;
      const arcs=(obj.arcs||[]).filter(a=>a.edge!==edgeIndex);
      if(value)arcs.push({edge:edgeIndex,sweep:value});
      updated.arcs=arcs;
    }else if(key==='finish'&&!value)delete updated[key];
    else updated[key]=value;
    replaceItem(selected.kind,updated);
  }
  $('#ceilingLibrary').addEventListener('click',handleClick);$('#panel').addEventListener('click',handleClick);
  $('#panel').addEventListener('change',handleField);
  $('#ceilingLibrary').addEventListener('change',e=>{if(e.target.id==='ceilingPresetWidth'){
      const v=e.target.valueAsNumber;if(Number.isFinite(v)&&v>=10&&v<=10000)presetWidth=v;else e.target.value=presetWidth;
    }else if(e.target.id==='ceilingRoom'){setRoom(e.target.value);select(null,null);}
    else if(pendingPreset&&e.target.id==='ceilingPresetTarget')pendingPreset.target=e.target.value;
    else if(pendingPreset&&e.target.id==='ceilingPresetDrop'&&e.target.checkValidity())pendingPreset.drop=e.target.valueAsNumber;
  });
  $('#ceilingMode').onclick=()=>{
    if(active()){close();return;}
    open();App.assistant.chatPane?.('props');
    if(App.core.narrow())App.panel.drawer('lib',true);
  };
  function setOverlay(on){overlay=Boolean(on);render();}
  $('#ceilingOverlay').onclick=()=>setOverlay(!overlay);
  $('#ceilingFinish').onclick=finishPolygon;
  $('#ceilingCancel').onclick=()=>{clearTool();render();App.panel.renderPanel();};
  App.ceilingEditor={active,context,open,focus:open,close,syncView,render,renderPanel,renderSketch,startPointer,movePointer,endPointer,hover,key,overlayVisible:()=>overlay,setOverlay,toolThumbnail,fixtureSymbol,symbolScale,selectFurniture};
})();
