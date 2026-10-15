import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDataset } from "./update-all-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builders = path.join(root, "scripts/data-update/builders");
const route = (id, type, name) => [id, type, "#1769e0", `${type}:${id}`, name];
const train = route(101, "train", "铁路甲线");
const display = route("display:1", "train", "已确认换乘线");
const otherDisplay = route("display:2", "train", "另一条显示线");
const metro = route(202, "subway", "地铁乙线");
const baselineRoutes = [otherDisplay, metro, train, route(303, "train", "铁路丙线"), display];
const stop = (id, name, routes, displayRoutes) => [id, 10, 150, 10, 150, name,
  1, 0, routes, 1, id, displayRoutes, 1, 1];
const baselineStop = stop(1, "回归测试站", [2], [0, 4]);
const snapshots = (network) => [
  {id: "huaxia", label: "华夏共和国", network},
  {id: "kadah", label: "Kadah", network: {format: 2, routeTable: [train],
    lines: [[2, [[10, 150], [10, 150.001]], [0]]], stops: [stop(2, "站乙", [0], null)]}},
  {id: "longchuan-ar925", label: "Loongchuan", network: {format: 2, routeTable: [train],
    lines: [[3, [[10, 150], [10, 150.001]], [0]]], stops: [stop(3, "站丙", [0], null)]}},
];
const packet = (network) => ({generatedAt: "2026-10-14T00:00:00Z", snapshots: snapshots(network)});
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-route-indexes-"));
const staged = path.join(directory, "outputs/ogf-atlas");
const baselineDirectory = path.join(directory, "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19");
await fs.mkdir(staged, {recursive: true});
await fs.mkdir(baselineDirectory, {recursive: true});
const write = (filename, value) => fs.writeFile(filename, JSON.stringify(value));
const railway = {format: 1, ways: [[10, [1, 2], [[10, 149.999], [10, 150.001]], "铁路甲线"]]};
await write(path.join(baselineDirectory, "transit-preload.json"), packet({format: 2,
  routeTable: baselineRoutes, lines: [[10, [[10, 149.999], [10, 150.001]], [2]]], stops: [baselineStop]}));
await write(path.join(baselineDirectory, "railway-routing.json"), railway);
await write(path.join(staged, "railway-routing.json"), railway);
await write(path.join(staged, "transit-relations.json"), {snapshots: [{id: "huaxia", elements: [
  {type: "node", id: 1, lat: 10, lon: 150, tags: {name: "回归测试站", train: "yes", railway: "station"}},
]}]});

for (const [script, existing] of [
  ["restore-v215-railway-stations.cjs", false],
  ["repair-explicit-mainline-interchanges.cjs", true],
]) {
  const currentStop = stop(1, "回归测试站", [0], [0]);
  currentStop[9] = 0;
  const original = packet({format: 2, routeTable: [metro],
    lines: [[11, [[10, 149.999], [10, 150.001]], [0]]], stops: existing ? [currentStop] : []});
  await write(path.join(staged, "transit-preload.json"), original);
  execFileSync(process.execPath, [path.join(builders, script), "--write"], {cwd: directory, stdio: "pipe"});
  const result = JSON.parse(await fs.readFile(path.join(staged, "transit-preload.json"), "utf8"));
  const network = result.snapshots[0].network;
  const restored = network.stops.find(item => item[0] === 1);
  assert.ok(restored, `${script}: station survives restoration`);
  assert.ok(restored[8].some(index => network.routeTable[index]?.[0] === train[0]),
    `${script}: routing memberships still resolve to the original train`);
  assert.deepEqual(new Set(restored[11].map(index => network.routeTable[index]?.[0])),
    new Set(existing ? [metro[0], otherDisplay[0], display[0]] : [otherDisplay[0], display[0]]),
    `${script}: display memberships must be remapped by route identity, including valid but reordered indexes`);
  assert.deepEqual(network.lines, original.snapshots[0].network.lines, `${script}: current line geometry is unchanged`);
  assert.deepEqual(result.snapshots.slice(1), original.snapshots.slice(1), `${script}: other systems remain unchanged`);
  assert.doesNotThrow(() => validateDataset("transit-preload.json", result));
}

const invalid = packet({format: 2, routeTable: [metro],
  lines: [[11, [[10, 150], [10, 150.001]], [0]]], stops: [stop(1, "水汀", [0], [4])]});
assert.throws(() => validateDataset("transit-preload.json", invalid), /显示.*索引|线路索引/u,
  "candidate validation must reject broken display indexes before starting terrain work");
console.log(JSON.stringify({status: "passed", builders: 2, checks: ["display identity", "routing retained",
  "current display retained", "other snapshots retained", "early validation"]}));
