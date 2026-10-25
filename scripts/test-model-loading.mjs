import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {courtyardGateWays} from "./fixtures/wall-gates.mjs";
import {roofShapeElements} from "./fixtures/roof-shapes.mjs";
import {raisedSkillionRoof} from "./fixtures/roof-only.mjs";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const declaration = name => {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const factory = vm.createContext({});
const names = declaration("huayuModelTileWorkerSource").match(/const functions = \[([^]*?)\];/u)[1]
  .split(",").map(name => name.trim());
for (const name of [...names, "createHuayuGardenModels", "huayuModelEntryBytes", "huayuModelTileWorkerMain", "huayuModelTileWorkerSource"]) {
  vm.runInContext(declaration(name), factory);
}
const workerSource = factory.huayuModelTileWorkerSource();
const records = new Map();
const usageRecords = new Map();
let modelBlobReads = 0, modelBlobWrites = 0;
let denied = false;
const indexedDB = {open() {
  if (denied) throw new Error("storage denied");
  const request = {};
  setImmediate(() => {
    request.result = {transaction() {
      const transaction = {};
      let pending = 0;
      const operation = action => {
        pending++;
        const result = {};
        setImmediate(() => {
          result.result = action(); result.onsuccess?.(); pending--;
          if (!pending) transaction.oncomplete?.();
        });
        return result;
      };
      transaction.objectStore = name => {
        const values = name === "usage" ? usageRecords : records;
        return {
          get:key => operation(() => {if(name === "tiles") modelBlobReads++; return structuredClone(values.get(key));}),
          put:entry => operation(() => {if(name === "tiles") modelBlobWrites++; values.set(entry.key, structuredClone(entry));}),
          delete:key => operation(() => values.delete(key)),
          getAll:() => operation(() => [...values.values()].map(value => structuredClone(value))),
        };
      };
      return transaction;
    }};
    request.onsuccess();
  });
  return request;
}};
let answer;
let modelNow;
class ModelDate extends Date {static now() {return modelNow ?? Date.now();}}
const worker = vm.createContext({indexedDB, setTimeout, clearTimeout, Date:ModelDate,
  self:{postMessage(value) {answer = value;}}});
vm.runInContext(workerSource, worker);
let sequence = 0;
const request = async job => {
  await worker.self.onmessage({data:{...job, id:++sequence}});
  assert.equal(answer.error, undefined);
  return answer.result;
};
const closedWay = (id, tags, x = 0) => ({type:"way", id, tags,
  geometry:[{lon:x,lat:0},{lon:x+0.0001,lat:0},{lon:x+0.0001,lat:0.0001},
    {lon:x,lat:0.0001},{lon:x,lat:0}]});
const elements = [closedWay(1, {building:"yes", name:"兰亭大厦", color:"FFAA00", height:"15"}),
  closedWay(2, {building:"pavilion", height:"4"}, 0.001),
  {type:"node", id:3, lon:0.002, lat:0.001, tags:{leisure:"gazebo", height:"3.5"}},
  {type:"way", id:4, tags:{barrier:"wall", height:"2"},
    geometry:[{lon:0,lat:0},{lon:0.001,lat:0.001}]},
  closedWay(5, {building:"roof", amenity:"shelter", shelter_type:"public_transport"}, 0.003),
  closedWay(6, {building:"yes", amenity:"shelter", height:"5"}, 0.004),
  {type:"node",id:7,lon:0.005,lat:0.001,tags:{amenity:"shelter"}},...courtyardGateWays];
const text = JSON.stringify({elements});
for (const kind of ["building", "structure"]) {
  const prepared = await request({action:"decode", kind, text});
  const expected = kind === "building" ? {data:factory.huayuLiveBuildingFeatureCollection(elements)}
    : {pavilionData:factory.huayuPavilionFeatureCollection(elements), wallData:factory.huayuWallFeatureCollection(elements)};
  const {cacheBytes, ...geometry} = prepared;
  assert.ok(cacheBytes > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(geometry)), JSON.parse(JSON.stringify(expected)),
    "background models must exactly preserve ordinary buildings, pavilion hollows, colours and walls");
  if (kind === "building") {
    assert.equal(prepared.data.features.length, 1);
    assert.equal(prepared.data.features[0].properties.color, "#ffaa00");
  } else {
    assert.equal(prepared.pavilionData.features.length, 12);
    assert.ok(prepared.pavilionData.features.some(feature=>feature.properties.osmId==="6"
      && feature.properties.pavilionPart==="roof" && feature.properties.renderHeight===5
      && feature.properties.renderMinHeight>4),"background decoding preserves the newly supported open shelter");
    assert.ok(prepared.wallData.features.length > 0);
    const gate=prepared.wallData.features.find(feature=>feature.properties.wallPart==="gate-lintel");
    assert.equal(gate?.properties.osmId,"41637302");
    assert.equal(gate.properties.minHeight,3.2,"background decoding retains real opening clearance");
  }
  const entry = {...prepared, loadedAt:Date.now(), cachedAt:Date.now()};
  assert.equal(await request({action:"write", kind, key:"15/123/456", entry}), true);
  assert.ok(await request({action:"read", kind, key:"15/123/456"}), "reopening must restore prepared models");
}
const roofDecoded=await request({action:"decode",kind:"building",text:JSON.stringify({elements:roofShapeElements})});
assert.deepEqual(JSON.parse(JSON.stringify(roofDecoded.data)),JSON.parse(JSON.stringify(factory.huayuLiveBuildingFeatureCollection(roofShapeElements))),
  "all 19 roof tags, curved footprints and orientation metadata match background decoding");
