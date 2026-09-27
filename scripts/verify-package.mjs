import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const release = JSON.parse(await fs.readFile(path.join(root, "release.json"), "utf8"));

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

const manifestLines = (await fs.readFile(path.join(root, "release", "SHA256.txt"), "utf8"))
  .trim().split(/\r?\n/u).filter(Boolean);
const manifest = new Map(manifestLines.map((line) => {
  const match = line.match(/^([0-9A-F]{64})  (.+)$/u);
  assert.ok(match, `无效的 SHA-256 清单行：${line}`);
  return [match[2], match[1]];
}));

const files = await listFiles(site);
assert.equal(files.length, manifest.size, "生产文件数量与 SHA-256 清单不一致");
for (const file of files) {
  const relative = path.relative(site, file).split(path.sep).join("/");
  const actual = createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();
  assert.equal(actual, manifest.get(relative), `文件校验失败：${relative}`);
}

for (const required of ["_headers", "_worker.js", "app.js", "index.html", "huayu-style.json",
  "transit-preload.json", "transit-relations.json", "station-access.json", "railway-routing.json"]) {
  assert.ok(manifest.has(required), `缺少生产文件：${required}`);
}

const index = await fs.readFile(path.join(site, "index.html"), "utf8");
const app = await fs.readFile(path.join(site, "app.js"), "utf8");
const worker = await fs.readFile(path.join(site, "_worker.js"), "utf8");
assert.ok(index.includes(release.entryScript), "index.html 未引用 release.json 指定的应用版本");
assert.ok(app.includes(`\"huayu:model-version\": \"${release.expectedBuildingModel}\"`), "建筑模型版本不一致");
assert.ok(app.includes(`HUAYU_LIVE_BUILDING_MIN_ZOOM = ${release.expectedBuildingMinZoom}`), "建筑起始缩放级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedBuildingTileZooms.join(", ")}])`), "Worker 建筑分片级别不一致");
assert.ok(app.includes(`HUAYU_LIVE_BASEMAP_MIN_ZOOM = ${release.expectedLiveBasemapMinZoom}`),
  "实时底图起始缩放级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedLiveBasemapTileZooms.join(", ")}])`),
  "Worker 实时底图分片级别不一致");
assert.ok(worker.includes("live-basemap") && worker.includes("fetchLiveBasemapTile"),
  "Worker 缺少实时底图接口");

for (const script of ["app.js", "_worker.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(site, script)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${script} 语法检查失败：${result.stderr}`);
}

const workerTest = spawnSync(process.execPath, [path.join(root, "scripts", "test-worker.mjs")], {
  encoding: "utf8",
});
assert.equal(workerTest.status, 0, `Worker 接口测试失败：${workerTest.stderr || workerTest.stdout}`);

console.log(JSON.stringify({
  status: "passed",
  release: release.releaseVersion,
  productionFiles: files.length,
  manifestEntries: manifest.size,
}, null, 2));
