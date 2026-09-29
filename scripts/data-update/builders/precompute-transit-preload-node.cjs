const fs = require("node:fs");
const vm = require("node:vm");

const target = "outputs/ogf-atlas/transit-preload.json";
const appPath = "outputs/ogf-atlas/app.js";

function createBounds([[south, west], [north, east]]) {
  const make = (s, w, n, e) => ({
    getSouth: () => s,
    getWest: () => w,
    getNorth: () => n,
    getEast: () => e,
    pad(ratio) {
      const lat = (n - s) * ratio;
      const lon = (e - w) * ratio;
      return make(s - lat, w - lon, n + lat, e + lon);
    },
    contains(value) {
      const lat = Array.isArray(value) ? Number(value[0]) : Number(value.lat);
      const lon = Array.isArray(value) ? Number(value[1]) : Number(value.lng ?? value.lon);
      return lat >= s && lat <= n && lon >= w && lon <= e;
    },
  });
  return make(south, west, north, east);
}

function loadCollector() {
  const source = fs.readFileSync(appPath, "utf8");
  const serviceRules = JSON.parse(fs.readFileSync("outputs/ogf-atlas/transit-services.json", "utf8"));
  const constantsEnd = source.indexOf("  const elements =");
  const declarationsStart = source.indexOf("  async function runPlaceSearch");
  if (constantsEnd < 0 || declarationsStart < 0) {
    throw new Error("app.js structure changed; collectTransitNetwork cannot be isolated safely");
  }
  const context = vm.createContext({
    window: { location: { search: "" }, setTimeout, clearTimeout },
    URLSearchParams,
    URL,
    console,
    fetch,
    AbortController,
    AbortSignal,
    structuredClone,
    setTimeout,
    clearTimeout,
    __transitServiceRules: serviceRules,
  });
  vm.runInContext(`${source.slice(0, constantsEnd)}
    let transitServiceRules = globalThis.__transitServiceRules;
    let multimodalRouteSequences = new Map();
    let multimodalRelationNodesById = new Map();
    let multimodalRelationsById = new Map();
    let multimodalRelationParentsByChildId = new Map();
    let multimodalRelationParentsSource = null;
    let multimodalWaysById = new Map();
    let multimodalRouteCorridors = new Map();
    let multimodalBusTopologies = new Map();
    globalThis.__buildTransitNetwork = collectTransitNetwork;
    return;
  ${source.slice(declarationsStart)}`, context, { filename: appPath });
  if (typeof context.__buildTransitNetwork !== "function") {
    throw new Error("collectTransitNetwork was not exported from app.js");
  }
  return context.__buildTransitNetwork;
}

const payload = JSON.parse(fs.readFileSync(target, "utf8"));
const collectTransitNetwork = loadCollector();

for (const snapshot of payload.snapshots || []) {
  const bounds = createBounds(snapshot.bounds);
  const network = collectTransitNetwork(
    snapshot.elements || [],
    bounds,
    false,
    snapshot.railInfrastructure || [],
  );
  network.stationDataUnavailable = false;
  network.source = "preloaded";
  network.sourceLabel = snapshot.label || "本地";
  network.lines.forEach((line) => {
    line.bbox = line.geometry.reduce((bbox, point) => [
      Math.min(bbox[0], point.lat),
      Math.min(bbox[1], point.lon),
      Math.max(bbox[2], point.lat),
      Math.max(bbox[3], point.lon),
    ], [Infinity, Infinity, -Infinity, -Infinity]);
  });
  snapshot.network = network;
  delete snapshot.railInfrastructure;
}

payload.generatedAt = new Date().toISOString();
fs.writeFileSync(target, JSON.stringify(payload));
console.log(JSON.stringify({
  target,
  engine: "node-vm",
  snapshots: payload.snapshots.map((snapshot) => ({
    id: snapshot.id,
    routes: snapshot.network?.routeCount ?? null,
    lines: snapshot.network?.lines?.length ?? null,
    stops: snapshot.network?.stops?.length ?? null,
  })),
}, null, 2));
