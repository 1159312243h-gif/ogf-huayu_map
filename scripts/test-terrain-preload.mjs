import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {gzipSync} from "node:zlib";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {validateDataset,readDatasetFile} from "./update-all-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "site/app.js"), "utf8");
const install = (names, context) => names.forEach((name) => {
  const declaration = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
});
const feature = {type:"Feature",id:"hill",geometry:{type:"Polygon",coordinates:[
  [[1,1],[2,1],[2,2],[1,2],[1,1]]]},properties:{reliefRole:"surface",reliefHeight:200,reliefArea:1e8}};
const packet = {format:1,schema:"open-small-mountains-v1",generatedAt:new Date().toISOString(),
  coverage:[{id:"region",bounds:[[0,0],[3,3]],complete:true}],features:[feature]};
const transportContext = vm.createContext({AbortController,Response,Blob,DecompressionStream,TextDecoder,
  window:{setTimeout,clearTimeout}});
install(["fetchJson"],transportContext);
for (const body of [JSON.stringify(packet),gzipSync(JSON.stringify(packet))]) {
  transportContext.fetch = async () => new Response(body);
  assert.equal((await transportContext.fetchJson("./terrain-preload.json.gz",1000))
    .features[0].id,"hill","plain and remaining gzip responses must decode identically");
}
let requests = 0;
let tileRequests = 0;
let nextPacket = packet;
let fail = false;
let persisted;
const state = {active:true,glMap:{getZoom:() => 9},terrainTileCache:new Map(),tileCache:new Map(),
  terrainPendingTiles:new Map(),terrainFailedTiles:new Map(),terrainQueue:[],
  terrainQueuedTileKeys:new Set(),terrainVisibleTileKeys:new Set()};
const context = vm.createContext({Date,Number,JSON,terrainOverlayEnabled:true,huayuTerrainPreload:null,
  huayuWoodlandMaterialLayers:new Map(),
  huayuTerrainPreloadManifest:null,huayuTerrainPreloadChunks:new Map(),huayuTerrainPreloadChunkRequests:new Map(),
  huayuTerrainPreloadPromise:null,huayuTerrainPreloadAttempted:false,huayuTerrainPreloadLastCheckedAt:0,
  HUAYU_TERRAIN_CACHE_MS:10800000,HUAYU_TERRAIN_PRELOAD_RECHECK_MS:300000,
  HUAYU_TERRAIN_MIN_ZOOM:5.5,HUAYU_LIVE_BASEMAP_MIN_ZOOM:12.5,huayuTerrainTileRevision:0,
  HUAYU_TERRAIN_TILE_ZOOM:9,HUAYU_TERRAIN_MAX_VISIBLE_TILES:24,
  huayuLiveBuildingVisibleTiles:() => [{key:"9/0/0",z:9,x:0,y:0}],
  hydrateHuayuTerrainSnapshots:() => {},scheduleNextHuayuTerrainRefresh:() => {},
  huayuAdministrativeQueryBounds:() => ({west:0.5,east:2.5,south:0.5,north:2.5}),
  huayuAdministrativeBoundsContain:(outer,inner) => Boolean(outer && inner && outer.west<=inner.west
    && outer.east>=inner.east&&outer.south<=inner.south&&outer.north>=inner.north),
  huayuTerrainSelectionBounds:(bounds) => bounds,
  huayuMountainSurfaceFeatureIntersectsViewport:() => true,
  huayuLiveBuildingTileBounds:() => ({west:0,east:3,south:0,north:3}),
  loadHuayuTerrainStoredTile:async () => null,storeHuayuTerrainTile:async (key,entry) => {
    assert.equal(key,"published-preload"); persisted = entry;
  },
  fetchJson:async () => {requests++; if(fail) throw new Error("offline"); return nextPacket;},
  mergeHuayuLiveBasemapTiles:() => {},scheduleHuayuLiveBasemap:() => {},
  pumpHuayuTerrainTiles:() => {tileRequests++;},suspendHuayuTerrainTiles:() => {},
  window:{clearTimeout:() => {},setTimeout:() => 1},
});
install(["validateHuayuTerrainPreloadManifest","huayuTerrainPreloadManifestChunks",
  "validateHuayuTerrainPreload","validateHuayuTerrainPreloadChunk","loadHuayuTerrainPreloadChunks",
  "fetchHuayuTerrainPreloadChunk",
  "huayuTerrainPreloadCovers","rebuildHuayuTerrainData","loadHuayuTerrainPreload",
  "refreshHuayuTerrainTiles"],context);
