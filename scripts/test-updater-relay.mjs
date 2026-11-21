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
  if(url==='https://token.actions.githubusercontent.com/.well-known/jwks'){keyCalls++;assert.equal(init.redirect,'manual');return new Response(JSON.stringify({keys:[jwk]}));}
  assert.equal(new URL(url).origin+new URL(url).pathname,source,'the maintenance route cannot select another upstream');sourceCalls++;assert.equal(init.method==='POST'?init.body.get('data'):new URL(url).searchParams.get('data'),query);assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('authorization'),false);
  if(mode==='rate')return new Response(null,{status:429,headers:{'Retry-After':'90'}});
  if(mode==='hold')return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));
  if(mode==='oversize'){let n=0;return new Response(new ReadableStream({pull(c){if(n++<65)c.enqueue(new Uint8Array(1024*1024));else c.close();}}));}
  return new Response(raw);
 };
 assert.equal((await run(request(null))).status,401);assert.equal(sourceCalls,0);assert.equal(keyCalls,0);
 assert.equal((await run(new Request('https://ogf-atlas.pages.dev/api/data-update/source'))).status,405);
 for(const bad of [{aud:'https://other.test'},{repository:'other/repo'},{repository_id:'1'},{ref:'refs/pull/1/merge'},{event_name:'pull_request_target'},{sub:'repo:'+repo+':pull_request'},{workflow_ref:repo+'/.github/workflows/untrusted.yml@refs/heads/main'},{exp:now-1},{iat:now+100},{nbf:now+100},{iss:'https://other.test'}])assert.equal((await run(request(await jwt(bad)))).status,403);
 assert.equal((await run(request(await jwt({}, {alg:'none'})))).status,403);assert.equal((await run(request(await jwt({}, {jku:'https://other.test/key'})))).status,403);
 const signatureStart=valid.lastIndexOf('.')+1;const badSig=valid.slice(0,signatureStart)+(valid[signatureStart]==='a'?'b':'a')+valid.slice(signatureStart+1);assert.equal((await run(request(badSig))).status,403);
 const unknown=await jwt({}, {kid:'unknown-key'});
 const r=await run(request());assert.equal(r.status,200);assert.equal(r.headers.get('x-huayu-source-route'),'github-oidc');assert.equal(r.headers.get('cache-control'),'no-store, no-transform');
 assert.equal(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text(),raw,'compression must preserve every original byte and source time');
 const immutableSubject='repo:1159312243h-gif@249743200/ogf-huayu_map@1390670617:ref:refs/heads/main';
 const immutableResponse=await run(request(await jwt({sub:immutableSubject})));assert.equal(immutableResponse.status,200);await immutableResponse.body.cancel();
 for(const sub of [immutableSubject.replace('@249743200/','@1/'),immutableSubject.replace('@1390670617:', '@1:'),
   immutableSubject.replace('refs/heads/main','refs/heads/other'),immutableSubject.replace('ogf-huayu_map@','other@')])
  assert.equal((await run(request(await jwt({sub})))).status,403,'other immutable identities must remain rejected');
 const beforeUnknown=keyCalls;for(let i=0;i<5;i++)assert.equal((await run(request(unknown))).status,403);assert.equal(keyCalls,beforeUnknown,'unknown key storms must share the key refresh cooldown');
 assert.equal((await run(request(valid,{query,upstream:'https://other.test'}))).status,400);assert.equal((await run(request(valid,{query:'invalid'}))).status,400);
 mode='rate';const rate=await run(request());assert.equal(rate.status,429);assert.equal(rate.headers.get('retry-after'),'90');
 mode='hold';const c=new AbortController(),a=await run(request(valid,{query},c.signal)),b=await run(request());assert.equal((await run(request())).status,429);c.abort();mode='normal';const afterAbort=await run(request());assert.equal(afterAbort.status,200);await afterAbort.body.cancel();await a.body.cancel().catch(()=>{});await b.body.cancel().catch(()=>{});
 mode='oversize';const large=await run(request());await assert.rejects(large.arrayBuffer());mode='normal';const recovery=await run(request());assert.equal(recovery.status,200);await recovery.body.cancel();
 let time=Date.now(),identities=0,relays=0;const identityDiagnostics=[];
 const environment={ACTIONS_ID_TOKEN_REQUEST_URL:'https://token.actions.githubusercontent.com/request?api-version=2',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'local-runner-secret'};
 const client=relayClient.createRelayFetcher({environment,now:()=>time,onIdentity:info=>identityDiagnostics.push(info),fetcher:async(url,init)=>{
  if(url.startsWith(environment.ACTIONS_ID_TOKEN_REQUEST_URL)){identities++;assert.equal(new URL(url).searchParams.get('audience'),aud);assert.equal(init.headers.Authorization,'Bearer local-runner-secret');assert.equal(init.redirect,'error');return new Response(JSON.stringify({value:valid}));}
  assert.equal(url,'https://ogf-atlas.pages.dev/api/data-update/source');relays++;assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).query,query);assert.equal(init.headers.Authorization,'Bearer '+valid);return new Response(raw);
 }});
 for(let i=0;i<2;i++)assert.equal((await client(source,{method:'POST',body:new URLSearchParams({data:query})})).status,200);assert.equal(identities,1);assert.equal(relays,2);
 await assert.rejects(client('https://other.test/api/interpreter',{method:'POST'}));await assert.rejects(client(source,{method:'POST',headers:{Authorization:'private'},body:new URLSearchParams({data:query})}));
 assert.equal(identities,1);assert.equal(relays,2);
 time+=241000;assert.equal((await client(source,{method:"POST",body:new URLSearchParams({data:query})})).status,200);assert.equal(identities,2,"long builds must renew short-lived job identity");
 assert.equal(identityDiagnostics.length,2);assert.equal(identityDiagnostics[0].repositoryId,claims.repository_id);
 assert.equal(JSON.stringify(identityDiagnostics).includes(valid),false);assert.equal(JSON.stringify(identityDiagnostics).includes("local-runner-secret"),false);
 const previousRelay=process.env.OGF_UPDATER_RELAY;
 try{process.env.OGF_UPDATER_RELAY='1';let ordinary=0;globalThis.fetch=async url=>{ordinary++;assert.equal(url,'https://opengeofiction.net/api/0.6/way/1/full.json');return new Response('original API');};
  assert.equal(await (await network.fetchWithRetry('https://opengeofiction.net/api/0.6/way/1/full.json')).text(),'original API');assert.equal(ordinary,1);
 }finally{if(previousRelay===undefined)delete process.env.OGF_UPDATER_RELAY;else process.env.OGF_UPDATER_RELAY=previousRelay;}
 console.log(JSON.stringify({status:'passed',checks:['actual routed GitHub RSA identity verification','immutable repository and main workflow scope','no anonymous arbitrary source queries','unchanged gzip bytes and source timestamps','bounded streams, concurrency and cancellation','client token memory reuse and pinned credential routes'],keyCalls,sourceCalls}));
}finally{globalThis.fetch=nativeFetch;}

