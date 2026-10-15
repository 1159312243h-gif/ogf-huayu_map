import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import worker, { normalizedFavorites } from "../site/_worker.js";
import { createPersonalTestDatabase } from "./test-support/personal-db.mjs";

const context = vm.createContext({});
vm.runInContext(await readFile(new URL("../site/saved-places.js", import.meta.url),"utf8"), context);
const places = context.HuayuSavedPlaces;
const plain = value => JSON.parse(JSON.stringify(value));
const home = {lat:12.51,lng:148.36,zoom:16,label:"我的家",placeTags:["home"],customTags:["亲友家","休息"],isDefault:true};
const college = {lat:12.52,lng:148.37,zoom:15,label:"第一大学",placeTags:["university","former-home"],customTags:["校园时光"]};
const data = {
  home, college, previousCollege:{...college,lat:12.53,label:"第二大学",isDefault:true},
  old:{lat:12,lng:148,label:"旧收藏",zoom:13},
  invalid:{lat:null,lng:148}, empty:{lat:"",lng:148}, badLat:{lat:86,lng:148},
  badTags:{lat:0,lng:0,placeTags:["home","home","unknown"],zoom:99},
};
assert.deepEqual(plain(places.normalize(data)), Object.fromEntries(normalizedFavorites(data)),
  "浏览器与 Worker 必须保留相同标签、默认标记及旧收藏，并拒绝非法坐标");
assert.equal(places.matches(data,"大学").length,2,"同类学校允许多个地点");
assert.equal(places.matches(data,"","default").length,1,"只能有一个默认地点");
assert.equal(places.matches(data,"家庭住址").length,2,"标签可按中文快速查询");
assert.equal(places.matches(data,"","university").length,2);
assert.equal(places.matches(data)[0][0],"home","默认位置优先显示");
assert.equal(places.normalize(data).badTags.zoom,20);
assert.deepEqual(plain(places.normalize(data).badTags.placeTags),["home"]);
const special = JSON.parse('{"__proto__":{"lat":1,"lng":2,"label":"安全名称"}}');
assert.equal(Object.getPrototypeOf(places.normalize(special)),null);
const customCases = {
  one:{...college,customTags:["  周末  去处 ","周末 去处","Travel","ＴＲＡＶＥＬ","大学","home","",null,4,"\u0000tag","a".repeat(25),"👨‍👩‍👦"]},
  two:{...home,customTags:["travel","亲友家"]},
  limit:{...home,customTags:Array.from({length:12},(_,i)=>`标签${i}`)},
};
assert.deepEqual(plain(places.normalize(customCases)),Object.fromEntries(normalizedFavorites(customCases)),
  "自定义标签的 Unicode、大小写、去重、预设归并和上限在前后端必须一致");
assert.deepEqual(plain(places.normalize(customCases).one.customTags),["周末 去处","Travel","👨‍👩‍👦"]);
assert.ok(places.normalize(customCases).one.placeTags.includes("home"));
assert.equal(places.normalize(customCases).limit.customTags.length,8);
assert.equal(places.matches(customCases,"周末 去处").length,1);
assert.equal(places.matches(customCases,"","custom:travel").length,2);
assert.equal(places.customLabels(customCases).filter(s=>s.toLowerCase()==="travel").length,1);

