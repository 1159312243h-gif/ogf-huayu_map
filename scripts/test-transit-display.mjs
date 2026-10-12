import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {Worker} from "node:worker_threads";
import {performance} from "node:perf_hooks";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
// A reused frame must honour an explicit refresh. A pending old viewport must
// not replace a cached complete frame after the user returns into its bounds.
const frames = [], timers = new Map();
let resets = 0, renders = 0, labelUpdates = 0;
const cachedNetwork = {};
const rendererContext = vm.createContext({
  window: {
    L: {Canvas: {extend: methods => class {
      constructor(options) {this.options = options; this._map = {}; this._container = {};}
      _reset() {resets++;}
      refreshProjection = methods.refreshProjection;
    }}},
    requestAnimationFrame: fn => {frames.push(fn); return frames.length;},
    clearTimeout: id => timers.delete(id), setTimeout: fn => {timers.set(1, fn); return 1;},
  },
  map: {hasLayer: () => true, getBounds: () => ({}), getZoom: () => 12},
  vectorPerspectiveActive: false, transitCanvasProjectionFrame: null,
  transitInteractionActive: false,
  mapViewMode: "transit", selectedTransitId: null, transitNetworkData: cachedNetwork,
  transitRenderedNetwork: cachedNetwork, transitRenderedRailwayData: null, railwayRoutingData: null,
  transitRenderedConnectionData: null, railwayConnectionsData: null,
  transitRenderedBounds: {contains: () => true}, transitRenderedFilterKey: "11100",
  transitRenderFilterKey: () => "11100", getTransitDisplayNetwork: value => value,
  updateTransitNetworkLabels: () => {labelUpdates++;},
  renderTransitNetwork: () => {renders++;}, TRANSIT_RENDER_DELAY_MS: 250, transitRenderTimer: null,
});
for (const name of ["createTransitCanvasRenderer", "scheduleTransitCanvasProjection", "scheduleTransitNetworkRender"]) {
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], rendererContext);
}
rendererContext.transitCanvasRenderer = rendererContext.createTransitCanvasRenderer();
rendererContext.scheduleTransitCanvasProjection();
rendererContext.scheduleTransitCanvasProjection();
assert.equal(frames.length, 1, "zoom, resize and data arrival coalesce into one frame");
frames.shift()();
assert.equal(resets, 1, "reset both canvas transform and path projection after the completed camera update");
rendererContext.vectorPerspectiveActive = true;
rendererContext.scheduleTransitCanvasProjection(); frames.shift()();
assert.equal(resets, 1, "hidden Leaflet traffic is not rebuilt in perspective");
rendererContext.vectorPerspectiveActive = false;
rendererContext.scheduleTransitNetworkRender();
assert.equal(renders, 0, "ordinary movement keeps the complete cached display objects");
assert.equal(labelUpdates, 1);
rendererContext.scheduleTransitNetworkRender({force: true, immediate: true});
assert.equal(renders, 1, "explicit refresh bypasses the viewport cache");
rendererContext.scheduleTransitNetworkRender({force: true});
assert.equal(timers.size, 1);
rendererContext.scheduleTransitNetworkRender();
assert.equal(timers.size, 0, "returning to cached bounds cancels a stale queued viewport render");
rendererContext.transitInteractionActive = true;
rendererContext.scheduleTransitNetworkRender({force:true,immediate:true});
assert.equal(renders,1,"a arriving packet/filter change never rebuilds traffic during a gesture");
rendererContext.transitInteractionActive = false;
rendererContext.scheduleTransitNetworkRender({force:true});
rendererContext.transitInteractionActive = true;
timers.get(1)();
assert.equal(renders,1,"a scheduled refresh that outlives gesture start is deferred as well");
rendererContext.transitInteractionActive = false;
rendererContext.transitDisplayFilters = {railway:true};
rendererContext.railwayRoutingData = {};
vm.runInContext(app.match(/  async function ensureNationalRailwayDisplayLoaded\([^]*?\n  \}/u)[0],rendererContext);
await rendererContext.ensureNationalRailwayDisplayLoaded();
await rendererContext.ensureNationalRailwayDisplayLoaded();
assert.equal(renders,1,"loaded railway infrastructure cannot force a rebuild on every map move");

// Exercise the shipped Leaflet renderer itself. Its canvas and paths can hold
// an older zoom/origin while cached station markers already use the new view.
const paintedStarts = [];
const context2d = {scale() {}, translate() {}, setTransform() {}, clearRect() {}, save() {}, restore() {},
  beginPath() {}, rect() {}, clip() {}, moveTo(x, y) {paintedStarts.push([x, y]);}, lineTo() {},
  closePath() {}, stroke() {}, fill() {}, setLineDash() {}};
const createElement = () => ({style: {}, addEventListener() {}, removeEventListener() {},
  getContext: () => context2d});
const leafletWindow = {devicePixelRatio: 2, screen: {}, addEventListener() {}, removeEventListener() {},
  setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {return 1;}, cancelAnimationFrame() {}};
const leafletRuntime = vm.createContext({window: leafletWindow, navigator: {userAgent: "node", platform: "Win32"},
  document: {documentElement: {style: {}}, createElement, createElementNS: createElement},
  setTimeout() {}, clearTimeout() {}, console});
