import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {prepareTrafficRender} from './lib/traffic-render-probe.mjs';
const source=await readFile(new URL('../site/traffic-simulation.js',import.meta.url),'utf8');
const frozen=JSON.parse(await readFile(new URL('./fixtures/traffic-render-baseline.json',import.meta.url),'utf8'));
for(const expected of frozen.cases){
 const probe=prepareTrafficRender(source,expected.options);probe.run();const actual=probe.capture();
 const {uploadBytes,...geometry}=actual;
 assert.deepEqual(geometry,expected.geometry,'unchanged actual car matrices, colours, selected marker, bridge height and pick coordinates');
 assert.equal(uploadBytes,actual.drawn*51*4,'upload only the three matrices and body colours that are actually drawn');
 assert.ok(uploadBytes<=1200*51*4);probe.dispose();
}
const ctx=vm.createContext({});vm.runInContext(await readFile(new URL('../site/traffic-surfaces.js',import.meta.url),'utf8'),ctx);
const S=ctx.HuayuTrafficSurfaces,plans=[{heights:[5,9],samples:[{coordinate:[0,0],roadId:42,width:9},{coordinate:[.001,0],roadId:42,width:9}]}],surface=S.index(plans);
const baseline={...surface,roadIds:null};let reads=0;const get=surface.cells.get.bind(surface.cells);surface.cells.get=key=>{reads++;return get(key);};
for(const id of ['missing',null,undefined,'42',42])for(const x of [-.001,0,.0005,.001,.002]){
 const car={roadId:id,elevated:id===42||id==='42',phase:'edge',roadWidth:12};
 const a=JSON.parse(JSON.stringify(S.vehicle(surface,car,[x,0],3))),b=JSON.parse(JSON.stringify(S.vehicle(baseline,car,[x,0],3)));
 assert.deepEqual(a,b,'numeric/string road identities, ground fallback, absent deck and fitted narrow bridge stay identical');
}
reads=0;for(let i=0;i<1000;i++)assert.equal(S.locate(surface,'unrelated',[i/100000,0]),null);
assert.equal(reads,0,'unrelated ground roads must not scan bridge grid cells');
console.log('Traffic render passed: frozen full-buffer geometry parity, selected/pick/bridge rules and bounded active-prefix uploads.');
