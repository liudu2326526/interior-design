/* 几何计算、材质图案和家具图例。
 * 依赖 App.store、App.plan、App.core。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  let matPat = {};                     // 材料 key → SVG pattern id（buildDefs 生成）
  function clearMaterialPatterns(){ matPat = {}; }
  function normRect(r){
    if (Array.isArray(r)) r = r.slice(0, 4);
    else if (r && typeof r === 'object') r = [r.x0, r.y0, r.x1, r.y1];
    else return null;
    const v = r.map(Number);
    if (v.length < 4 || v.some(x => !Number.isFinite(x))) return null;
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  }
  function normPoint(p){
    if (!Array.isArray(p) || p.length < 2) return null;
    const v = p.slice(0, 2).map(Number);
    return v.every(Number.isFinite) ? v : null;
  }
  function normPoly(p){
    if (!Array.isArray(p)) return null;
    const out = p.map(normPoint).filter(Boolean);
    while (out.length > 3 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
    return out.length >= 3 ? out : null;
  }
  const polyCenter = poly => [Math.round(poly.reduce((a,p) => a + p[0], 0)/poly.length), Math.round(poly.reduce((a,p) => a + p[1], 0)/poly.length)];

  // 在 x 向右、y 向下的平面内，正角度沿顺时针方向。
  function arcGeometry(from, to, degrees, thickness = 0){
    if (![from, to].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) ||
        !Number.isFinite(degrees) || Math.abs(degrees) < .5 || Math.abs(degrees) > 180) return null;
    const dx = to[0] - from[0], dy = to[1] - from[1], chord = Math.hypot(dx, dy);
    const sweep = degrees * Math.PI / 180, half = sweep / 2;
    const radius = chord / (2 * Math.sin(Math.abs(half)));
    const offset = Math.abs(degrees) === 180 ? 0 : .5 / Math.tan(half);
    const cx = from[0] / 2 + to[0] / 2 - dy * offset;
    const cy = from[1] / 2 + to[1] / 2 + dx * offset;
    const outer = radius + thickness / 2;
    if (!(radius > thickness / 2) || ![cx - outer, cx + outer, cy - outer, cy + outer].every(Number.isFinite)) return null;
    return {cx, cy, radius, start:Math.atan2(from[1] - cy, from[0] - cx), sweep, thickness};
  }

  function curvePoint(curve, fraction, offset = 0){
    const angle = curve.start + curve.sweep * fraction, radius = curve.radius + offset;
    return [curve.cx + radius * Math.cos(angle), curve.cy + radius * Math.sin(angle)];
  }
  function curveFraction(curve, angle){
    const turn = 2 * Math.PI, delta = (angle - curve.start) * Math.sign(curve.sweep);
    const fraction = ((delta % turn + turn) % turn) / Math.abs(curve.sweep);
    return fraction <= 1 ? fraction : null;
  }
  function closestCurvePoint(curve, x, y, offset = 0){
    const fraction = curveFraction(curve, Math.atan2(y - curve.cy, x - curve.cx));
    if (fraction !== null) return curvePoint(curve, fraction, offset);
    const a = curvePoint(curve, 0, offset), b = curvePoint(curve, 1, offset);
    return Math.hypot(x - a[0], y - a[1]) <= Math.hypot(x - b[0], y - b[1]) ? a : b;
  }
  function curveDistance(curve, x, y){
    const [px, py] = closestCurvePoint(curve, x, y);
    return Math.hypot(x - px, y - py);
  }
  function curveBounds(curve){
    const samples = [0, 1];
    for (let n = 0; n < 4; n++){
      const fraction = curveFraction(curve, n * Math.PI / 2);
      if (fraction !== null) samples.push(fraction);
    }
    const points = samples.flatMap(t => [curvePoint(curve, t, -curve.thickness / 2), curvePoint(curve, t, curve.thickness / 2)]);
    return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
            Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  }
  function curveSamples(curve, offset = 0){
    // 把 3D 弦与圆弧间的偏差控制在约 0.5mm，限制单段网格规模。
    const maxStep = 2 * Math.acos(1 - Math.min(1, .5 / (curve.radius + curve.thickness / 2)));
    const steps = Math.min(128, Math.max(2, Math.ceil(Math.abs(curve.sweep) / maxStep)));
    return Array.from({length:steps + 1}, (_, i) => curvePoint(curve, i / steps, offset));
  }
  function curveOutline(curve, width = curve.thickness){
    return [...curveSamples(curve, width / 2), ...curveSamples(curve, -width / 2).reverse()];
  }
  function curvedSpan(raw){
    if (!Number.isFinite(raw?.thickness) || raw.thickness <= 0) return null;
    return arcGeometry(raw.from, raw.to, raw.sweep, raw.thickness);
  }
  const arcFields = raw => ({from:[...raw.from], to:[...raw.to], sweep:raw.sweep, thickness:raw.thickness});
  const isCurvedSpan = raw => raw && typeof raw === 'object' && !Array.isArray(raw) &&
    ['from', 'to', 'sweep', 'thickness'].some(key => Object.hasOwn(raw, key));

  function roomCurves(room){
    if (!room.arcs?.length) return new Map();
    const poly = room.vertices || room.poly;
    return new Map(room.arcs.map(({edge, sweep}) => [edge, arcGeometry(poly[edge], poly[(edge + 1) % poly.length], sweep)]));
  }
  function roomOutline(room){
    if (!room.arcs?.length) return room.poly;
    const curves = roomCurves(room);
    return room.poly.flatMap((p, i) => {
      const curve = curves.get(i);
      return curve ? [p, ...curveSamples(curve).slice(1, -1)] : [p];
    });
  }

  const patURL = k => `url(#${matPat[App.plan.matKey(k)] || 'm-tile800'})`;
  // 家具库：[类型, 名称, 宽, 深, 颜色]
  const legacyLibrary = [
    {cat:'卧室', items:[
      ['bed','双人床 1.8m',1800,2000,'#c9d6df'],['bed','双人床 1.5m',1500,2000,'#d8c7dc'],['bed','单人床',1200,2000,'#e8d5b5'],
      ['crib','婴儿床',1250,700,'#efe3d0'],['nightstand','床头柜',450,400,'#e8dccb'],['wardrobe','衣柜',2000,600,'#efe6d8'],
      ['wardrobe','小衣柜',1200,550,'#efe6d8'],['dresser','梳妆台',1000,450,'#efe6d8'],['desk','书桌',1200,600,'#e2cfb4'],
      ['chair','椅子',450,480,'#cfc6b8'],['bookshelf','书架',800,300,'#e2cfb4'],['baycushion','飘窗垫',520,1800,'#e7dccd']]},
    {cat:'客厅', items:[
      ['sofa','三人沙发',2400,900,'#b7c4b0'],['sofa','双人沙发',1700,880,'#c3cbd6'],['cornersofa','转角沙发',2800,1700,'#b7c4b0'],
      ['armchair','单人沙发',850,850,'#d6b99a'],['beanbag','懒人沙发',800,800,'#e0b98f'],['coffeetable','茶几',1300,650,'#e8dccb'],
      ['sidetable','边几',500,500,'#d9c3a3'],['tvstand','电视柜',2400,400,'#e2cfb4'],['rug','地毯',2400,1700,'#d9cbb8'],
      ['shoecab','鞋柜',1000,350,'#efe6d8'],['shoecab','玄关柜',1400,380,'#e6dccc'],['floorlamp','落地灯',450,450,'#3d3a34'],
      ['plant','绿植',500,500,'#a9c39b'],['plant','大绿植',700,700,'#9dbb8c']]},
    {cat:'餐厨', items:[
      ['table','餐桌',1400,800,'#e2cfb4'],['table','六人餐桌',1800,900,'#d8c2a2'],['roundtable','圆桌',1000,1000,'#e2cfb4'],
      ['chair','餐椅',450,480,'#cfc6b8'],['island','岛台',1800,900,'#e9e5de'],['barstool','吧椅',420,420,'#6b5d4c'],
      ['counter','橱柜台面',1600,600,'#e9e5de'],['stove','燃气灶',750,450,'#dcdcdc'],['ksink','水槽',800,450,'#e1e6ea'],
      ['fridge','冰箱',700,700,'#dfe4e8'],['cabinet','餐边柜',1600,400,'#efe6d8']]},
    {cat:'卫浴', items:[
      ['toilet','马桶',400,700,'#ffffff'],['vanity','浴室柜',800,500,'#eef1f3'],['vanity','双盆浴室柜',1200,500,'#eef1f3'],
      ['shower','淋浴房',900,900,'#e4edf2'],['bathtub','浴缸',1600,750,'#eef3f6'],['washer','洗衣机',600,600,'#e6ebee'],
      ['waterheater','电热水器',800,450,'#f4f4f2'],['cabinet','储物柜',1000,400,'#efe6d8']]},
    {cat:'家电', items:[
      ['tv','65 寸电视',1450,80,'#1d1d1f'],['tv','55 寸电视',1230,80,'#1d1d1f'],['fridge','对开门冰箱',910,700,'#c9ced3'],
      ['aircon','柜机空调',500,380,'#f6f7f8'],['acwall','挂机空调',900,250,'#f6f7f8'],['dishwasher','洗碗机',600,600,'#c9ced3'],
      ['ovencol','蒸烤箱高柜',600,600,'#efe6d8'],['dryer','烘干机',600,600,'#e6ebee'],['purifier','空气净化器',400,300,'#f4f4f2']]},
    {cat:'书房 · 休闲', items:[
      ['desk','长书桌',1600,700,'#d8c2a2'],['officechair','办公椅',620,620,'#4a4f55'],['bookshelf','大书架',1600,350,'#e2cfb4'],
      ['piano','立式钢琴',1500,600,'#1f1d1b'],['treadmill','跑步机',800,1800,'#3a3a3c'],['armchair','阅读椅',750,800,'#c9a98a']]},
  ];
  // 规格为真实占地毫米。内置家具使用同一套可编辑的二维、三维模型。
  const oldOffers = new Map(legacyLibrary.flatMap(category => category.items.map(item => [item[1],item])));
  const existing = (name,id,en,options) => [...oldOffers.get(name),{id,en,...options}];
  const offer = (id,type,name,en,w,d,color,options) => [type,name,w,d,color,{id,en,...options}];
  const category = (id,name,en,groups) => ({id,name,en,groups});
  const group = (id,name,en,items) => ({id,name,en,items});
  const FURNITURE_CATALOG = [
    category('bedroom','卧室','Bedroom',[
      group('beds','成人床','Beds',[
        existing('双人床 1.8m','bed-1800','Double bed 1.8 m'),
        existing('双人床 1.5m','bed-1500','Double bed 1.5 m'),
        existing('单人床','bed-1200','Single bed 1.2 m'),
        offer('bed-900','bed','窄单人床 0.9m','Narrow single bed',900,1900,'#b7c9c0'),
        offer('bed-1350','bed','小双人床 1.35m','Small double bed',1350,1900,'#c2a8a6'),
        offer('bed-2000','bed','加长双人床 2m','Extra-long king bed',2000,2200,'#a3b4c7'),
      ]),
      group('cribs','婴儿床','Cribs',[
        existing('婴儿床','crib-1250','Crib'),
        offer('crib-1050','crib','窄款婴儿床','Compact crib',1050,620,'#ded2c0'),
        offer('crib-1450','crib','宽款婴儿床','Wide crib',1450,800,'#cbb495'),
      ]),
      group('wardrobes','衣柜','Wardrobes',[
        existing('衣柜','wardrobe-2000','Wardrobe'),
        existing('小衣柜','wardrobe-1200','Small wardrobe'),
        offer('wardrobe-900','wardrobe','窄深衣柜','Shallow wardrobe',900,440,'#d3c1a6'),
        offer('wardrobe-1600','wardrobe','胡桃木色衣柜','Walnut-tone wardrobe',1600,600,'#8e6d56'),
        offer('wardrobe-2600','wardrobe','通长组合衣柜','Full-width wardrobe',2600,650,'#ded7ce'),
      ]),
      group('bedside','床头柜','Nightstands',[
        existing('床头柜','nightstand-450','Nightstand'),
        offer('nightstand-340','nightstand','窄床头柜','Narrow nightstand',340,330,'#d5be9f'),
        offer('nightstand-600','nightstand','宽床头柜','Wide nightstand',600,450,'#91705c'),
      ]),
      group('dressing','梳妆与窗台','Dressing & window seats',[
        existing('梳妆台','dresser-1000','Dresser'),
        offer('dresser-800','dresser','紧凑梳妆台','Compact dresser',800,380,'#d9c9b4'),
        offer('dresser-1300','dresser','宽台面梳妆台','Wide dresser',1300,520,'#b79a7f'),
        existing('飘窗垫','baycushion-1800','Bay cushion'),
        offer('baycushion-1200','baycushion','短窗台垫','Short window cushion',480,1200,'#b9c9c1'),
        offer('baycushion-2400','baycushion','长窗台垫','Long window cushion',650,2400,'#c6b39c'),
      ]),
    ]),
    category('living','客厅','Living room',[
      group('sofas','沙发','Sofas',[
        existing('三人沙发','sofa-2400','Three-seat sofa'),
        existing('双人沙发','sofa-1700','Two-seat sofa'),
        offer('sofa-1450','sofa','紧凑双人沙发','Compact two-seat sofa',1450,760,'#c7aba0'),
        offer('sofa-2580','sofa','深座三人沙发','Deep three-seat sofa',2580,1130,'#af9e8e'),
        offer('sofa-3100','sofa','四人沙发','Four-seat sofa',3100,1050,'#aebbb2'),
        existing('转角沙发','corner-left-2800','Left corner sofa',{handedness:'left'}),
        offer('corner-right-2800','cornersofa','右转角沙发','Right corner sofa',2800,1700,'#b7c4b0',{handedness:'right'}),
        offer('corner-left-3150','cornersofa','深座左转角沙发','Deep left corner sofa',3150,2100,'#a9b5c0',{handedness:'left'}),
        offer('corner-right-3150','cornersofa','深座右转角沙发','Deep right corner sofa',3150,2100,'#a9b5c0',{handedness:'right'}),
      ]),
      group('lounge','单椅与懒人沙发','Lounge seating',[
        existing('单人沙发','armchair-850','Armchair'),
        offer('armchair-700','armchair','紧凑休闲椅','Compact lounge chair',700,720,'#a6b2bc'),
        offer('armchair-980','armchair','宽座休闲椅','Wide lounge chair',980,990,'#c4a68d'),
        existing('懒人沙发','beanbag-800','Beanbag'),
        offer('beanbag-1000','beanbag','深座豆袋椅','Deep beanbag',1000,1100,'#bbc0a6'),
      ]),
      group('occasional-tables','茶几与边几','Coffee & side tables',[
        existing('茶几','coffee-1300','Coffee table'),
        offer('coffee-1050-oval','coffeetable','椭圆茶几','Oval coffee table',1050,560,'#bd9978',{topShape:'oval',height:380}),
        offer('coffee-760-round','coffeetable','低圆茶几','Low round coffee table',760,760,'#d9c9b4',{topShape:'round',height:340}),
        offer('coffee-900-square','coffeetable','方形大茶几','Square coffee table',900,900,'#ac8a6f',{topShape:'rect',height:420}),
        offer('coffee-1500','coffeetable','长条茶几','Long coffee table',1500,560,'#a99b8b',{topShape:'rect',height:430}),
        existing('边几','side-500','Side table'),
        offer('side-380-round','sidetable','窄圆边几','Small round side table',380,380,'#dac9b6',{topShape:'round',height:550}),
        offer('side-460-square','sidetable','高方边几','Tall square side table',460,460,'#a99682',{topShape:'rect',height:640}),
        offer('side-650-oval','sidetable','长椭圆边几','Long oval side table',650,410,'#c3aa8c',{topShape:'oval',height:490}),
      ]),
      group('media','电视柜','Media consoles',[
        existing('电视柜','tvstand-2400','TV console'),
        offer('tvstand-1600','tvstand','紧凑电视柜','Compact TV console',1600,410,'#bb9e84'),
        offer('tvstand-2800','tvstand','通长电视柜','Long TV console',2800,460,'#ada18b'),
      ]),
      group('rugs','地毯','Rugs',[
        existing('地毯','rug-2400','Area rug'),
        offer('rug-1400','rug','小块地毯','Small area rug',1400,1000,'#b9c5b2'),
        offer('rug-2000','rug','窄长地毯','Runner rug',2000,780,'#b9a49e'),
        offer('rug-3000','rug','大块客厅地毯','Large area rug',3000,2200,'#c2b6a5'),
      ]),
      group('decor','落地灯与绿植','Floor lamps & plants',[
        existing('落地灯','lamp-450','Floor lamp'),
        offer('lamp-350','floorlamp','小直径落地灯','Compact floor lamp',350,350,'#9b7951'),
        offer('lamp-570','floorlamp','大灯罩落地灯','Wide shade floor lamp',570,570,'#57555a'),
        existing('绿植','plant-500','Plant'),
        existing('大绿植','plant-700','Large plant'),
        offer('plant-300','plant','紧凑盆栽','Compact potted plant',300,300,'#adc5a2'),
        offer('plant-900','plant','大型落地盆栽','Large floor planter',900,900,'#84a47c'),
      ]),
    ]),
    category('dining','餐厅','Dining room',[
      group('dining-tables','餐桌','Dining tables',[
        existing('餐桌','table-1400','Dining table'),
        existing('六人餐桌','table-1800','Six-seat dining table'),
        offer('table-900','table','小方餐桌','Small square table',900,900,'#c9ad90'),
        offer('table-1100','table','窄款餐桌','Narrow dining table',1100,630,'#d7ba93'),
        offer('table-2400','table','八人长餐桌','Long eight-seat table',2400,1000,'#9f7658'),
        existing('圆桌','roundtable-1000','Round dining table'),
        offer('roundtable-850','roundtable','小圆餐桌','Small round dining table',850,850,'#c5aa91'),
        offer('roundtable-1300','roundtable','六人圆餐桌','Six-seat round table',1300,1300,'#c7a987'),
        offer('roundtable-1550','roundtable','八人圆餐桌','Eight-seat round table',1550,1550,'#876b55'),
      ]),
      group('dining-seating','餐椅与吧椅','Dining chairs & stools',[
        existing('椅子','chair-450','Chair'),
        existing('餐椅','diningchair-450','Dining chair'),
        offer('diningchair-410','chair','窄餐椅','Narrow dining chair',410,445,'#d6c0aa'),
        offer('diningchair-530','chair','宽座餐椅','Wide-seat dining chair',530,560,'#b4a69b'),
        existing('吧椅','barstool-420','Bar stool'),
        offer('barstool-360','barstool','紧凑圆吧椅','Compact round bar stool',360,360,'#a07c5f'),
        offer('barstool-510','barstool','宽座圆吧椅','Wide round bar stool',510,510,'#857b66'),
      ]),
      group('sideboards','餐边柜','Sideboards',[
        existing('餐边柜','sideboard-1600','Sideboard'),
        offer('sideboard-1050','cabinet','窄餐边柜','Compact sideboard',1050,350,'#cab49b'),
        offer('sideboard-2200','cabinet','长餐边柜','Long sideboard',2200,480,'#a58366'),
      ]),
    ]),
    category('kitchen','厨房','Kitchen',[
      group('counters','橱柜台面','Cabinet counters',[
        existing('橱柜台面','counter-1600','Kitchen counter'),
        offer('counter-850','counter','短橱柜台面','Short cabinet counter',850,560,'#e1d8c9'),
        offer('counter-2100','counter','长橱柜台面','Long cabinet counter',2100,620,'#b6b4a4'),
        offer('counter-2900','counter','一字型长橱柜','Full-length cabinet counter',2900,650,'#c9baaa'),
      ]),
      group('islands','岛台','Kitchen islands',[
        existing('岛台','island-1800','Kitchen island'),
        offer('island-1200','island','紧凑岛台','Compact island',1200,720,'#d0b8a0'),
        offer('island-2100','island','长岛台','Long island',2100,930,'#beb6a3'),
        offer('island-2500','island','宽深备餐岛台','Deep preparation island',2500,1100,'#cfc7b8'),
      ]),
      group('cooking','灶具','Cooktops',[
        existing('燃气灶','stove-750','Gas cooktop'),
        offer('stove-660','stove','紧凑双眼灶','Compact two-burner cooktop',660,400,'#d4d7d6'),
        offer('stove-610','stove','方形四眼灶','Square four-burner cooktop',610,530,'#b9bdc0'),
        offer('stove-900','stove','宽款四眼灶','Wide four-burner cooktop',900,660,'#b8b9bc'),
      ]),
      group('sinks','厨房水槽','Kitchen sinks',[
        existing('水槽','sink-800','Double-bowl sink'),
        offer('sink-500','ksink','紧凑单盆水槽','Compact single-bowl sink',500,400,'#d6dce1'),
        offer('sink-670','ksink','深款单盆水槽','Deep single-bowl sink',670,510,'#bbc9d1'),
        offer('sink-980','ksink','宽双盆水槽','Wide double-bowl sink',980,520,'#c5cdd3'),
      ]),
      group('refrigeration','冰箱','Refrigerators',[
        existing('冰箱','fridge-700','Refrigerator'),
        offer('fridge-600','fridge','窄双层冰箱','Narrow top-and-bottom refrigerator',600,620,'#d9dede'),
        existing('对开门冰箱','fridge-910','Side-by-side refrigerator'),
        offer('fridge-1070','fridge','宽对开门冰箱','Wide side-by-side refrigerator',1070,780,'#a5acb3'),
      ]),
    ]),
    category('bath','卫浴','Bathroom',[
      group('toilets','马桶','Toilets',[
        existing('马桶','toilet-700','Toilet'),
        offer('toilet-590','toilet','短进深马桶','Short-projection toilet',365,590,'#fbfbfa'),
        offer('toilet-760','toilet','长座圈马桶','Elongated toilet',430,760,'#f5f6f5'),
      ]),
      group('vanities','浴室柜','Vanities',[
        existing('浴室柜','vanity-800','Vanity'),
        offer('vanity-600','vanity','小单盆浴室柜','Compact single vanity',600,430,'#cbb69d'),
        offer('vanity-950','vanity','宽台面单盆浴室柜','Wide single vanity',950,520,'#bbb6aa'),
        existing('双盆浴室柜','vanity-1200','Double vanity'),
        offer('vanity-1600','vanity','长双盆浴室柜','Long double vanity',1600,570,'#a98c72'),
      ]),
      group('showers','淋浴房','Showers',[
        existing('淋浴房','shower-900','Shower enclosure'),
        offer('shower-800','shower','紧凑方淋浴房','Compact square shower',800,800,'#e1e7ed'),
        offer('shower-1200','shower','长方淋浴房','Rectangular shower',1200,900,'#d6e1e8'),
        offer('shower-1550','shower','宽淋浴区','Wide shower',1550,1000,'#d0dce5'),
      ]),
      group('baths','浴缸','Bathtubs',[
        existing('浴缸','bath-1600','Bathtub'),
        offer('bath-1250','bathtub','短款浴缸','Compact bathtub',1250,700,'#e5e9ec'),
        offer('bath-1700','bathtub','深宽浴缸','Wide bathtub',1700,850,'#eee8e1'),
        offer('bath-1850','bathtub','加长浴缸','Extra-long bathtub',1850,800,'#e9eef0'),
      ]),
      group('bath-storage','卫浴收纳与热水','Bath storage & water heating',[
        existing('储物柜','bathcab-1000','Storage cabinet'),
        offer('bathcab-650','cabinet','窄浴室储物柜','Narrow bath cabinet',650,340,'#c6b49d'),
        existing('电热水器','heater-800','Water heater'),
        offer('heater-650','waterheater','短筒热水器','Compact water heater',650,390,'#e7e7e3'),
        offer('heater-1030','waterheater','长筒热水器','Large water heater',1030,480,'#f0efea'),
      ]),
    ]),
    category('appliances','家电','Appliances',[
      group('televisions','电视','Televisions',[
        existing('65 寸电视','tv-65','65-inch TV'),
        existing('55 寸电视','tv-55','55-inch TV'),
        offer('tv-43','tv','43 寸电视','43-inch TV',960,75,'#232629'),
        offer('tv-75','tv','75 寸电视','75-inch TV',1670,90,'#1b1c20'),
        offer('tv-85','tv','85 寸电视','85-inch TV',1890,110,'#353438'),
      ]),
      group('climate','空调与净化','Climate & air care',[
        existing('柜机空调','aircon-500','Floor-standing AC'),
        offer('aircon-380','aircon','窄柜机空调','Narrow floor-standing AC',380,340,'#e8e6e1'),
        existing('挂机空调','acwall-900','Wall-mounted AC'),
        offer('acwall-760','acwall','短挂机空调','Compact wall-mounted AC',760,215,'#ebece9'),
        offer('acwall-1100','acwall','宽挂机空调','Wide wall-mounted AC',1100,285,'#dadee1'),
        existing('空气净化器','purifier-400','Air purifier'),
        offer('purifier-540','purifier','宽式空气净化器','Wide air purifier',540,350,'#e0e0df'),
      ]),
      group('laundry','洗烘设备','Laundry',[
        existing('洗衣机','washer-600','Washer'),
        offer('washer-520','washer','薄款滚筒洗衣机','Slim front-load washer',595,520,'#e2e1de'),
        offer('washer-730','washer','深筒洗衣机','Deep front-load washer',680,730,'#bdc5cd'),
        existing('烘干机','dryer-600','Dryer'),
        offer('dryer-680','dryer','大容量烘干机','Large dryer',660,680,'#c7d0d6'),
      ]),
      group('kitchen-appliances','嵌入厨电','Built-in kitchen appliances',[
        existing('洗碗机','dishwasher-600','Dishwasher'),
        offer('dishwasher-450','dishwasher','窄嵌入洗碗机','Slim dishwasher',450,570,'#cdd1d5'),
        existing('蒸烤箱高柜','ovencol-600','Oven tower'),
        offer('ovencol-750','ovencol','宽蒸烤箱高柜','Wide oven tower',750,655,'#bcb4a8'),
      ]),
    ]),
    category('study','书房 · 休闲','Study & leisure',[
      group('desks','书桌','Desks',[
        existing('书桌','desk-1200','Desk'),
        offer('desk-950','desk','小书桌','Compact desk',950,500,'#e2caaa'),
        existing('长书桌','desk-1600','Long desk'),
        offer('desk-2000','desk','宽工作桌','Wide work desk',2000,800,'#a68568'),
      ]),
      group('study-seats','办公椅与阅读椅','Task & reading chairs',[
        existing('办公椅','office-620','Office chair'),
        offer('office-540','officechair','紧凑办公椅','Compact task chair',540,570,'#666970'),
        offer('office-720','officechair','宽座办公椅','Wide task chair',720,740,'#62544b'),
        existing('阅读椅','reader-750','Reading chair'),
        offer('reader-900','armchair','深座阅读椅','Deep reading chair',900,1000,'#afb8a5'),
      ]),
      group('bookcases','书架','Bookcases',[
        existing('书架','bookcase-800','Bookcase'),
        offer('bookcase-480','bookshelf','单列窄书架','Slim bookcase',480,280,'#bea284'),
        existing('大书架','bookcase-1600','Large bookcase'),
        offer('bookcase-2200','bookshelf','通长书架','Full-width bookcase',2200,395,'#876b55'),
      ]),
      group('hobbies','音乐与运动','Music & fitness',[
        existing('立式钢琴','piano-1500','Upright piano'),
        offer('piano-1350','piano','小型立式钢琴','Compact upright piano',1350,545,'#514033'),
        offer('piano-1570','piano','宽款立式钢琴','Wide upright piano',1570,650,'#3c3028'),
        existing('跑步机','treadmill-1800','Treadmill'),
        offer('treadmill-1450','treadmill','紧凑跑步机','Compact treadmill',710,1450,'#51545a'),
        offer('treadmill-2150','treadmill','长跑台跑步机','Long-deck treadmill',920,2150,'#333741'),
      ]),
    ]),
    category('entry','玄关与收纳','Entry & storage',[
      group('entry-cabinets','鞋柜与玄关柜','Shoe & entry cabinets',[
        existing('鞋柜','shoecab-1000','Shoe cabinet'),
        offer('shoecab-650','shoecab','窄玄关鞋柜','Narrow shoe cabinet',650,320,'#d8c3aa'),
        existing('玄关柜','shoecab-1400','Entry cabinet'),
        offer('shoecab-1900','shoecab','宽玄关收纳柜','Wide entry cabinet',1900,430,'#b69373'),
      ]),
      group('storage-cabinets','通用收纳柜','General storage',[
        offer('cabinet-750','cabinet','窄储物柜','Narrow storage cabinet',750,390,'#d7c4ad'),
        offer('cabinet-1250','cabinet','中型储物柜','Medium storage cabinet',1250,490,'#bfa78c'),
        offer('cabinet-1850','cabinet','宽储物柜','Wide storage cabinet',1850,540,'#a48a71'),
      ]),
    ]),
  ];
  const LIB = FURNITURE_CATALOG.map(({name,groups}) => ({cat:name,items:groups.flatMap(({items}) => items)}));
  const drawingItemTypes = new Set(['component', ...LIB.flatMap(c => c.items.map(i => i[0]))]);
  const componentCount = items => items.filter(f => f.type === 'component').length;
  const typeColor = t => { for (const c of legacyLibrary) for (const i of c.items) if (i[0]===t) return i[4]; return '#eee'; };

  let _n = 1;
  const uid = () => 'f' + Date.now().toString(36) + (_n++);
  const F = (type,name,cx,cy,w,d,rot=0,color) => ({id:uid(),type,name,cx,cy,w,d,rot,color:color||typeColor(type)});

  function wrapRotation(angle){
    const rot = Number.isFinite(angle) ? angle % 360 : 0;
    return rot < 0 ? rot + 360 : rot;
  }
  function winderPoints(pivot, edges, steps){
    const inFootprint = point => Array.isArray(point) && point.length === 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= .5 && Math.abs(point[1]) <= .5;
    if (!inFootprint(pivot) || !Array.isArray(edges) || edges.length !== steps + 1 ||
        !Array.from(edges).every(inFootprint)) return null;
    const [px, pz] = pivot;
    let direction = 0, sweep = 0;
    for (let i = 0; i < steps; i++){
      const ax = edges[i][0] - px, az = edges[i][1] - pz;
      const bx = edges[i + 1][0] - px, bz = edges[i + 1][1] - pz;
      const cross = ax * bz - az * bx;
      if (Math.abs(cross) <= 1e-9 || (direction && Math.sign(cross) !== direction)) return null;
      direction = Math.sign(cross);
      sweep += Math.abs(Math.atan2(cross, ax * bx + az * bz));
    }
    if (sweep >= 2 * Math.PI - 1e-8) return null;
    return {pivot: [...pivot], edges: edges.map(point => [...point])};
  }
  function normalizeComponentParts(input){
    const parts = [];
    if (!Array.isArray(input)) return parts;
    for (const p of input.slice(0, 48)){
      if (!p || !['box', 'cylinder', 'stairs', 'winder'].includes(p.shape)) continue;
      const {shape, x, z, w, d, y, h, steps} = p;
      if (![x, z, w, d, y, h].every(Number.isFinite) || Math.abs(x) > .5 || Math.abs(z) > .5 ||
          w <= 0 || w > 1 || d <= 0 || d > 1 || y < 0 || h <= 0 || y + h > 10000) continue;
      const part = {shape, x, z, w, d, y, h};
      if (shape === 'stairs' || shape === 'winder'){
        if (!Number.isInteger(steps) || steps < (shape === 'winder' ? 2 : 1) || steps > 32) continue;
        part.steps = steps;
      }
      if (shape === 'winder'){
        const points = winderPoints(p.pivot, p.edges, steps);
        if (!points) continue;
        Object.assign(part, points);
      }
      if (Number.isFinite(p.rot)) part.rot = wrapRotation(p.rot);
      if (typeof p.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(p.color)) part.color = p.color;
      parts.push(part);
    }
    return parts;
  }
  const tableTopType = type => type === 'coffeetable' || type === 'sidetable';
  const tableTopShapes = ['rect', 'round', 'oval'];
  const tableTopShape = f => f.topShape || (f.type === 'sidetable' ? 'oval' : 'rect');
  const tableHeight = f => f.height ?? (f.type === 'sidetable' ? 545 : 400);
  const sofaCushions = (type,w) => type === 'armchair' ? 1 : w >= 2900 ? 4 : w > 2200 ? 3 : 2;
  const sinkBasins = w => w >= 750 ? 2 : 1;
  const vanityBasins = w => w >= 1100 ? 2 : 1;
  const roundTablePlaces = w => w >= 1500 ? 8 : w >= 1200 ? 6 : 4;
  function normalizeFurn(f){
    if (!f || typeof f !== 'object') return null;
    const cx = +f.cx, cy = +f.cy, w = +f.w, d = +f.d;
    if (![cx, cy, w, d].every(Number.isFinite) || w <= 0 || d <= 0) return null;
    const type = String(f.type || 'box');
    const parts = type === 'component' ? normalizeComponentParts(f.parts) : null;
    if (parts && !parts.length) return null;
    const item = {
      id: String(f.id || uid()), type, name: String(f.name || type), cx, cy, w, d,
      rot: wrapRotation(+f.rot),
      color: /^#[0-9a-f]{3,8}$/i.test(f.color || '') ? f.color : typeColor(type),
      ...(parts ? {parts} : {}),
    };
    if (type === 'cornersofa' && ['left', 'right'].includes(f.handedness)) item.handedness = f.handedness;
    if (tableTopType(type)){
      if (tableTopShapes.includes(f.topShape)) item.topShape = f.topShape;
      if (Number.isFinite(f.height) && f.height >= 200 && f.height <= 800) item.height = f.height;
    }
    return item;
  }
  function catalogItemDetails(entry){
    if (!Array.isArray(entry)) return entry;
    const [type,name,w,d,color,options] = entry;
    return {...options,type,name,w,d,color};
  }
  function placeCatalogItem(entry,cx,cy){
    const item = catalogItemDetails(entry);
    if (!item) return null;
    return normalizeFurn({...item,id:uid(),cx,cy,rot:item.rot ?? 0});
  }
  /* ======================= 几何工具 ======================= */
  function roomArea(room){
    const poly = room.vertices || room.poly, curves = roomCurves(room), [ox, oy] = poly[0];
    let twiceArea = 0;
    poly.forEach(([x, y], i) => {
      const [nx, ny] = poly[(i + 1) % poly.length], curve = curves.get(i);
      twiceArea += (x - ox) * (ny - oy) - (nx - ox) * (y - oy);
      if (curve) twiceArea += curve.radius ** 2 * (curve.sweep - Math.sin(curve.sweep));
    });
    return Math.abs(twiceArea) / 2e6;
  }
  function roomPerimeter(room){
    const poly = room.vertices || room.poly, curves = roomCurves(room);
    return poly.reduce((sum, p, i) => {
      const q = poly[(i + 1) % poly.length], curve = curves.get(i);
      return sum + (curve ? curve.radius * Math.abs(curve.sweep) : Math.hypot(q[0] - p[0], q[1] - p[1]));
    }, 0) / 1000;
  }
  const bbox = poly => { const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1]); return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]; };
  function aabb(f){ const a = f.rot*Math.PI/180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); return {hw:f.w/2*c + f.d/2*s, hh:f.w/2*s + f.d/2*c}; }
  const fmt = (n, d=2) => n.toFixed(d);
  const norm = a => ((Math.round(a) % 360) + 360) % 360;
  const wallLength = w => w[6] ? w[6].radius * Math.abs(w[6].sweep) : Math.max(w[2]-w[0], w[3]-w[1]);
  function snapRects(){ return App.store.WALLS.filter((w,i) => !w[6] && !App.store.state.demolished.includes('w'+i)).concat(App.store.WINS.filter(w => !w[4])); }
  function snapCurves(){ return App.store.WALLS.filter((w,i) => w[6] && !App.store.state.demolished.includes('w'+i)).map(w => w[6]).concat(App.store.WINS.map(w => w[4]).filter(Boolean)); }

  /* ======================= 颜色 / 材质图案 ======================= */
  function hex2rgb(h){ h = h.replace('#',''); if (h.length===3) h = h.split('').map(c=>c+c).join(''); const n = parseInt(h,16); return [(n>>16)&255,(n>>8)&255,n&255]; }
  function shade(h,k){ const f = v => Math.max(0,Math.min(255,Math.round(k>1 ? v+(255-v)*(k-1)*2 : v*k))); return '#'+hex2rgb(h).map(v=>f(v).toString(16).padStart(2,'0')).join(''); }

  function buildDefs(){
    const plank = (id,base,line) => `<pattern id="m-${id}" patternUnits="userSpaceOnUse" width="1800" height="360">
      <rect width="1800" height="360" fill="${base}"/>
      <path d="M0 0H1800M0 180H1800M1200 0V180M600 180V360" stroke="${line}" stroke-width="10"/>
      <path d="M100 70Q500 60 900 85T1700 75M200 260Q700 250 1100 275T1750 262" stroke="${line}" stroke-width="5" fill="none" opacity=".45"/></pattern>`;
    const tile = (id,size,base,line) => `<pattern id="m-${id}" patternUnits="userSpaceOnUse" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="${base}"/><path d="M0 0H${size}M0 0V${size}" stroke="${line}" stroke-width="10"/></pattern>`;
    // 内置图案固定成默认样式；方案里自定义的材料按 sw 生成纯色地砖图案
    const BUILTIN = ['wood','walnut','tile800','tile600','antislip','marble','terrazzo','carpet'];
    clearMaterialPatterns();
    BUILTIN.forEach(k => matPat[k] = 'm-' + k);
    const extra = Object.keys(App.store.MATS).filter(k => !BUILTIN.includes(k)).map((k, i) => {
      const base = /^#[0-9a-f]{3,8}$/i.test(App.store.MATS[k].sw) ? App.store.MATS[k].sw : '#e5e0d6';
      matPat[k] = 'mx' + i;
      return `<pattern id="mx${i}" patternUnits="userSpaceOnUse" width="600" height="600">
      <rect width="600" height="600" fill="${base}"/><path d="M0 0H600M0 0V600" stroke="${shade(base,.92)}" stroke-width="8"/></pattern>`;
    }).join('');
    App.core.$('#defs').innerHTML =
      plank('wood','#dcc09a','#bf9d70') + plank('walnut','#a57c56','#80593a') +
      tile('tile800',800,'#ece7de','#d3cabb') + tile('tile600',600,'#e2e6e3','#c4cbc6') + tile('antislip',300,'#d6dbd7','#b3bab4') +
      `<pattern id="m-marble" patternUnits="userSpaceOnUse" width="1200" height="1200">
      <rect width="1200" height="1200" fill="#f3f0ea"/><path d="M0 0H1200M0 0V1200" stroke="#dcd5c8" stroke-width="10"/>
      <path d="M-50 300C250 260 380 520 700 470S1100 640 1260 600M200 1200C300 950 520 980 640 820" stroke="#d6cfc2" stroke-width="12" fill="none"/></pattern>
    <pattern id="m-terrazzo" patternUnits="userSpaceOnUse" width="500" height="500">
      <rect width="500" height="500" fill="#e8e1d5"/>
      <circle cx="60" cy="80" r="22" fill="#b9a58c"/><circle cx="310" cy="140" r="16" fill="#8fa3a0"/><circle cx="190" cy="330" r="26" fill="#c9b7a2"/>
      <circle cx="420" cy="400" r="18" fill="#a88f76"/><circle cx="90" cy="440" r="12" fill="#8fa3a0"/><circle cx="440" cy="40" r="10" fill="#b9a58c"/></pattern>
    <pattern id="m-carpet" patternUnits="userSpaceOnUse" width="120" height="120">
      <rect width="120" height="120" fill="#c9c3d3"/><circle cx="30" cy="30" r="8" fill="#bab3c6"/><circle cx="90" cy="90" r="8" fill="#bab3c6"/></pattern>
    <pattern id="grid" patternUnits="userSpaceOnUse" width="1000" height="1000">
      <path d="M500 0V1000M0 500H1000" stroke="#e5dfd3" stroke-width="8"/><path d="M0 0V1000M0 0H1000" stroke="#d8d0c1" stroke-width="14"/></pattern>` + extra;
  }

  /* ======================= 家具图例 ======================= */
  const ST = 'stroke="#3d3a34" stroke-width="1" vector-effect="non-scaling-stroke"';
  const rc = (x,y,w,h,f,ex='') => `<rect x="${x}" y="${y}" width="${Math.max(0,w)}" height="${Math.max(0,h)}" fill="${f}" ${ST} ${ex}/>`;
  const ec = (cx,cy,rx,ry,f,ex='') => `<ellipse cx="${cx}" cy="${cy}" rx="${Math.max(0,rx)}" ry="${Math.max(0,ry)}" fill="${f}" ${ST} ${ex}/>`;
  const ln = (x1,y1,x2,y2,ex='') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${ST} ${ex}/>`;
  const pa = (d,f='none',ex='') => `<path d="${d}" fill="${f}" ${ST} ${ex}/>`;
  const DASH = 'stroke-dasharray="4 3"';

  function winderSVG(part, w, d, color){
    const pivot = [part.pivot[0] * w, part.pivot[1] * d];
    const edges = part.edges.map(([x, z]) => [x * w, z * d]);
    const centers = [];
    const treads = edges.slice(1).map((end, i) => {
      const start = edges[i];
      centers.push(pivot.map((axis, j) => axis + ((start[j] + end[j]) / 2 - axis) * .62));
      return `<polygon points="${[pivot, start, end].map(point => point.join(',')).join(' ')}" fill="${color}" ${ST}/>`;
    }).join('');
    const [x, z] = centers.at(-1), [prevX, prevZ] = centers.at(-2);
    const angle = Math.atan2(z - prevZ, x - prevX);
    const tip = Math.min(Math.min(w, d) * .085, Math.hypot(x - prevX, z - prevZ) / 2);
    const head = [-.65, .65].map(offset => [x - tip * Math.cos(angle + offset), z - tip * Math.sin(angle + offset)].join(' '));
    return treads + pa(`M${centers.map(point => point.join(' ')).join('L')}M${head[0]}L${x} ${z}L${head[1]}`,
      'none', 'pointer-events="none"');
  }

  function componentSVG(f){
    // 顶面较高的部件盖在较低的部件之上；局部 +Z 对应平面向下。
    const parts = [...f.parts].sort((a, b) => (a.y + a.h) - (b.y + b.h));
    return parts.map(p => {
      const w = p.w * f.w, d = p.d * f.d, color = p.color || f.color;
      let shape;
      if (p.shape === 'winder') shape = winderSVG(p, w, d, color);
      else if (p.shape === 'cylinder') shape = ec(0, 0, w/2, d/2, color);
      else shape = rc(-w/2, -d/2, w, d, color);
      if (p.shape === 'stairs'){
        for (let i = 1; i < p.steps; i++){
          const z = -d/2 + i * d/p.steps;
          shape += ln(-w/2, z, w/2, z, 'opacity=".65" pointer-events="none"');
        }
        const x = w * .24, z = d * .36, head = Math.min(w, d) * .11;
        shape += pa(`M${x} ${-z}V${z}M${x-head} ${z-head}L${x} ${z}L${x+head} ${z-head}`, 'none', 'opacity=".95" pointer-events="none"');
      }
      return `<g data-part-shape="${p.shape}" transform="translate(${p.x*f.w} ${p.z*f.d}) rotate(${p.rot || 0})">${shape}</g>`;
    }).join('');
  }

  function furnSVG(t,w,d,c,details = {}){
    const x = -w/2, y = -d/2, m = Math.min(w,d);
    switch (t){
      case 'bed': {
        let s = rc(x,y,w,d,'#fbf8f2','rx="30"') + rc(x,y,w,Math.min(90,d*.05),shade(c,.62),'rx="20"');
        const ph = Math.min(360,d*.18), py = y+150;
        if (w >= 1300){ const pw = (w-240)/2; s += rc(x+80,py,pw,ph,'#fff','rx="70"') + rc(x+160+pw,py,pw,ph,'#fff','rx="70"'); }
        else s += rc(x+80,py,w-160,ph,'#fff','rx="70"');
        const by = py+ph+110, bh = y+d-15-by;
        s += rc(x+15,by,w-30,bh,c,'rx="40"') + pa(`M${x+15} ${by+300}H${x+w-15}`,'none',DASH);
        s += pa(`M${x+w-15-Math.min(420,w*.3)} ${by}L${x+w-15} ${by}L${x+w-15} ${by+Math.min(420,w*.3)}Z`, shade(c,1.12));
        return s;
      }
      case 'sofa': case 'armchair': {
        const b = d*.24, a = Math.min(200,w*.13), n = sofaCushions(t,w), cw = (w-2*a)/n, dk = shade(c,.85);
        let s = rc(x,y,w,d,dk,'rx="60"');
        for (let i=0;i<n;i++) s += rc(x+a+i*cw,y+b,cw,d-b-40,c,'rx="40"');
        return s + rc(x,y,w,b,dk,'rx="50"') + rc(x,y,a,d,dk,'rx="50"') + rc(x+w-a,y,a,d,dk,'rx="50"');
      }
      case 'cornersofa': {
        const k = Math.min(950,d*.56,w*.4), b = 220, dk = shade(c,.85);
        let s = pa(`M${x} ${y}H${x+w}V${y+k}H${x+k}V${y+d}H${x}Z`, dk);
        const cw = (w-b-200)/2;
        s += rc(x+b,y+b,cw,k-b-30,c,'rx="40"') + rc(x+b+cw,y+b,cw,k-b-30,c,'rx="40"') + rc(x+b,y+k,k-b-30,d-k-200,c,'rx="40"');
        s += rc(x,y,w,b,dk,'rx="50"') + rc(x,y,b,d,dk,'rx="50"') + rc(x+w-200,y,200,k,dk,'rx="50"') + rc(x,y+d-200,k,200,dk,'rx="50"');
        return details.handedness === 'right' ? `<g transform="scale(-1 1)">${s}</g>` : s;
      }
      case 'nightstand': return rc(x,y,w,d,c,'rx="30"') + `<circle r="${m*.24}" fill="#fff6dd" ${ST}/>` + `<circle r="${m*.08}" fill="${shade(c,.8)}" ${ST}/>`;
      case 'wardrobe': {
        let s = rc(x,y,w,d,c) + ln(x+50,0,x+w-50,0);
        for (let hx = x+160; hx < x+w-100; hx += 180) s += ln(hx-45,-d*.28,hx+45,d*.28,'opacity=".6"');
        return s;
      }
      case 'cabinet': case 'shoecab': return rc(x,y,w,d,c) + ln(x,y+d,x+w,y);
      case 'dresser': return rc(x,y,w,d,c,'rx="20"') + rc(x+w*.2,y,w*.6,55,'#dfe9ee') + ec(0,d/2+180,160,140,shade(c,.9));
      case 'desk': return rc(x,y,w,d,c,'rx="20"') + rc(-w*.18,y+50,w*.36,45,'#555') + rc(-w*.14,y+d*.45,w*.28,d*.28,'#f4f4f4','rx="10"');
      case 'chair': return rc(x+25,y+d*.16,w-50,d*.84-10,c,'rx="60"') + rc(x,y,w,d*.2,shade(c,.78),'rx="40"');
      case 'bookshelf': { let s = rc(x,y,w,d,c); for (let bx = x+400; bx < x+w-50; bx += 400) s += ln(bx,y,bx,y+d); return s; }
      case 'baycushion': return rc(x,y,w,d,c,'rx="60"') + rc(x+60,y+80,w-120,Math.min(300,d*.2),'#fff','rx="60"') + rc(x+60,y+d-80-Math.min(300,d*.2),w-120,Math.min(300,d*.2),'#fff','rx="60"');
      case 'coffeetable': return details.topShape === 'round' || details.topShape === 'oval' ? ec(0,0,w/2,d/2,c)
        : rc(x,y,w,d,c,'rx="80"') + rc(x+60,y+60,w-120,d-120,shade(c,1.06),'rx="50"');
      case 'tvstand': return rc(x,y,w,d,c) + rc(x+w*.15,y+30,w*.7,55,'#3a3a3a');
      case 'rug': return rc(x,y,w,d,c,'rx="40" fill-opacity=".6"') + rc(x+90,y+90,w-180,d-180,'none','rx="30" stroke-dasharray="3 3" opacity=".6"');
      case 'plant': {
        let s = `<circle r="${m/2}" fill="${c}" fill-opacity=".85" ${ST}/>`;
        for (let k=0;k<8;k++) s += `<ellipse cx="0" cy="${-m*.27}" rx="${m*.1}" ry="${m*.21}" transform="rotate(${k*45})" fill="${shade(c,.8)}" ${ST}/>`;
        return s + `<circle r="${m*.1}" fill="#8a6a4a" ${ST}/>`;
      }
      case 'table': return rc(x,y,w,d,c,'rx="30"') + rc(x+50,y+50,w-100,d-100,'none','rx="20" opacity=".4"');
      case 'roundtable': {
        let s = ec(0,0,w/2,d/2,c);
        const places = roundTablePlaces(w), plate = Math.min(100,m*.125);
        for (let i=0;i<places;i++){
          const angle = i*Math.PI*2/places+.4;
          s += ec(Math.cos(angle)*w*.32,Math.sin(angle)*d*.32,plate,plate,'#fbf8f2','opacity=".7"');
        }
        return s;
      }
      case 'counter': return rc(x,y,w,d,c) + ln(x,y+d-40,x+w,y+d-40,DASH);
      case 'stove': {
        let s = rc(x,y,w,d,'#2f2f2f','rx="20"'); const r = m*.26;
        const pts = w/d > 1.4 ? [[-w/4,0],[w/4,0]] : [[-w/4,-d/4],[w/4,-d/4],[-w/4,d/4],[w/4,d/4]];
        pts.forEach(([px,py]) => s += `<circle cx="${px}" cy="${py}" r="${r}" fill="none" stroke="#bbb" stroke-width="1" vector-effect="non-scaling-stroke"/><circle cx="${px}" cy="${py}" r="${r*.45}" fill="#666"/>`);
        return s;
      }
      case 'ksink': {
        const two = sinkBasins(w) === 2, width = w*(two ? .42 : .7);
        const centers = two ? [-w*.23,w*.23] : [0];
        let s = rc(x,y,w,d,c,'rx="20"');
        for (const cx of centers) s += rc(cx-width/2,y+d*.18,width,d*.66,'#fff','rx="50"');
        return s + `<circle cx="${two ? 0 : w*.3}" cy="${y+d*.09}" r="22" fill="#999"/>`;
      }
      case 'fridge': {
        const s = rc(x,y,w,d,c,'rx="30"') + ln(x,y+d*.14,x+w,y+d*.14);
        return s + (w > 850
          ? ln(0,y+d*.14,0,y+d) + rc(-70,y+d*.5,40,d*.25,'#aab') + rc(30,y+d*.5,40,d*.25,'#aab')
          : rc(x+w*.18,y+d*.64,40,d*.2,'#aab'));
      }
      case 'toilet': return rc(x+w*.04,y,w*.92,d*.27,c,'rx="30"') + ec(0,y+d*.27+d*.36,w*.47,d*.36,c) + ec(0,y+d*.27+d*.4,w*.3,d*.24,'#eef4f7');
      case 'vanity': {
        const count = vanityBasins(w), width = Math.min(w/count*.32,260);
        let s = rc(x,y,w,d,c,'rx="20"');
        for (const cx of count === 2 ? [-w/4,w/4] : [0]){
          s += ec(cx,y+d*.57,width,d*.28,'#fff') + `<circle cx="${cx}" cy="${y+d*.17}" r="26" fill="#999"/>`;
        }
        return s;
      }
      case 'shower': return rc(x,y,w,d,c) + ln(x,y,x+w,y+d,DASH) + ln(x+w,y,x,y+d,DASH) + `<circle r="45" fill="#fff" ${ST}/>`;
      case 'bathtub': return rc(x,y,w,d,c,'rx="40"') + rc(x+80,y+80,w-160,d-160,'#fff',`rx="${m*.33}"`) + `<circle cx="${x+w-260}" cy="0" r="35" fill="#ccc" ${ST}/>`;
      case 'washer': case 'dryer': return rc(x,y,w,d,c,'rx="30"') + rc(x,y,w,d*.14,shade(c,.9)) + `<circle cy="${d*.06}" r="${m*.34}" fill="#fff" ${ST}/><circle cy="${d*.06}" r="${m*.24}" fill="${t==='dryer'?'#e9dccb':'#cfdde4'}" ${ST}/>`;
      case 'crib': {
        let s = rc(x,y,w,d,c,'rx="20"') + rc(x+45,y+45,w-90,d-90,'#fff','rx="20"');
        for (let sx = x+90; sx < x+w-60; sx += 90) s += ln(sx,y,sx,y+45,'opacity=".5"') + ln(sx,y+d-45,sx,y+d,'opacity=".5"');
        return s;
      }
      case 'beanbag': return ec(0,0,w/2,d/2,c) + ec(-w*.04,-d*.06,w*.3,d*.28,shade(c,1.12),'opacity=".9"');
      case 'sidetable': return details.topShape === 'rect' ? rc(x,y,w,d,c,'rx="18"')
        : ec(0,0,w/2,d/2,c) + (details.topShape ? '' : ec(0,0,w*.12,d*.12,'none','opacity=".5"'));
      case 'floorlamp': return `<circle r="${m*.5}" fill="#fff6dd" fill-opacity=".85" ${ST}/>` + `<circle r="${m*.32}" fill="none" ${ST} ${DASH}/>` + `<circle r="${m*.07}" fill="${c}" ${ST}/>`;
      case 'island': return rc(x,y,w,d,c) + ln(x,y+d-250,x+w,y+d-250,DASH);
      case 'barstool': return `<circle r="${m/2}" fill="${c}" ${ST}/><circle r="${m*.3}" fill="${shade(c,1.15)}" ${ST}/>`;
      case 'waterheater': return rc(x,y,w,d,c,`rx="${d/2}" ${DASH}`) + ln(x+w*.2,0,x+w*.8,0,DASH);
      case 'tv': return rc(x,y,w,d,c,'rx="10"') + rc(x+w*.3,y+d,w*.4,Math.min(40,d),'#666');
      case 'aircon': return rc(x,y,w,d,c,'rx="30"') + ln(x+40,y+d*.72,x+w-40,y+d*.72) + ln(x+40,y+d*.86,x+w-40,y+d*.86);
      case 'acwall': {
        let s = rc(x,y,w,d,c,`rx="30" ${DASH}`);
        [.25,.5,.75].forEach(k => s += ln(x+w*k,y+d,x+w*k,y+d+200,`${DASH} opacity=".6"`));
        return s;
      }
      case 'dishwasher': return rc(x,y,w,d,c,'rx="15"') + ln(x,y+d-70,x+w,y+d-70) + rc(x+w*.3,y+d-45,w*.4,25,'#888');
      case 'ovencol': return rc(x,y,w,d,c) + ln(x,y,x+w,y+d) + ln(x+w,y,x,y+d);
      case 'purifier': return rc(x,y,w,d,c,'rx="60"') + rc(x+45,y+45,w-90,d-90,'none',`rx="40" ${DASH}`);
      case 'officechair': {
        let s = '';
        for (let k = 0; k < 5; k++) s += `<line x1="0" y1="0" x2="0" y2="${m*.48}" transform="rotate(${k*72+36})" stroke="#555" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
        return s + rc(x+w*.12,y+d*.22,w*.76,d*.66,c,'rx="80"') + rc(x+w*.15,y+d*.04,w*.7,d*.16,shade(c,.78),'rx="40"')
          + rc(x+w*.02,y+d*.3,w*.1,d*.45,shade(c,.7),'rx="30"') + rc(x+w*.88,y+d*.3,w*.1,d*.45,shade(c,.7),'rx="30"');
      }
      case 'piano': {
        let s = rc(x,y,w,d*.55,c,'rx="10"') + rc(x+40,y+d*.55,w-80,d*.4,shade(c,1.4),'rx="10"');
        const kx = x+90, kw = w-180, kd = d*.2;
        s += rc(kx,y+d*.55,kw,kd,'#faf8f3');
        for (let i = 1; i < 26; i++) s += ln(kx+kw*i/26,y+d*.55,kx+kw*i/26,y+d*.55+kd,'opacity=".5"');
        return s;
      }
      case 'treadmill': return rc(x,y,w,d,c,'rx="50"') + rc(x+90,y+320,w-180,d-400,'#1c1c1e','rx="25"') + rc(x,y,w,230,shade(c,1.4),'rx="40"');
      default: return rc(x,y,w,d,c);
    }
  }

  Object.assign(App.geom, {
    normRect, normPoint, normPoly, polyCenter, arcGeometry, curvePoint, closestCurvePoint,
    curveDistance, curveBounds, curveOutline, curvedSpan, arcFields, isCurvedSpan, roomCurves,
    roomOutline, patURL, LIB, FURNITURE_CATALOG, catalogItemDetails, placeCatalogItem,
    drawingItemTypes, componentCount, uid, F, normalizeComponentParts,
    tableTopType, tableTopShape, tableHeight, sofaCushions, sinkBasins, vanityBasins, roundTablePlaces,
    normalizeFurn, roomArea, roomPerimeter, bbox, aabb, fmt,
    norm, wallLength, snapRects, snapCurves, shade, buildDefs, componentSVG, furnSVG,
  });
  App.geom.clearMaterialPatterns = clearMaterialPatterns;
})();
