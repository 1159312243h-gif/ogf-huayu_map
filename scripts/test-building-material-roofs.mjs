import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "../site/three-0.160.1.module.min.js";
import {pavilionTagRuntime as runtime} from "./test-pavilion-tags.mjs";
import {raisedSkillionRoof} from "./fixtures/roof-only.mjs";

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
const roofOnly = runtime.huayuLiveBuildingFeatureCollection([raisedSkillionRoof]).features[0];
assert.equal(roofOnly.properties.renderMinHeight, 4, "底高不能被最小墙高限制下压");
assert.equal(roofOnly.properties.renderHeight, 4.5, "总高不能被最低墙高限制抬升");
assert.equal(roofOnly.properties.roofHeight, .5);
assert.equal(roofOnly.properties.roofBaseHeight, 4);
assert.equal(roofOnly.properties.roofOnly, 1);
const roofOnlyTriangles = roofs.roofTriangles(roofOnly);
assert.equal(roofOnlyTriangles.length, 2);
assert.ok(roofOnlyTriangles.every(t => t.kind === "roof"), "屋顶占满全部高度时不能补侧墙或山墙");
assert.ok(roofOnlyTriangles.flatMap(t => t.points).every(p => p[2] >= 4 && p[2] <= 4.5));
const stillHasWalls = model({...raisedSkillionRoof.tags, min_height: "3.8"});
assert.equal(stillHasWalls.properties.roofOnly, undefined, "剩余 0.2 米墙体也必须如实保留");
assert.equal(stillHasWalls.properties.roofBaseHeight, 4);
assert.equal(stillHasWalls.properties.renderMinHeight, 3.8);
assert.ok(roofs.roofTriangles(stillHasWalls).some(t => t.kind === "wall"));
assert.equal(model({...raisedSkillionRoof.tags, "roof:height": "1"}).properties.roofModel, undefined,
  "屋顶高超过底高到总高的有效空间时回退，不能改写尺寸或假造墙高");

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

const aliases = {gable:"gabled",gabled:"gabled",hip:"hipped","half hipped":"half-hipped",
  pyramid:"pyramidal",shed:"skillion",skillion:"skillion"};
for (const [tag,shape] of Object.entries(aliases)) assert.equal(runtime.huayuRoofShape({"roof:shape":tag}),shape);
assert.equal(runtime.huayuRoofShape({"roof:shape":"unknown_shape"}),"");

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

let wallHeight, wallFilter = ["==", ["get", "structureKind"], "building"];
const originalWallFilter = wallFilter;
const originalCapFilter = ["any", ["has", "ancientKind"], ["has", "roof:colour"],
  ["has", "roof:color"], ["has", "roofMaterialColor"]];
let capFilter = originalCapFilter;
const map = {
  on(){},off(){},getStyle(){return {layers:[]};},getLayer(id){return ["live-building","roof-cap"].includes(id);},
  getPaintProperty(){return wallHeight;},setPaintProperty(id,name,value){if(name==="fill-extrusion-height")wallHeight=value;},
  getFilter(id){return id==="roof-cap"?capFilter:wallFilter;},
  setFilter(id, filter){if(id==="roof-cap")capFilter=filter;else wallFilter=filter;},
  getPitch(){return 45;},getZoom(){return 16;},triggerRepaint(){},removeLayer(){},
};
const options={enabled:true,satellite:false,night:false,buildingLayer:"live-building",roofCapLayer:"roof-cap",wallDefault:"#aaa",
  roofDefault:"#999",ancientWall:"#876",ancientRoof:"#765"};
