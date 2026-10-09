import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const install = (names, context) => {
  for (const name of names) {
    const declaration = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
    assert.ok(declaration, `Missing ${name}`);
    vm.runInContext(declaration, context);
  }
};

// The compact query must reconstruct the same multipolygon and holes as the old query.
const geometryContext = vm.createContext({
  huayuLiveBasemapPolygonClass: () => "wood", huayuSportKind: () => "",
  huayuLiveBasemapPolygonSignature: () => "wood", huayuPreferredFeatureName: (tags) => tags.name,
  huayuLiveBasemapSportsProperties: () => ({}), huayuLiveBasemapImportantLabel: () => null,
  huayuMountainWoodlandEligible: () => true,
  huayuMountainReliefParts: (element, geometry) => [{element, geometry, properties:{reliefRole:"surface"}}],
});
install(["huayuWallCoordinates", "huayuWallPointKey", "huayuWallJoinRings", "huayuWallRingArea",
  "huayuNormalizedWallRing", "huayuWallPointInRing", "huayuCityWallRelationGeometry",
  "huayuGeometryAreaSquareMeters", "huayuLiveBasemapFeatureCollection"], geometryContext);
const member = (ref, role, ring) => ({type:"way", ref, role,
  geometry:ring.map(([lon, lat]) => ({lon, lat}))});
const relation = {type:"relation", id:1, tags:{natural:"wood", name:"测试山"}, members:[
  member(10, "outer", [[0,0],[2,0],[2,2],[0,2],[0,0]]),
  member(11, "inner", [[0.5,0.5],[1,0.5],[1,1],[0.5,1],[0.5,0.5]]),
]};
const compact = geometryContext.huayuLiveBasemapFeatureCollection([relation], {includeMountainRelief:true});
const legacy = geometryContext.huayuLiveBasemapFeatureCollection([relation, ...relation.members.map((item) =>
  ({...item, id:item.ref, tags:{}}))], {includeMountainRelief:true});
assert.deepEqual(compact, legacy);
assert.equal(compact.features.find((feature) => feature.properties.reliefRole === "surface")
  .geometry.coordinates.length, 2, "inner clearings must survive compact downloads");

// Distant zooms must not rebuild every tiny woodland fragment synchronously.
// The selection stays deterministic and keeps named/large mountain surfaces,
// while close views retain the complete viewport set.
const overviewContext = vm.createContext({
  huayuMountainSurfaceFeatureIntersectsViewport: () => true,
});
install(["huayuMountainSurfaceOverviewFeatures"], overviewContext);
const overviewFeatures = Array.from({length:5000}, (_, index) => ({
  type:"Feature", id:`overview-${index}`, geometry:{type:"Polygon",coordinates:[]},
  properties:{reliefRole:"surface", reliefArea:index === 4999 ? 1e9 : 1e6,
    name:index === 4999 ? "大华岭" : ""},
}));
const distant = overviewContext.huayuMountainSurfaceOverviewFeatures(
  overviewFeatures, null, 5,
);
assert.equal(distant.length, 1600, "overview rebuilds must use a bounded feature set");
assert.ok(distant.some((feature) => feature.properties.name === "大华岭"),
  "named mountains must survive overview thinning");
assert.equal(overviewContext.huayuMountainSurfaceOverviewFeatures(
  overviewFeatures.slice(0, 100), null, 10,
).length, 100, "close views must retain all loaded surfaces");

// Disconnected parts of one mountain must not disappear by rank or relative area.
geometryContext.clamp = (value,min,max) => Math.max(min,Math.min(max,value));
geometryContext.huayuTreeRandom = () => () => 0.5;
geometryContext.HUAYU_MOUNTAIN_WOODLAND_MIN_AREA = 1000000;
install(["huayuForestPark", "huayuWoodlandArea", "huayuMountainWoodlandName", "huayuMountainLandKind",
  "huayuTerrainElevationMeters", "huayuMountainReliefParts"],geometryContext);
