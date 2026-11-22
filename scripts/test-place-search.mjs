import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/place-search.js";
const tick=()=>new Promise(resolve=>setImmediate(resolve)),plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=data=>Response.json(data);
const create=globalThis.HuayuPlaceSearch.createClient;
let clock=0,calls=0;
const client=create({now:()=>clock,ttl:100,maxEntries:2,fetcher:async url=>{calls++;return response([{url}]);}});
await client.read("a");await client.read("a");assert.equal(calls,1);
clock=101;await client.read("a");assert.equal(calls,2,"expired results are revalidated");
await client.read("b");await client.read("a");await client.read("c");await client.read("b");assert.equal(calls,5,"LRU evicts the unused entry");
let mode="empty",attempts=0;
const transient=create({fetcher:async()=>{attempts++;if(mode==="http")return new Response("",{status:503});if(mode==="broken")return new Response("[{");if(mode==="object")return response({});return response([]);}});
for(const state of ["empty","http","broken","object"]){mode=state;for(let i=0;i<2;i++)try{await transient.read(state);}catch{}}
assert.equal(attempts,8,"empty and failed responses never enter positive cache");
let bigCalls=0;const large=[{name:"x".repeat(100)}];
const small=create({maxBytes:20,fetcher:async()=>{bigCalls++;return response(large);}});
assert.deepEqual(await small.read("large"),large);await small.read("large");assert.equal(bigCalls,2,"over-budget responses are returned intact, not cached");
const inflight=[],shared=create({fetcher:(url,options)=>{const wait=deferred();inflight.push({url,options,...wait});return wait.promise;}});
const a=new AbortController(),b=new AbortController();
const one=shared.read("same",{signal:a.signal}),two=shared.read("same",{signal:b.signal});await tick();
assert.equal(inflight.length,1);const cancelled=assert.rejects(one,{name:"AbortError"});a.abort();await cancelled;
assert.equal(inflight[0].options.signal.aborted,false,"one reader cannot cancel another");
inflight[0].resolve(response([{id:1}]));assert.equal((await two)[0].id,1);
const finalReader=new AbortController(),gone=shared.read("gone",{signal:finalReader.signal});await tick();
const rejection=assert.rejects(gone,{name:"AbortError"});finalReader.abort();await rejection;await tick();
assert.equal(inflight[1].options.signal.aborted,true,"last reader releases the source request");
let started=0,peak=0,running=0;const work=[];
const queued=create({concurrency:2,fetcher:async(url,{signal})=>{started++;running++;peak=Math.max(peak,running);const d=deferred();work.push({url,...d});try{return await d.promise;}finally{running--;}}});
const c=new AbortController(),q1=queued.read("1"),q2=queued.read("2"),q3=queued.read("3",{signal:c.signal});await tick();
assert.equal(started,2);const q3Rejected=assert.rejects(q3,{name:"AbortError"});c.abort();await q3Rejected;
work.forEach(w=>w.resolve(response([{url:w.url}])));await Promise.all([q1,q2]);await tick();assert.equal(started,2);assert.equal(peak,2);
const deadline=create({fetcher:()=>new Promise(()=>{})});await assert.rejects(deadline.read("timeout",{timeout:5}),{name:"TimeoutError"});
deadline.clear();

