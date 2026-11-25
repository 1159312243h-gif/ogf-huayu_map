import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {samples,tileAt,inspectPacket} from "./audit-basemap-freshness.mjs";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../site/_worker.js", import.meta.url), "utf8");
const extract = (source, name) => {
  const match = source.match(new RegExp(`(?:  )?(?:async )?function ${name}\\([^]*?\\n(?:  )?\\}`, "u"));
  assert.ok(match, name); return match[0];
};
assert.equal(extract(app,"validateHuayuBasemapPayload").replace(/^  /gm,""),
  extract(worker,"validateHuayuBasemapPayload"), "browser and edge enforce identical source completeness");
const context = vm.createContext({Set, Map, WeakMap, Date, Number,
  huayuTerrainPreload:null, huayuAdministrativeQueryBounds:() => null,
  huayuAdministrativeBoundsContain:() => false, huayuTerrainPreloadCovers:() => false,
  applyHuayuLiveBasemap:() => {}, useHuayuTerrainData:() => {},
});
for (const name of ["validateHuayuBasemapPayload", "huayuLiveBuildingTileBounds", "huayuBasemapSourceAuthority",
  "huayuLiveBasemapKeysReady", "huayuLiveBasemapKeysIdle", "huayuLiveBasemapRenderPlan",
  "rebuildHuayuTerrainData", "mergeHuayuLiveBasemapTiles"]) vm.runInContext(extract(app,name),context);
const packet = elements => ({osm3s:{timestamp_osm_base:"2026-11-25T02:30:00Z"}, elements:[...elements,
  {type:"count",tags:{total:String(elements.length),nodes:"0",ways:String(elements.length),relations:"0"}}]});
assert.doesNotThrow(() => context.validateHuayuBasemapPayload(packet([])));
const valid = packet([{type:"way",id:1}]);
for (const bad of [{...valid,remark:"Query timed out"}, {...valid,osm3s:{}},
  {...valid,elements:valid.elements.slice(0,1)}, packet([{type:"way",id:1},{type:"way",id:1}]),
  {...valid,elements:[...valid.elements.slice(0,1),{type:"count",tags:{total:"2",ways:"2",nodes:"0",relations:"0"}}]}]) {
  assert.throws(() => context.validateHuayuBasemapPayload(bad), /incomplete_basemap/);
}
const feature = (id, kind, name, coordinates = [[152.866,14.683],[152.867,14.684]]) => ({
  type:"Feature", id:`${name}:${id}`, geometry:{type:"LineString",coordinates},
  properties:{osmType:"way",osmId:String(id),renderKind:kind,name,featureClass:kind === "road" ? "primary" : "river"},
});
const river = feature(1,"waterway","old river"), updated = feature(1,"waterway","new river");
const deleted = feature(2,"road","removed road");
const edge = feature(3,"road","edge road",[[152.870,14.683],[152.880,14.684]]);
const outside = feature(4,"road","outside road",[[152.880,14.684],[152.881,14.685]]);
const parentKey = "14/15149/7516", detailKey = "15/30298/15032";
const entry = (features, sourceTime, sourceIds = features.map(f => `way:${f.properties.osmId}`)) => ({
  data:{features}, sourceTime, loadedAt:sourceTime, sourceIds:new Set(sourceIds), verifiedComplete:true, revision:sourceTime,
});
const state = () => ({active:true,glMap:{},terrainSignature:"",terrainTileCache:new Map(),
  tileCache:new Map([[parentKey,entry([river,deleted,edge,outside],100)], [detailKey,entry([updated],200)]]),
  terrainData:{features:[]},snapshotTileKeys:new Set([parentKey]),detailTileKeys:new Set([detailKey]),
  pendingTiles:new Map(),queuedTileKeys:new Set(),activeTier:"fallback"});
