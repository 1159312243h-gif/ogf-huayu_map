import assert from 'node:assert/strict';
import transport from './data-update/builders/terrain-request.cjs';
const {requestTerrainElements}=transport;
const query='[out:json][timeout:120];way(id:1,2);out body geom;',elements=[{type:'way',id:1},{type:'way',id:2}];
const waits=[],signals=new Set(),queries=[];let calls=0,cancelled=0;
const result=await requestTerrainElements(query,'fixture',{wait:async ms=>waits.push(ms),fetch:async(_url,init)=>{calls++;signals.add(init.signal);queries.push(init.body.get('data'));return calls<=5?new Response(new ReadableStream({cancel(){cancelled++;}}),{status:429}):Response.json({elements});}});
assert.deepEqual(result,elements);assert.deepEqual(waits,[30000,60000,90000,120000,120000]);assert.equal(calls,6);assert.equal(signals.size,6);assert.equal(cancelled,5);assert.ok(queries.every(q=>q===query));
let exhausted=0;await assert.rejects(requestTerrainElements(query,'limited',{wait:async()=>{},fetch:async()=>{exhausted++;return new Response('busy',{status:429});}}),/HTTP 429/u);assert.equal(exhausted,6);
const instructed=[];let instructedCalls=0;await requestTerrainElements(query,'hint',{wait:async ms=>instructed.push(ms),fetch:async()=>++instructedCalls===1?new Response('busy',{status:429,headers:{'Retry-After':'90'}}):Response.json({elements})});assert.deepEqual(instructed,[90000]);
let excessive=0;await assert.rejects(requestTerrainElements(query,'excess',{wait:async()=>{throw Error('must not sleep');},fetch:async()=>{excessive++;return new Response('busy',{status:429,headers:{'Retry-After':'600'}});}}),/bounded retry/u);assert.equal(excessive,1);
let incomplete=0;const recovery=[];assert.deepEqual(await requestTerrainElements(query,'broken',{wait:async ms=>recovery.push(ms),fetch:async(_url,init)=>{assert.equal(init.body.get('data'),query);return ++incomplete===1?new Response('{"elements":['):Response.json({elements});}}),elements);assert.equal(incomplete,2);assert.deepEqual(recovery,[10000]);
let broken=0;await assert.rejects(requestTerrainElements(query,'always-broken',{wait:async()=>{},fetch:async()=>{broken++;return new Response('{');}}),SyntaxError);assert.equal(broken,2);
for(const status of [401,403,400]){let rejected=0;await assert.rejects(requestTerrainElements(query,'permanent',{fetch:async()=>{rejected++;return new Response(null,{status});}}),new RegExp('HTTP '+status));assert.equal(rejected,1);}
await assert.rejects(requestTerrainElements(query,'remark',{fetch:async()=>Response.json({elements,remark:'runtime error: Query timed out'})}),/Query timed out/u);
console.log('Terrain request recovery passed: bounded 429 cooldown, cancelled bodies, fresh deadlines, identical query retry and permanent/incomplete rejection.');
