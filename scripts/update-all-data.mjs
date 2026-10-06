import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const stateRoot = path.join(root, ".data-update");
const builderSource = path.join(root, "scripts", "data-update", "builders");
const datasetNames = [
  "transit-preload.json",
  "transit-relations.json",
  "railway-routing.json",
  "railway-connections.json",
  "station-access.json",
  "airports.json",
];

function printHelp() {
  console.log(`华域地图统一数据更新

用法：
  npm run data:update          联网生成、校验、备份并替换全部静态数据
  npm run data:update:dry      联网生成和校验，但不替换 site/ 文件
  npm run data:update:resume   从最近一次失败的分块继续
  npm run data:update:check    不联网，只检查当前 site/ 数据
  node scripts/update-all-data.mjs --help

要求：Node.js 20 或更高版本。脚本不依赖浏览器、Codex 或任何大模型，
不会部署网站。建筑和近距底图由 Worker 按需读取 OGF，本命令只探测其
共同数据源，不生成永久瓦片。`);
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["generatedAt", "checkedAt", "updatedAt"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

export function semanticHash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function validDate(value, label) {
  const time = Date.parse(String(value || ""));
  assert.ok(Number.isFinite(time), `${label} 缺少有效 generatedAt`);
  assert.ok(time <= Date.now() + 24 * 60 * 60 * 1000, `${label} 的 generatedAt 位于未来`);
}

function uniqueCount(values) {
  return new Set(values.map(String)).size;
}

function validateTransitPreload(payload, label) {
  validDate(payload.generatedAt, label);
  assert.ok(Array.isArray(payload.snapshots) && payload.snapshots.length >= 3, `${label} 快照不足`);
  assert.equal(uniqueCount(payload.snapshots.map((item) => item.id)), payload.snapshots.length, `${label} 快照 ID 重复`);
  const counts = {};
  for (const snapshot of payload.snapshots) {
    const network = snapshot.network;
    assert.ok(network?.format === 2, `${label}/${snapshot.id} 不是紧凑网络格式 2`);
    assert.ok(Array.isArray(network.routeTable) && network.routeTable.length, `${label}/${snapshot.id} 没有线路`);
    assert.ok(Array.isArray(network.lines) && network.lines.length, `${label}/${snapshot.id} 没有线路几何`);
    assert.ok(Array.isArray(network.stops) && network.stops.length, `${label}/${snapshot.id} 没有站点`);
    assert.equal(uniqueCount(network.lines.map((line) => line[0])), network.lines.length,
      `${label}/${snapshot.id} 线路几何 ID 重复`);
    assert.equal(uniqueCount(network.stops.map((stop) => stop[0])), network.stops.length,
      `${label}/${snapshot.id} 站点 ID 重复`);
    for (const line of network.lines) {
      assert.ok(Array.isArray(line[1]) && line[1].length >= 2, `${label}/${snapshot.id} 存在空线路几何`);
      assert.ok((line[2] || []).every((index) => network.routeTable[index]),
        `${label}/${snapshot.id} 存在线路索引越界`);
    }
    for (const stop of network.stops) {
      assert.ok(Number.isFinite(stop[1]) && Number.isFinite(stop[2]), `${label}/${snapshot.id} 存在无效站点坐标`);
      assert.ok((stop[8] || []).every((index) => network.routeTable[index]),
        `${label}/${snapshot.id} 存在站点线路索引越界`);
    }
    counts[snapshot.id] = {
      routes: network.routeTable.length,
      lines: network.lines.length,
      stops: network.stops.length,
    };
  }
  return counts;
}

function validateTransitRelations(payload, label) {
  validDate(payload.generatedAt, label);
  assert.ok(Array.isArray(payload.snapshots) && payload.snapshots.length >= 3, `${label} 快照不足`);
  const counts = {};
  for (const snapshot of payload.snapshots) {
    assert.ok(Array.isArray(snapshot.elements) && snapshot.elements.length, `${label}/${snapshot.id} 没有要素`);
    const keys = snapshot.elements.map((item) => `${item.type}:${item.id}`);
    assert.equal(uniqueCount(keys), keys.length, `${label}/${snapshot.id} 存在重复 OGF 要素`);
    counts[snapshot.id] = { elements: snapshot.elements.length };
  }
  return counts;
}

function validateRailwayRouting(payload, label) {
  validDate(payload.generatedAt, label);
  assert.equal(payload.format, 1, `${label} 格式错误`);
  assert.ok(Array.isArray(payload.ways) && payload.ways.length >= 8000, `${label} 铁路段不足`);
  assert.ok(Array.isArray(payload.stations) && payload.stations.length, `${label} 没有车站`);
  assert.equal(uniqueCount(payload.ways.map((way) => way[0])), payload.ways.length, `${label} 铁路段 ID 重复`);
  for (const way of payload.ways) {
    assert.ok(Array.isArray(way[1]) && Array.isArray(way[2]) && way[1].length === way[2].length
      && way[2].length >= 2, `${label} 存在不完整铁路几何`);
  }
  assert.ok(payload.coverage?.complete !== false, `${label} 声明铁路覆盖不完整`);
  return { ways: payload.ways.length, stations: payload.stations.length };
}

function validateRailwayConnections(payload, label) {
  validDate(payload.generatedAt, label);
  assert.equal(payload.format, 1, `${label} 格式错误`);
  assert.ok(Array.isArray(payload.ways), `${label} 缺少补充铁路段`);
  assert.ok(Array.isArray(payload.links), `${label} 缺少推定连接数组`);
  return { ways: payload.ways.length, links: payload.links.length };
}

function validateStationAccess(payload, label) {
  validDate(payload.generatedAt, label);
  assert.equal(payload.format, 1, `${label} 格式错误`);
  assert.ok(Array.isArray(payload.elements) && payload.elements.length, `${label} 没有站口数据`);
  const keys = payload.elements.map((item) => `${item.type}:${item.id}`);
  assert.equal(uniqueCount(keys), keys.length, `${label} 存在重复要素`);
  return { elements: payload.elements.length };
}

function validateAirports(payload, label) {
  validDate(payload.generatedAt, label);
  assert.ok(Array.isArray(payload.airports) && payload.airports.length, `${label} 没有机场`);
  assert.equal(uniqueCount(payload.airports.map((item) => item.id)), payload.airports.length, `${label} 机场 ID 重复`);
  for (const airport of payload.airports) {
    assert.ok(airport.name && Number.isFinite(airport.lat) && Number.isFinite(airport.lon), `${label} 存在无效机场`);
  }
  return { airports: payload.airports.length };
}

const validators = {
  "transit-preload.json": validateTransitPreload,
  "transit-relations.json": validateTransitRelations,
  "railway-routing.json": validateRailwayRouting,
  "railway-connections.json": validateRailwayConnections,
  "station-access.json": validateStationAccess,
  "airports.json": validateAirports,
};

export function validateDataset(name, payload) {
  const validator = validators[name];
  assert.ok(validator, `没有 ${name} 的校验器`);
  return validator(payload, name);
}

async function loadDatasets(directory) {
  const datasets = {};
  for (const name of datasetNames) {
    const body = await fs.readFile(path.join(directory, name), "utf8");
    assert.ok(body.length > 20, `${name} 文件为空`);
    datasets[name] = JSON.parse(body);
  }
  return datasets;
}

export function compareCounts(candidate, baseline, minimumRatio, label) {
  for (const [key, baselineValue] of Object.entries(baseline)) {
    const candidateValue = candidate[key];
    if (typeof baselineValue === "number") {
      assert.ok(Number.isFinite(candidateValue), `${label}/${key} 缺少计数`);
      assert.ok(candidateValue >= Math.floor(baselineValue * minimumRatio),
        `${label}/${key} 从 ${baselineValue} 降至 ${candidateValue}，超过安全阈值`);
    } else {
      assert.ok(candidateValue, `${label} 缺少基线分组 ${key}`);
      compareCounts(candidateValue, baselineValue, minimumRatio, `${label}/${key}`);
    }
  }
}

function validateAll(candidateDatasets, baselineDatasets = null) {
  const counts = {};
  for (const name of datasetNames) counts[name] = validateDataset(name, candidateDatasets[name]);
  if (baselineDatasets) {
    const baselineCounts = {};
    for (const name of datasetNames) baselineCounts[name] = validateDataset(name, baselineDatasets[name]);
    const thresholds = {
      "transit-preload.json": 0.65,
      "transit-relations.json": 0.55,
      "railway-routing.json": 0.75,
      "station-access.json": 0.55,
      "airports.json": 0.55,
    };
    for (const name of datasetNames.filter((item) => item !== "railway-connections.json")) {
      compareCounts(counts[name], baselineCounts[name], thresholds[name], name);
    }
    compareCounts(
      { links: counts["railway-connections.json"].links },
      { links: baselineCounts["railway-connections.json"].links },
      0.5,
      "railway-connections.json",
    );
    const candidateRailIds = new Set([
      ...candidateDatasets["railway-routing.json"].ways,
      ...candidateDatasets["railway-connections.json"].ways,
    ].map((way) => String(way[0])));
    const baselineSupplementIds = baselineDatasets["railway-connections.json"].ways.map((way) => String(way[0]));
    const retainedSupplementIds = baselineSupplementIds.filter((id) => candidateRailIds.has(id));
    assert.ok(retainedSupplementIds.length >= Math.floor(baselineSupplementIds.length * 0.8),
      `铁路补充几何保留率过低：${retainedSupplementIds.length}/${baselineSupplementIds.length}`);
  }
  return counts;
}

async function copyDatasets(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of datasetNames) await fs.copyFile(path.join(source, name), path.join(destination, name));
}

async function runCommand(label, command, args, cwd, logDirectory) {
  const logPath = path.join(logDirectory, `${label}.log`);
  await fs.mkdir(logDirectory, { recursive: true });
  const log = await fs.open(logPath, "w");
  console.log(`\n[${label}] ${command} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, windowsHide: true });
    const forward = (chunk, target) => {
      target.write(chunk);
      log.write(chunk).catch(() => {});
    };
    child.stdout.on("data", (chunk) => forward(chunk, process.stdout));
    child.stderr.on("data", (chunk) => forward(chunk, process.stderr));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${label} 失败，退出码 ${code}`)));
  }).finally(() => log.close());
}

