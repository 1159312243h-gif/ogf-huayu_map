import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
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
let requests = 0;
let tileRequests = 0;
let nextPacket = packet;
let fail = false;
let persisted;
const state = {active:true,glMap:{getZoom:() => 9},terrainTileCache:new Map(),tileCache:new Map(),
  terrainPendingTiles:new Map(),terrainFailedTiles:new Map(),terrainQueue:[],
  terrainQueuedTileKeys:new Set(),terrainVisibleTileKeys:new Set()};
const context = vm.createContext({Date,Number,JSON,terrainOverlayEnabled:true,huayuTerrainPreload:null,
  huayuTerrainPreloadPromise:null,huayuTerrainPreloadAttempted:false,huayuTerrainPreloadLastCheckedAt:0,
  HUAYU_TERRAIN_CACHE_MS:10800000,HUAYU_TERRAIN_PRELOAD_RECHECK_MS:300000,
  HUAYU_TERRAIN_MIN_ZOOM:5.5,HUAYU_LIVE_BASEMAP_MIN_ZOOM:12.5,huayuTerrainTileRevision:0,
  HUAYU_TERRAIN_TILE_ZOOM:9,HUAYU_TERRAIN_MAX_VISIBLE_TILES:24,
  huayuLiveBuildingVisibleTiles:() => [{key:"9/0/0",z:9,x:0,y:0}],
  hydrateHuayuTerrainSnapshots:() => {},scheduleNextHuayuTerrainRefresh:() => {},
  huayuAdministrativeQueryBounds:() => ({west:0.5,east:2.5,south:0.5,north:2.5}),
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
install(["validateHuayuTerrainPreload","huayuTerrainPreloadCovers","rebuildHuayuTerrainData",
  "loadHuayuTerrainPreload","refreshHuayuTerrainTiles"],context);
assert.equal(context.validateHuayuTerrainPreload(packet),true);
assert.equal(context.validateHuayuTerrainPreload({...packet,features:[]}),false);
assert.equal(context.validateHuayuTerrainPreload({...packet,features:[{...feature,geometry:{type:"Polygon",coordinates:[[[NaN,1]]]}}]}),false);
await context.loadHuayuTerrainPreload(state);
assert.equal(requests,1);
assert.equal(state.terrainData.features[0].id,"hill","cold start renders the published packet");
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

const require = createRequire(import.meta.url);
const {buildTerrainPreload} = require("./data-update/builders/build-terrain-preload.cjs");
await fs.mkdir(path.join(root,".data-update"),{recursive:true});
const testDirectory = await fs.mkdtemp(path.join(root,".data-update/terrain-test-"));
for (const name of ["app.js","_worker.js","transit-preload.json"]) {
  await fs.copyFile(path.join(root,"site",name),path.join(testDirectory,name));
}
const mapped = {type:"way",id:1,tags:{natural:"wood",name:"测试山"},geometry:[
  {lon:1,lat:1},{lon:1.1,lat:1},{lon:1.1,lat:1.1},{lon:1,lat:1.1},{lon:1,lat:1}]};
let geometryRequests = 0;
let inventoryRateLimited = true;
const built = await buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"cache"),
  sleep:async () => {},
  fetch:async (_url,options) => {
    const query = options.body.get("data");
    if (query.includes("out tags bb;")) {
      if (inventoryRateLimited) {
        inventoryRateLimited = false;
        return new Response("busy",{status:429});
      }
      return new Response(JSON.stringify({elements:[{type:mapped.type,id:mapped.id,tags:mapped.tags},
        {type:"way",id:2,tags:{natural:"wood"},bounds:{minlat:1,maxlat:1.0001,minlon:1,maxlon:1.0001}},
        {type:"way",id:3,tags:{natural:"wood",leisure:"park",name:"森林公园"},
          bounds:{minlat:1,maxlat:2,minlon:1,maxlon:2}},
        {type:"node",id:4,lat:1.05,lon:1.05,tags:{natural:"peak",name:"测试峰",ele:"400"}},
        {type:"node",id:5,lat:2,lon:2,tags:{natural:"peak",name:"远处峰",ele:"999"}}]}));
    }
    geometryRequests++;
    return new Response(JSON.stringify({elements:[mapped]}));
  }});
assert.equal(geometryRequests,1,"neighbouring inventories must reuse the same full geometry");
assert.equal(built.features.filter((item) => item.properties.reliefRole === "surface").length,1,
  "overlapping spatial queries must deduplicate terrain");
assert.equal(built.features.find((item) => item.properties.reliefRole === "surface").properties.reliefHeight,400,
  "national peak filtering must retain local elevation while excluding distant peaks");
assert.ok(validateDataset("terrain-preload.json.gz",built).surfaces > 0);
const target = path.join(testDirectory,"terrain-preload.json.gz");
assert.equal((await readDatasetFile(target)).features.length,built.features.length,
  "the compressed published asset must decode to the complete GeoJSON packet");
const before = await fs.readFile(target);
await assert.rejects(buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"fail-cache"),
  fetch:async () => new Response("denied",{status:403})}),/HTTP 403/u);
assert.deepEqual(await fs.readFile(target),before,
  "incomplete refresh must never replace the published terrain packet");
await assert.rejects(buildTerrainPreload({siteDirectory:testDirectory,cacheDirectory:path.join(testDirectory,"timeout-cache"),
  fetch:async () => new Response(JSON.stringify({elements:[],remark:"runtime error: Query timed out"}))}),/Query timed out/u);
assert.deepEqual(await fs.readFile(target),before,
  "HTTP 200 with a timeout remark must not replace a complete snapshot");
console.log("Published terrain regressions passed: cold start, freshness, replacement, offline reuse and atomic generation.");
