import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {featureDataQuery} from "../site/_worker.js";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const context = vm.createContext({TextEncoder, Map, Set, Date});
context.window = context;
vm.runInContext(await readFile(new URL("../site/transit-atlas-options.js", import.meta.url), "utf8"), context);
vm.runInContext(await readFile(new URL("../site/feature-data.js", import.meta.url), "utf8"), context);
const A = context.HuayuTransitAtlas, F = context.HuayuFeatures;
const plain = value => JSON.parse(JSON.stringify(value));
const routeInfo = item => ({id: item.id, type: item.tags.route, identity: `route:${item.id}`, label: item.tags.name, color: "#123456"});
const way = (id, tags) => ({type: "way", id, tags, geometry: [{lat: 12, lon: 150+id/1000}, {lat: 12.01, lon: 150+id/1000}]});
const items = [way(11, {railway: "subway"}), way(12, {railway: "construction", construction: "subway"}),
  way(13, {railway: "proposed", proposed: "tram"}),
  {type: "node", id: 20, lat: 12.003, lon: 150.013, tags: {railway: "station", name: "规划车站"}},
  {type: "relation", id: 30, tags: {type: "route", route: "subway", name: "现有线路含在建延长"}, members: [{type:"way",ref:11},{type:"way",ref:12}]},
  {type: "relation", id: 31, tags: {type: "route", route: "tram", state: "proposed", name: "新线"}, members: [{type:"way",ref:13},{type:"node",ref:20},{type:"relation",ref:31}]}];
const original = JSON.stringify(items), future = A.futureNetwork(items, routeInfo);
assert.deepEqual(plain(future.lines.map(l=>[l.sourceId,l.routes[0].type,l.atlasLifecycle])), [[12,"subway","construction"],[13,"tram","proposed"]]);
assert.equal(future.stops[0].routes[0].atlasLifecycle,"proposed");
assert.equal(A.lifecycle({name:"规划新城线"}),"existing","names cannot invent lifecycle status");
assert.equal(A.lifecycle({construction:"no"}),"existing");
assert.equal(A.lifecycle({"construction:railway":"light_rail"}),"construction");
assert.equal(A.routeType({"proposed:route":"subway"}),"subway");
assert.equal(JSON.stringify(items),original,"atlas classification cannot mutate routing/source data");

// Jinchuan's masters explicitly identify subway service, while construction
// is tagged on their tracks and ordinary station nodes are sibling members.
const futureStation = {type:"node",id:40,lat:12.005,lon:150.012,
  tags:{name:"东湾",railway:"station",station:"subway",subway:"yes"}};
const futureMaster = {type:"relation",id:41,tags:{type:"route_master",route_master:"subway",name:"规划6号线"},
  members:[{type:"way",ref:12},{type:"node",ref:40}]};
const stationNetwork = extra => A.futureNetwork([items[1],futureStation,futureMaster,...extra],routeInfo);
const beforeStation = JSON.stringify([items[1],futureStation,futureMaster]);
const inferred = stationNetwork([]);
assert.deepEqual(plain(inferred.stops.map(s=>[s.name,s.routes[0].id,s.routes[0].type,s.routes[0].atlasLifecycle])),
  [["东湾",41,"subway","construction"]],"stations inherit the unanimous explicit lifecycle of their relation's tracks");
assert.equal(inferred.lines[0].routes[0].id,41,"track and station must retain the same real relation identity");
for (const track of [way(12,{railway:"construction"}),way(12,{railway:"proposed",proposed:"subway"})]) {
  const network=A.futureNetwork([track,futureStation,futureMaster],routeInfo);
  assert.equal(network.stops[0].routes[0].atlasLifecycle,A.lifecycle(track.tags));
}
for (const extra of [items[0],way(11,{railway:"proposed",proposed:"subway"}),null]) {
  const master={...futureMaster,members:[...futureMaster.members,{type:"way",ref:11}]};
  const network=A.futureNetwork([items[1],futureStation,master,...(extra?[extra]:[])],routeInfo);
  assert.equal(network.stops.length,0,"mixed lifecycles or incomplete tracks cannot relabel unspecified stations");
}
const child={...futureMaster,id:42,members:[...futureMaster.members,{type:"relation",ref:42}]};
const parent={...futureMaster,members:[{type:"relation",ref:42},{type:"node",ref:40}]};
assert.ok(A.futureNetwork([items[1],futureStation,parent,child],routeInfo).stops
  .some(s=>s.routes.some(r=>r.id===41&&r.atlasLifecycle==="construction")),"nested and cyclic route members remain bounded");
