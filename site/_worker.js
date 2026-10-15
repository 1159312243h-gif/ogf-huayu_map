const OGF_OVERPASS_URL = "https://overpass.opengeofiction.net/api/interpreter";
const BUILDING_TILE_ZOOMS = new Set([11, 12, 13, 14, 15]);
const BUILDING_CACHE_SECONDS = 10800;
const BUILDING_QUERY_TIMEOUT_MS = 30000;
const STRUCTURE_TILE_ZOOMS = BUILDING_TILE_ZOOMS;
const STRUCTURE_REFRESH_SECONDS = 10800;
const STRUCTURE_RETENTION_SECONDS = 604800;
const STRUCTURE_QUERY_TIMEOUT_MS = 20000;
const LIVE_BASEMAP_TILE_ZOOMS = new Set([13, 14, 15]);
const ROAD_OVERVIEW_TILE_ZOOMS = new Set([11, 12]);
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
const PERSONAL_SESSION_COOKIE = "huayu_session";
const PERSONAL_SESSION_SECONDS = 30 * 24 * 60 * 60;
// Workers currently caps PBKDF2 at 100,000 iterations.
const PERSONAL_PASSWORD_ITERATIONS = 100000;
const PERSONAL_MAX_JSON_BYTES = 64 * 1024;
const PERSONAL_MAX_IMAGE_BYTES = 768 * 1024;
const PERSONAL_MAX_OVERLAY_BYTES = 10 * 1024 * 1024;
const PERSONAL_MAX_OVERLAYS = 20;
const PERSONAL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const textEncoder = new TextEncoder();

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
  const clearanceWays = zoom >= 14
    ? `way["highway"](${bbox})->.pavilionClearanceWays;` : "";
  return `[out:json][timeout:15];way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;${clearanceWays}(`
    + `nwr["amenity"="shelter"]["shelter_type"~"^(gazebo|pavilion|picnic_shelter)$"](${bbox});`
    + `nwr["leisure"="gazebo"](${bbox});`
    + `nwr["man_made"~"^(gazebo|pavilion)$"](${bbox});nwr["building"~"^(gazebo|pavilion)$"](${bbox});`
    + `nwr["building:part"~"^(gazebo|pavilion)$"](${bbox});)->.pavilionStructures;`
    + `(.barrierWays;.pavilionStructures;way(r.pavilionStructures);`
    + `${zoom >= 14 ? ".pavilionClearanceWays;" : ""});out body geom;`;
}

function liveBasemapOverpassQuery(bounds, zoom) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  if (zoom < 13) {
    return `[out:json][timeout:45];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${bbox});`
      + `way["highway"]["layer"](${bbox});way["highway"]["bridge"]["bridge"!="no"](${bbox});)->.roads;`
      + `node(w.roads)->.roadNodes;way(bn.roadNodes)["highway"]->.approaches;(.roads;.approaches;);out body geom;`;
  }
  const highwaySelector = zoom <= 13
    ? `["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]` : `["highway"]`;
  const elevatedWays = zoom <= 13
    ? `way["highway"]["layer"](${bbox});way["highway"]["bridge"]["bridge"!="no"](${bbox});` : "";
  const treeNodes = zoom >= 15
    ? `node["natural"="tree"](${bbox})->.basemapTrees;` : "";
  const gardenNodes = zoom >= 15
    ? `(node["leisure"="garden"](${bbox});node["landuse"="flowerbed"](${bbox});)->.basemapGardens;` : "";
  return `[out:json][timeout:${zoom <= 13 ? 45 : 25}];(`
    + `way${highwaySelector}(${bbox});`
    + elevatedWays
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
    + gardenNodes
    + `(node["natural"~"^(peak|volcano)$"]["name"](${bbox});`
    + `node["amenity"="university"]["name"](${bbox});)->.basemapImportantLabels;`
    + `(.basemapWays;.basemapRelations;.basemapPlaces;${zoom >= 15 ? ".basemapTrees;.basemapGardens;" : ""}.basemapImportantLabels;`
    + `way(r.basemapRelations););out body geom;`;
}

