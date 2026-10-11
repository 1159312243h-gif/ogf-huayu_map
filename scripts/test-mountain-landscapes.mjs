import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {gunzipSync} from "node:zlib";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require = createRequire(import.meta.url);
const {renderRuntime} = require("./data-update/builders/build-terrain-render-cache.cjs");
const site = fileURLToPath(new URL("../site/",import.meta.url));
const runtime = await renderRuntime(site);
const app = await fs.readFile(path.join(site,"app.js"),"utf8");
const collect = app.match(/  function huayuWoodlandMaterialOcclusions\([^]*?\n  \}/u)[0];
const collectContext = vm.createContext({HUAYU_LIVE_BASEMAP_LAYERS:{water:"water"},
  HUAYU_LIVE_BUILDING_LAYER:"building",HUAYU_PAVILION_LAYER:"pavilion",HUAYU_PAVILION_BASE_LAYER:"base",
  huayuMountainSurfaceFeatureIntersectsViewport:()=>true});
vm.runInContext(collect,collectContext);
const woods = {id:"woods",geometry:{type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]},properties:{class:"wood"}};
const mappedGarden = {...woods,id:"garden",properties:{class:"grass",subclass:"garden"}};
const collected = collectContext.huayuWoodlandMaterialOcclusions({getStyle:()=>({layers:[
  {id:"garden-fill",type:"fill",source:"vector","source-layer":"landcover"}]}),
  querySourceFeatures:()=>[woods,mappedGarden]},[],null);
assert.deepEqual(Array.from(collected,feature=>feature.id),["garden"],
  "garden source queries must respect class filters and never erase the surrounding woodland");
const payload = JSON.parse(gunzipSync(await fs.readFile(path.join(site,"terrain-preload.json.gz"))));
const manifest = JSON.parse(await fs.readFile(path.join(site,"terrain-preload-manifest.json"),"utf8"));
const context = JSON.parse(gunzipSync(await fs.readFile(path.join(site,manifest.contextSnapshot.url))));
const mountain = payload.features.find(feature => feature.properties?.sourceOsmId === "487789");
const meiling = payload.features.find(feature => feature.properties?.sourceOsmId === "39038953");
const peach = context.features.find(feature => feature.properties?.osmId === "39038979");
assert.ok(mountain && meiling && peach,"use the actual Xishu mountain, Meiling and peach garden geometry");
const original = JSON.stringify([mountain,meiling,peach]);
const features = runtime.huayuMountainSurfaceLandscapes([mountain,meiling],[peach]);
assert.equal(features.length,3,"the mapped garden clearing needs slope material without becoming a new summit");
assert.equal(JSON.stringify([mountain,meiling,peach]),original,"classification, original holes and source parameters stay intact");
const gardens = features.filter(feature => feature.properties.reliefLandKind === "garden");
assert.ok(gardens.every(feature => feature.properties.reliefOnMountain === mountain.id));
const ranges = runtime.huayuMountainRangeContext(features,{features:[]});
runtime.reviewFeatures = features; runtime.reviewContext = ranges;
vm.runInContext("reviewFeatures.forEach(feature => huayuMountainWaterContexts.set(feature,reviewContext))",runtime);
const root = runtime.huayuMountainSurfaceModel(features[0],features[0].geometry);
for (const garden of gardens) {
  const model = runtime.huayuMountainSurfaceModel(garden,garden.geometry);
  const point = runtime.huayuGeometryInteriorPoint(garden.geometry);
  assert.ok(model.heightAt(point)>1,"garden ground remains on the mountain, not an empty/zero-altitude slot");
  assert.equal(model.heightAt(point),root.heightAt(point),"garden and forest use exactly one continuous height field");
  assert.equal(model.peakHeight,root.peakHeight,"normalization and contour interval match at garden edges");
}
const park = {...peach,id:"park",properties:{...peach.properties,osmId:"park",landscapeKind:"park",name:"森林公园"}};
assert.equal(runtime.huayuMountainSurfaceLandscapes([mountain],[park]).length,1,"forest parks remain park clearings");
const outside = {...peach,id:"outside",geometry:{type:"Polygon",coordinates:[[[150,12],[150.001,12],[150.001,12.001],[150,12.001],[150,12]]]}};
assert.equal(runtime.huayuMountainSurfaceLandscapes([mountain],[outside]).length,1,"ordinary gardens elsewhere never become hills");
// Real water holes remain transparent; only mapped gardens get slope material.
const lake = {...peach,properties:{...peach.properties,materialOcclusion:"water"}};
assert.equal(runtime.huayuMountainSurfaceLandscapes([mountain],[lake]).length,1);
const bounds = {west:152.9637,east:152.9659,south:14.6309,north:14.6348};
const built = await runtime.huayuWoodlandMaterialBuildGeometry(features,{features:[]},bounds,19);
const origin = runtime.huayuMountainMaterialOrigin(bounds);
assert.ok(built.values.length>0);
for (let offset=0;offset<built.values.length;offset+=9) {
  assert.ok(Math.abs(built.values[offset])<0.00001 && Math.abs(built.values[offset+1])<0.00001,
    "high-zoom vertices must use local coordinates, avoiding metre-wide float32 blocks");
  const position = origin[0]+built.values[offset];
  assert.ok(position>= (180+bounds.west)/360-1e-10 && position <= (180+bounds.east)/360+1e-10);
}
// Distinct sub-metre samples must survive packing, unlike absolute Mercator floats.
const local = new Float32Array([0.1/40075016.7,0.2/40075016.7]);
assert.ok(local[0] !== local[1] && Math.abs((local[1]-local[0])*40075016.7-0.1)<1e-6);
console.log("Mountain landscapes passed: actual Meiling/peach clearings, shared slopes, park exclusion, intact water holes and local-coordinate geometry.");