const canopyDecoded = await request({action:"decode",kind:"building",text:JSON.stringify({elements:[raisedSkillionRoof]})});
assert.deepEqual(JSON.parse(JSON.stringify(canopyDecoded.data)),
  JSON.parse(JSON.stringify(factory.huayuLiveBuildingFeatureCollection([raisedSkillionRoof]))), "屋顶独占高度在后台与前端完全一致");
assert.equal(canopyDecoded.data.features[0].properties.roofOnly, 1);
assert.equal(canopyDecoded.data.features[0].properties.renderMinHeight, 4);
assert.equal(canopyDecoded.data.features[0].properties.renderHeight, 4.5);
const readWrites = modelBlobWrites;
const readAge = [...records.values()][0].cachedAt;
await request({action:"read", kind:"building", key:"15/123/456"});
await new Promise(resolve => setImmediate(resolve));
assert.equal(modelBlobWrites, readWrites, "returning touches metadata without rewriting large geometry blobs");
assert.equal([...records.values()][0].cachedAt, readAge);

modelNow = Date.now();
const modelEpoch = modelNow;
for (const kind of ["building", "structure", "garden"]) {
  modelNow = modelEpoch;
  await request({action:"write", kind, key:"refresh-boundary", entry:{data:{features:[]},cachedAt:modelEpoch}});
  modelNow = modelEpoch + 119999;
  assert.ok(await request({action:"read",kind,key:"refresh-boundary"}));
  modelNow = modelEpoch + 120000;
  const cached = await request({action:"read",kind,key:"refresh-boundary"});
  if (kind === "garden") {
    assert.ok(cached, "the model refresh change preserves garden's three-hour cache");
    modelNow = modelEpoch + 3 * 60 * 60 * 1000;
    assert.equal(await request({action:"read",kind,key:"refresh-boundary"}), null);
  } else assert.equal(cached, null, "old prepared building/structure caches expire at exactly two minutes");
}
modelNow = modelEpoch;
await request({action:"write",kind:"structure",key:"retained-stale",entry:{data:{features:[]},
  cachedAt:modelEpoch - 180000,loadedAt:modelEpoch - 180000,refreshAt:modelEpoch + 30000}});
modelNow += 29999;
assert.ok(await request({action:"read",kind:"structure",key:"retained-stale"}));
modelNow++;
assert.equal(await request({action:"read",kind:"structure",key:"retained-stale"}),null,
  "stale source is only reused until its short recheck deadline, never another full model TTL");
modelNow = undefined;
for (const key of [...records.keys()]) if (key.endsWith("/refresh-boundary") || key.endsWith("/retained-stale")) {
  records.delete(key); usageRecords.delete(key);
}

// Walking through many districts used to evict at 144 records. Keep 1024
// lightweight tiles, protect recently revisited tiles, and bound dense blobs.
const small = {data:{type:"FeatureCollection",features:[]},cachedAt:Date.now(),cacheBytes:1024};
for (let i=0;i<1030;i++) {
  if (i===1023) {
    await request({action:"read",kind:"building",key:"district-0"});
    await new Promise(resolve => setImmediate(resolve));
  }
  await request({action:"write",kind:"building",key:`district-${i}`,entry:{...small}});
}
assert.equal(records.size,1024);
assert.ok(await request({action:"read",kind:"building",key:"district-0"}),"recent revisit must survive LRU eviction");
assert.equal(await request({action:"read",kind:"building",key:"district-1"}),null);
const readsBeforePruning = modelBlobReads;
for(let i=0;i<5;i++) await request({action:"write",kind:"structure",key:`dense-${i}`,
  entry:{pavilionData:{features:[]},wallData:{features:[]},cachedAt:Date.now(),cacheBytes:80*1024*1024}});
