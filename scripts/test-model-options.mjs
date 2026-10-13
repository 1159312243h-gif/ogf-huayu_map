import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/model-options.js", import.meta.url), "utf8");
const vegetation = await readFile(new URL("../site/vegetation-models.js", import.meta.url), "utf8");
const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../site/styles.css", import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
function boot(storage = new Map(), denied = false) {
  const events = [];
  const context = vm.createContext({setTimeout, clearTimeout, console,
    localStorage: {
      getItem(key) {if (denied) throw new Error("blocked"); return storage.get(key) || null;},
      setItem(key, value) {if (denied) throw new Error("blocked"); storage.set(key, value);},
    },
    fetch() {throw new Error("candidate selection must not request assets or data");},
    CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
    dispatchEvent: event => events.push(event),
  });
  vm.runInContext(vegetation, context);
  vm.runInContext(source, context);
  return {context, api: context.HuayuModelOptions, events, storage};
}
const {context, api, events, storage} = boot();
const expected = {
  "birch-trees": "broadleaf", "pine-branches": "pine", "bush-lods": "shrubs", "daisy-flowers": "flowers",
  "gazebo": "pavilion", "nz-bus-shelter": "busShelter", "stone-fountain": "fountain",
  "chain-link-fence": "fence",
  "column-wall": "wall", "pingyao-reference": "cityWall",
};
assert.deepEqual(Object.fromEntries(api.candidates.map(candidate => [candidate.id, candidate.category])), expected);
assert.equal(api.categories.length, 10);
assert.equal(api.candidates.length, 10);
assert.equal(new Set(api.candidates.map(candidate => candidate.uid)).size, 10);
assert.ok(Object.isFrozen(api) && Object.isFrozen(api.categories) && Object.isFrozen(api.candidates));
assert.ok(api.categories.every(Object.isFrozen) && api.candidates.every(Object.isFrozen));
assert.equal(api.candidates.filter(candidate => candidate.status === "pending-file").length, 8);
assert.deepEqual(clone(api.candidates.filter(candidate=>candidate.status === "available-file").map(candidate=>candidate.id)),["birch-trees"]);
for (const candidate of api.candidates) {
  assert.ok(/^[a-f0-9]{32}$/u.test(candidate.uid), candidate.id);
  assert.equal(candidate.source, `https://sketchfab.com/models/${candidate.uid}`);
  assert.ok(candidate.author && candidate.listedGlbBytes > 0);
  assert.equal(candidate.license, "CC BY 4.0");
  assert.equal(candidate.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(candidate.status === "reference-only", candidate.category === "cityWall");
}
assert.ok(!api.categories.some(category => /busStop|sign|bench/iu.test(category.id)));
assert.ok(!api.categories.some(category => category.id === "metroEntrance"));
assert.ok(!Object.hasOwn(api.defaults, "metroEntrance"));
const legacy = boot(new Map([[api.STORAGE_KEY, JSON.stringify({metroEntrance:"mrt-exit-01",pine:"pine-branches",pavilion:"gazebo"})]])).api;
assert.deepEqual(clone(legacy.getSelections()), {...clone(api.defaults),pine:"pine-branches",pavilion:"gazebo"},
  "Discard the cancelled entrance choice while preserving other saved model choices.");
assert.deepEqual(clone(api.getSelections()), clone(api.defaults));
context.HuayuVegetation.setPreferences({treeModel: "natural", vegetationDensity: "light", gardenFlowers: false});
const renderPreferences = clone(context.HuayuVegetation.getPreferences());
const oldStoredPreferences = storage.get(context.HuayuVegetation.STORAGE_KEY);
events.length = 0;
for (const candidate of api.candidates) {
  assert.equal(api.setSelection(candidate.category, candidate.id), true);
  assert.equal(api.getState(candidate.category).selection, candidate.id);
  assert.equal(api.getState(candidate.category).effective, "existing", "pending candidates never take over rendering");
  assert.equal(api.getState(candidate.category).status, candidate.status);
  assert.equal(api.getState(candidate.category).candidate.id, candidate.id);
  assert.deepEqual(clone(context.HuayuVegetation.getPreferences()), renderPreferences);
}
assert.ok(events.every(event => event.type === api.EVENT && event.detail.saved));
assert.notEqual(api.STORAGE_KEY, context.HuayuVegetation.STORAGE_KEY);
assert.equal(storage.get(context.HuayuVegetation.STORAGE_KEY), oldStoredPreferences);
const restored = boot(storage).api;
assert.deepEqual(clone(restored.getSelections()), clone(api.getSelections()));
assert.deepEqual(clone(api.normalize({pine: "gazebo", pavilion: "gazebo", extra: "birch-trees"})),
  {...clone(api.defaults), pavilion: "gazebo"});
api.setSelection("pine", "gazebo");
assert.equal(api.getState("pine").selection, "existing");
const stable = clone(api.getSelections()), eventCount = events.length;
assert.equal(api.setSelection("not-a-category", "gazebo"), false);
assert.deepEqual(clone(api.getSelections()), stable);
assert.equal(events.length, eventCount);
api.setSelection("pine", "obsolete-pine");
assert.equal(api.getState("pine").selection, "existing");
for (const value of ["{broken", "null", "[1]", '"string"', "42"]) {
  assert.deepEqual(clone(boot(new Map([[api.STORAGE_KEY, value]])).api.getSelections()), clone(api.defaults));
}
const denied = boot(new Map(), true);
assert.equal(denied.api.setSelection("pine", "pine-branches"), false);
assert.equal(denied.api.getState("pine").selection, "pine-branches");
assert.equal(denied.api.getState("pine").effective, "existing");
assert.equal(denied.events.at(-1).detail.saved, false);
api.reset();
assert.deepEqual(clone(api.getSelections()), clone(api.defaults));
assert.deepEqual(clone(boot(storage).api.getSelections()), clone(api.defaults));

// Exercise the same structured DOM construction as the browser without a map or renderer.
class Element {
  constructor(tag, document) {this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = {}; this.listeners = {};this.dataset={};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children = children.flatMap(child => child.tagName === "fragment" ? child.children : [child]);}
  setAttribute(key, value) {this.attributes[key] = value;}
  addEventListener(type, handler) {this.listeners[type] = handler;}
}
const document = {createElement: tag => new Element(tag, document), createDocumentFragment: () => new Element("fragment", document)};
const container = new Element("div", document);
api.mount(container);
assert.equal(container.children.length, 10);
for (const row of container.children) {
  const [label, detail] = row.children;
  const select = label.children[1];
  assert.equal(label.htmlFor, select.id);
  assert.equal(select.attributes["aria-describedby"], detail.id);
  assert.equal(detail.attributes["aria-live"], "polite");
  assert.equal(detail.hidden, true);
  select.value = select.children[1].value;
  select.listeners.change();
  assert.equal(detail.hidden, false);
  assert.match(detail.children[0].textContent, /当前仍用现有模型/u);
  for (const option of select.children) {
    assert.equal(option.textContent, api.candidates.find(candidate => candidate.id === option.value)?.label || "沿用现有模型");
    assert.ok(!/[（）()]/u.test(option.textContent), "Dropdown names stay plain; status is shown below.");
  }
  for (const link of detail.children.slice(1, 3)) {
    assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
    assert.ok(link.href.startsWith("https://"));
  }
}
api.reset();
assert.ok(container.children.every(row => row.children[1].hidden && row.children[0].children[1].value === "existing"));
denied.api.mount(container);
assert.match(container.children[1].children[1].children[0].textContent, /本次打开暂存/u);
assert.ok(html.includes('id="model-option-controls"') && html.includes("10 款方案 · 文件状态加载中"));
assert.ok(html.indexOf('src="./model-options.js?') < html.indexOf('src="./app.js?'));
assert.ok(css.includes('.place-panel:has(#settings-view:not([hidden])) {z-index: 660;}'));
const resetHandler = app.match(/document.getElementById\("reset-render-settings"\).addEventListener\("click", \(\) => \{([^]*?)\n  \}\);/u)[1];
assert.ok(resetHandler.includes("HuayuModelOptions?.reset()") && resetHandler.includes("HuayuVegetation.DEFAULTS"));
assert.ok(!/fetch\(|import\(|innerHTML|triggerRepaint|setData|localStorage\.clear|huayu-render-settings-change/u.test(source));
console.log("Model candidates passed: confirmed catalogue, licensing, pending states, isolated persistence, denial, reset, accessible controls and unchanged rendering.");
