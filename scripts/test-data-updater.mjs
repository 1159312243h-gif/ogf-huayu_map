import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareCounts, semanticHash, validateDataset } from "./update-all-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = [
  "transit-preload.json",
  "transit-relations.json",
  "railway-routing.json",
  "railway-connections.json",
  "station-access.json",
  "airports.json",
];

const counts = {};
for (const name of names) {
  const payload = JSON.parse(await fs.readFile(path.join(root, "site", name), "utf8"));
  counts[name] = validateDataset(name, payload);
}

assert.equal(
  semanticHash({ generatedAt: "2026-01-01T00:00:00Z", value: [1, 2, 3] }),
  semanticHash({ generatedAt: "2027-01-01T00:00:00Z", value: [1, 2, 3] }),
  "语义哈希不应把 generatedAt 当成数据变化",
);
assert.notEqual(semanticHash({ value: 1 }), semanticHash({ value: 2 }), "语义哈希必须识别内容变化");
assert.doesNotThrow(() => compareCounts({ ways: 90 }, { ways: 100 }, 0.75, "fixture"));
assert.throws(() => compareCounts({ ways: 70 }, { ways: 100 }, 0.75, "fixture"), /安全阈值/u);

const builderDirectory = path.join(root, "scripts", "data-update", "builders");
const builderFiles = (await fs.readdir(builderDirectory)).filter((name) => name.endsWith(".cjs"));
const forbidden = /(C:[\\/]Users|playwright|msedge\.exe|\.cache[\\/]codex|openai|large language model)/iu;
for (const name of builderFiles) {
  const source = await fs.readFile(path.join(builderDirectory, name), "utf8");
  assert.doesNotMatch(source, forbidden, `${name} 仍包含设备、Codex、浏览器或大模型依赖`);
}

const updater = await fs.readFile(path.join(root, "scripts", "update-all-data.mjs"), "utf8");
assert.doesNotMatch(updater, /wrangler|pages deploy|cloudflare.*deploy/iu, "统一更新器不得自动部署");
assert.match(updater, /replaceDatasetsAtomically/u, "统一更新器必须保留原子替换流程");
assert.match(updater, /backupDirectory/u, "统一更新器必须创建备份");
assert.ok(updater.indexOf('step("compact-transit-preload.cjs", "--write")')
  < updater.indexOf('step("enforce-transit-service-rules.cjs")'),
"人工换乘规则必须在交通预载包紧凑化后重新应用");
assert.match(updater, /preservedFiles: \["transit-services\.json"\]/u,
  "统一更新器必须保留人工交通服务规则文件");
const transitServices = JSON.parse(await fs.readFile(path.join(root, "site", "transit-services.json"), "utf8"));
assert.ok(transitServices.stationInterchangeOverrides?.some((rule) => rule.id === "beihu-southeast-corner-three-line")
  && transitServices.stationInterchangeOverrides?.some((rule) => rule.id === "beihu-yujiaqiao-interchange"),
"人工换乘规则文件必须包含东南角和郁家桥设定");
const beihuInterchangeMatrix = [
  ["beihu-north-station-three-line", "北沪车站", ["R", "I", "M"]],
  ["beihu-erchong-interchange", "二重", ["M", "CY"]],
  ["beihu-yujiaqiao-interchange", "郁家桥", ["CY"]],
  ["beihu-zhongshan-xinde-interchange", "中山信德", ["BL"]],
  ["beihu-southeast-corner-three-line", "东南角", ["R", "I", "P"]],
  ["beihu-aiguo-road-interchange", "爱国路", ["R", "P"]],
  ["beihu-ximending-interchange", "西门町", ["P", "BL"]],
];
for (const [id, stationName, routeRefs] of beihuInterchangeMatrix) {
  const rule = transitServices.stationInterchangeOverrides?.find((item) => item.id === id);
  assert.deepEqual(rule?.stationNames, [stationName], `北沪换乘站名规则丢失：${stationName}`);
  assert.deepEqual(rule?.routeRefs, routeRefs, `北沪换乘线路顺序变化：${stationName}`);
  assert.equal(rule?.symbolMode, "single-ring", `北沪换乘站必须使用单环符号：${stationName}`);
}
const southeastCornerRule = transitServices.stationInterchangeOverrides
  ?.find((rule) => rule.id === "beihu-southeast-corner-three-line");
assert.equal(southeastCornerRule?.stationCount ?? 1, 1,
  "东南角必须使用单个三线换乘符号，不得拆成三个站圈");
assert.equal(southeastCornerRule?.mergeNearbyUnnamedWithinMeters, 80,
  "东南角必须在数据更新后继续合并同组无名 P 线站体的显示标记");
const yujiaqiaoRule = transitServices.stationInterchangeOverrides
  ?.find((rule) => rule.id === "beihu-yujiaqiao-interchange");
assert.equal(yujiaqiaoRule?.mergeNearbyUnnamedWithinMeters, 30,
  "郁家桥必须在数据更新后继续合并共享线路的近邻无名站标记");
assert.deepEqual(yujiaqiaoRule?.routeNames, ["捷运纵贯线"],
  "郁家桥必须在数据更新后保留纵贯线换乘信息");
assert.ok(!transitServices.stationTransferAliases?.some((rule) => rule.id === "beihu-yujiaqiao-station-complex")
  && !transitServices.stationDisplayMergeOverrides?.some((rule) => rule.id === "beihu-yujiaqiao-station-complex"),
"数据更新后必须继续把郁家桥与望铁郁家桥保留为独立站点");

const railwayBuilder = await fs.readFile(path.join(builderDirectory, "build-railway-routing.cjs"), "utf8");
assert.match(railwayBuilder, /for \(const snapshot of relationSnapshots\)/u,
  "铁路路由必须复用本轮交通抓取中的实时车站数据");
const connectionBuilder = await fs.readFile(path.join(builderDirectory, "build-rail-connections.cjs"), "utf8");
assert.match(connectionBuilder, /railway-connections-baseline-refresh/u,
  "铁路连接生成器必须实时复核现存的基线补充几何");

console.log(JSON.stringify({
  status: "passed",
  datasets: counts,
  builders: builderFiles.length,
  dependencyPolicy: "Node.js built-ins only",
}, null, 2));
