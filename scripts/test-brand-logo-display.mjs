import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/brand-logo-core.js";
const code=(await readFile("site/brand-logos.js","utf8")).replace(/\r\n/gu,"\n");
const core=globalThis.HuayuBrandLogoCore;
const entries=JSON.parse(await readFile("site/brand-logos.json","utf8")).items;
const entry=entries.find(e=>e.name==="aniM");
const point=core.markers([{type:"node",id:397898300,lat:14.6556237,lon:152.8957163,
 tags:{brand:"aniM",name:"aniM",branch:"津川站前店",shop:"anime"}}],entries)[0];
const plain=v=>JSON.parse(JSON.stringify(v));
const functionSource=name=>{
 const multi=code.match(new RegExp(" (?:async )?function "+name+"\\([^]*?\\n \\}","u"))?.[0];
 if(multi)return multi;
 const single=code.split("\n").find(line=>line.includes(" function "+name+"("));
 assert.ok(single,name);return single;
};
function setup(vector=true){
 const layers=new Map([["poi-level-3",{id:"poi-level-3",type:"symbol",sourceLayer:"poi"}]]);
 const nativeFilter=["all",[">=","rank",25]],filters=new Map([["poi-level-3",nativeFilter]]),sources=new Map(),images=new Map();
 let queries=0,uploads=0,preloads=0,cancels=0,reads=0;
 const events=new Map(),glMap={
  style:{},getLayersOrder:()=>[...layers.keys()],getLayer:id=>layers.get(id),addLayer:l=>layers.set(l.id,l),removeLayer:id=>layers.delete(id),
  getFilter:id=>filters.get(id),setFilter:(id,f)=>filters.set(id,f),
  getSource:id=>sources.get(id),addSource:(id,s)=>sources.set(id,{data:s.data,setData(data){this.data=data;uploads++;}}),removeSource:id=>sources.delete(id),
  hasImage:id=>images.has(id),addImage:(id,data,options)=>images.set(id,{data,...options}),listImages:()=>[...images.keys()],removeImage:id=>images.delete(id),
  on:(event,fn)=>events.set(event,fn),off:event=>events.delete(event),project:()=>({x:0,y:0}),
  queryRenderedFeatures:()=>{queries++;return [];}
 };
 const context={vector:vector?glMap:null,zoom:15,satellite:false,labels:true,transit:false,night:false};
 const leaflet={items:[],clearLayers(){this.items=[];},addTo(){}},cache={items:[point],bounds:[152.89,14.65,152.9,14.66],fetchedAt:12345};
 const ctx=vm.createContext({Map,Set,Promise,Date:class extends Date{static now(){return 1000000;}},JSON,Math,console,MAP_LOGO_MIN_ZOOM:Number(code.match(/const MAP_LOGO_MIN_ZOOM=(\d+);/u)[1]),
  sourceId:"huayu-brand-logo-points",layerId:"huayu-brand-logo-points-symbols",core,entries,places:cache,
  mapImages:new Map(),assets:new Map([[entry.imageUrl,{width:72,height:72}]]),rows:new Map(),filters:new Map(),gl:null,
  entries,validResult:()=>true,cachedPlaces:()=>null,placeSignature:"",registrySignature:"",
  drawn:null,drawEpoch:0,enabled:true,document:{hidden:false,createElement:()=>({children:[],append(...n){this.children.push(...n);}})},
  atlas:{getBrandLogoContext:()=>context,canSelectBrandLogo:()=>true,selectBrandLogoPlace(){throw Error("hidden logo selected");},map:{hasLayer:()=>true}},
  preload:async()=>{preloads++;},cancelPlaces:()=>cancels++,refresh:async()=>{},api:async()=>{reads++;throw Error("unexpected request");},
  schedule(){},styleLoaded(){},leaflet,image:()=>({style:{}}),txt:(_tag,text)=>({textContent:text}),
  L:{divIcon:o=>o,marker:(at,options)=>({at,options,on(){return this;},addTo(group){group.items.push(this);return this;}})}
 });
 for(const name of ["restoreFilters","suppress","detach","imageId","mapSize","mapImage","clearMap","syncVisibility","pick","draw","update"])vm.runInContext(functionSource(name),ctx);
 return {ctx,context,glMap,sources,images,leaflet,layers,filters,nativeFilter,cache,
  get queries(){return queries;},get uploads(){return uploads;},get preloads(){return preloads;},get cancels(){return cancels;},get reads(){return reads;}};
}
const s=setup();
await s.ctx.draw();await s.ctx.update();
assert.equal(s.preloads,0);assert.equal(s.reads,0);assert.equal(s.sources.size,0,"small scale neither loads places nor adds logos");
s.context.zoom=16;await s.ctx.draw();
const layer=s.layers.get("huayu-brand-logo-points-symbols"),source=s.sources.get("huayu-brand-logo-points");
assert.equal(layer.minzoom,16);assert.equal(source.data.features.length,1);
assert.equal(source.data.features[0].properties.name,"aniM · 津川站前店");
const image=[...s.images.values()][0];assert.equal(image.pixelRatio,2);
assert.ok(Math.abs(image.data.width/image.pixelRatio*layer.layout["icon-size"]-21.6)<.01,"square logos are readable at about 22px");
assert.equal(layer.layout["text-size"],12);assert.deepEqual(plain(layer.layout["text-offset"]),[0,1.1]);
assert.notDeepEqual(plain(s.filters.get("poi-level-3")),s.nativeFilter,"only ready logo takes over matching nearby ordinary POI");
s.context.zoom=15.99;s.ctx.syncVisibility();
assert.equal(source.data.features.length,0);assert.equal(s.ctx.rows.size,0);
assert.deepEqual(plain(s.filters.get("poi-level-3")),s.nativeFilter,"zooming out immediately restores original symbols");
assert.equal(s.ctx.pick({lng:point.lon,lat:point.lat}),false);assert.equal(s.queries,0);
assert.equal(s.ctx.places,s.cache);assert.equal(s.ctx.places.fetchedAt,12345,"visibility change never discards cache or renews its source age");
const uploads=s.uploads;s.ctx.syncVisibility();assert.equal(s.uploads,uploads,"already hidden logos do not repeatedly upload empty geometry");
s.context.zoom=17;await s.ctx.draw();assert.equal(source.data.features.length,1,"zooming back reuses the full original cache");
let release;s.ctx.preload=()=>new Promise(resolve=>release=resolve);
const pending=s.ctx.draw();s.context.zoom=15;s.ctx.syncVisibility();release();await pending;
assert.equal(source.data.features.length,0,"late image load cannot reintroduce logos after zooming out");
s.context.zoom=17;s.context.satellite=true;s.context.labels=false;await s.ctx.draw();assert.equal(source.data.features.length,0);
s.context.labels=true;s.ctx.preload=async()=>{};await s.ctx.draw();assert.equal(source.data.features.length,1,"satellite annotation preference remains effective");

