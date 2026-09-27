import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const port = Math.max(1, Math.min(65535, Number(process.argv[2] || process.env.PORT || 4178)));
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
  [".md", "text/markdown; charset=UTF-8"],
  [".png", "image/png"],
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
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": contentTypes.get(path.extname(file).toLocaleLowerCase()) || "application/octet-stream" },
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return new Response("Not found", { status: 404 });
    throw error;
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${incoming.headers.host || `127.0.0.1:${port}`}`;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(incoming.url || "/", origin), {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method || "GET") ? undefined : body,
    });
    const pending = [];
    const response = await worker.fetch(request, { ASSETS: { fetch: staticResponse } }, {
      waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (incoming.method === "HEAD") outgoing.end();
    else outgoing.end(Buffer.from(await response.arrayBuffer()));
    Promise.allSettled(pending).catch(() => {});
  } catch (error) {
    outgoing.writeHead(500, { "Content-Type": "application/json; charset=UTF-8" });
    outgoing.end(JSON.stringify({ error: "local_worker_failure", message: String(error?.message || error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Huayu Map development server: http://127.0.0.1:${port}/`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
