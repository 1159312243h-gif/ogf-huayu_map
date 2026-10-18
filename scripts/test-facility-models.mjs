import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {Worker} from "node:worker_threads";
import * as THREE from "../site/three-0.160.1.module.min.js";
import {pavilionTagRuntime as parser} from "./test-pavilion-tags.mjs";
import {huilongToilet,huilongRoad,huilongContext} from "./fixtures/huilong-toilet.mjs";
const source=await readFile(new URL("../site/facility-models.js",import.meta.url),"utf8");
const app=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const context=vm.createContext({setTimeout,clearTimeout,console});vm.runInContext(source,context);
const api=context.HuayuFacilityModels,geometry=api.createFacilityGeometry(),copy=v=>JSON.parse(JSON.stringify(v));
for(const tags of [{attraction:"big_wheel"},{attraction:"ferris_wheel"},{man_made:"ferris_wheel"}])assert.equal(api.kind(tags),"ferris-wheel");
for(const tags of [{name:"摩天轮餐厅"},{tourism:"theme_park"},{attraction:"carousel"},
  {attraction:"big_wheel",disused:"yes"},{attraction:"big_wheel",construction:"yes"}])assert.equal(api.kind(tags),"");
const polygon=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
const lot={type:"Feature",id:"way:1",properties:{amenity:"parking",parking:"surface"},
  geometry:{type:"Polygon",coordinates:[polygon(148,12,.0006,.0004),polygon(148.0002,12.0001,.0001,.0001)]}};
const ferris={type:"Feature",id:"node:2",properties:{attraction:"big_wheel",height:"60",min_height:"5",diameter:"40",direction:"90"},
  geometry:{type:"Point",coordinates:[148.001,12]}};
const baseline=geometry.build([lot,ferris]);assert.equal(baseline.wheels.length,1);assert.ok(baseline.spaces>10);
assert.deepEqual(copy(baseline.wheels[0]),{key:"node:2",center:[148.001,12],base:5,height:60,diameter:40,angle:0,estimated:false});
assert.equal(geometry.build([{...ferris,properties:{...ferris.properties,min_height:"80"}}]).wheels.length,0);
assert.equal(geometry.build([{...ferris,properties:{attraction:"big_wheel",height:"100 ft"}}]).wheels[0].height,30.48);
assert.equal(geometry.build([{...ferris,properties:{attraction:"big_wheel",direction:""}}]).wheels[0].angle,0);
const lineWheel={...ferris,id:"way:3",geometry:{type:"LineString",coordinates:[[148,12],[148.0001,12]]}};
assert.ok(geometry.build([lineWheel]).wheels[0].diameter<12,"mapped wheel span constrains its diameter");
const tightWheel={...ferris,geometry:{type:"Polygon",coordinates:[polygon(148,12,.0001,.00002)]}};
assert.equal(geometry.build([tightWheel]).wheels.length,0,"mapped footprints too narrow for the supports retain the original symbol");
const islandWheel={...ferris,geometry:{type:"MultiPolygon",coordinates:[[polygon(148,12,.00001,.00001)],
  [polygon(148.001,12,.0006,.0003)]]}};
assert.ok(geometry.build([islandWheel]).wheels[0].center[0]>148.001,"wheel fits its actual containing island");
assert.equal(geometry.build([{...lot,geometry:{type:"Point",coordinates:[148,12]}}]).data.features.length,1,"point parking adds only a marker");
for(const f of baseline.data.features.filter(f=>f.properties.facilityPart==="parking-space"))
  assert.ok(f.geometry.coordinates.every(p=>geometry.inside(p,lot.geometry.coordinates)),"complete spaces respect the exact outer ring and hole");
for(const tags of [{parking:"underground"},{parking:"multi-storey"},{parking:"rooftop"},{covered:"yes"},{building:"parking"},{layer:"1"},{min_height:"4"}]) {
  const data=geometry.build([{...lot,properties:{amenity:"parking",...tags}}]);
  assert.equal(data.spaces,0,"underground, covered and elevated parking never acquire invented surface spaces");
  assert.equal(data.data.features.length,1,"retain a parking marker alongside existing building rendering");
}
assert.equal(geometry.build([{...lot,properties:{amenity:"parking",capacity:"3"}}]).spaces,3);
// Actual narrow lot beside 北城公园, way 41975973: the old perpendicular-only layout was empty.
const narrowParking={...lot,id:"way:41975973",geometry:{type:"Polygon",coordinates:[[
  [152.9354023,14.641296],[152.935286,14.6408357],[152.9353389,14.6408277],
  [152.9354615,14.6412769],[152.9354023,14.641296]
]]}};
const parallelSpaces=geometry.build([narrowParking]).data.features.filter(f=>f.properties.facilityPart==="parking-space");
assert.ok(parallelSpaces.length>=6,"a real narrow roadside lot receives parallel bays instead of an empty grey strip");
assert.ok(parallelSpaces.every(f=>f.properties.parkingLayout==="parallel"
  && f.geometry.coordinates.every(p=>geometry.inside(p,narrowParking.geometry.coordinates))));