const mountainParts = Array.from({length:16},(_,index) => {
  const x = index * 2;
  const size = index ? 0.01 : 1;
  return [[[x,0],[x+size,0],[x+size,size],[x,size],[x,0]]];
});
assert.equal(geometryContext.huayuMountainReliefParts({type:"relation",id:2,tags:{name:"测试岭"}},
  {type:"MultiPolygon",coordinates:mountainParts},13e9).length,16,
  "all real mountain parts above the fixed tiny-sliver threshold must survive");

// A narrow mapped garden hill is below the former 10,000 m2 part cutoff.
const meiling = {type:"Polygon",coordinates:[[
  [152.96432,14.633254],[152.9642966,14.6323745],[152.9642513,14.6321102],
  [152.9644417,14.6319094],[152.9645806,14.6321793],[152.9645346,14.6332012],
  [152.9644409,14.6337108],[152.9641678,14.634043],[152.964121,14.6338844],
  [152.9642459,14.6335258],[152.96432,14.633254],
]]};
const meilingArea = geometryContext.huayuGeometryAreaSquareMeters(meiling);
assert.ok(meilingArea > 0 && meilingArea < 10000);
const smallHillParts = geometryContext.huayuMountainReliefParts(
  {type:"way",id:39038953,tags:{leisure:"garden",name:"梅岭"}},meiling,meilingArea);
assert.equal(smallHillParts.length,1,"small mapped mountains must retain their real footprint");
assert.ok(smallHillParts[0].properties.reliefHeight < 40,
  "a campus hill must not inherit the former 120 metre minimum");
const grass = geometryContext.huayuMountainReliefParts({type:"relation",id:417972,
  tags:{landuse:"grass",name:"一得阁拉米高山草地"}},compact.features[0].geometry,50e9);
assert.equal(grass[0].properties.reliefLandKind,"open");
assert.ok(grass[0].properties.reliefHeight <= 420,"open highlands need gentler inferred relief");

// Fresh disk snapshots avoid the network; stale snapshots remain visible on refresh failure.
const key = "9/474/242";
const entry = (refreshAt) => ({data:{type:"FeatureCollection", features:[]}, refreshAt,
  cachedAt:Date.now(), loadedAt:Date.now()});
const state = () => ({active:true, terrainTileCache:new Map(), terrainPendingTiles:new Map(),
  terrainVisibleTileKeys:new Set([key]), terrainQueuedTileKeys:new Set([key]),
  terrainQueue:[{key,z:9,x:474,y:242}], terrainFailedTiles:new Map()});
let networkCalls = 0;
let snapshots = 0;
let retryDelay = 0;
let stored = entry(Date.now() + 10800000);
let failRefresh;
const loadingContext = vm.createContext({
  loadHuayuTerrainPreload:() => {}, huayuTerrainPreloadAttempted:true,
  huayuTerrainPreloadCovers:() => false, HUAYU_LIVE_BASEMAP_MIN_ZOOM:12.5,
  terrainOverlayEnabled:true, HUAYU_TERRAIN_TILE_CONCURRENCY:4, HUAYU_TERRAIN_CACHE_MS:10800000,
  huayuTerrainTileRevision:0, AbortController, Date,
  loadHuayuTerrainStoredTile:async () => stored,
  fetchHuayuTerrainTile:() => {networkCalls++; return new Promise((resolve,reject) => {failRefresh=reject;});},
  rebuildHuayuTerrainData:() => {}, mergeHuayuLiveBasemapTiles:() => {snapshots++;},
  updateHuayuLiveBasemapDiagnostics:() => {}, pruneHuayuTerrainTileCache:() => {},
  scheduleHuayuLiveBasemap:() => {}, window:{clearTimeout:() => {}, setTimeout:(_,delay) => {retryDelay=delay;}},
});
install(["scheduleNextHuayuTerrainRefresh", "pumpHuayuTerrainTiles"], loadingContext);
const freshState = state();
loadingContext.pumpHuayuTerrainTiles(freshState);
await freshState.terrainPendingTiles.get(key).promise;
assert.equal(networkCalls, 0);
assert.equal(freshState.terrainTileCache.get(key).source, "browser-cache");
assert.ok(snapshots > 0);
stored = entry(Date.now() - 1000);
const staleState = state();
loadingContext.pumpHuayuTerrainTiles(staleState);
const refresh = staleState.terrainPendingTiles.get(key).promise;
await new Promise(setImmediate);
assert.equal(networkCalls, 1);
assert.ok(staleState.terrainTileCache.has(key), "stale terrain must display before the refresh finishes");
failRefresh(new Error("temporary timeout"));
await refresh;
assert.ok(staleState.terrainTileCache.has(key), "timeout must not erase the retained terrain");
assert.ok(retryDelay >= 14900 && retryDelay <= 15000, "stale refresh failures must respect retry cooldown");