assert.ok([...usageRecords.values()].reduce((sum,entry)=>sum+entry.bytes,0)<=256*1024*1024);
assert.equal(modelBlobReads,readsBeforePruning,"capacity checks must read metadata, not clone all stored models");
const expiredKey=[...usageRecords.keys()].find(key=>key.endsWith("/structure/dense-3"));
usageRecords.get(expiredKey).cachedAt-=4*60*60*1000;
usageRecords.get(expiredKey).lastUsed=Date.now()+1000;
await request({action:"write",kind:"structure",key:"dense-new",
  entry:{pavilionData:{features:[]},wallData:{features:[]},cachedAt:Date.now(),cacheBytes:60*1024*1024}});
assert.ok(await request({action:"read",kind:"structure",key:"dense-2"}),
  "expired blobs must be removed before evicting valid recently used geometry to meet the byte budget");
for (const entry of records.values()) entry.cachedAt -= 4 * 60 * 60 * 1000;
assert.equal(await request({action:"read", kind:"structure", key:"dense-4"}), null,
  "cache reads must not reset source age and suppress refreshes");
await worker.self.onmessage({data:{action:"decode", kind:"building", text:JSON.stringify({elements,remark:"timeout"})}});
assert.equal(answer.error, "INCOMPLETE_MODEL_TILE", "incomplete upstream data must not replace a snapshot");
// Changing a geometry dependency automatically prevents old prepared models from being reused.
for (const entry of records.values()) entry.cachedAt = Date.now();
const restored = await request({action:"decode",kind:"structure",text});
await request({action:"write",kind:"structure",key:"15/123/456",entry:{...restored,cachedAt:Date.now()}});
assert.ok(await request({action:"read",kind:"structure",key:"15/123/456"}),"algorithm invalidation fixture must exist before changing the worker");
// Upgrade the previous schema in place: the existing model and its original
// age survive, while small usage metadata is created for capacity accounting.
const legacyKey=[...records.keys()].find(key=>key.endsWith("/structure/15/123/456"));
const legacyEntry=structuredClone(records.get(legacyKey));
const migratedUsage=new Map();
let migratedVersion;
const migrationIndexedDB={open(_name,version){
  migratedVersion=version;
  const opening={};
  const usageStore={put:entry=>migratedUsage.set(entry.key,structuredClone(entry))};
  opening.result={objectStoreNames:{contains:name=>name==="tiles"},
    createObjectStore:name=>{assert.equal(name,"usage");return usageStore;},
    transaction:()=>({objectStore:name=>name==="usage"?usageStore:{get(){
      const reading={};setImmediate(()=>{reading.result=structuredClone(legacyEntry);reading.onsuccess();});return reading;
    }}})};
  opening.transaction={objectStore:()=>({openCursor(){
    const cursor={};setImmediate(()=>{cursor.result={value:legacyEntry,continue(){
      setImmediate(()=>{cursor.result=null;cursor.onsuccess();opening.onsuccess();});
    }};cursor.onsuccess();});return cursor;
  }})};
  setImmediate(()=>opening.onupgradeneeded());return opening;
}};
const upgraded=vm.createContext({indexedDB:migrationIndexedDB,setTimeout,clearTimeout,
  self:{postMessage:value=>{answer=value;}}});
vm.runInContext(workerSource,upgraded);
await upgraded.self.onmessage({data:{action:"read",kind:"structure",key:"15/123/456"}});
assert.equal(migratedVersion,2);
assert.equal(answer.result.cachedAt,legacyEntry.cachedAt,"schema migration must preserve original data age");
assert.ok(migratedUsage.get(legacyKey).bytes>0,"legacy model participates in the new storage budget");
const changed = vm.createContext({indexedDB, setTimeout, clearTimeout, self:{postMessage(value) {answer = value;}}});
vm.runInContext(workerSource.replace("function huayuPavilionColumnRing(",
  "function huayuPavilionColumnRing(/* cache-version-regression */"), changed);
await changed.self.onmessage({data:{action:"read", kind:"structure", key:"15/123/456"}});
assert.equal(answer.result, null);
denied = true;
const unavailable = vm.createContext({indexedDB, setTimeout, clearTimeout, self:{postMessage(value) {answer = value;}}});
vm.runInContext(workerSource, unavailable);
await unavailable.self.onmessage({data:{action:"read", kind:"building", key:"anything"}});
assert.equal(answer.result, null);
await unavailable.self.onmessage({data:{action:"decode", kind:"building", text}});
assert.equal(answer.error, undefined, "denied storage must not prevent rendering");

const selection = vm.createContext({clamp:(value, min, max) => Math.min(max, Math.max(min, value)),
  HUAYU_LIVE_BUILDING_MIN_TILE_ZOOM:11, HUAYU_LIVE_BUILDING_MAX_TILE_ZOOM:15,HUAYU_MODEL_VIEW_TILE_LIMIT:32,
  huayuAdministrativeQueryBounds:map=>map.getBounds()});
