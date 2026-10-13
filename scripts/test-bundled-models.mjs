import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,webcrypto} from "node:crypto";
import vm from "node:vm";
import {inspectGlb} from "../site/model-import/runtime.js";

const options=await readFile(new URL("../site/model-options.js",import.meta.url),"utf8");
const assets=await readFile(new URL("../site/model-assets.js",import.meta.url),"utf8");
const requests=[],handlers=new Map();
let responseMode="missing";
const context=vm.createContext({Blob,AbortSignal,crypto:webcrypto,console:{warn(){}},
  localStorage:{getItem(){return null;},setItem(){}},
  addEventListener(type,handler){handlers.set(type,handler);},dispatchEvent(){},CustomEvent:class{},
  async fetch(url,init){if(url.endsWith('bundled-candidates.json'))return {ok:true,json:async()=>({schema:1,models:[]})};
    requests.push({url,init});return {ok:responseMode!=="missing",
    arrayBuffer:async()=>responseMode==="truncated" ? new ArrayBuffer(1) : new ArrayBuffer(1943404)};},
});
vm.runInContext(assets,context);vm.runInContext(options,context);
const candidate=context.HuayuModelOptions.candidates.find(candidate=>candidate.id==="birch-trees");
assert.equal(candidate.status,"available-file");
assert.ok(Object.isFrozen(candidate.bundled) && Object.isFrozen(candidate.bundled.config));
const buffer=await readFile(new URL(`../site/${candidate.bundled.url}`,import.meta.url));
assert.equal(buffer.length,candidate.bundled.bytes);
assert.equal(createHash("sha256").update(buffer).digest("hex"),candidate.bundled.sha256);
assert.deepEqual(inspectGlb(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)),{triangles:13374,primitives:8});
const json=JSON.parse(buffer.subarray(20,20+buffer.readUInt32LE(12)).toString("utf8"));
assert.equal(json.asset.extras.author,"Igor_K. (https://sketchfab.com/Igor_K.)");
assert.equal(json.asset.extras.license,"CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)");
assert.ok(json.asset.extras.source.endsWith(candidate.uid));
const leaves=json.materials.find(material=>material.name==="leaves");
assert.equal(leaves.alphaMode,"MASK");assert.equal(leaves.alphaCutoff,0.3);
let node={children:json.scenes[json.scene || 0].nodes};
for(const index of candidate.bundled.config.part.split("/"))node=json.nodes[node.children[Number(index)]];
assert.equal(node.name,"birch-1");
const meshNodes=node.children.map(index=>json.nodes[index]);
assert.deepEqual(meshNodes.map(node=>node.name),["birch-1_bark_0","birch-1_leaves_0"]);
assert.equal(meshNodes.reduce((sum,node)=>sum+json.meshes[node.mesh].primitives.reduce((total,p)=>total+json.accessors[p.indices].count/3,0),0),candidate.bundled.triangles);
const credits=await readFile(new URL("../site/model-import/ATTRIBUTION.md",import.meta.url),"utf8");
assert.ok(credits.includes(candidate.uid) && credits.includes(candidate.author) && credits.includes(candidate.licenseUrl));
assert.equal(await context.HuayuModelAssets.init(),false);
assert.equal(requests.length,0,"Default models do not download bundled candidates.");
context.HuayuModelOptions.setSelection("pine","pine-branches");
await context.HuayuModelAssets.activateSelections();
assert.equal(requests.length,0,"Missing candidate files never cause remote downloads.");
context.HuayuModelOptions.setSelection("broadleaf","birch-trees");
assert.equal(context.HuayuModelAssets.state("birch-trees").status,"stored");
assert.equal(context.HuayuModelOptions.getState("broadleaf").effective,"existing");
await context.HuayuModelAssets.activateSelections();
assert.equal(requests.length,1);
assert.equal(requests[0].url,candidate.bundled.url);assert.equal(requests[0].init.credentials,"omit");
assert.equal(context.HuayuModelAssets.state("birch-trees").status,"failed");
assert.equal(context.HuayuModelOptions.getState("broadleaf").effective,"existing");
responseMode="truncated";await context.HuayuModelAssets.prepare("birch-trees");
assert.match(context.HuayuModelAssets.state("birch-trees").record.error,/大小/u);
responseMode="corrupt";await context.HuayuModelAssets.prepare("birch-trees");
assert.match(context.HuayuModelAssets.state("birch-trees").record.error,/完整性/u);
const count=requests.length;context.HuayuModelOptions.reset();
await context.HuayuModelAssets.activateSelections();assert.equal(requests.length,count);
console.log("Bundled birch passed: real GLB, SHA-256, CC BY attribution, single complete tree, depth cutout, lazy local requests and failure fallback without IndexedDB.");
