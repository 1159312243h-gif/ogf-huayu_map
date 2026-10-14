import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {Worker} from "node:worker_threads";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const source=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const declaration=(name,text=source) => {
  const match=text.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`,"u"));
  assert.ok(match,`Missing ${name}`);return match[0];
};
const runtime=vm.createContext({});
vm.runInContext(declaration("createHuayuGardenModels"),runtime);
const models=runtime.createHuayuGardenModels();
const way=(id,tags,west=142,south=24,width=0.001,height=0.001) => ({type:"way",id,tags,
  geometry:[[west,south],[west+width,south],[west+width,south+height],[west,south+height],[west,south]]
    .map(([lon,lat]) => ({lon,lat}))});
const garden=way(1,{leisure:"garden",name:"验收花园"});
const options={zoom:15,bounds:{west:142,south:24,east:142.001,north:24.001}};
const plain=models.build([garden],options);
assert.ok(plain.features.length>50,"real garden areas get varied modeled planting");
const plantCount=data => new Set(data.features.map(f => f.properties.plantKey)).size;
assert.ok(plantCount(plain)>120 && plantCount(plain)<=160,
  "medium garden areas get denser planting within the per-garden geometry limit");
assert.ok(models.version.startsWith("gardens-v2-"),"density changes invalidate only the garden model algorithm cache");
assert.deepEqual([...new Set(plain.features.map(f => f.properties.plantType))].sort(),["flower","shrub","tree"]);
assert.equal(JSON.stringify(plain),JSON.stringify(models.build([garden],options)),"revisiting never randomizes planting");
assert.equal(models.build([garden],{...options,zoom:14}).features.length,0,"overview tiles never carry close model geometry");
assert.equal(models.build([way(2,{building:"yes",name:"花园大厦"}),way(3,{leisure:"park",name:"森林花园公园"})],options).features.length,0,
  "names and parks are not enough to fabricate a garden model");
const flowerbed=models.build([way(4,{landuse:"flowerbed"},142,24,0.00015,0.00015)],options);
assert.equal(flowerbed.features.some(f => f.properties.plantType !== "flower"),false,"flowerbeds do not get invented trees");
assert.ok(plantCount(flowerbed)>=15,"mapped flowerbed areas receive closer-spaced flower clusters");
const node=models.build([{type:"node",id:5,lon:142.0004,lat:24.0004,tags:{leisure:"garden"}}],options);
assert.equal(new Set(node.features.map(f => f.properties.plantKey)).size,1,"point gardens use one compact flower cluster");
const road={type:"way",id:6,tags:{highway:"footway",width:"3"},geometry:[{lon:142.0005,lat:24},{lon:142.0005,lat:24.001}]};
const pond=way(7,{natural:"water"},142.00015,24.0002,0.0002,0.0004);
const avoided=models.build([pond,garden,road],options);
assert.ok(avoided.features.length>0 && avoided.features.length<plain.features.length);
for(const feature of avoided.features) for(const polygon of feature.geometry.coordinates) for(const [x,y] of polygon[0]) {
  assert.ok(x>142 && x<142.001 && y>24 && y<24.001,"all crowns and flowers stay within the garden");
  assert.ok(Math.abs(x-142.0005)*111320*Math.cos(24*Math.PI/180)>1.5,"modeled leaves stay off the mapped path");
  assert.ok(!(x>142.00015 && x<142.00035 && y>24.0002 && y<24.0006),"ponds stay clear of plants");
}
assert.equal(JSON.stringify(avoided),JSON.stringify(models.build([garden,road,pond],options)),"input order does not change planting");
const hole=way(8,{},142.0003,24.0003,0.0004,0.0004);
const island=way(9,{},142.0001,24.0012,0.0002,0.0002);
const relation={type:"relation",id:10,tags:{type:"multipolygon",leisure:"garden"},members:[
  {type:"way",ref:1,role:"outer",geometry:garden.geometry},
  {type:"way",ref:8,role:"inner",geometry:hole.geometry},
  {type:"way",ref:9,role:"outer",geometry:island.geometry}]};
const multipart=models.build([relation,garden,hole,island],{zoom:15});
assert.ok(multipart.features.every(f => f.properties.gardenOrigin === "relation:10"),"relation members do not duplicate the garden");
assert.ok(multipart.features.some(f => f.properties.plantY>24.0012),"separate polygon islands get planting too");
assert.ok(multipart.features.every(f => !(f.properties.plantX>142.0003 && f.properties.plantX<142.0007
  && f.properties.plantY>24.0003 && f.properties.plantY<24.0007)),"multipolygon holes remain empty");
const building={type:"Feature",properties:{height:8},geometry:{type:"Polygon",coordinates:[pond.geometry.map(p => [p.lon,p.lat])]}};
const masked=models.filterBuildings(plain.features,[building]);
assert.ok(masked.length<plain.features.length,"late building geometry removes overlapping plants");
assert.equal(models.filterBuildings(masked,[building]).length,masked.length,"masking is idempotent");
const roof=models.build([{...garden,tags:{leisure:"garden",height:"8"}}],options);
assert.ok(roof.features.every(f => f.properties.plantBase>=8.25));
assert.equal(models.filterBuildings(roof.features,[building]).length,roof.features.length,"roof planting remains on its mapped slab");
const big=models.build([way(20,{leisure:"garden"},142,24,0.1,0.1)],options);
assert.ok(plantCount(big)<=160,"bounded geometry for very large gardens");
const busyGardens=[garden,...Array.from({length:40},(_,i) =>
  way(100+i,{leisure:"garden"},142.002+(i%10)*0.0002,24+Math.floor(i/10)*0.0002,0.0001,0.0001))];
const busy=models.build(busyGardens,{zoom:15});
assert.ok(new Set(busy.features.filter(f=>f.properties.gardenOrigin==="way:1").map(f=>f.properties.plantKey)).size>=15,
  "many small neighbouring gardens must not starve a large garden of visible planting");
assert.ok(plantCount(busy)<=320,"all gardens share one bounded tile budget");
const denseTile=models.build(Array.from({length:3},(_,i) =>
  way(200+i,{landuse:"flowerbed"},142+i*0.003,24,0.002,0.002)),{zoom:15});
assert.equal(plantCount(denseTile),320,"dense areas share the new tile limit, not an unbounded model count");
for (const origin of new Set(denseTile.features.map(f => f.properties.gardenOrigin)))
  assert.ok(plantCount({features:denseTile.features.filter(f => f.properties.gardenOrigin === origin)})<=160);

const require=createRequire(import.meta.url);
const {terrainRuntime}=require("./data-update/builders/build-terrain-preload.cjs");
const treeRuntime=await terrainRuntime(fileURLToPath(new URL("../site/",import.meta.url)));
for (const name of ["HUAYU_WOODLAND_TREE_CLUSTER_MAX_AREA","HUAYU_WOODLAND_CLUSTER_TREE_LIMIT"])
  vm.runInContext(source.match(new RegExp(`  const ${name} = [^;]+;`,"u"))[0],treeRuntime);
for (const name of ["huayuTreeCircleGeometry","huayuTreeModelParts","huayuWoodlandTreeCenters"])
  vm.runInContext(declaration(name),treeRuntime);
const woodland=way(300,{natural:"wood"},142,24,0.002,0.002);
const woodlandGeometry={type:"Polygon",coordinates:[woodland.geometry.map(p => [p.lon,p.lat])]};
const trees=treeRuntime.huayuWoodlandTreeCenters(woodland,woodlandGeometry,18000);
assert.equal(trees.length,10,"woodland areas use approximately one tree per 1800 square metres");
const fullFootprint=treeRuntime.huayuWoodlandTreeCenters(woodland,woodlandGeometry,200000);
assert.ok(fullFootprint.some(point => point[1]>24.0016) && fullFootprint.some(point => point[1]<24.0004),
  "area trees cover both ends of the footprint rather than stopping after the first grid rows");
const pointInPolygon=treeRuntime.huayuPointInPolygonGeometry;
let candidateChecks=0;
treeRuntime.huayuPointInPolygonGeometry=(...args) => {candidateChecks++;return pointInPolygon(...args);};
const thinWoodland={type:"Polygon",coordinates:[[[142,24],[143,24],[143,24.00001],[142,24.00001],[142,24]]]};
const thinTrees=treeRuntime.huayuWoodlandTreeCenters(woodland,thinWoodland,200000);
assert.ok(thinTrees.length<=96 && candidateChecks<=288,"extreme aspect ratios keep the full-footprint sampling budget bounded");
treeRuntime.huayuPointInPolygonGeometry=pointInPolygon;
assert.equal(JSON.stringify(trees),JSON.stringify(treeRuntime.huayuWoodlandTreeCenters(woodland,woodlandGeometry,18000)),
  "denser trees remain fixed when the map is revisited");
const treeHoles={type:"MultiPolygon",coordinates:[
  [woodlandGeometry.coordinates[0],[[142.0005,24.0005],[142.0015,24.0005],[142.0015,24.0015],
    [142.0005,24.0015],[142.0005,24.0005]]],
  [way(301,{},142.003,24,0.002,0.002).geometry.map(p => [p.lon,p.lat])]]};
const holeTrees=treeRuntime.huayuWoodlandTreeCenters(woodland,treeHoles,200000);
assert.ok(holeTrees.length>72 && holeTrees.length<=96,"dense woodland respects the new per-area limit");
assert.ok(holeTrees.every(point => treeRuntime.huayuPointInPolygonGeometry(point,treeHoles)),
  "denser woodland never fills multipolygon holes or grows outside the actual boundary");
const mappedTree={type:"node",id:302,lon:142.01,lat:24,tags:{natural:"tree",height:"12","crown:diameter":"6"}};
const mapped=treeRuntime.huayuLiveBasemapFeatureCollection([mappedTree]);
assert.equal(mapped.features.length,2,"mapped point trees still contain only one trunk and one canopy");
assert.ok(mapped.features.every(f => f.properties.treeOrigin === "mapped"));
assert.equal(mapped.features.find(f => f.properties.renderKind === "tree-canopy").properties.treeHeight,12);
const treeTile=treeRuntime.huayuLiveBasemapFeatureCollection(Array.from({length:12},(_,i) =>
  way(400+i,{natural:"wood"},142+i*0.004,24,0.003,0.003)));
assert.equal(treeTile.features.filter(f => f.properties.renderKind === "tree-canopy").length,320,
  "all area trees share one bounded live-basemap batch");
assert.equal(treeRuntime.huayuLiveBasemapFeatureCollection([woodland],{includeMountainRelief:true}).features
  .some(f => f.properties.renderKind?.startsWith("tree-")),false,"regional mountain snapshots never gain close tree geometry");

// Late buildings must only refresh planting when the visible model changes.
// They must not trigger another upload/rebuild of roads and mountain material.
const groundSource={writes:0,setData(){this.writes++;}},gardenSource={writes:0,setData(){this.writes++;}};
const material={writes:0,setData(){this.writes++;}},map={getSource:id=>id==="plants"?gardenSource:groundSource};
const buildings=new WeakMap([[map,{data:{features:[]}}]]),structures=new WeakMap();
const application=vm.createContext({huayuGardenModels:models,HUAYU_GARDEN_PLANT_SOURCE:"plants",HUAYU_LIVE_BASEMAP_SOURCE:"ground",
  huayuLiveBuildingStates:buildings,huayuStructureStates:structures,huayuWoodlandMaterialLayers:new WeakMap([[map,material]]),
  huayuTerrainPreload:null,document:{getElementById:()=>({dataset:{}})},window:{clearTimeout(){}},
  ensureHuayuLiveBasemapLayers:()=>true,applyHuayuSportsSnapshot(){},scheduleHuayuLiveBasemapPrimarySync(){},updateHuayuLiveBasemapDiagnostics(){}});
vm.runInContext(declaration("applyHuayuLiveBasemap"),application);
const ground={type:"Feature",properties:{renderKind:"road"}},terrain={type:"Feature",properties:{reliefRole:"surface"}};
const state={data:{features:[ground,terrain,...plain.features]},renderRevision:1,appliedRevision:-1};
application.applyHuayuLiveBasemap(map,state);
assert.deepEqual([groundSource.writes,gardenSource.writes,material.writes],[1,1,1]);
buildings.get(map).data={features:[building]};application.applyHuayuLiveBasemap(map,state);
assert.deepEqual([groundSource.writes,gardenSource.writes,material.writes],[1,2,1]);
buildings.get(map).data={features:[building]};application.applyHuayuLiveBasemap(map,state);
assert.deepEqual([groundSource.writes,gardenSource.writes,material.writes],[1,2,1],"unchanged planting never reuploads geometry");
state.data={features:[ground,{...terrain,id:"new-terrain"},...plain.features]};state.renderRevision++;
application.applyHuayuLiveBasemap(map,state);
assert.deepEqual([groundSource.writes,gardenSource.writes,material.writes],[1,2,2],"real terrain updates still reach the material");

const factory=vm.createContext({});
const names=declaration("huayuModelTileWorkerSource").match(/const functions = \[([^]*?)\];/u)[1].split(",").map(s => s.trim());
for(const name of [...names,"createHuayuGardenModels","huayuModelEntryBytes","huayuModelTileWorkerMain","huayuModelTileWorkerSource"])
  vm.runInContext(declaration(name),factory);
// Building materials and roof geometry intentionally invalidate the shared
// building/structure model metadata. Gardens retain their independent cache
// version and must continue to produce identical geometry below.
assert.equal(createHash("sha256").update(names.map(name=>factory[name].toString()).join("\n")).digest("hex"),
  "53df39f0bb314ca5fb05b62260a378830de5462b1d122c3208860bb25c02df55",
  "material and roof changes use the reviewed v16 building/structure cache algorithm");
const worker=new Worker(`const {parentPort}=require("node:worker_threads");
global.self={postMessage:value=>parentPort.postMessage(value)};
parentPort.on("message",data=>self.onmessage({data}));
${factory.huayuModelTileWorkerSource()}`,{eval:true});
try {
  const result=await new Promise((resolve,reject) => {
    worker.once("message",resolve);worker.once("error",reject);
    worker.postMessage({id:1,action:"decode",kind:"garden",options,text:JSON.stringify({elements:[garden,road,pond]})});
  });
  assert.equal(result.error,undefined);
  assert.equal(JSON.stringify(result.result.data),JSON.stringify(avoided),"actual background worker uses identical garden geometry");
} finally {await worker.terminate();}
console.log(JSON.stringify({status:"passed",gardenPlants:new Set(plain.features.map(f=>f.properties.plantKey)).size,
  components:plain.features.length,workerParity:true,preserved:"paths, ponds, holes, roof heights and existing model caches"}));