for (const name of ["huayuLiveBuildingTileZoom", "huayuLiveBuildingTileAt", "huayuLiveBuildingVisibleTiles",
  "huayuLiveBuildingTileBounds","huayuModelEntryBytes","huayuModelTileWindow","huayuModelWindowTiles",
  "huayuModelDetailView","huayuModelDetailTiles","selectHuayuModelTiles","rememberHuayuModelTileCost","huayuModelCoverage","huayuModelFeatureInside"])
  vm.runInContext(declaration(name), selection);
const bounds = {west:155.9, east:156.3, south:11.95, north:12.2};
const coarse = selection.huayuLiveBuildingTileZoom({getZoom:() => 11});
assert.ok(selection.huayuLiveBuildingVisibleTiles(bounds, coarse).length
  < selection.huayuLiveBuildingVisibleTiles(bounds, 12).length);
assert.equal(selection.huayuLiveBuildingTileZoom({getZoom:() => 16}), 15,
  "close views must keep the original full-detail tile level");

// A horizon-sized footprint must not enumerate/queue hundreds of detailed
// tiles. Dense views shrink complete windows rather than punching model holes.
const horizon={west:152.7,east:153.2,south:14.4,north:14.9};
const camera={getBounds:()=>horizon,getZoom:()=>15,getCenter:()=>({lng:152.93546,lat:14.63852})};
const detailState={tileCache:new Map(),pendingTiles:new Map(),queue:[],tileZoom:15};
let detail=selection.huayuModelDetailTiles(camera,detailState,12*1024*1024);
assert.ok(detail.length>0 && detail.length<=32);
const focus=selection.huayuLiveBuildingTileAt(152.93546,14.63852,15);
assert.ok(detail.some(t=>t.key===focus.key),"nearby buildings remain the priority at the horizon");
const frozenView=selection.huayuModelDetailView(camera), originalCenter=camera.getCenter;
camera.getCenter=()=>({lng:0,lat:0});
assert.deepEqual(selection.huayuModelDetailTiles(frozenView,detailState,12*1024*1024).map(t=>t.key),detail.map(t=>t.key),
  "arriving data during a gesture uses the settled view rather than chasing every camera frame");
camera.getCenter=originalCenter;
for(const tile of detail)detailState.tileCache.set(tile.key,{cacheBytes:1024*1024});
detail=selection.huayuModelDetailTiles(camera,detailState,4*1024*1024);
assert.ok(detail.length>0 && detail.length<=4,"required visible tiles obey the byte budget too");
assert.equal(selection.huayuModelWindowTiles(selection.huayuModelTileWindow(detail.map(t=>t.key))).length,detail.length,
  "the budgeted region is contiguous and complete");
let aborted=false;
detailState.pendingTiles.set("old",{controller:{abort:()=>{aborted=true;}}});
detailState.queue=[{key:"old"},detail[0]];
selection.selectHuayuModelTiles(detailState,detail);
assert.equal(aborted,true);assert.equal(detailState.queue.length,1);
detailState.tileCache.clear();
selection.rememberHuayuModelTileCost(detailState,focus.key,{cacheBytes:20*1024*1024});
assert.equal(selection.huayuModelDetailTiles(camera,detailState,12*1024*1024).length,0,
  "an oversized near tile stays on the native fallback instead of reloading in a loop");
const wrapped=selection.huayuModelCoverage(["15/32767/16000","15/0/16000"]);
assert.equal(wrapped.coordinates.length,2,"ownership wraps at the date line without claiming the whole world");
const coverage={type:"MultiPolygon",coordinates:[[[[0,0],[2,0],[2,2],[0,2],[0,0]]]]};
const shape=points=>({geometry:{type:"Polygon",coordinates:[points]}});
assert.equal(selection.huayuModelFeatureInside(shape([[.1,.1],[1,.1],[1,1],[.1,.1]]),coverage),true);
assert.equal(selection.huayuModelFeatureInside(shape([[1,1],[3,1],[3,2],[1,1]]),coverage),false,
  "edge-crossing buildings retain a whole native fallback, not clipped detail roofs");

// Exercise asynchronous completion, not only cancellation of the HTTP request:
// even a server/cache that resolves after abort cannot repopulate old regions.
let finishTile;
const pumps=vm.createContext({AbortController,
  HUAYU_LIVE_BUILDING_TILE_CONCURRENCY:3,HUAYU_STRUCTURE_TILE_CONCURRENCY:3,
  HUAYU_BUILDING_SOURCE_BYTES:12*1024*1024,HUAYU_STRUCTURE_SOURCE_BYTES:4*1024*1024,
  HUAYU_LIVE_BUILDING_CACHE_MS:120000,HUAYU_STRUCTURE_CACHE_MS:120000,
  huayuLiveBuildingTileRevision:0,huayuStructureTileRevision:0,
  loadHuayuModelTile:()=>new Promise(resolve=>{finishTile=resolve;}),fetchHuayuLiveBuildingTile:()=>{},fetchHuayuStructureTile:()=>{},
  rememberHuayuModelTileCost:selection.rememberHuayuModelTileCost,huayuModelEntryBytes:selection.huayuModelEntryBytes,
  selectHuayuModelTiles:selection.selectHuayuModelTiles,huayuModelDetailTiles:selection.huayuModelDetailTiles,
  pruneHuayuLiveBuildingTileCache:()=>{},pruneHuayuStructureTileCache:()=>{},
  updateHuayuLiveBuildingDiagnostics:()=>{},updateHuayuStructureDiagnostics:()=>{},
  mergeHuayuLiveBuildingTiles:()=>{},mergeHuayuStructureTiles:()=>{},
  scheduleNextHuayuLiveBuildingRefresh:()=>{},scheduleNextHuayuStructureRefresh:()=>{},
  scheduleHuayuLiveBuildings:()=>{},scheduleHuayuStructures:()=>{}});
