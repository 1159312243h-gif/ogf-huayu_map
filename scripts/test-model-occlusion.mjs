import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const context = vm.createContext({huayuModelOcclusionStates: new WeakMap(),
  satelliteAnnotationsEnabled:false,
  HUAYU_LIVE_BASEMAP_LAYERS:{mountainOverviewTexture:"terrain",treeCanopy:"tree-canopy"},
  HUAYU_GARDEN_LAYERS:{pattern:"garden-pattern",outline:"garden-outline"},
  HUAYU_LIVE_BUILDING_LAYER:"live-buildings", HUAYU_ANCIENT_BUILDING_LAYERS:{roof:"ancient-roof"},
  HUAYU_PAVILION_LAYER:"pavilion", HUAYU_BUS_FACILITY_LAYERS:{model:"bus-shelter"},
  HUAYU_SUBWAY_ENTRANCE_MODEL_LAYER:"subway", HUAYU_ELEVATED_GREEN_LAYERS:{surface:"roof-garden"},
  huayuSatelliteTextureImage: () => "surface-grain"});
for (const name of ["syncHuayuModelOcclusion", "activateHuayuModelOcclusion", "deactivateHuayuModelOcclusion",
  "huayuSatelliteSurfaceLayer", "syncHuayuSatelliteSurfaces", "syncHuayuSatelliteAnnotations", "huayuBuildingColorExpression"]) {
  const declaration = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, `Missing ${name}`);
  vm.runInContext(declaration, context);
}

// Exercise the actual published styles, with asynchronously arriving trees,
// ground sports markings, structures, terrain and traffic overlays interleaved.
const publishedStyles = await Promise.all(["huayu-style.json", "huayu-night-style.json"].map(async file =>
  JSON.parse(await readFile(new URL(`../site/${file}`, import.meta.url), "utf8"))));
