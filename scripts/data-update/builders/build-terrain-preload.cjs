const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const {createHash} = require("node:crypto");
const {gzipSync} = require("node:zlib");

// Use the application classification and Worker query, so scheduled refreshes
// retain named small hills, landscaped hills, open highlands and park exclusions.
async function terrainRuntime(siteDirectory) {
  const app = await fs.readFile(path.join(siteDirectory, "app.js"), "utf8");
  const worker = await fs.readFile(path.join(siteDirectory, "_worker.js"), "utf8");
  const context = vm.createContext({
    clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
    HUAYU_IMPORTANT_LABEL_ANCHORS: new Map(),
    huayuSportKind: () => "", huayuLiveBasemapSportsProperties: () => ({}),
    huayuSupplementalElementCenter: () => null,
  });
  for (const name of ["HUAYU_MOUNTAIN_WOODLAND_MIN_AREA", "HUAYU_REGIONAL_WOODLAND_MIN_AREA"]) {
    const declaration = app.match(new RegExp(`  const ${name} = [^;]+;`, "u"))?.[0];
    if (!declaration) throw new Error(`Missing terrain threshold: ${name}`);
    vm.runInContext(declaration.replace("const ", "var "), context);
  }
  const names = ["huayuPreferredFeatureName", "huayuForestPark", "huayuWoodlandArea",
    "huayuMountainWoodlandName", "huayuMountainLandKind", "huayuMountainPlainName",
    "huayuLiveBasemapPolygonClass", "huayuLiveBasemapPolygonSignature",
    "huayuWallCoordinates", "huayuWallPointKey", "huayuWallJoinRings", "huayuWallRingArea",
    "huayuNormalizedWallRing", "huayuWallPointInRing", "huayuCityWallRelationGeometry",
    "huayuGeometryAreaSquareMeters", "huayuGeometryInteriorPoint", "huayuLiveBasemapLabelCoordinate",
    "huayuLiveBasemapImportantLabel", "huayuPointInPolygonGeometry", "huayuTreeHash", "huayuTreeRandom",
    "huayuTerrainElevationMeters", "huayuMountainWoodlandEligible", "huayuMountainReliefParts",
    "huayuLiveBasemapSportsRelationGeometry", "huayuLiveBasemapFeatureCollection"];
  for (const name of names) {
    const declaration = app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
    if (!declaration) throw new Error(`Missing terrain classifier: ${name}`);
    vm.runInContext(declaration, context);
  }
  const pointInPolygon = context.huayuPointInPolygonGeometry;
  const geometryBounds = new WeakMap();
  context.huayuPointInPolygonGeometry = (point, geometry) => {
    let bounds = geometryBounds.get(geometry);
    if (!bounds) {
      bounds = {west: Infinity, east: -Infinity, south: Infinity, north: -Infinity};
      const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
        : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
      for (const polygon of polygons) for (const [longitude, latitude] of polygon[0] || []) {
        bounds.west = Math.min(bounds.west, longitude);
        bounds.east = Math.max(bounds.east, longitude);
        bounds.south = Math.min(bounds.south, latitude);
        bounds.north = Math.max(bounds.north, latitude);
      }
      if (geometry) geometryBounds.set(geometry, bounds);
    }
    // National snapshots contain many distant peaks. Reject only those outside
    // the polygon bounds before using the identical application ring test.
    if (point[0] < bounds.west || point[0] > bounds.east
      || point[1] < bounds.south || point[1] > bounds.north) return false;
    return pointInPolygon(point, geometry);
  };
  const queryDeclaration = worker.match(/function terrainOverpassQuery\([^]*?\n\}/u)?.[0];
  if (!queryDeclaration) throw new Error("Missing terrain query");
  vm.runInContext(queryDeclaration, context);
  return context;
}

