(function(root){
  "use strict";
  const schema="huayu-transit-template-v1";
  const families={"bus-stop":"公交站牌","bus-rollsign":"公交车载前后路牌","bus-interior":"公交车厢线路屏","metro-guide":"地铁导视","metro-led":"车厢 LED 线路屏","metro-lcd":"车厢 LCD 线路屏"};
  const busLayouts={strip:"横排竖写纸质站牌",column:"纵向灯箱线路牌",pole:"杆挂横式线路牌",lcd:"LCD 站台信息屏",led:"LED 到站预报屏",ink:"电子墨水站牌",compact:"紧凑横条纸质牌",split:"左右分区灯箱",wide:"横屏多线路看板",cards:"双列分卡电子牌",hub:"公交枢纽索引牌",bilingual:"横写双语线路牌"};
  Object.assign(busLayouts,{"gaoyang":"高阳 · 黑黄多线路站牌","gaoyang-detail":"高阳 · 线路地图与发车表","wuxi":"无锡 · 黑站头红白灯箱","mint":"薄荷绿 · 圆角线路与定位针","chengdu":"成都 · 右栏到站电子牌","shenzhen":"深圳 · 蓝底黄条本站牌","shanghai":"上海 · 双列纸质线路卡","qingdao":"青岛 · 蓝白杆挂叠牌","weifang":"潍坊 · 大箭头纸质站牌","lanzhou":"兰州 · 运营公司分组横牌","wuhan":"武汉 · 红号方向箭头横牌","chongqing":"重庆 · 斜排站序到站分栏","chengmai":"澄迈 · 绿白方向与黄底道路条","xiamen":"厦门 · 重点线路与发车卡阵"});
  const screenLayouts={marquee:"LED 全线横向走马灯",alternating:"上下交错站名条屏",diagonal:"斜排站名全线屏",return:"双行折返线路屏",loop:"闭合回接线路屏",focus:"局部站段＋全线总览"};
  Object.assign(screenLayouts,{"nanjing":"南京 · 蓝顶下一站斜排屏","chongqing-screen":"重庆 · 黄顶红绿站灯屏","wuxi-screen":"无锡 · 园林拱灯双页屏","fuzhou":"福州 · 蓝白快线站序屏","platform":"站台 · 邻站与开门信息屏","ningbo":"宁波 · 底部彩带斜排屏","suzhou":"苏州 · 弧顶邻站放大屏","songjiang":"松江 · 粉色三站放大车厢屏","macau":"澳门 · 站段与侧栏车厢屏","macau-fold":"澳门 · 蓝黄折返车厢屏","wayfinding":"黑黄 · 双语大字导视屏"});
  const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
  const fail=message=>{throw Error(message);};
  const text=(v,max=400)=>{if(typeof v!=="string"||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v))fail("模板文字无效");return v;};
  function fields(v,keys){if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k)))fail("模板含未知字段，请使用本站 JSON 模板格式");}
  const color=v=>typeof v==="string"&&/^#[0-9a-f]{6}$/iu.test(v)?v:fail("颜色须为六位十六进制值，如 #ffffff");
  function normalize(value){
    fields(value,["schema","title","family","author","license","sourceUrl","style"]);
    if(value.schema!==schema)fail("模板格式不匹配，请先下载本站模板 JSON 作为示例");
    if(!Object.hasOwn(families,value.family))fail("不支持的线路显示版式");
    const title=text(value.title,100).trim();if(!title)fail("请填写模板名称");
    fields(value.style,["background","text","muted","accent","columns","shape","busLayout","screenLayout"]);
    const s=value.style,columns=s.columns??8,shape=s.shape??"round";
    if(!Number.isInteger(columns)||columns<4||columns>16)fail("每行站点数须为 4–16");
    if(!["round","square"].includes(shape))fail("站点符号无效");
    if(s.busLayout!==undefined&&(value.family!=="bus-stop"||!Object.hasOwn(busLayouts,s.busLayout)))fail("公交站牌布局无效");
    if(s.screenLayout!==undefined&&(!["bus-interior","metro-led","metro-lcd"].includes(value.family)||!Object.hasOwn(screenLayouts,s.screenLayout)))fail("车厢线路屏布局无效");
    const sourceUrl=text(value.sourceUrl??"",2048);
    if(sourceUrl){let u;try{u=new URL(sourceUrl);}catch{fail("来源链接无效");}if(!["https:","http:"].includes(u.protocol)||u.username||u.password)fail("来源链接须为公开 HTTP(S) 地址");}
    return {schema,title,family:value.family,author:text(value.author??"",120),license:text(value.license??"",200),sourceUrl,
      style:{background:color(s.background),text:color(s.text),muted:color(s.muted),accent:s.accent==="route"?"route":color(s.accent),columns,shape,...(value.family==="bus-stop"?{busLayout:s.busLayout||"strip"}:{}),...(s.screenLayout||value.family==="bus-interior"?{screenLayout:s.screenLayout||"alternating"}:{})}};
  }
  const builtin=(id,title,family,background,foreground,muted,accent,columns=8,shape="round",busLayout,screenLayout)=>({id,template:normalize({schema,title,family,author:"华域地图",license:"原创通用版式，随项目使用",sourceUrl:"",style:{background,text:foreground,muted,accent,columns,shape,...(busLayout?{busLayout}:{}),...(screenLayout?{screenLayout}:{})}})});
  const builtins=[
    builtin("bus-stop-green","绿白纵向灯箱站牌","bus-stop","#ffffff","#173b32","#677b73","#16805b",8,"round","column"),
    builtin("bus-stop-red","红白横排竖写站牌","bus-stop","#fffdf9","#392b26","#85756e","#b63637"),
    builtin("bus-amber","琥珀色车载电子路牌","bus-rollsign","#11140f","#ffb846","#c59343","#ffb846"),
    builtin("bus-white","白字车载电子路牌","bus-rollsign","#111719","#ffffff","#8da5a8","#ffffff"),
    builtin("metro-guide","白底彩带地铁导视","metro-guide","#ffffff","#202a34","#74808e","route"),
    builtin("metro-guide-blue","深蓝地铁导视","metro-guide","#102b4d","#ffffff","#bacbdc","route"),
    builtin("metro-led","黑底双色 LED 线路屏","metro-led","#111816","#e7f4e9","#7c9283","#4bd477",10,"square"),
    builtin("metro-lcd","浅色 LCD 动态信息版式","metro-lcd","#f1f5f8","#192937","#6b7c8b","route",8),
    builtin("bus-stop-pole","蓝白杆挂横式站牌","bus-stop","#ffffff","#173450","#637381","#235b92",12,"round","pole"),
    builtin("bus-stop-lcd","LCD 站台到站信息屏","bus-stop","#f2f6f8","#173146","#536d7c","#146b8a",12,"round","lcd"),
    builtin("bus-stop-led","LED 站台到站预报屏","bus-stop","#10150f","#ffc861","#b69e6c","#ffd36b",12,"square","led"),
    builtin("bus-stop-ink","黑白电子墨水站牌","bus-stop","#ffffff","#171b1a","#606560","#171b1a",12,"round","ink"),
    builtin("bus-stop-compact","米白紧凑横条站牌","bus-stop","#fffcf3","#302f29","#736f60","#71623b",12,"round","compact"),
    builtin("bus-stop-split","青白左右分区灯箱","bus-stop","#ffffff","#183d3c","#647c79","#167c7b",10,"round","split"),
    builtin("bus-stop-wide","深色横屏多线路看板","bus-stop","#14232d","#f4f7f8","#acbdc6","#79d4cc",10,"round","wide"),
    builtin("bus-stop-cards","蓝白双列分卡电子牌","bus-stop","#ffffff","#243d58","#697b91","#305c93",6,"square","cards"),
    builtin("bus-stop-hub","橙白公交枢纽索引牌","bus-stop","#fffdf9","#363329","#7b776c","#a65a18",12,"round","hub"),
    builtin("bus-stop-bilingual","紫白横写双语线路牌","bus-stop","#ffffff","#362d4d","#7b7288","#70538e",8,"round","bilingual")
  ];
  for(const [id,title,family,layout,dark] of [
    ["bus-interior-marquee","公交 · 琥珀 LED 全线走马灯","bus-interior","marquee",true],
    ["bus-interior-alternating","公交 · 上下交错全线条屏","bus-interior","alternating",true],
    ["bus-interior-diagonal","公交 · 斜排站名宽条屏","bus-interior","diagonal",false],
    ["bus-interior-return","公交 · 双行折返 LCD 全线屏","bus-interior","return",false],
    ["bus-interior-loop","公交 · 闭合回接 LED 全线屏","bus-interior","loop",true],
    ["bus-interior-focus","公交 · 邻站放大与全线总览","bus-interior","focus",false],
    ["metro-lcd-diagonal","地铁 · 斜排站名 LCD 条屏","metro-lcd","diagonal",false],
    ["metro-lcd-return","地铁 · 双行折返 LCD 条屏","metro-lcd","return",false],
    ["metro-led-loop","地铁 · 闭合回接 LED 条屏","metro-led","loop",true],
    ["metro-lcd-focus","地铁 · 邻站放大与全线总览","metro-lcd","focus",false]
  ])builtins.push(builtin(id,title,family,dark?"#101917":"#f7faf9",dark?"#f2f6ef":"#203c40",dark?"#889a8e":"#6c8182",layout==="marquee"?"#ffc66b":"route",12,"round",undefined,layout));
  builtins.push(builtin("bus-stop-gaoyang","高阳 · 黑黄多线路站牌","bus-stop","#08090b","#ffffff","#aeb2b8","#ffbf24",12,"round","gaoyang"));
  builtins.push(builtin("bus-stop-gaoyang-detail","高阳 · 线路地图与发车表","bus-stop","#08090b","#ffffff","#aeb2b8","#ffbf24",12,"round","gaoyang-detail"));
  builtins.push(builtin("bus-stop-wuxi","无锡 · 黑站头红白灯箱","bus-stop","#fdfdfb","#242428","#72777c","#c62e35",12,"round","wuxi"));
  builtins.push(builtin("bus-stop-mint","薄荷绿 · 圆角线路与定位针","bus-stop","#edf6ef","#203b32","#60796e","#368866",12,"round","mint"));
  builtins.push(builtin("bus-stop-chengdu","成都 · 右栏到站电子牌","bus-stop","#e5f3f2","#153f45","#527a80","#298b9b",12,"round","chengdu"));
  builtins.push(builtin("bus-stop-shenzhen","深圳 · 蓝底黄条本站牌","bus-stop","#0f437c","#ffffff","#afcbe0","#ffda56",12,"round","shenzhen"));
  builtins.push(builtin("bus-stop-shanghai","上海 · 双列纸质线路卡","bus-stop","#faf9f5","#272e35","#6a747b","#b53a43",12,"round","shanghai"));
  builtins.push(builtin("bus-stop-qingdao","青岛 · 蓝白杆挂叠牌","bus-stop","#ffffff","#20344c","#607489","#2264a3",12,"round","qingdao"));
  builtins.push(builtin("bus-stop-weifang","潍坊 · 大箭头纸质站牌","bus-stop","#fffef8","#222b32","#67767f","#23699b",12,"round","weifang"));
  builtins.push(builtin("bus-stop-lanzhou","兰州 · 运营公司分组横牌","bus-stop","#e7f1ec","#253b3a","#60776f","#c63538",12,"round","lanzhou"));
  builtins.push(builtin("bus-stop-wuhan","武汉 · 红号方向箭头横牌","bus-stop","#ffffff","#282d34","#737780","#c5343d",12,"round","wuhan"));
  builtins.push(builtin("bus-stop-chongqing","重庆 · 斜排站序到站分栏","bus-stop","#f0f6fb","#213b57","#6a7c92","#3165a1",12,"round","chongqing"));
  builtins.push(builtin("bus-stop-chengmai","澄迈 · 绿白方向与黄底道路条","bus-stop","#f6faf4","#244734","#6c8172","#3e8b4a",12,"round","chengmai"));
  builtins.push(builtin("bus-stop-xiamen","厦门 · 重点线路与发车卡阵","bus-stop","#f2f7fa","#1e3d53","#617c8d","#17749b",12,"round","xiamen"));
  builtins.push(builtin("metro-screen-nanjing","南京 · 蓝顶下一站斜排屏","metro-lcd","#f7fafb","#23354a","#708092","#256ca6",12,"round",undefined,"nanjing"));
  builtins.push(builtin("metro-screen-chongqing-screen","重庆 · 黄顶红绿站灯屏","metro-led","#fcfbef","#292b2a","#848785","#d5a52a",12,"round",undefined,"chongqing-screen"));
  builtins.push(builtin("metro-screen-wuxi-screen","无锡 · 园林拱灯双页屏","metro-lcd","#fffdfb","#33353a","#84828a","#ba3747",12,"round",undefined,"wuxi-screen"));
  builtins.push(builtin("metro-screen-fuzhou","福州 · 蓝白快线站序屏","metro-lcd","#eef7fd","#243e5b","#798fa5","#298bc5",12,"round",undefined,"fuzhou"));
  builtins.push(builtin("metro-screen-platform","站台 · 邻站与开门信息屏","metro-lcd","#faf9f6","#34393b","#7d8385","#b64a43",12,"round",undefined,"platform"));
  builtins.push(builtin("metro-screen-ningbo","宁波 · 底部彩带斜排屏","metro-lcd","#fbfbf8","#303a3a","#798786","#419777",12,"round",undefined,"ningbo"));
  builtins.push(builtin("metro-screen-suzhou","苏州 · 弧顶邻站放大屏","metro-lcd","#fcf8fb","#413947","#87788d","#ae628d",12,"round",undefined,"suzhou"));
  builtins.push(builtin("bus-interior-songjiang","松江 · 粉色三站放大车厢屏","bus-interior","#fff6f8","#442c3d","#987d8c","#bd5f8d",12,"round",undefined,"songjiang"));
  builtins.push(builtin("bus-interior-macau","澳门 · 站段与侧栏车厢屏","bus-interior","#f6f9fa","#244450","#7b9197","#278b99",12,"round",undefined,"macau"));
  builtins.push(builtin("bus-interior-macau-fold","澳门 · 蓝黄折返车厢屏","bus-interior","#fffdf4","#203b57","#7b8996","#286ba1",12,"round",undefined,"macau-fold"));
  builtins.push(builtin("metro-screen-wayfinding","黑黄 · 双语大字导视屏","metro-lcd","#101216","#ffffff","#adb5bf","#ffd049",12,"round",undefined,"wayfinding"));
  function parse(input){
    let v;try{v=typeof input==="string"?JSON.parse(input.replace(/^\uFEFF/u,"")):input;}catch{fail("JSON 无法解析");}
    if(Array.isArray(v)){
      if(!v.length||v.some((p,i)=>p?.templateSchema!==schema||typeof p.template!=="string"||(p.part!==undefined?p.part!==i:v.length!==1)))fail("不是完整的线路显示模板数据包");
      try{v=JSON.parse(v.map(p=>p.template).join(""));}catch{fail("共享模板内容无法解析");}
    }else if(v?.data?.records){
      const records=v.data.records;
      return parse(records.map(p=>p.properties));
    }
    return normalize(v);
  }
  function packageRecords(value){const t=normalize(value),json=JSON.stringify(t),records=[];for(let i=0;i<json.length;i+=1800)records.push({name:t.title,templateSchema:schema,part:records.length,template:json.slice(i,i+1800)});return records;}
  const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
  const transferKind=value=>{
    const type=typeof value==="object"?String(value?.type||""):"",label=typeof value==="object"?String(value?.label||value?.ref||""):String(value||"");
    if(type)return {subway:"地铁",light_rail:"轻轨",tram:"有轨电车",monorail:"单轨",train:"铁路",rail:"铁路",aircraft:"航空",flight:"航空",airplane:"航空",ferry:"轮渡"}[type]||"";
    return /地铁|metro|subway/iu.test(label)?"地铁":/轻轨|light.rail/iu.test(label)?"轻轨":/铁路|火车|高铁|城际|railway|\btrain\b/iu.test(label)?"铁路":/航空|飞机|机场换乘|flight/iu.test(label)?"航空":/轮渡|ferry/iu.test(label)?"轮渡":"";
  };
  function busTransfers(values){return (values||[]).filter(v=>transferKind(v)).map(v=>typeof v==="object"?transferKind(v)+" "+String(v.label||v.ref||""):String(v));}
  const signHints=stop=>[...new Set([...(stop.transfers||[]).map(transferKind).filter(Boolean),...(stop.facilities||[]).map(v=>v==="hospital"?"医":v==="school"?"学":"").filter(Boolean)])].join(" · ");
  function busStops(stops){return stops.map(stop=>({...stop,transfers:busTransfers(stop.transfers),facilities:stop.facilities||[]}));}
  function transferBadges(stop,x,y,maxWidth=120,size=14,align='middle'){
    const badges=stop?.transferBadges?.length?stop.transferBadges:(stop?.transfers||[]).map(label=>({label}));
    if(!badges.length)return '';
    const values=[...new Map(badges.map(b=>{const label=String(b.label||b.ref||''),ref=String(b.ref||'').trim()||label.match(/(?:^|[ ·])([A-Za-z]*\d+[A-Za-z]*)(?:\s*号线|[ ·]|$)/u)?.[1]||label.replace(/^(?:地铁|轻轨|单轨|有轨电车)\s*/u,'').replace(/\s*号线$/u,'');return [b.identity||ref+'|'+b.color,{...b,label,ref}];})).values()];
    const gap=3,h=size+9,rows=[[]];let used=0;
    for(const b of values){const w=Math.min(maxWidth,Math.max(h,units(b.ref)*size+12));if(used&&used+gap+w>maxWidth){rows.push([]);used=0;}rows.at(-1).push({...b,w});used+=w+gap;}
    return rows.map((row,r)=>{const width=row.reduce((a,b)=>a+b.w,0)+gap*(row.length-1);let left=align==='start'?x:align==='end'?x-width:x-width/2;
      return row.map(b=>{const w=b.w,c=/^#[0-9a-f]{6}$/iu.test(b.color||'')?b.color:'#6d797f',rgb=c.slice(1).match(/../gu).map(v=>parseInt(v,16)),ink=rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>165?'#16242b':'#ffffff',cx=left+w/2,top=y-(rows.length-1-r)*(h+3);
        const mark='<g data-transfer-badge="true" data-transfer-ref="'+esc(b.ref)+'"><title>'+esc(b.label)+'</title><rect x="'+left+'" y="'+top+'" width="'+w+'" height="'+h+'" rx="3" fill="'+esc(c)+'"/><text x="'+cx+'" y="'+(top+size+3)+'" text-anchor="middle" font-size="'+size+'" font-weight="700" fill="'+ink+'"'+(units(b.ref)*size>w-5?' textLength="'+Math.max(1,w-5)+'" lengthAdjust="spacingAndGlyphs"':'')+'>'+esc(b.ref)+'</text></g>';left+=w+gap;return mark;}).join('');}).join('');
  }
  function coordinate(s){const lat=s.lat,lon=s.lon??s.lng;return typeof lat==="number"&&typeof lon==="number"&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=85&&Math.abs(lon)<=180?{lat,lon}:{};}

  const railModes=new Set(['subway','light_rail','monorail','tram','train']);
  const stopRefs=s=>[s.sourceId,...s.memberSourceIds||[]].filter(v=>/^(node|way|relation)\/[1-9]\d*$/u.test(v||''));
  function sameStop(a,b){
    const refs=new Set(stopRefs(a));
    return stopRefs(b).some(v=>refs.has(v))||(a.stopAreaIds||[]).some(v=>(b.stopAreaIds||[]).includes(v));
  }
  // Only explicit endpoint identities connect a manual through journey. Names and proximity never do.
  function connectThroughRoute(base,extension,{attach='end',reverse=false}={}){
    if(!base?.stops?.length||!extension?.stops?.length||!railModes.has(base.type)||!railModes.has(extension.type))fail('请读取两条完整轨道线路后再拼接');
    if(base.overview||extension.overview||base.roundtrip||extension.roundtrip)fail('贯通拼接请选择非环线的具体方向，不使用分支全线总览');
    if(!['start','end'].includes(attach)||typeof reverse!=='boolean')fail('贯通拼接方向无效');
    const used=base.throughRoute?.segments||[{sourceId:base.sourceId,ref:base.ref,name:base.title,color:base.color,fromIndex:0,toIndex:base.stops.length-1,reverse:false,from:base.from,to:base.to,sourceTime:base.sourceTime||null,fetchedAt:base.fetchedAt||null}];
    if(used.length>=21)fail('贯通最多接入20个方向');
    if(!/^relation\/[1-9]\d*$/u.test(extension.sourceId||'')||used.some(v=>v.sourceId===extension.sourceId)||extension.stops.length<2)fail('请选择另一条未加入的完整真实方向');
    const added=reverse?[...extension.stops].reverse():extension.stops;
    const a=attach==='end'?base.stops.at(-1):added.at(-1),b=attach==='end'?added[0]:base.stops[0];
    const shared=sameStop(a,b),baseEnds=base.trackEndpointIds||[],extensionEnds=reverse?[...(extension.trackEndpointIds||[])].reverse():extension.trackEndpointIds||[];
    const linked=[baseEnds,extensionEnds].every(v=>v.length===2&&v.every(id=>/^node\/[1-9]\d*$/u.test(id)))&&(attach==='end'?baseEnds[1]===extensionEnds[0]:extensionEnds[1]===baseEnds[0]);
    if(!shared&&!linked)fail('首末站没有共同站点、stop_area 或原始轨道端点，不能拼接；同名或相邻不代表相连');
    const merged={...a,memberSourceIds:[...new Set([...stopRefs(a),...stopRefs(b)])],stopAreaIds:[...new Set([...a.stopAreaIds||[],...b.stopAreaIds||[]])],
      transfers:[...new Map([...a.transfers||[],...b.transfers||[]].map(v=>[typeof v==='object'?v.identity||v.ref||v.label:v,v])).values()]};
    const stops=shared?(attach==='end'?[...base.stops.slice(0,-1),merged,...added.slice(1)]:[...added.slice(0,-1),merged,...base.stops.slice(1)]):(attach==='end'?[...base.stops,...added]:[...added,...base.stops]);
    const offset=added.length-(shared?1:0),segment={sourceId:extension.sourceId,ref:extension.ref||'',name:extension.title||'',color:/^#[0-9a-f]{6}$/iu.test(extension.color||'')?extension.color:'#6d797f',reverse,from:extension.from||'',to:extension.to||'',sourceTime:extension.sourceTime||null,fetchedAt:extension.fetchedAt||null,fromIndex:attach==='end'?base.stops.length-1:0,toIndex:attach==='end'?stops.length-1:offset};
    const segments=attach==='end'?[...used,segment]:[segment,...used.map(v=>({...v,fromIndex:v.fromIndex+offset,toIndex:v.toIndex+offset}))];
    const junction={stationId:shared?merged.sourceId:null,trackNodeId:linked?(attach==='end'?baseEnds[1]:baseEnds[0]):null,name:shared?merged.name:a.name+' → '+b.name,extensionId:extension.sourceId,attach,reverse};
    return {...base,stops,trackEndpointIds:baseEnds.length===2&&extensionEnds.length===2?(attach==='end'?[baseEnds[0],extensionEnds[1]]:[extensionEnds[0],baseEnds[1]]):[],throughServices:[],operatingPattern:null,geography:null,
      throughRoute:{manual:true,segments,junctions:[...base.throughRoute?.junctions||[],junction]},
      source:base.source,roundtrip:false};
  }
  function throughConnectionOptions(base,routes=[]){
    const result=[];
    for(const route of routes)for(const attach of ['end','start'])for(const reverse of [false,true]){
      try{connectThroughRoute(base,route,{attach,reverse});result.push({lineSourceId:route.sourceId,attach,reverse,ref:route.ref||'',title:route.title||''});}catch{}
    }
    return result;
  }
  function rangeIndexes(route,from,to){
    const indexes=[];for(let i=from;;i=(i+1)%route.stops.length){indexes.push(i);if(i===to)return indexes;if(indexes.length>=route.stops.length)fail('运行区间无效');}
  }
  function normalizeOperatingPattern(route,value){
    if(value===null||value===undefined)return null;
    if(!plain(value)||Object.keys(value).some(k=>!['name','fromIndex','toIndex','skipIndexes','manual'].includes(k))||!railModes.has(route.type))fail('运行交路参数无效');
    const index=v=>(typeof v==='number'||typeof v==='string'&&/^\d+$/u.test(v))&&Number.isInteger(Number(v))&&Number(v)>=0&&Number(v)<route.stops.length;
    const fromIndex=Number(value.fromIndex),toIndex=Number(value.toIndex),name=String(value.name||'本次交路').trim();
    if(!index(value.fromIndex)||!index(value.toIndex)||fromIndex===toIndex||!route.roundtrip&&fromIndex>toIndex||!name||name.length>80)fail('请选择有效的顺向交路起止站，环线可以跨首尾');
    const skip=value.skipIndexes||[],range=rangeIndexes(route,fromIndex,toIndex);
    if(!Array.isArray(skip)||skip.some(v=>!index(v))||new Set(skip.map(Number)).size!==skip.length)fail('跳停站索引无效或重复');
    const skipIndexes=skip.map(Number).sort((a,b)=>a-b);
    if(skipIndexes.some(v=>!range.includes(v)||v===fromIndex||v===toIndex))fail('只可跳停运行区间内部站点，起终站必须停靠');
    return {name,fromIndex,toIndex,skipIndexes,manual:true};
  }
  function stopState(route,index){
    const p=route.operatingPattern;if(!p)return 'stopping';
    if(!rangeIndexes(route,p.fromIndex,p.toIndex).includes(index))return 'outside';
    return p.skipIndexes.includes(index)?'skipped':'stopping';
  }
  function nextStoppingIndex(route,stops,current){
    if(current<0)return -1;
    const p=route.operatingPattern;
    if(p&&current===p.toIndex)return -1;
    for(let step=1;step<=stops.length;step++){
      let i=current+step;
      if(i>=stops.length){if(!route.roundtrip)return -1;i%=stops.length;}
      const repeated=stops.length>1&&stops[0].sourceId&&stops[0].sourceId===stops.at(-1).sourceId;
      if(repeated&&current===stops.length-1&&i===0)continue;
      if(stopState(route,i)==='stopping')return i;
      if(p&&i===p.toIndex)return -1;
    }
    return -1;
  }
  function withOperatingPattern(result,data){
    if(!data.operatingPattern)return result;
    const pattern=data.operatingPattern;
    function append(svg){
      const filtered=svg.replace(/<g (data-(?:stop|focus-stop)-index)="(\d+)">/gu,(all,attribute,index)=>{
        const state=stopState(data,Number(index));
        return '<g '+attribute+'="'+index+'" data-stop-state="'+state+'"'+(state==='stopping'?'':' filter="url(#huayu-inactive-stop)"')+'>';
      });
      const inactive=data.stops.map((s,i)=>({name:s.name,index:i,state:stopState(data,i)})).filter(s=>s.state!=='stopping');
      const body='<defs><filter id="huayu-inactive-stop" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter></defs><metadata data-operating-pattern="true">'+esc(JSON.stringify({operatingPattern:pattern,inactiveStops:inactive,throughRoute:data.throughRoute||null,manualPreview:true,realtime:false}))+'</metadata>';
      return filtered.replace(/<\/svg>\s*$/u,body+'</svg>');
    }
    return {...result,svg:append(result.svg),...(result.motionSvg?{motionSvg:append(result.motionSvg)}:{}),operatingPattern:pattern,stoppingIndexes:data.stops.flatMap((_,i)=>stopState(data,i)==='stopping'?[i]:[])};
  }
  const diagramServices=data=>[...(data.throughRoute?.segments||[]).map(v=>({...v,ref:v.ref||v.name||v.sourceId})),...data.throughServices||[]];

  function normalizeThroughServices(route,values=[]){
    if(!Array.isArray(values)||values.length>20)fail('贯通运行区间最多设置20项');
    if(values.length&&!['subway','light_rail','monorail','tram','train'].includes(route.type))fail('贯通运行标注仅用于轨道线路');
    return values.map(v=>{
      if(!plain(v)||Object.keys(v).some(k=>!['ref','name','color','fromIndex','toIndex','manual'].includes(k)))fail('贯通运行参数无效');
      const fromIndex=Number(v.fromIndex),toIndex=Number(v.toIndex),ref=String(v.ref||'').trim(),name=String(v.name||ref).trim(),color=String(v.color||'#6d797f');
      if(!ref||ref.length>40||name.length>120||!/^#[0-9a-f]{6}$/iu.test(color)||![fromIndex,toIndex].every(i=>Number.isInteger(i)&&i>=0&&i<route.stops.length)||fromIndex===toIndex||!route.roundtrip&&fromIndex>toIndex)fail('请填写贯通线路编号、颜色及有效的顺向运行区间');
      return {ref,name,color,fromIndex,toIndex,manual:true};
    });
  }
  function throughIntervals(out,data,stops,positions,width){
    if(data.throughRoute?.segments?.length){
      const paths=[];
      for(const segment of data.throughRoute.segments)for(let i=segment.fromIndex+1;i<=segment.toIndex;i++){
        const a=positions[i-1],b=positions[i];if(!a||!b)continue;
        const d=a.y===b.y?'M '+a.x+' '+a.y+' H '+b.x:foldedJoin(a,b,a.x>width/2?width-32:32);
        paths.push('<path data-line-to="'+i+'" data-through-line-source="'+esc(segment.sourceId)+'" d="'+d+'" fill="none" stroke="'+esc(segment.color||data.color)+'" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>');
      }
      for(const path of paths){const index=Number(path.match(/data-line-to="(\d+)"/u)?.[1]),a=positions[index-1],b=positions[index];
        const row=a.y===b.y?positions.findIndex(p=>p?.y===a.y):-1,at=row<0?-1:out.findIndex(v=>v.startsWith('<g data-stop-index="'+row+'"'));
        out.splice(at<0?out.length:at,0,path);
      }
    }

    for(const [j,service]of diagramServices(data).entries()){
      const indexes=[];for(let i=service.fromIndex;;i=(i+1)%stops.length){indexes.push(i);if(i===service.toIndex)break;if(indexes.length>stops.length)break;}
      out.push('<g data-through-track="'+esc(service.ref)+'"><title>'+esc('贯通 '+service.ref+' · '+stops[service.fromIndex].name+' → '+stops[service.toIndex].name)+'</title>');
      for(let k=1;k<indexes.length;k++){
        const a=positions[indexes[k-1]],b=positions[indexes[k]];if(!a||!b)continue;const offset=16+(j%4)*7,p={x:a.x,y:a.y-offset},q={x:b.x,y:b.y-offset};
        if(indexes[k]<indexes[k-1]){loopPath(out,p,q,26,width-26,Math.min(...positions.filter(Boolean).map(p=>p.y))-38-j*7,service.color,3);continue;}
        const d=p.y===q.y?'M '+p.x+' '+p.y+' H '+q.x:foldedJoin(p,q,p.x>width/2?width-28:28);
        out.push('<path d="'+d+'" fill="none" stroke="'+esc(service.color)+'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');
      }out.push('</g>');
    }
  }
  function withThroughServices(result,data,template){
    const services=diagramServices(data);if(!services.length)return result;
    function append(svg){
      const h=Number(svg.match(/<svg[^>]*\bheight="([\d.]+)"/u)?.[1]);if(!h)return svg;const extra=52+services.length*67,w=result.width;
      let body='<g data-through-services="true" font-family="Microsoft YaHei,system-ui,sans-serif"><rect x="0" y="'+h+'" width="'+w+'" height="'+extra+'" fill="'+esc(template.style.background)+'"/><text x="34" y="'+(h+34)+'" font-size="23" font-weight="700" fill="'+esc(template.style.text)+'">贯通运营 · 运行区间</text>';
      for(const [i,v]of services.entries()){
        const y=h+49+i*67,a=data.stops[v.fromIndex],b=data.stops[v.toIndex],label=v.name===v.ref?v.ref:v.ref+' · '+v.name;
        body+='<g data-through-interval="'+esc(v.ref)+'"><title>'+esc(label+' · 用户设置，仅用于本页线路图')+'</title><rect x="34" y="'+y+'" width="146" height="42" rx="5" fill="'+esc(v.color)+'"/><text x="107" y="'+(y+29)+'" text-anchor="middle" font-size="23" font-weight="700" fill="#ffffff" textLength="'+Math.min(126,Math.max(25,units(v.ref)*23))+'" lengthAdjust="spacingAndGlyphs">'+esc(v.ref)+'</text><text x="202" y="'+(y+29)+'" font-size="22" fill="'+esc(template.style.text)+'" textLength="'+Math.min(w-520,Math.max(90,units(a.name+' → '+b.name)*22))+'" lengthAdjust="spacingAndGlyphs">'+esc(a.name+' → '+b.name)+'</text>';
        const x=w-277,length=230,start=v.fromIndex/(data.stops.length-1)*length,end=v.toIndex/(data.stops.length-1)*length;
        body+='<path d="M '+x+' '+(y+21)+' h '+length+'" stroke="#d0d7da" stroke-width="5"/>';
        const mark=(a,b)=>'<path d="M '+(x+a)+' '+(y+21)+' H '+(x+b)+'" stroke="'+esc(v.color)+'" stroke-width="8"/>';
        body+=v.toIndex>v.fromIndex?mark(start,end):mark(start,length)+mark(0,end);body+='</g>';
      }
      body+='</g><metadata>'+esc(JSON.stringify({throughServices:services,manualPreview:true,sourceId:data.sourceId}))+'</metadata>';
      return svg.replace(/(<svg[^>]*\bheight=")[\d.]+"/u,'$1'+(h+extra)+'"').replace(/(<svg[^>]*\bviewBox="0 0 [\d.]+ )[\d.]+"/u,'$1'+(h+extra)+'"').replace(/<\/svg>\s*$/u,body+'</svg>');
    }
    return {...result,svg:append(result.svg),...(result.motionSvg?{motionSvg:append(result.motionSvg)}:{}),height:result.height+52+services.length*67,throughServices:services};
  }
  function line(value){
    if(!plain(value)||!Array.isArray(value.stops)||!value.stops.length)fail("请先选择一条已读取站序的线路");
    return {type:String(value.type||""),relationKind:String(value.relationKind||""),title:String(value.title||"未命名线路"),ref:String(value.ref||""),color:/^#[0-9a-f]{6}$/iu.test(value.color||"")?value.color:"#326da6",
      from:String(value.from||"").trim(),to:String(value.to||"").trim(),endpointState:String(value.endpointState||""),
      throughRoute:value.throughRoute||null,operatingPattern:normalizeOperatingPattern(value,value.operatingPattern),throughServices:normalizeThroughServices(value,value.throughServices||[]),orderBasis:value.orderBasis||'',orderWarning:value.orderWarning||'',geography:value.geography||null,passenger:value.passenger||{},simulation:value.simulation||null,serviceNote:String(value.serviceNote||""),serviceSources:value.serviceSources||{},service:Object.fromEntries(["hours","first","last","fare","operator","interval","departures"].map(key=>[key,String(value.service?.[key]||"")])),
      roundtrip:typeof value.roundtrip==="boolean"?value.roundtrip:/(?:循环|环线|环城|环状|环形)|\b(?:circle|circular|loop|ring)\b/iu.test(value.title||""),demo:Boolean(value.demo),source:String(value.source||"OpenGeofiction 当前线路关系"),sourceId:String(value.sourceId||""),
      stops:value.stops.map(s=>({sourceId:String(s.sourceId||""),memberSourceIds:stopRefs(s),stopAreaIds:s.stopAreaIds||[],...coordinate(s),street:String(s.street||s.tags?.["addr:street"]||""),name:String(s.name||"未命名站点"),nameEn:String(s.nameEn||""),transferBadges:(s.transferBadges||s.transfers||[]).filter(v=>typeof v==="object"&&v).map(v=>({ref:String(v.ref||""),identity:String(v.identity||v.sourceId||""),label:String(v.label||v.ref||v.type||""),color:/^#[0-9a-f]{6}$/iu.test(v.color||"")?v.color:null})),facilities:[...new Set([...(s.facilities||[]),...(["hospital","school","university","college","kindergarten"].includes(s.tags?.amenity)?[s.tags.amenity==="hospital"?"hospital":"school"]:[])])].filter(v=>["hospital","school"].includes(v)),transfers:(value.type==="bus"?busTransfers(s.transfers):(s.transfers||[]).map(v=>typeof v==="object"?String(v.label||v.ref||v.type||""):String(v)))}))};
  }

  const clockMinutes=value=>{const m=String(value||'').match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u);return m?Number(m[1])*60+Number(m[2]):null;};
  const clockText=minutes=>String(Math.floor(((minutes%1440)+1440)%1440/60)).padStart(2,'0')+':'+String(((Math.round(minutes)%60)+60)%60).padStart(2,'0');
  function intervalMinutes(value){
    const text=String(value||'').trim(),iso=text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/iu),clock=text.match(/^(\d{1,2}):([0-5]\d)$/u);
    if(iso)return Math.max(1,Number(iso[1]||0)*60+Number(iso[2]||0));if(clock)return Math.max(1,Number(clock[1])*60+Number(clock[2]));
    const m=text.match(/^(?:每\s*)?(\d+(?:\.\d+)?)\s*(?:[-–—~至]\s*(\d+(?:\.\d+)?))?\s*(小时|hours?|h|分钟|分|minutes?|mins?|m)?(?:\s*一班)?$/iu);
    return m?Math.max(1,(Number(m[1])+Number(m[2]||m[1]))/2*(/小时|hour|^h$/iu.test(m[3]||'')?60:1)):null;
  }
  function simulateService(route,{enabled=false,seed=0,now=Date.now(),current=0}={}){
    const data=line(route);if(!enabled)return data;
    const date=new Date(now);if(!Number.isFinite(date.getTime()))fail('模拟参考时间无效');
    const raw={...data.service},service={...raw},generatedFields=[];
    const random=key=>{let h=2166136261;for(const c of String(seed)+'|'+data.sourceId+'|'+data.title+'|'+key){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return (h>>>0)/4294967296;};
    const pick=(key,values)=>values[Math.floor(random(key)*values.length)];
    const put=(key,value)=>{if(!service[key]?.trim()){service[key]=value;generatedFields.push(key);}};
    const hoursClocks=[...String(raw.hours).matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)].map(m=>Number(m[1])*60+Number(m[2]));
    const timetable=[...String(raw.departures).matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)].map(m=>Number(m[1])*60+Number(m[2]));
    const first=clockMinutes(raw.first)??hoursClocks[0]??(timetable.length?Math.min(...timetable):pick('first',[330,345,360,375,390,405,420]));
    const last=clockMinutes(raw.last)??hoursClocks[1]??(timetable.length?Math.max(...timetable):pick('last',[1260,1290,1320,1350,1380,1410]));
    put('first',clockText(first)+'（模拟）');put('last',clockText(last)+'（模拟）');put('hours',clockText(first)+'–'+clockText(last)+'（模拟）');
    put('fare',pick('fare',['1','2','3','4'])+' 元（模拟）');put('operator','模拟运营单位 '+String(1+Math.floor(random('operator')*99)).padStart(2,'0'));
    let interval=intervalMinutes(raw.interval);if(!interval)interval=pick('interval',[6,8,10,12,15,20]);
    // A real exact timetable remains a timetable; do not turn it into a regular service.
    if(!raw.departures?.trim())put('interval',interval+' 分钟（模拟）');
    const offset=Math.max(0,Number.isInteger(current)?current:0)*pick('travel',[2,3]),times=[],baseDay=new Date(date.getFullYear(),date.getMonth(),date.getDate());
    const daily=raw.hours.trim()==='24/7'||/24小时/u.test(raw.hours),phase=Math.floor(random('phase')*Math.max(1,interval));
    const stamp=(day,minutes)=>new Date(baseDay.getFullYear(),baseDay.getMonth(),baseDay.getDate()+day,0,minutes).getTime();
    for(let day=-1;day<=3;day++){
      if(timetable.length){for(const m of timetable)times.push(stamp(day,m+offset));}
      else{const start=daily?0:first,end=daily?1440:last+(last<=first?1440:0);for(let m=start+phase;m<=end;m+=interval)times.push(stamp(day,Math.round(m)+offset));}
    }
    const upcoming=[...new Set(times)].filter(t=>t>=date.getTime()).sort((a,b)=>a-b),display=t=>{
      if(t===undefined)return {label:'本时段无模拟班次',at:null,minutes:null};const at=new Date(t),minutes=Math.ceil((t-date.getTime())/60000),nextDay=at.getDate()!==date.getDate()||at.getMonth()!==date.getMonth();
      return {at:at.toISOString(),minutes,label:(nextDay?'次日 ':'')+clockText(at.getHours()*60+at.getMinutes())+' · '+minutes+' 分钟（模拟）'};
    };
    if(!raw.departures?.trim()&&!raw.interval?.trim())put('departures',upcoming.slice(0,4).map(t=>{const d=new Date(t);return clockText(d.getHours()*60+d.getMinutes());}).join('、')+'（模拟节选）');
    return {...data,service,simulation:{generatedFields,referenceTime:date.toISOString(),basis:timetable.length?'时刻表＋模拟站间耗时':intervalMinutes(raw.interval)?'已标注班次间隔＋模拟相位':'随机班次间隔＋模拟相位',arrival:{next:display(upcoming[0]),following:display(upcoming[1])}},serviceNote:[data.serviceNote,'含模拟数据，非实时运营信息'].filter(Boolean).join('；')};
  }
  // Keep provenance in the model and metadata; artwork uses concise passenger text.
  const artworkText=value=>String(value).replaceAll('（模拟节选）','（节选）').replaceAll('（模拟）','').replace(/^模拟运营单位 /u,'运营单位 ').replaceAll('本时段无模拟班次','本时段无班次');
  function artworkService(route){
    const generated=new Set(route.simulation?.generatedFields||[]);
    return Object.fromEntries(Object.entries(route.service).map(([key,value])=>[key,generated.has(key)?artworkText(value):value]));
  }
  const arrivalText=(route,following=false)=>artworkText(route.simulation?.arrival?.[following?'following':'next']?.label||'未接入');

  const units=v=>[...String(v)].reduce((n,c)=>n+(/[\u0020-\u007e]/u.test(c)?0.56:1),0);
  function wrapService(v,width,size){const rows=[];let row="",n=0;for(const c of String(v)){if(c==="\r")continue;if(c==="\n"){rows.push(row);row="";n=0;continue;}const w=units(c)*size;if(row&&n+w>width){rows.push(row);row="";n=0;}row+=c;n+=w;}rows.push(row);return rows;}
  function busServiceRows(route,width,size){
    const s=artworkService(route),hours=(s.hours||"")+((s.first||s.last)?(s.hours?" · ":"")+"首班 "+(s.first||"未提供")+" / 末班 "+(s.last||"未提供"):"");
    const lines=["服务时间  "+(hours||"未提供"),"票价  "+(s.fare||"未提供")+((s.interval||!s.departures)?"   班次间隔  "+(s.interval||"未提供"):"")];
    if(s.departures)lines.push("发车时刻  "+s.departures);lines.push("运营方  "+(s.operator||"未提供"));
    return lines.flatMap(v=>wrapService(v,width,size));
  }
  const busNotice=route=>[route.demo?"示例线路 · 非真实运营数据":"",/用户补填/u.test(route.serviceNote)?"用户补填，未核验":""].filter(Boolean).join(" · ");
  const terminus=route=>route.displayTerminus??(route.operatingPattern?route.stops[route.operatingPattern.toIndex].name:route.throughRoute?(route.throughRoute.segments.at(-1).reverse?route.throughRoute.segments.at(-1).from:route.throughRoute.segments.at(-1).to)||"未提供":route.to||(route.endpointState==="choose-direction"?"请选择具体方向":"未提供"));
  const nextLabel=(route,stops,current)=>"下一站  "+busNext(route,stops,current);
  const busDirection=(route,stops=route.stops,current=-1)=>route.roundtrip?"终点站  "+(terminus(route,stops)||"未提供"):"开往  "+terminus(route,stops);
  function busNext(route,stops,current){
    if(current<0)return "未指定本站";
    const i=nextStoppingIndex(route,stops,current);if(i>=0)return stops[i].name;
    return route.operatingPattern&&current===route.operatingPattern.toIndex||terminus(route)!=="未提供"&&stops[current]?.name.normalize("NFKC").trim()===terminus(route).normalize("NFKC").trim()?"终点站":"未提供";
  }
  const busMetadata=(template,entries,board)=>'<metadata>'+esc(JSON.stringify({template:{title:template.title,author:template.author,license:template.license,sourceUrl:template.sourceUrl},routes:entries.map(e=>({source:e.route.source,sourceId:e.route.sourceId,title:e.route.title,from:e.route.from,to:e.route.to,roundtrip:e.route.roundtrip,service:e.route.service,serviceSources:e.route.serviceSources,serviceNote:e.route.serviceNote,orderBasis:e.route.orderBasis,orderWarning:e.route.orderWarning,throughServices:e.route.throughServices,throughRoute:e.route.throughRoute,operatingPattern:e.route.operatingPattern,geography:e.route.geography?{complete:e.route.geography.complete,sourceTime:e.route.geography.sourceTime,fetchedAt:e.route.geography.fetchedAt,roadCount:e.route.geography.roads.length,routeGeometry:Boolean(e.route.geography.routeWayIds?.length)}:null,simulation:e.route.simulation})),stationId:board?.stationId,complete:board?.complete||false,sourceTime:board?.sourceTime,manualPreview:true,realtime:false}))+'</metadata>';
  function routeSegment(out,x1,y1,x2,y2,color,width){out.push('<path data-route-segment="true" d="M '+x1+' '+y1+' L '+x2+' '+y2+'" fill="none" stroke="'+esc(color)+'" stroke-width="'+width+'" stroke-linecap="round"/>');}
  function foldedJoin(a,b,edge){
    const sign=edge>=a.x?1:-1,dy=b.y>=a.y?1:-1;
    const radius=Math.min(22,Math.abs(b.y-a.y)/2,Math.abs(edge-a.x),Math.abs(edge-b.x));
    return 'M '+a.x+' '+a.y+' H '+(edge-sign*radius)+' Q '+edge+' '+a.y+' '+edge+' '+(a.y+dy*radius)+' V '+(b.y-dy*radius)+' Q '+edge+' '+b.y+' '+(edge-sign*radius)+' '+b.y+' H '+b.x;
  }
  function loopPath(out,first,last,left,right,top,color,width){
    const d=first.y===last.y?'M '+last.x+' '+last.y+' C '+right+' '+last.y+' '+right+' '+top+' '+last.x+' '+top+' H '+first.x+' C '+left+' '+top+' '+left+' '+first.y+' '+first.x+' '+first.y:'M '+last.x+' '+last.y+' H '+(right-12)+' Q '+right+' '+last.y+' '+right+' '+(last.y-12)+' V '+(top+12)+' Q '+right+' '+top+' '+(right-12)+' '+top+' H '+(left+12)+' Q '+left+' '+top+' '+left+' '+(top+12)+' V '+(first.y-12)+' Q '+left+' '+first.y+' '+(left+12)+' '+first.y+' H '+first.x;
    const middle=(first.x+last.x)/2;
    out.push('<path data-loop-return="true" d="'+d+'" fill="none" stroke="'+esc(color)+'" stroke-width="'+width+'" stroke-linecap="round" stroke-linejoin="round"/><path data-route-direction="true" d="M '+(middle+7)+' '+(top-5)+' L '+(middle-2)+' '+top+' L '+(middle+7)+' '+(top+5)+'" fill="none" stroke="'+esc(color)+'" stroke-width="'+width+'"/>');
  }
  function verticalLoop(out,first,last,left,bottom,color,width){out.push('<path data-loop-return="true" d="M '+last.x+' '+last.y+' V '+(bottom-10)+' Q '+last.x+' '+bottom+' '+(last.x-10)+' '+bottom+' H '+(left+10)+' Q '+left+' '+bottom+' '+left+' '+(bottom-10)+' V '+(first.y+10)+' Q '+left+' '+first.y+' '+(left+10)+' '+first.y+' H '+first.x+'" fill="none" stroke="'+esc(color)+'" stroke-width="'+width+'" stroke-linecap="round" stroke-linejoin="round"/>');}
  // Ring stops occupy both sides of one perimeter, in source order.
  function loopDiagramPlan(stops,width,{vertical=false,size=24}={}){
    const half=Math.ceil(stops.length/2),other=stops.length-half;
    const horizontal=!vertical&&stops.length>=4&&half*Math.max(84,...stops.map(p=>Math.min(150,units(p.name)*size+12)))<=width-100;
    const labelWidth=horizontal?Math.max(48,(width-100)/Math.max(half,1)-14):(width-48)/2-48;
    const labels=stops.map(p=>({names:wrapService(p.name,labelWidth,size),english:p.nameEn?wrapService(p.nameEn,labelWidth,13):[],hint:signHints(p)}));
    const blocks=labels.map(p=>p.names.length*(size+6)+p.english.length*17+(p.hint?20:0));
    const maxBlock=Math.max(...blocks),pitch=Math.max(72,maxBlock+26),cap=Math.max(38,maxBlock/2+16);
    const left=24,right=width-24,top=16,bottom=horizontal?top+maxBlock*2+104:top+cap*2+Math.max(pitch,(half-1)*pitch);
    const positions=stops.map((p,i)=>{
      const first=i<half,k=first?i:i-half,count=first?half:other,t=count>1?k/(count-1):.5;
      return horizontal?{x:left+36+(first?t:1-t)*(right-left-72),y:first?top:bottom,side:first?'top':'bottom'}:{x:first?left:right,y:top+cap+(first?t:1-t)*(bottom-top-cap*2),side:first?'left':'right'};
    });
    return {positions,labels,blocks,size,labelWidth,left,right,top,bottom,horizontal,height:bottom+44};
  }
  function drawLoopDiagram(out,plan,{x,y,stops,current,color,background,text,muted,label,marker,openStop,highlight=false,pin=false}){
    const {left,right,top,bottom,size}=plan,r=24,l=x+left,h=x+right,t=y+top,b=y+bottom;
    out.push('<g data-loop-layout="'+(plan.horizontal?'horizontal':'vertical')+'">');
    out.push('<path data-route-segment="true" d="M '+l+' '+(t+r)+' V '+(b-r)+' Q '+l+' '+b+' '+(l+r)+' '+b+' H '+(h-r)+' Q '+h+' '+b+' '+h+' '+(b-r)+'" fill="none" stroke="'+esc(color)+'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>');
    out.push('<path data-loop-return="true" d="M '+h+' '+(b-r)+' V '+(t+r)+' Q '+h+' '+t+' '+(h-r)+' '+t+' H '+(l+r)+' Q '+l+' '+t+' '+l+' '+(t+r)+'" fill="none" stroke="'+esc(color)+'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>');
    const arrow=(px,py,rotation)=>out.push('<path data-loop-direction="true" d="M -7 -6 L 0 3 L 7 -6" transform="translate('+px+' '+py+') rotate('+rotation+')" fill="none" stroke="'+esc(color)+'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');
    // Arrows use a gap between markers, never cover an actual stop.
    const middleGap=side=>{const p=plan.positions.filter(p=>p.side===side);if(p.length>1){const i=Math.floor((p.length-1)/2);return {x:x+(p[i].x+p[i+1].x)/2,y:y+(p[i].y+p[i+1].y)/2};}return null;};
    if(plan.horizontal){for(const [side,rotation]of [['top',-90],['bottom',90]]){const p=middleGap(side);if(p)arrow(p.x,p.y,rotation);}}
    else{for(const [side,rotation]of [['left',0],['right',180]]){const p=middleGap(side);if(p)arrow(p.x,p.y,rotation);}}
    if(stops.length<4){arrow((l+h)/2,t,90);arrow((l+h)/2,b,-90);}
    stops.forEach((stop,i)=>{
      const p=plan.positions[i],px=x+p.x,py=y+p.y,active=i===current,detail=plan.labels[i],c=active?color:text;
      openStop(stop,i);out.push('<g data-loop-station-side="'+p.side+'" data-loop-x="'+px+'" data-loop-y="'+py+'">');
      if(marker)marker(px,py,i);else out.push('<circle cx="'+px+'" cy="'+py+'" r="'+(active?8:5)+'" fill="'+esc(active?color:background)+'" stroke="'+esc(color)+'" stroke-width="3"/>');
      if(active&&pin)out.push('<path data-current-pin="true" d="M '+px+' '+(py-7)+' q -22 -26 0 -32 q 22 6 0 32" fill="#ce4249"/>');
      const anchor=plan.horizontal?'middle':p.side==='left'?'start':'end',tx=plan.horizontal?px:px+(p.side==='left'?28:-28);
      let ty=plan.horizontal?(p.side==='top'?py+38:py-26-plan.blocks[i]+size):py-plan.blocks[i]/2+size;
      if(active){const ay=plan.horizontal?(p.side==='top'?py-12:py+29):ty-size-10;label('本站',tx,ay,14,color,plan.labelWidth,'text-anchor="'+anchor+'" font-weight="700"');}
      if(active&&highlight)out.push('<rect x="'+(plan.horizontal?tx-plan.labelWidth/2:anchor==='start'?tx-3:tx-plan.labelWidth)+'" y="'+(ty-size-3)+'" width="'+plan.labelWidth+'" height="'+(plan.blocks[i]+8)+'" rx="5" fill="'+esc(color)+'"/>');
      detail.names.forEach(v=>{label(v,tx,ty,size,active&&highlight?background:c,plan.labelWidth,'text-anchor="'+anchor+'"');ty+=size+6;});
      detail.english.forEach(v=>{label(v,tx,ty-4,13,active&&highlight?background:muted,plan.labelWidth,'text-anchor="'+anchor+'"');ty+=17;});
      if(detail.hint)label(detail.hint,tx,ty-2,13,active&&highlight?background:color,plan.labelWidth,'text-anchor="'+anchor+'"');
      out.push('</g></g>');
    });
    out.push('</g>');return plan.height;
  }
  function separator(out,x1,y1,x2,y2,color){out.push('<path data-route-separator="true" d="M '+x1+' '+y1+' L '+x2+' '+y2+'" fill="none" stroke="'+esc(color)+'" stroke-opacity="0.6" stroke-width="2"/>');}
  // Station signs are separate from vehicle destination signs. Layouts follow
  // observed physical structures; unavailable operational data stays explicit.
  function renderBus(template,data,stops,current){
    stops=busStops(stops);
    if(referenceBusLayouts.has(template.style.busLayout))return renderReferenceBus(template,[{route:{...data,stops},current}]);
    if(expandedBusLayouts.has(template.style.busLayout))return renderBusVariants(template,[{route:{...data,stops},current}]);
    const s=template.style,layout=s.busLayout,column=layout==="column",cols=column?Math.ceil(stops.length/24):1,
      width=column?Math.min(1440,600*cols):1440,contentWidth=width-100,accent=s.accent==="route"?data.color:s.accent;
    const station=current>=0?stops[current]:null,service=artworkService(data);
    const digital=["lcd","led","ink"].includes(layout),pole=layout==="pole";
    const displayName=station?.name||"请选择本站",next=busNext(data,stops,current);
    const out=[];
    function rect(x,y,w,h,fill,rx=0){out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+esc(fill)+'"/>');}
    function label(v,x,y,size=28,fill=s.text,max=0,extra=""){
      const len=[...String(v)].reduce((n,c)=>n+(/[\u0020-\u007e]/u.test(c)?0.56:1),0)*size;
      out.push('<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+esc(fill)+'"'+(max&&len>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');
    }
    function rule(x,y,w,color=accent,thickness=3){rect(x,y,w,thickness,color);}
    function wrapped(v,x,y,limit,size=28,fill=s.text){const a=[...v];for(let i=0;i<a.length;i+=limit)label(a.slice(i,i+limit).join(""),x,y+i/limit*(size+5),size,fill);}
    function marker(x,y,i){
      const color=current===i?accent:s.muted;
      if(s.shape==="square"){const radius=current===i?12:8;out.push('<rect x="'+(x-radius)+'" y="'+(y-radius)+'" width="'+(radius*2)+'" height="'+(radius*2)+'" fill="'+esc(current===i?accent:s.background)+'" stroke="'+esc(color)+'" stroke-width="4"/>');return;}
      out.push('<circle cx="'+x+'" cy="'+y+'" r="'+(current===i?13:8)+'" fill="'+esc(current===i?accent:s.background)+'" stroke="'+esc(color)+'" stroke-width="4"/>');
    }
    function openStop(stop,i){out.push('<g data-stop-index="'+i+'"><title>'+esc((data.roundtrip?"":(i+1)+". ")+stop.name+(stop.nameEn?" · "+stop.nameEn:"")+(signHints(stop).length?" · 标识 "+signHints(stop):""))+'</title>');}
    function busNumber(x,y,w,h){rect(x,y,w,h,accent,2);label(data.ref||"公交",x+w/2,y+h*0.69,Math.min(82,h*0.6),s.background,w-24,'text-anchor="middle" font-weight="750"');}
    const hours=(service.hours?service.hours+((service.first||service.last)?" · 首班 "+(service.first||"未提供")+" / 末班 "+(service.last||"未提供"):""):"")||((service.first||service.last)?"首班 "+(service.first||"未提供")+" / 末班 "+(service.last||"未提供"):"未提供");
    const serviceLines=busServiceRows(data,contentWidth,24);
    function serviceRows(y){serviceLines.forEach((v,i)=>label(v,50,y+i*32,24,s.text,contentWidth));}
    const capacity=Math.max(1,Math.floor((pole?1016:1294)/48)),rows=Math.ceil(stops.length/capacity),perRow=Math.ceil(stops.length/rows);
    const nameDepth=stop=>{const a=[...stop.name];return a.length&&a.filter(c=>/\p{Script=Han}/u.test(c)).length>a.length/2?a.length:Math.ceil(a.length/4);};
    const maxDepth=Math.max(...stops.map(nameDepth)),rowHeight=118+maxDepth*30;
    const perCol=column?Math.ceil(stops.length/cols):0,colWidth=contentWidth/cols;
    const nameLimit=column?Math.max(4,Math.floor((colWidth-100)/30)):4;
    const colRowHeight=column?Math.max(90,...stops.map(stop=>44+Math.ceil([...stop.name].length/nameLimit)*34+(stop.nameEn?20:0)+(signHints(stop).length?20:0))):0;
    const headerLift=data.roundtrip&&column?32:0;
    const orderStart=(column?560:digital?740:pole?498:510)-headerLift+Math.max(0,serviceLines.length-3)*32;
    const ring=data.roundtrip?loopDiagramPlan(stops,column?contentWidth:pole?1016:1294,{vertical:column,size:column?28:24}):null;
    const drawRing=(x,y)=>drawLoopDiagram(out,ring,{x,y,stops,current,color:accent,background:s.background,text:s.text,muted:s.muted,label,marker,openStop});
    const contentBottom=ring?orderStart+ring.height+30:column?orderStart+perCol*colRowHeight+90:orderStart+rows*rowHeight+48;
    const height=contentBottom+(busNotice(data)?44:24);
    rect(0,0,width,height,s.background);rule(0,0,width,accent,8);
    // Masthead: the actual stop name, rather than the route name.
    if(layout==="led"){
      label("公交站 · 到站预报",50,58,28,accent);label(displayName,50,132,60,s.text,contentWidth,'font-weight="750"');rule(50,172,contentWidth,s.muted,2);
    }else if(layout==="ink"){
      label("BUS STOP / 公交站",50,54,26,s.text);label(displayName,50,133,62,s.text,contentWidth,'font-weight="750"');rule(50,168,contentWidth,s.text,6);
    }else{
      rect(0,8,width,164,accent);label("BUS STOP / 公交站",50,54,26,s.background);
      label(displayName,50,133,column?48:60,s.background,contentWidth,'font-weight="750"');
    }

    if(column){
      busNumber(50,242,170,112);label(busDirection(data,stops,current),250,286,36,s.text,width-300,'font-weight="700"');
      label("下一站  "+next,250,337,24,accent,width-300);
      serviceRows(433-headerLift);
      if(ring)drawRing(50,orderStart);else for(let c=0;c<cols;c++){
        const start=c*perCol,count=Math.min(perCol,stops.length-start),left=50+c*colWidth,x=left+24;
        label(data.roundtrip?"":"站序 "+(start+1)+"–"+(start+count),left,orderStart+12,18,s.muted,colWidth-20);
        routeSegment(out,x+2,orderStart+50,x+2,orderStart+50+(count-1)*colRowHeight,accent,4);
        for(let r=0;r<count;r++){
          const i=start+r,stop=stops[i],y=orderStart+50+r*colRowHeight;openStop(stop,i);marker(x+2,y,i);
          if(i===current)label("本站",x+26,y-18,18,accent);
          wrapped(stop.name,x+30,y+10,nameLimit,30,i===current?accent:s.text);
          const bottom=y+14+Math.ceil([...stop.name].length/nameLimit)*35;
          if(stop.nameEn)label(stop.nameEn,x+30,bottom,16,s.muted,colWidth-90);
          if(signHints(stop).length)label(signHints(stop),x+30,bottom+23,16,accent,colWidth-90);
          out.push('</g>');
        }
        label(c<cols-1?"↓ 续接右栏":data.roundtrip?"":"↓ 行驶方向",left,orderStart+count*colRowHeight+65,22,accent,colWidth-15);
      }
    }else{
      if(digital){
        if(layout==="lcd"){
          busNumber(50,244,260,126);label(busDirection(data,stops,current),50,423,37,s.text,570,'font-weight="700"');
          label("下一站  "+next,50,472,27,accent,570);
          rect(660,242,350,228,s.background,12);rect(1030,242,360,228,s.background,12);
          label("最近一班",690,296,28,s.muted);label(arrivalText(data),690,376,32,accent,300);
          label("后续一班",1060,296,28,s.muted);label(arrivalText(data,true),1060,376,32,accent,300);
          if(!data.simulation)label("实时车辆与到站预测均未接入",690,442,21,s.muted,660);
        }else if(layout==="led"){
          label("线路",50,272,27,accent);label(data.roundtrip?"终点站":"开往方向",270,272,27,accent);label("最近一班",860,272,27,accent);label("后续一班",1140,272,27,accent);rule(50,295,contentWidth,s.muted,2);
          label(data.ref||"公交",50,375,64,accent,200,'font-weight="750"');label(terminus(data,stops)||"未提供",270,365,38,s.text,540,'data-terminus="true"');
          label(arrivalText(data),860,365,25,s.text,260);label(arrivalText(data,true),1140,365,25,s.text,250);
          label("下一站  "+next,50,435,28,s.text,contentWidth);rule(50,473,contentWidth,s.muted,2);
        }else{
          busNumber(50,243,238,119);label(busDirection(data,stops,current),330,286,44,s.text,1030,'font-weight="700"');
          label("下一站  "+next,330,337,27,s.text,1030);rule(50,391,contentWidth,s.text,2);
          label("到站预报",50,442,29,s.text);label("最近一班："+arrivalText(data),335,442,24,s.text,500);label("后续一班："+arrivalText(data,true),870,442,24,s.text,510);rule(50,474,contentWidth,s.text,2);
        }
        serviceRows(525);

      }else if(pole){
        label(busDirection(data,stops,current),350,271,42,s.text,1010,'font-weight="750"');label("下一站  "+next,350,314,25,accent,1010);
        serviceRows(385-headerLift);
      }else{
        busNumber(50,240,238,112);label(busDirection(data,stops,current),330,283,46,s.text,1030,'font-weight="750"');
        label("下一站  "+next,330,337,28,accent,1030);serviceRows(398-headerLift);
      }
      if(ring){if(pole)busNumber(50,orderStart+10,240,104);drawRing(pole?350:72,orderStart);}else for(let r=0;r<rows;r++){
        const start=r*perRow,count=Math.min(perRow,stops.length-start),left=pole?350:72,right=1366,step=(right-left)/Math.max(count-1,1),y=orderStart+r*rowHeight+42;
        if(pole&&r===0)busNumber(50,y-14,240,104);
        routeSegment(out,left,y,left+(count-1)*step,y,accent,6);
        const end=left+Math.max(25,(count-1)*step);out.push('<path d="M '+(end-15)+' '+(y-13)+' L '+(end+8)+' '+y+' L '+(end-15)+' '+(y+13)+'" fill="none" stroke="'+esc(accent)+'" stroke-width="5"/>');
        for(let c=0;c<count;c++){
          const i=start+c,stop=stops[i],x=left+c*step;openStop(stop,i);marker(x,y,i);
          label(i===current?"本站":data.roundtrip?"":String(i+1),x,y-25,i===current?23:17,i===current?accent:s.muted,step-5,'text-anchor="middle" font-weight="700"');
          const a=[...stop.name],isHan=a.filter(v=>/\p{Script=Han}/u.test(v)).length>a.length/2;
          if(isHan){for(let k=0;k<a.length;k++)label(a[k],x,y+43+k*30,28,i===current?accent:s.text,0,'text-anchor="middle"');}
          else{for(let k=0;k<a.length;k+=4)label(a.slice(k,k+4).join(""),x,y+43+k/4*30,24,i===current?accent:s.text,step-8,'text-anchor="middle"');}
          if(stop.nameEn)label(stop.nameEn,x,y+rowHeight-48,14,s.muted,step-8,'text-anchor="middle"');
          if(signHints(stop).length)label(signHints(stop),x,y+rowHeight-23,14,accent,step-8,'text-anchor="middle"');
          out.push('</g>');
        }
      }

    }
    const note=(data.demo?"示例线路 · 非真实运营数据":"数据："+data.source+(data.sourceId?" · "+data.sourceId:""))+" · 本站为手动预览，非实时到站 · 仅展示当前线路"+(data.serviceNote?" · "+data.serviceNote:"");
    if(data.roundtrip&&!ring){
      if(column){const col=Math.floor((stops.length-1)/perCol),count=(stops.length-1)%perCol;verticalLoop(out,{x:76,y:orderStart+50},{x:76+col*colWidth,y:orderStart+50+count*colRowHeight},22,contentBottom-16,accent,4);}
      else{const count=stops.length-(rows-1)*perRow,left=pole?350:72;loopPath(out,{x:left,y:orderStart+42},{x:count>1?1366:left,y:orderStart+(rows-1)*rowHeight+42},left-30,1408,orderStart-8,accent,6);}
    }
    if(busNotice(data))label(busNotice(data),50,height-18,18,s.muted,contentWidth);
    const svg='<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(displayName+" · "+template.title)+'"><title>'+esc(data.title+" · "+template.title)+'</title><desc>'+esc(note)+'</desc>'+busMetadata(template,[{route:data}])+'<g font-family="system-ui, sans-serif">'+out.join('')+'</g></svg>';
    return {svg,width,height,contentBottom,stationCount:stops.length,renderedStations:stops.length,demo:data.demo,busLayout:layout,stationName:station?.name||null,realtime:false};
  }


  // These structures draw their own panels rather than cropping the old signs.
  // The same full-order primitives serve single-line and validated station boards.
  const expandedBusLayouts=new Set(["compact","split","wide","cards","hub","bilingual"]);
  function renderBusVariants(template,entries,board=null){
    const s=template.style,layout=s.busLayout,width=layout==="wide"?1920:1440,margin=40,gap=40;
    const station=entries[0].route.stops[entries[0].current];
    const stationName=station?.name||null,accent=s.accent==="route"?entries[0].route.color:s.accent,out=[];
    const units=v=>[...String(v)].reduce((sum,c)=>sum+(/[\u0020-\u007e]/u.test(c)?0.56:1),0);
    function rect(x,y,w,h,fill=s.background,rx=0,extra=""){out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+esc(fill)+'" '+extra+'/>');}
    function label(v,x,y,size=24,fill=s.text,max=width-80,extra=""){
      out.push('<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+esc(fill)+'"'+(units(v)*size>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');
    }
    function wrap(v,max,size){
      const rows=[];let row="",length=0;
      for(const c of String(v)){const n=units(c)*size;if(row&&length+n>max){rows.push(row);row="";length=0;}row+=c;length+=n;}
      rows.push(row);return rows;
    }
    const rule=(x,y,w,c=accent,h=2)=>rect(x,y,w,h,c);
    const routeColor=item=>s.accent==="route"?item.route.color:s.accent;
    const destination=item=>terminus(item.route)||"未提供";
    const next=item=>busNext(item.route,item.route.stops,item.current);
    const hours=item=>{const service=artworkService(item.route);return (service.hours?service.hours+((service.first||service.last)?" · 首班 "+(service.first||"未提供")+" / 末班 "+(service.last||"未提供"):""):"")||((service.first||service.last)?"首班 "+(service.first||"未提供")+" / 末班 "+(service.last||"未提供"):"未提供");};
    function services(item,x,y,w,size=20,fill=s.text){busServiceRows(item.route,w,size).forEach((v,i)=>label(v,x,y+i*28,size,fill,w));}
    function badge(item,x,y,w=150,h=86){rect(x,y,w,h,routeColor(item),3);label(item.route.ref||"公交",x+w/2,y+h*.69,Math.min(58,h*.61),s.background,w-16,'text-anchor="middle" font-weight="750"');}
    function stopOpen(stop,i,roundtrip){out.push('<g data-stop-index="'+i+'"><title>'+esc((roundtrip?"":(i+1)+". ")+stop.name+(stop.nameEn?" · "+stop.nameEn:"")+(signHints(stop).length?" · 标识 "+signHints(stop):""))+'</title>');}
    function marker(item,x,y,i){
      const active=i===item.current,c=routeColor(item),r=active?11:7;
      if(s.shape==="square")out.push('<rect x="'+(x-r)+'" y="'+(y-r)+'" width="'+r*2+'" height="'+r*2+'" fill="'+esc(active?c:s.background)+'" stroke="'+esc(c)+'" stroke-width="3"/>');
      else out.push('<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+esc(active?c:s.background)+'" stroke="'+esc(c)+'" stroke-width="3"/>');
    }
    function arrow(x,y,c){out.push('<path d="M '+(x-10)+' '+(y-9)+' L '+(x+2)+' '+y+' L '+(x-10)+' '+(y+9)+'" fill="none" stroke="'+esc(c)+'" stroke-width="3"/>');}
    // Measure before drawing so long names, transfers and later rows never collide.
    function nameRows(stop,compact,step,size){
      const chars=[...stop.name],han=chars.filter(c=>/\p{Script=Han}/u.test(c)).length>chars.length/2;
      return compact&&han?chars:wrap(stop.name,step-18,size);
    }
    function diagram(item,w,compact=false){
      if(item.route.roundtrip){const loop=loopDiagramPlan(item.route.stops,w,{size:compact?23:22});return {loop,height:loop.height};}
      const capacity=Math.max(1,Math.floor(w/(compact?48:72))),columns=Math.ceil(item.route.stops.length/Math.ceil(item.route.stops.length/capacity)),rows=[];
      for(let start=0;start<item.route.stops.length;start+=columns){
        const stops=item.route.stops.slice(start,start+columns),step=w/stops.length,size=compact?23:22;
        const depth=Math.max(...stops.map(stop=>nameRows(stop,compact,step,size).length));
        const english=stops.some(stop=>stop.nameEn),transfers=stops.some(stop=>signHints(stop).length);
        rows.push({start,stops,step,size,height:76+depth*(size+5)+(english?20:0)+(transfers?24:0),english,transfers});
      }
      return {rows,height:rows.reduce((n,r)=>n+r.height,0)+(item.route.roundtrip?52:0)};
    }
    function drawDiagram(item,d,x,y,w,compact=false){
      if(d.loop)return drawLoopDiagram(out,d.loop,{x,y,stops:item.route.stops,current:item.current,color:routeColor(item),background:s.background,text:s.text,muted:s.muted,label,marker:(x,y,i)=>marker(item,x,y,i),openStop:(stop,i)=>stopOpen(stop,i,true)});
      let top=y+(item.route.roundtrip?52:0);const c=routeColor(item);
      d.rows.forEach((row,r)=>{
        const cy=top+28,end=x+row.step/2+(row.stops.length-1)*row.step;
        routeSegment(out,x+row.step/2,cy,end,cy,c,4);arrow(Math.min(x+w-10,end+20),cy,c);
        row.stops.forEach((stop,k)=>{
          const i=row.start+k,cx=x+row.step/2+k*row.step;stopOpen(stop,i,item.route.roundtrip);marker(item,cx,cy,i);
          label(i===item.current?"本站":item.route.roundtrip?"":String(i+1),cx,top+8,16,i===item.current?c:s.muted,row.step-6,'text-anchor="middle" font-weight="700"');
          const names=nameRows(stop,compact,row.step,row.size);
          names.forEach((name,n)=>label(name,cx,top+64+n*(row.size+5),row.size,i===item.current?c:s.text,row.step-12,'text-anchor="middle"'));
          const bottom=top+row.height-16;
          if(stop.nameEn)label(stop.nameEn,cx,bottom-(row.transfers?24:0),13,s.muted,row.step-12,'text-anchor="middle"');
          if(signHints(stop).length)label(signHints(stop),cx,bottom,13,c,row.step-12,'text-anchor="middle"');
          out.push('</g>');
        });
        if(r<d.rows.length-1)label("→ 续下行",x+w-8,top+row.height-2,14,s.muted,100,'text-anchor="end"');
        top+=row.height;
      });
      if(item.route.roundtrip){const first=d.rows[0],last=d.rows.at(-1);loopPath(out,{x:x+first.step/2,y:y+80},{x:x+w-last.step/2,y:top-last.height+28},x+3,x+w-3,y+35,c,4);}
    }
    function vertical(item,w){
      if(item.route.roundtrip){const loop=loopDiagramPlan(item.route.stops,w,{vertical:true,size:26});return {loop,height:loop.height};}
      const columns=Math.min(3,Math.ceil(item.route.stops.length/16)),perColumn=Math.ceil(item.route.stops.length/columns),cell=w/columns;
      const rowHeight=Math.max(90,...item.route.stops.map(stop=>44+wrap(stop.name,cell-65,26).length*31+(stop.nameEn?20:0)+(signHints(stop).length?20:0)));
      return {columns,perColumn,cell,rowHeight,height:perColumn*rowHeight+70+(item.route.roundtrip?32:0)};
    }
    function drawVertical(item,d,x,y){
      if(d.loop)return drawLoopDiagram(out,d.loop,{x,y,stops:item.route.stops,current:item.current,color:routeColor(item),background:s.background,text:s.text,muted:s.muted,label,marker:(x,y,i)=>marker(item,x,y,i),openStop:(stop,i)=>stopOpen(stop,i,true)});
      const c=routeColor(item);
      for(let col=0;col<d.columns;col++){
        const start=col*d.perColumn,stops=item.route.stops.slice(start,start+d.perColumn),left=x+col*d.cell;
        routeSegment(out,left+14,y+28,left+14,y+28+(stops.length-1)*d.rowHeight,c,4);
        stops.forEach((stop,k)=>{
          const i=start+k,cy=y+28+k*d.rowHeight,names=wrap(stop.name,d.cell-65,26);
          stopOpen(stop,i,item.route.roundtrip);marker(item,left+14,cy,i);
          label(i===item.current?"本站":item.route.roundtrip?"":String(i+1),left+39,cy-14,14,i===item.current?c:s.muted,d.cell-60);
          names.forEach((name,n)=>label(name,left+39,cy+18+n*31,26,i===item.current?c:s.text,d.cell-60));
          const bottom=cy+20+names.length*31;
          if(stop.nameEn)label(stop.nameEn,left+39,bottom,14,s.muted,d.cell-60);
          if(signHints(stop).length)label(signHints(stop),left+39,bottom+20,14,c,d.cell-60);
          out.push('</g>');
        });
        label(col<d.columns-1?"↓ 续接右栏":item.route.roundtrip?"":"↓ 行驶方向",left,y+stops.length*d.rowHeight+42,18,c,d.cell-16);
      }
    }
    function verticalClosure(item,d,x,y){if(!item.route.roundtrip||d.loop)return;const col=Math.floor((item.route.stops.length-1)/d.perColumn),row=(item.route.stops.length-1)%d.perColumn;verticalLoop(out,{x:x+14,y:y+28},{x:x+col*d.cell+14,y:y+28+row*d.rowHeight},x-10,y+d.height-12,routeColor(item),4);}
    function panel(item,w,kind){
      if(kind==="split"){const d=vertical(item,w-374),serviceHeight=busServiceRows(item.route,276,20).length*28;return {item,kind,w,d,height:Math.max(650,d.height+72,wrap(destination(item),276,34).length*42+330+serviceHeight)};}
      const compact=kind==="compact",d=diagram(item,w-(compact?250:48),compact),serviceHeight=busServiceRows(item.route,w-48,compact?20:18).length*28;
      return {item,kind,w,d,height:compact?Math.max(180,d.height+16,174+wrap(destination(item),174,25).length*30)+serviceHeight+70+(busNotice(item.route)?24:0):d.height+212+serviceHeight};
    }
    function drawPanel(p,x,y,index){
      const {item,kind,w,d,height}=p,c=routeColor(item),compact=kind==="compact";
      out.push('<g'+(board?' data-board-route-index="'+index+'"':"")+'><title>'+esc(item.route.title+" · "+item.route.sourceId)+'</title>');
      rect(x,y,w,height,s.background,5,'stroke="'+esc(s.muted)+'" stroke-width="1"');
      if(kind==="split"){
        rect(x,y,326,height,c,4);badge(item,x+25,y+24,276,112);
        label(item.route.roundtrip?"终点站":"开往",x+25,y+180,22,s.background,276);
        let top=y+226;for(const name of wrap(destination(item),276,34)){label(name,x+25,top,34,s.background,276,'font-weight="700"');top+=42;}
        label("下一站  "+next(item),x+25,top+18,22,s.background,276);
        services(item,x+25,top+80,276,20,s.background);
        drawVertical(item,d,x+354,y+56);verticalClosure(item,d,x+354,y+56);
      }else if(compact){
        badge(item,x+18,y+20,182,92);label(item.route.roundtrip?"终点站":"开往",x+26,y+150,21,c,174);
        wrap(destination(item),174,25).forEach((name,i)=>label(name,x+26,y+187+i*30,25,s.text,174,'font-weight="700"'));
        drawDiagram(item,d,x+222,y+12,w-250,true);
        const top=y+height-busServiceRows(item.route,w-44,20).length*28-36-(/用户补填/u.test(item.route.serviceNote)?24:0);rule(x+18,top-42,w-36,s.muted,1);
        label("下一站  "+next(item),x+22,top-12,20,s.text,w-44);services(item,x+22,top+20,w-44,20);
      }else{
        badge(item,x+22,y+20,138,84);label(busDirection(item.route,item.route.stops,item.current),x+184,y+57,30,s.text,w-206,'font-weight="700"');
        label("下一站  "+next(item),x+184,y+96,21,c,w-206);

        drawDiagram(item,d,x+24,y+158,w-48);
        services(item,x+24,y+height-busServiceRows(item.route,w-48,18).length*28-12,w-48,18);

      }
      if(busNotice(item.route))label(busNotice(item.route),x+w-14,y+height-4,14,s.muted,w-28,'text-anchor="end"');
      out.push('</g>');
    }
    const contentWidth=width-margin*2;
    let panelX=margin,panelWidth=contentWidth,columns=1,start=200,overview=0;
    if(layout==="cards"){columns=Math.min(2,entries.length);panelWidth=(contentWidth-gap*(columns-1))/columns;}
    if(layout==="wide"){panelX=556;panelWidth=width-panelX-margin;overview=200+entries.length*176+160;}
    if(layout==="hub")start=340+entries.length*102;
    const panels=entries.map(item=>panel(item,panelWidth,layout));
    const rows=[];for(let i=0;i<panels.length;i+=columns)rows.push(Math.max(...panels.slice(i,i+columns).map(p=>p.height)));
    const height=Math.max(overview,start+rows.reduce((n,h)=>n+h+gap,0))+(board?.demo||entries[0].route.demo?56:24);
    rect(0,0,width,height);rect(0,0,width,164,accent);
    label("BUS STOP / 公交站",margin,48,24,s.background,contentWidth);
    label(stationName||"请选择本站",margin,126,62,s.background,contentWidth,'font-weight="750"');
    const scope=board?"已加入 "+entries.length+" 条线路／方向 · 同一站点 "+board.stationId+" · "+(board.complete?"本站已登记公交关系查询完成":"非全站完整清单"):"仅展示当前线路，不代表本站全部途经线路";

    if(layout==="wide"){
      label("线路总览",margin,286,32,accent,450,'font-weight="700"');
      entries.forEach((item,i)=>{
        const y=320+i*176;rule(margin,y,458,s.muted,1);badge(item,margin,y+18,114,64);
        label(busDirection(item.route,item.route.stops,item.current),margin+134,y+45,26,s.text,324);
        label("下一站  "+next(item),margin+134,y+80,20,s.muted,324);
        label("最近一班："+arrivalText(item.route),margin,y+122,23,accent,458);
        label("后续一班："+arrivalText(item.route,true),margin,y+154,19,s.muted,458);
      });

    }
    if(layout==="hub"){
      label("线路索引",margin,274,28,accent,180,'font-weight="700"');label("方向／下一站",270,274,22,s.muted,700);label("服务时间",1020,274,22,s.muted,340);
      entries.forEach((item,i)=>{
        const y=300+i*102;rule(margin,y,contentWidth,s.muted,1);badge(item,margin,y+16,170,66);
        label(busDirection(item.route,item.route.stops,item.current),270,y+45,29,s.text,700);label(hours(item),1020,y+45,20,s.text,340);

      });
    }
    let y=start;
    for(let row=0;row<rows.length;row++){
      for(let col=0;col<columns;col++){const i=row*columns+col;if(!panels[i])continue;drawPanel(panels[i],panelX+col*(panelWidth+gap),y,i);if(col<columns-1&&panels[i+1])separator(out,panelX+(col+1)*panelWidth+col*gap+gap/2,y+8,panelX+(col+1)*panelWidth+col*gap+gap/2,y+rows[row]-8,s.muted);}
      if(row<rows.length-1)separator(out,panelX,y+rows[row]+gap/2,panelX+panelWidth*columns+gap*(columns-1),y+rows[row]+gap/2,s.muted);
      y+=rows[row]+gap;
    }

  const demo=board?board.demo:entries[0].route.demo;
    const note=(demo?(board?"示例站牌":"示例线路")+" · 非真实运营数据":"数据："+entries.map(e=>e.route.source+" · "+e.route.sourceId).join("、"))+" · 本站为手动预览，非实时到站"+(board?.sourceTime?" · OGF 数据时间 "+board.sourceTime:"");
    if(demo)label((board?"示例站牌":"示例线路")+" · 非真实运营数据",margin,height-28,18,s.muted,contentWidth);
    const title=(stationName||"请选择本站")+" · "+(board?"同站多线路 · ":"")+template.title;
    const svg='<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" data-bus-layout="'+layout+'" aria-label="'+esc(title)+'"><title>'+esc(title)+'</title><desc>'+esc(note+' · '+scope)+'</desc>'+busMetadata(template,entries,board)+'<g font-family="Microsoft YaHei,system-ui,sans-serif">'+out.join("")+'</g></svg>';
    const stationCount=entries.reduce((n,e)=>n+e.route.stops.length,0);
    return {svg,width,height,stationCount,renderedStations:stationCount,...(board?{lineCount:entries.length}:{}),demo,busLayout:layout,stationName,realtime:false};
  }

  function stationEntry(route,options={}){
    const data=line(route);
    if(data.type!=="bus")fail("整站站牌只接受公交线路");
    if(data.relationKind==="route_master")fail("请先在原线路页选择具体方向／分段，再加入本站牌");
    const stops=options.reverse?[...data.stops].reverse():data.stops,current=options.current;
    if(!Number.isInteger(current)||current<0||current>=stops.length)fail("请先选择这条线路经过的本站");
    const stop=stops[current];
    if(!(data.demo?/^demo\/[a-z0-9-]+$/u:/^(node|way|relation)\/[1-9]\d*$/u).test(stop.sourceId))fail("本站缺少可核对的要素编号，不能仅凭同名合并");
    if(!(data.demo?/^demo\/[a-z0-9-]+$/u:/^relation\/[1-9]\d*$/u).test(data.sourceId))fail("线路缺少可核对的关系编号");
    const key=[data.sourceId,stops[0].sourceId,stops.at(-1).sourceId,stop.sourceId,stops.slice(0,current+1).filter(item=>item.sourceId===stop.sourceId).length].join("|");
    return {key,route:{...data,stops},current,stationId:stop.sourceId,stationName:stop.name};
  }
  function addStationLine(board,route,options={}){
    const entry=stationEntry(route,options);
    if(board&&(board.stationId!==entry.stationId||board.demo!==entry.route.demo))fail("该线路选中的站点编号不同，不能把对向站或同名站合到本站牌；请选同一站点，或清空后建立另一站牌");
    const lines=(board?.lines||[]).filter(item=>item.key!==entry.key);
    return {stationId:entry.stationId,stationName:board?.stationName||entry.stationName,demo:entry.route.demo,lines:[...lines,entry]};
  }
  function renderStationArtwork(value,board,options={}){
    const template=normalize(value),s=template.style;
    if(template.family!=="bus-stop")fail("整站多线路仅适用于公交站牌模板");
    if(!board?.lines?.length)fail("请先把经过同一站点的已读取公交线路加入本站牌");
    // Validate again at the rendering boundary; display membership is never
    // inferred from a shared name, transfer list or nearby geometry.
    const entries=board.lines.map(item=>stationEntry(options.simulation?.enabled?simulateService(item.route,{...options.simulation,current:item.current}):item.route,{current:item.current}));
    if(entries.some(item=>item.stationId!==board.stationId||item.route.demo!==board.demo))fail("站牌包含不属于同一站点的线路");
    if(new Set(entries.map(item=>item.key)).size!==entries.length)fail("站牌包含重复线路方向");
    if(referenceBusLayouts.has(s.busLayout))return renderReferenceBus(template,entries,board);
    if(expandedBusLayouts.has(s.busLayout))return renderBusVariants(template,entries,board);
    const stationName=entries[0].stationName,width=1440,accent=s.accent==="route"?entries[0].route.color:s.accent;
    const column=s.busLayout==="column",digital=["lcd","led","ink"].includes(s.busLayout),gridColumns=column?Math.min(3,entries.length):1;
    const gap=40,cellWidth=(1340-gap*(gridColumns-1))/gridColumns;
    const panels=entries.map(item=>{
      const t=digital?normalize({...template,style:{...s,busLayout:"strip"}}):template;
      const image=renderBus(t,item.route,item.route.stops,item.current),croppedHeight=image.contentBottom-222;
      const inner=image.svg.slice(image.svg.indexOf('<g font-family='),image.svg.lastIndexOf('</svg>'));
      return {item,image,inner,croppedHeight,drawHeight:croppedHeight*cellWidth/image.width+(busNotice(item.route)?32:0)};
    });
    const out=[];
    const rect=(x,y,w,h,fill)=>out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+esc(fill)+'"/>');
    function label(v,x,y,size=26,fill=s.text,max=1340,extra=""){
      const length=[...String(v)].reduce((sum,c)=>sum+(/[\u0020-\u007e]/u.test(c)?0.56:1),0)*size;
      out.push('<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+esc(fill)+'"'+(length>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');
    }
    const rowHeights=[];for(let i=0;i<panels.length;i+=gridColumns)rowHeights.push(Math.max(...panels.slice(i,i+gridColumns).map(p=>p.drawHeight)));
    const overviewHeight=digital?90+entries.length*100:0,panelsStart=198+overviewHeight;
    const height=panelsStart+rowHeights.reduce((sum,h)=>sum+h+gap,0)+(board.demo?44:8);
    rect(0,0,width,height,s.background);rect(0,0,width,166,accent);
    label("BUS STOP / 公交站",50,51,25,s.background);
    label(stationName,50,130,60,s.background,1340,'font-weight="750"');

    if(digital){
      label("线路",60,282,25,accent,200);label("方向／下一站",270,282,25,accent,540);label("最近一班",865,282,25,accent,230);label("后续一班",1135,282,25,accent,230);
      entries.forEach((item,i)=>{
        const y=322+i*100,stops=item.route.stops,next=busNext(item.route,stops,item.current);
        rect(50,y-15,1340,1,s.muted);label(item.route.ref||"公交",60,y+32,46,accent,185,'font-weight="750"');
        label(busDirection(item.route,stops,item.current),270,y+18,30,s.text,535);label("下一站  "+next,270,y+57,21,s.muted,535);
        label(arrivalText(item.route),865,y+30,24,s.text,230);label(arrivalText(item.route,true),1135,y+30,24,s.text,230);
      });
    }
    let y=panelsStart;
    for(let row=0;row<rowHeights.length;row++){
      for(let c=0;c<gridColumns;c++){
        const index=row*gridColumns+c,p=panels[index];if(!p)continue;const x=50+c*(cellWidth+gap),h=p.croppedHeight*cellWidth/p.image.width;
        out.push('<g data-board-route-index="'+index+'"><title>'+esc(p.item.route.title+" · "+p.item.route.sourceId)+'</title>');
        out.push('<svg x="'+x+'" y="'+y+'" width="'+cellWidth+'" height="'+h+'" viewBox="0 222 '+p.image.width+' '+p.croppedHeight+'" overflow="hidden">'+p.inner+'</svg>');
        if(busNotice(p.item.route))label(busNotice(p.item.route),x+10,y+h+27,17,s.muted,cellWidth-20);out.push('</g>');
        if(c<gridColumns-1&&panels[index+1])separator(out,x+cellWidth+gap/2,y+8,x+cellWidth+gap/2,y+rowHeights[row]-8,s.muted);
      }
      if(row<rowHeights.length-1)separator(out,50,y+rowHeights[row]+gap/2,1390,y+rowHeights[row]+gap/2,s.muted);
      y+=rowHeights[row]+gap;
    }
    const note=(board.demo?"示例站牌 · 非真实运营数据":(board.complete?"按本站登记关系查询 · ":"已读取线路由用户逐条收录 · ")+entries.map(p=>p.route.sourceId).join("、"))+" · "+(board.complete?"范围：所选站点已登记公交关系":"不保证全站完整")+" · 非实时到站"+(board.sourceTime?" · OGF 数据时间 "+board.sourceTime:"");
    if(board.demo)label("示例站牌 · 非真实运营数据",50,height-24,18,s.muted);
    const svg='<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(stationName+" · 同站多线路站牌")+'"><title>'+esc(stationName+" · 同站多线路站牌")+'</title><desc>'+esc(note+' · '+(board.complete?'本站已登记公交关系查询完成':'非全站完整清单'))+'</desc>'+busMetadata(template,entries,board)+'<g font-family="system-ui,sans-serif">'+out.join('')+'</g></svg>';
    return {svg,width,height,stationCount:entries.reduce((n,e)=>n+e.route.stops.length,0),renderedStations:entries.reduce((n,e)=>n+e.route.stops.length,0),lineCount:entries.length,stationName,demo:board.demo,realtime:false};
  }


  // Only trusted, generated SVG is animated; imported templates remain data.
  // Exports always use the complete, static diagram, never the clipped ticker.

  // Minimise the widest row while retaining the original consecutive order.
  function measuredRows(stops,width,measure){
    const weights=stops.map(p=>Math.min(width,measure(p)));
    const count=limit=>{let n=1,sum=0;for(const w of weights){if(sum+w>limit+.001){n++;sum=0;}sum+=w;}return n;};
    const rows=count(width);let lo=Math.max(...weights,weights.reduce((a,b)=>a+b,0)/rows),hi=width;
    for(let i=0;i<35;i++){const mid=(lo+hi)/2;if(count(mid)<=rows)hi=mid;else lo=mid;}
    const result=[];let row=[],sum=0,remaining=rows;
    for(let i=weights.length-1;i>=0;i--){
      if(row.length&&(sum+weights[i]>hi+.001||i+1<remaining)){result.unshift(row);row=[];sum=0;remaining--;}
      row.unshift({i,slot:weights[i]});sum+=weights[i];
    }
    if(row.length)result.unshift(row);return result;
  }


  const passengerLayouts=new Set(["nanjing","chongqing-screen","wuxi-screen","fuzhou","platform","ningbo","suzhou","songjiang","macau","macau-fold","wayfinding"]);
  function passengerState(value={},defaultCars=6){
    const integer=(v,min,max,fallback)=>Number.isInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):fallback;
    const cars=integer(value.cars,1,24,defaultCars);
    return {cars,car:integer(value.car,1,cars,1),carsKnown:Boolean(value.cars),doorSide:["left","right","both"].includes(value.doorSide)?value.doorSide:"unknown",doorLabel:String(value.doorLabel||"").slice(0,40),
      phase:["running","approaching","arrived","closing"].includes(value.phase)?value.phase:"approaching",page:["route","platform","cycle"].includes(value.page)?value.page:"cycle",
      leftExit:String(value.leftExit||"").slice(0,160),rightExit:String(value.rightExit||"").slice(0,160),
      facilities:["wc","accessible","lift","stairs"].filter(k=>value.facilities?.includes(k)),manual:Boolean(value.manual)};
  }
  // Original pictograms are paths, not copied photos, logos, external fonts or scripts.
  function passengerIcon(kind,x,y,size,color){
    const shapes={
      train:'<rect x="5" y="2" width="22" height="25" rx="7"/><path d="M9 8h14v10H9zM10 29l-3 3m15-3 3 3M10 23h1m10 0h1"/>',
      bus:'<rect x="4" y="4" width="24" height="22" rx="4"/><path d="M8 8h16v10H8zM9 27v4m14-4v4M8 22h2m12 0h2"/>',
      plane:'<path d="M16 1l3 12 12 7v3l-12-3v8l4 3v1l-7-2-7 2v-1l4-3v-8-0l-12 3v-3l12-7z"/>',
      lift:'<rect x="3" y="3" width="26" height="26" rx="3"/><path d="M10 9l3-3 3 3m-3-3v9m9 8-3 3-3-3m3 3v-9M8 20h4v7H8z"/>',
      stairs:'<path d="M2 29h6v-6h6v-6h6v-6h6V5h4M3 15L15 3m-8 0h8v8"/>',
      accessible:'<circle cx="14" cy="4" r="2"/><path d="M13 9l1 10h10l5 10M14 14h9M10 16a9 9 0 1 0 11 11"/>',
      wc:'<circle cx="9" cy="5" r="3"/><circle cx="24" cy="5" r="3"/><path d="M5 11h8v10H5zM7 21v9m4-9v9M23 10l-6 13h13l-6-13m-3 13v7m6-7v7"/>',
      hospital:'<path d="M12 2h8v10h10v8H20v10h-8V20H2v-8h10z"/>',
      school:'<path d="M2 11L16 3l14 8-14 8zM6 15v10l10 5 10-5V15M30 12v14"/>',
      exit:'<path d="M18 2H3v28h15M13 16h18m-8-8 8 8-8 8"/>'
    };
    return '<g data-pictogram="'+kind+'" transform="translate('+x+' '+y+') scale('+(size/32)+')" fill="none" stroke="'+esc(color)+'" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">'+(shapes[kind]||shapes.train)+'</g>';
  }
  // Wuxi garden LCD: a light panoramic route page and a separate arrival page.
  function renderWuxiScreen(template,data,stops,current){
    const s=template.style,W=1920,ac=s.accent==="route"?data.color:s.accent,bg=s.background,fg=s.text,mut=s.muted;
    const p=passengerState(data.passenger,6),active=stops[current]||null,next=stops[nextStoppingIndex(data,stops,current)]||null;
    const target=p.phase==="arrived"?active:next,headerH=92,rowW=W-160;
    const slots=stop=>Math.max(46,Math.ceil([...stop.name].length/8)*23+(stop.nameEn?15:0)+22);
    const rows=measuredRows(stops,rowW,slots),depth=Math.min(8,Math.max(...stops.map(v=>[...v.name].length)));
    const rowH=104+depth*23,routeH=rows.length*rowH+24,platformH=290,carH=90;
    const state=({running:"列车运行中",approaching:"即将到站",arrived:"已到站",closing:"车门即将关闭"})[p.phase];
    let out=[];
    const rect=(x,y,w,h,c,r=0,extra="")=>out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+r+'" fill="'+esc(c)+'" '+extra+'/>');
    const path=(d,c,w=2,extra="")=>out.push('<path d="'+d+'" fill="none" stroke="'+esc(c)+'" stroke-width="'+w+'" stroke-linecap="round" stroke-linejoin="round" '+extra+'/>');
    function label(v,x,y,z=22,c=fg,max=0,extra=""){out.push('<text x="'+x+'" y="'+y+'" font-size="'+z+'" fill="'+esc(c)+'"'+(max&&units(v)*z>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');}
    function header(){
      rect(0,0,W,headerH,bg);
      out.push(passengerIcon("train",28,26,38,ac));label(data.ref||"轨道交通",80,49,27,fg,240,'font-weight="750"');label("RAIL TRANSIT",81,69,12,mut,210);
      out.push('<g data-wuxi-canopy="true">');
      let d='M 470 0 H 1450 V 9';for(let x=1450;x>470;x-=35)d+=' q -17.5 24 -35 0';out.push('<path d="'+d+' Z" fill="'+esc(ac)+'"/>');
      rect(642,5,636,73,"#366d69",22);rect(647,10,626,63,"#f2dfb0",18);rect(652,15,616,53,ac,15);
      label(p.phase==="arrived"?"当前站":"下一站",677,39,18,"#fff8ed",85);label(p.phase==="arrived"?"THIS STATION":"NEXT STATION",677,57,10,"#fff8ed",95);
      label(current<0?"请选择当前站":target?.name||terminus(data),996,51,30,"#fff8ed",505,'text-anchor="middle" font-weight="750"');out.push('</g>');
      label("终点站  DESTINATION",1510,25,12,mut,375);label(terminus(data),1510,58,27,fg,375,'font-weight="650"');
      if(data.from)label("从 "+data.from,1510,80,12,mut,375);
    }
    function background(h){rect(0,0,W,h,bg);for(let x=50;x<W;x+=180){path('M'+x+' '+(h-4)+'q80 -42 160 0',"#dce9e5",1,'opacity=".4"');}}
    function route(top,animated=false){
      const positions=[];
      rows.forEach((row,r)=>{
        const used=row.reduce((n,v)=>n+v.slot,0),gap=(rowW-used)/Math.max(1,row.length-1),reverse=r%2===1,y=top+61+r*rowH;let x=80;
        const points=row.map(o=>{const q={...o,x:x+o.slot/2,y};x+=o.slot+gap;if(reverse)q.x=W-q.x;positions[q.i]=q;return q;});
        out.push('<g data-station-row="'+r+'" data-row-count="'+row.length+'">');
        const sorted=[...points].sort((a,b)=>a.x-b.x);let rail='M '+sorted[0].x+' '+(y-9);
        for(const q of sorted)rail+=' H '+(q.x-12)+' Q '+(q.x-12)+' '+(y-30)+' '+q.x+' '+(y-30)+' Q '+(q.x+12)+' '+(y-30)+' '+(q.x+12)+' '+(y-9);
        rail+=' H '+sorted.at(-1).x;path(rail,"#9baea9",4,'data-garden-rail="true"');
        path('M '+points[0].x+' '+y+' H '+points.at(-1).x,"#a8b9b3",4,'data-route-segment="true"');
        points.forEach(q=>{
          const stop=stops[q.i],isCurrent=q.i===current,passed=current>=0&&q.i<current,c=isCurrent?ac:passed?"#c6848c":fg;
          out.push('<g data-stop-index="'+q.i+'"><title>'+esc(stop.name+(stop.nameEn?' · '+stop.nameEn:'')+(stop.transfers.length?' · '+stop.transfers.join(' / '):''))+'</title>');
          out.push('<path data-garden-lamp="true" d="M '+(q.x-8)+' '+(y+1)+' V '+(y-5)+' Q '+(q.x-8)+' '+(y-21)+' '+q.x+' '+(y-21)+' Q '+(q.x+8)+' '+(y-21)+' '+(q.x+8)+' '+(y-5)+' V '+(y+1)+' Z" fill="'+esc(isCurrent?ac:passed?'#d6a6ad':bg)+'" stroke="#9baea9" stroke-width="1.5"/>');
          if(isCurrent)out.push('<circle data-current-lamp="true" cx="'+q.x+'" cy="'+(y-10)+'" r="14" fill="none" stroke="'+esc(ac)+'" stroke-width="2">'+(animated?'<animate attributeName="opacity" values="1;.2;1" dur="1.6s" repeatCount="indefinite"/>':'')+'</circle>');
          const chars=[...stop.name],n=Math.ceil(chars.length/8),colDepth=Math.min(8,chars.length);
          chars.forEach((v,k)=>label(v,q.x+(Math.floor(k/8)-(n-1)/2)*23,q.y+30+(k%8)*23,21,c,0,'text-anchor="middle"'));
          if(stop.nameEn){const ex=q.x+n*12+3,ey=q.y+16;label(stop.nameEn,ex,ey,11,mut,Math.max(80,colDepth*23),'transform="rotate(90 '+ex+' '+ey+')"');}
          if(stop.transfers.length){
            out.push(transferBadges(stop,q.x,y-59,Math.min(110,q.slot+Math.max(0,gap)-4),12));
          }
          out.push('</g>');
        });out.push('</g>');
      });
      for(let i=1;i<positions.length;i++){const a=positions[i-1],b=positions[i];if(a.y!==b.y){const d=foldedJoin(a,b,a.x>W/2?W-32:32);path(d,"#9baea9",4,'data-route-segment="true" data-route-join="true"');}}
      if(data.roundtrip)loopPath(out,positions[0],positions.at(-1),24,W-24,top+3,"#9baea9",4);
      throughIntervals(out,data,stops,positions,W);
      const mid=positions.length>1?(positions[0].x+positions[1].x)/2:W/2;
      out.push('<g data-flow-chevron="true">'+(animated?'<animateTransform attributeName="transform" type="translate" values="0 0;12 0;0 0" dur="1.8s" repeatCount="indefinite"/>':'')+'<path d="M '+(mid-6)+' '+(positions[0].y-5)+' l 6 5 -6 5" fill="none" stroke="'+esc(ac)+'" stroke-width="2"/></g>');
    }
    function gardenWindow(cx,cy,side,animated){
      const d='M '+(cx-44)+' '+(cy-68)+' H '+(cx+44)+' L '+(cx+70)+' '+(cy-40)+' V '+(cy+40)+' L '+(cx+44)+' '+(cy+68)+' H '+(cx-44)+' L '+(cx-70)+' '+(cy+40)+' V '+(cy-40)+' Z';
      out.push('<g data-garden-window="'+side+'">');path(d,"#6d8380",4);
      path('M'+(cx-40)+' '+(cy-63)+'v27h-25m28-26v38h-28m127-38v26h-27v-26m27 36h-38v-36M'+(cx-65)+' '+(cy+28)+'h26v34m-26-26h15v26m89-36h26m-38 0v36m12-26h26',"#7d918b",2);
      // Bamboo branches are decoration, never passenger or exit data.
      path('M'+(cx-12)+' '+(cy+18)+'q-15-40 2-80m-7 28-17-14m19 3 19-14m-16 35 23-7m-26-2-15-7',"#96ad9c",1.8);
      const open=p.doorSide===side||p.doorSide==="both";
      if(open){out.push('<g data-door-direction="'+side+'">'+(animated?'<animate attributeName="opacity" values=".25;1;.25" dur="1.6s" repeatCount="indefinite"/>':'')+'<path d="M '+(cx-15)+' '+(cy+42)+' l 15 -15 15 15 m -30 12 l 15 -15 15 15" fill="none" stroke="'+esc(ac)+'" stroke-width="7"/></g>');}
      out.push('</g>');
      label(open?"本侧开门":p.doorSide==="unknown"?"开门侧待设置":"对侧开门",cx,cy+102,22,open?ac:mut,230,'text-anchor="middle"');
    }
    function platform(top,animated=false){
      gardenWindow(200,top+113,'left',animated);gardenWindow(W-200,top+113,'right',animated);
      path('M 455 '+(top+82)+' H 758 Q 815 '+(top+82)+' 852 '+(top+47)+' Q 960 '+(top-10)+' 1068 '+(top+47)+' Q 1105 '+(top+82)+' 1162 '+(top+82)+' H 1465',"#9baea9",8);
      out.push('<circle cx="960" cy="'+(top+157)+'" r="93" fill="'+esc(ac)+'" stroke="#e7d9ae" stroke-width="4"/>');
      label(active?.name||"未指定当前站",960,top+155,30,"#ffffff",172,'text-anchor="middle" font-weight="750"');
      if(active?.nameEn)label(active.nameEn,960,top+181,13,"#fff9f0",168,'text-anchor="middle"');
      label(state,960,top+226,14,"#ffffff",160,'text-anchor="middle"');
      label("可换乘  TRANSFER",590,top+123,15,mut,285,'text-anchor="middle"');
      const transfers=active?.transfers||[];if(transfers.length)out.push(transferBadges(active,590,top+138,290,20));else label('—',590,top+158,20,ac,290,'text-anchor="middle"');
      label("下一站  NEXT STATION",1320,top+122,15,mut,285,'text-anchor="middle"');label(next?.name||(current<0?'请选择当前站':busNext(data,stops,current)),1320,top+164,27,fg,320,'text-anchor="middle"');
      if(next?.nameEn)label(next.nameEn,1320,top+190,13,mut,320,'text-anchor="middle"');
      if(p.leftExit)label('← '+p.leftExit,470,top+260,18,fg,350);
      if(p.rightExit)label(p.rightExit+' →',1450,top+260,18,fg,350,'text-anchor="end"');
      for(const [i,kind]of p.facilities.entries())out.push(passengerIcon(kind,480+i*62,top+207,25,ac));
      const known=p.doorSide!=="unknown",open=p.phase==="arrived",closing=p.phase==="closing";
      for(let i=0;i<2;i++){
        out.push('<g data-door-leaf="'+i+'" transform="translate('+(known&&open?(i?8:-8):0)+' 0)">');
        if(animated&&known&&(open||closing))out.push('<animateTransform attributeName="transform" type="translate" values="'+(closing?(i?'8 0;0 0;0 0':'-8 0;0 0;0 0'):(i?'0 0;8 0;8 0':'0 0;-8 0;-8 0'))+'" dur="4s" repeatCount="indefinite"/>');
        rect(1540+i*24,top+212,22,45,known?ac:mut,2);rect(1545+i*24,top+218,12,18,bg,2);out.push('</g>');
      }
      if(p.doorLabel)label(p.doorLabel,1600,top+244,16,fg,170);
    }
    function carriages(top){
      path('M 36 '+top+' H '+(W-36),"#ccdcd6",1);
      const cw=Math.min(86,(1100-(p.cars-1)*6)/p.cars),start=50;
      for(let i=0;i<p.cars;i++){const x=start+i*(cw+6),selected=i+1===p.car;out.push('<g data-carriage="'+(i+1)+'">');rect(x,top+23,cw,32,selected?ac:"#c7d8d1",5);label(String(i+1),x+cw/2,top+46,16,selected?"#ffffff":fg,cw-6,'text-anchor="middle"');out.push('</g>');}
      label('当前车厢 '+p.car+(p.carsKnown?' / '+p.cars+' 节':' · 车厢示意'),1210,top+43,17,mut,280);
      if(p.doorLabel)label(p.doorLabel,1510,top+43,17,ac,270);
      if(data.demo)label('示例线路',W-30,top+75,12,mut,140,'text-anchor="end"');
    }
    const metadata=busMetadata(template,[{route:data}])+'<metadata>'+esc(JSON.stringify({passenger:p,manualPreview:true}))+'</metadata>';
    const shell=(body,h)=>'<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+h+'" viewBox="0 0 '+W+' '+h+'" data-screen-layout="wuxi-screen" data-passenger-screen="true" data-wuxi-garden="true"><title>'+esc(data.title+' · '+template.title)+'</title><desc>完整站序，手动预览，非实时到站</desc>'+metadata+'<g font-family="Microsoft YaHei,system-ui,sans-serif">'+body+'</g></svg>';
    const height=headerH+routeH+platformH+carH;background(height);header();route(headerH);platform(headerH+routeH);carriages(height-carH);const svg=shell(out.join(''),height);
    const motionH=headerH+Math.max(routeH,platformH)+carH;out=[];background(motionH);header();
    for(const name of ['route','platform']){out.push('<g data-passenger-page="'+name+'" opacity="'+(p.page==='platform'?(name==='platform'?1:0):(name==='route'?1:0))+'">');if(p.page==='cycle')out.push('<animate attributeName="opacity" values="'+(name==='route'?'1;1;0;0;1':'0;0;1;1;0')+'" keyTimes="0;.44;.5;.94;1" dur="16s" repeatCount="indefinite"/>');if(name==='route')route(headerH,true);else platform(headerH,true);out.push('</g>');}carriages(motionH-carH);
    return {svg,motionSvg:shell(out.join(''),motionH),width:W,height,stationCount:stops.length,renderedStations:stops.length,demo:data.demo,screenLayout:'wuxi-screen',realtime:false,passenger:p,passengerPages:['route','platform'],rowCounts:rows.map(r=>r.length)};
  }

  function renderPassengerScreen(template,data,stops,current){
    if(template.style.screenLayout==="wuxi-screen")return renderWuxiScreen(template,data,stops,current);
    const s=template.style,profile=s.screenLayout||"wayfinding",guide=template.family==="metro-guide"||profile==="wayfinding",p=passengerState(data.passenger,data.type==="bus"?1:6),W=1440;
    const ac=s.accent==="route"?data.color:s.accent,bg=s.background,fg=s.text,mut=s.muted,isBus=data.type==="bus",color=guide?"#ffdf38":ac;
    const state=({running:isBus?"车辆运行中":"列车运行中",approaching:"即将到站",arrived:"已到站",closing:"车门即将关闭"})[p.phase];
    const selected=current>=0?current:-1,active=stops[selected]||null,next=stops[nextStoppingIndex(data,stops,selected)]||null;
    const rowWidth=1280,diagonal=["nanjing","ningbo"].includes(profile),vertical=["chongqing-screen","wuxi-screen","macau-fold"].includes(profile);
    const size=20,slot=stop=>vertical?Math.max(31,Math.ceil([...stop.name].length/8)*21+8):diagonal?47:Math.max(58,Math.min(120,units(stop.name)*11+8));
    const rows=measuredRows(stops,rowWidth,slot);
    const depth=Math.min(8,Math.max(...stops.map(v=>[...v.name].length))),rowH=vertical?125+depth*23:diagonal?290:225;
    const focusH=["songjiang","wuxi-screen","macau","fuzhou","platform","suzhou"].includes(profile)?252:0;
    const routeH=rows.length*rowH+64,headerH=118,platformH=410,staticH=headerH+routeH+focusH+platformH+58;
    let out=[];
    const rect=(x,y,w,h,c,r=0,extra="")=>out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+r+'" fill="'+esc(c)+'" '+extra+'/>');
    const path=(d,c,width=3,extra="")=>out.push('<path d="'+d+'" fill="none" stroke="'+esc(c)+'" stroke-width="'+width+'" stroke-linecap="round" stroke-linejoin="round" '+extra+'/>');
    function label(v,x,y,z=22,c=fg,max=0,extra=""){out.push('<text x="'+x+'" y="'+y+'" font-size="'+z+'" fill="'+esc(c)+'"'+(max&&units(v)*z>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');}
    function wrapped(v,x,y,w,z,c,anchor="middle"){const lines=wrapService(v,w,z);lines.forEach((v,i)=>label(v,x,y+i*(z+4),z,c,w,'text-anchor="'+anchor+'"'));return lines.length*(z+4);}
    const arrow=(x,y,c=ac,scale=1,role="signage")=>out.push('<path data-direction-arrow="true" data-arrow-role="'+role+'" d="M '+x+' '+y+' h '+(46*scale)+' m '+(-16*scale)+' '+(-16*scale)+' l '+(16*scale)+' '+(16*scale)+' -'+(16*scale)+' '+(16*scale)+'" fill="none" stroke="'+esc(c)+'" stroke-width="'+(6*scale)+'"/>');
    function header(){
      rect(0,0,W,headerH,guide?"#101316":profile==="chongqing-screen"?"#edc646":ac);
      if(profile==="suzhou")out.push('<path d="M180 0H1260Q1210 112 720 112Q230 112 180 0" fill="#ffffff" fill-opacity=".14"/>');
      if(profile==="wuxi-screen"){
        for(let x=170;x<1270;x+=65)out.push('<path data-window-pattern="true" d="M'+x+' 0q32 42 64 0" fill="none" stroke="#ffffff" stroke-opacity=".4" stroke-width="4"/>');
        rect(355,18,730,80,"#fff5e9",38);rect(363,26,714,64,ac,32);
      }
      const ink=profile==="chongqing-screen"?"#26313c":"#ffffff";
      out.push(passengerIcon(isBus?"bus":"train",24,30,53,guide?color:ink));
      label(data.ref||"线路",92,58,31,guide?color:ink,195,'font-weight="800"');
      label(isBus?"BUS":"RAIL TRANSIT",94,87,13,ink,180);
      label(p.phase==="arrived"?"当前站  THIS STATION":"下一站  NEXT STATION",375,42,17,guide?color:ink,680);
      label(selected<0?"请选择当前站":(p.phase==="arrived"?active:next)?.name||terminus(data),375,89,38,guide?color:ink,660,'font-weight="750"');
      label("终点站  DESTINATION",1120,42,14,ink,285);label(terminus(data),1120,82,25,ink,285);
    }
    function stationMap(top,animated=false){
      const positions=[],returning=["macau-fold","suzhou","platform"].includes(profile)||rows.length>1;
      rows.forEach((row,r)=>{
        const reverse=returning&&r%2===1,used=row.reduce((a,b)=>a+b.slot,0),gap=(rowWidth-used)/Math.max(1,row.length-1);
        let x=80;const y=top+44+r*rowH+(diagonal?145:vertical?44:64);
        out.push('<g data-station-row="'+r+'" data-row-count="'+row.length+'">');
        const rowPoints=row.map(o=>{const q={...o,x:x+o.slot/2,y};x+=o.slot+gap;return q;});
        if(reverse)for(const q of rowPoints)q.x=W-q.x;
        for(const q of rowPoints)positions[q.i]=q;
        const first=rowPoints[0],last=rowPoints.at(-1);
        path('M'+first.x+' '+y+'H'+last.x,mut,11,'data-route-casing="true"');
        path('M'+first.x+' '+y+'H'+last.x,ac,6,'data-route-segment="true"');
        if(row.length>1){
          const step=reverse?-1:1;
          for(let k=0;k<rowPoints.length-1;k++){
            const a=rowPoints[k],b=rowPoints[k+1],cx=(a.x+b.x)/2;
            out.push('<g data-flow-chevron="true">'+(animated?'<animateTransform attributeName="transform" type="translate" values="0 0;'+(step*13)+' 0;0 0" dur="1.6s" repeatCount="indefinite"/>':""));
            path('M'+(cx-step*6)+' '+(y-4)+'l'+(step*5)+' 4 -'+(step*5)+' 4',a.i<selected?mut:ac,2);out.push('</g>');
          }
        }
        rowPoints.forEach(q=>{
          const stop=stops[q.i],passed=q.i<selected,c=q.i===selected?ac:passed?mut:fg,rad=q.i===selected?12:7;
          out.push('<g data-stop-index="'+q.i+'"><title>'+esc((data.roundtrip?"":(q.i+1)+". ")+stop.name+(stop.nameEn?" · "+stop.nameEn:"")+(stop.transfers.length?" · "+stop.transfers.join(" / "):""))+'</title>');
          out.push('<circle cx="'+q.x+'" cy="'+q.y+'" r="'+rad+'" fill="'+esc(q.i===selected?ac:bg)+'" stroke="'+esc(profile==="chongqing-screen"?(passed?"#ce3445":"#30a76a"):c)+'" stroke-width="4"/>');
          if(q.i===selected)out.push('<circle data-current-lamp="true" cx="'+q.x+'" cy="'+q.y+'" r="19" fill="none" stroke="'+esc(ac)+'" stroke-width="2">'+(animated?'<animate attributeName="opacity" values="1;.15;1" dur="1.6s" repeatCount="indefinite"/>':"")+'</circle>');
          if(vertical){
            const chars=[...stop.name],depth=Math.min(8,chars.length),n=Math.ceil(chars.length/depth);
            chars.forEach((v,k)=>label(v,q.x+(Math.floor(k/depth)-(n-1)/2)*21,q.y+42+(k%depth)*23,size,c,0,'text-anchor="middle"'));
          }else if(diagonal)label(stop.name,q.x-75,q.y-26,20,c,180,'text-anchor="start" transform="rotate(-42 '+(q.x-75)+' '+(q.y-26)+')"');
          else wrapped(stop.name,q.x,q.y+42,q.slot+Math.max(0,gap)-8,20,c);
          const hint=isBus?signHints(stop):stop.transfers.join(" / ");
          if(hint&&!isBus){out.push(transferBadges(stop,q.x,diagonal?q.y+24:q.y-63,Math.max(24,q.slot+gap-6),13));}
          if(hint&&isBus){
            const mark=transferKind(stop.transfers[0])==="航空"?"plane":stop.facilities?.includes("hospital")?"hospital":stop.facilities?.includes("school")?"school":"train";
            const hy=diagonal?q.y+28:q.y-72;
            out.push(passengerIcon(mark,q.x-10,hy,20,ac));
            label(hint,q.x,hy+40,12,ac,Math.max(20,q.slot+gap-5),'text-anchor="middle"');
          }
          if(stop.nameEn)label(stop.nameEn,q.x,top+(r+1)*rowH+15,11,mut,q.slot+Math.max(0,gap)-5,'text-anchor="middle"');
          out.push('</g>');
        });
        out.push('</g>');
      });
      for(let i=1;i<positions.length;i++){const a=positions[i-1],b=positions[i];if(a.y!==b.y){const side=a.x>W/2?1400:40;const d=foldedJoin(a,b,side);path(d,mut,11,'data-route-casing="true"');path(d,ac,6,'data-route-segment="true" data-route-join="true"');}}
      if(data.roundtrip)loopPath(out,positions[0],positions.at(-1),30,1410,top+6,ac,6);
      throughIntervals(out,data,stops,positions,W);
      arrow(positions[0].x,positions[0].y-26,ac,.6,"running");
      return positions;
    }
    function doors(x,y,animated){
      const open=p.phase==="arrived",closing=p.phase==="closing",known=p.doorSide!=="unknown";
      rect(x,y,166,154,"#edf1f4",13);
      for(let i=0;i<2;i++){
        out.push('<g data-door-leaf="'+i+'" transform="translate('+(open?(i?-0+24:-24):0)+' 0)">');
        if(animated&&known&&(open||closing))out.push('<animateTransform attributeName="transform" type="translate" values="'+(closing?(i?'24 0;0 0;0 0':'-24 0;0 0;0 0'):(i?'0 0;24 0;24 0':'0 0;-24 0;-24 0'))+'" dur="4s" repeatCount="indefinite"/>');
        rect(x+10+i*73,y+9,70,136,known?ac:"#81909b",5);rect(x+23+i*73,y+23,43,65,"#d9eff7",5);out.push('</g>');
      }
      if(!known){path('M'+(x+28)+' '+(y+125)+'L'+(x+138)+' '+(y+28),mut,5);}
      label(p.doorSide==="unknown"?"开门侧待设置":p.doorSide==="both"?"两侧开门":p.doorSide==="left"?"左侧开门":"右侧开门",x+83,y+184,22,fg,200,'text-anchor="middle"');
      if(p.doorLabel)label(p.doorLabel,x+83,y+214,18,ac,200,'text-anchor="middle"');
    }
    function platform(top,animated=false){
      rect(28,top+8,1384,platformH-14,guide?"#20272b":"#f0f4f6",20);
      label(active?.name||"未指定当前站",56,top+65,38,guide?"#ffffff":fg,420,'font-weight="750"');
      if(active?.nameEn)label(active.nameEn,58,top+93,17,guide?"#c5d1d4":mut,420);
      label(state,58,top+126,20,ac,650);
      const trainX=68,trainY=top+224,trainW=1060,gap=5,cw=(trainW-(p.cars-1)*gap)/p.cars;
      path('M'+trainX+' '+(trainY+81)+'H'+(trainX+trainW),mut,4);
      path('M'+trainX+' '+(trainY-40)+'H'+(trainX+trainW),mut,2);

      if(p.leftExit){out.push(passengerIcon("exit",trainX,top+135,27,ac));label("← "+p.leftExit,trainX+40,top+158,20,guide?"#ffffff":fg,440);}
      if(p.rightExit){out.push(passengerIcon("exit",650,top+135,27,ac));label(p.rightExit+" →",690,top+158,20,guide?"#ffffff":fg,420);}
      for(let i=0;i<p.cars;i++){
        const cx=trainX+i*(cw+gap),currentCar=i+1===p.car;
        out.push('<g data-carriage="'+(i+1)+'">');
        rect(cx,trainY,cw,64,currentCar?ac:"#d7dfe4",i===0||i===p.cars-1?18:5);
        if(cw>42){rect(cx+9,trainY+9,cw-18,18,currentCar?"#d8f4ff":"#f7fafb",4);for(let k=0;k<2;k++)rect(cx+cw*(.36+k*.22)-3,trainY+32,6,20,currentCar?"#ffffff":"#abb9c2",1);}
        label(String(i+1),cx+cw/2,trainY+55,Math.min(24,cw*.55),currentCar?"#ffffff":"#44515d",cw-8,'text-anchor="middle" font-weight="750"');
        out.push('<circle cx="'+(cx+cw*.23)+'" cy="'+(trainY+68)+'" r="5" fill="#4f5e68"/><circle cx="'+(cx+cw*.77)+'" cy="'+(trainY+68)+'" r="5" fill="#4f5e68"/>');
        if(currentCar){out.push('<path d="M'+(cx+cw/2-10)+' '+(trainY-28)+'l10 16 10-16z" fill="'+esc(ac)+'"/>');}
        out.push('</g>');
      }
      for(const [i,kind] of p.facilities.entries()){
        const fx=480+i*120;out.push(passengerIcon(kind,fx,top+77,31,ac));
        label(({wc:"卫生间",accessible:"无障碍",lift:"电梯",stairs:"楼扶梯"})[kind],fx+15,top+128,14,mut,100,'text-anchor="middle"');
      }
      const carX=trainX+(p.car-1)*(cw+gap)+cw/2;
      label("当前车厢 "+p.car,carX,trainY+111,17,ac,150,'text-anchor="middle"');
      label(p.carsKnown?"编组 "+p.cars+" 节":"车厢示意",900,top+64,16,mut,200);
      doors(1190,top+54,animated);
      rect(44,top+365,1352,30,p.phase==="closing"?"#a9670a":p.phase==="arrived"&&p.doorSide!=="unknown"?"#177955":"#3f505b",8);
      label((p.doorLabel?p.doorLabel+"  ·  ":"")+state+(p.doorSide==="unknown"?"":"  ·  "+({left:"左侧开门",right:"右侧开门",both:"两侧开门"})[p.doorSide]),720,top+386,17,"#ffffff",1290,'text-anchor="middle"');
    }
    function focus(top,animated=false){
      if(!focusH)return;
      const target=selected<0?-1:p.phase==="arrived"?selected:next?stops.indexOf(next):selected;
      const served=stops.map((_,i)=>i).filter(i=>stopState(data,i)==="stopping"),at=served.indexOf(target),indices=[at-1,at,at+1].map(i=>data.roundtrip&&at>=0?served[(i+served.length)%served.length]:served[i]??-1);
      const garden=profile==="wuxi-screen",macau=profile==="macau";
      out.push('<g data-neighbour-focus="'+profile+'">');
      rect(28,top+6,1384,focusH-18,guide?"#20272b":profile==="songjiang"?"#f8eaf0":"#eef4f5",16);
      if(garden){
        for(const cx of [112,1328]){
          out.push('<path data-garden-window="true" d="M'+(cx-46)+' '+(top+55)+'l28-28h36l28 28v68l-28 28h-36l-28-28z" fill="none" stroke="'+esc(ac)+'" stroke-width="3"/>');
          path('M'+(cx-42)+' '+(top+52)+'h18v24h-18m88-24h-18v24h18M'+cx+' '+(top+50)+'v80m-22-61 22 21 22-34m-22 44 27 14',ac,2);
        }
      }
      const xs=garden?[365,720,1075]:macau?[230,650,1030]:[235,720,1205];
      path('M'+xs[0]+' '+(top+88)+'H'+xs[2],ac,profile==="songjiang"?13:8);
      for(const [j,index] of indices.entries()){
        const stop=target>=0?stops[index]:null,cx=xs[j],main=j===1;
        if(main&&garden)out.push('<path d="M560 '+(top+222)+'V'+(top+110)+'Q560 '+(top+22)+' 720 '+(top+22)+'Q880 '+(top+22)+' 880 '+(top+110)+'V'+(top+222)+'Z" fill="'+esc(ac)+'"/>');
        out.push('<circle cx="'+cx+'" cy="'+(top+88)+'" r="'+(main?23:12)+'" fill="'+esc(main?ac:bg)+'" stroke="'+esc(garden&&main?"#ffffff":ac)+'" stroke-width="'+(main?6:4)+'"/>');
        label(main?(p.phase==="arrived"?"当前站 / THIS STATION":"下一站 / NEXT STATION"):j===0?"上一站":"后续站",cx,top+(main?(garden?58:39):47),main?18:15,garden&&main?"#ffffff":ac,300,'text-anchor="middle"');
        wrapped(stop?.name||(target<0&&main?"请选择当前站":"—"),cx,top+149,main?290:260,main?26:23,garden&&main?"#ffffff":fg);
        if(stop?.nameEn)label(stop.nameEn,cx,top+210,14,garden&&main?"#ffffff":mut,280,'text-anchor="middle"');
      }
      if(animated)out.push('<g data-focus-arrow="true"><animateTransform attributeName="transform" type="translate" values="0 0;18 0;0 0" dur="1.6s" repeatCount="indefinite"/>'+passengerIcon("exit",xs[0]+130,top+70,35,ac)+'</g>');
      out.push('</g>');
    }
    function signage(top){
      const ink=guide?"#ffffff":fg;
      rect(28,top,1384,156,"#111416",8);
      out.push(passengerIcon("train",56,top+32,65,"#ffffff"));arrow(146,top+65,"#ffffff",1.2);
      label("乘车 / TO TRAIN",245,top+53,18,"#ffffff",580);label("往 "+terminus(data),245,top+111,39,"#ffffff",850);
      label(data.ref||"线路",1165,top+106,48,color,210,'font-weight="800"');
      if(p.leftExit||p.rightExit){rect(28,top+174,1384,98,"#111416",8);out.push(passengerIcon("exit",53,top+197,52,color));if(p.leftExit)label("← "+p.leftExit,136,top+238,32,color,575);if(p.rightExit)label(p.rightExit+" →",780,top+238,32,color,575);}
      return p.leftExit||p.rightExit?294:176;
    }
    let extra=0;
    rect(0,0,W,staticH+(guide?294:0),bg);header();
    if(guide)extra=signage(headerH+22);
    focus(headerH+extra);
    stationMap(headerH+extra+focusH);
    platform(headerH+extra+focusH+routeH);
    const height=staticH+extra;
    // A bottom colour band, ornamental window rail and dated bilingual blocks
    // distinguish the source structures rather than recolouring one generic map.
    if(profile==="ningbo"){rect(0,height-44,W,44,ac);label(state+"  "+(active?.name||"未指定当前站"),42,height-14,22,"#ffffff",1350);}
    const metadata=busMetadata(template,[{route:data}]).replace('</metadata>','</metadata><metadata>'+esc(JSON.stringify({passenger:p,manualPreview:true,geography:data.geography?{sourceTime:data.geography.sourceTime}:null}))+'</metadata>');
    const shell=(body,h)=>'<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+h+'" viewBox="0 0 '+W+' '+h+'" data-screen-layout="'+profile+'" data-passenger-screen="true"><title>'+esc(data.title+" · "+template.title)+'</title><desc>完整站序，手动预览，非实时到站</desc>'+metadata+'<g font-family="Microsoft YaHei,system-ui,sans-serif">'+body+'</g></svg>';
    if(data.demo)label("示例线路",W-30,height-15,14,mut,140,'text-anchor="end"');
    const svg=shell(out.join(""),height);
    const motionH=Math.max(headerH+extra+focusH+routeH+24,headerH+platformH+30);
    out=[];rect(0,0,W,motionH,bg);header();
    const makePage=(name,draw,values)=>{out.push('<g data-passenger-page="'+name+'" opacity="'+(p.page==="platform"?(name==="platform"?1:0):(name==="route"?1:0))+'">');if(p.page==="cycle")out.push('<animate attributeName="opacity" values="'+values+'" keyTimes="0;.44;.5;.94;1" dur="16s" repeatCount="indefinite"/>');draw();out.push('</g>');};
    makePage("route",()=>{if(guide)signage(headerH+18);focus(headerH+extra,true);stationMap(headerH+extra+focusH,true);},"1;1;0;0;1");
    makePage("platform",()=>platform(headerH+22,true),"0;0;1;1;0");
    if(data.demo)label("示例线路",W-30,motionH-8,14,mut,140,'text-anchor="end"');
    const motionSvg=shell(out.join(""),motionH);
    return {svg,motionSvg,width:W,height,stationCount:stops.length,renderedStations:stops.length,demo:data.demo,screenLayout:s.screenLayout||null,realtime:false,passenger:p,passengerPages:["route","platform"],rowCounts:rows.map(p=>p.length)};
  }

  function renderScreen(template,data,stops,current){
    if(passengerLayouts.has(template.style.screenLayout))return renderPassengerScreen(template,data,stops,current);
    const s=template.style,screenName=s.screenLayout,layout=({nanjing:"diagonal","chongqing-screen":"alternating","wuxi-screen":"alternating",fuzhou:"alternating",platform:"focus",ningbo:"diagonal",suzhou:"focus",songjiang:"focus",macau:"focus","macau-fold":"return",wayfinding:"alternating"})[screenName]||screenName,accent=s.accent==="route"?data.color:s.accent,width=1440,cols=s.columns;
    const visibleStops=data.type==="bus"?busStops(stops):stops;
    const referenceScreen=Object.hasOwn({nanjing:1,"chongqing-screen":1,"wuxi-screen":1,fuzhou:1,platform:1,ningbo:1,suzhou:1,songjiang:1,macau:1,"macau-fold":1,wayfinding:1},screenName);
    const nameDepth=Math.max(1,...visibleStops.map(p=>referenceScreen&&["alternating","marquee"].includes(layout)?Math.min(8,[...p.name].length):[...p.name].length));
    const vertical=layout==="alternating"||layout==="marquee",rowH=vertical?Math.max(300,2*(100+nameDepth*23)):layout==="diagonal"?Math.max(235,100+Math.min(nameDepth*14,220)):Math.max(206,130+Math.ceil(nameDepth/Math.max(3,Math.floor(1240/cols/23)))*27);
    const focusExtra=Math.max(0,Math.ceil(nameDepth/(screenName==="songjiang"?5:6))-2)*(screenName==="songjiang"?43:33);
    const rows=Math.ceil(stops.length/cols),startY=layout==="focus"?435+focusExtra:188;
    const mapHeight=rows*rowH+(data.roundtrip?42:0),services=busServiceRows(data,1336,19),footerY=startY+mapHeight+34,height=footerY+services.length*27+(screenName==="ningbo"?148:72);
    let out=[];
    const rect=(x,y,w,h,fill,rx=0)=>out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+esc(fill)+'"/>');
    function label(v,x,y,size=24,fill=s.text,max=0,extra=""){
      out.push('<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+esc(fill)+'"'+(max&&units(v)*size>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');
    }
    const header=()=>{

      const next=current>=0?busNext(data,stops,current):"未指定当前站",terminal=terminus(data),profile=screenName;
      if(profile==="ningbo"){
        rect(0,footerY+services.length*27+20,width,98,accent);
        label(data.ref||"线路",36,footerY+services.length*27+83,40,"#ffffff",145,'font-weight="800"');
        label("下一站  "+next,210,footerY+services.length*27+81,34,"#ffffff",730);
        label("终点站  "+terminal,980,footerY+services.length*27+80,24,"#ffffff",420);return;
      }
      if(["nanjing","chongqing-screen","wuxi-screen","fuzhou","macau-fold"].includes(profile)){
        const bar=profile==="chongqing-screen"?"#edc443":profile==="macau-fold"?"#276caa":accent,ink=profile==="chongqing-screen"?"#212b35":"#ffffff";
        rect(0,0,width,114,bar);rect(26,18,130,78,profile==="macau-fold"?"#ffdc62":s.background,7);
        label(data.ref||"线路",91,72,37,profile==="macau-fold"?"#253c59":accent,110,'text-anchor="middle" font-weight="800"');
        label("下一站",184,37,18,ink);label(next,184,86,43,ink,760,'font-weight="750"');
        label("终点站",1010,37,18,ink);label(terminal,1010,86,31,ink,390);
        if(profile==="fuzhou"){rect(0,114,1440,18,"#b5d7ee");}
        return;
      }
      if(profile==="suzhou"){
        out.push('<path d="M 0 0 H 1440 V 91 Q 720 178 0 91 Z" fill="'+esc(accent)+'"/>');
        label(data.ref||"线路",38,65,35,"#ffffff",160,'font-weight="800"');label("下一站  "+next,250,72,42,"#ffffff",770,'font-weight="700"');label("终点站  "+terminal,1060,62,24,"#ffffff",340);return;
      }
      if(profile==="songjiang"){
        rect(0,0,width,117,accent);label(data.ref||"线路",34,75,45,"#ffffff",190,'font-weight="800"');
        label("终点站  "+terminal,280,73,35,"#ffffff",1100);return;
      }
      if(profile==="wayfinding"){
        rect(0,0,width,138,s.background);rect(0,0,15,138,accent);
        label(current>=0?stops[current].name:"请选择当前站",44,65,51,s.text,850,'font-weight="800"');
        if(current>=0&&stops[current].nameEn)label(stops[current].nameEn,47,111,24,accent,850);
        label(data.ref||"线路",1010,55,38,accent,370);label("终点站  "+terminal,1010,108,26,s.text,380);return;
      }
      if(profile==="platform"){
        rect(0,0,width,118,accent);label(data.ref||"线路",34,77,42,"#ffffff",160,'font-weight="800"');label("下一站  "+next,245,76,42,"#ffffff",760);
        label("终点站  "+terminal,1040,74,25,"#ffffff",360);return;
      }
      if(profile==="macau"){
        rect(0,0,width,118,accent);label(data.ref||"线路",38,76,45,"#ffffff",160,'font-weight="800"');label("终点站  "+terminal,250,74,36,"#ffffff",1140);return;
      }

      rect(0,0,width,132,s.background);rect(0,0,width,7,accent);rect(30,28,142,78,accent,8);
      label(data.ref||"线路",101,80,39,s.background,122,'text-anchor="middle" font-weight="750"');
      label("下一站",202,49,20,s.muted);label(current>=0?busNext(data,stops,current):"未指定当前站",202,95,39,s.text,690,'font-weight="700"');
      label("终点站",984,49,20,s.muted);label(terminus(data),984,95,31,s.text,420,'font-weight="650"');
      separator(out,30,131,1410,131,s.muted);
    };
    function dot(x,y,i,animated=false){
      const passed=current>=0&&i<current,c=screenName==="chongqing-screen"?(passed?"#cf3a43":"#33975f"):passed?s.muted:accent,selected=i===current;
      out.push('<circle cx="'+x+'" cy="'+y+'" r="'+(selected?13:screenName==="fuzhou"?11:8)+'" fill="'+esc(selected?accent:s.background)+'" stroke="'+esc(selected?s.text:c)+'" stroke-width="4"/>');
      if(selected)out.push('<circle data-current-lamp="true" cx="'+x+'" cy="'+y+'" r="20" fill="none" stroke="'+esc(accent)+'" stroke-width="3">'+(animated?'<animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite"/>':"")+'</circle>');
    }
    const wrap=(value,x,y,size,fill,limit=7)=>{const chars=[...value];for(let k=0;k<chars.length;k+=limit)label(chars.slice(k,k+limit).join(""),x,y+Math.floor(k/limit)*(size+5),size,fill,0,'text-anchor="middle"');};
    function station(stop,i,x,y,mode,animated=false){
      const color=current>=0&&i<current?s.muted:s.text;
      out.push('<g data-stop-index="'+i+'"><title>'+esc(stop.name+(stop.nameEn?" · "+stop.nameEn:"")+(stop.transfers.length?" · 换乘 "+stop.transfers.join(" / "):""))+'</title>');
      dot(x,y,i,animated);
      if(mode==="vertical"){
        const up=layout==="alternating"&&i%2===0,chars=[...stop.name];
        if(referenceScreen){const depth=Math.min(8,chars.length),n=Math.ceil(chars.length/depth);chars.forEach((c,k)=>label(c,x+(Math.floor(k/depth)-(n-1)/2)*23,up?y-36-(depth-1-k%depth)*23:y+48+(k%depth)*23,22,color,0,'text-anchor="middle"'));}
        else chars.forEach((c,k)=>label(c,x,up?y-36-(chars.length-1-k)*23:y+48+k*23,22,color,0,'text-anchor="middle"'));
      }else if(mode==="diagonal"){
        label(stop.name,x-75,y-26,23,color,190,'transform="rotate(-43 '+(x-75)+' '+(y-26)+')"');
      }else wrap(stop.name,x,y+45,22,color,Math.max(3,Math.floor(1240/cols/23)));
      const detailsY=mode==="vertical"?y+62+nameDepth*23:mode==="diagonal"?y+52:y+48+Math.ceil([...stop.name].length/Math.max(3,Math.floor(1240/cols/23)))*27;
      if(stop.nameEn)label(stop.nameEn,x,detailsY,12,s.muted,Math.min(128,1240/cols-8),'text-anchor="middle"');
      const hint=data.type==="bus"?signHints(stop):(stop.transfers.length?"换乘 "+stop.transfers.join(" / "):"");
      if(hint){if(data.type==="bus")label(hint,x,detailsY+23,13,accent,Math.min(128,1240/cols-8),'text-anchor="middle"');else out.push(transferBadges(stop,x,detailsY+7,Math.min(128,1240/cols-8),13));}
      if(i===current&&!data.roundtrip)label("当前站",x,y+(mode==="diagonal"?26:layout==="alternating"&&i%2===0?35:-28),14,accent,0,'text-anchor="middle"');
      out.push('</g>');
    }
    function map(animated){
      const positions=[];
      for(let r=0;r<rows;r++){
        const n=Math.min(cols,stops.length-r*cols),usedCols=Math.min(cols,stops.length),reverse=["return","loop","focus"].includes(layout)&&r%2===1;
        const top=startY+r*rowH,y=top+(vertical?rowH/2:layout==="diagonal"?rowH-76:30);
        for(let c=0;c<n;c++)positions.push({x:100+(reverse?usedCols-1-c:c)*1240/Math.max(1,usedCols-1),y});
      }
      for(let i=1;i<positions.length;i++){
        const p=positions[i-1],q=positions[i];
        if(p.y===q.y)routeSegment(out,p.x,p.y,q.x,q.y,accent,6);
        else if(["return","loop","focus"].includes(layout)){
          const right=p.x>width/2,x=right?1390:50;
          out.push('<path data-route-segment="true" data-route-join="true" d="'+foldedJoin(p,q,x)+'" fill="none" stroke="'+esc(accent)+'" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>');
        }else label("→",1380,p.y+8,27,accent);
      }
      if(data.roundtrip)loopPath(out,positions[0],positions.at(-1),35,1405,startY-4,accent,6);
      throughIntervals(out,data,stops,positions,width);
      visibleStops.forEach((stop,i)=>station(stop,i,positions[i].x,positions[i].y,vertical?"vertical":layout==="diagonal"?"diagonal":"wrapped",animated));
    }
    function focus(){
      const index=current>=0?current:0,near=screenName==="songjiang"?3:5,start=Math.max(0,Math.min(index-1,stops.length-near)),subset=stops.slice(start,start+near),gap=(screenName==="macau"?870:1240)/Math.max(1,subset.length-1);
      label("当前站  "+(current>=0?stops[current].name:"未指定"),52,180,23,accent,1336);
      routeSegment(out,100,238,100+(subset.length-1)*gap,238,accent,6);
      subset.forEach((p,k)=>{const i=start+k,x=100+k*gap;out.push('<g data-focus-stop-index="'+i+'">');dot(x,238,i);wrap(p.name,x,290,screenName==="songjiang"?38:28,i===current?accent:s.text,screenName==="songjiang"?5:6);out.push("</g>");});
      if(screenName==="platform"){rect(52,330+focusExtra,1336,36,"#e9eeeb",4);label("开门侧／车厢编组未提供",70,355+focusExtra,18,s.muted,1290);}
      if(screenName==="macau"){rect(1050,153,352,211+focusExtra,"#e0ebec",8);label("运营信息",1070,192,23,accent,310);const notes=busServiceRows(data,310,15);notes.slice(0,5).forEach((v,i)=>label(v,1070,229+i*24,15,s.text,310));}
      separator(out,40,380+focusExtra,1400,380+focusExtra,s.muted);label("全线站序",52,418+focusExtra,19,s.muted);
    }
    const shell=(body,h,description)=>'<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+h+'" viewBox="0 0 '+width+' '+h+'" role="img" data-screen-layout="'+screenName+'" aria-label="'+esc(data.title+" · "+template.title)+'"><title>'+esc(data.title+" · "+template.title)+'</title><desc>'+esc(description+' · 手动预览，非实时到站')+'</desc>'+busMetadata(template,[{route:data}])+'<g font-family="'+(referenceScreen?"Microsoft YaHei,system-ui,sans-serif":"system-ui,sans-serif")+'">'+body+'</g></svg>';
    rect(0,0,width,height,s.background);header();
    if(layout!=="focus")label("当前站  "+(current>=0?stops[current].name:"未指定"),52,169,20,accent,1336);else focus();
    map(false);separator(out,40,footerY-14,1400,footerY-14,s.muted);
    services.forEach((v,i)=>label(v,52,footerY+18+i*27,19,s.muted,1336));
    if(busNotice(data))label(busNotice(data),52,height-22,17,s.muted,1336);
    const svg=shell(out.join(""),height,"完整线路图 · "+data.title);
    let motionSvg;
    if(layout==="marquee"){
      out=[];const motionHeight=Math.max(510,400+nameDepth*23),period=Math.max(1344,stops.length*164+64),duration=Math.max(18,period/52);
      rect(0,0,width,motionHeight,s.background);header();label("当前站  "+(current>=0?stops[current].name:"未指定"),52,171,22,accent,1336);
      out.push('<svg x="48" y="195" width="1344" height="'+(motionHeight-242)+'" viewBox="0 0 1344 '+(motionHeight-242)+'" overflow="hidden"><g data-marquee-track="true"><animateTransform attributeName="transform" type="translate" from="0 0" to="-'+period+' 0" dur="'+duration+'s" repeatCount="indefinite"/>');
      for(let copy=0;copy<2;copy++){
        out.push('<g transform="translate('+(copy*period)+' 0)"'+(copy?' aria-hidden="true"':"")+'>');
        routeSegment(out,40,42,period-24,42,accent,6);
        visibleStops.forEach((stop,i)=>{const x=80+i*164;station(stop,i,x,42,"vertical",true);});out.push('</g>');
      }
      out.push('</g></svg>');if(busNotice(data))label(busNotice(data),52,motionHeight-20,17,s.muted,1336);
      motionSvg=shell(out.join(""),motionHeight,"全站序循环滚动 · "+data.title);
    }else if(current>=0){
      // Preserve exactly the static layout; animate only the selected lamp.
      motionSvg=svg.replace(/(<circle data-current-lamp="true"[^>]*>)<\/circle>/u,'$1<animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite"/></circle>');
    }
    return {svg,motionSvg,width,height,stationCount:stops.length,renderedStations:stops.length,demo:data.demo,screenLayout:screenName,realtime:false};
  }


  // Original SVG structures based on the numbered user references.
  const referenceBusLayouts=new Set(["gaoyang","gaoyang-detail","wuxi","mint","chengdu","shenzhen","shanghai","qingdao","weifang","lanzhou","wuhan","chongqing","chengmai","xiamen"]);
  function renderReferenceBus(template,entries,board=null){
    const s=template.style,L=s.busLayout,W=1440,out=[],dark=L.startsWith("gaoyang"),bg=s.background,fg=s.text,mut=s.muted,ac=s.accent==="route"?entries[0].route.color:s.accent;
    const station=entries[0].route.stops[entries[0].current],stationName=station?.name||null;
    const rect=(x,y,w,h,c=bg,rx=0)=>out.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+esc(c)+'"/>');
    function label(v,x,y,z=22,c=fg,max=1360,extra=""){out.push('<text x="'+x+'" y="'+y+'" font-size="'+z+'" fill="'+esc(c)+'"'+(max&&units(v)*z>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+' '+extra+'>'+esc(v)+'</text>');}
    const sep=(x,y,w,c=mut)=>separator(out,x,y,x+w,y,c);
    function lines(v,x,y,w,z=18,c=fg){const a=wrapService(v,w,z);a.forEach((p,i)=>label(p,x,y+i*(z+6),z,c,w));return a.length*(z+6);}
    const hours=r=>{const v=artworkService(r);return v.hours||[v.first,v.last].filter(Boolean).join("–")||"未提供";};
    function service(r,x,y,w,z=18,c=fg){const a=busServiceRows(r,w,z);a.forEach((v,i)=>label(v,x,y+i*(z+6),z,c,w));return a.length*(z+6);}
    function number(r,x,y,w=164,h=108,c=ac,ink=bg,round=0){rect(x,y,w,h,c,round);label(r.ref||"公交",x+w/2,y+h*.72,Math.min(78,h*.67),ink,w-18,'text-anchor="middle" font-weight="800" data-route-number="true"');}
    function direction(r,current,x,y,w,c=fg,z=23){label((r.roundtrip?"终点站  ":"开往 · 终点站  ")+terminus(r),x,y,z,c,w);label("下一站  "+busNext(r,r.stops,current),x,y+34,z-3,c,w);}
    function diagram(item,x,y,w,{diagonal=false,pin=false,highlight=false,ink=fg,lineColor=ac,arrow=false}={}){
      if(item.route.roundtrip){
        const stops=item.route.stops,plan=loopDiagramPlan(stops,w,{size:22});
        return drawLoopDiagram(out,plan,{x,y,stops,current:item.current,color:lineColor,background:bg,text:ink,muted:mut,label,highlight,pin,openStop:(p,i)=>out.push('<g data-stop-index="'+i+'"><title>'+esc(p.name+(p.nameEn?' · '+p.nameEn:'')+(signHints(p)?' · '+signHints(p):''))+'</title>')});
      }

      const stops=item.route.stops,z=diagonal?20:22,pad=diagonal?170:20,positions=[],available=w-pad-24;
      const sizeOf=p=>diagonal?53:Math.max(32,/[\p{Script=Han}]/u.test(p.name)?Math.ceil([...p.name].length/8)*22+10:57);
      const rows=measuredRows(stops,available,sizeOf);
      let top=y;
      for(const [rowIndex,row] of rows.entries()){
        out.push('<g data-station-row="'+rowIndex+'" data-row-count="'+row.length+'">');
        const n=row.length,gap=(available-row.reduce((v,p)=>v+p.slot,0))/Math.max(1,n-1);
        const depth=Math.max(...row.map(({i})=>/[\p{Script=Han}]/u.test(stops[i].name)?Math.min(8,[...stops[i].name].length):Math.ceil([...stops[i].name].length/3)));
        const english=false,hints=row.some(({i})=>signHints(stops[i]));
        const head=diagonal?185:36,dy=top+head,rh=diagonal?265:head+depth*(z+3)+22+(english?20:0)+(hints?22:0);
        let cursor=x+pad;
        const rowPoints=row.map(p=>{const px=cursor+p.slot/2;cursor+=p.slot+gap;return {...p,px};});
        const x0=rowPoints[0].px,x1=rowPoints.at(-1).px;routeSegment(out,x0,dy,x1,dy,lineColor,4);
        if(arrow&&n>1)out.push('<path d="M '+(x1-14)+' '+(dy-9)+' L '+(x1+3)+' '+dy+' L '+(x1-14)+' '+(dy+9)+'" fill="none" stroke="'+esc(lineColor)+'" stroke-width="4"/>');
        for(const {i,slot,px} of rowPoints){
          const p=stops[i],active=i===item.current;positions.push({x:px,y:dy});
          out.push('<g data-stop-index="'+i+'"><title>'+esc(p.name+(p.nameEn?" · "+p.nameEn:"")+(signHints(p)?" · "+signHints(p):""))+'</title>');
          const chars=[...p.name],nameDepth=Math.min(8,chars.length),ncol=Math.ceil(chars.length/nameDepth);
          if(active&&highlight)rect(px-slot/2+2,dy+15,slot-4,depth*(z+3)+6,ac,10);
          out.push('<circle cx="'+px+'" cy="'+dy+'" r="'+(active?8:5)+'" fill="'+esc(active?lineColor:bg)+'" stroke="'+esc(lineColor)+'" stroke-width="3"/>');
          if(active&&pin)out.push('<path data-current-pin="true" d="M '+px+' '+(dy-7)+' q -22 -26 0 -32 q 22 6 0 32" fill="#ce4249"/>');
          const color=active&&highlight?bg:active&&!dark?"#c83545":ink;
          if(diagonal)label(p.name,px-8,dy-18,z,color,226,'text-anchor="end" transform="rotate(45 '+(px-8)+' '+(dy-18)+')"');
          else if(/[\p{Script=Han}]/u.test(p.name))chars.forEach((c,j)=>label(c,px+(Math.floor(j/nameDepth)-(ncol-1)/2)*23,dy+35+(j%nameDepth)*(z+3),z,color,0,'text-anchor="middle"'));
          else for(let j=0;j<chars.length;j+=3)label(chars.slice(j,j+3).join(""),px,dy+35+j/3*(z+3),18,color,slot-5,'text-anchor="middle"');
          if(english&&p.nameEn)label(p.nameEn,px,diagonal?top+rh-28:dy+depth*(z+3)+32,11,ink,Math.max(12,slot-8),'text-anchor="middle"');
          if(signHints(p))label(signHints(p),px,top+rh-2,12,lineColor,Math.max(12,slot-8),'text-anchor="middle"');
          out.push('</g>');
        }
        top+=rh;out.push('</g>');
      }
      if(item.route.roundtrip)loopPath(out,positions[0],positions.at(-1),x+7,x+w-5,y+9,lineColor,4);
      return top-y;
    }

    function timetable(r,x,y,w){
      label("发车时间",x,y+30,29,fg,w);label("DEPARTURE TIME",x,y+56,14,mut,w);
      const value=artworkService(r).departures,groups=new Map();let day="发车时刻";
      for(const part of value.split(/[;\n]/u)){
        const tokens=[...part.matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)];if(!tokens.length)continue;
        const firstClock=part.search(/(?:[01]?\d|2[0-3]):[0-5]\d/u),prefix=part.slice(0,firstClock).trim();
        if(/(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH|工作日|节假日|每日)/u.test(part.slice(firstClock)))continue;
        if(prefix&&/^(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH|工作日|节假日|每日|周|星期)/u.test(prefix))day=prefix;
        if(!groups.has(day))groups.set(day,new Map());const hours=groups.get(day);
        for(const m of tokens){const h=m[1].padStart(2,"0");if(!hours.has(h))hours.set(h,[]);hours.get(h).push(m[2]);}
      }
      let top=y+82;
      for(const [day,hours] of groups){
        out.push('<g data-timetable-group="'+esc(day)+'">');label(day,x,top+25,20,ac,w);top+=45;
        for(const [h,mins] of hours){sep(x,top,w);label(h,x+12,top+29,23,ac,65);const a=wrapService(mins.join("  "),w-112,20);a.forEach((v,i)=>label(v,x+100,top+29+i*27,20,fg,w-112));top+=Math.max(44,a.length*27+15);}
        out.push('</g>');top+=15;
      }
      top+=lines(value||"未提供",x,top+27,w,17,mut)+32;return top-y;
    }
    function geographic(r,x,y,w,h){

      const located=r.stops.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)),context=r.geography;
      rect(x,y,w,h,dark?"#f4f5f2":"#e9efea",8);
      label(context?.complete?"城市路网 · 线路位置":"站点地理位置（连线示意）",x+20,y+32,22,"#263d3d",w-40);
      if(located.length!==r.stops.length||located.length<2){label("站点坐标未完整提供",x+25,y+h/2,24,"#62736e",w-50);return;}
      const lat0=located.reduce((a,p)=>a+p.lat,0)/located.length*Math.PI/180,base=located[0].lon,unwrap=lon=>{while(lon-base>180)lon-=360;while(lon-base< -180)lon+=360;return lon;};
      const project=p=>({x:unwrap(p.lon)*Math.cos(lat0),y:-p.lat,p});
      const points=located.map(project),xs=points.map(p=>p.x),ys=points.map(p=>p.y),pad=.004;
      const loX=Math.min(...xs)-pad,loY=Math.min(...ys)-pad,dx=Math.max(...xs)-loX+pad,dy=Math.max(...ys)-loY+pad;
      const k=Math.min((w-130)/Math.max(dx,1e-8),(h-130)/Math.max(dy,1e-8)),ox=x+(w-dx*k)/2,oy=y+60+(h-95-dy*k)/2;
      const at=p=>({x:ox+(p.x-loX)*k,y:oy+(p.y-loY)*k}),path=ps=>ps.map((p,i)=>{const q=at(project(p));return (i?"L ":"M ")+q.x+" "+q.y;}).join(" ");
      // Nested viewport clips full source geometry without truncating the data.
      out.push('<svg x="'+x+'" y="'+(y+48)+'" width="'+w+'" height="'+(h-48)+'" viewBox="'+x+' '+(y+48)+' '+w+' '+(h-48)+'" overflow="hidden">');
      const routeIds=new Set(context?.routeWayIds||[]);
      if(context?.complete){
        const roads=context.roads||[];
        for(const road of roads){const major=/^(motorway|trunk|primary|secondary|tertiary)(?:_link)?$/u.test(road.class);out.push('<path data-road-id="'+road.id+'" d="'+path(road.points)+'" fill="none" stroke="'+(major?"#bdc5c6":"#dce1df")+'" stroke-width="'+(major?5:2)+'" stroke-linecap="round"/>');}
        for(const road of roads.filter(p=>routeIds.has(p.id)))out.push('<path data-geographic-route-way="'+road.id+'" d="'+path(road.points)+'" fill="none" stroke="'+esc(ac)+'" stroke-width="5" stroke-linecap="round"/>');
        const labels=[];for(const road of roads){if(!road.name||! /^(motorway|trunk|primary|secondary|tertiary)$/u.test(road.class))continue;const q=at(project(road.points[Math.floor(road.points.length/2)]));if(q.x<x+75||q.x>x+w-75||q.y<y+80||q.y>y+h-40||labels.some(p=>Math.hypot(p.x-q.x,(p.y-q.y)*2)<100))continue;labels.push(q);label(road.name,q.x,q.y,13,"#73817e",110,'text-anchor="middle"');}
      }
      out.push('<g data-geographic-route="true">');
      if(!routeIds.size)out.push('<path data-station-chord="true" d="'+path(located)+'" fill="none" stroke="'+esc(ac)+'" stroke-width="3" stroke-dasharray="8 6"/>');
      points.forEach((p,i)=>{const q=at(p);out.push('<circle cx="'+q.x+'" cy="'+q.y+'" r="4" fill="#ffffff" stroke="'+esc(ac)+'" stroke-width="2"><title>'+esc(p.p.name)+'</title></circle>');if(i===0||i===points.length-1)label(p.p.name,q.x,q.y+(i===0?-13:26),17,"#263d3d",120,'text-anchor="middle"');});
      out.push('</g></svg>');
      if(context?.complete&&!routeIds.size)label("虚线为站点连线",x+20,y+h-12,13,"#62736e",w-40);

    }
    rect(0,0,W,200,bg);const mast=L==="wuxi"?"#17191d":L==="shenzhen"?"#0b3464":dark?bg:L==="mint"?bg:ac;
    rect(0,0,W,dark?202:174,mast);
    label(stationName||"请选择本站",42,dark?104:100,61,dark?fg:L==="mint"?fg:"#ffffff",1356,'font-weight="800"');
    if(station?.nameEn)label(station.nameEn,44,dark?155:143,25,dark?fg:L==="mint"?mut:"#ffffff",1352);
    else label("BUS STOP",44,dark?155:143,19,dark?mut:L==="mint"?mut:"#ffffff",1352);
    let top=dark?220:194;const two=L==="shanghai",cellW=two?662:1356,gap=32;
    const renderPanel=(item,x,y,w)=>{
      const r=item.route,current=item.current,v=artworkService(r),accent=s.accent==="route"?r.color:ac;let end=y;
      if(dark){
        rect(x,y,w,118,"#ffffff");number(r,x,y,238,118,ac,"#111215");
        label("开往 / TO",x+264,y+30,14,"#5e6368",50);label("终点站  "+terminus(r),x+320,y+39,25,"#181b20",w-740);
        label("下一站",x+264,y+77,14,"#5e6368",50);label(busNext(r,r.stops,current),x+320,y+88,22,"#181b20",w-740);
        label(v.operator||"未提供",x+w-405,y+43,20,"#1d2426",208);label("票价",x+w-180,y+35,13,"#626e73",168);
        label(hours(r),x+w-405,y+78,20,"#1d2426",260);lines(v.fare||"未提供",x+w-180,y+76,168,16,"#1d2426");
        const h=diagram(item,x,y+132,w,{ink:fg,lineColor:ac});end=y+132+h;
        const extra=[...((v.interval||!v.departures)?wrapService("班次间隔  "+(v.interval||"未提供"),w,17):[]),...(v.departures?wrapService("发车时刻  "+v.departures,w,17):[])];extra.forEach((p,i)=>label(p,x,end+23+i*24,17,mut,w));end+=extra.length*24+37;
        if(L==="gaoyang-detail"){geographic(r,x,end,w,420);end+=450;end+=timetable(r,x,end,w);}
      }else if(["mint","shenzhen","wuxi","lanzhou","wuhan","chengmai"].includes(L)){
        const side=L==="wuhan"?205:255,ds=busServiceRows(r,side-20,17),dTop=y+(L==="wuhan"?66:34);
        rect(x,y,w,Math.max(210,ds.length*23+180),bg);
        number(r,x+8,y+16,side-20,100,L==="shenzhen"?"#ffffff":accent,L==="shenzhen"?"#123d70":"#ffffff",L==="mint"?24:0);
        const sideBottom=y+150+service(r,x+12,y+150,side-28,17),rightX=x+side+20,rightW=w-side-34;
        if(L==="wuhan"){routeSegment(out,rightX,y+26,rightX+rightW,y+26,accent,4);label("→",rightX+rightW-28,y+18,30,accent,45);}
        direction(r,current,rightX,dTop,rightW);
        if(L==="chengmai"||L==="mint")rect(rightX,y+90,rightW,4,accent);
        const h=diagram(item,rightX,y+112,rightW,{pin:L==="mint",highlight:L==="shenzhen",arrow:["wuhan","wuxi"].includes(L),lineColor:accent});
        end=Math.max(sideBottom+20,y+112+h+16);
        if(L==="chengmai"||L==="mint"){
          const roads=[...new Set(r.stops.map(p=>p.street).filter(Boolean))].join(" · ");
          rect(rightX,end,rightW,42,L==="chengmai"?"#f3cf61":"#d5e8da",5);label(roads||"终点站  "+terminus(r),rightX+12,end+28,19,"#314638",rightW-24);end+=56;
        }
      }else if(L==="chengdu"||L==="chongqing"){
        const right=430,dx=x+w-right-20;rect(x,y,w,160,bg,14);
        number(r,dx+18,y+20,right-38,98,accent,"#ffffff",L==="chongqing"?18:0);direction(r,current,dx+24,y+160,right-50);
        label("最近一班",dx+24,y+240,18,mut,right-40);label(arrivalText(r),dx+24,y+278,30,accent,right-48);
        label("后续一班  "+arrivalText(r,true),dx+24,y+316,19,mut,right-48);
        const sh=service(r,dx+24,y+358,right-48,17),h=diagram(item,x+12,y+12,w-right-46,{diagonal:L==="chongqing",arrow:true});
        end=y+Math.max(h+30,358+sh+20);separator(out,dx,y+10,dx,end-12,mut);
      }else{
        const blue=L==="qingdao",paper=L==="shanghai",arrow=L==="weifang";
        rect(x,y,w,112,blue||paper?accent:bg,paper?12:0);
        number(r,x+8,y+8,150,96,blue||paper?"#ffffff":accent,blue||paper?accent:"#ffffff");
        direction(r,current,x+182,y+43,w-202,blue||paper?"#ffffff":fg,paper?21:25);
        const sh=service(r,x+12,y+146,w-24,18),h=diagram(item,x+12,y+164+sh,w-24,{arrow:blue||arrow});end=y+164+sh+h+14;
        if(arrow){rect(x+28,end,w-75,12,fg);out.push('<path d="M '+(x+w-60)+' '+(end-17)+' L '+(x+w-19)+' '+(end+6)+' L '+(x+w-60)+' '+(end+29)+'" fill="'+esc(fg)+'"/>');label("BUS",x+w/2,end+49,24,fg,w-40,'text-anchor="middle" font-weight="750"');end+=72;}
      }
      if(busNotice(r)){label(busNotice(r),x+8,end+22,16,mut,w-16);end+=38;}return end-y;
    };
    if(L==="xiamen"){
      label("线路发车",42,top+30,24,ac);top+=54;const cols=4,cw=324;
      for(let i=0;i<entries.length;i+=cols){entries.slice(i,i+cols).forEach((e,k)=>{const x=42+k*(cw+20);rect(x,top,cw,152,"#ffffff",12);label("发车信息",x+18,top+43,26,ac,cw-36);label(terminus(e.route),x+18,top+77,20,fg,cw-36);label("最近一班  "+arrivalText(e.route),x+18,top+111,17,ac,cw-36);label(hours(e.route),x+18,top+138,15,mut,cw-36);});top+=172;}
    }
    let priorOperator=null;
    for(let i=0;i<entries.length;i+=two?2:1){
      const batch=entries.slice(i,i+(two?2:1));let rh=0;
      if(L==="lanzhou"){const op=artworkService(batch[0].route).operator||"未提供";if(op!==priorOperator){rect(42,top,1356,46,"#426d62");label(op,56,top+31,23,"#ffffff",1328);top+=62;priorOperator=op;}}
      batch.forEach((e,k)=>{const x=42+k*(cellW+gap);out.push('<g data-board-route-index="'+(i+k)+'">');rh=Math.max(rh,renderPanel(e,x,top,cellW));out.push('</g>');});
      if(two&&batch.length>1)separator(out,720,top,720,top+rh,mut);
      top+=rh+20;if(i+batch.length<entries.length){sep(42,top,1356,dark?"#50545a":mut);top+=25;}
    }
    const height=top+28;out.unshift('<rect width="'+W+'" height="'+height+'" fill="'+esc(bg)+'"/>');
    if(board?.demo){label("示例站牌 · 非真实运营数据",42,top+17,16,mut);}
    const note="完整已读站序 · 本站为手动预览，非实时到站"+(!board?" · 仅展示当前线路":"")+(board&&!board.complete?" · 非全站完整清单":"");
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+height+'" viewBox="0 0 '+W+' '+height+'" data-reference-layout="'+L+'"><title>'+esc((stationName||entries[0].route.title)+" · "+template.title)+'</title><desc>'+esc(note)+'</desc>'+busMetadata(template,entries,board)+'<g font-family="system-ui,sans-serif">'+out.join("")+'</g></svg>';
    const total=entries.reduce((n,e)=>n+e.route.stops.length,0);
    return {svg,width:W,height,stationCount:total,renderedStations:total,lineCount:entries.length,stationName,demo:entries[0].route.demo,busLayout:L,realtime:false};
  }

  function renderLineArtwork(value,route,options={}){
    const template=normalize(value),data=options.simulation?.enabled?simulateService(route,{...options.simulation,current:options.current}):line(route),s=template.style,stops=options.reverse?[...data.stops].reverse():data.stops;
    const requested=Number.isInteger(options.current)&&options.current>=0&&options.current<stops.length?options.current:-1;
    data.displayTerminus=terminus(data);data.stops=stops;
    if(options.reverse)data.throughServices=data.throughServices.map(v=>({...v,fromIndex:stops.length-1-v.toIndex,toIndex:stops.length-1-v.fromIndex}));
    if(options.reverse){
      if(data.operatingPattern){const p=data.operatingPattern;data.operatingPattern={...p,fromIndex:stops.length-1-p.toIndex,toIndex:stops.length-1-p.fromIndex,skipIndexes:p.skipIndexes.map(i=>stops.length-1-i).sort((a,b)=>a-b)};}
      if(data.throughRoute)data.throughRoute={...data.throughRoute,segments:[...data.throughRoute.segments].reverse().map(v=>({...v,fromIndex:stops.length-1-v.toIndex,toIndex:stops.length-1-v.fromIndex}))};
    }
    const current=requested>=0&&stopState(data,requested)==='stopping'?requested:-1;
    const finish=result=>withOperatingPattern(withThroughServices(result,{...data,stops},template),data);
    if(template.family==="metro-guide")return finish(renderPassengerScreen(template,data,stops,current));
    if(s.screenLayout)return finish(renderScreen(template,data,stops,current));
    if(template.family==="bus-stop")return renderBus(template,data,stops,current);
    const accent=s.accent==="route"?data.color:s.accent,family=template.family,roll=family==="bus-rollsign",vertical=family==="bus-stop";
    const width=1440,columns=vertical?2:s.columns;
    const rows=vertical?Math.ceil(stops.length/2):Math.ceil(stops.length/columns);
    const nameColumns=vertical?20:Math.min(6,Math.max(2,Math.floor(1300/Math.max(columns-1,1)/24)));
    const maxLines=stops.reduce((n,stop)=>Math.max(n,Math.ceil([...stop.name].length/nameColumns)),1);
    const rowHeight=vertical?Math.max(86,40+maxLines*26):Math.max(220,112+maxLines*26);
    const height=roll?480:260+rows*rowHeight;
    const shapes=[];
    function rect(x,y,w,h,fill,rx=0){shapes.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+esc(fill)+'"/>');}
    function label(v,x,y,size=24,fill=s.text,max=0,extra=""){
      const len=[...String(v)].reduce((n,c)=>n+(/[\u0020-\u007e]/u.test(c)?0.56:1),0)*size;
      shapes.push('<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+esc(fill)+'"'+(max&&len>max?' textLength="'+max+'" lengthAdjust="spacingAndGlyphs"':"")+" "+extra+">"+esc(v)+"</text>");
    }
    function multiline(v,x,y,limit,size,fill=s.text,extra=""){const a=[...v];for(let i=0;i<a.length;i+=limit)label(a.slice(i,i+limit).join(""),x,y+(i/limit)*(size+5),size,fill,0,extra);}
    function marker(x,y,index){
      const passed=current>=0&&index<current,c=passed?s.muted:accent;
      if(s.shape==="square")rect(x-9,y-9,18,18,c,2);
      else shapes.push('<circle cx="'+x+'" cy="'+y+'" r="9" fill="'+esc(s.background)+'" stroke="'+esc(c)+'" stroke-width="5"/>');
      if(current===index)shapes.push('<circle cx="'+x+'" cy="'+y+'" r="17" fill="none" stroke="'+esc(s.text)+'" stroke-width="3"/>');
    }
    rect(0,0,width,height,s.background);
    rect(0,0,width,8,accent);
    if(roll){
      label(data.ref||data.title,54,176,108,accent,350,'font-weight="700"');
      label(busDirection(data,stops,current),460,130,54,s.text,900,'font-weight="700"');
      label(current>=0?nextLabel(data,stops,current):"",462,214,36,s.text,885);
      if(data.simulation){label("最近一班  "+arrivalText(data),54,292,29,s.text,1320);label("后续一班  "+arrivalText(data,true),54,342,27,s.muted,1320);label("票价  "+artworkService(data).fare+"   运营方  "+artworkService(data).operator,54,398,23,s.muted,1320);}

    }else{
      rect(40,30,156,95,accent,8);label(data.ref||"线路",118,91,38,s.background,136,'text-anchor="middle" font-weight="700"');
      label(data.title,222,66,32,s.text,1160,'font-weight="700"');
      label(data.roundtrip?"终点站  "+(terminus(data,stops)||"未提供"):(data.from||"未提供")+"  →  "+terminus(data,stops),222,111,25,s.muted,1160);
      if(family==="metro-lcd"||family==="metro-led"){
        label(current>=0?"当前站  "+stops[current].name+"     下一站  "+busNext(data,stops,current):"全线站序 · 可手动选择预览站点",48,166,28,accent,1330);
      }else label(families[family]+" · "+stops.length+" 站 · 按当前所选方向",48,166,22,s.muted);
      for(let r=0;r<rows;r++){
        const start=vertical?r*2:r*columns,count=Math.min(columns,stops.length-start),y=220+r*rowHeight;
        if(!vertical&&count>1)routeSegment(shapes,70,y,70+(count-1)*1300/Math.max(columns-1,1),y,accent,8);
        for(let c=0;c<count;c++){
          const i=start+c,stop=stops[i],x=vertical?64+c*700:70+c*(1300/Math.max(columns-1,1));
          shapes.push('<g data-stop-index="'+i+'"><title>'+esc((data.roundtrip?"":(i+1)+". ")+stop.name+(stop.transfers.length?" · 换乘 "+stop.transfers.join(" / "):""))+"</title>");
          marker(x,y,i);
          label(data.roundtrip?"":String(i+1).padStart(2,"0"),vertical?x+23:x,y+(vertical?8:-24),16,s.muted,0,vertical?"":'text-anchor="middle"');
          multiline(stop.name,vertical?x+65:x,y+(vertical?8:42),nameColumns,vertical?25:22,current>=0&&i<current?s.muted:s.text,vertical?"":'text-anchor="middle"');
          if(stop.nameEn)label(stop.nameEn,vertical?x+65:x,y+rowHeight-48,13,s.muted,vertical?530:Math.min(138,1300/Math.max(columns-1,1)-12),vertical?"":'text-anchor="middle"');
          if(stop.transfers.length)shapes.push(transferBadges(stop,vertical?x+65:x,y+rowHeight-40,vertical?530:Math.min(140,1300/Math.max(columns-1,1)-12),14,vertical?"start":"middle"));
          shapes.push("</g>");
        }
      }
    }
    if(!roll){const positions=stops.map((_,i)=>({x:70+(i%columns)*1300/Math.max(columns-1,1),y:220+Math.floor(i/columns)*rowHeight}));throughIntervals(shapes,data,stops,positions,width);}
    const note=(data.demo?"示例线路 · 非真实运营数据":"数据："+data.source+(data.sourceId?" · "+data.sourceId:""))+" · "+(current>=0?"当前位置为手动预览，非实时到站":"静态示意，非实时到站");
    if(data.roundtrip&&!roll){const count=stops.length-(rows-1)*columns;loopPath(shapes,{x:70,y:220},{x:70+(count-1)*1300/Math.max(columns-1,1),y:220+(rows-1)*rowHeight},24,1415,185,accent,8);}
    if(busNotice(data))label(busNotice(data),42,height-20,17,s.muted,1350);
    const svg='<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" role="img" aria-label="'+esc(data.title+" · "+template.title)+'"><title>'+esc(data.title+" · "+template.title)+'</title><desc>'+esc(note)+'</desc>'+busMetadata(template,[{route:data}])+'<g font-family="system-ui, sans-serif">'+shapes.join("")+"</g></svg>";
    return finish({svg,width,height,stationCount:stops.length,renderedStations:roll?0:stops.length,demo:data.demo});
  }
  // Process only SVG generated above. Keep transforms, clips and SMIL in their own parent.
  // Late return/through paths must paint before station-containing siblings at that level.
  function stationForegroundSvg(svg){
    const root={open:'',close:'',children:[],tag:''},stack=[root];
    for(const token of svg.match(/<[^>]*>|[^<]+/gu)||[]){
      if(/^<\//u.test(token)){const node=stack.pop();node.close=token;continue;}
      const tag=token.match(/^<([A-Za-z][\w:.-]*)\b/u)?.[1];
      if(!tag){stack.at(-1).children.push({text:token});continue;}
      const node={open:token,close:'',children:[],tag};
      stack.at(-1).children.push(node);
      if(!/\/>$/u.test(token))stack.push(node);
    }
    if(stack.length!==1)fail('线路图结构不完整');
    const track=node=>node.tag==='path'&&/\bdata-(?:route-(?:segment|casing|join|direction)|loop-return|through-line-source)=/u.test(node.open)||node.tag==='g'&&/\bdata-(?:through-track|flow-chevron)=/u.test(node.open);
    function paint(node,inactive=false){
      if(node.text!==undefined)return node.text;
      inactive=inactive||/\bdata-stop-state="(?:skipped|outside)"/u.test(node.open);
      if(inactive&&node.tag==='text'&&!/\bopacity=/u.test(node.open))node.open=node.open.replace(/>$/u,' opacity=".4">');
      const children=node.children.map(child=>{const text=paint(child,inactive);return {node:child,text};});
      node.hasStation=/\bdata-(?:stop|focus-stop)-index=/u.test(node.open)||children.some(v=>v.node.hasStation);
      const first=children.findIndex(v=>v.node.hasStation&&!track(v.node));
      if(first>=0){
        const later=children.slice(first),routes=later.filter(v=>track(v.node));
        children.splice(first,later.length,...routes,...later.filter(v=>!track(v.node)));
      }
      return node.open+children.map(v=>v.text).join('')+node.close;
    }
    return paint(root);
  }
  function foregroundResult(result){
    return {...result,svg:stationForegroundSvg(result.svg),...(result.motionSvg?{motionSvg:stationForegroundSvg(result.motionSvg)}:{})};
  }
  function render(...args){return foregroundResult(renderLineArtwork(...args));}
  function renderStation(...args){return foregroundResult(renderStationArtwork(...args));}
  const demo={type:"bus",sourceId:"demo/28",title:"示例城市公交 · 中央站至海滨公园",from:"中央站",to:"海滨公园",ref:"28",color:"#16805b",demo:true,roundtrip:false,source:"演示数据",stops:[
    {name:"中央站",transfers:["地铁 1 号线"]},{name:"市民中心"},{name:"图书馆"},{name:"大学城",transfers:["地铁 3 号线"]},{name:"人民广场"},{name:"北城公园"},{name:"滨江路"},{name:"海滨公园"}]};
  demo.stops=demo.stops.map((stop,i)=>({...stop,sourceId:"demo/"+(100+i)}));
  const demoStop=name=>demo.stops.find(stop=>stop.name===name)||{name,sourceId:"demo/extra-"+({"火车站":1,"中山路":2,"科技馆":3,"体育中心":4,"机场":5,"工业园":6}[name])};
  let demoStation=addStationLine(null,demo,{current:3});
  for(const [ref,names] of [["56",["火车站","中山路","大学城","科技馆","图书馆","滨江路","体育中心"]],["104",["机场","工业园","大学城","人民广场","海滨公园"]]]){
    const stops=names.map(demoStop);demoStation=addStationLine(demoStation,{...demo,title:"示例公交 "+ref,from:names[0],to:names.at(-1),ref,sourceId:"demo/"+ref,stops},{current:2});
  }
  root.HuayuTransitTemplates=Object.freeze({schema,families,busLayouts,screenLayouts,builtins,normalize,parse,packageRecords,simulateService,normalizeThroughServices,connectThroughRoute,throughConnectionOptions,normalizeOperatingPattern,stopState,nextStoppingIndex,render,renderStation,addStationLine,demo,demoStation});
})(globalThis);