for(const name of ["pumpHuayuLiveBuildingTiles","pumpHuayuStructureTiles"])vm.runInContext(declaration(name),pumps);
for(const name of ["pumpHuayuLiveBuildingTiles","pumpHuayuStructureTiles"]){
  const state={active:true,glMap:camera,tileCache:new Map(),visibleTileKeys:new Set([focus.key]),
    queue:[focus],queuedTileKeys:new Set([focus.key]),pendingTiles:new Map(),failedTiles:new Map(),tileZoom:15};
  pumps[name](state);
  state.visibleTileKeys.clear();state.pendingTiles.get(focus.key).controller.abort();
  finishTile({data:{features:[]},pavilionData:{features:[]},wallData:{features:[]},cacheBytes:1024});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.tileCache.size,0);assert.equal(state.pendingTiles.size,0);
  assert.equal(state.requestCount||0,0,"late discarded work cannot count as an accepted model load");
  state.visibleTileKeys=new Set([focus.key]);state.queue=[focus];state.queuedTileKeys=new Set([focus.key]);
  pumps[name](state);
  finishTile({data:{features:[]},pavilionData:{features:[]},wallData:{features:[]},cacheBytes:20*1024*1024});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.tileCache.size,0,"an oversized completed tile is not admitted to model memory");
  assert.equal(state.visibleTileKeys.size,0,"oversized region falls back without an endless missing-tile queue");
  assert.ok(state.tileCosts.get(focus.key).bytes>12*1024*1024);
}

// A completed cached result avoids network; cancellation and slow storage remain bounded.
let fetches = 0;
const loader = vm.createContext({window:{setTimeout,clearTimeout}, DOMException, AbortController,
  huayuModelEntryBytes:factory.huayuModelEntryBytes,
  getHuayuModelTileWorker:() => ({request:async () => ({data:{features:[]}, cachedAt:Date.now()})})});
vm.runInContext(declaration("loadHuayuModelTile"), loader);
const result = await loader.loadHuayuModelTile("building", {key:"tile"}, async () => {fetches++;}, {aborted:false});
assert.equal(result.source, "browser-cache");
assert.equal(fetches, 0);
await assert.rejects(loader.loadHuayuModelTile("building", {key:"tile"}, async () => {}, {aborted:true}),
  error => error.name === "AbortError");
loader.getHuayuModelTileWorker = () => ({request:job => job.action === "read"
  ? new Promise(() => {}) : Promise.resolve(true)});
await loader.loadHuayuModelTile("building", {key:"tile"}, async () => {
  fetches++; return {data:{features:[]},loadedAt:Date.now()};
}, {aborted:false});
assert.equal(fetches, 1, "slow cache startup must not block live model loading");
loader.getHuayuModelTileWorker = () => null;
const oldFetchedAt = Date.now() - 110000, deadline = oldFetchedAt + 120000;
const fromEdge = await loader.loadHuayuModelTile("building",{key:"edge-hit"},async () => ({data:{features:[]},
  loadedAt:oldFetchedAt,refreshAt:deadline}),new AbortController().signal);
assert.equal(fromEdge.cachedAt,oldFetchedAt,"decoding a network hit must preserve source data age");
assert.equal(fromEdge.refreshAt,deadline,"a late edge hit cannot earn a new two-minute lifetime");

