import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const index = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const base = JSON.parse(await readFile(new URL("../site/huayu-style.json", import.meta.url), "utf8"));
const original = JSON.stringify(base);
let requests = 0;
let unavailable = false;
const context = vm.createContext({
  BASEMAP_STYLES: {"huayu-satellite": {url: "./huayu-style.json?v=23"}},
  huayuSatelliteStyle: null, huayuSatelliteStylePromise: null,
  satelliteAnnotationsEnabled: false,
  huayuSatelliteMaterialFields: new Map(),
  ensureVectorBasemapLibrary: async () => {}, AbortSignal,
  fetch: async url => {
    requests++;
    assert.equal(url, "./huayu-style.json?v=23", "use the existing OGF style, not mismatched Earth imagery");
    return {ok: !unavailable, json: async () => structuredClone(base)};
  },
});
for (const name of ["huayuOverlayPalette", "createHuayuSatelliteStyle", "prepareVectorBasemap"]) {
  const declaration = app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}
const satellite = JSON.parse(JSON.stringify(context.createHuayuSatelliteStyle(base)));
assert.equal(JSON.stringify(base), original, "switching back must retain the untouched standard style");
assert.deepEqual(satellite.sources, base.sources, "share data sources and existing tile cache");
assert.equal(satellite.sprite, base.sprite);
assert.equal(satellite.glyphs, base.glyphs);
assert.equal(satellite.metadata["ogf-atlas:imagery"], "simulated-from-ogf-features");
assert.equal(satellite.layers.length, base.layers.length, "reuse the ground layers without adding a second relief layer");
for (let i = 0; i < base.layers.length; i++) {
  const {paint: beforePaint, ...before} = base.layers[i];
  const {paint: afterPaint, ...after} = satellite.layers[i];
  assert.deepEqual(after, before, `${before.id}: preserve classification, label anchors, zoom range and geometry`);
  if (before.type === "fill-extrusion") {
    for (const property of ["fill-extrusion-height", "fill-extrusion-base"]) {
      assert.deepEqual(afterPaint[property], beforePaint[property], `${before.id}: source heights remain available in other modes`);
    }
    assert.equal(afterPaint["fill-extrusion-opacity"], 0, "satellite must never show a vertical model");
  }
}
assert.deepEqual(satellite.layers.find(layer => layer.id === "building-top").paint["fill-translate"], [0, 0]);
assert.ok(satellite.layers.filter(layer => layer.type === "symbol" && layer.layout?.["text-field"])
  .every(layer => layer.paint["text-opacity"] === 0), "image-only presentation must not start with dense map labels");
context.satelliteAnnotationsEnabled = true;
const labelled = context.createHuayuSatelliteStyle(base);
assert.ok(labelled.layers.filter(layer => layer.type === "symbol" && layer.layout?.["text-field"])
  .every(layer => layer.paint["text-opacity"] > 0), "labels can be restored without moving their anchors");
context.satelliteAnnotationsEnabled = false;
assert.ok(satellite.layers.filter(layer => layer.type === "line" && /boundary|^parks_|tunnel/u.test(layer.id))
  .every(layer => layer.paint["line-opacity"] === 0), "administrative borders and underground lines are not physical image content");
for (const name of ["huayuTreeHash", "huayuTreeRandom", "huayuSatelliteMaterialPixels"]) {
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], context);
}
const grass = context.huayuSatelliteMaterialPixels("grass", "#6b744a");
assert.deepEqual(grass, context.huayuSatelliteMaterialPixels("grass", "#6b744a"),
  "panning or reloading cannot randomize the material");
const roof = context.huayuSatelliteMaterialPixels("roof-grain", "#aaa89e");
assert.ok(roof.filter((value,index) => index % 4 === 3).every(value => value < 255),
  "roof material must preserve the underlying tagged colour");
