import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {readGlb,packGlb} from "./prepare-model-candidates.mjs";
import {inspectGlb} from "../site/model-import/runtime.js";
import {fileURLToPath} from "node:url";
import path from "node:path";

export const WALL_CROP=Object.freeze([28,7,40,42,24,48]);
export async function prepareCityWall(original,crop=WALL_CROP) {
const {MeshoptSimplifier}=await import("../.data-update/model-tools/node_modules/meshoptimizer/meshopt_simplifier.module.js");
const sourceSha256=createHash("sha256").update(original).digest("hex");
assert.equal(sourceSha256,"9c702bd1bf54dcbd59f88dbd44b05979f91485157388d2349dacfc2fd3dbcced");
const {json,binary}=readGlb(original);
assert.equal(json.asset.extras.license,"CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)");
function accessor(index) {
  const item=json.accessors[index],view=json.bufferViews[item.bufferView],offset=(view.byteOffset || 0)+(item.byteOffset || 0);
  const channels={SCALAR:1,VEC2:2,VEC3:3}[item.type],count=item.count*channels;
  const size={5126:4,5125:4,5123:2}[item.componentType];
  if(view.byteStride && view.byteStride!==channels*size) {
    const result=item.componentType===5126 ? new Float32Array(count) : new Uint32Array(count);
    for(let i=0;i<item.count;i++)for(let axis=0;axis<channels;axis++) {
      const start=offset+i*view.byteStride+axis*size;
      result[i*channels+axis]=item.componentType===5126 ? binary.readFloatLE(start) : size===4 ? binary.readUInt32LE(start) : binary.readUInt16LE(start);
    }
    return result;
  }
  const bytes=binary.subarray(offset,offset+count*size);
  const copied=Uint8Array.from(bytes).buffer;
  return item.componentType===5126 ? new Float32Array(copied) : item.componentType===5125 ? new Uint32Array(copied) : new Uint16Array(copied);
}
const vertices=json.meshes.reduce((sum,mesh)=>sum+json.accessors[mesh.primitives[0].attributes.POSITION].count,0);
const positions=new Float32Array(vertices*3),attributes=new Float32Array(vertices*5),triangles=[];
let offset=0;
if(crop)assert.ok(crop.length===6 && crop.every(Number.isFinite),"Crop is minX,minY,minZ,maxX,maxY,maxZ in source coordinates.");
for(const mesh of json.meshes)for(const primitive of mesh.primitives) {
  const p=accessor(primitive.attributes.POSITION),n=accessor(primitive.attributes.NORMAL),uv=accessor(primitive.attributes.TEXCOORD_0),indices=accessor(primitive.indices);
  positions.set(p,offset*3);
  for(let i=0;i<p.length/3;i++)attributes.set([n[i*3],n[i*3+1],n[i*3+2],uv[i*2],uv[i*2+1]],(offset+i)*5);
  for(let i=0;i<indices.length;i+=3) {
    const face=[indices[i],indices[i+1],indices[i+2]];
    if(crop && !face.every(index=>[0,1,2].every(axis=>p[index*3+axis]>=crop[axis] && p[index*3+axis]<=crop[axis+3])))continue;
    triangles.push(...face.map(index=>index+offset));
  }
  offset+=p.length/3;
}
assert.ok(triangles.length>0);await MeshoptSimplifier.ready;
let indices=new Uint32Array(triangles),error;
const originalTriangles=indices.length/3;
for(const tolerance of [0.01,0.03,0.1]) {
  [indices,error]=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,attributes,5,[0.1,0.1,0.1,0.1,0.1],null,
    (crop ? 1800 : 15000)*3,tolerance,['Sparse']);
  if(indices.length<=(crop ? 6000 : 50000)*3)break;
}
const [remap,count]=MeshoptSimplifier.compactMesh(indices);
let p=new Float32Array(count*3),n=new Float32Array(count*3),uv=new Float32Array(count*2);
for(let i=0;i<remap.length;i++)if(remap[i]!==0xffffffff) {
  const next=remap[i];p.set(positions.subarray(i*3,i*3+3),next*3);
  n.set(attributes.subarray(i*5,i*5+3),next*3);uv.set(attributes.subarray(i*5+3,i*5+5),next*2);
}
// Source scan uses a downward vertical axis; the original scene also flips Y.
if(crop) {
  for(let i=1;i<p.length;i+=3){p[i]=-p[i];n[i]=-n[i];}
  // Reflection must preserve outward face winding, not just flipped normals.
  for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
  // Close the two cut ends with a hull of the actual boundary cross-section.
  // These faces stay inside the cropped footprint; no surrounding buildings/roads are reconstructed.
  const positions=Array.from(p),normals=Array.from(n),uvs=Array.from(uv),faces=Array.from(indices);
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(const [end,sign] of [[crop[2],-1],[crop[5],1]]) {
    const points=[];
    for(let i=0;i<p.length/3;i++)if(Math.abs(p[i*3+2]-end)<0.3)points.push({x:p[i*3],y:p[i*3+1],i});
    points.sort((a,b)=>a.x-b.x || a.y-b.y);
    const lower=[],upper=[];
    for(const point of points){while(lower.length>1 && cross(lower.at(-2),lower.at(-1),point)<=0)lower.pop();lower.push(point);}
    for(const point of points.slice().reverse()){while(upper.length>1 && cross(upper.at(-2),upper.at(-1),point)<=0)upper.pop();upper.push(point);}
    const hull=lower.slice(0,-1).concat(upper.slice(0,-1)),start=positions.length/3;
    for(const point of hull){positions.push(point.x,point.y,end);normals.push(0,0,sign);uvs.push(uv[point.i*2],uv[point.i*2+1]);}
    for(let i=1;i<hull.length-1;i++)faces.push(start, start+(sign>0 ? i : i+1),start+(sign>0 ? i+1 : i));
  }
  p=new Float32Array(positions);n=new Float32Array(normals);uv=new Float32Array(uvs);indices=new Uint32Array(faces);
}
const output={asset:structuredClone(json.asset),scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Pingyao crenellated wall segment',mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],
  materials:structuredClone(json.materials),textures:structuredClone(json.textures),samplers:structuredClone(json.samplers),
  images:[],bufferViews:[],accessors:[],buffers:[],extensionsUsed:['KHR_materials_unlit']};