assert.equal(context.validateHuayuTerrainPreload(packet),true);
const buildingMask={...feature,id:"mapped-building",properties:{renderKind:"terrain-context",terrainContext:1,materialOcclusion:"building"}};
assert.equal(context.validateHuayuTerrainPreload({...packet,features:[feature,buildingMask]}),true,
  "saved mountain buildings must remain a valid part of the published snapshot");
assert.equal(context.validateHuayuTerrainPreload({...packet,features:[]}),false);
assert.equal(context.validateHuayuTerrainPreload({...packet,features:[{...feature,geometry:{type:"Polygon",coordinates:[[[NaN,1]]]}}]}),false);
await context.loadHuayuTerrainPreload(state);
assert.equal(requests,2,"manifest fallback checks the lightweight index before the legacy packet");
assert.equal(state.terrainData.features[0].id,"hill","cold start renders the published packet");
nextPacket = {...packet,classification:"mountain-neighbors-v1",features:[feature,{...feature,id:"foothill"}]};
context.huayuTerrainPreloadLastCheckedAt = 0;
await context.loadHuayuTerrainPreload(state);
assert.equal(state.terrainData.features.length,2,
  "a reclassified snapshot replaces older browser data without falsifying its data generation time");
context.refreshHuayuTerrainTiles(state.glMap,state,{west:1,east:2,south:1,north:2});
assert.equal(tileRequests,0,"fresh complete overview must not wait for Overpass tiles");
assert.equal(context.huayuTerrainPreloadCovers({west:3,east:4,south:1,north:2}),false);
assert.equal(context.huayuTerrainPreloadCovers({west:2,east:1,south:1,north:2}),false);
context.refreshHuayuTerrainTiles(state.glMap,state,{west:3.5,east:4,south:1,north:2});
assert.equal(tileRequests,1,"outside published coverage must still queue live terrain");
// A newer published packet must remove deleted mountains from older live tiles.
state.terrainTileCache.set("9/1/1",{data:{features:[feature]},loadedAt:Date.parse(packet.generatedAt)-1000});
nextPacket = {...packet,generatedAt:new Date(Date.parse(packet.generatedAt)+1000).toISOString(),
  features:[{...feature,id:"replacement"}]};
context.huayuTerrainPreloadLastCheckedAt = 0;
await context.loadHuayuTerrainPreload(state);
assert.deepEqual(Array.from(state.terrainData.features,(item) => item.id),["replacement"]);
fail = true;
context.huayuTerrainPreloadLastCheckedAt = 0;
await context.loadHuayuTerrainPreload(state);
assert.equal(state.terrainData.features[0].id,"replacement","refresh failure retains the complete packet");
const requestsBeforeDisable = requests;
context.terrainOverlayEnabled = false;
context.huayuTerrainPreloadLastCheckedAt = 0;
await context.loadHuayuTerrainPreload(state);
assert.equal(requests,requestsBeforeDisable,"disabled terrain must not fetch a published snapshot");
context.terrainOverlayEnabled = true;
context.huayuTerrainPreload.refreshAt = Date.now()-1;
assert.equal(context.huayuTerrainPreloadCovers({west:1,east:2,south:1,north:2}),false,
  "stale published coverage must allow live refresh");
state.glMap.getZoom = () => 15;
const tileRequestsBeforeStaleRefresh = tileRequests;
context.refreshHuayuTerrainTiles(state.glMap,state,{west:1,east:2,south:1,north:2});
assert.equal(tileRequests,tileRequestsBeforeStaleRefresh,
  "a complete saved snapshot must remain the close-view fallback while revalidation runs");
context.rebuildHuayuTerrainData(state);
assert.deepEqual(Array.from(state.terrainData.features,(item) => item.id),["replacement"],
  "an expired packet must not resurrect deleted mountains from older tiles");
