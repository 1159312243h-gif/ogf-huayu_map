const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("outputs/ogf-atlas/app.js", "utf8");
const declarations = source.slice(source.indexOf("  async function runPlaceSearch"));
const constants = source.slice(0, source.indexOf("  const elements ="));
const context = vm.createContext({
  window: { location: { search: "" }, setTimeout, clearTimeout },
  URLSearchParams, console, fetch, AbortController,
});
vm.runInContext(constants + `
  let multimodalRouteSequences = new Map();
  let multimodalRelationNodesById = new Map();
  let multimodalRelationsById = new Map();
  let multimodalWaysById = new Map();
  let multimodalRouteCorridors = new Map();
  let multimodalBusTopologies = new Map();
  let transitRoutingContextKey = "diagnosis";
  let transitRoutingGraphCache = new WeakMap();
  let transitPathResultCache = new WeakMap();
  let transitStopProjectionCache = new WeakMap();
  let transitNetworkData = null;
  let selectedTransitItems = [];
  let railInfrastructureGraphCache = null;
  let railwayRoutingData = null;
  let allowInferredRailConnections = false;
  let routeConnectorMode = "auto";
  let transitPreloadSnapshots = [];
  let transitServiceRules = { refCorrections: [], throughServices: [] };
  let stationAccessData = null;
  const stationAccessCandidatesCache = new Map();
  const stationInternalPathCache = new Map();
  const stationConnectorCache = new Map();
  const groundConnectorCache = new Map();
  let roadFallbackCoverage = null;
  let roadFallbackWays = [];
  let roadFallbackPromise = null;
  const roadFallbackGraphCache = new Map();
  const transitLineBoundsCache = new WeakMap();
  globalThis.diagnosis = {
    hydrateTransitNetwork, buildTransitRoutingGraph, findRoutingStations,
    buildMultimodalPlans, rankMultimodalPlans, selectTransitConnectorCandidates,
    enrichPlanGroundConnectors, projectPointToTransitGeometry,
    joinConnectedTransitLines, transitGeometryLength, transitStopLinePosition,
    initialize(items) {
      transitPreloadSnapshots = [{ elements: items }];
      multimodalRouteSequences = buildTransitRelationSequences(items);
      multimodalRelationNodesById = new Map(items.filter(x => x.type === "node").map(x => [String(x.id), x]));
      initializeTransitRoutingGeometry(items);
    },
    enrichTransitNetworkRouteMetadata, transitEdgeTravelSeconds, transitGeometryBetweenStops,
    transitRoutingRelationCorridors, estimateGroundConnector, fetchRoadConnector,
    initializeStationAccess, stationAccessCandidates, stationInternalWalk, fetchStationConnector,
    isPublicTransitPlan, isUrbanRailTransitRoute, buildDirectTaxiPlan,
    transitPlanUsesTrainRide, transitPlanUsesNonTrainRide, transitPlanUsesConfirmedPublicTransitRail,
    publicTransitRailSupplementRelevant, transitConnectorModeVariant,
    collectTransitNetwork, transitRouteInfo, transitBusRelationTopologies, busGeometryBetweenStops,
    hasTransitRideGeometry, getRailInfrastructureGraph, findRailInfrastructurePath, findLocalTransitConnection,
    projectPointToTransitSegment,
    findTransitPath, findTransitPathWithRouteState, findTransitPathVariants,
    classifyMultimodalPlans, filterReasonableTransitAccessPlans, multimodalEstimatedFare, metroFareByDistance, multimodalWalkingDistance,
    transitFareGroup, transitEdgeEstimatedFare, reverseTransitPath, transitPathTransferStopIds, transitPathRouteIdentities, transitPathPassengerRouteIdentities,
    initializeTransitServiceRules, transitThroughConnection, transitPathTransferSummary, collapseMultimodalRouteLegs,
    preferCompletePublicTransitPlans, preferDestinationCompletingTransitPlans, preferVerifiedTransitRelations, automaticGroundConnectorPriority,
    compareAutomaticGroundConnectors, transitRelationLabel, findPreloadedTransitRelations,
    buildTransitBusRoutingQuery,
    hasCompleteTransitBusRoutingData,
    isBusStopNode, isReasonableTransitTransfer,
    collectTransitGraph, supplementTransitGraphStopsFromPreload,
    orderTransitGuideStops, collectTransitGuideGeometryOrder,
    collectTransitGuideMemberOrders, collectTransitGuideMemberOrderCandidates,
    isReliableTransitGuideMemberOrder, selectTransitGuideMemberOrderCandidates, isTransitGuideRoundtrip,
    transitGuideNamedStopIndex, transitGuideOrderAgreement, unfoldParallelTransitGuideWay,
    groundAccessWayAllowed, findGroundAccessRoute, transitConnectorPriority,
    isAutoTaxiDominatedTransitPlan, transitAutoTaxiFallbackTier,
    preferNearbyTransitStations,
    buildCrossCityRailPlans, buildRelationRailPlans, railStopsShareComponent, railLineCandidatesForStop, railNodeCandidatesForStop,
    railNavigationStationsForEdge, navigationStopsRepresentSameStation,
    filterReasonableRailPlans, preferNearbyRailStations, selectRailConnectorCandidates,
    railTaxiDistance, isReasonableRailTaxiFallback,
    transitRoutingStopPoint, transitStationWayPoint, transitPlanEndpointStop, stationSourcePoint,
    setNetwork(network) { transitNetworkData = network; },
    setSelectedTransitItems(items) { selectedTransitItems = items; },
    setRailwayData(data) { railwayRoutingData = data; },
    setRailInference(value) { allowInferredRailConnections = value; },
    setConnectorMode(mode) { routeConnectorMode = mode; },
  };
  return;
` + declarations, context);