function step(name, ...args) {
  return { name, script: name, args };
}

function isBuilderInput(name) {
  return name.endsWith(".cjs") || name === "huaxia-country-boundary.json";
}

async function seedTransitRelations(stagedSite) {
  const preload = JSON.parse(await fs.readFile(path.join(stagedSite, "transit-preload.json"), "utf8"));
  const relations = {
    generatedAt: preload.generatedAt,
    snapshots: preload.snapshots.map(({ id, label, bounds, elements }) => ({ id, label, bounds, elements })),
  };
  await fs.writeFile(path.join(stagedSite, "transit-relations.json"), JSON.stringify(relations));
}

async function prepareRun(runDirectory) {
  const stagedSite = path.join(runDirectory, "outputs", "ogf-atlas");
  const work = path.join(runDirectory, "work");
  const baseline = path.join(runDirectory, "baseline");
  await fs.mkdir(path.dirname(stagedSite), { recursive: true });
  await fs.cp(site, stagedSite, { recursive: true });
  await fs.cp(builderSource, work, { recursive: true });
  await copyDatasets(site, baseline);
  await fs.copyFile(path.join(root, "release", "SHA256.txt"), path.join(baseline, "SHA256.txt"));

  const publishedBaseline = path.join(work, "history-feeder-compare", "ogf-atlas-v2.1.5-2026-09-19");
  const publicTransitBaseline = path.join(work, "preload-refresh-v3036-baseline");
  await fs.mkdir(publishedBaseline, { recursive: true });
  await fs.mkdir(publicTransitBaseline, { recursive: true });
  for (const name of ["transit-preload.json", "railway-routing.json", "railway-connections.json"]) {
    await fs.copyFile(path.join(site, name), path.join(publishedBaseline, name));
  }
  await fs.copyFile(path.join(site, "transit-preload.json"), path.join(publicTransitBaseline, "transit-preload.json"));
  return { stagedSite, work, baseline };
}

