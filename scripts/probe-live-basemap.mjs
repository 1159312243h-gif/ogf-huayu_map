import assert from "node:assert/strict";

globalThis.caches = {
  default: {
    async match() { return undefined; },
    async put() {},
  },
};

const worker = (await import("../site/_worker.js")).default;
const probePath = process.env.LIVE_BASEMAP_PROBE || "/api/live-basemap/13/7576/3759.json";
const startedAt = Date.now();
const response = await worker.fetch(new Request(`https://local.test${probePath}`), {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
}, { waitUntil() {} });
const payload = await response.json();
assert.equal(response.status, 200, `实时底图接口探测失败：${JSON.stringify(payload)}`);
assert.ok(Array.isArray(payload.elements), "实时底图接口没有返回 OGF elements");
assert.ok(payload.elements.some((element) => element.tags?.highway
  || element.tags?.landuse || element.tags?.natural || element.tags?.railway), "探测分片缺少底图要素");

console.log(JSON.stringify({
  status: "passed",
  probe: probePath,
  elements: payload.elements.length,
  cache: response.headers.get("x-ogf-basemap-cache"),
  fetchedAt: response.headers.get("x-ogf-basemap-fetched-at"),
  durationMs: Date.now() - startedAt,
}, null, 2));
