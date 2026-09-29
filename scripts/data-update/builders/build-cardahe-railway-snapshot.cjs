const fs = require("node:fs");

const rawPath = "work/cardahe-rail-raw.json";
const relationsPath = "outputs/ogf-atlas/transit-relations.json";
const preloadPath = "outputs/ogf-atlas/transit-preload.json";
const routingPath = "outputs/ogf-atlas/railway-routing.json";
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const boundary = raw.elements.find((item) => item.type === "relation"
  && item.tags?.boundary === "administrative" && item.tags?.admin_level === "2"
  && item.tags?.name === "Kadah");
if (!boundary?.bounds) throw new Error("Kadah country boundary bbox missing");

const railWays = raw.elements.filter((item) => item.type === "way"
  && ["rail", "narrow_gauge"].includes(item.tags?.railway)
  && Array.isArray(item.geometry) && item.geometry.length > 1
  && Array.isArray(item.nodes) && item.nodes.length === item.geometry.length);
const earthRadiusMeters = 6371000;

function distanceMeters(first, second) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.lat - first.lat) * radians;
  const longitudeDelta = (second.lon - first.lon) * radians;
  const firstLatitude = first.lat * radians;
  const secondLatitude = second.lat * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizedStationName(item) {
  return String(item.tags?.name || "").trim().toLocaleLowerCase("en");
}

function isRailStationElement(item) {
  const tags = item.tags || {};
  return ["station", "halt", "tram_stop"].includes(tags.railway)
    || tags.station === "subway"
    || tags.subway === "yes"
    || tags.light_rail === "yes"
    || tags.monorail === "yes"
    || tags.train === "yes"
    || tags.building === "train_station";
}

const sourceNodes = raw.elements.filter((item) => item.type === "node"
  && Number.isFinite(item.lat) && Number.isFinite(item.lon));
const stationAreas = raw.elements.filter((item) => ["way", "relation"].includes(item.type)
  && Number.isFinite(item.center?.lat) && Number.isFinite(item.center?.lon)
  && normalizedStationName(item) && isRailStationElement(item));
const realStationsByName = new Map();
sourceNodes.filter((item) => normalizedStationName(item) && isRailStationElement(item)).forEach((node) => {
  const name = normalizedStationName(node);
  if (!realStationsByName.has(name)) realStationsByName.set(name, []);
  realStationsByName.get(name).push(node);
});
const syntheticStations = [];
stationAreas.forEach((area) => {
  const point = area.center;
  const name = normalizedStationName(area);
  const duplicateRealNode = (realStationsByName.get(name) || [])
    .some((node) => distanceMeters(point, node) <= 180);
  const duplicateSynthetic = syntheticStations.some((node) => normalizedStationName(node) === name
    && distanceMeters(point, node) <= 180);
  if (duplicateRealNode || duplicateSynthetic) return;
  syntheticStations.push({
    type: "node",
    id: -100000000000 - Number(area.id),
    lat: point.lat,
    lon: point.lon,
    tags: {
      ...(area.tags || {}),
      "ogf_atlas:source": `${area.type}_station_center`,
      "ogf_atlas:source_id": `${area.type}:${area.id}`,
    },
  });
});
const stationElements = [
  ...sourceNodes,
  ...stationAreas,
  ...syntheticStations,
];
const elements = [...railWays, ...stationElements];
const railInfrastructure = railWays.map((way) => ({
  id: way.id,
  name: way.tags?.name || "",
  tags: way.tags || {},
  geometry: way.geometry,
  bbox: [
    Math.min(...way.geometry.map((point) => point.lat)),
    Math.min(...way.geometry.map((point) => point.lon)),
    Math.max(...way.geometry.map((point) => point.lat)),
    Math.max(...way.geometry.map((point) => point.lon)),
  ],
}));
const snapshot = {
  id: "kadah",
  label: "卡达赫（Kadah）",
  bounds: [[boundary.bounds.minlat, boundary.bounds.minlon], [boundary.bounds.maxlat, boundary.bounds.maxlon]],
  elements,
  railInfrastructure,
};

const relationsPayload = JSON.parse(fs.readFileSync(relationsPath, "utf8"));
relationsPayload.snapshots = (relationsPayload.snapshots || []).filter((item) => item.id !== snapshot.id);
relationsPayload.snapshots.push({ ...snapshot, railInfrastructure: undefined });
delete relationsPayload.snapshots.at(-1).railInfrastructure;
relationsPayload.generatedAt = new Date().toISOString();
fs.writeFileSync(relationsPath, JSON.stringify(relationsPayload));

// Rebuild the source preload with the extra infrastructure field. The browser
// precompute step turns this into the compact network used at runtime.
const preloadSource = JSON.parse(JSON.stringify(relationsPayload));
const existingPreload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const existingPreloadById = new Map((existingPreload.snapshots || []).map((item) => [item.id, item]));
preloadSource.snapshots = preloadSource.snapshots.map((item) => {
  if (item.id === snapshot.id) return snapshot;
  const existingSnapshot = existingPreloadById.get(item.id);
  return existingSnapshot?.network ? { ...item, network: existingSnapshot.network } : item;
});
preloadSource.generatedAt = relationsPayload.generatedAt;
fs.writeFileSync(preloadPath, JSON.stringify(preloadSource));

const routing = JSON.parse(fs.readFileSync(routingPath, "utf8"));
const existing = new Map((routing.ways || []).map((way) => [way[0], way]));
railWays.forEach((way) => existing.set(way.id, [
  way.id,
  way.nodes,
  way.geometry.map((point) => [point.lat, point.lon]),
  way.tags?.name || "",
  way.tags?.maxspeed || "",
  way.tags?.highspeed === "yes" ? 1 : 0,
]));
routing.ways = [...existing.values()];
routing.generatedAt = new Date().toISOString();
routing.coverage = {
  ...(routing.coverage || {}),
  additionalCountries: [...new Set([...(routing.coverage?.additionalCountries || []), "Kadah (卡达赫)"])],
  additionalCountryWays: railWays.length,
};
fs.writeFileSync(routingPath, JSON.stringify(routing));

console.log(JSON.stringify({
  country: snapshot.label,
  bounds: snapshot.bounds,
  infrastructureWays: railWays.length,
  stationElements: stationElements.length,
  sourceStationNodes: sourceNodes.filter(isRailStationElement).length,
  stationAreas: stationAreas.length,
  syntheticStations: syntheticStations.length,
  relationElements: elements.length,
  preloadSnapshots: preloadSource.snapshots.map((item) => ({ id: item.id, elements: item.elements.length })),
  routingWays: routing.ways.length,
}, null, 2));
