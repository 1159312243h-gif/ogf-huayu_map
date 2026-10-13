import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const projectName = process.env.CLOUDFLARE_PAGES_PROJECT || "ogf-atlas";
const databaseName = process.env.CLOUDFLARE_D1_DATABASE || "ogf-atlas-users";
const bucketName = process.env.CLOUDFLARE_R2_BUCKET || "ogf-atlas-user-images";
const adminUsernames = process.env.ADMIN_USERNAMES || "";

if (!accountId || !apiToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
}

const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

async function cloudflare(pathname, options = {}) {
  const response = await fetch(`${apiRoot}${pathname}`, { ...options, headers: { ...headers, ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = payload.errors?.map((item) => item.message).filter(Boolean).join("; ") || response.statusText;
    throw new Error(`Cloudflare ${options.method || "GET"} ${pathname} failed (${response.status}): ${detail}`);
  }
  return payload.result;
}

async function ensureDatabase() {
  const databases = await cloudflare("/d1/database?per_page=100");
  const existing = databases.find((database) => database.name === databaseName);
  return existing || cloudflare("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: databaseName }),
  });
}

async function ensureBucket() {
  const response = await fetch(`${apiRoot}/r2/buckets/${encodeURIComponent(bucketName)}`, {
    method: "PUT",
    headers,
  });
  if (response.ok || response.status === 409) return;
  const payload = await response.json().catch(() => ({}));
  const detail = payload.errors?.map((item) => item.message).filter(Boolean).join("; ") || response.statusText;
  throw new Error(`Cloudflare R2 bucket creation failed (${response.status}): ${detail}`);
}

async function applyMigration(databaseId) {
  const sql = await fs.readFile(path.join(root, "migrations", "0001_personal_data.sql"), "utf8");
  const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await cloudflare(`/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: statement }),
    });
  }
}

async function configurePages(databaseId) {
  const project = await cloudflare(`/pages/projects/${encodeURIComponent(projectName)}`);
  const current = project.deployment_configs?.production || {};
  const production = {
    ...current,
    d1_databases: { ...(current.d1_databases || {}), DB: { id: databaseId } },
    r2_buckets: { ...(current.r2_buckets || {}), USER_IMAGES: { name: bucketName } },
  };
  if (adminUsernames) {
    production.env_vars = {
      ...(current.env_vars || {}),
      ADMIN_USERNAMES: { type: "plain_text", value: adminUsernames },
    };
  }
  await cloudflare(`/pages/projects/${encodeURIComponent(projectName)}`, {
    method: "PATCH",
    body: JSON.stringify({ deployment_configs: { production } }),
  });
}

const database = await ensureDatabase();
await ensureBucket();
await applyMigration(database.uuid);
await configurePages(database.uuid);

console.log(JSON.stringify({
  status: "configured",
  projectName,
  databaseName,
  databaseId: database.uuid,
  bucketName,
  administratorBootstrapConfigured: Boolean(adminUsernames),
}, null, 2));
