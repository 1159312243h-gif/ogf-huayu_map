import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, {
  hashPassword,
  parseCookie,
  validateOverlayBounds,
  validatePassword,
  validateUsername,
  validImageSignature,
} from "../site/_worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const [index, app, personal, migration] = await Promise.all([
  fs.readFile(path.join(site, "index.html"), "utf8"),
  fs.readFile(path.join(site, "app.js"), "utf8"),
  fs.readFile(path.join(site, "personal-data.js"), "utf8"),
  fs.readFile(path.join(root, "migrations", "0001_personal_data.sql"), "utf8"),
]);

assert.equal(validateUsername("  测试_user-7  "), "测试_user-7");
assert.equal(validateUsername("ab"), null);
assert.equal(validateUsername("bad name"), null);
assert.equal(validatePassword("long-enough"), true);
assert.equal(validatePassword("short"), false);
assert.deepEqual(validateOverlayBounds({ west: 148, south: 12, east: 149, north: 13 }),
  { west: 148, south: 12, east: 149, north: 13 });
assert.equal(validateOverlayBounds({ west: 140, south: 10, east: 171, north: 11 }), null,
  "贴图范围不得横跨超过 30 经度");
assert.equal(validateOverlayBounds({ west: 149, south: 12, east: 148, north: 13 }), null);
assert.equal(validImageSignature(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/png"), true);
assert.equal(validImageSignature(new TextEncoder().encode("<script>bad</script>"), "image/png"), false,
  "不能只信任浏览器声明的图片 MIME");

const salt = "00112233445566778899aabbccddeeff";
const firstHash = await hashPassword("correct horse battery", salt, 1000);
const secondHash = await hashPassword("correct horse battery", salt, 1000);
const wrongHash = await hashPassword("different password", salt, 1000);
assert.equal(firstHash, secondHash, "相同密码和盐必须生成稳定哈希");
assert.notEqual(firstHash, wrongHash, "不同密码不得生成相同哈希");
assert.equal(parseCookie(new Request("https://example.test", {
  headers: { Cookie: "theme=day; huayu_session=abc%20123; x=y" },
}), "huayu_session"), "abc 123");

const missingBindings = await worker.fetch(new Request("https://example.test/api/auth/session"), {}, {});
assert.equal(missingBindings.status, 503);
assert.equal((await missingBindings.json()).error, "personal_data_service_not_configured");

for (const table of ["users", "sessions", "search_history", "favorites", "image_overlays"]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"), `迁移缺少 ${table}`);
}
assert.match(migration, /username_normalized TEXT NOT NULL UNIQUE/u);
assert.match(migration, /user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/u);
assert.match(migration, /object_key TEXT NOT NULL UNIQUE/u);

for (const id of ["account-view", "login-form", "register-form", "overlays-view", "overlay-upload-form", "admin-users"]) {
  assert.ok(index.includes(`id="${id}"`), `页面缺少 ${id}`);
}
assert.ok(index.includes("personal-data.js?v=7.1-huayu-personal-data-v1"));
assert.ok(app.includes('new CustomEvent("huayu:personal-data-changed"')
  && app.includes("window.HuayuPersonalData?.isPickingBounds()")
  && app.includes("applyPersonalDataSnapshot"),
"现有收藏、搜索和地图点击必须接入账号同步与贴图框选");
assert.ok(personal.includes('credentials: "same-origin"')
  && personal.includes("window.L.imageOverlay")
  && personal.includes("/api/personal/sync")
  && personal.includes("/api/admin/users"),
"个人数据前端必须使用同源会话并支持贴图与用户管理");

console.log(JSON.stringify({ status: "passed", feature: "personal-data" }, null, 2));