// Production edge fallback still verifies the exact signed job, using only a fresh deployment trust asset.
const {validateUpdaterKeys}=await import('./update-updater-keys.mjs');
const bundle={source:'https://token.actions.githubusercontent.com/.well-known/jwks',fetchedAt:new Date().toISOString(),keys:[jwk]};
assert.equal((await validateUpdaterKeys(bundle)).keys.length,1);
for(const bad of [{...bundle,source:'https://other.test/keys'},{...bundle,fetchedAt:'2000-01-01T00:00:00Z'},
 {...bundle,keys:[{...jwk,d:'private'}]},{...bundle,keys:[jwk,jwk]}])await assert.rejects(validateUpdaterKeys(bad));
try{
 let freshSourceCalls=0;
 globalThis.fetch=async(url,init)=>{
  if(url==='https://token.actions.githubusercontent.com/.well-known/jwks')throw new TypeError('fetch failed');
  assert.equal(new URL(url).origin+new URL(url).pathname,source);freshSourceCalls++;return new Response(raw);
 };
 const fallbackWorker=(await import('../site/_worker.js?fresh-jwks-fallback')).default;
 const environment={ASSETS:{fetch:async req=>{assert.equal(new URL(req.url).pathname,'/updater-jwks.json');return new Response(JSON.stringify(bundle));}}};
 const good=await fallbackWorker.fetch(request(await jwt({sub:'repo:1159312243h-gif@249743200/ogf-huayu_map@1390670617:ref:refs/heads/main'})),environment,{});
 assert.equal(good.status,200);await good.body.cancel();assert.equal(freshSourceCalls,1);
 const invalid=await fallbackWorker.fetch(request(valid.slice(0,valid.lastIndexOf('.')+1)+Buffer.alloc(256).toString('base64url')),environment,{});
 assert.equal(invalid.status,403);assert.equal(freshSourceCalls,1,'bundled public keys cannot sign or bypass an identity');
 let n=0;for(const bad of [{...bundle,source:'https://other.test'},{...bundle,fetchedAt:'2000-01-01T00:00:00Z'},{...bundle,keys:[jwk,jwk]}]){
  const isolated=(await import('../site/_worker.js?bad-jwks-fallback-'+n++)).default;
  assert.equal((await isolated.fetch(request(),{ASSETS:{fetch:async()=>new Response(JSON.stringify(bad))}},{})).status,503);
 }
 assert.equal(freshSourceCalls,1);
 console.log('Updater public-key fallback passed: actual Worker signatures, official source, seven-day expiry, no private keys or arbitrary trust and source requests remain protected.');
}finally{globalThis.fetch=nativeFetch;}

