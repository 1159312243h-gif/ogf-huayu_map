import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
function load(context,names){
  for(const name of names){
    const declaration=app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))?.[0];
    assert.ok(declaration,name);vm.runInContext(declaration,context);
  }
}
const route=key=>({identity:key});
const line=(id,start,end,key)=>({id,geometry:[start,end],routes:[route(key)]});
const lines=[
  line("metro",{lon:-1,lat:0},{lon:0,lat:0},"metro"),
  line("outside-rail",{lon:0,lat:0},{lon:1,lat:0},"rail"),
  line("unrelated",{lon:10,lat:5},{lon:11,lat:5},"rail"),
  line("inside-rail",{lon:-1,lat:5},{lon:0,lat:5},"rail"),
];
const stops=[{lon:-1,lat:0,routes:[route("metro")]},{lon:-1,lat:5,routes:[route("rail")]}];
let projections=0,connections=0,intersections=0;
const context=vm.createContext({Map,Set,WeakMap,
  preferAuthoritativeTransitRoutes:routes=>routes,transitAtlasRouteKey:route=>route.identity,
  transitAtlasPointWithinBuffer:()=>true,administrativeFeatureContainsPoint:()=>true,
  transitAtlasGeometryIntersectsFeature:geometry=>{intersections++;return geometry[0].lon<0;},
  projectPointToTransitGeometry:(point,geometry)=>{projections++;return {distance:Math.min(...geometry.map(
    p=>Math.hypot(p.lon-point.lon,p.lat-point.lat)*1000))};},
  transitAtlasLinesConnect:(first,second)=>{connections++;return first.geometry.some(a=>
    second.geometry.some(b=>a.lon===b.lon&&a.lat===b.lat));},
});
load(context,["transitAtlasStopProjection","transitAtlasConnectedNetworkLines"]);
const prepared={lines,pointWithinCache:new Map(),intersections:new WeakMap(),
  stopProjections:new WeakMap(),connections:new Map(),stationMatches:new WeakMap()};
const ids=items=>Array.from(items,item=>item.id);
const before=JSON.stringify({lines,stops});
assert.deepEqual(ids(context.transitAtlasConnectedNetworkLines(lines,{},stops,10000,prepared)),
  ["metro","outside-rail","inside-rail"]);
const counts={projections,connections,intersections};
for(let i=0;i<10;i++){
  const railway=lines.filter(line=>line.routes[0].identity==="rail");
  assert.deepEqual(ids(context.transitAtlasConnectedNetworkLines(railway,{},stops,10000,prepared)),["inside-rail"],
    "disabled metro cannot hold an outside railway fragment connected");
  const metro=lines.filter(line=>line.routes[0].identity==="metro");
  assert.deepEqual(ids(context.transitAtlasConnectedNetworkLines(metro,{},stops,10000,prepared)),["metro"]);
  assert.deepEqual(ids(context.transitAtlasConnectedNetworkLines(lines,{},stops,10000,prepared)),
    ["metro","outside-rail","inside-rail"]);
}
assert.deepEqual({projections,connections,intersections},counts,
  "repeated filtering must not repeat geometry projections, boundary intersections or physical connection checks");
assert.equal(JSON.stringify({lines,stops}),before,"filtering cannot rewrite source geometry or station memberships");
// The uncached path and the prepared path must produce exactly the same membership.
assert.deepEqual(ids(context.transitAtlasConnectedNetworkLines(lines,{},stops,10000)),
  ids(context.transitAtlasConnectedNetworkLines(lines,{},stops,10000,prepared)));

let preparations=0;
const network={lines:[],stops:[]};
const source=[];
const p=vm.createContext({Map,Set,WeakMap,transitAtlasPrepared:null,
  transitAtlasCity:{},transitAtlasFutureData:null,railwayRoutingData:null,
  transitRoutingRevision:1,transitServiceRules:{},buffer:10000,
  transitAtlasSnapshotNetworks:()=>[network],transitAtlasSnapshotElements:()=>[...source],
  transitAtlasBufferDistanceMeters:()=>p.buffer,transitAtlasFutureKey:()=>"future-key",
  transitAtlasBufferedBounds:()=>({minLat:0,minLon:0,maxLat:1,maxLon:1}),
  transitAtlasAddNationalRailwayLines:()=>{preparations++;return 0;},
  transitAtlasAddNationalRailwayStations:()=>0,transitAtlasApplyLifecycle:()=>{},
  transitAtlasJoinConnectedSourceFragments:lines=>lines,transitAtlasLabelContinuations:()=>{},
});
load(p,["prepareTransitAtlasGeometry"]);
let current=p.prepareTransitAtlasGeometry();
assert.strictEqual(p.prepareTransitAtlasGeometry(),current);
p.transitAtlasModes={metro:false,railway:true};
p.elements={transitAtlasConstruction:{checked:true},transitAtlasProposed:{checked:true}};
assert.strictEqual(p.prepareTransitAtlasGeometry(),current,"display filters reuse the prepared city");
assert.equal(preparations,1);
const changes=[
  ()=>{p.buffer=20000;},
  ()=>{p.transitAtlasCity={};},
  ()=>{p.transitRoutingRevision++;},
  ()=>{p.transitServiceRules={};},
  ()=>{p.railwayRoutingData={};},
  ()=>{network.lines=[];},
  ()=>{network.stops=[];},
  ()=>{source.push({type:"node",id:1});},
  ()=>{source[0]={type:"node",id:1};},
  ()=>{p.transitAtlasFutureData={key:"future-key",elements:[]};},
  ()=>{p.transitAtlasFutureData=null;},
];
for(const change of changes){
  change();const next=p.prepareTransitAtlasGeometry();
  assert.notStrictEqual(next,current,"changed source, city, range or data generation invalidates the prepared result");
  assert.strictEqual(p.prepareTransitAtlasGeometry(),next);
  current=next;
}
assert.equal(preparations,1+changes.length);

