import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const context = vm.createContext({module:{exports:{}},exports:{},console,performance,
  TextDecoder,TextEncoder,URL,Blob,AbortController,setTimeout,clearTimeout});
const declaration = app.match(/  function huayuModelInsideExpression\([^]*?\n  \}/u)?.[0];
assert.ok(declaration);
vm.runInContext(declaration,context);
// Execute the expression implementation shipped with the map. A mock that
// pretends within supports polygons would miss the original roof regression.
const engine = await readFile(new URL("../site/maplibre-gl.js",import.meta.url),"utf8");
let exposed = engine.replace(/within:(\w+),distance:(\w+),/u,
  "within:$1,distance:(globalThis.__ownershipDistance=$2),");
const nativeDecoder = engine.match(/new ([\w$]+)\(new ([\w$]+)\(this.rawTileData\)\)\.layers/u);
assert.ok(nativeDecoder, "Locate the bundled vector tile decoder");
exposed = exposed.replace("const ju=Math.pow(2,13)",
  `globalThis.__decodeMvt=bytes=>new ${nativeDecoder[1]}(new ${nativeDecoder[2]}(bytes));const ju=Math.pow(2,13)`);
assert.notEqual(exposed,engine,"Locate the bundled style-expression registry");
vm.runInContext(exposed,context);
assert.equal(typeof context.__ownershipDistance,"function");
const rect = (west,south,east,north) => [[west,south],[east,south],[east,north],[west,north],[west,south]];
const coverage = {type:"MultiPolygon",coordinates:[[rect(0,0,2.8125,2)]]};
const distance = (area, crossing = []) => {
  const expression = context.huayuModelInsideExpression(area, crossing);
  assert.equal(expression[0],">");assert.equal(expression[2],0);
  assert.equal(expression[1][0],"distance");
  return context.__ownershipDistance.parse(expression[1],{error:message => {throw Error(message);}});
};
const project = ([lon,lat]) => ({x:(lon+180)/360*8192,
  y:(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2*8192});
const evaluate = (expression,rings,type="Polygon") => expression.evaluate({canonical:{z:0,x:0,y:0},
  canonicalID:() => ({z:0,x:0,y:0}),geometry:() => rings.map(ring=>ring.map(project)),geometryType:() => type});
const predicate = distance(coverage);
for (const [name,rings,inside] of [
  ["ordinary house",[rect(.3,.3,.5,.5)],true],
  ["outside",[rect(3.1,.3,3.3,.5)],false],
  ["crossing edge",[rect(2.7,.7,2.9,.9)],false],
  ["touching edge",[rect(2.6,1,2.8125,1.2)],false],
  ["two inside components",[rect(.6,.6,.8,.8),rect(1.1,1.1,1.3,1.3)],true],
  ["inside and outside components",[rect(.6,1.4,.8,1.6),rect(3.1,1.4,3.3,1.6)],false],
  ["courtyard",[rect(.9,.3,1.7,.8),rect(1,.4,1.6,.7).reverse()],true],
  ["window in a courtyard",[rect(-.2,-.2,3,2.2),rect(-.1,-.1,2.9,2.1).reverse()],false],
]) assert.equal(evaluate(predicate,rings)>0,inside,name);
assert.equal(evaluate(predicate,[[[1,1]]],"Point")>0,true,"point shelter inside");
assert.equal(evaluate(predicate,[[[3,1]]],"Point")>0,false,"point shelter outside");
assert.equal(evaluate(predicate,[[[1,1],[3,1]]],"LineString")>0,false,"crossing shelter line");
const wrapped = distance({type:"MultiPolygon",coordinates:[[rect(178,0,180,2)],[rect(-180,0,-178,2)]]});
for (const [west,east,inside] of [[179,179.3,true],[-179.3,-179,true],[177,177.3,false],[-177.3,-177,false],
  [177.9,178.1,false],[-178.1,-177.9,false]]) {
  assert.equal(evaluate(wrapped,[rect(west,.3,east,.5)])>0,inside,"date-line window");
}
assert.equal(context.huayuModelInsideExpression(null),false,"no complete coverage cannot claim buildings");
assert.equal(context.huayuModelInsideExpression({type:"MultiPolygon",coordinates:[]}),false);
const crossing = {type:"Feature",geometry:{type:"MultiPolygon",coordinates:[
  [rect(1,.5,1.2,.7)],[rect(2.7,.5,3,.7)],
]}};
const protectedParts = distance(coverage,[crossing]);
assert.equal(evaluate(protectedParts,[rect(1,.5,1.2,.7)])>0,false,
  "true source multipolygon members stay native together when another member crosses the window");
assert.equal(evaluate(protectedParts,[rect(2.7,.5,2.8,.7)])>0,false,
  "a tile-clipped native fragment must not partially replace its whole crossing source building");
assert.equal(evaluate(protectedParts,[rect(.3,.3,.5,.5)])>0,true,
  "unrelated complete buildings still transfer normally");

// Encode a tile-wide batch like OGF OpenMapTiles, then decode the result with
// the actual bundled engine, rather than a mock of our normalization code.
const tileSource = await readFile(new URL("../site/building-tiles.js",import.meta.url),"utf8");
const tileContext = vm.createContext({TextDecoder,TextEncoder,Uint8Array,console});
vm.runInContext(tileSource,tileContext);
const normalize = tileContext.HuayuBuildingTiles.normalizeTile;
const varint = value => {const out=[];do{const byte=value%128;value=Math.floor(value/128);out.push(byte+(value?128:0));}while(value);return out;};
const field = (tag,value,wire=2) => [...varint(tag*8+wire),...(wire===2?[...varint(value.length),...value]:varint(value))];
const text = value => [...new TextEncoder().encode(value)];
const encodeGeometry = rings => {
  const out=[];let x=0,y=0;
  for(const ring of rings){out.push(9);ring.forEach(([a,b],i)=>{
    if(i===1)out.push(...varint((ring.length-1)*8+2));
    out.push(...varint((a-x)*2^((a-x)>>31)),...varint((b-y)*2^((b-y)>>31)));x=a;y=b;
  });out.push(15);}return out;
};
const feature = (rings,type=3) => [...field(1,391555520,0),...field(2,[0,0,1,1]),
  ...field(3,type,0),...field(4,encodeGeometry(rings))];
const layer = (name,features) => field(3,[...field(15,2,0),...field(1,text(name)),
  ...features.flatMap(f=>field(2,f)),...field(3,text("render_height")),...field(3,text("render_min_height")),
  ...field(4,field(5,13,0)),...field(4,field(5,4,0)),...field(5,8192,0)]);
const a=[[100,100],[300,100],[300,300],[100,300]],hole=[[150,150],[150,250],[250,250],[250,150]],
  b=[[7000,7000],[7300,7000],[7300,7300],[7000,7300]],
  c=[[-120,20],[-30,20],[-30,130],[-120,130]];
const original=new Uint8Array([...layer("building",[feature([a,hole,b,c])]),...layer("water",[feature([a,b])])]).buffer;
const normalized=normalize(original);
const read = buffer => context.__decodeMvt(new Uint8Array(buffer));
const before=read(original),after=read(normalized);
assert.equal(before.layers.building.length,1);
assert.equal(after.layers.building.length,3,"unrelated merged buildings must be independently filterable");
const ringsOf = item => item.loadGeometry().map(ring=>ring.map(p=>[p.x,p.y]));
const expected = [[a,hole],[b],[c]].map(rings=>rings.map(ring=>[...ring,ring[0]]));
for(let i=0;i<3;i++){
  const f=after.layers.building.feature(i);
  assert.deepEqual(JSON.parse(JSON.stringify(ringsOf(f))),expected[i],"preserve exact tile vertices, winding and courtyard holes");
  assert.equal(f.id,391555520);assert.equal(f.properties.render_height,13);assert.equal(f.properties.render_min_height,4);
  assert.equal(f.extent,8192);assert.equal(f.type,3);
}
assert.equal(after.layers.water.length,1,"other layer batches must not be changed");
assert.deepEqual(ringsOf(after.layers.water.feature(0)),ringsOf(before.layers.water.feature(0)));
assert.equal(normalize(normalized),normalized,"a previously processed tile must not be converted again");
const single=new Uint8Array(layer("building",[feature([a,hole])])).buffer;
assert.equal(normalize(single),single,"single buildings keep their original tile bytes");
const noBuildings=new Uint8Array(layer("water",[feature([a,b])])).buffer;
assert.equal(normalize(noBuildings),noBuildings,"nonbuilding tile bytes remain identical");
for(const bytes of [[26,255],[255],...Array.from({length:8},(_,i)=>Array.from(new Uint8Array(original).slice(0,i)))]){
  const invalid=new Uint8Array(bytes).buffer;assert.equal(normalize(invalid),invalid,"damaged tiles retain original fallback, never a partial rewrite");
}
const tileCoverage={type:"MultiPolygon",coordinates:[[rect(-176,83,-160,85)]]};
const tilePredicate=distance(tileCoverage),toLonLat=([x,y])=>[x/8192*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/8192)))*180/Math.PI];
assert.equal(evaluate(tilePredicate,[a,hole,b,c].map(r=>[...r,r[0]].map(toLonLat)))>0,false,
  "one outside component reproduces the original all-or-nothing native batch bug");