try{
 let posts=0,gets=0;
 globalThis.fetch=async(url,init)=>{
  if(url==='https://token.actions.githubusercontent.com/.well-known/jwks')return new Response(JSON.stringify({keys:[jwk]}));
  assert.equal(new Headers(init.headers).has('authorization'),false);assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
  if(init.method==='GET'){gets++;assert.equal(new URL(url).origin+new URL(url).pathname,source);assert.equal(new URL(url).searchParams.get('data'),query);throw new TypeError('fetch failed');}
  posts++;assert.equal(init.method,'POST');assert.ok(init.body.get('data').startsWith(query));if(init.body.get('data').length>14000)throw new TypeError('fetch failed');return new Response(raw);
 };
 const recovered=await worker.fetch(request(),{ASSETS:{fetch:async()=>new Response(null,{status:404})}},{});
 assert.equal(recovered.status,200);assert.equal(recovered.headers.get('x-huayu-source-method'),'POST');
 assert.equal(await new Response(recovered.body.pipeThrough(new DecompressionStream('gzip'))).text(),raw);assert.equal(posts,1);assert.equal(gets,1);
 const tooLong=query+' '.repeat(15000);const longResponse=await worker.fetch(request(valid,{query:tooLong}),{},{});
 assert.equal(longResponse.status,502);assert.equal(posts,2);assert.equal(gets,1,'long queries cannot be forced into URLs');
 console.log('Updater method recovery passed: GET-first identical short read-only query, pinned origin, unchanged bytes, no forwarded identity and long-query bound.');
}finally{globalThis.fetch=nativeFetch;}

// Model the actual workerd restriction: redirect:error is rejected before any network request.
try{
 let followed=0,redirectSource=false;
 globalThis.fetch=async(url,init)=>{
  if(init.redirect==='error')throw new TypeError('Invalid redirect value, must be follow or manual');
  assert.equal(init.redirect,'manual');
  if(url==='https://token.actions.githubusercontent.com/.well-known/jwks')return new Response(JSON.stringify({keys:[jwk]}));
  assert.equal(new URL(url).origin+new URL(url).pathname,source);followed++;
  return redirectSource?new Response(null,{status:302,headers:{Location:'https://untrusted.test/query'}}):new Response(raw);
 };
 const actualRuntime=(await import('../site/_worker.js?workerd-redirect-contract')).default;
 const recovered=await actualRuntime.fetch(request(),{},{});assert.equal(recovered.status,200);await recovered.body.cancel();
 redirectSource=true;const rejected=await actualRuntime.fetch(request(),{},{});assert.equal(rejected.status,502);assert.equal(rejected.headers.has('Location'),false);assert.equal((await rejected.json()).error,'source_redirect_rejected');assert.equal(followed,2);
 console.log('Cloudflare runtime passed: supported manual redirect mode, actual signed source read and explicit redirect refusal without forwarding credentials.');
}finally{globalThis.fetch=nativeFetch;}

