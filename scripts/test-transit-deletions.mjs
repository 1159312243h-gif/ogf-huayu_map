import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {spawnSync} from "node:child_process";
import sourcePolicy from "./data-update/builders/verify-transit-current-sources.cjs";
const {verifySources,reconcile,validate,sourceRef,assertReconciled}=sourcePolicy;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"huayu-transit-deletions-"));
const refs=[{type:"node",id:1,role:"station"},{type:"node",id:2,role:"station"},
  {type:"way",id:3,role:"station"},{type:"relation",id:4,role:"route"},{type:"relation",id:5,role:"route"}];
const elements=[{type:"node",id:1,tags:{railway:"station"}},{type:"way",id:3,tags:{landuse:"residential"}},
  {type:"relation",id:4,tags:{type:"route",route:"subway"}}];
const payload={osm3s:{timestamp_osm_base:"2026-11-24T00:00:00Z"},elements:[...elements,
  {type:"count",tags:{nodes:"1",ways:"1",relations:"1",total:"3"}}]};
let calls=0;
const result=await verifySources(refs,{cachePrefix:path.join(directory,"good"),fetchImpl:async url=>{
  calls++;return String(url).includes("overpass")?{ok:true,json:async()=>payload}
    :String(url).includes("/way/3")?{status:200,json:async()=>({elements:[elements[1]]})}:{status:410};
}});
assert.equal(calls,4);
assert.deepEqual(result.verification.removed.map(e=>[e.type,e.id,e.reason,e.status]),
  [["node",2,"deleted",410],["relation",5,"deleted",410],["way",3,"no-longer-transit",200]]);
assert.throws(()=>validate({...payload,remark:"timed out"},refs),/Incomplete/);
assert.throws(()=>validate({...payload,elements:elements},refs),/count/);
assert.throws(()=>validate({...payload,elements:[...payload.elements,elements[0]]},refs),/count/);
for(const status of [404,429,500])await assert.rejects(verifySources(refs,{cachePrefix:path.join(directory,"fail"+status),
  fetchImpl:async url=>String(url).includes("overpass")?{ok:true,json:async()=>payload}:{status}}),/Official transit verification/);
await assert.rejects(verifySources(refs,{cachePrefix:path.join(directory,"partial"),fetchImpl:async url=>String(url).includes("overpass")
  ?{ok:true,json:async()=>payload}:{status:200,json:async()=>({elements:[]})}}),/Incomplete official/);
const stop=id=>[id,14,152,14,152,"Station "+id,1,0,[0,1],0,id,[0,1]];
const snapshots=["city","province","country"].map(id=>({id,network:{format:2,routeTable:[[4,"subway"],[5,"train"]],
  lines:[[11,[[14,152],[15,153]],[0,1]],[12,[[14,152],[15,153]],[1]]],displayTracks:[],stops:[stop(1),stop(2)],displayStops:[stop(1),stop(2)]}}));
const relations={snapshots:snapshots.map(({id})=>({id,elements:[...elements,{type:"relation",id:5},
  {type:"relation",id:6,members:[{type:"node",ref:1},{type:"node",ref:2}]}]}))};
const preload={snapshots};reconcile(preload,relations,result);
assertReconciled(preload,relations);
assert.deepEqual(sourceRef({type:"node",id:-1000,tags:{"ogf_atlas:source":"way:3"}}),{type:"way",id:3});
const areaPreload={snapshots:[{id:"area",network:{routeTable:[[4,"subway"]],lines:[],stops:[[-1000,14,152,14,152,"area",1,0,[0],0,-1000]]}}]};
const areaRelations={snapshots:[{id:"area",elements:[{type:"node",id:-1000,tags:{"ogf_atlas:source":"way:3"}}]}]};
reconcile(areaPreload,areaRelations,result);
assert.equal(areaPreload.snapshots[0].network.stops.length,0,"synthetic station must follow original way deletion/class change");
assert.equal(areaRelations.snapshots[0].elements.length,0);
for(const s of snapshots){assert.deepEqual(s.network.stops.map(s=>s[0]),[1]);assert.deepEqual(s.network.displayStops.map(s=>s[0]),[1]);
 assert.deepEqual(s.network.lines.map(l=>[l[0],l[2]]),[[11,[0]]]);assert.deepEqual(s.network.stops[0][8],[0]);assert.deepEqual(s.network.stops[0][11],[0]);}