context.huayuTerrainPreload = null;
context.huayuTerrainPreloadAttempted = false;
context.huayuTerrainPreloadLastCheckedAt = 0;
context.loadHuayuTerrainStoredTile = async () => persisted;
await context.loadHuayuTerrainPreload(state);
assert.equal(context.huayuTerrainPreload.source,"published-browser-snapshot");
assert.equal(state.terrainData.features[0].id,"replacement","reopening offline must restore the saved replacement");

// Two distant chunk regions accumulate rather than replacing each other. Concurrent
// requests share one fetch, and a previous generation cannot overwrite a new snapshot.
const manifest = {...packet,classification:"mountain-neighbors-v1",chunks:[
  {id:"a",url:"./a.json.gz",bounds:[[0,0],[3,3]]},
  {id:"b",url:"./b.json.gz",bounds:[[0,6],[3,9]]}]};
let view = {west:1,east:2,south:1,north:2};
let chunkRequests = 0;
let releaseChunk;
let pauseChunk = false;
context.huayuTerrainPreload = null;
context.huayuTerrainPreloadManifest = manifest;
context.huayuAdministrativeQueryBounds = () => view;
context.fetchJson = async (url) => {
  chunkRequests++;
  if (pauseChunk) await new Promise(resolve => {releaseChunk=resolve;});
  return {...manifest,chunkId:url.includes("a.")?"a":"b",features:[
    {...feature,id:url.includes("a.")?"hill-a":"hill-b"}]};
};
const applyChunks = () => context.rebuildHuayuTerrainData(state);
await context.loadHuayuTerrainPreloadChunks(state,applyChunks);
view = {west:7,east:8,south:1,north:2};
await context.loadHuayuTerrainPreloadChunks(state,applyChunks);
assert.deepEqual(Array.from(state.terrainData.features,item=>item.id),["hill-a","hill-b"],
  "panning must retain terrain outside the current viewport");
view = {west:1,east:2,south:1,north:2};
const retainedData = state.terrainData;
await context.loadHuayuTerrainPreloadChunks(state,applyChunks);
assert.equal(chunkRequests,2,"revisiting downloaded chunks must not fetch again");
assert.equal(state.terrainData,retainedData,"viewport changes must not replace unchanged terrain data");
context.huayuTerrainPreloadManifest = null;
assert.equal(context.huayuTerrainPreloadCovers({west:1,east:8,south:1,north:2},{allowStale:true}),false,
  "a gap between saved regions must not be advertised as complete coverage");
context.huayuTerrainPreloadManifest = manifest;
context.huayuTerrainPreloadChunks.clear();
pauseChunk = true;
const firstChunkLoad = context.loadHuayuTerrainPreloadChunks(state,applyChunks);
const concurrentChunkLoad = context.loadHuayuTerrainPreloadChunks(state,applyChunks);
await new Promise(setImmediate);
assert.equal(chunkRequests,3,"concurrent movement events must share an in-flight chunk fetch");
releaseChunk();
await Promise.all([firstChunkLoad,concurrentChunkLoad]);
context.huayuTerrainPreloadChunks.clear();
const oldGenerationLoad = context.loadHuayuTerrainPreloadChunks(state,applyChunks);
await new Promise(setImmediate);
const completeSnapshot = context.huayuTerrainPreload;
context.huayuTerrainPreloadManifest = {...manifest,generatedAt:new Date(Date.parse(manifest.generatedAt)+1000).toISOString()};
releaseChunk();
assert.equal(await oldGenerationLoad,false);
assert.equal(context.huayuTerrainPreload,completeSnapshot,
  "an obsolete generation must not replace the last complete snapshot");
context.huayuTerrainPreloadLastCheckedAt = 0;
context.huayuTerrainPreloadChunks.clear();
context.fetchJson = async url => {
  if (url.includes("manifest")) return manifest;
  if (url.endsWith("terrain-preload.json.gz")) return {...manifest,features:[{...feature,id:"full-fallback"}]};
  throw new Error("chunk temporarily unavailable");
};
await context.loadHuayuTerrainPreload(state);
assert.deepEqual(Array.from(state.terrainData.features,item=>item.id),["full-fallback"],
  "a complete legacy packet of the same generation must replace a partial saved region after chunk failure");