const chunks=[];let bytes=0;
function view(data) {
  const padding=(4-bytes%4)%4;if(padding){chunks.push(Buffer.alloc(padding));bytes+=padding;}
  const index=output.bufferViews.length;output.bufferViews.push({buffer:0,byteOffset:bytes,byteLength:data.length});
  chunks.push(data);bytes+=data.length;return index;
}
const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
for(let i=0;i<p.length;i++){const axis=i%3;minimum[axis]=Math.min(minimum[axis],p[i]);maximum[axis]=Math.max(maximum[axis],p[i]);}
for(const [data,type,size,componentType] of [[p,'VEC3',3,5126],[n,'VEC3',3,5126],[uv,'VEC2',2,5126],[indices,'SCALAR',1,5125]]) {
  output.accessors.push({bufferView:view(Buffer.from(data.buffer)),count:data.length/size,componentType,type,
    ...(data===p ? {min:minimum,max:maximum} : {})});
}
for(const image of json.images) {
  const source=json.bufferViews[image.bufferView],start=source.byteOffset || 0;
  output.images.push({mimeType:image.mimeType,bufferView:view(binary.subarray(start,start+source.byteLength))});
}
output.asset.extras.huayuPreparation={sourceSha256,changes:crop ? 'Cropped a single crenellated wall segment, simplified with normal/UV constraints, corrected reflected winding, and capped cut ends from its boundary cross-section. Retained the embedded scan texture and original source; removed surrounding streets, vehicles, lawns and buildings.'
  : 'Simplified complete reference scene for offline review only; not a repeatable map wall.',crop,originalTriangles,triangles:indices.length/3,error};
output.buffers=[{byteLength:bytes}];
const result=packGlb(output,Buffer.concat(chunks));
inspectGlb(result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength));
return {buffer:result,sourceSha256,changes:output.asset.extras.huayuPreparation.changes,bytes:result.length,
  triangles:indices.length/3,bounds:{minimum,maximum},error,crop};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const directory=new URL("../.data-update/model-downloads/",import.meta.url);
  const crop=process.argv[2] ? process.argv[2].split(',').map(Number) : WALL_CROP;
  const {buffer,...info}=await prepareCityWall(await readFile(new URL("pingyao-reference-original.glb",directory)),crop);
  await writeFile(new URL('pingyao-reference.glb',directory),buffer);
  console.log(JSON.stringify(info));
}
