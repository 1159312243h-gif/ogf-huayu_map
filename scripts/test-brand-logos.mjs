import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {deflateSync} from "node:zlib";
import worker from "../site/_worker.js";
import "../site/brand-logo-core.js";
import "../site/brand-data.js";
import {createLocalPersonalDatabase} from "./lib/local-personal-db.mjs";
const core=globalThis.HuayuBrandLogoCore,builtins=JSON.parse(await readFile("site/brand-logos.json","utf8")).items;
assert.equal(builtins.length,4);
for(const e of builtins){const bytes=await readFile("site"+e.imageUrl.split("?")[0]);assert.equal(createHash("sha256").update(bytes).digest("hex"),e.sha256);assert.equal(bytes.subarray(0,4).toString(),"RIFF");}
const matcher=core.matcher(builtins),brand=builtins.find(e=>e.name==="高阳银行");
assert.equal(matcher.match({brand:"高阳银行",name:"其他店"}).key,brand.key);
assert.equal(matcher.match({brand:"其他",name:"高阳银行",amenity:"bank"}),null);
assert.equal(matcher.match({name:"高阳银行（清河支行）",amenity:"bank"}).key,brand.key);
assert.equal(matcher.match({name:"高阳银行清河支行",amenity:"bank"}).key,brand.key);
assert.equal(matcher.match({name:"高阳银行路",highway:"bus_stop"}),null);
assert.equal(matcher.match({name:"高阳银行",building:"yes"}),null);
assert.equal(matcher.match({brand:"TODAYS"}).name,"ToDays");
assert.equal(matcher.match({name:"高阳银行",shop:"clothes"}),null);
assert.equal(matcher.match({name:"高阳银行（公园ATM）",amenity:"atm"}).key,brand.key);
assert.equal(matcher.match({"brand:en":"aniM",shop:"anime"}).name,"aniM");
const names = [
 [{brand:"aniM",name:"aniM（津川站前店）",branch:"津川站前店"},"aniM · 津川站前店"],
 [{brand:"aniM",name:"津川站前店",branch:"津川站前店"},"aniM · 津川站前店"],
 [{brand:"aniM",branch:"津川站前店"},"aniM · 津川站前店"],
 [{brand:"aniM",name:"aniM津川站前店"},"aniM津川站前店"],
 [{brand:"aniM",name:"aniM津川站前店",branch:"  "},"aniM津川站前店"],
 [{brand:"aniM",branch:"ａｎｉｍ"},"aniM"],
 [{brand:"aniM","name:zh":"动漫店",name:"aniM",branch:" 津川站前店 "},"aniM · 津川站前店"],
 [{name:"aniM（津川站前店）",branch:"津川站前店",shop:"anime"},"aniM · 津川站前店"],
];
for (const [tags,expected] of names) {
 const identity={kind:"brand",name:"aniM"},before=JSON.stringify(tags),element={type:"node",id:901,lat:14,lon:153,tags,
   ...(!tags.brand?{brandMatch:{source:"name",name:"aniM"}}:{})};
 assert.equal(core.placeLabel(tags,identity),expected);
 assert.equal(globalThis.HuayuBrandData.placeLabel(tags,identity),expected,"logo and list use the same naming rule");
 assert.equal(globalThis.HuayuBrandData.place(element).label,expected,"list location and navigation name are consistent");
 const marker=core.markers([element],builtins)[0];assert.equal(marker.label,expected);
 assert.equal(marker.name,tags["name:zh"]||tags.name||"aniM","original names still drive symbol ownership");
 assert.equal(JSON.stringify(tags),before,"formatting never edits source tags");
}
assert.equal(globalThis.HuayuBrandData.place({type:"node",id:902,lat:14,lon:153,tags:{name:"未知店",branch:"北城店"},
 brandMatch:{source:"candidate",name:"未知品牌"}}).label,"未知店 · 北城店","unconfirmed shops are not renamed to an inferred brand");
const suppression=core.suppressionExpression([{name:"ToDays",lon:152.9,lat:14.6}]);
assert.equal(suppression[0],"match");assert.equal(suppression[2],"ToDays");
assert.equal(suppression[3][1][0],"within");assert.equal(suppression.at(-1),true);
const metro={id:"metro",key:"transit:test",kind:"transit",name:"测试地铁",aliases:["Test Metro"]};
const other={id:"other",key:"transit:other",kind:"transit",name:"另一地铁",aliases:[]};
assert.equal(core.matcher([metro]).transit({},[{type:"subway",network:"Test Metro"}]),metro);
assert.equal(core.matcher([metro]).transit({},[{type:"train",network:"Test Metro"}]),null);
assert.equal(core.matcher([metro,other]).transit({},[{type:"subway",network:"Test Metro"},{type:"subway",network:"另一地铁"}]),null);
const elems=[{type:"node",id:1,lat:14,lon:153,tags:{name:"站甲",railway:"station"}},
 {type:"node",id:2,lat:14,lon:153,tags:{name:"站甲",railway:"platform",public_transport:"platform"}},
 {type:"relation",id:100,tags:{route:"subway",network:"测试地铁"},members:[{type:"node",ref:1,role:"stop"},{type:"node",ref:2,role:"platform"}]}];
