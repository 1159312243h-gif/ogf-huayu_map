import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {inspectGlb} from "../site/model-import/runtime.js";

const input=process.argv[2];
assert.ok(input,"Provide the legally downloaded birch_trees.glb path.");
const original=await readFile(input);
const sourceSha256=createHash("sha256").update(original).digest("hex");
assert.equal(sourceSha256,"8d342a91bf231a7a09fd66697aa07dfa68219e0138b67a60237491aeb6251d5e",
  "This preparation is only for the verified Igor_K. Birch trees download.");
const jsonLength=original.readUInt32LE(12);
const description=JSON.parse(original.subarray(20,20+jsonLength).toString("utf8"));
assert.equal(description.asset.extras.license,"CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)");
assert.ok(description.asset.extras.source.endsWith("de6263e5400b4a52a795decf84f06575"));
const leaves=description.materials.find(material=>material.name==="leaves");
assert.equal(leaves.alphaMode,"BLEND");
// Alpha cutout keeps individual leaves in the shared instanced depth buffer.
leaves.alphaMode="MASK";leaves.alphaCutoff=0.3;
description.asset.extras.huayuPreparation={sourceSha256,
  changes:"Leaf material changed from alpha blending to 0.3 alpha cutout for instanced map depth; geometry and textures unchanged."};
const text=Buffer.from(JSON.stringify(description)),length=Math.ceil(text.length/4)*4;
const binaryChunk=original.subarray(20+jsonLength);
const prepared=Buffer.alloc(20+length+binaryChunk.length,0x20);
prepared.writeUInt32LE(0x46546c67,0);prepared.writeUInt32LE(2,4);prepared.writeUInt32LE(prepared.length,8);
prepared.writeUInt32LE(length,12);prepared.writeUInt32LE(0x4e4f534a,16);text.copy(prepared,20);
binaryChunk.copy(prepared,20+length);
const inspected=inspectGlb(prepared.buffer.slice(prepared.byteOffset,prepared.byteOffset+prepared.byteLength));
const sha256=createHash("sha256").update(prepared).digest("hex");
const directory=new URL("../site/model-import/assets/",import.meta.url);
await mkdir(directory,{recursive:true});
const name=`birch-trees-${sha256.slice(0,12)}.glb`;
await writeFile(new URL(name,directory),prepared);
console.log(JSON.stringify({name,sha256,bytes:prepared.length,sourceSha256,...inspected},null,2));
