import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/transport-timetable-core.js";
import "../site/shared-dataset-core.js";
import "../site/transport-timetable-navigation.js";
import worker from "../site/_worker.js";
import {createLocalPersonalDatabase} from "./lib/local-personal-db.mjs";
const C=globalThis.HuayuTimetableCore,T=globalThis.HuayuDatasetTools;
const rows=[
 {trip_id:"R1",stop_sequence:1,stop_id:"node/101",station:"甲站",departure:"23:50",service_date:"2026-11-22"},
 {trip_id:"R1",stop_sequence:2,stop_id:"node/102",station:"乙站",arrival:"00:10",departure:"00:12",service_date:"2026-11-22"},
 {trip_id:"R1",stop_sequence:3,stop_id:"node/103",station:"丙站",arrival:"00:30",service_date:"2026-11-22"}
];
const data=T.normalize(JSON.stringify(rows),"json",{kind:"rail_timetable"}),trip=data.timetable.trips[0];
assert.equal(trip.stops[1].arrivalSeconds,86400+600-28800);
const occurrence=C.nextService(trip,0,2,Date.parse("2026-11-22T15:40:00Z"));
assert.equal(occurrence.departure,Date.parse("2026-11-22T15:50:00Z"));assert.equal(occurrence.arrival,Date.parse("2026-11-22T16:30:00Z"));
assert.equal(occurrence.waitSeconds,600);assert.equal(occurrence.rideSeconds,2400);assert.equal(occurrence.estimated,false);
assert.equal(C.nextService(trip,0,2,Date.parse("2026-11-22T16:00:00Z")),null,"missed dated service cannot become tomorrow's invented trip");
assert.equal(C.nextService({...trip,days:"1"},0,2,Date.parse("2026-11-22T15:00:00Z")),null,"wrong weekday excluded");
const flight=T.normalize(JSON.stringify([
 {trip_id:"HX8",station:"东机场",stop_code:"AAA",departure:"22:00",utc_offset:"+08:00"},
 {trip_id:"HX8",station:"西机场",stop_code:"BBB",arrival:"20:00",utc_offset:"+02:00"}]),"json",{kind:"flight_timetable"}).timetable.trips[0];
assert.equal(C.nextService(flight,0,1,Date.parse("2026-11-22T13:00Z")).rideSeconds,14400,"flight offsets retain four real hours");
for(const changes of [{departure:"99:00"},{utc_offset:"+25:00"},{service_date:"2026-02-30"},{vehicle_speed_kmh:-1},{service_days:"0"},{stop_id:"node/0"}])
 assert.throws(()=>T.normalize(JSON.stringify(rows.map(r=>({...r,...changes}))),"json",{kind:"rail_timetable"}));
