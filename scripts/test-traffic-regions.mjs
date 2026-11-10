import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {createHash} from "node:crypto";
const context=vm.createContext({console,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,Float64Array});
for(const name of ["traffic-core","traffic-demand","traffic-regions","traffic-regional-sites","traffic-regional-core","traffic-protocol"])vm.runInContext(await readFile(new URL(`../site/${name}.js`,import.meta.url),"utf8"),context);
const C=context.HuayuTrafficCore,R=context.HuayuTrafficRegions,U=context.HuayuRegionalTraffic,plain=v=>JSON.parse(JSON.stringify(v));
const center=[152,14],project=C.projection(center),xy=(x,y)=>project.lngLat([x,y]);
const poly=(x0,y0,x1,y1)=>({type:"Polygon",coordinates:[[xy(x0,y0),xy(x1,y0),xy(x1,y1),xy(x0,y1),xy(x0,y0)]]});
const rel=(id,name,level,g,tags={},centre=null)=>({type:"relation",id,tags:{name,boundary:"administrative",admin_level:String(level),...tags},members:[
  ...g.coordinates.map((ring,i)=>({type:"way",ref:id*100+i,role:i?"inner":"outer",geometry:ring.map(p=>({lon:p[0],lat:p[1]}))})),...(centre?[{type:"node",ref:centre,role:"admin_centre"}]:[])]});