// Model a suspended request whose timers never get a chance to run.
{
 const realNow=Date.now;let clock=realNow(),hold=true;const upstreamSignals=[];
 try {
  Date.now=()=>clock;
  globalThis.fetch=async(url,init)=>{
   if(url==='https://token.actions.githubusercontent.com/.well-known/jwks')return Response.json({keys:[jwk]});
   upstreamSignals.push(init.signal);
   return hold?new Response(new ReadableStream({pull(){return new Promise(()=>{});}})):new Response(raw);
  };
  const isolated=(await import('../site/_worker.js?expiring-source-leases')).default;
  const a=await isolated.fetch(request(),{},{}),b=await isolated.fetch(request(),{},{});
  const blocked=await isolated.fetch(request(),{},{});assert.equal(blocked.status,429);assert.equal(blocked.headers.get('x-huayu-source-error'),'relay-concurrency');
  clock+=240001;hold=false;
  const recovered=await isolated.fetch(request(),{},{});assert.equal(recovered.status,200);assert.ok(upstreamSignals.slice(0,2).every(s=>s.aborted),'expired source reads are actually cancelled before slots are reused');
  assert.equal(await new Response(recovered.body.pipeThrough(new DecompressionStream('gzip'))).text(),raw);
  await a.body.cancel().catch(()=>{});await b.body.cancel().catch(()=>{});
  globalThis.fetch=async(url)=>url==='https://token.actions.githubusercontent.com/.well-known/jwks'?Response.json({keys:[jwk]}):new Response(null,{status:429});
  const upstream=await isolated.fetch(request(),{},{});assert.equal(upstream.headers.get('x-huayu-source-error'),'upstream-http-429');
 } finally {Date.now=realNow;globalThis.fetch=nativeFetch;}
 console.log('Updater lease recovery passed: real signed requests, bounded concurrency, expired-stream cancellation without timers and explicit upstream/relay diagnostics.');
}

try {
 let count=0;const work=[];globalThis.fetch=async(url)=>url==='https://token.actions.githubusercontent.com/.well-known/jwks'?Response.json({keys:[jwk]}):new Response(raw);
 const isolated=(await import('../site/_worker.js?tracked-pipe-lifetime')).default;
 for(let i=0;i<5;i++) {
  const r=await isolated.fetch(request(),{},{waitUntil(p){count++;work.push(p);}});
  assert.equal(r.status,200);assert.equal(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text(),raw);
  await Promise.all(work);
 }
 assert.equal(count,5,'the actual public route must track every full source/compression pipe until its cleanup finishes');
 const cancelled=await isolated.fetch(request(),{},{waitUntil:p=>work.push(p)});await cancelled.body.cancel();await Promise.all(work);
 const next=await isolated.fetch(request(),{},{waitUntil:p=>work.push(p)});assert.equal(next.status,200);await next.body.cancel();await Promise.all(work);
 console.log('Updater stream lifetime passed: actual routed context owns complete byte-preserving source pipes; EOF and cancellation release slots before the next sequential request.');
}finally{globalThis.fetch=nativeFetch;}

try {
 const work=[];globalThis.fetch=async(url)=>url==="https://token.actions.githubusercontent.com/.well-known/jwks"?Response.json({keys:[jwk]}):new Response(raw);
 const isolated=(await import("../site/_worker.js?identity-source-transfer")).default;
 for(let i=0;i<5;i++){const req=request();req.headers.set("x-huayu-source-encoding","identity");const r=await isolated.fetch(req,{},{waitUntil:p=>work.push(p)});assert.equal(r.status,200);assert.equal(r.headers.get("content-encoding"),null);assert.equal(r.headers.get("x-huayu-source-encoding"),"identity");assert.equal(await r.text(),raw);await Promise.all(work);}
 console.log("Updater identity transport passed: original bytes and source time, tracked EOF and sequential slot cleanup without a JavaScript gzip stage; legacy gzip tests remain.");
}finally{globalThis.fetch=nativeFetch;}
