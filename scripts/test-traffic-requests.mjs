import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const source=await readFile(new URL("../site/traffic-regions.js",import.meta.url),"utf8");
const payload=JSON.stringify({osm3s:{timestamp_osm_base:"2026-11-01T00:00:00Z"},elements:[{type:"count",tags:{total:"0"}}]});
const flush=()=>new Promise(setImmediate);
function harness(){
  let now=0,serial=0;const timers=new Map();
  const later=(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id;};
  const cancel=id=>timers.delete(id);
  const c=vm.createContext({AbortController,TextDecoder,Uint8Array,setTimeout:later,clearTimeout:cancel,
    Date:class extends Date{static now(){return now;}}});
  vm.runInContext(source,c);
  const advance=async ms=>{const end=now+ms;await flush();
    while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}
    now=end;await flush();};
  return {request:c.HuayuTrafficRegions.request,load:c.HuayuTrafficRegions.load,later,cancel,advance,timers,now:()=>now};
}
function delayed(h,signal,ms,value){return new Promise((resolve,reject)=>{
  const abort=()=>{h.cancel(timer);signal.removeEventListener("abort",abort);reject(new DOMException("signal is aborted without reason","AbortError"));};
  const timer=h.later(()=>{signal.removeEventListener("abort",abort);resolve(value);},ms);
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
});}
function stream(h,signal,{pieces=6,interval=20000,endless=false}={}){
  const bytes=new TextEncoder().encode(payload),width=Math.ceil(bytes.length/pieces);let i=0,cancelled=0;
  return {ok:true,headers:new Headers(),body:{getReader:()=>({
    read:()=>delayed(h,signal,interval,endless?{done:false,value:bytes}:i<pieces?{done:false,value:bytes.slice(i*width,++i*width)}:{done:true}),
    cancel:async()=>{cancelled++;}
  })},cancelled:()=>cancelled};
}
{
  const h=harness(),signals=[],progress=[];let body;
  const work=h.request("whole-city",async(_u,o)=>{signals.push(o.signal);return body=stream(h,o.signal);},{onProgress:p=>progress.push(p.bytes)});
  let done=false;work.then(()=>{done=true;});
  await h.advance(100000);assert.equal(done,false);assert.equal(signals.length,1);assert.equal(signals[0].aborted,false,"ongoing download survives the old 95 second deadline");
  await h.advance(40000);const result=await work;
  assert.equal(result.sourceTime,Date.parse("2026-11-01T00:00:00Z"));assert.equal(result.elements.length,0);
  assert.equal(result.readAt,140000);assert.ok(progress.length>=5);assert.ok(body.cancelled());assert.equal(h.timers.size,0);
}
{
  const h=harness(),starts=[],signals=[],retries=[];
  const work=h.request("unchanged-query",async(_u,o)=>{starts.push(h.now());signals.push(o.signal);
    return delayed(h,o.signal,starts.length===1?80000:40000,starts.length===1?new Response("busy",{status:503}):new Response(payload));
  },{label:"路网与干道",onRetry:r=>retries.push(r)});
  await h.advance(125000);await work;
  assert.deepEqual(starts,[0,83000]);assert.equal(new Set(signals).size,2);assert.equal(retries.length,1);assert.equal(h.timers.size,0);
}
{
  const h=harness(),signals=[],retries=[];
  const work=h.request("stalled",async(_u,o)=>{signals.push(o.signal);return delayed(h,o.signal,999999,null);},{label:"人口与边界",onRetry:r=>retries.push(r)});
  const rejected=assert.rejects(work,/人口与边界：响应超时.*已自动重试 2 次/u);
  await h.advance(300000);await rejected;assert.equal(signals.length,3);assert.equal(retries.length,2);assert.equal(h.timers.size,0);
}
{
  const h=harness();let attempts=0;
  const work=h.request("endless",async(_u,o)=>{attempts++;return stream(h,o.signal,{endless:true});},{label:"路网与干道"});
  const rejected=assert.rejects(work,/路网与干道：响应超时/u);
  await h.advance(920000);await rejected;assert.equal(attempts,3,"continuous bytes cannot bypass the five-minute per-attempt cap");assert.equal(h.timers.size,0);
}
{
  const h=harness(),bodies=[];
  const work=h.request("same-query",async(_u,o)=>{bodies.push(o.body);if(bodies.length===1)throw new TypeError("Failed to fetch");return new Response(payload);});
  await h.advance(4000);await work;assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(h.timers.size,0);
}
for(const response of [()=>new Response("bad request",{status:400}),()=>new Response('{"elements":[{"type":"count","tags":{"total":"1"}}]}'),
  ()=>new Response("no",{headers:{"content-length":String(33*1024*1024)}}),()=>new Response("null")]){
  const h=harness();let attempts=0;
  await assert.rejects(()=>h.request("invalid",async()=>{attempts++;return response();}));
  assert.equal(attempts,1,"permanent, incomplete and over-budget results must not be retried or accepted");assert.equal(h.timers.size,0);
}
{
  const h=harness(),caller=new AbortController();let attempts=0;
  const work=h.request("cancel",async()=>{attempts++;return new Response("busy",{status:503});},{signal:caller.signal});
  const rejected=assert.rejects(work,/请求已取消/u);await flush();caller.abort();await rejected;await h.advance(100000);
  assert.equal(attempts,1);assert.equal(h.timers.size,0,"cancellation removes retry and deadline timers");
}
{
  const h=harness(),calls=[0,0,0,0],progress=[];
  const selected=[{osm_type:"relation",osm_id:1,geojson:{type:"Polygon",coordinates:[[[0,0],[.1,0],[.1,.1],[0,.1],[0,0]]]}}];
  const data=[[{type:"relation",id:1,tags:{boundary:"administrative",admin_level:"5",population:"1000"},
    members:[{type:"way",role:"outer",geometry:selected[0].geojson.coordinates[0].map(p=>({lon:p[0],lat:p[1]}))}]}],
    [{type:"way",id:2,nodes:[1,2],tags:{highway:"residential"},geometry:[{lon:.01,lat:.01},{lon:.09,lat:.09}]}],[],[]];
  const work=h.load(selected,p=>progress.push(p),async(_u,o)=>{
    const q=new URLSearchParams(o.body).get("data"),i=q.includes('node(r.r:')?0:q.includes('way(area.a)[highway~')?1:q.includes('[building][building!=no]')?3:2;
    calls[i]++;if(i===1&&calls[i]===1)throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({osm3s:{timestamp_osm_base:new Date(1000+i*1000).toISOString()},elements:[...data[i],{type:"count",tags:{total:String(data[i].length)}}]}));
  });
  await h.advance(4000);const result=await work;
  assert.deepEqual(calls,[1,2,1,1],"a road retry must retain completed population, facilities and buildings inputs");
  assert.equal(result.population.total,1000);assert.equal(result.roads.length,1);
  assert.deepEqual(Array.from(result.sourceTimes),[1000,2000,3000,4000]);assert.ok(progress.some(p=>/路网与干道.*自动重试 1／2/u.test(p)));
  assert.equal(h.timers.size,0);
}
console.log("Traffic requests passed: slow complete streams, independent retry deadlines, idle/total caps, network recovery, permanent rejection, source times and cancellation cleanup.");
