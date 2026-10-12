import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = await readFile(new URL('../site/terrain-perspective.js', import.meta.url), 'utf8');
const posts = [], protocols = new Map();
let workerSource;
class Worker {
  constructor(url) {workerSource = blobs.get(url);}
  postMessage(message) {
    posts.push(message);
    if (this.complete && message.id) queueMicrotask(() => this.onmessage?.({data:{id:message.id,buffer:new ArrayBuffer(4),cpuMs:1,loadMs:0}}));
  }
  terminate() {this.terminated = true;}
}
const blobs = new Map(); let nextBlob = 0;
class Blob {constructor(parts) {this.source = parts.join('');}}
class FixtureURL extends globalThis.URL {
  static createObjectURL(b){const key=`blob:${++nextBlob}`;blobs.set(key,b.source);return key;}
  static revokeObjectURL(){}
}
const context = vm.createContext({Worker, Blob, Float32Array, Uint8ClampedArray, console, setTimeout, clearTimeout,
  URL: FixtureURL,
  location: {href: 'http://localhost/'}, DOMException, AbortController});
vm.runInContext(source, context);
const {rasterize, colorize, encodeDem, tileBounds, surfaceMask, surfaceCandidates, tileSources, Controller} = context.HuayuTerrainPerspective;
const palette = {low: [0.3,0.5,0.3], high: [0.4,0.6,0.4], openLow: [0.5,0.5,0.4], openHigh: [0.6,0.6,0.4],
  gardenLow: [0.3,0.5,0.3], gardenHigh: [0.4,0.6,0.4], contour: [0.1,0.2,0.1]};
