import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const timers = new Map(), revoked = [], workers = [], urls = [];
let timerId = 0;
class FakeWorker {
  constructor() {this.messages = []; workers.push(this);}
  postMessage(message) {this.messages.push(message);}
  terminate() {this.terminated = true;}
}
class FakeURL extends URL {
  static createObjectURL() {const url = `blob:${urls.length}`; urls.push(url); return url;}
  static revokeObjectURL(url) {revoked.push(url);}
}
const context = vm.createContext({document: {currentScript: {src: "https://map.test/sunlight-shadows.js"}},
  setTimeout: (fn, delay) => {timers.set(++timerId, {fn, delay}); return timerId;}, clearTimeout: id => timers.delete(id),
  URL: FakeURL, Worker: FakeWorker, OffscreenCanvas: class {},
  CustomEvent: class {constructor(type) {this.type = type;}}, dispatchEvent() {},
});
vm.runInContext(await readFile(new URL("../site/building-roofs.js", import.meta.url), "utf8"), context);
vm.runInContext(await readFile(new URL("../site/sunlight-shadows.js", import.meta.url), "utf8"), context);
const api = context.HuayuSunShadows, copy = value => JSON.parse(JSON.stringify(value));
const feature = (polys, properties = {}) => ({type: "Feature", properties: {renderHeight: 10, renderMinHeight: 0, ...properties},
  geometry: {type: "MultiPolygon", coordinates: polys.map(poly => poly.map(ring => ring.map(api.unproject)))}});
