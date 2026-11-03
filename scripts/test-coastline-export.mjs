import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import worker, {coastlineQuery} from "../site/_worker.js";

const context=vm.createContext({});
for(const file of ["vendor/polygon-clipping-0.15.7.js","coastline.js"])vm.runInContext(await readFile(new URL(`../site/${file}`,import.meta.url),"utf8"),context);
const C=context.HuayuCoastline, plain=value=>JSON.parse(JSON.stringify(value));
const b={west:0,east:10,south:0,north:10};
const ring=(x1,y1,x2,y2)=>[[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]];
const feature=(coordinates,id=1)=>({type:"Feature",properties:{name:`测试区${id}`,osm_id:id,admin_level:6},geometry:{type:"Polygon",coordinates}});
let node=1, wayId=1;
const way=points=>({type:"way",id:wayId++,tags:{natural:"coastline"},nodes:points.map(()=>node++),geometry:points.map(([lon,lat])=>({lon,lat}))});
const full=feature([ring(0,0,10,10)]), before=JSON.stringify(full);
const oceanCoast=way([[5,-1],[5,5],[5,11]]);
let land=C.landGeometry([oceanCoast],b);
let row=C.analyze([full],land)[0];
assert.ok(Math.abs(row.landSquareMeters/row.totalSquareMeters-.5)<1e-10,"northbound coast keeps the western land side");
assert.equal(row.totalSquareMeters,row.landSquareMeters+row.seaSquareMeters,"land and sea partition the original administrative area");
const reversed=way([[5,11],[5,5],[5,-1]]);
assert.ok(C.analyze([feature([ring(6,1,9,9)])],C.landGeometry([reversed],b))[0].seaSquareMeters<1,"southbound keeps eastern land");

const island=way(ring(7,2,9,4));
land=C.landGeometry([oceanCoast,island],b);
row=C.analyze([full],land)[0];
assert.equal(row.feature.geometry.coordinates.length,2,"offshore islands remain separate land polygons");
assert.ok(row.landSquareMeters>C.analyze([full],C.landGeometry([oceanCoast],b))[0].landSquareMeters);
const inlandLake=feature([ring(1,1,4,4)]);
assert.equal(C.analyze([inlandLake],land)[0].seaSquareMeters,0,"inland rivers and lakes are not subtracted; only coastline excludes sea");
const withHole=feature([ring(0,0,10,10),ring(1,1,2,2)],2);
const holed=C.analyze([withHole],land)[0];
assert.equal(holed.feature.geometry.coordinates[0].length,2,"original administrative holes remain holes");
const seaRow=C.analyze([full],land,undefined,"sea")[0];
assert.equal(seaRow.feature.properties.derived,"coastline-sea-v1");
assert.equal(seaRow.feature.properties.area_square_meters,seaRow.seaSquareMeters);
assert.equal(seaRow.landSquareMeters,row.landSquareMeters,"area statistics do not depend on export part");
assert.ok(Math.abs(C.area(seaRow.feature.geometry.coordinates)-seaRow.seaSquareMeters)<.01);
assert.equal(seaRow.feature.geometry.coordinates[0].length,2,"offshore island becomes a hole in sea geometry");
assert.equal(C.analyze([inlandLake],land,undefined,"sea")[0].feature.geometry.coordinates.length,0,"inland water is excluded from sea exports");
const marineHole=feature([ring(0,0,10,10),ring(6,6,7,7)]);
assert.equal(C.analyze([marineHole],land,undefined,"sea")[0].feature.geometry.coordinates[0].length,3,"marine export preserves both administrative holes and islands");
assert.equal(C.analyze([full],C.landGeometry([],b,true),undefined,"sea")[0].feature.geometry.coordinates.length,0,"all-land region has no sea to export");
const oceanOnly=C.analyze([full],C.landGeometry([],b,false),undefined,"sea")[0];
assert.equal(oceanOnly.feature.properties.area_square_meters,oceanOnly.totalSquareMeters);
assert.deepEqual(plain(oceanOnly.feature.geometry.coordinates),[plain(full.geometry.coordinates)],"all-sea region retains the full administrative geometry");
assert.notEqual(oceanOnly.feature.geometry.coordinates[0],full.geometry.coordinates,"derived output does not alias the original boundary");
assert.throws(()=>C.analyze([full],land,undefined,"other"),/请选择/);

