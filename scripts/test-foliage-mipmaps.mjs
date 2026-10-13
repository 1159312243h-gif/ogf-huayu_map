import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildFoliageMipmaps,alphaCoverage} from "../site/model-import/foliage-mipmaps.js";

const width=64,height=32,pixels=new Uint8ClampedArray(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const offset=(y*width+x)*4;
  pixels.set([18,130,45,(x*17+y*31)%19<3 ? 255 : 0],offset);
}
const original=pixels.slice(),result=buildFoliageMipmaps(pixels,width,height);
assert.deepEqual(pixels,original,"Preparing mipmaps must not modify the source pixels.");
assert.deepEqual(result.levels[0].data,original,"Level zero remains the original texture.");
assert.deepEqual(result.levels.map(level=>[level.width,level.height]),[[64,32],[32,16],[16,8],[8,4],[4,2],[2,1],[1,1]]);
assert.equal(result.bytes,result.levels.reduce((total,level)=>total+level.width*level.height*4,0));
for(const level of result.levels.slice(1)) {
  const coverage=alphaCoverage(level.data,level.width,level.height,0.3);
  assert.ok(coverage>0,"Nonempty leaves must not vanish from coarse mipmaps.");
  if(level.width>=16)assert.ok(Math.abs(coverage-result.coverage)<0.03,`Coverage drift at ${level.width}: ${coverage}`);
  for(let i=0;i<level.data.length;i+=4)if(level.data[i+3])
    assert.deepEqual([...level.data.slice(i,i+3)],[18,130,45],"Transparent pixels must not darken leaf colors.");
}
assert.deepEqual(buildFoliageMipmaps(pixels,width,height),result,"Preparation is deterministic.");

const sparse=new Uint8ClampedArray(32*32*4);sparse.set([8,155,42,255]);
const sparseResult=buildFoliageMipmaps(sparse,32,32);
assert.ok(sparseResult.levels.at(-1).data[3]>=77,"Sub-byte averages still preserve nonempty coarse leaves.");
assert.ok(sparseResult.levels[1].data[3]>0);
assert.ok(sparseResult.levels[1].data.slice(7).every((value,index)=>index%4!==0 || value===0),
  "Genuinely empty texels stay transparent.");
assert.equal(sparse[3],255);
const empty=buildFoliageMipmaps(new Uint8ClampedArray(8*4*4),8,4);
assert.equal(empty.coverage,0);assert.ok(empty.levels.every(level=>level.data.every(value=>value===0)));
const solid=new Uint8ClampedArray(16*4);solid.fill(255);
assert.ok(buildFoliageMipmaps(solid,4,4).levels.every(level=>alphaCoverage(level.data,level.width,level.height,0.3)===1));
const mixed=new Uint8ClampedArray([255,0,0,255,0,0,255,255]);
assert.deepEqual([...buildFoliageMipmaps(mixed,2,1).levels[1].data],[188,0,188,255],"Resample color in linear space.");
assert.deepEqual([...buildFoliageMipmaps(mixed,2,1,{srgb:false}).levels[1].data],[128,0,128,255]);
const odd=new Uint8ClampedArray(3*5*4);odd.set([15,90,25,255],odd.length-4);
assert.ok(buildFoliageMipmaps(odd,3,5).levels.at(-1).data[3]>=77,"Odd sizes keep the final row and column.");
assert.equal(buildFoliageMipmaps(pixels,width,height,{repeat:false}).levels.length,7);
for(const args of [[pixels,0,height],[pixels,width,0],[pixels,width+1,height],
  [pixels,width,height,{alphaTest:0}],[pixels,width,height,{alphaTest:NaN}]])assert.throws(()=>buildFoliageMipmaps(...args));

const runtime=await readFile(new URL("../site/model-import/runtime.js",import.meta.url),"utf8");
const assets=await readFile(new URL("../site/model-assets.js",import.meta.url),"utf8");
assert.ok(runtime.includes('prepareBirchFoliage(gltf)') && runtime.includes('prepared.has(texture)'));
assert.ok(runtime.includes('extras?.huayuPreparation?.sourceSha256') && runtime.includes('material.name!=="leaves"'));
assert.ok(runtime.includes('texture.generateMipmaps=false') && runtime.includes('item.mipmaps=[]'));
assert.ok(assets.includes('runtime.js?v=birch-coverage-v1'),"The existing runtime cache must be invalidated.");
console.log("Foliage mipmaps passed: stable alpha coverage, nonempty coarse leaves, transparent gaps, linear alpha-weighted colors, unchanged source and one-time scoped preparation.");
