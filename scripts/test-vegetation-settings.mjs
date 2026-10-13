import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/vegetation-models.js", import.meta.url), "utf8");
const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const storage = new Map(), events = [];
const context = vm.createContext({setTimeout, clearTimeout, console: {warn() {}},
  localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
  CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
  dispatchEvent: event => events.push(event), reviewLoadLibrary: () => Promise.reject(new Error("offline"))});
vm.runInContext(source.replace('import("./three-0.160.1.module.min.js")', "root.reviewLoadLibrary()"), context);
const api = context.HuayuVegetation;
const clone = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(clone(api.getPreferences()), {treeModel: "classic", vegetationDensity: "dense", gardenFlowers: true});
assert.deepEqual(clone(api.normalize({treeModel: "bogus", vegetationDensity: "extreme", gardenFlowers: "false"})), clone(api.DEFAULTS));
api.setPreferences({gardenFlowers: false});
assert.equal(JSON.parse(storage.get(api.STORAGE_KEY)).gardenFlowers, false);
assert.equal(events.at(-1).type, "huayu-render-settings-change");
assert.equal(events.at(-1).detail.saved, true);
context.localStorage.setItem = () => {throw new Error("blocked");};
assert.equal(api.setPreferences({treeModel: "natural"}), false);
assert.equal(api.getPreferences().treeModel, "natural", "denied storage still supports this session");
api.setPreferences(api.DEFAULTS);

const treeRuntime = vm.createContext({clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v))});
for (const name of ["huayuTreeHash", "huayuTreeRandom", "huayuTreeCircleGeometry", "huayuTreeModelParts", "createHuayuGardenModels"])
  vm.runInContext(app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], treeRuntime);
const point = [152.9648, 14.632];
const ground = [];
for (let i = 0; i < 12; i++) {
  const mapped = i === 0;
  const element = {type: "node", id: mapped ? 10 : 20, tags: {height: "12", circumference: "1.8"}};
  for (const part of treeRuntime.huayuTreeModelParts(element, [point[0] + i * 0.0001, point[1]], mapped ? null : i)) {
    ground.push({type: "Feature", id: `${part.renderKind}:${part.element.id}`, geometry: part.geometry,
      properties: {...part.properties, osmType: "node", osmId: part.element.id, renderKind: part.renderKind}});
  }
}
const garden = clone(treeRuntime.createHuayuGardenModels().build([{type: "way", id: 30, tags: {leisure: "garden"},
  geometry: [[152.964, 14.632], [152.965, 14.632], [152.965, 14.633], [152.964, 14.633], [152.964, 14.632]]
    .map(([lon, lat]) => ({lon, lat}))}], {zoom: 18})).features;
const descriptions = api.describe(ground, garden);
assert.equal(descriptions.filter(t => !t.garden).length, 12);
assert.ok(descriptions.some(t => t.garden));
const tree = descriptions.find(t => !t.garden);
assert.ok(Math.abs(tree.center[0] - point[0]) < 1e-10 && Math.abs(tree.center[1] - point[1]) < 1e-10);
assert.equal(tree.height, 12); assert.equal(tree.base, 0);
assert.ok(tree.radius > 1 && tree.trunkRadius < 0.4);
assert.equal(ground.length, 24, "source geometry is not mutated");
const light = api.selection(descriptions, "light"), standard = api.selection(descriptions, "standard"), dense = api.selection(descriptions, "dense");
assert.ok(light.size < standard.size && standard.size < dense.size);
assert.ok([...light].every(key => standard.has(key)) && [...standard].every(key => dense.has(key)));
assert.deepEqual([...api.selection(descriptions.slice().reverse(), "light")].sort(), [...light].sort());
assert.ok(light.has(tree.key), "explicit mapped trees never disappear at lower density");
assert.ok(api.selection([{key: "point-garden", group: "node:33"}], "light").has("point-garden"));
const roofTree = {...garden.find(f => f.properties.plantType === "tree")};
if (roofTree.properties) {
  const elevated = garden.filter(f => f.properties.plantKey === roofTree.properties.plantKey)
    .map(f => ({...f, properties: {...f.properties, plantGround: 20,
      plantBase: f.properties.plantBase + 20, plantHeight: f.properties.plantHeight + 20}}));
  const t = api.describe([], elevated)[0];
  assert.equal(t.base, 20); assert.ok(t.crownBase > 20 && t.height > t.crownBase);
}

const filters = new Map(), listeners = new Map(); let submissions = 0;
const options = {trunk: "trunk", canopy: "canopy", plants: "plants", night: false, satellite: false};
const map = {getLayer: id => ["trunk", "canopy", "plants"].includes(id),
  getFilter: id => filters.get(id), setFilter: (id, filter) => {submissions++; filters.set(id, filter);},
  triggerRepaint() {}, on: (type, fn) => listeners.set(type, fn),
  off: (type, fn) => {assert.equal(listeners.get(type), fn); listeners.delete(type);}};
const controller = api.sync(map, ground, garden, options);
assert.ok(!JSON.stringify(filters.get("plants")).includes('"flower"'));
const stable = submissions;
api.sync(map, ground, garden, options);
assert.equal(submissions, stable, "stable filters are not resubmitted");
api.setPreferences({vegetationDensity: "light", gardenFlowers: false});
api.sync(map, ground, garden, options);
assert.ok(JSON.stringify(filters.get("trunk")).includes("woodland"));
assert.ok(JSON.stringify(filters.get("plants")).includes('"flower"'));
assert.equal(controller.ground, ground); assert.equal(controller.garden, garden);
api.setPreferences({treeModel: "natural"});
api.sync(map, ground, garden, options);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(controller.status, "failed");
assert.ok(!JSON.stringify(filters.get("canopy")).includes("false"), "failed natural component retains classic crowns");
api.sync(map, ground, garden, {...options, satellite: true});
assert.equal(controller.status, "classic", "simulated satellite never starts 3D trees");
api.dispose(map); assert.equal(listeners.size, 0);
api.setPreferences({treeModel: "natural"});
api.sync(map, ground, garden, options);
api.dispose(map);
const getLayer = map.getLayer;
map.getLayer = () => {throw new Error("removed map must not be accessed by a late loader");};
await new Promise(resolve => setTimeout(resolve, 20));
map.getLayer = getLayer;
assert.equal(listeners.size, 0, "late failed imports do not revive a disposed controller");

assert.ok(html.includes('data-action="settings"') && html.includes('id="settings-view"'));
assert.ok(html.includes('value="classic"') && html.includes('value="natural"'));
const actions = app.match(/  function runAction\([^]*?\n  \}/u)[0];
assert.ok(actions.indexOf('action === "settings"') < actions.indexOf("exitVectorPerspectiveMode"));
assert.ok(actions.includes('showView("settings", {preservePerspective: true})'));
assert.ok(source.includes("new T.InstancedMesh") && source.includes("autoClear = false"));
assert.ok(source.includes("queryTerrainElevation(tree.center)") && source.includes("renderer.resetState()"));
assert.ok(!source.includes("localStorage.clear") && !source.includes("fetch("));
console.log("Vegetation settings passed: defaults, persistence/denial, natural descriptors, nested density, mapped points, flowers, fallback, satellite and cleanup.");
