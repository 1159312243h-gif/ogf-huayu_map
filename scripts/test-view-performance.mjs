import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const install = (name, context) => vm.runInContext(source.match(
  new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))[0], context);
const plain = value => JSON.parse(JSON.stringify(value));

// Use the public live layer objects. Never serialize source data just to
// inspect order/type, and never cache an old order across a style update.
let serialized = 0;
const order = ["forest", "material", "water", "building", "labels"];
const definitions = new Map([
  {id:"forest",type:"fill",source:"tiles",sourceLayer:"landcover"},
  {id:"material",type:"custom"},
  {id:"water",type:"fill",source:"tiles",sourceLayer:"water"},
  {id:"building",type:"fill-extrusion",source:"live",metadata:{test:true}},
  {id:"labels",type:"symbol",source:"tiles",sourceLayer:"place"},
].map(layer => [layer.id,layer]));
const styleContext = vm.createContext({});
install("huayuStyleLayers",styleContext);
const map = {getLayersOrder:()=>order, getLayer:id=>definitions.get(id),
  getStyle(){serialized++;throw new Error("copied live GeoJSON");}};
const summary = () => plain(styleContext.huayuStyleLayers(map));
assert.deepEqual(summary(),[
  {id:"forest",type:"fill",source:"tiles","source-layer":"landcover"},
  {id:"water",type:"fill",source:"tiles","source-layer":"water"},
  {id:"building",type:"fill-extrusion",source:"live",metadata:{test:true}},
  {id:"labels",type:"symbol",source:"tiles","source-layer":"place"},
]);
order.splice(0,1);order.push("forest");
assert.equal(summary().at(-1).id,"forest","moving a layer takes effect immediately");
definitions.set("forest",{id:"forest",type:"line",source:"new",sourceLayer:"transportation"});
assert.equal(summary().at(-1)["source-layer"],"transportation","replacement styles cannot reuse old categories");
definitions.delete("forest");
assert.equal(summary().length,3,"removed layers are excluded immediately");
assert.equal(serialized,0);
assert.deepEqual(plain(styleContext.huayuStyleLayers({getStyle:()=>undefined})),[]);
assert.deepEqual(plain(styleContext.huayuStyleLayers({getStyle:()=>({layers:[{id:"legacy"}]})})),[{id:"legacy"}]);

// Repeated platforms must retain the exact manual interchange results while
// name normalization stays bounded by distinct route strings, not stop count.
const alpha = {id:1,identity:"a",ref:"A",label:"测试Ａ线"};
const blue = {id:2,identity:"b",ref:"B",label:"城市蓝线支线"};
const red = {id:3,identity:"r",ref:"R",label:"红线"};
const display = {id:4,identity:"d",ref:"D",label:"换乘显示"};
const override = {stationNames:["甲站"],mainline:false,routeRefs:["Ａ"],routeNames:["蓝线"],
  displayRoutes:[display],symbolMode:"segments",stationCount:3};
const rules = {stationInterchangeOverrides:[override,
  {...override,stationNames:["乙站"],displayOnly:true,routeNames:[]}]};
const context = vm.createContext({transitServiceRules:rules,invalidateTransitDisplayNetwork(){},
  transitStationComplexKey:name=>name,
  uniqueTransitRoutes:routes=>[...new Map(routes.map(route=>[route.identity,route])).values()]});
install("applyStationInterchangeOverrides",context);
vm.runInContext("let normalizations=0;const originalNormalize=String.prototype.normalize;String.prototype.normalize=function(...args){normalizations++;return originalNormalize.apply(this,args);};",context);
const network = {lines:[{routes:[alpha,blue,red]}],stops:[
  ...Array.from({length:120},(_,id)=>({id,name:"甲站",isMainline:false,routes:[red]})),
  {id:121,name:"乙站",isMainline:false,routes:[red]},
  {id:122,name:"甲站",isMainline:true,routes:[red]},
]};
context.applyStationInterchangeOverrides(network);
for(const stop of network.stops.slice(0,120)) {
  assert.deepEqual(plain(stop.routes).map(route=>route.id),[3,1,2]);
  assert.deepEqual(plain(stop.displayRoutes).map(route=>route.id),[4]);
  assert.equal(stop.interchangeStationCount,3);
  assert.equal(stop.interchangeSymbolMode,"segments");
}
assert.deepEqual(plain(network.stops[120].routes).map(route=>route.id),[3]);
assert.deepEqual(plain(network.stops[120].displayRoutes).map(route=>route.id),[1,4]);
assert.equal(network.stops[121].isInterchange,undefined,"mainline exclusions must remain exact");
const normalizations = vm.runInContext("normalizations",context);
assert.ok(normalizations<40,`120 platforms should reuse their route strings; saw ${normalizations} normalizations`);
override.routeRefs=["R"];override.routeNames=[];
const next = {lines:network.lines,stops:[{id:1,name:"甲站",isMainline:false,routes:[]}]};
context.applyStationInterchangeOverrides(next);
assert.deepEqual(plain(next.stops[0].routes).map(route=>route.id),[3],"new rules must take effect without a stale match cache");
console.log(JSON.stringify({status:"passed",liveStyleSerialization:serialized,interchangePlatforms:120,normalizations}));
