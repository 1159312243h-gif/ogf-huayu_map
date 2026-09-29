const assert = require("node:assert/strict");
const fs = require("node:fs");

const baselinePath = "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/transit-preload.json";
const baselineRailPath = "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/railway-routing.json";
const targetPath = "outputs/ogf-atlas/transit-preload.json";
const targetRailPath = "outputs/ogf-atlas/railway-routing.json";
const facilityName = /(折返|回库|车场|车辆段|存车|停车线|出入段|联络线|试车线|检修线|工程线|引入线|渡线|洗车线|卸车线|调车线|备用线|安全线|咽喉线|入库线|出库线|返空线|turn[- ]?back|stabling|depot|yard|siding|crossover|test\s*track|maintenance|engineering|access\s*track|wash\s*track|storage\s*track)/iu;
const earthRadiusMeters = 6371000;

function distanceMeters(first, second) {
  const radians = Math.PI / 180;
  const dLat = (Number(second[1]) - Number(first[1])) * radians;
  const dLon = (Number(second[2]) - Number(first[2])) * radians;
  const lat1 = Number(first[1]) * radians;
  const lat2 = Number(second[1]) * radians;
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(value));
}

function routeKey(route) {
  return `${route?.[1] || ""}|${route?.[0] ?? ""}|${route?.[3] || ""}`;
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
const baselineRail = JSON.parse(fs.readFileSync(baselineRailPath, "utf8"));
const targetRail = JSON.parse(fs.readFileSync(targetRailPath, "utf8"));
const baselineSnapshot = baseline.snapshots.find((snapshot) => snapshot.id === "huaxia");
const targetSnapshot = target.snapshots.find((snapshot) => snapshot.id === "huaxia");
assert.ok(baselineSnapshot?.network?.format === 2, "published Huaxia baseline is missing");
assert.ok(targetSnapshot?.network?.format === 2, "current Huaxia compact snapshot is missing");
assert.ok(target.snapshots.some((snapshot) => snapshot.id === "kadah"), "Kadah snapshot must be retained");
assert.ok(target.snapshots.some((snapshot) => snapshot.id === "longchuan-ar925"
  && /Loongchuan/u.test(snapshot.label || "")), "AR925 Loongchuan snapshot must be retained");

const baselineWayIds = new Set(baselineRail.ways.map((way) => String(way[0])));
const targetWayIds = new Set(targetRail.ways.map((way) => String(way[0])));
const missingBaselineWays = [...baselineWayIds].filter((id) => !targetWayIds.has(id));
assert.deepEqual(missingBaselineWays, [], "current railway topology must contain every v2.1.5 railway way");

const baselineNetwork = baselineSnapshot.network;
const targetNetwork = targetSnapshot.network;
const baselineRoutes = baselineNetwork.routeTable || [];
const targetRoutes = targetNetwork.routeTable || [];
const targetRouteIndexes = new Map(targetRoutes.map((route, index) => [routeKey(route), index]));
const currentStops = targetNetwork.stops || [];
const stopsById = new Set(currentStops.flatMap((stop) => [stop[0], stop[10]])
  .filter((id) => id !== null && id !== undefined).map(String));
const currentStopsByName = new Map();
currentStops.forEach((stop) => {
  const name = String(stop[5] || "").trim().toLocaleLowerCase("zh-CN");
  if (!name) return;
  if (!currentStopsByName.has(name)) currentStopsByName.set(name, []);
  currentStopsByName.get(name).push(stop);
});

let baselineRailwayStops = 0;
let retainedCurrentStops = 0;
let importedStops = 0;
let skippedFacilityStops = 0;
let importedRoutes = 0;

for (const stop of baselineNetwork.stops || []) {
  const trainRouteIndexes = (stop[8] || []).filter((index) => baselineRoutes[index]?.[1] === "train");
  if (!trainRouteIndexes.length) continue;
  baselineRailwayStops += 1;
  const stopIds = [stop[0], stop[10]].filter((id) => id !== null && id !== undefined).map(String);
  const normalizedName = String(stop[5] || "").trim().toLocaleLowerCase("zh-CN");
  const sameNamedCurrent = currentStopsByName.get(normalizedName) || [];
  if (stopIds.some((id) => stopsById.has(id))
    || sameNamedCurrent.some((candidate) => distanceMeters(stop, candidate) <= 300)) {
    retainedCurrentStops += 1;
    continue;
  }

  const mappedRoutes = [];
  for (const oldIndex of trainRouteIndexes) {
    const route = baselineRoutes[oldIndex];
    if (facilityName.test(String(route?.[4] || ""))) continue;
    const key = routeKey(route);
    let targetIndex = targetRouteIndexes.get(key);
    if (targetIndex === undefined) {
      targetIndex = targetRoutes.length;
      targetRoutes.push(route);
      targetRouteIndexes.set(key, targetIndex);
      importedRoutes += 1;
    }
    mappedRoutes.push(targetIndex);
  }
  if (!mappedRoutes.length) {
    skippedFacilityStops += 1;
    continue;
  }
  const imported = [...stop];
  imported[6] = 1;
  imported[7] = 0;
  imported[8] = [...new Set(mappedRoutes)];
  imported[9] = stop[9] ? 1 : 0;
  currentStops.push(imported);
  stopIds.forEach((id) => stopsById.add(id));
  if (normalizedName) {
    if (!currentStopsByName.has(normalizedName)) currentStopsByName.set(normalizedName, []);
    currentStopsByName.get(normalizedName).push(imported);
  }
  importedStops += 1;
}

targetNetwork.routeTable = targetRoutes;
targetNetwork.stops = currentStops;
targetNetwork.meta = {
  ...(targetNetwork.meta || {}),
  railwayStationBaseline: "published-snapshot",
  railwayStationBaselineStops: baselineRailwayStops,
  railwayStationImportedStops: importedStops,
};
target.generatedAt = new Date().toISOString();
fs.writeFileSync(targetPath, JSON.stringify(target));

console.log(JSON.stringify({
  status: "written",
  target: targetPath,
  baselineRailwayWays: baselineWayIds.size,
  currentRailwayWays: targetWayIds.size,
  baselineRailwayStops,
  retainedCurrentStops,
  importedStops,
  skippedFacilityStops,
  importedRoutes,
  huaxiaStops: currentStops.length,
  snapshots: target.snapshots.map((snapshot) => ({ id: snapshot.id, label: snapshot.label })),
}, null, 2));
