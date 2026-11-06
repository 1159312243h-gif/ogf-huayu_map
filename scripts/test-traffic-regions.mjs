import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const context=vm.createContext({console,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,Float64Array});
for(const name of ["traffic-core","traffic-demand","traffic-regions","traffic-regional-core","traffic-protocol"])vm.runInContext(await readFile(new URL(`../site/${name}.js`,import.meta.url),"utf8"),context);
const C=context.HuayuTrafficCore,R=context.HuayuTrafficRegions,U=context.HuayuRegionalTraffic,plain=v=>JSON.parse(JSON.stringify(v));
const center=[152,14],project=C.projection(center),xy=(x,y)=>project.lngLat([x,y]);
const poly=(x0,y0,x1,y1)=>({type:"Polygon",coordinates:[[xy(x0,y0),xy(x1,y0),xy(x1,y1),xy(x0,y1),xy(x0,y0)]]});
const rel=(id,name,level,g,tags={},centre=null)=>({type:"relation",id,tags:{name,boundary:"administrative",admin_level:String(level),...tags},members:[
  ...g.coordinates.map((ring,i)=>({type:"way",ref:id*100+i,role:i?"inner":"outer",geometry:ring.map(p=>({lon:p[0],lat:p[1]}))})),...(centre?[{type:"node",ref:centre,role:"admin_centre"}]:[])]});
