import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source=await readFile(new URL("../site/traffic-core.js",import.meta.url),"utf8");
const readWorker=await readFile(new URL("../site/traffic-worker.js",import.meta.url),"utf8");
const context=vm.createContext({console});vm.runInContext(source,context);
vm.runInContext(await readFile(new URL("../site/traffic-demand.js",import.meta.url),"utf8"),context);
const {buildGraph,Simulation,GAP}=context.HuayuTrafficCore;
const plain=v=>JSON.parse(JSON.stringify(v));
const center=[152.95,14.64], sx=111320*Math.cos(center[1]*Math.PI/180);
const road=(id,points,properties={})=>({id,type:"Feature",properties:{highway:"residential",roadNodes:points.map(p=>p[0]),...properties},
  geometry:{type:"LineString",coordinates:points.map(p=>[center[0]+p[1]/sx,center[1]+p[2]/111320])}});
const graph=(roads,options={})=>buildGraph(plain(roads),{center,...options});
const xy=(x,y)=>[center[0]+x/sx,center[1]+y/111320];
const site=(id,x,y,properties,area=true)=>({type:'Feature',id,properties:{osmId:id,osmType:area?'way':'node',...properties},
  geometry:area?{type:'Polygon',coordinates:[[xy(x-12,y-12),xy(x+12,y-12),xy(x+12,y+12),xy(x-12,y+12),xy(x-12,y-12)]]}:{type:'Point',coordinates:xy(x,y)}});
const demandFeatures=[site('home-w',-300,25,{building:'apartments',population:'3000',name:'西住宅'}),site('home-s',25,-300,{building:'apartments',population:'3000'}),
  site('work-e',300,25,{building:'office',name:'工作区'}),site('shop-n',25,300,{shop:'supermarket',name:'商店'},false),site('school-n',-25,300,{amenity:'school'},false)];
const options={count:240,demandFeatures,demandFactor:3,startHour:8};
let cases=0;
function check(name,fn){fn();cases++;console.log(`passed: ${name}`);}

