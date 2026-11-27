/* Temporary samples rendered by the same ceiling model as the current project. */
(() => {
  'use strict';
  const App = globalThis.App;
  const { $, tr } = App.core;
  const model = App.ceilingModel;
  const bar = $('#ceilingShowcase');
  const shapeInput = $('#ceilingShowcaseShape');
  const fixtureInput = $('#ceilingShowcaseFixtures');
  let session = null;

  const point = ([x, y, w, h], u, v) => [x + u*w, y + v*h];
  const rectangle = (frame, left=0, top=0, right=1, bottom=1) => [
    point(frame,left,top), point(frame,right,top), point(frame,right,bottom), point(frame,left,bottom),
  ];
  const sampleZone = (poly, drop) => ({id:'showcase-zone', poly, drop});

  function fits(room, poly) {
    try {
      model.apply(model.normalize(), room, {zones:[sampleZone(poly, 0)]});
      return true;
    } catch {
      return false;
    }
  }

  function sampleFrame(room) {
    const [x0,y0,x1,y1] = App.geom.bbox(room.poly), width = x1-x0, depth = y1-y0;
    const centers = [[(x0+x1)/2,(y0+y1)/2], ...(room.at ? [room.at] : [])];
    for (const u of [.25,.5,.75]) {
      for (const v of [.25,.5,.75]) centers.push([x0+u*width,y0+v*depth]);
    }
    for (const scale of [.84,.68,.5,.34,.22,.12]) {
      const w = width*scale, h = depth*scale;
      for (const [cx,cy] of centers) {
        const frame = [cx-w/2,cy-h/2,w,h];
        if (fits(room,rectangle(frame))) return frame;
      }
    }
    throw new Error(tr('这个房间没有足够的连续区域展示样板', 'This room has too little continuous space for a sample'));
  }

  function singleSide(room, frame, width, drop) {
    const vertices = room.vertices || room.poly;
    const sign = Math.sign(vertices.reduce((sum,[x,y],i) => {
      const [nextX,nextY] = vertices[(i+1)%vertices.length];
      return sum + x*nextY-y*nextX;
    },0));
    const edges = vertices.map((a,i) => ({a,b:vertices[(i+1)%vertices.length],i}))
      .filter(({i}) => !room.arcs?.some(arc => arc.edge===i))
      .map(edge => ({...edge,len:Math.hypot(edge.b[0]-edge.a[0],edge.b[1]-edge.a[1])}))
      .filter(({len}) => len>width).sort((a,b) => b.len-a.len);
    for (const {a,b,len} of edges) {
      const nx = (a[1]-b[1])*sign*width/len, ny = (b[0]-a[0])*sign*width/len;
      const poly = [a,b,[b[0]+nx,b[1]+ny],[a[0]+nx,a[1]+ny]];
      if (fits(room,poly)) return sampleZone(poly,drop);
    }
    return sampleZone(rectangle(frame,0,0,1,.23),drop);
  }

  function sampleZones(room, frame, type, height) {
    if (type==='original') return [];
    const smallSide = Math.min(frame[2], frame[3]);
    const width = Math.max(2, Math.min(520, smallSide*.18));
    const drop = Math.max(0,Math.min(height-1, height*(type==='island' ? .1 : .076), 260));
    const options = {id:'showcase-zone',width,drop,color:model.defaultColor};
    if (type==='flat') return [model.preset('flat',room,options)];
    if (type==='perimeter') {
      try {
        const zone = model.preset('perimeter',room,options);
        model.apply(model.normalize(),room,{zones:[{...zone,drop:0}]});
        return [zone];
      } catch {
        return [model.preset('perimeter',{poly:rectangle(frame)},options)];
      }
    }
    if (type==='island') return [model.preset('island',{poly:rectangle(frame)},options)];
    if (type==='side') return [singleSide(room,frame,width,drop)];
    if (type==='rectangle') return [sampleZone(rectangle(frame,.07,.23,.76,.76),drop)];
    const corners = [[.12,.14],[.68,.14],[.92,.41],[.74,.81],[.39,.81],[.39,.56],[.12,.56]];
    return [{...sampleZone(corners.map(([u,v])=>point(frame,u,v)),drop),arcs:[{edge:2,sweep:42}]}];
  }

  function sampleFixtures(frame, type, height) {
    const size = Math.min(frame[2],frame[3]);
    const dim = (max, ratio) => Math.max(1, Math.min(max,size*ratio));
    const make = (type, index, u, v, props) => {
      const [x,y] = point(frame,u,v);
      return {id:'showcase-fixture-'+index, type, x, y, ...props};
    };
    if (type==='none') return [];
    const equipment = [
      make('vent',0,.31,.27,{length:dim(1100,.38),width:dim(150,.13)}),
      make('access',1,.7,.56,{length:dim(440,.19),width:dim(440,.19)}),
      make('curtain',2,.54,.81,{length:dim(1800,.56),width:dim(180,.15)}),
      make('ceilingac',3,.25,.56,{length:dim(840,.18),width:dim(840,.18)}),
      make('ductac',4,.75,.22,{length:dim(1200,.22),width:dim(500,.12)}),
    ];
    if (type==='equipment') return equipment;
    if (type==='array') return [.18,.39,.61,.82].map((u,i) =>
      make('downlight',i,u,.4,{width:dim(105,.1),kelvin:3300,intensity:85}));
    const lights = [
      make('downlight',0,.17,.22,{width:dim(105,.1),kelvin:3700,intensity:80}),
      make('spot',1,.82,.27,{width:dim(95,.1),tilt:28,rotation:135,kelvin:3500,intensity:75}),
      make('pendant',2,.48,.55,{width:dim(440,.22),hang:Math.max(0,Math.min(460,height*.16,height-1)),kelvin:2800}),
      make('linear',3,.25,.73,{length:dim(1000,.34),width:dim(55,.08),kelvin:4000}),
      make('track',4,.75,.72,{length:dim(1150,.35),width:dim(54,.08),rotation:90,kelvin:3100}),
    ];
    if (type==='lights') return lights;
    const fixture = [...lights,...equipment].find(f => f.type===type);
    if (!fixture) return [];
    const [x,y] = point(frame,.5,.5);
    return [{...fixture,x,y}];
  }

  function showSample() {
    if (!session) return false;
    const {room, frame} = session;
    const ceiling = App.ceilingFurniture.current(), height = model.baseHeight(ceiling,room.id);
    try {
      const zones = sampleZones(room,frame,shapeInput.value,height);
      const fixtures = sampleFixtures(frame,fixtureInput.value,height);
      session.preview = model.apply(ceiling,room,{zones,edges:[],fixtures});
      App.store.ui.ceilingPreview = session.preview;
      App.draw2d.renderAll();
      return true;
    } catch (error) {
      App.core.toast(error.message);
      return false;
    }
  }

  function close(redraw=true) {
    if (!session) return;
    if (App.store.ui.ceilingPreview===session.preview) App.store.ui.ceilingPreview=null;
    session=null;
    bar.hidden=true;
    if (redraw) App.draw2d.renderAll();
  }

  async function open(roomId) {
    if (session || App.store.ui.ceilingPreview) return;
    const room = App.store.ROOMS.find(r => r.id===roomId && !r.outdoor && !r.bay);
    if (!room) return App.core.toast(tr('先选一个室内房间', 'Select an interior room first'));
    try {
      session = {room, frame:sampleFrame(room), preview:null};
      shapeInput.value='perimeter';
      fixtureInput.value='lights';
      if (!showSample()) return close();
      App.panel.closeDrawers();
      await App.io.studioEnterRoom(roomId,{ceiling:true});
      if (App.io.is3D() && session) bar.hidden=false;
      else close();
    } catch (error) {
      close();
      App.core.toast(error.message);
    }
  }

  function sync() {
    if (session && App.store.ui.ceilingPreview!==session.preview) close(false);
  }

  shapeInput.onchange = fixtureInput.onchange = showSample;
  $('#ceilingShowcaseClose').onclick = () => close();
  function roomChanged(id) {
    if (!session || session.room.id===id) return false;
    close(false);
    return true;
  }

  App.ceilingShowcase = {open, close, sync, roomChanged};
})();