// The visible snapshot completes before peripheral prefetch can consume bandwidth
// or invalidate its still-building mesh. Previously every cold start awaited both.
context.huayuTerrainPreloadManifest=manifest;
context.huayuTerrainPreload=null;
context.huayuTerrainPreloadChunks.clear();
state.terrainSelectionBounds=null;
view={west:1,east:2,south:1,north:2};
context.huayuTerrainSelectionBounds=()=>({west:0,east:9,south:0,north:3});
let prefetchTimer, priorityRequests=0;
context.window.setTimeout=callback=>{prefetchTimer=callback;return 1;};
const material={rebuildPromise:true};
context.huayuWoodlandMaterialLayers=new Map([[state.glMap,material]]);
context.fetchJson=async url=>{
  priorityRequests++;
  return {...manifest,chunkId:url.includes("a.")?"a":"b",features:[{...feature,id:url.includes("a.")?"hill-a":"hill-b"}]};
};
await context.loadHuayuTerrainPreloadChunks(state,applyChunks);
assert.equal(priorityRequests,1,"a visible region must not wait for unrelated peripheral chunks");
prefetchTimer();
assert.equal(priorityRequests,1,"peripheral prefetch must wait while the first mesh is still building");
material.rebuildPromise=false;
prefetchTimer();
await new Promise(setImmediate);
assert.equal(priorityRequests,2,"idle time must still preload nearby terrain");
assert.deepEqual(Array.from(state.terrainData.features,item=>item.id),["hill-a","hill-b"]);

// A country-scale cold start must show prepared material without downloading
// raw country polygons or claiming that their detailed coverage was loaded.
const overviewSnapshot = context.huayuTerrainPreload;
const requestsBeforeOverview = priorityRequests;
let preparedLoads = 0;
material.loadPublishedSnapshot = async () => { preparedLoads++; };
context.huayuTerrainPreloadManifest = {...manifest, renderBlocks:[{url:"./prepared.json.gz"}]};
state.glMap.getZoom = () => 4;
context.huayuTerrainPreloadChunks.clear();
assert.equal(await context.loadHuayuTerrainPreloadChunks(state,applyChunks),true);
assert.equal(preparedLoads,1,"small-scale visits must load the prepared terrain immediately");
assert.equal(priorityRequests,requestsBeforeOverview,"overview visits must not download raw detail chunks");
assert.equal(context.huayuTerrainPreload,overviewSnapshot,"prepared material must not fabricate raw snapshot coverage");
const originalPreloadLoader = context.loadHuayuTerrainPreload;
let overviewChecks = 0;
context.loadHuayuTerrainPreload = () => { overviewChecks++; };
context.refreshHuayuTerrainTiles(state.glMap,state,view);
assert.equal(overviewChecks,1,"five-minute snapshot checking must also run below the live-query minimum zoom");
assert.equal(state.terrainVisibleTileKeys.size,0,"small-scale snapshots must not queue live terrain tiles");
context.loadHuayuTerrainPreload = originalPreloadLoader;

const require = createRequire(import.meta.url);
const {buildTerrainPreload} = require("./data-update/builders/build-terrain-preload.cjs");
await fs.mkdir(path.join(root,".data-update"),{recursive:true});
const testDirectory = await fs.mkdtemp(path.join(root,".data-update/terrain-test-"));
for (const name of ["app.js","_worker.js","transit-preload.json"]) {
  await fs.copyFile(path.join(root,"site",name),path.join(testDirectory,name));
}
const mapped = {type:"way",id:1,tags:{natural:"wood",name:"测试山"},geometry:[
  {lon:1,lat:1},{lon:1.1,lat:1},{lon:1.1,lat:1.1},{lon:1,lat:1.1},{lon:1,lat:1}]};
const nearbyHill = {type:"way",id:6,tags:{natural:"wood"},geometry:[
  {lon:1.105,lat:1.02},{lon:1.108,lat:1.02},{lon:1.108,lat:1.023},{lon:1.105,lat:1.023},{lon:1.105,lat:1.02}]};
