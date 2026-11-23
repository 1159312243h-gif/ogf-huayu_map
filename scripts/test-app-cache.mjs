import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {webcrypto,createHash} from "node:crypto";
const swCode=await readFile(new URL("../site/app-sw.js",import.meta.url),"utf8"),policyCode=await readFile(new URL("../site/app-cache-policy.js",import.meta.url),"utf8");
const sha=value=>createHash("sha256").update(value).digest("hex"),origin="https://ogf-atlas.pages.dev",build="b".repeat(64);
let sources={"app-cache-version.js":'self.HUAYU_CACHE_BUILD = "'+build+'";\n',"app.js":"window.fullMap=true;","index.html":"<script defer src=app.js></script>","transit-preload.json":JSON.stringify({generatedAt:"2026-11-22T00:00:00Z",snapshots:[{complete:true}]})};
const manifest=()=>({schema:"huayu-desktop-assets-v1",runtime:1,version:"9.0.3",revision:"c".repeat(64),files:Object.entries(sources).map(([path,text])=>({path,bytes:Buffer.byteLength(text),sha256:sha(text),kind:path.endsWith(".json")?"data":"code",sourceTime:path.endsWith(".json")?JSON.parse(text).generatedAt:undefined}))});
const cachesMap=new Map(),handlers={},events=[],network=[];let failed=false,corrupt=false,clock=1764000000000;
function cache(name){if(!cachesMap.has(name))cachesMap.set(name,new Map());const values=cachesMap.get(name);return {match:async k=>values.get(typeof k==="string"?k:k.url)?.clone(),put:async(k,r)=>values.set(typeof k==="string"?k:k.url,r.clone()),keys:async()=>[...values.keys()].map(k=>new Request(k)),delete:async k=>values.delete(typeof k==="string"?k:k.url)};}
const caches={open:async name=>cache(name),keys:async()=>[...cachesMap.keys()],delete:async name=>cachesMap.delete(name)};
const self={location:{origin},clients:{claim:async()=>{},get:async()=>({url:origin+"/?app=native"}),matchAll:async()=>[{postMessage:m=>events.push(m)}]},addEventListener:(name,handler)=>handlers[name]=handler};
const context={self,globalThis:self,caches,crypto:webcrypto,Request,Response,URL,TextDecoder,Uint8Array,AbortSignal,Date:class extends Date{static now(){return clock;}},fetch:async request=>{
 const url=new URL(typeof request==="string"?request:request.url),name=url.pathname.slice(1);network.push({name,headers:typeof request==="string"?null:Object.fromEntries(request.headers)});
 if(failed)throw Error("connection reset");if(name==="desktop-assets.json")return Response.json(manifest());
 if(!(name in sources))return new Response("missing",{status:404});return new Response(corrupt&&name==="app.js"?"truncated":sources[name],{headers:{"Content-Type":name.endsWith(".js")?"text/javascript":"application/json"}});
},importScripts(...names){for(const name of names){if(name.includes("version"))self.HUAYU_CACHE_BUILD=build;else vm.runInContext(policyCode,realm);}}};
const realm=vm.createContext(context);vm.runInContext(swCode,realm);
async function lifecycle(type){let p;handlers[type]({waitUntil:v=>p=v});await p;}
async function get(path,{cacheMode="default",method="GET",signal}={}){let value;const waits=[];const request=new Request(origin+path,{cache:cacheMode,method,...(signal?{signal}:{}),...(method==="POST"?{body:"private"}:{})});handlers.fetch({request,clientId:"browser",waitUntil:p=>waits.push(p),respondWith:p=>value=p});return {response:value?await value:null,waits};}
await lifecycle("install");await lifecycle("activate");
assert.ok(!("skipWaiting" in self),"不能抢占现有程序窗口热切换新旧脚本");
failed=true;assert.equal(await(await get("/app.js?v=random")).response.text(),sources["app.js"],"同一完整程序从缓存读取，无网络依赖");
for(const path of ["/api/auth/session","/api/datasets","/api/brand-logos","/api/timetables"]){assert.equal((await get(path)).response,null,"共享与私人接口绕过程序缓存");}
assert.equal((await get("/api/datasets",{method:"POST"})).response,null);
failed=false;let r=await get("/transit-preload.json");assert.equal((await r.response.json()).generatedAt,"2026-11-22T00:00:00Z");
clock+=300001;sources["transit-preload.json"]=JSON.stringify({generatedAt:"2026-11-23T00:00:00Z",snapshots:[{complete:true,updated:true}]});
r=await get("/transit-preload.json");assert.equal((await r.response.json()).generatedAt,"2026-11-23T00:00:00Z","普通到期检查必须交付新快照");
failed=true;clock+=300001;r=await get("/transit-preload.json");assert.equal((await r.response.json()).generatedAt,"2026-11-23T00:00:00Z","网络失败保留原完整快照与源时间");
failed=false;clock+=300001;sources["transit-preload.json"]=JSON.stringify({generatedAt:"2026-11-21T00:00:00Z",snapshots:[]});r=await get("/transit-preload.json",{cacheMode:"reload"});assert.equal((await r.response.json()).generatedAt,"2026-11-23T00:00:00Z","旧线上快照不回退本机数据");
cachesMap.set("private-user-storage",new Map());cachesMap.set("building-model-cache",new Map());await lifecycle("activate");assert.ok(cachesMap.has("private-user-storage")&&cachesMap.has("building-model-cache"));
assert.ok(events.some(e=>e.type==="huayu:public-data-updated"));
console.log("Cross-platform cache passed: complete program offline, exact manifest hashes, ordinary expiry delivers latest data, source-age rollback, offline retention, no API/write caching and no private/model cache deletion.");