async function buildCandidate(runDirectory, stagedSite, resume = false) {
  const logDirectory = path.join(runDirectory, "logs");
  const stepDirectory = path.join(runDirectory, "steps");
  await fs.mkdir(stepDirectory, { recursive: true });
  if (resume) {
    for (const name of (await fs.readdir(builderSource)).filter(isBuilderInput)) {
      await fs.copyFile(path.join(builderSource, name), path.join(runDirectory, "work", name));
    }
  }
  const pipelineHash = createHash("sha256");
  for (const name of (await fs.readdir(path.join(runDirectory, "work")))
    .filter(isBuilderInput).sort()) {
    pipelineHash.update(name);
    pipelineHash.update(await fs.readFile(path.join(runDirectory, "work", name)));
  }
  pipelineHash.update(await fs.readFile(fileURLToPath(import.meta.url)));
  const pipelineFingerprint = pipelineHash.digest("hex");
  const runTask = async (name, action) => {
    const marker = path.join(stepDirectory, `${name}.done.json`);
    if (resume) {
      try {
        const state = JSON.parse(await fs.readFile(marker, "utf8"));
        if (state.pipelineFingerprint === pipelineFingerprint) {
          console.log(`\n[${name}] 已在本次运行中完成，跳过`);
          return;
        }
      } catch {}
    }
    await action();
    await fs.writeFile(marker, `${JSON.stringify({
      completedAt: new Date().toISOString(),
      pipelineFingerprint,
    })}\n`, "utf8");
  };
  const run = async ({ name, script, args }) => {
    const label = name.replace(/\.cjs$/u, "");
    await runTask(label, () => runCommand(
      label,
      process.execPath,
      [path.join("work", script), ...args],
      runDirectory,
      logDirectory,
    ));
  };

  await run(step("build-huaxia-transit-preload.cjs", ...(resume ? ["--resume"] : [])));
  await runTask("seed-transit-relations", () => seedTransitRelations(stagedSite));
  for (const item of [
    step("fetch-huaxia-full-railways-once.cjs"),
    step("fetch-huaxia-railway-ids-once.cjs", ...(resume ? ["--resume"] : [])),
    step("fetch-cardahe-rail-once.cjs", ...(resume ? ["--resume"] : [])),
    step("fetch-ar925-longchuan-transit-once.cjs", ...(resume ? ["--resume"] : [])),
    step("build-cardahe-railway-snapshot.cjs"),
    step("build-ar925-longchuan-snapshot.cjs"),
    step("precompute-transit-preload-node.cjs"),
    step("reconcile-mainline-stations.cjs"),
    step("compact-transit-preload.cjs", "--write"),
    step("build-railway-routing.cjs", "--fetch-missing-once"),
    step("restore-v215-railway-stations.cjs"),
    step("repair-explicit-mainline-interchanges.cjs", "--write"),
    step("reconcile-compact-transit-stations.cjs"),
    step("package-public-transit-rail-infrastructure.cjs", "--write"),
    step("build-station-access.cjs"),
    step("build-huaxia-airports.cjs", ...(resume ? ["--resume"] : [])),
    step("build-rail-connections.cjs"),
    step("enforce-transit-service-rules.cjs"),
  ]) await run(item);
}