const box = (x, y, width, height) => [[x,y],[x+width,y],[x+width,y+height],[x,y+height],[x,y]];
const data = {type: "FeatureCollection", features: [feature([[box(0,0,20,20)]])]}, original = JSON.stringify(data);
const items = api.prepare(data), morning = {east: 1, north: 0, up: 1}, noon = {east: 0, north: 0, up: 1};
assert.ok(Math.abs(api.offset(morning, 10)[0] + 10) < 1e-10, "45 degree sun casts a 10 metre building 10 metres west");
assert.deepEqual(copy(api.offset({east: -1, north: 0, up: 1}, 10)), [10, 0]);
assert.ok(Math.abs(api.offset({east: 0, north: 1, up: .5}, 10)[1] + 20) < 1e-10);
assert.deepEqual(copy(api.offset({east: 0, north: 0, up: -1}, 10)), [0, 0]);
// Probe the union of the actual drawing paths, independently of ring winding.
function contains(ring, point) {
  let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if ((a[1]>point[1]) !== (b[1]>point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
const covered = (faces, point) => faces.some(poly => poly.reduce((inside, ring) => inside !== contains(ring, point), false));
const projected = api.faces(items[0], morning, false);
assert.equal(covered(projected, [-9,10]), true); assert.equal(covered(projected, [-11,10]), false);
assert.equal(covered(projected, [25,10]), false);
const courtyard = api.prepare({features: [feature([[box(0,0,40,40), box(10,10,20,20)]]) ]})[0];
assert.equal(covered(api.faces(courtyard,noon,false), [20,20]), false, "an overhead sun preserves the real courtyard hole");
assert.equal(covered(api.faces(courtyard,morning,false), [25,20]), true, "an inner courtyard wall casts into the hole");
assert.equal(covered(api.faces(courtyard,morning,false), [15,20]), false, "unshaded courtyard floor is not filled solid");
const multipart = api.prepare({features: [feature([[box(0,0,10,10)], [box(30,0,10,10)]])]})[0];
assert.equal(covered(api.faces(multipart,noon,false), [35,5]), true);
assert.equal(covered(api.faces(multipart,noon,false), [20,5]), false);
const concave = api.prepare({features: [feature([[[[0,0],[30,0],[30,10],[10,10],[10,30],[0,30],[0,0]]]])]})[0];
assert.equal(covered(api.faces(concave,noon,false), [25,25]), false, "concave outlines are not replaced by convex hulls");
const elevated = api.prepare({features: [feature([[box(0,0,5,5)]], {renderMinHeight:10,renderHeight:20})]})[0];
assert.equal(covered(api.faces(elevated,morning,false), [2,2]), false, "elevated volumes keep the projected bottom height");
const roofData = {features: [feature([[box(0,0,32,12)]], {roofModel:1,roofShape:"gabled",roofBaseHeight:6,roofTopHeight:10})]};
const roof = api.prepare(roofData)[0], northSun = {east:0,north:1,up:1};
assert.ok(roof.roof.length > 0);
assert.equal(covered(api.faces(roof,northSun,false), [16,-9]), true);
assert.equal(covered(api.faces(roof,northSun,true), [16,-9]), false, "pitched roof projects its actual eave and ridge heights");
assert.equal(JSON.stringify(data), original, "shadow preparation never changes source geometry or tags");
// Draw two identical casters and inspect real drawing commands: opacity is
// applied once by the map, not inside individual paths or via destination-out.
const fills = [], drawing = {clearRect() {},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(rule){fills.push(rule);}};
const stats=api.drawMask(drawing,[...items,...items],{extent:[-20,-20,40,40],width:600,height:600,sun:morning,shaped:false});
assert.equal(stats.count,2); assert.ok(fills.every(rule=>rule==="evenodd"));
assert.equal(drawing.fillStyle,"#000000"); assert.equal(drawing.globalAlpha,undefined);

const events = new Map(), sources = new Map(), layers = new Map();
const map = {getZoom:()=>19,getPitch:()=>58,getCenter:()=>({lat:14.6}),
  getBounds:()=>({getWest:()=>152.93,getSouth:()=>14.63,getEast:()=>152.94,getNorth:()=>14.64}),
  getCanvas:()=>({width:1440,height:1000}),getStyle:()=>({layers:[{id:"wall",type:"fill-extrusion"}]}),
  getLayer:id=>layers.get(id),getSource:id=>sources.get(id),isSourceLoaded:()=>true,
  addSource:(id,s)=>sources.set(id,s),removeSource:id=>sources.delete(id),
  addLayer:l=>layers.set(l.id,l),removeLayer:id=>layers.delete(id),
  getPaintProperty:(id,k)=>layers.get(id)?.paint[k],setPaintProperty:(id,k,v)=>layers.get(id).paint[k]=v,
  on:(e,fn)=>{if(!events.has(e))events.set(e,new Set());events.get(e).add(fn);},
  off:(e,fn)=>events.get(e)?.delete(fn),
};
const emit=(e,v={})=>{for(const fn of events.get(e)||[])fn(v);};
const flush=()=>{for(const [id,t]of [...timers])if(t.delay===120){timers.delete(id);t.fn();}};
const controller=api.create(map), settings={date:"2026-10-18",minutes:540,shadows:true,shadowOpacity:28};
const light={sun:{...morning,altitude:45}};
controller.setBuildings(data,true); flush(); assert.equal(workers.length,0,"default off creates no worker or mask");
controller.update(light,settings);flush(); assert.equal(workers.length,1);
const worker=workers[0], first=controller.job;
assert.ok(first.width<=2048 && first.height<=2048);
worker.onmessage({data:{id:first.id,revision:first.revision,blob:{},stats:{count:1}}});
assert.equal(layers.size,1); assert.equal([...layers.values()][0].paint["raster-opacity"],0,"incomplete mask is not visible");
emit("sourcedata",{sourceId:controller.pending.id});
assert.equal(controller.state,"ready"); assert.equal(layers.size,1); assert.equal(sources.size,1);
const displayed=controller.display.id;
controller.update(light,settings);flush(); assert.equal(worker.messages.filter(m=>m.type==="render").length,1,"unchanged light and view reuse the mask");
emit("movestart");controller.setBuildings({...data},true);flush();
assert.equal(controller.display.id,displayed,"dragging preserves the complete image");
emit("moveend");flush();const delayed=controller.job;
controller.update(light,{...settings,minutes:600});flush();
assert.equal(controller.state,"preparing","a changed solar time immediately invalidates the old ready status");
assert.equal(controller.job,null,"changing time while busy does not queue more expensive jobs");
worker.onmessage({data:{id:delayed.id,revision:delayed.revision,blob:{},stats:{count:99}}});flush();
assert.equal(controller.pending,null,"late mask for another time cannot replace the new selection");
assert.equal(layers.size,0,"different solar time does not display stale shadow directions");
const current=controller.job;
worker.onmessage({data:{id:current.id,revision:current.revision,blob:{},stats:{count:2}}});emit("sourcedata",{sourceId:controller.pending.id});
controller.setBuildings(data,false);assert.equal(layers.size,0);assert.equal(sources.size,0);assert.equal(worker.terminated,true,"building ownership loss clears the mask and worker");
controller.update(null,settings);controller.destroy();
assert.equal(timers.size,0);assert.ok([...events.values()].every(s=>s.size===0));
assert.equal(revoked.length,urls.length,"every temporary image URL is released");
const app=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
assert.ok(app.includes('layer.metadata?.["huayu:sun-shadow"]'),"ground shadows participate in the existing shared model ordering");
assert.ok(app.includes("HuayuSunlight?.syncBuildings(glMap, state.data"),"late complete building ownership feeds the same controller");
console.log("Building shadows passed: metric direction/length, courtyards/concavity/multipart, elevated bottoms, canonical roof silhouette, single mask, stable reuse, complete ownership, stale jobs and resource cleanup.");