assert.equal(evaluate(tilePredicate,expected[0].map(r=>r.map(toLonLat)))>0,true,
  "the inside building can transfer independently after splitting");
assert.equal(evaluate(tilePredicate,expected[1].map(r=>r.map(toLonLat)))>0,false,"far native fallback stays visible");

let protocol,installed=0,networkUrl,requestSignal;
const browser=vm.createContext({TextDecoder,TextEncoder,Uint8Array,DOMException,AbortController,setTimeout,clearTimeout,
  document:{currentScript:{src:"https://example.test/building-tiles.js?v=1"}},
  fetch:async (url,options)=>{networkUrl=url;requestSignal=options.signal;return {ok:true,arrayBuffer:async()=>original,
    headers:new Headers({"cache-control":"public, max-age=300","expires":"Thu, 05 Nov 2026 08:00:00 GMT"})};},
  Worker:class {postMessage({id,buffer}){queueMicrotask(()=>this.onmessage({data:{id,buffer:normalize(buffer)}}));}terminate(){}},
});
browser.window=browser;
vm.runInContext(tileSource,browser);
const api=browser.HuayuBuildingTiles,library={addProtocol(name,callback){assert.equal(name,"huayu-buildings");installed++;protocol=callback;}};
api.install(library);api.install(library);assert.equal(installed,1);
const url="https://ogf-tileserver-t5qifc5o4q-uc.a.run.app/data/openmaptiles/14/15152/7518.pbf";
const controller=new AbortController(),result=await protocol(api.request(url,"Tile"),controller);
assert.equal(networkUrl,url);assert.equal(requestSignal,controller.signal);
assert.equal(result.cacheControl,"public, max-age=300","preserve original cache freshness headers");
assert.equal(read(result.data).layers.building.length,3,"production protocol must actually use worker normalization");
for(const [candidate,type] of [[url,"Glyphs"],["https://other.test/data/openmaptiles/1.pbf","Tile"],
  [url.replace("/data/openmaptiles/14/15152/7518.pbf","/fonts/Noto/0-255.pbf"),"Tile"]])
  assert.equal(api.request(candidate,type).url,candidate,"unrelated requests must retain the original URL");
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(protocol(api.request(url,"Tile"),cancelled),error=>error.name==="AbortError",
  "cancelled requests cannot deliver a late tile to a removed map");