for(const s of relations.snapshots){assert.ok(!s.elements.some(e=>e.id===5));assert.equal(s.elements.find(e=>e.id===6).members.length,1);}
const app=fs.readFileSync(new URL("../site/app.js",import.meta.url),"utf8");
const clock=Date.parse("2026-11-24T01:00:00Z"),period=3*3600000;
const context=vm.createContext({Date:class extends Date{static now(){return clock;}},Set,Map,Array,
  transitPreloadSnapshots:snapshots,applyStationInterchangeOverrides:n=>n,mergeTransitStops:s=>s,
  uniqueTransitRoutes:r=>[...new Map(r.map(r=>[r.id,r])).values()]});
for(const name of ["huayuSourceRefreshAt","filterVerifiedTransitSources","transitNetworkBeforeSourceUpdate","mergeTransitDisplaySources","mergeTransitNetworks"])
 vm.runInContext(app.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}',"u"))[0],context);
const response=headers=>({headers:new Headers(headers)});
assert.equal(context.huayuSourceRefreshAt(response({"X-OGF-Transit-Cache":"STALE","X-OGF-Transit-Refresh-After":"30"}),"Transit",period),clock+30000);
assert.equal(context.huayuSourceRefreshAt(response({"X-OGF-Transit-Fetched-At":new Date(clock-period+45000).toISOString()}),"Transit",period),clock+45000);
assert.equal(context.huayuSourceRefreshAt(response({"X-OGF-Basemap-Refresh-After":"20"}),"Basemap",period),clock+20000);
assert.equal(context.filterVerifiedTransitSources([{type:"node",id:2},{type:"relation",id:5},{type:"node",id:1}]).length,1,"old live tiles cannot revive confirmed deleted IDs");
const r1={id:4},r2={id:44};
const base={lines:[{id:"oldjoined",routes:[r1]},{id:"outside",routes:[r2]}],stops:[{id:1,routes:[r1,r2]}],routeCount:2};
const updated={lines:[{id:"newjoined",routes:[r1]}],stops:[{id:1,routes:[r1],name:"updated"}],source:"live"};
const merged=context.mergeTransitNetworks(base,updated,[{type:"relation",id:4},{type:"node",id:1}]);
assert.deepEqual(Array.from(merged.lines,l=>l.id),["outside","newjoined"]);
assert.equal(merged.stops.length,1);assert.equal(merged.stops[0].name,"updated");
assert.deepEqual(Array.from(merged.stops[0].routes,r=>r.id).sort(),[4,44],"keep memberships outside the returned source query");
const partial=context.mergeTransitNetworks(base,updated);
assert.ok(partial.lines.some(l=>l.id==="oldjoined"),"partial responses preserve previous full geometry");
assert.equal(base.lines.length,2,"refresh does not mutate the previous complete network");
console.log("Transit deletion regressions passed: all regions, official 410/200 proofs, no deletion on partial/error, returned-source replacement, stale 30s retry, original source age and tombstones.");

// Exercise the actual staged builder, including compact IDs, synthetic sources and railway supplements.
const run=path.join(directory,"entry"),root=path.join(run,"outputs/ogf-atlas");
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(run,"work"),{recursive:true});
const packet={generatedAt:"2026-11-23T00:00:00Z",snapshots:["city","province","country"].map(id=>({id,network:{format:2,
 routeTable:[[4,"subway"],[5,"train"]],lines:[[11,[[14,152],[15,153]],[0,1]]],stops:[stop(1),stop(2)],displayStops:[stop(1),stop(2)]}}))};
fs.writeFileSync(path.join(root,"transit-preload.json"),JSON.stringify(packet));
fs.writeFileSync(path.join(root,"transit-relations.json"),JSON.stringify({snapshots:packet.snapshots.map(({id})=>({id,elements:[...elements]}))}));
fs.writeFileSync(path.join(root,"railway-routing.json"),JSON.stringify({coverage:{},stations:[[1,14,152,"keep"],[2,14,152,"remove"]]}));
const entryPayload={...payload,elements:[elements[0],elements[2],{type:"count",tags:{nodes:"1",ways:"0",relations:"1",total:"2"}}]};
fs.writeFileSync(path.join(run,"mock.cjs"),
 "global.fetch=async url=>String(url).includes('overpass')?{ok:true,json:async()=>("+JSON.stringify(entryPayload)+")}:{status:410};");
