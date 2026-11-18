import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import "../site/brand-logo-core.js";
const source=await readFile(new URL("../site/brand-logo-server.js",import.meta.url),"utf8");
const builtins=JSON.parse(await readFile(new URL("../site/brand-logos.json",import.meta.url),"utf8")).items;
const core=globalThis.HuayuBrandLogoCore,checks=[];
const sample={type:"node",id:397898300,lat:14.6556237,lon:152.8957163,tags:{brand:"aniM",name:"aniM",branch:"津川站前店",shop:"anime"}};
function payload(elements=[sample],total=elements.length){return new Response(JSON.stringify({elements:[...elements,{type:"count",tags:{total:String(total)}}],osm3s:{timestamp_osm_base:"2026-11-18T02:03:33Z"}}));}
function setup(entries=builtins){
 let time=Date.now(),transport=async()=>payload(),calls=[];
 class Clock extends Date{static now(){return time;}}
 const factory=vm.runInNewContext(source+"\ncreateBrandLogoServer",{URL,Map,Set,Blob,Response,AbortSignal,AbortController,Date:Clock,
   setTimeout:(f,ms)=>setTimeout(f,Math.min(ms,5)),clearTimeout,fetch:async(u,o)=>{calls.push({url:u,...o});return transport(u,o);}});
 const service=factory({core,builtins:entries,json:(v,status=200)=>new Response(JSON.stringify(v),{status}),sameOrigin:()=>true});
 const url="https://logos.test/api/brand-logo-places?bounds=152.892,14.653,152.899,14.658";
 return {calls,setTransport:fn=>transport=fn,advance:ms=>time+=ms,async get(signal,force=false){const r=await service.handle(new Request(url+(force?"&refresh=1":""),{signal}),{});return {status:r.status,body:await r.json()};}};
}
{
 const s=setup();s.setTransport(async()=>{if(s.calls.length===1)throw TypeError("connect timed out");return payload();});
 const r=await s.get();assert.equal(r.status,200);assert.equal(r.body.items[0].id,sample.id);assert.equal(s.calls.length,2);
 assert.equal(s.calls[0].method,"POST");assert.equal(s.calls[1].method,"GET");assert.ok(s.calls[1].url.includes("maxsize"));
 assert.equal(r.body.dbTimestamp,"2026-11-18T02:03:33Z");assert.equal((await s.get()).body.fetchedAt,r.body.fetchedAt);assert.equal(s.calls.length,2);
 checks.push("transient-connect-retry-and-complete-cache-with-original-source-time");
 s.advance(120001);s.setTransport(async()=>{throw TypeError("offline");});
 const stale=await s.get();assert.equal(stale.status,200);assert.equal(stale.body.stale,true);assert.equal(stale.body.fetchedAt,r.body.fetchedAt);assert.equal(s.calls.length,5);
 await s.get();assert.equal(s.calls.length,5,"failure cooldown prevents event-driven retry storms");
 s.advance(30001);s.setTransport(async()=>payload([]));const empty=await s.get();assert.equal(empty.status,200);assert.equal(empty.body.stale,false);assert.equal(empty.body.items.length,0);
 checks.push("bounded-offline-retry-stale-source-age-and-recovery-to-real-empty");
}
{
 const s=setup();s.setTransport(async()=>new Response("busy",{status:429}));
 assert.equal((await s.get()).status,503);assert.equal(s.calls.length,3);assert.equal((await s.get()).status,503);assert.equal(s.calls.length,3);
 s.advance(30001);s.setTransport(async()=>payload());assert.equal((await s.get()).status,200);
 checks.push("rate-limit-bounded-retries-and-first-load-recovery");
}
{
 const s=setup();const first=await s.get();assert.equal(first.status,200);s.advance(1000);s.setTransport(async()=>payload([]));
 const forced=await s.get(undefined,true);assert.equal(forced.status,200);assert.equal(forced.body.items.length,0);assert.equal(s.calls.length,2);assert.ok(forced.body.fetchedAt>first.body.fetchedAt);
 checks.push("explicit-refresh-bypasses-fresh-cache-and-replaces-deleted-places");
}
for(const mode of ["forbidden","count","duplicates","large"]){
 const s=setup();s.setTransport(async()=>mode==="forbidden"?new Response("denied",{status:403}):mode==="count"?payload([sample],4):mode==="duplicates"?payload([sample,sample]):new Response(new Uint8Array(8*1024*1024+1)));
 const r=await s.get();if(mode==="forbidden")assert.equal(r.body.retryable,false);assert.equal(r.status,mode==="large"?413:502);assert.equal(s.calls.length,1,"permanent errors and incomplete source data are not retried into success");
 s.setTransport(async()=>payload());assert.equal((await s.get()).status,200,"invalid results never enter the complete cache");
}
checks.push("permanent-errors-count-duplicates-and-byte-limits-stay-fatal");
{
 const s=setup();let release,upstreamSignal;const ready=new Promise(resolve=>release=resolve);
 s.setTransport(async(_,o)=>{upstreamSignal=o.signal;await ready;return payload();});
 const one=new AbortController(),two=new AbortController();const a=s.get(one.signal),b=s.get(two.signal);
 await new Promise(r=>setTimeout(r,10));assert.equal(s.calls.length,1);one.abort();const cancelled=await a;assert.equal(cancelled.status,499);assert.equal(upstreamSignal.aborted,false);
 release();assert.equal((await b).status,200);assert.equal((await s.get()).status,200);assert.equal(s.calls.length,1);
 checks.push("shared-request-cancellation-isolated-between-users");
}
{
 const s=setup();let upstreamSignal;
 s.setTransport(async(_,o)=>{upstreamSignal=o.signal;await new Promise((_,reject)=>o.signal.addEventListener("abort",()=>reject(o.signal.reason),{once:true}));});
 const abort=new AbortController(),r=s.get(abort.signal);await new Promise(r=>setTimeout(r,10));abort.abort();assert.equal((await r).status,499);assert.equal(upstreamSignal.aborted,true);
 await new Promise(r=>setTimeout(r,10));s.setTransport(async()=>payload());assert.equal((await s.get()).status,200);assert.equal(s.calls.length,2);
 checks.push("last-user-cancels-upstream-and-late-query-cannot-fill-cache");
}
{
 const long=builtins.concat(Array.from({length:100},(_,i)=>({...builtins[0],name:"Brand"+i+"x".repeat(140),key:"brand:long"+i})));
 const s=setup(long);s.setTransport(async()=>{if(s.calls.length===1)throw TypeError("offline");return payload();});assert.equal((await s.get()).status,200);
 assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>c.method==="POST"),"large registries never exceed safe GET URL length");checks.push("large-registry-keeps-bounded-post-transport");
}
console.log(JSON.stringify({status:"passed",checks}));
