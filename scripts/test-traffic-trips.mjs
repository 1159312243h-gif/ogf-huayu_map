import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const context=vm.createContext({console,Float64Array});
for(const name of ["traffic-core","traffic-demand","traffic-regions","traffic-regional-sites","traffic-regional-core","traffic-trip","traffic-camera","traffic-protocol"])
  vm.runInContext(await readFile(new URL(`../site/${name}.js`,import.meta.url),"utf8"),context);
const C=context.HuayuTrafficCore,T=context.HuayuTrafficTrips,U=context.HuayuRegionalTraffic,plain=v=>JSON.parse(JSON.stringify(v));
const center=[152,14],project=C.projection(center),xy=(x,y)=>project.lngLat([x,y]);
const road=(id,points,properties={})=>({id,type:"Feature",properties:{highway:"primary",roadNodes:points.map(p=>String(p[0])),...properties},
  geometry:{type:"LineString",coordinates:points.map(p=>xy(p[1],p[2]))}});
const roads=[road("west",[[1,-400,0],[2,0,0]]),road("east",[[2,0,0],[3,400,0]]),road("north",[[2,0,0],[4,0,400]])];
const graph=(rs=roads,options={})=>C.buildGraph(plain(rs),{center,...options});
const local=(rs=roads)=>new C.Simulation(graph(rs),{}),request={start:xy(-200,0),destination:xy(400,0)};
let cases=0;function check(name,fn){fn();cases++;console.log(`passed: ${name}`);}
check("a chosen point starts on the actual directed road, highlights its route and arrives then ends",()=>{
  const s=local(),result=T.start(s,request),car=s.cars[0];
  assert.ok(Math.hypot(...project.xy(result.coordinate).map((v,i)=>v-[-200,0][i]))<1);
  assert.equal(s.selected,result.id);assert.equal(car.s>100,true);assert.equal(s.snapshot().vehicles[0].manual,true);
  assert.ok(s.selectedRoute().coordinates[0][0]>xy(-210,0)[0],"route must not extend behind the chosen start");
  for(let i=1;i<car.route.length;i++)assert.ok(s.graph.edges[car.route[i-1]].next.includes(car.route[i]));
  for(let i=0;i<4000&&car.phase!=="dwell";i++)s.advance(.25);
  assert.equal(car.phase,"dwell");assert.equal(car.v,0);assert.equal(s.locks.size,0);
  assert.equal(s.arrived,0,"manual trips do not inflate predicted arrivals");
  for(let i=0;i<300;i++)s.advance(.25);assert.equal(s.cars.length,0,"manual cars never roam or take an invented return route");
});
check("one-way backwards trips and coordinate-only crossings stay unreachable",()=>{
  assert.throws(()=>T.start(local([road("one",[[1,-400,0],[3,400,0]],{oneway:"yes"})]),{start:xy(200,0),destination:xy(-400,0)}),/不可达/);
  const separate=[roads[0],road("other",[[5,0,0],[6,400,0]])];
  assert.throws(()=>T.start(local(separate),request),/不可达/);
});
check("invalid, unloaded and blocked origins preserve existing cars and demand",()=>{
  const s=local(),before=plain(s.demand.summary());
  for(const start of [[NaN,14],[152,95],xy(5000,0)])assert.throws(()=>T.start(s,{start,destination:request.destination}));
  assert.equal(s.cars.length,0);assert.deepEqual(plain(s.demand.summary()),before);
  T.start(s,request);const saved=plain(s.snapshot());assert.throws(()=>T.start(s,request),/已有/);assert.deepEqual(plain(s.snapshot()),saved);
  const b=local(),p=T.plan(b,request),e=b.graph.edges[p.route[0]];
  for(let lane=0;lane<e.lanes;lane++)b.cars.push({id:lane+1,edge:e.id,s:p.s,phase:"edge",lane});
  assert.throws(()=>T.start(b,request),/安全/);
});
check("an automatic destination is an existing reachable facility and never random roaming",()=>{
  const s=local();assert.throws(()=>T.start(s,{start:request.start}),/手动设置终点/);
  s.demand.sites=[{node:"3",name:"真实设施",kind:"errand",access:xy(400,0)},{node:"missing",name:"断路设施",kind:"work"}];
  assert.equal(T.start(s,{start:request.start}).destination,"真实设施");
});
check("regional manual samples preserve population, aggregate stocks, parking and viewport lifetime",()=>{
  const polygon={type:"Polygon",coordinates:[[xy(-600,-600),xy(600,-600),xy(600,600),xy(-600,600),xy(-600,-600)]]};
  const input={center,roads:plain(roads),features:[{id:"work",properties:{building:"office"},geometry:{type:"Point",coordinates:xy(400,0)}},
    {id:"parking",properties:{amenity:"parking",capacity:"20"},geometry:{type:"Point",coordinates:xy(400,20)}}],population:{total:10000,zones:[{id:"home",name:"住宅区",region:"测试市",residents:10000,coordinate:xy(-400,0)}],rows:[],conflicts:[],missing:0},
    selected:[{name:"测试市",geometry:polygon}],bounds:[...xy(-600,-600),...xy(600,600)],sourceTimes:[1000]};
  const s=new U.RegionalSimulation(U.buildGraph(input),{regionalInput:input}),baseline=new U.RegionalSimulation(U.buildGraph(input),{regionalInput:input});
  const before=plain(s.demand.summary());assert.ok(s.stock.some(v=>v>0));s.cars=[];baseline.cars=[];
  T.start(s,{...request,start:xy(0,200)});const id=s.cars.find(c=>c.manual).id;
  assert.deepEqual(plain(s.demand.summary()),before);
  s.setViewport([...xy(-300,-100),...xy(300,100)]);assert.ok(s.cars.some(c=>c.id===id));
  // Isolate the manual vehicle's lifecycle; aggregate traffic continues independently.
  s.cars=s.cars.filter(c=>c.manual);
  for(let i=0;i<6000;i++){s.advance(.2);baseline.advance(.2);}
  assert.deepEqual(plain(s.demand.summary()),plain(baseline.demand.summary()));assert.deepEqual([...s.stock],[...baseline.stock]);assert.deepEqual([...s.backlog],[...baseline.backlog]);
  assert.equal(s.arrived,baseline.arrived);assert.equal(s.returned,baseline.returned);assert.equal(s.cars.some(c=>c.manual),false);
  assert.deepEqual([...s.parking.values()].map(p=>p.occupied),[...baseline.parking.values()].map(p=>p.occupied));
});
check("camera modes preserve position, use north in 2D and turn through the shortest heading in 3D",()=>{
  const camera=context.HuayuTrafficCamera,car={coordinate:center,angle:Math.PI};
  assert.deepEqual(plain(camera.target(car,"2d",123)),{center,pitch:0,bearing:0});
  const target=camera.target(car,"3d",270);assert.equal(target.pitch,55);assert.equal(target.bearing,270);
  assert.equal(camera.target({coordinate:center,angle:0},"3d",0).bearing,90);
  assert.ok(Math.abs(camera.target({coordinate:center,angle:-Math.PI/2+.01},"3d",-179).bearing+179)<3);
});
check("moving follow windows retain neighbouring cars, include crossing roads and leave congestion stocks unchanged",()=>{
  const rs=[road("long",[[1,-1500,0],[2,1500,0]])],polygon={type:"Polygon",coordinates:[[xy(-1700,-600),xy(1700,-600),xy(1700,600),xy(-1700,600),xy(-1700,-600)]]};
  const input={center,roads:rs,features:[{id:"work",properties:{building:"office"},geometry:{type:"Point",coordinates:xy(1500,0)}}],
    population:{total:10000,zones:[{id:"home",name:"住宅",region:"测试市",residents:10000,coordinate:xy(-1500,0)}],rows:[],conflicts:[],missing:0},
    selected:[{name:"测试市",geometry:polygon}],bounds:[...xy(-1700,-600),...xy(1700,600)],sourceTimes:[1000]};
  const s=new U.RegionalSimulation(U.buildGraph(input),{regionalInput:input});s.cars=[];
  T.start(s,{start:xy(0,0),destination:xy(1500,0)});const car=s.cars[0],stock=[...s.stock],backlog=[...s.backlog],demand=plain(s.demand.summary());
  s.setViewport([...xy(-120,-60),...xy(120,60)]);
  const near=s.cars.filter(c=>c.focus);assert.ok(near.length>0,"a long road crossing the screen needs no vertex inside it");
  assert.ok(near.length<=s.graph.edges.reduce((n,e)=>n+Math.ceil(s.stock[e.id]*240/e.line.length),0),"new focus samples respect existing road occupancy, rather than filling the screen budget");
  for(const c of near){const e=s.graph.edges[c.edge],p=C.sample(e.line,e.start+c.s/e.line.length*e.length);assert.ok(Math.abs(p.x)<120.001);}
  for(const c of near.filter(c=>c.edge===car.edge&&c.lane===car.lane))assert.ok(Math.abs(c.s-car.s)>=8*s.graph.edges[car.edge].line.length/s.graph.edges[car.edge].length);
  const ids=new Set(near.map(c=>c.id));s.setViewport([...xy(-100,-60),...xy(140,60)]);
  assert.ok(s.cars.filter(c=>ids.has(c.id)).length>near.length/2,"overlapping focus cars keep their IDs and journeys");
  s.setViewport([...xy(400,-60),...xy(600,60)]);
  assert.ok(s.cars.some(c=>c.focus&&project.xy(s.snapshot().vehicles.find(v=>v.id===c.id).coordinate)[0]>400));
  assert.ok(s.cars.some(c=>c.id===car.id));assert.ok(s.cars.filter(c=>c.focus).length<=1200);
  assert.deepEqual([...s.stock],stock);assert.deepEqual([...s.backlog],backlog);assert.deepEqual(plain(s.demand.summary()),demand);
  s.cars=[car];s.roadSamples.set(car.edge,{id:car.edge,count:40,ratio:.02,waiting:32});
  for(let i=0;i<3;i++)s.advance(.2);
  assert.ok(car.v<.5,"selected observation car slows with the same congested road state");assert.equal(s.snapshot().vehicles[0].waiting,true);
  assert.equal(s.selectedGuidance().traffic.waiting,32);assert.equal(s.selectedGuidance().traffic.ratio,.02);
});
check("selected lane guidance retains explicit and estimated bridge/tunnel counts through real trips",()=>{
  const rs=[road("start",[[1,-600,0],[2,-300,0]],{name:"地面道路"}),
    road("bridge",[[2,-300,0],[3,0,0]],{bridge:"yes",layer:1,lanes:"8",name:"八车道桥"}),
    road("tunnel",[[3,0,0],[4,300,0]],{tunnel:"yes",layer:-1,oneway:"yes",lanes:"3",name:"三车道隧道"}),
    road("end",[[4,300,0],[5,600,0]],{name:"出口"})];
  const s=local(rs);T.start(s,{start:xy(-500,0),destination:xy(600,0)});const seen=new Map();
  for(let i=0;i<6000&&s.cars[0]?.phase!=="dwell";i++){s.advance(.05);const g=s.selectedGuidance();if(g?.phase==="edge")seen.set(g.road,plain(g));}
  const b=seen.get("八车道桥"),t=seen.get("三车道隧道");assert.ok(b&&t);
  assert.equal(b.bridge,true);assert.equal(b.totalLanes,8);assert.equal(b.lanes,4);assert.equal(b.oppositeLanes,4);assert.equal(b.laneSource,"tag");
  assert.equal(t.tunnel,true);assert.equal(t.totalLanes,3);assert.equal(t.lanes,3);assert.equal(t.oppositeLanes,0);
  const car={id:t.id,lane:1,lanes:3},v=context.HuayuTrafficCamera.laneView(car,t);assert.equal(v.structure,"隧道");assert.equal(v.total,3);assert.match(v.note,/标签/);
  const ground=seen.get("地面道路");assert.equal(ground.totalLanes,6);assert.equal(ground.laneSource,"class");
  assert.equal(context.HuayuTrafficCamera.laneView(car,{...t,id:t.id+1}).structure,"地面道路","stale vehicle guidance cannot describe a new selection");
});
check("near-follow windows remain bounded and shared narrow roads never pretend to have two lanes",()=>{
  const cam=context.HuayuTrafficCamera,w=cam.laneWindow([-179,-80,179,80],center);
  assert.ok(w[2]-w[0]<=.050001);assert.ok(w[3]-w[1]<=.050001);assert.ok(w[0]<center[0]&&w[2]>center[0]);
  const view=cam.laneView({id:1,lane:1,lanes:1},{id:1,totalLanes:1,lanes:1,shared:true,lane:1,laneSource:"width"});
  assert.equal(view.n,1);assert.equal(view.total,1);assert.match(view.summary,/共享 1/);assert.match(view.note,/路宽估算/);
  for(const drivingSide of ["right","left"]){
    const s=new C.Simulation(graph(roads,{drivingSide}),{});T.start(s,request);
    const g=s.selectedGuidance(),v=cam.laneView({id:g.id},g);
    assert.equal(v.reverse,drivingSide==="left","lane schematic mirrors the actual driving-side lane offsets");
  }
});
check("tunnel diagram uses only nearby actual same-road forward samples and mirrors left-side driving",()=>{
  const cam=context.HuayuTrafficCamera,car={id:1,roadId:'t',tunnel:true,phase:'edge',coordinate:xy(0,0),angle:0,lane:2,lanes:3};
  const vehicle=(id,x,p={})=>({...car,id,coordinate:xy(x,0),lane:1,...p});
  const vehicles=[car,vehicle(2,30),vehicle(3,-10),vehicle(4,91),vehicle(5,-26),vehicle(6,20,{angle:Math.PI}),
    vehicle(7,20,{roadId:'other'}),vehicle(8,20,{tunnel:false}),vehicle(9,20,{hiddenSample:true}),vehicle(10,20,{phase:'dwell'})];
  let scene=cam.tunnelView(car,{id:1,tunnel:true,lanes:3,lane:2},vehicles);
  assert.deepEqual(plain(scene.nearby.map(v=>v.id)),[3,2]);assert.equal(scene.selected.id,1);
  assert.ok(scene.nearby.find(v=>v.id===2).y<scene.selected.y);assert.ok(scene.nearby.find(v=>v.id===3).y>scene.selected.y);
  const right=cam.tunnelView(car,{id:1,tunnel:true,lanes:3,lane:1},vehicles),left=cam.tunnelView(car,{id:1,tunnel:true,lanes:3,lane:1,reverseLanes:true},vehicles);
  assert.ok(right.selected.x<left.selected.x);assert.equal(right.selected.x+left.selected.x,320);
  assert.equal(cam.tunnelView({...car,tunnel:false},{id:2,tunnel:true},vehicles),null,"stale guidance cannot turn a ground road into a tunnel");
  scene=cam.tunnelView(car,null,Array.from({length:30},(_,i)=>vehicle(i+2,i)));
  assert.equal(scene.nearby.length,16,"the independent inset has a bounded reusable vehicle pool");
});
const timers=new Map(),messages=[];let serial=0;
const w=vm.createContext({console,onmessage:null,importScripts:()=>{},HuayuTrafficCore:C,HuayuTrafficTrips:T,
  postMessage:m=>messages.push(plain(m)),setInterval:fn=>{timers.set(++serial,fn);return serial;},clearInterval:id=>timers.delete(id)});
vm.runInContext(await readFile(new URL("../site/traffic-worker.js",import.meta.url),"utf8"),w);
await w.onmessage({data:{action:"build",generation:4,features:roads,options:{center}}});
await w.onmessage({data:{action:"start-trip",generation:3,request:1,...request}});assert.equal(messages.some(m=>m.tripResult),false);
await w.onmessage({data:{action:"start-trip",generation:4,request:2,...request}});assert.ok(messages.at(-1).tripResult.id);assert.equal(timers.size,1);
await w.onmessage({data:{action:"start-trip",generation:4,request:3,start:[NaN,0]}});assert.ok(messages.at(-1).tripError);assert.equal(timers.size,1);assert.equal(messages.some(m=>m.error),false);
await w.onmessage({data:{action:"end-trip",generation:4,request:4}});assert.equal(messages.at(-1).tripResult.ended,true);assert.equal(timers.size,0);
cases++;console.log("passed: worker rejects stale starts and reports bad routes without stopping a running simulation");
console.log(JSON.stringify({status:"passed",cases}));