// Panning preserves bounded in-flight downloads rather than repeatedly restarting them.
const previousController = new AbortController();
const panState = state();
panState.terrainPendingTiles.set("previous-tile", {controller:previousController});
loadingContext.HUAYU_TERRAIN_MIN_ZOOM = 7.5;
loadingContext.HUAYU_TERRAIN_TILE_ZOOM = 9;
loadingContext.HUAYU_TERRAIN_MAX_VISIBLE_TILES = 16;
loadingContext.huayuLiveBuildingVisibleTiles = () => [{key,z:9,x:474,y:242}];
loadingContext.pumpHuayuTerrainTiles = () => {};
loadingContext.hydrateHuayuTerrainSnapshots = () => {};
install(["refreshHuayuTerrainTiles"], loadingContext);
loadingContext.refreshHuayuTerrainTiles({getZoom:() => 9}, panState, {west:1,east:2,south:1,north:2});
assert.equal(previousController.signal.aborted, false);

// Denied browser storage must fail open immediately, without preventing live requests.
const deniedContext = vm.createContext({huayuTerrainStoragePromise:null,
  window:{setTimeout,clearTimeout,indexedDB:{open:() => {throw new Error("storage denied");}}}});
install(["huayuTerrainStorage", "loadHuayuTerrainStoredTile"], deniedContext);
assert.equal(await deniedContext.loadHuayuTerrainStoredTile(key), null);

// Unchanged padded viewports reuse the buffer; cancelled async builds cannot overwrite it.
let uploads = 0;
let vertexCalls = 0;
let cancelBuild = false;
let clock = 0;
let layer;
const renderContext = vm.createContext({
  terrainOverlayEnabled:true, HUAYU_TERRAIN_MIN_ZOOM:7.5, HUAYU_MOUNTAIN_SURFACE_VERTEX_LIMIT:500000,
  HUAYU_REGIONAL_MOUNTAIN_SURFACE_MIN_AREA:400000000,
  HUAYU_LIVE_BASEMAP_LAYERS:{mountainOverviewTexture:"existing-material"},
  huayuMountainSurfaceRgb:() => [0.5,0.5,0.5],
  huayuMountainSurfaceViewportBounds:() => ({west:-0.2,east:1.2,south:-0.2,north:1.2}),
  huayuAdministrativeQueryBounds:() => ({west:0,east:1,south:0,north:1}),
  huayuMountainSurfaceFeatureIntersectsViewport:() => true,
  huayuMountainSurfaceOverviewFeatures: (features) => features,
  huayuWoodlandMaterialCoverage:() => null,
  huayuWoodlandMaterialOcclusions:() => [],
  huayuMountainSurfaceFeatureVertices:() => {
    vertexCalls++;
    if (cancelBuild) layer.rebuildRevision++;
    return Array(54).fill(0);
  },
  huayuLiveBasemapStates:new WeakMap(), Float32Array,
  huayuMountainWaterContexts:new WeakMap(),
  clamp:(value,min,max) => Math.max(min,Math.min(max,value)),
  performance:{now:() => {clock+=20; return clock;}}, window:{setTimeout,clearTimeout},
});
install(["huayuAdministrativeBoundsContain", "createHuayuWoodlandMaterialLayer"], renderContext);
layer = renderContext.createHuayuWoodlandMaterialLayer({mountainRelief:["","","","",""],mountainContour:""});
layer.gl = {bindBuffer:() => {}, bufferData:() => {uploads++;}};
layer.map = {getZoom:() => 11, triggerRepaint:() => {}};
layer.features = [{id:1,properties:{reliefRole:"surface",reliefArea:1e8}}];
layer.dataRevision = 1;
layer.rebuildRevision = 1;
await layer.rebuild();
assert.equal(uploads, 1);
assert.equal(vertexCalls, 1);
await layer.rebuild();
assert.equal(vertexCalls, 1, "same viewport must reuse the complete mesh");
layer.dataRevision++;
cancelBuild = true;
await layer.rebuild();
assert.equal(uploads, 1, "cancelled builds must retain the previous buffer");

