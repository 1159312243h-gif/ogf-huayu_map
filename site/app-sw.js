"use strict";
// One complete program generation per Service Worker; do not skip waiting over existing windows.
importScripts("./app-cache-version.js","./app-cache-policy.js");
const policy=self.HuayuCachePolicy,PROGRAM="huayu-program-"+self.HUAYU_CACHE_BUILD,DATA="huayu-public-data-v2";
const ORIGIN=self.location.origin,MANIFEST=ORIGIN+"/desktop-assets.json";
const nativeClients=new Set(),pending=new Map(),lastCheck=new Map();
let activeManifest=null,remotePromise=null,remoteValue=null,remoteAt=0;
const key=name=>ORIGIN+"/"+name;
async function hash(bytes){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");}
function networkRequest(url,options={}){return new Request(url,{...options,credentials:"omit",cache:"no-cache",redirect:"error",headers:{...options.headers,"X-Huayu-Cache-Network":"1"}});}
async function body(response,limit){
 const reader=response.body?.getReader();if(!reader)throw Error("资源正文缺失");const chunks=[];let total=0;
 try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>limit)throw Error("资源超过完整缓存预算");chunks.push(part.value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}
 const result=new Uint8Array(total);let offset=0;for(const part of chunks){result.set(part,offset);offset+=part.length;}return result;
}
async function checked(response,file){
 if(response.status!==200)throw Error("未取得完整资源");const bytes=await body(response,Math.max(file.bytes,file.decodedBytes||0));
 const digest=await hash(bytes);if(!(bytes.length===file.bytes&&digest===file.sha256)&&!(bytes.length===file.decodedBytes&&digest===file.decodedSha256))throw Error("资源校验失败");return bytes;
}
async function readManifest(){
 if(activeManifest)return activeManifest;
 const saved=await(await caches.open(PROGRAM)).match(MANIFEST);if(!saved)throw Error("本机完整程序尚未准备");activeManifest=policy.manifest(await saved.json());return activeManifest;
}
async function onlineManifest(){
 if(remoteValue&&Date.now()-remoteAt<policy.interval)return remoteValue;
 if(remotePromise)return remotePromise;
 remotePromise=(async()=>{const r=await fetch(networkRequest(MANIFEST,{signal:AbortSignal.timeout(12000)}));if(r.status!==200)throw Error("更新清单不可用");const m=policy.manifest(JSON.parse(new TextDecoder().decode(await body(r,512*1024))));remoteValue=m;remoteAt=Date.now();return m;})().finally(()=>{remotePromise=null;});return remotePromise;
}
async function install(){
 const m=await onlineManifest(),version=m.files.find(f=>f.path==="app-cache-version.js");
 if(!version)throw Error("程序版本标识缺失");
 const versionResponse=await fetch(networkRequest(key(version.path))),versionBytes=await checked(versionResponse,version);
 if(!new TextDecoder().decode(versionBytes).includes('"'+self.HUAYU_CACHE_BUILD+'"'))throw Error("程序更新期间版本已变化");
 const cache=await caches.open(PROGRAM),files=m.files.filter(f=>f.kind==="code");let cursor=0;
 const worker=async()=>{while(cursor<files.length){const f=files[cursor++],r=await fetch(networkRequest(key(f.path),{signal:AbortSignal.timeout(30000)})),type=r.headers.get("content-type")||"application/octet-stream",bytes=await checked(r,f);
  await cache.put(key(f.path),new Response(bytes,{headers:{"Content-Type":type,"Cache-Control":"no-store","X-Huayu-Program":self.HUAYU_CACHE_BUILD}}));
 }};
 const results=await Promise.allSettled([worker(),worker(),worker()]);if(results.some(r=>r.status==="rejected"))throw Error("程序更新未完整完成");
 await cache.put(MANIFEST,new Response(JSON.stringify(m),{headers:{"Content-Type":"application/json"}}));activeManifest=m;
}
function response(bytes,headers,source){return new Response(bytes,{headers:{...headers,"Cache-Control":"no-store","X-Huayu-App-Source":source}});}
async function seed(request,clientId){
 if(!nativeClients.has(clientId)){try{const client=await self.clients.get(clientId);if(!client||new URL(client.url).searchParams.get("app")!=="native")return null;}catch{return null;}}const url=new URL(request.url);url.searchParams.set("huayuSeed","1");
 try{const r=await fetch(new Request(url,{credentials:"omit",signal:AbortSignal.timeout(3000)}));if(r.status===200&&r.headers.get("X-Huayu-App-Source")==="android-bundle")return r;}catch{}return null;
}
async function updateData(request,name,saved){
 if(pending.has(name))return pending.get(name);
 const work=(async()=>{
  lastCheck.set(name,Date.now());let file;try{file=(await onlineManifest()).files.find(f=>f.path===name&&f.kind==="data");}catch{}
  const r=await fetch(networkRequest(request.url,{signal:AbortSignal.timeout(25000)}));if(r.status!==200)throw Error("公开数据读取失败");
  if(!file)return r; // Original frontend validates live data; no unchecked body is persisted.
  if(request.signal.aborted)throw Error("读取已取消");
  const bytes=await checked(r,file),oldTime=saved?.headers.get("X-Huayu-Source-Time"),newTime=file.sourceTime;
  if(oldTime&&(!newTime||Date.parse(newTime)<Date.parse(oldTime)))throw Error("保留较新的本机数据");
  const result=response(bytes,{"Content-Type":name.endsWith(".gz")&&bytes[0]===31?"application/gzip":"application/json","X-Huayu-Saved-At":String(Date.now()),"X-Huayu-Source-Time":newTime||"","Content-Length":String(bytes.length),"X-Huayu-SHA256":file.sha256},"verified-public-snapshot");
  try{const cache=await caches.open(DATA);await cache.put(key(name),result.clone());void pruneData(cache);}catch{}
  if(saved?.headers.get("X-Huayu-SHA256")!==file.sha256){const clients=await self.clients.matchAll({type:"window"});for(const client of clients)client.postMessage({type:"huayu:public-data-updated",name});}
  return result;
 })().finally(()=>pending.delete(name));pending.set(name,work);return work;
}
let pruneAt=0;
async function pruneData(cache){
 if(Date.now()-pruneAt<60000)return;pruneAt=Date.now();
 const rows=[];for(const request of await cache.keys()){const r=await cache.match(request),size=Number(r.headers.get("content-length"));rows.push({request,at:Number(r.headers.get("X-Huayu-Saved-At"))||0,size:Number.isFinite(size)&&size>0?size:(await r.arrayBuffer()).byteLength});}
 rows.sort((a,b)=>b.at-a.at);let total=0;for(const row of rows){total+=row.size;if(total>192*1024*1024)await cache.delete(row.request);}
}
async function data(request,name,event){
 let saved;try{saved=await(await caches.open(DATA)).match(key(name));}catch{}
 const url=new URL(request.url),forced=policy.force(request,url);
 if(saved&&!forced){
  const checkedAt=Math.max(Number(saved.headers.get("X-Huayu-Saved-At"))||0,lastCheck.get(name)||0);
  if(Date.now()-checkedAt>=policy.interval){
   // Return the updated response to this caller; it must not remain hidden behind stale local data.
   try{return await updateData(request,name,saved);}catch{return saved;}
  }return saved;
 }
 if(!saved&&!forced){const bundled=await seed(request,event.clientId);if(bundled){event.waitUntil(updateData(request,name,null).catch(()=>{}));return bundled;}}
 try{return await updateData(request,name,saved);}catch(e){if(request.signal.aborted)throw e;if(saved)return saved;const bundled=await seed(request,event.clientId);if(bundled)return bundled;throw e;}
}
self.addEventListener("install",event=>event.waitUntil(install()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{
 await readManifest();await self.clients.claim();
 // Delete only older program generations owned by this application, keeping one complete fallback.
 const own=(await caches.keys()).filter(n=>n.startsWith("huayu-program-")&&n!==PROGRAM);for(const name of own.slice(0,-1))await caches.delete(name);
})()));
self.addEventListener("message",event=>{
 if(event.data?.type==="huayu:cache-config"&&event.source?.id){if(event.data.nativeSeed)nativeClients.add(event.source.id);else nativeClients.delete(event.source.id);}
 if(event.data?.type==="huayu:cache-status")event.waitUntil((async()=>{let m;try{m=await readManifest();}catch{}event.ports?.[0]?.postMessage({ready:Boolean(m),revision:m?.revision||null,programCache:PROGRAM,publicData:true,privateApiCache:false});})());
});
self.addEventListener("fetch",event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=="GET"||url.origin!==ORIGIN||url.pathname.startsWith("/api/")||url.searchParams.has("huayuSeed")||request.headers.get("X-Huayu-Cache-Network")==="1")return;
 let name;try{name=decodeURIComponent(url.pathname.slice(1))||"index.html";}catch{return;}
 if(name==="apps")name="apps.html";
 if(!policy.publicFile(name))return;
 if(policy.dataFile(name)){event.respondWith(data(request,name,event));return;}
 event.respondWith((async()=>{
  const m=await readManifest();if(!m.files.some(f=>f.path===name&&f.kind==="code"))return fetch(request);
  const stored=await(await caches.open(PROGRAM)).match(key(name));if(stored)return stored;
  // Never fetch one newer script into an existing complete program generation.
  throw Error("本机程序文件缺失，请重新打开应用恢复完整版本");
 })());
});