const entry=spawnSync(process.execPath,["--require",path.join(run,"mock.cjs"),new URL("./data-update/builders/verify-transit-current-sources.cjs",import.meta.url).pathname.replace(/^\/([A-Z]:)/u,"$1")],{cwd:run,encoding:"utf8",windowsHide:true,env:{...process.env,OGF_UPDATER_RELAY:"0"}});
assert.equal(entry.status,0,entry.stderr||entry.stdout);
const written=JSON.parse(fs.readFileSync(path.join(root,"transit-preload.json")));
assert.equal(written.generatedAt,packet.generatedAt,"source-generation timestamp is not rewritten by verification");
assert.ok(written.snapshots.every(s=>s.network.stops.length===1&&s.network.routeTable.length===1));
assert.equal(JSON.parse(fs.readFileSync(path.join(root,"railway-routing.json"))).stations.length,1);
console.log("Actual staged deletion builder passed, including matching routing station supplement and unchanged generation time.");

const tileRealm=vm.createContext({Date:class extends Date{static now(){return clock;}},AbortSignal,Set,Map,
 TRANSIT_LIVE_COVERAGE_REFRESH_MS:period,transitSnapshotTiles:()=>[{z:10,x:1,y:1}],
 mergeTransitSnapshotElements:packets=>packets.flatMap(p=>p.payload.elements),
 fetch:async()=>new Response(JSON.stringify({verifiedComplete:true,elements:[]}),{headers:{"X-OGF-Transit-Cache":"STALE","X-OGF-Transit-Refresh-After":"30"}})});
for(const name of ["huayuSourceRefreshAt","fetchTransitSnapshotTiles"])vm.runInContext(app.match(new RegExp('  (?:async )?function '+name+'\\([^]*?\\n  \\}',"u"))[0],tileRealm);
const emptyTile=await tileRealm.fetchTransitSnapshotTiles("rail",{},1000);
assert.equal(emptyTile.complete,true,"a genuinely complete empty packet is still a successful refresh");
assert.equal(emptyTile.refreshAt,clock+30000,"actual tile loader must carry the edge deadline to coverage expiry");
assert.equal(emptyTile.authoritative,true);
tileRealm.fetch=async()=>new Response(JSON.stringify({elements:[],remark:"timeout"}));
assert.equal((await tileRealm.fetchTransitSnapshotTiles("rail",{},1000)).complete,false,"partial/error responses cannot certify coverage");
console.log("Actual traffic tile loader passed: complete empty packets, stale retry deadline and partial/error rejection.");

const modeOnly=["subway","light_rail","monorail"].map((type,i)=>({type:"node",id:100+i,tags:{[type]:"yes"}}));
const modePayload={osm3s:payload.osm3s,elements:[...modeOnly,{type:"count",tags:{nodes:"3",ways:"0",relations:"0",total:"3"}}]};
const modes=await verifySources(modeOnly.map(({type,id})=>({type,id,role:"station"})),{cachePrefix:path.join(directory,"modes"),fetchImpl:async url=>{
 assert.ok(String(url).includes("overpass"),"existing urban mode tags must not trigger removal confirmation");return {ok:true,json:async()=>modePayload};
}});
assert.equal(modes.verification.removed.length,0);
assert.equal(modes.current.size,3);
console.log("Station source classification passed: subway, light-rail and monorail mode-only tags remain valid under the existing collector rules.");

// Regression for the real Kadah failure: positive area way IDs in the national
// railway table must not become node API lookups.
const areaRun=path.join(directory,"routing-area"),areaRoot=path.join(areaRun,"outputs/ogf-atlas");
fs.mkdirSync(areaRoot,{recursive:true});fs.mkdirSync(path.join(areaRun,"work"),{recursive:true});
const areaStation={type:"way",id:39110112,tags:{railway:"station",name:"Arsbe"},center:{lat:57.5,lon:148.3}};
const areaRoute={type:"relation",id:4,tags:{type:"route",route:"train"}};
const areaPacket={generatedAt:packet.generatedAt,snapshots:[{id:"kadah",network:{format:2,routeTable:[[4,"train"]],
 lines:[[11,[[57,148],[58,149]],[0]]],stops:[],displayStops:[]}}]};
