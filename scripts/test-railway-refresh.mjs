import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import railwayRefresh from "./data-update/builders/refresh-railway-ways.cjs";

const {refreshRailwayWays, validateResponse, assertBaselineRetention} = railwayRefresh;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ogf-railway-refresh-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const way = (id, tags = {railway: "rail"}) => ({type: "way", id, tags, nodes: [id * 2, id * 2 + 1],
  geometry: [{lat: 12, lon: 142}, {lat: 12.001, lon: 142.001}]});
const response = ways => ({osm3s: {timestamp_osm_base: "2026-10-30T02:31:40Z"}, elements: [...ways,
  {type: "count", tags: {ways: String(ways.length), total: String(ways.length)}}]});
const incomplete = {...way(4), geometry: []};
const oneNode = {...way(5), nodes: [10], geometry: [{lat: 12, lon: 142}]};
const payload = response([way(1, {railway: "rail", service: "siding"}), way(3, {highway: "service"}), incomplete, oneNode]);
const official = w => ({elements: [{...w, geometry: undefined}, ...w.nodes.map((id, index) =>
  ({type: "node", id, ...w.geometry[index]}))]});
const refreshed = await refreshRailwayWays([1, 2, 3, 4, 5], {cachePrefix: path.join(directory, "fixture"),
  fetchImpl: async url => url.includes("overpass") ? {ok: true, json: async () => payload}
    : url.includes("/2/") ? {ok: false, status: 410}
    : {ok: true, status: 200, json: async () => url.includes("/3/")
      ? official(way(3, {highway: "service"})) : official(way(4))}});
assert.deepEqual(refreshed.ways.map(w => w.id), [1, 4], "preserve current sidings and repair missing geometry using current primary nodes");
assert.deepEqual(refreshed.verification.removed, [{id: 2, reason: "deleted"},
  {id: 3, reason: "no-longer-railway"}, {id: 5, reason: "non-drawable"}]);
assert.doesNotThrow(() => assertBaselineRetention(new Set([1, 2, 3, 4, 5]), new Set([1, 4]), refreshed.verification));
assert.throws(() => assertBaselineRetention(new Set([1, 2]), new Set([1]), {}), /without complete/);
assert.throws(() => assertBaselineRetention(new Set([1, 2]), new Set([1, 2]), refreshed.verification), /reintroduced/);
for (const bad of [{...payload, remark: "timeout"}, {...payload, elements: []},
  response([way(1), way(1)]), response([way(999)]), response([incomplete])]) {
  assert.throws(() => validateResponse(bad, [1, 2, 3, 4, 5]));
}
await assert.rejects(refreshRailwayWays([20], {cachePrefix: path.join(directory, "failed"),
  fetchImpl: async () => ({ok: false, status: 503})}), /503/);
await assert.rejects(refreshRailwayWays([21], {cachePrefix: path.join(directory, "partial"),
  fetchImpl: async url => url.includes("overpass") ? {ok: true, json: async () => response([])}
    : {ok: true, status: 200, json: async () => ({elements: []})}}), /Incomplete official/);

// Run the actual builder and baseline-restoration gate. A baseline-only siding
// takes its current nodes; a confirmed deletion stays absent on the next build.
const run = path.join(directory, "builder");
for (const folder of ["work", "outputs/ogf-atlas", "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19"]) {
  fs.mkdirSync(path.join(run, folder), {recursive: true});
}
for (const name of ["build-railway-routing.cjs", "refresh-railway-ways.cjs", "restore-v215-railway-stations.cjs", "remap-compact-route-indexes.cjs"]) {
  fs.copyFileSync(path.join(root, "scripts/data-update/builders", name), path.join(run, "work", name));
}
const write = (name, data) => fs.writeFileSync(path.join(run, name), JSON.stringify(data));
const currentWays = Array.from({length: 8000}, (_, i) => way(i + 1));
const compact = w => [w.id, w.nodes, w.geometry.map(p => [p.lat, p.lon]), "old name", "", 0];
write("work/huaxia-full-railways-raw.json", {elements: currentWays});
write("work/railway-routing-ids-current.json", {elements: currentWays.map(({id}) => ({id}))});
write("outputs/ogf-atlas/transit-relations.json", {snapshots: [{id: "huaxia", elements: []}]});
write("work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/railway-routing.json",
  {ways: [...currentWays, way(8001), way(8002)].map(compact)});
const preload = {snapshots: [{id: "huaxia", network: {format: 2, stops: [], routeTable: []}},
  {id: "kadah"}, {id: "longchuan-ar925", label: "Loongchuan"}]};
write("outputs/ogf-atlas/transit-preload.json", preload);
write("work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/transit-preload.json", preload);
write("mock-response.json", response([way(8002, {railway: "rail", service: "siding", name: "current siding"})]));
fs.writeFileSync(path.join(run, "mock-fetch.cjs"), `const fs=require('node:fs');
global.fetch=async url=>url.includes('overpass')?{ok:true,json:async()=>JSON.parse(fs.readFileSync('mock-response.json'))}:{ok:false,status:410};`);
const execute = script => spawnSync(process.execPath, ["--require", "./mock-fetch.cjs", `work/${script}`],
  {cwd: run, encoding: "utf8", windowsHide: true});
