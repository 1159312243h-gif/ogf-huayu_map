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
    normalizeTransitSearchText:value=>String(value).toLowerCase().replace(/\s+/gu,""),
    transitPinyinize:value=>String(value).toLowerCase(),transitSearchEditDistance:()=>99,
    map:{getBounds:()=>({contains:()=>false})},searchPlaces:async()=>[],
    fetchAdministrativeExportPayload:async()=>empty(),
    activeAdministrativeFeatureBounds:features=>{
      const points=features.flatMap(f=>f.geometry.coordinates.flat(Infinity)).filter(Number.isFinite);
      const lons=points.filter((_,index)=>index%2===0),lats=points.filter((_,index)=>index%2===1);
      return {minLon:Math.min(...lons),maxLon:Math.max(...lons),minLat:Math.min(...lats),maxLat:Math.max(...lats)};
    },...overrides});
  for (const name of ["normalizePlaceSearchText","fuzzyAdministrativeNameKey","primaryPlaceName","administrativePlaceNameKey",
    "administrativeResultKey","isAdministrativeBoundaryResult","polygonFeatureGeometry","administrativeBoundaryGeometry",
    "sameAdministrativeCoordinate","pointInAdministrativeRing","stitchAdministrativeRings","overpassRelationFeature",
    "transitAtlasCityQueryVariants","transitAtlasCitySearchScore","transitAtlasCityCandidates",
    "transitAtlasCityBoundaryQuery","transitAtlasCityBoundaryResults","findTransitAtlasCities"]) {
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
