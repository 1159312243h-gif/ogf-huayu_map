import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/brand-logo-core.js";
const source=await readFile("site/brand-logos.js","utf8"),cacheSource=await readFile("site/brand-logo-cache.js","utf8");
const builtins=JSON.parse(await readFile("site/brand-logos.json","utf8")).items,core=globalThis.HuayuBrandLogoCore;
const anim=builtins.find(e=>e.name==="aniM"),todays=builtins.find(e=>e.name==="ToDays"),now=9000000,age=180000;
const sample={type:"node",id:397898300,lat:14.6556237,lon:152.8957163,tags:{brand:"aniM",name:"aniM",branch:"津川站前店",shop:"anime"}};
const point=core.markers([sample],builtins)[0],sig=items=>JSON.stringify(items.map(e=>[e.key,e.imageUrl,e.aliases,e.categories]));
const bounds=[152.894,14.654,152.898,14.657],windowData={items:[point],bounds,fetchedAt:now-age,dbTimestamp:"2026-11-18T02:03:33Z",signature:sig(builtins)};
const png="data:image/png;base64,QUJD";
function storage(){const values=new Map();return {values,getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};}
function seed(store,{registry=true,window=true,image=true}={}){
 const ctx=vm.createContext({Date,Map,Set,JSON,Math});vm.runInContext(cacheSource,ctx);
 const cache=ctx.HuayuBrandLogoCache.createStore({storage:store,now:()=>now});
 if(registry)cache.saveRegistry(builtins,now-age);if(window)cache.saveWindows([windowData]);if(image)cache.saveImage(anim.imageUrl,png);
 return cache;
}
function harness({store=storage(),view=bounds,online="hang",places="hang",slowImage=null}={}){
 let time=now,nextId=0,registryReads=0,placeReads=0,staticReads=0,imageReads=0;
 const timers=new Map(),nodes=new Map(),events=new Map(),layers=new Map([["poi-level-3",{id:"poi-level-3",type:"symbol",sourceLayer:"poi"}]]);
 const images=new Map(),sources=new Map(),filters=new Map([["poi-level-3",["all"]]]),requests=[],onlineResolvers=[];
 const on=(name,fn)=>{for(const k of name.split(" ")){if(!events.has(k))events.set(k,[]);events.get(k).push(fn);}};
 function node(){return {style:{},children:[],value:"",checked:true,hidden:false,textContent:"",append(...items){this.children.push(...items);},
  replaceChildren(...items){this.children=items;},addEventListener(){},getContext(){return {drawImage(){},clearRect(){},
  getImageData:()=>({width:this.width,height:this.height,data:new Uint8ClampedArray(this.width*this.height*4).fill(255)})};},toDataURL:()=>png};}
 const map={style:{},getLayersOrder:()=>[...layers.keys()],getLayer:id=>layers.get(id),addLayer:l=>layers.set(l.id,l),removeLayer:id=>layers.delete(id),
  getSource:id=>sources.get(id),addSource:(id,s)=>sources.set(id,{data:s.data,setData(data){this.data=data;}}),removeSource:id=>sources.delete(id),
  getFilter:id=>filters.get(id),setFilter:(id,f)=>filters.set(id,f),hasImage:id=>images.has(id),addImage:(id,data)=>images.set(id,data),
  listImages:()=>[...images.keys()],removeImage:id=>images.delete(id),on,off(){},project:()=>({x:0,y:0}),queryRenderedFeatures:()=>[]};
 const context={vector:map,zoom:18,labels:true,satellite:false,transit:false,night:false,
  bounds:{getWest:()=>view[0],getSouth:()=>view[1],getEast:()=>view[2],getNorth:()=>view[3]}};
 const atlas={getBrandLogoContext:()=>context,map:{on,off(){},hasLayer:()=>true},refreshBrandLogoTransit(){}};
 const document={hidden:false,addEventListener:on,createElement:node,getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}};
 const ctx=vm.createContext({console,Map,Set,JSON,Math,Date:class extends Date{static now(){return time;}},Uint8ClampedArray,Error,
  document,localStorage:store,sessionStorage:storage(),HuayuAtlas:atlas,HuayuBrandLogoCore:core,AbortSignal,AbortController,
  addEventListener:on,dispatchEvent:e=>{for(const fn of events.get(e.type)||[])fn(e);},CustomEvent:class{constructor(type){this.type=type;}},
  setTimeout:(fn,ms)=>{timers.set(++nextId,{fn,at:time+ms});return nextId;},clearTimeout:id=>timers.delete(id),setInterval:()=>++nextId,clearInterval(){},
  createImageBitmap:async()=>({width:108,height:42,close(){}}),
  L:{layerGroup:()=>({clearLayers(){}})},
  fetch:async(url,options={})=>{
   if(url==="/api/brand-logos"){registryReads++;if(online==="fail")throw Error("offline");
    if(online==="success")return {ok:true,json:async()=>({items:builtins,sharedAvailable:true})};
    return new Promise(resolve=>onlineResolvers.push(items=>resolve({ok:true,json:async()=>({items,sharedAvailable:true})})));}
   if(url==="./brand-logos.json"){staticReads++;return {ok:true,json:async()=>({items:builtins})};}
   if(url.startsWith("/api/brand-logo-places?")){placeReads++;return new Promise((resolve,reject)=>requests.push({
     url,signal:options.signal,resolve:v=>resolve({ok:true,json:async()=>v}),reject}));}
   if(url===png)return {ok:true,blob:async()=>({})};
   imageReads++;if(url===slowImage)return new Promise(()=>{});return {ok:true,blob:async()=>({})};
  }});
 ctx.window=ctx;vm.runInContext(cacheSource,ctx);vm.runInContext(source,ctx);
 const micro=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
 return {ctx,store,context,map,requests,nodes,images,onlineResolvers,async tick(ms=0){
   time+=ms;await micro();
   for(let pass=0;pass<12;pass++){const ready=[...timers].filter(([,v])=>v.at<=time);if(!ready.length)break;
    for(const [id,v] of ready){timers.delete(id);v.fn();}await micro();}
  },event(name){for(const fn of events.get(name)||[])fn();},
  get features(){return sources.get("huayu-brand-logo-points")?.data.features||[];},
  get registryReads(){return registryReads;},get placeReads(){return placeReads;},get staticReads(){return staticReads;},get imageReads(){return imageReads;}
 };
}
{
 const store=storage();seed(store);
 const s=harness({store});await s.tick(0);await s.tick(450);
 assert.equal(s.registryReads,1);assert.equal(s.features[0]?.id,"node/397898300","cached real identity renders before online registry completes");
 assert.equal(s.imageReads,0,"prepared transparent image restores without a new source fetch");
 assert.equal(s.placeReads,1,"background fresh places still requested using original cache age");
 s.requests[0].reject(Error("offline"));await s.tick();
 assert.equal(s.features.length,1,"failed current query retains ready cached point");
 assert.equal(JSON.parse(store.getItem("huayu-public-logo-windows-v2"))[0].fetchedAt,now-age);
 const reloaded=harness({store});await reloaded.tick();await reloaded.tick(450);
 assert.equal(reloaded.features.length,1,"a new tab restores public registry, complete points and image cache");
 reloaded.context.zoom=15;reloaded.event("zoom");assert.equal(reloaded.features.length,0);
 reloaded.context.zoom=18;reloaded.event("moveend");await reloaded.tick(450);assert.equal(reloaded.features.length,1);
 reloaded.context.night=true;reloaded.event("style.load");await reloaded.tick(450);assert.equal(reloaded.features.length,1);
 assert.ok([...reloaded.images.keys()].every(id=>id.startsWith("huayu-logo-transparent-v2-")),"old opaque textures cannot be reused");
}
{
 const store=storage();seed(store);
 const s=harness({store,view:[152.892,14.653,152.9,14.659]});await s.tick();await s.tick(450);
 assert.equal(s.features.length,1,"enlarged view restores overlapping known points immediately");
 assert.equal(s.placeReads,1,"overlap is never treated as complete new viewport coverage");
 assert.ok(s.requests[0].url.includes("152.890560"));
 const stored=JSON.parse(store.getItem("huayu-public-logo-windows-v2"))[0];assert.deepEqual(stored.bounds,bounds);
 assert.equal(stored.fetchedAt,now-age,"partial restoration never expands or renews the original complete window");
}
{
 const store=storage();seed(store,{registry:false,image:false});
 const s=harness({store});await s.tick();await s.tick(450);
 assert.equal(s.staticReads,1);assert.equal(s.features.length,1,"bundled registry and existing real points render while online directory hangs");
}
{
 const store=storage();const cache=seed(store);
 const second=core.markers([{...sample,id:900001,tags:{brand:"ToDays",name:"ToDays",shop:"convenience"}}],builtins)[0];
 cache.saveWindows([{...windowData,items:[point,second]}]);
 const s=harness({store,slowImage:todays.imageUrl});await s.tick();await s.tick(450);
 assert.equal(s.features.length,1);assert.equal(s.features[0].id,"node/397898300","one stalled image cannot block another ready brand");
}
{
 const store=storage();seed(store);const s=harness({store});await s.tick();await s.tick(450);
 s.onlineResolvers[0](builtins.filter(e=>e.key!==anim.key));await s.tick();await s.tick(450);
 assert.equal(s.features.length,0,"deleted registry association is removed immediately");
 s.requests[0].resolve({...windowData});await s.tick();assert.equal(s.features.length,0,"late old registry response cannot restore removed identity");
}
{
 const store=storage(),cache=seed(store);
 assert.equal(cache.registry().readAt,now-age);assert.equal(cache.windows()[0].fetchedAt,now-age);
 const ctx=vm.createContext({Date,Map,Set,JSON,Math});vm.runInContext(cacheSource,ctx);
 const expired=ctx.HuayuBrandLogoCache.createStore({storage:store,now:()=>now+3*3600000});
 assert.equal(expired.registry(),null);assert.equal(expired.windows().length,0);assert.equal(expired.image(anim.imageUrl),null);
 cache.saveRegistry([{...anim,imageUrl:"https://other.invalid/asset.png"}],now);assert.equal(cache.registry().items.length,4);
 cache.saveWindows([{...windowData,items:[point,point]}]);assert.equal(cache.windows().length,0,"duplicate identity never enters complete point cache");
 cache.saveWindows(Array.from({length:12},()=>windowData));assert.equal(cache.windows().length,8);
 cache.saveImage("/brand-logos/unversioned.webp",png);assert.equal(cache.image("/brand-logos/unversioned.webp"),null);
 assert.equal(cache.image(anim.imageUrl),png);
 store.setItem("huayu-public-logo-registry-v2","{");assert.equal(cache.registry(),null);
 const denied=ctx.HuayuBrandLogoCache.createStore({storage:{getItem(){throw Error("denied");},setItem(){throw Error("quota");}},now:()=>now});
 assert.equal(denied.registry(),null);assert.doesNotThrow(()=>denied.saveRegistry(builtins,now));
 for(let i=0;i<120;i++)cache.saveImage("/api/brand-logos/img"+i+"/image?v="+"f".repeat(64),png);
 assert.equal(JSON.parse(store.getItem("huayu-transparent-logo-images-v2")).length,96,"prepared cache has an image count bound");
}
console.log("Whole logo module passed: blocked/failed directory, bundled fallback, reload/new tab, viewport growth, original timestamps, independent images, zoom/night, deleted identities, expiry, corruption, quotas and cache bounds.");
