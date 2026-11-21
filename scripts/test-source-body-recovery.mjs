import assert from 'node:assert/strict';
import {recoverSourceBody} from './lib/source-body-recovery.mjs';
import {fetchCatalogPart} from './update-brand-catalog.mjs';
import '../site/admin-catalog.js';
const query=[];let reads=0;const native=globalThis.fetch,waits=[];
try{
 globalThis.fetch=async(_url,init)=>{query.push(init.body.get('data'));return ++reads<3?new Response('{'):Response.json({osm3s:{timestamp_osm_base:'2026-11-21T03:00:00Z'},elements:[{type:'count',tags:{total:'1'}},{type:'way',id:1,tags:{brand:'测试'}}]});};
 const part=await fetchCatalogPart('brand','way',{wait:async ms=>waits.push(ms)});assert.equal(part.elements.length,2);assert.equal(part.osm3s.timestamp_osm_base,'2026-11-21T03:00:00Z');assert.ok(query.every(q=>q===query[0]));assert.deepEqual(waits,[10000,20000]);
 let permanent=0;globalThis.fetch=async()=>{permanent++;return new Response(null,{status:403});};await assert.rejects(fetchCatalogPart('brand','way',{wait:async()=>assert.fail('never retry denied reads')}),/HTTP_403/u);assert.equal(permanent,1);
}finally{globalThis.fetch=native;}
let persistent=0;await assert.rejects(recoverSourceBody(()=>{persistent++;throw new SyntaxError('truncated');},{wait:async()=>{}}),SyntaxError);assert.equal(persistent,3);
let invalid=0;await assert.rejects(recoverSourceBody(()=>{invalid++;throw Error('INCOMPLETE_CATALOG');},{wait:async()=>assert.fail('semantic failures remain fatal')}),/INCOMPLETE_CATALOG/u);assert.equal(invalid,1);
const C=globalThis.HuayuAdministrativeCatalog,sourceTime='2026-11-21T03:00:00Z';let administrativeReads=0;
const payload={osm3s:{timestamp_osm_base:sourceTime},elements:[{type:'count',tags:{areas:'1',total:'1'}},{type:'relation',id:28652,tags:{boundary:'administrative',admin_level:'2',name:'华夏'},center:{lat:12,lon:150}},{type:'relation',id:10,tags:{boundary:'administrative',admin_level:'4',name:'测试省'},center:{lat:10,lon:150}},{type:'count',tags:{relations:'2',total:'2'}}]};
const loader=new C.Loader({storage:null,fetcher:async()=>++administrativeReads===1?new Response('{'):Response.json(payload)});
const candidate=await recoverSourceBody(()=>loader.live(),{wait:async()=>{}});assert.equal(candidate.sourceTime,sourceTime);assert.equal(administrativeReads,2);
console.log('Catalog body recovery passed: actual brand/admin reads, identical queries, preserved source time, three-attempt truncation bound and fatal permission/count failures.');
