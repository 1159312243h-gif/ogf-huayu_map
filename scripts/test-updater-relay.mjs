import assert from 'node:assert/strict';
import worker from '../site/_worker.js';
import relayClient from './data-update/builders/updater-relay.cjs';
import network from './data-update/builders/overpass-network.cjs';
const nativeFetch=globalThis.fetch,repo='1159312243h-gif/ogf-huayu_map',aud='https://ogf-atlas.pages.dev/data-update';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'local-maintenance-key',alg:'RS256',use:'sig'};
const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const now=Math.floor(Date.now()/1000);
const claims={iss:'https://token.actions.githubusercontent.com',aud,repository:repo,repository_id:'1390670617',event_name:'workflow_dispatch',ref:'refs/heads/main',sub:'repo:'+repo+':ref:refs/heads/main',workflow_ref:repo+'/.github/workflows/data-refresh.yml@refs/heads/main',iat:now,nbf:now-5,exp:now+300};
async function jwt(overrides={},header={}){const a=enc({alg:'RS256',kid:jwk.kid,...header}),b=enc({...claims,...overrides});const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(a+'.'+b));return a+'.'+b+'.'+Buffer.from(sig).toString('base64url');}
const valid=await jwt(),query='[out:json][timeout:10];rel(28652);out count;';
const raw=JSON.stringify({osm3s:{timestamp_osm_base:'2026-11-20T08:00:00Z'},elements:[{type:'count',tags:{total:'1'}}]});
let sourceCalls=0,keyCalls=0,mode='normal';
const source='https://overpass.opengeofiction.net/api/interpreter';
function request(token=valid,body={query},signal){return new Request('https://ogf-atlas.pages.dev/api/data-update/source',{method:'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:JSON.stringify(body),signal});}
const run=req=>worker.fetch(req,{ASSETS:{fetch:async()=>new Response(null,{status:404})}},{waitUntil(){}});
try{
 globalThis.fetch=async(url,init)=>{
  if(url==='https://token.actions.githubusercontent.com/.well-known/jwks'){keyCalls++;assert.equal(init.redirect,'error');return new Response(JSON.stringify({keys:[jwk]}));}
  assert.equal(url,source,'the maintenance route cannot select another upstream');sourceCalls++;assert.equal(init.body.get('data'),query);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('authorization'),false);
  if(mode==='rate')return new Response(null,{status:429,headers:{'Retry-After':'90'}});
  if(mode==='hold')return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));
  if(mode==='oversize'){let n=0;return new Response(new ReadableStream({pull(c){if(n++<65)c.enqueue(new Uint8Array(1024*1024));else c.close();}}));}
  return new Response(raw);
 };
 assert.equal((await run(request(null))).status,401);assert.equal(sourceCalls,0);assert.equal(keyCalls,0);
 assert.equal((await run(new Request('https://ogf-atlas.pages.dev/api/data-update/source'))).status,405);
 for(const bad of [{aud:'https://other.test'},{repository:'other/repo'},{repository_id:'1'},{ref:'refs/pull/1/merge'},{event_name:'pull_request_target'},{sub:'repo:'+repo+':pull_request'},{workflow_ref:repo+'/.github/workflows/untrusted.yml@refs/heads/main'},{exp:now-1},{iat:now+100},{nbf:now+100},{iss:'https://other.test'}])assert.equal((await run(request(await jwt(bad)))).status,403);
 assert.equal((await run(request(await jwt({}, {alg:'none'})))).status,403);assert.equal((await run(request(await jwt({}, {jku:'https://other.test/key'})))).status,403);
 const badSig=valid.slice(0,valid.lastIndexOf('.')+1)+('a'+valid.slice(valid.lastIndexOf('.')+2));assert.equal((await run(request(badSig))).status,403);
 const unknown=await jwt({}, {kid:'unknown-key'});
 const r=await run(request());assert.equal(r.status,200);assert.equal(r.headers.get('x-huayu-source-route'),'github-oidc');assert.equal(r.headers.get('cache-control'),'no-store, no-transform');
 assert.equal(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text(),raw,'compression must preserve every original byte and source time');
 const beforeUnknown=keyCalls;for(let i=0;i<5;i++)assert.equal((await run(request(unknown))).status,403);assert.equal(keyCalls,beforeUnknown,'unknown key storms must share the key refresh cooldown');
 assert.equal((await run(request(valid,{query,upstream:'https://other.test'}))).status,400);assert.equal((await run(request(valid,{query:'invalid'}))).status,400);
 mode='rate';const rate=await run(request());assert.equal(rate.status,429);assert.equal(rate.headers.get('retry-after'),'90');
 mode='hold';const c=new AbortController(),a=await run(request(valid,{query},c.signal)),b=await run(request());assert.equal((await run(request())).status,429);c.abort();mode='normal';const afterAbort=await run(request());assert.equal(afterAbort.status,200);await afterAbort.body.cancel();await a.body.cancel().catch(()=>{});await b.body.cancel().catch(()=>{});
 mode='oversize';const large=await run(request());await assert.rejects(large.arrayBuffer());mode='normal';const recovery=await run(request());assert.equal(recovery.status,200);await recovery.body.cancel();
 let time=Date.now(),identities=0,relays=0;
 const environment={ACTIONS_ID_TOKEN_REQUEST_URL:'https://token.actions.githubusercontent.com/request?api-version=2',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'local-runner-secret'};
 const client=relayClient.createRelayFetcher({environment,now:()=>time,fetcher:async(url,init)=>{
  if(url.startsWith(environment.ACTIONS_ID_TOKEN_REQUEST_URL)){identities++;assert.equal(new URL(url).searchParams.get('audience'),aud);assert.equal(init.headers.Authorization,'Bearer local-runner-secret');assert.equal(init.redirect,'error');return new Response(JSON.stringify({value:valid}));}
  assert.equal(url,'https://ogf-atlas.pages.dev/api/data-update/source');relays++;assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).query,query);assert.equal(init.headers.Authorization,'Bearer '+valid);return new Response(raw);
 }});
 for(let i=0;i<2;i++)assert.equal((await client(source,{method:'POST',body:new URLSearchParams({data:query})})).status,200);assert.equal(identities,1);assert.equal(relays,2);
 await assert.rejects(client('https://other.test/api/interpreter',{method:'POST'}));await assert.rejects(client(source,{method:'POST',headers:{Authorization:'private'},body:new URLSearchParams({data:query})}));
 assert.equal(identities,1);assert.equal(relays,2);
 time+=241000;assert.equal((await client(source,{method:"POST",body:new URLSearchParams({data:query})})).status,200);assert.equal(identities,2,"long builds must renew short-lived job identity");
 const previousRelay=process.env.OGF_UPDATER_RELAY;
 try{process.env.OGF_UPDATER_RELAY='1';let ordinary=0;globalThis.fetch=async url=>{ordinary++;assert.equal(url,'https://opengeofiction.net/api/0.6/way/1/full.json');return new Response('original API');};
  assert.equal(await (await network.fetchWithRetry('https://opengeofiction.net/api/0.6/way/1/full.json')).text(),'original API');assert.equal(ordinary,1);
 }finally{if(previousRelay===undefined)delete process.env.OGF_UPDATER_RELAY;else process.env.OGF_UPDATER_RELAY=previousRelay;}
 console.log(JSON.stringify({status:'passed',checks:['actual routed GitHub RSA identity verification','immutable repository and main workflow scope','no anonymous arbitrary source queries','unchanged gzip bytes and source timestamps','bounded streams, concurrency and cancellation','client token memory reuse and pinned credential routes'],keyCalls,sourceCalls}));
}finally{globalThis.fetch=nativeFetch;}