vm.runInContext(await readFile(new URL("../site/leaflet.js", import.meta.url), "utf8"), leafletRuntime);
const L = leafletWindow.L;
rendererContext.window.L = L;
const actualRenderer = rendererContext.createTransitCanvasRenderer();
let cameraZoom = 12, origin = L.point(0, 0);
const center = L.latLng(14.63441, 152.93879), size = L.point(1200, 700);
const setCamera = (zoom, lon = center.lng) => {
  cameraZoom = zoom;
  center.lng = lon;
  origin = L.CRS.EPSG3857.latLngToPoint(center, zoom).subtract(size.divideBy(2)).round();
};
const geographicMap = {
  getSize: () => size, getZoom: () => cameraZoom, getCenter: () => center,
  getZoomScale: (zoom, from) => 2 ** (zoom - from),
  project: (point, zoom) => L.CRS.EPSG3857.latLngToPoint(point, zoom),
  _getNewPixelOrigin: () => origin,
  containerPointToLayerPoint: point => point,
  latLngToLayerPoint: point => L.CRS.EPSG3857.latLngToPoint(point, cameraZoom).round().subtract(origin),
};
actualRenderer._map = geographicMap;
actualRenderer._container = createElement(); actualRenderer._ctx = context2d;
const line = L.polyline([[14.63, 152.935], [14.64, 152.945]], {smoothFactor: 0});
line._map = geographicMap; line._renderer = actualRenderer;
actualRenderer._initPath(line);
actualRenderer.on("update", actualRenderer._updatePaths, actualRenderer);
setCamera(9); actualRenderer.refreshProjection();
for (const zoom of [12, 15, 12, 9, 12]) {
  setCamera(zoom, zoom === 15 ? 152.94 : 152.93879);
  paintedStarts.length = 0;
  // No network or polyline reconstruction: refresh the retained geographic path.
  actualRenderer.refreshProjection();
  const stationPoint = geographicMap.latLngToLayerPoint(line.getLatLngs()[0]);
  assert.equal(line._rings[0][0].x, stationPoint.x);
  assert.equal(line._rings[0][0].y, stationPoint.y);
  assert.ok(paintedStarts.length > 0 && paintedStarts.every(([x, y]) => x === stationPoint.x && y === stationPoint.y),
    "no old-scale path may be painted before the new projection is ready");
  assert.equal(actualRenderer._zoom, zoom);
  assert.equal(actualRenderer._container.width, 2 * size.x * 1.4,
    "retina canvas keeps CSS coordinates separate from physical pixels");
}
const rules = JSON.parse(await readFile(new URL("../site/transit-services.json", import.meta.url), "utf8"));
const payload = JSON.parse(await readFile(new URL("../site/transit-preload.json", import.meta.url), "utf8"));
const runtime = vm.createContext({window:{location:{search:""}}, URLSearchParams, performance,
  __rules:rules, console});
vm.runInContext(`${app.slice(0,app.indexOf("  const elements ="))}
  ${app.match(/  const VECTOR_TRANSIT_LINE_SOURCE =[^\n]+/u)[0]}
  ${app.match(/  const VECTOR_TRANSIT_STOP_SOURCE =[^\n]+/u)[0]}
  ${app.match(/  const VECTOR_TRANSIT_LAYER_IDS =[^]*?  \};/u)[0]}
  let transitServiceRules = {};
  let transitPreloadSnapshots = [];
  let selectedTransitItems = [];
  let selectedTransitRoot = null;
  let transitRelations = [];
  let multimodalRelationsById = new Map();
  let mapViewMode = 'transit';
  let selectedTransitId = null;
  let selectedNetworkStationId = null;
  let railwayConnectionsData = null;
  let railwayRoutingData = null;
  let allowInferredRailConnections = true;
  let transitNetworkData = null;
  let vectorPerspectiveActive = true;
  let vectorPerspectiveMap = null;
  let vectorTransitBoundMap = null;
  let vectorTransitPopup = null;
  let vectorTransitOverlayMap = null;
  let vectorTransitStyleWaitMap = null;
  let vectorTransitViewCache = null;
  let vectorTransitOverlaySignature = '';
  const vectorTransitIconIds = new Set();
  const elements = {transitNetworkStatus:{dataset:{}}};
  const transitDisplayFilters = {metro:true,tram:true,railway:true,bus:false};
  const transitLineBoundsCache = new WeakMap();
  const transitDisplayNetworkCache = new WeakMap();
  globalThis.api = {hydrateTransitNetwork, mergeTransitStops, mergeTransitStopsForDisplay,
    getTransitDisplayNetwork, transitDisplayStopsInBounds, invalidateTransitDisplayNetwork,
    collectTransitNetwork, mergeTransitNetworks, transitCollectionWorkerSource, transitCollectionBounds, distanceMeters,
    trainRouteSetsConflict, uniqueTransitRoutes, transitStationDisplayMergeRadius, createTransitStopIcon,
    joinConnectedTransitLines, transitPathDirectionSimilarity,
    getVisibleTransitRoutes, getTransitLineBounds, transitStopMatchesFilters, transitLayerCategory,
    shouldShowTransitStopLabel, collapseParallelPublicTransitRailLinesForDisplay,
    vectorTransitOverlayData, setNetwork(n) {transitNetworkData=n;},
    syncVectorTransitOverlay, setVectorMap(m) {vectorPerspectiveMap=m;},
    applyStationInterchangeOverrides, transitStationDetailRoutes,
    reconcileTransitDisplayStations, splitTransitStationDisplaySystems,
    createFocusedTransitRouteResolver, setFocusedItems(root,items) {selectedTransitRoot=root;selectedTransitItems=items;},
    rules() {return transitServiceRules;},
    setRules: initializeTransitServiceRules};
  initializeTransitServiceRules(__rules);
  return;
  ${app.slice(app.indexOf("  async function runPlaceSearch"))}`,runtime);
const api = runtime.api;
const plain = value => JSON.parse(JSON.stringify(value));
const railway = (id, identity, color = "#036eb8") => ({id,type:"train",identity,label:identity,color});
const stop = (id,name,lat,lon,routes,extra={}) => ({id,sourceId:id,name,lat,lon,sourceLat:lat,
  sourceLon:lon,isRail:true,isBus:false,routes,displayRoutes:[],...extra});