const pairedLot={...lot,id:"paired-lot",geometry:{type:"Polygon",coordinates:[polygon(148,12,
  60/(111320*Math.cos(12*Math.PI/180)),18/111320)]}};
const pairedSpaces=geometry.build([pairedLot]).data.features.filter(f=>f.properties.facilityPart==="parking-space");
assert.ok(pairedSpaces.length>20 && pairedSpaces.every(f=>f.properties.parkingLayout==="perpendicular"));
const forward=[],reverse=[];
for(const f of pairedSpaces) {
  const [a,b,c,d]=f.geometry.coordinates,opening=(a[1]+d[1])/2,back=(b[1]+c[1])/2;
  (opening>back ? forward : reverse).push(opening);
}
assert.equal(forward.length,reverse.length,"both rows have balanced bays");
assert.ok(forward.length>0 && (Math.min(...reverse)-Math.max(...forward))*111320>=5.99,
  "opposite rows open toward one shared aisle at least 6 m wide");
assert.equal(geometry.build([{...pairedLot,properties:{amenity:"parking",capacity:"0"}}]).spaces,0);
const islands={...lot,id:"relation:4",geometry:{type:"MultiPolygon",coordinates:[[polygon(148,12,.0003,.0002)],
  [polygon(148.001,12,.0003,.0002)]]}};
const islandSpaces=geometry.build([islands]).data.features.filter(f=>f.properties.facilityPart==="parking-space");
assert.ok(islandSpaces.some(f=>f.geometry.coordinates[0][0]>148.001) && islandSpaces.some(f=>f.geometry.coordinates[0][0]<148.0003));
const aisle={type:"Feature",id:"way:5",properties:{service:"parking_aisle"},
  geometry:{type:"LineString",coordinates:[[148.0001,12],[148.0001,12.0004]]}};
assert.ok(geometry.build([lot,aisle]).spaces<baseline.spaces,"actual parking aisles reserve clearance");
assert.equal(JSON.stringify(baseline),JSON.stringify(geometry.build([ferris,lot,lot])),"revisits and duplicate records do not shift or duplicate models");
const crowded=geometry.build(Array.from({length:100},(_,i)=>({...lot,id:`lot:${i}`})));
assert.ok(crowded.spaces<=2048 && crowded.data.features.filter(f=>f.properties.facilityPart==="parking-outline").length<=64);
assert.equal(geometry.build(Array.from({length:25},(_,i)=>({...ferris,id:`wheel:${i}`}))).wheels.length,16);

const outdoorContext={coverage:[{west:147,east:149,south:11,north:13}],obstacles:[]};
const toilet={type:"Feature",id:"node:toilet",properties:{amenity:"toilets",osmType:"node"},geometry:{type:"Point",coordinates:[148,12]}};
const cafe={...toilet,id:"node:cafe",properties:{amenity:"cafe",name:"独立奶茶点",osmType:"node"},geometry:{type:"Point",coordinates:[148.0003,12]}};
const outdoor=geometry.build([toilet,cafe],outdoorContext);
assert.equal(outdoor.small.length,2);assert.deepEqual(copy(outdoor.small.map(f=>f.type).sort()),["kiosk","toilet"]);
assert.equal(geometry.build([toilet,cafe]).small.length,0,"unloaded building data never implies outdoors");
const obstacle={type:"Feature",properties:{building:"yes"},geometry:{type:"Polygon",coordinates:[polygon(147.9999,11.9999,.0002,.0002)]}};
assert.equal(geometry.build([toilet,cafe],{...outdoorContext,obstacles:[obstacle]}).small.length,1,"a complete building prevents duplicate toilet housing");
const courtyard={...obstacle,geometry:{type:"MultiPolygon",coordinates:[[polygon(147.999,11.999,.002,.002),polygon(147.9999,11.9999,.0002,.0002)]]}};
assert.equal(geometry.build([toilet],{...outdoorContext,obstacles:[courtyard]}).small.length,1,"a true courtyard hole remains outdoor space");
for(const tags of [{indoor:"yes"},{location:"underground"},{location:"rooftop"},{level:"1"},{level:"0;1"},{layer:"-1"},
  {building:"toilets"},{"building:part":"yes"},{min_height:"3"},{disused:"yes"},{construction:"yes"}])
  assert.equal(geometry.build([{...toilet,properties:{...toilet.properties,...tags}}],outdoorContext).small.length,0,JSON.stringify(tags));