fs.writeFileSync(path.join(areaRoot,"transit-preload.json"),JSON.stringify(areaPacket));
fs.writeFileSync(path.join(areaRoot,"transit-relations.json"),JSON.stringify({snapshots:[{id:"kadah",elements:[areaStation,areaRoute]}]}));
fs.writeFileSync(path.join(areaRoot,"railway-routing.json"),JSON.stringify({coverage:{},stations:[[39110112,57.5,148.3,"Arsbe"]]}));
const areaBody={osm3s:payload.osm3s,elements:[areaStation,areaRoute,{type:"count",tags:{nodes:"0",ways:"1",relations:"1",total:"2"}}]};
fs.writeFileSync(path.join(areaRun,"mock.cjs"),"global.fetch=async(url,options)=>{if(!String(options.body).includes('39110112'))throw Error('station ID missing');if(String(options.body).includes('node%28id'))throw Error('area queried as node');return {ok:true,json:async()=>("+JSON.stringify(areaBody)+")};};");
const areaEntry=spawnSync(process.execPath,["--require",path.join(areaRun,"mock.cjs"),new URL("./data-update/builders/verify-transit-current-sources.cjs",import.meta.url).pathname.replace(/^\/([A-Z]:)/u,"$1")],{cwd:areaRun,encoding:"utf8",windowsHide:true,env:{...process.env,OGF_UPDATER_RELAY:"0"}});
assert.equal(areaEntry.status,0,areaEntry.stderr||areaEntry.stdout);
assert.equal(JSON.parse(fs.readFileSync(path.join(areaRoot,"railway-routing.json"))).stations.length,1);
console.log("National area station passed: actual current-source builder queries the original way, never a same-number node.");

// An already completed relation-loader promise must not pin the old generation.
let releaseOld,relationChecks=0,coverageChecks=0;
const currentRelation={type:"relation",id:44};
const relationRealm=vm.createContext({Date,Promise,Map,Set,Array,transitPreloadGeneratedAt:1,
 transitPreloadSnapshots:[{id:"test",elements:[],network:{lines:[{}]}}],transitRelationsPreloaded:false,
 transitRelationsPreloadPromise:null,transitServicePreloadPromise:Promise.resolve(),TRANSIT_PRELOAD_URL:"preload",TRANSIT_RELATIONS_URL:"relations",
 railwayRoutingData:null,activeTransitPreloadSnapshotId:"test",transitNetworkRequestId:1,transitBusRequestId:1,
 transitNetworkLoading:true,transitBusLoading:true,mapViewMode:"transit",transitAtlasCity:null,transitAtlasSourceLoad:null,
 vectorPerspectiveActive:false,selectedTransitId:null,transitNetworkData:null,map:{getCenter:()=>({})},
 setTransitRefreshState:()=>{},applyTransitPreloadForPoint:()=>true,
 hydrateTransitPreloadSnapshots:()=>[{id:"test",elements:[],network:{lines:[{}]}}],
 scheduleTransitCoverageRefresh:()=>coverageChecks++,scheduleTransitRelationsRefresh:()=>relationChecks++,
 filterVerifiedTransitSources:x=>x,enrichTransitRelationTypes:()=>{},enrichTransitNetworkRouteMetadata:()=>{},
 reconcileConfirmedPublicTransitRailStations:()=>{},invalidateTransitRoutingCaches:()=>{},
 fetchJson:async (url,timeout,options)=>{
   if(url==="preload")return {generatedAt:"2026-11-24T00:00:00Z"};
   assert.equal(options.cache,"no-cache");return new Promise(resolve=>{releaseOld=resolve;});
 }});
for(const name of ["preloadTransitNetwork","preloadTransitRelations","ensureTransitRelationsLoaded"])
 vm.runInContext(app.match(new RegExp('  async function '+name+'\\([^]*?\\n  \\}',"u"))[0],relationRealm);
const oldRelations=relationRealm.ensureTransitRelationsLoaded();
await relationRealm.preloadTransitNetwork({revalidate:true});
assert.equal(relationRealm.transitRelationsPreloadPromise,null);
assert.equal(relationChecks,1);assert.equal(coverageChecks,1);
relationRealm.fetchJson=async (url,timeout,options)=>{assert.equal(options.cache,"no-cache");return {snapshots:[{id:"test",elements:[currentRelation]}]};};
assert.equal(await relationRealm.ensureTransitRelationsLoaded(),true);
const currentPromise=relationRealm.transitRelationsPreloadPromise;
releaseOld({snapshots:[{id:"test",elements:[{type:"relation",id:4}]}]});
assert.equal(await oldRelations,false);
assert.equal(relationRealm.transitPreloadSnapshots[0].elements[0].id,44);
assert.equal(relationRealm.transitRelationsPreloadPromise,currentPromise,"late old request cannot clear the new relation loader");
console.log("Generation relation refresh passed: real preload invalidation, actual no-cache relation read and late-response/promise guards.");