// Exercise the actual client API and stationary refresh scheduling with a controlled clock.
const apiCalls = [], scheduled = [], epoch = Date.now();
class ApiDate extends Date {static now() {return epoch;}}
let apiKind = "building", apiStatus = "HIT";
const liveClient = vm.createContext({Date:ApiDate,AbortController,
  window:{location:{protocol:"https:"},setTimeout,clearTimeout},
  HUAYU_LIVE_BUILDING_CACHE_MS:120000,HUAYU_STRUCTURE_CACHE_MS:120000,
  decodeHuayuModelTile:async () => ({data:{features:[]}}),
  fetch:async (url,options) => {apiCalls.push({url,options});return new Response("{}",{headers:{
    [`X-OGF-${apiKind === "building" ? "Building" : "Structure"}-Cache`]:apiStatus,
    [`X-OGF-${apiKind === "building" ? "Building" : "Structure"}-Fetched-At`]:new Date(epoch-110000).toISOString(),
  }});},
  scheduleHuayuLiveBuildings:(_map,delay) => scheduled.push(delay),scheduleHuayuStructures:(_map,delay) => scheduled.push(delay),
});
for (const name of ["fetchHuayuLiveBuildingTile","fetchHuayuStructureTile","huayuLiveBuildingEntryFresh","huayuStructureEntryFresh",
  "scheduleNextHuayuLiveBuildingRefresh","scheduleNextHuayuStructureRefresh"]) vm.runInContext(declaration(name),liveClient);
for (const kind of ["building","structure"]) {
  apiKind=kind;
  const value = await liveClient[kind === "building" ? "fetchHuayuLiveBuildingTile" : "fetchHuayuStructureTile"]({z:15,x:1,y:1});
  assert.equal(value.refreshAt,epoch+10000);
  assert.equal(apiCalls.at(-1).options.cache,"no-cache");
  assert.ok(apiCalls.at(-1).url.includes("refresh=live-2m"),"old long-lived browser HTTP responses use a different key");
  const fresh = liveClient[kind === "building" ? "huayuLiveBuildingEntryFresh" : "huayuStructureEntryFresh"];
  assert.equal(fresh({cachedAt:epoch-119999}),true);
  assert.equal(fresh({cachedAt:epoch-120000}),false);
  assert.equal(fresh({cachedAt:epoch-5000,refreshAt:epoch-1}),false);
  const state={active:true,coverageReady:true,glMap:{},visibleTileKeys:new Set(["tile"]),pendingTiles:new Map(),queuedTileKeys:new Set(),
    failedTiles:new Map(),tileCache:new Map([["tile",{cachedAt:epoch-110000,refreshAt:value.refreshAt}]])};
  const schedule = liveClient[kind === "building" ? "scheduleNextHuayuLiveBuildingRefresh" : "scheduleNextHuayuStructureRefresh"];
  schedule(state); assert.equal(scheduled.at(-1),10000,"a stationary view refreshes at the source's original expiry");
  state.tileCache.get("tile").refreshAt=epoch-1;state.failedTiles.set("tile",epoch);
  schedule(state);assert.equal(scheduled.at(-1),15000,"failed source refreshes are limited instead of polling every second");
  const count=scheduled.length;state.pendingTiles.set("tile",{});schedule(state);assert.equal(scheduled.length,count);
}
apiKind="structure";apiStatus="STALE";
const retained=await liveClient.fetchHuayuStructureTile({z:15,x:1,y:1});
assert.equal(retained.refreshAt,epoch+30000,"retained edge results trigger a short recheck");
let redundantAborted=false;
const lateCache=vm.createContext({DOMException,AbortController,
  window:{setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5)),clearTimeout},
  huayuModelEntryBytes:factory.huayuModelEntryBytes,
  getHuayuModelTileWorker:()=>({request:()=>new Promise(resolve=>setTimeout(()=>resolve({
    data:{features:[]},cachedAt:Date.now()}),20))})});
vm.runInContext(declaration("loadHuayuModelTile"),lateCache);
const lateResult=await lateCache.loadHuayuModelTile("building",{key:"late"},async (_tile,signal)=>
  new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>resolve({data:{features:[]},loadedAt:Date.now()}),100);
    signal.addEventListener("abort",()=>{clearTimeout(timer);redundantAborted=true;reject(new DOMException("Aborted","AbortError"));});
  }),new AbortController().signal);
assert.equal(lateResult.source,"browser-cache","a delayed valid cache must still beat a slower network response");
assert.equal(redundantAborted,true,"late cache reuse cancels the redundant API request");

let commits=0;
const residency=vm.createContext({HUAYU_LIVE_BUILDING_TILE_CACHE_LIMIT:256,
  HUAYU_BUILDING_SOURCE_BYTES:12*1024*1024,HUAYU_STRUCTURE_SOURCE_BYTES:4*1024*1024,
  HUAYU_LIVE_BUILDING_CACHE_BYTES:48*1024*1024,HUAYU_STRUCTURE_TILE_CACHE_LIMIT:256,
  HUAYU_STRUCTURE_CACHE_BYTES:16*1024*1024,applyHuayuLiveBuildings:()=>commits++,
  applyHuayuStructures:()=>commits++,updateHuayuLiveBuildingDiagnostics:()=>{},
  updateHuayuStructureDiagnostics:()=>{},syncHuayuLiveBuildingPrimaryLayers:()=>{},
  clearHuayuLiveBuildingPrimarySync:()=>{}});