assert.equal(geometry.build([{...toilet,properties:{...toilet.properties,level:"0",building:"no"}}],outdoorContext).small.length,1);
assert.equal(geometry.build([{...cafe,properties:{shop:"vacant"}}],outdoorContext).small.length,0);
assert.equal(geometry.build([{...cafe,properties:{shop:"convenience"}}],outdoorContext).small.length,1);
assert.equal(geometry.build([{...cafe,properties:{...cafe.properties,osmType:"way"}}],outdoorContext).small.length,0,"a center-only mapped area is never a point kiosk");
const cafeArea={...obstacle,id:"way:cafe-area",properties:{amenity:"cafe"},geometry:{type:"Polygon",coordinates:[polygon(148.0002,11.9999,.0002,.0002)]}};
assert.equal(geometry.build([cafe,cafeArea],outdoorContext).small.length,0,"existing facility areas retain their own geometry");
for(const renderKind of ["road","railway","waterway"]){
  const road={properties:{renderKind,highway:"footway"},geometry:{type:"LineString",coordinates:[[147.9999,12],[148.0001,12]]}};
  assert.equal(geometry.build([toilet],{...outdoorContext,obstacles:[road]}).small.length,0,"complete model footprint avoids "+renderKind);
}
assert.equal(geometry.build([toilet],{...outdoorContext,obstacles:[{...obstacle,properties:{renderKind:"water"}}]}).small.length,0);
assert.equal(geometry.build([toilet,{...toilet,id:"node:duplicate"}],outdoorContext).small.length,1,"overlapping new models keep a deterministic single owner");
assert.equal(JSON.stringify(outdoor),JSON.stringify(geometry.build([cafe,toilet],outdoorContext)),"reordering source data cannot move or duplicate outdoor models");
const tagged=geometry.build([{...toilet,properties:{amenity:"toilets",width:"6",length:"4",height:"3.5",direction:"90"}}],outdoorContext).small[0];
assert.equal(tagged.width,6);assert.equal(tagged.depth,4);assert.equal(tagged.height,3.5);assert.equal(tagged.angle,Math.PI/2);assert.equal(tagged.estimated,false);
assert.equal(geometry.build(Array.from({length:200},(_,i)=>({...toilet,id:`node:${i}`,geometry:{type:"Point",coordinates:[148+i*.0004,12]}})),outdoorContext).small.length,128);

const metres=(x,y)=>[148+x/(111320*Math.cos(12*Math.PI/180)),12+y/111320];
const pathAt=y=>({type:"Feature",properties:{renderKind:"road",highway:"footway"},
  geometry:{type:"LineString",coordinates:[metres(-20,y),metres(20,y)]}});
const besidePath=geometry.build([toilet],{...outdoorContext,obstacles:[pathAt(2.8)]}).small[0];
assert.ok(besidePath,"a rectangular footprint fits beside a path even when its bounding circle would overlap");
assert.equal(besidePath.width,4.8);assert.equal(besidePath.depth,3.2);
const huilongModel=geometry.build([huilongToilet],huilongContext).small[0];
assert.ok(huilongModel,"the actual outdoor toilet between two buildings beside 回龙巷 fits at its original point");
assert.deepEqual(copy(huilongModel.center),huilongToilet.geometry.coordinates);
assert.ok(huilongModel.width>=2.4 && huilongModel.depth>=1.6);
assert.equal(geometry.build([huilongToilet],{...huilongContext,obstacles:[
  {...huilongRoad,properties:{...huilongRoad.properties,width:"8"}},...huilongContext.obstacles.slice(1),
]}).small.length,0,"an explicit 8 m carriageway still prevents a model that would overlap the road");
for(const highway of ["motorway","motorway_link","trunk","trunk_link","primary","primary_link","secondary","secondary_link",
  "tertiary","tertiary_link","residential","unclassified","service","living_street","pedestrian","track","cycleway","footway","path","steps","unknown"])
  for(const tags of [{highway},{highway,lanes:"4"},{highway,lanes:"1"},{highway,width:"12"}]) {
    const half=parser.huayuPavilionRoadHalfWidth(tags),road={...pathAt(half+1.8),properties:{renderKind:"road",...tags}};
    const expected={...road,properties:{...road.properties,width:String(half*2)}};
    assert.deepEqual(copy(geometry.build([toilet],{...outdoorContext,obstacles:[road]}).small),
      copy(geometry.build([toilet],{...outdoorContext,obstacles:[expected]}).small),"facility road estimates match pavilion clearance: "+JSON.stringify(tags));
  }