assert.throws(()=>T.normalize(JSON.stringify([rows[0],{...rows[1],stop_sequence:1}]),"json",{kind:"urban_timetable"}),/站序/);
const line=[{geometry:[{lat:0,lon:0},{lat:0,lon:.009}],maxspeed:"120"}];
const normal=C.estimate(line),slow=C.estimate([{...line[0],maxspeed:"30"}]),weak=C.estimate(line,{...C.defaults.rail,acceleration:.1,deceleration:.1});
assert.ok(slow.seconds>normal.seconds);assert.ok(weak.seconds>normal.seconds);assert.ok(normal.seconds>normal.meters/(120/3.6));
const tiny=C.estimate([{geometry:[{lat:0,lon:0},{lat:0,lon:.00001}],maxspeed:120}]);assert.ok(tiny.seconds>0&&tiny.seconds<20);
const bend=C.estimate([{geometry:[{lat:0,lon:0},{lat:0,lon:.0005},{lat:.0005,lon:.0005}],maxspeed:120}]);
const noBend=C.estimate([{geometry:[{lat:0,lon:0},{lat:0,lon:.001}],maxspeed:120}]);assert.ok(bend.curvedVertices>0);assert.ok(bend.seconds>=noBend.seconds);
assert.throws(()=>C.estimate([line[0],{geometry:[{lat:1,lon:1},{lat:1,lon:2}]}]),/不连续/);
const sparse=T.normalize(JSON.stringify([{station:"甲站",departure:"10:00"},{station:"乙站"},{station:"丙站"}]),"json",{kind:"urban_timetable"}).timetable.trips[0];
const resolved=C.resolveTimes(sparse,[line,line]);assert.ok(resolved.stops[2].arrivalSeconds>resolved.stops[1].arrivalSeconds);assert.equal(resolved.estimates.length,2);
assert.equal(sparse.stops[1].arrivalSeconds,undefined,"estimation never mutates uploaded records");assert.throws(()=>C.resolveTimes(sparse),/路径/);
const DB=await createLocalPersonalDatabase(),env={DB,ADMIN_USERNAMES:"tt_admin"};
async function call(path,method="GET",body,cookie=""){
 const response=await worker.fetch(new Request("https://tt.test"+path,{method,headers:{Origin:"https://tt.test","Content-Type":"application/json",Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{});
 return {status:response.status,body:await response.json(),cookie:response.headers.get("Set-Cookie")?.split(";")[0]||cookie};
}
let record;
try{
 const owner=await call("/api/auth/register","POST",{username:"tt_owner",password:"test-timetable-password"}),other=await call("/api/auth/register","POST",{username:"tt_other",password:"test-timetable-password"});
 const meta={title:"测试铁路时刻",kind:"rail_timetable",scope:{kind:"large",label:"测试范围"},source:"作者时刻安排",observedDate:"2026-11-22",license:"CC0"};
 const payload={metadata:meta,content:JSON.stringify(rows),format:"json",filename:"trips.json",shared:true};
 assert.equal((await call("/api/datasets","POST",payload)).status,401);
 const saved=await call("/api/datasets","POST",payload,owner.cookie);assert.equal(saved.status,201,JSON.stringify(saved.body));
 const id=saved.body.item.id;
 const found=await call("/api/timetables?from=node/101&to=node/103");assert.equal(found.status,200,JSON.stringify(found.body));assert.equal(found.body.items.length,1);
 record=found.body.items[0];assert.equal(record.source.author.username,"tt_owner");assert.equal(record.trip.stops.length,3);
 assert.equal((await call("/api/timetables?from=node/103&to=node/101")).body.items.length,0);
 assert.equal((await call("/api/timetables?q=R1&mode=rail")).body.items.length,1);
 assert.equal((await call("/api/timetables?mode=flight")).body.items.length,0);
 const match=await call("/api/timetables/match","POST",{pairs:[{mode:"rail",from:["id:node/101"],to:["id:node/103"]}]});
 assert.equal(match.status,200,JSON.stringify(match.body));assert.equal(match.body.pairs[0].items.length,1);
 assert.equal((await call("/api/datasets/"+id,"DELETE",{revision:1},other.cookie)).status,403);
 const oldBatch=DB.batch;DB.batch=async statements=>{await oldBatch([statements[0],DB.prepare("INSERT INTO transport_trips(dataset_id,trip_index,mode,trip_id,search_text,data_json) VALUES ('missing',0,'rail','x','','{}')")]);};
 const originalError=console.error;console.error=()=>{};
 try{assert.equal((await call("/api/datasets","POST",payload,owner.cookie)).status,500);}finally{console.error=originalError;}
 DB.batch=oldBatch;assert.equal((await call("/api/timetables")).body.items.length,1,"failed index transaction rolls back dataset and all candidate chunks");
 assert.equal((await call("/api/datasets/"+id,"DELETE",{revision:1},owner.cookie)).status,200);
 assert.equal((await call("/api/timetables")).body.items.length,0,"dataset delete cascades timetable and station indexes");
}finally{DB.close();}
const plan={id:"p",duration:2000,path:{stops:["101","102","103"],edges:[{kind:"ride",distance:1000,duration:500,route:{type:"train"}},{kind:"ride",distance:1000,duration:500,route:{type:"train"}}]}};
const description={prefix:600,legs:[{kind:"ride",mode:"rail",seconds:1000,edgeIndexes:[0,1],fromKeys:["id:node/101"],toKeys:["id:node/103"],
 stops:[{keys:["id:node/101"]},{keys:["id:node/102"]},{keys:["id:node/103"]}],sections:[line,line],routeIds:[],unconfirmed:false}]};
const nav=globalThis.HuayuTimetableNavigation.create({describe:()=>description,read:async()=>new Response(JSON.stringify({pairs:[{index:0,items:[record],complete:true}]}))});
const before=JSON.stringify(plan),chosen=await nav.enrich([plan],{departureAt:Date.parse("2026-11-22T15:30Z")});
assert.equal(chosen[0].sharedTimetables[0].tripId,"R1");assert.equal(chosen[0].sharedTimetables[0].waitSeconds,600,"access time is paid before boarding");
assert.equal(chosen[0].duration,4000);assert.equal(JSON.stringify(plan),before,"navigation preserves default graph and source plan");
const missed=await nav.enrich([plan],{departureAt:Date.parse("2026-11-22T16:00Z")});assert.equal(missed[0].duration,2000);
const wrong={...record,trip:{...trip,routeId:"relation/999"}};
const wrongNav=globalThis.HuayuTimetableNavigation.create({describe:()=>description,read:async()=>new Response(JSON.stringify({pairs:[{index:0,items:[wrong],complete:true}]}))});
assert.equal((await wrongNav.enrich([plan],{departureAt:Date.parse("2026-11-22T15:30Z")}))[0].sharedTimetables,undefined,"unrelated line cannot attach by station name");
const offline=globalThis.HuayuTimetableNavigation.create({describe:()=>description,read:async()=>{throw Error("offline");}});
assert.equal((await offline.enrich([plan]))[0].duration,2000,"service failure keeps the exact default travel time");
const incomplete=globalThis.HuayuTimetableNavigation.create({describe:()=>description,read:async()=>new Response(JSON.stringify({pairs:[{index:0,items:[record],complete:false}]}))});
assert.equal((await incomplete.enrich([plan]))[0].sharedTimetables,undefined,"partial match directory is not treated as complete");
const core=await readFile("site/transport-timetable-core.js","utf8"),server=await readFile("site/transport-timetable-server.js","utf8"),workerCode=await readFile("site/_worker.js","utf8");
assert.ok(workerCode.includes(core.slice(core.indexOf("function createTransportTimetableCore()"),core.indexOf("globalThis.HuayuTimetableCore="))));
assert.ok(workerCode.includes(server));
const frontend=await readFile("site/app.js","utf8");
assert.match(frontend,/plans = await enrichTimetablePlans\(plans\)/u);assert.match(frontend,/const airportPlans = await enrichTimetablePlans/u);
console.log("Timetables passed: minimal uploads, overnight/timezones/calendars, original times, acceleration/braking/curve/track caps, disconnected rejection, shared routed API, scoped authors, atomic index rollback, deletion cascade, access-aware navigation, missed services, unrelated lines and offline/partial fallback.");

import "../site/map-agent-contract.js";
import "../site/map-agent-tools.js";
const calls=[];
const agent=globalThis.HuayuAgentTools.create({atlas:{},timetables:()=>({
 query:async(args)=>{calls.push(args);return {items:[record],nextPage:null};},
 estimate:async(args)=>{calls.push(args);return record;}
})});
assert.equal((await agent.execute("search_transport_services",{query:"R1",mode:"rail",page:"0"})).items[0].trip.tripId,"R1");
assert.equal((await agent.execute("estimate_transport_service",{datasetId:"known",tripIndex:"0"})).published,false);
assert.equal(calls[1].tripIndex,0);
const shipped=await readFile("site/app.js","utf8");
const getFunction=func=>shipped.match(new RegExp("  (?:async )?function "+func+"\\([^]*?\\n  \\}","u"))[0];
const stops=[{id:101,sourceId:101,name:"甲站"},{id:102,sourceId:102,name:"乙站"},{id:103,sourceId:103,name:"丙站"}];
const app=vm.createContext({window:{HuayuTimetableCore:C},Map,Set,String,Number,Math,
 transitNetworkData:{stops},isUrbanRailTransitRoute:()=>false,METRO_ROUTE_TYPES:new Set(["subway"]),
 transitPassengerRouteIdentity:r=>String(r?.id||""),isTransitPassengerRouteChange:(a,b)=>a?.id!==b?.id,
 transitEdgeTravelSeconds:e=>e.duration,transitRouteChangeSeconds:()=>180,transitRouteChangeWalkingMeters:()=>0,WALKING_SPEED_KMH:5});
for(const f of ["timetableStopKeys","timetableEdgeSegments","collapseMultimodalRouteLegs","describeTimetablePlan"])vm.runInContext(getFunction(f),app);
const originalPlan={...plan,egressConnector:{duration:400},path:{...plan.path,edges:plan.path.edges.map(e=>({...e,route:{id:99,type:"train"},geometrySegments:line.map(l=>l.geometry)}))}};
const desc=app.describeTimetablePlan(originalPlan);
assert.equal(desc.legs.length,1);assert.equal(desc.legs[0].mode,"rail");assert.deepEqual(JSON.parse(JSON.stringify(desc.legs[0].edgeIndexes)),[0,1]);
assert.ok(desc.legs[0].fromKeys.includes("id:node/101"));assert.equal(desc.prefix,600);
const actualNav=globalThis.HuayuTimetableNavigation.create({describe:p=>app.describeTimetablePlan(p),read:async()=>Response.json({pairs:[{index:0,items:[record],complete:true}]})});
assert.equal((await actualNav.enrich([originalPlan],{departureAt:Date.parse("2026-11-22T15:30Z")}))[0].sharedTimetables[0].tripId,"R1");
console.log("Shipped app/assistant passed: real leg collapse, original source IDs, boarding prefix, selected timetable and exact tool handlers.");