// Hold a real pending protocol request to exercise cancellation and failures
// after fetch, while preserving the original bytes for a complete fallback.
async function heldProtocol(WorkerClass) {
  const timers=new Map();let timerId=0,handler;
  const sandbox=vm.createContext({TextDecoder,Uint8Array,DOMException,
    setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),
    document:{currentScript:{src:"https://example.test/building-tiles.js"}},Worker:WorkerClass,
    fetch:async()=>({ok:true,arrayBuffer:async()=>original,headers:new Headers()}),
  });sandbox.window=sandbox;
  vm.runInContext(tileSource,sandbox);
  sandbox.HuayuBuildingTiles.install({addProtocol:(_name,callback)=>{handler=callback;}});
  const controller=new AbortController(),promise=handler(sandbox.HuayuBuildingTiles.request(url,"Tile"),controller);
  await new Promise(resolve=>setImmediate(resolve));
  return {timers,controller,promise};
}
let heldWorker;
class HeldWorker {constructor(){heldWorker=this;}postMessage(job){this.job=job;}terminate(){this.terminated=true;}}
const duringWorker=await heldProtocol(HeldWorker);
assert.ok(heldWorker.job,"tile is waiting in the worker before cancellation");
duringWorker.controller.abort();
await assert.rejects(duringWorker.promise,error=>error.name==="AbortError");
heldWorker.onmessage({data:{id:heldWorker.job.id,buffer:normalized}});
assert.equal(duringWorker.timers.size,0,"cancelled jobs remove their deadline and ignore late worker replies");
const failedWorker=await heldProtocol(HeldWorker);
heldWorker.onerror();
assert.equal((await failedWorker.promise).data,original,"worker failure returns the complete original tile");
assert.equal(heldWorker.terminated,true);assert.equal(failedWorker.timers.size,0);
const timedOut=await heldProtocol(HeldWorker);
for(const callback of [...timedOut.timers.values()])callback();
assert.equal((await timedOut.promise).data,original,"worker timeout preserves the native fallback");
const unavailable=await heldProtocol(undefined);
assert.equal((await unavailable.promise).data,original,"unavailable workers must not remove base buildings");
const rejected=await heldProtocol(class {postMessage(){throw Error("transfer failed");}});
assert.equal((await rejected.promise).data,original,"failed worker transfer preserves original bytes");
assert.ok(app.includes("transformRequest: isHuayuBasemapId(id) ? window.HuayuBuildingTiles?.request"));
assert.ok(app.includes("transformRequest: window.HuayuBuildingTiles?.request"),"independent Huayu exports use the same tile normalization");
const index=await readFile(new URL("../site/index.html",import.meta.url),"utf8");
assert.ok(index.indexOf('./building-tiles.js?v=')<index.indexOf('./app.js?v='),"tile protocol loads before the app");
console.log("Building ownership passed: native MVT batch splitting, exact vertices/holes/tags, complete windows, genuine crossing buildings, worker protocol, cancellation and fallback.");