const firstRoute = railway(1,"train:national:fast");
const secondRoute = railway(2,"train:金铁:local","#1eaa39");
const pair = [stop(1,"测试铁路站",12,150,[firstRoute],{isMainline:true}),
  stop(2,"测试铁路站",12.0018,150,[secondRoute],{lat:12.003,lon:150.001})];
const original = plain(pair);
const grouped = api.mergeTransitStopsForDisplay(pair);
assert.equal(grouped.length,1,"one physical train station keeps one marker across service types and snapped tracks");
assert.deepEqual(plain(grouped[0].routes).map(r=>r.identity),[firstRoute.identity,secondRoute.identity],
  "click details retain both services");
assert.deepEqual(plain(grouped[0].displaySourceIds),["1","2"]);
assert.equal(grouped[0].lat,pair[0].lat,"display anchor is stable, not reprojected onto another corridor");
assert.deepEqual(plain(pair),original,"display grouping must not mutate routing IDs, coordinates or memberships");
assert.equal(api.mergeTransitStops(pair).length,2,"routing corridor conflict remains separate in the navigation graph");
api.setRules({});
assert.equal(api.mergeTransitStopsForDisplay(pair).length,1,"ordinary railway dedup does not depend on manual overrides");
assert.equal(api.mergeTransitStopsForDisplay([...pair,stop(3,"测试铁路站",12.1,150,[firstRoute])]).length,2,
  "distant equally named stations remain separate");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],stop(4,"测试铁路站",12,150,
  [{type:"subway",identity:"subway:test"}])]).length,2,"metro and railway remain distinct without confirmed override");
const mixedDisplay = api.mergeTransitStopsForDisplay([
  {...pair[0],routes:[firstRoute,{type:"subway",identity:"subway:test"}]},pair[1]]);
assert.equal(mixedDisplay.length,2,"a shared source with both systems displays separate railway and metro stations");
assert.equal(mixedDisplay.filter(s=>s.displaySystem==="railway").length,1,
  "railway platforms still deduplicate within their own system");
assert.ok(mixedDisplay.every(s=>api.transitStationDetailRoutes(s).every(r=>api.transitLayerCategory(r)===s.displaySystem)),
  "click information cannot leak routes from the other system");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],stop(5,"望铁测试铁路站",12,150,[secondRoute])]).length,2,
  "similar or prefixed names do not merge");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],stop(6,"测试铁路站",12,150,[],{isRail:false,isBus:true})]).length,2,
  "equally named bus stops do not merge into railway stations");
const chain = Array.from({length:4},(_,i)=>stop(i+10,"沿线同名站",12+i*0.0016,150,[firstRoute]));
assert.equal(api.mergeTransitStopsForDisplay(chain).length,2,"station radius uses a fixed anchor, never transitive distance chaining");
api.setRules(rules);
const network = api.hydrateTransitNetwork(payload.snapshots.find(s=>s.id === "huaxia").network);
const routingBeforeDisplay = plain(network.stops);
const previousApp = await readFile(new URL("../releases/6.6-huayu-height-field-model-cache-v1/app.js",import.meta.url),"utf8");
const previousMerge = previousApp.match(/  function mergeTransitStops\([^]*?\n  \}/u)[0]
  .replace("function mergeTransitStops(","function legacyMergeTransitStops(");
vm.runInContext(`const distanceMeters=api.distanceMeters;
  const trainRouteSetsConflict=api.trainRouteSetsConflict;
  const uniqueTransitRoutes=api.uniqueTransitRoutes;
  ${previousMerge}`,runtime);
assert.ok(JSON.stringify(api.mergeTransitStops(network.stops)) === JSON.stringify(runtime.legacyMergeTransitStops(network.stops)),
  "name indexing preserves the released navigation graph's station IDs, membership and coordinates");
// Joining is shared with the collector/routing graph. Avoiding speculative
// copies must retain all four orientations, tie order and certified gaps.
const previousJoin = previousApp.match(/  function joinConnectedTransitLines\([^]*?\n  \}/u)[0]
  .replace("function joinConnectedTransitLines(","function legacyJoinConnectedTransitLines(");
vm.runInContext(`const transitPathDirectionSimilarity = api.transitPathDirectionSimilarity;
  ${previousJoin}\n globalThis.joinChecks = {joinConnectedTransitLines:api.joinConnectedTransitLines, legacyJoinConnectedTransitLines};`,runtime);
const joinFixtures = [network.lines.filter(l=>l.routes.some(r=>r.publicTransitRailSystem))];
for (const reverseSeed of [false,true]) {
  for (const reverseExtension of [false,true]) {
    for (const gap of [0,0.00003,0.002]) {
      const seed = [{lat:12,lon:150},{lat:12.01,lon:150}];
      const extension = [{lat:12.01+gap,lon:150},{lat:12.02,lon:150}];
      if (reverseSeed) seed.reverse();
      if (reverseExtension) extension.reverse();
      joinFixtures.push([{id:1,geometry:seed,routes:[firstRoute]},
        {id:2,geometry:extension,routes:[firstRoute]},
        {id:3,geometry:[{lat:12.01,lon:150},{lat:12.01,lon:150.01}],routes:[firstRoute]}]);
    }
  }
}
for (const fixture of joinFixtures) {
  for (const limit of [1,450]) {
    for (const certified of [false,true]) {
      assert.deepEqual(plain(runtime.joinChecks.joinConnectedTransitLines(fixture,limit,certified)),
        plain(runtime.joinChecks.legacyJoinConnectedTransitLines(fixture,limit,certified)),
        "optimized joining preserves released geometry, IDs, route memberships and transfer-gap decisions");
    }
  }
}
let data = api.getTransitDisplayNetwork(network);
assert.deepEqual(plain(network.stops),routingBeforeDisplay,"display separation leaves all navigation stations untouched");
const jinchuan = data.stops.filter(s=>["津川","津川火车站"].includes(s.name));
assert.equal(jinchuan.length,2,"Jinchuan railway and metro stations are separate across the whole published snapshot");
assert.deepEqual(plain(jinchuan.map(s=>[s.id,s.name,s.displaySystem]).sort((a,b)=>a[0]-b[0])),
  [[403358828,"津川","railway"],[424888164,"津川火车站","metro"]]);
