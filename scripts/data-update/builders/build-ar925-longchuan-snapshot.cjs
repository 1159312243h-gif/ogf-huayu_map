const fs = require("node:fs");

const rawPath = "work/ar925-longchuan-transit-raw.json";
const preloadPath = "outputs/ogf-atlas/transit-preload.json";
const relationsPath = "outputs/ogf-atlas/transit-relations.json";
const railwayRoutingPath = "outputs/ogf-atlas/railway-routing.json";
const snapshotBounds = [[-0.39, 141.53], [0.25, 142.10]];
const snapshotId = "longchuan-ar925";

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const containsPoint = (point) => point && point.lat >= snapshotBounds[0][0]
  && point.lat <= snapshotBounds[1][0] && point.lon >= snapshotBounds[0][1]
  && point.lon <= snapshotBounds[1][1];
const localWays = raw.elements.filter((item) => item.type === "way"
  && Array.isArray(item.geometry) && item.geometry.some(containsPoint));
const localWayIds = new Set(localWays.map((item) => item.id));
const localRailwayWays = localWays.filter((way) =>
  ["rail", "narrow_gauge", "subway", "light_rail", "tram", "monorail"].includes(way.tags?.railway));
const localNodes = raw.elements.filter((item) => item.type === "node" && containsPoint(item));
const localNodeIds = new Set(localNodes.map((item) => item.id));
const routeRelations = raw.elements.filter((item) => item.type === "relation" && item.tags?.type === "route");
const localRouteRelations = routeRelations.filter((item) => (item.members || []).some((member) =>
  (member.type === "way" && localWayIds.has(member.ref))
  || (member.type === "node" && localNodeIds.has(member.ref))));
const localRouteIds = new Set(localRouteRelations.map((item) => item.id));
const localMasterRelations = raw.elements.filter((item) => item.type === "relation"
  && item.tags?.type === "route_master"
  && (item.members || []).some((member) => member.type === "relation" && localRouteIds.has(member.ref)));
const localRelationIds = new Set([...localRouteIds, ...localMasterRelations.map((item) => item.id)]);
const localRelations = [...localMasterRelations, ...localRouteRelations]
  .map((relation) => ({
    ...relation,
    members: (relation.members || []).filter((member) => (member.type === "way" && localWayIds.has(member.ref))
      || (member.type === "node" && localNodeIds.has(member.ref))
      || (member.type === "relation" && localRelationIds.has(member.ref))),
    tags: { ...(relation.tags || {}), "ogf_atlas:snapshot_clip": snapshotId },
  }));
const elements = [...localRelations, ...localWays, ...localNodes];
const railInfrastructure = localRailwayWays
  .filter((way) => ["rail", "narrow_gauge"].includes(way.tags?.railway) && !way.tags?.service)
  .map((way) => ({
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
  id: snapshotId,
  label: "龙川市 Loongchuan（AR925）",
  bounds: snapshotBounds,
  elements,
  railInfrastructure,
};

const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
preload.snapshots = (preload.snapshots || []).filter((item) => item.id !== snapshotId);
preload.snapshots.push(snapshot);
preload.generatedAt = new Date().toISOString();
fs.writeFileSync(preloadPath, JSON.stringify(preload));

const relations = JSON.parse(fs.readFileSync(relationsPath, "utf8"));
relations.snapshots = (relations.snapshots || []).filter((item) => item.id !== snapshotId);
relations.snapshots.push({
  id: snapshot.id,
  label: snapshot.label,
  bounds: snapshot.bounds,
  elements: snapshot.elements,
});
relations.generatedAt = preload.generatedAt;
fs.writeFileSync(relationsPath, JSON.stringify(relations));

const railwayRouting = JSON.parse(fs.readFileSync(railwayRoutingPath, "utf8"));
const routingWays = new Map((railwayRouting.ways || []).map((way) => [way[0], way]));
localRailwayWays.filter((way) => Array.isArray(way.nodes) && way.nodes.length === way.geometry.length)
  .forEach((way) => routingWays.set(way.id, [
    way.id,
    way.nodes,
    way.geometry.map((point) => [point.lat, point.lon]),
    way.tags?.name || "",
    way.tags?.maxspeed || "",
    way.tags?.highspeed === "yes" ? 1 : 0,
  ]));
railwayRouting.ways = [...routingWays.values()];
railwayRouting.generatedAt = preload.generatedAt;
railwayRouting.coverage = {
  ...(railwayRouting.coverage || {}),
  additionalRegions: [...new Set([
    ...(railwayRouting.coverage?.additionalRegions || [])
      .filter((region) => !/AR925\s+(?:Longchuan|Loongchuan)/iu.test(region)),
    "AR925 Loongchuan (龙川市)",
  ])],
  longchuanAr925Ways: localRailwayWays.length,
};
fs.writeFileSync(railwayRoutingPath, JSON.stringify(railwayRouting));

console.log(JSON.stringify({
  id: snapshot.id,
  label: snapshot.label,
  bounds: snapshot.bounds,
  elements: snapshot.elements.length,
  relations: localRelations.length,
  routeTypes: [...new Set(localRouteRelations.map((relation) => relation.tags?.route).filter(Boolean))],
  railwayWays: localRailwayWays.length,
  stations: localNodes.filter((node) => node.tags?.name).map((node) => node.tags.name),
  infrastructureWays: railInfrastructure.length,
  railwayRoutingWays: railwayRouting.ways.length,
}, null, 2));
