import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const ctx=vm.createContext({console});
const readWorker=await readFile(new URL('../site/traffic-worker.js',import.meta.url),'utf8');
for(const file of ["traffic-core.js","traffic-demand.js","traffic-protocol.js","traffic-surfaces.js"])vm.runInContext(await readFile(new URL(`../site/${file}`,import.meta.url),"utf8"),ctx);
const C=ctx.HuayuTrafficCore,plain=v=>JSON.parse(JSON.stringify(v));
const xy=(x,y)=>[x/111320,y/111320];
const road=(id,nodes,tags={})=>({type:"Feature",id,properties:{highway:"residential",roadNodes:nodes.map(n=>n[0]),...tags},geometry:{type:"LineString",coordinates:nodes.map(n=>xy(n[1],n[2]))}});
const line=[['a',-300,0],['j',0,0],['b',300,0]],g=(features,options={})=>C.buildGraph(features,{center:[0,0],...options});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
let cases=0;function check(name,fn){fn();cases++;console.log(`passed: ${name}`);}
check("explicit totals/directions, shared turn lane and reverse single direction retain their physical lane allocation",()=>{
  let graph=g([road('odd',line,{lanes:'3','lanes:forward':'1','lanes:backward':'2',width:'9'})]);
  assert.deepEqual(plain(graph.edges.map(e=>e.lanes)),[1,2]);
  assert.deepEqual(plain(graph.edges[0].laneOffsets),[3]);assert.deepEqual(plain(graph.edges[1].laneOffsets),[0,3]);
  let s=C.laneSpec({highway:'primary',lanes:'5','lanes:forward':'2','lanes:backward':'2','lanes:both_ways':'1'},true);
  assert.equal(s.middle,1);assert.equal(s.total,5);assert.ok(s.forwardOffsets[0]>s.laneWidth/2);
  s=C.laneSpec({highway:'secondary',lanes:'3','lanes:forward':'1','lanes:backward':'1'},true);assert.equal(s.middle,1);
  graph=g([road('reverse',line,{oneway:'-1',lanes:'3'})]);assert.equal(graph.edges.length,1);assert.equal(graph.edges[0].from,'b');assert.equal(graph.edges[0].lanes,3);
  assert.deepEqual(plain(graph.edges[0].laneOffsets),[-3,0,3]);
  assert.equal(g([road('reverse',line,{oneway:'-1','lanes:forward':'1','lanes:backward':'3'})]).edges[0].lanes,3);
  assert.equal(g([road('forward',line,{oneway:'yes','lanes:forward':'2','lanes:backward':'3'})]).edges[0].lanes,2);
});
check("missing tags use valid width then stable class defaults; narrow shared roads have no invented divider",()=>{
  for(const [highway,total,directional] of [['primary',6,3],['trunk',8,4]]){
    const graph=g([road(highway,line,{highway})]),spec=graph.edges[0].laneSpec;
    assert.equal(spec.total,total);assert.equal(spec.source,'class');
    assert.deepEqual(plain(graph.edges.map(e=>e.lanes)),[directional,directional]);
    const view=C.laneGeometry(graph,[-.005,-.005,.005,.005]);
    assert.equal(view.roads,1);assert.equal(view.features.filter(f=>f.properties.kind==='divider').length,total-2);
    const divided=g([road('forward',line,{highway,oneway:'yes'}),road('reverse',[['c',-300,25],['d',300,25]],{highway,oneway:'-1'})]);
    assert.deepEqual(plain(divided.edges.map(e=>e.lanes)),[directional,directional]);
    assert.equal(C.laneSpec({highway,width:'12 m'},true).total,4);
    assert.equal(C.laneSpec({highway,lanes:'2',width:'24 m'},true).total,2);
    assert.equal(C.laneSpec({highway,'lanes:forward':'2','lanes:backward':'1',width:'24 m'},true).total,3);
  }
  assert.equal(C.laneSpec({highway:'motorway'},false).total,3);
  assert.equal(C.laneSpec({highway:'residential'},true).total,2);
  assert.equal(C.laneSpec({highway:'secondary',width:'12 m'},true).source,'width');
  assert.equal(C.laneSpec({highway:'secondary',width:'12 m'},true).total,4);
  assert.equal(C.laneSpec({highway:'secondary',width:'40 feet'},true).total,4);
  for(const width of ['abc','-10','0','500'])assert.equal(C.laneSpec({highway:'residential',width},true).source,'class');
  for(const lanes of ['no','2;3','3.5','-2','1000'])assert.equal(C.laneSpec({highway:'residential',lanes},true).source,'class');
  const view=C.laneGeometry(g([road('narrow',line,{width:'4.4'})]),[-.005,-.005,.005,.005]);
  assert.equal(view.roads,1);assert.ok(!view.features.some(f=>['divider','center'].includes(f.properties.kind)));
});
check("left/right driving mirrors every lane and lane paths remain continuous through a bend and junction lane reduction",()=>{
  const r=road('bend',[['a',-300,0],['j',0,0],['b',200,100]],{lanes:'4'}),right=g([r]),left=g([r],{drivingSide:'left'});
  for(let i=0;i<right.edges.length;i++)for(let lane=0;lane<2;lane++)near(C.laneOffset(right.edges[i],lane),-C.laneOffset(left.edges[i],lane));
  const e=right.edges[0],s=e.line.cumulative[1],a=C.sample(e.line,s-1e-7,C.laneOffset(e,1)),b=C.sample(e.line,s+1e-7,C.laneOffset(e,1));
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-5);
  const out=g([road('n',[['j',0,0],['n',0,300]],{oneway:'yes',lanes:'1'})]).edges[0];
  const target=C.nextLane(e,out,1);assert.equal(target,0);
  const turn=C.turnPath(e,out,1,target),start=C.sample(e.line,e.end,C.laneOffset(e,1)),end=C.sample(out.line,out.start,C.laneOffset(out,target));
  near(turn.points[0][0],start.x);near(turn.points[0][1],start.y);near(turn.points.at(-1)[0],end.x);near(turn.points.at(-1)[1],end.y);
});
check("cars share a road at the same distance in different lanes but preserve safety gaps within each lane",()=>{
  const graph=g([road('wide',line,{lanes:'4'})]),s=new C.Simulation(graph),e=graph.edges[0];
  s.cars=[{id:1,edge:e.id,lane:0,s:100,v:0,phase:'edge',next:null,wait:null,age:0,queueSeconds:0},
    {id:2,edge:e.id,lane:1,s:100,v:0,phase:'edge',next:null,wait:null,age:0,queueSeconds:0}];
  assert.equal(s.available(e.id,100,undefined,0),false);assert.equal(s.available(e.id,120,undefined,1),true);
  for(let i=0;i<20;i++)s.step();
  near(s.cars[0].s,s.cars[1].s);assert.ok(s.cars.every(c=>c.s>100));
  const snap=s.snapshot().vehicles;near(Math.hypot((snap[0].coordinate[0]-snap[1].coordinate[0])*111320,(snap[0].coordinate[1]-snap[1].coordinate[1])*111320),3);
  s.cars.push({id:3,edge:e.id,lane:0,s:s.cars[0].s-C.GAP,v:10,phase:'edge',next:null,wait:null,age:0,queueSeconds:0});
  for(let i=0;i<100;i++){s.step();assert.ok(s.cars[0].s-s.cars[2].s>=C.GAP-1e-6);}
  s.locks.set('junction',{car:99,out:e.id,lane:1});assert.equal(s.available(e.id,0,undefined,1),false);assert.equal(s.available(e.id,0,undefined,0),true);
});
check("lane geometry uses the same metre offsets, clips long roads to the view, deduplicates directions and skips unsupported elevations",()=>{
  const raw=[road('wide',line,{lanes:'4',width:'12'}),road('bridge',[['c',-300,20],['d',300,20]],{layer:'1'})],copy=plain(raw);
  const graph=g(raw,{regional:true}),bounds=[-.001,-.001,.001,.001],view=C.laneGeometry(graph,bounds);
  assert.equal(view.roads,1);assert.equal(view.estimated,0);
  assert.equal(view.deferredElevated,1,"bridge lane allocation is retained until a legal deck height is accepted");
  assert.equal(view.deferredTunnel,0);
  assert.equal(C.laneGeometry(graph,[1,1,2,2]).deferred.length,0,"out-of-view bridge metadata must not cross the Worker boundary");
  assert.equal(C.laneGeometry(g(Array.from({length:1201},(_,i)=>road(`bridge-${i}`,[[`a${i}`,-100,20],[`b${i}`,100,20]],{layer:'1',highway:'primary'})),{regional:true}),bounds).deferred.length,1200,"bridge metadata respects the near-view segment budget");
  const tunnelView=C.laneGeometry(g([road('tunnel',line,{tunnel:'yes',lanes:'4'})],{regional:true}),bounds);
  assert.equal(tunnelView.roads,0);assert.equal(tunnelView.deferredTunnel,1,"underground lanes remain data-only until an underground surface exists");
  assert.equal(tunnelView.deferred[0].lanes,4,"deferred lane metadata reports the physical total, rather than one direction");
  assert.equal(view.features.filter(f=>f.properties.kind==='divider').length,2);
  assert.equal(view.features.filter(f=>f.properties.kind==='center').length,1);
  for(const f of view.features)for(const part of f.geometry.coordinates)for(const [x,y] of part){assert.ok(x>=bounds[0]-1e-10&&x<=bounds[2]+1e-10&&y>=bounds[1]-1e-10&&y<=bounds[3]+1e-10);}
  const stripes=view.features.filter(f=>f.properties.kind==='divider');
  near(Math.abs(stripes[0].geometry.coordinates[0][0][1])*111320,3);
  assert.equal(C.laneGeometry(graph,[1,1,2,2]).roads,0);assert.deepEqual(raw,copy);
  assert.ok(view.vertices<80000);
});
check("lane changes across road segments survive compact frames without resending unchanged descriptions",()=>{
  const encoder=new ctx.HuayuTrafficProtocol.Encoder(),decoder=new ctx.HuayuTrafficProtocol.Decoder();encoder.reset([{name:'路'}]);
  const v={id:1,coordinate:[0,0],angle:0,speed:10,queueSeconds:0,dwellRemaining:0,phase:'edge',road:'路',purpose:'通勤',origin:'家',destination:'单位',distance:300,lane:2,lanes:3,laneSource:'tag'};
  let packet=encoder.encode({vehicles:[v]});let car=decoder.decode(packet).vehicles[0];assert.equal(car.lane,2);assert.equal(car.lanes,3);assert.equal(car.laneSource,'tag');
  packet=encoder.encode({vehicles:[{...v,lane:1,lanes:1,laneSource:'width'}]});assert.equal(packet.vehicleMeta,undefined);
  car=decoder.decode(packet).vehicles[0];assert.equal(car.lane,1);assert.equal(car.lanes,1);assert.equal(car.laneSource,'width');
});
check("bridge surfaces follow accepted absolute deck heights and original road IDs, with safe tunnel and missing-height fallbacks",()=>{
  const S=ctx.HuayuTrafficSurfaces,plan=(id,height)=>({heights:[height,height+1],surfaceWidths:[10,10],samples:[
    {coordinate:xy(-100,0),roadId:id,width:10,s:0,sourceSegment:0,fraction:0},
    {coordinate:xy(100,0),roadId:id,width:10,s:200,sourceSegment:0,fraction:1}]});
  const plans=[plan('low',5),plan('high',15)],surface=S.index(plans),c={roadId:'low',elevated:true,phase:'edge',roadWidth:10};
  near(S.vehicle(surface,c,xy(0,0),40).height,5.5);
  near(S.vehicle(surface,{...c,roadId:'high'},xy(0,0),0).height,15.5);
  assert.equal(S.vehicle(surface,{...c,roadId:'missing'},xy(0,0),0),null);
  assert.equal(S.vehicle(surface,{...c,tunnel:true},xy(0,0),0),null);
  assert.equal(S.vehicle(null,c,xy(0,0),0),null);
  assert.equal(S.vehicle(null,{...c,elevated:false},xy(0,0),null),null);
  near(S.vehicle(surface,{...c,phase:'turn',nextRoadId:'high',nextElevated:true,turnProgress:.5},xy(0,0),0).height,10.5);
  const graph=g([road('low',line,{highway:'primary',bridge:'yes',layer:'1'})]),mesh=S.geometry(graph,[plans[0]],[-.001,-.001,.001,.001]);
  assert.ok(mesh.positions.length>0&&mesh.flow.length>0);assert.ok([...mesh.positions].every(Number.isFinite));assert.ok(mesh.segments>0);
  assert.ok(mesh.groups.every(group=>group.ids.length===2));assert.ok([...mesh.flow].filter((_,i)=>i%3===2).every(z=>z>5));
  assert.equal(S.geometry(graph,[plans[0]],[1,1,2,2]).flow.length,0);
  const encoder=new ctx.HuayuTrafficProtocol.Encoder(),decoder=new ctx.HuayuTrafficProtocol.Decoder();encoder.reset([
    {name:'桥',roadId:'low',laneSpec:{width:10}},{name:'桥',roadId:'high',laneSpec:{width:20}}]);
  const v={...c,id:1,coordinate:xy(0,0),angle:0,speed:10,queueSeconds:0,dwellRemaining:0,road:'桥',purpose:'通勤',phase:'turn',nextRoadId:'high',nextElevated:true,turnProgress:.4};
  let packet=encoder.encode({vehicles:[v]}),decoded=decoder.decode(packet).vehicles[0];
  assert.equal(decoded.roadId,'low');assert.equal(decoded.nextRoadId,'high');near(decoded.turnProgress,.4);assert.equal(decoded.roadWidth,10);
  packet=encoder.encode({vehicles:[{...v,roadId:'high',nextTunnel:true}]});assert.equal(packet.vehicleMeta,undefined);assert.equal(packet.roadSurfaces,undefined);
  decoded=decoder.decode(packet).vehicles[0];assert.equal(decoded.roadId,'high');assert.equal(decoded.nextTunnel,true);assert.equal(decoded.roadWidth,20);
});
check("the actual worker prepares bounded lanes while paused without downloading data or advancing traffic",()=>{
  const messages=[],w=vm.createContext({console,onmessage:null,importScripts:()=>{},HuayuTrafficCore:C,HuayuTrafficSurfaces:ctx.HuayuTrafficSurfaces,postMessage:m=>messages.push(plain(m)),
    setInterval:()=>assert.fail('no OD must not start a timer'),clearInterval:()=>{}});
  vm.runInContext(readWorker,w);
  w.onmessage({data:{action:'build',generation:4,features:[road('wide',line,{lanes:'4'})],options:{center:[0,0]},paused:true}});
  const before=messages.at(-1).time;
  w.onmessage({data:{action:'lanes',generation:4,request:7,bounds:[-.001,-.001,.001,.001]}});
  assert.equal(messages.at(-1).laneRequest,7);assert.equal(messages.at(-1).generation,4);assert.equal(messages.at(-1).laneGeometry.roads,1);
  assert.equal(messages.at(-1).vehicles,undefined);
  const count=messages.length;w.onmessage({data:{action:'lanes',generation:3,request:8,bounds:[-.001,-.001,.001,.001]}});assert.equal(messages.length,count);
  w.onmessage({data:{action:'pause',paused:true}});assert.equal(messages.at(-1).time,before);
});
console.log(JSON.stringify({status:'passed',cases}));
