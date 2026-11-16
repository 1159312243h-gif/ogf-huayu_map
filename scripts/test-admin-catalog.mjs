import assert from "node:assert/strict";
import {readFile,mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import "../site/admin-catalog.js";
import {replaceAdministrativeCatalog} from "./update-admin-catalog.mjs";
const C=globalThis.HuayuAdministrativeCatalog;
const current=C.validate(JSON.parse(await readFile(new URL("../site/huaxia-admin-catalog.json",import.meta.url),"utf8")));
const payload={osm3s:{timestamp_osm_base:current.sourceTime},elements:[{type:"count",tags:{areas:"1",total:"1"}},...current.elements,
  {type:"count",tags:{relations:String(current.total),total:String(current.total)}}]};
assert.equal(C.build(payload,null,current.readAt).total,current.total);
assert.match(C.query(),/rel\(28652\).*area\(3600028652\)/u);
assert.equal((C.query().match(/out count/gu)||[]).length,2);
for(const invalid of [null,{...payload,remark:"timed out"},{...payload,elements:payload.elements.slice(1)},
  {...payload,elements:[{type:"count",tags:{areas:"0",total:"0"}},...payload.elements.slice(1)]},
  {...payload,elements:[...payload.elements,{type:"count",tags:{total:"0"}}]}])assert.throws(()=>C.build(invalid));
assert.throws(()=>C.validate({...current,elements:current.elements.map((e,i)=>i===1?current.elements[0]:e)}));
assert.throws(()=>C.validate({...current,elements:current.elements.map(e=>e.id===28652?{...e,id:1}:e)}));
assert.throws(()=>C.validate({...current,elements:current.elements.map((e,i)=>i===1?{...e,center:{lat:999,lon:0}}:e)}));
const small={...current,total:2,elements:[current.elements.find(e=>e.id===28652),current.elements.find(e=>e.id!==28652)]};
assert.throws(()=>C.build({...payload,elements:[payload.elements[0],...small.elements,{type:"count",tags:{relations:"2",total:"2"}}]},current),/异常缩减/u);
const storage=new Map(),disk={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
let calls=0;
const first=new C.Loader({storage:disk,fetcher:async url=>{calls++;assert.equal(url,"./huaxia-admin-catalog.json");return new Response(JSON.stringify(current));},now:()=>Date.parse(current.readAt)+1000});
assert.equal((await first.load()).total,current.total);assert.equal(calls,1);
assert.ok(storage.has(C.KEY));
let release;
const second=new C.Loader({storage:disk,fetcher:()=>new Promise(resolve=>{release=resolve;}),now:()=>Date.parse(current.readAt)+2000});
const restored=await second.load();assert.equal(restored.readAt,current.readAt,"cache reads must not renew source age");
release(new Response(JSON.stringify(current)));await second.pending;
let releaseSnapshot,liveCalls=0;
const manual=new C.Loader({storage:null,fetcher:async url=>{
  if(url.startsWith("./"))return new Promise(resolve=>{releaseSnapshot=resolve;});
  liveCalls++;return new Response(JSON.stringify(payload));
},now:()=>Date.parse(current.readAt)+1000});
const initial=manual.load(),force=manual.refresh(true);
releaseSnapshot(new Response(JSON.stringify(current)));await initial;await force;
assert.equal(liveCalls,1,"a manual refresh during snapshot loading must still reach the live source once");
const noStorage=new C.Loader({storage:{getItem(){throw Error("denied");},setItem(){throw Error("denied");}},
  fetcher:async url=>new Response(JSON.stringify(url.startsWith("./")?current:payload)),now:()=>Date.parse(current.readAt)+1000});
assert.equal((await noStorage.load()).total,current.total,"storage denial must not block the complete snapshot");
const slow=new C.Loader({storage:null,fetcher:async url=>{
  if(url.startsWith("./"))return new Response(JSON.stringify(current));
  throw Error("upstream unavailable");
},now:()=>Date.parse(current.readAt)+C.TTL+1});
// A stale complete snapshot is still usable while the live refresh is pending.
assert.equal((await slow.load()).total,current.total);
if(slow.pending)await assert.rejects(slow.pending,/unavailable/u);
assert.equal(slow.current.total,current.total);assert.equal(slow.current.readAt,current.readAt);
await assert.rejects(slow.refresh(true));assert.equal(slow.current.total,current.total);
const newer={...current,readAt:new Date(Date.parse(current.readAt)+1000).toISOString()};
second.accept(newer);second.accept(current);assert.equal(second.current.readAt,newer.readAt,"a late older snapshot must not replace a newer result");
const dir=await mkdtemp(path.join(tmpdir(),"huayu-admin-test-"));
try{const file=path.join(dir,"catalog.json");await writeFile(file,"original");
  await assert.rejects(replaceAdministrativeCatalog(file,{...current,total:0}));assert.equal(await readFile(file,"utf8"),"original");
  await replaceAdministrativeCatalog(file,current);assert.equal(JSON.parse(await readFile(file,"utf8")).total,current.total);
}finally{await rm(dir,{recursive:true,force:true});}
console.log(`Administrative catalog passed: ${current.total} complete relations, country/area/count checks, snapshot/cache reuse, original timestamps, failure retention and atomic replacement.`);
