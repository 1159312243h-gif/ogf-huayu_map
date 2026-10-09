const OGF_OVERPASS_URL = "https://overpass.opengeofiction.net/api/interpreter";
const BUILDING_TILE_ZOOMS = new Set([11, 12, 13, 14, 15]);
const BUILDING_CACHE_SECONDS = 10800;
const BUILDING_QUERY_TIMEOUT_MS = 30000;
const STRUCTURE_TILE_ZOOMS = BUILDING_TILE_ZOOMS;
const STRUCTURE_REFRESH_SECONDS = 10800;
const STRUCTURE_RETENTION_SECONDS = 604800;
const STRUCTURE_QUERY_TIMEOUT_MS = 20000;
const LIVE_BASEMAP_TILE_ZOOMS = new Set([13, 14, 15]);
const LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS = new Set([13, 14]);
const LIVE_BASEMAP_SNAPSHOT_REFRESH_SECONDS = 10800;
const LIVE_BASEMAP_SNAPSHOT_RETENTION_SECONDS = 604800;
const LIVE_BASEMAP_DETAIL_REFRESH_SECONDS = 120;
const LIVE_BASEMAP_DETAIL_RETENTION_SECONDS = 1800;
const LIVE_BASEMAP_QUERY_TIMEOUT_MS = 30000;
const TERRAIN_TILE_ZOOM = 9;
const TERRAIN_REFRESH_SECONDS = 10800;
const TERRAIN_RETENTION_SECONDS = 604800;
const TERRAIN_QUERY_TIMEOUT_MS = 35000;
const TRANSIT_TILE_ZOOMS = Object.freeze({ rail: 10, bus: 12 });
const TRANSIT_REFRESH_SECONDS = 10800;
const TRANSIT_RETENTION_SECONDS = 604800;
const TRANSIT_QUERY_TIMEOUT_MS = Object.freeze({ rail: 40000, bus: 20000 });
const liveBasemapRefreshes = new Map();
const terrainTileRefreshes = new Map();
const transitTileRefreshes = new Map();
const structureTileRefreshes = new Map();

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
    + `way["historic"~"^(palace|castle|temple|shrine|monument|archaeological_site|city_gate)$"](${bbox})->.ancientWays;`
    + `rel["historic"~"^(palace|castle|temple|shrine|monument|archaeological_site|city_gate)$"](${bbox})->.ancientRelations;`
    + `way["building:architecture"~"^(traditional|hanok|pagoda|temple|palace|castle)$"](${bbox})->.ancientArchitectureWays;`
    + `rel["building:architecture"~"^(traditional|hanok|pagoda|temple|palace|castle)$"](${bbox})->.ancientArchitectureRelations;`
    + `way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;`
    + `(.buildingWays;.buildingRelations;.buildingPartWays;.buildingPartRelations;.ancientWays;.ancientRelations;`
    + `.ancientArchitectureWays;.ancientArchitectureRelations;.barrierWays;way(r.buildingRelations);way(r.buildingPartRelations);`
    + `way(r.ancientRelations);way(r.ancientArchitectureRelations););out body geom;`;
}

function structureOverpassQuery(bounds, zoom) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const pavilionName = "(凉亭|亭子|景观亭|观景亭|赏花亭|休憩亭|休息亭|廊亭|亭)$";
  const clearanceWays = zoom >= 14
    ? `way["highway"](${bbox})->.pavilionClearanceWays;` : "";
  return `[out:json][timeout:15];way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;${clearanceWays}(`
    + `nwr["amenity"="shelter"](${bbox});nwr["leisure"="gazebo"](${bbox});`
    + `nwr["man_made"~"^(gazebo|pavilion)$"](${bbox});nwr["building"~"^(gazebo|pavilion)$"](${bbox});`
    + `nwr["building:part"~"^(gazebo|pavilion)$"](${bbox});`
    + `nwr["building"]["building"!="no"]["name"~"${pavilionName}"](${bbox});`
    + `nwr["building"~"^(roof|shelter)$"]["name"~"${pavilionName}"](${bbox});`
    + `nwr["tourism"="attraction"]["name"~"${pavilionName}"](${bbox});`
    + `nwr["historic"="building"]["name"~"${pavilionName}"](${bbox});)->.pavilionStructures;`
    + `(.barrierWays;.pavilionStructures;way(r.pavilionStructures);`
    + `${zoom >= 14 ? ".pavilionClearanceWays;" : ""});out body geom;`;
}

