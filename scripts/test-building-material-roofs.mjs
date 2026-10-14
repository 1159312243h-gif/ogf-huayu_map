import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {pavilionTagRuntime as runtime} from "./test-pavilion-tags.mjs";

const roofSource = await readFile(new URL("../site/building-roofs.js", import.meta.url), "utf8");
const roofContext = vm.createContext({console, setTimeout, clearTimeout,
  CSS:{supports:(kind,value)=>kind === "color" && /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\(|hsla?\()/iu.test(value)}});
vm.runInContext(roofSource, roofContext);
const roofs = roofContext.HuayuBuildingRoofs;
assert.ok(roofs, "坡屋顶控制器必须作为独立浏览器模块导出");

const rectangle = (tags = {}, coordinates = [[0,0],[0.0002,0],[0.0002,0.0001],[0,0.0001],[0,0]]) => ({
  type:"way", id:1, tags:{building:"yes",...tags},
  geometry:coordinates.map(([lon,lat])=>({lon,lat})),
});
const model = (tags, coordinates) => runtime.huayuLiveBuildingFeatureCollection([rectangle(tags,coordinates)]).features[0];

const wallMaterials = {
  brick:"#b77b61", bricks:"#b77b61", masonry:"#b77b61", stone_blocks:"#9d9990",
  reinforced_concrete:"#aaa79e", stucco:"#d5c7ad", timber:"#9b7655", aluminium:"#8d999d",
};
for (const [material,color] of Object.entries(wallMaterials)) {
  assert.equal(runtime.huayuBuildingMaterialColor(material,false,false),color,`墙面材质 ${material} 应稳定归一化`);
  assert.ok(runtime.huayuBuildingMaterialColor(material,false,true),`墙面材质 ${material} 应有夜间色`);
}
assert.equal(runtime.huayuBuildingMaterialColor("clay_tiles",true,false),"#a45f49");
assert.equal(runtime.huayuBuildingMaterialColor("unknown_material",false,false),"");
const materialProperties = runtime.huayuBuildingMaterialProperties({"building:material":"bricks","roof:material":"clay tiles"});
assert.equal(materialProperties.buildingMaterialColor,"#b77b61");
assert.equal(materialProperties.roofMaterialColor,"#a45f49");
assert.equal(materialProperties.buildingMaterialNightColor,"#745044");

const explicitAndMaterial = model({height:"10","building:colour":"#123456","building:material":"brick",
  "roof:colour":"#654321","roof:material":"slate","roof:shape":"gabled","roof:height":"2"});
assert.equal(roofs.taggedColor(explicitAndMaterial.properties,false,false,{wallDefault:"#fff"}),"#123456",
  "明确墙色必须优先于建筑材质");
assert.equal(roofs.taggedColor(explicitAndMaterial.properties,true,false,{roofDefault:"#fff"}),"#654321",
  "明确屋顶色必须优先于屋顶材质");
const materialOnly = model({height:"10","building:material":"glass","roof:material":"slate",
  "roof:shape":"gabled","roof:height":"2"});
assert.equal(roofs.taggedColor(materialOnly.properties,false,false,{wallDefault:"#fff"}),"#73aab7");
assert.equal(roofs.taggedColor(materialOnly.properties,true,true,{roofDefault:"#fff"}),"#40474d");

const aliases = {gable:"gabled",gabled:"gabled",hip:"hipped","half hipped":"hipped",
  pyramid:"pyramidal",shed:"skillion",skillion:"skillion"};
for (const [tag,shape] of Object.entries(aliases)) assert.equal(runtime.huayuRoofShape({"roof:shape":tag}),shape);
assert.equal(runtime.huayuRoofShape({"roof:shape":"dome"}),"");

const shapes = {
  gabled:{roof:4,wall:2,total:6},
  hipped:{roof:6,wall:0,total:6},
  pyramidal:{roof:4,wall:0,total:4},
  skillion:{roof:2,wall:4,total:6},
};
for (const [shape,counts] of Object.entries(shapes)) {
  const feature = model({height:"10","roof:shape":shape,"roof:height":"2"});
  assert.equal(feature.properties.roofModel,1);
  assert.equal(feature.properties.roofBaseHeight,8);
  assert.equal(feature.properties.roofTopHeight,10,"明确总高度必须包含屋顶而不是额外增高");
  const triangles = roofs.roofTriangles(feature);
  assert.equal(triangles.length,counts.total,`${shape} 三角面数量`);
  assert.equal(triangles.filter(item=>item.kind==="roof").length,counts.roof);
  assert.equal(triangles.filter(item=>item.kind==="wall").length,counts.wall);
  assert.ok(triangles.flatMap(item=>item.points).every(point=>point[2]===8||point[2]===10));
  assert.ok(triangles.every(({points:[a,b,c]}) => {
    const first=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],second=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const cross=[first[1]*second[2]-first[2]*second[1],first[2]*second[0]-first[0]*second[2],
      first[0]*second[1]-first[1]*second[0]];
    return Math.hypot(...cross)>1e-12;
  }),`${shape} 不得生成退化三角面`);
}

