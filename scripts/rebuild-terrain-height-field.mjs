import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {gzipSync, gunzipSync} from "node:zlib";
import {validateDataset, replaceDatasetsAtomically} from "./update-all-data.mjs";

const require = createRequire(import.meta.url);
const {terrainRuntime, applyTerrainElevationObservations, writeTerrainPreloadChunks, terrainLegacyPacket}
  = require("./data-update/builders/build-terrain-preload.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");

async function fetchObservations(bounds, depth = 0) {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(",");
  const query = `[out:json][timeout:90];node["ele"](${bbox});out body;`;
  try {
    const response = await fetch("https://overpass.opengeofiction.net/api/interpreter", {
      method: "POST", body: new URLSearchParams({data: query}), signal: AbortSignal.timeout(110000)});
    if (!response.ok) throw Error(`OGF elevation HTTP ${response.status}`);
    const data = await response.json();
    if (data.remark || !Array.isArray(data.elements)) throw Error(data.remark || "Incomplete elevation response");
    console.log(`Elevation observations: ${data.elements.length} for ${bbox}`);
    return data.elements;
  } catch (error) {
    if (depth >= 3 || /HTTP (?:401|403|429)/u.test(error.message)) throw error;
    const mid = (bounds.south + bounds.north) / 2;
    return [...await fetchObservations({...bounds, north: mid}, depth + 1),
      ...await fetchObservations({...bounds, south: mid}, depth + 1)];
  }
}

async function main() {
  const original = JSON.parse(gunzipSync(await fs.readFile(path.join(site, "terrain-preload.json.gz"))));
  const manifest = JSON.parse(await fs.readFile(path.join(site, "terrain-preload-manifest.json"), "utf8"));
  if (manifest.contextSnapshot) {
    const context = JSON.parse(gunzipSync(await fs.readFile(path.join(site, manifest.contextSnapshot.url))));
    const all = new Map([...original.features, ...context.features].map(feature => [feature.id, feature]));
    original.features = [...all.values()];
  }
  await fs.mkdir(path.join(root, ".data-update"), {recursive: true});
  const run = await fs.mkdtemp(path.join(root, ".data-update/height-field-"));
  const observations = new Map();
  for (const region of original.coverage) {
    const [[south, west], [north, east]] = region.bounds;
    for (const element of await fetchObservations({south, west, north, east})) observations.set(element.id, element);
  }
  const observedAt = new Date().toISOString();
  // Preserve the geometry's original generation time. Only elevation data was
  // refetched here; regular three-hour rebuilds continue to refresh both.
  await fs.writeFile(path.join(run, "observations.json"), JSON.stringify({observedAt, elements: [...observations.values()]}));
  const runtime = await terrainRuntime(site);
  const payload = applyTerrainElevationObservations(original, [...observations.values()], runtime, observedAt);
  validateDataset("terrain-preload.json.gz", payload);
  const candidate = path.join(run, "candidate");
  await fs.mkdir(candidate, {recursive: true});
  for (const name of ["app.js", "_worker.js", "transit-preload.json", "transit-relations.json", "railway-routing.json",
    "railway-connections.json", "station-access.json", "airports.json"]) await fs.copyFile(path.join(site, name), path.join(candidate, name));
  const nextManifest = await writeTerrainPreloadChunks(candidate, payload);
  const bytes = gzipSync(JSON.stringify(terrainLegacyPacket(payload, nextManifest.contextSnapshot)), {level: 9});
  if (bytes.length >= 25 * 1024 * 1024) throw Error("Terrain snapshot exceeds Pages limit");
  await fs.writeFile(path.join(candidate, "terrain-preload.json.gz"), bytes);
  await fs.mkdir(path.join(run, "baseline"), {recursive: true});
  await fs.copyFile(path.join(root, "release/SHA256.txt"), path.join(run, "baseline/SHA256.txt"));
  await replaceDatasetsAtomically(candidate, run);
  console.log(JSON.stringify({status: "passed", generatedAt: payload.generatedAt, heightField: payload.heightField, run}, null, 2));
}

main().catch(error => {console.error(error); process.exitCode = 1;});
