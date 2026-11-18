import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import path from "node:path";
import worker from "../site/_worker.js";
import {createLocalPersonalDatabase} from "./lib/local-personal-db.mjs";

const DB = await createLocalPersonalDatabase(), env = {DB,ADMIN_USERNAMES:"info_admin"};
const password = "test-only-shared-info-password";
async function request(route, method="GET", body, cookie="", extra={}) {
  const response = await worker.fetch(new Request(`https://info.test${route}`,{
    method,headers:{Origin:"https://info.test",Cookie:cookie,"Content-Type":"application/json",...extra},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }),env,{});
  return {status:response.status,body:await response.json(),
    cookie:response.headers.get("Set-Cookie")?.split(";")[0] || cookie,headers:response.headers};
}
const feature = {type:"way",id:12001,label:"北城公园",lat:14.637,lng:152.933};
const entry = {feature,title:"公园简介",content:"<img src=x onerror=alert(1)>\n这是公开的多行信息。",sourceUrl:"https://example.com/source"};
const endpoint = `/api/feature-info?type=${feature.type}&id=${feature.id}`;
try {
  const a = await request("/api/auth/register","POST",{username:"info_author_a",password,displayName:"甲"});
  const b = await request("/api/auth/register","POST",{username:"info_author_b",password,displayName:"乙"});
  const admin = await request("/api/auth/register","POST",{username:"info_admin",password});
  assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(admin.body.user.role,"admin");
  assert.equal((await request("/api/feature-info","POST",entry)).status,401,"游客不能发布");
  const created = await request("/api/feature-info","POST",entry,a.cookie);
  assert.equal(created.status,201);
  const id = created.body.item.id, route = `/api/feature-info/${id}`;
  assert.equal(created.body.item.author.id,a.body.user.id);
  assert.equal(created.body.item.content,entry.content,"后端保存原文，由 UI 安全文本渲染");
  const second = await request("/api/feature-info","POST",{...entry,title:"游园补充",content:"第二位作者"},b.cookie);
  assert.equal(second.status,201);
  const publicRead = await request(endpoint);
  assert.equal(publicRead.status,200);assert.equal(publicRead.body.total,2);
  assert.equal(publicRead.headers.get("Cache-Control"),"no-store");
  assert.deepEqual(new Set(publicRead.body.items.map(item=>item.author.id)),new Set([a.body.user.id,b.body.user.id]));
  assert.ok(!JSON.stringify(publicRead.body).includes("password"));
  assert.equal((await request(endpoint.replace("way","node"))).body.total,0,"同号不同要素类型不能混合");
  assert.equal((await request(endpoint.replace("12001","12002"))).body.total,0,"同名不同编号不能混合");
  const page = await request(`${endpoint}&limit=1`);
  const next = await request(`${endpoint}&limit=1&after=${encodeURIComponent(page.body.nextCursor)}`);
  assert.equal(next.body.items.length,1);assert.notEqual(page.body.items[0].id,next.body.items[0].id);
  assert.equal(next.body.nextCursor,null);
  assert.equal((await request(`${endpoint}&after=invalid`)).status,400);
  assert.equal((await request(`${endpoint}&limit=51`)).status,400);
  const patch = {title:"作者修改",content:"新正文",sourceUrl:"",revision:1};
  assert.equal((await request(route,"PATCH",patch,b.cookie)).status,403);
  assert.equal((await request(route,"DELETE",{revision:1},b.cookie)).status,403);
  assert.equal((await request(route,"PATCH",{...patch,user_id:a.body.user.id},b.cookie)).status,400,"拒绝伪造归属字段");
  assert.equal((await request(route,"PATCH",{...patch,feature:{...feature,id:100}},a.cookie)).status,400);
  assert.equal((await request("/api/feature-info","POST",{...entry,userId:b.body.user.id},a.cookie)).status,400);
  assert.equal((await request(route,"PATCH",patch,a.cookie,{Origin:"https://attacker.test"})).status,403);
  assert.equal((await request(route,"PATCH",patch,a.cookie,{"Sec-Fetch-Site":"cross-site"})).status,403);
  const changed = await request(route,"PATCH",patch,a.cookie);
  assert.equal(changed.status,200);assert.equal(changed.body.item.revision,2);
  assert.equal(changed.body.item.author.id,a.body.user.id);
  assert.equal((await request(route,"PATCH",patch,a.cookie)).status,409,"陈旧版本不得覆盖");
  assert.equal((await request(route,"DELETE",{revision:1},admin.cookie)).status,409);
  const moderated = await request(route,"PATCH",{...patch,title:"管理员核对",revision:2},admin.cookie);
  assert.equal(moderated.status,200);assert.equal(moderated.body.item.revision,3);
  assert.equal(moderated.body.item.author.id,a.body.user.id,"管理员不能夺走作者署名");
  assert.equal(moderated.body.item.editedBy.username,"info_admin");
  const parallel = await Promise.all([
    request(route,"PATCH",{...patch,revision:3},a.cookie),
    request(route,"PATCH",{...patch,revision:3},admin.cookie),
  ]);
  assert.deepEqual(parallel.map(row=>row.status).sort(),[200,409],"并发保存只接受一个版本");
  const found = await request(`/api/feature-info/search?q=${encodeURIComponent("北城公园")}`);
  assert.equal(found.body.items[0].id,feature.id);
  assert.equal(found.body.items[0].matchingCount,2);
  assert.equal((await request(`/api/feature-info/search?q=${encodeURIComponent("第二位作者")}`)).body.items[0].id,feature.id);
  assert.equal((await request(`/api/feature-info/search?q=${encodeURIComponent("%' OR 1=1 --")}`)).body.items.length,0,"查询是字面量");
  assert.equal((await request("/api/feature-info/search?q=")).status,400);
  for (const invalid of [
    {...entry,title:" "},{...entry,content:"x".repeat(5001)},{...entry,content:"bad\u0000text"},
    {...entry,sourceUrl:"javascript:alert(1)"},{...entry,sourceUrl:"https://name:pass@example.com"},
    {...entry,feature:{...feature,type:"area"}},{...entry,feature:{...feature,id:-2}},
    {...entry,feature:{...feature,id:"01"}},{...entry,feature:{...feature,lat:"14"}},
    {...entry,feature:{...feature,lng:181}},
  ]) assert.equal((await request("/api/feature-info","POST",invalid,a.cookie)).status,400);
  assert.equal((await request("/api/feature-info","POST",{...entry,content:"x".repeat(40000)},a.cookie)).status,413);
  await DB.prepare("UPDATE users SET disabled = 1 WHERE id = ?").bind(b.body.user.id).run();
  assert.equal((await request("/api/feature-info","POST",entry,b.cookie)).status,401);
  assert.equal((await request(endpoint)).body.total,2,"停用账号不自动抹掉公开内容");
  await DB.prepare("UPDATE users SET disabled = 0 WHERE id = ?").bind(b.body.user.id).run();
  await DB.prepare("UPDATE sessions SET expires_at = 0 WHERE user_id = ?").bind(b.body.user.id).run();
  assert.equal((await request("/api/feature-info","POST",entry,b.cookie)).status,401);
  const relogin = await request("/api/auth/login","POST",{username:"info_author_b",password});
  assert.equal((await request(`/api/feature-info/${second.body.item.id}`,"DELETE",{revision:1},relogin.cookie)).status,200);
  assert.equal((await request(`/api/feature-info/${second.body.item.id}`,"DELETE",{revision:1},admin.cookie)).status,404);
  const bulk = await request("/api/auth/register","POST",{username:"info_limits",password});
  for (let i=0;i<5;i++) assert.equal((await request("/api/feature-info","POST",entry,bulk.cookie)).status,201);
  assert.equal((await request("/api/feature-info","POST",entry,bulk.cookie)).status,429);
  await DB.prepare("UPDATE feature_contributions SET created_at = created_at - 120000 WHERE user_id = ?").bind(bulk.body.user.id).run();
  // Exercise the atomic per-feature limit without manufacturing thousands of requests.
  for (let i=5;i<20;i++) await DB.prepare(`INSERT INTO feature_contributions
    (id,feature_type,feature_id,feature_name,lat,lng,user_id,title,content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(`limit-${i}`,feature.type,feature.id,feature.label,feature.lat,feature.lng,
      bulk.body.user.id,"标题","正文",1,1).run();
  assert.equal((await request("/api/feature-info","POST",entry,bulk.cookie)).status,429);
  const many = await request("/api/auth/register","POST",{username:"info_total_limit",password});
  const rows = Array.from({length:1000},(_,i) => DB.prepare(`INSERT INTO feature_contributions
    (id,feature_type,feature_id,feature_name,lat,lng,user_id,title,content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(`total-${i}`,"node",20000+i,"另一个地点",14,152,many.body.user.id,"标题","正文",1,1));
  await DB.batch(rows);
  assert.equal((await request("/api/feature-info","POST",entry,many.cookie)).status,429,"不同要素仍遵守账号总上限");
  assert.equal((await request("/api/account","DELETE",{password},many.cookie)).status,200);
  assert.equal((await request("/api/account","DELETE",{password},bulk.cookie)).status,200);
  assert.equal((await request(endpoint)).body.total,1,"删除账号级联删除作者全部投稿");
  assert.equal((await request(route,"DELETE",{revision:4},admin.cookie)).status,200,"管理员可以删除他人投稿");
  assert.equal((await request(endpoint)).body.total,0);
  const properties = [{key:"name",value:"北城图书馆"},{key:"building:levels",value:"3"},{key:"自定义用途",value:"社区阅读"}];
  const attributePost = await request("/api/feature-info","POST",{feature,properties},admin.cookie);
  assert.equal(attributePost.status,201,"可以只发属性，无需编造标题和简介");
  const attributeId = attributePost.body.item.id, attributeRoute = `/api/feature-info/${attributeId}`;
  assert.equal(attributePost.body.item.title,"属性补充");assert.equal(attributePost.body.item.content,"");
  assert.deepEqual(attributePost.body.item.properties,properties);
  assert.deepEqual((await request(endpoint)).body.items[0].properties,properties,"游客可读取完整的有序属性");
  const nameSearch = await request(`/api/feature-info/search?q=${encodeURIComponent("北城图书馆")}`);
  assert.equal(nameSearch.body.items[0].id,feature.id);assert.equal(nameSearch.body.items[0].sharedNames,"北城图书馆");
  assert.equal((await request(`/api/feature-info/search?q=${encodeURIComponent("building:levels")}`)).body.items[0].id,feature.id);
  const authorProperty = await request("/api/feature-info","POST",{feature,properties:[{key:"name",value:"另一位作者的名称"}]},a.cookie);
  assert.equal(authorProperty.status,201);
  assert.equal((await request(attributeRoute,"PATCH",{title:"",content:"",properties:[{key:"name",value:"被改名"}],revision:1},a.cookie)).status,403);
  const legacyEdit = await request(attributeRoute,"PATCH",{title:"属性说明",content:"说明",revision:1},admin.cookie);
  assert.equal(legacyEdit.status,200);assert.deepEqual(legacyEdit.body.item.properties,properties,"旧客户端未传属性时必须保留原属性");
  const replacement = [{key:"name",value:"新图书馆名称"}];
  const propertyEdits = await Promise.all([
    request(attributeRoute,"PATCH",{properties:replacement,revision:2},admin.cookie),
    request(attributeRoute,"PATCH",{properties:[{key:"name",value:"过期修改"}],revision:2},admin.cookie),
  ]);
  assert.deepEqual(propertyEdits.map(row=>row.status).sort(),[200,409]);
  // Authentication can finish in either order; only the accepted transaction owns the saved values.
  const acceptedIndex=propertyEdits.findIndex(row=>row.status===200);
  const acceptedProperties=[replacement,[{key:"name",value:"过期修改"}]][acceptedIndex];
  assert.equal(propertyEdits[1-acceptedIndex].body.error,"contribution_conflict");
  assert.equal(propertyEdits[acceptedIndex].body.item.revision,3);
  assert.deepEqual((await request(endpoint)).body.items.find(item=>item.id===attributeId).properties,acceptedProperties,"冲突请求不能删除或覆盖已经保存的属性");
  const staleProperties=await request(attributeRoute,"PATCH",{properties:[{key:"name",value:"确定过期的修改"}],revision:2},admin.cookie);
  assert.equal(staleProperties.status,409,"已保存后再到达的旧版本必须拒绝");
  assert.deepEqual((await request(endpoint)).body.items.find(item=>item.id===attributeId).properties,acceptedProperties,"确定过期请求不得删除或替换胜出事务的属性");
  assert.deepEqual((await request(endpoint)).body.items.find(item=>item.id===authorProperty.body.item.id).properties,[{key:"name",value:"另一位作者的名称"}],"同键不同作者的属性不能相互覆盖");
  for (const invalid of [null,{},[{key:"name",value:""}],[{key:"bad key",value:"x"}],
    [{key:"__proto__",value:"x"}],[{key:"name",value:"x",authorId:a.body.user.id}],
    [{key:"name",value:"x"},{key:" name ",value:"y"}],[{key:"a".repeat(81),value:"x"}],
    [{key:"name",value:"x".repeat(513)}],[{key:"name",value:"\u0000"}],
    Array.from({length:33},(_,i)=>({key:`key${i}`,value:"x"}))]) {
    assert.equal((await request("/api/feature-info","POST",{feature,properties:invalid},admin.cookie)).status,400);
  }
  assert.equal((await request(attributeRoute,"PATCH",{properties:[],revision:3},admin.cookie)).status,400,"不能把整条投稿改成空内容");
  const cleared = await request(attributeRoute,"PATCH",{title:"保留简介",content:"只移除本条投稿的属性",properties:[],revision:3},admin.cookie);
  assert.equal(cleared.status,200);assert.deepEqual(cleared.body.item.properties,[]);
  assert.equal((await request(`/api/feature-info/search?q=${encodeURIComponent(acceptedProperties[0].value)}`)).body.items.length,0);
  // Inject a failing SQLite trigger to verify both the text and properties roll back together.
  const rollbackDB = await createLocalPersonalDatabase();
  try {
    const originalDB = env.DB; env.DB = rollbackDB;
    const rollbackUser = await request("/api/auth/register","POST",{username:"rollback_user",password});
    const seed = await request("/api/feature-info","POST",{feature,properties:[{key:"name",value:"原名"}]},rollbackUser.cookie);
    await rollbackDB.prepare(`CREATE TRIGGER reject_property BEFORE INSERT ON feature_contribution_properties
      WHEN NEW.property_value = 'rollback-test' BEGIN SELECT RAISE(ABORT, 'test-rejection'); END`).run();
    const log = console.error;console.error=()=>{};
    try {
      assert.equal((await request(`/api/feature-info/${seed.body.item.id}`,"PATCH",{title:"未保存",properties:[{key:"name",value:"rollback-test"}],revision:1},rollbackUser.cookie)).status,500);
      assert.equal((await request("/api/feature-info","POST",{feature,properties:[{key:"name",value:"rollback-test"}]},rollbackUser.cookie)).status,500);
    } finally {console.error=log;}
    const intact = await request(endpoint);assert.equal(intact.body.total,1);assert.equal(intact.body.items[0].revision,1);
    assert.deepEqual(intact.body.items[0].properties,[{key:"name",value:"原名"}]);
    env.DB = originalDB;
  } finally {rollbackDB.close();}
  const bAgain = await request("/api/auth/login","POST",{username:"info_author_b",password});
  assert.equal((await request(`/api/feature-info/${authorProperty.body.item.id}`,"DELETE",{revision:1},bAgain.cookie)).status,403);
  const moderates = await request(`/api/feature-info/${authorProperty.body.item.id}`,"PATCH",{properties:[{key:"name",value:"管理员校正名"}],revision:1},admin.cookie);
  assert.equal(moderates.status,200);assert.equal(moderates.body.item.author.id,a.body.user.id);
  assert.equal((await request("/api/account","DELETE",{password},admin.cookie)).status,200);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS count FROM feature_contribution_properties WHERE contribution_id = ?").bind(attributeId).first("count"),0,"删账号会级联删属性");
  assert.equal((await request("/api/auth/logout","POST",undefined,a.cookie)).status,200);
  assert.equal((await request("/api/feature-info","POST",entry,a.cookie)).status,401);
  const unavailable = await worker.fetch(new Request(`https://info.test${endpoint}`),{},{});
  assert.equal(unavailable.status,503);
} finally {DB.close();}

// A database created with the old migration must upgrade without losing users.
const directory = await mkdtemp(path.join(tmpdir(),"huayu-info-"));
try {
  const filename = path.join(directory,"legacy.sqlite"), old = new DatabaseSync(filename);
  old.exec(await readFile(new URL("../migrations/0001_personal_data.sql",import.meta.url),"utf8"));
  old.prepare(`INSERT INTO users (id,username,username_normalized,display_name,password_salt,password_hash,password_iterations,created_at,updated_at)
    VALUES ('legacy','legacy','legacy','原用户','salt','hash',100,1,1)`).run(); old.close();
  const existing = new DatabaseSync(filename);
  existing.exec(await readFile(new URL("../migrations/0002_feature_contributions.sql",import.meta.url),"utf8"));
  existing.prepare(`INSERT INTO feature_contributions
    (id,feature_type,feature_id,feature_name,lat,lng,user_id,title,content,created_at,updated_at)
    VALUES ('old-note','way',100,'旧建筑',14,152,'legacy','旧简介','原有内容',1,1)`).run();
  existing.close();
  for (let i=0;i<2;i++) {
    const upgraded = await createLocalPersonalDatabase(filename);
    assert.equal((await upgraded.prepare("SELECT username FROM users WHERE id = 'legacy'").first()).username,"legacy");
    assert.equal((await upgraded.prepare("SELECT content FROM feature_contributions WHERE id = 'old-note'").first()).content,"原有内容");
    if (i === 0) await upgraded.prepare(`INSERT INTO feature_contribution_properties
      (contribution_id,property_key,property_value,position) VALUES ('old-note','name','兼容名称',0)`).run();
    assert.equal((await upgraded.prepare("SELECT property_value FROM feature_contribution_properties WHERE contribution_id = 'old-note'").first()).property_value,"兼容名称");
    upgraded.close();
  }
} finally {await rm(directory,{recursive:true,force:true});}
const [frontend,app] = await Promise.all([readFile(new URL("../site/feature-info.js",import.meta.url),"utf8"),readFile(new URL("../site/app.js",import.meta.url),"utf8")]);
assert.ok(frontend.includes("content.textContent = item.content") && !frontend.includes("innerHTML"),"用户内容必须按文本显示");
assert.ok(app.includes("featureResult: !boundary ? result : null"),"无面几何的地名点也应保留词条身份");
console.log(JSON.stringify({status:"passed",feature:"shared-feature-info",checks:["public-multi-author","typed-identity","author-admin-permissions",
  "cross-origin-and-spoofing","optimistic-concurrency","literal-search","pagination","limits","disabled-expired-logout",
  "account-deletion","legacy-idempotent-migrations","text-only-rendering","property-only-post","typed-property-search",
  "author-property-isolation","legacy-edit-keeps-properties","atomic-property-conflicts-and-rollback","property-validation-and-deletion"]}));
