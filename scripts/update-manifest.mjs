import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const output = path.join(root, "release", "SHA256.txt");

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

const lines = [];
for (const file of await listFiles(site)) {
  const body = await fs.readFile(file);
  const hash = createHash("sha256").update(body).digest("hex").toUpperCase();
  const relative = path.relative(site, file).split(path.sep).join("/");
  lines.push(`${hash}  ${relative}`);
}

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ manifest: path.relative(root, output), files: lines.length }, null, 2));