assert.ok(jinchuan.every(s=>api.transitStationDetailRoutes(s).every(r=>api.transitLayerCategory(r)===s.displaySystem)));
assert.ok(jinchuan.find(s=>s.displaySystem==="railway").displaySourceIds.includes("403358828"));
assert.ok(!jinchuan.find(s=>s.displaySystem==="railway").displaySourceIds.includes("424888164")
  && !jinchuan.find(s=>s.displaySystem==="metro").displaySourceIds.includes("403358828"),
  "same-system platform aliases never steal the other facility's source ID");
const gubei = data.stops.filter(s=>s.name==="古北" && s.lat>9.53 && s.lat<9.54);
assert.equal(gubei.length,2,"same-name Gaoyang railway and metro are separate too, not only Jinchuan");
assert.equal(gubei.find(s=>s.displaySystem==="metro").id,369201191);
assert.equal(gubei.find(s=>s.displaySystem==="railway").id,371698802);
assert.ok(data.stops.every(s=>[...s.routes,...s.displayRoutes].every(r=>api.transitLayerCategory(r)===s.displaySystem)),
  "all cities keep each display station confined to its own system");
api.setRules({...rules,stationDisplayMergeOverrides:[...(rules.stationDisplayMergeOverrides||[]),{
  id:"obsolete-cross-system",stationNames:["津川","津川火车站"],maxMeters:350,source:"user_confirmed"}]});
assert.equal(api.mergeTransitStopsForDisplay(network.stops.filter(s=>["津川","津川火车站"].includes(s.name))).length,2,
  "even a stale manual override cannot join different names or systems");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],{...pair[1],name:"测试铁路站火车站"}]).length,2,
  "different exact names remain independent even when their suffix-stripped complex keys match");
api.setRules(rules);
data = api.getTransitDisplayNetwork(network);
const relationPayload = JSON.parse(await readFile(new URL("../site/transit-relations.json",import.meta.url),"utf8"));
for (const snapshot of payload.snapshots) {
  const restored = api.hydrateTransitNetwork(snapshot.network);
  const before = plain({stops:restored.stops,lines:restored.lines});
  api.reconcileTransitDisplayStations(restored,relationPayload.snapshots.find(s=>s.id===snapshot.id).elements);
  assert.deepEqual(plain({stops:restored.stops,lines:restored.lines}),before,
    `${snapshot.id}: reconstructing display provenance does not change the navigation graph`);
  assert.deepEqual(plain(restored.displayStops.map(s=>[s.id,s.name,s.lat,s.lon,s.displaySystem,s.displaySystems])),
    snapshot.network.displayStops.map(s=>[s[0],s[5],s[1],s[2],s[14]||"",s[15]]),
    `${snapshot.id}: rebuilding the published sources is deterministic and keeps both systems`);
  const displayed = api.getTransitDisplayNetwork(restored);
  assert.ok(displayed.stops.every(s=>api.transitStationDetailRoutes(s).every(r=>api.transitLayerCategory(r)===s.displaySystem)),
    `${snapshot.id}: all station details belong to one transport system`);
}
const gaoping = data.stops.filter(s=>s.name === "高阳高平" && api.distanceMeters(s,{lat:9.5082,lon:155.7800})<500);
assert.equal(gaoping.length,1,"screenshot: Gaoyang Gaoping has one station in the yard");
assert.equal(data.stops.filter(s=>s.name === "高阳高平").length,2,"remote mapped namesake stays visible");
assert.equal(data.stops.filter(s=>s.name === "金铁高平").length,1,"screenshot: Jintie Gaoping has one station");
assert.ok(gaoping[0].displaySourceIds.includes("405781518") && gaoping[0].displaySourceIds.includes("441559469"));
const sourceRouteIds = network.stops.filter(s=>[405781518,441559469].includes(s.id)).flatMap(s=>s.routes.map(r=>r.id));
assert.ok(sourceRouteIds.every(id=>api.transitStationDetailRoutes(gaoping[0]).some(r=>r.id===id)),
  "Gaoping detail retains both directions/services, including multiple relations with the same route identity");
const yujia = data.stops.filter(s=>["郁家桥","望铁郁家桥"].includes(s.name));
assert.ok(yujia.some(s=>s.name === "郁家桥") && yujia.some(s=>s.name === "望铁郁家桥"));
const southeast = data.stops.filter(s=>s.name === "东南角");
assert.equal(southeast.length,1);
assert.equal(southeast[0].interchangeSymbolMode,"single-ring");
assert.deepEqual(plain(southeast[0].interchangeRouteRefs),["R","I","P"]);
assert.ok(["R","I","P"].every(ref=>[...southeast[0].routes,...southeast[0].displayRoutes].some(r=>r.ref === ref)));

const binhaiSource = network.stops.filter(s=>s.name==="滨海" && s.sourceLat>11.48 && s.sourceLat<11.49);
assert.equal(binhaiSource.length,2,"OGF has separate coastal/central station areas at Zhuwan Binhai");
const binhaiBefore = plain(binhaiSource);
const binhai = data.stops.filter(s=>s.name==="滨海" && s.sourceLat>11.48 && s.sourceLat<11.49);
assert.equal(binhai.length,1,"Zhuwan Binhai displays one interchange rather than two circles 254 m apart");
assert.equal(binhai[0].isInterchange,true);
const binhaiAnchor = {lat:11.481797,lon:157.3142974};
const southernBinhai = [...binhaiSource].sort((a,b)=>
  api.distanceMeters({lat:a.sourceLat,lon:a.sourceLon},binhaiAnchor)
    - api.distanceMeters({lat:b.sourceLat,lon:b.sourceLon},binhaiAnchor))[0];
