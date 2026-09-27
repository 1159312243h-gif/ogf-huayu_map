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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== "https://overpass.opengeofiction.net/api/interpreter") {
    throw new Error(`Unexpected upstream URL: ${url}`);
  }
  const body = String(options.body || "");
  const query = decodeURIComponent(body.replace(/^data=/u, ""));
  upstreamQueries.push(query);
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
  assert.match(first.headers.get("cache-control") || "", /max-age=120/u);
  assert.equal((await first.json()).elements.length, 1);
  assert.equal(upstreamQueries.length, 1);
  assert.match(upstreamQueries[0], /way\["highway"\]/u);
  assert.match(upstreamQueries[0], /basemapRelations/u);
  assert.match(upstreamQueries[0], /basemapPlaces/u);
  await Promise.all(waitUntilPromises.splice(0));

  const second = await worker.fetch(new Request(liveUrl), { ASSETS: assets }, context);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-ogf-basemap-cache"), "HIT");
  assert.equal(upstreamQueries.length, 1, "cache hit should not request Overpass again");

  const building = await worker.fetch(new Request("https://example.test/api/buildings/11/1893/939.json"),
    { ASSETS: assets }, context);
  assert.equal(building.status, 200);
  assert.equal(building.headers.get("x-ogf-building-cache"), "MISS");
  assert.equal(building.headers.get("x-ogf-basemap-cache"), null);
  assert.match(upstreamQueries.at(-1), /buildingWays/u);

  const asset = await worker.fetch(new Request("https://example.test/index.html"), { ASSETS: assets }, context);
  assert.equal(await asset.text(), "asset");

  console.log(JSON.stringify({
    status: "passed",
    liveBasemapCache: "MISS/HIT",
    liveBasemapZooms: [13, 14, 15],
    buildingRoutePreserved: true,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