const render = s => {context.rebuildHuayuTerrainData(s);context.mergeHuayuLiveBasemapTiles(s);return s.data.features;};
let s = state(), result = render(s);
assert.equal(result.filter(f => f.properties.osmId === "1").length,1);
assert.equal(result.find(f => f.properties.osmId === "1").properties.name,"new river");
assert.ok(!result.some(f => f.properties.osmId === "2"), "complete detail cannot resurrect an old parent road");
assert.ok(result.some(f => f.properties.osmId === "3"), "cross-boundary source geometry remains whole");
assert.ok(result.some(f => f.properties.osmId === "4"), "unqueried parent coverage remains visible");
assert.equal(s.terrainData.features.find(f => f.properties.osmId === "1").properties.name,"new river",
  "terrain water masks must use the same current river as the displayed map");
s = state();s.tileCache.set(detailKey,entry([],200));
assert.ok(!render(s).some(f => ["1","2"].includes(f.properties.osmId)), "a counted complete empty tile owns its covered old geometry");
s = state();s.tileCache.get(detailKey).verifiedComplete = false;
assert.ok(render(s).some(f => f.properties.osmId === "2"), "unverified data cannot remove fallback geometry");
s = state();s.tileCache.get(parentKey).sourceTime=300;
assert.equal(render(s).find(f => f.properties.osmId === "1").properties.name,"old river",
  "original source time takes priority over detail zoom and later network retrieval");
s = state();s.tileCache.delete(detailKey);
assert.ok(render(s).some(f => f.properties.osmId === "2"), "missing or failed detail retains the complete parent");
s = state();s.tileCache.set(detailKey,entry([],200,["way:2"]));
assert.ok(!render(s).some(f => f.properties.osmId === "2"), "current source reclassification replaces old derived features");
const minor = feature(9,"road","minor");minor.properties.featureClass="minor";
const regional = entry([],300), old = entry([minor],100);
assert.equal(context.huayuBasemapSourceAuthority([{key:"13/7574/3758",entry:regional}])
  .accepts(minor,{key:parentKey,entry:old}),true,"z13 cannot remove an omitted minor-road class");

for(const sample of samples){
  const tile=tileAt(sample,15),key=`${tile.z}/${tile.x}/${tile.y}`,bounds=context.huayuLiveBuildingTileBounds(tile);
  const sibling={...tile,x:tile.x+(tile.x%2?-1:1)},other=context.huayuLiveBuildingTileBounds(sibling);
  const coords=[[bounds.west+(bounds.east-bounds.west)*0.2,bounds.south+(bounds.north-bounds.south)*0.3],
    [bounds.west+(bounds.east-bounds.west)*0.8,bounds.south+(bounds.north-bounds.south)*0.6]];
  const missing=feature(100,"waterway",sample.name,coords),previous=entry([missing],100);
  const complete=entry([],200);
  assert.equal(context.huayuBasemapSourceAuthority([{key,entry:complete}])
    .accepts(missing,{key:"published",entry:previous}),false,`${sample.name}: complete empty source replaces its old river`);
  const combinedBounds={west:Math.min(bounds.west,other.west),east:Math.max(bounds.east,other.east)};
  const long=feature(101,"waterway",sample.name,[[combinedBounds.west+0.0001,coords[0][1]],[combinedBounds.east-0.0001,coords[1][1]]]);
  const coverage=[{key,entry:complete},{key:`15/${sibling.x}/${sibling.y}`,entry:entry([],200)}];
  assert.equal(context.huayuBasemapSourceAuthority(coverage).accepts(long,{key:"published",entry:previous}),false,
    `${sample.name}: complete neighbouring tiles jointly own a removed long river`);
  assert.equal(context.huayuBasemapSourceAuthority(coverage.slice(0,1)).accepts(long,{key:"published",entry:previous}),true,
    `${sample.name}: missing neighbour cannot erase a long river`);
}
const packetResponse=new Response(null,{headers:{"X-OGF-Basemap-Fetched-At":"2026-11-25T02:31:00Z"}});
assert.equal(inspectPacket(valid,packetResponse,Date.parse("2026-11-25T02:32:00Z")).sourceAgeMinutes,2);
assert.equal(inspectPacket(valid,packetResponse).sourceComplete,true);
assert.equal(inspectPacket({...valid,elements:valid.elements.slice(0,1)},packetResponse).legacyUncounted,true);
assert.throws(()=>inspectPacket({...valid,remark:"timeout"},packetResponse),/timeout/);

