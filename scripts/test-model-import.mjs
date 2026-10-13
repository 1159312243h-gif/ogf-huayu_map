import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {inspectGlb,parse,bundle,normalizeConfig,disposeScene,LIMITS} from "../site/model-import/runtime.js";

export function fixtureGlb(modify = () => {}) {
  const positions=new Float32Array([
    -0.5,0,-0.5, 0.5,0,-0.5, 0,1,0, 0.5,0,-0.5, 0.5,0,0.5, 0,1,0,
    0.5,0,0.5, -0.5,0,0.5, 0,1,0, -0.5,0,0.5, -0.5,0,-0.5, 0,1,0,
    -0.5,0,-0.5, -0.5,0,0.5, 0.5,0,-0.5, 0.5,0,-0.5, -0.5,0,0.5, 0.5,0,0.5,
  ]);
  const json={asset:{version:"2.0",generator:"Huayu importer regression fixture; not an external candidate"},
    scene:0,scenes:[{nodes:[0]}],nodes:[{name:"Synthetic pyramid",mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],
    materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.82,0.08,0.03,1],roughnessFactor:1,metallicFactor:0}}],
    buffers:[{byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:18,type:"VEC3",min:[-0.5,0,-0.5],max:[0.5,1,0.5]}]};
  modify(json);
  const text=JSON.stringify(json),length=Math.ceil(Buffer.byteLength(text)/4)*4;
  const output=Buffer.alloc(12+8+length+8+positions.byteLength);
  output.writeUInt32LE(0x46546c67,0);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);
  output.writeUInt32LE(length,12);output.writeUInt32LE(0x4e4f534a,16);output.fill(0x20,20,20+length);output.write(text,20);
  output.writeUInt32LE(positions.byteLength,20+length);output.writeUInt32LE(0x004e4942,24+length);
  Buffer.from(positions.buffer).copy(output,28+length);
  return output.buffer.slice(output.byteOffset,output.byteOffset+output.byteLength);
}

if (process.argv[1]?.replaceAll("\\","/").endsWith("test-model-import.mjs")) {
  const glb=fixtureGlb();
  assert.deepEqual(inspectGlb(glb),{triangles:6,primitives:1});
  const gltf=await parse(glb),normalized=bundle(gltf,{up:"y",yaw:45});
  assert.equal(normalized.pieces.length,1);assert.equal(normalized.triangles,6);
  for(const piece of normalized.pieces) {
    piece.geometry.computeBoundingBox();const bounds=piece.geometry.boundingBox;
    assert.ok(Math.abs(bounds.min.z)<1e-6 && Math.abs(bounds.max.z-1)<1e-6);
    assert.ok(Math.abs(bounds.min.x+0.5)<1e-6 && Math.abs(bounds.max.y-0.5)<1e-6);
  }
  assert.equal(bundle(gltf,{up:"z",part:"0"}).pieces.length,1);
  assert.throws(()=>bundle(gltf,{part:"90"}),/不存在/u);
  assert.deepEqual(normalizeConfig({up:"bad",yaw:900,part:"../../../bad"}),{up:"y",yaw:180,part:"all"});
  for(const modify of [
    json=>{json.buffers[0].uri="https://example.com/model.bin";},
    json=>{json.images=[{uri:"file:///C:/model.png"}];},
    json=>{json.images=[{uri:"data:image/svg+xml;base64,PHN2Zz4="}];},
    json=>{json.extensionsRequired=["KHR_draco_mesh_compression"];},
    json=>{json.meshes[0].primitives[0].mode=1;},
    json=>{json.animations=[{}];},
    json=>{json.accessors[0].count=400000;},
    json=>{json.nodes[0].children=[0];},
    json=>{json.buffers[0].byteLength=100000000;},
  ]) assert.throws(()=>inspectGlb(fixtureGlb(modify)));
  assert.throws(()=>inspectGlb(new ArrayBuffer(LIMITS.bytes+1)),/24 MiB/u);
  const damaged=glb.slice(0,glb.byteLength-4);assert.throws(()=>inspectGlb(damaged),/完整/u);
  normalized.dispose();disposeScene(gltf.scene);

  const source=await readFile(new URL("../site/vegetation-models.js",import.meta.url),"utf8");
  const runtime=vm.createContext({localStorage:{getItem:()=>null}});vm.runInContext(source,runtime);
  const api=runtime.HuayuVegetation;
  const items=Array.from({length:500},(_,i)=>({key:String(i),category:i%2 ? "pine" : "broadleaf",group:i ? "woodland" : null}));
  const assets=new Map([["pine",{triangles:10000}],["broadleaf",{triangles:10000}]]),selected=new Set(items.map(item=>item.key));
  const first=api.importedBatches(items,assets,selected),reverse=api.importedBatches(items.slice().reverse(),assets,selected);
  assert.equal(first.keys.size,40);assert.ok(first.keys.has("0"));
  assert.deepEqual([...first.keys].sort(),[...reverse.keys].sort());
  assert.equal(api.importedBatches(items,new Map([["pine",{triangles:20001}]]),selected).keys.size,0);
  assert.equal(api.importedBatches([{key:"a",category:"flowers"}],new Map([["flowers",{triangles:6}]]),new Set(["a"]),false).keys.size,0);
  const assetSource=await readFile(new URL("../site/model-assets.js",import.meta.url),"utf8");
  const blocked=vm.createContext({console,CustomEvent:class{},dispatchEvent(){}});vm.runInContext(assetSource,blocked);
  assert.equal(await blocked.HuayuModelAssets.init(),false);
  await assert.rejects(blocked.HuayuModelAssets.install("birch-trees",{}, {},false),/授权/u);
  assert.equal(blocked.HuayuModelAssets.state("birch-trees").status,"missing");
  const app=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
  assert.ok(app.includes('treeLeafType: String(tags.leaf_type || "")'));
  assert.ok(assetSource.includes('transaction(["metadata","files"],"readwrite")'));
  assert.ok(!/localStorage\.clear/u.test(assetSource));
  assert.equal((assetSource.match(/root\.fetch\(/gu) || []).length,2,"Only the same-origin catalogue and verified model files are fetched.");
  assert.ok(assetSource.includes('if(!record.packaged)return requestValue'));
  assert.ok(assetSource.includes('credentials:"omit"') && assetSource.includes('root.crypto.subtle.digest("SHA-256",buffer)'));
  console.log("Model import passed: GLB validation, no external resources, official loader, axis/parts, atomic storage failure, authorization, stable budgets and unchanged points.");
}