const z = 12, x = 3800, y = 1900, bounds = tileBounds(z,x,y), n = 2 ** z;
const mercator = ([lng,lat]) => [(lng+180)/360,(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2];
const origin = mercator([(bounds.west+bounds.east)/2,(bounds.south+bounds.north)/2]);
const values = [];
for (const [u,v] of [[0,0],[1,0],[0,1],[1,0],[1,1],[0,1]]) values.push(
  (x+u)/n-origin[0],(y+v)/n-origin[1],0,-0.2,-0.1,1,0.5,100+30*u+20*v,276);
const xy = (u,v) => [(x+u)/n*360-180,Math.atan(Math.sinh(Math.PI*(1-2*(y+v)/n)))*180/Math.PI];
const surface = {geometry: {type:'Polygon',coordinates: [[xy(0,0),xy(1,0),xy(1,1),xy(0,1),xy(0,0)],
  [xy(0.4,0.4),xy(0.6,0.4),xy(0.6,0.6),xy(0.4,0.6),xy(0.4,0.4)]]},properties:{reliefLandKind:'wood'}};
const block = {bounds, values: new Float32Array(values), surfaces:[surface], contexts:[]};
const original = Array.from(block.values), size = 32;
const heights = new Float32Array(size*size), colors = new Uint8ClampedArray(size*size*4), attributes = new Float32Array(size*size*8);
rasterize(block,z,x,y,size,heights,colors,attributes);
colorize(heights,colors,attributes,z,x,y,size,palette);
assert.deepEqual(Array.from(block.values),original,'perspective sampling must preserve all original mesh vertices and elevations');
for (let row=0;row<size;row++) for (let col=0;col<size;col++) {
  const i=row*size+col, expected=100+30*(col+0.5)/size+20*(row+0.5)/size;
  assert.ok(Math.abs(heights[i]-expected)<0.001,'DEM must interpolate the same contour mesh, including the ground underneath water/clearings');
  if (colors[i*4+3]) assert.equal(attributes[i*8],20,'retain the original contour interval');
}
assert.equal(colors[(16*size+16)*4+3],0,'preserve true holes in the visible material');
assert.ok(heights[16*size+16]>120,'a clearing must not become a zero-altitude pit');
assert.ok(new Set(Array.from(colors).filter((_,i)=>i%4!==3)).size>15,'keep texture, contour and slope tonal detail');
const partial = {...block, triangleIndex:undefined, surfaceIndex:undefined, surfaces:[{
  ...surface, geometry:{type:'Polygon',coordinates:[[xy(0,0),xy(0.5,0),xy(0.5,1),xy(0,1),xy(0,0)]]}}]};
const rimHeights = new Float32Array(size*size).fill(1000), rimColors = new Uint8ClampedArray(size*size*4).fill(255);
rasterize(partial,z,x,y,size,rimHeights,rimColors,new Float32Array(size*size*8));
assert.ok(rimHeights[16*size+28]<150,'fine skirts must replace coarse high vertices instead of keeping a jagged max-height rim');
assert.equal(rimColors[(16*size+28)*4+3],0,'the completed cell must also clear old overview colours outside its real outline');
const empty = {...block,values:new Float32Array(),surfaces:[],triangleIndex:undefined,surfaceIndex:undefined};
rasterize(empty,z,x,y,size,rimHeights,rimColors,new Float32Array(size*size*8));
assert.ok(rimHeights.every(h=>h===0),'a complete empty fine cell must not leave phantom overview mountains');
const bounds2 = {...bounds,west:bounds.east,east:bounds.east+(bounds.east-bounds.west)};
const indexed = {...block,surfaceIndex:undefined,surfaces:[{...surface,geometry:{type:'Polygon',coordinates:[[xy(2,0),xy(3,0),xy(3,1),xy(2,1),xy(2,0)]]}},surface]};
assert.deepEqual(Array.from(surfaceMask(indexed.surfaces,z,x,y,size,false,surfaceCandidates(indexed,bounds))),
  Array.from(surfaceMask(indexed.surfaces,z,x,y,size)),'spatial mask selection must retain original ownership IDs, holes and draw priority');
const half = (west,east) => ({...bounds,west,east});
const descriptors = [{key:'coarse',bounds:{...bounds,east:bounds2.east}},
  {key:'left',bounds:half(bounds.west,(bounds.west+bounds.east)/2)},
  {key:'right',bounds:half((bounds.west+bounds.east)/2,bounds.east)}];
assert.deepEqual(Array.from(tileSources(descriptors,bounds),s=>s.key),['left','right'],
  'multiple complete fine cells must avoid downloading and scanning a fully covered national packet');
assert.deepEqual(Array.from(tileSources(descriptors.slice(0,2),bounds),s=>s.key),['coarse','left'],
  'partly uncovered tiles must keep the complete overview fallback');
const dem=encodeDem(new Float32Array([-150,0,125.25,4500,11000]));
for(const [i,height] of [-150,0,125.25,4500,11000].entries()) {
  const decoded=(dem[i*4]*65536+dem[i*4+1]*256+dem[i*4+2])*0.1-10000;
  assert.ok(Math.abs(decoded-height)<=0.051,'signed and high observed elevations must survive DEM encoding');
}

const layers = [{id:'land',type:'fill'},{id:'existing-material',type:'custom'},{id:'road',type:'line'},
  {id:'trees',type:'fill-extrusion',paint:{'fill-extrusion-base':7,'fill-extrusion-height':12}}, {id:'labels',type:'symbol'}];
const sources = new Map(), events = new Map();
const map = {getLayersOrder:()=>layers.map(l=>l.id), getSource:id=>sources.get(id), isMoving:()=>false,
  getZoom:()=>z,getCenter:()=>({lng:(bounds.west+bounds.east)/2,lat:(bounds.south+bounds.north)/2}),
  getBounds:()=>({getWest:()=>bounds.west+1e-6,getEast:()=>bounds.east-1e-6,getNorth:()=>bounds.north-1e-6,getSouth:()=>bounds.south+1e-6}),
  addSource(id,spec) {sources.set(id,{...spec,setTiles(tiles){this.tiles=tiles;}});},
  removeSource:id=>sources.delete(id), setTerrain(value) {this.terrain=value;},
  addLayer(layer,before) {const i=before?layers.findIndex(l=>l.id===before):layers.length;layers.splice(i,0,layer);layer.onAdd?.(this);},
  removeLayer(id) {const i=layers.findIndex(l=>l.id===id);const [layer]=layers.splice(i,1);layer.onRemove?.(this);},
  on:(name,handler)=>events.set(name,handler), off:(name,handler)=>{if(events.get(name)===handler)events.delete(name);}};
let destroyed=0, resumed=0;
const material = {id:'existing-material',type:'custom',blocks:new Map([['fine',{key:'fine',level:4,bounds,perspectivePacket:block}]]),
  rawSnapshotData:{generatedAt:'test'}, onRemove(){if(!this.presentationDetached)destroyed++;}, onAdd(){resumed++;}};
layers[1]=material;
const controller = new Controller(map,material,{palette,library:{addProtocol:(scheme,p)=>protocols.set(scheme,p),removeProtocol:scheme=>protocols.delete(scheme)}});
assert.doesNotThrow(()=>new vm.Script(workerSource),'the actual background worker must compile');
// Run the actual worker, including paired output, cancellation, memory reuse
// and a new worker recovering the persisted pair without source geometry.
const disk = new Map(); let pngBuilds = 0;
class ImageData {constructor(data,width,height){Object.assign(this,{data,width,height});}}
class Canvas {
  constructor(width,height){Object.assign(this,{width,height});this.context={
    putImageData:image=>{this.image=image;},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){}};}
  getContext(){return this.context;}
  convertToBlob(){pngBuilds++;return Promise.resolve(new globalThis.Blob([this.image.data]));}
}
const store = {put:row=>disk.set(row.key,row),delete:key=>disk.delete(key),
  get:key=>{const request={};setImmediate(()=>{request.result=disk.get(key);request.onsuccess();});return request;},
  index:()=>({openCursor:()=>{
    const request={},rows=[...disk.values()].sort((a,b)=>a.usedAt-b.usedAt);let i=0;
    const next=()=>setImmediate(()=>{request.result=i<rows.length?{value:rows[i++],continue:next}:null;request.onsuccess();});next();return request;
  }})};