const api = context.diagnosis;
api.initializeTransitServiceRules(JSON.parse(fs.readFileSync("outputs/ogf-atlas/transit-services.json", "utf8")));
const preload = JSON.parse(fs.readFileSync("outputs/ogf-atlas/transit-preload.json", "utf8"));
const relations = JSON.parse(fs.readFileSync("outputs/ogf-atlas/transit-relations.json", "utf8"));
const items = relations.snapshots.flatMap(x => x.elements);
api.initialize(items);
const network = api.hydrateTransitNetwork(preload.snapshots[0].network);
api.setNetwork(network);
api.enrichTransitNetworkRouteMetadata(network);
const graph = api.buildTransitRoutingGraph(network, new Set(["subway", "light_rail", "monorail", "tram", "train", "bus"]));
const line3Stops = network.stops.filter(x => x.routes.some(r => r.identity.endsWith(":JS03")));
const lines = network.lines.filter(x => x.routes.some(r => r.identity.endsWith(":JS03")));
const corridors = api.transitRoutingRelationCorridors(line3Stops[0].routes.find(r => r.identity.endsWith(":JS03")));
const stationByName = name => line3Stops.find(s => s.name === name);
const geometryComparison = [546911, 546912].map(id => {
  const relation = items.find(x => x.type === "relation" && x.id === id);
  const ways = relation.members.filter(x => x.type === "way").map(m => items.find(x => x.type === "way" && x.id === m.ref)).filter(Boolean);
  const route = line3Stops[0].routes.find(r => r.identity.endsWith(":JS03"));
  const separateCorridors = api.joinConnectedTransitLines(ways.filter(x => x.geometry?.length > 1).map(x => ({ ...x, routes: [route] })));
  return { relation: id, name: relation.tags.name,
    clockToRailwayStation: api.transitGeometryBetweenStops(stationByName("钟楼广场"), stationByName("津川火车站"), separateCorridors, "subway")?.distance,
  };
});
if (require.main === module) console.log(JSON.stringify({ geometryComparison,
  generatedClockToRailwayStation: graph.adjacency.get(String(stationByName("钟楼广场").id))
    .find(e => e.to === String(stationByName("津川火车站").id) && e.route?.identity.endsWith(":JS03"))?.distance,
}, null, 2));
if (require.main === module && !process.argv.includes("--compact")) console.log(JSON.stringify({
  snapshotDates: [preload.generatedAt, relations.generatedAt],
  line3Corridors: corridors.map(x => ({ id: x.id, length: api.transitGeometryLength(x.geometry) })),
  line3Stops: line3Stops.map(x => ({ id: x.id, name: x.name, lat: x.sourceLat ?? x.lat, lon: x.sourceLon ?? x.lon,
    projections: corridors.map(c => ({ offset: api.projectPointToTransitGeometry(x, c.geometry)?.distance,
      position: api.transitStopLinePosition(x, [c]) })),
    edges: (graph.adjacency.get(String(x.id)) || []).filter(e => e.route?.identity.endsWith(":JS03")).map(e => ({
      to: graph.stopsById.get(e.to)?.name, distance: e.distance, geometry: Boolean(e.geometrySegments),
    })),
  })),
}, null, 2));

