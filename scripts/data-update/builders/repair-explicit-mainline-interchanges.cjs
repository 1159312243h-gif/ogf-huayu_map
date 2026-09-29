const assert = require("node:assert/strict");
const fs = require("node:fs");

const preloadPath = "outputs/ogf-atlas/transit-preload.json";
const relationsPath = "outputs/ogf-atlas/transit-relations.json";
const baselinePath = "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/transit-preload.json";
const railwayPath = "outputs/ogf-atlas/railway-routing.json";
const shouldWrite = process.argv.includes("--write");
const facilityName = /(折返|回库|车场|车辆段|存车|停车线|出入段|联络线|试车线|检修线|工程线|引入线|渡线|洗车线|卸车线|调车线|备用线|安全线|咽喉线|入库线|出库线|返空线|turn[- ]?back|stabling|depot|yard|siding|crossover|test\s*track|maintenance|engineering|access\s*track|wash\s*track|storage\s*track)/iu;

function routeKey(route) {
  return `${route?.[1] || ""}|${route?.[0] ?? ""}|${route?.[3] || ""}`;
}

function projectPoint(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = Math.cos((point.lat * Math.PI) / 180) * latitudeScale;
  const px = point.lon * longitudeScale;
  const py = point.lat * latitudeScale;
  const ax = start[1] * longitudeScale;
  const ay = start[0] * latitudeScale;
  const bx = end[1] * longitudeScale;
  const by = end[0] * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator))
    : 0;
  const x = ax + ratio * dx;
  const y = ay + ratio * dy;
  return { lat: y / latitudeScale, lon: x / longitudeScale, distance: Math.hypot(px - x, py - y) };
}

function nearestPointOnLines(point, lines) {
  let nearest = null;
  for (const line of lines) {
    const bbox = line[3];
    const padding = 0.004;
    if (bbox && (point.lat < bbox[0] - padding || point.lat > bbox[2] + padding
      || point.lon < bbox[1] - padding || point.lon > bbox[3] + padding)) continue;
    const geometry = line[1] || [];
    for (let index = 1; index < geometry.length; index += 1) {
      const projection = projectPoint(point, geometry[index - 1], geometry[index]);
      if (!nearest || projection.distance < nearest.distance) nearest = { ...projection, line };
    }
  }
  return nearest;
}

function isExplicitCurrentTrainStation(node) {
  const tags = node?.tags || {};
  return node?.type === "node"
    && Number.isFinite(node.lat)
    && Number.isFinite(node.lon)
    && tags.train === "yes"
    && ["station", "halt"].includes(tags.railway);
}

const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const relations = JSON.parse(fs.readFileSync(relationsPath, "utf8"));
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const railway = JSON.parse(fs.readFileSync(railwayPath, "utf8"));
const targetSnapshot = preload.snapshots.find((snapshot) => snapshot.id === "huaxia");
const relationSnapshot = relations.snapshots.find((snapshot) => snapshot.id === "huaxia");
const baselineSnapshot = baseline.snapshots.find((snapshot) => snapshot.id === "huaxia");
assert.ok(targetSnapshot?.network?.format === 2, "current Huaxia compact network is missing");
assert.ok(Array.isArray(relationSnapshot?.elements), "current Huaxia relation source is missing");
assert.ok(baselineSnapshot?.network?.format === 2, "published Huaxia baseline is missing");
assert.ok(railway?.format === 1 && railway.ways?.length, "current railway topology is missing");

const network = targetSnapshot.network;
const routeTable = network.routeTable || [];
const baselineRoutes = baselineSnapshot.network.routeTable || [];
const routeIndexes = new Map(routeTable.map((route, index) => [routeKey(route), index]));
const currentSourceNodes = new Map(relationSnapshot.elements
  .filter(isExplicitCurrentTrainStation)
  .map((node) => [String(node.id), node]));
