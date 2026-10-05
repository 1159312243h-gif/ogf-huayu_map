const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../outputs/ogf-atlas");
const preloadPath = path.join(root, "transit-preload.json");
const servicesPath = path.join(root, "transit-services.json");

const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const services = JSON.parse(fs.readFileSync(servicesPath, "utf8"));

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
    .replace(/[\s·・_—-]+/gu, "");
}

function stationKey(value) {
  return normalize(value)
    .replace(/(?:火车|铁路|地铁|轻轨|城铁|公交)?站$/u, "")
    .replace(/车站$/u, "");
}

function routeMatches(route, override) {
  const refs = [route?.[5], route?.[6], String(route?.[4] || "").split(" · ")[0]]
    .filter(Boolean).map(normalize);
  const labels = [route?.[4], route?.[3]].filter(Boolean).map(normalize);
  return (override.routeRefs || []).some((ref) => refs.includes(normalize(ref)))
    || (override.routeNames || []).some((name) => labels.some((label) => label === normalize(name)
      || label.includes(normalize(name))));
}

function uniqueIndexes(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0))];
}

function compactDisplayRoute(route, fallbackId) {
  return [
    route.id || `station-display:${fallbackId}`,
    route.type || "train",
    route.color,
    route.identity || `train:station-display:${fallbackId}`,
    route.label,
    route.ref || null,
    null,
    "route",
    0,
    null,
    [],
    [],
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    46,
  ];
}

function ensureDisplayRoute(network, route, fallbackId) {
  const identity = route.identity || `train:station-display:${fallbackId}`;
  const existing = network.routeTable.findIndex((item) => item?.[3] === identity);
  if (existing >= 0) return existing;
  network.routeTable.push(compactDisplayRoute(route, fallbackId));
  return network.routeTable.length - 1;
}

const overrides = (services.stationInterchangeOverrides || []).filter((item) =>
  item && item.source === "user_confirmed" && Array.isArray(item.stationNames));
let changedStops = 0;
let addedDisplayRoutes = 0;

for (const snapshot of preload.snapshots || []) {
  const network = snapshot.network;
  if (!network || network.format !== 2) continue;
  for (const stop of network.stops || []) {
    if (!Array.isArray(stop)) continue;
    const override = overrides.find((item) => item.stationNames.some((name) =>
      stationKey(name) === stationKey(stop[5]))
      && (typeof item.mainline !== "boolean" || item.mainline === (stop[9] === 1)));
    if (!override) continue;
    const matched = network.routeTable.map((route, index) => routeMatches(route, override) ? index : -1)
      .filter((index) => index >= 0);
    const explicit = (override.displayRoutes || []).map((route) =>
      ensureDisplayRoute(network, route, override.id));
    const beforeRoutes = JSON.stringify(stop[8] || []);
    const beforeDisplay = JSON.stringify(stop[11] || []);
    if (override.displayOnly) {
      stop[11] = uniqueIndexes([...(stop[11] || []), ...matched, ...explicit]);
    } else {
      stop[8] = uniqueIndexes([...(stop[8] || []), ...matched]);
      stop[11] = uniqueIndexes([...(stop[11] || []), ...explicit]);
    }
    stop[13] = 1;
    if (beforeRoutes !== JSON.stringify(stop[8] || [])
      || beforeDisplay !== JSON.stringify(stop[11] || [])) changedStops += 1;
    addedDisplayRoutes += explicit.length;
  }
}

preload.generatedAt = new Date().toISOString();
fs.writeFileSync(preloadPath, JSON.stringify(preload));
console.log(JSON.stringify({
  status: "written",
  changedStops,
  addedDisplayRoutes,
  preservedRuleSource: "transit-services.json",
}, null, 2));