const explicitStation={...futureStation,tags:{...futureStation.tags,railway:"proposed",proposed:"station"}};
assert.equal(A.futureNetwork([items[1],explicitStation,futureMaster],routeInfo).stops[0].routes[0].atlasLifecycle,"proposed",
  "an explicit station lifecycle takes precedence over its tracks");
assert.equal(JSON.stringify([items[1],futureStation,futureMaster]),beforeStation,"inference is atlas-only and leaves source tags untouched");

context.transitRouteInfo = routeInfo;
for (const name of ["transitAtlasApplyLifecycle","transitAtlasProjection"]) {
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))[0], context);
}
const lines = new Map([["11+12",{id:"11+12",geometry:[...items[0].geometry,...items[1].geometry],routes:[routeInfo(items[4])]}]]);
const sharedItems=items.map(item=>item.id===31 ? {...item,members:[...item.members,{type:"way",ref:11}]} : item);
context.transitAtlasApplyLifecycle(lines,new Map(),sharedItems);
assert.ok(lines.has("existing-11"),"an unfinished extension must not hide the existing segment");
assert.equal(lines.get("existing-11").geometry,items[0].geometry);
assert.equal(lines.get("future-12").atlasLifecycle,"construction");
assert.ok(!lines.has("11+12"),"the original joined line cannot draw an excluded extension underneath");
assert.ok(lines.has("future-11"),"a planned service may reuse real existing track without removing the existing service");
assert.equal(A.routeType({railway:"construction",construction:"station"}),"","an unfinished station building is not a track");

const bounds = {minLon: 10,maxLon: 15,minLat:60,maxLat:70}, rect={x:20,y:30,width:1000,height:800};
const project=A.projection(bounds,rect), nw=project([10,70]),se=project([15,60]),mid=project([12.5,65]);
const worldN=A.world([10,70]),worldS=A.world([15,60]),worldM=A.world([12.5,65]);
assert.ok(Math.abs((mid[1]-nw[1])/(se[1]-nw[1])-(worldM[1]-worldN[1])/(worldS[1]-worldN[1]))<1e-10,
  "rail, boundary and raster positions must share the exact Mercator transform, including high latitude");
const pan=A.projection(bounds,rect,{scale:2,offsetX:50,offsetY:-20});
assert.ok(Math.abs(pan([12.5,65])[0]-(rect.x+rect.width/2+(mid[0]-rect.x-rect.width/2)*2+50))<1e-7);

const collection={name:"测试城市",features:[{type:"Feature",properties:{feature_type:"track",source_id:"12",route_names:["在建线"],lifecycle:["construction"],clipped_at_end:true},
  geometry:{type:"LineString",coordinates:[[150,12],[150.1,12.1]]}}]};
const entries=A.downloadEntries(collection,"city/1","2026-10-15T00:00:00Z");
assert.equal(entries[0].derived,true);
assert.equal(A.downloadEntries(collection,"city/1",null)[0].feature.id,entries[0].feature.id,"repeated additions deduplicate independently of export time");
assert.deepEqual(plain(entries[0].feature.geometry),collection.features[0].geometry);
assert.ok(F.csv(entries.map(e=>e.feature)).includes("construction"));
assert.throws(()=>F.osm(entries),/线路图几何/u,"derived, clipped lines must never invent original OSM dependency IDs");
const query=featureDataQuery(new URL("https://local/api/features?mode=atlas-future&south=12&west=148&north=12.3&east=148.3"));
assert.ok(query.includes('way["railway"~"^(construction|proposed)$"]'));
assert.ok(query.includes('"proposed:route"')&&query.includes('"construction:railway"'));
assert.ok(query.includes(".selected out count")&&query.includes("out body geom 2001")&&query.includes("maxsize:33554432"));
assert.throws(()=>featureDataQuery(new URL("https://local/api/features?mode=atlas-future&south=0&west=0&north=10&east=10")),/AREA_TOO_LARGE/u);
assert.equal(F.subtypes.building.length,10);
assert.ok(F.matchesFilters({building:"commercial"},F.downloadFilters("building",{subtype:"commercial"})));
assert.ok(F.matchesFilters({building:"industrial"},F.downloadFilters("building",{subtype:"industrial"})));