function terrainSlices(coverage) {
  const [[south, west], [north, east]] = coverage.bounds;
  const columns = Math.ceil((east - west) / 4);
  const rows = Math.ceil((north - south) / 9);
  return Array.from({length: rows}, (_, row) => Array.from({length: columns}, (_, column) => ({
    id: `${coverage.id}-${row}-${column}`,
    bounds: {south: south + (north - south) * row / rows,
      north: south + (north - south) * (row + 1) / rows,
      west: west + (east - west) * column / columns,
      east: west + (east - west) * (column + 1) / columns},
  }))).flat();
}

function compactFeature(feature) {
  const geometry = JSON.parse(JSON.stringify(feature.geometry));
  const round = (value) => Math.round(value * 1e6) / 1e6;
  const walk = (coordinates) => typeof coordinates[0] === "number"
    ? coordinates.map(round) : coordinates.map(walk);
  geometry.coordinates = walk(geometry.coordinates);
  return {...feature, geometry};
}

async function buildTerrainPreload(options = {}) {
  const siteDirectory = path.resolve(options.siteDirectory || "outputs/ogf-atlas");
  const cacheDirectory = path.resolve(options.cacheDirectory || "work/terrain-refresh-cache");
  const runtime = await terrainRuntime(siteDirectory);
  const rulesHash = createHash("sha256").update(await fs.readFile(path.join(siteDirectory, "app.js")))
    .update(await fs.readFile(path.join(siteDirectory, "_worker.js")))
    .update(await fs.readFile(__filename)).digest("hex");
  const potentialTerrain = (element) => {
    if (element.type === "node") return true;
    const tags = element.tags || {};
    const names = [tags.name, tags["name:zh"], tags.alt_name, tags.loc_name];
    if (!runtime.huayuMountainLandKind(tags) || names.some(runtime.huayuMountainPlainName)) return false;
    if (names.some(runtime.huayuMountainWoodlandName) || runtime.huayuMountainLandKind(tags) === "open") return true;
    const bounds = element.bounds;
    if (!bounds || ![bounds.minlat, bounds.maxlat, bounds.minlon, bounds.maxlon].every(Number.isFinite)
      || bounds.maxlon < bounds.minlon) return true;
    const equatorLatitude = bounds.minlat <= 0 && bounds.maxlat >= 0 ? 0
      : Math.min(Math.abs(bounds.minlat), Math.abs(bounds.maxlat));
    // Bounding rectangle area is an upper bound; it can only exclude ordinary
    // woods that cannot possibly reach the application's one-square-km floor.
    const maximumArea = (bounds.maxlat - bounds.minlat) * (bounds.maxlon - bounds.minlon)
      * 111320 ** 2 * Math.cos(equatorLatitude * Math.PI / 180) * 1.02;
    return maximumArea >= runtime.HUAYU_MOUNTAIN_WOODLAND_MIN_AREA;
  };
  const transit = JSON.parse(await fs.readFile(path.join(siteDirectory, "transit-preload.json"), "utf8"));
  const coverage = transit.snapshots.map(({id, bounds}) => ({id, bounds, complete: true}));
  const slices = coverage.flatMap(terrainSlices);
  const packets = new Array(slices.length);
  await fs.mkdir(cacheDirectory, {recursive: true});
  const geometries = new Map();
  const remember = (elements) => {
    for (const element of elements) {
      if ((element.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon))
        || (element.type === "way" && element.geometry?.length)
        || (element.type === "relation" && element.members?.length)) {
        geometries.set(`${element.type}:${element.id}`, element);
      }
    }
    return elements;
  };
  if (options.resume) {
    for (const name of await fs.readdir(cacheDirectory)) {
      if (!name.endsWith(".json") || name.includes("-inventory")) continue;
      try { remember(JSON.parse(await fs.readFile(path.join(cacheDirectory, name), "utf8")).elements || []); }
      catch {}
    }
  }
  const requestElements = async (query, label, timeout = 55000) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await (options.fetch || fetch)("https://overpass.opengeofiction.net/api/interpreter", {
        method: "POST", body: new URLSearchParams({data: query}), signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 429 && attempt < 2) {
        const delay = Math.min(60000, Math.max(30000, Number(response.headers.get("Retry-After")) * 1000 || 0));
        console.log(`Terrain rate limit ${label}: retry in ${delay / 1000}s`);
        await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
        continue;
      }
      if (!response.ok) throw new Error(`Terrain ${label}: HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.remark || !Array.isArray(payload.elements)) throw new Error(payload.remark || "invalid data");
      return payload.elements;
    }
  };
  const fetchGeometry = async (items, label) => {
    if (!items.length) return [];
    const query = `[out:json][timeout:120];(` + ["node", "way", "relation"].map((type) => {
      const ids = items.filter((item) => item.type === type).map((item) => item.id);
      return ids.length ? `${type}(id:${ids.join(",")});` : "";
    }).join("") + `);out body geom;`;
    const cachePath = path.join(cacheDirectory, `${label}-geometry.json`);
    if (options.resume) {
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
        if (cached.query === query && Array.isArray(cached.elements) && !cached.remark) return remember(cached.elements);
      } catch {}
    }
    let elements;
    try { elements = await requestElements(query, label, 180000); }
    catch (error) {
      if (items.length < 2 || /HTTP (?:429|401|403)/u.test(error.message)) throw error;
      console.log(`Terrain geometry split ${label}: ${error.message}`);
      const middle = Math.ceil(items.length / 2);
      elements = [...await fetchGeometry(items.slice(0, middle), `${label}-0`),
        ...await fetchGeometry(items.slice(middle), `${label}-1`)];
    }
    const ids = new Set(elements.map((element) => `${element.type}:${element.id}`));
    if (items.some((item) => !ids.has(`${item.type}:${item.id}`))) throw new Error(`Incomplete terrain geometry: ${label}`);
    await fs.writeFile(cachePath, JSON.stringify({query, elements}));
    return remember(elements);
  };
  const fetchSlice = async (slice, depth = 0) => {
    const broadQuery = runtime.terrainOverpassQuery(slice.bounds).replace("[timeout:30]", "[timeout:45]");
    // Accept complete raw slices produced by the earlier perimeter-filter query.
    const sizeGuard = `(if:length()>=3000 || is_tag("name") || is_tag("name:zh") || is_tag("alt_name") || is_tag("loc_name"))`;
    const query = broadQuery.replace(/(way\["(?:natural"="wood|landuse"="forest)"\]\([^)]*\))(?=;)/gu,
      `$1${sizeGuard}`);
    const cachePath = path.join(cacheDirectory, `${slice.id}.json`);
    if (options.resume) {
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
        if ([query,broadQuery].some((candidate) => cached.query?.replace(/\[timeout:\d+\]/u, "")
          === candidate.replace(/\[timeout:\d+\]/u, ""))
          && (!cached.rulesHash || cached.rulesHash === rulesHash)
          && Array.isArray(cached.elements) && !cached.remark) return remember(cached.elements);
      } catch {}
    }
    try {
      // Fetch the inexpensive tag inventory first, then resolve bounded ID batches.
      // Reuse full geometries across neighbouring boxes instead of downloading
      // the same large multipolygon repeatedly. No shape is clipped to its box.
      const inventoryQuery = broadQuery.replace("out body geom;", "out tags bb;");
      const inventoryPath = path.join(cacheDirectory, `${slice.id}-inventory.json`);
      let inventory;
      if (options.resume) {
        try {
          const cached = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
          if (cached.query === inventoryQuery && Array.isArray(cached.elements)) inventory = cached.elements;
        } catch {}
      }
      if (!inventory) {
        inventory = await requestElements(inventoryQuery, `${slice.id}-inventory`);
        await fs.writeFile(inventoryPath, JSON.stringify({query: inventoryQuery, elements: inventory}));
      }
      inventory = inventory.filter(potentialTerrain);
      remember(inventory);
      const missing = inventory.filter((item) => !geometries.has(`${item.type}:${item.id}`));
      console.log(`Terrain inventory ${slice.id}: ${inventory.length} elements, ${missing.length} geometries to fetch`);
      for (const [type, batchSize] of [["node", 500], ["way", 150], ["relation", 4]]) {
        const typedItems = missing.filter((item) => item.type === type);
        for (let offset = 0; offset < typedItems.length; offset += batchSize) {
          await fetchGeometry(typedItems.slice(offset, offset + batchSize), `${slice.id}-${type}-${offset}`);
        }
      }
      const elements = inventory.map((item) => geometries.get(`${item.type}:${item.id}`));
      if (elements.some((item) => !item)) throw new Error(`Incomplete terrain slice: ${slice.id}`);
      await fs.writeFile(cachePath, JSON.stringify({query: broadQuery, rulesHash, elements}));
      return elements;
    } catch (error) {
      if (depth >= 4 || /HTTP (?:429|401|403)/u.test(error.message)) throw error;
      const bounds = slice.bounds;
      const latitudeSplit = bounds.north - bounds.south >= bounds.east - bounds.west;
      const middle = latitudeSplit ? (bounds.south + bounds.north) / 2 : (bounds.west + bounds.east) / 2;
      const halves = latitudeSplit ? [{...bounds, north: middle}, {...bounds, south: middle}]
        : [{...bounds, east: middle}, {...bounds, west: middle}];
      console.log(`Terrain split ${slice.id}: ${error.message}`);
      const elements = [];
      for (const [index, half] of halves.entries()) {
        for (const element of await fetchSlice({id: `${slice.id}-${index}`, bounds: half}, depth + 1)) elements.push(element);
      }
      await fs.writeFile(cachePath, JSON.stringify({query, rulesHash, elements}));
      return elements;
    }
  };
  let cursor = 0;
  await Promise.all(Array.from({length: 1}, async () => {
    while (cursor < slices.length) {
      const index = cursor++;
      const slice = slices[index];
      console.log(`Terrain fetch ${slice.id} (${index + 1}/${slices.length})`);
      packets[index] = await fetchSlice(slice);
    }
  }));
  const elements = new Map();
  for (const packet of packets) for (const element of packet) elements.set(`${element.type}:${element.id}`, element);
  const data = runtime.huayuLiveBasemapFeatureCollection([...elements.values()], {includeMountainRelief: true});
  const features = data.features.filter((feature) => feature.properties?.reliefRole === "surface"
    || (feature.properties?.renderKind === "important-label"
      && ["mountain", "peak"].includes(feature.properties.featureClass)))
    .map(compactFeature).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!features.some((feature) => feature.properties.reliefRole === "surface")) throw new Error("Empty terrain preload");
  const payload = {format: 1, schema: "open-small-mountains-v1", generatedAt: new Date().toISOString(),
    coverage, features};
  const target = path.join(siteDirectory, "terrain-preload.json.gz");
  const next = `${target}.next`;
  // Commit only after every spatial slice succeeds; failures leave the published packet intact.
  const serialized = gzipSync(JSON.stringify(payload), {level: 9});
  if (serialized.length >= 25 * 1024 * 1024) throw new Error("Terrain snapshot exceeds Pages file limit");
  await fs.writeFile(next, serialized);
  await fs.rename(next, target);
  console.log(`Terrain preload: ${features.length} features, ${(await fs.stat(target)).size} bytes`);
  return payload;
}

module.exports = {terrainRuntime, terrainSlices, compactFeature, buildTerrainPreload};
if (require.main === module) {
  const siteIndex = process.argv.indexOf("--site");
  buildTerrainPreload({siteDirectory: siteIndex >= 0 ? process.argv[siteIndex + 1] : undefined,
    resume: process.argv.includes("--resume")}).catch((error) => {console.error(error); process.exitCode = 1;});
}
