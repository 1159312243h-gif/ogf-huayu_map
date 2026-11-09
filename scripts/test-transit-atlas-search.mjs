import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const empty = () => ({elements:[{type:"count", tags:{total:"0"}}]});
const polygon = {type:"Polygon",coordinates:[[[150,12],[151,12],[151,13],[150,13],[150,12]]]};
const boundary = (id = 307796, name = "津川市") => ({osm_type:"relation",osm_id:id,name,
  type:"administrative",category:"boundary",lat:"12.5",lon:"150.5",geojson:polygon});
const ring = coordinates => coordinates.map(([lon,lat]) => ({lat,lon}));
const member = (coordinates, role = "outer") => ({type:"way",role,geometry:ring(coordinates)});
const relation = {type:"relation",id:307796,tags:{boundary:"administrative",admin_level:"5",name:"津川市"},
  members:[{type:"node",ref:123,role:"admin_centre"},{type:"relation",ref:456,role:"subarea"},
    member(polygon.coordinates[0]),member([[150.1,12.1],[150.2,12.1],[150.2,12.2],[150.1,12.1]],"inner"),
    member([[152,12],[153,12],[153,13],[152,12]])]};
const payload = value => ({elements:[{type:"count",tags:{total:"1"}},value]});
const plain = value => JSON.parse(JSON.stringify(value));