for (let iteration = 0; iteration < 2; iteration++) {
  for (const script of ["build-railway-routing.cjs", "restore-v215-railway-stations.cjs"]) {
    const result = execute(script);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const built = JSON.parse(fs.readFileSync(path.join(run, "outputs/ogf-atlas/railway-routing.json")));
  assert.equal(built.ways.length, 8001);
  assert.ok(!built.ways.some(w => w[0] === 8001));
  assert.equal(built.ways.find(w => w[0] === 8002)[3], "current siding");
}
const priorOutput = fs.readFileSync(path.join(run, "outputs/ogf-atlas/railway-routing.json"), "utf8");
fs.writeFileSync(path.join(run, "mock-fetch.cjs"), "global.fetch=async()=>{throw Error('network unavailable')};");
// Use a different missing ID so the successful per-run cache cannot hide failure.
write("work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/railway-routing.json",
  {ways: [...currentWays, way(8999)].map(compact)});
assert.notEqual(execute("build-railway-routing.cjs").status, 0);
assert.equal(fs.readFileSync(path.join(run, "outputs/ogf-atlas/railway-routing.json"), "utf8"), priorOutput,
  "failed source verification cannot overwrite the previous complete candidate");

const app = fs.readFileSync(path.join(root, "site/app.js"), "utf8");
let requests = 0, invalidate = 0, renders = 0, fail = false, mismatch = false;
let generation = "2026-10-30T03:00:00Z";
const oldRouting = {format: 1, generatedAt: "old", ways: [compact(way(2))]};
const oldSupplement = {format: 1, ways: [], links: []};
const context = vm.createContext({railwayRoutingData: oldRouting, railwayConnectionsData: oldSupplement,
  railwayRoutingPromise: null, railwayRoutingLoadFailed: false, railwayRoutingPreloadGeneration: 1,
  transitPreloadGeneratedAt: 1, railInfrastructureGraphCache: {}, transitAtlasRailGraphCache: {},
  railwayRoutingWayBoundsCache: new Map([[2, {}]]), RAILWAY_ROUTING_URL: "routing", RAILWAY_CONNECTIONS_URL: "supplement",
  mapViewMode: "transit", transitAtlasCity: null, validInferredRailLink: () => true,
  invalidateTransitRoutingCaches: () => {invalidate++;}, scheduleTransitNetworkRender: () => {renders++;},
  fetchJson: async (url, _timeout, options) => {
    requests++; assert.equal(options.cache, "no-cache");
    if (fail && url === "supplement") throw Error("network failure");
    return url === "routing" ? {format: 1, generatedAt: generation, ways: [compact(way(1))],
      coverage: {complete: true, baselineVerification: {removed: [{id: 2, reason: "deleted"}]}}}
      : {format: 1, generatedAt: generation, routingGeneratedAt: mismatch ? "mixed" : generation, ways: [], links: []};
  }});
for (const name of ["prepareRailwayPackages", "ensureRailwayRoutingLoaded"]) {
  vm.runInContext(app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))[0], context);
}
await Promise.all([context.ensureRailwayRoutingLoaded({revalidate: true, preloadGeneration: 2}),
  context.ensureRailwayRoutingLoaded({revalidate: true, preloadGeneration: 2})]);
assert.equal(requests, 2, "concurrent checks share one pair of package requests");
assert.deepEqual(Array.from(context.railwayRoutingData.ways, w => w[0]), [1]);
assert.equal(context.railwayRoutingWayBoundsCache.size, 0);
assert.equal(invalidate, 1); assert.equal(renders, 1);
await context.ensureRailwayRoutingLoaded();
await context.ensureRailwayRoutingLoaded({revalidate: true, preloadGeneration: 2});
assert.equal(requests, 2, "same generation and ordinary map movement reuse parsed topology");
const completeRouting = context.railwayRoutingData, completeSupplement = context.railwayConnectionsData;
for (const errorMode of ["network", "mixed"]) {
  fail = errorMode === "network"; mismatch = errorMode === "mixed";
  assert.equal(await context.ensureRailwayRoutingLoaded({revalidate: true, preloadGeneration: 3}), false);
  assert.equal(context.railwayRoutingData, completeRouting);
  assert.equal(context.railwayConnectionsData, completeSupplement);
  assert.equal(invalidate, 1, "failed refresh keeps both data and graph caches intact");
}
fail = mismatch = false; generation = "2026-10-30T06:00:00Z";
assert.equal(await context.ensureRailwayRoutingLoaded({revalidate: true, preloadGeneration: 3}), true,
  "a failed generation can be retried without restarting the page");
assert.throws(() => context.prepareRailwayPackages({format: 1, generatedAt: generation, ways: [compact(way(1))],
  coverage: {baselineVerification: {removed: [{id: 2}]}}}, {format: 1, ways: [compact(way(2))], links: []}), /REINTRODUCED/);
assert.match(app, /ensureRailwayRoutingLoaded\(\{revalidate: true, preloadGeneration: generatedAt\}\)/u,
  "the existing five-minute preload check must trigger topology revalidation");
console.log(JSON.stringify({status: "passed", currentSourceDeletion: true, preservedSidings: true,
  incompleteResponseKeepsSnapshot: true, repeatedBuilder: true, atomicBrowserRefresh: true}));
