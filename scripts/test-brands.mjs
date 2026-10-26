import assert from "node:assert/strict";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import "../site/brand-data.js";
import worker, {brandDataQuery, brandNamedFacilityQuery, brandNameQueryPattern} from "../site/_worker.js";
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
const nameFixtures = [node(8001, {brand: "华夏银行", amenity: "bank", "brand:en": "Huaxia Bank"}),
  node(8002, {name: "华夏银行（北城支行）", amenity: "bank"}),
  node(8003, {"name:en": "Huaxia Bank", amenity: "atm"}),
  node(8004, {name: "华夏银行津川分行", amenity: "bank"}),
  node(8005, {brand: "其他银行", name: "华夏银行", amenity: "bank"}),
  node(8006, {name: "华夏银行", highway: "bus_stop", public_transport: "platform"}),
  node(8007, {name: "华夏银行", tourism: "attraction"}),
  node(8008, {name: "华夏银行", shop: "clothes"}),
  node(8009, {name: "未知咖啡", amenity: "cafe"}), node(8010, {name: "未知咖啡", amenity: "cafe"}),
  node(8011, {name: "未知咖啡北城店", amenity: "cafe"}),
  node(8012, {name: "便利店", shop: "vacant"}), node(8013, {name: "全家火锅", amenity: "restaurant"}),
  node(8014, {brand: "全家", shop: "convenience"}), node(8015, {name: "全家", shop: "convenience"})];
const originalNames = JSON.stringify(nameFixtures);
const recognizedNames = data.recognizeBrands([...nameFixtures, nameFixtures[1]]);
const enriched = data.aggregate(recognizedNames, "brand"), bank = enriched.find(entry => entry.name === "华夏银行");
assert.equal(bank.count, 4); assert.equal(bank.taggedCount, 1); assert.equal(bank.namedCount, 3);
assert.equal(recognizedNames.find(e => e.id === 8005).brandMatch.name, "其他银行", "显式 brand 优先，不按店名改写归属");
for (const id of [8006, 8007, 8008, 8012]) assert.ok(!recognizedNames.some(e => e.id === id), "站名、景点、分类冲突和空置商铺不能误认品牌");
assert.equal(enriched.find(entry => entry.name === "未知咖啡").candidateCount, 2, "无品牌字典依据的同名店可计数，但明确标为候选");
assert.equal(enriched.find(entry => entry.name === "未知咖啡北城店").candidate, true, "未知品牌不凭后缀擅自归并");
assert.equal(enriched.find(entry => entry.name === "全家").count, 2);
assert.equal(enriched.find(entry => entry.name === "全家火锅").candidate, true, "同前缀不等于同品牌");
assert.equal(JSON.stringify(nameFixtures), originalNames, "识别不向原始标签补写 brand");
assert.equal(data.filterEntries(enriched, "tag").find(e => e.name === "华夏银行").count, 1);
assert.deepEqual(data.filterEntries(enriched, "name").find(e => e.name === "华夏银行").categories, [["amenity=bank", 2], ["amenity=atm", 1]]);
assert.ok(data.filterEntries(enriched, "candidate").every(entry => entry.candidate));
assert.ok(data.recognizeBrands(nameFixtures, [], false).every(element => element.tags.brand), "仅标签模式保留原始行为");
const ambiguous = data.recognizeBrands([node(8020, {name: "共同别名", shop: "convenience"})], [
  {name:"甲品牌", aliases:["共同别名"], categories:[["shop=convenience",1]]},
  {name:"乙品牌", aliases:["共同别名"], categories:[["shop=convenience",1]]}]);
assert.equal(ambiguous.length, 0, "别名冲突不强行归属或冒充新品牌");
assert.deepEqual(data.aggregate([node(8022,{brand:"银行",amenity:"bank","brand:ref":"编号123","brand:en":"Bank"})],"brand")[0].aliases,["Bank"],"品牌编号不当作语言别名");
assert.equal(data.recognizeBrands([node(8021, {name: "ＡＣＭＥ", shop: "convenience"})], [
  {name:"Acme",categories:[["shop=convenience",1]]}])[0].brandMatch.name, "Acme", "名称识别归一化大小写和全角");
