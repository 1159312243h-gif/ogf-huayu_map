const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// An additive display table also upgrades old compact packets. Never rebuild
// or rewrite their routing stations, line memberships, geometry or timestamps.
const root = process.argv.includes("--site") ? path.resolve(__dirname, "../../../site")
  : path.resolve("outputs/ogf-atlas");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const preloadPath = path.join(root, "transit-preload.json");
const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const relations = JSON.parse(fs.readFileSync(path.join(root, "transit-relations.json"), "utf8"));
const rules = JSON.parse(fs.readFileSync(path.join(root, "transit-services.json"), "utf8"));
const runtime = vm.createContext({window: {location: {search: ""}}, URLSearchParams, __rules: rules});
vm.runInContext(`${app.slice(0, app.indexOf("  const elements ="))}
  let transitServiceRules = {};
  globalThis.displayBuilder = {hydrateTransitNetwork, reconcileTransitDisplayStations};
  initializeTransitServiceRules(__rules);
  return;
  ${app.slice(app.indexOf("  async function runPlaceSearch"))}`, runtime);

const report = [];
for (const snapshot of preload.snapshots) {
  const source = relations.snapshots.find((item) => item.id === snapshot.id);
  if (!source) throw new Error(`Missing transit sources for ${snapshot.id}`);
  const compact = snapshot.network;
  if (compact?.format !== 2) throw new Error(`Unexpected compact format for ${snapshot.id}`);
  const network = runtime.displayBuilder.hydrateTransitNetwork(compact);
  runtime.displayBuilder.reconcileTransitDisplayStations(network, source.elements);
  const indexes = new Map(compact.routeTable.map((route, index) => [`${route[0]}:${route[3]}`, index]));
  const routeIndexes = (routes) => (routes || []).map((route) => {
    const index = indexes.get(`${route.id}:${route.identity}`);
    if (index === undefined) throw new Error(`Missing display route ${route.id} in ${snapshot.id}`);
    return index;
  });
  compact.displayStops = network.displayStops.map((stop) => [
    stop.id, stop.lat, stop.lon, stop.sourceLat ?? null, stop.sourceLon ?? null,
    stop.name, stop.isRail ? 1 : 0, stop.isBus ? 1 : 0, routeIndexes(stop.routes),
    stop.isMainline ? 1 : 0, stop.sourceId ?? null, routeIndexes(stop.displayRoutes),
    stop.nationalRailwayEligible === false ? 0 : 1, stop.isInterchange ? 1 : 0,
    stop.displaySystem || null,
    stop.displaySystems || null,
  ]);
  report.push({id: snapshot.id, routingStops: compact.stops.length, displaySources: compact.displayStops.length});
}
fs.writeFileSync(preloadPath, JSON.stringify(preload));
console.log(JSON.stringify({preservedGeneratedAt: preload.generatedAt, snapshots: report}, null, 2));
