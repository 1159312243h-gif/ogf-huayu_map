"use strict";
// Anonymous, fixed OGF basemap resources only; never cache /api, search, accounts or uploaded files.
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto");
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const HOSTS=new Set(["ogf-tileserver-t5qifc5o4q-uc.a.run.app","openmaptiles.opengeofiction.net","tiles04.opengeofiction.net","tiles05.opengeofiction.net"]);
function eligible(request){try{const u=new URL(request.url);return request.method==="GET"&&u.protocol==="https:"&&HOSTS.has(u.hostname)&&!u.username&&!u.password&&!u.search&&/\.(?:pbf|png|webp|json)$/.test(u.pathname)&&!request.headers.has("range");}catch{return false;}}
class TileCache{
 constructor({directory,fetch,now=Date.now}){this.directory=directory;this.fetch=fetch;this.now=now;this.pending=new Set();this.writes=new Set();}
 async read(url){try{const key=hash(url),record=JSON.parse(await fs.readFile(path.join(this.directory,key+".json"),"utf8"));
  if(record.url!==url||!Number.isSafeInteger(record.bytes)||record.bytes>8*1024*1024||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isFinite(record.savedAt)||!Number.isFinite(record.ttl))return null;
  const bytes=await fs.readFile(path.join(this.directory,record.sha256+".bin"));if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)return null;return {record,bytes};
 }catch{return null;}}
 response(saved,source){return new Response(saved.bytes,{headers:{...saved.record.headers,"Cache-Control":"no-store","X-Huayu-Desktop-Source":source,"Age":String(Math.max(0,Math.floor((this.now()-saved.record.savedAt)/1000)))}});}
 async save(url,response){
  const control=response.headers.get("cache-control")||"";if(/no-store|private/i.test(control)||response.headers.has("set-cookie"))return;
  const advertised=Number(response.headers.get("content-length"));if(Number.isFinite(advertised)&&advertised>8*1024*1024)return;
  const reader=response.body?.getReader();if(!reader)return;const chunks=[];let size=0;
  try{while(true){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>8*1024*1024)throw Error("skip oversized cache");chunks.push(Buffer.from(v.value));}}
  catch{await reader.cancel().catch(()=>{});return;}if(!size)return;
  const bytes=Buffer.concat(chunks,size),sha256=hash(bytes),headers={};
  if(/text\/html/i.test(response.headers.get("content-type")||""))return;
  if(new URL(url).pathname.endsWith(".json")){try{const v=JSON.parse(bytes.toString("utf8"));if(v.error||v.remark)return;}catch{return;}}
  for(const name of ["content-type","access-control-allow-origin","access-control-expose-headers","last-modified","etag"]){const v=response.headers.get(name);if(v)headers[name]=v;}
  const maxAge=/max-age\s*=\s*(\d+)/i.exec(control),age=Math.max(0,Number(response.headers.get("age"))||0);
  const ttl=/no-cache/i.test(control)?0:Math.max(0,Math.min(300,maxAge?Number(maxAge[1]):0)-age)*1000;
  const record={url,bytes:size,sha256,headers,savedAt:this.now(),ttl};const key=hash(url);
  await fs.mkdir(this.directory,{recursive:true});await fs.writeFile(path.join(this.directory,sha256+".bin"),bytes);
  const temp=path.join(this.directory,key+".next");await fs.writeFile(temp,JSON.stringify(record));await fs.rename(temp,path.join(this.directory,key+".json"));
  await this.prune();
 }
 async prune(){
  if(this.pruning)return this.pruning;
  this.pendingPruneBytes=(this.pendingPruneBytes||0)+8*1024*1024;
  if(this.now()-(this.lastPrune||0)<60000&&this.pendingPruneBytes<32*1024*1024)return;
  this.lastPrune=this.now();this.pendingPruneBytes=0;
  this.pruning=(async()=>{const files=await fs.readdir(this.directory),records=[];
   for(const name of files.filter(n=>/^[a-f0-9]{64}[.]json$/.test(n))){try{const r=JSON.parse(await fs.readFile(path.join(this.directory,name),"utf8"));if(/^[a-f0-9]{64}$/.test(r.sha256))records.push({name,...r});}catch{}}
   records.sort((a,b)=>b.savedAt-a.savedAt);let total=0,count=0;const keep=new Set();
   for(const r of records){if(total+r.bytes<=192*1024*1024&&count++<4096){total+=r.bytes;keep.add(r.sha256);}else await fs.unlink(path.join(this.directory,r.name)).catch(()=>{});}
   for(const name of files.filter(n=>/^[a-f0-9]{64}[.]bin$/.test(n))){if(!keep.has(name.slice(0,-4))){const info=await fs.stat(path.join(this.directory,name));if(this.now()-info.mtimeMs>60000)await fs.unlink(path.join(this.directory,name)).catch(()=>{});}}
  })().catch(()=>{}).finally(()=>{this.pruning=null;});return this.pruning;
 }
 async handle(request){
  if(!eligible(request))return this.fetch(request);
  if(request.signal.aborted)throw Error("request cancelled");const saved=await this.read(request.url);
  if(saved&&this.now()-saved.record.savedAt<saved.record.ttl)return this.response(saved,"saved-basemap");
  try{
   const response=await this.fetch(new Request(request,{credentials:"omit",signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])}));
   if(response.status>=500)throw Error("temporary basemap failure");
   if(response.status===200&&!this.pending.has(request.url)){
    this.pending.add(request.url);const task=this.save(request.url,response.clone()).catch(()=>{}).finally(()=>{this.pending.delete(request.url);this.writes.delete(task);});this.writes.add(task);
   }return response;
  }catch(error){if(request.signal.aborted||!saved)throw error;return this.response(saved,"saved-basemap-offline");}
 }
}
module.exports={TileCache,eligible};
