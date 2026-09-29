const { mkdir, readFile, writeFile } = require("node:fs/promises");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const target = "outputs/ogf-atlas/transit-preload.json";
const refreshCacheDirectory = "work/huaxia-transit-refresh-cache";
const useRefreshCache = process.argv.includes("--resume");
const relationOnly = process.argv.includes("--relation-only");
const countryBounds = [[2.9833913, 139.6123328], [37.2533652, 166.8539534]];
const railRouteTypes = new Set(["subway", "light_rail", "tram", "monorail", "train"]);
const namedTrackTypes = new Set(["subway", "light_rail", "tram", "monorail"]);
const countryLongitudeSlices = [
  [2.9833913, 139.6123328, 37.2533652, 146.5],
  [2.9833913, 146.5, 37.2533652, 153.5],
  [2.9833913, 153.5, 37.2533652, 160.5],
  [2.9833913, 160.5, 37.2533652, 166.8539534],
];
const railwayLongitudeBreaks = [139.6123328, 143, 146.5, 150, 153.5, 157, 160.5, 164, 166.8539534];
const railwayLatitudeBreaks = [2.9833913, 12, 21, 30, 37.2533652];
const railwaySpatialSlices = railwayLatitudeBreaks.slice(0, -1).flatMap((south, latitudeIndex) =>
  railwayLongitudeBreaks.slice(0, -1).map((west, longitudeIndex) => [
    south,
    west,
    railwayLatitudeBreaks[latitudeIndex + 1],
    railwayLongitudeBreaks[longitudeIndex + 1],
  ]));
const SYNTHETIC_STATION_STUB_MAX_METERS = 600;
const DISTINCT_STATION_AREA_METERS = 350;
// Named railway ways are useful as a fallback when OGF has not drawn a
// relation, but depot and test-facility tracks must never become passenger
// routes merely because they carry a name or pass near a station.
const NON_OPERATIONAL_RAIL_NAME = /(折返|回库|车场|车辆段|存车|停车线|出入段|联络线|试车线|检修线|工程线|引入线|渡线|洗车线|卸车线|调车线|备用线|安全线|咽喉线|入库线|出库线|返空线|turn[- ]?back|stabling|depot|yard|siding|crossover|test\s*track|maintenance|engineering|access\s*track|wash\s*track|storage\s*track)/iu;
const relationQuery = (routeType) => `[out:json][timeout:180];rel(28652);map_to_area->.country;
  rel["type"="route"]["route"="${routeType}"](area.country)->.railRoutes;
  rel(br.railRoutes)["type"="route_master"]->.railMasters;
  (rel(br.railRoutes)["type"="collection"];rel(br.railMasters)["type"="collection"];)->.fareCollections1;
  rel(br.fareCollections1)["type"="collection"]->.fareCollections2;
  rel(br.fareCollections2)["type"="collection"]->.fareCollections3;
  rel(br.fareCollections3)["type"="collection"]->.fareCollections4;
  (.railRoutes;.railMasters;.fareCollections1;.fareCollections2;.fareCollections3;.fareCollections4;)->.railRelations;
  way(r.railRoutes)->.railWays;
  node(r.railRoutes)->.railStops;
  .railRelations out body center;.railWays out body geom;.railStops out body;`;
const stationQuery = `[out:json][timeout:180];rel(28652);map_to_area->.country;
  (nwr["railway"~"^(station|halt|tram_stop)$"]["name"](area.country);nwr["station"="subway"]["name"](area.country);nwr["subway"="yes"]["name"](area.country););out body center;`;

