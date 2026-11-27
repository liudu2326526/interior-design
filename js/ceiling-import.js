// Recognize a drawing or reference photo into a reviewable patch on the current ceiling.
(() => {
  'use strict';
  const App = globalThis.App;
  const {tr} = App.core;
  const model = App.ceilingModel;
  const ns = 'http://www.w3.org/2000/svg';
  const types = {downlight:['筒灯','Downlight'], spot:['射灯','Spotlight'], pendant:['吊灯','Pendant'],
    linear:['线性灯','Linear light'], track:['轨道灯','Track light'], vent:['风口','Vent'], access:['检修口','Access panel'], curtain:['窗帘盒','Curtain pocket'],
    ceilingac:['嵌入式四面出风空调','Cassette air conditioner'], ductac:['风管机','Ducted air conditioner'],
    cove:['灯槽','Light cove'], trim:['收边','Trim']};
  const fields = {x:['横坐标','X'], y:['纵坐标','Y'], drop:['下吊','Drop'], width:['宽','Width'], depth:['深','Depth'],
    length:['长','Length'], rotation:['旋转','Rotation'], hang:['吊长','Hang'], kelvin:['色温','Color temperature'], tilt:['倾角','Tilt'], intensity:['亮度','Intensity'], baseHeight:['原顶净高','Base height']};
  const svgNode = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const copy = data => App.core.deepCopy(data);
  function collectDraft(base, items, plan){
    const draft = copy(base), changedRooms = new Set();
    for (const row of items.filter(item => item.checked)){
      if (!Object.hasOwn(draft.rooms,row.roomId)) draft.rooms[row.roomId]={zones:[],edges:[],fixtures:[]};
      const room = draft.rooms[row.roomId];
      changedRooms.add(row.roomId);
      if (row.group === 'baseHeight'){ room.baseHeight = row.value; continue; }
      const group = room[row.group], index = group.findIndex(item => item.id === row.id);
      if (row.action === 'remove'){
        if (index !== -1) group.splice(index,1);
      } else if (index === -1) group.push(row.value);
      else group[index] = row.value;
    }
    const checked = model.validate(draft, plan.rooms);
    return {ceiling:checked, changes:[...changedRooms].map(id => ({
      action:Object.hasOwn(base.rooms, id) ? 'replace' : 'add', path:['state','ceiling','rooms',id], value:checked.rooms[id],
    }))};
  }

  function mapPreview(container, plan, ceiling, items, roomId){
    const focused = plan.rooms.find(room => room.id === roomId);
    let viewBox;
    if (focused){
      const pts = model.outline(focused);
      const [x0,y0,x1,y1] = App.geom.bbox(pts), pad = Math.max(140, Math.max(x1-x0,y1-y0)*.05);
      viewBox = [x0-pad,y0-pad,x1-x0+2*pad,y1-y0+2*pad].join(' ');
    }
    container.innerHTML = App.importer.impReviewMap(plan, [], [], viewBox);
    const svg = container.firstElementChild;
    const selected = new Set(items.filter(i=>i.checked).map(i=>JSON.stringify([i.roomId,i.group,i.id])));
    const isPicked = (room,group,id) => selected.has(JSON.stringify([room.id,group,id]));
    const path = pts => 'M' + pts.map(p=>p.join(' ')).join('L') + 'Z';
    for(const room of focused ? [focused] : plan.rooms){
      const design = ceiling.rooms[room.id];
      if (!design) continue;
      for (const z of model.shapes(ceiling,room)){
        const ink = isPicked(room,'zones',z.id) ? '#a95829' : '#908a7f';
        svg.append(svgNode('path', {d:[z.poly,...z.holes].map(path).join(' '),'fill-rule':'evenodd',fill:ink,
          'fill-opacity':'.19',stroke:ink,'stroke-width':1.5,'vector-effect':'non-scaling-stroke'}));
      }
      for(const e of design.edges){
        const zone = e.zoneId ? design.zones.find(z=>z.id===e.zoneId) : room;
        const surface = e.hole === undefined ? zone : (zone?.holes?.[e.hole] ? {poly:zone.holes[e.hole]} : null);
        if (!surface) continue;
        svg.append(svgNode('polyline', {points:model.edgePoints(surface,e.edge).map(p=>p.join(',')).join(' '), fill:'none',
          stroke:isPicked(room,'edges',e.id) ? '#c2841d' : '#9a978b','stroke-width':3,'vector-effect':'non-scaling-stroke'}));
      }
      for(const f of design.fixtures){
        const ink = isPicked(room,'fixtures',f.id) ? '#276b80' : '#9a978b';
        const group = svgNode('g',{transform:'translate('+f.x+' '+f.y+') rotate('+(f.rotation||0)+')'});
        if (['linear','track','vent','access','curtain'].includes(f.type)){
          const w=f.length||300, h=f.width||80;
          group.append(svgNode('rect',{x:-w/2,y:-h/2,width:w,height:h,fill:ink}));
        } else group.append(svgNode('circle',{r:Math.max(55,(f.width||100)/2),fill:ink}));
        svg.append(group);
      }
    }
  }

  function openCeilingImport(roomId){
    if (document.getElementById('ceilingImport')) return;
    if (App.core.PUBLIC_ACCESS === 'guest' || !/^https?:$/.test(location.protocol)){
      App.core.toast(tr('连接本机服务或登录公网 AI 后即可识别天花。','Connect to the local service or sign in to use AI recognition.')); return;
    }
    const studio = App.io.studio, plan = studio.getPlan(), base = model.normalize(App.ceilingFurniture.current(), plan.rooms);
    const sceneKey = App.projects.activeSceneKey;
    let items = [], controller = null, preview = null, urls = [], before = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'walk-dialog'; dialog.id = 'ceilingImport'; dialog.setAttribute('aria-labelledby','ceilingImportTitle');
    dialog.innerHTML = `<div class="walk-dialog-head"><h2 id="ceilingImportTitle">${tr('识别天花','Recognize ceiling')}</h2><button class="btn" data-close>${tr('关闭','Close')}</button></div>
      <div class="walk-dialog-body" style="display:grid;gap:10px">
        <section data-setup style="display:grid;gap:10px">
          <div class="imp-review-seg" data-modes><button type="button" data-mode="drawing" aria-pressed="true">${tr('天花图纸','Ceiling drawing')}</button><button type="button" data-mode="photo" aria-pressed="false">${tr('参考照片','Reference photo')}</button></div>
          <label>${tr('应用范围','Apply to')} <select data-room></select></label>
          <label class="imp-drop"><span data-file-label></span><br><input data-files type="file" multiple></label>
          <label>${tr('对齐或设计说明（可选）','Alignment or design notes (optional)')}<textarea class="imp-note" data-note maxlength="2000"></textarea></label>
        </section>
        <section data-review hidden><details data-original hidden><summary>${tr('查看上传的原图','View uploaded images')}</summary><div data-photos></div></details><div class="imp-review"><div data-alignment></div><div class="imp-review-seg" data-variants><button type="button" data-before aria-pressed="false">${tr('当前天花','Current ceiling')}</button><button type="button" data-after aria-pressed="true">${tr('应用所选后','With selected changes')}</button></div><div data-map></div><div data-warnings class="imp-exp"></div></div>
          <div data-rows class="imp-files" style="margin-top:8px"></div></section>
        <div data-status class="imp-st" role="status"></div><div data-error class="imp-err" role="alert"></div>
        <div class="imp-foot"><button class="btn" data-back hidden>${tr('重新识别','Recognize again')}</button><span class="spacer"></span><button class="btn primary" data-start>${tr('识别并预览','Recognize and preview')}</button><button class="btn primary" data-apply hidden>${tr('应用所选天花','Apply selected changes')}</button></div>
      </div>`;
    document.body.append(dialog);
    const at = key => dialog.querySelector('[data-'+key+']');
    const close = () => dialog.close();
    const show = (el, visible) => { el.hidden = !visible; if (el === at('setup')) el.style.display = visible ? 'grid' : 'none'; };
    const error = message => { at('error').textContent = message; at('error').classList.toggle('on',Boolean(message)); };
    const roomName = id => App.store.roomState(id)?.name || plan.rooms.find(r=>r.id===id)?.name || id;
    for(const room of plan.rooms) at('room').add(new Option(roomName(room.id), room.id));
    const all = new Option(tr('整套户型','Entire floor plan'),'');
    at('room').add(all,0); at('room').value = plan.rooms.some(r=>r.id===roomId) ? roomId : '';
    let mode = 'drawing';
    function syncMode(value){
      if (mode !== value) at('files').value = '';
      mode = value;
      at('modes').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===mode));
      all.disabled = mode === 'photo';
      if (all.disabled && !at('room').value) at('room').value=plan.rooms[0].id;
      at('files').accept = mode === 'photo' ? '.jpg,.jpeg,.png,.webp' : '.jpg,.jpeg,.png,.webp,.pdf,.dwg,.dxf';
      at('file-label').textContent = mode==='photo' ? tr('参考照片 · PNG、JPG、WebP','Reference photos · PNG, JPG, WebP') :
        tr('天花图纸 · 图片、PDF 首页、DWG 或 DXF','Ceiling drawing · image, first page of a PDF, DWG or DXF');
      at('note').placeholder = mode==='photo' ? tr('如：照片中有窗的一侧是客厅南墙','For example, the window faces south') :
        tr('如：图上 A 轴对应客厅西墙','For example, grid A follows the west wall');
      at('status').textContent = mode==='photo' ? tr('照片用于估算造型和灯位，应用前可核对尺寸。','Photo-based positions and sizes are estimates. Review the dimensions before applying.') : '';
    }
    syncMode(mode);
    at('modes').onclick = e=>{ const b=e.target.closest('[data-mode]'); if(b) syncMode(b.dataset.mode); };
    at('close').onclick = close;
    dialog.addEventListener('close',()=>{ controller?.abort(); urls.forEach(url=>URL.revokeObjectURL(url)); dialog.remove(); },{once:true});
    const assertCurrent = () => {
      const now = App.ceilingFurniture.current();
      if (App.projects.activeSceneKey !== sceneKey || JSON.stringify(plan)!==JSON.stringify(studio.getPlan()) ||
          JSON.stringify(base)!==JSON.stringify(model.normalize(now, plan.rooms))){
        throw new Error(tr('方案、底图或天花已改变。请关闭后重新识别。','The design, floor plan or ceiling changed. Reopen recognition to use the current version.'));
      }
    };
    const refresh = () => {
      preview = null; error('');
      try {
        assertCurrent();
        const result = collectDraft(base, items, plan);
        mapPreview(at('map'), plan, before ? base : result.ceiling, before ? [] : items, at('room').value);
        preview = result;
      } catch(e){ error(e.message); }
      at('apply').disabled = !preview?.changes.length;
    };
    at('variants').onclick = e=>{
      if (!e.target.matches('button')) return;
      before=e.target===at('before');
      at('before').setAttribute('aria-pressed',String(before)); at('after').setAttribute('aria-pressed',String(!before)); refresh();
    };
    function review(result){
      items = result.items.map(row=>({...row,checked:!['remove','detach'].includes(row.action)}));
      show(at('setup'),false); show(at('review'),true); show(at('back'),true); show(at('start'),false); show(at('apply'),true);
      at('status').textContent = items.length ? tr('勾选要应用的对象。尺寸单位为 mm。','Select the objects to apply. Dimensions are in mm.') :
        result.aligned ? tr('未见需要加入或更新的天花对象。','No ceiling objects to add or update.') : tr('无法与当前户型对齐。','Could not align the drawing to this floor plan.');
      urls.forEach(url=>URL.revokeObjectURL(url)); urls=[]; at('photos').replaceChildren();
      for (const file of at('files').files) {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
        const img=document.createElement('img'), url=URL.createObjectURL(file); urls.push(url);
        img.src=url; img.alt=file.name; img.style.cssText='max-width:100%;max-height:240px;object-fit:contain'; at('photos').append(img);
      }
      show(at('original'),Boolean(urls.length));
      at('alignment').textContent = result.alignment;
      at('warnings').textContent = (result.estimated ? [tr('照片推算，请核对位置、朝向和高度。','Photo estimate. Verify position, orientation and height.'),...result.warnings] : result.warnings).join('\n');
      at('rows').replaceChildren();
      const toggles = new Map();
      for(const row of items){
        const previous = row.group==='baseHeight' ? base.rooms[row.roomId]?.baseHeight : base.rooms[row.roomId]?.[row.group].find(i=>i.id===row.id);
        const title = row.group==='baseHeight' ? tr(...fields.baseHeight) : row.value.name || (types[row.value.type] ? tr(...types[row.value.type]) : row.id);
        const section = document.createElement('div'); section.className='imp-review';
        const head = document.createElement('label'), check = document.createElement('input'); check.type='checkbox'; check.checked=row.checked;
        toggles.set(row,check);
        const change = row.action==='remove' ? tr('删除','Remove') : row.action==='detach' ? tr('调整挂载面','Reattach')
          : previous===undefined ? tr('新增','New') : tr('更新','Update');
        head.append(check, ' ' + roomName(row.roomId) + ' · ' + title + ' · ' + change);
        check.onchange=()=>{
          row.checked=check.checked;
          if (row.action === 'remove' && row.group === 'zones') {
            for (const related of items.filter(item=>item.roomId===row.roomId && item.parentZone===row.id)) {
              related.checked=row.checked; toggles.get(related).checked=row.checked;
            }
          }
          refresh();
        };
        section.append(head);
        if (row.reason){ const reason=document.createElement('div'); reason.className='imp-sub'; reason.textContent=row.reason; section.append(reason); }
        if (row.action === 'remove' || row.action === 'detach'){ at('rows').append(section); continue; }
        const values=document.createElement('div'); values.style.cssText='display:flex;flex-wrap:wrap;gap:8px';
        const keys = row.group==='baseHeight' ? ['baseHeight'] : Object.keys(fields).filter(k=>Number.isFinite(row.value[k]));
        for(const key of keys){
          const label=document.createElement('label'), input=document.createElement('input');
          const old=key==='baseHeight' ? previous : previous?.[key];
          label.style.cssText='display:grid;gap:2px;font-size:12px';
          label.textContent=tr(...fields[key]) + ({rotation:' °',tilt:' °',kelvin:' K',intensity:' %'}[key] || ' mm') + (old===undefined ? '' : ' ('+tr('原','was')+' '+old+')');
          input.type='number'; input.step='any'; input.style.width='80px'; input.value=key==='baseHeight'?row.value:row.value[key];
          input.oninput=()=>{ if(key==='baseHeight') row.value=input.valueAsNumber; else row.value[key]=input.valueAsNumber; refresh(); };
          label.append(input); values.append(label);
        }
        section.append(values); at('rows').append(section);
      }
      refresh();
    }
    at('back').onclick = ()=>{
      items=[]; preview=null; show(at('setup'),true); show(at('review'),false); show(at('back'),false); show(at('start'),true); show(at('apply'),false);
      syncMode(mode); error('');
    };
    at('apply').onclick = ()=>{
      try {
        assertCurrent();
        const {changes}=collectDraft(base,items,plan);
        if (!changes.length) return;
        const result=studio.applyOps([{op:'editScene',changes}]);
        if (!result.applied || result.skipped) throw new Error(result.errors?.[0] || tr('应用未完成。','Apply failed.'));
        close(); App.core.toast(tr('已应用天花变更，可撤销。','Selected ceiling changes applied. You can undo this edit.'));
      } catch(e){ error(e.message); }
    };
    at('start').onclick = async ()=>{
      if(controller) return;
      const files=[...at('files').files];
      if (!files.length) return error(tr('请先选择图纸或照片。','Choose a drawing or photo first.'));
      if (files.length>6 || files.some(f=>!f.size || f.size>8*1024*1024) || files.reduce((n,f)=>n+f.size,0)>20*1024*1024){
        return error(tr('最多 6 个文件，单个不超过 8 MB，总计不超过 20 MB。','Choose up to 6 files, at most 8 MB each and 20 MB total.'));
      }
      const run = new AbortController(); controller=run;
      error(''); at('start').disabled=true;
      at('setup').inert=true; at('status').textContent=tr('正在识别天花并对齐当前户型…','Recognizing the ceiling and aligning it to the floor plan…');
      try {
        assertCurrent();
        const attachments=[];
        for(const f of files) attachments.push({name:f.name,data:await App.importer.impFileB64(f)});
        const chunks=App.assistant.aiTextChunks('ceiling-import',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({mode,roomId:at('room').value||null,plan,ceiling:base,files:attachments,note:at('note').value.trim()}),signal:run.signal});
        let text=''; for await(const chunk of chunks) text+=chunk;
        const result=JSON.parse(text); assertCurrent(); review(result);
      } catch(e){ if(!run.signal.aborted){ at('status').textContent=''; error(e.message || tr('识别失败。','Recognition failed.')); } }
      finally{ controller=null; at('start').disabled=false; at('setup').inert=false; }
    };
    dialog.showModal();
  }

  App.importer.openCeilingImport=openCeilingImport;
})();
