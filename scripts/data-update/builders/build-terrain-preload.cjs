const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const {createHash} = require("node:crypto");
const {gzipSync} = require("node:zlib");
const {writeTerrainRenderCache} = require("./build-terrain-render-cache.cjs");
const {buildTerrainContext} = require("./build-terrain-context.cjs");

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
    "huayuTerrainElevationMeters", "huayuMountainOuterContains", "huayuMountainWoodlandEligible", "huayuMountainNeighborhoodBounds",
    "huayuMountainNeighborhoodIndex", "huayuMountainReliefParts",
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
  const {terrainDigest, ...source} = feature;
  const compact = {...source, geometry};
  return {...compact, terrainDigest:createHash("sha256").update(JSON.stringify(compact)).digest("hex")};
}

function terrainFeatureBounds(feature) {
  const coordinates = feature?.geometry?.coordinates;
  const bounds = {south: Infinity, west: Infinity, north: -Infinity, east: -Infinity};
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      bounds.west = Math.min(bounds.west, value[0]);
      bounds.east = Math.max(bounds.east, value[0]);
      bounds.south = Math.min(bounds.south, value[1]);
      bounds.north = Math.max(bounds.north, value[1]);
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

async function writeTerrainContextAsset(siteDirectory,payload) {
  const features=payload.features.filter(feature=>feature.properties?.terrainContext===1);
  if (!features.length) return null;
  const body=gzipSync(JSON.stringify({format:1,schema:payload.schema,generatedAt:payload.generatedAt,
    classification:payload.classification,features}),{level:9});
  if (body.length>=25*1024*1024) throw Error("Mountain context snapshot exceeds Pages file limit");
  const digest=createHash("sha256").update(body).digest("hex").slice(0,16);
  const file=`context-${digest}.json.gz`;
  const directory=path.join(siteDirectory,"terrain-preload-chunks");
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,file),body);
  return {url:`./terrain-preload-chunks/${file}`,bytes:body.length,features:features.length};
}

function terrainLegacyPacket(payload,contextSnapshot) {
  // Pages limits each asset to 25 MiB. Keep complete geometry and complete
  // mapped context in separate assets, as well as the normal spatial chunks.
  return contextSnapshot ? {...payload,contextSnapshot,
    features:payload.features.filter(feature=>feature.properties?.terrainContext!==1)} : payload;
}