async function replaceDatasetsAtomically(candidateDirectory, runDirectory) {
  const moved = [];
  const suffix = timestampId();
  try {
    for (const name of datasetNames) {
      const target = path.join(site, name);
      const next = path.join(site, `.${name}.${suffix}.next`);
      const previous = path.join(site, `.${name}.${suffix}.previous`);
      await fs.copyFile(path.join(candidateDirectory, name), next);
      await fs.rename(target, previous);
      try {
        await fs.rename(next, target);
      } catch (error) {
        await fs.rename(previous, target);
        throw error;
      }
      moved.push({ name, target, previous });
    }
    await runCommand("update-manifest", process.execPath, [path.join("scripts", "update-manifest.mjs")], root,
      path.join(runDirectory, "logs"));
    await runCommand("verify-package", process.execPath, [path.join("scripts", "verify-package.mjs")], root,
      path.join(runDirectory, "logs"));
    await Promise.all(moved.map(({ previous }) => fs.rm(previous, { force: true })));
  } catch (error) {
    for (const { target, previous } of moved.reverse()) {
      await fs.rm(target, { force: true });
      await fs.rename(previous, target);
    }
    await fs.copyFile(path.join(runDirectory, "baseline", "SHA256.txt"), path.join(root, "release", "SHA256.txt"));
    throw error;
  } finally {
    const entries = await fs.readdir(site);
    await Promise.all(entries.filter((name) => name.includes(`.${suffix}.next`))
      .map((name) => fs.rm(path.join(site, name), { force: true })));
  }
}

