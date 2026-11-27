/* Room-based ceiling editing shares the plan's viewBox, project history and selection tools. */
(() => {
  'use strict';
  const App = globalThis.App;
  const { $, tr, esc } = App.core;
  const model = App.ceilingModel;
  const state = () => App.store.state.ceiling;
  const displayed = () => App.store.ui.ceilingPreview || state();
  const isPreview = () => Boolean(App.store.ui.ceilingPreview);
  const rect = (x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  const path = points => points?.length ? 'M'+points.map(p=>p.join(' ')).join('L') : '';
  const closed = points => path(points)+'Z';
  const names = {
    side:['单侧边吊','Single-edge drop'], flat:['整面平吊','Flat ceiling'], perimeter:['回形边吊','Perimeter drop'], island:['悬浮顶','Floating island'],
    rectangle:['矩形吊顶','Rectangular zone'], polygon:['自由轮廓','Custom outline'], hole:['绘制镂空','Draw opening'],
    downlight:['筒灯','Downlight'], spot:['射灯','Spotlight'], pendant:['吊灯','Pendant'],
    linear:['线性灯','Linear light'], track:['磁吸轨道','Lighting track'],
    vent:['条形风口','Air grille'], access:['检修口','Access hatch'], curtain:['窗帘盒','Curtain pocket'], cove:['灯槽','Light cove'], trim:['收边','Trim'],
  };
  const title = k => names[k] ? tr(...names[k]) : k;
  const lights = ['downlight','spot','pendant','linear','track'], equipment = ['vent','access','curtain'];
  const dimDefaults = {downlight:[90,90,0],spot:[100,100,40],pendant:[400,400,600],linear:[1200,45,0],track:[1500,55,0],vent:[1000,120,0],access:[450,450,0],curtain:[1600,180,0]};
  const groups = {zone:'zones',edge:'edges',fixture:'fixtures'};
  let presetWidth=400, arrayType='downlight', projectId='';
  let enabled=false, overlay=false, roomId='', selected=null, tool=null, points=[], hoverPoint=null, dragPreview=null, edgeIndex=0, count=4;
  const active = () => enabled && !App.io.is3D?.();
  const rooms = () => App.store.ROOMS.filter(r => !r.bay);
  const firstRoom = () => rooms().find(r=>!r.outdoor) || rooms()[0];
  const roomDef = () => rooms().find(r=>r.id===roomId);
  const roomData = (ceiling=state()) => model.room(ceiling,roomId);
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
    if(holeIndex>=0 && !selectedObject()?.holes?.[holeIndex])holeIndex=-1;
  }
  function clearTool(){ tool=null; points=[]; hoverPoint=null; dragPreview=null; }
  function setRoom(id){
    if(!rooms().some(r=>r.id===id))return;
    if(roomId!==id){roomId=id; selected=null; clearTool(); edgeIndex=0;holeIndex=-1;}
  }
  function enter(id,kind,itemId){
    const was=active(); enabled=true;
    const selectedRoom=App.store.ui.sel?.kind==='room'?App.store.ui.sel.id:'';
    setRoom(id||selectedRoom||roomId||firstRoom()?.id);
    if(kind && groups[kind]){selected={kind,id:itemId};edgeIndex=0;holeIndex=-1;}
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
    if(!active())clearTool();
    App.draw2d.renderAll();
  }
  function context(){return active()?{roomId,kind:selected?.kind||'room',id:selected?.id||roomId,tool:tool||'select'}:null;}
  function select(kind,id){selected=kind&&id?{kind,id}:null;edgeIndex=0;holeIndex=-1;render();App.panel.renderPanel();}
  function change(patch,nextSelection=selected){
    if(isPreview()||!roomDef())return false;
    try{
      const next=model.apply(state(),roomDef(),patch);
      selected=nextSelection;
      App.store.mutate(()=>{App.store.state.ceiling=next;});
      return true;
    }catch(error){
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
  function fixtureSymbol(f){
    const [dl,dw]=dimDefaults[f.type]||dimDefaults.downlight,l=f.length||dl,w=f.width||dw;
    switch(f.type){
      case 'curtain':return rect(-l/2,-w/2,l,w)+`<path d="M${-l/2} 0h${l}" stroke-dasharray="4 2"/>`;
      case 'vent':return rect(-l/2,-w/2,l,w)+`<path d="M${-l*.44} 0h${l*.88}"/>`;
      case 'access':return rect(-l/2,-w/2,l,w)+`<path d="M${-l/2} ${w/2}L${l/2} ${-w/2}" stroke-dasharray="4 3"/>`;
      case 'track':return rect(-l/2,-w/2,l,w)+[-.32,0,.32].map(t=>`<path d="M${l*t} 0l${w} ${w}"/>`).join('');
      case 'linear':return rect(-l/2,-w/2,l,w);
      case 'pendant':return `<ellipse rx="${l/2}" ry="${w/2}"/><ellipse rx="${l*.28}" ry="${w*.28}"/>`;
      case 'spot':return `<circle r="${w/2}"/><path d="M0 0l${l*.72} ${l*.48}"/>`;
      default:return `<circle r="${w/2}"/><path d="M${-w/4} 0h${w*.5}m${-w/4} ${-w/4}v${w*.5}"/>`;
    }
  }
  function attrs(kind,item,id){
    const selectedHere=active()&&id===roomId&&selected?.id===item.id&&selected.kind===kind;
    return `data-ceil-id="${esc(item.id)}" data-ceil-kind="${kind}" data-ceil-room="${esc(id)}" ${selectedHere?'class="ceil-selected"':''}`;
  }
  function drawRoom(r,ceiling){
    const data=model.room(ceiling,r.id);
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
    const fixtures=data.fixtures.map(f=>{
      const color=equipment.includes(f.type)?'#286d71':'#996e24';
      return `<g ${attrs('fixture',f,r.id)} transform="translate(${f.x} ${f.y}) rotate(${f.rotation||0})" stroke="${color}" fill="#fffdf4"><title>${esc(title(f.type))}</title>${fixtureSymbol(f)}<circle r="${Math.max(60,5/App.store.view.s)}" fill="transparent" stroke="none"/></g>`;
    });
    return [...zones,...edges,...fixtures].join('');
  }
  function button(label,cmd,value='',on=false){return `<button type="button" class="btn ${on?'on':''}" data-cmd="${cmd}" data-value="${esc(value)}"${cmd==='tool'?' aria-pressed="'+on+'"':''}>${label}</button>`;}
  const actionButtons=(vs,cmd)=>vs.map(v=>button(title(v),cmd,v,tool===v)).join('');
  function options(list,value){return list.map(([key,label])=>`<option value="${esc(String(key))}" ${String(key)===String(value)?'selected':''}>${esc(label)}</option>`).join('');}
  function library(){
    const lib=$('#ceilingLibrary'), available=rooms(), def=roomDef();
    lib.innerHTML=`<h3>${tr('天花板设计','Ceiling design')}</h3><label class="ceil-field">${tr('设计房间','Room')}<select id="ceilingRoom">${options(available.map(r=>[r.id,roomName(r)]),roomId)}</select></label>
    <h4>${tr('吊顶造型','Ceiling shapes')}</h4><label class="ceil-field">${tr('边宽 / 悬浮顶退距（mm）','Band width / island inset (mm)')}<input id="ceilingPresetWidth" type="number" min="10" max="10000" step="10" value="${presetWidth}"></label><div class="ceiling-tools">${actionButtons(['flat','perimeter','island'],'preset')}${actionButtons(['side','rectangle','polygon'],'tool')}</div>
    <h4>${tr('灯具','Lights')}</h4><div class="ceiling-tools">${actionButtons(lights,'tool')}</div>
    <h4>${tr('顶部设备','Ceiling equipment')}</h4><div class="ceiling-tools">${actionButtons(equipment,'tool')}</div>
    <h4>${tr('等距布灯','Light array')}</h4><div class="ceiling-tools">${button(tr('两点等距布置','Place between two points'),'tool','array',tool==='array')}</div>
    <div class="ceil-buttons">${button(tr('AI 识别天花','Recognize ceiling'),'scan')}${button(tr('室内 3D 预览','Preview in 3D'),'preview')}</div>`;
    if(!def||isPreview())lib.querySelectorAll('[data-cmd]').forEach(b=>{if (b.dataset.cmd!=='preview' && !(!def&&b.dataset.cmd==='scan'))b.disabled=true;});
  }
  function render(){
    const project=App.projects.activeProjectId;
    if(projectId && project && project!==projectId){roomId='';selected=null;edgeIndex=0;holeIndex=-1;clearTool();}
    if(project)projectId=project;
    const edit=active(); if(edit)reconcile();
    document.body.classList.toggle('ceiling-edit',edit);
    const libName=edit?tr('天花工具','Ceiling tools'):tr('家具库','Library');
    $('#tgLib').textContent='◧ '+libName;
    if(App.io.TIPS)$('#tip').textContent=edit?tr('选择房间 · 点击天花对象编辑 · 滚轮缩放 · 拖动空白处平移','Select a room · click ceiling objects to edit · scroll to zoom · drag to pan'):App.io.TIPS()[App.io.is3D()?'3d':'2d'];
    $('#ceilingMode').classList.toggle('on',edit);$('#ceilingMode').setAttribute('aria-pressed',String(edit));
    const overlayBtn=$('#ceilingOverlay'); overlayBtn.hidden=edit;overlayBtn.classList.toggle('on',overlay);overlayBtn.setAttribute('aria-pressed',String(overlay));
    const shown=edit||overlay||isPreview();
    $('#gCeiling').innerHTML=shown?rooms().filter(r=>displayed()?.rooms?.[r.id]).map(r=>drawRoom(r,displayed())).join(''):'';
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
    const g=$('#ceilingSketch'), task=$('#ceilingTask'),edit=active();
    task.hidden=!edit||!tool||isPreview();document.body.classList.toggle('ceiling-draw',edit&&!!tool);
    if(!edit||!roomDef()){g.innerHTML='';return;}
    const r=roomDef(), k=1/App.store.view.s, pieces=[];
    if(!tool && !selected)pieces.push(App.draw2d.roomShape(r,'fill="none" stroke="#c18250" stroke-width="1.2" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"'));
    if(!isPreview()&&selected?.kind==='zone'&&!tool){
      const z=selectedObject();if(z){
        const onHole=holeIndex>=0 && z.holes?.[holeIndex];
        const contour=onHole?{poly:z.holes[holeIndex]}:z;
        const vertices=contour.poly.map((v,i)=>dragPreview?.vertex===i?dragPreview.point:v);
        pieces.push(`<path d="${closed(model.outline({...contour,poly:vertices}))}" class="ceiling-outline"/>`);
        if(!dragPreview)pieces.push(`<path d="${path(model.edgePoints(contour,edgeIndex))}" fill="none" stroke="#cf8643" stroke-width="3" vector-effect="non-scaling-stroke"/>`);
        vertices.forEach(([x,y],i)=>pieces.push(`<circle data-ceil-vertex="${i}" cx="${x}" cy="${y}" r="${4*k}" fill="#fff" stroke="#b5653a" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`));
      }
    }
    if(dragPreview && dragPreview.vertex===undefined)pieces.push(`<circle cx="${dragPreview.point[0]}" cy="${dragPreview.point[1]}" r="${7*k}" class="ceiling-outline"/>`);
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
    <svg viewBox="0 0 220 38" width="100%" height="38" role="img" aria-label="${tr('顶面示意剖面','Ceiling section diagram')}"><path d="M5 3h210v4H5Z" fill="#776f62"/><path d="M40 7v${offset}h140V7" fill="${z?.color||'#f6f0e8'}" stroke="#ad7a51"/><path d="M12 7v${offset}m-4 0h8" fill="none" stroke="#716859"/></svg>`;
  }
  const edgesList = z => z?.poly || [];
  let holeIndex=-1;
  function boundary(z){return holeIndex>=0&&z.holes?.[holeIndex]?{poly:z.holes[holeIndex]}:z;}
  function edgeFields(z){
    const poly=edgesList(boundary(z));edgeIndex=Math.min(edgeIndex,Math.max(0,poly.length-1));
    const arc=holeIndex<0?z.arcs?.find(a=>a.edge===edgeIndex):null;
    return `<section><h3>${tr('轮廓与边部','Outline and edges')}</h3><div class="ceil-fields">${pick(tr('轮廓','Boundary'),'boundary',[[-1,tr('外轮廓','Outer outline')],...(z.holes||[]).map((_,i)=>[i,tr('内圈','Opening')+' '+(i+1)])],holeIndex)}${pick(tr('边段','Edge'),'edgeIndex',poly.map((_,i)=>[i,tr('边','Edge')+' '+(i+1)]),edgeIndex)}
    ${holeIndex<0?field(tr('圆弧角度（°）','Arc sweep (°)'),'sweep',arc?.sweep||0,'number','min="-180" max="180" step="any"'):''}</div>
    <div class="ceil-buttons">${button(tr('沿此边加灯槽','Add light cove'),'edge','cove')}${button(tr('沿此边加收边','Add trim'),'edge','trim')}${button(title('hole'),'tool','hole')}</div>
    <p class="ceiling-note">${tr('拖动外轮廓节点调整边界。圆弧角度为 0 时按直线绘制。','Drag outer vertices to reshape. Set the sweep to 0 for a straight edge.')}</p></section>`;
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
      html+=field(tr('全屋原顶净高（mm）','Project base height (mm)'),'globalHeight',state()?.baseHeight||2800,'number','min="1" max="30000" step="1"')+field(tr('房间原顶净高（mm）','Room base height (mm)'),'roomHeight',model.baseHeight(state(),roomId),'number','min="100" step="10"')+elevation(d);
      if(d.baseHeight!==undefined)html+=button(tr('沿用全屋原顶高度','Use project base height'),'inherit');
    }else if(selected.kind==='zone'){
      html+=`<div class="ceil-fields">${field(tr('名称','Name'),'name',z.name,'text','maxlength="100"')}${field(tr('下吊量（mm）','Drop (mm)'),'drop',z.drop,'number','min="0" step="10"')}${(['perimeter','island'].includes(z.preset?.type)?field(tr('边宽 / 退距（mm）','Band width / inset (mm)'),'presetWidth',z.preset.width,'number','min="1" max="30000"'):'')}${field(tr('饰面','Finish'),'finish',z.finish||'','text','maxlength="100"')}${field(tr('颜色','Color'),'color',z.color,'color')}</div>`+elevation(d,z);
    }else if(selected.kind==='fixture'){
      const defs=dimDefaults[z.type]||dimDefaults.downlight;
      html+=`<div class="ceil-fields">${field('X (mm)','x',Math.round(z.x))}${field('Y (mm)','y',Math.round(z.y))}
      ${field(tr('长度（mm）','Length (mm)'),'length',z.length??defs[0],'number','min="1"')}${field(tr('宽度（mm）','Width (mm)'),'width',z.width??defs[1],'number','min="1"')}
      ${field(tr('旋转（°）','Rotation (°)'),'rotation',z.rotation||0)}${field(tr('吊长（mm）','Hang (mm)'),'hang',z.hang||0,'number','min="0"')}
      ${pick(tr('安装面','Mounting surface'),'zoneId',[['',tr('随所在顶面','Auto by position')],...d.zones.map(zone=>[zone.id,zone.name])],z.zoneId||'',true)}
      ${lights.includes(z.type)?field(tr('色温（K）','Color temperature (K)'),'kelvin',z.kelvin??3000,'number','min="1800" max="10000"')+field(tr('亮度（%）','Intensity (%)'),'intensity',z.intensity??100,'number','min="0" max="100"')+(z.type==='spot'?field(tr('倾角（°）','Tilt (°)'),'tilt',z.tilt??0,'number','min="-85" max="85"'):''):''}</div>
      <p class="ceiling-note">${tr('安装面标高','Mount elevation')} ${Math.round(model.fixtureHeight(state(),def,z))} mm</p>`;
    }else{
      html+=`<div class="ceil-fields">${field(tr('宽度（mm）','Width (mm)'),'width',z.width,'number','min="1"')}${field(tr('深度（mm）','Depth (mm)'),'depth',z.depth,'number','min="1"')}${field(tr('颜色','Color'),'color',z.color||'#f7d59b','color')}</div>`;
    }
    html+='</section>';
    if(z&&selected.kind==='zone')html+=edgeFields(z);
    if(z)html+=`<section class="ceil-buttons">${button(tr('返回房间','Room properties'),'back')}${button(tr('删除选中对象','Delete selected'),'delete')}</section>`;
    html+='<section><h3>'+tr('房间对象','Room objects')+'</h3><div class="ceil-list">';
    let total=0;
    for(const [kind,key] of Object.entries(groups)){
      for(const item of d[key]){
        total++;
        html+=`<button type="button" class="btn chip ${selected?.kind===kind&&selected.id===item.id?'on':''}" data-ceil-select="${kind}" data-id="${esc(item.id)}">${esc(item.name||title(item.type))}</button>`;
      }
    }
    if(!total)html+=`<p class="ceiling-note">${tr('从左侧选择造型，或选择灯具后在图上放置。','Pick a shape from the library, or choose a fixture and place it on the plan.')}</p>`;
    panel.innerHTML=html+'</div></section>';
  }
  function startTool(next){
    if(!roomDef()||isPreview())return;
    if(next==='hole'&&selected?.kind!=='zone')return;
    clearTool();tool=next;App.panel.closeDrawers();render();App.panel.renderPanel();
  }
  function preset(type){
    const def=roomDef();if(!def||isPreview())return;
    try{
      const zone=model.preset(type,def,{id:uid(),width:presetWidth,drop:180,color:'#f4e6d6'});
      zone.name=title(type);
      clearTool();holeIndex=-1;edgeIndex=0;
      if(change({zones:[...roomData().zones,zone]},{kind:'zone',id:zone.id}))App.panel.closeDrawers();
    }catch(e){App.core.toast(e.message);}
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
    const zone={id:uid(),name:title(tool==='rectangle'?'rectangle':'polygon'),poly,drop:180,color:'#f4e6d6'};
    return change({zones:[...data.zones,zone]},{kind:'zone',id:zone.id});
  }
  function finishPolygon(){
    if(!freeTool()||points.length<3)return;
    if(addPolygon(points)){clearTool();holeIndex=-1;edgeIndex=0;render();App.panel.renderPanel();}
  }
  function fixturesAt(type,locations){
    const [length,width,hang]=dimDefaults[type],data=roomData();
    const fixtures=locations.map(([x,y])=>({id:uid(),type,x,y,length,width,hang,rotation:0}));
    return change({fixtures:[...data.fixtures,...fixtures]},{kind:'fixture',id:fixtures[0].id});
  }
  function tap(d){
    if(isPreview())return;
    if(!tool){
      const dest=d.room||roomAt(d.point)?.id;
      if(dest)setRoom(dest);
      if(dest)select(d.itemKind,d.id);else select(null,null);
      return;
    }
    const p=d.point, def=roomDef();
    if(!def)return;
    if(!isInside(p,def.poly)&&!App.ceilingModel.outline(def).some(v=>Math.hypot(v[0]-p[0],v[1]-p[1])<1)){
      // Boundary points are validated against the complete polygon by the model on commit.
      if(!freeTool()&&tool!=='rectangle'&&tool!=='array'&&tool!=='side')return App.core.toast(tr('请在当前房间内放置','Place inside the selected room'));
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
      const zone={id:uid(),name:title('side'),poly:[...nearest,...inner.reverse()],drop:180,color:'#f4e6d6'};
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
      clearTool();render();App.panel.renderPanel();return;
    }
    fixturesAt(tool,[p]);
  }
  function startPointer(e,p){
    const target=e.target.closest('[data-ceil-id]'),vertex=e.target.closest('[data-ceil-vertex]');
    return {kind:'ceiling',sx:e.clientX,sy:e.clientY,point:snap(p),x0:App.store.view.x0,y0:App.store.view.y0,
      room:target?.dataset.ceilRoom||e.target.closest('[data-room]')?.dataset.room,id:target?.dataset.ceilId,itemKind:target?.dataset.ceilKind,
      vertex:vertex?Number(vertex.dataset.ceilVertex):undefined,moved:false,origin:[p.x,p.y],panning:false};
  }
  function movePointer(d,e,p,far){
    if(!d.moved&&!far)return;
    d.moved=true;
    if(!tool&&!isPreview()&&(d.vertex!==undefined||d.itemKind==='fixture')){
      if(d.vertex===undefined && (selected?.id!==d.id||roomId!==d.room)){setRoom(d.room);select('fixture',d.id);}
      const f=d.vertex===undefined?selectedObject():null;
      const dest=f?{x:f.x+p.x-d.origin[0],y:f.y+p.y-d.origin[1]}:p;
      dragPreview={vertex:d.vertex,point:snap(dest)};renderSketch();return;
    }
    d.panning=true;App.core.svg.classList.add('panning');
    App.store.view.x0=d.x0-(e.clientX-d.sx)/App.store.view.s;App.store.view.y0=d.y0-(e.clientY-d.sy)/App.store.view.s;App.interact.applyView();
  }
  function endPointer(d,cancel){
    const ghost=dragPreview;dragPreview=null;
    if(!cancel&&!d.moved&&d.vertex===undefined)tap(d);
    if(!cancel&&ghost&&!isPreview()){
      const obj=selectedObject();
      if(obj && selected.kind==='fixture' && d.id===obj.id)replaceItem('fixture',{...obj,x:ghost.point[0],y:ghost.point[1]});
      else if(obj && selected.kind==='zone' && ghost.vertex!==undefined){
        const edited=boundary(obj).poly.map((v,i)=>i===ghost.vertex?ghost.point:v);
        const next=obj.holes?.[holeIndex]?{...obj,holes:obj.holes.map((h,i)=>i===holeIndex?edited:h)}:{...obj,poly:edited};
        delete next.preset;replaceItem('zone',next);
      }
    }
    renderSketch();
  }
  function hover(p){if(tool && points.length){hoverPoint=snap(p);renderSketch();}}
  function key(e){
    const k=e.key.toLowerCase(), mod=e.metaKey||e.ctrlKey;
    if(mod){if(k==='d'){e.preventDefault();return true;}return false;}
    if(!tool&&!isPreview()&&selected?.kind==='fixture'&&(k.startsWith('arrow')||k==='r')){
      const f=selectedObject(),step=e.shiftKey?100:10,dirs={arrowleft:[-step,0],arrowright:[step,0],arrowup:[0,-step],arrowdown:[0,step]};
      if(f && dirs[k])replaceItem('fixture',{...f,x:f.x+dirs[k][0],y:f.y+dirs[k][1]});
      if(f && k==='r')replaceItem('fixture',{...f,rotation:((f.rotation||0)+(e.shiftKey?-90:90)+360)%360});
      e.preventDefault();return true;
    }
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
    if(cmd==='preview'){if(roomDef())App.io.studioEnterRoom(roomId,{ceiling:true});return;}
    if(isPreview())return;
    if(cmd==='preset')preset(value);
    else if(cmd==='tool')startTool(value);
    else if(cmd==='edge')addEdge(value);
    else if(cmd==='back'){clearTool();select(null,null);}
    else if(cmd==='delete')removeSelection();
    else if(cmd==='inherit')change({baseHeight:null});
  }
  function handleField(e){
    if(!active()||isPreview())return;
    const el=e.target,key=el.dataset.ceilField;if(!key)return;
    const value=el.type==='number'?el.valueAsNumber:el.value;
    if(el.type==='number' && (!el.checkValidity()||!Number.isFinite(value))){el.reportValidity();renderPanel();return;}
    if(key==='globalHeight'){
      try{
        const next=model.validate({...state(),baseHeight:value},App.store.ROOMS);
        App.store.mutate(()=>{App.store.state.ceiling=next;});
      }catch(error){App.core.toast(error.message);renderPanel();}
      return;
    }
    if(key==='arrayType'){arrayType=value;return;}
    if(key==='roomHeight'){change({baseHeight:value});return;}
    if(key==='count'){count=Math.max(2,Math.min(32,Math.round(value)));return;}
    if(key==='boundary'){holeIndex=Number(value);edgeIndex=0;renderSketch();renderPanel();return;}
    if(key==='edgeIndex'){edgeIndex=Number(value);renderSketch();renderPanel();return;}
    const obj=selectedObject();if(!obj)return;
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
    }else if((key==='zoneId'||key==='finish')&&!value)delete updated[key];
    else updated[key]=value;
    replaceItem(selected.kind,updated);
  }
  $('#ceilingLibrary').addEventListener('click',handleClick);$('#panel').addEventListener('click',handleClick);
  $('#panel').addEventListener('change',handleField);
  $('#ceilingLibrary').addEventListener('change',e=>{if(e.target.id==='ceilingPresetWidth'){
      const v=e.target.valueAsNumber;if(Number.isFinite(v)&&v>=10&&v<=10000)presetWidth=v;else e.target.value=presetWidth;
    }else if(e.target.id==='ceilingRoom'){setRoom(e.target.value);render();App.panel.renderPanel();}});
  $('#ceilingMode').onclick=()=>{
    if(active()){close();return;}
    open();App.assistant.chatPane?.('props');
    if(App.core.narrow())App.panel.drawer('lib',true);
  };
  function setOverlay(on){overlay=Boolean(on);render();}
  $('#ceilingOverlay').onclick=()=>setOverlay(!overlay);
  $('#ceilingFinish').onclick=finishPolygon;
  $('#ceilingCancel').onclick=()=>{clearTool();render();App.panel.renderPanel();};
  document.querySelector('[data-view="2d"]').addEventListener('click',()=>{if(active())close();});
  App.ceilingEditor={active,context,open,focus:open,close,syncView,render,renderPanel,renderSketch,startPointer,movePointer,endPointer,hover,key,overlayVisible:()=>overlay,setOverlay};
})();
