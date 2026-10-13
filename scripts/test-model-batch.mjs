import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import vm from "node:vm";
import {downloadUrl,verifyMetadata,candidates,startServer,describeGlb} from "./download-model-candidates.mjs";
import {fixtureGlb} from "./test-model-import.mjs";
import {prepareKnownModel,readGlb} from "./prepare-model-candidates.mjs";

const list=await candidates(),pine=list.find(candidate=>candidate.id==='pine-branches');
assert.equal(list.length,9);assert.equal(list.filter(candidate=>candidate.status==='pending-file').length,8);
const valid={uid:pine.uid,isDownloadable:true,license:{slug:'by',url:'https://creativecommons.org/licenses/by/4.0/'}};
assert.equal(verifyMetadata(pine,valid).downloadable,true);
assert.equal(verifyMetadata(pine,{...valid,isDownloadable:false}).downloadable,false);
for(const change of [{uid:'wrong'},{license:{slug:'st',url:'https://sketchfab.com/licenses'}},
  {license:{slug:'by',url:'https://example.org/licenses/by/4.0/'}}])assert.throws(()=>verifyMetadata(pine,{...valid,...change}));
for(const url of ['https://media.sketchfab.com/models/model.glb','https://example.s3.amazonaws.com/asset.glb','https://asset.cloudfront.net/tree.glb'])
  assert.equal(downloadUrl(url).protocol,'https:');
for(const url of ['http://media.sketchfab.com/model.glb','https://127.0.0.1/model.glb','https://sketchfab.com.evil.example/model.glb',
  'https://token@media.sketchfab.com/model.glb','file:///C:/secret','https://example.org/model.glb'])assert.throws(()=>downloadUrl(url));
assert.equal(describeGlb(Buffer.from(fixtureGlb())).inspected.triangles,6);
assert.throws(()=>describeGlb(Buffer.from('<html>invalid</html>')));