for (const type of ["node", "way", "rel", "nwr"]) for (const scope of ["", "(area.cityArea)", "(14,152,15,153)"]) {
  assert.equal(brandNamedFacilityQuery(type, scope), data.namedFacilityQuery(type, scope), "定时目录与实时范围使用同一商业设施范围");
  assert.equal(brandNamedFacilityQuery(type, scope, "^literal$"), data.namedFacilityQuery(type, scope, "^literal$"));
}
for (const name of ['A "B";.*', "[x](a)|.*+?^${}\\", "华夏银行"]) for (const exact of [true,false]) {
  assert.equal(brandNameQueryPattern([name], exact), data.nameQueryPattern([name], exact), "Worker 与名称识别查询字面量转义一致");
  const pattern = brandNameQueryPattern([name], exact).replace("[[:space:]", "[\\s");
  const regex = new RegExp(pattern, "i");
  assert.ok(regex.test(name)); assert.ok(!regex.test("prefix" + name));
  if (exact) assert.ok(!regex.test(name + "分店"));
}
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
const withNames = new URL(cityScope); withNames.searchParams.set("includeNames","1");
assert.ok(brandDataQuery(withNames).query.includes(data.namedFacilityQuery("nwr", "(area.cityArea)")));
const nameLocations = new URL(cityLocations); nameLocations.searchParams.set("includeNames","1");
assert.ok(brandDataQuery(nameLocations).query.includes(data.namedFacilityQuery("nwr", "(area.cityArea)", data.nameQueryPattern(['A "B";.*']))));
nameLocations.searchParams.set("aliases", '["有效别名"]'); assert.equal(brandDataQuery(nameLocations).includeNames, true);
for (const invalid of ["null", "{}", "[3]", JSON.stringify(Array(13).fill("x")), '["x\\n"]']) {
  nameLocations.searchParams.set("aliases", invalid); assert.throws(() => brandDataQuery(nameLocations));
}
assert.throws(() => completeElements({...payload(raw), remark: "timeout"}, "brand"));
assert.throws(() => completeElements({elements: [count(4), ...raw]}, "brand"));
assert.throws(() => completeElements(payload([raw[0], raw[0]]), "brand"));
const candidate = buildBrandCatalog(payload(raw), payload(raw.filter(e => e.tags.operator)), null);
assert.ok(catalogQuery("operator","node").includes('node["operator"]["shop"]'));
assert.ok(!catalogQuery("operator","node").includes('node["operator"]->'),"运营者整库不扫描未限定的电力与网络对象");
assert.ok(catalogQuery("brand","rel").includes('rel["brand"]'));
assert.equal(candidate.brands.length, 2);
const untaggedFacilities = nameFixtures.filter(e => !e.tags.brand && data.namedFacility(e.tags));
const nameCandidate = buildBrandCatalog(payload(nameFixtures.filter(e => e.tags.brand)), payload(raw.filter(e => e.tags.operator)), null,
  "2026-10-26T05:00:00Z", payload(untaggedFacilities));
assert.equal(nameCandidate.recognitionVersion, 1);
assert.equal(nameCandidate.brands.find(entry => entry.name === "华夏银行").count, 4);
assert.ok(nameCandidate.brands.some(entry => entry.candidate));
assert.ok(!nameCandidate.brands.some(entry => entry.name === "未知咖啡北城店"), "全域索引省略单独店名，城市发现仍可列出");
assert.ok(catalogQuery("name","node").includes(data.namedFacilityQuery("node")));
assert.equal(completeElements(payload([]), "name").length, 0);
assert.throws(() => completeElements({...payload(untaggedFacilities), remark:"timeout"}, "name"));
assert.throws(() => completeElements(payload([node(999, {name:"银行站", highway:"bus_stop"})]), "name"));
assert.throws(() => data.validateCatalog({...nameCandidate, brands:[{...nameCandidate.brands[0], namedCount:-1}]}));
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
  assert.throws(() => buildBrandCatalog(payload(raw), payload(raw.filter(e => e.tags.operator)), null,
    undefined, {...payload(untaggedFacilities), remark:"timeout"}));
  assert.equal(await readFile(file, "utf8"), before, "店名抓取失败不以标签半包覆盖旧目录");
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
  if (mode === "city-names") return Response.json({...payload(nameFixtures), elements:[count(1),...payload(nameFixtures).elements]});
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
  mode = "city-names";
  const namedCity = await (await worker.fetch(new Request("https://map.test/api/brands?kind=brand&mode=discover&scope=city&relation=8881&includeNames=1"),{},{})).json();
  assert.equal(namedCity.includeNames,true); assert.equal(namedCity.total,nameFixtures.length);
  assert.equal(namedCity.elements.find(e=>e.id===8002).tags.brand,undefined, "Worker 保留未标品牌的原始要素，而非伪造 brand");
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
const namePage=brandPage({ready:true});
namePage.el("brand-recognition").value="all";
namePage.requests.shift().resolve(Response.json(nameCandidate)); await settle();
namePage.el("brand-city-query").value="津川"; namePage.el("brand-city-form").dispatchEvent(new Event("submit"));
namePage.cityRequests.shift().resolve([boundary(8801)]);await settle();
const discoverNames=namePage.requests.shift();assert.equal(new URL(discoverNames.url,"https://map.test").searchParams.get("includeNames"),"1");
// Coordinates omitted in this DOM harness; real location actions are browser-tested separately.
const nameSnapshot={...snapshot,fetchedAt:new Date().toISOString(),cityRelation:8801,includeNames:true,total:nameFixtures.length,
  elements:nameFixtures.map(({lat,lon,...element})=>element)};