const compact=geometry.build([{...cafe,geometry:toilet.geometry}],{...outdoorContext,obstacles:[pathAt(1.9)]}).small[0];
assert.ok(compact && compact.depth<2.8,"missing dimensions can adapt to real available space");
assert.deepEqual(copy(compact.center),[148,12],"fitting never moves the original POI");
assert.ok(compact.width>=1.6 && compact.depth>=1.4);
const explicitCafe={...cafe,geometry:toilet.geometry,properties:{...cafe.properties,width:"3.2",length:"2.8"}};
assert.equal(geometry.build([explicitCafe],{...outdoorContext,obstacles:[pathAt(1.9)]}).small.length,0,
  "explicit dimensions cannot shrink to force a fit");
const diagonalPath={...pathAt(0),geometry:{type:"LineString",coordinates:[metres(-20,-20+2.3*Math.SQRT2),metres(20,20+2.3*Math.SQRT2)]}};
const wideKiosk={...cafe,geometry:toilet.geometry,properties:{...cafe.properties,width:"6",length:"2"}};
const aligned=geometry.build([wideKiosk],{...outdoorContext,obstacles:[diagonalPath]}).small[0];
assert.ok(aligned && Math.abs(aligned.angle-Math.PI/4)<1e-8,"unmarked direction may align with the actual nearby path");
assert.equal(aligned.width,6);assert.equal(aligned.depth,2);
assert.equal(geometry.build([{...wideKiosk,properties:{...wideKiosk.properties,direction:"180"}}],
  {...outdoorContext,obstacles:[diagonalPath]}).small.length,0,"explicit direction remains authoritative");
const wideRoad={...pathAt(25),properties:{renderKind:"road",highway:"primary",width:"60"}};
assert.equal(geometry.build([toilet],{...outdoorContext,obstacles:[wideRoad]}).small.length,0,
  "a distant centerline still reserves the full explicitly mapped road width");

// Exercise the same factory in a real worker rather than copying its algorithm.
const worker=new Worker(`const {parentPort}=require('node:worker_threads');const geometry=(${api.createFacilityGeometry.toString()})();parentPort.on('message',data=>parentPort.postMessage(geometry.build(data.features,data.context)));`,{eval:true});
try {
  const actual=await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);worker.postMessage({features:[lot,narrowParking,pairedLot,ferris,toilet,cafe],context:outdoorContext});});
  assert.deepEqual(actual,copy(geometry.build([lot,narrowParking,pairedLot,ferris,toilet,cafe],outdoorContext)));
  const adapted=await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);
    worker.postMessage({features:[wideKiosk],context:{...outdoorContext,obstacles:[diagonalPath]}});});
  assert.deepEqual(adapted,copy(geometry.build([wideKiosk],{...outdoorContext,obstacles:[diagonalPath]})));
  const actualToilet=await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);
    worker.postMessage({features:[huilongToilet],context:huilongContext});});
  assert.deepEqual(actualToilet,copy(geometry.build([huilongToilet],huilongContext)),"actual roadside toilet has identical worker and fallback placement");
}finally{await worker.terminate();}

// Full raw-tag normalization: preserve geometry over duplicate center-only output.
parser.window={HuayuFacilityModels:api};
for(const name of ["huayuSupplementalElementCenter","huayuSupplementalFacilityAreaGeometry","huayuBuildingColorProperties",
  "huayuBuildingMaterialColor","huayuBuildingMaterialProperties","huayuFacilityPointColors","huayuFacilityFeatures"])
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))[0],parser);
const rawWay={type:"way",id:1,tags:lot.properties,geometry:lot.geometry.coordinates[0].map(([lon,lat])=>({lon,lat}))};
const inputs=parser.huayuFacilityFeatures([{type:"way",id:1,tags:lot.properties,center:{lon:148,lat:12}},rawWay]);
assert.equal(inputs.length,1);assert.equal(inputs[0].geometry.type,"Polygon");
const relation={type:"relation",id:3,tags:{amenity:"parking",type:"multipolygon"},members:[{type:"way",ref:1,role:"outer",geometry:rawWay.geometry}]};
assert.equal(parser.huayuFacilityFeatures([rawWay,relation]).length,1,"relation members are not modeled twice");