assert.equal(binhai[0].sourceId,southernBinhai.sourceId,"the interchange remains at the southern track crossing");
assert.equal(binhai[0].lat,southernBinhai.sourceLat,"display uses the original southern facility position");
assert.ok(binhaiSource.every(s=>binhai[0].displaySourceIds.includes(String(s.id))));
assert.deepEqual(plain(api.transitStationDetailRoutes(binhai[0])).map(r=>r.label).sort(),
  ["筑湾地铁中心线","筑湾地铁海岸线"],"Binhai details retain both mapped lines");
const reverseBinhai = api.mergeTransitStopsForDisplay([...binhaiSource].reverse());
assert.equal(reverseBinhai.length,1);
assert.equal(reverseBinhai[0].sourceId,binhai[0].sourceId,"station order and regenerated synthetic IDs cannot move the anchor north");
const renumberedBinhai = api.mergeTransitStopsForDisplay(binhaiSource.map((s,i)=>({...s,id:900+i,sourceId:900+i})));
assert.equal(renumberedBinhai[0].sourceLat,binhai[0].sourceLat);
assert.equal(renumberedBinhai[0].sourceLon,binhai[0].sourceLon);
assert.deepEqual(plain(binhaiSource),binhaiBefore,"display merging never changes navigation stops, coordinates or routes");
const otherBinhai = [stop(801,"滨海",11.5,157.32,binhaiSource[0].routes),
  stop(802,"滨海",11.502,157.32,binhaiSource[0].routes)];
assert.equal(api.mergeTransitStopsForDisplay([...binhaiSource,...otherBinhai]).length,3,
  "the confirmed 300 m rule cannot merge other nearby namesakes outside this station");
assert.equal(api.mergeTransitStopsForDisplay([...binhaiSource,
  stop(803,"滨海",11.481797,157.3142974,[],{isRail:false,isBus:true}),
  stop(804,"滨海北",11.481797,157.3142974,binhaiSource[0].routes)]).length,3,
  "bus stops and differently named stations remain independent");
assert.equal(api.transitStationDisplayMergeRadius("滨海"),api.transitStationDisplayMergeRadius("普通站"),
  "the scoped display override does not expand focused route membership matching");

const makeBounds = (south,west,north,east) => ({getSouth:()=>south,getWest:()=>west,getNorth:()=>north,getEast:()=>east,
  isValid:()=>Number.isFinite(south),contains:([lat,lon])=>lat>=south&&lat<=north&&lon>=west&&lon<=east,
  intersects:b=>south<=b.getNorth()&&north>=b.getSouth()&&west<=b.getEast()&&east>=b.getWest(),
  pad:r=>makeBounds(south-(north-south)*r,west-(east-west)*r,north+(north-south)*r,east+(east-west)*r)});
runtime.window.L = {latLngBounds:(a,b)=>makeBounds(a[0],a[1],b[0],b[1])};
runtime.window.L.divIcon = value => value;
const binhaiIcon = api.createTransitStopIcon(binhai[0],binhai[0].routes,true);
assert.ok(binhaiIcon.html.includes("conic-gradient(") && binhaiIcon.html.includes("#7651a3")
  && binhaiIcon.html.includes("#d97818"),"Binhai has one ring partitioned with both line colours");
api.setNetwork(network);
const jinchuanVectorData = api.vectorTransitOverlayData({getBounds:()=>makeBounds(14.654,152.896,14.655,152.898),
  getZoom:()=>19,hasImage:()=>true});
assert.deepEqual(plain(jinchuanVectorData.stopFeatures.map(f=>f.properties.name).sort()),["津川","津川火车站"],
  "perspective uses the same two original facilities as the flat display");
assert.equal(new Set(jinchuanVectorData.stopFeatures.map(f=>f.properties.stopId)).size,2,
  "each perspective symbol keeps its own clickable display ID");
const binhaiVectorData = api.vectorTransitOverlayData({getBounds:()=>makeBounds(11.479,157.312,11.487,157.317),
  getZoom:()=>18,hasImage:()=>true});
assert.equal(binhaiVectorData.stopFeatures.filter(f=>f.properties.name==="滨海").length,1,
  "perspective displays the same one Binhai interchange");
const vectorData = api.vectorTransitOverlayData({getBounds:()=>makeBounds(9.504,155.775,9.512,155.785),
  getZoom:()=>15,hasImage:()=>true});
assert.equal(vectorData.stopFeatures.filter(f=>f.properties.name==="高阳高平").length,1,
  "perspective uses the same merged stations as top down");
const sourceSubmissions = [];
const styleWaits = [];
const glMap = {getBounds:()=>makeBounds(9.504,155.775,9.512,155.785),getZoom:()=>15,hasImage:()=>true,
  getStyle:()=>({layers:[{id:"background"}]}),isStyleLoaded:()=>false,
  getLayer:()=>({}),getSource:id=>({setData:data=>sourceSubmissions.push({id,data})}),
  on:()=>{},off:()=>{},once:event=>styleWaits.push(event),
  getContainer:()=>({clientWidth:1200,clientHeight:700}),project:()=>({x:700,y:300})};
api.setVectorMap(glMap);
api.syncVectorTransitOverlay();
assert.equal(sourceSubmissions.length,2,"usable perspective style displays traffic before unrelated tiles finish loading");
assert.equal(styleWaits.length,0,"traffic never waits for a one-time load that already happened");
api.syncVectorTransitOverlay();
assert.equal(sourceSubmissions.length,2,"unchanged perspective data is not resubmitted to the GL worker");
data = api.getTransitDisplayNetwork(network);

const bounds = {getSouth:()=>9.49,getNorth:()=>9.52,getWest:()=>155.765,getEast:()=>155.79,
  contains:([lat,lon])=>lat>=9.49 && lat<=9.52 && lon>=155.765 && lon<=155.79};