discoverNames.resolve(Response.json(nameSnapshot));await settle();
assert.match(namePage.el("brand-catalog-status").textContent,/名称识别 4/);
assert.ok(namePage.el("brand-catalog-list").children.some(card=>card.children[0]?.textContent==="未知咖啡北城店"),"城市包含仅出现一次的店名候选");
namePage.el("brand-recognition").value="candidate";namePage.el("brand-recognition").dispatchEvent(new Event("change"));await settle();
assert.equal(namePage.requests.length,0,"同一两分钟结果切换来源筛选可复用，不能重复请求");
assert.match(namePage.el("brand-catalog-status").textContent,/0 个不同品牌/);
assert.ok(namePage.el("brand-catalog-list").children.every(card=>card.children[1].textContent.includes("店名候选")));
namePage.el("brand-catalog-list").children[0].dispatchEvent(new Event("click"));
const candidateLocation=namePage.requests.shift(),candidateParams=new URL(candidateLocation.url,"https://map.test").searchParams;
assert.equal(candidateParams.get("candidate"),"1");assert.equal(candidateParams.get("scope"),"city");
const candidateName=candidateParams.get("name");
candidateLocation.resolve(Response.json({...nameSnapshot,elements:nameSnapshot.elements.filter(e=>e.tags.name===candidateName)}));await settle();
assert.ok(namePage.el("brand-location-list").children.length>0);assert.match(namePage.el("brand-detail-summary").textContent,/尚未证明/);
assert.ok(namePage.el("brand-location-list").children[0].children.some(child=>child.textContent.includes("待确认店名")));
namePage.el("brand-detail-close").dispatchEvent(new Event("click"));
namePage.el("brand-recognition").value="tag";namePage.el("brand-recognition").dispatchEvent(new Event("change"));
const strictRequest=namePage.requests.shift();assert.equal(new URL(strictRequest.url,"https://map.test").searchParams.has("includeNames"),false);
strictRequest.resolve(Response.json({...nameSnapshot,includeNames:false,elements:nameSnapshot.elements.filter(e=>e.tags.brand)}));await settle();
assert.match(namePage.el("brand-catalog-status").textContent,/名称识别 0/);
assert.ok(!namePage.el("brand-catalog-list").children.some(card=>card.children[1].textContent.includes("店名候选")));
namePage.el("brand-recognition").value="name";namePage.el("brand-recognition").dispatchEvent(new Event("change"));await settle();
namePage.el("brand-catalog-list").children.find(card=>card.children[0].textContent==="华夏银行").dispatchEvent(new Event("click"));
namePage.requests.shift().resolve(Response.json(nameSnapshot));await settle();
assert.equal(namePage.el("brand-location-list").children.length,3,"仅名称识别筛选在详情同样生效，不混入显式标签地点");
assert.match(namePage.el("brand-detail-status").textContent,/标签 0、名称识别 3/);
console.log("Brand names, explicit-tag priority, aliases, category exclusions, candidate counts, source filters, literal queries, live cache age, failure retention, cancellation, complete directories, delayed startup and city scopes passed.");