assert.deepEqual(core.markers(elems,[metro]).map(e=>e.id),[1]);
assert.equal(core.placeLabel({name:"站甲",branch:"系统分部"},metro),"站甲","transit logos retain the station name");
const escaped=core.query([{...brand,name:'A".*',aliases:[]}],[152,14,152.1,14.1]);
assert.ok(escaped.includes('A\\\\"')||escaped.includes('A\\"'));assert.ok(escaped.includes("\\\\.\\\\*"));
assert.throws(()=>core.query(builtins,[150,10,153,14]));
assert.deepEqual(core.filterExpression(["all",["==","class","shop"],["!in","name","甲"]]),["all",["==",["get","class"],"shop"],["!",["in",["get","name"],["literal",["甲"]]]]]);
// Execute the shipped engine's spatial predicate, not a mock of it.
const engine=await readFile("site/maplibre-gl.js","utf8"),exposed=engine.replace(/within:([a-zA-Z0-9_$]+),distance:([a-zA-Z0-9_$]+),/u,"within:(globalThis.__logoWithin=$1),distance:$2,");
assert.ok(exposed!==engine,"Locate the shipped engine's spatial predicate");
const spatialContext=vm.createContext({module:{exports:{}},exports:{},console,performance,TextDecoder,TextEncoder,URL,Blob,AbortController,setTimeout,clearTimeout});
vm.runInContext(exposed,spatialContext);
const shape=suppression[3][1],predicate=spatialContext.__logoWithin.parse(shape,{error:message=>{throw Error(message);}});
const canonical={z:17,x:Math.floor((152.9+180)/360*2**17),y:Math.floor((1-Math.log(Math.tan(Math.PI/4+14.6*Math.PI/360))/Math.PI)/2*2**17)};
const project=([lon,lat])=>({x:((lon+180)/360*2**17-canonical.x)*8192,y:((1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2*2**17-canonical.y)*8192});
const inside=point=>predicate.evaluate({canonical,canonicalID:()=>canonical,geometry:()=>[[project(point)]],geometryType:()=>"Point"});
assert.equal(inside([152.9,14.6]),true,"accepted nearby POI transfers to the logo");
assert.equal(inside([152.902,14.6]),false,"a distant namesake keeps its original symbol");
const crc=buffer=>{let c=0xffffffff;for(const v of buffer){c^=v;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;};
function chunk(type,data){const name=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);name.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([name,data])),8+data.length);return b;}
const head=Buffer.alloc(13);head.writeUInt32BE(1,0);head.writeUInt32BE(1,4);head[8]=8;head[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",head),chunk("IDAT",deflateSync(Buffer.from([0,255,255,255,255]))),chunk("IEND",Buffer.alloc(0))]);
const DB=await createLocalPersonalDatabase(),env={DB,ADMIN_USERNAMES:"logo_admin"},password="logo-regression-password";
async function request(path,method="GET",body,cookie="",extra={}){
 const r=await worker.fetch(new Request("https://logos.test"+path,{method,headers:{Origin:"https://logos.test",Cookie:cookie,"Content-Type":"application/json",...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{});
 return {status:r.status,body:r.headers.get("Content-Type")?.includes("image/")?new Uint8Array(await r.arrayBuffer()):await r.json(),cookie:r.headers.get("Set-Cookie")?.split(";")[0]||cookie,headers:r.headers};
}
const entry={kind:"brand",name:"回归品牌",aliases:["Regression"],source:"本人设计，公开地图标识",sourceUrl:"https://example.org/logo",rightsConfirmed:true,image:"data:image/png;base64,"+png.toString("base64")};
try{
 const a=await request("/api/auth/register","POST",{username:"logo_author",password}),b=await request("/api/auth/register","POST",{username:"logo_other",password}),admin=await request("/api/auth/register","POST",{username:"logo_admin",password});
 assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(admin.body.user.role,"admin");
 assert.equal((await request("/api/brand-logos")).body.items.length,4);
 assert.equal((await request("/api/brand-logos","POST",entry)).status,401);
 assert.equal((await request("/api/brand-logos","POST",entry,a.cookie,{Origin:"https://wrong.test"})).status,403);
 assert.equal((await request("/api/brand-logos","POST",{...entry,userId:b.body.user.id},a.cookie)).status,400);
 assert.equal((await request("/api/brand-logos","POST",{...entry,rightsConfirmed:false},a.cookie)).status,400);
 assert.equal((await request("/api/brand-logos","POST",{...entry,image:"data:image/png;base64,"+Buffer.from("<svg onload=bad()>").toString("base64")},a.cookie)).status,400);
 const created=await request("/api/brand-logos","POST",entry,a.cookie);assert.equal(created.status,201);
 const item=created.body.item,route="/api/brand-logos/"+item.id;
 assert.equal(item.author.id,a.body.user.id);assert.equal(item.key,"brand:回归品牌");
 assert.equal((await request("/api/brand-logos","POST",{...entry,name:" 回归品牌 "},b.cookie)).status,409);
 const image=await request(item.imageUrl);assert.equal(image.status,200);assert.deepEqual(Buffer.from(image.body),png);assert.equal(image.headers.get("X-Content-Type-Options"),"nosniff");
 assert.equal((await request(item.imageUrl+"wrong")).status,404);
 const patch={revision:1,aliases:[],source:"修订",sourceUrl:"",rightsConfirmed:true};
 assert.equal((await request(route,"PATCH",patch,b.cookie)).status,403);
 assert.equal((await request(route,"DELETE",{revision:1},b.cookie)).status,403);
 const updated=await request(route,"PATCH",patch,admin.cookie);assert.equal(updated.status,200);assert.equal(updated.body.item.author.id,a.body.user.id);assert.equal(updated.body.item.revision,2);
 assert.equal((await request(route,"PATCH",patch,a.cookie)).status,409);
 assert.equal((await request(route,"DELETE",{revision:1},a.cookie)).status,409);
 assert.equal((await request("/api/brand-logos")).headers.get("Cache-Control"),"no-store");
 // A user override of a built-in restores the original after deletion.
 const override=await request("/api/brand-logos","POST",{...entry,name:"ToDays"},a.cookie);assert.equal(override.status,201);
 assert.equal((await request("/api/brand-logos")).body.items.find(e=>e.name==="ToDays").builtin,false);
 assert.equal((await request("/api/brand-logos/"+override.body.item.id,"DELETE",{revision:1},a.cookie)).status,200);
 assert.equal((await request("/api/brand-logos")).body.items.find(e=>e.name==="ToDays").builtin,true);
 const originalFetch=globalThis.fetch;let fetches=0,partial=false;
 globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,"manual");fetches++;return new Response(JSON.stringify({elements:[{type:"node",id:11,lat:14.01,lon:152.01,tags:{brand:"ToDays",name:"ToDays（站前店）",branch:"站前店"}},{type:"count",tags:{total:partial?"5":"1"}}],osm3s:{timestamp_osm_base:"2026-11-17T00:00:00Z"}}));};
 try{
  const p=await request("/api/brand-logo-places?bounds=152,14,152.1,14.1");assert.equal(p.status,200);assert.equal(p.body.items[0].label,"ToDays · 站前店");
  await request("/api/brand-logo-places?bounds=152,14,152.1,14.1");assert.equal(fetches,1);
  partial=true;assert.equal((await request("/api/brand-logo-places?bounds=152,14,152.2,14.1")).status,502);
  assert.equal((await request("/api/brand-logo-places?bounds=152,14,154,16")).status,400);
 }finally{globalThis.fetch=originalFetch;}
 assert.equal((await request(route,"DELETE",{revision:2},a.cookie)).status,200);
 const orphan=await request("/api/brand-logos","POST",entry,b.cookie);assert.equal(orphan.status,201);
 await DB.prepare("DELETE FROM users WHERE id=?").bind(b.body.user.id).run();assert.equal((await request("/api/brand-logos")).body.items.some(e=>e.id===orphan.body.item.id),false);
 for(const script of ["site/brand-logos.js","site/brand-logo-core.js","site/brand-logo-server.js"]){assert.equal(spawnSync(process.execPath,["--check",script],{encoding:"utf8"}).status,0,script);}
 assert.equal(spawnSync(process.execPath,["scripts/sync-brand-logos.mjs","--check"],{encoding:"utf8"}).status,0);
 await import("./test-brand-logo-loading.mjs");
 await import("./test-brand-logo-display.mjs");
 await import("./test-brand-logo-startup.mjs");
 console.log(JSON.stringify({status:"passed",checks:["four-authentic-assets","explicit-brand-and-branch-names-without-name-duplication","transit-network-and-relation-members","ambiguous-systems-keep-original","literal-queries-and-bounds","PNG-validation-and-public-image","author-admin-and-version-conflicts","override-delete-fallback","account-cascade","complete-only-cache","frontend-worker-parity"]}));
}finally{DB.close();}