const controller=roofs.sync(map,{type:"FeatureCollection",features:[materialOnly]},options);
controller.setWallMode(true);
// Evaluate the emitted paint with the string-ID coercion used by GeoJSON
// tiling. Only actual modeled OSM objects may have their walls shortened.
function evaluate(expression,feature) {
  if(!Array.isArray(expression))return expression;
  const [op,...args]=expression,run=value=>evaluate(value,feature);
  if(op==="literal")return args[0];
  if(op==="get")return feature.properties[args[0]] ?? null;
  if(op==="has")return feature.properties[args[0]]!==undefined;
  if(op==="id")return feature.id;
  if(op==="case")return run(args[0])?run(args[1]):run(args[2]);
  if(op==="all")return args.every(run);if(op==="any")return args.some(run);
  if(op==="==")return run(args[0])===run(args[1]);
  if(op==="!")return !run(args[0]);
  if(op==="in")return run(args[1]).includes(run(args[0]));
  if(op==="concat")return args.map(run).join("");
  if(op==="to-string")return String(run(args[0]));
  if(op==="coalesce")return args.map(run).find(v=>v!==null && v!==undefined);
  if(op==="+")return args.map(run).reduce((a,b)=>a+b,0);
  if(op==="to-color"){
    for(const argument of args){const value=run(argument);if(typeof value==="string" && value.startsWith("#"))return value;}
    return undefined;
  }
  throw new Error(`Unexpected paint operator: ${op}`);
}
const tiled={...materialOnly,id:0};
assert.equal(evaluate(wallHeight,tiled),8,"tiled string IDs must not leave a flat cap hiding the modeled roof");
assert.equal(evaluate(capFilter,tiled),false,"成功坡顶不能被同源平顶颜色盖板遮挡");
const coloredComplex=model({height:"8","building:colour":"#ffffff","roof:colour":"#575757",
  "roof:shape":"gabled"},pentagon);
coloredComplex.properties.osmId="3";
assert.equal(evaluate(capFilter,coloredComplex),true,"复杂轮廓回退仍保留独立屋顶颜色");
for(const properties of [{...tiled.properties,osmType:"relation"},{...tiled.properties,osmId:"2"},
  {...tiled.properties,roofModel:undefined}])assert.equal(evaluate(wallHeight,{...tiled,properties}),10,
    "unmodeled objects keep their complete native height, including way/relation ID collisions");
const modeledItems=controller.items;controller.items=[];controller.setWallMode(true);
assert.equal(evaluate(wallHeight,tiled),10,"valid roof tags alone cannot shorten walls after the mesh budget excludes a building");
controller.items=modeledItems;
controller.setWallMode(false);
assert.deepEqual(capFilter,originalCapFilter,"俯视、卫星或模型失败恢复完整顶面过滤");
assert.deepEqual(JSON.parse(JSON.stringify(wallHeight)),["get","renderHeight"],
  "坡屋顶关闭或失败时墙体必须恢复完整平屋顶高度");
controller.update({type:"FeatureCollection",features:[roofOnly,materialOnly]}, options);
controller.setWallMode(true);
assert.equal(evaluate(wallFilter, roofOnly), false, "成功屋面接管后排除零厚度原生挤出的平顶盖板");
assert.equal(evaluate(capFilter,roofOnly),false,"零墙高屋面接管后不能重新添加水平底板");
assert.equal(evaluate(wallFilter, materialOnly), true, "普通建筑墙体不受屋面过滤影响");
assert.equal(evaluate(wallFilter, {...roofOnly, properties:{...roofOnly.properties,osmType:"relation"}}), true,
  "同号关系与道路不能混淆，只接管实际已建模的要素");
controller.items=[]; controller.setWallMode(true);
assert.deepEqual(wallFilter, originalWallFilter, "模型预算或准备失败时不能隐藏原建筑");
controller.setWallMode(false);
assert.deepEqual(wallFilter, originalWallFilter);
controller.update({type:"FeatureCollection",features:[materialOnly]}, options);
assert.equal(controller.wanted(),true);
controller.update(controller.data,{...options,satellite:true});
assert.equal(controller.wanted(),false,"模拟卫星不得启用三维坡屋顶");
map.getPitch=()=>0;
controller.update(controller.data,{...options,satellite:false});
assert.equal(controller.wanted(),false,"俯视不得启用三维坡屋顶");
roofs.dispose(map);

// Exercise the production layer definitions, so separate roof colours cannot
// silently disappear when a valid footprint needs the native flat fallback.
const appSource=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const layerDefinitions=new Map(),sources=new Set();
Object.assign(runtime,{
  HUAYU_LIVE_BUILDING_SOURCE:"buildings",HUAYU_LIVE_BUILDING_LAYER:"live-building",HUAYU_LIVE_BUILDING_MIN_ZOOM:10,
  HUAYU_CITY_WALL_LAYERS:{fill:"wall"},HUAYU_ANCIENT_BUILDING_LAYERS:{roof:"roof-cap",outline:"outline"},
  huayuCityWallInsertionLayer:()=>undefined,positionHuayuSportsBelowBuildings:()=>{},
  positionHuayuWallsAboveBuildings:()=>{},positionHuayuElevatedGreenAboveBuildings:()=>{},
  huayuOverlayPalette:()=>({night:false,buildingColors:["#aaa","#bbb","#ccc","#ddd","#eee"],
    ancientWall:"#fff",ancientRoof:"#555",ancientOutline:"#333",buildingOpacity:1}),
});
for(const name of ["huayuBuildingColorExpression","ensureHuayuLiveBuildingLayer"])
  vm.runInContext(appSource.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))[0],runtime);