const app=(await readFile(new URL("../site/app.js",import.meta.url),"utf8")).replace(/\r\n/gu,"\n");
const extract=name=>{const body=app.match(new RegExp("  (?:async )?function "+name+"\\([^]*?\\n  \\}","u"))?.[0];assert.ok(body,name);return body;};
const baseNames=["normalizePlaceSearchText","fuzzyAdministrativeNameKey","primaryPlaceName","placeSearchOwnNames",
"withQueryMatchedPlaceName","placeSearchResultKey","placeSearchMatchScore","isAdministrativeBoundaryResult","isAdministrativeCenterResult",
"isAdministrativeSearchBoundary","shouldExpandAdministrativeSearch","fuzzyAdministrativeSearchQueries","isFuzzyAdministrativeCandidate","fuzzyAdministrativeDisplayResults",
"rankPlaceSearchResults","searchFuzzyAdministrativePlaces","searchPlacesWithAdministrativeFuzzy","hydratePlaceSearchResult","searchPlaces"];
function context(overrides={}) {
 const ctx=vm.createContext({AbortController,AbortSignal,Map,Set,Promise,Date,console,NOMINATIM_URL:"https://geo.test",
 FUZZY_ADMINISTRATIVE_SUFFIXES:["市","区","县"],window:{setTimeout,clearTimeout},
 map:{getBounds:()=>({contains:([lat])=>lat===14}),getCenter:()=>({lat:14,lng:152})},
 distanceMeters:(a,b)=>Math.hypot(a.lat-b.lat,a.lon-b.lon),
 pointOfInterestNameTypeSearch:()=>null,pointOfInterestCanonicalNameQuery:q=>q,
 shouldSearchCurrentViewportByName:()=>true,currentNominatimViewbox:()=>"151,15,153,13",
 ...overrides});
 for(const name of baseNames)vm.runInContext(extract(name),ctx);
 return ctx;
}
const city=(id,name="津川市")=>({osm_type:"relation",osm_id:id,name,lat:"16",lon:"152",class:"boundary",type:"administrative",extratags:{admin_level:"5"},huayu_search_geometry_pending:true});
const shop={osm_type:"node",osm_id:2,name:"津川",lat:"14",lon:"152",class:"shop",type:"convenience"};
const ctx=context(),requests=[],updates=[];
ctx.searchPlaces=(query,limit,options)=>{const wait=deferred();requests.push({query,limit,options,...wait});return wait.promise;};
let done=false;const composed=ctx.searchPlacesWithAdministrativeFuzzy("津川",30,{includeBoundary:false,onResults:r=>updates.push(plain(r))}).then(r=>{done=true;return r;});
assert.ok(requests.every(r=>r.options.includeBoundary===false&&r.options.includeTags===true));
requests[0].resolve([city(1),shop]);await tick();assert.equal(done,false);
assert.equal(updates[0][0].osm_id,1,"city appears before nearby commercial match without waiting for auxiliary providers");
assert.ok(requests.some(r=>r.query==="津川市")&&requests.some(r=>r.query==="津川区")&&requests.some(r=>r.query==="津川县"));
requests.slice(1).forEach(r=>r.resolve(r.query==="津川市"?[city(3)]:[]));
const results=await composed;assert.ok(results.some(r=>r.osm_id===1)&&results.some(r=>r.osm_id===3));
assert.deepEqual(plain(ctx.fuzzyAdministrativeDisplayResults(results,"津川")).map(r=>r.osm_id).sort((a,b)=>a-b),[1,3],"distinct same-name administrative identities remain selectable");
const province={...city(4,"金沙省"),namedetails:{name:"金沙省",_place_name:"高阳府",ref:"HX-S3"}};
assert.equal(ctx.rankPlaceSearchResults([province,city(5,"高阳府")],"高阳府",8)[0].osm_id,5);
assert.equal(ctx.fuzzyAdministrativeDisplayResults([province],"高阳府").length,0);
const thin=city(7);let requestedUrl;
const geometry={type:"MultiPolygon",coordinates:[[[[1,1],[4,1],[4,4],[1,1]],[[2,2],[3,2],[3,3],[2,2]]],[[[5,5],[6,5],[6,6],[5,5]]]]};
vm.runInContext(extract("searchPlaces"),ctx);
ctx.placeSearchClient={read:async url=>{requestedUrl=url;const {huayu_search_geometry_pending,...source}=thin;return [url.includes("/lookup?")?{...source,geojson:geometry}:source];}};
const found=await ctx.searchPlaces("津川市",30,{includeBoundary:false,includeTags:true,includeNameDetails:true});
assert.ok(requestedUrl.includes("namedetails=1")&&requestedUrl.includes("extratags=1")&&!requestedUrl.includes("polygon_geojson"));
assert.equal(found[0].huayu_search_geometry_pending,true);
const full=await ctx.hydratePlaceSearchResult(found[0]);
assert.ok(requestedUrl.includes("/lookup?")&&requestedUrl.includes("osm_ids=R7"));
assert.deepEqual(plain(full.geojson),geometry,"exact selected identity retains all islands and holes");
assert.equal(full.huayu_search_geometry_pending,undefined);
ctx.placeSearchClient={read:async()=>[{...city(8),geojson:geometry}]};
await assert.rejects(ctx.hydratePlaceSearchResult(found[0]),/完整几何/u);
ctx.placeSearchClient={read:async()=>{throw Error("HTTP_503");}};
await assert.rejects(ctx.hydratePlaceSearchResult(found[0]),/503/u,"provider failure never silently chooses a same-name object");