function terrainOverpassQuery(bounds) {
  const latitudePad = 2000 / 111320;
  const longitudePad = latitudePad / Math.max(0.1,
    Math.cos(Math.max(Math.abs(bounds.south), Math.abs(bounds.north)) * Math.PI / 180));
  bounds = { south: Math.max(-85, bounds.south - latitudePad), north: Math.min(85, bounds.north + latitudePad),
    west: Math.max(-180, bounds.west - longitudePad), east: Math.min(180, bounds.east + longitudePad) };
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const namedRelief = `["name"~"高山|山地|山区|山坡|丘陵|荒原|alpine|upland|mountain|[山岭谷岳峰岗丘峦坡峡]$",i]`;
  return `[out:json][timeout:30];(`
    + `way["natural"="wood"](${bbox});`
    + `way["landuse"="forest"](${bbox});`
    + `way["natural"~"^(scrub|heath|fell|bare_rock|scree)$"](${bbox});`
    + `way["natural"="grassland"]${namedRelief}(${bbox});`
    + `way["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `way["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainWays;(`
    + `rel["type"="multipolygon"]["natural"="wood"](${bbox});`
    + `rel["type"="multipolygon"]["landuse"="forest"](${bbox});`
    + `rel["type"="multipolygon"]["natural"~"^(scrub|heath|fell|bare_rock|scree)$"](${bbox});`
    + `rel["type"="multipolygon"]["natural"="grassland"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainRelations;`
    + `(node["natural"~"^(peak|volcano|saddle)$"](${bbox});node["ele"](${bbox});)->.terrainPeaks;`
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
  const snapshot = LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z) || ROAD_OVERVIEW_TILE_ZOOMS.has(z);
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
  cacheUrl.searchParams.set("schema", "huayu-building-v6-material-roofs");
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
  cacheUrl.searchParams.set("schema", "huayu-structures-v3-tagged-pavilions");
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
    if (!LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z) && !ROAD_OVERVIEW_TILE_ZOOMS.has(z)) throw error;
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
  if ((!LIVE_BASEMAP_TILE_ZOOMS.has(z) && !ROAD_OVERVIEW_TILE_ZOOMS.has(z)) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_live_basemap_tile",
      requiredZooms: [...ROAD_OVERVIEW_TILE_ZOOMS, ...LIVE_BASEMAP_TILE_ZOOMS],
    }), 400);
  }

  const policy = liveBasemapCachePolicy(z);
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", z < 13 ? "huayu-road-overview-v1" : z === 13 ? "huayu-live-basemap-v10-elevated-roads"
    : z >= 15 ? "huayu-live-basemap-v9-garden-nodes" : "huayu-live-basemap-v8-progressive-terrain");
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
  cacheUrl.searchParams.set("schema", "huayu-terrain-v8-height-field");
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

function personalJson(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomToken(size = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value))));
}

async function hashPassword(password, saltHex, iterations = PERSONAL_PASSWORD_ITERATIONS) {
  const salt = new Uint8Array(String(saltHex).match(/.{1,2}/gu)?.map((value) => Number.parseInt(value, 16)) || []);
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return bytesToHex(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations,
  }, key, 256));
}

function constantTimeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0)
      ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  }
  return difference === 0;
}

function normalizeUsername(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateUsername(value) {
  const username = String(value || "").trim().normalize("NFKC");
  return /^[\p{L}\p{N}_-]{3,32}$/u.test(username) ? username : null;
}

function validatePassword(value) {
  const password = String(value || "");
  return password.length >= 10 && password.length <= 128 && password.trim().length >= 1;
}

function validateOverlayBounds(value) {
  const bounds = {
    west: Number(value?.west),
    south: Number(value?.south),
    east: Number(value?.east),
    north: Number(value?.north),
  };
  if (!Object.values(bounds).every(Number.isFinite)
    || bounds.west < -180 || bounds.east > 180 || bounds.south < -85 || bounds.north > 85
    || bounds.east - bounds.west < 0.000001 || bounds.north - bounds.south < 0.000001
    || bounds.east - bounds.west > 30 || bounds.north - bounds.south > 30) return null;
  return bounds;
}

function validImageSignature(bytes, type) {
  const data = new Uint8Array(bytes);
  if (type === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => data[index] === value);
  }
  if (type === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === "image/webp") {
    return String.fromCharCode(...data.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...data.slice(8, 12)) === "WEBP";
  }
  return false;
}

function d1BlobBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value);
  }
  return null;
}

function parseCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function sessionCookie(value, maxAge = PERSONAL_SESSION_SECONDS) {
  return `${PERSONAL_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function personalBindingsAvailable(environment) {
  return Boolean(environment?.DB);
}

function bootstrapAdminUsernames(environment) {
  return new Set(String(environment?.ADMIN_USERNAMES || "").split(",")
    .map(normalizeUsername).filter(Boolean));
}

function publicUser(user, environment) {
  const role = user?.role === "admin" || bootstrapAdminUsernames(environment).has(user?.username_normalized)
    ? "admin" : "user";
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role,
    createdAt: user.created_at,
  };
}

async function readJsonBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > PERSONAL_MAX_JSON_BYTES) throw Object.assign(new Error("payload_too_large"), { status: 413 });
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function sameOriginMutation(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function currentPersonalUser(request, environment) {
  const token = parseCookie(request, PERSONAL_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const user = await environment.DB.prepare(`SELECT users.*, sessions.id AS session_id
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ? AND users.disabled = 0`)
    .bind(tokenHash, now).first();
  if (!user) return null;
  user.session_id = tokenHash;
  return user;
}

async function requirePersonalUser(request, environment) {
  const user = await currentPersonalUser(request, environment);
  if (!user) throw Object.assign(new Error("authentication_required"), { status: 401 });
  return user;
}

async function createPersonalSession(environment, userId) {
  const token = randomToken();
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    environment.DB.prepare(`INSERT INTO sessions
      (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256Hex(token), userId, now, now + PERSONAL_SESSION_SECONDS * 1000),
  ]);
  return token;
}

