const OGF_OVERPASS_URL = "https://overpass.opengeofiction.net/api/interpreter";
const BUILDING_TILE_ZOOMS = new Set([11, 12, 13, 14]);
const BUILDING_CACHE_SECONDS = 120;
const BUILDING_QUERY_TIMEOUT_MS = 30000;

function buildingTileBounds(z, x, y) {
  const scale = 2 ** z;
  const longitude = (tileX) => tileX / scale * 360 - 180;
  const latitude = (tileY) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / scale))) * 180 / Math.PI;
  return {
    west: longitude(x),
    east: longitude(x + 1),
    north: latitude(y),
    south: latitude(y + 1),
  };
}

function buildingOverpassQuery(bounds) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  return `[out:json][timeout:25];way["building"]["building"!="no"](${bbox})->.buildingWays;`
    + `rel["building"]["building"!="no"](${bbox})->.buildingRelations;`
    + `way["building:part"]["building:part"!="no"](${bbox})->.buildingPartWays;`
    + `rel["building:part"]["building:part"!="no"](${bbox})->.buildingPartRelations;`
    + `(.buildingWays;.buildingRelations;.buildingPartWays;.buildingPartRelations;`
    + `way(r.buildingRelations);way(r.buildingPartRelations););out body geom;`;
}

function buildingJsonResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });
}

function cachedBuildingResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.set("X-OGF-Building-Cache", cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchBuildingTile(request, context, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const scale = 2 ** z;
  if (!BUILDING_TILE_ZOOMS.has(z) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_building_tile",
      requiredZooms: [...BUILDING_TILE_ZOOMS],
    }), 400);
  }

  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-building-v3");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cachedBuildingResponse(cached, "HIT");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILDING_QUERY_TIMEOUT_MS);
  try {
    const query = buildingOverpassQuery(buildingTileBounds(z, x, y));
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return buildingJsonResponse(JSON.stringify({
        error: "overpass_error",
        status: upstream.status,
      }), 502, { "Cache-Control": "no-store" });
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      return buildingJsonResponse(JSON.stringify({ error: "invalid_overpass_json" }), 502, {
        "Cache-Control": "no-store",
      });
    }
    if (!Array.isArray(payload?.elements)) {
      return buildingJsonResponse(JSON.stringify({ error: "invalid_overpass_payload" }), 502, {
        "Cache-Control": "no-store",
      });
    }

    const fetchedAt = new Date().toISOString();
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=${BUILDING_CACHE_SECONDS}, s-maxage=${BUILDING_CACHE_SECONDS}`,
      "X-OGF-Building-Cache": "MISS",
      "X-OGF-Building-Fetched-At": fetchedAt,
      "X-OGF-Building-Tile": `${z}/${x}/${y}`,
    });
    context.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : "overpass_unavailable",
    }), 504, { "Cache-Control": "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, environment, context) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/buildings\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (match) {
      return fetchBuildingTile(request, context, ...match.slice(1).map(Number));
    }
    return environment.ASSETS.fetch(request);
  },
};