function summary(plan) {
  const passengerRoutes = [...new Set(plan.path.edges
    .filter((edge) => edge.kind === "ride" && edge.route)
    .map((edge) => edge.route.identity || edge.route.routingIdentity))];
  const routeChanges = [];
  let previousRoute = null;
  plan.path.edges.forEach((edge, index) => {
    if (edge.kind !== "ride" || !edge.route) return;
    const routeIdentity = edge.route.routingIdentity || edge.route.identity;
    const previousIdentity = previousRoute?.routingIdentity || previousRoute?.identity;
    if (previousRoute && previousIdentity !== routeIdentity) {
      routeChanges.push({
        at: graph.stopsById.get(String(plan.path.stops[index]))?.name,
        from: previousIdentity,
        to: routeIdentity,
        connection: edge.connection,
      });
    }
    previousRoute = edge.route;
  });
  return { from: plan.originStop.name, to: plan.destinationStop.name,
    stops: plan.path.stops.map(x => graph.stopsById.get(String(x))?.name),
    routes: api.transitPathRouteIdentities(plan.path),
    passengerRoutes,
    routeChanges,
    transfers: plan.transfers,
    throughCount: plan.throughCount,
    rideDistance: plan.ride,
    access: plan.access, egress: plan.egress, durationMinutes: plan.duration / 60,
    accessConnector: plan.accessConnector && { mode: plan.accessConnector.mode, estimated: plan.accessConnector.estimated, duration: plan.accessConnector.duration },
    egressConnector: plan.egressConnector && { mode: plan.egressConnector.mode, estimated: plan.egressConnector.estimated, duration: plan.egressConnector.duration },
  };
}

module.exports = { api, context, network, graph, geometryComparison };

if (require.main === module) (async () => {
  const at = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    const [lat, lng] = index < 0 ? fallback : process.argv[index + 1].split(",").map(Number);
    return { lat, lng };
  };
  const origin = at("--origin", [14.5087644, 152.8256433]);
  const destination = at("--destination", [14.6593192, 152.8927349]);
  const origins = api.findRoutingStations(network.stops, origin, "transit", "origin");
  const destinations = api.findRoutingStations(network.stops, destination, "transit", "destination");
  const plans = api.buildMultimodalPlans(origin, destination, origins, destinations, graph, "transit");
  const selected = api.selectTransitConnectorCandidates(plans.filter(p => !p.fallbackRoutes), "recommended");
  const requestedSequence = ["JS03", "JS02", "JS04"];
  const requestedPlans = plans.filter((plan) => {
    const routeRefs = [...new Set(plan.path.edges.filter((edge) => edge.kind === "ride" && edge.route)
      .map((edge) => (edge.route.identity || edge.route.routingIdentity).split(":").at(-1)))];
    return plan.originStop.name === "东浦" && plan.destinationStop.name === "松硚"
      && routeRefs.join(">") === requestedSequence.join(">");
  });
  if (process.argv.includes("--only-requested")) {
    console.log(JSON.stringify({
      requestedSequencePlans: requestedPlans.map((plan) => ({ ...summary(plan), selected: selected.some((item) => item.id === plan.id) })),
      selectedCandidates: selected.map(summary),
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({ endpoint: destination, destinationCandidates: destinations.map(x => ({name: x.stop.name, distance: x.distance})),
    initialTop: api.rankMultimodalPlans(plans, "recommended").slice(0, 8).map(summary),
    requestedSequencePlans: requestedPlans.map((plan) => ({ ...summary(plan), selected: selected.some((item) => item.id === plan.id) })),
    selectedCandidates: process.argv.includes("--compact") ? undefined : selected.map(summary),
  }, null, 2));
  if (process.argv.includes("--roads")) {
    const comparisonPlans = plans.filter(p => !p.fallbackRoutes && ["钟楼广场", "文化中心"].includes(p.destinationStop.name)
      && p.originStop.name === origins[0].stop.name);
    for (const plan of comparisonPlans) await api.enrichPlanGroundConnectors(plan);
    console.log(JSON.stringify({ roadRanked: api.rankMultimodalPlans(comparisonPlans, "recommended").map(summary),
      inSelected: comparisonPlans.map(p => ({from: p.originStop.name, to: p.destinationStop.name, included: selected.some(s => s.id === p.id)})),
    }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