const unnamedHeath = {...mapped,id:8,tags:{natural:"heath"},geometry:mapped.geometry.map(p=>({...p,lon:p.lon+0.3}))};
let geometryRequests = 0;
let inventoryRateLimited = true;
const built = await buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"cache"),
  sleep:async () => {},
  fetch:async (_url,options) => {
    const query = options.body.get("data");
    if (query.includes("out tags bb;")) {
      assert.ok(query.includes('way["natural"~"^(scrub|heath|fell|bare_rock|scree)$"]('),
        "scheduled inventories must fetch unnamed rough land before shared classification");
      assert.ok(query.includes('node["ele"]('), "three-hour inventories must collect non-peak elevations");
      if (inventoryRateLimited) {
        inventoryRateLimited = false;
        return new Response("busy",{status:429});
      }
      return new Response(JSON.stringify({elements:[{type:mapped.type,id:mapped.id,tags:mapped.tags},
        {type:"way",id:2,tags:{natural:"wood"},bounds:{minlat:1,maxlat:1.0001,minlon:1,maxlon:1.0001}},
        {type:"way",id:3,tags:{natural:"wood",leisure:"park",name:"森林公园"},
          bounds:{minlat:1,maxlat:2,minlon:1,maxlon:2}},
        {type:"node",id:4,lat:1.05,lon:1.05,tags:{natural:"peak",name:"测试峰",ele:"400"}},
        {type:"node",id:5,lat:2,lon:2,tags:{natural:"peak",name:"远处峰",ele:"999"}},
        {type:"node",id:9,lat:1.03,lon:1.04,tags:{natural:"saddle",ele:"200"}},
        {type:"node",id:10,lat:1.08,lon:1.02,tags:{ele:"0"}},
        {type:"way",id:6,tags:nearbyHill.tags,bounds:{minlat:1.02,maxlat:1.023,minlon:1.105,maxlon:1.108}},
        {type:"way",id:8,tags:unnamedHeath.tags,bounds:{minlat:1,maxlat:1.1,minlon:1.3,maxlon:1.4}}]}));
    }
    geometryRequests++;
    return new Response(JSON.stringify({elements:query.includes("way(id:6)")?[nearbyHill]:[mapped,unnamedHeath]}));
  }});
assert.equal(geometryRequests,2,"neighbouring inventories must reuse the primary and foothill geometries");
assert.equal(built.features.filter((item) => item.properties.reliefRole === "surface").length,3,
  "overlapping spatial queries must deduplicate terrain");
assert.ok(built.features.some(item=>item.properties.reliefNeighbor===1),
  "the scheduled builder must fetch small nearby woods that its former area filter discarded");
assert.ok(built.features.some(item=>item.properties.sourceOsmId==="8"&&item.properties.reliefLandKind==="open"),
  "three-hour regeneration must retain unnamed heath terrain");
assert.ok(built.features.every(item=>/^[a-f0-9]{64}$/u.test(item.terrainDigest)),
  "three-hour generation must prepare stable digests rather than hash country geometry in the browser");
assert.equal(built.features.find((item) => item.properties.reliefRole === "surface").properties.reliefHeight,400,
  "national peak filtering must retain local elevation while excluding distant peaks");
assert.equal(built.heightField.mountainObservations,3,
  "scheduled snapshots must keep peaks, saddles and zero-metre spot elevations together");
assert.equal(built.heightField.flatland,"deferred");
assert.equal(JSON.parse(built.features.find(item=>item.properties.sourceOsmId==="1").properties.reliefSamples).length,3);
assert.ok(validateDataset("terrain-preload.json.gz",built).surfaces > 0);
const target = path.join(testDirectory,"terrain-preload.json.gz");
assert.equal((await readDatasetFile(target)).features.length,built.features.length,
  "the compressed published asset must decode to the complete GeoJSON packet");
const chunkManifest = JSON.parse(await fs.readFile(path.join(testDirectory,"terrain-preload-manifest.json"),"utf8"));
assert.equal(chunkManifest.generatedAt,built.generatedAt);
assert.equal(chunkManifest.heightField.mountainObservations,3,
  "the manifest must retain height-field metadata for browser caches");