function normalizedSearchHistory(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter((item) => {
    const key = item.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (!item || item.length > 200 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function normalizedFavorites(items) {
  const source = items && typeof items === "object" && !Array.isArray(items) ? items : {};
  return Object.entries(source).slice(0, 200).flatMap(([key, place]) => {
    const lat = Number(place?.lat);
    const lng = Number(place?.lng);
    if (!key || key.length > 100 || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 85 || Math.abs(lng) > 180) return [];
    return [[key, {
      lat,
      lng,
      zoom: Number.isFinite(Number(place.zoom)) ? Math.min(20, Math.max(1, Number(place.zoom))) : 13,
      label: String(place.label || "收藏地点").slice(0, 200),
    }]];
  });
}

async function personalDataForUser(environment, userId) {
  const [historyResult, favoriteResult, overlayResult] = await Promise.all([
    environment.DB.prepare(`SELECT query FROM search_history WHERE user_id = ?
      ORDER BY updated_at DESC LIMIT 10`).bind(userId).all(),
    environment.DB.prepare(`SELECT favorite_key, payload FROM favorites WHERE user_id = ?
      ORDER BY updated_at DESC LIMIT 200`).bind(userId).all(),
    environment.DB.prepare(`SELECT id, name, mime_type, byte_size, west, south, east, north,
      opacity, visible, created_at, updated_at FROM image_overlays WHERE user_id = ?
      ORDER BY created_at DESC`).bind(userId).all(),
  ]);
  const favorites = {};
  (favoriteResult.results || []).forEach((item) => {
    try { favorites[item.favorite_key] = JSON.parse(item.payload); } catch {}
  });
  return {
    searchHistory: (historyResult.results || []).map((item) => item.query),
    favorites,
    overlays: (overlayResult.results || []).map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.mime_type,
      byteSize: item.byte_size,
      bounds: { west: item.west, south: item.south, east: item.east, north: item.north },
      opacity: item.opacity,
      visible: Boolean(item.visible),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      imageUrl: `/api/overlays/${encodeURIComponent(item.id)}/image`,
    })),
  };
}

async function replaceSearchHistory(environment, userId, items) {
  const queries = normalizedSearchHistory(items);
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM search_history WHERE user_id = ?").bind(userId),
    ...queries.map((query, index) => environment.DB.prepare(`INSERT INTO search_history
      (user_id, query_key, query, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(userId, query.normalize("NFKC").toLocaleLowerCase("zh-CN"), query, now - index)),
  ]);
  return queries;
}

async function replaceFavorites(environment, userId, items) {
  const favorites = normalizedFavorites(items);
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM favorites WHERE user_id = ?").bind(userId),
    ...favorites.map(([key, place], index) => environment.DB.prepare(`INSERT INTO favorites
      (user_id, favorite_key, payload, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(userId, key, JSON.stringify(place), now - index)),
  ]);
  return Object.fromEntries(favorites);
}

async function mergePersonalData(environment, userId, payload) {
  const localHistory = normalizedSearchHistory(payload?.searchHistory);
  const localFavorites = normalizedFavorites(payload?.favorites);
  const now = Date.now();
  const statements = [];
  localHistory.forEach((query, index) => {
    statements.push(environment.DB.prepare(`INSERT INTO search_history
      (user_id, query_key, query, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, query_key) DO UPDATE SET query = excluded.query,
      updated_at = MAX(search_history.updated_at, excluded.updated_at)`)
      .bind(userId, query.normalize("NFKC").toLocaleLowerCase("zh-CN"), query, now - index));
  });
  localFavorites.forEach(([key, place], index) => {
    statements.push(environment.DB.prepare(`INSERT INTO favorites
      (user_id, favorite_key, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, favorite_key) DO UPDATE SET payload = excluded.payload,
      updated_at = MAX(favorites.updated_at, excluded.updated_at)`)
      .bind(userId, key, JSON.stringify(place), now - index));
  });
  if (statements.length) await environment.DB.batch(statements);
  return personalDataForUser(environment, userId);
}

async function deleteUserData(environment, userId) {
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM search_history WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM favorites WHERE user_id = ?").bind(userId),
    environment.DB.prepare(`DELETE FROM image_overlay_blobs WHERE overlay_id IN
      (SELECT id FROM image_overlays WHERE user_id = ?)`).bind(userId),
    environment.DB.prepare("DELETE FROM image_overlays WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
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

async function handleAuthApi(request, environment, url) {
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const user = await currentPersonalUser(request, environment);
    if (!user) return personalJson({ user: null }, 401);
    const data = await personalDataForUser(environment, user.id);
    return personalJson({ user: publicUser(user, environment), ...data });
  }
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const password = String(body.password || "");
    const displayName = String(body.displayName || username || "").trim().slice(0, 40);
    if (!username) return personalJson({ error: "invalid_username" }, 400);
    if (!validatePassword(password)) return personalJson({ error: "invalid_password" }, 400);
    const usernameNormalized = normalizeUsername(username);
    if (await environment.DB.prepare("SELECT id FROM users WHERE username_normalized = ?")
      .bind(usernameNormalized).first()) return personalJson({ error: "username_taken" }, 409);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = Date.now();
    const user = {
      id: crypto.randomUUID(), username, username_normalized: usernameNormalized,
      display_name: displayName || username, role: "user", created_at: now,
    };
    try {
      await environment.DB.prepare(`INSERT INTO users
        (id, username, username_normalized, display_name, password_salt, password_hash,
          password_iterations, role, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, ?, ?)`)
        .bind(user.id, user.username, user.username_normalized, user.display_name, salt,
          await hashPassword(password, salt), PERSONAL_PASSWORD_ITERATIONS, now, now).run();
    } catch (error) {
      if (/unique|constraint/iu.test(String(error?.message || error))) {
        return personalJson({ error: "username_taken" }, 409);
      }
      throw error;
    }
    const token = await createPersonalSession(environment, user.id);
    return personalJson({ user: publicUser(user, environment), searchHistory: [], favorites: {}, overlays: [] },
      201, { "Set-Cookie": sessionCookie(token) });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const usernameNormalized = normalizeUsername(body.username);
    const password = String(body.password || "");
    const user = await environment.DB.prepare("SELECT * FROM users WHERE username_normalized = ?")
      .bind(usernameNormalized).first();
    const fallbackSalt = "00000000000000000000000000000000";
    const candidate = await hashPassword(password, user?.password_salt || fallbackSalt,
      Number(user?.password_iterations) || PERSONAL_PASSWORD_ITERATIONS);
    if (!user || user.disabled || !constantTimeEqual(candidate, user.password_hash)) {
      return personalJson({ error: "invalid_credentials" }, 401);
    }
    const token = await createPersonalSession(environment, user.id);
    const data = await personalDataForUser(environment, user.id);
    return personalJson({ user: publicUser(user, environment), ...data }, 200,
      { "Set-Cookie": sessionCookie(token) });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookie(request, PERSONAL_SESSION_COOKIE);
    if (token) await environment.DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(await sha256Hex(token)).run();
    return personalJson({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return null;
}

async function handleAccountApi(request, environment, url) {
  if (url.pathname === "/api/account" && request.method === "PATCH") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    const displayName = String(body.displayName ?? user.display_name).trim().slice(0, 40);
    if (!displayName) return personalJson({ error: "invalid_display_name" }, 400);
    if (body.newPassword != null) {
      const currentCandidate = await hashPassword(String(body.currentPassword || ""), user.password_salt,
        Number(user.password_iterations));
      if (!constantTimeEqual(currentCandidate, user.password_hash)) {
        return personalJson({ error: "invalid_current_password" }, 403);
      }
      if (!validatePassword(body.newPassword)) return personalJson({ error: "invalid_password" }, 400);
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      await environment.DB.batch([
        environment.DB.prepare(`UPDATE users SET display_name = ?, password_salt = ?, password_hash = ?,
          password_iterations = ?, updated_at = ? WHERE id = ?`)
          .bind(displayName, salt, await hashPassword(String(body.newPassword), salt),
            PERSONAL_PASSWORD_ITERATIONS, Date.now(), user.id),
        environment.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?")
          .bind(user.id, user.session_id),
      ]);
    } else {
      await environment.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
        .bind(displayName, Date.now(), user.id).run();
    }
    user.display_name = displayName;
    return personalJson({ user: publicUser(user, environment) });
  }
  if (url.pathname === "/api/account" && request.method === "DELETE") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    const candidate = await hashPassword(String(body.password || ""), user.password_salt,
      Number(user.password_iterations));
    if (!constantTimeEqual(candidate, user.password_hash)) {
      return personalJson({ error: "invalid_current_password" }, 403);
    }
    await deleteUserData(environment, user.id);
    return personalJson({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return null;
}

async function handlePersonalDataApi(request, environment, url) {
  if (url.pathname === "/api/personal/sync" && request.method === "POST") {
    const user = await requirePersonalUser(request, environment);
    return personalJson(await mergePersonalData(environment, user.id, await readJsonBody(request)));
  }
  if (url.pathname === "/api/personal/search-history" && request.method === "PUT") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    return personalJson({ searchHistory: await replaceSearchHistory(environment, user.id, body.items) });
  }
  if (url.pathname === "/api/personal/favorites" && request.method === "PUT") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    return personalJson({ favorites: await replaceFavorites(environment, user.id, body.items) });
  }
  return null;
}

async function handleOverlayApi(request, environment, url) {
  const imageMatch = url.pathname.match(/^\/api\/overlays\/([^/]+)\/image$/u);
  if (imageMatch && request.method === "GET") {
    const user = await requirePersonalUser(request, environment);
    const overlay = await environment.DB.prepare(`SELECT image_overlays.mime_type, image_overlays.byte_size,
      image_overlays.updated_at, image_overlay_blobs.image_data FROM image_overlays
      JOIN image_overlay_blobs ON image_overlay_blobs.overlay_id = image_overlays.id
      WHERE image_overlays.id = ? AND image_overlays.user_id = ?`)
      .bind(decodeURIComponent(imageMatch[1]), user.id).first();
    if (!overlay) return personalJson({ error: "overlay_not_found" }, 404);
    const image = d1BlobBytes(overlay.image_data);
    if (!image) return personalJson({ error: "image_not_found" }, 404);
    if (image.byteLength !== Number(overlay.byte_size)) {
      return personalJson({ error: "image_storage_corrupt" }, 500);
    }
    const headers = new Headers({
      "Content-Type": overlay.mime_type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(overlay.byte_size),
      "ETag": `W/\"${encodeURIComponent(imageMatch[1])}-${overlay.updated_at}-${overlay.byte_size}\"`,
    });
    return new Response(image, { headers });
  }
  if (url.pathname === "/api/overlays" && request.method === "GET") {
    const user = await requirePersonalUser(request, environment);
    return personalJson({ overlays: (await personalDataForUser(environment, user.id)).overlays });
  }
  if (url.pathname === "/api/overlays" && request.method === "POST") {
    const user = await requirePersonalUser(request, environment);
    const usage = await environment.DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(byte_size), 0) AS bytes FROM image_overlays WHERE user_id = ?`)
      .bind(user.id).first();
    if (Number(usage?.total || 0) >= PERSONAL_MAX_OVERLAYS) {
      return personalJson({ error: "overlay_limit_reached" }, 409);
    }
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > PERSONAL_MAX_IMAGE_BYTES + 128 * 1024) {
      return personalJson({ error: "image_too_large" }, 413);
    }
    const form = await request.formData();
    const image = form.get("image");
    if (!image || typeof image.arrayBuffer !== "function" || !PERSONAL_IMAGE_TYPES.has(image.type)) {
      return personalJson({ error: "invalid_image" }, 400);
    }
    if (image.size <= 0 || image.size > PERSONAL_MAX_IMAGE_BYTES) {
      return personalJson({ error: "image_too_large" }, 413);
    }
    const bounds = validateOverlayBounds({
      west: form.get("west"), south: form.get("south"), east: form.get("east"), north: form.get("north"),
    });
    if (!bounds) return personalJson({ error: "invalid_bounds" }, 400);
    const opacity = Math.min(1, Math.max(0.1, Number(form.get("opacity")) || 0.75));
    const id = crypto.randomUUID();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[image.type];
    const objectKey = `users/${user.id}/overlays/${id}.${extension}`;
    const name = String(form.get("name") || image.name || "地图贴图").trim().slice(0, 100) || "地图贴图";
    const bytes = await image.arrayBuffer();
    if (!validImageSignature(bytes, image.type)) return personalJson({ error: "invalid_image" }, 400);
    if (Number(usage?.bytes || 0) + image.size > PERSONAL_MAX_OVERLAY_BYTES) {
      return personalJson({ error: "overlay_storage_limit_reached" }, 409);
    }
    const now = Date.now();
    await environment.DB.batch([
      environment.DB.prepare(`INSERT INTO image_overlays
        (id, user_id, name, object_key, mime_type, byte_size, west, south, east, north,
          opacity, visible, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, user.id, name, objectKey, image.type, image.size, bounds.west, bounds.south,
          bounds.east, bounds.north, opacity, now, now),
      environment.DB.prepare(`INSERT INTO image_overlay_blobs (overlay_id, image_data)
        VALUES (?, ?)`).bind(id, bytes),
    ]);
    return personalJson({ overlay: {
      id, name, mimeType: image.type, byteSize: image.size, bounds, opacity, visible: true,
      createdAt: now, updatedAt: now, imageUrl: `/api/overlays/${encodeURIComponent(id)}/image`,
    } }, 201);
  }
  const overlayMatch = url.pathname.match(/^\/api\/overlays\/([^/]+)$/u);
  if (overlayMatch && request.method === "PATCH") {
    const user = await requirePersonalUser(request, environment);
    const id = decodeURIComponent(overlayMatch[1]);
    const existing = await environment.DB.prepare("SELECT * FROM image_overlays WHERE id = ? AND user_id = ?")
      .bind(id, user.id).first();
    if (!existing) return personalJson({ error: "overlay_not_found" }, 404);
    const body = await readJsonBody(request);
    const name = body.name == null ? existing.name : String(body.name).trim().slice(0, 100);
    const opacity = body.opacity == null ? existing.opacity : Math.min(1, Math.max(0.1, Number(body.opacity)));
    const visible = body.visible == null ? existing.visible : Number(Boolean(body.visible));
    if (!name || !Number.isFinite(opacity)) return personalJson({ error: "invalid_overlay" }, 400);
    const now = Date.now();
    await environment.DB.prepare(`UPDATE image_overlays SET name = ?, opacity = ?, visible = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`).bind(name, opacity, visible, now, id, user.id).run();
    return personalJson({ ok: true, updatedAt: now });
  }
  if (overlayMatch && request.method === "DELETE") {
    const user = await requirePersonalUser(request, environment);
    const id = decodeURIComponent(overlayMatch[1]);
    const existing = await environment.DB.prepare(`SELECT id FROM image_overlays
      WHERE id = ? AND user_id = ?`).bind(id, user.id).first();
    if (!existing) return personalJson({ error: "overlay_not_found" }, 404);
    await environment.DB.batch([
      environment.DB.prepare("DELETE FROM image_overlay_blobs WHERE overlay_id = ?").bind(id),
      environment.DB.prepare("DELETE FROM image_overlays WHERE id = ? AND user_id = ?").bind(id, user.id),
    ]);
    return personalJson({ ok: true });
  }
  return null;
}

