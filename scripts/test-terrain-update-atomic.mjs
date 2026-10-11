import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const updater=await fs.readFile(path.join(root,"scripts/update-all-data.mjs"),"utf8");
const declaration=updater.match(/async function replaceDatasetsAtomically\([^]*?\n\}/u)?.[0];
assert.ok(declaration);
await fs.mkdir(path.join(root,".data-update"),{recursive:true});
const directory=await fs.mkdtemp(path.join(root,".data-update/terrain-atomic-test-"));
const site=path.join(directory,"site"),candidate=path.join(directory,"candidate"),run=path.join(directory,"run");
for (const base of [site,candidate]) for (const name of ["terrain-preload-chunks","terrain-render-cache"]) {
  await fs.mkdir(path.join(base,name),{recursive:true});
}
await fs.mkdir(path.join(run,"baseline"),{recursive:true});
// The extracted transaction uses an isolated root and site, never the workspace site.
const testRoot=path.join(directory,"root");
await fs.mkdir(path.join(testRoot,"release"),{recursive:true});
await fs.writeFile(path.join(testRoot,"release/SHA256.txt"),"old inventory");
await fs.writeFile(path.join(run,"baseline/SHA256.txt"),"old inventory");
const manifest=(generation)=>({generatedAt:generation,
  chunks:[{url:`./terrain-preload-chunks/f-${generation}.json.gz`}],
  contextSnapshot:{url:`./terrain-preload-chunks/context-${generation}.json.gz`},
  renderBlocks:[{url:`./terrain-render-cache/r-${generation}.json.gz`}]});
for (const [base,generation] of [[site,"old"],[candidate,"new"]]) {
  await fs.writeFile(path.join(base,"terrain-preload.json.gz"),generation);
  await fs.writeFile(path.join(base,"terrain-preload-manifest.json"),JSON.stringify(manifest(generation)));
  for (const entry of [...manifest(generation).chunks,...manifest(generation).renderBlocks,manifest(generation).contextSnapshot]) {
    await fs.writeFile(path.join(base,entry.url),generation);
  }
}
let rejectValidation=true;
const context=vm.createContext({fs,path,assert,site,root:testRoot,process,
  datasetNames:["terrain-preload.json.gz"],timestampId:()=>"test-transaction",
  runCommand:async label=>{
    if (label!=="verify-package") return;
    const next=JSON.parse(await fs.readFile(path.join(site,"terrain-preload-manifest.json"),"utf8"));
    assert.equal(next.generatedAt,"new");
    for (const entry of [...next.chunks,...next.renderBlocks,next.contextSnapshot]) assert.equal(await fs.readFile(path.join(site,entry.url),"utf8"),"new");
    if (rejectValidation) throw Error("validation rejected");
  }});
vm.runInContext(declaration,context);
await assert.rejects(context.replaceDatasetsAtomically(candidate,run),/validation rejected/u);
assert.equal(await fs.readFile(path.join(site,"terrain-preload.json.gz"),"utf8"),"old");
assert.equal(JSON.parse(await fs.readFile(path.join(site,"terrain-preload-manifest.json"),"utf8")).generatedAt,"old");
assert.equal(await fs.readFile(path.join(site,"terrain-render-cache/r-old.json.gz"),"utf8"),"old");
assert.equal(await fs.readFile(path.join(site,"terrain-preload-chunks/context-old.json.gz"),"utf8"),"old");
rejectValidation=false;
await context.replaceDatasetsAtomically(candidate,run);
assert.equal(await fs.readFile(path.join(site,"terrain-preload.json.gz"),"utf8"),"new");
assert.equal(JSON.parse(await fs.readFile(path.join(site,"terrain-preload-manifest.json"),"utf8")).generatedAt,"new");
await assert.rejects(fs.stat(path.join(site,"terrain-render-cache/r-old.json.gz")),/ENOENT/u);
assert.equal(await fs.readFile(path.join(site,"terrain-render-cache/r-new.json.gz"),"utf8"),"new");
assert.equal(await fs.readFile(path.join(site,"terrain-preload-chunks/context-new.json.gz"),"utf8"),"new");
await assert.rejects(fs.stat(path.join(site,"terrain-preload-chunks/context-old.json.gz")),/ENOENT/u);
console.log("Terrain refresh passed: new data and render assets switch together; validation failure restores the complete old snapshot.");