function liveBasemapOverpassQuery(bounds, zoom) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const highwaySelector = zoom <= 13
    ? `["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]` : `["highway"]`;
  const treeNodes = zoom >= 15
    ? `node["natural"="tree"](${bbox})->.basemapTrees;` : "";
  return `[out:json][timeout:${zoom <= 13 ? 45 : 25}];(`
    + `way${highwaySelector}(${bbox});`
    + `way["railway"~"^(rail|narrow_gauge|light_rail|tram|monorail)$"](${bbox});`
    + `way["waterway"](${bbox});`
    + `way["natural"~"^(water|wood|scrub|grassland|wetland|beach|sand)$"](${bbox});`
    + `way["landuse"](${bbox});`
    + `way["leisure"~"^(park|garden|pitch|track|stadium|sports_centre|playground|fitness_station|swimming_pool)$"](${bbox});`
    + `way["amenity"~"^(school|university|college|hospital|clinic|parking|fire_station|recycling|waste_disposal|waste_transfer_station|waster_transfer_station|fuel|charging_station)$"](${bbox});`
    + `)->.basemapWays;(`
    + `rel["type"="multipolygon"]["natural"~"^(water|wood|scrub|grassland|wetland|beach|sand)$"](${bbox});`
    + `rel["type"="multipolygon"]["landuse"](${bbox});`
    + `rel["type"="multipolygon"]["leisure"~"^(park|garden|pitch|track|stadium|sports_centre|playground|fitness_station|swimming_pool)$"](${bbox});`
    + `rel["type"="multipolygon"]["amenity"~"^(school|university|college|hospital|clinic|parking|fire_station|recycling|waste_disposal|waste_transfer_station|waster_transfer_station|fuel|charging_station)$"](${bbox});`
    + `)->.basemapRelations;`
    + `node["place"~"^(city|town|village|suburb|neighbourhood|hamlet)$"](${bbox})->.basemapPlaces;`
    + treeNodes
    + `(node["natural"~"^(peak|volcano)$"]["name"](${bbox});`
    + `node["amenity"="university"]["name"](${bbox});)->.basemapImportantLabels;`
    + `(.basemapWays;.basemapRelations;.basemapPlaces;${zoom >= 15 ? ".basemapTrees;" : ""}.basemapImportantLabels;`
    + `way(r.basemapRelations););out body geom;`;
}

function terrainOverpassQuery(bounds) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const namedRelief = `["name"~"高山|山地|山区|山坡|丘陵|荒原|alpine|upland|mountain|[山岭谷岳峰岗丘峦坡峡]$",i]`;
  return `[out:json][timeout:30];(`
    + `way["natural"="wood"](${bbox});`
    + `way["landuse"="forest"](${bbox});`
    + `way["natural"~"^(grassland|scrub|heath|fell|bare_rock|scree)$"]${namedRelief}(${bbox});`
    + `way["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `way["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainWays;(`
    + `rel["type"="multipolygon"]["natural"="wood"](${bbox});`
    + `rel["type"="multipolygon"]["landuse"="forest"](${bbox});`
    + `rel["type"="multipolygon"]["natural"~"^(grassland|scrub|heath|fell|bare_rock|scree)$"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainRelations;`
    + `node["natural"~"^(peak|volcano)$"](${bbox})->.terrainPeaks;`
    + `(.terrainWays;.terrainRelations;.terrainPeaks;);out body geom;`;
}

