import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {Worker} from "node:worker_threads";
import {performance} from "node:perf_hooks";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
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
    collectTransitNetwork, transitCollectionWorkerSource, transitCollectionBounds, distanceMeters,
    trainRouteSetsConflict, uniqueTransitRoutes,
    vectorTransitOverlayData, setNetwork(n) {transitNetworkData=n;},
    syncVectorTransitOverlay, setVectorMap(m) {vectorPerspectiveMap=m;},
    applyStationInterchangeOverrides, transitStationDetailRoutes,
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
assert.equal(api.mergeTransitStopsForDisplay([{...pair[0],routes:[firstRoute,{type:"subway",identity:"subway:test"}]},pair[1]]).length,1,
  "a railway station already carrying confirmed metro membership still merges its railway platforms");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],stop(5,"望铁测试铁路站",12,150,[secondRoute])]).length,2,
  "similar or prefixed names do not merge");
assert.equal(api.mergeTransitStopsForDisplay([pair[0],stop(6,"测试铁路站",12,150,[],{isRail:false,isBus:true})]).length,2,
  "equally named bus stops do not merge into railway stations");
const chain = Array.from({length:4},(_,i)=>stop(i+10,"沿线同名站",12+i*0.0016,150,[firstRoute]));
assert.equal(api.mergeTransitStopsForDisplay(chain).length,2,"station radius uses a fixed anchor, never transitive distance chaining");
api.setRules(rules);
const network = api.hydrateTransitNetwork(payload.snapshots.find(s=>s.id === "huaxia").network);
const previousApp = await readFile(new URL("../releases/6.6-huayu-height-field-model-cache-v1/app.js",import.meta.url),"utf8");
const previousMerge = previousApp.match(/  function mergeTransitStops\([^]*?\n  \}/u)[0]
  .replace("function mergeTransitStops(","function legacyMergeTransitStops(");
vm.runInContext(`const distanceMeters=api.distanceMeters;
  const trainRouteSetsConflict=api.trainRouteSetsConflict;
  const uniqueTransitRoutes=api.uniqueTransitRoutes;
  ${previousMerge}`,runtime);
assert.ok(JSON.stringify(api.mergeTransitStops(network.stops)) === JSON.stringify(runtime.legacyMergeTransitStops(network.stops)),
  "name indexing preserves the released navigation graph's station IDs, membership and coordinates");
let data = api.getTransitDisplayNetwork(network);
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

const makeBounds = (south,west,north,east) => ({getSouth:()=>south,getWest:()=>west,getNorth:()=>north,getEast:()=>east,
  isValid:()=>Number.isFinite(south),contains:([lat,lon])=>lat>=south&&lat<=north&&lon>=west&&lon<=east,
  intersects:b=>south<=b.getNorth()&&north>=b.getSouth()&&west<=b.getEast()&&east>=b.getWest(),
  pad:r=>makeBounds(south-(north-south)*r,west-(east-west)*r,north+(north-south)*r,east+(east-west)*r)});
runtime.window.L = {latLngBounds:(a,b)=>makeBounds(a[0],a[1],b[0],b[1])};
api.setNetwork(network);
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
  {type:"relation",id:31,tags:{type:"route",route:"train",name:"测试铁路",colour:"#036eb8"},
    members:[{type:"way",ref:11},{type:"node",ref:21},{type:"node",ref:24}]},
  {type:"relation",id:32,tags:{type:"route",route:"train",name:"测试铁路",colour:"#036eb8"},
    members:[{type:"way",ref:12},{type:"node",ref:22},{type:"node",ref:24}]},
  {type:"relation",id:33,tags:{type:"route",route:"bus",name:"测试公交"},members:[{type:"node",ref:25}]},
];
const fixtureBounds = api.transitCollectionBounds(11.99,149.99,12.02,150.01);
const worker = new Worker(`const {parentPort} = require('node:worker_threads');
  const self = {postMessage:data=>parentPort.postMessage(data)};
  ${api.transitCollectionWorkerSource()}
  parentPort.on('message',data=>self.onmessage({data}));`,{eval:true});
try {
  for(const includeBus of [false,true]) {
    const output = new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);});
    worker.postMessage({id:Number(includeBus),items,extent:[[11.99,149.99],[12.02,150.01]],includeBus,infrastructure:[],rules:plain(api.rules())});
    const result = await output;
    assert.equal(result.error,undefined,result.error);
    assert.deepEqual(result.network,plain(api.collectTransitNetwork(items,fixtureBounds,includeBus)),
      "background geometry/membership collection matches the scheduled collector");
    assert.equal(api.mergeTransitStopsForDisplay(result.network.stops).filter(s=>s.name==="共同铁路站").length,1);
  }
} finally {
  await worker.terminate();
}
console.log(JSON.stringify({status:"passed",sourceStops:network.stops.length,displayStops:data.stops.length,
  gaoyangGaoping:gaoping.length,jintieGaoping:1,cachedViewportLookups:500,lookupMs:+lookupMs.toFixed(1),workerParity:true}));
