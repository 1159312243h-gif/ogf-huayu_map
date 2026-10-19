import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {courtyardGateWays} from "./fixtures/wall-gates.mjs";
import {roofShapeElements} from "./fixtures/roof-shapes.mjs";

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
const worker = vm.createContext({indexedDB, setTimeout, clearTimeout,
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
const readWrites = modelBlobWrites;
const readAge = [...records.values()][0].cachedAt;
await request({action:"read", kind:"building", key:"15/123/456"});
await new Promise(resolve => setImmediate(resolve));
assert.equal(modelBlobWrites, readWrites, "returning touches metadata without rewriting large geometry blobs");
assert.equal([...records.values()][0].cachedAt, readAge);

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
  "cache reads must not reset age and suppress three-hour refreshes");
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
  HUAYU_LIVE_BUILDING_MIN_TILE_ZOOM:11, HUAYU_LIVE_BUILDING_MAX_TILE_ZOOM:15});
for (const name of ["huayuLiveBuildingTileZoom", "huayuLiveBuildingTileAt", "huayuLiveBuildingVisibleTiles"])
  vm.runInContext(declaration(name), selection);
const bounds = {west:155.9, east:156.3, south:11.95, north:12.2};
const coarse = selection.huayuLiveBuildingTileZoom({getZoom:() => 11});
assert.ok(selection.huayuLiveBuildingVisibleTiles(bounds, coarse).length
  < selection.huayuLiveBuildingVisibleTiles(bounds, 12).length);
assert.equal(selection.huayuLiveBuildingTileZoom({getZoom:() => 16}), 15,
  "close views must keep the original full-detail tile level");

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
  HUAYU_LIVE_BUILDING_CACHE_BYTES:48*1024*1024,HUAYU_STRUCTURE_TILE_CACHE_LIMIT:256,
  HUAYU_STRUCTURE_CACHE_BYTES:16*1024*1024,applyHuayuLiveBuildings:()=>commits++,
  applyHuayuStructures:()=>commits++,updateHuayuLiveBuildingDiagnostics:()=>{},
  updateHuayuStructureDiagnostics:()=>{},syncHuayuLiveBuildingPrimaryLayers:()=>{},
  clearHuayuLiveBuildingPrimarySync:()=>{}});
for(const name of ["huayuModelEntryBytes","huayuModelResidentTiles","pruneHuayuModelTileCache",
  "pruneHuayuLiveBuildingTileCache","pruneHuayuStructureTileCache",
  "mergeHuayuLiveBuildingTiles","mergeHuayuStructureTiles"]) vm.runInContext(declaration(name),residency);
// Count source submissions, including the production no-op on an unchanged revision.
residency.applyHuayuLiveBuildings=residency.applyHuayuStructures=(_,state)=>{
  if(state.appliedRevision!==state.renderRevision){commits++;state.appliedRevision=state.renderRevision;}
};
const tileEntry=(id,revision=1,cacheBytes=2048)=>({revision,cacheBytes,lastUsed:1,loadedAt:Date.now(),
  data:{features:[{id,geometry:{type:"Polygon",coordinates:[]},properties:{}}]},
  pavilionData:{features:[{id:`p-${id}`,properties:{}}]},wallData:{features:[]}});
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
let touches=[];
residency.getHuayuModelTileWorker=()=>({request:job=>{touches.push(job);return Promise.resolve(true);}});
vm.runInContext(declaration("touchHuayuModelTiles"),residency);
const touched={tileCache:new Map([["tile",{cachedAt:1000,loadedAt:1000}]])};
residency.touchHuayuModelTiles("building",touched,[{key:"tile"}],70000);
residency.touchHuayuModelTiles("building",touched,[{key:"tile"}],70001);
assert.equal(touches.length,1,"frequent camera movements must not rewrite disk metadata continuously");
assert.equal(touched.tileCache.get("tile").cachedAt,1000,"LRU use must not change the three-hour data age");
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