for(const name of ["huayuModelEntryBytes","huayuModelTileWindow","huayuModelWindowTiles","huayuModelCoverage",
  "huayuLiveBuildingTileBounds","huayuModelFeatureInside","huayuModelResidentTiles","pruneHuayuModelTileCache",
  "pruneHuayuLiveBuildingTileCache","pruneHuayuStructureTileCache",
  "mergeHuayuLiveBuildingTiles","mergeHuayuStructureTiles"]) vm.runInContext(declaration(name),residency);
// Count source submissions, including the production no-op on an unchanged revision.
residency.applyHuayuLiveBuildings=residency.applyHuayuStructures=(_,state)=>{
  if(state.appliedRevision!==state.renderRevision){commits++;state.appliedRevision=state.renderRevision;}
};
const tileEntry=(id,revision=1,cacheBytes=2048)=>{
  const b=residency.huayuLiveBuildingTileBounds({z:15,x:id===3?200:100,y:id===3?200:100});
  const x=(b.west+b.east)/2,y=(b.north+b.south)/2;
  return {revision,cacheBytes,lastUsed:1,loadedAt:Date.now(),
    data:{features:[{id,geometry:{type:"Polygon",coordinates:[[[x,y],[x+.00001,y],[x,y+.00001],[x,y]]]},properties:{}}]},
    pavilionData:{features:[{id:`p-${id}`,properties:{}}]},wallData:{features:[]}};
};
for(const merge of ["mergeHuayuLiveBuildingTiles","mergeHuayuStructureTiles"]){
  const a="15/100/100",b="15/101/100",far="15/200/200";
  const state={tileCache:new Map([[a,tileEntry(1)],[b,tileEntry(1)],[far,tileEntry(3)]]),
    visibleTileKeys:new Set([a]),pendingTiles:new Map(),queuedTileKeys:new Set(),
    renderRevision:0,appliedRevision:-1,glMap:{},dataReady:false,snapshotReady:false};
  residency[merge](state);
  const first=commits, firstData=state.data||state.pavilionData;
  assert.equal(firstData.features.length,1,"overlapping tile features remain deduplicated");
  assert.equal(state.renderTileRevisions.size,2,"retain already visited neighbours, not distant districts");
  state.visibleTileKeys=new Set([b]);residency[merge](state);
  state.visibleTileKeys=new Set([a]);residency[merge](state);
  assert.equal(commits,first,"local A-B-A must reuse the resident source without reindexing/geometry upload");
  assert.equal(state.data||state.pavilionData,firstData);
  state.visibleTileKeys=new Set([far,"15/201/200"]);residency[merge](state);
  assert.equal(commits,first,"an incomplete replacement must retain the complete old model");
  state.visibleTileKeys=new Set([far]);residency[merge](state);
  assert.equal(state.renderTileRevisions.size,1);
  state.visibleTileKeys=new Set([a]);residency[merge](state);
  assert.equal(state.tileCache.size,3,"distant round trips retain parsed geometry");
  state.tileCache.get(a).revision++;
  const beforeUpdate=commits;residency[merge](state);
  assert.equal(commits,beforeUpdate+1,"refreshed tile geometry must replace the old resident model");
  state.interacting=true;state.tileCache.get(a).revision++;
  const beforeDrag=commits;residency[merge](state);
  assert.equal(commits,beforeDrag,"do not upload models during a drag");
}
const bounded={tileCache:new Map(),visibleTileKeys:new Set(["visible"]),pendingTiles:new Map(),
  renderTileRevisions:new Map([["resident",1]])};
for(let i=0;i<400;i++)bounded.tileCache.set(`visited-${i}`,tileEntry(i,1,1024));
bounded.tileCache.set("visible",tileEntry(401));bounded.tileCache.set("resident",tileEntry(402));
residency.pruneHuayuModelTileCache(bounded,256,48*1024*1024);
assert.equal(bounded.tileCache.size,256);
assert.ok(bounded.tileCache.has("visible")&&bounded.tileCache.has("resident"));
bounded.tileCache.set("old-dense",tileEntry(403,1,50*1024*1024));
residency.pruneHuayuModelTileCache(bounded,256,48*1024*1024);
assert.equal(bounded.tileCache.has("old-dense"),false,"byte budget prevents a few huge regions retaining unbounded memory");
const requiredDense={tileCache:new Map([["15/100/100",tileEntry(1,1,13*1024*1024)]]),
  renderTileRevisions:new Map([["15/100/100",1]])};
assert.equal(residency.huayuModelResidentTiles(requiredDense,["15/100/100"],12*1024*1024),null,
  "previously rendered/visible status cannot bypass the source byte limit");