function context(overrides = {}) {
  let clock = Date.now();
  const result = vm.createContext({Map,Set,Promise,Date:{now:()=>clock},
    TRANSIT_PINYIN_ALIASES:new Map([["津川",["jinchuan"]]]),
    transitAtlasCitySearchCache:new Map(),
    administrativeCityPointSearchCache:new Map(),
    normalizeTransitSearchText:value=>String(value).toLowerCase().replace(/\s+/gu,""),
    transitPinyinize:value=>String(value).toLowerCase(),transitSearchEditDistance:()=>99,
    map:{getBounds:()=>({contains:()=>false}),getCenter:()=>({lat:12.5,lng:150.5})},
    distanceMeters:(a,b)=>Math.hypot(a.lat-b.lat,a.lng-b.lng),searchPlaces:async()=>[],
    fetchAdministrativeExportPayload:async()=>empty(),
    activeAdministrativeFeatureBounds:features=>{
      const points=features.flatMap(f=>f.geometry.coordinates.flat(Infinity)).filter(Number.isFinite);
      const lons=points.filter((_,index)=>index%2===0),lats=points.filter((_,index)=>index%2===1);
      return {minLon:Math.min(...lons),maxLon:Math.max(...lons),minLat:Math.min(...lats),maxLat:Math.max(...lats)};
    },...overrides});
  for (const name of ["normalizePlaceSearchText","fuzzyAdministrativeNameKey","placeSearchOwnNames","withQueryMatchedPlaceName","primaryPlaceName","administrativePlaceNameKey",
    "placeSearchResultKey","placeSearchMatchScore","isAdministrativeCenterResult","rankPlaceSearchResults",
    "administrativeResultKey","isAdministrativeBoundaryResult","polygonFeatureGeometry","administrativeBoundaryGeometry",
    "sameAdministrativeCoordinate","pointInAdministrativeRing","stitchAdministrativeRings","overpassRelationFeature",
    "transitSearchEditDistance","transitAtlasCityQueryVariants","transitAtlasCitySearchScore","exactAdministrativeCitySearchScore","transitAtlasCityCandidates",
    "transitAtlasCityBoundaryQuery","transitAtlasCityBoundaryResults","administrativeCityPoints","findTransitAtlasCities"]) {
    const declaration=app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`,"u"))?.[0];
    assert.ok(declaration,name);vm.runInContext(declaration,result);
  }
  result.advance = ms=>{clock+=ms;};
  return result;
}

const c=context();
assert.ok(c.transitAtlasCityQueryVariants("津川").includes("津川市"));
assert.ok(c.transitAtlasCityQueryVariants("jinchuan").includes("津川"));
const query=c.transitAtlasCityBoundaryQuery('A.*"\\镇');
assert.ok(query.includes("out count")&&query.includes("out geom 17")&&query.includes("maxsize:16777216"));
// The actual name pattern must stay a JSON string literal.
const pattern=JSON.parse(query.match(/\$"~("(?:\\.|[^"\\])*")/u)[1]);
const matcher=new RegExp(pattern,"i");
assert.ok(matcher.test('A.*"\\镇'));
assert.equal(matcher.test('Another镇'),false,"input is literal, never query/regex syntax");
const actual=c.transitAtlasCityBoundaryResults(payload(relation));
assert.equal(actual[0].osm_id,307796);
assert.equal(actual[0].geojson.type,"MultiPolygon");
assert.equal(actual[0].geojson.coordinates[0].length,2,"a real hole remains a hole");
assert.equal(actual[0].geojson.coordinates.length,2,"disconnected boundary parts remain intact");
assert.deepEqual(plain(c.transitAtlasCityBoundaryResults(payload({...relation,members:[]}))),[]);
for (const broken of [member([[155,12],[156,13]]),member([[150.1,12.1],[150.2,12.2]],"inner"),
  {type:"way",role:"outer"},member([[170,20],[171,20],[171,21],[170,20]],"inner")]) {
  assert.deepEqual(plain(c.transitAtlasCityBoundaryResults(payload({...relation,members:[...relation.members,broken]}))),[],
    "reject the entire incomplete boundary instead of dropping an outer fragment or hole");
}
assert.throws(()=>c.transitAtlasCityBoundaryResults({elements:[{type:"count",tags:{total:"17"}}]}),/CITY_SEARCH_TOO_BROAD/u);
assert.throws(()=>c.transitAtlasCityBoundaryResults({elements:[],remark:"timeout"}),/INCOMPLETE/u);
assert.equal(c.transitAtlasCityCandidates([{...boundary(),geojson:{type:"Point",coordinates:[150,12]}}],"津川").length,0);
assert.equal(c.transitAtlasCityCandidates([boundary(1,"Different city")],"津川").length,0);
assert.equal(c.transitAtlasCitySearchScore({...boundary(2,"Jinchuan"),namedetails:{"name:zh":"津川市"}},"津川"),1);

// Actual Nominatim structure: a province links to its capital, but that capital
// is not an alias of the province and must never replace its displayed name.
const province={...boundary(307794),name:undefined,display_name:"金沙省, 天南道, 华夏共和国",
  namedetails:{ref:"HX-S3",name:"金沙省",short_name:"金",_place_name:"高阳府"},extratags:{linked_place:"city"}};
const gaoyang={...boundary(347805),name:undefined,display_name:"高阳府, 金沙省, 天南道, 华夏共和国",namedetails:{name:"高阳府"}};
assert.equal(c.primaryPlaceName(c.withQueryMatchedPlaceName(province,"高阳府")),"金沙省");
assert.equal(c.primaryPlaceName(c.withQueryMatchedPlaceName(gaoyang,"高阳府")),"高阳府");
assert.equal(c.exactAdministrativeCitySearchScore(province,"高阳府"),Infinity);
assert.deepEqual(plain(c.transitAtlasCityCandidates([province,gaoyang],"高阳府",true)).map(r=>r.osm_id),[347805]);
assert.equal(c.exactAdministrativeCitySearchScore(province,"金"),0,"a real short_name remains searchable");
assert.equal(c.exactAdministrativeCitySearchScore(province,"HX-S3"),Infinity,"a provider ref is not a name");
assert.equal(c.primaryPlaceName(c.withQueryMatchedPlaceName({...gaoyang,namedetails:{name:"高阳府","name:en":"Gaoyang",alt_name:"高阳城;高阳旧府",_place_name:"错误中心"}},"高阳旧府")),"高阳旧府");
assert.equal(c.exactAdministrativeCitySearchScore({...gaoyang,namedetails:{name:"高阳府","name:en":"Gaoyang"}},"Gaoyang"),0);
assert.equal(c.primaryPlaceName(c.withQueryMatchedPlaceName({...province,huayu_search_name:"高阳府"},"金沙省")),"金沙省","new matches do not reuse a stale inferred title");
const ranked=c.rankPlaceSearchResults([province,gaoyang],"高阳府",12);
assert.deepEqual(plain(ranked).map(r=>r.osm_id),[347805,307794],"the requested city precedes a related province");
assert.deepEqual(plain(ranked).map(r=>c.primaryPlaceName(r)),["高阳府","金沙省"]);
assert.equal(ranked[1].geojson,province.geojson,"naming does not alter the selected administrative geometry");
assert.equal(c.primaryPlaceName(c.withQueryMatchedPlaceName({...province,osm_id:999,namedetails:{name:"其他省",_place_name:"另一个府"},display_name:"其他省, 其他道"},"另一个府")),"其他省","the fix applies to other linked administrative centres");

let calls=0;
const fallback=context({searchPlaces:async()=>{throw new Error("HTTP_503");},
  fetchAdministrativeExportPayload:async()=>{calls++;return payload(relation);}});
assert.equal((await fallback.findTransitAtlasCities("津川"))[0].osm_id,307796,
  "original-tag boundary search survives a geocoder outage");
await fallback.findTransitAtlasCities("津川");assert.equal(calls,1,"successful boundaries are reused");
fallback.advance(3*60*60*1000+1);await fallback.findTransitAtlasCities("津川");assert.equal(calls,2,"cache ages from fetch, not read");

let options;
const fast=context({searchPlaces:async(term,limit,opts)=>{
  options=opts;
  return term==="津川市"?[boundary()]:new Promise(()=>{});
},fetchAdministrativeExportPayload:()=>new Promise(()=>{})});
const timeout=setTimeout(()=>{throw new Error("fast city boundary waited for unrelated hung searches");},1000);
assert.equal((await fast.findTransitAtlasCities("津川"))[0].osm_id,307796);
clearTimeout(timeout);
assert.equal(options.featureType,"city");assert.equal(options.dedupe,false);assert.equal(options.includeNameDetails,true);

const attempted=[];
const retry=context({searchPlaces:async term=>{
  attempted.push(term);
  if(term!=="津川市")return [];
  if(attempted.filter(t=>t===term).length===1)throw new Error("HTTP_504");
  return [boundary()];
},fetchAdministrativeExportPayload:async()=>{throw new Error("HTTP_502");}});
assert.equal((await retry.findTransitAtlasCities("津川"))[0].osm_id,307796);
assert.equal(attempted.filter(t=>t==="津川市").length,2,"retry a failed name once");
assert.equal(attempted.filter(t=>t==="津川").length,1,"do not retry genuine empty results");

let fail=true;
const recover=context({searchPlaces:async()=>{if(fail)throw new Error("HTTP_503");return [];},
  fetchAdministrativeExportPayload:async()=>{if(fail)throw new Error("HTTP_503");return empty();}});
await assert.rejects(recover.findTransitAtlasCities("津川"),/CITY_SEARCH_UNAVAILABLE/u);
assert.equal(recover.transitAtlasCitySearchCache.size,0,"never cache a failure as an empty result");
fail=false;assert.deepEqual(plain(await recover.findTransitAtlasCities("津川")),[]);

const cityPoint={osm_type:"node",osm_id:431549267,name:"合江市",display_name:"合江市, 汤海共和国",
  category:"place",type:"city",lat:"35.9421869",lon:"141.4226814",geojson:{type:"Point",coordinates:[141.4226814,35.9421869]}};
let completeBoundary;
const points=context({searchPlaces:async()=>[cityPoint],fetchAdministrativeExportPayload:q=>q.includes('node["place"')?Promise.resolve(empty()):new Promise(resolve=>{completeBoundary=resolve;})});
const updates=[],pointSearch=points.findTransitAtlasCities("合江市",{exactNames:true,onPlaces:results=>updates.push(plain(results))});
await new Promise(setImmediate);
assert.equal(updates[0][0].osm_id,431549267,"simulation receives international city points before a slow boundary lookup finishes");
completeBoundary(empty());assert.deepEqual(plain(await pointSearch),[],"shared atlas results still require real complete boundaries");
assert.equal(points.transitAtlasCitySearchCache.size,0,"city points must not pollute the complete-boundary cache");
const independentQueries=[];
const independentPoints=context({searchPlaces:()=>new Promise(()=>{}),fetchAdministrativeExportPayload:async q=>{
  independentQueries.push(q);return q.includes('node["place"')?payload({type:"node",id:431549267,lon:141.4226814,lat:35.9421869,tags:{place:"city",name:"合江市"}}):empty();
}});
const independentUpdates=[];
void independentPoints.findTransitAtlasCities("合江市",{exactNames:true,onPlaces:results=>independentUpdates.push(plain(results))});
await new Promise(setImmediate);
assert.ok(independentQueries.some(q=>q.includes('node["place"')&&!q.includes('geom')&&!q.includes('rel[')),"city point lookup never waits for administrative geometry");
assert.equal(independentUpdates[0][0].osm_id,431549267,"an independent original-tag query locates the city even when the geocoder hangs");
assert.doesNotMatch(c.transitAtlasCityBoundaryQuery("合江市"),/node\["place"/u,"default railway atlas lookup remains boundary-only");

// Actual returned near-match: a town in a different country, not the requested city.
const wrongTown={...boundary(452801,"围江镇"),display_name:"围江镇, 河东厅, 京承府, 赤汤省, 东原道, 华夏共和国"};
assert.equal(c.transitAtlasCityCandidates([wrongTown],"合江市").length,1,"exercise the real edit-distance path that caused the false winner");
assert.equal(c.transitAtlasCityCandidates([wrongTown],"合江市",true).length,0);
for(const name of ["合江镇","合江县","河阴区","内河街道"])assert.equal(c.exactAdministrativeCitySearchScore({...boundary(2,name),display_name:`${name}, 合江省, AR923`},"合江市"),Infinity);
assert.equal(c.exactAdministrativeCitySearchScore(cityPoint,"合江市"),0);
assert.equal(c.exactAdministrativeCitySearchScore({...cityPoint,name:"合江",display_name:"合江"},"合江市"),1);
assert.equal(c.exactAdministrativeCitySearchScore({...cityPoint,name:"合江市",namedetails:{"name:en":"He Jiang",alt_name:"合江旧城;合江新城"}},"He Jiang"),0);
assert.equal(c.exactAdministrativeCitySearchScore({...cityPoint,namedetails:{alt_name:"合江旧城;合江新城"}},"合江新城"),0);
assert.equal(c.exactAdministrativeCitySearchScore(boundary(9,"北湖縣"),"北湖县"),1);
assert.equal(c.exactAdministrativeCitySearchScore(boundary(9,"赤汤省"),"赤汤"),1);
assert.equal(c.exactAdministrativeCitySearchScore(boundary(9,"津川市"),"jinchuan"),1);

let finishGeocoder,settled=false;const originalResolvers=[];
const race=context({searchPlaces:term=>term==="合江市"?new Promise(resolve=>{finishGeocoder=resolve;}):Promise.resolve([wrongTown]),
  fetchAdministrativeExportPayload:q=>new Promise(resolve=>{originalResolvers.push([q,resolve]);})});
race.transitAtlasCitySearchCache.set(race.normalizePlaceSearchText("合江市"),{results:[wrongTown],createdAt:Date.now(),bytes:100});
const raceUpdates=[],raceResult=race.findTransitAtlasCities("合江市",{exactNames:true,onPlaces:results=>raceUpdates.push(...plain(results))}).then(results=>{settled=true;return results;});
await new Promise(setImmediate);assert.equal(settled,false,"a fast wrong town and an older fuzzy cache cannot finish an exact city search");
finishGeocoder([cityPoint]);for(const [q,resolve] of originalResolvers)resolve(q.includes('node["place"')?payload({type:"node",id:431549267,lon:141.4226814,lat:35.9421869,tags:{place:"city",name:"合江市"}}):empty());
assert.deepEqual(plain(await raceResult),[]);assert.ok(raceUpdates.some(r=>r.osm_id===431549267));assert.ok(raceUpdates.every(r=>r.osm_id!==452801));
assert.equal(race.transitAtlasCitySearchCache.has("exact-city-v2:合江市"),false,"a missing exact boundary is not cached as a wrong place");

const storage=new Map(),sessionStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
const savedPoints=context({sessionStorage,searchPlaces:async()=>[cityPoint],fetchAdministrativeExportPayload:async()=>empty()});
await savedPoints.findTransitAtlasCities("合江市",{exactNames:true,onPlaces(){}});
assert.equal(storage.size,1,"positive city points survive a page reload in this tab");
const restored=context({sessionStorage,searchPlaces:async()=>{throw Error("HTTP_503");},fetchAdministrativeExportPayload:async()=>{throw Error("HTTP_502");}});
const recoveredPoints=[];await assert.rejects(restored.findTransitAtlasCities("合江市",{exactNames:true,onPlaces:r=>recoveredPoints.push(...plain(r))}),/CITY_SEARCH_UNAVAILABLE/u);
assert.equal(recoveredPoints[0].osm_id,431549267,"a total network outage must not remove the previously verified city point");
const originalTime=restored.administrativeCityPointSearchCache.get("合江市").createdAt;
restored.advance(1000);restored.administrativeCityPoints("合江市");assert.equal(restored.administrativeCityPointSearchCache.get("合江市").createdAt,originalTime,"cache reads do not extend source age");
restored.advance(3*60*60*1000);assert.equal(restored.administrativeCityPoints("合江市").length,0);
savedPoints.administrativeCityPoints("其他市",[]);assert.equal(savedPoints.administrativeCityPointSearchCache.has("其他市"),false);
const unavailableStorage=context({sessionStorage:{getItem(){throw Error("denied");},setItem(){throw Error("denied");}}});
assert.equal(unavailableStorage.administrativeCityPoints("合江市",[cityPoint])[0].osm_id,431549267);
const retryPoints=context({searchPlaces:async()=>[],fetchAdministrativeExportPayload:async q=>{
  if(!q.includes('node["place"'))return empty();retryPoints.attempts=(retryPoints.attempts||0)+1;
  if(retryPoints.attempts===1)throw Error("HTTP_503");return payload({type:"node",id:431549267,lon:141.4226814,lat:35.9421869,tags:{place:"city",name:"合江市"}});
}});
const retried=[];await retryPoints.findTransitAtlasCities("合江市",{exactNames:true,onPlaces:r=>retried.push(...plain(r))});assert.equal(retryPoints.attempts,2);assert.equal(retried[0].osm_id,431549267);

function node(){return {children:[],hidden:false,value:"",classList:{toggle(){}},
  append(...children){this.children.push(...children);},appendChild(child){this.children.push(child);},
  replaceChildren(){this.children=[];},setAttribute(){},addEventListener(){},focus(){}};}
const elements={transitAtlasQuery:node(),transitAtlasResults:node(),transitAtlasStatus:node()};
const pending=new Map();
const ui=context({elements,document:{createElement:node},transitAtlasRequestId:0,
  setStatus:(element,text)=>{element.textContent=text;},administrativeLevelLabel:()=>"行政区"});
ui.findTransitAtlasCities=q=>new Promise((resolve,reject)=>pending.set(q,{resolve,reject}));
vm.runInContext(app.match(/  async function searchTransitAtlasCities\([^]*?\n  \}/u)[0],ui);
elements.transitAtlasQuery.value="旧查询";const old=ui.searchTransitAtlasCities({preventDefault(){}});
elements.transitAtlasQuery.value="新查询";const newer=ui.searchTransitAtlasCities({preventDefault(){}});
pending.get("新查询").resolve([boundary(2,"新城市")]);await newer;
pending.get("旧查询").resolve([boundary(1,"旧城市")]);await old;
assert.equal(elements.transitAtlasResults.children[0].children[0].textContent,"新城市");
elements.transitAtlasQuery.value="故障";const outage=ui.searchTransitAtlasCities({preventDefault(){}});
pending.get("故障").reject(new Error("CITY_SEARCH_UNAVAILABLE"));await outage;
assert.match(elements.transitAtlasStatus.textContent,/连接失败或超时/u);
assert.doesNotMatch(elements.transitAtlasStatus.textContent,/没有找到/u);
console.log("Transit atlas search passed: real complete boundaries and holes, literal multilingual names, independent providers, fast results, retry, bounded positive cache, honest errors and stale response protection.");
