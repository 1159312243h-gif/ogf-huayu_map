import assert from "node:assert/strict";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import "../site/brand-data.js";
import worker, {brandDataQuery} from "../site/_worker.js";
import {buildBrandCatalog, catalogQuery, completeElements, replaceBrandCatalog} from "./update-brand-catalog.mjs";

const data = globalThis.HuayuBrandData;
const count = total => ({type: "count", id: 0, tags: {total: String(total)}});
const node = (id, tags, lat = 14.6, lon = 152.9) => ({type: "node", id, lat, lon, tags});
const raw = [node(1, {brand: 'A "B";.*', operator: "运营公司", branch: "中心分店", "addr:city": "津川", shop: "convenience"}),
  {type: "way", id: 2, center: {lat: 14.61, lon: 152.91}, tags: {brand: 'A "B";.*', name: "广场店", shop: "convenience"}},
  {type: "relation", id: 3, center: {lat: 14.62, lon: 152.92}, tags: {brand: "另一品牌", operator: "运营公司", amenity: "bank"}}];
const payload = elements => ({osm3s: {timestamp_osm_base: "2026-10-24T06:46:50Z"}, elements: [count(elements.length), ...elements]});
const brands = data.aggregate([...raw, raw[0]], "brand"), operators = data.aggregate(raw, "operator");
assert.equal(brands[0].count, 2, "点面去重使用来源 ID，不将同名各分店合并为一项地点");
assert.equal(operators.length, 1, "品牌与运营者各自聚合，不按关联名称合并身份");
assert.equal(operators[0].count, 2);
assert.equal(data.matches(brands, "津川 中心")[0].name, 'A "B";.*');
assert.equal(data.matches(brands, "", "amenity=bank")[0].name, "另一品牌");
assert.equal(data.matches([{name: "ＡＢＣ", count: 1, categories: []}], "abc").length, 1);
assert.equal(data.place(raw[1]).sourceKey, "way/2");
assert.equal(data.place(raw[2]).lat, 14.62);
assert.equal(data.place({type: "way", id: 5, tags: {}}), null, "缺失坐标不能伪定位到零度");
assert.equal(data.place(node(5, {}, 0, 0)).lat, 0, "零坐标有效");
const manyBranches = data.aggregate(Array.from({length: 80}, (_, i) => node(i + 10, {brand: "连锁", branch: `店${i}`})), "brand")[0];
assert.equal(manyBranches.branchCount, 80, "精确不同 branch 数量不受样本上限影响");
assert.equal(manyBranches.branches.length, 12);
const imported = data.validateCatalog(JSON.parse(await readFile(new URL("../site/brand-catalog.json", import.meta.url), "utf8")));
assert.ok(imported.brands.length > 1000 && imported.operators.length > 1000);
const q = new URL('https://map.test/api/brands?kind=brand&scope=world'); q.searchParams.set("name", 'A "B";.*');
const definition = brandDataQuery(q);
assert.ok(definition.query.includes(`["brand"=${JSON.stringify('A "B";.*')}]`));
assert.ok(!definition.query.includes('["brand"~'), "名称必须作为字面量，不能执行正则");
assert.ok(definition.query.includes("out count") && definition.query.includes("center 500"));
assert.throws(() => brandDataQuery(new URL("https://map.test/api/brands?kind=brand&scope=world&mode=discover")));
assert.throws(() => brandDataQuery(new URL("https://map.test/api/brands?kind=brand&scope=view&name=x&south=0&north=60&west=0&east=100")));
const countryScope = new URL("https://map.test/api/brands?kind=operator&mode=discover&scope=view&south=14&north=15&west=152&east=153");
assert.equal(brandDataQuery(countryScope).limit, 2000);
assert.throws(() => completeElements({...payload(raw), remark: "timeout"}, "brand"));
assert.throws(() => completeElements({elements: [count(4), ...raw]}, "brand"));
assert.throws(() => completeElements(payload([raw[0], raw[0]]), "brand"));
const candidate = buildBrandCatalog(payload(raw), payload(raw.filter(e => e.tags.operator)), null);
assert.ok(catalogQuery("operator","node").includes('node["operator"]["shop"]'));
assert.ok(!catalogQuery("operator","node").includes('node["operator"]->'),"运营者整库不扫描未限定的电力与网络对象");
assert.ok(catalogQuery("brand","rel").includes('rel["brand"]'));
assert.equal(candidate.brands.length, 2);
assert.throws(() => buildBrandCatalog(payload(raw), payload(raw.filter(e => e.tags.operator)), imported), /SHRINK/u);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "huayu-brand-test-"));
try {
  const file = path.join(temporaryDirectory, "catalog.json");
  await replaceBrandCatalog(file, candidate);
  const before = await readFile(file, "utf8");
  await replaceBrandCatalog(file, {...candidate, generatedAt:"2026-10-25T12:00:00Z"});
  assert.equal(JSON.parse(await readFile(file,"utf8")).generatedAt,"2026-10-25T12:00:00Z","完整新目录可以原子接管旧目录");
  await replaceBrandCatalog(file,candidate);
  await assert.rejects(replaceBrandCatalog(file, {...candidate, operators: []}));
  assert.equal(await readFile(file, "utf8"), before, "校验失败不能覆盖旧完整目录");
} finally {await rm(temporaryDirectory, {recursive: true, force: true});}

