import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(await fs.readFile(path.join(root, "release.json"), "utf8"));
const attempts = Math.max(1, Number(process.env.VERIFY_ATTEMPTS || 1));
const delayMs = Math.max(1000, Number(process.env.VERIFY_DELAY_MS || 10000));
const baseUrl = String(process.env.OGF_ATLAS_URL || release.productionUrl).replace(/\/$/u, "");

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

async function verify() {
  const cacheKey = `${release.releaseVersion}-${Date.now()}`;
  const entryResponse = await fetch(`${baseUrl}/?verify=${encodeURIComponent(cacheKey)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const entry = await entryResponse.text();
  assert.equal(entryResponse.status, 200, "生产入口未返回 200");
  assert.ok(entry.includes(release.entryScript), "生产入口尚未加载目标版本");

  const appResponse = await fetch(`${baseUrl}/app.js?verify=${encodeURIComponent(cacheKey)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const app = await appResponse.text();
  assert.equal(appResponse.status, 200, "生产 app.js 未返回 200");
  assert.ok(app.includes(`HUAYU_LIVE_BUILDING_MIN_ZOOM = ${release.expectedBuildingMinZoom}`),
    "生产 app.js 的建筑缩放门槛不一致");

  const buildingResponse = await fetch(`${baseUrl}${release.buildingProbe}?verify=${encodeURIComponent(cacheKey)}`, {
    signal: AbortSignal.timeout(60000),
  });
  const building = await buildingResponse.json();
  assert.equal(buildingResponse.status, 200, "生产建筑 API 未返回 200");
  assert.ok(Array.isArray(building.elements) && building.elements.length > 0, "生产建筑 API 没有返回 OGF 要素");

  const basemapResponse = await fetch(`${baseUrl}${release.liveBasemapProbe}?verify=${encodeURIComponent(cacheKey)}`, {
    signal: AbortSignal.timeout(60000),
  });
  const basemap = await basemapResponse.json();
  assert.equal(basemapResponse.status, 200, "生产实时底图 API 未返回 200");
  assert.ok(Array.isArray(basemap.elements) && basemap.elements.some((element) => element.tags?.highway
    || element.tags?.landuse || element.tags?.natural || element.tags?.railway), "生产实时底图 API 没有返回底图要素");

  const transitResponse = await fetch(`${baseUrl}${release.transitProbe}?verify=${encodeURIComponent(cacheKey)}`, {
    signal: AbortSignal.timeout(60000),
  });
  const transit = await transitResponse.json();
  assert.equal(transitResponse.status, 200, "生产交通分片 API 未返回 200");
  assert.ok(Array.isArray(transit.elements) && transit.elements.length > 0, "生产交通分片 API 没有返回 OGF 要素");
  assert.equal(transitResponse.headers.get("x-ogf-transit-policy"), "snapshot-3h",
    "生产交通分片没有使用三小时缓存策略");

  return {
    status: "passed",
    url: baseUrl,
    release: release.releaseVersion,
    buildingElements: building.elements.length,
    buildingCache: buildingResponse.headers.get("x-ogf-building-cache"),
    liveBasemapElements: basemap.elements.length,
    liveBasemapCache: basemapResponse.headers.get("x-ogf-basemap-cache"),
    transitElements: transit.elements.length,
    transitCache: transitResponse.headers.get("x-ogf-transit-cache"),
  };
}

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    console.log(JSON.stringify(await verify(), null, 2));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await wait(delayMs);
  }
}
throw lastError;
