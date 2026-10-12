import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const app = await readFile(new URL("../site/app.js",import.meta.url),"utf8");
let data;
const mapElement={dataset:{}};
const context=vm.createContext({ensureHuayuAdministrativeLabelLayer:()=>true,HUAYU_ADMIN_LABEL_SOURCE:"labels",
  document:{getElementById:()=>mapElement}});
for(const name of ["huayuAdministrativeLabelCoordinate","huayuAdministrativeLabelQuery","applyHuayuAdministrativeLabels"]){
  const declaration=app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`,"u"))?.[0];
  assert.ok(declaration,name);vm.runInContext(declaration,context);
}
const city={type:"node",id:126401531,lon:148.4176544,lat:12.49166,tags:{place:"city",name:"上京都"}};
const capital={type:"relation",id:28660,tags:{name:"上京都",admin_level:"4"},
  center:{lon:151.2325436,lat:10.7553048},members:[{type:"node",ref:city.id,role:"label"}]};
const centre={...city,id:2,lon:149,lat:13};
const province={type:"relation",id:3,tags:{name:"测试省",admin_level:"4"},center:{lon:152,lat:11},
  members:[{type:"node",ref:centre.id,role:"admin_centre"}]};
const fallback={type:"relation",id:4,tags:{name:"无锚点省",admin_level:"4"},center:{lon:153,lat:10}};
const missing={...capital,id:5,members:[{type:"node",ref:99,role:"label"}]};
context.applyHuayuAdministrativeLabels({getSource:()=>({setData:value=>{data=value;}})},
  {provinceElements:[capital,city,province,centre,fallback,missing]});
const points=new Map(data.features.map(f=>[f.id,Array.from(f.geometry.coordinates)]));
assert.deepEqual(points.get("28660"),[city.lon,city.lat],"Shangjing must follow its designated OGF label node");
assert.deepEqual(points.get("3"),[centre.lon,centre.lat],"administrative centres must also be honoured");
assert.deepEqual(points.get("4"),[153,10],"regions without a label member retain their fallback");
assert.equal(points.has("5"),false,"missing designated anchors must not produce false centres");
assert.equal(points.has(String(city.id)),false,"city anchor nodes must not become duplicate province labels");
assert.deepEqual(JSON.parse(mapElement.dataset.huayuAdminLabelAnchors).find(anchor=>anchor.id==="28660").coordinates,
  [city.lon,city.lat],"diagnostics must use the actual map DOM element without interrupting label loading");
const both={...province,members:[...province.members,...capital.members]};
assert.deepEqual(Array.from(context.huayuAdministrativeLabelCoordinate(both,new Map([[String(city.id),city],["2",centre]]))),
  [city.lon,city.lat],"label takes precedence over administrative centre");
for(const group of ["road","province"]){
  const query=context.huayuAdministrativeLabelQuery(group,"7,147,14,154");
  assert.ok(query.includes('node(r.adminRelations:"label")')&&query.includes('node(r.adminRelations:"admin_centre")')
    &&query.endsWith("out body center;"),"label members must be fetched even outside viewport bounds");
}
console.log("Administrative labels passed: designated anchors, priority, missing nodes, fallback and no duplicate city labels.");
const layerContext=vm.createContext({HUAYU_ADMIN_LABEL_SOURCE:"labels",HUAYU_ADMIN_PROVINCE_LABEL_LAYER:"provinces",
  HUAYU_ADMIN_ROAD_LABEL_LAYER:"roads",huayuOverlayPalette:()=>({adminProvince:"#123456",adminRoad:"#123456",textHalo:"#ffffff"})});
vm.runInContext(app.match(/  function ensureHuayuAdministrativeLabelLayer\([^]*?\n  \}/u)[0],layerContext);
const sources=new Map(),layers=new Map();
assert.equal(layerContext.ensureHuayuAdministrativeLabelLayer({isStyleLoaded:()=>false,
  getStyle:()=>({layers:[{id:"place-country"}]}),getSource:id=>sources.get(id),addSource:(id,source)=>sources.set(id,source),
  getLayer:id=>layers.get(id),addLayer:layer=>layers.set(layer.id,layer)}),true,
  "remote tiles still loading must not prevent administrative label initialization");
assert.equal(layers.size,2);

// Verify the published basemaps at both overview and close scales. The city
// boundary must be visible and distinguishable, with no duplicate local line.
for (const file of ["huayu-style.json", "huayu-night-style.json"]) {
  const style = JSON.parse(await readFile(new URL(`../site/${file}`, import.meta.url), "utf8"));
  const borders = style.layers.filter(layer => layer["source-layer"] === "boundary");
  const matches = (filter, level, maritime = 0) => {
    if (!filter) return true;
    const [op, field, value] = filter;
    if (op === "all") return filter.slice(1).every(part => matches(part, level, maritime));
    const actual = field === "admin_level" ? level : field === "maritime" ? maritime : 0;
    return op === "==" ? actual === value : op === "!=" ? actual !== value
      : op === ">=" ? actual >= value : op === "<=" ? actual <= value : false;
  };
  for (const zoom of [8, 11, 15, 18]) {
    for (const level of [2, 3, 4, 5, 6, 8, 9, 10]) {
      const visible = borders.filter(layer => zoom >= (layer.minzoom || 0)
        && zoom < (layer.maxzoom ?? 24) && matches(layer.filter, level)
        && layer.paint["line-opacity"] > 0 && layer.layout?.visibility !== "none");
      assert.equal(visible.length, 1, `${file}: admin ${level} remains visible once at z${zoom}`);
    }
  }
  const city = borders.find(layer => matches(layer.filter, 5));
  const county = borders.find(layer => matches(layer.filter, 6));
  const local = borders.find(layer => matches(layer.filter, 8));
  assert.notEqual(city.paint["line-color"], local.paint["line-color"]);
  assert.notDeepEqual(city.paint["line-dasharray"], county.paint["line-dasharray"]);
  assert.ok(city.paint["line-width"].stops.at(-1)[1] > local.paint["line-width"].stops.at(-1)[1],
    "city borders keep higher visual priority than township borders");
}
console.log("Administrative boundaries passed: city/county hierarchy and upper-level borders retained at close scales.");