// Regional ranges must vary throughout their extent, including far from a centre point.
const surfaceContext = vm.createContext({clamp:(value,min,max) => Math.max(min,Math.min(max,value))});
surfaceContext.HUAYU_MOUNTAIN_WOODLAND_MIN_AREA = 1000000;
install(["huayuTreeHash", "huayuMountainSurfaceNoise", "huayuRegionalMountainSurface", "huayuMountainPlainName"], surfaceContext);
const bounds = {west:149.5,east:153.3,south:4.2,north:8.2};
const rangeFeature = {id:"regional-range", properties:{reliefPeaks:"[]"}};
const range = surfaceContext.huayuRegionalMountainSurface(rangeFeature,bounds,0.99,50e9,2500);
for (const [west,south] of [[149.7,4.4],[151.5,4.4],[149.7,6.3],[151.5,6.3]]) {
  const heights = [];
  for (let row=0; row<10; row++) for (let column=0; column<10; column++) {
    heights.push(range.heightAt([west+column*0.15,south+row*0.15]));
  }
  assert.ok(Math.max(...heights)-Math.min(...heights)>450,
    "each regional quadrant needs ridge/valley variation instead of a flat plateau");
  assert.ok(heights.filter((height) => height<250).length<10,
    "regional shading must not be limited to a handful of isolated centres");
}
const coordinate = [150.8,6.5];
assert.ok(Math.abs(range.heightAt(coordinate)-range.heightAt([150.80001,6.50001]))<2,
  "the shared elevation field must remain continuous for shading and contour interpolation");
assert.equal(range.heightAt(coordinate), surfaceContext.huayuRegionalMountainSurface(
  rangeFeature,bounds,0.99,50e9,2500).heightAt(coordinate), "regional fields must survive reload deterministically");
const measured = surfaceContext.huayuRegionalMountainSurface({id:"measured-range",properties:{
  reliefPeaks:JSON.stringify([{coordinates:coordinate,elevation:2300}]),
}},bounds,0.99,50e9,2500);
assert.equal(measured.heightAt(coordinate),2300,"mapped peak elevation must constrain the field");

// Small woodland keeps its existing local hill model, while regional woodland skips invented centres.
surfaceContext.huayuMountainSurfaceModels = new WeakMap();
surfaceContext.huayuMountainWaterContexts = new WeakMap();
surfaceContext.huayuMountainGeometryBounds = new WeakMap();
surfaceContext.HUAYU_REGIONAL_MOUNTAIN_SURFACE_MIN_AREA = 400000000;
surfaceContext.huayuMountainSurfaceSamplingPolygon = (polygon) => polygon;
surfaceContext.huayuPointInPolygonGeometry = () => true;
surfaceContext.huayuMountainSurfaceBoundaryDistance = () => 10000;
let localAnchorCalls = 0;
surfaceContext.huayuMountainSurfaceAnchors = () => {
  localAnchorCalls++;
  return [{coordinates:[0.5,0.5],height:800,sigma:20000}];
};
surfaceContext.huayuMountainSurfaceNoise = () => 0.5;
install(["huayuMountainOuterContains", "huayuMountainSegmentIndex",
  "huayuMountainSurfaceFeatureIntersectsViewport", "huayuMountainSurfaceModel"], surfaceContext);