const east=way([[7,11],[7,-1]]),west=way([[3,-1],[3,11]]);
land=C.landGeometry([west,east],b);
assert.equal(land.length,2,"separate land on both sides of a channel is preserved");
row=C.analyze([full],land)[0];
assert.ok(Math.abs(row.landSquareMeters/row.totalSquareMeters-.6)<1e-10);
const islandOnly=C.landGeometry([island],b);
assert.equal(C.analyze([full],islandOnly)[0].feature.geometry.coordinates.length,1,"closed island does not turn surrounding ocean into land");
const seaHole=way(ring(2,2,8,8).reverse()),innerIsland=way(ring(4,4,6,6));
land=C.landGeometry([seaHole,innerIsland],b);
assert.equal(land.length,2,"mainland with an enclosed sea and an island preserves the nested topology");
assert.ok(C.analyze([full],land)[0].seaSquareMeters>0);
const nestedSea=C.analyze([full],land,undefined,"sea")[0];
assert.equal(nestedSea.feature.geometry.coordinates.length,1);
assert.equal(nestedSea.feature.geometry.coordinates[0].length,2,"an island inside an enclosed sea remains excluded");
assert.equal(C.landGeometry([],b),null,"no shoreline is unknown until a separate land/sea probe succeeds");
assert.equal(C.analyze([full],C.landGeometry([],b,true))[0].seaSquareMeters,0);
assert.equal(C.analyze([full],C.landGeometry([],b,false))[0].landSquareMeters,0);
assert.throws(()=>C.landGeometry([way([[3,3],[7,7]])],b),/不完整/);
assert.throws(()=>C.landGeometry([oceanCoast,oceanCoast],b),/不完整/);
assert.throws(()=>C.landGeometry([{...oceanCoast,geometry:[]}],b),/不完整/);
assert.throws(()=>C.bounds([feature([ring(-100,0,100,5)])]),/过大/);
assert.equal(JSON.stringify(full),before,"analysis never changes original boundaries");
const enclosing=way(ring(-1,-1,11,11));enclosing.nodes[enclosing.nodes.length-1]=enclosing.nodes[0];
assert.equal(C.analyze([full],C.landGeometry([enclosing],b))[0].seaSquareMeters,0,"a complete surrounding coast supplies a land seed even if all its vertices lie outside the extent");
const multi={...full,geometry:{type:"MultiPolygon",coordinates:[[ring(0,0,4,4)],[ring(7,2,9,4)]]}};
assert.equal(C.analyze([multi],C.landGeometry([oceanCoast,island],b))[0].feature.geometry.coordinates.length,2);

// The same curves may be split across OGF ways without changing the land mask.
const split=[way([[5,-1],[5,5]]),way([[5,5],[5,11]])];
assert.deepEqual(plain(C.landGeometry(split,b)),plain(C.landGeometry([oceanCoast],b)));
// Concave coast, repeated frame crossings and a coast through a frame corner.
for(const points of [ [[-1,2],[4,2],[4,4],[-1,4]], [[-1,1],[6,1],[6,3],[-1,3]], [[-1,-1],[5,5],[11,11]] ]) {
  const result=C.analyze([full],C.landGeometry([way(points)],b))[0];
  assert.ok(result.landSquareMeters>0&&result.seaSquareMeters>0);
}

const url=new URL("https://example.test/api/coastline?bbox=0,0,10,10");
assert.match(coastlineQuery(url),/natural.*coastline/);
assert.ok(!coastlineQuery(url).includes('natural"="water'),"inland water is never queried as ocean");
for(const bbox of ["",",0,10,10","0,0,NaN,1","0,0,80,1","10,0,0,1","0,-90,10,1","0,0,1,1;out;"])
  assert.throws(()=>coastlineQuery(new URL(`https://example.test/api/coastline?${new URLSearchParams({bbox})}`)));
const originalFetch=globalThis.fetch;
const payload={elements:[{type:"count",tags:{total:"1"}},oceanCoast],osm3s:{timestamp_osm_base:"2026-11-03T01:02:03Z"}};
try {
  for(const [body,status] of [[payload,200],[{...payload,remark:"timeout"},502],
    [{elements:[{type:"count",tags:{total:"2"}},oceanCoast]},502],
    [{elements:[{type:"count",tags:{total:"12001"}}]},413],
    [{elements:[oceanCoast]},502],
    [{elements:[{type:"count",tags:{total:"1"}},{...oceanCoast,geometry:[]}]},502],
    [{elements:[{type:"count",tags:{total:"0"}}]},200]]) {
    globalThis.fetch=async ()=>new Response(JSON.stringify(body));
    const response=await worker.fetch(new Request(url),{},{});
    assert.equal(response.status,status);
    const result=await response.json();
    if(status===200){assert.ok(result.fetchedAt);assert.equal(result.elements.length,Number(body.elements[0].tags.total));}
    if(body===payload)assert.equal(result.sourceTimestamp,payload.osm3s.timestamp_osm_base);
  }
  globalThis.fetch=async ()=>{throw Error("network error");};
  assert.equal((await worker.fetch(new Request(url),{},{})).status,502,"failed source reads cannot become empty land");
  assert.equal((await worker.fetch(new Request(url,{method:"POST"}),{},{})).status,405);
}finally{globalThis.fetch=originalFetch;}

