import {readFile} from "node:fs/promises";
import assert from 'node:assert/strict';
import '../site/transit-station-data.js';
import '../site/transit-template-core.js';
const D=globalThis.HuayuTransitStationData,T=globalThis.HuayuTransitTemplates;
const station={type:'node',id:100,name:'测试站'},n=(id,name='测试站',extra={})=>({type:'node',id,lat:14+id/1e6,lon:152,tags:{highway:'bus_stop',name,...extra}});
const seed=n(100),a={type:'relation',id:200,tags:{type:'route',route:'bus',ref:'7',operator:'分线运营公司',price:'2',currency:'CNY',start_time:'06:00',end_time:'22:30'},members:[{type:'node',ref:99,role:'stop'},{type:'node',ref:100,role:'stop'},{type:'node',ref:101,role:'stop'}]},
 b={...a,id:201,tags:{type:'route',route:'bus',ref:'8'},members:[{type:'node',ref:102,role:'stop'},{type:'node',ref:100,role:'stop'}]},
 parent={type:'relation',id:300,tags:{type:'route_master',route_master:'bus',operator:'总运营公司',opening_hours:'Mo-Fr 06:00-23:00',interval:'10',charge:'3 CNY'},members:[{type:'relation',ref:200,role:''},{type:'relation',ref:201,role:''}]};
