import assert from "node:assert/strict";
import {pavilionTagRuntime as runtime} from "./test-pavilion-tags.mjs";

export const buildingColorCases = [
  {label:"color=blue",tags:{color:"blue"},wall:"#0000ff"},
  {label:"colour=#e75480",tags:{colour:"#e75480"},wall:"#e75480"},
  {label:"建筑专用颜色优先",tags:{"building:colour":"#2e8b57","building:color":"red",color:"blue"},wall:"#2e8b57"},
  {label:"兼容 building:color",tags:{"building:color":"RGB(255, 165, 0)"},wall:"#ffa500"},
  {label:"无井号色值",tags:{color:" 663399 "},wall:"#663399"},
  {label:"无效值回退下一标签",tags:{"building:colour":"invalid",colour:"#09f"},wall:"#0099ff"},
  {label:"全部无效使用默认色",tags:{color:"definitely-not-a-color"},wall:null},
  {label:"古建筑墙面与屋顶",tags:{building:"temple",color:"#dc143c","roof:colour":"#4169e1"},wall:"#dc143c",roof:"#4169e1"},
  {label:"仅屋顶标签不改墙面",tags:{building:"temple","roof:color":"hsl(120,100%,25%)"},wall:null,roof:"#008000"},
];
export const buildingColorFixtures = buildingColorCases.map((item,index) => {
  const x=index*0.00022;
  return {type:"way",id:101+index,tags:{building:"yes",name:item.label,height:"7",...item.tags},
    geometry:[[x,0],[x+0.00012,0],[x+0.00012,0.00012],[x,0.00012],[x,0]]
      .map(([lon,lat]) => ({lon,lat}))};
});
export const buildingColorModels = JSON.parse(JSON.stringify(runtime.huayuLiveBuildingFeatureCollection(buildingColorFixtures)));
const uncolouredFixtures = buildingColorFixtures.map(element=>({...element,tags:Object.fromEntries(
  Object.entries(element.tags).filter(([key])=>!key.includes("color")&&!key.includes("colour")))}));
const uncolouredModels = JSON.parse(JSON.stringify(runtime.huayuLiveBuildingFeatureCollection(uncolouredFixtures)));
assert.equal(buildingColorModels.features.length,buildingColorCases.length);
for(const [index,feature] of buildingColorModels.features.entries()) {
  const original=uncolouredModels.features[index];
  assert.deepEqual(feature.geometry,original.geometry,"colour must not change building footprint");
  assert.equal(feature.properties.renderHeight,original.properties.renderHeight);
  assert.equal(feature.properties.renderMinHeight,original.properties.renderMinHeight);
  assert.equal(feature.properties.structureKind,"building");
  assert.equal(feature.properties.ancientKind,original.properties.ancientKind);
}
assert.equal(buildingColorModels.features[0].properties.color,"blue");
assert.equal(buildingColorModels.features[2].properties["building:colour"],"#2e8b57");
assert.equal(buildingColorModels.features[3].properties["building:color"],"rgb(255, 165, 0)");
assert.equal(buildingColorModels.features[4].properties.color,"#663399");
assert.equal(buildingColorModels.features[7].properties["roof:colour"],"#4169e1");
assert.equal(buildingColorModels.features[8].properties.color,undefined,"roof colour must not become a wall colour");
assert.equal(JSON.parse(JSON.stringify(runtime.huayuBuildingColorProperties({color:"transparent"}))).color,undefined);
assert.equal(JSON.parse(JSON.stringify(runtime.huayuBuildingColorProperties({color:" 000000 "}))).color,"#000000",
  "valid black must not be mistaken for a missing colour");
const relation={type:"relation",id:200,tags:{building:"yes",color:"ivory"},
  members:[{type:"way",ref:201,role:"outer"}]};
const member={...buildingColorFixtures[0],id:201,tags:{}};
const relationModel=runtime.huayuLiveBuildingFeatureCollection([relation,member]).features[0];
assert.equal(relationModel.properties.color,"ivory","relation colour must survive polygon assembly");
const pavilion=runtime.huayuPavilionFeatureCollection([{...buildingColorFixtures[0],
  tags:{building:"gazebo",color:"brown","roof:color":"red"}}]);
assert.equal(pavilion.features.length,3);
assert.ok(pavilion.features.every(feature=>feature.properties.color==="brown"&&feature.properties["roof:color"]==="red"));
console.log(JSON.stringify({status:"passed",colouredBuildingCases:buildingColorCases.length,
  preserved:"geometry, heights, ancient classification, relation colours and open pavilion parts"}));