const indexedDB={open:()=>{const request={};setImmediate(()=>{request.result={transaction:()=>({objectStore:()=>store})};request.onsuccess();});return request;}};
function newWorker() {
  const answers=new Map(),messages=[];
  const runtime=vm.createContext({Float32Array,Uint8Array,Uint8ClampedArray,TextEncoder,crypto:webcrypto,performance,
    setTimeout,clearTimeout,Blob:globalThis.Blob,ImageData,OffscreenCanvas:Canvas,indexedDB,
    self:{postMessage:message=>{messages.push(message);if(message.id){answers.get(message.id)?.(message);answers.delete(message.id);}}}});
  vm.runInContext(workerSource,runtime);
  return {messages,register:()=>runtime.self.onmessage({data:{key:'stable-mesh',block:structuredClone(block)}}),
    run:job=>new Promise(resolve=>{answers.set(job.id,resolve);runtime.self.onmessage({data:job});}),
    cancel:id=>runtime.self.onmessage({data:{cancel:id}})};
}
const job={id:100,kind:'elevation',revision:1,z,x,y,palette,sources:[{key:'stable-mesh',cacheKey:'stable-generation',bounds}]};
const w=newWorker();w.register();
const output=await w.run(job);assert.ok(output.buffer.byteLength);assert.equal(pngBuilds,2,'one computation creates both DEM and material');
const paired=await w.run({...job,id:101,kind:'material'});assert.ok(paired.buffer.byteLength);assert.equal(pngBuilds,2,'the paired request must reuse the identical completed generation');
const concurrent=await Promise.all([w.run({...job,id:107,x:x+1}),w.run({...job,id:108,x:x+1,kind:'material'})]);
assert.ok(concurrent.every(result=>result.buffer?.byteLength));assert.equal(pngBuilds,4,'concurrent material/DEM requests must coalesce into a single paired generation');
w.cancel(102);w.run({...job,id:102,x:x+1});
await w.run({...job,id:103});assert.ok(!w.messages.some(m=>m.id===102),'cancelled queued tiles must not consume raster generation work');
await new Promise(setImmediate);
const restored=newWorker();
const recovered=await restored.run({...job,id:104,revision:9});
assert.deepEqual(new Uint8Array(recovered.buffer),new Uint8Array(output.buffer),'a new worker must recover the exact persisted pair');
assert.equal(pngBuilds,4,'returning/reopening must not recompute a valid terrain presentation');
const unavailable=await restored.run({...job,id:105,sources:[{key:'missing',cacheKey:'missing-generation',bounds}]});
assert.equal(unavailable.error,'TERRAIN_MESH_NOT_READY','missing non-published geometry must reject instead of silently flattening the mountain');
const flat=await restored.run({...job,id:106,sources:[]});
assert.ok(flat.buffer.byteLength,'an actually empty complete inventory may return flat terrain');
const encodedBeforeFlat=pngBuilds;
const anotherFlat=await restored.run({...job,id:109,x:x+2,sources:[]});
assert.deepEqual(new Uint8Array(anotherFlat.buffer),new Uint8Array(flat.buffer));
assert.equal(pngBuilds,encodedBeforeFlat,'surrounding genuinely flat tiles must share the zero-ground pair without repeated PNG work');
const enabling = controller.setEnabled(true);
assert.equal(layers[1],material,'keep the existing complete material throughout tile preparation');
assert.equal(map.terrain,undefined,'do not lift objects onto unavailable terrain');
assert.equal(sources.size,0,'native source takeover must wait for both material and elevation');
await controller.refresh();
assert.equal(controller.revision,1,'background arrivals must not repeatedly cancel the first useful presentation');
assert.ok(posts.some(post=>post.kind==='material' && post.z===z+1),
  'preparation must match the native 256px material zoom instead of repeating the wrong level');