runtime.ensureHuayuLiveBuildingLayer({getStyle:()=>({layers:[{id:"ground"}]}),
  getSource:id=>sources.has(id),addSource:id=>sources.add(id),getLayer:id=>layerDefinitions.get(id),
  addLayer:layer=>layerDefinitions.set(layer.id,layer)});
assert.equal(layerDefinitions.size,3,"颜色恢复复用既有顶面层，不增加模型图层");
const capDefinition=layerDefinitions.get("roof-cap"),wallDefinition=layerDefinitions.get("live-building");
const flat=model({height:"8","roof:shape":"flat","building:colour":"#ffffff","roof:colour":"#575757"});
const holed=runtime.huayuLiveBuildingFeatureCollection([
  {type:"relation",id:810,tags:{building:"yes",type:"multipolygon",height:"8","roof:shape":"gabled",
    "roof:colour":"#575757","building:colour":"#ffffff"},members:[{type:"way",ref:811,role:"outer"},{type:"way",ref:812,role:"inner"}]},
  {...rectangle({},[[0,0],[.0002,0],[.0002,.0002],[0,.0002],[0,0]]),id:811,tags:{}},
  {...rectangle({},[[.00005,.00005],[.00015,.00005],[.00015,.00015],[.00005,.00015],[.00005,.00005]]),id:812,tags:{}},
]).features[0];
assert.equal(holed.geometry.coordinates.length,2,"庭院孔洞必须留在原始同源轮廓中");
for(const feature of [flat,coloredComplex,holed]) {
  assert.equal(evaluate(capDefinition.filter,feature),true);
  assert.equal(evaluate(capDefinition.paint["fill-extrusion-color"],feature),"#575757");
  assert.equal(evaluate(wallDefinition.paint["fill-extrusion-color"],feature),"#ffffff");
  assert.equal(evaluate(capDefinition.paint["fill-extrusion-height"],feature),8);
  assert.equal(evaluate(capDefinition.paint["fill-extrusion-base"],feature),8,"仅涂顶面，不添加厚度或改总高");
}
const ancient=model({building:"temple",height:"8"});
assert.ok(evaluate(capDefinition.paint["fill-extrusion-height"],ancient)>8,"保留原先古建筑薄压檐");
assert.equal(evaluate(capDefinition.filter,model({height:"8"})),false,"未标屋顶颜色的普通建筑不强制改色");

// Exercise the actual mesh/material path: the upper walls must use the same
// evaluated colour as native extrusions, including palette/material fallbacks.
roofContext.maplibregl={MercatorCoordinate:{fromLngLat:([lon,lat])=>({x:0.5+lon/360,y:0.5-lat/360,
  meterInMercatorCoordinateUnits:()=>1/40075016.68557849})}};
let bearing=90,anchor="viewport",nativeColor={r:0.2,g:0.3,b:0.4},evaluatedFeature;
const lightValues={position:{x:0.3,y:-0.5,z:1},color:{r:1,g:0.8,b:0.7},intensity:0.6};
const paintValues={"fill-extrusion-color":{evaluate(feature){evaluatedFeature=feature;return nativeColor;}},
  "fill-extrusion-vertical-gradient":true,"fill-extrusion-opacity":1};
const renderMap={...map,getPitch:()=>45,getBearing:()=>bearing,getTerrain:()=>null,
  style:{getLayer:()=>({paint:{get:key=>paintValues[key]}}),
    light:{properties:{get:key=>key==="anchor"?anchor:lightValues[key]}}}};
