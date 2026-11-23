"use strict";
// Keep the real HTTPS origin: existing cookies, CSP, workers and API authorization still apply.
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto"),zlib=require("node:zlib");
const {TileCache}=require("./tile-cache.cjs");
const digest=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const RUNTIME=1,MAX_FILE=25*1024*1024,MAX_DATA=128*1024*1024,MAX_CODE=128*1024*1024;
const newerVersion=(a,b)=>a.split(".").map(Number).reduce((n,v)=>n*10000+v,0)>=b.split(".").map(Number).reduce((n,v)=>n*10000+v,0);
const {dataFile}=require("./cache-policy.cjs");
function safePath(name){return typeof name==="string"&&name.length<240&&!name.startsWith("/")&&!name.includes("\\")&&!name.includes("%")&&!name.split("/").some(part=>!part||part==="."||part===".."||part.startsWith(".")||part.startsWith("_")||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(part))&&/^[a-zA-Z0-9_./-]+$/.test(name)&&!/(?:^|\/)[^/]*-server\.js$/.test(name)&&!/[.](?:toml|env|map|sql)$/.test(name)&&name!=="package.json"&&name!=="updater-jwks.json";}
function publicFile(name){return safePath(name)&&name!=="desktop-assets.json"&&/\.(?:html|js|css|json|gz|svg|png|webp|jpg|glb|txt|md|webmanifest)$/.test(name);}
function codeId(files){return digest(Buffer.from(JSON.stringify(files.filter(f=>f.kind==="code").map(f=>[f.path,f.bytes,f.sha256]))));}
function validateManifest(m){
 if(m?.schema!=="huayu-desktop-assets-v1"||m.runtime!==RUNTIME||!/^\d+\.\d+\.\d+$/.test(m.version)||!Array.isArray(m.files)||m.files.length<2||m.files.length>512)throw Error("不兼容的本地资源清单");
 const names=new Set();let total=0,code=0;
 for(const f of m.files){if(!publicFile(f.path)||names.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>MAX_FILE||!/^[a-f0-9]{64}$/.test(f.sha256)||f.kind!==(dataFile(f.path)?"data":"code"))throw Error("本地资源清单校验失败");if(f.kind==="data"&&f.decodedBytes!==undefined&&(!Number.isSafeInteger(f.decodedBytes)||f.decodedBytes<0||f.decodedBytes>MAX_DATA||!/^[a-f0-9]{64}$/.test(f.decodedSha256)))throw Error("无效压缩数据清单");if(f.sourceTime!==undefined&&f.sourceTime!==null&&(typeof f.sourceTime!=="string"||!Number.isFinite(Date.parse(f.sourceTime))))throw Error("无效源时间");names.add(f.path);total+=f.bytes;if(f.kind==="code")code+=f.bytes;}
 if(total>256*1024*1024||code>MAX_CODE||!names.has("index.html")||!names.has("app.js")||m.revision!==codeId(m.files))throw Error("本地资源版本不完整");return m;
}
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".webmanifest":"application/manifest+json",".svg":"image/svg+xml",".png":"image/png",".webp":"image/webp",".jpg":"image/jpeg",".glb":"model/gltf-binary",".txt":"text/plain; charset=utf-8",".md":"text/plain; charset=utf-8",".gz":"application/gzip"};
async function readLimited(response,limit){
 const size=Number(response.headers.get("content-length"));if(Number.isFinite(size)&&size>limit)throw Error("资源超过完整下载预算");
 const chunks=[];let bytes=0;const reader=response.body?.getReader();if(!reader)throw Error("资源正文缺失");
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw Error("资源超过完整下载预算");chunks.push(Buffer.from(part.value));}}catch(e){await reader.cancel().catch(()=>{});throw e;}
 return Buffer.concat(chunks,bytes);
}
function sourceTime(bytes,name){try{const b=name.endsWith(".gz")&&bytes[0]===31&&bytes[1]===139?zlib.gunzipSync(bytes,{maxOutputLength:MAX_DATA}):bytes;const v=JSON.parse(b.toString("utf8"));return [v.sourceTime,v.dbTimestamp,v.generatedAt,v.readAt,v.sourceUpdatedAt].find(t=>typeof t==="string"&&Number.isFinite(Date.parse(t)))||null;}catch{return null;}}
function matches(bytes,f){return bytes.length===f.bytes&&digest(bytes)===f.sha256||f.kind==="data"&&bytes.length===f.decodedBytes&&digest(bytes)===f.decodedSha256;}
function validData(bytes,name){try{const body=name.endsWith(".gz")&&bytes[0]===31&&bytes[1]===139?zlib.gunzipSync(bytes,{maxOutputLength:256*1024*1024}):bytes;const value=JSON.parse(body.toString("utf8"));return value&&typeof value==="object"&&!value.error&&!value.remark;}catch{return false;}}
class LocalClient {
 constructor({origin,bundle,directory,fetch,offline=false,now=Date.now}){this.origin=origin;this.bundle=bundle;this.directory=directory;this.fetch=fetch;this.offline=offline;this.now=now;this.pending=new Map();this.directData=new Set();this.checked=new Map();this.verified=new Set();this.cacheIndex=new Map();this.updateState="pending";this.lastUpdateAttempt=0;this.tiles=new TileCache({directory:path.join(directory,"basemap"),fetch:request=>this.online(request),now});}
 async init(){
  this.packaged=validateManifest(JSON.parse(await fs.readFile(path.join(this.bundle,"desktop-assets.json"),"utf8")));
  this.active={manifest:this.packaged,directory:this.bundle};
  try{const pointer=JSON.parse(await fs.readFile(path.join(this.directory,"active.json"),"utf8"));if(!/^[a-f0-9]{64}$/.test(pointer.revision))throw Error("版本指针无效");
   const dir=path.join(this.directory,"versions",pointer.revision),m=validateManifest(JSON.parse(await fs.readFile(path.join(dir,"desktop-assets.json"),"utf8")));
   if(m.revision!==pointer.revision||!newerVersion(m.version,this.packaged.version))throw Error("版本不匹配");await this.checkCode(dir,m);this.active={manifest:m,directory:dir};
  }catch{/* A missing or damaged update never replaces the complete built-in application. */}
  this.code=new Map(this.active.manifest.files.filter(f=>f.kind==="code").map(f=>[f.path,f]));
  this.seeds=new Map(this.packaged.files.filter(f=>f.kind==="data").map(f=>[f.path,f]));
  try{await fs.mkdir(path.join(this.directory,"public-data"),{recursive:true});}catch{}
  return this;
 }
 status(){return {localAssets:true,revision:this.active.manifest.revision,bundledBytes:this.packaged.files.reduce((s,f)=>s+f.bytes,0),bundledPublicData:true,programUpdates:"verified-on-restart",updateState:this.updateState};}
 async checkCode(dir,m){for(const f of m.files.filter(f=>f.kind==="code")){const b=await fs.readFile(path.join(dir,f.path));if(b.length!==f.bytes||digest(b)!==f.sha256)throw Error("本地程序文件损坏");}}
 async file(dir,f,source){
  const bytes=await fs.readFile(path.join(dir,f.path)),key=dir+"/"+f.path;
  if(!this.verified.has(key)){if(bytes.length!==f.bytes||digest(bytes)!==f.sha256)throw Error("本地文件校验失败");this.verified.add(key);}
  return new Response(bytes,{headers:{"Content-Type":MIME[path.extname(f.path)]||"application/octet-stream","Cache-Control":"no-store","X-Huayu-Desktop-Source":source}});
 }
 async online(request){if(this.offline)throw Error("诊断离线模式");return this.fetch(request,{bypassCustomProtocolHandlers:true});}
 async cached(name){
  try{const key=digest(Buffer.from(name)),record=JSON.parse(await fs.readFile(path.join(this.directory,"public-data",key+".json"),"utf8"));
   if(record.path!==name||!Number.isSafeInteger(record.bytes)||record.bytes>MAX_DATA||!/^[a-f0-9]{64}$/.test(record.sha256))return null;
   const bytes=await fs.readFile(path.join(this.directory,"public-data",record.sha256+".bin"));if(bytes.length!==record.bytes||digest(bytes)!==record.sha256 )return null;
   this.cacheIndex.set(name,record);return {bytes,record};
  }catch{return null;}
 }
 dataResponse(bytes,source){return new Response(bytes,{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Huayu-Desktop-Source":source}});}
 async remoteManifest(){
  if(this.latestManifest&&this.now()-this.manifestReadAt<300000)return this.latestManifest;
  if(this.manifestPending)return this.manifestPending;
  const work=(async()=>{const r=await this.online(new Request(this.origin+"/desktop-assets.json",{credentials:"omit",cache:"no-cache",redirect:"error",signal:AbortSignal.timeout(12000)}));
   if(r.status!==200)throw Error("未取得完整公开清单");const m=validateManifest(JSON.parse((await readLimited(r,512*1024)).toString("utf8")));this.latestManifest=m;this.manifestReadAt=this.now();return m;
  })().finally(()=>{this.manifestPending=null;});this.manifestPending=work;return work;
 }
 async refreshData(url){
  const name=url.pathname.slice(1);if(this.pending.has(name))return this.pending.get(name);
  const work=(async()=>{
   this.checked.set(name,this.now());
   let expected;try{const m=await this.remoteManifest();expected=m.files.find(f=>f.kind==="data"&&f.path===name);}catch{/* A not-yet-deployed manifest must not freeze the existing online data path. */}
   const response=await this.online(new Request(url.href,{credentials:"omit",cache:"no-cache",redirect:"error",signal:AbortSignal.timeout(20000)}));
   if(!response.ok||response.status!==200)throw Error("公开快照网络读取失败");const bytes=await readLimited(response,expected?Math.min(MAX_DATA,Math.max(expected.bytes,expected.decodedBytes||0)):MAX_DATA);
   if((expected&&!matches(bytes,expected))||!validData(bytes,name))throw Error("公开快照不完整");
   const source=expected?.sourceTime||sourceTime(bytes,name),known=await this.cached(name),seed=this.seeds.get(name);
   const previous=Math.max(Date.parse(known?.record.sourceTime)||0,Date.parse(seed?.sourceTime)||0);
   if(previous&&(!source||Date.parse(source)<previous))throw Error("保留更新的完整公开快照");
   if(!expected){this.directData.add(name);return bytes;} // Original frontend validates live data; unverified bodies never replace disk snapshots.
   const sha256=digest(bytes),directory=path.join(this.directory,"public-data"),key=digest(Buffer.from(name));
   const record={path:name,bytes:bytes.length,sha256,sourceTime:source,receivedAt:this.now()};
   // Content-addressed bodies plus one atomic pointer; cache time never becomes source time.
   try{await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,sha256+".bin"),bytes);
    const temp=path.join(directory,key+".next");await fs.writeFile(temp,JSON.stringify(record));await fs.rename(temp,path.join(directory,key+".json"));this.cacheIndex.set(name,record);this.directData.delete(name);void this.pruneData();
   }catch{this.directData.add(name);/* Without writable disk, subsequent reads must use the live result rather than pinned seeds. */}
   return bytes;
  })().finally(()=>this.pending.delete(name));this.pending.set(name,work);return work;
 }
 async pruneData(){
  if(this.pruning)return this.pruning;
  if(this.now()-(this.lastPrune||0)<60000)return;this.lastPrune=this.now();
  const run=(async()=>{const dir=path.join(this.directory,"public-data"),files=await fs.readdir(dir),records=[];
   for(const name of files.filter(n=>/^[a-f0-9]{64}[.]json$/.test(n))){try{const record=JSON.parse(await fs.readFile(path.join(dir,name),"utf8"));if(dataFile(record.path)&&/^[a-f0-9]{64}$/.test(record.sha256))records.push({name,...record});}catch{}}
   records.sort((a,b)=>b.receivedAt-a.receivedAt);let total=0;const keep=new Set();
   for(const r of records){if(total+r.bytes<=384*1024*1024){total+=r.bytes;keep.add(r.sha256);}else await fs.unlink(path.join(dir,r.name)).catch(()=>{});}
   for(const name of files.filter(n=>/^[a-f0-9]{64}[.]bin$/.test(n))){if(!keep.has(name.slice(0,-4))){const info=await fs.stat(path.join(dir,name));if(this.now()-info.mtimeMs>60000)await fs.unlink(path.join(dir,name)).catch(()=>{});}}
  })().catch(()=>{}).finally(()=>{this.pruning=null;});this.pruning=run;return run;
 }
 async handle(request){
  let url;try{url=new URL(request.url);}catch{return new Response("请求地址无效",{status:400});}
  if(url.origin!==this.origin)return this.tiles.handle(request);
  if(request.method!=="GET")return this.online(request);
  let name;try{name=decodeURIComponent(url.pathname.slice(1))||"index.html";}catch{return new Response("请求地址无效",{status:400});}
  if(name==="apps")name="apps.html";
  const code=this.code.get(name);if(code)return this.file(this.active.directory,code,"local-code");
  if(dataFile(name)){
   let cached=await this.cached(name);const seed=this.seeds.get(name);if(seed?.sourceTime&&(Date.parse(seed.sourceTime)||0)>(Date.parse(cached?.record.sourceTime)||0))cached=null;
   const force=url.searchParams.has("refresh")||url.searchParams.has("force");
   if((cached||seed)&&!force&&!this.directData.has(name)){
    if(this.checked.has(name)&&this.now()-this.checked.get(name)>=300000){try{return this.dataResponse(await this.refreshData(url),"online-public-snapshot");}catch{}}
    else if(!this.checked.has(name))void this.refreshData(url).catch(()=>{});
    if(cached)return this.dataResponse(cached.bytes,"saved-public-snapshot");
    return this.file(this.bundle,seed,"bundled-public-snapshot");
   }
   try{return this.dataResponse(await this.refreshData(url),"online-public-snapshot");}
   catch(e){if(cached)return this.dataResponse(cached.bytes,"saved-public-snapshot");if(seed)return this.file(this.bundle,seed,"bundled-public-snapshot");throw e;}
  }
  // APIs, account data, uploads, AI keys and external basemap requests retain their original handling.
  return this.online(request);
 }
 async pruneVersions(){
  try{const parent=path.resolve(this.directory,"versions"),items=[];
   for(const name of await fs.readdir(parent)){if(/^[a-f0-9]{64}$/.test(name)){const target=path.resolve(parent,name);if(path.dirname(target)!==parent)throw Error("非法缓存路径");const stat=await fs.stat(target);if(stat.isDirectory())items.push({name,target,at:stat.mtimeMs});}}
   items.sort((a,b)=>b.at-a.at);const keep=new Set([this.active.manifest.revision,this.readyRevision,...items.slice(0,3).map(x=>x.name)]);
   for(const item of items)if(!keep.has(item.name))await fs.rm(item.target,{recursive:true,force:true});
  }catch{}
 }
 async checkForUpdate(){
  if(this.updating)return this.updating;
  const work=(async()=>{
   this.lastUpdateAttempt=this.now();this.updateState="checking";
   try{
    const response=await this.online(new Request(this.origin+"/desktop-assets.json",{credentials:"omit",cache:"no-cache",redirect:"error",signal:AbortSignal.timeout(12000)}));
    if(!response.ok)throw Error("本次未取得程序更新清单");const bytes=await readLimited(response,512*1024),m=validateManifest(JSON.parse(bytes.toString("utf8")));
    if(m.version.split(".").map(Number).reduce((n,v)=>n*10000+v,0)<this.active.manifest.version.split(".").map(Number).reduce((n,v)=>n*10000+v,0))throw Error("拒绝降级程序");
    if(m.revision===this.readyRevision){this.readyRevision=m.revision;this.updateState="ready-on-restart";return {changed:true,revision:m.revision};}
    if(m.revision===this.active.manifest.revision){this.updateState="current";return {changed:false};}
    const staging=path.join(this.directory,"versions",m.revision);await fs.mkdir(staging,{recursive:true});
    const files=m.files.filter(f=>f.kind==="code");let cursor=0;
    const worker=async()=>{while(cursor<files.length){const f=files[cursor++],target=path.join(staging,f.path);let content;
     const previous=this.code.get(f.path);if(previous?.sha256===f.sha256)content=await fs.readFile(path.join(this.active.directory,f.path));
     else{const r=await this.online(new Request(this.origin+"/"+f.path,{credentials:"omit",cache:"no-cache",redirect:"error",signal:AbortSignal.timeout(30000)}));if(r.status!==200)throw Error("本地程序更新下载失败");content=await readLimited(r,Math.max(f.bytes,1));}
     if(content.length!==f.bytes||digest(content)!==f.sha256)throw Error("程序更新校验失败");await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);
    }};
    const results=await Promise.allSettled([worker(),worker(),worker()]);if(results.some(r=>r.status==="rejected"))throw Error("程序更新未完整完成");await this.checkCode(staging,m);
    await fs.writeFile(path.join(staging,"desktop-assets.json"),JSON.stringify(m));
    const next=path.join(this.directory,"active.next");await fs.writeFile(next,JSON.stringify({revision:m.revision}));await fs.rename(next,path.join(this.directory,"active.json"));
    this.readyRevision=m.revision;this.updateState="ready-on-restart";await this.pruneVersions();return {changed:true,revision:m.revision};
   }catch{this.updateState="kept-current";return {changed:false,failed:true};}
  })().finally(()=>{this.updating=null;});this.updating=work;return work;
 }
}
module.exports={LocalClient,validateManifest,publicFile,dataFile,codeId,digest,readLimited,sourceTime};
