import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const context = vm.createContext({huayuModelOcclusionStates: new WeakMap(),
  HUAYU_LIVE_BASEMAP_LAYERS:{mountainOverviewTexture:"terrain"},
  HUAYU_GARDEN_LAYERS:{pattern:"garden-pattern",outline:"garden-outline"}});
for (const name of ["syncHuayuModelOcclusion", "activateHuayuModelOcclusion", "deactivateHuayuModelOcclusion"]) {
  const declaration = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, `Missing ${name}`);
  vm.runInContext(declaration, context);
}

// Exercise the actual published styles, with asynchronously arriving trees,
// ground sports markings, structures, terrain and traffic overlays interleaved.
for (const file of ["huayu-style.json", "huayu-night-style.json"]) {
  const style = JSON.parse(await readFile(new URL(`../site/${file}`, import.meta.url), "utf8"));
  const definitions = new Map(style.layers.map(layer => [layer.id, structuredClone(layer)]));
  const order = style.layers.map(layer => layer.id);
  const listeners = new Map();
  let moves = 0;
  let styleReads = 0;
  const glMap = {
    // Loading sources must not delay repair until idle.
    isStyleLoaded: () => false,
    getStyle: () => {styleReads++; return {layers: order.map(id => definitions.get(id)).filter(layer => layer.type !== "custom")};},
    getLayersOrder: () => order,
    getLayer: id => definitions.get(id),
    getPaintProperty: (id, property) => definitions.get(id).paint?.[property],
    setPaintProperty: (id, property, value) => {
      (definitions.get(id).paint ||= {})[property] = value;
      listeners.get("styledata")?.();
    },
    on: (event, callback) => listeners.set(event, callback),
    off: (event, callback) => {assert.equal(listeners.get(event), callback); listeners.delete(event);},
    moveLayer: (id, beforeId) => {
      assert.ok(order.includes(id));
      assert.ok(!beforeId || order.includes(beforeId));
      order.splice(order.indexOf(id), 1);
      order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, id);
      moves += 1;
      listeners.get("styledata")?.();
    },
  };
  const add = (layer, beforeId) => {
    definitions.set(layer.id, layer);
    order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, layer.id);
  };
  add({id:"tree-canopy", type:"fill-extrusion", paint:{"fill-extrusion-opacity":0.94,
    "fill-extrusion-base":7, "fill-extrusion-height":12}}, "railway");
  add({id:"terrain", type:"custom", implementation:{renderingMode:"2d"}}, "building");
  add({id:"garden-fill", type:"fill"}, "terrain");
  add({id:"garden-pattern", type:"fill"}, "terrain");
  add({id:"garden-outline", type:"line"}, "terrain");
  add({id:"sports-markings", type:"line"}, "water-name-other");
  add({id:"pavilion", type:"fill-extrusion", paint:{"fill-extrusion-opacity":0.97,
    "fill-extrusion-base":3, "fill-extrusion-height":4}}, "poi-level-3");
  add({id:"wall", type:"fill-extrusion", layout:{visibility:"none"},
    paint:{"fill-extrusion-opacity":1}}, "highway-path");
  add({id:"traffic-line", type:"line"});
  add({id:"traffic-stop", type:"circle"});
  const surfaces = () => order.filter(id => ["background","fill","line","custom"].includes(definitions.get(id).type));
  const groundBefore = surfaces();
  const symbolsBefore = order.filter(id => definitions.get(id).type === "symbol");
  context.activateHuayuModelOcclusion(glMap);
  const verify = () => {
    const firstModel = order.findIndex(id => definitions.get(id).type === "fill-extrusion");
    const lastModel = order.findLastIndex(id => definitions.get(id).type === "fill-extrusion");
    assert.ok(surfaces().every(id => order.indexOf(id) < firstModel),
      "all roads, waterways, markings and flat terrain must precede even hidden 3D layers");
    assert.ok(order.filter(id => ["symbol","circle"].includes(definitions.get(id).type))
      .every(id => order.indexOf(id) > lastModel), "map annotations remain readable above solids");
    for (const layer of definitions.values()) if (layer.type === "fill-extrusion") {
      assert.equal(layer.paint["fill-extrusion-opacity"], 1, `${layer.id} must hide farther objects`);
    }
  };
  verify();
  const withoutGardenDetails = ids => ids.filter(id => !["garden-pattern","garden-outline"].includes(id));
  assert.deepEqual(withoutGardenDetails(surfaces()), withoutGardenDetails(groundBefore),
    "preserve terrain/water/road and tunnel/bridge order");
  assert.ok(order.indexOf("garden-fill") < order.indexOf("terrain"));
  assert.ok(order.indexOf("garden-pattern") > order.indexOf("terrain")
    && order.indexOf("garden-outline") > order.indexOf("terrain"),
    "planting details and garden borders stay visible on the shaded mountain ground");
  assert.deepEqual(order.filter(id => definitions.get(id).type === "symbol"), symbolsBefore);
  assert.equal(definitions.get("tree-canopy").paint["fill-extrusion-base"], 7);
  assert.equal(definitions.get("pavilion").paint["fill-extrusion-base"], 3, "do not fill pavilion hollows");
  const oldMoves = moves;
  const oldStyleReads = styleReads;
  listeners.get("styledata")();
  context.activateHuayuModelOcclusion(glMap);
  assert.equal(moves, oldMoves, "stable frames must not repeatedly move layers");
  assert.equal(styleReads, oldStyleReads, "stable styles must not repeatedly clone the full layer definitions");
  // A subsequent snapshot/overlay update may reinsert a road above models.
  glMap.moveLayer("traffic-line");
  verify();
  add({id:"bus-shelter", type:"fill-extrusion", paint:{"fill-extrusion-opacity":0.98}}, "highway-path");
  listeners.get("styledata")();
  verify();
  context.deactivateHuayuModelOcclusion(glMap);
  assert.equal(listeners.size, 0, "remove listeners when switching basemap");
}
console.log("Model occlusion regressions passed: ground order, solid depth, late updates, day/night and cleanup.");
