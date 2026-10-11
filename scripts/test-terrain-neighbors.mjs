import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require = createRequire(import.meta.url);
const {terrainRuntime} = require("./data-update/builders/build-terrain-preload.cjs");
const runtime = await terrainRuntime(fileURLToPath(new URL("../site/", import.meta.url)));
const rectangle = (id, west, south, width, height, tags = {}) => ({type: "way", id, tags: {natural: "wood", ...tags},
  geometry: [[west,south],[west+width,south],[west+width,south+height],[west,south+height],[west,south]]
    .map(([lon,lat])=>({lon,lat}))});
const main = rectangle(1, 1, 1, 0.05, 0.05, {name: "主山"});
const hill = rectangle(2, 1.055, 1.01, 0.002, 0.002);
const city = rectangle(3, 1.15, 1.01, 0.002, 0.002);
const park = rectangle(4, 1.055, 1.02, 0.002, 0.002, {leisure: "park", name: "主山森林公园"});
const plain = rectangle(5, 1.055, 1.025, 0.002, 0.002, {name: "河谷平原林地"});
const chained = rectangle(6, 1.072, 1.01, 0.002, 0.002);
const sliver = rectangle(7, 1.055, 1.035, 0.0001, 0.0001);
const fixtures = [main,hill,city,park,plain,chained,sliver];
const surfaces = input => runtime.huayuLiveBasemapFeatureCollection(input,{includeMountainRelief:true})
  .features.filter(feature=>feature.properties.reliefRole==="surface");
const accepted = surfaces(fixtures);
assert.deepEqual(Array.from(accepted,f=>f.properties.sourceOsmId).sort(), ["1","2"]);
const foothill = accepted.find(f=>f.properties.sourceOsmId==="2");
assert.equal(foothill.properties.reliefNeighbor,1);
assert.equal(foothill.properties.reliefParent,"way:1");
assert.ok(foothill.properties.reliefHeight<90,"small foothills retain size-scaled heights");
assert.equal(surfaces([hill]).length,0,"standalone small city woods must remain woodland");
assert.deepEqual(surfaces(fixtures.slice().reverse()).map(f=>f.id).sort(),accepted.map(f=>f.id).sort(),
  "neighbour classification must not depend on input order or chain growth");
const geometry = {type:"Polygon",coordinates:[main.geometry.map(p=>[p.lon,p.lat]),
  [[1.005,1.005],[1.045,1.005],[1.045,1.045],[1.005,1.045],[1.005,1.005]]]};
const index = runtime.huayuMountainNeighborhoodIndex([{element:main,geometry}]);
const clearing = rectangle(8,1.024,1.024,0.002,0.002);
assert.equal(index.findNearby({type:"Polygon",coordinates:[clearing.geometry.map(p=>[p.lon,p.lat])]}),null,
  "a large clearing must not become mountainous merely because bounding boxes overlap");
const unnamedHeath = rectangle(20, 2, 2, 0.1, 0.1, {natural:"heath"});
const unnamedScrub = rectangle(21, 2.2, 2, 0.1, 0.1, {natural:"scrub"});
const urbanScrub = rectangle(22, 3, 2, 0.002, 0.002, {natural:"scrub"});
const nearbyHeath = rectangle(23, 1.055, 1.035, 0.002, 0.002, {natural:"heath"});
const lawn = rectangle(24, 2, 3, 0.1, 0.1, {natural:"grassland"});
const flatHeath = rectangle(25, 2, 2, 0.1, 0.1, {natural:"heath",name:"河谷平原"});
const forestPark = rectangle(26, 2, 2, 0.1, 0.1, {natural:"heath",leisure:"park",name:"山地森林公园"});
const namedHighland = rectangle(27, 3, 3, 0.002, 0.002, {natural:"grassland",name:"高山草地"});
const openSurfaces = surfaces([main,unnamedHeath,unnamedScrub,urbanScrub,nearbyHeath,lawn,flatHeath,forestPark,namedHighland]);
assert.deepEqual(Array.from(openSurfaces,f=>f.properties.sourceOsmId).sort(),["1","20","21","23","27"]);
assert.ok(openSurfaces.filter(f=>f.properties.sourceOsmId!=="1")
  .every(f=>f.properties.reliefLandKind==="open"&&f.properties.reliefHeight<=420),
  "unnamed rough land must use gentle open terrain, not forest canopy or tall mountain defaults");
console.log("Neighbour hills passed: real edges, parks, plains, slivers, order, holes and no transitive growth.");