const levelsRoof = model({"building:levels":"2","roof:shape":"gabled","roof:levels":"1"});
assert.equal(levelsRoof.properties.roofBaseHeight,6);
assert.equal(levelsRoof.properties.roofTopHeight,9,"仅楼层高度时屋顶应加在墙体之上");
const angleRoof = model({height:"12","roof:shape":"gabled","roof:angle":"45"});
assert.ok(angleRoof.properties.roofHeight>5 && angleRoof.properties.roofHeight<6,
  "roof:angle 应按建筑短边半跨计算屋顶高度");
assert.equal(runtime.huayuRoofDirection({"roof:direction":"NE"}),45);
assert.equal(runtime.huayuRoofDirection({"roof:direction":"-90deg"}),270);
const directionFeature = model({height:"10","roof:shape":"gabled","roof:height":"2","roof:direction":"E",
  "roof:orientation":"across"});
assert.equal(directionFeature.properties.roofDirection,90);
assert.equal(directionFeature.properties.roofOrientation,"across");
assert.notDeepEqual(roofs.orientedRing(roofs.polygons(directionFeature)[0],directionFeature.properties)[0],
  roofs.polygons(directionFeature)[0][0],"屋脊方向标签应改变矩形的定向边组");

const pentagon = [[0,0],[0.0002,0],[0.00024,0.00005],[0.0001,0.00012],[0,0.00008],[0,0]];
const complex = model({height:"10","roof:shape":"gabled"},pentagon);
assert.equal(complex.properties.roofModel,undefined,"复杂非四边形建筑必须保留平屋顶");
assert.deepEqual(JSON.parse(JSON.stringify(complex.geometry.coordinates[0])),pentagon,
  "屋顶识别不得修改原始建筑轮廓");
assert.equal(JSON.stringify(runtime.huayuBuildingRoofProperties({"roof:shape":"gabled"},
  {type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]],
    [[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8],[0.2,0.2]]]},10,0)),
"{}","带孔建筑必须回退完整平屋顶");

const relation = {type:"relation",id:10,tags:{building:"yes","building:material":"wood",
  "roof:material":"thatch","roof:shape":"gabled","roof:height":"2"},
members:[{type:"way",ref:11,role:"outer"}]};
const relationMember = {...rectangle({},[[1,0],[1.0002,0],[1.0002,0.0001],[1,0.0001],[1,0]]),id:11,tags:{}};
const relationFeature = runtime.huayuLiveBuildingFeatureCollection([relation,relationMember]).features[0];
assert.equal(relationFeature.properties.buildingMaterialColor,"#9b7655");
assert.equal(relationFeature.properties.roofMaterialColor,"#ae9460");
assert.equal(relationFeature.properties.roofModel,1,"关系建筑应保留材质与简单坡屋顶");

let wallHeight;
const map = {
  on(){},off(){},getStyle(){return {layers:[]};},getLayer(id){return id==="live-building";},
  getPaintProperty(){return wallHeight;},setPaintProperty(id,name,value){if(name==="fill-extrusion-height")wallHeight=value;},
  getPitch(){return 45;},getZoom(){return 16;},triggerRepaint(){},removeLayer(){},
};
const options={enabled:true,satellite:false,night:false,buildingLayer:"live-building",wallDefault:"#aaa",
  roofDefault:"#999",ancientWall:"#876",ancientRoof:"#765"};
const controller=roofs.sync(map,{type:"FeatureCollection",features:[materialOnly]},options);
controller.setWallMode(true);
assert.deepEqual(JSON.parse(JSON.stringify(wallHeight)),["case",["==",["get","roofModel"],1],
  ["get","roofBaseHeight"],["get","renderHeight"]]);
controller.setWallMode(false);
assert.deepEqual(JSON.parse(JSON.stringify(wallHeight)),["get","renderHeight"],
  "坡屋顶关闭或失败时墙体必须恢复完整平屋顶高度");
assert.equal(controller.wanted(),true);
controller.update(controller.data,{...options,satellite:true});
assert.equal(controller.wanted(),false,"模拟卫星不得启用三维坡屋顶");
map.getPitch=()=>0;
controller.update(controller.data,{...options,satellite:false});
assert.equal(controller.wanted(),false,"俯视不得启用三维坡屋顶");
roofs.dispose(map);

console.log(JSON.stringify({status:"passed",materials:Object.keys(wallMaterials).length,
  roofShapes:Object.keys(shapes),fallbacks:["complex","holes","overhead","satellite","controller"]}));
