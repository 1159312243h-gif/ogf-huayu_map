(function(root){
  "use strict";
  const endpoint="https://overpass.opengeofiction.net/api/interpreter";
  const idOf=e=>e.type+"/"+e.id;
  const keys={hours:["opening_hours","service_times","operating_hours"],first:["start_time","first_departure","service:start_time"],last:["end_time","last_departure","service:end_time"],fare:["fare:description","charge","price","fare"],operator:["operator","operator:zh"],interval:["interval","interval:conditional","frequency"],departures:["departures","departure_times","service:departures","departure_times:conditional","timetable"]};
  const value=(tags,names)=>names.map(k=>String(tags?.[k]||"").trim()).find(Boolean)||"";
  function stationRef(station){
    const raw=station?.sourceId||station?.type+"/"+station?.id;
    if(!/^(node|way|relation)\/[1-9]\d*$/u.test(raw))throw Error("请选中有 OGF 编号的车站");
    return raw;
  }
  const memberOf=(parent,child)=>(parent.members||[]).some(m=>m.type==="relation"&&String(m.ref)===String(child.id));
  function parentLayers(relation,items){
    const routeType=relation.tags?.route||relation.tags?.route_master||"bus";
    const seen=new Set([String(relation.id)]),layers=[];let children=[relation];
    while(children.length){
      const next=items.filter(r=>r.type==="relation"&&!seen.has(String(r.id))&&["route_master","network","operator","collection","public_transport","superroute"].includes(r.tags?.type)&&(!r.tags.route_master||r.tags.route_master===routeType)&&(!r.tags.route||r.tags.route===routeType)&&children.some(c=>memberOf(r,c)));
      if(!next.length)break;next.forEach(r=>seen.add(String(r.id)));layers.push(next);children=next;
    }
    return layers;
  }
  function endpointsFor(relation,items=[]){
    const children=(relation?.members||[]).filter(m=>m.type==='relation').map(m=>items.find(r=>r.type==='relation'&&String(r.id)===String(m.ref)));
    const read=key=>{const direct=String(relation?.tags?.[key]||'').trim();if(direct)return direct;
      if(relation?.tags?.type!=='route_master'||!children.length||children.some(r=>!r||r.tags?.type!=='route'||r.tags?.route!==(relation.tags.route_master||relation.tags.route)))return '';
      const values=children.map(r=>String(r.tags?.[key]||'').trim());return values.every(Boolean)&&new Set(values).size===1?values[0]:'';
    };
    return {from:read('from'),to:read('to')};
  }
  function endpointStatus(relation,items=[]){
    const ends=endpointsFor(relation,items);if(ends.to)return "provided";
    if(relation?.tags?.type!=="route_master")return "missing";
    const refs=(relation.members||[]).filter(m=>m.type==="relation");
    const children=refs.map(m=>items.find(r=>r.type==="relation"&&String(r.id)===String(m.ref)));
    if(children.some(r=>!r))return "incomplete";
    const mode=relation.tags.route_master||relation.tags.route;
    return children.some(r=>r.tags?.type==="route"&&r.tags.route===mode&&String(r.tags.to||"").trim())?"choose-direction":"missing";
  }
  function serviceFor(relation,items=[]){
    const layers=parentLayers(relation,items),service={},sources={},conflicts=[];
    const read=(r,key,operator=false)=>{let names=keys[key];if(operator&&!(r.tags?.route_master==="bus"||r.tags?.route==="bus"||r.tags?.network==="bus"))names=names.flatMap(k=>["bus:"+k,"service:"+k]).concat(names.filter(k=>k.startsWith("service:")||["fare:description","service_times","operating_hours","departures","departure_times","departure_times:conditional","interval","interval:conditional","frequency","charge","fare"].includes(k)));
      let v=value(r.tags,names);if(key==="departures"&&/^https?:/iu.test(v))v="";
      const currency=key==="fare"?value(r.tags,["currency","fare:currency"]):"";return v&&currency&&!v.toLowerCase().includes(currency.toLowerCase())?v+" "+currency:v;};
    for(const key of Object.keys(keys)){
      let text=read(relation,key),owners=text?[relation]:[];
      if(!text)for(const layer of layers){const candidates=layer.filter(r=>read(r,key,r.tags?.type==="operator")),values=new Set(candidates.map(r=>read(r,key,r.tags?.type==="operator")));if(!values.size)continue;if(values.size===1){text=[...values][0];owners=candidates;}else conflicts.push(key);break;}
      service[key]=text;sources[key]=owners.map(idOf);
    }
    // Company office hours are not bus operating hours. Only explicitly scoped
    // bus/service tags from an exact named operator/network can fill missing data.
    const operator=service.operator,network=value(relation.tags,["network"]);
    const companies=(relation.tags?.route||relation.tags?.route_master||"bus")==="bus"?items.filter(r=>["operator","network","public_transport","collection"].includes(r.tags?.type)&&((operator&&r.tags.name===operator)||(network&&r.tags.name===network&&(!operator||r.tags.operator===operator)))&&(!r.tags.route||r.tags.route==="bus")&&(!r.tags.route_master||r.tags.route_master==="bus")):[];
    for(const key of Object.keys(keys).filter(k=>k!=="operator"&&!service[k]&&!conflicts.includes(k))){const candidates=companies.filter(r=>read(r,key,true)),values=new Set(candidates.map(r=>read(r,key,true)));if(values.size===1){service[key]=[...values][0];sources[key]=candidates.map(idOf);}else if(values.size>1)conflicts.push(key);}
    return {service,serviceSources:sources,serviceConflicts:conflicts,serviceNote:"线路优先；缺项按明确上级和运营安排继承，冲突不猜测"};
  }
  function isRoundtrip(relation,items=[]){
    const direct=relation?.tags||{};if(direct.roundtrip==="no")return false;if(direct.roundtrip==="yes")return true;
    const tags=[direct,...parentLayers(relation||{id:0},items).flat().filter(r=>["route_master","superroute"].includes(r.tags?.type)).map(r=>r.tags||{})];
    if(tags.some(t=>t.roundtrip==="yes"||(t.from&&t.to&&t.from.trim()===t.to.trim())||/(?:循环|环线|环城|环状|环形)|\b(?:circle|circular|loop|ring)\b/iu.test(t.name||"")))return true;
    const stops=(relation?.members||[]).filter(m=>/^(stop|platform)(?:_(entry|exit)_only)?$/u.test(m.role||""));
    return stops.length>2&&stops[0].type===stops.at(-1).type&&stops[0].ref===stops.at(-1).ref;
  }
  const literal=v=>'"'+String(v).replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
  function operatorQuery(routes,items){
    const selects=new Set();for(const r of routes){const {service}=serviceFor(r,items),network=value(r.tags,["network"]);for(const name of [service.operator,network].filter(Boolean))selects.add('rel["type"~"^(operator|network|public_transport|collection)$"]["name"='+literal(name)+'];');}
    return selects.size?'[out:json][timeout:25];('+[...selects].join('')+');out body;out count;':null;
  }
  const supportedModes=new Set(['bus','subway','light_rail','monorail','tram','train']);
  const railStation=e=>['station','halt','tram_stop'].includes(e?.tags?.railway)||['subway','light_rail','monorail','tram','train'].some(k=>e?.tags?.[k]==='yes');
  function stationRefs(station,items){
    const ref=stationRef(station),seed=items.find(e=>idOf(e)===ref),tags=station.tags||seed?.tags||{};
    if(station.mode==='bus'||tags.highway==='bus_stop'||tags.bus==='yes'&&!railStation({tags}))return new Set([ref]);
    const refs=new Set([ref,...(station.sourceIds||[])]);
    if(refs.size>128||[...refs].some(id=>!/^(node|way|relation)\/[1-9]\d*$/u.test(id)))throw Error("车站来源编号无效");
    for(const area of items.filter(e=>e.type==='relation'&&e.tags?.public_transport==='stop_area'&&(idOf(e)===ref||(e.members||[]).some(m=>m.type+'/'+m.ref===ref))))
      for(const m of area.members||[])if(/^(stop|platform)(?:_(entry|exit)_only)?$/u.test(m.role||''))refs.add(m.type+'/'+m.ref);
    return refs;
  }
  function discoveryQuery(station){const aliases=[...stationRefs(station,[])],extra=["node","way","relation"].map(type=>{const ids=aliases.filter(v=>v.startsWith(type+"/")).map(v=>v.split("/")[1]);return ids.length?type+"(id:"+ids.join(",")+");":"";}).join("");const ref=stationRef(station),[type,id]=ref.split('/'),up={node:'bn',way:'bw',relation:'br'}[type];return '[out:json][timeout:25];'+type+'('+id+')->.station;(.station;'+extra+')->.station;(rel(bn.station)["public_transport"="stop_area"];rel(bw.station)["public_transport"="stop_area"];rel(br.station)["public_transport"="stop_area"];)->.areas;(.station;.areas;node(r.areas);way(r.areas);rel(r.areas);)->.stops;(rel(bn.stops);rel(bw.stops);rel(br.stops);)->.parents;rel.parents["type"="route"]["route"~"^(bus|subway|light_rail|monorail|tram|train)$"]->.routes;(.routes <<;)->.masters;(.stops;.routes;.masters;);out body center;out count;';}
  function routesQuery(ids){
    if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error("线路关系编号无效");
    return '[out:json][timeout:30];rel(id:'+ids.join(',')+')->.routes;(.routes <<;)->.masters;(.routes;.masters;node(r.routes);way(r.routes:"platform");way(r.routes:"platform_entry_only");way(r.routes:"platform_exit_only");way(r.routes)["public_transport"="platform"];way(r.routes)["highway"="bus_stop"];way(r.routes)["railway"~"^(station|halt|tram_stop)$"];rel(r.routes:"platform");rel(r.routes:"stop");rel(r.routes)["public_transport"="platform"];rel(r.routes)["railway"~"^(station|halt|tram_stop)$"];)->.details;(rel(bn.details);rel(bw.details);rel(br.details);)->.parents;rel.parents["type"="route"]["route"~"^(subway|light_rail|monorail|tram|train)$"]->.interchanges;(.interchanges <<;)->.transfermasters;(.details;.interchanges;.transfermasters;);out body center;out count;';
  }
  function railFamilyRoots(routes,items){
    const roots=new Map();for(const r of routes){const masters=parentLayers(r,items).flat().filter(v=>v.tags?.type==='route_master'),outer=masters.filter(v=>!masters.some(p=>p!==v&&memberOf(p,v)));for(const v of outer)roots.set(v.id,v);}return [...roots.values()];
  }
  function railFamilyQuery(ids){
    if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('线路主关系编号无效');
    return '[out:json][timeout:40];rel(id:'+ids.join(',')+')->.familyRoots;(.familyRoots; >>;)->.familyMembers;rel.familyMembers["type"~"^(route|route_master)$"]->.familyRelations;(.familyRoots;.familyRelations;)->.routes;(.routes;node(r.routes);way(r.routes:"platform");way(r.routes:"platform_entry_only");way(r.routes:"platform_exit_only");rel(r.routes:"platform");rel(r.routes:"stop"););out body center;out count;';
  }
  function checkedRailFamily(roots,items){
    const map=new Map(items.filter(e=>e.type==='relation').map(e=>[e.id,e])),found=new Map(),visited=new Set(),active=new Set();
    function visit(id,mode){const r=map.get(id);if(!r)throw Error('全线主关系／分段关系缺失，保留此前完整图');if(active.has(id))throw Error('线路主关系循环引用，未生成不完整全线图');if(visited.has(id))return;const kind=r.tags?.route||r.tags?.route_master;if(!['route','route_master'].includes(r.tags?.type)||kind!==mode)return;active.add(id);found.set(id,r);
      for(const m of r.members||[])if(m.type==='relation'&&!/stop|platform/u.test(m.role||''))visit(m.ref,mode);
      active.delete(id);visited.add(id);
    }
    for(const root of roots)visit(root.id,root.tags.route||root.tags.route_master);return [...found.values()];
  }
  function railContextQuery(ids){
    if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('轨道关系编号无效');
    return '[out:json][timeout:40];rel(id:'+ids.join(',')+')->.templateRail;'
      +'(node(r.templateRail);way(r.templateRail:"platform");rel(r.templateRail:"platform");)->.seeds;'
      +'(rel(bn.seeds)["public_transport"="stop_area"];rel(bw.seeds)["public_transport"="stop_area"];rel(br.seeds)["public_transport"="stop_area"];)->.areas;'
      +'(node(around.seeds:350)["railway"~"^(station|stop|halt|tram_stop)$"];node(around.seeds:350)["public_transport"~"^(station|stop_position|platform)$"];way(around.seeds:350)["railway"~"^(station|halt|tram_stop|platform)$"];way(around.seeds:350)["public_transport"~"^(station|platform)$"];node(r.areas);way(r.areas);rel(r.areas);.seeds;)->.stations;'
      +'(rel(bn.stations);rel(bw.stations);rel(br.stations);)->.parents;rel.parents["type"="route"]["route"~"^(subway|light_rail|monorail|tram|train)$"]->.transfers;(.transfers <<;)->.masters;'
      +'way(r.templateRail)->.tracks;(.stations;.areas;.transfers;.masters;.templateRail;)->.context;(.context; - .tracks;)->.context;(.context;.tracks;)->.all;'
      +'.tracks out body geom;.context out body center;.all out count;';
  }
  const exactName=v=>String(v||'').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const metres=(a,b)=>Math.hypot((a.lat-b.lat)*111320,(a.lon-b.lon)*111320*Math.cos((a.lat+b.lat)*Math.PI/360));
  function orderRailStops(stops,relation,items){
    const memberIds=(relation.members||[]).filter(m=>m.type==='way'&&!/stop|platform/u.test(m.role||'')).map(m=>m.ref);
    const ways=memberIds.map(id=>items.find(e=>e.type==='way'&&e.id===id)).filter(Boolean);
    const fallback=reason=>({stops,orderBasis:'members',orderWarning:reason});
    if(!ways.length)return fallback('未取得完整轨道几何，暂保留关系站序');
    if(ways.length!==memberIds.length||ways.some(w=>!Array.isArray(w.geometry)||w.geometry.length<2||w.geometry.some(p=>!Number.isFinite(p?.lat)||!Number.isFinite(p?.lon))))return fallback('轨道几何不完整，暂保留关系站序');
    const nodes=new Map(),edges=new Map(),key=(w,i)=>w.nodes?.length===w.geometry.length?'n/'+w.nodes[i]:'p/'+w.geometry[i].lat.toFixed(7)+'/'+w.geometry[i].lon.toFixed(7);
    for(const w of ways)for(let i=0;i<w.geometry.length-1;i++){
      const a=key(w,i),b=key(w,i+1);if(a===b)continue;
      if(!nodes.has(a))nodes.set(a,{...w.geometry[i],links:new Set()});if(!nodes.has(b))nodes.set(b,{...w.geometry[i+1],links:new Set()});
      nodes.get(a).links.add(b);nodes.get(b).links.add(a);edges.set([a,b].sort().join('|'),[a,b]);
    }
    if(!nodes.size||[...nodes.values()].some(n=>n.links.size>2))return fallback('轨道包含分支，需选择明确运行方向；保留关系站序');
    const ends=[...nodes].filter(([,n])=>n.links.size===1).map(([k])=>k),loop=!ends.length;
    if(!loop&&ends.length!==2)return fallback('轨道未组成一条完整连续路径，保留关系站序');
    const from=stops.find(v=>exactName(v.name)===exactName(relation.tags?.from)),to=stops.find(v=>exactName(v.name)===exactName(relation.tags?.to));
    const anchor=from||stops[0];if(!Number.isFinite(anchor?.lat)||!Number.isFinite(anchor?.lon))return fallback('站点坐标不全，保留关系站序');
    const start=(loop?[...nodes.keys()]:ends).sort((a,b)=>metres(nodes.get(a),anchor)-metres(nodes.get(b),anchor))[0],walk=[start],used=new Set([start]);
    let previous=null,current=start;
    for(;;){const next=[...nodes.get(current).links].find(k=>k!==previous&&!used.has(k));if(!next)break;walk.push(next);used.add(next);previous=current;current=next;}
    if(used.size!==nodes.size)return fallback('轨道有断开部分，保留全部关系站序');
    if(loop)walk.push(start);
    const segments=[];let length=0;
    for(let i=1;i<walk.length;i++){const a=nodes.get(walk[i-1]),b=nodes.get(walk[i]),d=metres(a,b);segments.push({a,b,d,start:length});length+=d;}
    function project(stop){let best=null;for(const edge of segments){const c=Math.cos(stop.lat*Math.PI/180),dx=(edge.b.lon-edge.a.lon)*c,dy=edge.b.lat-edge.a.lat,den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((stop.lon-edge.a.lon)*c*dx+(stop.lat-edge.a.lat)*dy)/den)):0;const p={lat:edge.a.lat+t*(edge.b.lat-edge.a.lat),lon:edge.a.lon+t*(edge.b.lon-edge.a.lon)},distance=metres(stop,p);if(!best||distance<best.distance)best={distance,along:edge.start+t*edge.d};}return best;}
    const mapped=stops.map((stop,i)=>({stop,i,p:Number.isFinite(stop.lat)&&Number.isFinite(stop.lon)?project(stop):null}));
    if(mapped.some(v=>!v.p||v.p.distance>350))return fallback('部分站点未能投影到本站所属轨道，保留全部关系站序');
    let sorted=[...mapped].sort((a,b)=>a.p.along-b.p.along||a.i-b.i);
    if(loop){
      // Preserve the declared stop progression around a loop, including a repeated endpoint.
      const score=dir=>mapped.slice(1).reduce((n,v,i)=>{const d=(v.p.along-mapped[i].p.along)*dir;return n+((d+length)%length);},0);
      if(score(-1)<score(1))sorted.reverse();
      const anchorIndex=sorted.findIndex(v=>v.stop===anchor);sorted=[...sorted.slice(anchorIndex),...sorted.slice(0,anchorIndex)];
      if(stops.length>1&&stops[0].sourceId===stops.at(-1).sourceId){const last=sorted.findIndex(v=>v.i===stops.length-1);if(last>=0)sorted.push(...sorted.splice(last,1));}
    }else{
      const fi=sorted.findIndex(v=>v.stop===from),ti=sorted.findIndex(v=>v.stop===to);
      if(fi>=0&&ti>=0?fi>ti:fi>=0?fi>sorted.length/2:ti>=0?ti<sorted.length/2:mapped.slice(1).reduce((a,v,i)=>a+Math.sign(v.p.along-mapped[i].p.along),0)<0)sorted.reverse();
    }
    const originalEnds=sorted.length<2||sorted[0].p.along<=sorted.at(-1).p.along?[walk[0],walk.at(-1)]:[walk.at(-1),walk[0]];
    return {stops:sorted.map(v=>v.stop),trackEndpointIds:!loop&&originalEnds.every(v=>/^n\/[1-9]\d*$/u.test(v))?originalEnds.map(v=>v.replace(/^n\//u,'node/')):[],orderBasis:'connected-track',orderWarning:'',originalStopOrder:stops.map(v=>v.sourceId)};
  }
  const transferIndexes=new WeakMap();
  function transferIndex(items){
    if(transferIndexes.has(items))return transferIndexes.get(items);
    const membership=new Map(),names=new Map(),areas=new Map(),category=t=>['subway','light_rail','monorail'].includes(t)?'metro':t;
    for(const e of items){const n=exactName(e.tags?.name);if(n){if(!names.has(n))names.set(n,[]);names.get(n).push(e);}
      if(e.type==='relation'&&e.tags?.type==='route'&&supportedModes.has(e.tags.route))for(const m of e.members||[])if(role(m)){const k=m.type+'/'+m.ref;if(!membership.has(k))membership.set(k,new Set());membership.get(k).add(category(e.tags.route));}
      if(e.type==='relation'&&e.tags?.public_transport==='stop_area')for(const m of e.members||[]){const k=m.type+'/'+m.ref;if(!areas.has(k))areas.set(k,[]);areas.get(k).push(e);}
    }
    const result={membership,names,areas,category};transferIndexes.set(items,result);return result;
  }
  function transferRefs(stop,items,mode,rules={}){
    const ids=new Set([stop.sourceId,...stop.memberSourceIds||[]]),{membership,names,areas,category}=transferIndex(items);
    for(const area of new Set([...ids].flatMap(id=>areas.get(id)||[])))
      for(const m of area.members||[])if(/^(stop|platform|station)(?:_(entry|exit)_only)?$/u.test(m.role||''))ids.add(m.type+'/'+m.ref);
    const n=exactName(stop.name),alias=(rules.stationTransferAliases||[]).find(a=>a.stationNames?.some(v=>exactName(v)===n)),overrides=rules.stationDisplayMergeOverrides||[],override=overrides.find(v=>v.stationNames?.some(name=>exactName(name)===n)&&(!v.anchorPoint||metres(stop,{lat:v.anchorPoint.lat,lon:v.anchorPoint.lon})<=v.maxMeters));
    const radius=override?.maxMeters||350,anchor=override?.anchorPoint?{lat:override.anchorPoint.lat,lon:override.anchorPoint.lon}:stop;
    const candidates=[...new Set([n,...alias?.stationNames?.map(exactName)||[]])].flatMap(name=>names.get(name)||[]);
    for(const e of candidates){const k=idOf(e),p=point(e);if(e.type==='relation'&&e.tags?.type==='route'||!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||(![n,...alias?.stationNames?.map(exactName)||[]].includes(exactName(e.tags?.name)))||!n)continue;
      if(!membership.get(k)?.has(category(mode)))continue;
      if(metres(p,anchor)<=(exactName(e.tags?.name)===n?radius:alias?.maxMeters||0))ids.add(k);
    }
    return ids;
  }
  function checked(payload){
    const rows=payload?.elements,counts=rows?.filter(e=>e.type==="count"),items=rows?.filter(e=>e.type!=="count");
    if(payload?.remark||!Array.isArray(rows)||counts.length!==1||!Number.isSafeInteger(Number(counts[0].tags?.total))||Number(counts[0].tags.total)!==items.length)throw Error("本站线路数据不完整，请重试；原站牌已保留");
    if(items.some(e=>!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0)||new Set(items.map(idOf)).size!==items.length)throw Error("本站线路来源编号无效");
    return items;
  }
  const role=m=>/^(stop|platform)(?:_(entry|exit)_only)?$/u.test(String(m.role||""));
  const isStop=e=>railStation(e)||e?.tags?.highway==="bus_stop"||["platform","stop_position","station"].includes(e?.tags?.public_transport);
  const point=e=>e?.center||e;
  function paired(a,b){
    if(!/^stop/u.test(a.member.role)||!/^platform/u.test(b.member.role)||!a.element.tags?.name||a.element.tags.name!==b.element.tags?.name)return false;
    const p=point(a.element),q=point(b.element);return Number.isFinite(p?.lat)&&Number.isFinite(q?.lat)&&Math.hypot((p.lat-q.lat)*111320,(p.lon-q.lon)*111320*Math.cos(p.lat*Math.PI/180))<=80;
  }
  function routeFromMembers(relation,items,station,rules={},allowUnserved=false){
    if(relation?.type!=="relation"||relation.tags?.type!=="route"||!supportedModes.has(relation.tags.route))throw Error("线路登记已变化，请重新查询；原站牌保留");
    const ref=stationRef(station),refs=relation.tags.route==='bus'?new Set([ref]):stationRefs(station,items),all=new Map(items.map(e=>[idOf(e),e])),members=[];
    for(const member of relation.members||[]){const element=all.get(member.type+"/"+member.ref);if(role(member)&&!element)throw Error("线路 "+relation.id+" 的站点资料缺失，未替换原站牌");if(element&&(role(member)||isStop(element)))members.push({member,element});}
    let stops=[];
    for(let i=0;i<members.length;i++){
      const a=members[i],aliases=[idOf(a.element)];let e=a.element;
      if(members[i+1]&&paired(a,members[i+1])){aliases.push(idOf(members[++i].element));if(aliases.includes(ref))e=all.get(ref);}
      const sourceId=aliases.some(id=>refs.has(id))?ref:idOf(e),tags=e.tags||{};
      stops.push({sourceId,lat:point(e)?.lat,lon:point(e)?.lon,memberSourceIds:aliases,name:tags.name||tags.local_ref||tags.ref||"未命名站点",nameEn:tags["name:en"]||"",tags,transfers:[...(tags.railway==="station"||tags.train==="yes"?[{type:"train",label:"铁路"}]:[]),...(tags.subway==="yes"?[{type:"subway",label:"地铁"}]:[]),...(tags.aeroway==="terminal"?[{type:"flight",label:"航空"}]:[])]});
    }
    const order=relation.tags.route==='bus'?{stops,orderBasis:'members',orderWarning:''}:orderRailStops(stops,relation,items);stops=order.stops;
    const current=stops.findIndex(s=>s.sourceId===ref);
    if(current<0&&!allowUnserved)throw Error("线路 "+relation.id+" 未把所选物体登记为停靠站点，未替换原站牌");
    const parent=items.find(r=>r.type==="relation"&&r.tags?.type==="route_master"&&(r.members||[]).some(m=>m.type==="relation"&&m.ref===relation.id));
    const tags={...(parent?.tags||{}),...relation.tags},named={red:'#b63637',green:'#16805b',blue:'#235b92',yellow:'#caa322',orange:'#b76322'};
    let color=String(tags.colour||tags.color||'');color=named[color.toLowerCase()]||color;if(/^#[0-9a-f]{3}$/iu.test(color))color='#'+[...color.slice(1)].map(c=>c+c).join('');
    const data={type:relation.tags.route,relationKind:'route',sourceId:idOf(relation),title:tags.name||tags.ref||'公交线路 #'+relation.id,ref:tags.ref||'',color,...endpointsFor(relation,items),roundtrip:isRoundtrip(relation,items),source:'OpenGeofiction 本站停靠关系',...serviceFor(relation,items),stops,trackEndpointIds:order.trackEndpointIds||[],orderBasis:order.orderBasis,orderWarning:order.orderWarning,originalStopOrder:order.originalStopOrder};
    applyRailTransfers(data,relation,items,station,rules);
    return {route:data,current,stationId:ref,stationName:stops[current]?.name||station.name||''};
  }
  function applyRailTransfers(data,relation,items,station,rules={}){
    const stops=data.stops,ref=stationRef(station),refs=stationRefs(station,items),named={red:'#b63637',green:'#16805b',blue:'#235b92',yellow:'#caa322',orange:'#b76322'};
    if(data.type!=='bus'){
      const badge=r=>{const layers=parentLayers(r,items),masters=layers.flat().filter(p=>p.tags?.type==='route_master'),parent=masters.at(-1),tags={...r.tags,...parent?.tags};let c=String(tags.colour||tags.color||'');c=named[c.toLowerCase()]||c;if(/^#[0-9a-f]{3}$/iu.test(c))c='#'+[...c.slice(1)].map(v=>v+v).join('');return {type:r.tags.route||r.tags.route_master,identity:idOf(parent||r),ref:String((rules.refCorrections||[]).find(v=>[r.id,parent?.id].includes(v.relationId)&&v.sourceRef===tags.ref)?.displayRef||tags.ref||''),label:String(tags.name||tags.ref||'轨道线路'),color:c};};
      const own=badge(relation);data.color=own.color||data.color;data.ref=own.ref||data.ref;const corrections=rules.refCorrections||[];const fix=corrections.find(v=>String(v.relationId)===String(relation.id)&&v.sourceRef===data.ref);if(fix)data.ref=fix.displayRef;
      for(const stop of stops){stop.stopAreaIds=[...new Set([stop.sourceId,...stop.memberSourceIds||[]].flatMap(id=>(transferIndex(items).areas.get(id)||[]).map(idOf)))];const ids=transferRefs(stop,items,data.type,rules);if(stop.sourceId===ref)for(const id of refs)ids.add(id);stop.transfers=[...new Map(items.filter(r=>r.type==='relation'&&r.tags?.type==='route'&&r.tags.route!=='bus'&&supportedModes.has(r.tags.route)&&(r.members||[]).some(m=>ids.has(m.type+'/'+m.ref))).map(badge).filter(b=>b.identity!==own.identity).map(b=>[b.identity,b])).values()];}
    }
    if(data.type!=='bus'){
      const pool=items.filter(e=>e.type==='relation'&&['route','route_master'].includes(e.tags?.type)&&supportedModes.has(e.tags.route||e.tags.route_master));
      for(const stop of stops)for(const rule of rules.stationInterchangeOverrides||[]){
        if(!rule.stationNames?.some(n=>exactName(n)===exactName(stop.name))||!(rule.routeRefs||[]).some(v=>exactName(v)===exactName(data.ref)))continue;
        for(const candidate of pool.filter(r=>(rule.routeRefs||[]).some(v=>exactName(v)===exactName(r.tags.ref))||(rule.routeNames||[]).some(v=>exactName(v)===exactName(r.tags.name)))){
          const parent=parentLayers(candidate,items).flat().filter(v=>v.tags?.type==='route_master').at(-1),r=parent||candidate;
          if(exactName(r.tags.ref)===exactName(data.ref)||stop.transfers.some(v=>v.identity===idOf(r)))continue;
          stop.transfers.push({identity:idOf(r),ref:r.tags.ref||'',label:r.tags.name||r.tags.ref||'轨道线路',color:r.tags.colour||r.tags.color||'',type:r.tags.route||r.tags.route_master});
        }
        for(const value of rule.displayRoutes||[])if(!stop.transfers.some(v=>v.identity===value.identity))stop.transfers.push({...value});
      }
    }
    return data;
  }
  function railFamilyEntry(relation,items,station,prepared,rules={}){
    if(!prepared?.stops?.length)throw Error('全线站序未完整生成，保留此前完整图');
    const ref=stationRef(station),refs=stationRefs(station,items),stops=prepared.stops.map(v=>({...v,sourceId:[v.sourceId,...v.memberSourceIds||[]].some(id=>refs.has(id))?ref:v.sourceId}));
    const tags=relation.tags||{},data={type:tags.route||tags.route_master,relationKind:tags.type,sourceId:idOf(relation),title:tags.name||tags.ref||'轨道线路',ref:tags.ref||'',color:tags.colour||tags.color||'',...endpointsFor(relation,items),endpointState:endpointStatus(relation,items),roundtrip:Boolean(prepared.roundtrip),source:'OpenGeofiction 完整线路主关系及全部下属分段',...serviceFor(relation,items),stops,orderBasis:'line-page',orderWarning:'',overview:true,supplementSourceTime:prepared.supplementSourceTime||null};
    applyRailTransfers(data,relation,items,station,rules);return {route:data,current:stops.findIndex(v=>v.sourceId===ref),stationId:ref,stationName:station.name||'',overview:true};
  }
  function stationFromFeature(feature){
    if(!feature)return null;
    const tags=feature.originalTags||feature.tags||{},rail=railStation({tags});
    if(!rail&&tags.railway!=='stop'&&tags.highway!=='bus_stop'&&!['platform','stop_position','station'].includes(tags.public_transport))return null;
    return {sourceId:stationRef(feature),name:tags.name||feature.label||feature.name||'未命名站点',tags,mode:rail?'rail':tags.highway==='bus_stop'||tags.bus==='yes'?'bus':undefined,lat:feature.lat,lng:feature.lng};
  }
  function previewForStation(previous,station){
    const ref=stationRef(station),refs=stationRefs(station,[]),entries=[];
    for(const entry of previous.entries||[]){
      if(station.mode==='bus'&&entry.route.type!=='bus'||station.mode==='rail'&&entry.route.type==='bus')continue;
      const current=entry.route.stops.findIndex(stop=>[stop.sourceId,...stop.memberSourceIds||[]].some(id=>refs.has(id)));
      if(current<0)continue;
      const stops=entry.route.stops.map((stop,i)=>i===current?{...stop,sourceId:ref}:stop);
      entries.push({...entry,route:{...entry.route,stops},current,stationId:ref,stationName:station.name||stops[current].name});
    }
    return entries.length?{...previous,entries,stationId:ref,stationName:station.name||entries[0].stationName,complete:false,cached:true,scope:'已读完整线路中按原始编号匹配的临时预览，本站全部停靠关系正在核对'}:null;
  }
  function create(options={}){
    const read=options.fetch||root.fetch.bind(root),now=options.now||Date.now,stationCache=new Map(),detailsCache=new Map(),railCache=new Map(),familyCache=new Map(),cacheAge=120000;
    const cacheKey=station=>JSON.stringify([stationRef(station),station.mode||'', [...stationRefs(station,[])].sort()]);
    function cached(store,key){const entry=store.get(key);if(!entry)return null;if(now()-entry.time>=cacheAge){store.delete(key);return null;}store.delete(key);store.set(key,entry);return structuredClone(entry.value);}
    function remember(store,key,value,time=now()){const bytes=new TextEncoder().encode(key+JSON.stringify(value)).byteLength;if(bytes>12*1024*1024)return;store.delete(key);store.set(key,{time,bytes,value:structuredClone(value)});while(store.size>16||[...store.values()].reduce((a,e)=>a+e.bytes,0)>12*1024*1024)store.delete(store.keys().next().value);}
    function peek(station){const result=cached(stationCache,cacheKey(station));return result?{...result,cached:true}:null;}
    function preview(station){const exact=peek(station);if(exact)return exact;for(const key of [...stationCache.keys()].reverse()){const previous=cached(stationCache,key),result=previous&&previewForStation(previous,station);if(result)return result;}return null;}
    async function request(query,signal,{timeoutMs=40000,attempts=2,maxBytes=0}={}){
      for(let attempt=0;attempt<attempts;attempt++){
        signal?.throwIfAborted();
        try{
          const timeout=AbortSignal.timeout(timeoutMs),response=await read(endpoint+(attempt?'?data='+encodeURIComponent(query):''),{method:attempt?'GET':'POST',credentials:'omit',redirect:'error',headers:{Accept:'application/json',...(attempt?{}:{'Content-Type':'application/x-www-form-urlencoded'})},...(attempt?{}:{body:'data='+encodeURIComponent(query)}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
          if(!response.ok){await response.body?.cancel();const e=Error('车站资料读取失败（'+response.status+'），请重试');e.permanent=![408,429,500,502,503,504,405].includes(response.status);throw e;}
          let payload;
          if(maxBytes){
            const reader=response.body.getReader(),parts=[];let bytes=0;
            try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){const e=Error("城市路网响应过大，原图已保留");e.permanent=true;throw e;}parts.push(value);}const joined=new Uint8Array(bytes);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.length;}payload=JSON.parse(new TextDecoder().decode(joined));}
            finally{await reader.cancel().catch(()=>{});}
          }else payload=await response.json();checked(payload);signal?.throwIfAborted();return payload;
        }catch(e){signal?.throwIfAborted();if(attempt===attempts-1||e.permanent)throw e;}
      }
    }
    async function search(query,{signal}={}){
      query=String(query).trim();if(!query||query.length>100)throw Error('请输入车站名称或 node/编号、way/编号、relation/编号');
      const direct=query.match(/^(node|way|relation)\/[1-9]\d*$/u);
      const literal=query.replace(/[.*+?^{}$()|[\]\\]/gu,'\\$&').replaceAll('\\','\\\\').replaceAll('"','\\"');
      const select=direct?query.replace('/','(')+');':'(nwr["highway"="bus_stop"]["name"~"'+literal+'",i];nwr["public_transport"~"^(platform|stop_position|station)$"]["name"~"'+literal+'",i];);';
      // The search list is capped for the UI, while the count states whether more matches exist.
      const q='[out:json][timeout:25];'+select+'out body center 61;out count;';
      const timeout=AbortSignal.timeout(35000),r=await read(endpoint+'?data='+encodeURIComponent(q),{credentials:'omit',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!r.ok)throw Error('车站搜索暂时失败（'+r.status+'）');const payload=await r.json(),items=payload.elements?.filter(e=>e.type!=='count'),count=Number(payload.elements?.find(e=>e.type==='count')?.tags?.total);
      if(payload.remark||!items||!Number.isSafeInteger(count)||count<items.length||items.some(e=>!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0))throw Error('车站搜索结果不完整，请重试');
      signal?.throwIfAborted();return {items:items.slice(0,60).map(e=>({type:e.type,id:e.id,sourceId:idOf(e),name:e.tags?.name||'未命名站点',lat:point(e)?.lat,lng:point(e)?.lon,tags:e.tags||{}})),hasMore:count>60};
    }
    async function load(station,{signal,onProgress,refresh=false}={}){
      signal?.throwIfAborted();const ref=stationRef(station),key=cacheKey(station),saved=!refresh&&peek(station);
      if(saved){onProgress?.('已复用两分钟内完整站点数据，原始源时间不变。');return saved;}
      onProgress?.('正在查询 '+(station.name||ref)+' 的已登记停靠关系…');
      const discovery=await request(discoveryQuery(station),signal),first=checked(discovery),seed=first.find(e=>idOf(e)===ref);
      if(!seed)throw Error('未找到这个 OGF 车站，原站牌已保留');
      const refs=stationRefs(station,first),rail=station.mode&&station.mode!=='bus'||railStation(seed),bus=station.mode==='bus'||seed.tags?.highway==='bus_stop'||seed.tags?.bus==='yes'&&!rail;
      let routes=first.filter(e=>e.type==='relation'&&e.tags?.type==='route'&&supportedModes.has(e.tags.route)&&(!rail||e.tags.route!=='bus')&&(!bus||e.tags.route==='bus')&&(e.members||[]).some(m=>refs.has(m.type+'/'+m.ref)));
      if(!routes.length)throw Error('这个物体没有登记可用的公交或轨道停靠关系；请检查原始站点或 stop_area 关系');
      const all=new Map(first.map(e=>[idOf(e),e]));let sourceTime=discovery.osm3s?.timestamp_osm_base||null;
      const candidates=[],payloads=[],directRoutes=[...routes],familyRoots=rail&&options.expandFamilies!==false?railFamilyRoots(routes,first):[];
      if(familyRoots.length){
        onProgress?.('正在读取完整线路主关系及全部分期、方向…');
        const familyKey=JSON.stringify(familyRoots.map(r=>[r,...parentLayers(r,first).flat()]).sort((a,b)=>a[0].id-b[0].id)),saved=!refresh&&cached(familyCache,familyKey),payload=saved||await request(railFamilyQuery(familyRoots.map(r=>r.id)),signal,{timeoutMs:50000,attempts:2,maxBytes:32*1024*1024}),part=checked(payload),family=checkedRailFamily(familyRoots,part);
        for(const e of part)all.set(idOf(e),e);routes=family.filter(r=>r.tags.type==='route');if(!routes.length)throw Error('全线未取得可用分段，保留此前完整图');
        payloads.push({payload,cached:Boolean(saved),readAt:saved?familyCache.get(familyKey).time:now()});if(!saved)candidates.push(['family/'+familyKey,payload]);if(payload.osm3s?.timestamp_osm_base&&(!sourceTime||payload.osm3s.timestamp_osm_base<sourceTime))sourceTime=payload.osm3s.timestamp_osm_base;
      }
      for(let i=0;i<routes.length;i+=20){
        onProgress?.('正在读取 '+(station.name||ref)+' 完整站序和运营资料 '+Math.min(i+20,routes.length)+' / '+routes.length+'…');
        const batch=routes.slice(i,i+20),missing=[],keys=new Map();
        for(const r of batch){
          const parents=parentLayers(r,first).flat().sort((a,b)=>a.id-b.id),detailKey=JSON.stringify([r,...parents]);keys.set(r.id,detailKey);
          const reused=!refresh&&cached(detailsCache,detailKey);if(reused)payloads.push({payload:reused,cached:true,readAt:detailsCache.get(detailKey).time});else missing.push(r);
        }
        if(missing.length){
          const payload=await request(routesQuery(missing.map(r=>r.id)),signal),part=checked(payload);
          if(missing.some(r=>!part.some(e=>e.type==='relation'&&e.id===r.id)))throw Error('完整线路关系缺失，原站牌保留');
          payloads.push({payload,cached:false,readAt:now()});for(const r of missing)candidates.push([keys.get(r.id),payload]);
        }
      }
      // Fresh query results take precedence over shared older transfer/route context.
      for(const {payload} of payloads.sort((a,b)=>Number(b.cached)-Number(a.cached))){
        for(const e of checked(payload))all.set(idOf(e),e);
        if(payload.osm3s?.timestamp_osm_base&&(!sourceTime||payload.osm3s.timestamp_osm_base<sourceTime))sourceTime=payload.osm3s.timestamp_osm_base;
      }
      if(rail&&options.enrichRail!==false){
        const railRoutes=routes.map(r=>all.get(idOf(r))),missing=[],keys=new Map(),contexts=[];
        for(const r of railRoutes){const key=JSON.stringify([r,...parentLayers(r,[...all.values()]).flat().sort((a,b)=>a.id-b.id)]);keys.set(r.id,key);const saved=!refresh&&cached(railCache,key);if(saved)contexts.push({payload:saved,time:railCache.get(key).time});else missing.push(r);}
        for(let i=0;i<missing.length;i+=20){onProgress?.('正在核对全线轨道连接及各站换乘…');const batch=missing.slice(i,i+20),payload=await request(railContextQuery(batch.map(r=>r.id)),signal,{timeoutMs:50000,attempts:2,maxBytes:32*1024*1024});contexts.push({payload,time:now()});for(const r of batch)candidates.push(['rail/'+keys.get(r.id),payload]);}
        for(const {payload,time} of contexts){const part=checked(payload);for(const e of part)all.set(idOf(e),e);payloads.push({payload,cached:true,readAt:time});if(payload.osm3s?.timestamp_osm_base&&(!sourceTime||payload.osm3s.timestamp_osm_base<sourceTime))sourceTime=payload.osm3s.timestamp_osm_base;}
        for(const r of railRoutes){const ids=(r.members||[]).filter(m=>m.type==='way'&&!/stop|platform/u.test(m.role||'')).map(m=>m.ref);for(const id of ids){const way=all.get('way/'+id);if(!Array.isArray(way?.geometry)||way.geometry.length<2||way.geometry.some(p=>!Number.isFinite(p?.lat)||!Number.isFinite(p?.lon)))throw Error('轨道成员几何缺失或不完整，保留此前完整图');}}
      }
      const companyQuery=operatorQuery(routes.filter(r=>r.tags.route==='bus').map(r=>all.get(idOf(r))),[...all.values()]);let operatorStatus="not-needed";
      if(companyQuery){onProgress?.('正在核对运营方服务安排…');try{const payload=await request(companyQuery,signal,{timeoutMs:12000,attempts:1});for(const e of checked(payload))all.set(idOf(e),e);operatorStatus="checked";if(payload.osm3s?.timestamp_osm_base&&(!sourceTime||payload.osm3s.timestamp_osm_base<sourceTime))sourceTime=payload.osm3s.timestamp_osm_base;}catch(e){signal?.throwIfAborted();operatorStatus="unavailable";}}
      const items=[...all.values()],rules=options.rules?.()||{},entries=routes.map(r=>routeFromMembers(all.get(idOf(r)),items,station,rules,Boolean(familyRoots.length)));signal?.throwIfAborted();
      if(familyRoots.length&&options.buildFamily){const overviews=checkedRailFamily(familyRoots,items).filter(r=>r.tags.type==='route_master').map(root=>railFamilyEntry(root,items,station,options.buildFamily(root,items,station,checkedRailFamily([root],items)),rules));entries.unshift(...overviews);for(const e of overviews)if(e.route.supplementSourceTime&&(!sourceTime||e.route.supplementSourceTime<sourceTime))sourceTime=e.route.supplementSourceTime;}
      const result={stationId:ref,stationName:seed.tags?.name||entries[0].stationName,mode:entries.every(e=>e.route.type==='bus')?'bus':'rail',entries,operatorStatus,complete:true,scope:familyRoots.length?'本站已登记轨道线路的完整主关系及全部分期／方向；全线总览不表示各分段全部贯通运营':'所选 OGF 站点及明确 stop_area 成员的已登记停靠关系',familyRootIds:familyRoots.map(r=>idOf(r)),directLineCount:directRoutes.length,sourceTime,fetchedAt:now(),cached:false};
      signal?.throwIfAborted();for(const [detailKey,payload] of candidates)remember(detailKey.startsWith('family/')?familyCache:detailKey.startsWith('rail/')?railCache:detailsCache,detailKey.startsWith('family/')?detailKey.slice(7):detailKey.startsWith('rail/')?detailKey.slice(5):detailKey,payload);
      // Failed optional operator reads must remain retryable instead of caching missing service.
      if(operatorStatus!=='unavailable')remember(stationCache,key,result,Math.min(now(),...payloads.map(v=>v.readAt)));return result;
    }

    const geographyCache=new Map();
    async function loadGeography(route,{signal,refresh=false}={}){
      const points=route?.stops;
      if(!Array.isArray(points)||points.length<2||points.some(p=>typeof p.lat!=="number"||typeof (p.lon??p.lng)!=="number"||!Number.isFinite(p.lat)||!Number.isFinite(p.lon??p.lng)||Math.abs(p.lat)>85||Math.abs(p.lon??p.lng)>180))throw Error("需要全部站点的有效坐标，才能读取道路背景");
      const lons=[];for(const p of points){let x=p.lon??p.lng;if(lons.length){while(x-lons.at(-1)>180)x-=360;while(x-lons.at(-1)< -180)x+=360;}lons.push(x);}
      const south=Math.max(-85,Math.min(...points.map(p=>p.lat))-.004),north=Math.min(85,Math.max(...points.map(p=>p.lat))+.004),west=Math.min(...lons)-.004,east=Math.max(...lons)+.004;
      const ranges=[];
      for(let shift=Math.floor((west+180)/360);shift<=Math.floor((east+180)/360);shift++){
        const a=Math.max(-180,west-shift*360),b=Math.min(180,east-shift*360);
        if(a<b)ranges.push([south,a,north,b]);
      }
      const ref=/^relation\/[1-9]\d*$/u.test(route.sourceId||"")?route.sourceId.split("/")[1]:null;
      const key=JSON.stringify([ref,ranges]),cached=geographyCache.get(key);
      signal?.throwIfAborted();if(!refresh&&cached&&Date.now()-cached.fetchedAt<3*3600000)return cached;
      const relation=ref?'rel('+ref+')->.route;way(r.route)["highway"]->.routeways;':'';
      const query='[out:json][timeout:35];'+relation+'('+ranges.map(b=>'way["highway"]('+b.join(',')+');').join('')+(ref?'.route;.routeways;':'')+');out body geom;out count;';
      const payload=await request(query,signal,{timeoutMs:45000,attempts:2,maxBytes:32*1024*1024}),items=checked(payload);
      if(ref&&!items.some(e=>e.type==="relation"&&String(e.id)===ref))throw Error("线路关系缺失，原道路背景已保留");
      const roads=items.filter(e=>e.type==="way"&&e.tags?.highway).map(e=>{
        if(!Array.isArray(e.geometry)||e.geometry.length<2||e.geometry.some(p=>!Number.isFinite(p?.lat)||!Number.isFinite(p?.lon)||Math.abs(p.lat)>85||Math.abs(p.lon)>180))throw Error("道路 "+e.id+" 几何不完整，原道路背景已保留");
        return {id:e.id,class:e.tags.highway,name:e.tags.name||"",points:e.geometry.map(p=>({lat:p.lat,lon:p.lon}))};
      });
      if(roads.length>16000||roads.reduce((a,r)=>a+r.points.length,0)>300000)throw Error("线路道路背景范围过大，原图已保留");
      const members=items.find(e=>e.type==="relation"&&String(e.id)===ref)?.members||[];
      const ids=new Set(roads.map(e=>e.id));
      const routeWayIds=members.filter(m=>m.type==="way"&&!/stop|platform/u.test(m.role||"")&&ids.has(m.ref)).map(m=>m.ref);
      const result={complete:true,roads,routeWayIds,sourceTime:payload.osm3s?.timestamp_osm_base||null,fetchedAt:Date.now(),bounds:ranges};
      signal?.throwIfAborted();geographyCache.set(key,result);while(geographyCache.size>8)geographyCache.delete(geographyCache.keys().next().value);
      return result;
    }

    return {search,load,loadGeography,peek,preview};
  }
  root.HuayuTransitStationData=Object.freeze({create,serviceFor,endpointsFor,endpointStatus,isRoundtrip,operatorQuery,discoveryQuery,routesQuery,checked,routeFromMembers,stationRef,stationRefs,stationFromFeature,previewForStation,railContextQuery,orderRailStops,transferRefs,railFamilyRoots,railFamilyQuery,checkedRailFamily,railFamilyEntry});
})(globalThis);
