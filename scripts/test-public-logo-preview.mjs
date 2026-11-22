import assert from "node:assert/strict";
import {createPublicLogoPreview,publicLogoUrl} from "./lib/public-logo-preview.mjs";
const base="http://127.0.0.1:4322",path="/api/brand-logo-places?bounds=152.892,14.653,152.899,14.658";
for(const path of ["/api/account","/api/brand-management/applications","/api/datasets","/api/brand-logos/abc","/api/brand-logos?url=https://evil.test"]){
 const request=new Request(base+path);if(path.includes("?url"))assert.throws(()=>publicLogoUrl(request));else assert.equal(publicLogoUrl(request),null);
}
assert.equal(publicLogoUrl(new Request(base+"/api/brand-logos",{method:"POST",body:"{}",headers:{"Content-Type":"application/json"}})),null);
assert.throws(()=>publicLogoUrl(new Request(base+path,{headers:{Origin:"https://evil.test"}})));
for(const q of ["bounds=1,2,3,4","bounds=NaN,2,3,4","bounds=1,2,1.1,2.1&bounds=1,2,1.1,2.1","bounds=1,2,1.1,2.1&refresh=2"])assert.throws(()=>publicLogoUrl(new Request(base+"/api/brand-logo-places?"+q)));
assert.equal(publicLogoUrl(new Request(base+"/api/brand-logos/abc/image?v=hash")),"https://ogf-atlas.pages.dev/api/brand-logos/abc/image?v=hash");
let calls=0,release,upstream;const body=Buffer.from(JSON.stringify({items:[],fetchedAt:123,dbTimestamp:"2026-11-21T15:29:34Z",stale:false}));
const proxy=createPublicLogoPreview({read:async(url,signal)=>{calls++;upstream=signal;assert.ok(url.startsWith("https://ogf-atlas.pages.dev/api/brand-logo"));await new Promise(resolve=>release=resolve);return {status:200,body,contentType:"application/json"};}});
const a=new AbortController(),b=new AbortController(),one=proxy(new Request(base+path,{signal:a.signal})),two=proxy(new Request(base+path,{signal:b.signal}));
await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
a.abort();assert.equal((await one).status,499);assert.equal(upstream.aborted,false);
release();const r=await two;assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),body,"original source bytes and timestamps are unchanged");
assert.equal(r.headers.has("Set-Cookie"),false);
assert.equal(await proxy(new Request(base+"/api/auth/login",{method:"POST",body:"{}"})),null,"account and writes remain local");
const bad=createPublicLogoPreview({read:async()=>{throw Error("offline");}});assert.equal((await bad(new Request(base+path))).status,503);
const last=new AbortController();let cancelledSignal;const lonely=createPublicLogoPreview({read:async(_u,signal)=>{cancelledSignal=signal;return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));}});
const pending=lonely(new Request(base+path,{signal:last.signal}));await new Promise(resolve=>setImmediate(resolve));last.abort();assert.equal((await pending).status,499);assert.equal(cancelledSignal.aborted,true);
console.log("Local public logo preview passed: pinned anonymous GET routes, unchanged complete bytes/source times, shared cancellation, no forwarded account credentials or writes, and honest failure.");

let clock=Date.now(),catalogVersion="one",windowCalls=0;
const realBody=Buffer.from(JSON.stringify({items:[],fetchedAt:clock,dbTimestamp:"2026-11-21T15:29:34Z",stale:false}));
const reusable=createPublicLogoPreview({now:()=>clock,read:async url=>{
 windowCalls++;
 return {status:200,body:url.endsWith("/api/brand-logos")?Buffer.from(JSON.stringify({items:[{key:"brand:anim",imageUrl:catalogVersion,aliases:[],categories:[]}]})):realBody,contentType:"application/json"};
}});
await reusable(new Request(base+"/api/brand-logos"));await reusable(new Request(base+path));const count=windowCalls;
const smaller=base+"/api/brand-logo-places?bounds=152.8945,14.6545,152.897,14.657";
assert.deepEqual(Buffer.from(await (await reusable(new Request(smaller))).arrayBuffer()),realBody);
assert.equal(windowCalls,count,"complete parent window is reused without changing source bytes");
await reusable(new Request(smaller+"&refresh=1"));assert.equal(windowCalls,count+1,"explicit refresh still reads upstream");
await reusable(new Request(base+"/api/brand-logo-places?bounds=153,15,153.01,15.01"));assert.equal(windowCalls,count+2,"uncovered areas cannot borrow a smaller snapshot");
catalogVersion="two";await reusable(new Request(base+"/api/brand-logos"));await reusable(new Request(smaller));assert.equal(windowCalls,count+4,"changed logo identity invalidates all old windows");
clock+=120001;await reusable(new Request(smaller));assert.equal(windowCalls,count+5,"expiry uses original source read time");
console.log("Public logo window reuse passed: complete containment, unchanged bytes and source age, force refresh, directory invalidation and expiry.");

let version=1,olderRelease,newerRelease,versionReads=0;
const generationBody=n=>Buffer.from(JSON.stringify({items:[],generation:n,fetchedAt:Date.now(),dbTimestamp:"2026-11-21T15:29:34Z",stale:false}));
const generations=createPublicLogoPreview({read:async url=>{
 versionReads++;
 if(url.endsWith("/api/brand-logos"))return {status:200,body:Buffer.from(JSON.stringify({items:[{key:"brand:anim",imageUrl:"version-"+version,aliases:[],categories:[]}]})),contentType:"application/json"};
 return new Promise(resolve=>{const finish=n=>resolve({status:200,body:generationBody(n),contentType:"application/json"});if(!olderRelease)olderRelease=()=>finish(1);else newerRelease=()=>finish(2);});
}});
await generations(new Request(base+"/api/brand-logos"));const oldWindow=generations(new Request(base+path));await new Promise(resolve=>setImmediate(resolve));
version=2;await generations(new Request(base+"/api/brand-logos"));const newWindow=generations(new Request(base+path));await new Promise(resolve=>setImmediate(resolve));
assert.equal(versionReads,4,"a new registry does not join an obsolete in-flight query");
newerRelease();await newWindow;olderRelease();await oldWindow;
assert.equal((await (await generations(new Request(smaller))).json()).generation,2,"late old data cannot enter the new registry's complete window cache");