const service=await startServer(0);
try {
  const page=await (await fetch(service.origin)).text();
  assert.ok(page.includes('type="password"') && page.includes('autocomplete="off"'));
  assert.ok(!/localStorage|sessionStorage/u.test(page),'Credentials never persist in browser storage.');
  assert.ok(page.includes("input.value=''"));
  const before=await (await fetch(`${service.origin}/batch/status`)).json();
  assert.equal(before.running,false);assert.equal(before.items.length,9);
  assert.equal((await fetch(`${service.origin}/batch/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"token":"invalid"}'})).status,403);
  assert.equal((await fetch(`${service.origin}/batch/start`,{method:'POST',headers:{'Content-Type':'application/json',Origin:service.origin},body:'{"token":"invalid"}'})).status,400);
  assert.equal((await fetch(`${service.origin}/batch/start`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.org'},body:'{}'})).status,403);
  const after=await (await fetch(`${service.origin}/batch/status`)).json();
  assert.equal(after.running,false);assert.ok(!JSON.stringify(after).includes('invalid'));
  assert.equal((await fetch(`${service.origin}/batch/files/not-a-candidate.glb`)).status,404);
} finally {await new Promise(resolve=>service.server.close(resolve));}

const source=await readFile(new URL('../site/model-assets.js',import.meta.url),'utf8');
const options=await readFile(new URL('../site/model-options.js',import.meta.url),'utf8');
const manifest={schema:1,models:[{id:pine.id,uid:pine.uid,category:pine.category,name:'Pine fixture',
  url:'./model-import/assets/pine-fixture.glb',bytes:200,sha256:'a'.repeat(64),triangles:100,primitives:1,
  license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',config:{up:'y',yaw:0,part:'all'}},
  {id:'mrt-exit-01',uid:'998f6532bddd47fcb9c486eee0975c64',category:'metroEntrance',
    url:'./model-import/assets/forbidden.glb',license:'Standard',triangles:1,bytes:200,sha256:'b'.repeat(64),primitives:1,config:{up:'y',part:'all'}}]};
const requests=[];
const context=vm.createContext({AbortSignal,CustomEvent:class{},dispatchEvent(){},addEventListener(){},
  localStorage:{getItem(){return null;}},fetch:async(url,init)=>{requests.push({url,init});return {ok:true,json:async()=>manifest};}});
vm.runInContext(source,context);vm.runInContext(options,context);
await context.HuayuModelAssets.loadCatalog();
assert.equal(context.HuayuModelAssets.state(pine.id).status,'stored');
assert.equal(context.HuayuModelAssets.state('mrt-exit-01').status,'missing','A proprietary candidate cannot be bundled by catalogue injection.');
assert.equal(context.HuayuModelAssets.state(pine.id).record.packaged,true);
assert.equal(context.HuayuModelOptions.getState('pine').effective,'existing','Downloading files never changes user preferences.');
assert.equal(requests.length,1);assert.equal(requests[0].init.credentials,'omit');
assert.equal(context.HuayuModelAssets.state('birch-trees').record.triangles,3414);
await context.HuayuModelAssets.loadCatalog();assert.equal(requests.length,1,'Reuses the same catalogue.');

const actual=JSON.parse(await readFile(new URL('../site/model-import/bundled-candidates.json',import.meta.url),'utf8'));
const attribution=await readFile(new URL('../site/model-import/ATTRIBUTION.md',import.meta.url),'utf8');
const counts={'pine-branches':770,'bush-lods':222,'daisy-flowers':176,'gazebo':1992,
  'nz-bus-shelter':1124,'stone-fountain':2984,'chain-link-fence':300,'column-wall':870};
assert.equal(actual.schema,1);assert.equal(new Set(actual.models.map(model=>model.id)).size,actual.models.length);
for(const [id,count] of Object.entries(counts)) {
  const model=actual.models.find(model=>model.id===id);assert.ok(model,`${id} must be installed.`);
  const file=await readFile(new URL(`../site/${model.url.slice(2)}`,import.meta.url));
  assert.equal(file.length,model.bytes);assert.equal(createHash('sha256').update(file).digest('hex'),model.sha256);
  const {json,binary}=readGlb(file),inspection=describeGlb(file).inspected;
  assert.equal(model.triangles,count);
  if(id==='chain-link-fence') {
    assert.equal(inspection.triangles,3100);assert.equal(model.primitives,1);
    assert.equal(model.config.part,'0/0/0/2','Select one complete panel, never the five-piece pack.');
  } else {assert.equal(inspection.triangles,count);assert.equal(model.primitives,inspection.primitives);}
  assert.ok(json.asset.extras.source.endsWith(model.uid));assert.equal(model.license,'CC BY 4.0');
  assert.ok(attribution.includes(model.source) && attribution.includes(model.author) && attribution.includes(model.sha256));
  for(const view of json.bufferViews)assert.ok((view.byteOffset || 0)+view.byteLength<=binary.length,'All retained buffer references are valid.');
  if(model.changes) {
    assert.equal(model.changes,json.asset.extras.huayuPreparation.changes);
    assert.equal(model.sourceSha256,json.asset.extras.huayuPreparation.sourceSha256);
    assert.ok(attribution.includes(model.changes),'Modified models must disclose their changes.');
    // Locally retained originals allow full preparation and byte-preservation verification; they are intentionally not published.
    let original;
    try {original=await readFile(new URL(`../.data-update/model-downloads/${id}-original.glb`,import.meta.url));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(original) {
      assert.deepEqual(prepareKnownModel(id,original).buffer,file,'Preparation must be reproducible from the retained original.');
      const source=readGlb(original);
      for(const node of json.nodes) {
        const before=source.json.nodes.find(item=>item.name===node.name);assert.ok(before);
        for(const field of ['matrix','translation','rotation','scale'])assert.equal(JSON.stringify(node[field]),JSON.stringify(before[field]));
      }
      const hashes=value=>new Set(value.json.images?.map(image=>{
        const view=value.json.bufferViews[image.bufferView],start=view.byteOffset || 0;
        return createHash('sha256').update(value.binary.subarray(start,start+view.byteLength)).digest('hex');
      }) || []);
      const originalImages=hashes(source);
      for(const hash of hashes({json,binary}))assert.ok(originalImages.has(hash),'Texture bytes remain unchanged.');
      assert.throws(()=>prepareKnownModel(id,Buffer.from(fixtureGlb())),'Unreviewed source revisions cannot be converted automatically.');
    }
  }
  if(id==='bush-lods') {
    assert.equal(json.images.length,6);assert.equal(json.meshes.length,2);
    assert.ok(json.nodes.some(node=>node.name==='Bush_medium_001_LOD0'));
    assert.ok(!json.nodes.some(node=>/LOD[12]|billboard|ground|human/iu.test(node.name)));
    assert.equal(json.materials.find(material=>material.name==='Brunch_material').alphaMode,'MASK');
    assert.equal(json.materials.find(material=>material.name==='Brunch_material').alphaCutoff,0.3);
  } else if(id==='nz-bus-shelter') {
    assert.equal(json.meshes.length,6);assert.ok(json.materials.some(material=>material.alphaMode==='BLEND'));
  } else if(id==='stone-fountain') {
    assert.ok(!json.extensionsUsed.includes('KHR_materials_pbrSpecularGlossiness'));
    assert.equal(json.images.length,5);
    for(const material of json.materials) {
      assert.equal(material.extensions.KHR_materials_specular.specularFactor,0);
      assert.equal(material.pbrMetallicRoughness.metallicFactor,0);
      assert.ok(Number.isInteger(material.pbrMetallicRoughness.baseColorTexture.index));
    }
  }
}
for(const id of ['mrt-exit-01','mrt-exit-02'])assert.ok(!actual.models.some(model=>model.id===id));
const city=actual.models.find(model=>model.id==='pingyao-reference');assert.ok(city);
const wallFile=await readFile(new URL(`../site/${city.url.slice(2)}`,import.meta.url));
assert.equal(wallFile.length,city.bytes);assert.equal(createHash('sha256').update(wallFile).digest('hex'),city.sha256);
const wall=readGlb(wallFile),inspection=describeGlb(wallFile).inspected;
assert.ok(inspection.triangles<6000 && inspection.triangles===city.triangles);
assert.equal(city.config.yaw,90);assert.equal(city.config.part,'all');
assert.deepEqual(wall.json.asset.extras.huayuPreparation.crop,[28,7,40,42,24,48]);
assert.equal(city.sourceSha256,wall.json.asset.extras.huayuPreparation.sourceSha256);
assert.ok(city.changes.includes('capped cut ends') && attribution.includes(city.changes));
console.log('Model batch passed: official gates, 9 verified files, single fence panel, light city-wall segment, attribution, preserved originals and unchanged defaults.');