async function fetchElements(query, label) {
  const cachePath = `${refreshCacheDirectory}/${label.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/g, "")}.json`;
  if (useRefreshCache) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      if (Array.isArray(cached.elements)) {
        console.log(`Using cached ${label}: ${cached.elements.length} elements`);
        return cached.elements;
      }
    } catch {}
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`Fetching ${label}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(210000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${label} ${response.status}: ${body.slice(0, 800)}`);
      const payload = JSON.parse(body);
      const allowsEmptyTrackSlice = label.startsWith("non-service ") && label.includes(" tracks ");
      if (payload.remark || !Array.isArray(payload.elements)
        || (!payload.elements.length && !allowsEmptyTrackSlice)) {
        throw new Error(payload.remark || `${label} response is empty`);
      }
      const elements = payload.elements;
      await mkdir(refreshCacheDirectory, { recursive: true });
      await writeFile(cachePath, JSON.stringify({ generatedAt: new Date().toISOString(), query, elements }));
      console.log(`Fetched ${label}: ${elements.length} elements`);
      return elements;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      console.warn(`${label} attempt ${attempt} failed: ${error.message}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

function normalizeName(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN").replaceAll(" ", "");
}

function inferRef(name) {
  const chinese = String(name).match(/(?:地铁|地鐵|轨道交通|軌道交通|捷运|捷運|轻轨|輕軌)\s*([a-z]?\d+|[一二三四五六七八九十]+)\s*号?线/iu);
  if (chinese) return chinese[1].toUpperCase();
  const english = String(name).match(/\b(?:line|route)\s*([a-z]?\d+|[a-z])\b/iu);
  return english ? english[1].toUpperCase() : "";
}

function routeTypeForWay(way) {
  const type = way.tags?.railway;
  return namedTrackTypes.has(type) ? type : null;
}

function isNonOperationalRailFacility(item) {
  const tags = item?.tags || {};
  const name = String(tags.name || tags.ref || "").trim();
  if (NON_OPERATIONAL_RAIL_NAME.test(name)) return true;
  if (String(tags.service || "").trim()) return true;
  if (/^(?:depot|yard|siding|spur|crossover|test|maintenance|engineering)$/iu.test(String(tags.usage || "").trim())) return true;
  if (["construction", "proposed", "disused", "abandoned", "razed"].includes(String(tags.railway || "").trim().toLowerCase())) return true;
  return String(tags.public_transport || "").trim().toLowerCase() === "no";
}

function isNonOperationalRailRelation(relation) {
  const tags = relation?.tags || {};
  if (relation?.type !== "relation" || !railRouteTypes.has(tags.route)) return false;
  const hasPassengerStop = (relation.members || []).some((member) => member.type === "node"
    && /^(?:stop|platform|station|stop_entry|stop_exit)$/iu.test(String(member.role || "")));
  const synthetic = tags["ogf_atlas:source"] === "named_railway_ways";
  const name = String(tags.name || tags.ref || "").trim();
  if (synthetic && (NON_OPERATIONAL_RAIL_NAME.test(name)
    || String(tags.service || "").trim()
    || String(tags.public_transport || "").trim().toLowerCase() === "no")) return true;
  if (NON_OPERATIONAL_RAIL_NAME.test(name) && !hasPassengerStop) return true;
  if (!hasPassengerStop && /^(?:depot|yard|siding|spur|crossover|test|maintenance|engineering)$/iu.test(String(tags.usage || "").trim())) return true;
  return false;
}

function distanceToSegmentMeters(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = Math.cos((point.lat * Math.PI) / 180) * latitudeScale;
  const px = point.lon * longitudeScale;
  const py = point.lat * latitudeScale;
  const ax = start.lon * longitudeScale;
  const ay = start.lat * latitudeScale;
  const bx = end.lon * longitudeScale;
  const by = end.lat * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function pointDistanceMeters(first, second) {
  const latitudeScale = 111320;
  const meanLatitude = ((first.lat + second.lat) / 2 * Math.PI) / 180;
  return Math.hypot(
    (first.lon - second.lon) * Math.cos(meanLatitude) * latitudeScale,
    (first.lat - second.lat) * latitudeScale,
  );
}

function trackLengthMeters(ways) {
  return ways.reduce((sum, way) => sum + (way.geometry || []).slice(1)
    .reduce((length, point, index) => length + pointDistanceMeters(way.geometry[index], point), 0), 0);
}

function isStationNearWays(station, ways, bounds) {
  const padding = 0.003;
  if (station.lat < bounds.south - padding || station.lat > bounds.north + padding
    || station.lon < bounds.west - padding || station.lon > bounds.east + padding) return false;
  return ways.some((way) => {
    const geometry = way.geometry || [];
    for (let index = 1; index < geometry.length; index += 1) {
      if (distanceToSegmentMeters(station, geometry[index - 1], geometry[index]) <= 220) return true;
    }
    return false;
  });
}

function synthesizeNamedRailRoutes(elements) {
  const relations = elements.filter((item) => item.type === "relation");
  const memberWayIds = new Set(relations.flatMap((relation) => (relation.members || [])
    .filter((member) => member.type === "way")
    .map((member) => member.ref)));
  const existingNames = relations.map((relation) => normalizeName(relation.tags?.name)).filter(Boolean);
  const formalRailStopIds = new Set(relations.filter((relation) => railRouteTypes.has(relation.tags?.route)
    && !relation.tags?.["ogf_atlas:source"]).flatMap((relation) => (relation.members || [])
    .filter((member) => member.type === "node").map((member) => member.ref)));
  const stations = elements.filter((item) => item.type === "node" && Number.isFinite(item.lat) && Number.isFinite(item.lon));
  const groups = new Map();

  elements.forEach((item) => {
    const routeType = item.type === "way" ? routeTypeForWay(item) : null;
    const name = String(item.tags?.name || "").trim();
    if (!routeType || !name || memberWayIds.has(item.id) || isNonOperationalRailFacility(item)) return;
    const normalizedName = normalizeName(name);
    if (existingNames.some((existing) => existing.includes(normalizedName) || normalizedName.includes(existing))) return;
    const key = `${routeType}:${normalizedName}`;
    if (!groups.has(key)) groups.set(key, { routeType, name, ways: [] });
    groups.get(key).ways.push(item);
  });

  return [...groups.values()].map((group, index) => {
    const points = group.ways.flatMap((way) => way.geometry || []);
    const bounds = points.reduce((result, point) => ({
      south: Math.min(result.south, point.lat),
      north: Math.max(result.north, point.lat),
      west: Math.min(result.west, point.lon),
      east: Math.max(result.east, point.lon),
    }), { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity });
    const nearbyStations = stations.filter((station) => isStationNearWays(station, group.ways, bounds));
    let maximumStationSeparation = 0;
    nearbyStations.forEach((station, first) => nearbyStations.slice(first + 1).forEach((other) => {
      maximumStationSeparation = Math.max(maximumStationSeparation, pointDistanceMeters(station, other));
    }));
    const formalCoverage = nearbyStations.length
      ? nearbyStations.filter((station) => formalRailStopIds.has(station.id)).length / nearbyStations.length : 0;
    const displayOnly = trackLengthMeters(group.ways) < SYNTHETIC_STATION_STUB_MAX_METERS
      && maximumStationSeparation < DISTINCT_STATION_AREA_METERS && formalCoverage >= 0.5;
    const sourceTags = group.ways.find((way) => way.tags?.operator || way.tags?.network || way.tags?.colour)?.tags || group.ways[0].tags || {};
    return {
      type: "relation",
      id: -(index + 1),
      center: points.length ? {
        lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
        lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length,
      } : undefined,
      members: [
        ...group.ways.map((way) => ({ type: "way", ref: way.id, role: "" })),
        ...nearbyStations.map((station) => ({ type: "node", ref: station.id, role: "stop" })),
      ],
      tags: {
        type: "route",
        route: group.routeType,
        name: group.name,
        ref: sourceTags.ref || inferRef(group.name),
        operator: sourceTags.operator || "",
        network: sourceTags.network || "",
        colour: sourceTags.colour || sourceTags.color || "",
        "ogf_atlas:source": "named_railway_ways",
        ...(displayOnly ? { "ogf_atlas:display_only": "station_marker" } : {}),
      },
    };
  }).filter((relation) => relation?.members.some((member) => member.type === "way"));
}

function stationMode(station) {
  const tags = station.tags || {};
  if (tags.monorail === "yes" || tags.railway === "monorail") return "monorail";
  if (tags.light_rail === "yes" || tags.railway === "light_rail") return "light_rail";
  if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
  if (tags.station === "subway" || tags.subway === "yes" || tags.railway === "subway") return "subway";
  return "train";
}

function synthesizeStationSupportedUrbanRailRoutes(elements, idOffset = 0) {
  const relations = elements.filter((item) => item.type === "relation");
  const memberWayIds = new Set(relations.flatMap((relation) => (relation.members || [])
    .filter((member) => member.type === "way").map((member) => member.ref)));
  const ways = elements.filter((item) => item.type === "way"
    && namedTrackTypes.has(item.tags?.railway)
    && !memberWayIds.has(item.id)
    && Array.isArray(item.geometry) && item.geometry.length > 1
    && !isNonOperationalRailFacility(item));
  const stations = elements.filter((item) => item.type === "node"
    && Number.isFinite(item.lat) && Number.isFinite(item.lon)
    && String(item.tags?.name || "").trim()
    && stationMode(item) !== "train");
  const parent = ways.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const unite = (first, second) => {
    const a = find(first);
    const b = find(second);
    if (a !== b) parent[b] = a;
  };
  const nodes = new Map();
  ways.forEach((way, index) => {
    (way.nodes || []).forEach((node) => {
      const key = `${way.tags?.railway}:${node}`;
      if (nodes.has(key)) unite(index, nodes.get(key));
      else nodes.set(key, index);
    });
  });
  const componentMap = new Map();
  ways.forEach((way, index) => {
    const root = find(index);
    if (!componentMap.has(root)) componentMap.set(root, []);
    componentMap.get(root).push(way);
  });
  const components = [...componentMap.values()].map((componentWays) => {
    const mode = componentWays[0].tags?.railway;
    const points = componentWays.flatMap((way) => way.geometry || []);
    const bounds = points.reduce((result, point) => ({
      south: Math.min(result.south, point.lat), north: Math.max(result.north, point.lat),
      west: Math.min(result.west, point.lon), east: Math.max(result.east, point.lon),
    }), { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity });
    const nearbyStations = stations.filter((station) => stationMode(station) === mode
      && isStationNearWays(station, componentWays, bounds));
    const stationNames = [...new Set(nearbyStations.map((station) => normalizeName(station.tags?.name)).filter(Boolean))];
    return { mode, ways: componentWays, nearbyStations, stationNames };
  }).filter((component) => component.stationNames.length >= 2);

  // Two tracks of the same route are often mapped as separate components.
  // Shared station names are the evidence used to merge them without joining
  // unrelated nearby corridors.
  const componentParents = components.map((_, index) => index);
  const findComponent = (index) => componentParents[index] === index
    ? index : (componentParents[index] = findComponent(componentParents[index]));
  const uniteComponents = (first, second) => {
    const a = findComponent(first);
    const b = findComponent(second);
    if (a !== b) componentParents[b] = a;
  };
  for (let first = 0; first < components.length; first += 1) {
    for (let second = first + 1; second < components.length; second += 1) {
      if (components[first].mode !== components[second].mode) continue;
      const shared = components[first].stationNames.filter((name) => components[second].stationNames.includes(name));
      if (shared.length >= 2) uniteComponents(first, second);
    }
  }
  const systems = new Map();
  components.forEach((component, index) => {
    const root = findComponent(index);
    if (!systems.has(root)) systems.set(root, []);
    systems.get(root).push(component);
  });
  return [...systems.values()].map((system, index) => {
    const systemWays = [...new Map(system.flatMap((component) => component.ways).map((way) => [way.id, way])).values()];
    const nearbyStations = [...new Map(system.flatMap((component) => component.nearbyStations)
      .map((station) => [station.id, station])).values()];
    const mode = system[0].mode;
    const namedWay = systemWays.find((way) => String(way.tags?.name || "").trim());
    const label = String(namedWay?.tags?.name || ({
      subway: "地铁基础设施", light_rail: "轻轨基础设施",
      tram: "有轨电车基础设施", monorail: "单轨基础设施",
    }[mode] || "城市轨道基础设施")).trim();
    return {
      type: "relation",
      id: -(idOffset + index + 1),
      members: [
        ...systemWays.map((way) => ({ type: "way", ref: way.id, role: "" })),
        ...nearbyStations.map((station) => ({ type: "node", ref: station.id, role: "stop" })),
      ],
      tags: {
        type: "route", route: mode, name: label,
        "ogf_atlas:source": "station_supported_urban_rail_infrastructure",
      },
    };
  });
}

function normalizeStationElements(elements) {
  let syntheticNodeId = -1000000000;
  return elements.map((item) => {
    if (item.type === "node") return item;
    if (!Number.isFinite(item.center?.lat) || !Number.isFinite(item.center?.lon)) return null;
    return {
      type: "node",
      id: syntheticNodeId--,
      lat: item.center.lat,
      lon: item.center.lon,
      tags: {
        ...(item.tags || {}),
        "ogf_atlas:source": `${item.type}:${item.id}`,
      },
    };
  }).filter(Boolean);
}

function railEndpointKey(point) {
  return `${Number(point.lat).toFixed(7)},${Number(point.lon).toFixed(7)}`;
}

function simplifyRailGeometry(geometry, tolerance = 0.000006) {
  if (geometry.length <= 2) return geometry;
  const keep = new Uint8Array(geometry.length);
  const stack = [[0, geometry.length - 1]];
  const toleranceSquared = tolerance * tolerance;
  keep[0] = 1;
  keep[geometry.length - 1] = 1;

  while (stack.length) {
    const [startIndex, endIndex] = stack.pop();
    const start = geometry[startIndex];
    const end = geometry[endIndex];
    const dx = end.lon - start.lon;
    const dy = end.lat - start.lat;
    const denominator = dx * dx + dy * dy;
    let farthestIndex = -1;
    let farthestDistance = 0;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const point = geometry[index];
      const ratio = denominator
        ? Math.max(0, Math.min(1, ((point.lon - start.lon) * dx + (point.lat - start.lat) * dy) / denominator))
        : 0;
      const offsetX = point.lon - (start.lon + ratio * dx);
      const offsetY = point.lat - (start.lat + ratio * dy);
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex < 0 || farthestDistance <= toleranceSquared) continue;
    keep[farthestIndex] = 1;
    stack.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
  }

  return geometry.filter((_, index) => keep[index]);
}

function buildRailInfrastructure(ways, excludedWayIds) {
  const tracks = ways
    .filter((way) => !excludedWayIds.has(way.id) && Array.isArray(way.geometry) && way.geometry.length > 1)
    .map((way) => ({
      id: way.id,
      name: String(way.tags?.name || "").trim(),
      geometry: way.geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
    }));
  const endpoints = new Map();
  tracks.forEach((track, index) => {
    [track.geometry[0], track.geometry.at(-1)].forEach((point) => {
      const key = railEndpointKey(point);
      if (!endpoints.has(key)) endpoints.set(key, []);
      endpoints.get(key).push(index);
    });
  });

  const unused = new Set(tracks.map((_, index) => index));
  const lines = [];
  tracks.forEach((seed, seedIndex) => {
    if (!unused.delete(seedIndex)) return;
    let geometry = [...seed.geometry];
    const names = new Set(seed.name ? [seed.name] : []);
    let sourceCount = 1;

    const extend = (prepend) => {
      while (true) {
        const endpoint = prepend ? geometry[0] : geometry.at(-1);
        const endpointKey = railEndpointKey(endpoint);
        const nextIndex = (endpoints.get(endpointKey) || []).find((index) => unused.has(index));
        if (nextIndex === undefined) return;
        unused.delete(nextIndex);
        const next = tracks[nextIndex];
        if (next.name) names.add(next.name);
        sourceCount += 1;
        const firstMatches = railEndpointKey(next.geometry[0]) === endpointKey;
        if (prepend) {
          geometry = firstMatches
            ? [...next.geometry.slice(1).reverse(), ...geometry]
            : [...next.geometry.slice(0, -1), ...geometry];
        } else {
          geometry = firstMatches
            ? [...geometry, ...next.geometry.slice(1)]
            : [...geometry, ...next.geometry.slice(0, -1).reverse()];
        }
      }
    };

    extend(false);
    extend(true);
    const simplified = simplifyRailGeometry(geometry);
    const bbox = simplified.reduce((result, point) => [
      Math.min(result[0], point.lat),
      Math.min(result[1], point.lon),
      Math.max(result[2], point.lat),
      Math.max(result[3], point.lon),
    ], [Infinity, Infinity, -Infinity, -Infinity]);
    lines.push({
      id: `rail-infrastructure-${seed.id}`,
      name: names.size === 1 ? [...names][0] : "铁路",
      geometry: simplified,
      bbox,
      sourceCount,
    });
  });
  return lines;
}

(async () => {
  const batches = [];
  for (const routeType of railRouteTypes) {
    batches.push(await fetchElements(relationQuery(routeType), `standard ${routeType} route relations`));
  }
  for (const trackType of namedTrackTypes) {
    for (const [sliceIndex, bounds] of countryLongitudeSlices.entries()) {
      const urbanTrackQuery = `[out:json][timeout:180];rel(28652);map_to_area->.country;
        way["railway"="${trackType}"][!"service"](area.country)(${bounds.join(",")});out body geom;`;
      batches.push(await fetchElements(
        urbanTrackQuery,
        `non-service ${trackType} tracks ${sliceIndex + 1}/${countryLongitudeSlices.length}`,
      ));
    }
  }
  batches.push(normalizeStationElements(await fetchElements(stationQuery, "rail stations")));
  const railwayTrackBatches = [];
  for (const [sliceIndex, bounds] of railwaySpatialSlices.entries()) {
    const railwayTrackQuery = `[out:json][timeout:180];rel(28652);map_to_area->.country;
      way["railway"~"^(rail|narrow_gauge)$"][!"service"](area.country)(${bounds.join(",")});out body geom;`;
    railwayTrackBatches.push(await fetchElements(
      railwayTrackQuery,
      `non-service railway tracks ${sliceIndex + 1}/${railwaySpatialSlices.length}`,
    ));
  }
  const railwayTracks = [...new Map(railwayTrackBatches.flat()
    .map((item) => [`${item.type}:${item.id}`, item])).values()];
  await writeFile("work/huaxia-nonservice-railways-raw.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: endpoint,
    query: "railway=rail|narrow_gauge and no service tag, merged from 32 spatial slices",
    elements: railwayTracks,
  }));
  const sourceElements = [...new Map(batches.flat().map((item) => [`${item.type}:${item.id}`, item])).values()]
    .filter((item) => !isNonOperationalRailRelation(item));
  const namedSyntheticRelations = synthesizeNamedRailRoutes(sourceElements);
  const infrastructureSyntheticRelations = synthesizeStationSupportedUrbanRailRoutes(
    [...sourceElements, ...namedSyntheticRelations],
    namedSyntheticRelations.length,
  );
  const syntheticRelations = [...namedSyntheticRelations, ...infrastructureSyntheticRelations];
  const elements = [...sourceElements, ...syntheticRelations];
  const relationWayIds = new Set(elements
    .filter((item) => item.type === "relation")
    .flatMap((relation) => (relation.members || [])
      .filter((member) => member.type === "way")
      .map((member) => member.ref)));
  const railInfrastructure = buildRailInfrastructure(railwayTracks, relationWayIds);
  const payload = {
    generatedAt: new Date().toISOString(),
    snapshots: [{
      id: "huaxia",
      label: "华夏共和国",
      bounds: countryBounds,
      elements,
      ...(relationOnly ? {} : { railInfrastructure }),
    }],
  };
  const serialized = JSON.stringify(payload);
  await writeFile(target, serialized);
  const counts = elements.reduce((result, item) => {
    result[item.type] = (result[item.type] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({
    target,
    relationOnly,
    bytes: Buffer.byteLength(serialized),
    counts,
    syntheticRoutes: syntheticRelations.length,
    stationSupportedInfrastructureRoutes: infrastructureSyntheticRelations.length,
    railwayInfrastructure: {
      sourceWays: railwayTracks.length,
      renderedLines: railInfrastructure.length,
      renderedPoints: railInfrastructure.reduce((sum, line) => sum + line.geometry.length, 0),
    },
    sampleSyntheticRoutes: syntheticRelations.slice(0, 20).map((relation) => relation.tags.name),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