check("single direction, reverse, roundabout, explicit car permissions and motor road filtering",()=>{
  const base=[['a',-100,0],['b',100,0]];
  assert.equal(graph([road('a',base)]).edges.length,2);
  const forward=graph([road('a',base,{oneway:'yes',maxspeed:'30 mph'})]);
  assert.equal(forward.edges.length,1);assert.equal(forward.edges[0].from,'a');
  assert.ok(Math.abs(forward.edges[0].speed-13.4112)<0.001);
  assert.equal(graph([road('a',base,{oneway:'-1'})]).edges[0].from,'b');
  assert.equal(graph([road('a',base,{junction:'roundabout'})]).edges.length,1);
  assert.equal(graph([road('a',base,{junction:'roundabout',oneway:'no'})]).edges.length,2);
  for(const p of [{highway:'footway'},{highway:'construction'},{access:'private'},{motorcar:'no'}])assert.equal(graph([road('a',base,p)]).edges.length,0);
  for(const p of [{bridge:1},{bridge:'yes'},{tunnel:1},{tunnel:'yes'},{layer:1},{layer:-1}]){
    const g=graph([road('a',base,p)]);assert.equal(g.edges.length,2);assert.ok(g.edges.every(e=>e.elevated));
  }
  assert.ok(graph([road('a',base,{bridge:'no',tunnel:'no',layer:'0'})]).edges.every(e=>!e.elevated));
  assert.equal(graph([road('a',base,{access:'no',motorcar:'yes'})]).edges.length,2);
});
const cross=[road('ew',[['w',-300,0],['j',0,0],['e',300,0]]),road('ns',[['s',0,-300],['j',0,0],['n',0,300]])];
check("real nodes define junctions; coincident and overpassing roads never acquire fake connections",()=>{
  const g=graph(cross);assert.equal(g.edges.length,8);
  assert.equal(g.edges.find(e=>e.from==='w').next.length,3);
  const unconnected=graph([cross[0],road('other',[['s',0,-300],['other-j',0,0],['n',0,300]])]);
  assert.equal(unconnected.edges.length,4);
  assert.equal(unconnected.edges.find(e=>e.from==='w').next.length,0);
  const over=graph([cross[0],road('over',cross[1].properties.roadNodes.map((id,i)=>[id,0,(i-1)*300]),{layer:1})]);
  assert.equal(over.edges.length,4);assert.equal(over.edges.find(e=>e.from==='w').next.length,0);
  assert.equal(over.edges.find(e=>e.from==='s').next.length,0);
  const ramp=graph([road('ground',[['a',-250,0],['r',-150,0]]),road('bridge',[['r',-150,0],['b',150,0]],{bridge:'yes',layer:'1'}),road('exit',[['b',150,0],['c',250,0]])]);
  const entry=ramp.edges.find(e=>e.from==='a');assert.ok(entry.next.some(id=>ramp.edges[id].bridge));
  assert.ok(ramp.edges.find(e=>e.from==='r'&&e.bridge).next.some(id=>ramp.edges[id].to==='c'));
});
check("shape nodes, handedness, local bounds, duplicate data and missing topology",()=>{
  const r=road('curve',[['a',-80,0],['b',0,25],['c',80,0]]);
  const g=graph([r,r]);assert.equal(g.edges.length,2);assert.equal(g.edges[0].line.points.length,3);
  assert.ok(g.edges[0].offset>0);assert.ok(graph([r],{drivingSide:'left'}).edges[0].offset<0);
  assert.equal(graph([road('outside',[['a',1000,0],['b',1100,0]])]).edges.length,0);
  assert.equal(graph([road('missing',[['a',0,0],['b',100,0]],{roadNodes:[]})]).edges.length,0);
});
check("local return trips use a bridge connector, retain road identities and count its traffic without attaching homes to a raised crossing",()=>{
  const g=graph([road('entry',[['w',-400,0],['a',-200,0]]),road('bridge',[['a',-200,0],['j',0,0],['b',200,0]],{bridge:'yes',layer:1}),road('exit',[['b',200,0],['e',400,0]])]);
  const s=new Simulation(g,{...options,demandFeatures:[site('home',-400,25,{building:'apartments',population:'3000'}),site('work',400,25,{building:'office'})]});
  assert.ok(s.demand.pairs.length);assert.equal(g.structures.bridges,1);
  assert.ok(g.edges.filter(e=>e.bridge).every(e=>(s.demand.flows.get(e.id)||0)>0));
  let seen=false;for(let i=0;i<1000;i++){s.advance(.1);if(s.snapshot().vehicles.some(v=>v.roadId==='bridge'&&v.elevated))seen=true;}
  assert.ok(seen);assert.ok(s.network().some(e=>e.bridge&&e.hourly>0));
});
check("fixed steps are deterministic, pause preserves time and vehicles, boundary trips finish",()=>{
  const g=graph(cross),a=new Simulation(g,{...options,seed:17}),b=new Simulation(g,{...options,seed:17});
  for(let i=0;i<200;i++){a.advance(0.1);b.advance(0.05);b.advance(0.05);}
  assert.deepEqual(plain(a.snapshot()),plain(b.snapshot()));
  a.paused=true;const saved=plain(a.snapshot());a.advance(100);assert.deepEqual(plain(a.snapshot()),saved);
  a.paused=false;
  for(let i=0;i<2000;i++)a.advance(0.1);
  assert.ok(a.completed>0);assert.ok(a.cars.length<=600);
  for(const c of a.snapshot().vehicles)assert.ok(c.coordinate.every(Number.isFinite));
});
check("following vehicles keep their gap; only one movement occupies a junction; all approaches make progress",()=>{
  const balanced=demandFeatures.map(f=>f.properties.population?f:{...f,properties:{osmId:f.properties.osmId,osmType:f.properties.osmType,shop:'supermarket'}});
  const g=graph(cross),s=new Simulation(g,{...options,demandFeatures:balanced,startHour:12,seed:99});
  const departed=new Set();
  for(let i=0;i<6000;i++){
    s.advance(0.05);
    for(const e of g.edges){const cars=s.cars.filter(c=>c.phase==='edge'&&c.edge===e.id).sort((a,b)=>a.s-b.s);
      for(let j=1;j<cars.length;j++)assert.ok(cars[j].s-cars[j-1].s>=GAP-1e-5,`following gap ${cars[j].s-cars[j-1].s}: ${JSON.stringify({time:s.time,edge:e.id,cars:[cars[j-1],cars[j]]})}`);
    }
    const turning=s.cars.filter(c=>c.phase==='turn');
    const intersections=turning.map(c=>g.edges[c.edge].to);
    assert.equal(new Set(intersections).size,intersections.length);
    for(const c of turning){assert.equal(s.locks.get(g.edges[c.edge].to)?.car,c.id);departed.add(g.edges[c.edge].from);}
    for(const lock of s.locks.values())assert.ok(s.cars.some(c=>c.id===lock.car));
  }
  assert.ok(s.completed>50);assert.equal(departed.size,4);
  const before=plain(s.snapshot());s.setCount(60);const after=plain(s.snapshot());
  assert.deepEqual(before.vehicles,after.vehicles);assert.deepEqual(before.demand,after.demand);assert.equal(after.viewBudget,60);
});
check("a rear car cannot reserve ahead of its leader; occupied receiving lanes block admission",()=>{
  const g=graph(cross),s=new Simulation(g,{count:0}),e=g.edges.find(e=>e.from==='w'),next=e.next[0];
  s.cars=[{id:1,edge:e.id,s:e.length-20,v:0,phase:'edge',next,wait:0,age:0},
    {id:2,edge:e.id,s:e.length-10,v:0,phase:'edge',next,wait:1,age:0}];
  s.target=2;s.step();assert.equal(s.locks.get('j').car,2);
  s.locks.clear();s.cars.push({id:3,edge:next,s:0,v:0,phase:'edge',next:null,wait:null,age:0});
  s.target=3;s.step();assert.equal(s.locks.has('j'),false);
});
check("worker pause clears its timer, rebuild replaces generation and no data downloads occur",()=>{
  const timers=new Map(),messages=[];let id=0;
  const w=vm.createContext({console,onmessage:null,importScripts:()=>{},HuayuTrafficCore:context.HuayuTrafficCore,
    postMessage:m=>messages.push(plain(m)),setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:k=>timers.delete(k)});
  vm.runInContext(readWorker,w);
  w.onmessage({data:{action:'build',generation:1,features:cross,options:{center,...options}}});
  assert.equal(timers.size,1);for(let i=0;i<10;i++)[...timers.values()][0]();
  const time=messages.at(-1).time;
  w.onmessage({data:{action:'pause',paused:true}});assert.equal(timers.size,0);assert.equal(messages.at(-1).time,time);
  w.onmessage({data:{action:'pause',paused:false}});assert.equal(timers.size,1);
  w.onmessage({data:{action:'build',generation:2,features:[],options:{center}}});
  assert.equal(timers.size,0);assert.equal(messages.at(-1).generation,2);assert.equal(messages.at(-1).edges,0);
});
const {Demand,prepareSites}=context.HuayuTrafficDemand;
check("population is local, source IDs are unique, envelopes and relation members are not double counted",()=>{
  const g=graph(cross),duplicate={...demandFeatures[0],id:'render-duplicate'};
  const land=site('envelope',-300,25,{landuse:'residential',population:'100000'});
  // A larger residential polygon covering the mapped apartment must yield to it.
  land.geometry.coordinates[0]=[xy(-340,-15),xy(-260,-15),xy(-260,65),xy(-340,65),xy(-340,-15)];
  const place=site('whole-city',0,0,{place:'city',population:'900000',building:'residential'},false);
  const outside=site('outside',860,0,{building:'apartments',population:'60000'});
  const result=prepareSites([...demandFeatures,duplicate,land,place,outside],g);
  assert.equal(result.basis.taggedResidents,6000);assert.equal(result.basis.estimatedResidents,0);
  assert.equal(result.basis.residentialSites,2);assert.ok(result.basis.outside>=2);
  const member={...demandFeatures[0],properties:{...demandFeatures[0].properties,osmId:'member'}};
  const parent={...demandFeatures[0],properties:{...demandFeatures[0].properties,osmType:'relation',trafficMembers:['way:member']}};
  assert.equal(prepareSites([parent,member],g).basis.taggedResidents,3000);
});
check("missing population uses residential scale, explicit labels win, unknown buildings stay unknown",()=>{
  const g=graph(cross),home=site('residential',-300,25,{building:'house','building:levels':'2'});
  const small=prepareSites([home],g),tall=prepareSites([{...home,properties:{...home.properties,'building:levels':'8'}}],g);
  assert.ok(small.basis.estimatedResidents>0);assert.ok(tall.basis.estimatedResidents>small.basis.estimatedResidents*3);
  const unknown=site('unknown',300,25,{building:'yes',name:'某某住宅'});
  assert.equal(prepareSites([unknown],g).sites.length,0);
  const explicit={...home,properties:{...home.properties,population:'1,200'}};
  assert.equal(prepareSites([explicit],g).basis.taggedResidents,1200);assert.equal(prepareSites([explicit],g).basis.estimatedResidents,0);
  for(const text of ['1200 people','about 400','-2','Infinity'])assert.equal(context.HuayuTrafficDemand.population(text),0);
});
check("time, population and POI purposes change demand; routes follow reachable directed topology",()=>{
  const g=graph(cross),d=new Demand(g,demandFeatures,{startHour:8,demandFactor:1});
  const morningSchool=d.pairs.filter(p=>p.destination.kind==='education').reduce((n,p)=>n+p.hourly,0);
  const morningWork=d.pairs.filter(p=>p.destination.kind==='work').reduce((n,p)=>n+p.hourly,0);
  d.schedule(18);assert.ok(d.pairs.filter(p=>p.destination.kind==='education').reduce((n,p)=>n+p.hourly,0)<morningSchool);
  assert.ok(d.pairs.filter(p=>p.destination.kind==='work').reduce((n,p)=>n+p.hourly,0)<morningWork);
  const eveningReturn=d.pairs.filter(p=>p.destination.kind==='work').reduce((n,p)=>n+p.returnHourly,0);
  assert.ok(eveningReturn>d.pairs.filter(p=>p.destination.kind==='work').reduce((n,p)=>n+p.hourly,0)*2,
    'evening work traffic should mostly head home after the assumed work stay');
  for(const p of d.pairs)for(const ids of [p.outward,p.back])for(let i=1;i<ids.length;i++)assert.equal(g.edges[ids[i-1]].to,g.edges[ids[i]].from);
  const larger=new Demand(g,demandFeatures.map(f=>f.properties.population?{...f,properties:{...f.properties,population:'6000'}}:f),{startHour:18,demandFactor:1});
  assert.ok(Math.abs(larger.total-2*d.total)<1e-8);
  const noReturn=graph([road('one',[['w',-300,0],['e',300,0]],{oneway:'yes'})]);
  assert.equal(new Demand(noReturn,[demandFeatures[0],demandFeatures[2]]).pairs.length,0);
  assert.equal(new Simulation(g,{demandFeatures:[]}).cars.length,0,'missing demand must not become random roaming');
});
check("each trip arrives, dwells off street, returns to the original home and ends",()=>{
  const g=graph(cross),s=new Simulation(g,{...options,seed:2,startHour:12,demandFeatures:[demandFeatures[0],demandFeatures[3]]});
  const c=s.cars.find(c=>!c.returning);assert.ok(c);
  s.cars=[c];s.locks.clear();s.fill=()=>{}; // Isolate one complete trip, without unrelated arrivals.
  const id=c.id,home=c.pair.home.node,outward=plain(c.route);
  for(let i=0;i<3000&&c.phase!=='dwell';i++)s.advance(0.25);
  assert.equal(c.phase,'dwell');assert.equal(s.arrived,1);assert.equal(c.id,id);assert.equal(c.v,0);
  assert.equal(s.snapshot().dwelling,1);assert.equal(s.snapshot().moving,0);assert.equal(s.locks.size,0);
  assert.ok(c.departAt-s.time>=12*60-0.25&&c.departAt-s.time<=18*60);
  const dwell=plain(s.snapshot().vehicles);for(let i=0;i<20;i++)s.advance(0.25);
  assert.deepEqual(plain(s.snapshot().vehicles[0].coordinate),dwell[0].coordinate);
  for(let i=0;i<6000&&s.cars.length;i++)s.advance(0.25);
  assert.ok(c.returning);assert.equal(g.edges[c.route.at(-1)].to,home);assert.notDeepEqual(plain(c.route),outward);
  assert.equal(s.cars.length,0);assert.equal(s.returned,1);assert.equal(s.completed,2);
});
check("drawing budget does not change demand, car trips or assigned road flow",()=>{
  const g=graph(cross),a=new Simulation(g,{...options,count:60,seed:4}),b=new Simulation(g,{...options,count:480,seed:4});
  for(let i=0;i<400;i++){a.advance(0.1);b.advance(0.1);}
  assert.deepEqual(plain(a.snapshot().vehicles),plain(b.snapshot().vehicles));assert.deepEqual(plain(a.network()),plain(b.network()));
  assert.equal(a.demand.total,b.demand.total);assert.ok(a.network().some(e=>e.hourly>0));
  assert.ok(a.roadSamples.size>0);
  assert.ok(a.network().some(e=>e.ids.length===2),'physical roads aggregate opposite directions without hiding a slower direction');
});
console.log(JSON.stringify({status:'passed',cases}));