function transitTileOverpassQuery(kind, bounds) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  if (kind === "rail") {
    return `[out:json][timeout:35];rel["type"="route"]["route"~"^(subway|light_rail|tram|monorail|train)$"](${bbox})->.bboxRailRoutes;`
      + `rel(br.bboxRailRoutes)["type"="route_master"]->.railMasters;`
      + `rel(r.railMasters)["type"="route"]["route"~"^(subway|light_rail|tram|monorail|train)$"]->.masterRailRoutes;`
      + `(.bboxRailRoutes;.masterRailRoutes;)->.railRoutes;way(r.railRoutes)->.railWays;`
      + `way["railway"~"^(rail|narrow_gauge)$"][!"service"](${bbox})->.railInfrastructure;`
      + `node(r.railRoutes)->.routeStopNodes;`
      + `(nwr["railway"~"^(station|halt|tram_stop)$"](${bbox});nwr["station"="subway"](${bbox});`
      + `nwr["subway"="yes"](${bbox});nwr["public_transport"="station"](${bbox});)->.railStations;`
      + `(.railMasters;.railRoutes;);out body;(.railWays;.railInfrastructure;);out body geom;`
      + `.routeStopNodes out body;.railStations out body center;`;
  }
  return `[out:json][timeout:15];(node["highway"="bus_stop"](${bbox});node["amenity"="bus_station"](${bbox});`
    + `node["public_transport"="station"]["bus"="yes"](${bbox});`
    + `node["public_transport"="platform"]["bus"="yes"](${bbox});`
    + `node["public_transport"="stop_position"]["bus"="yes"](${bbox});)->.busStops;`
    + `rel(bn.busStops)["type"="route"]["route"="bus"]->.busRoutes;`
    + `rel(br.busRoutes)["type"="route_master"]->.busMasters;`
    + `(.busStops;.busRoutes;.busMasters;);out body;`;
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

