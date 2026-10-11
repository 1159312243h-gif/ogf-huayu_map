import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import vm from "node:vm";
import fs from "node:fs/promises";
import {validateDataset} from "./update-all-data.mjs";
const require = createRequire(import.meta.url);
const {terrainRuntime, applyTerrainElevationObservations} = require("./data-update/builders/build-terrain-preload.cjs");
const {renderRuntime} = require("./data-update/builders/build-terrain-render-cache.cjs");
const site = fileURLToPath(new URL("../site/", import.meta.url));
const classifier = await terrainRuntime(site);
const renderer = await renderRuntime(site);
const geometry = {type: "Polygon", coordinates: [[[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2], [0, 0]]]};
const mountain = {type: "way", id: 1, tags: {natural: "wood", name: "测试岭"},
  geometry: geometry.coordinates[0].map(([lon, lat]) => ({lon, lat}))};
const nodes = Array.from({length: 14}, (_, index) => ({type: "node", id: index + 100, lon: 0.02 + index * 0.011,
  lat: 0.10 + (index % 3 - 1) * 0.019, tags: {natural: index < 11 ? "peak" : index === 11 ? "saddle" : "rock",
    ele: String(index < 11 ? 2800 + index * 180 : index === 11 ? 1400 : index === 12 ? 0 : 1800)}}));
const collect = elements => classifier.huayuLiveBasemapFeatureCollection(elements, {includeMountainRelief: true})
  .features.filter(feature => feature.properties.reliefRole === "surface");
const [surface] = collect([mountain, ...nodes]);
assert.equal(collect([mountain, {type:"node", id: 500, lon:0.04, lat:0.04, tags:{natural:"tree",ele:"250"}}]).length,1,
  "elevation-tagged trees must constrain terrain without requesting unrelated tree models during snapshot builds");
assert.equal(JSON.parse(surface.properties.reliefPeaks).length, 11, "all peaks, including the ninth and later, must survive");
assert.equal(JSON.parse(surface.properties.reliefSamples).length, 14, "saddles, spots and zero elevations must enter the field");
assert.equal(surface.properties.reliefHeight, 4600, "mapped heights must not be clipped at 2500 m");
const model = renderer.huayuMountainSurfaceModel(surface, surface.geometry);
for (const node of nodes) assert.equal(model.heightAt([node.lon, node.lat]), Number(node.tags.ele));
assert.equal(model.heightAt([0.3, 0.3]), 0, "mountain observations must not raise surrounding flatland");
const riverSurface = {...surface, id: "river-mountain"};
renderer.riverSurface = riverSurface;
vm.runInContext("huayuMountainWaterContexts.set(riverSurface,{features:[{geometry:{type:'LineString',coordinates:[[0.05,0.05],[0.05,0.15]]}}]})", renderer);
const riverModel = renderer.huayuMountainSurfaceModel(riverSurface, geometry);
for (const node of nodes) assert.equal(riverModel.heightAt([node.lon, node.lat]), Number(node.tags.ele),
  "valley shaping and edge fading must preserve observations");
for (const sample of model.heightField.samples) {
  const point = sample.coordinates;
  const nearby = model.heightAt([point[0] + 1e-8, point[1] + 1e-8]);
  assert.ok(Math.abs(nearby - sample.elevation) < 0.02, "the height field must remain continuous at measurements");
}
const reversed = collect([mountain, ...nodes.slice().reverse()])[0];
const reversedModel = renderer.huayuMountainSurfaceModel(reversed, geometry);
for (const point of [[0.037, 0.08], [0.134, 0.125]]) assert.ok(Math.abs(model.heightAt(point) - reversedModel.heightAt(point)) < 1e-8,
  "source order must not change the elevation interpolation");