const stopsById = new Map();
network.stops.forEach((stop) => {
  [stop[0], stop[10]].filter((id) => id !== null && id !== undefined)
    .forEach((id) => stopsById.set(String(id), stop));
});
const hasTrainRoute = (stop) => (stop?.[8] || []).some((index) => routeTable[index]?.[1] === "train");
const physicalRailLines = railway.ways.map((way) => {
  const geometry = way[2] || [];
  const bbox = geometry.reduce((result, point) => [
    Math.min(result[0], point[0]),
    Math.min(result[1], point[1]),
    Math.max(result[2], point[0]),
    Math.max(result[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  return [way[0], geometry, [], bbox, String(way[3] || "").trim()];
}).filter((line) => line[1].length > 1);

function currentNamedPhysicalRoutes(point, nearestDistance) {
  const byName = new Map();
  const maximumDistance = Math.min(80, nearestDistance + 40);
  for (const line of physicalRailLines) {
    const name = line[4];
    if (!name || facilityName.test(name)) continue;
    const projection = nearestPointOnLines(point, [line]);
    if (!projection || projection.distance > maximumDistance) continue;
    const existing = byName.get(name);
    if (!existing || projection.distance < existing.distance) byName.set(name, { line, distance: projection.distance });
  }
  return [...byName.entries()].map(([name, { line }]) => {
    const route = [`infrastructure:${line[0]}`, "train", "#4e5e66", `train:infrastructure:${line[0]}`, name];
    const key = routeKey(route);
    let routeIndex = routeIndexes.get(key);
    if (routeIndex === undefined) {
      routeIndex = routeTable.length;
      routeTable.push(route);
      routeIndexes.set(key, routeIndex);
    }
    return routeIndex;
  });
}

const repaired = [];
for (const baselineStop of baselineSnapshot.network.stops || []) {
  if (!baselineStop[9]) continue;
  const sourceIds = [baselineStop[0], baselineStop[10]]
    .filter((id) => id !== null && id !== undefined)
    .map(String);
  const sourceNode = sourceIds.map((id) => currentSourceNodes.get(id)).find(Boolean);
  if (!sourceNode) continue;
  const existing = sourceIds.map((id) => stopsById.get(id)).find(Boolean);
  if (hasTrainRoute(existing)) continue;

  const mappedTrainRoutes = [];
  for (const baselineRouteIndex of baselineStop[8] || []) {
    const route = baselineRoutes[baselineRouteIndex];
    if (route?.[1] !== "train" || facilityName.test(String(route[4] || ""))) continue;
    const key = routeKey(route);
    let routeIndex = routeIndexes.get(key);
    if (routeIndex === undefined) {
      routeIndex = routeTable.length;
      routeTable.push(route);
      routeIndexes.set(key, routeIndex);
    }
    mappedTrainRoutes.push(routeIndex);
  }
  const projection = nearestPointOnLines({ lat: sourceNode.lat, lon: sourceNode.lon }, physicalRailLines);
  if (!projection || projection.distance > 280) continue;
  const currentNamedRoutes = currentNamedPhysicalRoutes({ lat: sourceNode.lat, lon: sourceNode.lon }, projection.distance);
  if (!mappedTrainRoutes.length && !currentNamedRoutes.length) continue;
  const authoritativeBaselineRoutes = mappedTrainRoutes.filter((index) => {
    const route = routeTable[index];
    return typeof route?.[0] === "number" && route[0] > 0;
  });
  const restoredTrainRoutes = currentNamedRoutes.length
    ? [...authoritativeBaselineRoutes, ...currentNamedRoutes]
    : mappedTrainRoutes;

  const restored = [...baselineStop];
  restored[1] = projection.lat;
  restored[2] = projection.lon;
  restored[3] = sourceNode.lat;
  restored[4] = sourceNode.lon;
  restored[5] = sourceNode.tags?.name || baselineStop[5];
  restored[6] = 1;
  restored[7] = existing?.[7] ? 1 : 0;
  restored[8] = [...new Set([...(existing?.[8] || []), ...restoredTrainRoutes])];
  restored[9] = 1;
  restored[10] = baselineStop[10] ?? sourceNode.id;
  repaired.push({ restored, existing, distance: projection.distance });
}

if (shouldWrite && repaired.length) {
  const repairedIds = new Set(repaired.flatMap(({ restored }) => [restored[0], restored[10]])
    .filter((id) => id !== null && id !== undefined).map(String));
  network.routeTable = routeTable;
  network.stops = [
    ...network.stops.filter((stop) => ![stop[0], stop[10]]
      .filter((id) => id !== null && id !== undefined).some((id) => repairedIds.has(String(id)))),
    ...repaired.map(({ restored }) => restored),
  ];
  network.meta = {
    ...(network.meta || {}),
    explicitMainlineInterchangesRepaired: repaired.length,
    explicitMainlineInterchangesSource: "current train=yes nodes checked against published corridors",
  };
  preload.generatedAt = new Date().toISOString();
  fs.writeFileSync(preloadPath, JSON.stringify(preload));
}

const summary = repaired.map(({ restored, existing, distance }) => ({
  id: restored[0],
  name: restored[5],
  distanceMeters: Math.round(distance),
  replacedTypes: (existing?.[8] || []).map((index) => routeTable[index]?.[1]).filter(Boolean),
  trainRoutes: restored[8].map((index) => routeTable[index]).filter((route) => route?.[1] === "train")
    .map((route) => route[4]),
}));
console.log(JSON.stringify({
  status: shouldWrite ? "written" : "dry-run",
  repaired: repaired.length,
  totalStops: shouldWrite ? network.stops.length : network.stops.length + repaired.filter(({ existing }) => !existing).length,
  targets: summary.filter((item) => item.name === "虚谷" || item.name === "津川航空港"),
  sample: summary.slice(0, 20),
}, null, 2));