const polygon = {type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]};
const smallModel = surfaceContext.huayuMountainSurfaceModel({id:"small",properties:{reliefArea:88e6,reliefHeight:800}},polygon);
assert.equal(localAnchorCalls,1);
assert.equal(smallModel.regionalWavelength,0);
assert.ok(Math.abs(smallModel.heightAt([0.5,0.5])-781.76)<1e-8,
  "accepted small-area rendering must keep its previous height formula");
surfaceContext.huayuMountainSurfaceModel({id:"large",properties:{reliefArea:50e9,reliefHeight:2500}},polygon);
assert.equal(localAnchorCalls,1,"regional areas must not use sparse inferred hill centres");

// Scale the edge fade and anchor spread to the actual small hill rather than kilometres.
const previousAnchors = surfaceContext.huayuMountainSurfaceAnchors;
const previousPointInPolygon = surfaceContext.huayuPointInPolygonGeometry;
install(["huayuTreeRandom", "huayuWallPointInRing", "huayuPointInPolygonGeometry",
  "huayuGeometryInteriorPoint", "huayuMountainSurfaceAnchors"],surfaceContext);
const campusHill = surfaceContext.huayuMountainSurfaceModel({id:"meiling",
  properties:smallHillParts[0].properties},meiling);
const hillInside = surfaceContext.huayuGeometryInteriorPoint(meiling);
assert.ok(campusHill.heightAt(hillInside) > campusHill.peakHeight * 0.5,
  "narrow small hills need visible slope instead of a 240 metre fade erasing them");
assert.equal(campusHill.heightAt([152.965,14.633]),0,"small hill shading must stay inside its footprint");
install(["huayuMountainContourInterval"],surfaceContext);
assert.equal(surfaceContext.huayuMountainContourInterval(campusHill.peakHeight),5,
  "small hill contours must use a matching interval");
surfaceContext.huayuMountainSurfaceAnchors = previousAnchors;
surfaceContext.huayuPointInPolygonGeometry = previousPointInPolygon;
install(["huayuMountainPlainName"], renderContext);
const cachedLayer = renderContext.createHuayuWoodlandMaterialLayer({mountainRelief:["","","","",""],mountainContour:""});
cachedLayer.setData([{id:"flat",properties:{reliefRole:"surface",name:"北沛口林区（平原）"}},
  {id:"mountain",properties:{reliefRole:"surface",name:"大华岭"}}]);
assert.equal(cachedLayer.features.length,1,"old persisted plain-woodland snapshots must also stay flat");

// Exact irregular footprints must retain peninsulas lost by point-stride simplification.
const notchedRing = [[0,0],[3,0],[3,1],[1.1,1],[1.1,3],[0.9,3],[0.9,1],[0,1],[0,0]];
const contains = surfaceContext.huayuMountainOuterContains(notchedRing,{west:0,east:3,south:0,north:3});
assert.equal(contains([1,2.9]),true,"a narrow real mountain extension must remain covered");
assert.equal(contains([2,2]),false,"exact footprint must not fill exterior clearings");

// Rivers lower the same field used by slope shading and contours; distant hills stay unchanged.
const valleyFeature = {id:"small",properties:{reliefArea:88e6,reliefHeight:800}};
surfaceContext.huayuMountainWaterContexts.set(valleyFeature,{features:[{id:"river",
  geometry:{type:"LineString",coordinates:[[0.5,0.2],[0.5,0.8]]}}]});
const valleyModel = surfaceContext.huayuMountainSurfaceModel(valleyFeature,polygon);
assert.ok(valleyModel.heightAt([0.5,0.5])<smallModel.heightAt([0.5,0.5])*0.1,
  "mapped water must carve a valley, not sit on a random ridge");
assert.equal(valleyModel.heightAt([0.6,0.5]),smallModel.heightAt([0.6,0.5]),
  "water influence must remain local and preserve accepted distant mountain appearance");
const lakeFeature = {id:"small",properties:{reliefArea:88e6,reliefHeight:800}};
surfaceContext.huayuMountainWaterContexts.set(lakeFeature,{features:[{id:"lake",geometry:{type:"Polygon",
  coordinates:[[[0.49,0.4],[0.51,0.4],[0.51,0.6],[0.49,0.6],[0.49,0.4]]]}}]});