const bounds = {west: 0, east: 0.2, south: 0, north: 0.2};
const vertices = renderer.huayuMountainSurfaceFeatureVertices(surface, 30000, bounds, 12);
const origin = renderer.huayuMountainMaterialOrigin(bounds);
for (const node of nodes) {
  const mx = (180 + node.lon) / 360 - origin[0];
  const my = (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + node.lat * Math.PI / 360))) / 360 - origin[1];
  let found = false;
  for (let offset = 0; offset < vertices.length; offset += 9) {
    if (Math.abs(vertices[offset] - mx) < 1e-10 && Math.abs(vertices[offset + 1] - my) < 1e-10
      && Math.abs(vertices[offset + 7] - Number(node.tags.ele)) < 0.01) found = true;
  }
  assert.ok(found, `the rendered mesh must contain node ${node.id} at its actual elevation`);
}
const root = {...surface, id: "range", properties: {...surface.properties, reliefArea: 5e9}};
const child = {...surface, id: "nested", geometry: {type: "Polygon", coordinates: [[[0.03, 0.03], [0.15, 0.03], [0.15, 0.15], [0.03, 0.15], [0.03, 0.03]]]},
  properties: {...surface.properties, reliefArea: 8e7}};
const ranges = renderer.huayuMountainRangeContext([root, child], {features: []});
renderer.members = [root, child]; renderer.rangesTest = ranges;
vm.runInContext("members.forEach(feature=>huayuMountainWaterContexts.set(feature,rangesTest))", renderer);
const a = renderer.huayuMountainSurfaceModel(root, root.geometry), b = renderer.huayuMountainSurfaceModel(child, child.geometry);
assert.equal(a.heightAt([0.08, 0.11]), b.heightAt([0.08, 0.11]));
assert.equal(a.heightField.sampleCount, 14, "duplicate parent/child observations must not count twice");
const park = {...mountain, id: 2, tags: {...mountain.tags, leisure: "park", name: "测试山森林公园"}};
assert.equal(collect([park, ...nodes]).length, 0);
const plain = {...mountain, id: 3, tags: {...mountain.tags, name: "测试平原林区"}};
assert.equal(collect([plain, ...nodes]).length, 0);
for (const value of ["", "garbage", "120m bad", "90000", null]) assert.equal(classifier.huayuTerrainElevationMeters(value), null);
assert.equal(classifier.huayuTerrainElevationMeters("1000 ft"), 304.8);
assert.equal(classifier.huayuTerrainElevationMeters("4355 m"), 4355);
assert.equal(classifier.huayuTerrainElevationMeters("0"), 0);
const packet = {generatedAt: "2026-10-09T06:57:01.976Z", features: [surface]};
const next = applyTerrainElevationObservations(packet, nodes.map(node => node.id === 100 ? {...node, tags: {...node.tags, ele: "5100"}} : node),
  classifier, "2026-10-11T00:00:00Z");
assert.equal(next.generatedAt, packet.generatedAt, "repreparing heights must preserve the original geometry's data time");
assert.equal(next.heightField.scope, "mountains-only");
assert.equal(next.heightField.flatland, "deferred");
assert.equal(renderer.huayuMountainSurfaceModel(next.features[0], geometry).heightAt([nodes[0].lon, nodes[0].lat]), 5100,
  "a later observation must replace the height without manual hill edits");
const deleted = applyTerrainElevationObservations(next, nodes.filter(node => node.id !== 100), classifier, "2026-10-11T03:00:00Z");
assert.equal(JSON.parse(deleted.features[0].properties.reliefSamples).some(sample => sample.id === "node:100"), false,
  "deleted source elevations must not be resurrected from an old snapshot");
assert.throws(() => validateDataset("terrain-preload.json.gz", {...next, format: 1, schema: "open-small-mountains-v1",
  coverage: Array.from({length: 3}, (_, index) => ({id: String(index), bounds: [[0,0],[1,1]], complete: true})),
  features: [{...surface, properties: {...surface.properties, reliefSamples: JSON.stringify([{coordinates:[0.1,0.1], elevation:"bad"}])}}]}),
  /高程约束损坏/u, "corrupt height observations must reject the new snapshot rather than replace the last valid one");
const worker = await fs.readFile(new URL("../site/_worker.js", import.meta.url), "utf8");
assert.ok(worker.includes('node["ele"](${bbox})'), "live and scheduled queries must include all mapped elevation points");
const workflow = await fs.readFile(new URL("../.github/workflows/data-refresh.yml", import.meta.url), "utf8");
assert.ok(workflow.includes('cron: "17 */3 * * *"'));
console.log("Height field passed: all peaks, saddles, spots, exact mesh heights, continuous shared slopes, automatic new observations, parks and flatland exclusions.");
