import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {gzipSync, gunzipSync} from "node:zlib";
import {validateDataset, replaceDatasetsAtomically} from "./update-all-data.mjs";

const require = createRequire(import.meta.url);
const {writeTerrainPreloadChunks, terrainLegacyPacket}
  = require("./data-update/builders/build-terrain-preload.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");

// Recalculate prepared geometry with the same algorithm as the live mesh
// worker, using the complete existing data. This does not fetch observations
// or change the timestamps that describe the OGF data's age.
async function main() {
  const original = JSON.parse(gunzipSync(await fs.readFile(path.join(site, "terrain-preload.json.gz"))));
  const manifest = JSON.parse(await fs.readFile(path.join(site, "terrain-preload-manifest.json"), "utf8"));
  assert.equal(manifest.generatedAt, original.generatedAt);
  if (manifest.contextSnapshot) {
    const context = JSON.parse(gunzipSync(await fs.readFile(path.join(site, manifest.contextSnapshot.url))));
    assert.equal(context.generatedAt, original.generatedAt);
    original.features = [...new Map([...original.features, ...context.features].map(feature => [feature.id, feature])).values()];
  }
  validateDataset("terrain-preload.json.gz", original);
  await fs.mkdir(path.join(root, ".data-update"), {recursive: true});
  const run = await fs.mkdtemp(path.join(root, ".data-update/material-rebuild-"));
  const candidate = path.join(run, "candidate"), baseline = path.join(run, "baseline");
  await fs.mkdir(candidate, {recursive: true});
  await fs.mkdir(baseline, {recursive: true});
  // Keep the previous immutable assets recoverable after the updater prunes
  // superseded hashes. Existing releases and unrelated changes stay intact.
  for (const directory of ["terrain-preload-chunks", "terrain-render-cache"]) {
    await fs.cp(path.join(site, directory), path.join(baseline, directory), {recursive: true});
  }
  for (const name of ["terrain-preload.json.gz", "terrain-preload-manifest.json"]) {
    await fs.copyFile(path.join(site, name), path.join(baseline, name));
  }
  await fs.copyFile(path.join(root, "release/SHA256.txt"), path.join(baseline, "SHA256.txt"));
  for (const name of ["app.js", "_worker.js", "transit-preload.json", "transit-relations.json", "railway-routing.json",
    "railway-connections.json", "station-access.json", "airports.json"]) {
    await fs.copyFile(path.join(site, name), path.join(candidate, name));
  }
  const nextManifest = await writeTerrainPreloadChunks(candidate, original);
  const bytes = gzipSync(JSON.stringify(terrainLegacyPacket(original, nextManifest.contextSnapshot)), {level: 9});
  assert.ok(bytes.length < 25 * 1024 * 1024, "Terrain snapshot exceeds Pages limit");
  assert.equal(nextManifest.generatedAt, manifest.generatedAt);
  assert.deepEqual(nextManifest.heightField, manifest.heightField);
  await fs.writeFile(path.join(candidate, "terrain-preload.json.gz"), bytes);
  await replaceDatasetsAtomically(candidate, run);
  console.log(JSON.stringify({status: "passed", preparedAt: new Date().toISOString(),
    generatedAt: original.generatedAt, features: original.features.length, heightField: original.heightField, run}, null, 2));
}

main().catch(error => {console.error(error); process.exitCode = 1;});
