import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {webcrypto,createHash} from "node:crypto";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const declaration = name => {
  const result = app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`,"u"))?.[0];
  assert.ok(result,name); return result;
};
const names = declaration("huayuTerrainMeshWorkerSource").match(/const functions = \[([^]*?)\];/u)[1]
  .split(",").map(name=>name.trim());
const factory = vm.createContext({HUAYU_MOUNTAIN_WOODLAND_MIN_AREA:1e6,
  HUAYU_REGIONAL_MOUNTAIN_SURFACE_MIN_AREA:4e8,HUAYU_TERRAIN_MIN_ZOOM:5.5});
for (const name of new Set(names)) vm.runInContext(declaration(name),factory);
vm.runInContext(declaration("huayuTerrainMeshWorkerSource"),factory);
const workerSource = factory.huayuTerrainMeshWorkerSource();
const records = new Map();
let answer, transferred, storageDenied = false;
let preparedHoles = 0;
const canvasContext = Object.fromEntries(["beginPath","moveTo","lineTo","closePath","fill"]
  .map(name=>[name,()=>{}]));
canvasContext.fill=()=>{if(canvasContext.globalCompositeOperation==="destination-out")preparedHoles++;};
class Canvas {
  getContext(){return canvasContext;}
  convertToBlob(){return Promise.resolve(new Blob(["mask"]));}
  transferToImageBitmap(){return {close(){}};}
}
const store = {put:entry=>records.set(entry.key,structuredClone(entry)),
  get:key=>{const request={};setImmediate(()=>{request.result=records.get(key);request.onsuccess();});return request;},
  count:()=>{const request={};setImmediate(()=>{request.result=records.size;request.onsuccess();});return request;}};
const indexedDB={open:()=>{
  if(storageDenied)throw Error("denied");
  const request={};setImmediate(()=>{request.result={transaction:()=>({objectStore:()=>store})};request.onsuccess();});
  return request;
}};
const worker=vm.createContext({Float32Array,Blob,TextEncoder,crypto:webcrypto,performance,setTimeout,clearTimeout,
  OffscreenCanvas:Canvas,indexedDB,createImageBitmap:async()=>({close(){}}),
  self:{postMessage:(message,transfer)=>{answer=message;transferred=transfer;}}});
vm.runInContext(workerSource,worker);
const hill={type:"Feature",id:"test-hill",properties:{reliefRole:"surface",reliefArea:88e6,
  reliefHeight:800,reliefNeighbor:1},geometry:{type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}};
const cell={key:"3/0.5/0/0",bounds:{west:0,east:0.5,south:0,north:0.5}};
const job={id:1,register:[[1,hill]],surfaces:[1],water:[],occlusions:[],cell,zoom:9,needsMesh:true};
await worker.self.onmessage({data:job});
assert.equal(answer.error,undefined);
assert.ok(answer.values.length>0);
assert.equal(answer.renderedNeighbors,1);
worker.testFeature=hill;
assert.equal(vm.runInContext("huayuMountainSurfaceModels.has(testFeature) || huayuMountainWaterContexts.has(testFeature)",worker),false,
  "finished meshes must release temporary per-feature sampling indices");
assert.ok(transferred.includes(answer.values.buffer),"large mesh buffers must transfer without a main-thread copy");
const first=Array.from(answer.values);
// The same shared algorithm must produce byte-identical geometry in the synchronous fallback.
const fallback=await worker.huayuWoodlandMaterialBuildGeometry(hill ? [hill] : [],{features:[]},cell.bounds,9);
assert.deepEqual(Array.from(fallback.values),first);
const neighbor={...hill,id:"neighbor",geometry:{type:"Polygon",coordinates:[
  [[0.25,0.25],[0.6,0.25],[0.6,0.6],[0.25,0.6],[0.25,0.25]]]}};
const adjacent=await worker.huayuWoodlandMaterialBuildGeometry([hill,neighbor],{features:[]},cell.bounds,9);
const owners=new Set();
for(let offset=8;offset<adjacent.values.length;offset+=9){
  const encoded=adjacent.values[offset];
  owners.add(Math.floor(Math.abs(encoded)/256));
  assert.ok(Math.abs(encoded)%256>0 && Math.abs(encoded)%256<=120,
    "owner encoding must preserve the actual contour interval and regional sign");
}
assert.deepEqual([...owners],[1,2],"overlapping hills must have independent mesh owners");

// Several land-cover polygons within one regional range share a physical field.
// Their mapped material outlines must not become separate sea-level hill bases.
const rangeRoot={...hill,id:"main-range",properties:{reliefRole:"surface",reliefArea:50e9,reliefHeight:2500}};
const patch={...hill,id:"nested-forest",properties:{reliefRole:"surface",reliefArea:88e6,reliefHeight:650},
  geometry:{type:"Polygon",coordinates:[[[0.3,0.3],[0.7,0.3],[0.7,0.7],[0.3,0.7],[0.3,0.3]]]}};
const openPatch={...patch,id:"nested-open",properties:{...patch.properties,reliefLandKind:"open"}};
const edgePatch={...patch,id:"extension",geometry:{type:"Polygon",coordinates:[
  [[0.94,0.2],[1.02,0.2],[1.02,0.8],[0.94,0.8],[0.94,0.2]]]}};
const unrelated={...patch,id:"unrelated",geometry:{type:"Polygon",coordinates:[
  [[1.2,0.3],[1.4,0.3],[1.4,0.5],[1.2,0.5],[1.2,0.3]]]}};
const context=worker.huayuMountainRangeContext([patch,rangeRoot,openPatch,edgePatch,unrelated],{features:[]});
assert.equal(context.ranges.get(rangeRoot),context.ranges.get(patch));
assert.equal(context.ranges.get(openPatch),context.ranges.get(patch),
  "open ground inside a range must keep the same elevation rather than reset to its gentle standalone model");
assert.equal(context.ranges.get(unrelated),undefined,"nearby but separate hills must remain independent");
worker.rangeMembers=[rangeRoot,patch,openPatch,edgePatch];worker.rangeContextTest=context;
vm.runInContext("rangeMembers.forEach(feature=>huayuMountainWaterContexts.set(feature,rangeContextTest))",worker);
const inherited=worker.huayuMountainSurfaceModel(patch,patch.geometry);
const mainRange=worker.huayuMountainSurfaceModel(rangeRoot,rangeRoot.geometry);
for(const point of [[0.3,0.5],[0.300001,0.5],[0.5,0.5],[0.7,0.5]]) {
  assert.equal(inherited.heightAt(point),mainRange.heightAt(point),"nested polygon edges must not create an artificial valley");
  assert.ok(inherited.heightAt(point)>100,"an internal land-cover edge is still on the mountain");
}
assert.equal(inherited.peakHeight,mainRange.peakHeight,"material normalization must match across nested footprints");
assert.equal(inherited.regionalWavelength,mainRange.regionalWavelength,"slope sampling and contours must use the same range scale");
const across=[mainRange.heightAt([0.99999,0.5]),mainRange.heightAt([1.00001,0.5])];
assert.ok(across.every(value=>value>0) && Math.abs(across[0]-across[1])<2,
  "an overlapping real extension must continue smoothly through the old main-range boundary");
const reversed=worker.huayuMountainRangeContext([unrelated,edgePatch,openPatch,rangeRoot,patch],{features:[]});
assert.equal(reversed.ranges.get(patch).heightAt([0.5,0.5]),context.ranges.get(patch).heightAt([0.5,0.5]),
  "changing snapshot order must not change the shared terrain");
const clearingRoot={...rangeRoot,id:"range-with-hole",geometry:{type:"Polygon",coordinates:[hill.geometry.coordinates[0],patch.geometry.coordinates[0]]}};
const clearingHill={...patch,id:"clearing-hill",geometry:{type:"Polygon",coordinates:[
  [[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6],[0.4,0.4]]]}};
assert.equal(worker.huayuMountainRangeContext([clearingRoot,clearingHill],{features:[]}).ranges.get(clearingHill),undefined,
  "bounding-box containment must not merge a separate hill in a real clearing");
const constrained={...patch,id:"mapped-summit",properties:{...patch.properties,
  reliefPeaks:JSON.stringify([{coordinates:[0.5,0.5],elevation:2100}])}};
assert.equal(worker.huayuMountainRangeContext([rangeRoot,constrained],{features:[]}).ranges.get(rangeRoot).heightAt([0.5,0.5]),2100,
  "a measured local peak must constrain the shared range, including the surrounding parent surface");
const ownerPixels=new Uint8ClampedArray(16*16*4);
ownerPixels.fill(255);
const slanted={...patch,geometry:{type:"Polygon",coordinates:[[[0.1,0.1],[0.9,0.5],[0.1,0.9],[0.1,0.1]]]}};
worker.huayuWoodlandMaterialOwnership([rangeRoot,slanted],([x,y])=>[x*16,y*16],16,ownerPixels);
for(let offset=0;offset<ownerPixels.length;offset+=4) {
  const owner=ownerPixels[offset+1]+ownerPixels[offset+2]*256;
  assert.ok(owner===1||owner===2,"diagonal material edges must never blend owner IDs or leave a seam");
  assert.equal(ownerPixels[offset+3],255,"ownership rasterization must preserve water/building coverage alpha");
}
ownerPixels[(8*16+8)*4+3]=0;
worker.huayuWoodlandMaterialOwnership([rangeRoot,slanted],([x,y])=>[x*16,y*16],16,ownerPixels);
assert.equal(ownerPixels[(8*16+8)*4+3],0,"protected mountain features must remain excluded");
assert.equal(records.size,1,"completed geometry and its mask must persist together");
await worker.self.onmessage({data:{...job,id:2,register:[]}});
assert.equal(answer.cacheHit,true,"reopening an unchanged geographic block must reuse its finished mesh");
assert.deepEqual(Array.from(answer.values),first);

// Published materials decode the prepared vertices without inferring heights.
let publishedFetches=0;
Object.assign(worker,{Uint8Array, TextDecoder, Response, AbortSignal, atob,
  fetch:async()=>{publishedFetches++;return new Response(JSON.stringify({format:1,model:"woodland-material-overview-v1",
    cell,surfaces:[hill],occlusions:[{...hill,geometry:{type:"Polygon",coordinates:[[[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3],[0.2,0.2]]]},
      properties:{materialOcclusion:"water"}}],
    vertices:Buffer.from(new Float32Array(first).buffer).toString("base64"),renderedNeighbors:1}));}});
const originalBuild = worker.huayuWoodlandMaterialBuildGeometry;
worker.huayuWoodlandMaterialBuildGeometry=()=>{throw Error("published overview must not recompute geometry");};
await worker.self.onmessage({data:{id:10,publishedUrl:"https://example.test/material.json.gz",preparedOcclusions:[]}});
assert.equal(answer.error,undefined);
assert.deepEqual(Array.from(answer.values),first);
assert.ok(transferred.includes(answer.values.buffer));
assert.equal(preparedHoles,1,"first render must protect snapshot water before any vector-source features arrive");
assert.equal(answer.waterFeatures.length,1,
  "prepared water must be drawable immediately without waiting for raw terrain or live basemap downloads");
await worker.self.onmessage({data:{id:11,publishedUrl:"https://example.test/material.json.gz",preparedOcclusions:[],
  maskBounds:{west:0.1,east:0.4,south:0.1,north:0.4},needsGeometry:false}});
assert.equal(answer.error,undefined);
assert.equal(answer.values.length,0,"panning must update the precise mask without copying/uploading unchanged geometry");
assert.equal(publishedFetches,1,"source arrivals must reuse the parsed snapshot rather than repeatedly fetch/decompress it");
worker.huayuWoodlandMaterialBuildGeometry=originalBuild;
const changed={...hill,properties:{...hill.properties,reliefHeight:600}};
await worker.self.onmessage({data:{...job,id:3,register:[[2,changed]],surfaces:[2]}});
assert.equal(answer.cacheHit,false,"updated elevations must invalidate persistent rendering results");
assert.notDeepEqual(Array.from(answer.values),first);
const prepared={...hill,terrainDigest:createHash("sha256").update(JSON.stringify(hill)).digest("hex")};
await worker.self.onmessage({data:{...job,id:4,register:[[9,prepared]],surfaces:[9]}});
assert.equal(answer.cacheHit,true,"precomputed snapshot digests must reuse the same exact geometry cache");
storageDenied=true;
const denied=vm.createContext({Float32Array,Blob,TextEncoder,crypto:webcrypto,performance,setTimeout,clearTimeout,
  OffscreenCanvas:Canvas,indexedDB,createImageBitmap:async()=>({close(){}}),
  self:{postMessage:message=>{answer=message;}}});
vm.runInContext(workerSource,denied);
await denied.self.onmessage({data:job});
assert.equal(answer.error,undefined,"denied persistent storage must not suppress terrain");
assert.deepEqual(Array.from(answer.values),first);

// The ordinary GeoJSON renderer must receive labels/water, never duplicate terrain meshes.
let vectorData, materialData, materialCalls=0;
const map={getSource:()=>({setData:data=>{vectorData=data;}})};
const layer={setData:data=>{materialData=data;materialCalls++;}};
const ctx=vm.createContext({ensureHuayuLiveBasemapLayers:()=>true,
  HUAYU_LIVE_BASEMAP_SOURCE:"live",huayuWoodlandMaterialLayers:new Map([[map,layer]]),
  applyHuayuSportsSnapshot:()=>{},scheduleHuayuLiveBasemapPrimarySync:()=>{},
  updateHuayuLiveBasemapDiagnostics:()=>{},window:{clearTimeout(){}}});
vm.runInContext(declaration("applyHuayuLiveBasemap"),ctx);
const label={id:"name",properties:{renderKind:"important-label"},geometry:{type:"Point",coordinates:[0.5,0.5]}};
const maskFeature={...hill,id:"building-mask",properties:{renderKind:"terrain-context",materialOcclusion:"building"}};
const state={renderRevision:1,appliedRevision:-1,data:{type:"FeatureCollection",features:[hill,label,maskFeature]}};
ctx.applyHuayuLiveBasemap(map,state);
assert.deepEqual(Array.from(vectorData.features),[label]);
assert.deepEqual(Array.from(materialData),[hill,label,maskFeature]);
ctx.applyHuayuLiveBasemap(map,state);
assert.equal(materialCalls,1,"panning unchanged data must not rescan/reindex all terrain polygons");
state.interacting=true;
state.renderRevision=2;
ctx.applyHuayuLiveBasemap(map,state);
assert.equal(materialCalls,1,"a snapshot arriving during a drag must wait until the gesture ends");
state.interacting=false;
ctx.applyHuayuLiveBasemap(map,state);
assert.equal(materialCalls,2,"the latest completed snapshot must apply after the gesture ends");
console.log("Terrain workers passed: published geometry without computation, exact parity, transferable buffers, persistent reuse, invalidation and no duplicate surfaces.");
