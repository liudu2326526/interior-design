// Shared by the browser and the Node import/assistant validators. Plan units are millimetres.
(() => {
  'use strict';
  const DEFAULT_HEIGHT = 2800, DEFAULT_COLOR = '#ffffff';
  const fixtureTypes = ['downlight','spot','pendant','linear','track','vent','access','curtain','ceilingac','ductac'];
  const own = (obj, key) => Object.hasOwn(obj, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const error = message => { throw new Error(message); };
  function fields(value,allowed){
    for (const field of Object.keys(value)) if (!allowed.includes(field)) error('不支持的天花字段 '+field);
  }
  const num = (v, min, max, label) => Number.isFinite(v) && v >= min && v <= max ? v : error(label + '超出有效范围');
  const string = (v, label) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120 ? v.trim() : error(label + '无效');
  const key = value => {
    const id = string(value, '标识');
    if (['__proto__','constructor','prototype'].includes(id)) error('无效标识');
    return id;
  };
  const color = (v, fallback) => v === undefined ? fallback : /^#[0-9a-f]{6}$/i.test(v) ? v : error('颜色应为六位十六进制色值');
  const list = (v, max, label) => v === undefined ? [] : Array.isArray(v) && v.length <= max ? v : error(label + '格式或数量无效');
  const equal = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]) < 1e-5;
  const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
  function signedArea(poly){
    return poly.reduce((area,a,i) => {
      const b = poly[(i+1)%poly.length];
      return area + a[0]*b[1]-a[1]*b[0];
    },0)/2;
  }
  function pointLineDistance(p, a, b){
    const dx = b[0]-a[0], dy = b[1]-a[1];
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy)/(dx*dx + dy*dy || 1)));
    return Math.hypot(p[0]-(a[0]+t*dx),p[1]-(a[1]+t*dy));
  }
  function pointIn(poly, p, includeBoundary=true){
    let inside = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++){
      const a = poly[i], b = poly[j];
      if (pointLineDistance(p,a,b) < 1e-4) return includeBoundary;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside = !inside;
    }
    return inside;
  }
  function intersects(a,b,c,d,allowTouch=false){
    if (Math.max(a[0],b[0])+1e-5<Math.min(c[0],d[0]) || Math.max(c[0],d[0])+1e-5<Math.min(a[0],b[0]) ||
        Math.max(a[1],b[1])+1e-5<Math.min(c[1],d[1]) || Math.max(c[1],d[1])+1e-5<Math.min(a[1],b[1])) return false;
    const opposite = (v,w) => (v > 1e-5 && w < -1e-5) || (w > 1e-5 && v < -1e-5);
    if (opposite(cross(a,b,c),cross(a,b,d)) && opposite(cross(c,d,a),cross(c,d,b))) return true;
    return !allowTouch && (pointLineDistance(a,c,d)<1e-5 || pointLineDistance(b,c,d)<1e-5 ||
      pointLineDistance(c,a,b)<1e-5 || pointLineDistance(d,a,b)<1e-5);
  }
  function simple(poly){
    if (poly.length < 3 || poly.length > 4096 || Math.abs(signedArea(poly)) < 1) return false;
    for (let i=0;i<poly.length;i++){
      const next = (i+1)%poly.length;
      if (equal(poly[i],poly[next])) return false;
      for (let j=i+2;j<poly.length;j++){
        if ((j+1)%poly.length === i) continue;
        if (intersects(poly[i],poly[next],poly[j],poly[(j+1)%poly.length])) return false;
      }
    }
    return true;
  }
  function boundaryCross(a,b,touchAllowed){
    return a.some((p,i) => b.some((q,j) => intersects(p,a[(i+1)%a.length],q,b[(j+1)%b.length],touchAllowed)));
  }
  function contained(child,parent,touchAllowed=true){
    if (child.length===parent.length && child.every((p,i)=>equal(p,parent[i]))) return touchAllowed;
    return child.every((p,i) => {
      const q = child[(i+1)%child.length];
      return pointIn(parent,p,touchAllowed) && pointIn(parent,[(p[0]+q[0])/2,(p[1]+q[1])/2],touchAllowed);
    }) && !boundaryCross(child,parent,touchAllowed);
  }
  function ring(raw){
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > 1024) error('顶面轮廓点数量无效');
    const poly = raw.map(p => {
      if (!Array.isArray(p) || p.length !== 2) error('顶面轮廓点无效');
      return p.map(v=>num(v,-1e8,1e8,'轮廓坐标'));
    });
    if (equal(poly[0],poly.at(-1))) poly.pop();
    if (poly.length < 3) error('顶面至少需要三个点');
    return poly;
  }
  function edgePoints(surface,i){
    const poly = surface.vertices || surface.poly;
    if (!poly || !Number.isInteger(i) || i<0 || i>=poly.length) return [];
    const a = poly[i], b = poly[(i+1)%poly.length], degrees = surface.arcs?.find(arc=>arc.edge===i)?.sweep;
    if (!degrees) return [a,b];
    const sweep = degrees*Math.PI/180, half=sweep/2, dx=b[0]-a[0], dy=b[1]-a[1];
    const k = Math.abs(degrees)===180 ? 0 : .5/Math.tan(half);
    const cx=(a[0]+b[0])/2-dy*k, cy=(a[1]+b[1])/2+dx*k;
    const radius=Math.hypot(a[0]-cx,a[1]-cy), start=Math.atan2(a[1]-cy,a[0]-cx);
    const n=Math.min(128,Math.max(2,Math.ceil(Math.abs(sweep)/(2*Math.acos(1-Math.min(1,.5/radius))))));
    const pts = [a];
    for (let j=1;j<n;j++) pts.push([cx+radius*Math.cos(start+sweep*j/n),cy+radius*Math.sin(start+sweep*j/n)]);
    pts.push(b);
    return pts;
  }
  function outline(surface){
    const poly=surface.vertices || surface.poly;
    if (!surface.arcs?.length) return poly;
    return poly.flatMap((p,i)=>edgePoints(surface,i).slice(0,-1));
  }
  function normalizeZone(raw,roomOutline,height){
    if (!record(raw)) error('顶面分区无效');
    fields(raw,['id','name','poly','arcs','holes','drop','color','finish','preset']);
    const poly = ring(raw.poly);
    const zone = {id:key(raw.id),name:string(raw.name ?? '吊顶区域','区域名称'),poly,
      drop:num(raw.drop ?? 0,0,height-1,'下吊量'),color:color(raw.color,DEFAULT_COLOR)};
    if(raw.preset!==undefined){
      if (!record(raw.preset) || !['perimeter','island'].includes(raw.preset.type)) error('顶面预设类型无效');
      fields(raw.preset,['type','width']);
      zone.preset={type:raw.preset.type,width:num(raw.preset.width,1,30000,'预设边宽')};
    }
    if (raw.finish!==undefined) zone.finish=string(raw.finish,'顶面饰面');
    const arcEdges=new Set();
    const arcs=list(raw.arcs,poly.length,'圆弧').map(arc=>{
      if (!record(arc) || !Number.isInteger(arc.edge) || arc.edge<0 || arc.edge>=poly.length ||
        arcEdges.has(arc.edge) || !Number.isFinite(arc.sweep) || Math.abs(arc.sweep)<.5 || Math.abs(arc.sweep)>180) error('顶面圆弧边无效');
      fields(arc,['edge','sweep']);
      arcEdges.add(arc.edge); return {edge:arc.edge,sweep:arc.sweep};
    });
    if (arcs.length) zone.arcs=arcs;
    const outer=outline(zone);
    if (!simple(outer)) error('顶面轮廓自交或面积过小');
    if (roomOutline && !contained(outer,roomOutline)) error('顶面区域超出房间轮廓');
    const holes=[];
    for(const rawHole of list(raw.holes,32,'顶面孔洞')){
      const h=ring(rawHole);
      if (!simple(h) || !contained(h,outer,false) || holes.some(p=>boundaryCross(p,h,false)||pointIn(p,h[0])||pointIn(h,p[0]))) error('顶面孔洞相交或超出区域');
      holes.push(h);
    }
    if (holes.length) zone.holes=holes;
    return zone;
  }
  const emptyRoom = () => ({zones:[],edges:[],fixtures:[]});
  const room = (scene,id) => typeof id==='string' && scene?.rooms && own(scene.rooms,id) ? scene.rooms[id] : emptyRoom();
  const baseHeight = (scene,id) => room(scene,id).baseHeight ?? scene?.baseHeight ?? DEFAULT_HEIGHT;
  function shapes(scene,def){
    const height=baseHeight(scene,def.id);
    return room(scene,def.id).zones.map(z=>({...z,poly:outline(z),holes:z.holes||[],height:height-z.drop}));
  }
  const covers = (s,p)=>pointIn(s.poly,p) && !s.holes.some(h=>pointIn(h,p,false));
  function mountHeight(surfaces,base,fixture){
    if (fixture.zoneId) {
      const surface=surfaces.find(s=>s.id===fixture.zoneId);
      if (surface) return surface.height;
    }
    return surfaces.reduce((h,s)=>covers(s,[fixture.x,fixture.y]) ? Math.min(h,s.height) : h,base);
  }
  const fixtureHeight=(scene,def,f)=>mountHeight(shapes(scene,def),baseHeight(scene,def.id),f);
  function readRoom(raw,def,globalHeight,strict){
    if (!record(raw)) error('房间天花设计无效');
    if (strict) fields(raw,['baseHeight','finish','color','zones','edges','fixtures']);
    const out=emptyRoom();
    if (raw.baseHeight!=null) out.baseHeight=num(raw.baseHeight,1,30000,'房间原顶高度');
    if (raw.finish!=null) out.finish=string(raw.finish,'原顶饰面');
    if (raw.color!=null) out.color=color(raw.color);
    const height=out.baseHeight ?? globalHeight, bound=def && outline(def);
    const unique=(items,fn)=>{
      const ids=new Set(), values=[];
      for (const rawItem of items){
        try {
          const item=fn(rawItem);
          if (ids.has(item.id)) error('天花对象标识重复');
          ids.add(item.id); values.push(item);
        } catch(e){if(strict) throw e;}
      }
      return values;
    };
    out.zones=unique(list(raw.zones,128,'顶面分区'),z=>normalizeZone(z,bound,height));
    const idToZone=new Map(out.zones.map(z=>[z.id,z]));
    out.edges=unique(list(raw.edges,512,'收边'),e=>{
      if (!record(e) || !['cove','trim'].includes(e.type)) error('收边类型无效');
      fields(e,['id','type','edge','hole','width','depth','color','zoneId']);
      const edge={id:key(e.id),type:e.type,edge:e.edge,width:num(e.width??40,1,3000,'收边宽度'),
        depth:num(e.depth??20,1,height-1,'收边深度'),color:color(e.color,e.type==='cove'?'#ffdfad':'#cbbda9')};
      const zone=e.zoneId==null ? def : idToZone.get(e.zoneId);
      if (e.zoneId!=null){ if(!zone) error('收边所属区域不存在'); edge.zoneId=e.zoneId; }
      if(e.hole!=null){
        if(!edge.zoneId || !Number.isInteger(e.hole) || !zone?.holes?.[e.hole]) error('收边孔洞不存在');
        edge.hole=e.hole;
      }
      const vertexCount=e.hole!=null ? zone.holes[e.hole].length : zone && (zone.vertices || zone.poly).length;
      if (!Number.isInteger(e.edge) || e.edge<0 || (vertexCount!==undefined && e.edge>=vertexCount)) error('收边边号无效');
      if (edge.depth >= height-(zone?.drop||0)) error('收边深度超过安装标高');
      if (def?.outdoor && !edge.zoneId) error('露台收边需要选择已绘制的顶面');
      return edge;
    });
    const surfaces=out.zones.map(z=>({...z,poly:outline(z),holes:z.holes||[],height:height-z.drop}));
    out.fixtures=unique(list(raw.fixtures,512,'灯具设备'),f=>{
      if (!record(f)||!fixtureTypes.includes(f.type)) error('顶面灯具或设备类型无效');
      fields(f,['id','type','x','y','zoneId','rotation','length','width','hang','color','kelvin','intensity','tilt']);
      const obj={id:key(f.id),type:f.type,x:num(f.x,-1e8,1e8,'灯位横坐标'),y:num(f.y,-1e8,1e8,'灯位纵坐标')};
      const p=[obj.x,obj.y];
      if (bound && !pointIn(bound,p)) error('灯具或设备超出房间');
      if (f.zoneId!=null){
        const z=surfaces.find(s=>s.id===f.zoneId);
        if (!z || !covers(z,p)) error('灯位未落在所属顶面');
        if (surfaces.some(s=>s.height<z.height && covers(s,p))) error('灯位被更低的吊顶覆盖，请选择下方完成面');
        obj.zoneId=f.zoneId;
      }
      if (def?.outdoor && !surfaces.some(s=>covers(s,p))) error('露台灯具需要安装在已绘制的顶面上');
      if (f.kelvin!==undefined) obj.kelvin=num(f.kelvin,1800,10000,'灯具色温');
      if (f.intensity!==undefined) obj.intensity=num(f.intensity,0,100,'灯具亮度');
      if (f.tilt!==undefined) obj.tilt=num(f.tilt,-85,85,'灯具倾角');
      if (f.rotation!==undefined) obj.rotation=num(f.rotation,-360,360,'灯具旋转角');
      if (f.length!==undefined) obj.length=num(f.length,1,30000,'设备长度');
      if (f.width!==undefined) obj.width=num(f.width,1,30000,'设备宽度');
      if (f.hang!==undefined) obj.hang=num(f.hang,0,mountHeight(surfaces,height,obj)-1,'灯具悬挂长度');
      if (f.color!==undefined) obj.color=color(f.color);
      return obj;
    });
    return out;
  }
  function parse(raw,roomDefs,strict){
    const scene={version:1,baseHeight:DEFAULT_HEIGHT,rooms:{}};
    if (raw==null) return scene;
    if (!record(raw) || (raw.version!==undefined && raw.version!==1)) { if(strict) error('天花版本或数据无效'); return scene; }
    if (strict) fields(raw,['version','baseHeight','rooms']);
    if (raw.baseHeight!==undefined){
      try { scene.baseHeight=num(raw.baseHeight,1,30000,'全屋原顶高度'); } catch(e){if(strict) throw e;}
    }
    if (raw.rooms===undefined) return scene;
    if(!record(raw.rooms)){ if(strict) error('天花房间表无效'); return scene;}
    const defs=Array.isArray(roomDefs) ? new Map(roomDefs.map(r=>[r.id,r])) : null;
    for (const [id,value] of Object.entries(raw.rooms)){
      try{
        key(id);
        if (defs&&!defs.has(id)) error('天花引用了不存在的房间 '+id);
        scene.rooms[id]=readRoom(value,defs?.get(id),scene.baseHeight,strict);
      }catch(e){if(strict) throw e;}
    }
    return scene;
  }
  const normalize=(raw,roomDefs)=>parse(raw,roomDefs,false);
  const validate=(raw,roomDefs)=>parse(raw,roomDefs,true);
  function apply(ceiling,def,change){
    key(def.id);
    const source=ceiling ?? normalize(), merged={...room(source,def.id),...change};
    const result=readRoom(merged,def,source.baseHeight,true);
    return {...source,rooms:{...source.rooms,[def.id]:result}};
  }
  function inset(poly,dist){
    num(dist,1,30000,'边吊宽度');
    const sign=Math.sign(signedArea(poly));
    const normals=poly.map((a,i)=>{
      const b=poly[(i+1)%poly.length], dx=b[0]-a[0], dy=b[1]-a[1], len=Math.hypot(dx,dy);
      return [-dy/len*sign,dx/len*sign];
    });
    const inner=poly.map((p,i)=>{
      const prev=normals[(i+poly.length-1)%poly.length], next=normals[i];
      const scale=dist/(1+prev[0]*next[0]+prev[1]*next[1]);
      return [p[0]+scale*(prev[0]+next[0]),p[1]+scale*(prev[1]+next[1])];
    });
    const clearance = inner.every(p=>poly.every((a,i)=>pointLineDistance(p,a,poly[(i+1)%poly.length])>=dist-.6));
    if (!simple(inner) || Math.sign(signedArea(inner))!==sign || !contained(inner,poly,false) || !clearance) error('边宽在此轮廓内产生交叉，请减小边宽或手绘分区');
    return inner;
  }
  function roundedIsland(poly){
    if (poly.length!==4) return {poly};
    const rounded=[],arcs=[];
    for (let i=0;i<4;i++){
      const p=poly[i], a=poly[(i+3)%4], b=poly[(i+1)%4];
      const la=Math.hypot(a[0]-p[0],a[1]-p[1]), lb=Math.hypot(b[0]-p[0],b[1]-p[1]);
      const u=[(a[0]-p[0])/la,(a[1]-p[1])/la], v=[(b[0]-p[0])/lb,(b[1]-p[1])/lb];
      if (Math.abs(u[0]*v[0]+u[1]*v[1])>.001) return {poly};
      const r=Math.min(300,la*.16,lb*.16);
      arcs.push({edge:rounded.length,sweep:Math.sign(signedArea(poly))*90});
      rounded.push([p[0]+u[0]*r,p[1]+u[1]*r],[p[0]+v[0]*r,p[1]+v[1]*r]);
    }
    return {poly:rounded,arcs};
  }
  function preset(type,def,opts={}){
    if (!['flat','perimeter','island'].includes(type)) error('未知的天花造型');
    const names={flat:'满吊',perimeter:'四周边吊',island:'中央造型'};
    const zone={id:opts.id ?? ('z-'+(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))),name:opts.name ?? names[type],
      poly:(def.vertices || def.poly).map(p=>[...p]),drop:opts.drop??150,color:opts.color??DEFAULT_COLOR};
    if (def.arcs?.length) zone.arcs=def.arcs.map(a=>({...a}));
    if (type!=='flat'){
      const width=opts.width??350, inner=inset(outline(def),width);
      zone.preset={type,width};
      if (type==='perimeter') zone.holes=[inner];
      else {delete zone.arcs; Object.assign(zone,roundedIsland(inner));}
    }
    return zone;
  }
  const api={normalize,validate,apply,room,baseHeight,outline,edgePoints,shapes,fixtureHeight,preset,pointIn,fixtureTypes,defaultColor:DEFAULT_COLOR};
  globalThis.CeilingModel=api;
  if (globalThis.App) globalThis.App.ceilingModel=api;
})();