function cachedBuildingResponse(response, cacheStatus, headerName = "X-OGF-Building-Cache") {
  const headers = new Headers(response.headers);
  headers.set(headerName, cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function liveBasemapCachePolicy(z) {
  const snapshot = LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z);
  return {
    name: snapshot ? "snapshot-3h" : "live-2m",
    refreshSeconds: snapshot ? LIVE_BASEMAP_SNAPSHOT_REFRESH_SECONDS : LIVE_BASEMAP_DETAIL_REFRESH_SECONDS,
    retentionSeconds: snapshot ? LIVE_BASEMAP_SNAPSHOT_RETENTION_SECONDS : LIVE_BASEMAP_DETAIL_RETENTION_SECONDS,
    browserSeconds: snapshot ? 60 : 15,
  };
}

function liveBasemapClientResponse(response, cacheStatus, policy) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Basemap-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  const refreshAfter = cacheStatus === "STALE" ? 30
    : Math.max(0, policy.refreshSeconds - ageSeconds);
  headers.set("X-OGF-Basemap-Cache", cacheStatus);
  headers.set("X-OGF-Basemap-Policy", policy.name);
  headers.set("X-OGF-Basemap-Age", String(ageSeconds));
  headers.set("X-OGF-Basemap-Refresh-After", String(refreshAfter));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : policy.browserSeconds}, must-revalidate`);
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
  cacheUrl.searchParams.set("schema", "huayu-building-v5");
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

function structureTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Structure-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Structure-Cache", cacheStatus);
  headers.set("X-OGF-Structure-Policy", "snapshot-3h");
  headers.set("X-OGF-Structure-Age", String(ageSeconds));
  headers.set("X-OGF-Structure-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, STRUCTURE_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : 60}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadStructureTile(cacheKey, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRUCTURE_QUERY_TIMEOUT_MS);
  try {
    const query = structureOverpassQuery(buildingTileBounds(z, x, y), z);
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
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${STRUCTURE_RETENTION_SECONDS}`,
      "X-OGF-Structure-Fetched-At": new Date().toISOString(),
      "X-OGF-Structure-Tile": `${z}/${x}/${y}`,
      "X-OGF-Structure-Policy": "snapshot-3h",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshStructureTile(cacheKey, z, x, y) {
  const refreshKey = cacheKey.url;
  if (structureTileRefreshes.has(refreshKey)) return structureTileRefreshes.get(refreshKey);
  const refresh = loadStructureTile(cacheKey, z, x, y)
    .finally(() => structureTileRefreshes.delete(refreshKey));
  structureTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchStructureTile(request, context, z, x, y) {
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
  if (!STRUCTURE_TILE_ZOOMS.has(z) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_structure_tile",
      requiredZooms: [...STRUCTURE_TILE_ZOOMS],
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-structures-v2-open-pavilions");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Structure-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < STRUCTURE_REFRESH_SECONDS) return structureTileClientResponse(cached, "HIT");
    const refresh = refreshStructureTile(cacheKey, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return structureTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshStructureTile(cacheKey, z, x, y);
    return structureTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

async function loadLiveBasemapTileOnce(cacheKey, z, x, y, policy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), z <= 13 ? 50000 : LIVE_BASEMAP_QUERY_TIMEOUT_MS);
  try {
    const query = liveBasemapOverpassQuery(buildingTileBounds(z, x, y), z);
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
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }

    const fetchedAt = new Date().toISOString();
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${policy.retentionSeconds}`,
      "X-OGF-Basemap-Fetched-At": fetchedAt,
      "X-OGF-Basemap-Tile": `${z}/${x}/${y}`,
      "X-OGF-Basemap-Policy": policy.name,
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLiveBasemapTile(cacheKey, z, x, y, policy) {
  try {
    return await loadLiveBasemapTileOnce(cacheKey, z, x, y, policy);
  } catch (error) {
    if (!LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return loadLiveBasemapTileOnce(cacheKey, z, x, y, policy);
  }
}

function refreshLiveBasemapTile(cacheKey, z, x, y, policy) {
  const refreshKey = cacheKey.url;
  if (liveBasemapRefreshes.has(refreshKey)) return liveBasemapRefreshes.get(refreshKey);
  const refresh = loadLiveBasemapTile(cacheKey, z, x, y, policy)
    .finally(() => liveBasemapRefreshes.delete(refreshKey));
  liveBasemapRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchLiveBasemapTile(request, context, z, x, y) {
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
  if (!LIVE_BASEMAP_TILE_ZOOMS.has(z) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_live_basemap_tile",
      requiredZooms: [...LIVE_BASEMAP_TILE_ZOOMS],
    }), 400);
  }

  const policy = liveBasemapCachePolicy(z);
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-live-basemap-v8-progressive-terrain");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Basemap-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < policy.refreshSeconds) {
      return liveBasemapClientResponse(cached, "HIT", policy);
    }
    const refresh = refreshLiveBasemapTile(cacheKey, z, x, y, policy);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return liveBasemapClientResponse(cached, "STALE", policy);
  }

  try {
    const response = await refreshLiveBasemapTile(cacheKey, z, x, y, policy);
    return liveBasemapClientResponse(response.clone(), "MISS", policy);
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

function terrainTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Terrain-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Terrain-Cache", cacheStatus);
  headers.set("X-OGF-Terrain-Policy", "snapshot-3h");
  headers.set("X-OGF-Terrain-Age", String(ageSeconds));
  headers.set("X-OGF-Terrain-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, TERRAIN_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : 60}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadTerrainTile(cacheKey, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TERRAIN_QUERY_TIMEOUT_MS);
  try {
    const query = terrainOverpassQuery(buildingTileBounds(z, x, y));
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
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    if (payload.remark) {
      const error = new Error("incomplete_terrain_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${TERRAIN_RETENTION_SECONDS}`,
      "X-OGF-Terrain-Fetched-At": new Date().toISOString(),
      "X-OGF-Terrain-Tile": `${z}/${x}/${y}`,
      "X-OGF-Terrain-Policy": "snapshot-3h",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshTerrainTile(cacheKey, z, x, y) {
  const refreshKey = cacheKey.url;
  if (terrainTileRefreshes.has(refreshKey)) return terrainTileRefreshes.get(refreshKey);
  const refresh = loadTerrainTile(cacheKey, z, x, y)
    .finally(() => terrainTileRefreshes.delete(refreshKey));
  terrainTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchTerrainTile(request, context, z, x, y) {
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
  if (z < 6 || z > TERRAIN_TILE_ZOOM || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_terrain_tile",
      requiredZoom: TERRAIN_TILE_ZOOM,
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-terrain-v5-open-small-mountains");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Terrain-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < TERRAIN_REFRESH_SECONDS) return terrainTileClientResponse(cached, "HIT");
    const refresh = refreshTerrainTile(cacheKey, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return terrainTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshTerrainTile(cacheKey, z, x, y);
    return terrainTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

function transitTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Transit-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Transit-Cache", cacheStatus);
  headers.set("X-OGF-Transit-Policy", "snapshot-3h");
  headers.set("X-OGF-Transit-Age", String(ageSeconds));
  headers.set("X-OGF-Transit-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, TRANSIT_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : 60}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadTransitTileOnce(cacheKey, kind, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSIT_QUERY_TIMEOUT_MS[kind]);
  try {
    const query = transitTileOverpassQuery(kind, buildingTileBounds(z, x, y));
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
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${TRANSIT_RETENTION_SECONDS}`,
      "X-OGF-Transit-Fetched-At": new Date().toISOString(),
      "X-OGF-Transit-Tile": `${kind}/${z}/${x}/${y}`,
      "X-OGF-Transit-Policy": "snapshot-3h",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshTransitTile(cacheKey, kind, z, x, y) {
  const refreshKey = cacheKey.url;
  if (transitTileRefreshes.has(refreshKey)) return transitTileRefreshes.get(refreshKey);
  const refresh = loadTransitTileOnce(cacheKey, kind, z, x, y)
    .finally(() => transitTileRefreshes.delete(refreshKey));
  transitTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchTransitTile(request, context, kind, z, x, y) {
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
  const requiredZoom = TRANSIT_TILE_ZOOMS[kind];
  const scale = 2 ** z;
  if (!Number.isInteger(requiredZoom) || z !== requiredZoom || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_transit_tile",
      requiredZooms: TRANSIT_TILE_ZOOMS,
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-transit-tile-v2-area-stations");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Transit-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < TRANSIT_REFRESH_SECONDS) return transitTileClientResponse(cached, "HIT");
    const refresh = refreshTransitTile(cacheKey, kind, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return transitTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshTransitTile(cacheKey, kind, z, x, y);
    return transitTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

export default {
  async fetch(request, environment, context) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/buildings\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (match) {
      return fetchBuildingTile(request, context, ...match.slice(1).map(Number));
    }
    const structureMatch = url.pathname.match(/^\/api\/structures\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (structureMatch) {
      return fetchStructureTile(request, context, ...structureMatch.slice(1).map(Number));
    }
    const liveBasemapMatch = url.pathname.match(/^\/api\/live-basemap\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (liveBasemapMatch) {
      return fetchLiveBasemapTile(request, context, ...liveBasemapMatch.slice(1).map(Number));
    }
    const terrainMatch = url.pathname.match(/^\/api\/terrain\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (terrainMatch) {
      return fetchTerrainTile(request, context, ...terrainMatch.slice(1).map(Number));
    }
    const transitMatch = url.pathname.match(/^\/api\/transit\/(rail|bus)\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (transitMatch) {
      return fetchTransitTile(request, context, transitMatch[1], ...transitMatch.slice(2).map(Number));
    }
    return environment.ASSETS.fetch(request);
  },
};
