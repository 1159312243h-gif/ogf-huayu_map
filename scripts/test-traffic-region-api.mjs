import assert from "node:assert/strict";
import {gunzipSync} from "node:zlib";
import "../site/traffic-regions.js";
import {fetchTrafficRegion,trafficRegionQueries} from "../site/_worker.js";
const R=globalThis.HuayuTrafficRegions;
for(const ids of [[307796],[1,2,3,4]])for(const b of [[152,14,153,15],[-5,-8,1,2]])assert.deepEqual(trafficRegionQueries(ids,b),R.queries(ids,b));
const elements=[{type:"way",id:2,nodes:[1,2],geometry:[{lat:14,lon:152},{lat:14.1,lon:152.1}],tags:{highway:"residential",bridge:"yes",lanes:"6"}}];
const payload={osm3s:{timestamp_osm_base:"2026-11-16T00:00:00Z"},elements:[...elements,{type:"count",tags:{total:String(elements.length)}}]};
let calls=0,body=JSON.stringify(payload),aborted=false,waits=[];
const cache=new Map();globalThis.caches={default:{match:async key=>cache.get(key.url)?.clone(),put:async(key,value)=>{cache.set(key.url,value.clone());}}};
const context={waitUntil:p=>waits.push(p)};
const upstream=globalThis.fetch;
const endpoint="https://example.test/api/traffic-region?ids=307796&bounds=152,14,153,15&part=1";
globalThis.fetch=async(_url,options)=>{calls++;assert.equal(options.method,"POST");
  options.signal.addEventListener("abort",()=>{aborted=true;});return new Response(body);};
async function unpack(response){return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"));}
async function settle(){await Promise.all(waits.splice(0));}
try{
  for(const invalid of ["?ids=1&bounds=0,0,50,50&part=0","?ids=1,1&bounds=0,0,1,1&part=0","?ids=1&bounds=0,0,1,1&part=4","?ids=all&bounds=0,0,1,1&part=0"]){
    assert.equal((await fetchTrafficRegion(new Request("https://example.test/api/traffic-region"+invalid),context)).status,400);
  }
  assert.equal(calls,0);
  const cold=await fetchTrafficRegion(new Request(endpoint),context);assert.equal(cold.headers.get("content-encoding"),"gzip");
  assert.equal(cold.headers.get("cache-control"),"no-store","the browser must not cache an unvalidated live stream");
  const readAt=cold.headers.get("x-huayu-read-at");assert.deepEqual(await unpack(cold),payload);await settle();
  assert.equal(cache.size,1);assert.equal(calls,1);
  const hit=await fetchTrafficRegion(new Request(endpoint),context);assert.equal(hit.headers.get("x-huayu-traffic-cache"),"HIT");
  assert.match(hit.headers.get("cache-control"),/max-age=\d+/u);
  assert.equal(hit.headers.get("x-huayu-read-at"),readAt);assert.deepEqual(await unpack(hit),payload);assert.equal(calls,1);
  const reload=await fetchTrafficRegion(new Request(endpoint+"&reload=1"),context);await unpack(reload);await settle();assert.equal(calls,2,"explicit reload bypasses complete cache");
  const [key,cached]=[...cache][0];cache.set(key,new Response(await cached.text(),{headers:{"x-huayu-read-at":String(Date.now()-120001)}}));
  await unpack(await fetchTrafficRegion(new Request(endpoint),context));await settle();assert.equal(calls,3,"expired data must not be silently renewed");
  for(const bad of [{...payload,remark:"runtime error: Query timed out"},{...payload,elements:[...elements,{type:"count",tags:{total:"999"}}]}]){
    cache.clear();body=JSON.stringify(bad);await unpack(await fetchTrafficRegion(new Request(endpoint),context));await settle();assert.equal(cache.size,0,"partial responses must never enter shared cache");
  }
  body=JSON.stringify(payload);let release;
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(body.slice(0,20)));release=()=>{c.enqueue(new TextEncoder().encode(body.slice(20)));c.close();};}}));
  const streaming=await fetchTrafficRegion(new Request(endpoint),context);
  assert.ok(release,"response headers must not wait for the whole upstream body");release();assert.deepEqual(await unpack(streaming),payload);await settle();
  cache.clear();globalThis.caches.default.match=()=>new Promise(()=>{});
  globalThis.fetch=async()=>new Response(body);const start=performance.now();
  const noDisk=await fetchTrafficRegion(new Request(endpoint),context);assert.ok(performance.now()-start<1500,"a stalled edge cache must not block the network");await unpack(noDisk);await settle();
  globalThis.caches.default.match=async()=>null;
  globalThis.fetch=async(_u,o)=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65536));},cancel(){aborted=true;}}));
  aborted=false;const cancel=await fetchTrafficRegion(new Request(endpoint),context);await cancel.body.cancel();
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(aborted,true,"cancelling the compressed response must cancel its upstream stream");
}finally{globalThis.fetch=upstream;}
console.log("Traffic region API passed: identical full queries, gzip without data loss, progressive streaming, bounded cache, source ages, explicit reload, failed-count rejection and cancellation.");
