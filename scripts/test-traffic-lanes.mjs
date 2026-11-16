import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const ctx=vm.createContext({console});
const readWorker=await readFile(new URL('../site/traffic-worker.js',import.meta.url),'utf8');
const readSimulation=await readFile(new URL('../site/traffic-simulation.js',import.meta.url),'utf8');
for(const file of ["traffic-core.js","traffic-demand.js","traffic-protocol.js","traffic-surfaces.js","traffic-camera.js"])vm.runInContext(await readFile(new URL(`../site/${file}`,import.meta.url),"utf8"),ctx);
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
check("automatic structural diagrams work without cars or following, preserve direction and hide only accepted bridge roads",()=>{
  const roads=[road('bridge',[['a',-300,0],['b',300,0]],{highway:'primary',bridge:'yes'}),
    road('tunnel',[['c',-300,30],['d',300,30]],{tunnel:'yes',lanes:'5','lanes:forward':'3','lanes:backward':'2'}),
    road('other',[['e',-300,60],['f',300,60]],{layer:'2',highway:'trunk'})],bounds=[-.001,-.001,.001,.001];
  const geometry=C.laneGeometry(g(roads,{regional:true}),bounds),camera=ctx.HuayuTrafficCamera;
  assert.equal(geometry.features.length,0,'diagram metadata never creates underground or unsupported ground lines');
  assert.equal(geometry.deferred[0].roadId,'bridge');
  assert.deepEqual(plain(geometry.deferred.find(r=>r.roadId==='tunnel').directions),[-1,-1,1,1,1]);
  const left=C.laneGeometry(g(roads,{regional:true,drivingSide:'left'}),bounds);
  assert.deepEqual(plain(left.deferred.find(r=>r.roadId==='tunnel').directions),[1,1,1,-1,-1]);
  let view=camera.structureView(geometry.deferred,'tunnel',bounds,new Set(['bridge']));
  assert.equal(view.road.roadId,'tunnel');assert.equal(view.road.lanes,5);assert.equal(view.source,'标签');
  assert.deepEqual(plain(view.choices.map(r=>r.roadId)),['tunnel','other'],'one accepted bridge does not suppress an unrelated missing deck');
  view=camera.structureView(geometry.deferred,'gone',bounds,new Set(['bridge','other']));
  assert.equal(view.road.roadId,'tunnel','an old selection automatically falls back to a visible road');
  assert.equal(camera.structureView(geometry.deferred,'',[1,1,2,2],new Set()),null);
  const shared=C.laneGeometry(g([road('narrow',line,{tunnel:'yes',width:'4.4'})]),bounds);
  assert.deepEqual(plain(shared.deferred[0].directions),[0]);
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
check("coarse and split bridge spans preserve metre dash phase across views, deck slopes, direction and narrow widths",()=>{
  const S=ctx.HuayuTrafficSurfaces,graph=g([road('bridge',line,{highway:'primary',bridge:'yes'})]);
  const plan=(stations,reverse=false)=>({heights:stations.map(s=>5+s/200),surfaceWidths:stations.map(()=>10),samples:stations.map(s=>({
    coordinate:xy(reverse?100-s:s-100,0),roadId:'bridge',width:10,s,sourceSegment:0,fraction:reverse?1-s/200:s/200}))});
  const divider=mesh=>{
    const result=[];
    for(let i=0;i<mesh.positions.length;i+=18){
      // Divider #faf8ee differs from the slightly darker edge line; vertex colors are linear.
      if(Math.abs(mesh.colors[i]-.95597335)>.00001)continue;
      const q=Array.from(mesh.positions.slice(i,i+18)),xs=q.filter((_,k)=>k%3===0),ys=q.filter((_,k)=>k%3===1);
      if(ys.reduce((a,b)=>a+b,0)<0)continue;
      result.push([Math.min(...xs),Math.max(...xs)]);
    }return result;
  };
  for(const [stations,reverse,bounds] of [[[0,200],false,[-.002,-.001,.002,.001]],[[0,7,41,200],false,[-.002,-.001,.002,.001]],
    [[0,200],false,[-10/111320,-.001,11/111320,.001]],[[0,200],true,[-.002,-.001,.002,.001]]]){
    const mesh=S.geometry(graph,[plan(stations,reverse)],bounds),intervals=divider(mesh);assert.ok(intervals.length>8);
    assert.ok(intervals.every(([a,b])=>b-a<=3.001),"no whole long-span stripe in place of metric dashes");
    for(let x=-18.25;x<19;x+=.5){const s=reverse?100-x:x+100,painted=intervals.some(([lo,hi])=>x>lo&&x<hi);
      assert.equal(painted,s%6<3,`dash phase at x=${x}, reverse=${reverse}, stations=${stations}`);}
    for(let i=0;i<mesh.positions.length;i+=3){const x=mesh.positions[i],y=mesh.positions[i+1],z=mesh.positions[i+2];
      assert.ok(Math.abs(y)<=5.001,"inferred lanes remain inside the accepted narrow deck");
      assert.ok(Math.abs(z-(5+(reverse?100-x:x+100)/200+.07))<.0001,"every cut retains accepted sloping height");}
    assert.ok(mesh.surface.length>0);
    for(let i=0;i<mesh.surface.length;i+=3){const x=mesh.surface[i],y=mesh.surface[i+1],z=mesh.surface[i+2];
      assert.ok(Math.abs(y)<=4.801,"pavement never widens the accepted bridge");
      assert.ok(Math.abs(z-(5+(reverse?100-x:x+100)/200+.035))<.0001,"pavement stays on the same accepted deck slope");}
    assert.ok([...mesh.positions].every(Number.isFinite));
  }
  const long={heights:[5,5],surfaceWidths:[72,72],samples:[0,40000].map(s=>({coordinate:xy(s-20000,0),roadId:'bridge',width:72,s,sourceSegment:0,fraction:s/40000}))};
  const wide=g([road('bridge',[['a',-20000,0],['b',20000,0]],{lanes:'24',bridge:'yes'})],{regional:true});
  const mesh=S.geometry(wide,[long],[-1,-1,1,1]);
  assert.ok(mesh.limited);assert.ok(mesh.segments>0&&mesh.segments<=1200);
  assert.ok((mesh.positions.length+mesh.flow.length+mesh.surface.length)/3<=80000,"pavement and dashed marks count toward the existing vertex cap");
  assert.equal(mesh.positions.length,mesh.colors.length);
  const splitGraph=g([road('bridge',line,{bridge:'yes',highway:'primary'}),road('junction',[['j',0,0],['north',0,300]])]);
  const shifted=S.geometry(splitGraph,[plan([0,200])],[-.002,-.001,.002,.001],xy(500,400));
  const xs=Array.from(shifted.surface).filter((_,i)=>i%3===0),ys=Array.from(shifted.surface).filter((_,i)=>i%3===1);
  assert.ok(Math.abs(Math.min(...xs)+600)<.01&&Math.abs(Math.max(...xs)+400)<.01,"bridge vertices use the actual deck origin");
  assert.ok(Math.abs((Math.min(...ys)+Math.max(...ys))/2+400)<.01);
  assert.equal(new Set(shifted.groups.map(group=>group.ids.join(','))).size,2,"flow grouping stays in graph coordinates when the deck has a different origin");
});
check("continuous pitched rendering reuses car-centred bridge windows and invalidates only changed decks or workers",()=>{
  const messages=[],controller={visible:true,result:{accepted:[]}},car={id:1,coordinate:[0,0]},timers=new Map();let now=0,cleared=0,indexed=0,serial=0;
  const worker={postMessage:m=>messages.push(plain(m))};
  const c=vm.createContext({map:{getBounds:()=>({getWest:()=>-179,getEast:()=>179,getSouth:()=>-80,getNorth:()=>80}),getCenter:()=>({lng:20,lat:30})},
    worker,graphics:{},document:{hidden:false},performance:{now:()=>now},root:{HuayuBridgeModels:{get:()=>controller},HuayuTrafficCamera:ctx.HuayuTrafficCamera,HuayuTrafficSurfaces:{index:()=>{indexed++;return {};}}},
    bridgeRequest:0,bridgeResult:null,bridgeWorker:null,bridgeIndex:null,bridgeBounds:null,bridgeAt:0,bridgeTimer:0,following:true,latest:{vehicles:[car]},selected:1,generation:4,
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),
    clearBridgeGraphics:()=>cleared++,refreshBridgeNote(){}});
  vm.runInContext(readSimulation.match(/  function syncBridgeSurfaces\([^]*?\n  \}/u)[0],c);
  c.syncBridgeSurfaces();assert.equal(messages.length,1);assert.equal(indexed,1);
  assert.ok(messages[0].bounds.every(v=>Math.abs(v)<=.025001));
  for(let i=0;i<300;i++){now+=16;c.syncBridgeSurfaces();}assert.equal(messages.length,1,"hundreds of changing render frames do not resend the same bounded geometry");
  car.coordinate=[.01,0];now+=800;c.syncBridgeSurfaces();assert.equal(messages.length,2);
  near((messages[1].bounds[0]+messages[1].bounds[2])/2,.01);
  car.coordinate=[.02,0];now+=16;c.syncBridgeSurfaces();assert.equal(messages.length,2,"moving outside a buffer still respects the 750 ms gate");
  now+=800;c.syncBridgeSurfaces();assert.equal(messages.length,3);assert.equal(indexed,1);
  controller.result={accepted:[]};c.syncBridgeSurfaces();assert.equal(messages.length,4);assert.equal(indexed,2);
  c.worker={postMessage:m=>messages.push(plain(m))};c.syncBridgeSurfaces();assert.equal(messages.length,5,"a new graph cannot reuse old road-state IDs");
  car.coordinate=[.04,0];now+=16;c.syncBridgeSurfaces();assert.equal(messages.length,5);assert.equal(timers.size,1);
  now+=800;const delayed=timers.values().next().value;timers.clear();delayed();
  assert.equal(messages.length,6,"the paused camera finishes a deferred update without another render frame");assert.equal(timers.size,0);
  const request=c.bridgeRequest;controller.visible=false;c.syncBridgeSurfaces();assert.equal(c.bridgeIndex,null);assert.equal(c.bridgeBounds,null);
  assert.ok(c.bridgeRequest>request);assert.ok(cleared>=3,"hide or deck replacement removes unsafe stale heights");
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
  w.onmessage({data:{action:'bridge-surfaces',generation:4,request:9,bounds:[-.001,-.001,.001,.001],plans:[{heights:[8,9],surfaceWidths:[9,9],samples:[0,200].map(s=>({coordinate:xy(s-100,0),roadId:'wide',width:9,s,sourceSegment:0,fraction:s/200}))}]}});
  assert.equal(messages.at(-1).bridgeRequest,9);assert.ok(Object.keys(messages.at(-1).bridgeGeometry.surface).length>0);
  w.onmessage({data:{action:'pause',paused:true}});assert.equal(messages.at(-1).time,before);
});
console.log(JSON.stringify({status:'passed',cases}));