// Actual Three.js geometry: a vertical wheel, shared depth, exact tagged base.
const listeners=new Map(),layers=new Map(),sources=new Map();
const map={on:(key,fn)=>listeners.set(key,fn),off:key=>listeners.delete(key),triggerRepaint(){},
  getStyle:()=>({layers:[...layers.values()]}),getLayer:id=>layers.get(id),removeLayer:id=>layers.delete(id),
  getSource:id=>sources.get(id),removeSource:id=>sources.delete(id),getZoom:()=>19,getTerrain:()=>({source:"terrain"}),queryTerrainElevation:()=>13};
const c=api.sync(map,[ferris],{night:false,satellite:false});clearTimeout(c.timer);c.timer=null;
context.maplibregl={MercatorCoordinate:{fromLngLat:([x,y])=>({x:x*1e-5,y:-y*1e-5,meterInMercatorCoordinateUnits:()=>1e-5})}};
c.T=THREE;c.scene=new THREE.Scene();c.prepared=baseline;c.build();
assert.equal(c.groups.length,1);const group=c.groups[0].group;
assert.equal(group.position.z,18,"model rests on terrain plus explicit min_height");
group.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(group);
assert.ok(bounds.max.z<=13+60.1 && bounds.min.z>=13+5-.1,"tagged overall height is retained");
assert.ok(bounds.max.z-bounds.min.z>40 && bounds.max.x-bounds.min.x>39,"wheel is vertical and spans its diameter");
const built=c.groups;c.options={night:false,satellite:true};c.position();assert.equal(c.groups,built,"terrain-only updates reuse geometry");
c.prepared=outdoor;c.options={night:false,satellite:false};c.build();
assert.ok(c.facilityBatches.length<=6,"all small models share a bounded set of instanced meshes");
c.scene.updateMatrixWorld(true);const smallBounds=new THREE.Box3().setFromObject(c.scene);
assert.ok(Math.abs(smallBounds.min.z-13)<.001 && smallBounds.max.z<=16.101,"small buildings sit on real terrain and retain their full height");
const savedBatches=c.facilityBatches;map.queryTerrainElevation=()=>null;c.position();
const instance=new THREE.Matrix4();savedBatches[0].mesh.getMatrixAt(0,instance);
assert.equal(new THREE.Vector3().setFromMatrixScale(instance).length(),0,"missing elevation hides a model rather than placing it at zero");
assert.equal(c.facilityBatches,savedBatches,"terrain readiness reuses geometry");
api.dispose(map);assert.equal(listeners.size,0);assert.equal(c.groups.length,0);assert.equal(c.resources.length,0);
assert.ok(source.includes('renderingMode:"3d"') && source.includes("autoClear=false") && source.includes("owner.options.satellite"));

// Delayed work cannot replace a newer revision or commit during an active drag.
const fakeLayers=new Map([["ground",{id:"ground",type:"background"}]]),fakeSources=new Map();let commits=0;
const fakeMap={...map,getStyle:()=>({layers:[...fakeLayers.values()]}),getLayer:id=>fakeLayers.get(id),
  getSource:id=>fakeSources.get(id),getPitch:()=>0,getZoom:()=>18,
  addSource:(id,data)=>fakeSources.set(id,{...data,setData(data){this.data=data;commits++;}}),
  addLayer:layer=>fakeLayers.set(layer.id,layer),removeLayer:id=>fakeLayers.delete(id),removeSource:id=>fakeSources.delete(id),
  getPaintProperty:(id,key)=>fakeLayers.get(id)?.paint?.[key],setPaintProperty:(id,key,value)=>{fakeLayers.get(id).paint[key]=value;},
  getLayoutProperty:(id,key)=>fakeLayers.get(id)?.layout?.[key],setLayoutProperty:(id,key,value)=>{const layer=fakeLayers.get(id);(layer.layout ||= {})[key]=value;}};
