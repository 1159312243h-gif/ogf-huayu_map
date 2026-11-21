import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require=createRequire(import.meta.url);
const {terrainRuntime}=require("./data-update/builders/build-terrain-preload.cjs");
const {buildTerrainContext,appendTerrainInventory}=require("./data-update/builders/build-terrain-context.cjs");
const site=fileURLToPath(new URL("../site/",import.meta.url));
const runtime=await terrainRuntime(site);
const testRoot=fileURLToPath(new URL("../.data-update/",import.meta.url));
await fs.mkdir(testRoot,{recursive:true});
const directory=await fs.mkdtemp(path.join(testRoot,"terrain-context-test-"));
const ring=[[0,0],[1,0],[1,1],[0,1],[0,0]];
const mountain={id:"mountain",properties:{osmType:"way",sourceOsmId:"8"},
  geometry:{type:"Polygon",coordinates:[ring,[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6],[0.4,0.4]]]}};
const coords=points=>points.map(([lon,lat])=>({lon,lat}));
const elements=[
  {type:"way",id:1,tags:{waterway:"river"},geometry:coords([[-1,0.5],[2,0.5]])},
  {type:"way",id:2,tags:{building:"yes"},geometry:coords([[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3],[0.2,0.2]])},
  {type:"way",id:3,tags:{leisure:"garden"},geometry:coords([[0.45,0.45],[0.55,0.45],[0.55,0.55],[0.45,0.55],[0.45,0.45]])},
  {type:"way",id:4,tags:{building:"yes"},geometry:coords([[2,2],[3,2],[3,3],[2,3],[2,2]])},
  {type:"way",id:5,tags:{waterway:"canal"},geometry:coords([[0.1,0.1],[0.4,0.1]])},
  {type:"way",id:8,tags:{leisure:"garden",name:"测试山"},geometry:coords(ring)},
  {type:"relation",id:10,tags:{natural:"water",type:"multipolygon"},members:[
    {type:"way",ref:100,role:"outer",geometry:coords([[0.7,0.7],[0.8,0.7],[0.8,0.8]])},
    {type:"way",ref:101,role:"outer",geometry:coords([[0.8,0.8],[0.7,0.8],[0.7,0.7]])}]},
];
const inventory=elements.map(element=>{
  const points=element.geometry||element.members.flatMap(member=>member.geometry);
  return {type:element.type,id:element.id,tags:element.tags,bounds:{
    minlon:Math.min(...points.map(p=>p.lon)),maxlon:Math.max(...points.map(p=>p.lon)),
    minlat:Math.min(...points.map(p=>p.lat)),maxlat:Math.max(...points.map(p=>p.lat))}};
});
let downloads=0;
const fetch=async (_url,options)=>{
  downloads++;
  const query=options.body.get("data");
  if(query.includes("out tags bb;"))return new Response(JSON.stringify({elements:inventory}));
  const ids=query.match(/\(id:([^)]*)\)/u)[1].split(",").map(Number);
  return new Response(JSON.stringify({elements:elements.filter(element=>ids.includes(element.id))}));
};
const options={surfaces:[mountain],slices:[{id:"test",bounds:{west:0,east:1,south:0,north:1}}],runtime,cacheDirectory:directory,fetch};
const context=await buildTerrainContext(options);
assert.deepEqual(context.map(feature=>feature.id).sort(),[
  "terrain-context:relation:10","terrain-context:way:1","terrain-context:way:2","terrain-context:way:3","terrain-context:way:5"]);
assert.equal(context.find(feature=>feature.properties.osmId==="1").geometry.coordinates.length,2,
  "a river crossing a mountain must retain its full geometry even with endpoints outside it");
assert.equal(context.find(feature=>feature.properties.osmId==="10").geometry.type,"Polygon",
  "split outer relation members must join into the actual lake outline");
assert.equal(context.find(feature=>feature.properties.osmId==="3").properties.materialOcclusion,"garden",
  "gardens inside forest holes must remain visible above the continuous hill");
assert.equal(context.find(feature=>feature.properties.osmId==="5").properties.terrainValley,0,
  "a small landscaped canal must not carve an exaggerated mountain valley");
const before=downloads;
assert.deepEqual(await buildTerrainContext({...options,resume:true}),context);
assert.equal(downloads,before,"resuming a preparation must reuse complete context responses");
await assert.rejects(buildTerrainContext({...options,cacheDirectory:path.join(directory,"failure"),
  fetch:async()=>new Response(JSON.stringify({elements:[],remark:"Query timed out"}))}),/Query timed out/u);
