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
const cityScope = new URL("https://map.test/api/brands?kind=brand&mode=discover&scope=city&relation=8877");
const cityDefinition = brandDataQuery(cityScope);
assert.equal(cityDefinition.city, 8877);
assert.ok(cityDefinition.query.includes('rel(8877)["boundary"="administrative"]'));
assert.ok(cityDefinition.query.includes("map_to_area->.cityArea;.cityArea out count;"));
assert.ok(cityDefinition.query.includes('nwr["brand"](area.cityArea)'), "城市按真实区域查询，不用店名、城市文字或包围盒筛选");
assert.ok(!cityDefinition.query.includes("津川"));
for (const id of ["", "0", "-1", "1);nwr;", "1.5", "9007199254740992"]) {
  const invalid = new URL(cityScope); invalid.searchParams.set("relation", id);
  assert.throws(() => brandDataQuery(invalid));
}
const cityLocations = new URL(cityScope); cityLocations.searchParams.set("mode", "locations"); cityLocations.searchParams.set("name", 'A "B";.*');
assert.ok(brandDataQuery(cityLocations).query.includes(`["brand"=${JSON.stringify('A "B";.*')}](area.cityArea)`));
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
  if (mode === "city") return Response.json({...payload(raw), elements: [count(1), ...payload(raw).elements]});
  if (mode === "city-no-area") return Response.json({elements: [count(0), count(0)]});
  if (mode === "city-partial") return Response.json({elements: [count(1), count(2001), ...Array.from({length: 2000}, (_, i) => node(i + 1, {brand: `品牌${i}`}))]});
  if (mode === "city-duplicate") return Response.json({elements: [count(1), count(2), raw[0], raw[0]]});
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
  const cityApi = id => worker.fetch(new Request(`https://map.test/api/brands?kind=brand&mode=discover&scope=city&relation=${id}`), {}, {});
  mode = "city";
  const cityResult = await (await cityApi(8877)).json();
  assert.equal(cityResult.total, 3); assert.equal(cityResult.cityRelation, 8877);
  assert.equal(data.aggregate(cityResult.elements, "brand").length, 2, "不同分店按品牌去重，含不带城市文字的标签");
  mode = "city-no-area";
  const missingArea = await cityApi(8878);
  assert.equal(missingArea.status, 502, "区域尚未生成不得报告零品牌或退回矩形");
  assert.match((await missingArea.json()).error, /行政边界/u);
  time += 121000;
  const retainedCity = await (await cityApi(8877)).json();
  assert.equal(retainedCity.stale, true); assert.equal(retainedCity.fetchedAt, cityResult.fetchedAt);
  mode = "city-partial";
  const partialCity = await (await cityApi(8879)).json();
  assert.equal(partialCity.total, 2001); assert.equal(partialCity.truncated, true); assert.equal(partialCity.elements.length, 2000);
  mode = "city-duplicate";
  assert.equal((await cityApi(8880)).status, 502, "重复来源不能冒充完整行政区结果");
} finally {globalThis.fetch = originalFetch; globalThis.caches = originalCaches; Date.now = originalNow;}
const browserSource = await readFile(new URL("../site/brand-browser.js", import.meta.url), "utf8");
function brandPage({ready, visible = true, panel = ""}) {
  class Element extends EventTarget {
    value = ""; textContent = ""; children = []; hidden = false; disabled = false;
    classList = {contains: () => false};
    replaceChildren(...children) {this.children = children;}
    append(...children) {this.children.push(...children);}
    add(option) {this.children.push(option);}
    scrollIntoView() {}
  }
  const nodes = new Map(), requests = [], intervals = new Set();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  el("brand-kind").value = "brand"; el("brand-sort").value = "count"; el("brand-scope").value = "world";
  el("brand-category").disabled = true;
  const window = Object.assign(new EventTarget(), {HuayuBrandData: data, location: {search: panel ? `?panel=${panel}` : ""}});
  const document = Object.assign(new EventTarget(), {getElementById: el, createElement: () => new Element(), hidden: false});
  let view = visible ? "brands" : "place", mapListeners = 0;
  const mapEvents = {}, cityRequests = [];
  const atlas = {
    getBrandMarkerLayer: () => ({clearLayers() {}, addTo() {}}),
    map: {on(event, callback) {mapListeners++; mapEvents[event] = callback;}, hasLayer: () => false,
      getBounds: () => ({getSouth: () => 14, getNorth: () => 15, getWest: () => 152, getEast: () => 153}),
      getCenter: () => ({lat: 14.6, lng: 152.9}), distance: () => 0},
    findAdministrativeCities: query => new Promise((resolve, reject) => cityRequests.push({query, resolve, reject})),
    getCurrentView: () => view,
    openView(next) {view = next; window.HuayuBrandBrowser?.setActive(next === "brands");},
  };
  if (ready) window.HuayuAtlas = atlas;
  const context = vm.createContext({window, document, URLSearchParams, AbortSignal,
    Option: function(label, value) {this.textContent = label; this.value = value;},
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
    setInterval(fn) {intervals.add(fn); return fn;}, clearInterval: id => intervals.delete(id), clearTimeout, setTimeout,
  });
  vm.runInContext(browserSource, context);
  return {window, document, atlas, el, requests, intervals, context, mapEvents, cityRequests, get mapListeners() {return mapListeners;},
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
const cityPage = brandPage({ready: true});
cityPage.requests.shift().resolve(Response.json(candidate)); await settle();
cityPage.el("brand-query").value = "津川";
cityPage.el("brand-query").dispatchEvent(new Event("input"));
assert.match(cityPage.el("brand-catalog-status").textContent, /文字匹配.*不是城市范围统计/u);
const boundary = (id, name = "津川市") => ({osm_type: "relation", osm_id: id, name, display_name: `${name}, 华域`, extratags: {admin_level: "5"}});
const submitCity = name => {cityPage.el("brand-city-query").value = name; cityPage.el("brand-city-form").dispatchEvent(new Event("submit"));};
submitCity("津川");
assert.equal(cityPage.cityRequests[0].query, "津川");
cityPage.cityRequests.shift().resolve([boundary(8877), boundary(9900, "津川区")]); await settle();
assert.equal(cityPage.el("brand-city-results").children.length, 2, "同名行政区保留独立选择，不暗中选择一个");
cityPage.el("brand-city-results").children[0].dispatchEvent(new Event("click"));
const cityRequest = cityPage.requests.shift(), cityParams = new URL(cityRequest.url, "https://map.test").searchParams;
assert.equal(cityParams.get("scope"), "city"); assert.equal(cityParams.get("relation"), "8877");
assert.equal(cityParams.has("south"), false, "城市发现不使用当前高倍率视野");
cityPage.mapEvents.moveend();
assert.equal(cityRequest.options.signal.aborted, false, "城市请求不被无关地图缩放取消");
const citySnapshot = {...snapshot, cityRelation: 8877, dbTimestamp: "2026-10-24T06:46:50Z"};
cityRequest.resolve(Response.json(citySnapshot)); await settle();
assert.equal(cityPage.el("brand-query").value, "", "城市名不残留为分店文字过滤，避免再次漏品牌");
assert.equal(cityPage.el("brand-catalog-list").children.filter(card => card.className === "brand-card").length, 2);
assert.match(cityPage.el("brand-catalog-status").textContent, /津川市行政边界内.*2 个不同品牌.*3 个地图要素/u);
cityPage.mapEvents.moveend();
assert.match(cityPage.el("brand-catalog-status").textContent, /津川市行政边界内/u);
assert.equal(cityPage.requests.length, 0, "地图移动保留城市统计，不重复查询");
cityPage.el("brand-catalog-list").children[0].dispatchEvent(new Event("click"));
const detailRequest = cityPage.requests.shift(), detailParams = new URL(detailRequest.url, "https://map.test").searchParams;
assert.equal(detailParams.get("scope"), "city"); assert.equal(detailParams.get("relation"), "8877");
detailRequest.resolve(Response.json({...citySnapshot, elements: [], total: 0})); await settle();
assert.match(cityPage.el("brand-detail-status").textContent, /津川市行政边界内查询/u);
cityPage.el("brand-detail-close").dispatchEvent(new Event("click"));
cityPage.el("brand-kind").value = "operator"; cityPage.el("brand-kind").dispatchEvent(new Event("change"));
const operatorRequest = cityPage.requests.shift(), operatorParams = new URL(operatorRequest.url, "https://map.test").searchParams;
assert.equal(operatorParams.get("kind"), "operator"); assert.equal(operatorParams.get("relation"), "8877");
operatorRequest.resolve(Response.json({...citySnapshot, elements: raw.filter(element => element.tags.operator), total: 2})); await settle();
assert.match(cityPage.el("brand-catalog-status").textContent, /1 个不同运营者/u);
cityPage.el("brand-live").checked = true;
vm.runInContext("Date.now = () => " + (Date.now() + 121000), cityPage.context);
for (const tick of cityPage.intervals) tick();
const refreshCity = cityPage.requests.shift();
assert.equal(new URL(refreshCity.url, "https://map.test").searchParams.get("relation"), "8877", "两分钟只更新当前城市和类型");
refreshCity.reject(Error("offline")); await settle();
assert.match(cityPage.el("brand-catalog-status").textContent, /失败.*保留旧结果/u);
assert.equal(cityPage.el("brand-catalog-list").children[0].children[0].textContent, "运营公司");
submitCity("旧城市"); const oldCitySearch = cityPage.cityRequests.shift();
submitCity("新城市"); const newCitySearch = cityPage.cityRequests.shift();
oldCitySearch.resolve([boundary(1234, "旧城市")]); await settle();
assert.equal(cityPage.requests.length, 0, "迟到的行政区搜索不能开始旧城市统计");
newCitySearch.resolve([boundary(8890, "新城市")]); await settle();
const lateCityRequest = cityPage.requests.shift();
cityPage.atlas.openView("place");
assert.equal(lateCityRequest.options.signal.aborted, true, "退出品牌页取消城市统计");
lateCityRequest.resolve(Response.json({...citySnapshot, cityRelation: 8890})); await settle();
assert.ok(!cityPage.el("brand-catalog-status").textContent.includes("新城市行政边界内："));
cityPage.atlas.openView("brands"); await settle();
submitCity("大城市"); cityPage.cityRequests.shift().resolve([boundary(8891, "大城市")]); await settle();
cityPage.requests.shift().resolve(Response.json({...citySnapshot, cityRelation: 8891, total: 2001, truncated: true})); await settle();
assert.match(cityPage.el("brand-catalog-status").textContent, /部分中至少.*不是完整总数/u);
cityPage.el("brand-reset").dispatchEvent(new Event("click"));
assert.match(cityPage.el("brand-catalog-status").textContent, /全域目录文字匹配/u);
assert.equal(cityPage.el("brand-city-scope").disabled, true);
console.log("Brand catalog, literal queries, live cache age, failure retention, cancellation, delayed startup, category filtering and administrative city counts passed.");