let touches=[];
residency.getHuayuModelTileWorker=()=>({request:job=>{touches.push(job);return Promise.resolve(true);}});
vm.runInContext(declaration("touchHuayuModelTiles"),residency);
const touched={tileCache:new Map([["tile",{cachedAt:1000,loadedAt:1000}]])};
residency.touchHuayuModelTiles("building",touched,[{key:"tile"}],70000);
residency.touchHuayuModelTiles("building",touched,[{key:"tile"}],70001);
assert.equal(touches.length,1,"frequent camera movements must not rewrite disk metadata continuously");
assert.equal(touched.tileCache.get("tile").cachedAt,1000,"LRU use must not change source data age");
// Track the real controller in each view. Overhead camera synchronization
// emits artificial MapLibre gesture pairs that must not trigger data commits.
const emitter=()=>{
  const callbacks=new Map();
  return {on(name,fn){if(!callbacks.has(name))callbacks.set(name,new Set());callbacks.get(name).add(fn);},
    off(name,fn){callbacks.get(name)?.delete(fn);},
    once(name,fn){const once=(...args)=>{this.off(name,once);fn(...args);};this.on(name,once);},
    emit(name){for(const fn of [...(callbacks.get(name)||[])])fn();},
    listenerCount(){return [...callbacks.values()].reduce((sum,set)=>sum+set.size,0);}};
};
const leaflet=emitter(), vector=emitter();
const gestures=vm.createContext({map:leaflet,vectorPerspectiveActive:false,vectorPerspectiveMap:null});
for(const name of ["observeHuayuMapGestures","waitForHuayuMapGestureEnd"])vm.runInContext(declaration(name),gestures);
let starts=0,ends=0;
const unbind=gestures.observeHuayuMapGestures(vector,()=>starts++,()=>ends++);
leaflet.emit("movestart");
for(let frame=0;frame<20;frame++){vector.emit("movestart");vector.emit("moveend");}
assert.equal(starts,1);assert.equal(ends,0,"sync frames must not complete a real overhead drag");
leaflet.emit("moveend");assert.equal(ends,1);
gestures.vectorPerspectiveActive=true;gestures.vectorPerspectiveMap=vector;
vector.emit("movestart");assert.equal(starts,2);
let settled=false;
const afterGesture=gestures.waitForHuayuMapGestureEnd(vector).then(()=>{settled=true;});
leaflet.emit("moveend");await Promise.resolve();
assert.equal(settled,false,"a tilted-view result must wait for its actual MapLibre gesture");
vector.emit("moveend");await afterGesture;assert.equal(settled,true);
unbind();assert.equal(leaflet.listenerCount()+vector.listenerCount(),0,"switching views must release gesture listeners");
// Arriving track/field geometry must show while unrelated resources load.
const sportsLayers={runningOverview:"track",infieldOverview:"infield",fill:"sports-fill",
  markings:"markings",outline:"sports-outline"};
const sportsIds=["overview-fill","overview-outline",...Object.values(sportsLayers)];
const visibility=new Map(sportsIds.map(id=>[id,"none"]));
const sportsOrder=["building",...sportsIds];
let sportsStyleWrites=0;
const sportsMap={isStyleLoaded:()=>false,getStyle:()=>({layers:sportsOrder.map(id=>({id}))}),getLayersOrder:()=>sportsOrder,
  getLayer:id=>sportsOrder.includes(id),getLayoutProperty:id=>visibility.get(id),
  moveLayer:(id,before)=>{sportsOrder.splice(sportsOrder.indexOf(id),1);sportsOrder.splice(sportsOrder.indexOf(before),0,id);},
  setLayoutProperty:(id,_,value)=>{sportsStyleWrites++;visibility.set(id,value);}};
const sportsContext=vm.createContext({HUAYU_LIVE_BASEMAP_LAYERS:{sportsOverviewFill:"overview-fill",sportsOverviewOutline:"overview-outline"},
  HUAYU_SPORTS_LAYERS:sportsLayers,HUAYU_LIVE_BUILDING_LAYER:"building",HUAYU_VECTOR_BUILDING_LAYER_IDS:[],document:{getElementById:()=>null}});
for(const name of ["huayuSportsBuildingInsertionLayer","positionHuayuSportsBelowBuildings","syncHuayuSportsSnapshotLayers"])
  vm.runInContext(declaration(name),sportsContext);
sportsContext.syncHuayuSportsSnapshotLayers(sportsMap,{sportsDataReady:true});
assert.ok([...visibility.values()].every(value=>value==="visible"),"available sports must not wait for every source to become idle");
assert.equal(sportsOrder.at(-1),"building","available sports must remain under solid models while resources load");
const firstSportsWrites=sportsStyleWrites;
sportsContext.syncHuayuSportsSnapshotLayers(sportsMap,{sportsDataReady:true});
assert.equal(sportsStyleWrites,firstSportsWrites,"stable sports visibility must not resubmit seven style changes");
console.log("Model loading regressions passed: worker parity, 1024-tile disk LRU, byte budgets, expiry, resident round trips, safe replacement, storage fallback and gestures.");