const retryWaits=[];
let retryRequests=0;
assert.deepEqual(await buildTerrainContext({...options,cacheDirectory:path.join(directory,"rate-limit-recovery"),
  wait:async milliseconds=>retryWaits.push(milliseconds),fetch:async(...args)=>{
    if (++retryRequests===1) return new Response("Rate limited",{status:429,headers:{"Retry-After":"90"}});
    return fetch(...args);
  }}),context,"a transient rate limit must retain the complete river, building and garden context");
assert.deepEqual(retryWaits,[90000],"honour the server's Retry-After before repeating a request");
let rejectedRequests=0;
const exhaustedWaits=[];
const exhaustedCache=path.join(directory,"rate-limit-exhausted");
await assert.rejects(buildTerrainContext({...options,cacheDirectory:exhaustedCache,
  wait:async milliseconds=>exhaustedWaits.push(milliseconds),fetch:async()=>{
    rejectedRequests++; return new Response("Rate limited",{status:429});
  }}),/HTTP 429/u);
assert.equal(rejectedRequests,3,"persistent limits stop after three attempts");
assert.deepEqual(exhaustedWaits,[30000,60000],"retry with bounded increasing delays");
assert.deepEqual(await fs.readdir(exhaustedCache),[],"a failed response cannot become a successful cached packet");
for (const [status,headers] of [[429,{"Retry-After":"600"}],[403,{}]]) {
  let requests=0;
  await assert.rejects(buildTerrainContext({...options,cacheDirectory:path.join(directory,`no-retry-${status}`),
    wait:async()=>assert.fail("never retry before the server's deadline or retry access denial"),
    fetch:async()=>{requests++;return new Response("Unavailable",{status,headers});}}),new RegExp(`HTTP ${status}`,"u"));
  assert.equal(requests,1,"access denial and waits beyond the retry budget fail without another request");
}
console.log("Terrain context passed: complete geometries, resume, bounded 429 backoff, Retry-After and failed-response preservation.");

for(const phase of ['connect','body']){
 let calls=0,bodyFailures=0;const waits=[];
 assert.deepEqual(await buildTerrainContext({...options,cacheDirectory:path.join(directory,'timeout-'+phase),
  wait:async ms=>waits.push(ms),fetch:async(...args)=>{
   calls++;if(phase==='connect' && calls===1)throw new DOMException('temporary timeout','TimeoutError');
   if(phase==='body' && !args[1].body.get('data').includes('out tags bb;') && bodyFailures++===0)
    return {ok:true,status:200,json:async()=>{throw new DOMException('temporary body timeout','TimeoutError');}};
   return fetch(...args);
  }}),context,'a transient '+phase+' timeout must recover the same complete context');
 assert.deepEqual(waits,phase==='connect'?[]:[10000]);
}
let timeouts=0;const timeoutCache=path.join(directory,'timeouts-exhausted'),timeoutWaits=[];
await assert.rejects(buildTerrainContext({...options,cacheDirectory:timeoutCache,wait:async ms=>timeoutWaits.push(ms),
 fetch:async()=>{timeouts++;throw new DOMException('persistent timeout','TimeoutError');}}),{name:'TimeoutError'});
assert.equal(timeouts,9);assert.deepEqual(timeoutWaits,[]);assert.deepEqual(await fs.readdir(timeoutCache),[]);
console.log('Terrain context transport passed: connect/body timeout recovery, fresh bounded attempts and no failed cache writes.');

const relaySetting=process.env.OGF_UPDATER_RELAY;delete process.env.OGF_UPDATER_RELAY;
const nativeFetch=globalThis.fetch;let defaultCalls=0;const defaultWaits=[];
try{
 globalThis.fetch=async(...args)=>++defaultCalls===1?new Response('busy',{status:429,headers:{'Retry-After':'90'}}):fetch(...args);
 assert.deepEqual(await buildTerrainContext({...options,fetch:undefined,cacheDirectory:path.join(directory,'default-transport-rate-limit'),wait:async ms=>defaultWaits.push(ms)}),context);
 assert.deepEqual(defaultWaits,[90000],'the shared transport must preserve the context builder HTTP retry window');
}finally{globalThis.fetch=nativeFetch;if(relaySetting!==undefined)process.env.OGF_UPDATER_RELAY=relaySetting;}

