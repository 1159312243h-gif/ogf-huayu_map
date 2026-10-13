import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inspectGlb} from "../site/model-import/runtime.js";

const sources=Object.freeze({
  "bush-lods":"fc18d1d08489713e5b519a529f42e00641f274978e4b1312db64684a2fa507d2",
  "nz-bus-shelter":"3c9ce6e22b7d68f488be65d8836dda117568b2d6f107d29d545c8b6437ab9051",
  "stone-fountain":"5f9bafb1157f35658fbf29458d8f4b74402106f6761c01eb78b7cbaa87c8c1c9",
});
export function readGlb(buffer) {
  assert.equal(buffer.readUInt32LE(0),0x46546c67);
  assert.equal(buffer.readUInt32LE(4),2);
  assert.equal(buffer.readUInt32LE(8),buffer.length);
  assert.equal(buffer.readUInt32LE(16),0x4e4f534a);
  const length=buffer.readUInt32LE(12),offset=20+length;
  assert.equal(buffer.readUInt32LE(offset+4),0x004e4942);
  const json=JSON.parse(buffer.subarray(20,offset).toString("utf8"));
  const binary=buffer.subarray(offset+8,offset+8+buffer.readUInt32LE(offset));
  assert.equal(json.buffers.length,1);assert.ok(!json.buffers[0].uri);
  return {json,binary};
}
export function packGlb(json,binary) {
  const text=Buffer.from(JSON.stringify(json)),jsonLength=Math.ceil(text.length/4)*4,binLength=Math.ceil(binary.length/4)*4;
  const buffer=Buffer.alloc(28+jsonLength+binLength);
  buffer.writeUInt32LE(0x46546c67,0);buffer.writeUInt32LE(2,4);buffer.writeUInt32LE(buffer.length,8);
  buffer.writeUInt32LE(jsonLength,12);buffer.writeUInt32LE(0x4e4f534a,16);
  buffer.fill(0x20,20,20+jsonLength);text.copy(buffer,20);
  buffer.writeUInt32LE(binLength,20+jsonLength);buffer.writeUInt32LE(0x004e4942,24+jsonLength);
  binary.copy(buffer,28+jsonLength);return buffer;
}
// Retain only referenced data, with original transforms, vertex bytes and embedded image bytes.
function compact(json,binary,allowedNodes) {
  const lists={},maps={},chunks=[];let byteLength=0;
  function copy(kind,index,update) {
    if(index===undefined)return undefined;
    maps[kind] ||= new Map();lists[kind] ||= [];
    if(maps[kind].has(index))return maps[kind].get(index);
    assert.ok(json[kind]?.[index],`Missing ${kind}[${index}]`);
    const item=structuredClone(json[kind][index]),next=lists[kind].length;
    maps[kind].set(index,next);lists[kind].push(item);update?.(item);return next;
  }
  const view=index=>copy("bufferViews",index,item=>{
    assert.equal(item.buffer,0);
    const start=item.byteOffset || 0,end=start+item.byteLength;
    assert.ok(start>=0 && end<=binary.length);
    const padding=(4-byteLength%4)%4;
    if(padding){chunks.push(Buffer.alloc(padding));byteLength+=padding;}
    item.byteOffset=byteLength;chunks.push(binary.subarray(start,end));byteLength+=item.byteLength;
  });
  const accessor=index=>copy("accessors",index,item=>{
    if(item.bufferView!==undefined)item.bufferView=view(item.bufferView);
    if(item.sparse){item.sparse.indices.bufferView=view(item.sparse.indices.bufferView);item.sparse.values.bufferView=view(item.sparse.values.bufferView);}
  });
  const texture=index=>copy("textures",index,item=>{
    item.source=copy("images",item.source,image=>{
      assert.ok(!image.uri,"Prepared models require embedded images.");image.bufferView=view(image.bufferView);
    });
    if(item.sampler!==undefined)item.sampler=copy("samplers",item.sampler);
    assert.ok(!item.extensions,"Unexpected texture extension.");
  });
  function textures(item) {
    for(const [key,value] of Object.entries(item)) {
      if(!value || typeof value!=="object")continue;
      if(key.endsWith("Texture") && Number.isInteger(value.index))value.index=texture(value.index);
      else textures(value);
    }
  }
  const material=index=>copy("materials",index,textures);
  const mesh=index=>copy("meshes",index,item=>{
    item.primitives=item.primitives.filter(primitive=>(primitive.mode ?? 4)===4);
    for(const primitive of item.primitives) {
      for(const key of Object.keys(primitive.attributes))primitive.attributes[key]=accessor(primitive.attributes[key]);
      if(primitive.indices!==undefined)primitive.indices=accessor(primitive.indices);
      if(primitive.material!==undefined)primitive.material=material(primitive.material);
      assert.ok(!primitive.targets && !primitive.extensions,"Unexpected mesh deformation or extension.");
    }
  });
  function retained(index) {
    if(allowedNodes && !allowedNodes.has(index))return false;
    const node=json.nodes[index];
    return (node.mesh!==undefined && json.meshes[node.mesh].primitives.some(p=>(p.mode ?? 4)===4))
      || (node.children || []).some(retained);
  }
  const node=index=>copy("nodes",index,item=>{
    if(item.children)item.children=item.children.filter(retained).map(node);
    if(item.mesh!==undefined)item.mesh=mesh(item.mesh);
  });
  const result={asset:structuredClone(json.asset),scene:0,scenes:[{
    ...structuredClone(json.scenes[json.scene ?? 0]),nodes:json.scenes[json.scene ?? 0].nodes.filter(retained).map(node),
  }]};
  Object.assign(result,lists);result.buffers=[{byteLength}];
  const used=new Set();
  function extensions(item) {
    if(!item || typeof item!=="object")return;
    if(item.extensions)Object.keys(item.extensions).forEach(key=>used.add(key));
    Object.values(item).forEach(extensions);
  }
  extensions(result);
  if(used.size)result.extensionsUsed=[...used];
  const required=(json.extensionsRequired || []).filter(name=>used.has(name));
  if(required.length)result.extensionsRequired=required;
  return packGlb(result,Buffer.concat(chunks));
}
export function prepareKnownModel(id,buffer) {
  if(!Object.hasOwn(sources,id))return {buffer,changes:null};
  const sourceSha256=createHash("sha256").update(buffer).digest("hex");
  assert.equal(sourceSha256,sources[id],"Original model changed: review before applying model-specific preparation.");
  const {json,binary}=readGlb(buffer);
  assert.equal(json.asset.extras.license,"CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)");
  let allowedNodes,changes;
  if(id==="bush-lods") {
    assert.equal(json.nodes[66].name,"Bush_medium_001_LOD0");
    assert.deepEqual(json.nodes[66].children,[67,68]);
    allowedNodes=new Set([0,1,2,63,66,67,68]);
    const foliage=json.materials[json.meshes[37].primitives[0].material];
    assert.equal(foliage.alphaMode,"BLEND");foliage.alphaMode="MASK";foliage.alphaCutoff=0.3;
    changes="Extracted complete Bush_medium_001_LOD0 (bark and foliage), retaining ancestor transforms, geometry and six referenced textures. Removed other plants, LODs, billboards, ground and human reference. Foliage uses 0.3 alpha cutout for shared map depth.";
  } else if(id==="nz-bus-shelter") {
    assert.deepEqual([...new Set(json.meshes.flatMap(m=>m.primitives.map(p=>p.mode)))].sort(),[1,4]);
    changes="Removed four auxiliary line-only drawing meshes. Retained all six triangle surface meshes, transforms, colors and glass transparency; no shelter surfaces or supports removed.";
  } else {
    assert.deepEqual(json.extensionsRequired,["KHR_materials_pbrSpecularGlossiness"]);
    for(const material of json.materials) {
      const spec=material.extensions.KHR_materials_pbrSpecularGlossiness;
      assert.deepEqual(spec.specularFactor,[0,0,0]);assert.ok(!spec.specularGlossinessTexture);
      material.pbrMetallicRoughness={baseColorFactor:spec.diffuseFactor,baseColorTexture:spec.diffuseTexture,
        metallicFactor:0,roughnessFactor:1-spec.glossinessFactor};
      // These five materials have zero specular reflectance; preserve it explicitly, rather than discarding the required extension.
      material.extensions={KHR_materials_specular:{specularFactor:0}};
    }
    changes="Converted five legacy specular/glossiness materials with zero specular reflectance to metallic/roughness plus KHR_materials_specular (specularFactor=0). Kept diffuse factors/textures, transparency, geometry, water and original transforms; roughness=1-glossiness. No texture or geometry simplification.";
  }
  json.asset.extras.huayuPreparation={sourceSha256,changes};
  const prepared=compact(json,binary,allowedNodes);
  const inspected=inspectGlb(prepared.buffer.slice(prepared.byteOffset,prepared.byteOffset+prepared.byteLength));
  return {buffer:prepared,changes,sourceSha256,...inspected};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const directory=new URL("../.data-update/model-downloads/",import.meta.url);
  for(const id of Object.keys(sources)) {
    const {buffer,...info}=prepareKnownModel(id,await readFile(new URL(`${id}-original.glb`,directory)));
    await writeFile(new URL(`${id}.glb`,directory),buffer);
    await writeFile(new URL(`${id}-preparation.json`,directory),`${JSON.stringify({...info,bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex")},null,2)}\n`);
    console.log(JSON.stringify({id,bytes:buffer.length,triangles:info.triangles,primitives:info.primitives}));
  }
}