const renderController=roofs.sync(renderMap,{type:"FeatureCollection",features:[explicitAndMaterial]},options);
renderController.T=THREE;renderController.scene=new THREE.Scene();renderController.build();
assert.equal(evaluatedFeature,explicitAndMaterial);
const wallGroup=renderController.geometry.groups[1],wallStart=wallGroup.start;
assert.equal(wallGroup.count,6);
for(let i=wallStart;i<wallStart+wallGroup.count;i++) {
  const color=renderController.geometry.attributes.color;
  [color.getX(i),color.getY(i),color.getZ(i)].forEach((value,j)=>
    assert.ok(Math.abs(value-Object.values(nativeColor)[j])<1e-6,"山墙必须读取原生墙体最终取色，不能使用屋顶色或固定默认色"));
}
const roofColor=new THREE.Color("#654321"),meshColors=renderController.geometry.attributes.color;
assert.ok(Math.abs(meshColors.getX(0)-roofColor.r)<1e-6,"屋顶坡面继续独立使用屋顶颜色");
const uniforms=renderController.wallMaterial.uniforms;
assert.ok(Math.abs(uniforms.wallLightPosition.value.x-0.5)<1e-6);
assert.ok(Math.abs(uniforms.wallLightPosition.value.y-0.3)<1e-6,"转动地图时山墙灯光须跟随原生墙体");
anchor="map";renderController.updateWallLighting();
assert.equal(uniforms.wallLightPosition.value.x,0.3,"地图固定光源不能随相机转动");
assert.equal(uniforms.wallLightIntensity.value,0.6);
assert.equal(uniforms.wallLightColor.value.y,0.8);
paintValues["fill-extrusion-vertical-gradient"]=false;
paintValues["fill-extrusion-opacity"]=0.7;renderController.updateWallLighting();
assert.equal(uniforms.wallVerticalGradient.value,0);
assert.equal(uniforms.wallOpacity.value,0.7);
assert.equal(renderController.wallMaterial.transparent,true);

const normals=Array.from(renderController.geometry.attributes.normal.array).slice(wallStart*3);
const reversed=structuredClone(explicitAndMaterial);reversed.geometry.coordinates[0].reverse();
renderController.update({type:"FeatureCollection",features:[reversed]},options);renderController.build();
const reversedNormals=Array.from(renderController.geometry.attributes.normal.array).slice(wallStart*3);
const normalsByFace=values=>Array.from({length:values.length/9},(_,i)=>values.slice(i*9,i*9+3).join(",")).sort();
assert.deepEqual(normalsByFace(normals),normalsByFace(reversedNormals),"源轮廓反向不能使山墙光照翻转");

const multiple=structuredClone(explicitAndMaterial),firstRing=multiple.geometry.coordinates;
multiple.geometry={type:"MultiPolygon",coordinates:[firstRing,firstRing.map(ring=>ring.map(([x,y])=>[x+0.001,y]))]};
renderController.update({type:"FeatureCollection",features:[multiple]},options);renderController.build();
const multiNormals=Array.from(renderController.geometry.attributes.normal.array).slice(renderController.geometry.groups[1].start*3);
assert.deepEqual(normalsByFace(multiNormals),[...normalsByFace(normals),...normalsByFace(normals)].sort(),
  "多面建筑须按各自轮廓判断山墙朝向，不能共用全建筑中心");
nativeColor={r:0.08,g:0.1,b:0.12};
renderController.update(renderController.data,{...options,night:true});renderController.build();
assert.ok(Math.abs(renderController.geometry.attributes.color.getX(renderController.geometry.groups[1].start)-0.08)<1e-6,
  "日夜切换后须重新使用原生墙体颜色");
renderController.update({type:"FeatureCollection",features:[roofOnly]},options); renderController.build();
assert.equal(renderController.geometry.groups[0].count,6,"实际 GPU 几何只包含两块单坡屋面三角形");
assert.equal(renderController.geometry.groups[1].count,0,"不能在实际渲染路径重新补出白色侧墙");
const canopyPositions=renderController.geometry.attributes.position;
for(let i=0;i<canopyPositions.count;i++) assert.ok(canopyPositions.getZ(i)>=4-1e-6 && canopyPositions.getZ(i)<=4.5+1e-6);
let disposed=0;
for(const resource of [renderController.geometry,renderController.material,renderController.wallMaterial])
  resource.addEventListener("dispose",()=>disposed++);
renderMap.getStyle=()=>undefined;
renderMap.getLayer=()=>{throw new Error("removed MapLibre style must not be queried");};
roofs.dispose(renderMap);
assert.equal(disposed,3,"底图已销毁时同样释放屋顶与山墙几何和材质，不再访问旧图层");

console.log(JSON.stringify({status:"passed",materials:Object.keys(wallMaterials).length,
  roofShapes:Object.keys(shapes),wallColorContinuity:true,
  fallbacks:["complex","holes","overhead","satellite","controller"]}));