const DB = await createPersonalTestDatabase();
const env = {DB};
async function request(path, method="GET", body, cookie="") {
  const response = await worker.fetch(new Request(`https://places.test${path}`,{
    method, headers:{Origin:"https://places.test",Cookie:cookie,"Content-Type":"application/json"},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }), env, {});
  const payload = await response.json();
  return {status:response.status,payload,cookie:response.headers.get("Set-Cookie")?.split(";")[0] || cookie};
}
const password = "test-only-account-password";
try {
  assert.equal((await request("/api/personal/favorites","PUT",{items:{home}})).status,401);
  const a = await request("/api/auth/register","POST",{username:"places_a",password});
  const b = await request("/api/auth/register","POST",{username:"places_b",password});
  assert.equal(a.status,201);assert.equal(b.status,201);
  const saved = await request("/api/personal/favorites","PUT",{items:{home,college}},a.cookie);
  assert.equal(saved.status,200);
  assert.deepEqual(saved.payload.favorites,{home,college});
  const reentered = await request("/api/auth/login","POST",{username:"places_a",password});
  assert.deepEqual(reentered.payload.favorites,{home,college},"独立登录会话须完整读取默认与标签");
  assert.deepEqual((await request("/api/auth/session","GET",undefined,b.cookie)).payload.favorites,{},
    "第二个账号不能读取第一个账号的私人地点");
  const merged = await request("/api/personal/sync","POST",{favorites:{
    home:{lat:12.51,lng:148.36,label:"旧本机副本"},
    guest:{lat:12.55,lng:148.4,label:"游客收藏",isDefault:true},
  }},a.cookie);
  assert.deepEqual(merged.payload.favorites.home,home,"旧本机合并不能抹掉账号名称、标签和默认");
  assert.equal(Object.values(merged.payload.favorites).filter(p=>p.isDefault).length,1);
  assert.equal(merged.payload.favorites.guest.isDefault,undefined);
  const full = Object.fromEntries(Array.from({length:199},(_,i)=>[`old-${i}`,{lat:10,lng:140+i/1000,label:`${"地".repeat(195)}${i}`,
    customTags:Array.from({length:8},(_,j)=>`${"标".repeat(18)}${i}-${j}`)}]));
  full.home=home;
  assert.ok(new TextEncoder().encode(JSON.stringify({items:full})).length>64*1024);
  const maximumSaved = await request("/api/personal/favorites","PUT",{items:full},a.cookie);
  assert.equal(maximumSaved.status,200,"200 个含完整中文名称和标签的收藏必须能够同步");
  assert.equal(maximumSaved.payload.favorites["old-198"].customTags.length,8);
  assert.equal((await request("/api/personal/favorites","PUT",{padding:"x".repeat(512*1024)},a.cookie)).status,413,
    "未声明 Content-Length 的超限收藏请求也须拒绝");
  assert.equal((await request("/api/auth/login","POST",{padding:"x".repeat(64*1024)})).status,413,
    "收藏扩容不能放宽登录请求的上限");
  const capped = await request("/api/personal/sync","POST",{favorites:{extra:{lat:1,lng:2,label:"额外"}}},a.cookie);
  assert.equal(Object.keys(capped.payload.favorites).length,200);
  assert.equal(capped.payload.favorites.home.isDefault,true,"满额合并不能丢失账号已有默认地点");
  const moved = {...college,lat:12.54,label:"新校区",isDefault:true};
  await request("/api/personal/favorites","PUT",{items:{moved}},a.cookie);
  const session = await request("/api/auth/session","GET",undefined,reentered.cookie);
  assert.deepEqual(session.payload.favorites,{moved},"编辑坐标、替换默认及删除旧收藏都须持久化");
  await request("/api/personal/favorites","PUT",{items:{}},a.cookie);
  assert.deepEqual((await request("/api/auth/session","GET",undefined,a.cookie)).payload.favorites,{});
  await request("/api/auth/logout","POST",{},a.cookie);
  assert.equal((await request("/api/auth/session","GET",undefined,a.cookie)).status,401);
  assert.equal((await request("/api/auth/session","GET",undefined,b.cookie)).status,200);
} finally {DB.close();}

console.log(JSON.stringify({status:"passed",feature:"saved-places",checks:[
  "frontend-worker-parity","labels-and-legacy-favorites","unique-default","real-sqlite-auth-sessions",
  "account-isolation","metadata-merge","capacity-preserves-default","edit-delete-logout",
  "custom-labels-and-filters","custom-label-session-persistence","bounded-full-collection-sync",
]},null,2));