for (const name of ["huayuOverlayPalette", "createHuayuSatelliteStyle"]) {
  vm.runInContext(source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], context);
}
publishedStyles.push(context.createHuayuSatelliteStyle(publishedStyles[0]));
for (const style of publishedStyles) {
  const satellite = Boolean(style.metadata?.["ogf-atlas:imagery"]);
  const definitions = new Map(style.layers.map(layer => [layer.id, structuredClone(layer)]));
  const order = style.layers.map(layer => layer.id);
  const listeners = new Map();
  let moves = 0;
  let styleReads = 0;
  const glMap = {
    // Loading sources must not delay repair until idle.
    isStyleLoaded: () => false,
    getStyle: () => {styleReads++; return {metadata:style.metadata,
      layers: order.map(id => definitions.get(id)).filter(layer => layer.type !== "custom")};},
    getLayersOrder: () => order,
    getLayer: id => definitions.get(id),
    getPaintProperty: (id, property) => definitions.get(id).paint?.[property],
    getFilter: id => definitions.get(id)?.filter,
    getLayoutProperty: (id, property) => definitions.get(id)?.layout?.[property],
    setFilter: (id, value) => {definitions.get(id).filter = value; listeners.get("styledata")?.();},
    setLayoutProperty: (id, property, value) => {
      (definitions.get(id).layout ||= {})[property] = value; listeners.get("styledata")?.();
    },
    addLayer: (layer, beforeId) => {add(layer, beforeId); listeners.get("styledata")?.();},
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
  add({id:"tree-canopy", type:"fill-extrusion", source:"trees", paint:{"fill-extrusion-opacity":0.94,
    "fill-extrusion-base":7, "fill-extrusion-height":12}}, "railway");
  add({id:"terrain", type:"custom", implementation:{renderingMode:"2d"}}, "building");
  add({id:"garden-fill", type:"fill"}, "terrain");
  add({id:"garden-pattern", type:"fill"}, "terrain");
  add({id:"garden-outline", type:"line"}, "terrain");
  add({id:"sports-markings", type:"line"}, "water-name-other");
  add({id:"pavilion", type:"fill-extrusion", source:"structures", filter:["==",["get","pavilionPart"],"roof"], paint:{"fill-extrusion-opacity":0.97,
    "fill-extrusion-base":3, "fill-extrusion-height":4}}, "poi-level-3");
  add({id:"wall", type:"fill-extrusion", layout:{visibility:"none"},
    paint:{"fill-extrusion-opacity":1}}, "highway-path");
  add({id:"traffic-line", type:"line"});
  add({id:"traffic-stop", type:"circle"});
  add({id:"natural-trees", type:"custom", implementation:{renderingMode:"3d"}}, "water");
  add({id:"sun-shadow",type:"raster",metadata:{"huayu:sun-shadow":true}},"water");
  const surfaces = () => order.filter(id => ["background","fill","line"].includes(definitions.get(id).type)
    || definitions.get(id).type === "custom" && definitions.get(id).implementation?.renderingMode !== "3d");
  const groundBefore = surfaces();
  const symbolsBefore = order.filter(id => definitions.get(id).type === "symbol");
  context.activateHuayuModelOcclusion(glMap);
  const verify = () => {
    const firstModel = order.findIndex(id => definitions.get(id).type === "fill-extrusion");
    const lastModel = order.findLastIndex(id => definitions.get(id).type === "fill-extrusion");
    assert.ok(order.indexOf("sun-shadow") > Math.max(...surfaces().filter(id => !/-satellite-(surface|grain|shadow)$/u.test(id)).map(id => order.indexOf(id)))
      && order.indexOf("sun-shadow") < firstModel,"building ground shadows cover roads and terrain, and remain below 3D solids");
    assert.ok(surfaces().every(id => order.indexOf(id) < firstModel),
      "all roads, waterways, markings and flat terrain must precede even hidden 3D layers");
    assert.ok(order.filter(id => ["symbol","circle"].includes(definitions.get(id).type))
      .every(id => order.indexOf(id) > lastModel), "map annotations remain readable above solids");
    assert.ok(order.indexOf("natural-trees") > Math.max(...surfaces().map(id => order.indexOf(id))),
      "natural trees share the 3D pass after ground, not the annotation pass");
    assert.ok(order.indexOf("natural-trees") < Math.min(...order.filter(id => ["symbol","circle"].includes(definitions.get(id).type))
      .map(id => order.indexOf(id))), "annotations remain above natural trees");
    for (const layer of definitions.values()) if (layer.type === "fill-extrusion") {
      assert.equal(layer.paint["fill-extrusion-opacity"], satellite ? 0 : 1,
        `${layer.id}: overhead imagery hides models; standard modes preserve solid depth`);
    }
  };
  verify();
  const withoutGardenDetails = ids => ids.filter(id => !["garden-pattern","garden-outline"].includes(id)
    && !/-satellite-(surface|grain|shadow)$/u.test(id));
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
  add({id:"bus-shelter", type:"fill-extrusion",source:"structures",
    filter:["has","busFacilityPart"], paint:{"fill-extrusion-opacity":0.98}}, "highway-path");
  listeners.get("styledata")();
  verify();
  add({id:"garden-plants",type:"fill-extrusion",paint:{"fill-extrusion-base":0.06,"fill-extrusion-height":0.65,
    "fill-extrusion-opacity":1}},"water");
  listeners.get("styledata")();
  verify();
  assert.equal(definitions.get("garden-plants").paint["fill-extrusion-base"],0.06,"small flowers retain their actual low base");
  if (satellite) {
    assert.equal(definitions.get("tree-canopy-satellite-surface").type, "fill");
    assert.equal(definitions.get("tree-canopy-satellite-surface").source, "trees", "no duplicate tree data or requests");
    assert.equal(definitions.has("wall-satellite-surface"), false);
    assert.equal(definitions.has("garden-plants-satellite-surface"), false);
    const roof = definitions.get("bus-shelter-satellite-surface");
    assert.ok(JSON.stringify(roof.filter).includes("shelter-roof"), "posts and signs cannot appear in the roof surface");
    const handoffFilter = ["all", ["==", ["get", "pavilionPart"], "roof"], ["==", ["get", "osmType"], "node"]];
    const reads = styleReads;
    glMap.setFilter("pavilion", handoffFilter);
    assert.deepEqual(definitions.get("pavilion-satellite-surface").filter, handoffFilter,
      "surface follows dedup after snapshot handoff even without a layer-order change");
    assert.deepEqual(definitions.get("pavilion-satellite-grain").filter, handoffFilter);
    assert.deepEqual(definitions.get("pavilion-satellite-shadow").filter, handoffFilter);
    glMap.setLayoutProperty("pavilion", "visibility", "none");
    assert.equal(definitions.get("pavilion-satellite-surface").layout.visibility, "none");
    assert.equal(definitions.get("pavilion-satellite-grain").layout.visibility, "none");
    assert.equal(definitions.get("pavilion-satellite-shadow").layout.visibility, "none");
    glMap.setLayoutProperty("pavilion", "visibility", "visible");
    assert.equal(definitions.get("pavilion-satellite-surface").layout.visibility, "visible");
    assert.equal(styleReads, reads, "satellite handoff does not clone full styles every frame");
    const shadows = order.filter(id=>id.endsWith("-satellite-shadow"));
    const roofs = order.filter(id=>id.endsWith("-satellite-surface"));
    assert.ok(shadows.every(shadow=>roofs.every(roof=>order.indexOf(shadow)<order.indexOf(roof))),
      "aerial shadows cannot paint over other roofs or crowns");
    context.satelliteAnnotationsEnabled = true;
    context.syncHuayuModelOcclusion(glMap);
    assert.ok([...definitions.values()].filter(layer=>layer.type==="symbol" && layer.layout?.["text-field"])
      .every(layer=>layer.paint["text-opacity"]>0));
    context.satelliteAnnotationsEnabled = false;
    add({id:"late-place",type:"symbol",source:"places",layout:{"text-field":"{name}"},paint:{"text-opacity":1}});
    listeners.get("styledata")();
    assert.equal(definitions.get("late-place").paint["text-opacity"],0,"late labels follow the image-only preference");
  }
  context.deactivateHuayuModelOcclusion(glMap);
  assert.equal(listeners.size, 0, "remove listeners when switching basemap");
}
console.log("Model occlusion regressions passed: ground order, solid depth, late updates, day/night/satellite and cleanup.");