const pending=api.sync(fakeMap,[lot],{});clearTimeout(pending.timer);pending.timer=null;
let resolve;pending.prepare=()=>new Promise(done=>{resolve=done;});
const stale=pending.apply();pending.update([lot,aisle],{});clearTimeout(pending.timer);pending.timer=null;
resolve(baseline);await stale;clearTimeout(pending.timer);pending.timer=null;
assert.equal(pending.prepared,undefined,"late geometry cannot take ownership of a new source revision");
const dragging=pending.apply();pending.interacting=true;resolve(geometry.build([lot]));await dragging;
assert.equal(commits,0,"worker completion during a drag keeps the current displayed source");
pending.interacting=false;await pending.apply();assert.equal(commits,1);
const previous=pending.prepared;let attempts=0;
pending.update([ferris],{});clearTimeout(pending.timer);pending.timer=null;
pending.prepare=async()=>{attempts++;throw new Error("fixture worker failure");};
const warn=context.console;context.console={...console,warn(){}};
try{await pending.apply();await pending.apply();}finally{context.console=warn;}
assert.equal(pending.prepared,previous,"failed preparation preserves the previous complete result");
assert.equal(attempts,1,"terrain and source events do not cause an unbounded preparation retry");
pending.options={satellite:true};await pending.apply();
assert.equal(fakeMap.getLayoutProperty(`${api.SOURCE}-surface`,"visibility"),"none");
const stablePoints=[toilet,cafe];pending.prepare=async()=>geometry.build(pending.features,pending.options.context);
pending.update(stablePoints,{context:outdoorContext});clearTimeout(pending.timer);pending.timer=null;await pending.apply();
assert.equal(pending.prepared.small.length,2);
const coveredContext={...outdoorContext,obstacles:[obstacle]};
pending.update(stablePoints,{context:coveredContext});clearTimeout(pending.timer);pending.timer=null;await pending.apply();
assert.equal(pending.prepared.small.length,1,"late building geometry removes the covered model with the original POI retained");
assert.equal(pending.features,stablePoints,"containment updates do not rewrite the original points");
api.dispose(fakeMap);assert.equal(fakeSources.size,0);assert.equal(fakeLayers.size,1);

// An unavailable supplemental endpoint retries without clearing existing POIs/models.
const retryMap={getZoom:()=>18},retained={facilities:[cafe],data:{features:[cafe]}},retryDelays=[];
const retryBounds={west:147,east:149,south:11,north:13};
let unavailable=true,staleRequest=false;
const retryRuntime=vm.createContext({
  huayuSupplementalPoiStates:new WeakMap([[retryMap,retained]]),isHuayuBasemapSelected:()=>true,
  ensureHuayuSupplementalPoiLayer:()=>true,huayuAdministrativeQueryBounds:()=>retryBounds,
  huayuAdministrativeBoundsContain:(a)=>Boolean(a),paddedHuayuSupplementalPoiBounds:b=>b,
  scheduleHuayuSupplementalPois:(map,delay)=>retryDelays.push(delay),OVERPASS_URL:"https://example.invalid/overpass",
  fetchJson:async()=>{if(staleRequest)retained.requestId++;if(unavailable)throw new Error("temporarily offline");return {elements:[]};},
  huayuSupplementalPoiFeatureCollection:()=>({features:[]}),huayuFacilityFeatures:()=>[],applyHuayuSupplementalPois(){},
});
retained.requestId=0;
vm.runInContext(app.match(/  async function refreshHuayuSupplementalPois\([^]*?\n  \}/u)[0],retryRuntime);
for(let i=0;i<3;i++)await retryRuntime.refreshHuayuSupplementalPois(retryMap);
assert.deepEqual(retryDelays,[2000,10000,10800000],"two bounded retries precede the normal three-hour refresh");
assert.equal(retained.facilities[0],cafe);assert.equal(retained.data.features[0],cafe);
staleRequest=true;await retryRuntime.refreshHuayuSupplementalPois(retryMap);
assert.equal(retryDelays.length,3,"a stale failed request cannot requeue the old view");
staleRequest=false;retained.pendingBounds=null;unavailable=false;
await retryRuntime.refreshHuayuSupplementalPois(retryMap);
assert.equal(retained.failureRetries,0);assert.equal(retained.failureBbox,null);
console.log("Facility models passed: explicit tags, parking types/holes/islands/aisles, outdoor toilets/shops, complete building coverage, courtyard holes, roads/water, dimensions, deterministic budgets, worker parity, late containment updates, depth/terrain and cleanup.");