const place=(id,name,pop,x,y,kind="suburb")=>({type:"node",id,lon:xy(x,y)[0],lat:xy(x,y)[1],tags:{name,place:kind,population:String(pop)}});
const selection=(r,g)=>({osm_type:"relation",osm_id:r.id,name:r.tags.name,extratags:r.tags,geojson:g});
let cases=0;function check(name,fn){fn();cases++;console.log(`passed: ${name}`);}
check("population:hx, actual admin_centre, contained place population, residual conservation and nested selections",()=>{
  const all=poly(-2000,-1000,2000,1000),sub=poly(-1800,-800,-100,800),a=rel(1,"同名",5,all,{},101),b=rel(2,"同名",6,sub,{"population:hx":"400"});
  const input=[a,b,place(101,"市",1000,0,0,"city"),place(102,"社区",100,-1000,0,"quarter")],p=R.populationZones(input,[selection(a,all),selection(b,sub)]);
  assert.equal(p.total,1000);assert.equal(p.zones.reduce((n,z)=>n+z.residents,0),1000);assert.equal(p.rows.find(r=>r.id==="relation:2").population,400);
  assert.match(p.rows.find(r=>r.id==="relation:1").source,/admin_centre 101/);assert.equal(p.rows.length,3);assert.equal(p.conflicts.length,0);
  const conflicted=R.populationZones([a,{...b,tags:{...b.tags,"population:hx":"1200"}},input[2]],[selection(a,all)]);
  assert.equal(conflicted.total,1200);assert.equal(conflicted.conflicts.length,1);
  const unknown=R.populationZones([rel(1,"未知",5,all),b],[selection(a,all)]);assert.equal(unknown.total,400);assert.equal(unknown.missing,1);
});
check("administrative holes and incomplete rings never become population or fake administrative rectangles",()=>{
  const g=poly(-2000,-1000,2000,1000);g.coordinates.push(poly(-100,-100,100,100).coordinates[0]);
  const a=rel(1,"有洞",5,g,{population:"200"});assert.equal(R.inside(center,R.geometry(a)),false);
  assert.equal(R.populationZones([a,place(2,"洞内",999,0,0,"quarter")],[selection(a,g)]).total,200);
  const damaged=plain(a);damaged.members[0].geometry.pop();assert.throws(()=>R.geometry(damaged),/闭合/);
});
const road=(id,pts,tags={})=>({type:"Feature",id,properties:{highway:"primary",roadNodes:pts.map(p=>p[0]),...tags},geometry:{type:"LineString",coordinates:pts.map(p=>xy(p[1],p[2]))}});
check("regional roads extend beyond the old radius, retain actual bridges and do not connect independent crossing IDs/layers",()=>{
  const roads=[road("a",[[1,-3000,0],[2,0,0],[3,3000,0]],{layer:1,bridge:"yes"}),road("b",[[4,0,-3000],[2,0,0],[5,0,3000]])];
  const g=C.buildGraph(roads,{center,regional:true});assert.equal(g.edges.length,4);assert.ok(g.edges.some(e=>e.elevated));
  assert.equal(g.nodes.size,4);assert.equal(g.edges[0].next.length,0);
  assert.equal(C.buildGraph(roads,{center}).edges.length,0);
});
check("through traffic prefers a main road over a marginally shorter service-road shortcut",()=>{
  const g=C.buildGraph([road("main",[[1,-300,0],[2,0,100],[3,300,0]]),road("shortcut",[[1,-300,0],[3,300,0]],{highway:"service",maxspeed:"40"})],{center});
  const t=context.HuayuTrafficDemand.shortestPaths(g,"1"),path=context.HuayuTrafficDemand.route(t,g,"1","3");
  assert.ok(path.every(id=>g.edges[id].highway==="primary"));
});
function input(join=true,parking=false){
  const g1=poly(-2100,-600,-10,600),g2=poly(10,-600,2100,600),a=rel(1,"甲市",5,g1,{population:"20000"}),b=rel(2,"乙市",5,g2,{population:"10000"});
  const selected=[selection(a,g1),selection(b,g2)],population=R.populationZones([a,b],selected);
  const features=[{type:"Feature",id:"work",properties:{building:"office",name:"工作与商业区"},geometry:{type:"Point",coordinates:xy(1500,0)}}];
  if(parking)features.push({type:"Feature",id:"parking",properties:{amenity:"parking",capacity:"2",name:"小型停车场"},geometry:{type:"Point",coordinates:xy(1500,20)}});
  return {center,roads:[road("west",[[1,-1500,0],[2,0,0]]),road("east",[[join?2:4,0,0],[3,1500,0]])],features,population,
    selected:selected.map(s=>({name:s.name,id:s.osm_id,geometry:s.geojson})),bounds:[...xy(-2100,-600),...xy(2100,600)],sourceTimes:[1000],provincial:false};
}
const simulation=(i,extra={})=>new U.RegionalSimulation(U.buildGraph(i),{regionalInput:i,startHour:8,demandFactor:1,...extra});
check("ordinary districts spread conserved population over real residential access points and retain holes",()=>{
  const i=input(),area=poly(-1800,-500,-100,500);area.coordinates.push(poly(-850,-50,-750,50).coordinates[0]);
  i.population={...i.population,total:60000,zones:[{id:"district",name:"街道",region:"甲市",residents:60000,coordinate:xy(-1500,0),geometry:area}]};
  const points=[[1,-1500,0],[6,-1200,300],[7,-400,300],[8,-300,-300],[2,0,0]];
  i.roads=[...points.slice(1).map((p,n)=>road(`residential${n}`,[points[n],p],{highway:"residential"})),road("work",[[2,0,0],[3,1500,0]])];
  const a=simulation(i),homes=a.demand.sites.filter(p=>p.kind==="home");
  assert.equal(homes.length,3);assert.equal(homes.reduce((n,h)=>n+h.weight,0),60000);
  for(const h of homes){assert.ok(a.graph.nodes.has(h.node));assert.ok(R.inside(h.access,area));assert.ok(h.weight<60000);}
  const b=simulation(i,{count:1200});assert.equal(a.demand.total,b.demand.total);assert.deepEqual(plain(a.demand.pairs.map(p=>p.hourly)),plain(b.demand.pairs.map(p=>p.hourly)));
});
check("over 512 facilities within the supported budget retain their own access points and total weight",()=>{
  const i=input(),points=Array.from({length:602},(_,n)=>[n+1,-1500+n*5,0]);
  i.selected=[{name:"甲市",geometry:poly(-2000,-500,2000,500)}];
  i.population={...i.population,total:1000,zones:[{id:"home",name:"小区",region:"甲市",residents:1000,coordinate:xy(-1500,0)}]};
  i.roads=points.slice(1).map((p,n)=>road(`r${n}`,[points[n],p],{highway:"residential"}));
  i.features=points.slice(1,601).map((p,n)=>({type:"Feature",id:`office${n}`,properties:{office:"yes",name:`办公${n}`},geometry:{type:"Point",coordinates:xy(p[1],0)}}));
  const s=simulation(i),destinations=s.demand.sites.filter(p=>p.kind!=="home");
  assert.equal(destinations.length,600);assert.equal(new Set(destinations.map(p=>p.node)).size,600);
  assert.equal(destinations.reduce((n,d)=>n+d.weight,0),60000);
  const network=s.network(),used=new Set([...s.demand.flows].filter(([,f])=>f>0).map(([id])=>id));
  assert.ok(used.size>0,"ineligible sub-40m destinations must not displace all valid longer trips");
  assert.ok(network.some(e=>e.hourly===0));assert.equal(network.reduce((n,e)=>n+e.ids.length,0),s.graph.edges.length);
  for(const e of network.filter(e=>e.hourly===0))assert.ok(e.ids.every(id=>!used.has(id)));
});
check("overflow facility grouping preserves total weight and each original parking assignment",()=>{
  const i=input(),points=Array.from({length:1900},(_,n)=>{
    const row=Math.floor(n/50),column=row%2?49-n%50:n%50;return [n+1,-245+column*10,-185+row*10];
  });
  i.selected=[{name:"甲市",geometry:poly(-500,-500,500,500)}];
  i.population={...i.population,total:1000,zones:[{id:"home",name:"小区",region:"甲市",residents:1000,coordinate:xy(-300,-185)}]};
  i.roads=[road("home",[[0,-300,-185],points[0]],{highway:"residential"}),...points.slice(1).map((p,n)=>road(`r${n}`,[points[n],p],{highway:"residential"}))];
  i.features=points.map((p,n)=>({type:"Feature",id:`office${n}`,properties:{office:"yes"},geometry:{type:"Point",coordinates:xy(p[1],p[2])}}));
  for(const [id,x] of [["west-parking",-105],["east-parking",145]])i.features.push({type:"Feature",id,properties:{amenity:"parking",capacity:"100"},geometry:{type:"Point",coordinates:xy(x,-5)}});
  const demand=new U.RegionalDemand(U.buildGraph(i),i,{startHour:8}),destinations=demand.sites.filter(p=>p.kind!=="home");
  assert.ok(destinations.length<1800,"overflow should actually combine facilities");
  assert.equal(destinations.reduce((n,d)=>n+d.weight,0),190000);
  const weight=id=>destinations.filter(d=>d.parking?.id===id).reduce((n,d)=>n+d.weight,0);
  // Each of 38 rows has 27 nodes west of the lots' 20 m bisector and 23 east.
  assert.equal(weight("west-parking"),102600);assert.equal(weight("east-parking"),87400);
  for(const d of destinations)assert.equal(d.node,d.parking.node);
});
check("internal streets support population origins and destination access without becoming a through shortcut",()=>{
  const g=C.buildGraph([
    road("west",[[1,-500,0],[2,0,0]]),road("east",[[4,300,0],[5,800,0]]),
    road("main",[[2,0,0],[6,150,200],[4,300,0]]),
    road("internal",[[2,0,0],[3,150,0],[4,300,0]],{highway:"service",maxspeed:"90"})
  ],{center,regional:true,accessNodes:new Set(["3"])});
  g.incoming=new Map();for(const e of g.edges){if(!g.incoming.has(e.to))g.incoming.set(e.to,[]);g.incoming.get(e.to).push(e.id);}
  const route=(a,b,reverse=false)=>U.path(g,U.tree(g,a,reverse),a,b,reverse);
  assert.ok(route("1","5").every(id=>!g.edges[id].accessOnly));
  assert.ok(route("1","5",true).every(id=>!g.edges[id].accessOnly));
  for(const ids of [route("3","5"),route("1","3"),route("3","5",true)]){
    assert.ok(ids.some(id=>g.edges[id].accessOnly));
    for(let i=1;i<ids.length;i++)assert.equal(g.edges[ids[i-1]].to,g.edges[ids[i]].from);
  }
  const i=input();i.roads=[...i.roads,road("home-access",[[10,-1500,100],[1,-1500,0]],{highway:"living_street"})];
  i.population={...i.population,total:1000,zones:[{id:"home",name:"小区",region:"甲市",residents:1000,coordinate:xy(-1500,100)}]};
  const a=simulation(i),b=simulation({...i,population:{...i.population,total:2000,zones:i.population.zones.map(z=>({...z,residents:2000}))}});
  assert.ok(a.demand.pairs.every(p=>p.outward.some(id=>a.graph.edges[id].accessOnly)));
  assert.ok(a.demand.total>0);assert.ok(Math.abs(b.demand.total/a.demand.total-2)<1e-8);
});
check("rail/airport attraction excludes platforms and nonpassenger hubs, uses valid annual counts and does not double an airport",()=>{
  const D=context.HuayuTrafficDemand;
  assert.equal(D.category({railway:"station"}),"transport");assert.equal(D.category({aeroway:"terminal"}),"transport");
  for(const p of [{railway:"platform"},{railway:"station",passenger:"no"},{railway:"station",station:"subway"},{aeroway:"aerodrome",aerodrome:"military"},{railway:"station",disused:"yes"}])assert.notEqual(D.category(p),"transport");
  assert.equal(D.hubWeight({aeroway:"aerodrome","passengers:annual":"36,500,000"}),100000);
  assert.ok(D.activity("transport",8)>D.activity("transport",2));
  const i=input(),poi=(id,x,tags,area)=>({type:"Feature",id,properties:tags,geometry:{type:"Point",coordinates:xy(x,10)},area});
  i.features=[poi("station",1500,{railway:"station",name:"客站"}),poi("station-duplicate",1510,{railway:"station",name:"客站"})];
  const station=simulation(i);assert.equal(station.demand.sites.filter(p=>p.kind==="transport").length,1);
  assert.equal(station.demand.sites.find(p=>p.kind==="transport").weight,5000);
  i.features=i.features.slice(0,1);Object.assign(i.features[0].properties,{osmType:"node",osmId:99});
  assert.equal(simulation(i,{nonPassengerStationIds:[99]}).demand.pairs.length,0);
  assert.equal(D.prepareSites(i.features,C.buildGraph(i.roads,{center,radius:5000}),{nonPassengerStationIds:[99]}).sites.length,0);
  const airport=poi("airport",0,{aeroway:"aerodrome",name:"机场"},poly(-2000,-200,2000,200)),terminal=poi("terminal",1500,{aeroway:"terminal",name:"航站楼"});
  i.features=[airport,terminal];const air=simulation(i);
  assert.equal(air.demand.sites.filter(p=>p.kind==="transport").reduce((n,p)=>n+p.weight,0),12000);
  assert.ok(air.demand.pairs.some(p=>p.destination.kind==="transport"));
});
function lotInput(){
  const i=input();i.selected=[{name:"甲市",geometry:poly(-2000,-500,2000,500)}];
  i.population={...i.population,total:1000,zones:[{id:"home",name:"小区",region:"甲市",residents:1000,coordinate:xy(-500,0)}]};
  i.roads=[road("main",[[1,-500,0],[2,0,0]]),road("lot-access",[[2,0,0],[3,60,0],[4,120,0]],{highway:"service"})];
  const area=poly(40,-30,140,30);area.coordinates.push(poly(80,10,100,25).coordinates[0]);
  i.features=[{type:"Feature",id:"work",properties:{shop:"convenience",name:"商店"},geometry:{type:"Point",coordinates:xy(120,0)}},
    {type:"Feature",id:"parking",properties:{amenity:"parking",capacity:"20",name:"测试停车场"},geometry:{type:"Point",coordinates:xy(90,0)},area}];
  return i;
}
check("parking keeps original geometry/holes and splits only existing connected road nodes",()=>{
  const i=lotInput(),area=i.features[1].area,ring=area.coordinates[0];
  const f=R.feature({type:"way",id:20,tags:{amenity:"parking"},nodes:[11,12,13,14,11],geometry:ring.map(p=>({lon:p[0],lat:p[1]}))});
  assert.deepEqual(plain(f.area),plain(poly(40,-30,140,30)));
  const relLot=R.feature({...rel(20,"停车场",8,area,{type:"multipolygon",amenity:"parking"}),tags:{type:"multipolygon",amenity:"parking"}});
  assert.equal(R.inside(xy(90,20),relLot.area),false);
  assert.equal(R.segmentInside(xy(60,20),xy(120,20),relLot.area),false);
  assert.equal(R.segmentInside(xy(60,0),xy(120,0),relLot.area),true);
  const s=simulation(i),lot=s.demand.parking[0];assert.equal(lot.renderable,true);assert.ok(lot.spots.length>0);
  assert.ok(s.graph.nodes.has("3"));assert.ok(i.roads.some(r=>r.properties.roadNodes.includes(Number(lot.node))));
  for(const spot of lot.spots)assert.equal(R.inside(project.lngLat(spot.point),area),true);
  const isolated=lotInput();isolated.roads[1].properties.roadNodes=[20,3,4];
  assert.equal(simulation(isolated).demand.pairs.length,0,"same coordinates without common node cannot invent an entrance");
  const underground=lotInput();underground.features[1].properties.parking="underground";
  assert.equal(simulation(underground).demand.parking[0].renderable,false);
});
check("display cars enter, remain visibly parked, exit and return on real roads without changing aggregate traffic",()=>{
  const i=lotInput(),s=simulation(i),control=simulation(i),lot=s.parking.get("parking");
  for(const c of s.cars)s.releaseSpot(c);s.cars=[];
  const c=s.create();c.returning=false;c.route=c.pair.outward;c.index=c.route.length-1;c.edge=c.route.at(-1);c.s=s.graph.edges[c.edge].line.length-0.1;
  s.cars=[c];lot.displayEntries=1;
  for(let j=0;j<150;j++){s.advance(.2);control.advance(.2);}
  assert.equal(c.phase,"dwell");assert.equal(s.snapshot().vehicles[0].parked,true);
  assert.equal(R.inside(s.snapshot().vehicles[0].coordinate,i.features[1].area),true);
  assert.deepEqual(plain(s.stock),plain(control.stock));assert.deepEqual(plain(s.backlog),plain(control.backlog));assert.equal(lot.occupied,control.parking.get("parking").occupied);
  c.departAt=s.time+.2;s.advance(.2);assert.equal(c.phase,"unparking");
  for(let j=0;j<75;j++)s.advance(.2);
  assert.equal(c.returning,true);assert.equal(c.phase,"edge");assert.equal(c.spot,null);assert.equal(lot.visual.size,0);
});
check("compact vehicle frames preserve phases and identities, send only changed metadata and bound directories",()=>{
  const P=context.HuayuTrafficProtocol,encoder=new P.Encoder(),decoder=new P.Decoder();encoder.reset([{name:"路"}]);
  const car={id:1,coordinate:center,angle:0.5,speed:7,queueSeconds:2,dwellRemaining:40,phase:"parking",returning:false,elevated:false,hiddenSample:false,waiting:false,parked:false,parking:true,road:"路",purpose:"购物",origin:"家",destination:"店",distance:100,parkingName:"车场"};
  const encode=v=>encoder.encode({vehicles:v.map(c=>({...c}))});
  let packet=encode([car]);assert.ok(packet.vehicleMeta);assert.ok(packet.roadLabels);assert.equal(packet.vehicles,undefined);
  assert.deepEqual(plain(decoder.decode(packet).vehicles[0]),plain(car));
  packet=encode([{...car,phase:"dwell",parked:true}]);assert.equal(packet.vehicleMeta,undefined);assert.equal(packet.roadLabels,undefined);assert.equal(decoder.decode(packet).vehicles[0].parked,true);
  for(let id=2;id<100;id++)decoder.decode(encode([{...car,id}]));
  assert.equal(encoder.known.size,1);assert.equal(decoder.known.size,1);
  decoder.decode(encode([]));assert.equal(decoder.known.size,0);
  assert.throws(()=>decoder.decode({vehicleFrames:new Float64Array(10)}),/格式/);
});
check("cross-city OD uses real reachable roads; no connection produces no fabricated cross-region traffic",()=>{
  const connected=simulation(input()),disconnected=simulation(input(false));
  assert.ok(connected.demand.pairs.some(p=>p.cross));assert.equal(disconnected.demand.pairs.some(p=>p.cross),false);
  const d=connected.demand.pairs[0];for(let i=1;i<d.outward.length;i++)assert.equal(connected.graph.edges[d.outward[i-1]].to,connected.graph.edges[d.outward[i]].from);
  connected.selected=connected.cars[0].id;const selected=connected.selectedRoute();assert.ok(selected.coordinates.length>=2);assert.ok(selected.origin.name&&selected.destination.name);
});
check("drawing budget and viewport sampling do not alter aggregate population, traffic or queue calculations",()=>{
  const a=simulation(input(),{count:60}),b=simulation(input(),{count:1200});
  b.setViewport([...xy(-1800,-300),...xy(-100,300)]);
  for(let i=0;i<100;i++){a.advance(.2);b.advance(.2);}
  assert.deepEqual(plain(a.stock),plain(b.stock));assert.deepEqual(plain(a.backlog),plain(b.backlog));assert.equal(a.demand.total,b.demand.total);
  assert.ok(a.snapshot().moving>60);assert.equal(a.snapshot().sampleCount,1800);
  const before=a.snapshot();a.paused=true;a.advance(100);assert.equal(a.snapshot().time,before.time);
});
check("marked parking capacity causes entry queues, conserves road/parking mass, and never invents free spaces",()=>{
  const s=simulation(input(true,true),{demandFactor:3}),initial=s.stock.reduce((n,v)=>n+v,0)+s.parking.get("parking").occupied;
  for(let i=0;i<5000;i++)s.advance(.2);
  const parked=s.parking.get("parking"),mass=s.stock.reduce((n,v)=>n+v,0)+s.backlog.reduce((n,v)=>n+v,0)+parked.occupied;
  assert.ok(parked.occupied>=0&&parked.occupied<=2+1e-7);assert.ok(s.snapshot().parking.waiting>0);assert.ok(s.snapshot().pending>0);
  const expected=initial+s.generated-s.returned;
  assert.ok(Math.abs(mass-expected)<1e-5,`${mass} vs ${expected}`);
  for(let i=0;i<s.stock.length;i++)assert.ok(s.stock[i]>=0&&s.stock[i]<=s.storage[i]+1e-7);
  assert.equal(s.demand.parking[0].estimated,false);
});
check("nearby travel dominates, administrative borders do not inflate distant trips, and remote-only demand is reduced",()=>{
  const i=input();i.roads=[road("near-link",[[1,0,0],[2,1000,0]]),road("regional-link",[[2,1000,0],[3,60000,0]]),road("remote-link",[[3,60000,0],[4,120000,0]])];
  const shape=poly(-100,-1000,130000,1000);
  i.population={...i.population,total:20000,zones:[{id:"home",name:"家",region:"甲市",residents:20000,coordinate:xy(0,0)}]};
  i.selected=[{name:"甲市",geometry:poly(-100,-1000,2000,1000)},{name:"乙市",geometry:poly(2000,-1000,130000,1000)}];
  const work=(id,x)=>({type:"Feature",id,properties:{office:"yes",capacity:"100"},geometry:{type:"Point",coordinates:xy(x,0)}});
  i.features=[work("near",1000),work("regional",60000),work("remote",120000)];
  const s=simulation(i),summary=s.demand.summary();assert.ok(summary.nearbyShare>0.97);assert.ok(summary.remoteShare>0&&summary.remoteShare<0.01);
  const far=simulation({...i,features:[work("remote",120000)]});assert.ok(far.demand.total<s.demand.total*0.01,"only distant facilities must not receive all normal local departures");
  const same=simulation({...i,selected:[{name:"甲市",geometry:shape}]});
  assert.equal(s.demand.total,same.demand.total);assert.deepEqual(plain(s.demand.pairs.map(p=>p.hourly)),plain(same.demand.pairs.map(p=>p.hourly)));
  assert.ok(U.distanceWeight(1000)>U.distanceWeight(25000));assert.ok(U.distanceWeight(25000)>U.distanceWeight(100000));
});
const payload=(elements,stamp)=>JSON.stringify({osm3s:{timestamp_osm_base:new Date(stamp).toISOString()},elements:[...elements,{type:"count",tags:{total:String(elements.length)}}]});
{
  const i=input(),g=poly(-2100,-600,2100,600),r=rel(1,"甲市",5,g,{population:"20000"}),s=[selection(r,g)],pending=[];
  let active=0,peak=0,started=0;
  const full=R.load(s,()=>{},async(_url,options)=>{
    const q=new URLSearchParams(options.body).get("data");active++;peak=Math.max(peak,active);started++;
    const index=q.includes('node(r.r:')?0:q.includes('way(area.a)[highway~')?1:2;
    const elements=index===0?[r]:index===1?i.roads.map((f,n)=>({type:"way",id:n+1,tags:f.properties,nodes:f.properties.roadNodes,geometry:f.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))})):[{type:"node",id:9,lon:xy(1500,0)[0],lat:xy(1500,0)[1],tags:{office:"yes"}}];
    return new Promise(resolve=>pending.push(()=>{active--;resolve(new Response(payload(elements,1000*(index+1))));}));
  });
  assert.equal(started,2);pending.shift()();await new Promise(setImmediate);assert.equal(started,3);assert.equal(peak,2);
  for(const resolve of pending.splice(0))resolve();
  const result=await full;assert.equal(result.population.total,20000);assert.equal(result.roads.length,2);assert.equal(result.features.length,1);
  assert.deepEqual(plain(result.sourceTimes),[1000,2000,3000]);
  cases++;console.log("passed: full-region requests overlap within two slots and retain complete input and source times");
}
{
  const s=input().selected.map(s=>({name:s.name,geojson:s.geometry})),roadFeature=road("near",[[1,-400,0],[2,400,0]]),raw={type:"way",id:1,tags:{highway:"primary"},nodes:[1,2],geometry:roadFeature.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))};
  const captured=[];
  const preview=await R.loadPreview(xy(-500,0),s,async(_url,o)=>{captured.push(new URLSearchParams(o.body).get("data"));return new Response(payload([raw],1000));});
  assert.equal(preview.roads.length,1);assert.equal(preview.radius,1500);assert.deepEqual(plain(preview.sourceTimes),[1000]);assert.ok(!captured[0].includes('area('));
  assert.equal(await R.loadPreview(xy(100000,0),s,()=>assert.fail("outside selected region must not fetch a neighbourhood")),null);
  await assert.rejects(()=>R.loadPreview(xy(-500,0),s,async()=>new Response(payload([{...raw,nodes:[1]}],1000))),/节点不完整/);
  cases++;console.log("passed: nearby preview queries a bounded neighbourhood, preserves topology, and never assigns city population");
}
{
  const messages=[],timers=new Map();let serial=0;
  const w=vm.createContext({console,onmessage:null,importScripts:()=>{},HuayuTrafficCore:C,
    HuayuTrafficRegions:{inside:R.inside,loadPreview:()=>assert.fail("valid loaded neighbourhood must not request new data")},
    postMessage:m=>messages.push(plain(m)),setInterval:fn=>{timers.set(++serial,fn);return serial;},clearInterval:id=>timers.delete(id)});
  vm.runInContext(await readFile(new URL("../site/traffic-worker.js",import.meta.url),"utf8"),w);
  const area=poly(-2000,-1000,2000,1000),nearRoad=road("near",[[1,-500,0],[2,500,0]]);
  const home={type:"Feature",id:"home",properties:{building:"apartments",population:"3000"},geometry:poly(-520,10,-480,40)};
  const work={type:"Feature",id:"work",properties:{office:"yes"},geometry:{type:"Point",coordinates:xy(500,20)}};
  await w.onmessage({data:{action:"build-preview",generation:3,regions:[{geojson:area}],context:{center,roads:[nearRoad],demand:[home,work],sourceTimes:[1234]},options:{count:60},paused:false}});
  assert.ok(messages.at(-1).preview);assert.ok(messages.at(-1).demand.pairs>0);assert.equal(messages.at(-1).regional,undefined);
  assert.equal(messages.at(-1).demand.taggedResidents,3000);assert.deepEqual(messages.at(-1).sourceTimes,[1234]);assert.equal(timers.size,1);
  await w.onmessage({data:{action:"pause",paused:true}});assert.equal(timers.size,0);
  cases++;console.log("passed: actual worker publishes loaded nearby trips without network access and pauses cleanly");
}
{
  const messages=[],timers=new Map();let serial=0;
  const w=vm.createContext({console,onmessage:null,importScripts:()=>{},HuayuTrafficCore:C,HuayuRegionalTraffic:U,
    HuayuTrafficProtocol:context.HuayuTrafficProtocol,postMessage:m=>messages.push(m),
    setInterval:fn=>{timers.set(++serial,fn);return serial;},clearInterval:id=>timers.delete(id)});
  vm.runInContext(await readFile(new URL("../site/traffic-worker.js",import.meta.url),"utf8"),w);
  await w.onmessage({data:{action:"build-region",generation:7,regionalInput:lotInput(),options:{count:60},paused:false}});
  const decoder=new context.HuayuTrafficProtocol.Decoder(),initial=decoder.decode(structuredClone(messages.at(-1)));
  assert.ok(initial.regional);assert.ok(initial.network);assert.ok(initial.demand.pairs>0);assert.ok(initial.vehicles.length>0);
  for(let j=0;j<4;j++)for(const fn of timers.values())fn();
  const sparse=messages.at(-1);assert.equal(sparse.demand,undefined);assert.equal(sparse.network,undefined);assert.equal(sparse.edges,undefined);assert.equal(sparse.parking,undefined);
  const next=decoder.decode(structuredClone(sparse));assert.equal(next.vehicles[0].purpose,initial.vehicles[0].purpose);assert.ok(next.time>initial.time);
  const selected=next.vehicles.find(v=>v.phase!=="dwell");
  await w.onmessage({data:{action:"select",id:selected.id}});assert.ok(messages.at(-1).route.coordinates.length>1);
  await w.onmessage({data:{action:"pause",paused:true}});assert.equal(timers.size,0);
  const time=messages.at(-1).time;await w.onmessage({data:{action:"count",count:1200}});assert.equal(messages.at(-1).time,time);
  cases++;console.log("passed: actual regional worker keeps metadata/route on sparse transferable frames, changes sample budget without time and pauses");
}
// Exercise the actual bounded response reader, including a misleading/partial count.
await assert.rejects(()=>R.request("fixture",async()=>new Response(JSON.stringify({elements:[{type:"count",tags:{total:"2"}},{type:"node",id:1}]}))),/计数不完整/);
cases++;console.log("passed: partial upstream results are rejected before takeover");
console.log(JSON.stringify({status:"passed",cases}));