let time = Date.parse("2026-10-25T10:00:00Z"), calls = 0, fail = false, deferred;
const snapshot = {elements: raw, fetchedAt: new Date(time).toISOString(), total: 3, stale: false};
const store = data.createStore(async (_url, {signal}) => {
  calls++;
  if (fail) throw Error("upstream timeout");
  if (deferred) return new Promise(resolve => deferred = {resolve, signal});
  return Response.json(snapshot);
}, () => time);
assert.equal((await store.load("a", "/a")).elements.length, 3);
time += 119000; await store.load("a", "/a"); assert.equal(calls, 1);
time += 2000; fail = true;
const fallback = await store.load("a", "/a");
assert.equal(fallback.stale, true); assert.equal(fallback.fetchedAt, snapshot.fetchedAt);
await assert.rejects(store.load("new", "/new"), /timeout/u, "失败不是没有门店");
fail = false; deferred = true;
const late = store.load("old", "/old");
store.cancel();
deferred.resolve(Response.json(snapshot));
assert.equal(await late, null, "退出／切换后迟到响应不重新进入界面或缓存");

const originalFetch = globalThis.fetch, originalCaches = globalThis.caches, originalNow = Date.now;
let upstream = 0, mode = "ok", waitResolve;
const cache = new Map();
globalThis.caches = {default: {
  match: async request => cache.get(request.url)?.clone(),
  put: async (request, response) => cache.set(request.url, response.clone()),
}};
Date.now = () => time;
globalThis.fetch = async (_url, options) => {
  upstream++;
  assert.equal(String(_url), "https://overpass.opengeofiction.net/api/interpreter");
  assert.ok(String(options.body).startsWith("data="));
  if (mode === "fail") return new Response("overloaded", {status: 503});
  if (mode === "partial") return Response.json({...payload(raw), remark: "runtime error: timeout"});
  if (mode === "wait") await new Promise(resolve => {waitResolve = resolve;});
  if (mode === "empty") return Response.json(payload([]));
  if (mode === "truncated") return Response.json({elements: [count(800), ...Array.from({length: 500}, (_, i) => node(i + 1, {brand: "大量"}))]});
  return Response.json(payload(raw));
};
const api = suffix => worker.fetch(new Request(`https://map.test/api/brands?kind=brand&scope=world&name=test${suffix}`), {}, {});
try {
  const first = await (await api("")).json();
  assert.equal(first.total, 3); assert.equal(upstream, 1);
  const second = await (await api("&ignored=cachebuster")).json();
  assert.equal(second.fetchedAt, first.fetchedAt); assert.equal(upstream, 1, "缓存命中不重查或续期");
  time += 121000; mode = "partial";
  const stale = await (await api("")).json();
  assert.equal(stale.stale, true); assert.equal(stale.fetchedAt, first.fetchedAt);
  mode = "fail";
  assert.equal((await api("2")).status, 502, "无旧结果时失败须显式提示");
  mode = "empty";
  assert.equal((await (await api("3")).json()).total, 0, "真正完整空结果可正常显示");
  mode = "truncated";
  const large = await (await api("4")).json();
  assert.equal(large.total, 800); assert.equal(large.truncated, true); assert.equal(large.elements.length, 500);
  mode = "wait";
  const a = api("5");
  while (!waitResolve) await new Promise(resolve => setImmediate(resolve));
  const b = api("5");
  await new Promise(resolve => setImmediate(resolve));
  const prior = upstream; waitResolve();
  assert.equal((await a).status, 200); assert.equal((await b).status, 200); assert.equal(upstream, prior, "共享并发品牌请求");
} finally {globalThis.fetch = originalFetch; globalThis.caches = originalCaches; Date.now = originalNow;}
const browserSource = await readFile(new URL("../site/brand-browser.js", import.meta.url), "utf8");
function brandPage({ready, visible = true, panel = ""}) {
  class Element extends EventTarget {
    value = ""; textContent = ""; children = []; hidden = false; disabled = false;
    classList = {contains: () => false};
    replaceChildren(...children) {this.children = children;}
    append(...children) {this.children.push(...children);}
    add(option) {this.children.push(option);}
  }
  const nodes = new Map(), requests = [], intervals = new Set();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  el("brand-kind").value = "brand"; el("brand-sort").value = "count";
  el("brand-category").disabled = true;
  const window = Object.assign(new EventTarget(), {HuayuBrandData: data, location: {search: panel ? `?panel=${panel}` : ""}});
  const document = Object.assign(new EventTarget(), {getElementById: el, createElement: () => new Element(), hidden: false});
  let view = visible ? "brands" : "place", mapListeners = 0;
  const atlas = {
    getBrandMarkerLayer: () => ({clearLayers() {}}),
    map: {on() {mapListeners++;}, hasLayer: () => false},
    getCurrentView: () => view,
    openView(next) {view = next; window.HuayuBrandBrowser?.setActive(next === "brands");},
  };
  if (ready) window.HuayuAtlas = atlas;
  const context = vm.createContext({window, document, URLSearchParams, AbortSignal,
    Option: function(label, value) {this.textContent = label; this.value = value;},
    fetch: () => new Promise((resolve, reject) => requests.push({resolve, reject})),
    setInterval(fn) {intervals.add(fn); return fn;}, clearInterval: id => intervals.delete(id), clearTimeout,
  });
  vm.runInContext(browserSource, context);
  return {window, el, requests, intervals, context, get mapListeners() {return mapListeners;},
    ready() {window.HuayuAtlas = atlas; window.dispatchEvent(new Event("huayu:map-ready"));}};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
for (const ready of [false, true]) {
  const page = brandPage({ready, visible: !ready, panel: ready ? "brands" : ""});
  if (!ready) {
    assert.equal(page.window.HuayuBrandBrowser, undefined, "地图尚未就绪时等待，不永久退出");
    assert.equal(page.requests.length, 0);
    page.ready();
  }
  assert.ok(page.window.HuayuBrandBrowser, "同步和异步地图启动都初始化品牌模块");
  assert.equal(page.requests.length, 1, "已打开的品牌页与直接入口均加载一次目录");
  assert.equal(page.el("brand-category").disabled, true, "加载中不能选择空分类");
  page.requests.shift().resolve(Response.json(candidate)); await settle();
  const category = page.el("brand-category");
  assert.equal(category.disabled, false);
  assert.ok(category.children.some(option => option.value === "amenity=bank"));
  category.value = "amenity=bank"; category.dispatchEvent(new Event("change"));
  assert.deepEqual(page.el("brand-catalog-list").children.map(card => card.children[0].textContent), ["另一品牌"],
    "实际分类控件筛选对应条目");
  page.el("brand-kind").value = "operator"; page.el("brand-kind").dispatchEvent(new Event("change"));
  assert.equal(category.value, "amenity=bank", "切换目录类型保留有效分类");
  assert.deepEqual(page.el("brand-catalog-list").children.map(card => card.children[0].textContent), ["运营公司"]);
  page.el("brand-catalog-refresh").dispatchEvent(new Event("click"));
  page.requests.shift().reject(Error("offline")); await settle();
  assert.equal(category.disabled, false, "已有目录刷新失败仍可筛选");
  assert.equal(category.value, "amenity=bank");
  page.ready(); vm.runInContext(browserSource, page.context);
  assert.equal(page.mapListeners, 1, "重复就绪或脚本执行不重复挂载模块");
  assert.equal(page.intervals.size, 1);
}
const failedPage = brandPage({ready: true});
failedPage.requests.shift().reject(Error("offline")); await settle();
assert.equal(failedPage.el("brand-category").disabled, true);
assert.match(failedPage.el("brand-catalog-status").textContent, /检查新版目录/u);
failedPage.el("brand-catalog-refresh").dispatchEvent(new Event("click"));
failedPage.requests.shift().resolve(Response.json(candidate)); await settle();
assert.equal(failedPage.el("brand-category").disabled, false, "首次失败后可重试恢复分类");
const unopenedPage = brandPage({ready: true, visible: false});
assert.equal(unopenedPage.requests.length, 0, "未打开品牌页不加载目录");
assert.equal(unopenedPage.intervals.size, 0);
console.log("Brand catalog, literal queries, live cache age, failure retention, cancellation, delayed startup and category filtering checks passed.");