// Use the same classifiers and the published route table as the page. A
// generic infrastructure fallback must not make a city-rail-only station
// appear in the ordinary railway atlas or its exports.
const services=JSON.parse(await readFile(new URL("../site/transit-services.json",import.meta.url),"utf8"));
const stationsContext=vm.createContext({Map,Set,WeakMap,transitServiceRules:services,
  PUBLIC_TRANSIT_RAIL_SELECTOR_CACHE:new WeakMap(),NORMALIZED_TRANSIT_TEXT_CACHE:new Map(),
  TRANSIT_NORMALIZATION_CACHE_LIMIT:8192,transitAtlasModes:{railway:true},
  TRANSIT_ATLAS_RAILWAY_CONTEXT_METERS:0,transitAtlasLineBoundsCache:new WeakMap(),
  translateTransitType:()=>"铁路",distanceMeters:()=>0,trainRouteSetsConflict:()=>false,
  projectPointToTransitGeometry:point=>({...point,distance:5})});
for(const name of ["URBAN_TRAIN_ROUTE_LABEL","URBAN_TRAIN_SERVICE_LABEL","URBAN_TRAIN_OPERATOR_LABEL"]){
  vm.runInContext(app.match(new RegExp(`  const ${name} = [^\\n]+;`,"u"))[0],stationsContext);
}
for(const name of ["urbanRailRelation","urbanRailText","normalizeTransitRuleText","publicTransitRailSystemForRoute",
  "isUrbanRailTransitRoute","uniqueTransitRoutes","preferAuthoritativeTransitRoutes","isFallbackTrainRoute",
  "isAuthoritativeTrainRoute","transitAtlasModeForRoute","transitAtlasRouteLabel","transitAtlasStationRoutes",
  "transitAtlasExpandBounds","transitAtlasBoundsOverlap","transitAtlasLineBounds","transitAtlasStationPoint",
  "transitPublicRouteName","transitPassengerRouteIdentity","transitAtlasRouteKey","transitAtlasChooseRoute",
  "isMainlineStationNode","railStationIsPassengerEligible","transitAtlasMainlineStation",
  "mergeTransitStops","transitAtlasAddNationalRailwayStations"]){
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))[0],stationsContext);
}
const C=stationsContext;
const preload=JSON.parse(await readFile(new URL("../site/transit-preload.json",import.meta.url),"utf8"));
let checked=0;
const sourceBefore=JSON.stringify(preload);
for(const snapshot of preload.snapshots){
  const table=snapshot.network.routeTable.map(r=>({id:r[0],type:r[1],color:r[2],identity:r[3],label:r[4],isFallback:true}));
  for(const stop of snapshot.network.stops){
    const raw=stop[8].map(i=>table[i]);
    if(!raw.some(C.isUrbanRailTransitRoute))continue;
    const routes=C.transitAtlasStationRoutes(raw);
    assert.ok(routes.some(C.isUrbanRailTransitRoute),`${stop[5]} keeps city rail`);
    assert.ok(!routes.some(r=>C.transitAtlasModeForRoute(r)==="railway"&&/^(铁路|铁路基础设施)$/u.test(r.label)),
      `${stop[5]} cannot inherit an ordinary railway category from a generic station track`);
    checked++;
  }
}
assert.ok(checked>=15,"exercise actual published city railway stations");
assert.equal(JSON.stringify(preload),sourceBefore,"atlas ownership cannot mutate the published network");
const cityRoute={id:"city",type:"train",label:"津川城铁久昭线",identity:"train:infrastructure:city",isFallback:true};
const generic={id:"generic",type:"train",label:"铁路基础设施",identity:"train:infrastructure:generic",isFallback:true};
const mainline={...generic,id:"mainline",label:"采坤线",identity:"train:infrastructure:mainline"};
assert.deepEqual(plain(C.transitAtlasStationRoutes([generic])),[generic],"ordinary-only stations keep their established fallback");
assert.deepEqual(plain(C.transitAtlasStationRoutes([cityRoute,generic,mainline])),[cityRoute,mainline],
  "shared stations retain a named ordinary railway and their city railway");