async function writeReport(runDirectory, report) {
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(runDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(stateRoot, "latest-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) return printHelp();
  for (const arg of args) assert.ok(["--dry-run", "--check", "--resume"].includes(arg), `未知参数：${arg}`);
  assert.ok(Number(process.versions.node.split(".")[0]) >= 20, "需要 Node.js 20 或更高版本");
  assert.ok(!(args.has("--dry-run") && args.has("--check")), "--dry-run 与 --check 不能同时使用");
  assert.ok(!(args.has("--resume") && (args.has("--dry-run") || args.has("--check"))),
    "--resume 会沿用失败运行的模式，不能再与 --dry-run 或 --check 组合");

  const startedAt = new Date();
  let previousReport = null;
  if (args.has("--resume")) {
    previousReport = JSON.parse(await fs.readFile(path.join(stateRoot, "latest-report.json"), "utf8"));
    assert.equal(previousReport.status, "failed", "最近一次运行不是失败状态，无需继续");
    assert.ok(["update", "dry-run"].includes(previousReport.mode), "最近一次失败不是数据构建运行");
  }
  const runId = `${args.has("--check") ? "check" : "run"}-${timestampId(startedAt)}`;
  const runDirectory = previousReport ? path.resolve(previousReport.runDirectory) : path.join(stateRoot, "runs", runId);
  const allowedRunsRoot = `${path.resolve(stateRoot, "runs")}${path.sep}`;
  assert.ok(`${runDirectory}${path.sep}`.startsWith(allowedRunsRoot), "恢复目录不在 .data-update/runs 内");
  await fs.mkdir(runDirectory, { recursive: true });
  const baselineDatasets = await loadDatasets(site);

  if (args.has("--check")) {
    const counts = validateAll(baselineDatasets);
    const report = {
      status: "passed",
      mode: "check",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      counts,
      dynamicData: "建筑与近距底图由 Worker 按需读取 OGF，不需要生成静态文件",
    };
    await writeReport(runDirectory, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let report;
  try {
    let stagedSite;
    if (previousReport) {
      stagedSite = path.join(runDirectory, "outputs", "ogf-atlas");
      await fs.cp(builderSource, path.join(runDirectory, "work"), { recursive: true, force: true });
      const originalBaseline = await loadDatasets(path.join(runDirectory, "baseline"));
      for (const name of datasetNames) {
        assert.equal(semanticHash(baselineDatasets[name]), semanticHash(originalBaseline[name]),
          `${name} 在失败后已改变，请开始一次新的更新，不要恢复旧候选`);
      }
    } else {
      ({ stagedSite } = await prepareRun(runDirectory));
    }
    await buildCandidate(runDirectory, stagedSite, Boolean(previousReport));
    const candidateDatasets = await loadDatasets(stagedSite);
    const counts = validateAll(candidateDatasets, baselineDatasets);
    const changedFiles = datasetNames.filter((name) =>
      semanticHash(candidateDatasets[name]) !== semanticHash(baselineDatasets[name]));
    const dryRun = previousReport ? previousReport.mode === "dry-run" : args.has("--dry-run");
    const backupDirectory = path.join(stateRoot, "backups", runId);

    if (!dryRun && changedFiles.length) {
      await copyDatasets(site, backupDirectory);
      await fs.copyFile(path.join(root, "release", "SHA256.txt"), path.join(backupDirectory, "SHA256.txt"));
      await replaceDatasetsAtomically(stagedSite, runDirectory);
    }

    report = {
      status: "passed",
      mode: dryRun ? "dry-run" : "update",
      startedAt: startedAt.toISOString(),
      resumedFrom: previousReport?.startedAt || null,
      completedAt: new Date().toISOString(),
      changedFiles,
      replaced: !dryRun && changedFiles.length > 0,
      counts,
      candidateDirectory: stagedSite,
      backupDirectory: !dryRun && changedFiles.length ? backupDirectory : null,
      preservedFiles: ["transit-services.json"],
      deployed: false,
      dynamicData: "建筑与近距底图使用同一 OGF 数据源按需更新，本次已通过联网构建验证数据源可用",
    };
    await writeReport(runDirectory, report);
    console.log(`\n统一数据更新完成：${dryRun ? "候选包已保留，未替换生产文件" : changedFiles.length ? "已安全替换数据文件" : "数据无语义变化，无需替换"}`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report = {
      status: "failed",
      mode: previousReport?.mode || (args.has("--dry-run") ? "dry-run" : "update"),
      startedAt: startedAt.toISOString(),
      resumedFrom: previousReport?.startedAt || null,
      failedAt: new Date().toISOString(),
      error: error.stack || error.message,
      productionFilesPreserved: true,
      runDirectory,
      deployed: false,
    };
    await writeReport(runDirectory, report);
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(`\n数据更新失败，site/ 原文件已保留：${error.message}`);
  process.exitCode = 1;
});
