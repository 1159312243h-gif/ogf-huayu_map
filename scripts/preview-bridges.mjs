import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {reviewFixtures} from "./bridge-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site"), port = Number(process.argv[2] || 4181);
const types = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json"};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let body, type;
    if (url.pathname === "/fixtures.json") { body = JSON.stringify(reviewFixtures); type = "application/json"; }
    else {
      const target = url.pathname === "/" ? path.join(root, "scripts", "bridge-preview.html")
        : path.resolve(site, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      if (url.pathname !== "/" && !target.startsWith(`${site}${path.sep}`)) throw new Error("Invalid path");
      body = await readFile(target); type = types[path.extname(target)] || "application/octet-stream";
    }
    response.writeHead(200, {"Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store"}); response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(port, "127.0.0.1", () => console.log(`Local bridge review: http://127.0.0.1:${port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
