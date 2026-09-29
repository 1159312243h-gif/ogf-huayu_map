const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../outputs/ogf-atlas");
const preloadPath = path.join(root, "transit-preload.json");
const railwayPath = path.join(root, "railway-routing.json");
const servicesPath = path.join(root, "transit-services.json");
const shouldWrite = process.argv.includes("--write");

const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const railway = JSON.parse(fs.readFileSync(railwayPath, "utf8"));
const services = JSON.parse(fs.readFileSync(servicesPath, "utf8"));
const snapshot = preload.snapshots.find((item) => item.id === "huaxia");
if (!snapshot?.network || snapshot.network.format !== 2) throw new Error("Huaxia compact transit snapshot is unavailable");

const systems = (services.publicTransitRailSystems || []).filter((system) =>
  system.source === "user_confirmed" && system.allowInfrastructure === true);
const stationSystemsById = new Map();
const inferredStationSystemIds = new Set(systems
  .filter((system) => system.inferStationMemberships === true)
  .map((system) => system.id));
for (const stationNetwork of services.publicTransitRailStationNetworks || []) {
  if (stationNetwork.source !== "user_confirmed" || !stationNetwork.systemId) continue;
  for (const stationId of stationNetwork.stationIds || []) {
    const key = String(stationId);
    if (!stationSystemsById.has(key)) stationSystemsById.set(key, new Set());
    stationSystemsById.get(key).add(stationNetwork.systemId);
  }
}
const nonOperational = /(折返|回库|车场|车辆段|存车|停车线|出入段|联络线|试车线|检修线|工程线|引入线|渡线|洗车线|调车线|备用线|安全线|咽喉线|入库线|出库线|返空线|turn[- ]?back|stabling|depot|yard|siding|crossover|test\s*track|maintenance|engineering|access\s*track|wash\s*track|storage\s*track)/iu;
const matchingSystem = (name) => systems.find((system) =>
  (system.lineNamePrefixes || []).some((prefix) => name.startsWith(prefix)));
const legacyRouteNamesByStationId = new Map();
try {
  const legacyPath = path.resolve(__dirname, "preload-refresh-v3036-baseline/transit-preload.json");
  const legacyPayload = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  const legacyNetwork = legacyPayload.snapshots.find((item) => item.id === "huaxia")?.network;
  for (const stop of legacyNetwork?.stops || []) {
    const routeNames = (stop[8] || []).map((index) => legacyNetwork.routeTable[index])
      .filter((route) => route?.[1] === "train" && matchingSystem(String(route[4] || "")))
      .map((route) => String(route[4] || ""));
    if (!routeNames.length) continue;
    for (const id of [stop[0], stop[10]]) {
      if (id === null || id === undefined) continue;
      const key = String(id);
      if (!legacyRouteNamesByStationId.has(key)) legacyRouteNamesByStationId.set(key, new Set());
      routeNames.forEach((name) => legacyRouteNamesByStationId.get(key).add(name));
    }
  }
} catch {}

function distanceToSegmentMeters(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = Math.cos(point[0] * Math.PI / 180) * latitudeScale;
  const px = point[1] * longitudeScale;
  const py = point[0] * latitudeScale;
  const ax = start[1] * longitudeScale;
  const ay = start[0] * latitudeScale;
  const bx = end[1] * longitudeScale;
  const by = end[0] * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function distanceToLineMeters(point, line) {
  let nearest = Infinity;
  const geometry = line[1] || [];
  for (let index = 1; index < geometry.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegmentMeters(point, geometry[index - 1], geometry[index]));
  }
  return nearest;
}

const network = snapshot.network;
const existingLineIds = new Set(network.lines.map((line) => String(line[0])));
const routeIndexBySystemLine = new Map();
const routeIndex = (system, name) => {
  const key = `${system.id}:${name}`;
  if (routeIndexBySystemLine.has(key)) return routeIndexBySystemLine.get(key);
  let index = network.routeTable.findIndex((route) => route[1] === "train" && route[4] === name);
  if (index < 0) {
    index = network.routeTable.length;
    network.routeTable.push([
      `infrastructure:public-transit:${system.id}:${name}`,
      "train",
      "#4e5e66",
      `train:infrastructure:public-transit:${system.id}:${name}`,
      name,
    ]);
  }
  routeIndexBySystemLine.set(key, index);
  return index;
};