let splitRequests=0;
assert.deepEqual(await buildTerrainContext({...options,cacheDirectory:path.join(directory,'inventory-split'),wait:async()=>{},fetch:async(...args)=>{
 const q=args[1].body.get('data');if(q.includes('out tags bb;')){splitRequests++;if(q.includes('(0,0,1,1)'))throw new DOMException('large inventory timeout','TimeoutError');}
 return fetch(...args);
}}),context,'four complete child inventories must preserve the same full river, lake, building and garden geometries');
assert.equal(splitRequests,5);let depthRequests=0;
await assert.rejects(buildTerrainContext({...options,cacheDirectory:path.join(directory,'inventory-split-limit'),wait:async()=>{},fetch:async()=>{depthRequests++;throw new DOMException('persistent timeout','TimeoutError');}}),{name:'TimeoutError'});
assert.equal(depthRequests,9,'spatial fallback has a fixed depth and keeps a persistent outage fatal');
console.log('Terrain context split passed: complete quadrants, identity union, original geometries and finite failure depth.');

const largeInventory=Array.from({length:150000},(_,id)=>({type:'way',id}));
const completeInventory=new Map();appendTerrainInventory(completeInventory,largeInventory);
const replacement={type:'way',id:3,updated:true};appendTerrainInventory(completeInventory,[replacement,{type:'relation',id:3}]);
assert.equal(completeInventory.size,150001);assert.equal(completeInventory.get('way:3'),replacement);
assert.equal([...completeInventory.keys()][3],'way:3');assert.equal(completeInventory.get('way:149999'),largeInventory.at(-1));
assert.equal(largeInventory[3].updated,undefined,'inventory merge never mutates an earlier source response');
console.log('Large terrain inventory passed: 150000 items retain exact identity, order and typed deduplication without argument expansion.');

let incompleteReads=0;const incompleteWaits=[],incompleteQueries=[];
assert.deepEqual(await buildTerrainContext({...options,cacheDirectory:path.join(directory,'incomplete-json'),wait:async ms=>incompleteWaits.push(ms),fetch:async(...args)=>{
  incompleteQueries.push(args[1].body.get('data'));
  if(++incompleteReads===1)return new Response('{"elements":[');
  return fetch(...args);
}}),context);
assert.equal(incompleteQueries[0],incompleteQueries[1]);assert.deepEqual(incompleteWaits,[10000]);
let persistentBroken=0;const badJsonCache=path.join(directory,'persistent-incomplete-json');
await assert.rejects(buildTerrainContext({...options,cacheDirectory:badJsonCache,wait:async()=>{},fetch:async()=>{persistentBroken++;return new Response('{');}}),SyntaxError);
assert.equal(persistentBroken,27);assert.deepEqual(await fs.readdir(badJsonCache),[]);
console.log('Terrain context body recovery passed: same-query retry, original complete geometry, fresh responses and no incomplete cache publication.');

let truncatedParent=0,childInventories=0;
assert.deepEqual(await buildTerrainContext({...options,cacheDirectory:path.join(directory,'truncated-inventory-split'),wait:async()=>{},fetch:async(...args)=>{
  const q=args[1].body.get('data');if(q.includes('out tags bb;')){if(q.includes('(0,0,1,1)')){truncatedParent++;return new Response('{');}childInventories++;}
  return fetch(...args);
}}),context);assert.equal(truncatedParent,3);assert.equal(childInventories,4,'all four complete children are required after bounded same-query recovery');
let brokenGeometry=0,splitGeometry=0;
const splitGeometryOptions={...options,cacheDirectory:path.join(directory,'truncated-geometry-split'),wait:async()=>{},fetch:async(...args)=>{
 const q=args[1].body.get('data');if(q.includes('way(id:')){const ids=q.match(/\(id:([^)]*)\)/u)[1].split(',');if(ids.length>1){brokenGeometry++;return new Response('{');}splitGeometry++;}
 return fetch(...args);
}};
assert.deepEqual(await buildTerrainContext(splitGeometryOptions),context,'all identities retain original full geometries across response-size subdivisions');
assert.ok(brokenGeometry>=3);assert.equal(splitGeometry,4);let resumedCalls=0;
assert.deepEqual(await buildTerrainContext({...splitGeometryOptions,resume:true,fetch:async()=>{resumedCalls++;throw Error('completed split should be cached');}}),context);assert.equal(resumedCalls,0);
console.log('Terrain response subdivision passed: every child inventory, full identity batches, unchanged geometry, bounded persistent failure and complete-only resume.');
