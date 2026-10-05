import assert from "node:assert/strict";

const cache = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      return cache.get(request.url)?.clone();
    },
    async put(request, response) {
      cache.set(request.url, response.clone());
    },
  },
};

const upstreamQueries = [];
let failNextUpstream = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== "https://overpass.opengeofiction.net/api/interpreter") {
    throw new Error(`Unexpected upstream URL: ${url}`);
  }
  const body = String(options.body || "");
  const query = decodeURIComponent(body.replace(/^data=/u, ""));
  upstreamQueries.push(query);
  if (failNextUpstream) {
    failNextUpstream = false;
    return new Response("temporary overload", { status: 502 });
  }
  return new Response(JSON.stringify({
    version: 0.6,
    elements: [{ type: "node", id: 1, lat: 14.6, lon: 152.9, tags: { place: "town", name: "测试镇" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const worker = (await import("../site/_worker.js")).default;
  const waitUntilPromises = [];
  const context = { waitUntil(promise) { waitUntilPromises.push(promise); } };
  const assets = { fetch: async () => new Response("asset", { status: 200 }) };

  const invalid = await worker.fetch(new Request("https://example.test/api/live-basemap/12/1/1.json"),
    { ASSETS: assets }, context);
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).requiredZooms, [13, 14, 15]);

  const liveUrl = "https://example.test/api/live-basemap/13/7576/3760.json?probe=1";
  const first = await worker.fetch(new Request(liveUrl), { ASSETS: assets }, context);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-ogf-basemap-cache"), "MISS");
  assert.equal(first.headers.get("x-ogf-building-cache"), null);
  assert.equal(first.headers.get("x-ogf-basemap-policy"), "snapshot-3h");
  assert.match(first.headers.get("cache-control") || "", /max-age=60/u);
  assert.ok(Number(first.headers.get("x-ogf-basemap-refresh-after")) > 10000);
  assert.equal((await first.json()).elements.length, 1);
  assert.equal(upstreamQueries.length, 1);
  assert.match(upstreamQueries[0], /way\["highway"/u);
  assert.match(upstreamQueries[0], /motorway\|trunk\|primary\|secondary\|tertiary/u);
  assert.match(upstreamQueries[0], /basemapRelations/u);
  assert.match(upstreamQueries[0], /basemapPlaces/u);
  assert.match(upstreamQueries[0], /basemapImportantLabels/u);
  assert.match(upstreamQueries[0], /natural"~"\^\(peak\|volcano\)\$"/u);
  assert.match(upstreamQueries[0], /pitch\|track\|stadium\|sports_centre/u,
    "live basemap tiles should carry detailed sports geometry");
  await Promise.all(waitUntilPromises.splice(0));

  const second = await worker.fetch(new Request(liveUrl), { ASSETS: assets }, context);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-ogf-basemap-cache"), "HIT");
  assert.equal(upstreamQueries.length, 1, "cache hit should not request Overpass again");

  const liveCacheKey = [...cache.keys()].find((key) => key.includes("huayu-live-basemap-v6"));
  assert.ok(liveCacheKey, "live basemap tile should be retained in the edge snapshot cache");
  const retained = cache.get(liveCacheKey);
  const retainedHeaders = new Headers(retained.headers);
  retainedHeaders.set("X-OGF-Basemap-Fetched-At", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
  cache.set(liveCacheKey, new Response(await retained.clone().text(), {
    status: retained.status,
    headers: retainedHeaders,
  }));
  const stale = await worker.fetch(new Request(liveUrl), { ASSETS: assets }, context);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("x-ogf-basemap-cache"), "STALE");
  assert.ok(waitUntilPromises.length > 0, "stale snapshot should schedule a background refresh");
  await Promise.all(waitUntilPromises.splice(0));
  assert.equal(upstreamQueries.length, 2, "stale snapshot should refresh in the background");
  const refreshed = await worker.fetch(new Request(liveUrl), { ASSETS: assets }, context);
  assert.equal(refreshed.headers.get("x-ogf-basemap-cache"), "HIT");

  const detail = await worker.fetch(new Request("https://example.test/api/live-basemap/15/30304/15040.json"),
    { ASSETS: assets }, context);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("x-ogf-basemap-policy"), "live-2m");
  assert.match(detail.headers.get("cache-control") || "", /max-age=15/u);

  failNextUpstream = true;
  const beforeRetry = upstreamQueries.length;
  const retriedSnapshot = await worker.fetch(
    new Request("https://example.test/api/live-basemap/14/15152/7519.json"),
    { ASSETS: assets }, context);
  assert.equal(retriedSnapshot.status, 200);
  assert.equal(upstreamQueries.length, beforeRetry + 2, "snapshot cold load should retry one transient upstream failure");

  const building = await worker.fetch(new Request("https://example.test/api/buildings/11/1893/939.json"),
    { ASSETS: assets }, context);
  assert.equal(building.status, 200);
  assert.equal(building.headers.get("x-ogf-building-cache"), "MISS");
  assert.equal(building.headers.get("x-ogf-basemap-cache"), null);
  assert.match(building.headers.get("cache-control") || "", /max-age=10800/u);
  assert.match(upstreamQueries.at(-1), /buildingWays/u);
  assert.match(upstreamQueries.at(-1), /barrierWays/u,
    "legacy building snapshots should remain reusable");
  assert.doesNotMatch(upstreamQueries.at(-1), /pavilionStructures/u,
    "pavilion selectors must not make the heavy building query time out");

  const detailedBuilding = await worker.fetch(
    new Request("https://example.test/api/buildings/15/29822/14884.json"), { ASSETS: assets }, context);
  assert.equal(detailedBuilding.status, 200, "z15 building tiles should support close-range modeling");
  const invalidBuilding = await worker.fetch(
    new Request("https://example.test/api/buildings/16/59644/29768.json"), { ASSETS: assets }, context);
  assert.equal(invalidBuilding.status, 400);
  assert.deepEqual((await invalidBuilding.json()).requiredZooms, [11, 12, 13, 14, 15]);

  const structureUrl = "https://example.test/api/structures/15/30304/15036.json?probe=1";
  const structure = await worker.fetch(new Request(structureUrl), { ASSETS: assets }, context);
  assert.equal(structure.status, 200);
  assert.equal(structure.headers.get("x-ogf-structure-cache"), "MISS");
  assert.equal(structure.headers.get("x-ogf-structure-policy"), "snapshot-3h");
  assert.match(structure.headers.get("cache-control") || "", /max-age=60/u);
  assert.match(upstreamQueries.at(-1), /barrierWays/u);
  assert.match(upstreamQueries.at(-1), /pavilionStructures/u);
  assert.match(upstreamQueries.at(-1), /nwr\["amenity"="shelter"\]/u,
    "all non-transit shelter candidates should reach client-side classification");
  assert.match(upstreamQueries.at(-1), /leisure"="gazebo/u);
  assert.match(upstreamQueries.at(-1), /man_made"~"\^\(gazebo\|pavilion\)\$"/u);
  assert.match(upstreamQueries.at(-1), /building:part"~"\^\(gazebo\|pavilion\)\$"/u);
  assert.match(upstreamQueries.at(-1), /nwr\["building"\]\["building"!="no"\]\["name"~/u,
    "named pavilion buildings should reach client-side classification even without shelter tags");
  assert.match(upstreamQueries.at(-1), /way\(r\.pavilionStructures\)/u,
    "pavilion relation member ways should be returned for polygon assembly");
  assert.match(upstreamQueries.at(-1), /pavilionClearanceWays/u,
    "z14-z15 structure tiles should include roads for pavilion clearance sizing");
  const structureQueriesAfterMiss = upstreamQueries.length;
  const structureHit = await worker.fetch(new Request(structureUrl), { ASSETS: assets }, context);
  assert.equal(structureHit.headers.get("x-ogf-structure-cache"), "HIT");
  assert.equal(upstreamQueries.length, structureQueriesAfterMiss);
  const structureCacheKey = [...cache.keys()].find((key) => key.includes("huayu-structures-v2-open-pavilions"));
  assert.ok(structureCacheKey, "structures should use an independent edge snapshot cache");

  const invalidStructure = await worker.fetch(
    new Request("https://example.test/api/structures/16/60608/30072.json"), { ASSETS: assets }, context);
  assert.equal(invalidStructure.status, 400);
  assert.deepEqual((await invalidStructure.json()).requiredZooms, [11, 12, 13, 14, 15]);

  const invalidTransit = await worker.fetch(
    new Request("https://example.test/api/transit/rail/11/1893/939.json"), { ASSETS: assets }, context);
  assert.equal(invalidTransit.status, 400);
  assert.deepEqual((await invalidTransit.json()).requiredZooms, { rail: 10, bus: 12 });

  const railTransitUrl = "https://example.test/api/transit/rail/10/946/469.json?probe=1";
  const railTransit = await worker.fetch(new Request(railTransitUrl), { ASSETS: assets }, context);
  assert.equal(railTransit.status, 200);
  assert.equal(railTransit.headers.get("x-ogf-transit-cache"), "MISS");
  assert.equal(railTransit.headers.get("x-ogf-transit-policy"), "snapshot-3h");
  assert.match(upstreamQueries.at(-1), /bboxRailRoutes/u);
  assert.match(upstreamQueries.at(-1), /routeStopNodes/u);
  assert.match(upstreamQueries.at(-1), /nwr\["railway"/u,
    "rail transit tiles should include stations mapped as areas or relations");
  assert.match(upstreamQueries.at(-1), /railStations out body center/u,
    "rail transit tiles should return center coordinates for non-node stations");
  const transitQueriesAfterMiss = upstreamQueries.length;
  const railTransitHit = await worker.fetch(new Request(railTransitUrl), { ASSETS: assets }, context);
  assert.equal(railTransitHit.headers.get("x-ogf-transit-cache"), "HIT");
  assert.equal(upstreamQueries.length, transitQueriesAfterMiss);

  const railTransitCacheKey = [...cache.keys()].find((key) => key.includes("huayu-transit-tile-v2-area-stations")
    && key.includes("/transit/rail/"));
  assert.ok(railTransitCacheKey, "rail transit tile should be retained in the edge cache");
  const retainedRailTransit = cache.get(railTransitCacheKey);
  const retainedRailHeaders = new Headers(retainedRailTransit.headers);
  retainedRailHeaders.set("X-OGF-Transit-Fetched-At", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
  cache.set(railTransitCacheKey, new Response(await retainedRailTransit.clone().text(), {
    status: retainedRailTransit.status,
    headers: retainedRailHeaders,
  }));
  const staleRailTransit = await worker.fetch(new Request(railTransitUrl), { ASSETS: assets }, context);
  assert.equal(staleRailTransit.headers.get("x-ogf-transit-cache"), "STALE");
  assert.ok(waitUntilPromises.length > 0, "stale transit tile should refresh in the background");
  await Promise.all(waitUntilPromises.splice(0));
  assert.equal(upstreamQueries.length, transitQueriesAfterMiss + 1);

  const busTransit = await worker.fetch(
    new Request("https://example.test/api/transit/bus/12/3787/1879.json"), { ASSETS: assets }, context);
  assert.equal(busTransit.status, 200);
  assert.equal(busTransit.headers.get("x-ogf-transit-cache"), "MISS");
  assert.match(upstreamQueries.at(-1), /busStops/u);
  assert.match(upstreamQueries.at(-1), /busMasters/u);

  const asset = await worker.fetch(new Request("https://example.test/index.html"), { ASSETS: assets }, context);
  assert.equal(await asset.text(), "asset");

  console.log(JSON.stringify({
    status: "passed",
    liveBasemapCache: "MISS/HIT/STALE/background-refresh",
    liveBasemapZooms: [13, 14, 15],
    liveBasemapPolicies: { snapshot: "z13-z14/3h", detail: "z15/2m" },
    buildingZooms: [11, 12, 13, 14, 15],
    buildingCache: "3h",
    structureZooms: [11, 12, 13, 14, 15],
    structureCache: "MISS/HIT/3h",
    transitTileZooms: { rail: 10, bus: 12 },
    transitCache: "MISS/HIT/STALE/background-refresh/3h",
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
