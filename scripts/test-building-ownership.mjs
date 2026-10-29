import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const context = vm.createContext({module:{exports:{}},exports:{},console,performance,
  TextDecoder,TextEncoder,URL,Blob,AbortController,setTimeout,clearTimeout});
const declaration = app.match(/  function huayuModelInsideExpression\([^]*?\n  \}/u)?.[0];
assert.ok(declaration);
vm.runInContext(declaration,context);
// Execute the expression implementation shipped with the map. A mock that
// pretends within supports polygons would miss the original roof regression.
const engine = await readFile(new URL("../site/maplibre-gl.js",import.meta.url),"utf8");
const exposed = engine.replace(/within:(\w+),distance:(\w+),/u,
  "within:$1,distance:(globalThis.__ownershipDistance=$2),");
assert.notEqual(exposed,engine,"Locate the bundled style-expression registry");
vm.runInContext(exposed,context);
assert.equal(typeof context.__ownershipDistance,"function");
const rect = (west,south,east,north) => [[west,south],[east,south],[east,north],[west,north],[west,south]];
const coverage = {type:"MultiPolygon",coordinates:[[rect(0,0,2.8125,2)]]};
const distance = area => {
  const expression = context.huayuModelInsideExpression(area);
  assert.equal(expression[0],">");assert.equal(expression[2],0);
  assert.equal(expression[1][0],"distance");
  return context.__ownershipDistance.parse(expression[1],{error:message => {throw Error(message);}});
};
const project = ([lon,lat]) => ({x:(lon+180)/360*8192,
  y:(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2*8192});
const evaluate = (expression,rings,type="Polygon") => expression.evaluate({canonical:{z:0,x:0,y:0},
  canonicalID:() => ({z:0,x:0,y:0}),geometry:() => rings.map(ring=>ring.map(project)),geometryType:() => type});
const predicate = distance(coverage);
for (const [name,rings,inside] of [
  ["ordinary house",[rect(.3,.3,.5,.5)],true],
  ["outside",[rect(3.1,.3,3.3,.5)],false],
  ["crossing edge",[rect(2.7,.7,2.9,.9)],false],
  ["touching edge",[rect(2.6,1,2.8125,1.2)],false],
  ["two inside components",[rect(.6,.6,.8,.8),rect(1.1,1.1,1.3,1.3)],true],
  ["inside and outside components",[rect(.6,1.4,.8,1.6),rect(3.1,1.4,3.3,1.6)],false],
  ["courtyard",[rect(.9,.3,1.7,.8),rect(1,.4,1.6,.7).reverse()],true],
  ["window in a courtyard",[rect(-.2,-.2,3,2.2),rect(-.1,-.1,2.9,2.1).reverse()],false],
]) assert.equal(evaluate(predicate,rings)>0,inside,name);
assert.equal(evaluate(predicate,[[[1,1]]],"Point")>0,true,"point shelter inside");
assert.equal(evaluate(predicate,[[[3,1]]],"Point")>0,false,"point shelter outside");
assert.equal(evaluate(predicate,[[[1,1],[3,1]]],"LineString")>0,false,"crossing shelter line");
const wrapped = distance({type:"MultiPolygon",coordinates:[[rect(178,0,180,2)],[rect(-180,0,-178,2)]]});
for (const [west,east,inside] of [[179,179.3,true],[-179.3,-179,true],[177,177.3,false],[-177.3,-177,false],
  [177.9,178.1,false],[-178.1,-177.9,false]]) {
  assert.equal(evaluate(wrapped,[rect(west,.3,east,.5)])>0,inside,"date-line window");
}
assert.equal(context.huayuModelInsideExpression(null),false,"no complete coverage cannot claim buildings");
assert.equal(context.huayuModelInsideExpression({type:"MultiPolygon",coordinates:[]}),false);
console.log("Building ownership passed: bundled MapLibre polygon/multipolygon distance, holes, boundary fallback, points/lines and date-line windows.");