const fallback=setup(false);fallback.context.zoom=16;await fallback.ctx.draw();
assert.deepEqual(plain(fallback.leaflet.items[0].options.icon.iconSize),[22,22]);
assert.deepEqual(plain(fallback.leaflet.items[0].options.icon.iconAnchor),[11,11]);
fallback.context.zoom=15;fallback.ctx.syncVisibility();assert.equal(fallback.leaflet.items.length,0);
const css=await readFile("site/brand-logos.css","utf8");
assert.match(css,/\.brand-logo-map-marker img\{width:22px;height:22px;[^}]*margin:0/u);
assert.match(css,/\.brand-logo-thumbnail\{width:32px;height:32px/u,"directory thumbnails stay unchanged");
assert.match(css,/\.brand-logo-map-marker img\{[^}]*background:transparent/u);assert.match(css,/\.transit-stop-div-icon \.brand-logo-thumbnail\{[^}]*background:transparent;box-shadow:none/u);
const app=await readFile("site/app.js","utf8"),transit=app.match(/  function createTransitStopIcon\([^]*?\n  \}/u)?.[0];
const rail=vm.createContext({window:{HuayuBrandLogos:{transitEntry:()=>entry,image:()=>({}),mapImage:()=>({}),mapSize:()=>({width:32,height:22})},L:{divIcon:o=>o}}});
vm.runInContext(transit,rail);
assert.deepEqual(plain(rail.createTransitStopIcon({},[],true).iconSize),[32,22],"rail fallback uses the same prepared logo shape; station filtering remains outside this handler");
console.log("Logo display passed: actual 22px geometry, street-level gate, immediate filter/pick restoration, unchanged full cache age, late-image guard, satellite preferences and shared rail geometry.");

function cropCase(width,height,paint){
 const pixels=new Uint8ClampedArray(width*height*4);paint(pixels,width,height);
 const canvases=[],draws=[];
 const document={createElement:()=>{
  const index=canvases.length,canvas={width:0,height:0,toDataURL:()=>"data:image/png;base64,preview"};
  canvas.getContext=()=>({set fillStyle(value){draws.push({index,color:value});},drawImage:(...args)=>draws.push({index,args:args.slice(1)}),fillRect:(...args)=>draws.push({index,fill:args}),clearRect:(...args)=>draws.push({index,clear:args}),
   getImageData:()=>index===0?{data:pixels}:{width:canvas.width,height:canvas.height}});
  canvases.push(canvas);return canvas;
 }};
 const c=vm.createContext({document,Math,Error});vm.runInContext(functionSource("prepareMapLogo"),c);
 return {run:()=>c.prepareMapLogo({width,height}),canvases,draws};
}
const wide=cropCase(256,256,(p,w)=>{for(let y=90;y<170;y++)for(let x=10;x<250;x++)p[(y*w+x)*4+3]=255;});
const cropped=wide.run();
assert.equal(cropped.data.width,108);assert.equal(cropped.data.height,42);
assert.deepEqual(wide.draws.find(d=>d.index===1&&d.args).args.slice(0,4),[10,90,240,80],"only fully transparent padding is cropped");
assert.ok(wide.draws.some(d=>d.index===1&&d.clear),"prepared map canvas starts transparent");
assert.ok(!wide.draws.some(d=>d.index===1&&d.fill),"no opaque map backing can erase source transparency");
const square=cropCase(128,128,p=>{for(let i=3;i<p.length;i+=4)p[i]=255;});
assert.deepEqual(square.run().data,{width:72,height:72},"opaque original backgrounds are retained");
const faint=cropCase(16,16,p=>{p[3]=1;p[p.length-1]=1;});faint.run();
assert.deepEqual(faint.draws.find(d=>d.index===1&&d.args).args.slice(0,4),[0,0,16,16],"faint source edges remain visible");
assert.throws(()=>cropCase(8,8,()=>{}).run(),/logo_image_empty/u);
const shared={...entry,id:"shared-upload",key:"brand:shared-upload",name:"共享上传",imageUrl:"/api/brand-logos/shared-upload/image?v=hash",builtin:false};
const uploaded={...point,id:900001,logoKey:shared.key,tags:{brand:shared.name,name:shared.name,shop:"anime"},name:shared.name,label:shared.name};
s.ctx.entries.push(shared);s.ctx.places.items.push(uploaded);
s.ctx.assets.set(shared.imageUrl,{width:108,height:72});s.ctx.mapImages.set(shared.imageUrl,"data:image/png;base64,preview");
await s.ctx.draw();
assert.equal(source.data.features.length,2,"built-in and user uploads both reach the shipped renderer");
assert.equal(s.images.get(source.data.features.find(f=>f.id==="node/900001").properties.icon).pixelRatio,2);
assert.deepEqual(plain(s.ctx.mapSize(shared)),{width:32,height:22},"uploads share the same display scale and aspect ratio");
assert.match(app,/"icon-size": \["case",\["==",\["get","brandLogo"\],true\],0\.6,0\.5\]/u,"ordinary transit symbols retain their original scale");
console.log("All-logo readability passed: shared upload and built-in parity, transparent padding, original opaque/faint pixels and 32x22 bounds.");

const light=cropCase(16,16,p=>p.fill(255));light.run();assert.ok(!light.draws.some(d=>d.index===1&&d.fill),"light logos retain alpha without a solid dark or light rectangle");