// Worker lifecycle: cancellation stops both computation and any asynchronous
// classification probe; a late result cannot update a completed request.
const workers=[];
class FakeWorker {
  constructor(){this.messages=[];this.terminated=false;workers.push(this);}
  postMessage(message){this.messages.push(message);}
  terminate(){this.terminated=true;}
}
const clientContext=vm.createContext({Worker:FakeWorker,AbortController,DOMException,setTimeout,clearTimeout});clientContext.window=clientContext;
vm.runInContext(await readFile(new URL("../site/coastline-client.js",import.meta.url),"utf8"),clientContext);
const client=clientContext.HuayuCoastlineClient;
let pending=client.analyze([full],{part:"sea"});let current=workers.at(-1);
assert.equal(current.messages[0].part,"sea");
current.onmessage({data:{type:"result",rows:[1],metadata:{}}});
assert.deepEqual(plain((await pending).rows),[1]);assert.equal(current.terminated,true);
const controller=new AbortController();pending=client.analyze([full],{signal:controller.signal});current=workers.at(-1);
controller.abort();await assert.rejects(pending,{name:"AbortError"});assert.equal(current.terminated,true);
current.onmessage({data:{type:"result",rows:[2]}});
let seedSignal,resolveSeed;
pending=client.analyze([full],{signal:new AbortController().signal,seed:(_b,signal)=>{seedSignal=signal;return new Promise(resolve=>{resolveSeed=resolve;});}});
current=workers.at(-1);const seedMessage=current.onmessage({data:{type:"seed",bounds:b}});
current.onerror();await assert.rejects(pending,/后台组件/);assert.equal(seedSignal.aborted,true);
resolveSeed({land:true,metadata:{}});await seedMessage;
assert.equal(current.messages.length,1,"late seed cannot restart a terminated worker");
assert.equal(current.terminated,true);
// Execute the real browser Worker entry point too, including the no-coastline
// classification handshake: the selected part must survive that second message.
const workerSource=await readFile(new URL("../site/coastline-worker.js",import.meta.url),"utf8");
for(const [part,elements,seedLand] of [["sea",[oceanCoast,island],null],["sea",[],true],["sea",[],false],[undefined,[oceanCoast],null]]) {
  const messages=[];
  const wc=vm.createContext({AbortSignal,TextEncoder,URLSearchParams,importScripts:()=>{},
    fetch:async()=>new Response(JSON.stringify({elements,fetchedAt:"2026-11-03T01:00:00Z"})),
    self:{postMessage:message=>messages.push(message)}});
  for(const file of ["vendor/polygon-clipping-0.15.7.js","coastline.js"])vm.runInContext(await readFile(new URL(`../site/${file}`,import.meta.url),"utf8"),wc);
  vm.runInContext(workerSource,wc);
  await wc.self.onmessage({data:{type:"analyze",features:[full],part}});
  if(seedLand!==null) {
    assert.equal(messages.at(-1).type,"seed");
    await wc.self.onmessage({data:{type:"seed",land:seedLand,metadata:{sourceBuildTime:"2026-03-28"}}});
  }
  const result=messages.at(-1);
  assert.equal(result.type,"result",result.message);
  assert.equal(result.metadata.part,part||"land");
  const row=result.rows[0];
  assert.equal(row.feature.properties.derived,`coastline-${part||"land"}-v1`);
  if(seedLand===true)assert.equal(row.feature.geometry.coordinates.length,0);
  if(seedLand===false)assert.equal(row.feature.properties.area_square_meters,row.totalSquareMeters);
}
console.log("Coastline export passed: land/sea complements, islands and administrative holes, inland-water exclusion from sea, all-land/all-sea classification, real Worker selection and seed handshake, cancellation, immutable boundaries, bounded API and truthful source time.");
