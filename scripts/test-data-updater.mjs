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