async function writeTerrainPreloadChunks(siteDirectory, payload) {
  const targetDirectory = path.join(siteDirectory, "terrain-preload-chunks");
  const chunkSize = 4;
  const coarseChunkSize = 12;
  const chunks = new Map();
  const add = (prefix, size, latitudeIndex, longitudeIndex, feature) => {
    const id = `${prefix}-${latitudeIndex}-${longitudeIndex}`;
    let chunk = chunks.get(id);
    if (!chunk) {
      chunk = {id, bounds: [[Math.max(-85, latitudeIndex * size), Math.max(-180, longitudeIndex * size)],
        [Math.min(85, (latitudeIndex + 1) * size), Math.min(180, (longitudeIndex + 1) * size)]], features: []};
      chunks.set(id, chunk);
    }
    chunk.features.push(feature);
  };
  for (const feature of payload.features) {
    const bounds = terrainFeatureBounds(feature);
    if (!bounds) continue;
    const columns = Math.max(1, Math.floor((bounds.east - 1e-9) / chunkSize)
      - Math.floor(bounds.west / chunkSize) + 1);
    const rows = Math.max(1, Math.floor((bounds.north - 1e-9) / chunkSize)
      - Math.floor(bounds.south / chunkSize) + 1);
    const size = columns * rows > 9 ? coarseChunkSize : chunkSize;
    const prefix = size === coarseChunkSize ? "c" : "f";
    const westIndex = Math.floor(bounds.west / size);
    const eastIndex = Math.floor((bounds.east - 1e-9) / size);
    const southIndex = Math.floor(bounds.south / size);
    const northIndex = Math.floor((bounds.north - 1e-9) / size);
    for (let latitudeIndex = southIndex; latitudeIndex <= northIndex; latitudeIndex += 1) {
      for (let longitudeIndex = westIndex; longitudeIndex <= eastIndex; longitudeIndex += 1) {
        add(prefix, size, latitudeIndex, longitudeIndex, feature);
      }
    }
  }
  await fs.mkdir(targetDirectory, {recursive: true});
  const retainedFiles = new Set();
  const contextSnapshot=await writeTerrainContextAsset(siteDirectory,payload);
  if (contextSnapshot) retainedFiles.add(path.basename(contextSnapshot.url));
  const manifestChunks = [];
  for (const chunk of [...chunks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const chunkPayload = {format: 1, schema: payload.schema, generatedAt: payload.generatedAt,
      classification: payload.classification, chunkId: chunk.id, features: chunk.features};
    const serialized = gzipSync(JSON.stringify(chunkPayload), {level: 9});
    if (serialized.length >= 25 * 1024 * 1024) throw new Error(`Terrain chunk exceeds Pages file limit: ${chunk.id}`);
    const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
    const file = `${chunk.id}-${digest}.json.gz`;
    retainedFiles.add(file);
    await fs.writeFile(path.join(targetDirectory, file), serialized);
    manifestChunks.push({id: chunk.id, bounds: chunk.bounds,
      url: `./terrain-preload-chunks/${file}`, bytes: serialized.length,
      features: chunk.features.length,
      surfaces: chunk.features.filter((feature) => feature.properties?.reliefRole === "surface").length});
  }
  const renderBlocks = await writeTerrainRenderCache(siteDirectory, payload);
  const manifest = {format: 1, schema: payload.schema, generatedAt: payload.generatedAt,
    classification: payload.classification, coverage: payload.coverage, chunks: manifestChunks, renderBlocks,
    ...(contextSnapshot ? {contextSnapshot} : {})};
  const manifestTarget = path.join(siteDirectory, "terrain-preload-manifest.json");
  await fs.writeFile(`${manifestTarget}.next`, JSON.stringify(manifest));
  await fs.rename(`${manifestTarget}.next`, manifestTarget);
  for (const file of await fs.readdir(targetDirectory)) {
    if (file.endsWith(".json.gz") && !retainedFiles.has(file)) await fs.unlink(path.join(targetDirectory, file));
  }
  console.log(`Terrain preload chunks: ${manifestChunks.length} files, ${manifestChunks.reduce((sum, chunk) => sum + chunk.bytes, 0)} bytes`);
  return manifest;
}

async function buildTerrainPreload(options = {}) {
  const siteDirectory = path.resolve(options.siteDirectory || "outputs/ogf-atlas");
  const cacheDirectory = path.resolve(options.cacheDirectory || "work/terrain-refresh-cache");
  const runtime = await terrainRuntime(siteDirectory);
  const rulesHash = createHash("sha256").update(await fs.readFile(path.join(siteDirectory, "app.js")))
    .update(await fs.readFile(path.join(siteDirectory, "_worker.js")))
    .update(await fs.readFile(__filename)).digest("hex");
  const potentialTerrain = (element, minimumArea = runtime.HUAYU_MOUNTAIN_WOODLAND_MIN_AREA) => {
    if (element.type === "node") return true;
    const tags = element.tags || {};
    const names = [tags.name, tags["name:zh"], tags.alt_name, tags.loc_name];
    if (!runtime.huayuMountainLandKind(tags) || names.some(runtime.huayuMountainPlainName)) return false;
    if (names.some(runtime.huayuMountainWoodlandName)
      || (runtime.huayuMountainLandKind(tags) === "open" && names.some(name =>
        /(?:高山|山地|山区|山坡|丘陵|荒原|alpine|upland|mountain)/iu.test(String(name || ""))))) return true;
    const bounds = element.bounds;
    if (!bounds || ![bounds.minlat, bounds.maxlat, bounds.minlon, bounds.maxlon].every(Number.isFinite)
      || bounds.maxlon < bounds.minlon) return true;
    const equatorLatitude = bounds.minlat <= 0 && bounds.maxlat >= 0 ? 0
      : Math.min(Math.abs(bounds.minlat), Math.abs(bounds.maxlat));
    // Bounding rectangle area is an upper bound; it can only exclude ordinary
    // woods that cannot possibly reach the application's one-square-km floor.
    const maximumArea = (bounds.maxlat - bounds.minlat) * (bounds.maxlon - bounds.minlon)
      * 111320 ** 2 * Math.cos(equatorLatitude * Math.PI / 180) * 1.02;
    return maximumArea >= minimumArea;
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
      const fullInventory = inventory;
      inventory = inventory.filter(item => potentialTerrain(item));
      remember(inventory);
      const missing = inventory.filter((item) => !geometries.has(`${item.type}:${item.id}`));
      console.log(`Terrain inventory ${slice.id}: ${inventory.length} elements, ${missing.length} geometries to fetch`);
      for (const [type, batchSize] of [["node", 500], ["way", 150], ["relation", 4]]) {
        const typedItems = missing.filter((item) => item.type === type);
        for (let offset = 0; offset < typedItems.length; offset += batchSize) {
          await fetchGeometry(typedItems.slice(offset, offset + batchSize), `${slice.id}-${type}-${offset}`);
        }
      }
      // Resolve large mountain geometry first. Use its expanded bounds only as
      // a conservative download filter; the shared classifier checks real edges.
      const primaryData = runtime.huayuLiveBasemapFeatureCollection(
        inventory.map(item => geometries.get(`${item.type}:${item.id}`)), {includeMountainRelief: true});
      const neighborhood = runtime.huayuMountainNeighborhoodIndex(primaryData.features
        .filter(feature => feature.properties?.reliefRole === "surface" && !feature.properties.reliefNeighbor)
        .map(feature => ({qualified: true, element: {type: feature.properties.osmType, id: feature.properties.sourceOsmId},
          geometry: feature.geometry})));
      const selectedIds = new Set(inventory.map(item => `${item.type}:${item.id}`));
      const nearby = fullInventory.filter(item => !selectedIds.has(`${item.type}:${item.id}`)
        && potentialTerrain(item, 10000) && item.bounds && neighborhood.mayBeNearby({
          west: item.bounds.minlon, east: item.bounds.maxlon, south: item.bounds.minlat, north: item.bounds.maxlat}));
      for (const [type, batchSize] of [["way", 150], ["relation", 4]]) {
        const missingNearby = nearby.filter(item => item.type === type && !geometries.has(`${item.type}:${item.id}`));
        for (let offset = 0; offset < missingNearby.length; offset += batchSize) {
          await fetchGeometry(missingNearby.slice(offset, offset + batchSize), `${slice.id}-nearby-${type}-${offset}`);
        }
      }
      inventory = [...inventory, ...nearby];
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
  const terrainFeatures = data.features.filter((feature) => feature.properties?.reliefRole === "surface"
    || (feature.properties?.renderKind === "important-label"
      && ["mountain", "peak"].includes(feature.properties.featureClass)))
    .map(compactFeature).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const contextFeatures = await buildTerrainContext({surfaces:terrainFeatures.filter(feature=>feature.properties.reliefRole==="surface"),
    slices,runtime,cacheDirectory,fetch:options.fetch,resume:options.resume});
  const features = [...terrainFeatures,...contextFeatures.map(compactFeature)].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  if (!features.some((feature) => feature.properties.reliefRole === "surface")) throw new Error("Empty terrain preload");
  const payload = {format: 1, schema: "open-small-mountains-v1", generatedAt: new Date().toISOString(),
    classification: "mountain-features-v2", coverage, features};
  const target = path.join(siteDirectory, "terrain-preload.json.gz");
  const next = `${target}.next`;
  // Commit only after every spatial slice succeeds; failures leave the published packet intact.
  const manifest=await writeTerrainPreloadChunks(siteDirectory, payload);
  const serialized = gzipSync(JSON.stringify(terrainLegacyPacket(payload,manifest.contextSnapshot)), {level: 9});
  if (serialized.length >= 25 * 1024 * 1024) throw new Error("Terrain snapshot exceeds Pages file limit");
  await fs.writeFile(next, serialized);
  await fs.rename(next, target);
  console.log(`Terrain preload: ${features.length} features, ${(await fs.stat(target)).size} bytes`);
  return payload;
}

module.exports = {terrainRuntime, terrainSlices, compactFeature, terrainFeatureBounds,writeTerrainContextAsset,terrainLegacyPacket,
  writeTerrainPreloadChunks, buildTerrainPreload};
if (require.main === module) {
  const siteIndex = process.argv.indexOf("--site");
  buildTerrainPreload({siteDirectory: siteIndex >= 0 ? process.argv[siteIndex + 1] : undefined,
    resume: process.argv.includes("--resume")}).catch((error) => {console.error(error); process.exitCode = 1;});
}