const expectedIds = data.stops.filter(s=>bounds.contains([s.lat,s.lon])).map(s=>s.id).sort();
assert.deepEqual(plain(api.transitDisplayStopsInBounds(network,bounds)).map(s=>s.id).sort(),plain(expectedIds),
  "spatial lookup matches full display data without lost stations at viewport edges");
const start = performance.now();
for(let i=0;i<500;i++) {
  assert.ok(api.getTransitDisplayNetwork(network) === data,"panning/reopening retains the same prepared station collection");
  api.transitDisplayStopsInBounds(network,bounds);
}
const lookupMs = performance.now()-start;
const live = {...network,stops:[...network.stops,stop(999,"新铁路站",9.509,155.778,[firstRoute])]};
assert.ok(api.getTransitDisplayNetwork(live) !== data);
assert.ok(api.transitDisplayStopsInBounds(live,bounds).some(s=>s.id===999),"new live stations join the prepared view");
api.invalidateTransitDisplayNetwork(network);
assert.ok(api.getTransitDisplayNetwork(network) !== data,"metadata/confirmed-rule updates invalidate prepared data");

// Use real Leaflet objects off-map to verify allocation/ownership and click
// details, independently of machine-dependent timings and DOM layout.
let createdMarkers = 0, clickedStop = null;
const flatLayers = L.layerGroup();
const flatContext = vm.createContext({performance,
  window:{L:{...L,marker:(...args)=>{createdMarkers++;return L.marker(...args);}}},
  map:{getBounds:()=>L.latLngBounds([[9.49,155.765],[9.52,155.79]]),getZoom:()=>16},
  transitNetworkLayer:flatLayers, transitCanvasRenderer:actualRenderer,
  vectorPerspectiveActive:false, transitInteractionActive:false, selectedNetworkStationId:null, mapFeatureSelectionEnabled:true,
  transitRenderedLayerCache:new Map(), networkTransitStopMarkers:[],
  transitDisplayFilters:{metro:true,tram:true,railway:true,bus:false},
  railwayConnectionsData:null, railwayRoutingData:null, railwayRoutingLoadFailed:false,
  transitRenderedBounds:null, transitRenderedFilterKey:"", transitRenderedNetwork:null,
  transitRenderedRailwayData:null, transitRenderedConnectionData:null,
  TRANSIT_RENDER_PADDING:0.28, BUS_STOP_MIN_ZOOM:15, transitBusLoading:false, currentView:"place",
  elements:{transitNetworkStatus:{dataset:{}}},
  getTransitDisplayNetwork:api.getTransitDisplayNetwork,
  getVisibleTransitRoutes:api.getVisibleTransitRoutes, getTransitLineBounds:api.getTransitLineBounds,
  transitLayerCategory:api.transitLayerCategory,
  transitDisplayStopsInBounds:api.transitDisplayStopsInBounds, transitStopMatchesFilters:api.transitStopMatchesFilters,
  shouldShowTransitStopLabel:api.shouldShowTransitStopLabel,
  collapseParallelPublicTransitRailLinesForDisplay:api.collapseParallelPublicTransitRailLinesForDisplay,
  createTransitStopIcon:(...args)=>L.divIcon(api.createTransitStopIcon(...args)),
  scheduleTransitCanvasProjection(){},scheduleTransitLabelCollisionPass(){},
  showTransitStation:s=>{clickedStop=s;}, hideTransitStationDetail(){}, syncMapLayers(){},
  syncVectorTransitOverlay(){},setStatus(){},escapeHtml:s=>s,inferredRailConnectionsEnabled:()=>false,
});
for (const name of ["renderTransitNetwork","renderSupplementaryRailways","reuseTransitRenderedLayer",
  "createTransitStopLabel","updateTransitNetworkLabels","setLayerPresenceInGroup","transitRenderFilterKey"]) {
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))[0],flatContext);
}
flatContext.renderTransitNetwork(network,16);
const initialMarkers = createdMarkers;
const initialObjects = flatLayers.getLayers();
const selectedMarker = flatContext.networkTransitStopMarkers.find(e=>e.stop.name==="高阳高平").marker;
flatContext.renderTransitNetwork(network,16);
assert.equal(createdMarkers,initialMarkers,"repeated rendering allocates no new markers or label objects");
assert.deepEqual(flatLayers.getLayers(),initialObjects,"unchanged geographic paths and stations keep their Leaflet identity");
assert.equal(flatContext.elements.transitNetworkStatus.dataset.addedLayers,"0");
assert.equal(flatContext.elements.transitNetworkStatus.dataset.removedLayers,"0");
const refreshedNetwork = {...network,lines:network.lines.map(l=>({...l,geometry:l.geometry.map(p=>({...p}))})),
  stops:network.stops.map(s=>({...s,detailGeneration:"fresh"}))};
flatContext.renderTransitNetwork(refreshedNetwork,16);
assert.equal(createdMarkers,initialMarkers,"fresh packets reuse unchanged symbols and labels without DOM teardown");
assert.deepEqual(flatLayers.getLayers(),initialObjects,"equal fresh geometry does not recreate the existing canvas paths");
selectedMarker.fire("click");
assert.equal(clickedStop.detailGeneration,"fresh","a retained marker's click reads the newest complete station details");
const changedNetwork = {...refreshedNetwork,stops:refreshedNetwork.stops.map(s=>s.name==="高阳高平"
  ? {...s,lat:s.lat+0.00001,routes:s.routes.map(r=>({...r,color:"#ff0000"}))}:s),
  displayStops:refreshedNetwork.displayStops.map(s=>s.name==="高阳高平" ? {...s,lat:s.lat+0.00001}:s)};