const formal={...generic,id:123,identity:"train:relation:123",label:"铁路",isFallback:false};
assert.deepEqual(plain(C.transitAtlasStationRoutes([cityRoute,formal])),[formal],"a real train relation still owns its station");
assert.deepEqual(plain(C.transitAtlasStationRoutes([{...cityRoute,atlasLifecycle:"proposed"},generic])),
  [{...cityRoute,atlasLifecycle:"proposed"},generic],"a proposed city service cannot suppress an existing fallback");

const station={id:1,name:"测试站",lat:12.005,lon:150.001,isMainline:true,routes:[cityRoute]};
const geometry=[{lat:12,lon:150},{lat:12.01,lon:150}];
const stationItems=[{id:1,type:"node",lat:station.lat,lon:station.lon,tags:{name:station.name,railway:"station"}}];
for(const [route,expected] of [[generic,0],[mainline,1]]){
  const networkStops=new Map([["station",{...station,routes:[cityRoute]}]]);
  const networkLines=new Map([["track",{id:"track",atlasNationalRailway:true,geometry,routes:[route]}]]);
  assert.equal(C.transitAtlasAddNationalRailwayStations(networkStops,networkLines,
    {minLat:12,maxLat:12.01,minLon:150,maxLon:150.01},stationItems),expected);
  assert.equal([...networkStops.values()].some(s=>s.routes.some(r=>r.identity===generic.identity)),false,
    "national station supplementation cannot reintroduce the rejected generic category");
  assert.equal(JSON.stringify(station.routes),JSON.stringify([cityRoute]));
}
const freightId=services.railOperatingRules.find(rule=>rule.id==="jinchuan-passenger-rail").nonPassengerStationIds[0];
const freightRow=preload.snapshots.flatMap(snapshot=>snapshot.network.stops).find(stop=>stop[0]===freightId);
assert.equal(freightRow[5],"津川南");
const freight={type:"node",id:freightId,lat:freightRow[3],lon:freightRow[4],
  tags:{name:freightRow[5],railway:"station",train:"yes"}};
assert.equal(C.railStationIsPassengerEligible(freight),false,"freight stays excluded from passenger routing");
assert.equal(C.transitAtlasMainlineStation(freight),true,"the atlas includes existing freight stations");
assert.equal(C.transitAtlasMainlineStation({...freight,tags:{...freight.tags,train:"no",access:"private"}}),true);
for(const tags of [{railway:"platform"},{railway:"station",station:"subway"},{railway:"station",abandoned:"yes"}]){
  assert.equal(C.transitAtlasMainlineStation({...freight,tags:{name:"排除",...tags}}),false);
}
const freightStops=new Map();
const freightTrack=[{lat:freight.lat-0.001,lon:freight.lon},{lat:freight.lat+0.001,lon:freight.lon}];
assert.equal(C.transitAtlasAddNationalRailwayStations(freightStops,
  new Map([["freight-track",{atlasNationalRailway:true,geometry:freightTrack,routes:[mainline]}]]),
  {minLat:freight.lat-0.01,maxLat:freight.lat+0.01,minLon:freight.lon-0.01,maxLon:freight.lon+0.01},[freight]),1);
assert.ok([...freightStops.values()].some(stop=>stop.id===freightId&&stop.routes.some(route=>route.label==="采坤线")));
console.log("Transit atlas options passed: original lifecycle tags, mixed existing/future segments, relation cycles, Mercator alignment, derived download metadata and bounded queries.");
console.log(`Transit atlas station ownership passed: ${checked} published city-rail stations, dedicated/shared/ordinary cases, future services, source isolation and no generic reinjection.`);
console.log("Freight atlas passed: Jinchuan South retains a real mainline membership without becoming a passenger routing station.");
