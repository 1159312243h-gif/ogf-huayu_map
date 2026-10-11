import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require=createRequire(import.meta.url);
const {terrainRuntime}=require("./data-update/builders/build-terrain-preload.cjs");
const {buildTerrainContext}=require("./data-update/builders/build-terrain-context.cjs");
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
console.log("Terrain context passed: crossing rivers, complete lake relations, garden clearings, city exclusions, canal slopes, resume and failed fetches.");