const place=(id,name,pop,x,y,kind="suburb")=>({type:"node",id,lon:xy(x,y)[0],lat:xy(x,y)[1],tags:{name,place:kind,population:String(pop)}});
const selection=(r,g)=>({osm_type:"relation",osm_id:r.id,name:r.tags.name,extratags:r.tags,geojson:g});
let cases=0;function check(name,fn){fn();cases++;console.log(`passed: ${name}`);}
check("indexed regional searches preserve legacy routes, exact costs and distances in both directions",()=>{
  const g={nodes:new Map(),edges:[]};for(let i=0;i<20;i++)g.nodes.set(String(i),{id:String(i),out:[]});
  let seed=7919;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let a=0;a<19;a++)for(let b=0;b<19;b++)if(a!==b&&rand()%5===0){const q=rand(),e={id:g.edges.length,from:String(a),to:String(b),line:{length:50+q%2000},speed:3+q%17,
    highway:["primary","residential","service","living_street"][q%4],accessOnly:q%4>=2};g.edges.push(e);g.nodes.get(e.from).out.push(e.id);}
  const rows=[];for(const start of g.nodes.keys())for(const reverse of [false,true]){const t=U.tree(g,start,reverse);
    for(const end of g.nodes.keys())rows.push([start,end,reverse,t.cost.get(end)??null,t.meters.get(end)??null,U.path(g,t,start,end,reverse)]);}
  // Recorded from the previous published search on the same deterministic graph.
  assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"),"ffba65f04660ecccb962d0542c1a26517f7c2aad4f7f3d032c8e0857179d45e3");
  assert.equal(U.path(g,U.tree(g,"0"),"0","19"),null,"a disconnected destination stays unreachable");
});
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
check("an ancestor admin centre cannot consume the selected city's population label",()=>{
  const g=poly(-2000,-1000,2000,1000),province=rel(900,"上级省",4,poly(-4000,-3000,4000,3000),{},901),city=rel(902,"主城区市",5,g);
  const node={...place(901,"主城区市",23560000,0,0,"city"),tags:{...place(901,"",0,0,0).tags,name:"主城区市",place:"city",capital:"5",population:"23560000"}};
  const district=rel(903,"局部区",6,poly(-1900,-900,-500,900));
  const p=R.populationZones([province,city,district,node,place(904,"街道",50000,-1000,0)],[selection(city,g)]);
  assert.equal(p.total,23560000);assert.equal(p.rows.find(r=>r.id==="relation:902").population,23560000);
  assert.equal(p.zones.find(z=>z.id==="relation:902").residents,23510000);assert.equal(p.rows.some(r=>r.id==="relation:900"),false);
  const both=R.populationZones([province,city,district,node],[selection(province,poly(-4000,-3000,4000,3000)),selection(city,g)]);
  assert.equal(both.total,23560000);assert.equal(both.rows.find(r=>r.id==="relation:900").population,null,"a level-5 city label does not become a level-4 provincial count");
});
check("capital and local administrative level distinguish county city points from their parent city",()=>{
  const g=poly(-2000,-1000,2000,1000),city=rel(910,"另一城市",5,g,{population:"1000000"}),county=rel(911,"县区",6,poly(-1900,-900,-500,900));
  const node=place(912,"县区",200000,-1000,0,"city");node.tags.capital="6";node.tags["place:hx"]="xian";
  const p=R.populationZones([city,county,node],[selection(city,g)]);
  assert.equal(p.total,1000000);assert.equal(p.rows.find(r=>r.id==="relation:911").population,200000);assert.equal(p.conflicts.length,0);
});
check("national and provincial capitals remain peer city populations instead of absorbing other cities",()=>{
  const g=poly(-4000,-3000,4000,3000),nation=rel(1001,"国家",2,g);
  const cities=["yes","2","3","4"].map((capital,i)=>{
    const n=place(1002+i,"城市"+i,1000+i*100,-2500+i*1500,0,"city");n.tags.capital=capital;return n;
  });
  nation.members.push({type:"node",ref:1002,role:"admin_centre"});
  const p=R.populationZones([nation,...cities],[selection(nation,g)]);
  assert.equal(p.total,4600);assert.equal(p.conflicts.length,0);
  assert.equal(p.rows.find(r=>r.id==="relation:1001").population,null,"a city seat is not a national total");
  assert.equal(p.pointScopes.filter(r=>r.scopeId==="relation:1001").length,4);
  const province=rel(1010,"省",4,g,{},1004);
  const q=R.populationZones([province,...cities],[selection(province,g)]);
  assert.equal(q.total,4600);assert.equal(q.conflicts.length,0);
  assert.equal(q.rows.find(r=>r.id==="relation:1010").population,null);
});
check("explicit population extents and foreign level-8 city centres retain their actual hierarchy",()=>{
  const g=poly(-3000,-2000,3000,2000),nation=rel(1020,"国家",2,g,{},1021);
  const label=place(1021,"国名",10000,0,0,"country"),province=place(1022,"省名",4000,0,0,"province");
  const city=rel(1023,"Municipality",8,poly(-1000,-1000,1000,1000),{},1024),centre=place(1024,"City",2000,0,0,"city");centre.tags.capital="4";
  const p=R.populationZones([nation,label,province,city,centre],[selection(nation,g)]);
  assert.equal(p.total,10000);assert.equal(p.conflicts.length,0);
  assert.equal(p.rows.find(r=>r.id==="relation:1023").population,2000);
  assert.equal(p.rows.find(r=>r.id==="node:1022").residual,2000);
  assert.equal(p.zones.reduce((n,z)=>n+z.residents,0),10000);
  const explicit={...centre,tags:{...centre.tags,admin_level:"2"}};
  assert.equal(R.populationZones([nation,explicit],[selection(nation,g)]).total,2000,"explicit extent takes priority over the city fallback");
});
check("locality coverage counts untagged places without inventing residents or counting holes",()=>{
  const g=poly(-2000,-1000,2000,1000);g.coordinates.push(poly(1400,-100,1600,100).coordinates[0]);
  const nation=rel(1030,"国家",2,g,{population:"10000"});
  const known=place(1031,"已标市",3000,-1000,0,"city"),unknown=place(1032,"未标镇",0,1000,0,"town"),hole=place(1033,"洞内",0,1500,0,"town");
  delete unknown.tags.population;
  const p=R.populationZones([nation,known,unknown,hole],[selection(nation,g)]);
  assert.equal(p.total,10000);assert.equal(p.localities.total,2);
  assert.equal(p.localities.withPopulation,1);assert.equal(p.localities.withoutPopulation,1);
  assert.equal(p.localities.byType.town.withPopulation,0);
});
check("an explicitly tagged provincial capital extent includes subordinate cities only once",()=>{
  const g=poly(-3000,-2000,3000,2000),province=rel(1040,"都",4,g);
  const capital=place(1041,"都",37000000,-1000,0,"city");capital.tags.capital="yes";capital.tags["place:hx"]="du";
  const city=place(1042,"下辖市",3500000,1000,0,"city");city.tags["place:hx"]="shi";
  const p=R.populationZones([province,capital,city],[selection(province,g)]);
  assert.equal(p.total,37000000);assert.equal(p.rows.find(r=>r.id==="relation:1040").population,37000000);
  assert.equal(p.rows.find(r=>r.id==="relation:1040").residual,33500000);assert.equal(p.conflicts.length,0);
});
check("a malformed facility multipolygon reports its source ID and refuses partial takeover",()=>{
  const r=rel(1050,"建筑",0,poly(-100,-100,100,100));r.tags={building:"yes",type:"multipolygon"};r.members[0].role="inner";
  assert.throws(()=>R.feature(r),/设施／建筑 relation:1050.*无完整外环.*未接管部分结果/);
});
check("label-only lower administrative relations retain population as points without blocking a complete city",()=>{
  const g=poly(-2000,-1000,2000,1000),city=rel(920,"任意城市",5,g,{population:"1000"});
  const district=rel(921,"无边界区",6,poly(-1800,-800,-100,800),{population:"400"},922);
  district.members=district.members.filter(m=>m.type!=="way");city.members.push({type:"relation",ref:921,role:"subarea"});
  const node=place(922,"无边界区",400,-1000,0,"city");node.tags.capital="6";
  const p=R.populationZones([city,district,node],[selection(city,g)]),z=p.zones.find(z=>z.id==="relation:921");
  assert.equal(p.total,1000);assert.equal(p.rows.length,2);assert.equal(z.residents,400);assert.equal(z.geometry,undefined);
  assert.equal(z.scopeId,"relation:920");assert.deepEqual(plain(z.scopeGeometry),plain(g));assert.equal(p.boundaryWarnings.length,1);
  assert.equal(p.boundaryWarnings[0].pointFallback,true);assert.equal(p.coverageAreas.length,1,"an estimated point scope is not an official district polygon");
  assert.throws(()=>R.populationZones([city,district,node],[selection(district,g)]),/外环/);
});
check("unclosed child boundaries keep explicit hierarchy and conservative totals, never invent a closing line",()=>{
  const g=poly(-2000,-1000,2000,1000),city=rel(930,"城市",5,g,{population:"1000"});
  const district=rel(931,"未闭合区",6,poly(-1800,-800,-100,800),{population:"400"},932),sub=rel(933,"真实街道",8,poly(-1500,-500,-500,500),{population:"150"});
  district.members[0].geometry.pop();district.members.push({type:"relation",ref:933,role:"subarea"});city.members.push({type:"relation",ref:931,role:"subarea"});
  const node=place(932,"区中心",0,-1000,0,"city");node.tags.capital="6";
  const p=R.populationZones([city,district,sub,node],[selection(city,g)]);
  assert.equal(p.total,1000);assert.equal(p.conflicts.length,0);assert.equal(p.zones.find(z=>z.id==="relation:931").residents,250);
  assert.equal(p.zones.find(z=>z.id==="relation:930").residents,600);assert.match(p.boundaryWarnings[0].reason,/未闭合/);
  assert.equal(p.zones.find(z=>z.id==="relation:931").geometry,undefined);
  const missing=plain(district);delete missing.members[0].geometry;
  assert.throws(()=>R.populationZones([city,missing,sub,node],[selection(city,g)]),/成员几何缺失/,"truncated source geometry is still rejected");
});
check("unlocated lower population is reserved, while unrelated labels and cyclic relation links do not change the city",()=>{
  const g=poly(-2000,-1000,2000,1000),city=rel(940,"城市",5,g,{population:"1000"});
  const child={type:"relation",id:941,tags:{boundary:"administrative",admin_level:"6",population:"250",name:"无定位区"},members:[{type:"relation",ref:940,role:"subarea"}]};
  city.members.push({type:"relation",ref:941,role:"subarea"});
  const unrelated={...child,id:942,members:[],tags:{...child.tags,name:"无关区域",population:"5000"}};
  const p=R.populationZones([unrelated,city,child],[selection(city,g)]);
  assert.equal(p.total,1000);assert.equal(p.zones.find(z=>z.id==="relation:941").locationMissing,true);
  assert.equal(p.zones.find(z=>z.id==="relation:940").residents,750);assert.equal(p.boundaryWarnings.length,1);
  assert.equal(p.boundaryWarnings[0].populationUnlocated,true);assert.ok(!p.rows.some(r=>r.id==="relation:942"));
});
check("missing locations never borrow an ancestor anchor to choose a district or absorb a nearby building",()=>{
  const g=poly(-2000,-1000,2000,1000),city=rel(960,"城市",5,g,{population:"1000"});
  const district=rel(961,"有边界区",6,poly(-1000,-800,1000,800),{population:"700"});
  const child={type:"relation",id:962,tags:{boundary:"administrative",admin_level:"8",population:"250",name:"无定位街道"},members:[]};
  city.members.push({type:"relation",ref:962,role:"subarea"});
  const p=R.populationZones([city,district,child],[selection(city,g)]);
  assert.equal(p.zones.find(z=>z.id==="relation:960").residents,50);
  assert.equal(p.zones.find(z=>z.id==="relation:961").residents,700);
  assert.equal(p.zones.find(z=>z.id==="relation:962").residents,250);
  const building={type:"Feature",id:"way:963",properties:{building:"house",population:"20"},geometry:{type:"Point",coordinates:xy(1500,0)}};
  const detailed=R.populationZones([city,district,child],[selection(city,g)],[building]);
  assert.equal(detailed.zones.find(z=>z.id==="relation:962").residents,250);
  assert.equal(detailed.zones.find(z=>z.id==="relation:960").residents,30);
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
const housing=(id,g,properties={})=>({type:"Feature",id,properties:{landuse:"residential",...properties},geometry:{type:"Point",coordinates:R.bounds(g).slice(0,2).map((v,j)=>(v+R.bounds(g)[j+2])/2)},area:g});
const buildingFeature=(id,x,props={})=>({...housing(id,poly(x-10,20,x+10,40)),properties:{building:"yes",osmType:"way",...props}});
const simulation=(i,extra={})=>new U.RegionalSimulation(U.buildGraph(i),{regionalInput:i,startHour:8,demandFactor:1,...extra});
check("province city and village points conserve hierarchy and keep city residuals connected",()=>{
  const g=poly(-1000,-1000,5000,1000),province=rel(970,"任意省",4,g),city=place(971,"市",10000,0,0,"city"),village=place(972,"村",200,2500,0,"village");
  const i=input();i.selected=[{id:970,name:"任意省",geometry:g}];i.buildingsLoaded=true;
  i.population=R.populationZones([village,province,city],[selection(province,g)]);
  assert.equal(i.population.total,10000,"a village count is part of the city's count");
  assert.equal(i.population.zones.find(z=>z.id==="node:971").residents,9800);
  assert.equal(i.population.zones.find(z=>z.id==="node:972").scopeId,"node:971");
  i.features=[buildingFeature("home1",0,{building:"apartments"}),buildingFeature("home2",2500,{building:"apartments"}),
    {type:"Feature",id:"office",properties:{office:"yes"},geometry:{type:"Point",coordinates:xy(4000,0)}}];
  i.roads=[road("local",[[1,0,0],[2,2500,0],[3,4000,0]],{highway:"residential"})];
  const s=simulation(i),d=s.demand.summary(),homes=s.demand.sites.filter(h=>h.kind==="home");
  assert.equal(d.unconnectedResidents,0);assert.equal(homes.reduce((n,h)=>n+h.weight,0),10000);
  assert.ok(homes.some(h=>h.sources.includes("市")&&h.weight>4000));assert.ok(d.hourly>100);
  assert.equal(d.missingPopulation,1,"an untagged province is still reported as unknown");
  const tagged={...village,tags:{...village.tags,building:"apartments"}};
  const repeated=R.populationZones([tagged,province,city],[selection(province,g)],[R.feature(tagged)]);
  assert.equal(repeated.total,10000);assert.equal(repeated.rows.filter(r=>r.id==="node:972").length,1,"a nested population place also fetched as a building is one source");
});
check("nested point scopes retain city partitions even when a city has no residual population",()=>{
  const g=poly(-1000,-1000,7000,1000),province=rel(980,"两城省",4,g),a=place(981,"甲市",300,0,0,"city"),b=place(982,"乙市",700,6000,0,"city"),
    child=place(983,"甲村",300,500,0,"village"),other=place(984,"乙村",100,5500,0,"village");
  const i=input();i.selected=[{id:980,name:"两城省",geometry:g}];i.buildingsLoaded=true;
  i.population=R.populationZones([other,b,child,province,a],[selection(province,g)]);
  assert.equal(i.population.total,1000);assert.ok(!i.population.zones.some(z=>z.id==="node:981"));
  assert.ok(i.population.pointScopes.some(z=>z.id==="node:981"),"zero residual parents still constrain geography");
  i.features=[buildingFeature("a-home",0,{building:"apartments"}),buildingFeature("b-home",6000,{building:"apartments"})];
  i.roads=[road("both",[[1,0,0],[2,6000,0]],{highway:"residential"})];
  const result=U.residentialAccesses(U.buildGraph(i),i);
  for(const z of i.population.zones){const nodes=result.accesses.get(z);assert.equal(nodes.length,1);
    assert.equal(nodes[0].node,z.id==="node:983"?"1":"2");assert.equal(nodes[0].share,1);}
});
check("a city population point contains lower relation counts without losing their real audit boundaries",()=>{
  const g=poly(-1000,-1000,7000,1000),province=rel(985,"省",4,g),city=place(986,"市",10000,0,0,"city"),
    district=rel(987,"有边界区",6,poly(-500,-500,1500,500),{population:"2000"}),
    label={type:"relation",id:988,tags:{boundary:"administrative",admin_level:"6",population:"1000",name:"仅中心区"},members:[{type:"node",ref:989,role:"admin_centre"}]},node=place(989,"中心",1000,6000,0,"city");node.tags.capital="6";
  const pop=R.populationZones([label,province,district,node,city],[selection(province,g)]);
  assert.equal(pop.total,10000);assert.equal(pop.zones.find(z=>z.id==="node:986").residents,7000);
  assert.equal(pop.zones.find(z=>z.id==="relation:988").scopeId,"node:986");
  assert.ok(pop.coverageAreas.some(a=>a.id==="relation:987"));assert.ok(pop.zones.find(z=>z.id==="node:986").exclusions.length);
});
check("population lacking a valid lower-area location remains unallocated instead of moving to other buildings",()=>{
  const i=input(),g=poly(-2000,-1000,2000,1000),city=rel(950,"城市",5,g,{population:"1000"});
  const child={type:"relation",id:951,tags:{boundary:"administrative",admin_level:"6",population:"250",name:"无定位区"},members:[]};
  city.members.push({type:"relation",ref:951,role:"subarea"});i.population=R.populationZones([city,child],[selection(city,g)]);i.selected=[{name:"城市",id:950,geometry:g}];
  for(const complete of [false,true]){i.buildingsLoaded=complete;const s=simulation(i),d=s.demand.summary();
    assert.equal(d.totalResidents,1000);assert.ok(d.unconnectedResidents>=250);assert.ok(s.demand.sites.filter(h=>h.kind==="home").reduce((n,h)=>n+h.weight,0)<=750);
    assert.equal(d.boundaryWarnings.length,1);}
});
function housingInput(){
  const i=input(),g=poly(-500,-600,9000,600),r=rel(10,"住宅测试市",5,g),p=place(101,"街道",12000,0,0);
  i.population=R.populationZones([r,p],[selection(r,g)]);i.selected=[{name:r.tags.name,geometry:g}];
  const points=[0,1000,2000,2800,4000,8000].map((x,n)=>[n+1,x,0]);
  i.roads=points.slice(1).map((p,n)=>road(`housing-road${n}`,[points[n],p],{highway:"residential"}));
  i.features=[{type:"Feature",id:"work",properties:{office:"yes"},geometry:{type:"Point",coordinates:xy(8000,0)}},
    ...[0,1000,2000,2800,4000].map((x,n)=>housing(`land${n}`,poly(x-50*(n+1),-100,x+50*(n+1),100)))];return i;
}
check("residential land distributes tagged place population beyond 450m without adding residents or changing drawing-independent demand",()=>{
  const i=housingInput(),z=i.population.zones[0];
  assert.equal(z.geometry,undefined);assert.equal(z.place,"suburb");assert.equal(z.scopeId,"relation:10");
  assert.ok(R.inside(xy(2000,0),z.scopeGeometry));
  const s=simulation(i),homes=s.demand.sites.filter(p=>p.kind==="home");
  assert.equal(homes.length,5);assert.equal(homes.reduce((n,h)=>n+h.weight,0),12000);
  assert.equal(s.demand.summary().estimatedResidents,0);assert.equal(s.demand.summary().totalResidents,12000);
  assert.equal(s.demand.summary().coveredResidentialLand,5);assert.equal(s.demand.summary().unknownResidentialLand,0);
  assert.ok(homes.some(h=>Math.abs(h.point[0]-2000)<1));assert.ok(homes.some(h=>Math.abs(h.point[0]-4000)<1),"a population label covers its parent area without a 3km cutoff");
  const first=homes.find(h=>Math.abs(h.point[0])<1),third=homes.find(h=>Math.abs(h.point[0]-2000)<1);
  assert.ok(Math.abs(third.weight/first.weight-3)<1e-8,"use land area, not an equal population for every road vertex");
  assert.ok(s.demand.pairs.some(p=>Math.abs(p.home.point[0]-2000)<1&&p.hourly>0));
  const more=simulation(i,{count:1200});assert.equal(more.demand.total,s.demand.total);
  assert.deepEqual(plain(more.demand.pairs.map(p=>p.hourly)),plain(s.demand.pairs.map(p=>p.hourly)));
});
check("residential ownership respects real parent holes, point range and deeper population areas",()=>{
  const i=housingInput(),g=poly(-500,-600,2500,600);g.coordinates.push(poly(900,-80,1100,80).coordinates[0]);
  i.population.zones[0].scopeGeometry=g;
  const child={id:"child",name:"独立社区",region:"住宅测试市",level:10,residents:2000,coordinate:xy(2000,0),geometry:poly(1900,-200,2100,200)};
  i.population.zones.push(child);i.population.total+=2000;
  const result=U.residentialAccesses(U.buildGraph(i),i),parent=result.accesses.get(i.population.zones[0]),children=result.accesses.get(child);
  assert.equal(parent.length,1);assert.ok(Math.abs(parent[0].point[0])<1);assert.equal(children.length,1);assert.ok(Math.abs(children[0].point[0]-2000)<1);
  assert.equal(result.covered,2);assert.equal(result.unknown,3);
  assert.equal(parent.reduce((n,a)=>n+a.share,0),1);assert.equal(children.reduce((n,a)=>n+a.share,0),1);
  i.population.zones=[];assert.equal(U.residentialAccesses(U.buildGraph(i),i).accesses.size,0,"unknown population must never be invented from land area");
});
check("residential relation members are not counted twice and unclosed source land is not made into a polygon",()=>{
  const i=housingInput(),f=i.features[1];f.id="relation:20";f.properties.trafficMembers=["way:21"];
  const baseline=U.residentialAccesses(U.buildGraph(i),i);
  i.features.push({...f,id:"way:21",properties:{landuse:"residential"}});
  const result=U.residentialAccesses(U.buildGraph(i),i);assert.equal(result.land,baseline.land);
  assert.deepEqual(plain([...result.accesses.values()]),plain([...baseline.accesses.values()]));
  const open=R.feature({type:"way",id:23,tags:{landuse:"residential"},nodes:[1,2,3],geometry:[{lon:152,lat:14},{lon:152.001,lat:14},{lon:152.002,lat:14}]});
  assert.equal(open.area,null);i.features.push(open);
  const invalid=U.residentialAccesses(U.buildGraph(i),i);assert.equal(invalid.covered,result.covered);assert.equal(invalid.unknown,result.unknown+1);
  assert.throws(()=>R.feature({type:"way",id:23,tags:{landuse:"residential"},nodes:[1,2,3],geometry:[{lon:152,lat:14}]}),/几何不完整/);
});
check("housing accesses use legal surface roads, including internal access, and keep disconnected homes unserved",()=>{
  const i=housingInput();
  i.roads.push(road("internal",[[20,1500,-40],[21,1550,-40]],{highway:"service"}),
    road("private",[[30,2200,0],[31,2250,0]],{highway:"residential",access:"private"}),
    road("bridge",[[40,2400,0],[41,2450,0]],{highway:"residential",layer:"1",bridge:"yes"}),
    road("tunnel",[[50,2600,0],[51,2650,0]],{highway:"residential",layer:"-1",tunnel:"yes"}));
  i.features.push(...[1500,2200,2400,2600].map(x=>housing(`extra${x}`,poly(x-10,-60,x+80,60))));
  const s=simulation(i),homes=s.demand.sites.filter(p=>p.kind==="home"),internal=homes.find(h=>/^(20|21)$/.test(h.node));
  assert.ok(internal);assert.ok(!s.demand.pairs.some(p=>p.home===internal));assert.ok(s.demand.summary().unservedResidents>0);
  assert.ok(!homes.some(h=>/^(30|31|40|41|50|51)$/.test(h.node)));
  assert.ok(Math.abs(homes.reduce((n,h)=>n+h.weight,0)-12000)<1e-7);
});
check("housing overflow coarsens all land weights within the same population zone without truncating its far side",()=>{
  const i=housingInput(),xs=Array.from({length:600},(_,n)=>n*500),g=poly(-100,-100,300000,100);
  i.population.zones=[{id:"large",name:"大区",region:"测试市",level:6,residents:60000,coordinate:xy(0,0),geometry:g}];
  i.features=xs.map((x,n)=>housing(`land${n}`,poly(x-20,-20,x+20,20)));
  i.roads=xs.map((x,n)=>road(`street${n}`,[[n*2,x,0],[n*2+1,x+10,0]],{highway:"residential"}));
  const result=U.residentialAccesses(U.buildGraph(i),i),list=result.accesses.get(i.population.zones[0]);
  assert.equal(result.covered,600);assert.ok(list.length<=512&&list.length>1);
  assert.ok(Math.abs(list.reduce((n,v)=>n+v.share*60000,0)-60000)<1e-7);
  assert.ok(list.some(v=>v.point[0]<1000));assert.ok(list.some(v=>v.point[0]>298000));
});
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
check("building occupancy uses measured footprint and real levels or usable height, never one person per building",()=>{
  const metrics=context.HuayuRegionalSites.buildingMetrics;
  const a=metrics(buildingFeature("small",0,{"building:levels":"2"}),project),b=metrics(buildingFeature("tall",0,{"building:levels":"80"}),project);
  assert.ok(Math.abs(b.floor/a.floor-40)<1e-8);assert.equal(b.levels,80);
  const h=metrics(buildingFeature("height",0,{height:"30 m",min_height:"3", "roof:height":"6"}),project);
  assert.equal(h.source,"height");assert.equal(h.levels,7);
  const ft=metrics(buildingFeature("feet",0,{height:"30 ft"}),project);assert.equal(ft.levels,3);
  const i=housingInput();i.buildingsLoaded=true;
  i.features=[buildingFeature("small",0,{building:"apartments","building:levels":"2"}),buildingFeature("large",1000,{building:"apartments","building:levels":"20"}),buildingFeature("office",2800,{building:"office"})];
  const s=simulation(i),homes=s.demand.sites.filter(h=>h.kind==="home"),first=homes.find(h=>h.node==="1"),second=homes.find(h=>h.node==="2");
  assert.ok(first.weight>1);assert.ok(Math.abs(second.weight/first.weight-10)<1e-7);
  assert.ok(Math.abs(homes.reduce((n,h)=>n+h.weight,0)-12000)<1e-7);
  assert.ok(s.demand.basis.buildingAudit.floorArea>0);
});
check("all-region buildings inherit regional totals across the whole parent instead of a label radius",()=>{
  const i=housingInput();i.buildingsLoaded=true;
  const g=poly(-1000,-1000,21000,1000),r=rel(40,"另一个城市",5,g,{population:"20000"});
  i.population=R.populationZones([r,place(401,"西区",12000,0,0),place(402,"东区",8000,14000,0)],[selection(r,g)]);
  i.selected=[{name:r.tags.name,geometry:g}];
  i.roads=[road("whole",[[1,0,0],[2,5000,0],[3,10000,0],[4,18000,0],[5,20000,0]],{highway:"residential"})];
  i.features=[buildingFeature("generic",5000),buildingFeature("home",10000,{building:"apartments"}),buildingFeature("distant",18000),buildingFeature("work",20000,{building:"office"}),buildingFeature("garage",0,{building:"garage"})];
  const s=simulation(i),d=s.demand.summary(),homes=s.demand.sites.filter(s=>s.kind==="home");
  assert.equal(d.buildings,5);assert.equal(d.homeBuildings,3);assert.equal(d.unknownBuildings,2);assert.equal(d.excludedBuildings,1);
  assert.ok(s.graph.nodes.has("2"),"a real building access vertex splits the original way without inventing a junction");
  assert.ok(homes.some(h=>h.node==="2"));assert.ok(homes.some(h=>h.node==="4"));
  assert.equal(d.totalResidents,20000);assert.equal(homes.reduce((n,h)=>n+h.weight,0)+d.unconnectedResidents,20000);
  assert.ok(s.demand.sites.some(s=>s.kind==="activity"));assert.equal(d.estimatedResidents,0);
  assert.ok(s.demand.pairs.some(p=>p.home.node==="4"&&p.hourly>0));
});
check("building area and floors distribute one regional population and residential envelopes/members do not duplicate it",()=>{
  const i=housingInput();i.buildingsLoaded=true;i.population.zones=[{id:"all",name:"区",region:"甲市",residents:900,level:6,coordinate:xy(1000,0),geometry:poly(-100,-200,3000,200)}];i.population.total=900;
  i.features=[buildingFeature("relation:b",0,{building:"apartments","building:levels":"2",trafficMembers:["way:member"]}),
    buildingFeature("b2",1000,{building:"apartments","building:levels":"4"}),buildingFeature("way:member",0,{building:"apartments","building:levels":"2"}),
    housing("estate",poly(-100,-200,2100,200)),{type:"Feature",id:"work",properties:{office:"yes"},geometry:{type:"Point",coordinates:xy(2800,0)}}];
  const s=simulation(i),homes=s.demand.sites.filter(s=>s.kind==="home");assert.equal(s.demand.summary().buildings,2);assert.equal(homes.length,2);
  assert.ok(Math.abs(homes.find(h=>h.node==="2").weight/homes.find(h=>h.node==="1").weight-2)<1e-7);
  assert.equal(homes.reduce((n,h)=>n+h.weight,0),900);
});
check("tagged building and housing-area population are subtracted from community and city totals",()=>{
  const g=poly(-1000,-1000,4000,1000),r=rel(50,"市",5,g,{population:"1000"}),estate=housing("estate",poly(-200,-200,500,200),{population:"200"});
  const b=buildingFeature("house",0,{building:"apartments",population:"80"});
  const pop=R.populationZones([r,place(501,"社区",400,0,0,"quarter")],[selection(r,g)],[estate,b]);
  assert.equal(pop.total,1000);assert.equal(pop.zones.reduce((n,z)=>n+z.residents,0),1000);
  assert.equal(pop.zones.find(z=>z.id==="house").residents,80);assert.equal(pop.zones.find(z=>z.id==="estate").residents,120);
  assert.equal(pop.zones.find(z=>z.id==="node:501").residents,200);assert.equal(pop.zones.find(z=>z.id==="relation:50").residents,600);
  assert.equal(pop.zones.find(z=>z.id==="estate").exclusions.length,1);
  assert.equal(pop.zones.find(z=>z.id==="relation:50").exclusions.length,1,"known estate geometry is excluded through a point community too");
});
check("every reachable building destination group receives OD coverage, beyond the nearest four",()=>{
  const i=housingInput();i.buildingsLoaded=true;i.population.zones=[{id:"all",name:"区",region:"甲市",residents:1000,level:6,coordinate:xy(0,0),geometry:poly(-100,-200,11000,200)}];i.population.total=1000;
  i.selected=[{name:"甲市",geometry:i.population.zones[0].geometry}];
  i.roads=[road("all-destinations",Array.from({length:11},(_,n)=>[n+1,n*1000,0]),{highway:"residential"})];
  i.features=[buildingFeature("home",0,{building:"apartments"}),...Array.from({length:10},(_,n)=>buildingFeature(`office${n}`,1000*(n+1),{building:"office"}))];
  const s=simulation(i),dest=s.demand.sites.filter(s=>s.kind!=="home");assert.equal(dest.length,10);
  for(const d of dest)assert.ok(s.demand.pairs.some(p=>p.destination===d&&p.hourly>0),d.id);
  const limited=simulation(i,{count:60});assert.equal(limited.demand.total,s.demand.total);
});
check("population place representations and nested estate totals are not duplicated as buildings",()=>{
  const g=poly(-1000,-1000,4000,1000),r=rel(60,"市",5,g),p=place(601,"市",1000,0,0,"city");
  const duplicate={type:"Feature",id:"node:601",geometry:{type:"Point",coordinates:xy(0,0)},properties:{...p.tags,building:"yes",osmType:"node",osmId:601}};
  const outer=housing("z-outer",poly(-500,-500,3000,500),{population:"600"});
  const inner=housing("a-inner",poly(-200,-200,500,200),{population:"200"});
  const b=buildingFeature("b",0,{building:"apartments",population:"80",disused:"no","building:part":"no"});
  const pop=R.populationZones([r,p],[selection(r,g)],[inner,outer,b,duplicate]);
  assert.equal(pop.total,1000);assert.equal(pop.rows.filter(z=>z.id==="node:601").length,0);
  assert.equal(pop.zones.find(z=>z.id==="z-outer").residents,400);
  assert.equal(pop.zones.find(z=>z.id==="a-inner").residents,120);
  assert.equal(pop.zones.find(z=>z.id==="b").residents,80);
});
check("unconnected buildings retain unallocated population, while districts without footprints keep an explicit road fallback",()=>{
  const i=housingInput();i.buildingsLoaded=true;i.population.zones=[{id:"all",name:"区",region:"甲市",residents:1000,level:6,coordinate:xy(0,0),geometry:poly(-100,-1000,4000,1000)}];i.population.total=1000;
  i.features=[buildingFeature("near",0,{building:"apartments"}),{...buildingFeature("far",2000,{building:"apartments"}),geometry:{type:"Point",coordinates:xy(2000,800)},area:poly(1990,790,2010,810)}];
  const s=simulation(i),d=s.demand.summary();assert.ok(Math.abs(d.unconnectedResidents-500)<1e-5);
  assert.ok(Math.abs(s.demand.sites.filter(s=>s.kind==="home").reduce((n,h)=>n+h.weight,0)+d.unconnectedResidents-1000)<1e-6);
  const noBuildings={...i,features:[]},fallback=U.residentialAccesses(U.buildGraph(noBuildings),noBuildings);
  assert.equal(fallback.fallbackPopulationZones,1);assert.ok(fallback.accesses.get(i.population.zones[0]).length>1);assert.equal(fallback.unconnected.get(i.population.zones[0]),0);
});
check("an explicitly populated point building keeps its own count instead of reallocating it across the parent scope",()=>{
  const i=housingInput(),g=poly(-100,-300,4000,300),r=rel(61,"市",5,g,{population:"1000"});
  const b={type:"Feature",id:"node:610",properties:{building:"apartments",population:"80",osmType:"node",osmId:610},geometry:{type:"Point",coordinates:xy(0,30)}};
  i.features=[b,buildingFeature("other",1000,{building:"apartments"}),buildingFeature("office",2800,{building:"office"})];
  i.population=R.populationZones([r],[selection(r,g)],i.features);i.selected=[{name:r.tags.name,geometry:g}];i.buildingsLoaded=true;
  const s=simulation(i),homes=s.demand.sites.filter(s=>s.kind==="home");
  assert.ok(Math.abs(homes.find(h=>h.node==="1").weight-80)<1e-7);
  assert.ok(Math.abs(homes.find(h=>h.node==="2").weight-920)<1e-7);assert.equal(s.demand.summary().totalResidents,1000);
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
  assert.throws(()=>decoder.decode({vehicleFrames:new Float64Array(11)}),/格式/);
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
check("regional samples keep legal lanes through continuous junction paths and lane count controls directional capacity",()=>{
  const i=input();i.roads=i.roads.map(r=>({...r,properties:{...r.properties,lanes:'4'}}));
  const s=simulation(i),c=s.cars.find(c=>c.phase==='edge'&&c.route.length>1);assert.ok(c);
  c.index=0;c.edge=c.route[0];c.lane=s.graph.edges[c.edge].lanes-1;c.waitFor=0;c.v=10;c.s=s.graph.edges[c.edge].line.length-.01;s.cars=[c];
  const incoming=s.graph.edges[c.edge],out=s.graph.edges[c.route[1]],expected=C.nextLane(incoming,out,c.lane),before=s.snapshot().vehicles[0].coordinate;
  s.advance(.2);assert.equal(c.phase,'turn');
  const first=s.snapshot().vehicles[0].coordinate;assert.ok(Math.hypot((first[0]-before[0])*111320*Math.cos(center[1]*Math.PI/180),(first[1]-before[1])*111320)<1);
  for(let j=0;j<250&&c.phase==='turn';j++)s.advance(.2);
  assert.equal(c.phase,'edge');assert.equal(c.edge,out.id);assert.equal(c.lane,expected);
  for(const v of s.snapshot().vehicles)assert.ok(v.lane>=1&&v.lane<=v.lanes);
  const single=simulation({...i,roads:i.roads.map(r=>({...r,properties:{...r.properties,lanes:'2'}}))});
  assert.equal(s.capacity[incoming.id],single.capacity[incoming.id]*2);
});
check("marked parking capacity causes entry queues, conserves road/parking mass, and never invents free spaces",()=>{
  const i=input(true,true);
  // Keep the known four-lane bottleneck independent of untagged class defaults.
  i.roads=i.roads.map(r=>({...r,properties:{...r.properties,lanes:'4'}}));
  const s=simulation(i,{demandFactor:3}),initial=s.stock.reduce((n,v)=>n+v,0)+s.parking.get("parking").occupied;
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
  const i=housingInput(),g=i.selected[0].geometry,r=rel(10,"住宅测试市",5,g),rawLand=rel(21,"住宅用地",0,poly(-100,-100,100,100),{landuse:"residential",type:"multipolygon"});
  rawLand.tags={landuse:"residential",type:"multipolygon"};const captured=[];
  const loaded=await R.load([selection(r,g)],()=>{},async(_url,o)=>{
    const q=new URLSearchParams(o.body).get("data");captured.push(q);
    return new Response(payload(q.includes('node(r.r:')?[r,place(101,"街道",12000,0,0)]:q.includes('way(area.a)[highway~')
      ?i.roads.map((f,n)=>({type:"way",id:n+1,tags:f.properties,nodes:f.properties.roadNodes,geometry:f.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))})):[rawLand],1000));
  });
  assert.equal(captured.length,4,"building completeness has its own bounded request");
  const query=captured.find(q=>q.includes('->.f;'));
  assert.match(query,/landuse~"\^\(residential\|industrial\|commercial\|retail\)/);assert.match(query,/nwr\.f\[landuse\]/);assert.match(query,/\.shape out body geom/);
  assert.ok(captured.some(q=>q.includes('[building][building!=no]')&&q.includes('out body geom;out count;')));
  assert.ok(captured.some(q=>q.includes('node(area.a)[place~')&&q.includes('country|state|province|region|city|town')),"population coverage includes untagged localities in the same request");
  assert.equal(loaded.features[0].area.type,"Polygon");assert.equal(loaded.features[0].properties.trafficMembers.length,1);
  assert.equal(loaded.population.zones[0].scopeId,"relation:10");assert.equal(loaded.population.total,12000);
  cases++;console.log("passed: full-region residential geometry and parent population scope arrive in the existing complete bounded requests");
}
{
  const i=input(),g=poly(-2100,-600,2100,600),r=rel(1,"甲市",5,g,{population:"20000"}),s=[selection(r,g)],pending=[];
  let active=0,peak=0,started=0;
  const full=R.load(s,()=>{},async(_url,options)=>{
    const q=new URLSearchParams(options.body).get("data");active++;peak=Math.max(peak,active);started++;
    const index=q.includes('node(r.r:')?0:q.includes('way(area.a)[highway~')?1:q.includes('[building][building!=no]')?3:2;
    const elements=index===0?[r]:index===1?i.roads.map((f,n)=>({type:"way",id:n+1,tags:f.properties,nodes:f.properties.roadNodes,geometry:f.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))})):[{type:"node",id:9,lon:xy(1500,0)[0],lat:xy(1500,0)[1],tags:{office:"yes"}}];
    return new Promise(resolve=>pending.push(()=>{active--;resolve(new Response(payload(elements,1000*(index+1))));}));
  });
  assert.equal(started,2);pending.shift()();await new Promise(setImmediate);assert.equal(started,3);assert.equal(peak,2);
  while(started<4||pending.length){pending.shift()();await new Promise(setImmediate);}
  const result=await full;assert.equal(result.population.total,20000);assert.equal(result.roads.length,2);assert.equal(result.features.length,1);
  assert.deepEqual(plain(result.sourceTimes),[1000,2000,3000,4000]);
  cases++;console.log("passed: full-region requests overlap within two slots and retain complete input and source times");
}
{
  const i=input(),g=poly(-2100,-600,2100,600),r=rel(1,"甲市",5,g,{population:"20000"}),s=[selection(r,g)];
  for(const expand of [true,false]){
    const capacity={slots:1},pending=[];let active=0,peak=0,started=0;
    const loading=R.load(s,()=>{},async(_url,o)=>{
      const q=new URLSearchParams(o.body).get("data"),elements=q.includes('node(r.r:')?[r]:q.includes('way(area.a)[highway~')
        ?i.roads.map((f,n)=>({type:"way",id:n+1,tags:f.properties,nodes:f.properties.roadNodes,geometry:f.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))})):[];
      started++;active++;peak=Math.max(peak,active);
      return new Promise(resolve=>pending.push(()=>{active--;resolve(new Response(payload(elements,1000)));}));
    },{capacity});
    assert.equal(started,1,"reserve a slot while nearby preview is still reading");
    if(expand){capacity.slots=2;capacity.wake();assert.equal(started,2);}
    while(started<4||pending.length){pending.shift()();await new Promise(setImmediate);}
    const result=await loading;assert.equal(result.population.total,20000);assert.equal(result.roads.length,2);
    assert.equal(peak,expand?2:1);assert.equal(capacity.wake,null);
  }
  cases++;console.log("passed: full-region load starts with one slot, expands after preview, or completes without expansion");
}
{
  const s=input().selected.map(s=>({name:s.name,geojson:s.geometry})),roadFeature=road("near",[[1,-400,0],[2,400,0]]),raw={type:"way",id:1,tags:{highway:"primary"},nodes:[1,2],geometry:roadFeature.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))};
  const captured=[];
  const preview=await R.loadPreview(xy(-500,0),s,async(_url,o)=>{captured.push(new URLSearchParams(o.body).get("data"));return new Response(payload([raw],1000));});
  assert.equal(preview.roads.length,1);assert.equal(preview.radius,1500);assert.deepEqual(plain(preview.sourceTimes),[1000]);assert.ok(!captured[0].includes('area('));
  assert.match(captured[0],/motorway\\|trunk\\|primary/);
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
{
  const g=poly(-1000,-1000,5000,1000),r=rel(990,"省级测试",4,g),captured=[];
  const roads=[road("res",[[1,0,0],[2,1000,0]],{highway:"residential"}),road("service",[[2,1000,0],[3,2000,0]],{highway:"service"}),
    road("living",[[3,2000,0],[4,3000,0]],{highway:"living_street"})];
  const loaded=await R.load([selection(r,g)],()=>{},async(_url,o)=>{
    const q=new URLSearchParams(o.body).get("data");captured.push(q);
    return new Response(payload(q.includes('node(r.r:')?[r,place(991,"市",10000,0,0,"city")]:q.includes('way(area.a)[highway~')
      ?roads.map((f,n)=>({type:"way",id:n+1,tags:f.properties,nodes:f.properties.roadNodes,geometry:f.geometry.coordinates.map(p=>({lon:p[0],lat:p[1]}))})):[],1000));
  });
  const query=captured.find(q=>q.includes('way(area.a)[highway~'));
  assert.match(query,/unclassified\|residential\|living_street\|service/);assert.ok(!query.includes('around.access'));
  assert.equal(loaded.provincial,true);assert.equal(loaded.roads.length,3);assert.equal(captured.length,4);assert.equal(loaded.population.total,10000);
  cases++;console.log("passed: provinces load complete residential and internal road access within the same four bounded requests");
}
{
  let capacity,finish;const messages=[];
  const w=vm.createContext({console,onmessage:null,importScripts(){},HuayuRegionalTraffic:U,HuayuTrafficProtocol:context.HuayuTrafficProtocol,
    HuayuTrafficRegions:{load:(_s,_p,_f,options)=>{capacity=options.capacity;return new Promise(resolve=>{finish=resolve;});}},
    postMessage:m=>messages.push(m),setInterval:()=>assert.fail("paused build must not start a timer"),clearInterval(){}});
  vm.runInContext(await readFile(new URL("../site/traffic-worker.js",import.meta.url),"utf8"),w);
  const loading=w.onmessage({data:{action:"build-region",generation:7,regions:[],previewPending:true,options:{count:60},paused:true}});
  assert.equal(capacity.slots,1);let wakes=0;capacity.wake=()=>wakes++;
  await w.onmessage({data:{action:"load-slots",generation:6}});assert.equal(capacity.slots,1);assert.equal(wakes,0);
  await w.onmessage({data:{action:"load-slots",generation:7}});assert.equal(capacity.slots,2);assert.equal(wakes,1);
  finish(lotInput());await loading;assert.ok(messages.at(-1).regional);
  cases++;console.log("passed: actual worker expands only the current region generation's request slots");
}
await assert.rejects(()=>R.request("fixture",async()=>new Response(JSON.stringify({elements:[{type:"count",tags:{total:"2"}},{type:"node",id:1}]}))),/计数不完整/);
cases++;console.log("passed: partial upstream results are rejected before takeover");
console.log(JSON.stringify({status:"passed",cases}));
