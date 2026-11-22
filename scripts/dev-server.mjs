import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const port = Math.max(1, Math.min(65535, Number(process.argv[2] || process.env.PORT || 4178)));
let personalDatabase = null;
if (process.argv.includes("--personal-data") || process.argv.includes("--personal-data-memory")) {
  const {createLocalPersonalDatabase} = await import("./lib/local-personal-db.mjs");
  const localDataDirectory = path.join(root, ".data-update");
  await fs.mkdir(localDataDirectory, {recursive:true});
  personalDatabase = await createLocalPersonalDatabase(process.argv.includes("--personal-data-memory") ? ":memory:" : path.join(localDataDirectory, "local-personal-data.sqlite"));
}
const publicLogoPreview = process.argv.includes("--public-logos-system-network")
  ? (await import("./lib/public-logo-preview.mjs")).createPublicLogoPreview() : null;
const cache = new Map();
globalThis.caches = {
  default: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) { cache.set(request.url, response.clone()); },
  },
};

const worker = (await import("../site/_worker.js")).default;
const contentTypes = new Map([
  [".css", "text/css; charset=UTF-8"],
  [".html", "text/html; charset=UTF-8"],
  [".js", "text/javascript; charset=UTF-8"],
  [".json", "application/json; charset=UTF-8"],
  [".glb", "model/gltf-binary"],
  [".md", "text/markdown; charset=UTF-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=UTF-8"],
]);

async function staticResponse(request) {
  const url = new URL(request.url);
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(site, relative);
  if (file !== site && !file.startsWith(`${site}${path.sep}`)) return new Response("Forbidden", { status: 403 });
  try {
    const body = await fs.readFile(file);
    const terrainPreload = relative === "terrain-preload.json.gz";
    const terrainEtag = terrainPreload ? `"${createHash("sha256").update(body).digest("hex")}"` : null;
    if (terrainEtag && request.headers.get("If-None-Match") === terrainEtag) {
      return new Response(null, {status: 304, headers: {ETag: terrainEtag,
        "Cache-Control": "public, max-age=300, must-revalidate"}});
    }
    return new Response(body, {
      status: 200,
      headers: terrainPreload ? {"Content-Type": "application/json; charset=UTF-8",
        "Content-Encoding": "gzip", "Cache-Control": "public, max-age=300, must-revalidate", ETag: terrainEtag}
        : { "Content-Type": contentTypes.get(path.extname(file).toLocaleLowerCase()) || "application/octet-stream" },
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return new Response("Not found", { status: 404 });
    throw error;
  }
}

const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort());
  outgoing.once("close", () => { if (!outgoing.writableFinished) controller.abort(); });
  try {
    const origin = `http://${incoming.headers.host || `127.0.0.1:${port}`}`;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(incoming.url || "/", origin), {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method || "GET") ? undefined : body,
      signal: controller.signal,
    });
    const pending = [];
    const response = await publicLogoPreview?.(request) || await worker.fetch(request, { ASSETS: { fetch: staticResponse }, ...(personalDatabase ? {DB:personalDatabase} : {}), ...Object.fromEntries(["MAP_AGENT_API_KEY","MAP_AGENT_MODEL","MAP_AGENT_BASE_URL","MAP_AGENT_ALLOW_GUESTS","MAP_AGENT_PROTOCOL"].filter(key=>process.env[key]).map(key=>[key,process.env[key]])) }, {
      waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (incoming.method === "HEAD") { await response.body?.cancel(); outgoing.end(); }
    else if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
    Promise.allSettled(pending).catch(() => {});
  } catch (error) {
    if (outgoing.headersSent || outgoing.destroyed) { outgoing.destroy(); return; }
    outgoing.writeHead(500, { "Content-Type": "application/json; charset=UTF-8" });
    outgoing.end(JSON.stringify({ error: "local_worker_failure", message: String(error?.message || error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Huayu Map development server: http://127.0.0.1:${port}/`);
  if (personalDatabase) console.log("Local account preview enabled. Local accounts and data are separate from Cloudflare production.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {personalDatabase?.close();process.exit(0);}));
}