async function handleAdminApi(request, environment, url) {
  if (!url.pathname.startsWith("/api/admin/")) return null;
  const admin = await requirePersonalUser(request, environment);
  if (publicUser(admin, environment).role !== "admin") {
    return personalJson({ error: "administrator_required" }, 403);
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const result = await environment.DB.prepare(`SELECT users.id, users.username, users.username_normalized,
      users.display_name, users.role, users.disabled, users.created_at,
      (SELECT COUNT(*) FROM search_history WHERE user_id = users.id) AS search_count,
      (SELECT COUNT(*) FROM favorites WHERE user_id = users.id) AS favorite_count,
      (SELECT COUNT(*) FROM image_overlays WHERE user_id = users.id) AS overlay_count
      FROM users ORDER BY users.created_at DESC LIMIT 500`).all();
    return personalJson({ users: (result.results || []).map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: publicUser(user, environment).role,
      disabled: Boolean(user.disabled),
      createdAt: user.created_at,
      searchCount: user.search_count,
      favoriteCount: user.favorite_count,
      overlayCount: user.overlay_count,
    })) });
  }
  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/u);
  if (match && request.method === "PATCH") {
    const id = decodeURIComponent(match[1]);
    const body = await readJsonBody(request);
    if (id === admin.id && (body.disabled === true || body.role === "user")) {
      return personalJson({ error: "cannot_lock_current_admin" }, 409);
    }
    const target = await environment.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
    if (!target) return personalJson({ error: "user_not_found" }, 404);
    const statements = [];
    if (body.disabled != null) statements.push(environment.DB.prepare(
      "UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?",
    ).bind(Number(Boolean(body.disabled)), Date.now(), id));
    if (["user", "admin"].includes(body.role)) statements.push(environment.DB.prepare(
      "UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
    ).bind(body.role, Date.now(), id));
    if (!statements.length) return personalJson({ error: "invalid_user_update" }, 400);
    await environment.DB.batch(statements);
    if (body.disabled === true) await environment.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    return personalJson({ ok: true });
  }
  if (match && request.method === "DELETE") {
    const id = decodeURIComponent(match[1]);
    if (id === admin.id) return personalJson({ error: "cannot_delete_current_admin" }, 409);
    if (!await environment.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first()) {
      return personalJson({ error: "user_not_found" }, 404);
    }
    await deleteUserData(environment, id);
    return personalJson({ ok: true });
  }
  return null;
}