// Exercise the actual async tile loader's rollback protection, not just sorting.
const oldGeometry={features:[{id:"newer-edit"}]};
const retainedEntry={sourceTime:Date.parse("2026-11-25T03:00:00Z"),data:oldGeometry};
const loaderState={active:true,queue:[{key:detailKey,z:15,x:30298,y:15032}],queuedTileKeys:new Set([detailKey]),
  visibleTileKeys:new Set([detailKey]),pendingTiles:new Map(),failedTiles:new Map(),tileCache:new Map([[detailKey,retainedEntry]]),glMap:{}};
const loaderContext=vm.createContext({AbortController,Date,HUAYU_LIVE_BASEMAP_TILE_CONCURRENCY:3,
  fetchHuayuLiveBasemapTile:async()=>({payload:valid}),
  applyHuayuLiveBasemap:()=>{},mergeHuayuLiveBasemapTiles:()=>{},updateHuayuLiveBasemapDiagnostics:()=>{},
  scheduleNextHuayuLiveBasemapRefresh:()=>{}});
vm.runInContext(extract(app,"pumpHuayuLiveBasemapTiles"),loaderContext);
loaderContext.pumpHuayuLiveBasemapTiles(loaderState);
await loaderState.pendingTiles.get(detailKey).promise;
assert.equal(loaderState.tileCache.get(detailKey).data,oldGeometry,"an older network response cannot overwrite a newer accepted edit");
assert.ok(retainedEntry.refreshAt>=Date.now()+29000&&retainedEntry.refreshAt<=Date.now()+30000);

// Install real published typography, rather than the order-only layer summary.
const style = JSON.parse(await readFile(new URL("../site/huayu-style.json",import.meta.url),"utf8"));
const layers = new Map(style.layers.map(layer => [layer.id,layer]));
let styleReads = 0;
const labelContext = vm.createContext({huayuLiveBasemapMinimumZoom:() => 12.5,
  HUAYU_LIVE_BASEMAP_SOURCE:"live-source"});
vm.runInContext(app.match(/  const HUAYU_LIVE_BASEMAP_LAYERS = \{[^]*?\n  \};/u)[0],labelContext);
vm.runInContext(extract(app,"ensureHuayuLiveBasemapLabels"),labelContext);
const map = {getLayer:id => layers.get(id),getStyle:() => {styleReads++;return style;}};
const added = [];
const add = (layer,before) => {layers.set(layer.id,layer);added.push({layer,before});};
labelContext.ensureHuayuLiveBasemapLabels(map,add);
assert.equal(added.length,4);
for (const {layer,before} of added) {
  const original = layers.get(before);
  assert.equal(layer.layout["text-field"],original.layout["text-field"]);
  assert.deepEqual(JSON.parse(JSON.stringify(layer.layout["text-font"])),original.layout["text-font"]);
  assert.deepEqual(JSON.parse(JSON.stringify(layer.layout["text-size"])),original.layout["text-size"]);
  assert.deepEqual(JSON.parse(JSON.stringify(layer.paint)),original.paint);
  assert.equal(layer.minzoom,Math.max(12.5,original.minzoom || 0));
}
assert.equal(styleReads,1);
labelContext.ensureHuayuLiveBasemapLabels(map,add);
assert.equal(styleReads,1,"unchanged labels do not serialize all live sources again");
console.log("Basemap source regressions passed: new geometry, source age, deletion ownership, complete empties, edge coverage, reclassification and failure retention.");
