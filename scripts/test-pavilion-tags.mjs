import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const runtime = vm.createContext({});
export const pavilionTagRuntime = runtime;
for (const name of [
  "parseHuayuWallMeasurement", "huayuWallCoordinates", "huayuWallPointKey", "huayuWallJoinRings",
  "huayuWallRingArea", "huayuNormalizedWallRing", "huayuWallPointInRing", "huayuCityWallRelationGeometry",
  "huayuPavilionKind", "huayuLiveBuildingHeight", "huayuAncientBuildingKind", "huayuAncientRoofCapHeight",
  "huayuLiveBuildingTags", "huayuPavilionRoofDepth", "huayuLiveBuildingMinHeight",
  "huayuPavilionPointSegmentDistanceMeters", "huayuPavilionRoadHalfWidth", "huayuPavilionNodeRadius",
  "huayuPavilionNodeGeometry", "huayuPavilionRingPerimeter", "huayuPavilionSampleRing",
  "huayuPavilionPolygonContainsPoint", "huayuPavilionDistanceToRings", "huayuPavilionInteriorPoint",
  "huayuPavilionMoveTowardMeters", "huayuPavilionColumnRing", "huayuPavilionInsetColumnCenter",
  "huayuPavilionColumnGeometry", "huayuIsPublicTransportShelter", "huayuBuildingColorProperties", "huayuLiveBuildingFeatureCollection",
  "huayuPavilionFeatureCollection",
]) {
  const declaration = app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, `Missing pavilion dependency: ${name}`);
  vm.runInContext(declaration, runtime);
}

const rectangle = (id, x, tags) => ({type:"way", id, tags,
  geometry:[[x,0],[x+0.00012,0],[x+0.00012,0.00012],[x,0.00012],[x,0]]
    .map(([lon,lat]) => ({lon,lat})),
});
export const pavilionTagFixtures = [
  {type:"node",id:1,lat:0.00006,lon:0.00006,tags:{leisure:"gazebo",name:"休憩处",height:"5.2"}},
  rectangle(2,0.00025,{building:"pavilion",name:"凉亭",height:"4.8"}),
  rectangle(3,0.0005,{building:"yes",name:"晴风亭",height:"8"}),
  rectangle(4,0.00075,{building:"roof",name:"望湖亭",height:"6"}),
  {type:"node",id:5,lat:0.00025,lon:0.00006,tags:{tourism:"attraction",name:"睡莲亭"}},
  {type:"node",id:6,lat:0.00025,lon:0.00031,tags:{amenity:"shelter",name:"休息亭"}},
  rectangle(7,0.001,{building:"yes","building:part":"gazebo",name:"观景处"}),
  rectangle(8,0.00125,{}),
  {type:"relation",id:9,tags:{type:"multipolygon",man_made:"gazebo",name:"园中建筑"},
    members:[{type:"way",ref:8,role:"outer"}]},
  {type:"node",id:10,lat:0.00025,lon:0.00056,
    tags:{leisure:"gazebo",amenity:"shelter",shelter_type:"public_transport",bus:"yes"}},
];

// Feed the same mixed payload to both renderers, including old cached name-only candidates.
export const pavilionTagModels = JSON.parse(JSON.stringify(runtime.huayuPavilionFeatureCollection(pavilionTagFixtures)));
export const ordinaryBuildingModels = JSON.parse(JSON.stringify(runtime.huayuLiveBuildingFeatureCollection(pavilionTagFixtures)));
const roofs = pavilionTagModels.features.filter(feature => feature.properties.pavilionPart === "roof");
assert.deepEqual(roofs.map(feature => feature.properties.osmId), ["1","2","7","9"]);
assert.equal(pavilionTagModels.features.length,12,"each tagged pavilion retains roof, base and open columns");
for (const roof of roofs) {
  const parts = pavilionTagModels.features.filter(feature => feature.properties.osmId === roof.properties.osmId);
  assert.deepEqual(parts.map(feature => feature.properties.pavilionPart),["roof","base","column"]);
  assert.ok(roof.properties.renderMinHeight > 0,"tagged pavilions retain hollow interiors");
  assert.deepEqual(parts[1].geometry,roof.geometry,"pavilion floor follows its footprint");
  const polygon = roof.geometry.coordinates;
  assert.ok(parts[2].geometry.coordinates.every(column => column[0].slice(0,-1)
    .every(point => runtime.huayuPavilionPolygonContainsPoint(point,polygon))),"columns stay under the roof");
}
assert.equal(roofs[0].properties.renderHeight,5.2,"point pavilion uses tagged height");
assert.equal(roofs[1].properties.renderHeight,4.8,"area pavilion uses tagged height");
assert.deepEqual(roofs[1].geometry.coordinates[0],pavilionTagFixtures[1].geometry.map(({lon,lat}) => [lon,lat]));
assert.deepEqual(ordinaryBuildingModels.features.map(feature => feature.properties.osmId),["3","4"]);
assert.ok(ordinaryBuildingModels.features.every(feature => feature.properties.structureKind === "building"
  && feature.properties.renderMinHeight === 0 && !feature.properties.pavilionPart),
  "name-only candidates remain ordinary buildings without pavilion roofs or columns");
assert.equal(ordinaryBuildingModels.features[0].properties.renderHeight,8,"ordinary building keeps its height");
console.log(JSON.stringify({status:"passed",taggedPavilions:roofs.length,
  ordinaryBuildings:ordinaryBuildingModels.features.length,nameOnlyAndTransitPavilions:0}));