const ui=context();const log=[],pending=[];
Object.assign(ui,{searchRequestId:0,placeSearchSelectionId:0,placeSearchController:null,searchSelectionController:null,
 elements:{searchResults:{replaceChildren(){}},searchStatus:{}},placeSearchResultLayer:{clearLayers(){}},
 setStatus:(_el,text)=>log.push({status:text}),parseCoordinates:()=>null,savedPlaceMatches:()=>[],
 isTransitSearchQuery:()=>false,pointOfInterestTypeSearch:()=>null,
 humanizeError:()=>"",renderSearchResults:(items,q)=>log.push({q,ids:items.map(r=>r.osm_id)})});
ui.window.HuayuBrandBrowser={clearSearch(){},search:q=>log.push({brand:q})};
ui.window.HuayuFeatureInfo={clearSearch(){},search:q=>log.push({shared:q})};
ui.searchPlacesWithAdministrativeFuzzy=(q,limit,options)=>{const d=deferred();pending.push({q,options,...d});return d.promise;};
vm.runInContext(extract("runPlaceSearch"),ui);
const old=ui.runPlaceSearch("旧城");assert.ok(log.some(r=>r.shared==="旧城"),"shared-name search starts independently");
assert.ok(!log.some(r=>r.brand==="旧城"),"brand suggestions do not compete with first place response");
pending[0].options.onResults([city(10)]);assert.ok(log.some(r=>r.q==="旧城"));
const recent=ui.runPlaceSearch("新城");assert.equal(pending[0].options.signal.aborted,true);
const before=log.length;pending[0].options.onResults([city(11)]);pending[0].resolve([city(11)]);await old;
assert.equal(log.length,before,"late old search cannot change results or reopen brand suggestions");
pending[1].options.onResults([city(12)]);pending[1].resolve([city(12)]);await recent;
assert.equal(log.filter(r=>r.q==="新城").length,1,"unchanged completion does not reset focus by rerendering");
assert.ok(log.some(r=>r.brand==="新城"));

const selection=context();let resolveGeometry;const selections=[];
Object.assign(selection,{searchSelectionController:null,placeSearchSelectionId:0,
 showToast(){},hydratePlaceSearchResult:r=>r.osm_id===20?new Promise(resolve=>resolveGeometry=resolve):Promise.resolve(r),
 isRoadSearchResult:()=>false,findAdministrativeBoundaryResult:()=>null,findAdministrativeCenterResult:()=>null,
 loadAdministrativeCenter:async()=>null,isAdministrativeCenterResult:()=>false,isAdministrativeBoundaryResult:()=>false,
 administrativeBoundaryGeometry:()=>null,parseBoundingBox:()=>null,
 setSelectedPlace:(p,options)=>selections.push({p,options})});
vm.runInContext(extract("selectPlaceSearchResult"),selection);
const oldSelection=selection.selectPlaceSearchResult({...city(20),huayu_search_geometry_pending:true});
await tick();await selection.selectPlaceSearchResult(city(21));resolveGeometry(city(20));assert.equal(await oldSelection,false);
assert.equal(selections.length,1);assert.equal(selections[0].p.label,"津川市");
assert.ok(selections[0].options.searchSelectionId>0,"actual selection passes its cancellation epoch to shared map handler");
console.log("Search passed: bounded cache, independent cancellation, deadlines, progressive cities first, same-name identities, exact full geometry, independent shared search and late-result protection.");
