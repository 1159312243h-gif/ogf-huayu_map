import * as THREE from "../three-0.160.1.module.min.js";
import {GLTFLoader} from "./GLTFLoader.js";
import {buildFoliageMipmaps} from "./foliage-mipmaps.js?v=birch-coverage-v1";

export const LIMITS = Object.freeze({bytes:24 * 1024 * 1024, triangles:100000, meshes:24, textures:8, textureSize:2048});
export function inspectGlb(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 28 || buffer.byteLength > LIMITS.bytes)
    throw new Error("GLB 文件需小于 24 MiB，且包含完整模型。");
  const view = new DataView(buffer);
  if (view.getUint32(0,true) !== 0x46546c67 || view.getUint32(4,true) !== 2 || view.getUint32(8,true) !== buffer.byteLength)
    throw new Error("不是完整的 glTF 2.0 GLB 文件。");
  let json;
  for (let offset=12; offset<buffer.byteLength;) {
    if (offset+8>buffer.byteLength) throw new Error("GLB 数据段损坏。");
    const length=view.getUint32(offset,true), type=view.getUint32(offset+4,true);
    if (length%4 || offset+8+length>buffer.byteLength) throw new Error("GLB 数据段长度无效。");
    if (offset===12 && type!==0x4e4f534a) throw new Error("GLB 缺少首个 JSON 数据段。");
    if (type===0x4e4f534a) {
      if (json || length>2*1024*1024) throw new Error("GLB 模型描述过大或重复。");
      json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,offset+8,length)));
    }
    offset+=length+8;
  }
  if (json?.asset?.version !== "2.0") throw new Error("仅支持 glTF 2.0。");
  if ((json.extensionsRequired || []).some(name=>!['KHR_materials_unlit','KHR_texture_transform','KHR_materials_emissive_strength','KHR_mesh_quantization'].includes(name)))
    throw new Error("模型使用暂不支持的压缩或材质扩展，请导出未压缩 GLB。");
  for (const item of [...json.buffers || [],...json.images || []]) {
    if (item.uri && !/^data:(application\/octet-stream|application\/gltf-buffer|image\/(png|jpeg|webp));base64,[a-z0-9+/=\s]+$/iu.test(item.uri))
      throw new Error("模型含外部文件或贴图，请先打包成内嵌贴图的 GLB。");
  }
  if ((json.images || []).some(image=>image.mimeType && !['image/png','image/jpeg','image/webp'].includes(image.mimeType)))
    throw new Error("贴图需使用 PNG、JPEG 或 WebP。");
  if ((json.images?.length || 0)>LIMITS.textures || (json.nodes?.length || 0)>256 || (json.accessors?.length || 0)>512)
    throw new Error("模型节点或贴图过多，请先轻量化。");
  if ((json.accessors || []).some(accessor=>!Number.isSafeInteger(accessor.count) || accessor.count<0 || accessor.count>300000)
    || (json.buffers || []).some(item=>!Number.isSafeInteger(item.byteLength) || item.byteLength<0 || item.byteLength>LIMITS.bytes)
    || (json.bufferViews || []).some(item=>!Number.isSafeInteger(item.byteLength) || item.byteLength<0 || item.byteLength>LIMITS.bytes
      || !Number.isSafeInteger(item.byteOffset ?? 0) || (item.byteOffset ?? 0)<0))
    throw new Error("模型声明的缓冲区或顶点容量超过限制。");
  const visiting=new Set(),visited=new Set(),parents=new Set();
  function visit(index,depth=0) {
    if(!Number.isInteger(index) || !json.nodes?.[index] || visiting.has(index) || depth>64)throw new Error("模型节点层级损坏或过深。");
    if(visited.has(index))return;
    visiting.add(index);for(const child of json.nodes[index].children || []){
      if(parents.has(child))throw new Error("模型节点不能重复挂接。");
      parents.add(child);visit(child,depth+1);
    }
    visiting.delete(index);visited.add(index);
  }
  (json.nodes || []).forEach((_,index)=>visit(index));
  for(const scene of json.scenes || []) {
    if((scene.nodes?.length || 0)>256 || new Set(scene.nodes || []).size!==(scene.nodes?.length || 0))throw new Error("场景节点重复或过多。");
    for(const node of scene.nodes || [])if(!json.nodes?.[node] || parents.has(node))throw new Error("场景根节点无效。");
  }
  let triangles=0, primitives=0;
  for (const mesh of json.meshes || []) for (const primitive of mesh.primitives || []) {
    if ((primitive.mode ?? 4)!==4 || primitive.targets || primitive.extensions?.KHR_draco_mesh_compression)
      throw new Error("仅支持静态三角网格，请先转换压缩、动画或非三角网格。");
    const accessor=json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION];
    if (!Number.isSafeInteger(accessor?.count) || accessor.count<=0) throw new Error("模型缺少有效三角网格。");
    triangles+=Math.ceil(accessor.count/3); primitives++;
  }
  if (!primitives || primitives>LIMITS.meshes || triangles>LIMITS.triangles || json.skins?.length || json.animations?.length)
    throw new Error("模型需为静态模型，最多 24 个网格、10 万个三角面。");
  return {triangles,primitives};
}
export async function parse(buffer) {
  inspectGlb(buffer);
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>{
    if (!/^(blob:|data:)/u.test(url)) throw new Error("不允许模型请求外部资源。");
    return url;
  });
  const gltf=await new GLTFLoader(manager).parseAsync(buffer,"");
  try {
    let meshes=0, triangles=0;
    const textures=new Set();
    gltf.scene.traverse(object=>{
      if (!object.isMesh) return;
      meshes++; triangles+=(object.geometry.index?.count || object.geometry.attributes.position?.count || 0)/3;
      for (const material of [object.material].flat()) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    });
    if (!meshes || meshes>LIMITS.meshes || triangles>LIMITS.triangles) throw new Error("展开后的模型超过网格预算。");
    let textureBytes=0;
    for (const texture of textures) {
      const image=texture.image;
      if (!image || image.width>LIMITS.textureSize || image.height>LIMITS.textureSize) throw new Error("贴图最长边需不超过 2048 像素。");
      textureBytes+=image.width*image.height*4;
    }
    if (textureBytes>32*1024*1024) throw new Error("贴图解码容量过大，请压缩或减少贴图。");
    prepareBirchFoliage(gltf);
    return gltf;
  } catch(error) {disposeScene(gltf.scene); throw error;}
}
function prepareBirchFoliage(gltf) {
  const extras=gltf.asset?.extras;
  if(extras?.huayuPreparation?.sourceSha256!=="8d342a91bf231a7a09fd66697aa07dfa68219e0138b67a60237491aeb6251d5e"
    || !extras.source?.endsWith("de6263e5400b4a52a795decf84f06575"))return;
  const prepared=new Set();
  gltf.scene.traverse(object=>{
    for(const material of [object.material || []].flat()) {
      const texture=material.map;
      if(material.name!=="leaves" || material.transparent || material.alphaTest!==0.3 || !texture || prepared.has(texture))continue;
      const {width,height}=texture.image;
      const canvas=globalThis.OffscreenCanvas ? new OffscreenCanvas(width,height) : document.createElement("canvas");
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext("2d",{willReadFrequently:true});
      context.drawImage(texture.image,0,0);
      const result=buildFoliageMipmaps(context.getImageData(0,0,width,height).data,width,height,
        {alphaTest:material.alphaTest,srgb:texture.colorSpace===THREE.SRGBColorSpace,repeat:texture.wrapS===THREE.RepeatWrapping});
      texture.mipmaps=result.levels.map(level=>new ImageData(level.data,level.width,level.height));
      texture.generateMipmaps=false;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.needsUpdate=true;
      texture.userData.huayuFoliage={algorithm:"birch-coverage-v1",coverage:result.coverage,bytes:result.bytes};
      prepared.add(texture);
    }
  });
}
export function parts(gltf) {
  const result=[{value:"all",label:"完整模型"}];
  function walk(object,path) {
    if (result.length>=65) return;
    if (path && object.name) result.push({value:path,label:object.name.slice(0,80)});
    object.children.forEach((child,index)=>walk(child,path ? `${path}/${index}` : String(index)));
  }
  walk(gltf.scene,"");return result;
}
export function normalizeConfig(value={}) {
  return {up:value.up==="z" ? "z" : "y",yaw:Math.max(-180,Math.min(180,Number(value.yaw)||0)),
    part:typeof value.part==="string" && /^(all|\d+(\/\d+)*)$/u.test(value.part) ? value.part : "all"};
}
export function bundle(gltf,config={}) {
  config=normalizeConfig(config);
  gltf.scene.updateMatrixWorld(true);
  let selected=gltf.scene;
  if (config.part!=="all") for(const index of config.part.split("/")) selected=selected?.children[Number(index)];
  if (!selected) throw new Error("选定的模型部件不存在。");
  const rotation=new THREE.Matrix4().makeRotationZ(config.yaw*Math.PI/180)
    .multiply(new THREE.Matrix4().makeRotationX(config.up==="y" ? Math.PI/2 : 0));
  const pieces=[], bounds=new THREE.Box3();
  try {
    selected.traverse(object=>{
      if (!object.isMesh || !object.visible) return;
      const geometry=object.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(rotation,object.matrixWorld));
      geometry.computeBoundingBox();bounds.union(geometry.boundingBox);
      pieces.push({geometry,material:object.material});
    });
    const size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    if (!pieces.length || ![size.x,size.y,size.z].every(value=>Number.isFinite(value) && value>1e-5))
      throw new Error("模型为空、平面化或尺寸无效。");
    const shift=new THREE.Matrix4().makeTranslation(-center.x,-center.y,-bounds.min.z);
    const scale=new THREE.Matrix4().makeScale(1/size.x,1/size.y,1/size.z);
    for(const piece of pieces) piece.geometry.applyMatrix4(scale.clone().multiply(shift));
    const triangles=pieces.reduce((sum,piece)=>sum+(piece.geometry.index?.count || piece.geometry.attributes.position.count)/3,0);
    return {pieces,triangles,size:size.toArray(),config,dispose(){pieces.forEach(piece=>piece.geometry.dispose());}};
  } catch(error) {pieces.forEach(piece=>piece.geometry.dispose());throw error;}
}
export function disposeScene(scene) {
  const geometry=new Set(),materials=new Set(),textures=new Set();
  scene.traverse(object=>{if(object.geometry) geometry.add(object.geometry);if(object.material) [object.material].flat().forEach(material=>materials.add(material));});
  for(const material of materials) for(const value of Object.values(material)) if(value?.isTexture) textures.add(value);
  geometry.forEach(item=>item.dispose());materials.forEach(item=>item.dispose());
  textures.forEach(item=>{item.dispose();item.mipmaps=[];item.image?.close?.();});
}
export function createPreview(container,gltf,config) {
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#edf1f0');
  container.replaceChildren(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(38,1,0.01,30);
  scene.add(new THREE.HemisphereLight(0xffffff,0x607568,2));
  const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-3,-4,6);scene.add(light);
  camera.up.set(0,0,1);
  let current,group,angle=0.7,pitch=0.5,distance=3.2,alive=true,drag=null;
  const draw=()=>{
    if (!alive) return;
    camera.position.set(Math.cos(angle)*Math.cos(pitch)*distance,Math.sin(angle)*Math.cos(pitch)*distance,0.5+Math.sin(pitch)*distance);
    camera.lookAt(0,0,0.5);renderer.render(scene,camera);
  };
  const resize=new ResizeObserver(()=>{
    const {width,height}=container.getBoundingClientRect();
    renderer.setSize(Math.max(1,width),Math.max(1,height),false);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();draw();
  });
  resize.observe(container);
  const update=value=>{
    const next=bundle(gltf,value);
    if(group) scene.remove(group);current?.dispose();current=next;group=new THREE.Group();
    const maximum=Math.max(...next.size);
    for(const piece of next.pieces) {
      const mesh=new THREE.Mesh(piece.geometry,piece.material);
      mesh.scale.set(next.size[0]/maximum,next.size[1]/maximum,next.size[2]/maximum);group.add(mesh);
    }
    scene.add(group);draw();return next;
  };
  renderer.domElement.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY};renderer.domElement.setPointerCapture(event.pointerId);});
  renderer.domElement.addEventListener('pointermove',event=>{if(!drag)return;angle-=(event.clientX-drag.x)*0.008;pitch=Math.max(-0.2,Math.min(1.3,pitch+(event.clientY-drag.y)*0.008));drag={x:event.clientX,y:event.clientY};draw();});
  renderer.domElement.addEventListener('pointerup',()=>{drag=null;});
  renderer.domElement.addEventListener('wheel',event=>{event.preventDefault();distance=Math.max(1.5,Math.min(7,distance+event.deltaY*0.003));draw();},{passive:false});
  update(config);
  return {update,dispose(){alive=false;resize.disconnect();current?.dispose();renderer.dispose();renderer.forceContextLoss();container.replaceChildren();}};
}