flatContext.renderTransitNetwork(changedNetwork,16);
assert.ok(createdMarkers>initialMarkers,"changed station coordinates/palette replace the affected symbols");
assert.ok(!flatLayers.hasLayer(selectedMarker),"old station coordinates do not remain underneath the replacement");
const beforePerspective = createdMarkers;
flatContext.vectorPerspectiveActive = true;
flatContext.renderTransitNetwork(changedNetwork,16);
assert.equal(createdMarkers,beforePerspective,"perspective never allocates a second invisible Leaflet station set");

const collisionFrames = [];
const rectangles = [{left:10,right:90,top:10,bottom:25},{left:70,right:150,top:10,bottom:25},
  {left:165,right:240,top:10,bottom:25},{left:500,right:600,top:10,bottom:25}];
const labelEntries = rectangles.map((rect,index)=>({stop:{id:index},labelMarker:{getElement:()=>({querySelector:()=>
  ({getBoundingClientRect:()=>rect,style:labelStyles[index]})})}}));
const labelStyles = rectangles.map(()=>({visibility:""}));
let removedLabels = 0;
const labelContext = vm.createContext({window:{requestAnimationFrame:fn=>{collisionFrames.push(fn);return 1;},
  cancelAnimationFrame(){}},transitLabelFrame:null,selectedNetworkStationId:1,
  map:{getContainer:()=>({getBoundingClientRect:()=>({left:0,right:400,top:0,bottom:300})})}});
vm.runInContext(app.match(/  function scheduleTransitLabelCollisionPass\([^]*?\n  \}/u)[0],labelContext);
const labelGroup = {hasLayer:()=>true,removeLayer:()=>{removedLabels++;}};
labelContext.scheduleTransitLabelCollisionPass(labelGroup,labelEntries);collisionFrames.shift()();
assert.deepEqual(labelStyles.map(s=>s.visibility),["hidden","","","hidden"],
  "selected station retains collision priority and out-of-view labels remain hidden");
rectangles[0].top=50;rectangles[0].bottom=65;
labelContext.scheduleTransitLabelCollisionPass(labelGroup,labelEntries);collisionFrames.shift()();
assert.equal(labelStyles[0].visibility,"","panning restores a newly unobstructed label");
assert.equal(removedLabels,0,"collision resolution never tears down/recreates label DOM");

// Execute the real generated worker, rather than checking source strings.
// Parallel tracks, different stop_position IDs and an area station share the
// very same collector as the main thread and the scheduled snapshot builder.
const items = [
  {type:"way",id:11,tags:{railway:"rail"},geometry:[{lat:12,lon:150},{lat:12.01,lon:150}]},
  {type:"way",id:12,tags:{railway:"rail"},geometry:[{lat:12,lon:150.00012},{lat:12.01,lon:150.00012}]},
  {type:"node",id:21,lat:12.004,lon:150,tags:{railway:"stop",public_transport:"stop_position",train:"yes",name:"共同铁路站"}},
  {type:"node",id:22,lat:12.0041,lon:150.00012,tags:{railway:"stop",public_transport:"stop_position",train:"yes",name:"共同铁路站"}},
  {type:"way",id:23,center:{lat:12.004,lon:150},tags:{railway:"station",public_transport:"station",name:"共同铁路站"}},
  {type:"node",id:24,lat:12.008,lon:150,tags:{railway:"station",name:"第二铁路站"}},
  {type:"node",id:25,lat:12.002,lon:150,tags:{highway:"bus_stop",name:"公交站"}},
  {type:"way",id:26,center:{lat:12.006,lon:150},tags:{railway:"station",station:"subway",name:"2"}},
  {type:"relation",id:27,center:{lat:12.009,lon:150},tags:{type:"multipolygon",public_transport:"station",name:"面状新站"}},
  {type:"relation",id:31,tags:{type:"route",route:"train",name:"测试铁路",colour:"#036eb8"},
    members:[{type:"way",ref:11},{type:"node",ref:21},{type:"node",ref:24}]},
  {type:"relation",id:32,tags:{type:"route",route:"train",name:"测试铁路",colour:"#036eb8"},
    members:[{type:"way",ref:12},{type:"node",ref:22},{type:"node",ref:24}]},
  {type:"relation",id:33,tags:{type:"route",route:"bus",name:"测试公交"},members:[{type:"node",ref:25}]},
  {type:"way",id:34,tags:{railway:"subway"},geometry:[{lat:12,lon:150.00018},{lat:12.01,lon:150.00018}]},
  {type:"node",id:28,lat:12.004,lon:150.00018,tags:{railway:"stop",subway:"yes",name:"共同铁路站"}},
  {type:"node",id:29,lat:12.003,lon:150.00018,tags:{railway:"station",name:"一般标签地铁站"}},
  {type:"relation",id:35,tags:{type:"route",route:"subway",name:"测试地铁"},
    members:[{type:"way",ref:34},{type:"node",ref:28},{type:"node",ref:29}]},
];
// Live route geometry includes platform areas which the compact preload does
// not contain. These are actual OGF tags from Dongpu Industrial Park / Olympic
// Park: subway=yes describes platform mode; ref=1/2 is a platform number.
const platformAreas = [
  {type:"way",id:42294886,center:{lat:12.004,lon:150},tags:{area:"yes",public_transport:"platform",railway:"platform",subway:"yes",ref:"1"}},
  {type:"relation",id:42256255,center:{lat:12.0043,lon:150},tags:{type:"multipolygon",public_transport:"platform",railway:"platform",subway:"yes",ref:"2"}},
  {type:"way",id:42224487,center:{lat:12.004,lon:150},tags:{public_transport:"platform",light_rail:"yes",local_ref:"3",name:"站台名称"}},
  {type:"way",id:40,center:{lat:12.004,lon:150},tags:{railway:"platform",monorail:"yes",ref:"4"}},
  {type:"way",id:41,center:{lat:12.004,lon:150},tags:{railway:"subway_entrance",subway:"yes",ref:"A"}},
  {type:"way",id:42,center:{lat:12.004,lon:150},tags:{subway:"yes",ref:"5"}},
];
const liveItems = [...items, ...platformAreas];
const fixtureBounds = api.transitCollectionBounds(11.99,149.99,12.02,150.01);
for (const [relationId,system] of [[31,"railway"],[35,"metro"]]) {
  api.setFocusedItems(items.find(item=>item.type==="relation" && item.id===relationId),items);
  const resolveFocused = api.createFocusedTransitRouteResolver();
  assert.ok(resolveFocused({name:"共同铁路站",lat:12.004,lon:150,allRouteMemberIds:[31,35]})
    .every(route=>api.transitLayerCategory(route)===system),
    "the focused route panel keeps station details in the selected railway/metro system too");
}
const worker = new Worker(`const {parentPort} = require('node:worker_threads');
  const self = {postMessage:data=>parentPort.postMessage(data)};
  ${api.transitCollectionWorkerSource()}
  parentPort.on('message',data=>self.onmessage({data}));`,{eval:true});
