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
const [index, app, personal, workerSource, migration, configure, verifyOnline] = await Promise.all([
  fs.readFile(path.join(site, "index.html"), "utf8"),
  fs.readFile(path.join(site, "app.js"), "utf8"),
  fs.readFile(path.join(site, "personal-data.js"), "utf8"),
  fs.readFile(path.join(site, "_worker.js"), "utf8"),
  fs.readFile(path.join(root, "migrations", "0001_personal_data.sql"), "utf8"),
  fs.readFile(path.join(root, "scripts", "configure-cloudflare-personal-data.mjs"), "utf8"),
  fs.readFile(path.join(root, "scripts", "verify-online.mjs"), "utf8"),
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

class OverlayTestDatabase {
  constructor() {
    this.overlays = new Map();
    this.blobs = new Map();
    this.usageOverride = null;
  }

  prepare(sql) {
    const database = this;
    const normalized = sql.replace(/\s+/gu, " ").trim();
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        if (normalized.includes("FROM sessions JOIN users")) {
          return {
            id: "user-1", username: "tester", username_normalized: "tester",
            display_name: "Tester", role: "user", disabled: 0, created_at: 1,
          };
        }
        if (normalized.includes("COUNT(*) AS total")) {
          if (database.usageOverride) return database.usageOverride;
          return {
            total: database.overlays.size,
            bytes: [...database.overlays.values()].reduce((sum, item) => sum + item.byte_size, 0),
          };
        }
        if (normalized.includes("JOIN image_overlay_blobs")) {
          const item = database.overlays.get(this.values[0]);
          if (!item || item.user_id !== this.values[1]) return null;
          return { ...item, image_data: database.blobs.get(item.id) };
        }
        if (normalized.startsWith("SELECT id FROM image_overlays")) {
          const item = database.overlays.get(this.values[0]);
          return item?.user_id === this.values[1] ? { id: item.id } : null;
        }
        throw new Error(`Unexpected first(): ${normalized}`);
      },
      async run() {
        if (normalized.startsWith("INSERT INTO image_overlays")) {
          const [id, userId, name, objectKey, mimeType, byteSize, west, south, east, north,
            opacity, createdAt, updatedAt] = this.values;
          database.overlays.set(id, {
            id, user_id: userId, name, object_key: objectKey, mime_type: mimeType,
            byte_size: byteSize, west, south, east, north, opacity, visible: 1,
            created_at: createdAt, updated_at: updatedAt,
          });
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO image_overlay_blobs")) {
          database.blobs.set(this.values[0], Array.from(new Uint8Array(this.values[1])));
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM image_overlay_blobs WHERE overlay_id =")) {
          database.blobs.delete(this.values[0]);
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM image_overlays WHERE id =")) {
          const item = database.overlays.get(this.values[0]);
          if (item?.user_id === this.values[1]) database.overlays.delete(this.values[0]);
          return { success: true };
        }
        throw new Error(`Unexpected run(): ${normalized}`);
      },
    };
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function authenticatedRequest(pathname, init = {}) {
  return new Request(`https://example.test${pathname}`, {
    ...init,
    headers: { Cookie: "huayu_session=test-session", ...(init.headers || {}) },
  });
}

const overlayDatabase = new OverlayTestDatabase();
const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const overlayForm = new FormData();
overlayForm.set("image", new Blob([pngSignature], { type: "image/png" }), "pixel.png");
overlayForm.set("name", "Test overlay");
overlayForm.set("opacity", "0.75");
overlayForm.set("west", "148");
overlayForm.set("south", "12");
overlayForm.set("east", "149");
overlayForm.set("north", "13");
const uploadResponse = await worker.fetch(authenticatedRequest("/api/overlays", {
  method: "POST", body: overlayForm,
}), { DB: overlayDatabase }, {});
assert.equal(uploadResponse.status, 201);
const uploaded = (await uploadResponse.json()).overlay;
assert.equal(overlayDatabase.overlays.size, 1);
assert.equal(overlayDatabase.blobs.size, 1);

const imageResponse = await worker.fetch(authenticatedRequest(uploaded.imageUrl), { DB: overlayDatabase }, {});
assert.equal(imageResponse.status, 200);
assert.equal(imageResponse.headers.get("Content-Type"), "image/png");
assert.deepEqual(new Uint8Array(await imageResponse.arrayBuffer()), pngSignature);

overlayDatabase.usageOverride = { total: 20, bytes: 0 };
const limitedResponse = await worker.fetch(authenticatedRequest("/api/overlays", {
  method: "POST", body: overlayForm,
}), { DB: overlayDatabase }, {});
assert.equal(limitedResponse.status, 409);
assert.equal((await limitedResponse.json()).error, "overlay_limit_reached");
overlayDatabase.usageOverride = null;

const deleteResponse = await worker.fetch(authenticatedRequest(`/api/overlays/${uploaded.id}`, {
  method: "DELETE",
}), { DB: overlayDatabase }, {});
assert.equal(deleteResponse.status, 200);
assert.equal(overlayDatabase.overlays.size, 0);
assert.equal(overlayDatabase.blobs.size, 0);

for (const table of ["users", "sessions", "search_history", "favorites", "image_overlays", "image_overlay_blobs"]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"), `迁移缺少 ${table}`);
}
assert.match(migration, /username_normalized TEXT NOT NULL UNIQUE/u);
assert.match(migration, /user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/u);
assert.match(migration, /object_key TEXT NOT NULL UNIQUE/u);
assert.match(migration, /image_data BLOB NOT NULL/u);
assert.ok(workerSource.includes("PERSONAL_MAX_IMAGE_BYTES = 768 * 1024")
  && workerSource.includes("PERSONAL_MAX_OVERLAY_BYTES = 10 * 1024 * 1024")
  && workerSource.includes("PERSONAL_MAX_OVERLAYS = 20")
  && workerSource.includes("INSERT INTO image_overlay_blobs")
  && !workerSource.includes("environment.USER_IMAGES"),
"贴图必须使用有单图、总容量和数量限制的 D1 私有存储");
assert.ok(!configure.includes("/r2/") && !configure.includes("USER_IMAGES"),
  "个人数据部署不能要求开通 R2 或绑定付款方式");
assert.ok(configure.includes("const failOpen = current.fail_open ?? currentPreview.fail_open ?? true")
  && configure.includes("deployment_configs: { production, preview }"),
"Pages 配置必须保持生产与预览环境的 fail_open 值一致");
assert.ok(workerSource.includes("PERSONAL_PASSWORD_ITERATIONS = 100000"),
  "PBKDF2 迭代次数必须兼容 Cloudflare Workers 的运行上限");
assert.ok(verifyOnline.includes("healthcheck_missing_")
  && verifyOnline.includes('assert.equal(authResponse.status, 401'),
"生产检查必须实际执行密码哈希和 D1 用户查询");

for (const id of ["account-view", "login-form", "register-form", "overlays-view", "overlay-upload-form", "admin-users"]) {
  assert.ok(index.includes(`id="${id}"`), `页面缺少 ${id}`);
}
assert.ok(index.includes("personal-data.js?v=7.1-huayu-personal-data-v4"));
assert.ok(app.includes('new CustomEvent("huayu:personal-data-changed"')
  && app.includes("window.HuayuPersonalData?.isPickingBounds()")
  && app.includes("applyPersonalDataSnapshot"),
"现有收藏、搜索和地图点击必须接入账号同步与贴图框选");
assert.ok(personal.includes('credentials: "same-origin"')
  && personal.includes("window.L.imageOverlay")
  && personal.includes("/api/personal/sync")
  && personal.includes("/api/admin/users")
  && personal.includes("prepareOverlayImage")
  && personal.includes("OVERLAY_STORED_MAX_BYTES = 768 * 1024"),
"个人数据前端必须使用同源会话并支持贴图与用户管理");

console.log(JSON.stringify({ status: "passed", feature: "personal-data" }, null, 2));