const additions = [];
for (const way of railway.ways || []) {
  const name = String(way[3] || "").trim();
  const system = matchingSystem(name);
  if (!system || nonOperational.test(name) || existingLineIds.has(String(way[0]))) continue;
  const geometry = way[2];
  if (!Array.isArray(geometry) || geometry.length < 2) continue;
  const bbox = geometry.reduce((result, point) => [
    Math.min(result[0], point[0]), Math.min(result[1], point[1]),
    Math.max(result[2], point[0]), Math.max(result[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  additions.push([way[0], geometry, [routeIndex(system, name)], bbox]);
}

if (additions.length) network.lines.push(...additions);

let enrichedStationMemberships = 0;
const publicTransitLines = network.lines.map((line) => ({
  line,
  routes: (line[2] || []).map((index) => {
    const route = network.routeTable[index];
    const system = route?.[1] === "train" ? matchingSystem(String(route[4] || "")) : null;
    return system ? { index, systemId: system.id } : null;
  }).filter(Boolean),
})).filter((item) => item.routes.length);
for (const stop of network.stops || []) {
  if (!stop[9]) continue;
  const stationSystems = new Set([stop[0], stop[10]]
    .filter((id) => id !== null && id !== undefined)
    .flatMap((id) => [...(stationSystemsById.get(String(id)) || [])]));
  const legacyRouteNames = new Set([stop[0], stop[10]]
    .filter((id) => id !== null && id !== undefined)
    .flatMap((id) => [...(legacyRouteNamesByStationId.get(String(id)) || [])]));
  if (!stationSystems.size && !legacyRouteNames.size && !inferredStationSystemIds.size) continue;
  const point = [Number.isFinite(stop[3]) ? stop[3] : stop[1], Number.isFinite(stop[4]) ? stop[4] : stop[2]];
  const matchedRoutes = [];
  for (const { line, routes } of publicTransitLines) {
    const bbox = line[3];
    const padding = 0.001;
    if (bbox && (point[0] < bbox[0] - padding || point[0] > bbox[2] + padding
      || point[1] < bbox[1] - padding || point[1] > bbox[3] + padding)) continue;
    if (distanceToLineMeters(point, line) <= 80) {
      matchedRoutes.push(...routes.filter((route) => stationSystems.has(route.systemId)
        || inferredStationSystemIds.has(route.systemId)
        || legacyRouteNames.has(String(network.routeTable[route.index]?.[4] || "")))
        .map((route) => route.index));
    }
  }
  const previous = stop[8] || [];
  stop[8] = [...new Set([...previous, ...matchedRoutes])];
  enrichedStationMemberships += stop[8].length - previous.length;
}

if (shouldWrite && (additions.length || enrichedStationMemberships)) {
  network.meta = {
    ...(network.meta || {}),
    publicTransitInfrastructureLines: publicTransitLines.length,
    publicTransitInfrastructureSystems: systems.map((system) => system.id),
    publicTransitStationMembershipsEnriched: enrichedStationMemberships,
    publicTransitLegacyMembershipsPreserved: legacyRouteNamesByStationId.size,
  };
  preload.generatedAt = new Date().toISOString();
  fs.writeFileSync(preloadPath, JSON.stringify(preload));
}

const summary = additions.reduce((result, line) => {
  const name = network.routeTable[line[2][0]][4];
  result[name] = (result[name] || 0) + 1;
  return result;
}, {});
console.log(JSON.stringify({
  status: shouldWrite ? "written" : "dry-run",
  systems: systems.map((system) => system.id),
  addedLines: additions.length,
  addedPoints: additions.reduce((sum, line) => sum + line[1].length, 0),
  publicTransitLines: publicTransitLines.length,
  enrichedStationMemberships,
  byLine: summary,
}, null, 2));