try {
  for(const includeBus of [false,true]) {
    const output = new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
    worker.postMessage({id:Number(includeBus),items:liveItems,extent:[[11.99,149.99],[12.02,150.01]],includeBus,infrastructure:[],rules:plain(api.rules())});
    const result = await output;
    assert.equal(result.error,undefined,result.error);
    assert.deepEqual(result.network,plain(api.collectTransitNetwork(items,fixtureBounds,includeBus)),
      "live platform areas add no stations, routes or routing IDs to the scheduled network");
    assert.deepEqual(result.network,plain(api.collectTransitNetwork(liveItems,fixtureBounds,includeBus)),
      "background and scheduled collectors apply the same station-area standard");
    const displayResult = api.getTransitDisplayNetwork(result.network);
    const sharedName = displayResult.stops.filter(s=>s.name==="共同铁路站");
    assert.equal(sharedName.length,2,"worker/scheduled outputs keep same-name metro and railway separately");
    assert.ok(sharedName.some(s=>s.displaySystem==="railway") && sharedName.some(s=>s.displaySystem==="metro"));
    assert.ok(sharedName.find(s=>s.displaySystem==="metro").displaySourceIds.includes("28"),
      "a source station lost in the existing navigation merge still has its own metro display");
    assert.ok(displayResult.stops.some(s=>s.name==="一般标签地铁站" && s.displaySystem==="metro"),
      "generic railway=station tags cannot hide an authoritative metro station");
    assert.ok(result.network.stops.some(s=>s.id==="way:26" && s.name==="2"),
      "an explicitly tagged real station survives even with a numeric name");
    assert.ok(result.network.stops.some(s=>s.id==="relation:27"),"explicit relation station areas remain supported");
    assert.ok([21,24].every(id=>result.network.stops.some(s=>s.id===id)),
      "established node stations and merged stop positions retain their routing IDs");
    const published = api.collectTransitNetwork(items,fixtureBounds,includeBus);
    const combined = api.mergeTransitNetworks(published,result.network);
    assert.equal(api.getTransitDisplayNetwork(combined).stops.filter(s=>s.name==="共同铁路站").length,2,
      "live handoff retains the published separate-system displays");
    assert.deepEqual(plain(api.mergeTransitStopsForDisplay(combined.stops)),
      plain(api.mergeTransitStopsForDisplay(published.stops)),
      "published-to-live refresh creates no additional platform symbols or incomplete details");
  }
  const binhaiItems = [
    {type:"way",id:51,tags:{railway:"subway"},geometry:[{lat:11.479,lon:157.3143},{lat:11.486,lon:157.3143}]},
    {type:"way",id:52,tags:{railway:"subway"},geometry:[{lat:11.481797,lon:157.312},{lat:11.481797,lon:157.317}]},
    {type:"way",id:41453212,center:{lat:11.4840801,lon:157.3143038},
      tags:{name:"滨海",public_transport:"station",railway:"station",station:"subway",subway:"yes"}},
    {type:"way",id:41512731,center:binhaiAnchor,
      tags:{name:"滨海",public_transport:"station",railway:"station",station:"subway",subway:"yes"}},
    {type:"relation",id:61,tags:{type:"route",route:"subway",name:"筑湾地铁海岸线",colour:"#7651a3"},members:[{type:"way",ref:51}]},
    {type:"relation",id:62,tags:{type:"route",route:"subway",name:"筑湾地铁中心线",colour:"#d97818"},members:[{type:"way",ref:52}]},
  ];
  const output = new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
  worker.postMessage({id:2,items:binhaiItems,extent:[[11.479,157.312],[11.487,157.317]],includeBus:false,infrastructure:[],rules:plain(api.rules())});
  const result = await output;
  assert.equal(result.error,undefined,result.error);
  assert.equal(result.network.stops.length,2,"live collection retains both real Binhai station areas");
  const collectedBefore = plain(result.network);
  const collectedBinhai = api.mergeTransitStopsForDisplay(result.network.stops);
  assert.equal(collectedBinhai.length,1,"fresh worker results reuse the confirmed Binhai display rule");
  assert.equal(collectedBinhai[0].sourceId,"way:41512731");
  assert.deepEqual(plain(api.transitStationDetailRoutes(collectedBinhai[0])).map(r=>r.label).sort(),
    ["筑湾地铁中心线","筑湾地铁海岸线"]);
  assert.deepEqual(plain(result.network),collectedBefore,"worker routing IDs and line geometry are untouched by the display override");
} finally {
  await worker.terminate();
}
console.log(JSON.stringify({status:"passed",sourceStops:network.stops.length,displayStops:data.stops.length,
  gaoyangGaoping:gaoping.length,jintieGaoping:1,cachedViewportLookups:500,lookupMs:+lookupMs.toFixed(1),workerParity:true}));