assert.ok(chunkManifest.renderBlocks?.length>0,"three-hour generation must prepare renderable geometry as well as raw polygons");
for (const block of chunkManifest.renderBlocks) {
  const packet=await readDatasetFile(path.join(testDirectory,block.url.replace(/^\.\//u,"")));
  assert.equal(packet.model,"woodland-material-overview-v1");
  assert.ok(Buffer.from(packet.vertices,"base64").length>0);
  assert.ok(packet.surfaces.some(feature=>feature.properties.reliefNeighbor===1),
    "prepared material must preserve recognised foothills");
}
assert.ok(chunkManifest.chunks.length>0&&chunkManifest.chunks.every(chunk=>chunk.bytes>0&&chunk.url.endsWith(".json.gz")),
  "the scheduled builder must publish versioned spatial snapshot chunks");
const chunkPackets = await Promise.all(chunkManifest.chunks.map(chunk=>
  readDatasetFile(path.join(testDirectory,chunk.url.replace(/^\.\//u,"")))));
assert.ok(chunkPackets.flatMap(packet=>packet.features).some(item=>item.properties.reliefNeighbor===1),
  "spatial chunks must preserve nearby foothills");
const before = await fs.readFile(target);
await assert.rejects(buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"fail-cache"),
  fetch:async () => new Response("denied",{status:403})}),/HTTP 403/u);
assert.deepEqual(await fs.readFile(target),before,
  "incomplete refresh must never replace the published terrain packet");
await assert.rejects(buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"timeout-cache"),
  fetch:async () => new Response(JSON.stringify({elements:[],remark:"runtime error: Query timed out"}))}),/Query timed out/u);
assert.deepEqual(await fs.readFile(target),before,
  "HTTP 200 with a timeout remark must not replace a complete snapshot");
context.huayuTerrainPreload={data:{features:[feature,buildingMask]},revision:9999,loadedAt:Date.now()};
state.tileCache.clear();state.terrainTileCache.clear();
context.rebuildHuayuTerrainData(state);
assert.ok(state.terrainData.features.some(feature=>feature.id==="mapped-building"),
  "merging the snapshot must retain building/garden masks before vector tiles arrive");
state.publishedTerrainContext=new Map([["prepared-river",{...buildingMask,id:"prepared-river",properties:{
  renderKind:"waterway",terrainContext:1,materialOcclusion:"water"},geometry:{type:"LineString",coordinates:[[1,1],[2,2]]}}]]);
state.publishedTerrainContextRevision=1;state.publishedTerrainContextAt=Date.now();
context.huayuTerrainPreload=null;
context.rebuildHuayuTerrainData(state);
assert.ok(state.terrainData.features.some(feature=>feature.id==="prepared-river"),
  "prepared-only overview views must show snapshot rivers before raw chunks arrive");
const splitPacket={...packet,classification:"mountain-features-v2",contextSnapshot:{
  url:"./terrain-preload-chunks/context-0123456789abcdef.json.gz",features:1}};
const splitContext={format:1,schema:packet.schema,generatedAt:packet.generatedAt,classification:splitPacket.classification,features:[buildingMask]};
context.huayuTerrainPreloadManifest=null;context.huayuTerrainPreload=null;
context.huayuTerrainPreloadAttempted=false;context.huayuTerrainPreloadPromise=null;context.huayuTerrainPreloadLastCheckedAt=0;
context.loadHuayuTerrainStoredTile=async()=>null;
state.glMap.getZoom=()=>9;
context.fetchJson=async url=>url.includes("manifest") ? {} : url===splitPacket.contextSnapshot.url ? splitContext : splitPacket;
await context.loadHuayuTerrainPreload(state);
assert.ok(context.huayuTerrainPreload.data.features.some(feature=>feature.id==="mapped-building"),
  "legacy fallback must join complete context and geometry even when the manifest is unavailable");
context.huayuTerrainPreloadLastCheckedAt=0;
context.fetchJson=async url=>url.includes("manifest") ? {} : url===splitPacket.contextSnapshot.url
  ? {...splitContext,generatedAt:"2000-01-01T00:00:00Z"} : splitPacket;
await context.loadHuayuTerrainPreload(state);
assert.ok(context.huayuTerrainPreload.data.features.some(feature=>feature.id==="mapped-building"),
  "a mismatched context generation must retain the previously complete snapshot");
console.log("Published terrain regressions passed: cold start, freshness, replacement, offline reuse and atomic generation.");