controller.worker.complete = true;
for(const post of posts.filter(p=>p.id)) controller.worker.onmessage({data:{id:post.id,buffer:new ArrayBuffer(4),cpuMs:1}});
await enabling;
assert.equal(layers.length,5,'native presentation replaces the same material, never adds a mountain overlay');
assert.equal(layers[1].id,material.id);
assert.equal(layers[1].type,'raster');
assert.equal(destroyed,0,'preserve overhead GPU meshes, caches and listeners while tilted');
assert.equal(map.terrain.exaggeration,1,'do not invent height exaggeration');
assert.equal(sources.get(controller.dem).encoding,'mapbox');
assert.equal(sources.get(controller.dem).maxzoom,14,'base vector overzoom and DEM must share a supported canonical zoom');
assert.equal(posts.filter(p=>p.block).length,0,'do not clone every cached cell before a tile needs its geometry');
controller.worker.onmessage({data:{needBlock:controller.records.get(1).sources[0].key}});
assert.equal(posts.filter(p=>p.block).length,1,'recover requested geometry on demand');
await controller.refresh();
assert.equal(posts.filter(p=>p.block).length,1,'unchanged camera/source state must not clone the same meshes again');
assert.equal(controller.revision,1,'camera changes with unchanged completed sources must reuse tiles');
const originalBounds=map.getBounds,startPosts=posts.length;
map.getBounds=()=>({getWest:()=>-160,getEast:()=>170,getNorth:()=>80,getSouth:()=>-80});
await controller.warmTiles(1,new AbortController().signal);
assert.ok(posts.length-startPosts<=64,'a horizon-sized view must not evict its warm centre from the bounded pair cache');
map.getBounds=originalBounds;
assert.equal(layers.find(l=>l.id==='trees').paint['fill-extrusion-base'],7,'native draping must preserve tree/model local base and height');
const firstSources=controller.records.get(1).sources.map(s=>s.key);
material.blocks.get('fine').perspectivePacket={...block,values:block.values.slice()};
await controller.refresh();
assert.equal(controller.revision,2);
assert.notDeepEqual(controller.records.get(2).sources.map(s=>s.key),firstSources,'new completed meshes invalidate presentation tiles');
assert.deepEqual(controller.records.get(1).sources.map(s=>s.key),firstSources,'old in-flight pairs retain an immutable generation');
controller.worker.onmessage({data:{needBlock:firstSources[0]}});
assert.equal(posts.at(-1).block,block,'an old tile must recover its exact packet after the live block is refined');
controller.worker.complete=false;
material.blocks.get('fine').perspectivePacket={...block,values:block.values.slice()};
const updateFailure=controller.refresh();
controller.worker.onmessage({data:{id:posts.at(-1).id,error:'TERRAIN_MESH_HTTP_503'}});
await updateFailure;
assert.equal(layers[1].type,'raster','a failed update must retain the previous complete native material');
assert.ok(map.terrain,'a failed update must retain the displayed ground and grounded objects');
assert.equal(controller.ready,true);
controller.worker.complete=true;
material.publishedManifest={generatedAt:'new-generation',renderBlocks:[{url:'./new-overview.json.gz',cell:{bounds}}]};
material.blocks.get('fine').perspectivePacket.generation='old-generation';
await controller.refresh();
assert.equal(controller.records.get(controller.revision).sources.length,1,'a new published generation must not be overlaid with old near-view elevations');
material.blocks.get('fine').perspectivePacket={...block,generation:'new-generation'};
await controller.refresh();
assert.equal(controller.records.get(controller.revision).sources.length,2,'same-generation completed detail may replace the overview');
controller.setEnabled(false);
assert.equal(map.terrain,null);
assert.equal(layers[1],material,'return to the original exact overhead material');
assert.equal(resumed,1); assert.equal(destroyed,0); assert.equal(sources.size,0);
controller.worker.complete=false;
const failure=controller.setEnabled(true);
controller.worker.onmessage({data:{id:posts.at(-1).id,error:'TERRAIN_MESH_HTTP_503'}});
await failure;
assert.equal(map.terrain,null);assert.equal(layers[1],material,'initial failure must restore the complete original material');
assert.equal(destroyed,0);assert.equal(controller.failed,true);
controller.dispose();
assert.equal(protocols.size,0); assert.equal(events.size,0); assert.ok(controller.worker.terminated);
const staging=new Controller(map,material,{palette,library:{addProtocol:(scheme,p)=>protocols.set(scheme,p),removeProtocol:scheme=>protocols.delete(scheme)}});
const beforeStaging=posts.length,oldPreparation=staging.setEnabled(true);
material.blocks.get('fine').perspectivePacket={...block,generation:'new-generation',values:block.values.slice()};
for(const post of posts.slice(beforeStaging).filter(post=>post.id))staging.worker.onmessage({data:{id:post.id,buffer:new ArrayBuffer(4)}});
await oldPreparation;
assert.equal(map.terrain,null,'a newer complete mesh arriving during warming must prevent stale coarse takeover');
assert.equal(layers[1],material,'retain the newest original material until its own paired tiles are prepared');
staging.worker.complete=true;
await staging.refresh();
assert.ok(staging.ready);assert.ok(map.terrain,'the completed latest mesh must then take over normally');
staging.dispose();
console.log('Perspective terrain passed: shared elevations/contours, clearings, DEM precision, one material, model bases, cache reuse and lifecycle.');