const shades = new Set(grass.filter((value,index) => index % 4 === 1));
assert.ok(shades.size > 30, "ground must contain continuous tonal detail rather than a flat fill");
const fieldCount = context.huayuSatelliteMaterialFields.size;
context.huayuSatelliteMaterialPixels("grass", "#506341");
assert.equal(context.huayuSatelliteMaterialFields.size, fieldCount,
  "material colours reuse their noise field rather than recomputing it");
assert.match(app, /function enterVectorPerspectiveMode[^]*?if \(selectedBasemapId === "huayu-satellite"\) return false/u);
assert.match(app, /if \(perspectiveSnapshot && id !== "huayu-satellite"\)/u,
  "switching from perspective preserves the location without inheriting tilt");
const palette = context.huayuOverlayPalette({getStyle: () => satellite});
assert.equal(palette.satellite, true);
assert.notEqual(palette.liveLandWood, context.huayuOverlayPalette({getStyle: () => base}).liveLandWood);
assert.equal(context.huayuOverlayPalette({getStyle: () => base}).satellite, undefined);
await Promise.all([context.prepareVectorBasemap("huayu-satellite"), context.prepareVectorBasemap("huayu-satellite")]);
assert.equal(requests, 1, "concurrent style switches share one preparation request");
await context.prepareVectorBasemap("huayu-satellite");
assert.equal(requests, 1, "repeated switches reuse the prepared style");
context.huayuSatelliteStyle = null;
unavailable = true;
await assert.rejects(context.prepareVectorBasemap("huayu-satellite"), /SATELLITE_STYLE_UNAVAILABLE/u);
assert.equal(context.huayuSatelliteStyle, null);
unavailable = false;
await context.prepareVectorBasemap("huayu-satellite");
assert.ok(context.huayuSatelliteStyle, "a failed preparation must allow retry");
assert.match(index, /value="huayu-satellite"/u);
assert.match(index, /OGF 地物生成的模拟卫星底图，非实拍影像/u);
assert.match(index, /aria-label="显示影像注记"/u);
// Switching away while terrain work is in flight must dispose the old material
// and avoid reading a removed style, even when MapLibre skips custom onRemove.
context.huayuMountainSurfaceRgb = () => [0.2, 0.3, 0.2];
context.HUAYU_LIVE_BASEMAP_LAYERS = {mountainOverviewTexture: "terrain"};
context.terrainOverlayEnabled = true;
let closedWorkers = 0, removedListeners = 0, deletedBuffers = 0, deletedTextures = 0;
let timerStarts = 0;
context.window = {clearTimeout() {}, cancelAnimationFrame() {}, setTimeout() {timerStarts++;}};
context.document = {getElementById: () => {throw new Error("stale diagnostics must not touch the current DOM");}};
for (const name of ["createHuayuWoodlandMaterialLayer", "updateHuayuLiveBasemapDiagnostics"]) {
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], context);
}
const material = context.createHuayuWoodlandMaterialLayer(palette);
const oldMap = {off() {removedListeners++;}};
const oldGL = {deleteBuffer() {deletedBuffers++;}, deleteTexture() {deletedTextures++;}};
material.map = oldMap;
material.gl = oldGL;
material.meshWorker = {close() {closedWorkers++;}};
material.blocks.set("pending", {buffer: {}, texture: {}});
material.onViewportChange = () => {};
material.onSourceContextChange = () => {};
material.onRemove(oldMap, oldGL);
material.onRemove(oldMap, oldGL);
material.scheduleRebuild();
assert.equal(closedWorkers, 1);
assert.equal(removedListeners, 2);
assert.equal(deletedBuffers, 1);
assert.equal(deletedTextures, 1);
assert.equal(material.map, null);
assert.equal(material.gl, null);
assert.equal(timerStarts, 0, "disposed materials cannot schedule another background rebuild");
context.updateHuayuLiveBasemapDiagnostics({active: false});
context.updateHuayuLiveBasemapDiagnostics({active: true, glMap: {
  getStyle: () => undefined, getLayersOrder: () => {throw new Error("removed style");},
}});
console.log("Satellite basemap passed: shared sources, overhead surfaces without 3D projection, camera guards, style isolation and retry.");
