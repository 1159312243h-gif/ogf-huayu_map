import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDatasetFile } from "./update-all-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maximumAgeDays = Math.max(1, Number(process.env.DATA_MAX_AGE_DAYS || 14));
const maximumAgeMs = maximumAgeDays * 24 * 60 * 60 * 1000;
const now = Date.now();
const definitions = [
  { file: "transit-preload.json", kind: "public-transit-overview" },
  { file: "transit-relations.json", kind: "public-transit-relations" },
  { file: "railway-routing.json", kind: "national-railway-routing" },
  { file: "railway-connections.json", kind: "national-railway-connections" },
  { file: "station-access.json", kind: "station-access" },
  { file: "airports.json", kind: "airports" },
  { file: "terrain-preload.json.gz", kind: "terrain-overview" },
];

const results = [];
for (const definition of definitions) {
  const filePath = path.join(root, "site", definition.file);
  const payload = await readDatasetFile(filePath);
  const generatedAt = String(payload.generatedAt || "");
  const timestamp = Date.parse(generatedAt);
  assert.ok(Number.isFinite(timestamp), `${definition.file} 缺少有效 generatedAt`);
  const ageMs = Math.max(0, now - timestamp);
  results.push({
    ...definition,
    generatedAt,
    ageDays: Number((ageMs / (24 * 60 * 60 * 1000)).toFixed(2)),
    status: ageMs <= maximumAgeMs ? "fresh" : "stale",
  });
}

const report = {
  checkedAt: new Date(now).toISOString(),
  maximumAgeDays,
  status: results.every((item) => item.status === "fresh") ? "passed" : "stale",
  datasets: results,
};
await fs.writeFile(path.join(root, "data-freshness-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, "passed", `发现超过 ${maximumAgeDays} 天未生成的数据快照`);
