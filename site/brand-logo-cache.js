(function install(root){
 "use strict";
 const TTL=3*3600000;
 const object=v=>v&&typeof v==="object"&&!Array.isArray(v);
 const url=v=>typeof v==="string"&&/^\/(?:brand-logos\/[a-zA-Z0-9._-]+\.webp\?v=[a-f0-9]{64}|api\/brand-logos\/[a-zA-Z0-9_-]{1,80}\/image\?v=[a-f0-9]{64})$/u.test(v);
 function registry(items){
  return Array.isArray(items)&&items.length>0&&items.length<=1000&&new Set(items.map(e=>e?.key)).size===items.length&&items.every(e=>object(e)
   &&["brand","operator","transit"].includes(e.kind)&&typeof e.key==="string"&&e.key.startsWith(e.kind+":")
   &&typeof e.id==="string"&&typeof e.name==="string"&&e.name.length>0&&e.name.length<=160&&url(e.imageUrl)
   &&Array.isArray(e.aliases)&&e.aliases.length<=20&&e.aliases.every(v=>typeof v==="string"&&v.length<=160)
   &&Array.isArray(e.categories)&&e.categories.every(c=>Array.isArray(c)&&typeof c[0]==="string"&&Number.isFinite(c[1])));
 }
 function windowValid(p,now=Date.now()){
  return object(p)&&Number.isFinite(p.fetchedAt)&&p.fetchedAt>0&&p.fetchedAt<=now+60000&&now-p.fetchedAt<TTL
   &&typeof p.signature==="string"&&p.signature.length<=1024*1024&&Array.isArray(p.bounds)&&p.bounds.length===4&&p.bounds.every(Number.isFinite)
   &&p.bounds[0]>=-180&&p.bounds[2]<=180&&p.bounds[1]>=-85&&p.bounds[3]<=85&&p.bounds[0]<p.bounds[2]&&p.bounds[1]<p.bounds[3]
   &&Array.isArray(p.items)&&p.items.length<=3000&&new Set(p.items.map(e=>e?.type+"/"+e?.id)).size===p.items.length
   &&p.items.every(e=>object(e)&&["node","way","relation"].includes(e.type)&&Number.isSafeInteger(e.id)&&e.id>0
    &&Number.isFinite(e.lat)&&Math.abs(e.lat)<=85&&Number.isFinite(e.lon)&&Math.abs(e.lon)<=180
    &&typeof e.name==="string"&&typeof e.label==="string"&&typeof e.logoKey==="string"&&object(e.tags));
 }
 function createStore({storage=null,now=()=>Date.now()}={}){
  const keys={registry:"huayu-public-logo-registry-v2",windows:"huayu-public-logo-windows-v2",images:"huayu-transparent-logo-images-v2"};
  const fresh=at=>Number.isFinite(at)&&at>0&&at<=now()+60000&&now()-at<TTL;
  function read(key,max){try{const text=storage?.getItem(key);return text&&text.length*2<=max?JSON.parse(text):null;}catch{return null;}}
  function write(key,value,max){try{const text=JSON.stringify(value);if(text.length*2<=max)storage?.setItem(key,text);}catch{}}
  let images=read(keys.images,2*1024*1024);if(!Array.isArray(images))images=[];
  images=images.filter(e=>object(e)&&fresh(e.at)&&url(e.url)&&typeof e.png==="string"&&e.png.length<180000
   &&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(e.png));
  return Object.freeze({
   registry(){const r=read(keys.registry,1024*1024);return r&&fresh(r.readAt)&&registry(r.items)?r:null;},
   saveRegistry(items,readAt){if(registry(items)&&fresh(readAt))write(keys.registry,{items,readAt},1024*1024);},
   windows(){const p=read(keys.windows,2*1024*1024);return Array.isArray(p)?p.filter(w=>windowValid(w,now())).slice(0,8):[];},
   saveWindows(values){const p=values.filter(w=>windowValid(w,now())).slice(0,8);while(p.length&&JSON.stringify(p).length*2>2*1024*1024)p.pop();write(keys.windows,p,2*1024*1024);},
   image(source){return images.find(e=>e.url===source&&fresh(e.at))?.png||null;},
   saveImage(source,png){if(!url(source)||typeof png!=="string"||png.length>=180000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(png))return;
    images=images.filter(e=>e.url!==source&&fresh(e.at));images.unshift({url:source,png,at:now()});images=images.slice(0,96);
    while(images.length&&JSON.stringify(images).length*2>2*1024*1024)images.pop();write(keys.images,images,2*1024*1024);
   }
  });
 }
 root.HuayuBrandLogoCache=Object.freeze({createStore,validRegistry:registry,validWindow:windowValid});
})(typeof window==="object"?window:globalThis);
