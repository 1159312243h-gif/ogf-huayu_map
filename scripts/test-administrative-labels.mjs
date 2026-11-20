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
    &&query.endsWith("out body center;out count;"),"label members must be fetched even outside viewport bounds");
}
console.log("Administrative labels passed: designated anchors, priority, missing nodes, fallback and no duplicate city labels.");
const layerContext=vm.createContext({HUAYU_ADMIN_LABEL_SOURCE:"labels",HUAYU_ADMIN_PROVINCE_LABEL_LAYER:"provinces",
  HUAYU_ADMIN_ROAD_LABEL_LAYER:"roads",huayuOverlayPalette:()=>({adminProvince:"#123456",adminRoad:"#123456",textHalo:"#ffffff"})});
vm.runInContext(app.match(/  function huayuStyleLayers\([^]*?\n  \}/u)[0],layerContext);
vm.runInContext(app.match(/  function ensureHuayuAdministrativeLabelLayer\([^]*?\n  \}/u)[0],layerContext);
const sources=new Map(),layers=new Map();
assert.equal(layerContext.ensureHuayuAdministrativeLabelLayer({isStyleLoaded:()=>false,
  getStyle:()=>({layers:[{id:"place-country"}]}),getSource:id=>sources.get(id),addSource:(id,source)=>sources.set(id,source),
  getLayer:id=>layers.get(id),addLayer:layer=>layers.set(layer.id,layer)}),true,
  "remote tiles still loading must not prevent administrative label initialization");
assert.equal(layers.size,2);

let serialized=0;
const hotMap={getLayersOrder:()=>['place-country'],getLayer:id=>layers.get(id)||(id==='place-country'?{id,type:'symbol'}:null),
 getStyle:()=>{serialized++;throw Error('full live geometry must not be serialized on a label check');},
 getSource:id=>sources.get(id),addSource:(id,source)=>sources.set(id,source),addLayer:layer=>layers.set(layer.id,layer)};
for(let i=0;i<100;i++)assert.equal(layerContext.ensureHuayuAdministrativeLabelLayer(hotMap),true);
assert.equal(serialized,0,'periodic administrative label checks must not clone map data');


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

// Exercise real label refresh handlers in one unchanged viewport, including complete deletions.
let now=1000000,upstream,nextCalls=0;
const labels=vm.createContext({Date:class extends Date{static now(){return now;}},URLSearchParams,
  document:{hidden:false,getElementById:()=>mapElement},OVERPASS_URL:'https://overpass.opengeofiction.net/api/interpreter',
  fetchJson:async()=>{nextCalls++;return upstream;},isHuayuBasemapSelected:()=>true,
  applyHuayuAdministrativeLabels:()=>{},ensureHuayuAdministrativeLabelLayer:()=>true,
  huayuAdminLabelStates:new WeakMap(),HUAYU_ADMIN_LABEL_SOURCE:'labels'});
for(const name of ['loadHuayuAdministrativeLabelGroup','huayuAdministrativeBoundsContain','huayuAdministrativeLabelQuery',
  'refreshHuayuAdministrativeLabels','activateHuayuAdministrativeLabels','deactivateHuayuAdministrativeLabels']){
 const source=app.match(new RegExp('  (?:async )?function '+name+'\\([^]*?\\n  \\}','u'))?.[0];assert.ok(source,name);vm.runInContext(source,labels);
}
const state={roadRequestId:0,provinceRequestId:0,roadElements:[city],roadFetchedAt:now-300001,
  provinceElements:[capital],provinceFetchedAt:now-300001};
const bounds={south:7,west:147,north:14,east:154};
upstream={osm3s:{timestamp_osm_base:'2026-11-20T06:00:00Z'},elements:[{...province,tags:{...province.tags,name:'新省名'}},{type:'count',tags:{total:'1'}}]};
await labels.loadHuayuAdministrativeLabelGroup({},state,'province',bounds,'query');
assert.equal(state.provinceElements[0].tags.name,'新省名');assert.equal(state.provinceFetchedAt,now);assert.equal(state.provinceSourceTime,upstream.osm3s.timestamp_osm_base);
const complete=state.provinceElements,sourceTime=state.provinceSourceTime;
for(const invalid of [{...upstream,remark:'runtime error: Query timed out'},
  {...upstream,elements:[province,{type:'count',tags:{total:'2'}}]},
  {...upstream,osm3s:{}}, {...upstream,elements:[province,province,{type:'count',tags:{total:'2'}}]}]){
 upstream=invalid;await labels.loadHuayuAdministrativeLabelGroup({},state,'province',bounds,'query');
 assert.equal(state.provinceElements,complete);assert.equal(state.provinceSourceTime,sourceTime);assert.equal(state.provinceRetryAt,now+30000);
}
upstream={osm3s:{timestamp_osm_base:sourceTime},elements:[{type:'count',tags:{total:'0'}}]};
await labels.loadHuayuAdministrativeLabelGroup({},state,'province',bounds,'query');assert.equal(state.provinceElements.length,0,'complete empty source removes obsolete live labels');
const map={getZoom:()=>6,getSource:()=>({setData(){}}),on(){},off(){}};
labels.huayuAdministrativeQueryBounds=()=>bounds;labels.paddedHuayuAdministrativeBounds=x=>x;
labels.huayuAdminLabelStates.set(map,state);let groups=[];
labels.loadHuayuAdministrativeLabelGroup=(_map,s,group,b)=>{groups.push(group);s[group+'PendingBounds']=b;};
state.roadQueryBounds=bounds;state.provinceQueryBounds=bounds;state.roadFetchedAt=now;state.provinceFetchedAt=now;
labels.refreshHuayuAdministrativeLabels(map);assert.equal(groups.length,0,'fresh in-range labels do not refetch');
now+=300000;labels.refreshHuayuAdministrativeLabels(map);assert.deepEqual(groups,['road','province'],'both groups refresh without moving the map');
labels.refreshHuayuAdministrativeLabels(map);assert.equal(groups.length,2,'one in-flight refresh is shared');
state.roadPendingBounds=null;state.provincePendingBounds=null;state.roadRetryAt=now+30000;state.provinceRetryAt=now+30000;
labels.refreshHuayuAdministrativeLabels(map);assert.equal(groups.length,2,'offline retries stay bounded');
now+=30000;labels.document.hidden=true;labels.refreshHuayuAdministrativeLabels(map);assert.equal(groups.length,2,'background pages do not poll');
const timers=new Map();let timer=0;
labels.window={setInterval:callback=>{timers.set(++timer,callback);return timer;},clearInterval:id=>timers.delete(id),clearTimeout(){}};
labels.scheduleHuayuAdministrativeLabels=()=>{};const another={on(){},off(){}};
labels.activateHuayuAdministrativeLabels(another);assert.equal(timers.size,1);labels.activateHuayuAdministrativeLabels(another);assert.equal(timers.size,1);
labels.deactivateHuayuAdministrativeLabels(another);assert.equal(timers.size,0,'leaving the map removes the periodic check');
console.log('Administrative refresh passed: same-view expiry, source timestamps, complete replacement/deletion, incomplete-response retention, bounded recovery, background suspension and timer cleanup.');