// A failed nationwide download is not a genuine empty city. Retry the two
// independent source packets once and reuse one in-flight load across filters.
const loaderSource=app.match(/  async function loadTransitAtlasSources\([^]*?\n  \}/u)?.[0];
assert.ok(loaderSource);
function loaderContext(overrides={}){
  const c=vm.createContext({Promise,Map,Set,transitAtlasCity:{label:"津川市"},
    transitAtlasSourceLoad:null,transitAtlasSourcesUnavailable:false,
    transitServicePreloadPromise:null,transitPreloadPromise:null,networks:[],
    elements:{transitAtlasRetry:{hidden:true},transitAtlasStatus:{}},
    setStatus:(element,text)=>{element.textContent=text;},
    ...overrides});
  c.transitAtlasSourceSnapshots=()=>c.networks;
  c.rebuildTransitAtlasModel=()=>{
    c.rebuilds=(c.rebuilds||0)+1;c.elements.transitAtlasRetry.hidden=!c.transitAtlasSourcesUnavailable;
  };
  vm.runInContext(loaderSource,c);return c;
}
let relationCalls=0,preloadCalls=0;
const retry=loaderContext();
retry.ensureTransitRelationsLoaded=async()=>{relationCalls++;return false;};
retry.refreshTransitPreloadPackage=async()=>{preloadCalls++;retry.networks=[network];return true;};
assert.equal(await retry.loadTransitAtlasSources(),true);
assert.equal(relationCalls,1);assert.equal(preloadCalls,1);
assert.equal(retry.transitAtlasSourcesUnavailable,false);
assert.equal(retry.transitAtlasSourceLoad,null);
assert.equal(retry.elements.transitAtlasRetry.hidden,true);
await retry.loadTransitAtlasSources();assert.equal(preloadCalls,1,"available data must not be downloaded again for filtering");

const failed=loaderContext();
failed.ensureTransitRelationsLoaded=async()=>false;
failed.refreshTransitPreloadPackage=async()=>false;
assert.equal(await failed.loadTransitAtlasSources(),false);
assert.equal(failed.transitAtlasSourcesUnavailable,true,"failure must remain distinguishable from a successful empty network");
assert.equal(failed.elements.transitAtlasRetry.hidden,false);
failed.ensureTransitRelationsLoaded=async()=>{failed.networks=[network];return true;};
assert.equal(await failed.loadTransitAtlasSources(),true,"manual retry recovers without reloading the whole map");
assert.equal(failed.transitAtlasSourcesUnavailable,false);
assert.equal(failed.elements.transitAtlasRetry.hidden,true);

let finish;
const pending=loaderContext({transitPreloadPromise:new Promise(resolve=>{finish=resolve;})});
pending.ensureTransitRelationsLoaded=async()=>{pending.networks=[network];return true;};
pending.refreshTransitPreloadPackage=async()=>{throw new Error("not needed");};
const first=pending.loadTransitAtlasSources(),second=pending.loadTransitAtlasSources();
assert.ok(pending.transitAtlasSourceLoad,"mode switches can distinguish pending data from no routes");
finish();assert.deepEqual(await Promise.all([first,second]),[true,true]);
assert.equal(pending.rebuilds,1,"concurrent switches share one source load and one final rebuild");
assert.equal(pending.transitAtlasSourceLoad,null);
const emptyCity=loaderContext({networks:[{lines:[],stops:[]}]});
emptyCity.ensureTransitRelationsLoaded=async()=>true;
emptyCity.refreshTransitPreloadPackage=async()=>{throw new Error("an empty complete packet is not a download failure");};
assert.equal(await emptyCity.loadTransitAtlasSources(),true);

const selected=new Map(),committed=[],futureCities=[];
const cityUI=vm.createContext({Set,transitAtlasRequestId:0,transitAtlasCity:null,transitAtlasFutureController:null,
  transitAtlasFutureData:null,transitAtlasHiddenRouteKeys:new Set(),railwayRoutingData:null,
  transitAtlasModes:{railway:false},polygonFeatureGeometry:r=>r.geojson,
  primaryPlaceName:r=>r.name,activeAdministrativeFeatureBounds:()=>({minLat:0,minLon:0,maxLat:1,maxLon:1}),
  elements:{transitAtlasQuery:{},transitAtlasResults:{replaceChildren(){}},transitAtlasWorkspace:{},transitAtlasStatus:{}},
  setStatus:()=>{},loadTransitAtlasSources:()=>new Promise(resolve=>selected.set(cityUI.transitAtlasCity.label,resolve)),
  rebuildTransitAtlasModel:()=>committed.push(cityUI.transitAtlasCity.label),
  loadTransitAtlasFuture:()=>futureCities.push(cityUI.transitAtlasCity.label)});
vm.runInContext(app.match(/  async function selectTransitAtlasCity\([^]*?\n  \}/u)[0],cityUI);
const oldCity=cityUI.selectTransitAtlasCity({name:"旧城市",geojson:{}});
const newCity=cityUI.selectTransitAtlasCity({name:"津川市",geojson:{}});
selected.get("津川市")();await newCity;selected.get("旧城市")();await oldCity;
assert.deepEqual(committed,["津川市"],"late old-city continuations cannot rebuild or relaunch future loads");
assert.deepEqual(futureCities,["津川市"]);
console.log("Transit atlas source recovery passed: bounded retry, explicit unavailability, manual recovery, shared pending load and complete empty-city distinction.");
console.log("Transit atlas filtering passed: repeated switches reuse geometry, excluded modes cannot bridge outside fragments, source isolation and all prepared-data invalidation cases.");