async function handlePersonalApi(request, environment) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/account"
    && !url.pathname.startsWith("/api/personal/") && !url.pathname.startsWith("/api/overlays")
    && !url.pathname.startsWith("/api/admin/")) return null;
  if (!personalBindingsAvailable(environment)) {
    return personalJson({ error: "personal_data_service_not_configured" }, 503);
  }
  if (!sameOriginMutation(request)) return personalJson({ error: "cross_origin_request_blocked" }, 403);
  try {
    return await handleAuthApi(request, environment, url)
      || await handleAccountApi(request, environment, url)
      || await handlePersonalDataApi(request, environment, url)
      || await handleOverlayApi(request, environment, url)
      || await handleAdminApi(request, environment, url)
      || personalJson({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("Personal data API failure", error);
    return personalJson({ error: status >= 500 ? "personal_data_failure" : String(error?.message || "request_failed") }, status);
  }
}

export {
  hashPassword,
  parseCookie,
  validateOverlayBounds,
  validatePassword,
  validateUsername,
  validImageSignature,
};

export default {
  async fetch(request, environment, context) {
    const url = new URL(request.url);
    const personalResponse = await handlePersonalApi(request, environment);
    if (personalResponse) return personalResponse;
    if (url.pathname === "/terrain-preload.json.gz"
      || (["/terrain-preload-chunks/", "/terrain-render-cache/"].some(prefix => url.pathname.startsWith(prefix))
        && url.pathname.endsWith(".json.gz"))) {
      const asset = await environment.ASSETS.fetch(request);
      if (asset.status !== 200) return asset;
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "application/json; charset=UTF-8");
      headers.set("Content-Encoding", "gzip");
      headers.set("Cache-Control", url.pathname !== "/terrain-preload.json.gz"
        ? "public, max-age=31536000, immutable, no-transform"
        : "public, max-age=300, must-revalidate, no-transform");
      // The asset body already contains gzip bytes. Do not gzip it again.
      return new Response(asset.body, { status: asset.status, headers, encodeBody: "manual" });
    }
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