const pack=items=>({osm3s:{timestamp_osm_base:'2026-11-18T01:02:03Z'},elements:[...items,{type:'count',tags:{total:String(items.length)}}]});
const source=[seed,n(99,'甲站'),n(101,'乙站'),n(102,'丙站'),a,b,parent],calls=[];
const fetch=async(url,options)=>{calls.push({url,options});const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data');return Response.json(pack(q.includes('->.station;')?[seed,a,b,parent]:source));};
const loaded=await D.create({fetch}).load(station);assert.equal(loaded.entries.length,2);assert.equal(loaded.complete,true);assert.equal(loaded.stationId,'node/100');assert.equal(loaded.sourceTime,'2026-11-18T01:02:03Z');
assert.deepEqual(loaded.entries[0].route.stops.map(s=>s.sourceId),['node/99','node/100','node/101']);assert.equal(loaded.entries[0].current,1);
assert.equal(loaded.entries[0].route.service.fare,'2 CNY');assert.equal(loaded.entries[0].route.service.operator,'分线运营公司');assert.equal(loaded.entries[0].route.service.interval,'10');assert.equal(loaded.entries[1].route.service.fare,'3 CNY');
assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.credentials==='omit'));assert.ok(calls.every(c=>!String(c.options.body).includes('around:')));
const currencyConflict={...parent,id:302,tags:{type:'route_master',route_master:'bus',fare:'3',currency:'USD'}};
assert.equal(D.serviceFor(b,[{...parent,tags:{...parent.tags,charge:'3',currency:'CNY'}},currencyConflict]).service.fare,'','different fare currencies cannot inherit a false consensus');
assert.throws(()=>D.routeFromMembers({...a,tags:{...a.tags,route:'bicycle'}},source,station),/已变化/u);
const conflicting={...parent,id:301,tags:{...parent.tags,interval:'20'}};assert.equal(D.serviceFor(b,[parent,conflicting]).service.interval,'');assert.equal(D.serviceFor(a,[parent,conflicting]).service.fare,'2 CNY');
assert.throws(()=>D.checked({...pack(source),remark:'runtime error'}),/不完整/u);assert.throws(()=>D.checked(pack([...source,seed])),/编号/u);
const abort=new AbortController();abort.abort();await assert.rejects(D.create({fetch}).load(station,{signal:abort.signal}),{name:'AbortError'});
let tries=0;await assert.rejects(D.create({fetch:async()=>{tries++;return Response.json({...pack([]),remark:'timeout'});}}).load(station),/不完整/u);assert.equal(tries,2);
await assert.rejects(D.create({fetch:async()=>Response.json(pack([seed]))}).load(station),/没有登记/u);
let stale=0;await assert.rejects(D.create({fetch:async()=>Response.json(++stale===1?pack([seed,a]):pack([seed,n(99),n(101)]))}).load(station),/关系缺失/u);
const platform={type:'way',id:1010,center:{lat:seed.lat,lon:152},tags:{public_transport:'platform',name:'测试站'}};
const paired={...a,members:[{type:'node',ref:99,role:'stop'},{type:'node',ref:100,role:'stop'},{type:'way',ref:1010,role:'platform'},{type:'node',ref:101,role:'stop'}]};
const p=D.routeFromMembers(paired,[...source,platform],{type:'way',id:1010});assert.equal(p.route.stops.length,3);assert.equal(p.route.stops[p.current].sourceId,'way/1010');assert.deepEqual(p.route.stops[p.current].memberSourceIds,['node/100','way/1010']);
assert.throws(()=>D.routeFromMembers(a,source,{type:'node',id:999}),/未把所选/u);
assert.throws(()=>D.discoveryQuery({type:'node',id:'100);out;'}),/编号/u);
let searchQuery='';const search=D.create({fetch:async url=>{searchQuery=new URL(url).searchParams.get('data');return Response.json(pack([seed]));}});assert.equal((await search.search('测试.*站')).items[0].id,100);assert.ok(searchQuery.includes('测试\\\\.\\\\*站'),'search treats regex text literally');
// A larger station keeps all routes through multiple bounded batches.
const many=Array.from({length:25},(_,i)=>({...a,id:500+i,tags:{...a.tags,ref:String(i+1)}}));let batches=0;
const manyResult=await D.create({fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data');if(q.includes('->.station;'))return Response.json(pack([seed,...many]));if(!q.includes('rel(id:'))return Response.json(pack([]));batches++;const ids=q.match(/rel\(id:([\d,]+)\)/u)[1].split(',').map(Number);return Response.json(pack([seed,n(99),n(101),...many.filter(r=>ids.includes(r.id))]));}}).load(station);
assert.equal(manyResult.entries.length,25);assert.equal(batches,2);assert.equal(manyResult.complete,true);
const bus=T.builtins.find(t=>t.id==='bus-stop-red').template,stops=Array.from({length:16},(_,i)=>({sourceId:'node/'+(i+1000),name:'站点'+i,transfers:[{type:'bus',label:'6 · 校园循环地铁接驳'},{type:'subway',label:'2号线'},{type:'train',label:'城际'},{type:'flight',label:'航空'}],tags:i===3?{amenity:'hospital'}:i===4?{amenity:'school'}:{}}));
const rendered=T.render(bus,{...T.demo,stops},{current:0});assert.doesNotMatch(rendered.svg,/校园循环/u);assert.match(rendered.svg,/地铁/u);assert.match(rendered.svg,/铁路/u);assert.match(rendered.svg,/航空/u);assert.match(rendered.svg,/医/u);assert.match(rendered.svg,/学/u);
const ys=[...rendered.svg.matchAll(/<g data-stop-index="\d+">[\s\S]*?<circle[^>]* cy="([\d.]+)"/gu)].map(m=>m[1]);assert.equal(new Set(ys).size,1,'16 stops use one horizontal row');assert.equal(ys.length,16);
const long=T.render(bus,{...T.demo,stops:Array.from({length:60},(_,i)=>({...stops[i%16],name:'站点'+i}))},{current:0});assert.equal([...long.svg.matchAll(/data-stop-index=/gu)].length,60);assert.ok(new Set([...long.svg.matchAll(/<circle[^>]* cy="([\d.]+)"/gu)].map(m=>m[1])).size>1);
for(const {template} of T.builtins.filter(t=>t.template.family==='bus-stop')){const image=T.render(template,loaded.entries[0].route,{current:1});for(const value of ['06:00','22:30','2 CNY','分线运营公司','10'])assert.ok(image.svg.includes(value),template.title+' shows '+value);}
console.log(JSON.stringify({status:'passed',checks:['exact typed station and all registered bus relations','full ordered stops and explicit stop/platform pair','source timestamps and direct service override','consistent route-master inheritance and conflict refusal','literal station search and no proximity membership','incomplete/missing/retry/abort reject atomically','bus interchanges excluded and rail/air retained','explicit hospital/school hints','horizontal 16 stops in one row; long lines retained','all 12 structures display real service fields']}));

// Departures are exact scheduled trips, never an interval. Nearest explicit
// parent wins; conflicts and unrelated companies cannot invent route service.
const timed={...b,tags:{...b.tags,departures:'07:10;08:30;17:40'}};
assert.equal(D.serviceFor(timed,[parent]).service.departures,'07:10;08:30;17:40');
assert.equal(D.serviceFor(timed,[]).service.interval,'');
const network={type:'relation',id:400,tags:{type:'network',network:'bus',name:'校园公交',service_times:'06:20-22:10',departures:'07:00;08:00'},members:[{type:'relation',ref:300,role:''}]};
assert.equal(D.serviceFor(b,[parent,network]).service.hours,parent.tags.opening_hours);
assert.equal(D.serviceFor(b,[parent,network]).service.departures,'07:00;08:00');
assert.deepEqual(D.serviceFor(b,[parent,network]).serviceSources.departures,['relation/400']);
const cycle={...network,members:[...network.members,{type:'relation',ref:400,role:''}]};assert.equal(D.serviceFor(b,[parent,cycle]).service.departures,'07:00;08:00');
const operator={type:'relation',id:401,tags:{type:'operator',name:'总运营公司',opening_hours:'Mo-Fr 09:00-17:00','bus:service_times':'05:40-23:40','bus:departures':'06:20;06:50','bus:fare':'4 CNY'}};
const inherited=D.serviceFor(b,[{...parent,tags:{type:'route_master',route_master:'bus',operator:'总运营公司'}},operator]);
assert.equal(inherited.service.hours,'05:40-23:40');assert.equal(inherited.service.departures,'06:20;06:50');assert.equal(inherited.service.fare,'4 CNY');assert.deepEqual(inherited.serviceSources.hours,['relation/401']);
assert.equal(D.serviceFor({...b,tags:{...b.tags,operator:'别家公司'}},[operator]).service.hours,'');
assert.equal(D.serviceFor({...b,tags:{...b.tags,operator:'总运营公司'}},[{...operator,tags:{type:'operator',name:'总运营公司',opening_hours:'Mo-Fr 09:00-17:00'}}]).service.hours,'','office opening hours cannot be a route schedule');
assert.equal(D.serviceFor(b,[parent,conflicting,operator]).service.interval,'','conflicting route masters cannot be overwritten by a company default');
assert.ok(D.discoveryQuery(station).includes('.routes <<;'));assert.ok(D.routesQuery([200]).includes('.routes <<;'));
for(const title of ['临川大学6号工医小循环','临川大学7号医文小循环','校园环线','Campus Loop'])assert.equal(D.isRoundtrip({...b,tags:{...b.tags,name:title}},[]),true,title);
assert.equal(D.isRoundtrip({...b,tags:{...b.tags,name:'校园环线',roundtrip:'no'}},[]),false);
assert.equal(D.isRoundtrip({...b,tags:{...b.tags,from:'校园东门',to:'校园东门'}},[]),true);
assert.equal(D.isRoundtrip({...b,members:[b.members[0],b.members[1],b.members[0]]},[]),true);
assert.equal(D.routeFromMembers({...a,tags:{...a.tags,name:'临川大学6号工医小循环'}},source,station).route.roundtrip,true);
const failedOperator=await D.create({fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data');return q.includes('rel["type"~')?new Response('',{status:503}):Response.json(pack(q.includes('->.station;')?[seed,a]:source));}}).load(station);
assert.equal(failedOperator.complete,true);assert.equal(failedOperator.operatorStatus,'unavailable');assert.equal(failedOperator.entries[0].route.service.first,'06:00');
console.log('Passed: departure/interval separation, recursive and nearest-parent service, exact scoped operator schedule, office-hours rejection, conflicts, cycle-safe loops and optional operator failure.');

const actualContext=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/transit-station-service.json',import.meta.url),'utf8'));for(const id of [491367,491368]){const r=actualContext.elements.find(e=>e.id===id),v=D.serviceFor(r,actualContext.elements);assert.equal(v.service.hours,'Mo-Su 07:00-22:00');assert.equal(v.service.fare,'校内人员免费；校外人员1元');assert.deepEqual(v.serviceSources.hours,['relation/549596']);assert.equal(D.isRoundtrip(r,actualContext.elements),true);}

const trainChild={...b,tags:{type:'route',route:'train'}},trainMaster={...parent,tags:{type:'route_master',route_master:'train',opening_hours:'06:30-21:30',departures:'07:20;09:40'}};assert.equal(D.serviceFor(trainChild,[trainMaster]).service.hours,'06:30-21:30');assert.equal(D.serviceFor(trainChild,[parent]).service.hours,'','other transport parents must not leak service');

const terminalRoute={...a,tags:{...a.tags,from:'运营起点',to:'运营终点',roundtrip:'yes'}};
assert.deepEqual(D.endpointsFor(terminalRoute,[]),{from:'运营起点',to:'运营终点'});
assert.equal(D.routeFromMembers(terminalRoute,source,station).route.to,'运营终点');
assert.deepEqual(D.endpointsFor({...a,tags:{...a.tags,roundtrip:'yes'}},source),{from:'',to:''});
const master={...parent,tags:{type:'route_master',route_master:'bus'}};
const childA={...a,tags:{...a.tags,from:'共同场站',to:'共同场站'}},childB={...b,tags:{...b.tags,from:'共同场站',to:'共同场站'}};
assert.deepEqual(D.endpointsFor(master,[childA,childB]),{from:'共同场站',to:'共同场站'});
assert.equal(D.endpointsFor(master,[childA,{...childB,tags:{...childB.tags,to:'别处'}}]).to,'');
assert.equal(D.endpointsFor(master,[childA]).to,'');
assert.equal(D.endpointsFor({...master,tags:{...master.tags,to:'主关系终点'}},[childA,childB]).to,'主关系终点');
console.log('Passed: explicit terminals preserved by station loading; master endpoints require complete unanimous directions.');


// Geography must be complete and keep route geometry distinct from station links.
const geoRoute={sourceId:'relation/200',stops:[{lat:14,lon:152},{lat:14.01,lon:152.02}]};
const road=(id,extra={})=>({type:'way',id,tags:{highway:'primary',name:'道路'+id},geometry:[{lat:14,lon:152},{lat:14.01,lon:152.02}],...extra});
const geoItems=[{...a,members:[{type:'way',ref:901,role:''},{type:'way',ref:902,role:'platform'}]},road(901),road(902)];
let geoCalls=0,geoPayload=pack(geoItems),geoQuery='';
const geoLoader=D.create({fetch:async(url,options)=>{geoCalls++;geoQuery=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data');return Response.json(geoPayload);}});
const geo=await geoLoader.loadGeography(geoRoute);assert.equal(geo.complete,true);assert.equal(geo.roads.length,2);assert.deepEqual(geo.routeWayIds,[901]);assert.equal(geo.sourceTime,'2026-11-18T01:02:03Z');
assert.match(geoQuery,/way\(r.route\)\["highway"\]/u);assert.match(geoQuery,/out body geom;out count;/u);
assert.equal(await geoLoader.loadGeography(geoRoute),geo);assert.equal(geoCalls,1);
await geoLoader.loadGeography(geoRoute,{refresh:true});assert.equal(geoCalls,2);
for(const p of [{lat:null,lon:152},{lat:14,lon:'152'},{lat:90,lon:152}])await assert.rejects(geoLoader.loadGeography({...geoRoute,stops:[p,geoRoute.stops[1]]}),/坐标/u);
assert.equal(geoCalls,2,'invalid coordinates never request');
await assert.rejects(geoLoader.loadGeography(geoRoute,{signal:abort.signal}),{name:'AbortError'});
geoPayload=pack([{...a},road(901,{geometry:[{lat:14,lon:152},null]})]);await assert.rejects(geoLoader.loadGeography(geoRoute,{refresh:true}),/几何不完整/u);
assert.equal((await geoLoader.loadGeography(geoRoute)).roads.length,2,'invalid candidate cannot overwrite full cache');
geoPayload={...pack(geoItems),elements:[...geoItems,{type:'count',tags:{total:'999'}}]};await assert.rejects(geoLoader.loadGeography(geoRoute,{refresh:true}),/不完整/u);
geoPayload=pack([road(901)]);await assert.rejects(geoLoader.loadGeography(geoRoute,{refresh:true}),/关系缺失/u);
geoPayload=pack(geoItems);const dateline=await geoLoader.loadGeography({...geoRoute,stops:[{lat:14,lon:179.99},{lat:14,lon:-179.99}]});
assert.equal(dateline.bounds.length,2);assert.ok(dateline.bounds.every(b=>b[1]>=-180&&b[3]<=180&&b[3]-b[1]<.1));
let delayRelease;const delayed=D.create({fetch:async()=>{await new Promise(resolve=>delayRelease=resolve);return Response.json(pack(geoItems));}}),cancelGeo=new AbortController();
const pending=delayed.loadGeography(geoRoute,{signal:cancelGeo.signal});cancelGeo.abort();delayRelease();await assert.rejects(pending,{name:'AbortError'});
console.log('Passed: complete real road geometry, platform exclusion, original source time, cache/force, missing coordinates, dateline, corrupt count/geometry, cancel and failure preserve full geography.');


// Recorded source: JS01 master has route=subway and six distinct directions.
const terminalFixture=JSON.parse(await readFile(new URL('./fixtures/transit-terminal-directions.json',import.meta.url),'utf8'));
const directions=terminalFixture.relations,recordedMaster=directions.find(r=>r.id===540666);
assert.equal(terminalFixture.sourceTime,'2026-11-19T09:36:57Z');
assert.equal(recordedMaster.tags.route,'subway');assert.equal(recordedMaster.tags.route_master,undefined);
assert.deepEqual(D.endpointsFor(recordedMaster,directions),{from:'',to:''});
assert.equal(D.endpointStatus(recordedMaster,directions),'choose-direction');
assert.deepEqual(D.endpointsFor(directions.find(r=>r.id===540664),directions),{from:'鹿山公园',to:'农园路'});
assert.equal(D.endpointStatus(directions.find(r=>r.id===540664),directions),'provided');
assert.equal(D.endpointStatus(recordedMaster,directions.filter(r=>r.id!==540665)),'incomplete');
for(const tags of [{type:'route_master',route:'subway'},{type:'route_master',route_master:'subway'}]){
 const m={type:'relation',id:80,tags,members:[{type:'relation',ref:81},{type:'relation',ref:82}]};
 const children=[81,82].map(id=>({type:'relation',id,tags:{type:'route',route:'subway',from:'起点',to:'终点'}}));
 assert.deepEqual(D.endpointsFor(m,children),{from:'起点',to:'终点'});
 assert.equal(D.endpointStatus(m,children),'provided');
 assert.deepEqual(D.endpointsFor(m,children.slice(0,1)),{from:'',to:''});
 assert.equal(D.endpointStatus({type:'relation',id:90,tags:{type:'route',route:'subway'}},[]),'missing');
}
console.log('Passed: recorded JS01 multi-phase master does not invent a terminal; both route-master mode conventions accept only complete unanimous child endpoints.');

// Rail station selection uses actual source IDs and explicit stop_area membership, never a demo or nearby names.
const railSeed={...seed,tags:{name:'南国大',railway:'stop',subway:'yes',public_transport:'stop_position'}};
const railRoute={...a,tags:{type:'route',route:'subway',ref:'JS01',name:'津川轨道交通1号线',from:'鹿山公园',to:'农园路',colour:'#ED4A28'}};
const otherRail={...b,tags:{type:'route',route:'subway',ref:'JS04',name:'津川轨道交通4号线',colour:'#21a675'}};
const railSource=[railSeed,n(99,'鹿山公园'),n(101,'农园路'),n(102,'虚谷'),railRoute,otherRail];
const railQueries=[];
const railResult=await D.create({fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data');railQueries.push(q);return Response.json(pack(railSource));}}).load({type:'node',id:100,mode:'rail'});
assert.equal(railResult.mode,'rail');assert.equal(railResult.entries.length,2);assert.equal(railResult.entries[0].current,1);assert.equal(railResult.entries[0].route.stops[1].name,'南国大');assert.equal(railResult.entries[0].route.to,'农园路');
assert.deepEqual(railResult.entries[0].route.stops[1].transfers.map(v=>({ref:v.ref,color:v.color})),[{ref:'JS04',color:'#21a675'}]);
assert.ok(railQueries[0].includes('stop_area')&&railQueries[0].includes('subway'));assert.ok(railQueries[1].includes('.interchanges'));assert.ok(!railQueries[0].includes('around')&&railQueries.some(q=>q.includes('around.seeds:350')));
const area={type:'relation',id:900,tags:{type:'public_transport',public_transport:'stop_area'},members:[{type:'node',ref:100,role:'station'},{type:'node',ref:101,role:'stop'}]};
const indirect={...railRoute,members:[{type:'node',ref:99,role:'stop'},{type:'node',ref:101,role:'stop'}]};
const areaEntry=D.routeFromMembers(indirect,[...railSource,area],{type:'node',id:100});assert.equal(areaEntry.current,1);assert.equal(areaEntry.route.stops[1].sourceId,'node/100');
const merged={type:'node',id:100,sourceIds:['node/101']};assert.equal(D.routeFromMembers(indirect,railSource,merged).current,1);assert.match(D.discoveryQuery(merged),/node\(id:100,101\)/u);
assert.throws(()=>D.discoveryQuery({...merged,sourceIds:['node/1);out;']}),/编号/u);
console.log('Passed: metro station identity, complete directions, current stop, real endpoints, per-line transfer colours, exact stop_area/display-source aliases and no proximity inference.');

// Real OGF fixture captured 2026-11-19: merged 南国大 station has two JS01 and two JS04 directions.
const nanguoda=JSON.parse(await readFile(new URL('./fixtures/transit-nanguoda-station.json',import.meta.url),'utf8'));
const actualRail=await D.create({enrichRail:false,expandFamilies:false,fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data'),response=nanguoda.responses.find(r=>r.query===q);assert.ok(response,'recorded station query remains complete and exact');return Response.json(response.payload);}}).load(nanguoda.station);
assert.equal(actualRail.sourceTime,nanguoda.sourceTime);assert.equal(actualRail.entries.length,4);assert.equal(actualRail.mode,'rail');
assert.deepEqual(actualRail.entries.map(e=>[e.route.sourceId,e.route.ref,e.current,e.route.stops.length,e.route.to]),[['relation/540664','JS01',15,18,'农园路'],['relation/540665','JS01',15,18,'鹿山公园'],['relation/547548','JS04',5,37,'虚谷'],['relation/547549','JS04',5,37,'虚谷']]);
for(const e of actualRail.entries){const stop=e.route.stops[e.current];assert.equal(stop.sourceId,nanguoda.station.sourceId);assert.equal(stop.name,'南国大');assert.equal(e.route.demo,undefined);assert.deepEqual(stop.transfers.map(t=>[t.ref,t.color]),e.route.ref==='JS01'?[['JS04','#21a675']]:[['JS01','#ED4A28']]);}
console.log('Passed: recorded 南国大 real station gives all four full directions, preserves tagged destinations, pins current by source ID and deduplicates transfer directions into JS01/JS04 coloured symbols.');

const busArea={type:'relation',id:999,tags:{public_transport:'stop_area'},members:[{type:'node',ref:100,role:'stop'},{type:'node',ref:102,role:'stop'}]};
assert.deepEqual([...D.stationRefs({type:'node',id:100,mode:'bus',sourceIds:['node/102']},[...source,busArea])],['node/100'],'bus opposite points must remain exact even in a stop area or display group');
assert.throws(()=>D.routeFromMembers({...a,members:[{type:'node',ref:102,role:'stop'}]},[...source,busArea],{type:'node',id:100,mode:'bus'}),/未把所选/u);
console.log('Passed: bus stop_area and display aliases never merge opposite stops; rail compatibility does not relax exact bus membership.');

// Map selection must use typed source identity; ordinary selected features also qualify.
assert.equal(D.stationFromFeature({type:'node',id:100,label:'车站',originalTags:railSeed.tags}).mode,'rail');
assert.equal(D.stationFromFeature({type:'node',id:100,originalTags:seed.tags}).mode,'bus');
assert.equal(D.stationFromFeature({type:'way',id:123,originalTags:{building:'yes'}}),null);
const railNodes=[99,100,101,102].map(id=>({...n(id),tags:{name:id===100?'南国大':'站点'+id,railway:'stop',subway:'yes',public_transport:'stop_position'}}));
let clock=1000000,cacheCalls=0,failCache=false,changed=false;
const cacheLoader=D.create({enrichRail:false,now:()=>clock,fetch:async()=>{cacheCalls++;if(failCache)return new Response('',{status:400});return Response.json(pack([...railNodes,changed?{...railRoute,tags:{...railRoute.tags,to:'修改后的真实终点'}}:railRoute,otherRail]));}});
const original=await cacheLoader.load({type:'node',id:100,mode:'rail'});assert.equal(cacheCalls,2);
const cacheHit=await cacheLoader.load({type:'node',id:100,mode:'rail'});assert.equal(cacheHit.cached,true);assert.equal(cacheCalls,2);assert.equal(cacheHit.sourceTime,original.sourceTime);assert.equal(cacheHit.fetchedAt,original.fetchedAt);
cacheHit.entries[0].route.stops[0].name='调用者修改';assert.notEqual(cacheLoader.peek({type:'node',id:100,mode:'rail'}).entries[0].route.stops[0].name,'调用者修改','cached complete results are isolated');
const nextStation={type:'node',id:99,mode:'rail',name:'站点99'},quick=cacheLoader.preview(nextStation);
assert.equal(quick.stationId,'node/99');assert.equal(quick.complete,false);assert.equal(quick.entries.length,1);assert.equal(quick.entries[0].current,0);assert.equal(quick.entries[0].route.stops[0].sourceId,'node/99');assert.equal(quick.sourceTime,original.sourceTime);assert.equal(cacheCalls,2,'preview performs no request');
assert.equal(cacheLoader.preview({type:'node',id:999,mode:'rail',name:'南国大'}),null,'same name never guesses station identity');
assert.equal(cacheLoader.preview({type:'node',id:99,mode:'bus'}),null,'rail routes do not become bus boards');
await cacheLoader.load(nextStation);assert.equal(cacheCalls,3,'other station discovers full membership but reuses unchanged complete route details');
changed=true;const updated=await cacheLoader.load({type:'node',id:101,mode:'rail'});assert.equal(cacheCalls,5,'changed relation content invalidates detail cache');assert.equal(updated.entries[0].route.to,'修改后的真实终点');
const stable=cacheLoader.peek(nextStation);failCache=true;
await assert.rejects(cacheLoader.load(nextStation,{refresh:true}),/读取失败/u);assert.deepEqual(cacheLoader.peek(nextStation),stable,'failed force refresh preserves complete cache');
const aborted=new AbortController();aborted.abort();await assert.rejects(cacheLoader.load(nextStation,{signal:aborted.signal}),{name:'AbortError'});
failCache=false;const beforeForce=cacheCalls;await cacheLoader.load(nextStation,{refresh:true});assert.equal(cacheCalls,beforeForce+2,'force refresh bypasses both station and details caches');
clock+=120001;assert.equal(cacheLoader.peek(nextStation),null);assert.equal(cacheLoader.preview(nextStation),null,'expired data does not provide an unmarked preview');const expiredCalls=cacheCalls;await cacheLoader.load(nextStation);assert.equal(cacheCalls,expiredCalls+2,'expiry rereads source and full route details');
const busQuick=D.previewForStation(loaded,{type:'node',id:102,mode:'bus'});assert.equal(busQuick.entries.length,1);assert.equal(busQuick.entries[0].route.sourceId,'relation/201');assert.equal(busQuick.entries[0].current,0);assert.equal(D.previewForStation(loaded,{type:'node',id:777,mode:'bus',name:'测试站'}),null);
let uncancel;const abortedLoader=D.create({fetch:async()=>{await new Promise(resolve=>uncancel=resolve);return Response.json(pack([...railNodes,railRoute,otherRail]));}}),abortLater=new AbortController();
const abortedTask=abortedLoader.load(nextStation,{signal:abortLater.signal});abortLater.abort();uncancel();await assert.rejects(abortedTask,{name:'AbortError'});assert.equal(abortedLoader.peek(nextStation),null,'late cancelled request cannot seed a complete cache');
console.log('Passed: ordinary map station identification, instant exact-ID preview, no guessed or opposite stops, two-minute full cache, immutable source snapshots, unchanged route reuse, changed relation invalidation, force/expiry, original source age and cancelled/failure cache isolation.');

// Sharing direction details must not keep old source snapshots alive indefinitely.
let expiryNow=0,expiryCalls=0;
const expiryLoader=D.create({enrichRail:false,now:()=>expiryNow,fetch:async()=>{expiryCalls++;return Response.json(pack([...railNodes,railRoute,otherRail]));}});
await expiryLoader.load({type:'node',id:100,mode:'rail'});expiryNow=119000;await expiryLoader.load(nextStation);assert.equal(expiryCalls,3);
expiryNow=120001;assert.equal(expiryLoader.peek(nextStation),null,'station cache must expire at the oldest reused source read, not at the later station visit');
await expiryLoader.load(nextStation);assert.equal(expiryCalls,5);
console.log('Passed: moving between stations cannot extend the two-minute source cache lifetime.');

// Live topology snapshot: JS01 members are grouped by phase; the railway is continuous.
const topology=JSON.parse(await readFile(new URL('./fixtures/transit-nanguoda-topology.json',import.meta.url),'utf8')),ruleBook=JSON.parse(await readFile(new URL('../site/transit-services.json',import.meta.url),'utf8'));let topologyCalls=0;
const topologyLoader=D.create({expandFamilies:false,rules:()=>ruleBook,fetch:async(url,options)=>{topologyCalls++;const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data'),row=topology.responses.find(r=>r.query===q);assert.ok(row,'recorded real enrichment query is exact');return Response.json(row.payload);}});
const completeRail=await topologyLoader.load(topology.station),forward=completeRail.entries.find(e=>e.route.sourceId==='relation/540664'),back=completeRail.entries.find(e=>e.route.sourceId==='relation/540665');
const correctOrder=['鹿山公园','青创城','长宁湖','高阳北路','环光中心','上京西路','市政府','津川火车站','安巷','东南大街','熙园','玄默门','临川','苍龙门','临大·津师','南国大','龙湖南湾','农园路'];
assert.deepEqual(forward.route.stops.map(v=>v.name),correctOrder);assert.deepEqual(back.route.stops.map(v=>v.name),[...correctOrder].reverse());assert.equal(forward.current,15);assert.equal(back.current,2);assert.equal(forward.route.orderBasis,'connected-track');assert.equal(completeRail.sourceTime,topology.sourceTime);
assert.deepEqual(forward.route.stops.filter(v=>v.transfers.length).map(v=>[v.name,v.transfers.map(t=>t.ref)]),[['长宁湖',['JS04']],['环光中心',['JS02']],['津川火车站',['JS03']],['玄默门',['JS05']],['南国大',['JS04']]]);
const ring4=completeRail.entries.find(e=>e.route.ref==='JS04');assert.ok(ring4.route.stops.find(v=>v.name==='卧虎山').transfers.some(v=>v.ref==='JSS1'));assert.equal(ring4.route.stops.length,37);assert.equal(ring4.route.orderBasis,'members');assert.match(ring4.route.orderWarning,/连续|断开/u,'disconnected source track must be disclosed rather than fabricate a connection');
assert.equal(topologyCalls,3);await topologyLoader.load(topology.station);assert.equal(topologyCalls,3,'whole topology and transfers reuse bounded complete cache');
const originalSourceOrder=topology.responses[1].payload.elements.find(e=>e.type==='relation'&&e.id===540664).members.filter(m=>m.role==='stop').map(m=>m.ref);assert.equal(originalSourceOrder[0],424888164,'original source order remains unchanged');
const nodes=[{lat:14,lon:152},{lat:14,lon:152.01},{lat:14.01,lon:152.01},{lat:14.01,lon:152}].map((p,i)=>({...p,type:'node',id:5000+i,tags:{railway:'stop',subway:'yes',name:'U'+i}}));
const way={type:'way',id:990,nodes:[5000,5001,5002,5003],geometry:nodes.map(({lat,lon})=>({lat,lon})),tags:{railway:'subway'}},uRoute={type:'relation',id:991,tags:{type:'route',route:'subway',from:'U0',to:'U3'},members:[{type:'way',ref:990,role:''},...[5002,5000,5003,5001].map(ref=>({type:'node',ref,role:'stop'}))]},uItems=[...nodes,way,uRoute];
const u=D.routeFromMembers(uRoute,uItems,{type:'node',id:5001});assert.deepEqual(u.route.stops.map(v=>v.name),['U0','U1','U2','U3']);assert.equal(u.current,1);
const uBack=D.routeFromMembers({...uRoute,tags:{...uRoute.tags,from:'U3',to:'U0'}},uItems,{type:'node',id:5001});assert.deepEqual(uBack.route.stops.map(v=>v.name),['U3','U2','U1','U0']);
const broken=D.orderRailStops(u.route.stops,uRoute,[...nodes,{...way,nodes:[5000,5001],geometry:way.geometry.slice(0,2)}]);assert.equal(broken.stops.length,4);assert.equal(broken.orderBasis,'members');assert.ok(broken.orderWarning);
const sharedStop={sourceId:'node/5000',memberSourceIds:['node/5000'],name:'U0',...nodes[0]},far={...nodes[0],id:7000,lat:14.1},near={...nodes[0],id:7001,lat:14.0001},different={...near,id:7002,tags:{...near.tags,name:'U0站'}},train={...near,id:7003,tags:{name:'U0',railway:'station',train:'yes'}},nearRoute={type:'relation',id:7004,tags:{type:'route',route:'subway',ref:'X2'},members:[{type:'node',ref:7001,role:'stop'},{type:'node',ref:7000,role:'stop'},{type:'node',ref:7002,role:'stop'}]},trainRoute={...nearRoute,id:7005,tags:{type:'route',route:'train'},members:[{type:'node',ref:7003,role:'stop'}]};
const refs=D.transferRefs(sharedStop,[...uItems,far,near,different,train,nearRoute,trainRoute],'subway');assert.ok(refs.has('node/7001'));for(const id of [7000,7002,7003])assert.ok(!refs.has('node/'+id),'distance/full name/system cannot merge '+id);
let badContext=0;const incomplete=D.create({expandFamilies:false,fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data'),response=topology.responses.find(r=>r.query===q);assert.ok(response);let payload=response.payload;if(q.includes('templateRail')){badContext++;const rows=payload.elements.filter(e=>e.type!=='count'&&!(e.type==='way'&&e.id===topology.responses[2].payload.elements.find(v=>v.type==='way').id));payload={...payload,elements:[...rows,{type:'count',tags:{total:String(rows.length)}}]};}return Response.json(payload);}});
await assert.rejects(incomplete.load(topology.station),/几何缺失|不完整/u);assert.equal(incomplete.peek(topology.station),null);assert.equal(badContext,1);
console.log('Passed: live JS01 corrected both directions on connected tracks, all five interchanges with real colours, JS04 nine transfer stations, U-shaped topology, exact names/systems/radii, original members retained, honest disconnected fallback and incomplete enrichment cannot cache.');

{
// Full master traversal includes phases that do not directly serve the selected station.
const fullFamily=JSON.parse(await readFile(new URL('./fixtures/transit-nanguoda-family.json',import.meta.url),'utf8'));let familyCalls=0;
const fullLoader=D.create({rules:()=>ruleBook,fetch:async(url,options)=>{familyCalls++;const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data'),row=fullFamily.responses.find(r=>r.query===q);assert.ok(row,'full recorded family query remains exact');return Response.json(row.payload);}});
const full=await fullLoader.load(fullFamily.station);assert.equal(familyCalls,4);assert.deepEqual(full.familyRootIds,['relation/540666','relation/547550']);assert.equal(full.entries.length,8);assert.equal(full.directLineCount,4);
assert.deepEqual(full.entries.filter(e=>e.route.ref==='JS01').map(e=>e.route.sourceId).sort(),['relation/540664','relation/540665','relation/547489','relation/547490','relation/547491','relation/547492']);
assert.ok(full.entries.some(e=>e.route.stops.some(s=>s.name==='技木山北')));assert.ok(full.entries.some(e=>e.route.stops.some(s=>s.name==='荣川国际机场')));for(const e of full.entries.filter(e=>[547489,547490,547491,547492].some(id=>e.route.sourceId==='relation/'+id)))assert.equal(e.current,-1,'other phases cannot falsely select a current stop');
await fullLoader.load(fullFamily.station);assert.equal(familyCalls,4);assert.equal(full.sourceTime,fullFamily.sourceTime);
const fullItems=[...new Map(fullFamily.responses.flatMap(v=>v.payload.elements.filter(e=>e.type!=='count')).map(e=>[e.type+'/'+e.id,e])).values()];
const fullRoot=fullItems.find(e=>e.type==='relation'&&e.id===540666),familyNodes=D.checkedRailFamily([fullRoot],fullItems);assert.equal(familyNodes.filter(e=>e.tags.type==='route').length,6);
assert.throws(()=>D.checkedRailFamily([fullRoot],fullItems.filter(e=>!(e.type==='relation'&&e.id===547491))),/关系缺失/u);
const leaf={type:'relation',id:8001,tags:{type:'route',route:'subway'},members:[]},otherLeaf={...leaf,id:8002},branch={type:'relation',id:8003,tags:{type:'route_master',route_master:'subway'},members:[{type:'relation',ref:8001,role:'route'},{type:'relation',ref:8002,role:'route'}]},outer={type:'relation',id:8004,tags:{type:'route_master',route:'subway'},members:[{type:'relation',ref:8003,role:'route'}]},network={type:'relation',id:8005,tags:{type:'collection',route:'subway'},members:[{type:'relation',ref:8004,role:''}]},unrelated={...otherLeaf,id:9990,tags:{...otherLeaf.tags,ref:'same-ref'}};
assert.deepEqual(D.railFamilyRoots([leaf],[leaf,otherLeaf,branch,outer,network,unrelated]).map(v=>v.id),[8004]);assert.deepEqual(D.checkedRailFamily([outer],[leaf,otherLeaf,branch,outer,network,unrelated]).map(v=>v.id),[8004,8003,8001,8002]);
assert.throws(()=>D.checkedRailFamily([outer],[leaf,otherLeaf,{...branch,members:[{type:'relation',ref:8004,role:'route'}]},outer]),/循环引用/u);
let failedFamilyQueries=0;const failingFamily=D.create({fetch:async(url,options)=>{const q=new URL(url).searchParams.get('data')||new URLSearchParams(options.body).get('data'),response=fullFamily.responses.find(v=>v.query===q);assert.ok(response);if(q.includes('->.familyRoots;')){failedFamilyQueries++;const rows=response.payload.elements.filter(e=>e.type!=='count'&&!(e.type==='relation'&&e.id===547492));return Response.json({...response.payload,elements:[...rows,{type:'count',tags:{total:String(rows.length)}}]});}return Response.json(response.payload);}});
await assert.rejects(failingFamily.load(fullFamily.station),/关系缺失/u);assert.equal(failingFamily.peek(fullFamily.station),null);assert.equal(failedFamilyQueries,1,'count-valid but missing phase is rejected before a full result can be cached');
console.log('Passed: current full JS01 master includes six phases/directions and east/west extensions; exact nested master traversal, no network or same-ref expansion, unserved phases neutral, source age/cache preserved, missing child and cycles rejected atomically.');

}


// Through connections receive original connected-track endpoint IDs, oriented with the displayed stops.
const endpointStops=[{sourceId:'node/7001',name:'端点甲',lat:10,lon:20},{sourceId:'node/7002',name:'端点乙',lat:10,lon:20.001},{sourceId:'node/7003',name:'端点丙',lat:10,lon:20.002}];
const endpointRoute={type:'relation',id:7000,tags:{type:'route',route:'subway',from:'端点甲',to:'端点丙'},members:[{type:'way',ref:7010,role:''}]};
const endpointWay={type:'way',id:7010,nodes:[7001,7002,7003],geometry:endpointStops.map(s=>({lat:s.lat,lon:s.lon})),tags:{railway:'subway'}};
assert.deepEqual(D.orderRailStops(endpointStops,endpointRoute,[endpointRoute,endpointWay]).trackEndpointIds,['node/7001','node/7003']);
assert.deepEqual(D.orderRailStops(endpointStops,{...endpointRoute,tags:{...endpointRoute.tags,from:'端点丙',to:'端点甲'}},[endpointRoute,endpointWay]).trackEndpointIds,['node/7003','node/7001']);
assert.equal(D.orderRailStops(endpointStops,endpointRoute,[endpointRoute]).trackEndpointIds,undefined,'incomplete tracks cannot claim endpoint continuity');
console.log('Passed: through-running evidence uses oriented original track endpoint nodes; incomplete track topology has no invented connector.');

assert.deepEqual(D.orderRailStops(endpointStops,endpointRoute,[endpointRoute,{...endpointWay,nodes:undefined}]).trackEndpointIds,[],'geometry-only ordering cannot claim original-node through connectivity');