const lakeModel = surfaceContext.huayuMountainSurfaceModel(lakeFeature,polygon);
assert.ok(lakeModel.heightAt([0.511,0.5])<lakeModel.heightAt([0.54,0.5]),
  "lake shore must have low slopes rising into the surrounding mountain");

// Tight budgets reduce resolution across the whole extent instead of cutting off grid rows.
const meshContext = vm.createContext({HUAYU_TERRAIN_MIN_ZOOM:5.5,
  clamp:(value,min,max) => Math.max(min,Math.min(max,value)),
  huayuMountainSurfaceModel:() => ({bounds:{west:0,east:100,south:0,north:0.01},cosine:1,
    areaSquareMeters:1e9,peakHeight:800,heightAt:() => 200,regionalWavelength:10000}),
  huayuMountainContourInterval:() => 40,
  window:{maplibregl:{MercatorCoordinate:{fromLngLat:({lng,lat},altitude) => ({x:lng,y:lat,z:altitude})}}},
});
install(["huayuMountainSurfaceFeatureVertices"],meshContext);
for (const budget of [6,12,300,600]) {
  const vertices = meshContext.huayuMountainSurfaceFeatureVertices({geometry:polygon},budget,null,8);
  const positions = Array.from({length:vertices.length/9},(_,index) => vertices.slice(index*9,index*9+2));
  assert.ok(positions.length<=budget);
  assert.equal(Math.max(...positions.map((point) => point[0])),100);
  assert.equal(Math.max(...positions.map((point) => point[1])),0.01,
    "both ends must survive the vertex budget even for an elongated mountain");
}

// Overview tiles cover every visible region; do not silently truncate the centre-priority list.
const overviewState = state();
loadingContext.HUAYU_TERRAIN_MIN_ZOOM = 5.5;
loadingContext.huayuLiveBuildingVisibleTiles = (_,zoom) => Array.from({length:zoom===9?40:10},(_,x) =>
  ({key:`${zoom}/${x}/0`,z:zoom,x,y:0}));
loadingContext.refreshHuayuTerrainTiles({getZoom:() => 6},overviewState,{west:1,east:2,south:1,north:2});
assert.equal(overviewState.terrainVisibleTileKeys.size,14);
assert.ok([...overviewState.terrainVisibleTileKeys].slice(0,4).every((tile) => tile.startsWith("9/")),
  "overview cold starts need lightweight centre requests before wider queries");
assert.ok([...overviewState.terrainVisibleTileKeys].slice(4).every((tile) => tile.startsWith("8/")));

install(["hydrateHuayuTerrainSnapshots"],loadingContext);
stored=entry(Date.now()+10800000);
const hydrationState=state();
hydrationState.terrainPendingTiles.set("slow-centre",{controller:new AbortController()});
await loadingContext.hydrateHuayuTerrainSnapshots(hydrationState,[{key,z:9,x:474,y:242}]);
assert.equal(hydrationState.terrainTileCache.get(key)?.source,"browser-cache",
  "disk coverage must not wait behind occupied download slots");

// Water/roads/buildings must remain above the material, independent of a style's original water order.
const orderContext = vm.createContext({HUAYU_LIVE_BASEMAP_LAYERS:{mountainOverviewTexture:"mountain",water:"live-water",waterway:"live-river"}});
install(["syncHuayuMountainFeatureOrder"],orderContext);
const layerOrder = ["water","river","forest","mountain","parks","building","road","labels"];
const styleLayers = [{id:"water","source-layer":"water"},{id:"river","source-layer":"waterway"},
  {id:"forest",type:"fill","source-layer":"landcover"},{id:"parks",type:"fill","source-layer":"landuse"},
  {id:"building","source-layer":"building"},{id:"road","source-layer":"transportation"},{id:"labels"}];
orderContext.syncHuayuMountainFeatureOrder({getLayersOrder:() => layerOrder,getStyle:() => ({layers:styleLayers}),
  moveLayer:(id,anchor) => {layerOrder.splice(layerOrder.indexOf(id),1);layerOrder.splice(anchor?layerOrder.indexOf(anchor):layerOrder.length,0,id);}});
for (const id of ["water","river","building","road"]) assert.ok(layerOrder.indexOf(id)>layerOrder.indexOf("mountain"));
assert.ok(layerOrder.indexOf("forest")<layerOrder.indexOf("mountain"));
assert.ok(layerOrder.indexOf("parks")<layerOrder.indexOf("mountain"),
  "translucent land-use fills must not wash out the mountain material");

// The translucent material must leave water and building pixels untouched,
// even if the renderer has already drawn opaque fills in a separate pass.
const probes = [[0.1,0.1],[0.3,0.3],[0.7,0.7],[0.9,0.9]].map(([x,y]) => ({point:[x*1024,(1-y)*1024],alpha:0}));
let paths;
let path;
const maskCanvas = {width:0,height:0};
const maskContext = {globalCompositeOperation:"source-over",beginPath:() => {paths=[];},
  moveTo:(x,y) => {path=[[x,y]];paths.push(path);},lineTo:(x,y) => path.push([x,y]),closePath:() => {},
  fill:() => {
    for (const probe of probes) {
      const inside = paths.filter((ring) => geometryContext.huayuWallPointInRing(probe.point,ring)).length % 2;
      if (inside) {
        probe.alpha=maskContext.globalCompositeOperation==="destination-out"?0:1;
        probe.material = maskContext.fillStyle === "#000000" ? 0 : 1;
      }
    }
  }};
maskCanvas.getContext = () => maskContext;
const maskVm = vm.createContext({document:{createElement:() => maskCanvas},
  window:{maplibregl:{MercatorCoordinate:{fromLngLat:({lng,lat}) => ({x:lng,y:-lat,z:0})}}}});
install(["huayuWoodlandMaterialCoverage"],maskVm);
const square = (low,high) => ({geometry:{type:"Polygon",coordinates:[
  [[low,low],[high,low],[high,high],[low,high],[low,low]]]}});
maskVm.huayuWoodlandMaterialCoverage([square(0,1)],{west:0,east:1,south:0,north:1},
  [square(0.2,0.4),square(0.6,0.8)]);
assert.deepEqual(probes.map((probe) => probe.alpha),[1,0,0,1],
  "forest pixels must remain while exact water/building areas are excluded");
maskVm.huayuWoodlandMaterialCoverage([
  {...square(0,1),properties:{reliefLandKind:"open"}},
  {...square(0.2,0.4),properties:{reliefLandKind:"wood"}},
],{west:0,east:1,south:0,north:1});
assert.deepEqual(probes.map((probe) => probe.material),[0,1,0,0],
  "open terrain must not repaint the woodland footprint inside its extent");
const overlayVm = vm.createContext({HUAYU_LIVE_BASEMAP_LAYERS:{water:"live-water"},
  HUAYU_LIVE_BUILDING_LAYER:"buildings",HUAYU_PAVILION_LAYER:"pavilions",HUAYU_PAVILION_BASE_LAYER:"pavilion-bases",
  huayuMountainSurfaceFeatureIntersectsViewport:() => true});
install(["huayuWoodlandMaterialOcclusions"],overlayVm);
const mixedSource = [{...square(0,1),properties:{renderKind:"land"}},
  {...square(0.2,0.4),properties:{renderKind:"water"}},
  {...square(0,1),properties:{renderKind:"mountain-surface"}}];
const overlays = overlayVm.huayuWoodlandMaterialOcclusions({
  getStyle:() => ({layers:[{id:"live-water",type:"fill",source:"mixed-live-source"}]}),
  querySourceFeatures:() => mixedSource},[],{west:0,east:1,south:0,north:1});
assert.equal(overlays.length,1,"mixed live sources must not erase the mountain or woodland itself");
assert.equal(overlays[0].properties.renderKind,"water");
console.log("Terrain regressions passed: geometry, cache, retry, pan, mesh coverage, water valleys and layer order.");
