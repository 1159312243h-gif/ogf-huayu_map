import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker,{tick,inspectLatest,SCHEMA,createWorker} from '../workers/update-watchdog/worker.mjs';
const sql=new DatabaseSync(':memory:');sql.exec(SCHEMA);
const DB={prepare(query){const statement=sql.prepare(query);return {bind(...values){return {
  async first(){return statement.get(...values)||null;},async run(){return statement.run(...values);}
};},async first(){return statement.get()||null;}};}};
const now=Date.parse('2026-11-27T04:00:00Z'),old={id:90,head_branch:'main',status:'completed',created_at:new Date(now-3600000).toISOString()};
const history=run=>({total_count:run?20:0,workflow_runs:run?[run]:[]});
assert.equal(inspectLatest(history(old),now).action,'dispatch');
assert.equal(inspectLatest(history(null),now).action,'dispatch');
for(const status of ['queued','in_progress','waiting','pending','requested'])assert.equal(inspectLatest(history({...old,status}),now).action,'wait');
assert.equal(inspectLatest(history({...old,created_at:new Date(now-14*60000).toISOString()}),now).reason,'recent-check');
assert.equal(inspectLatest(history({...old,created_at:new Date(now-15*60000).toISOString()}),now).action,'dispatch');
for(const run of [{...old,id:-1},{...old,head_branch:'other'},{...old,status:'unknown'},{...old,created_at:'bad'},{...old,created_at:new Date(now+1).toISOString()}])assert.throws(()=>inspectLatest(history(run),now),/invalid/);
for(const packet of [{total_count:1,workflow_runs:[]},{total_count:0,workflow_runs:[old]},{}])assert.throws(()=>inspectLatest(packet,now),/incomplete/);
const environment={DB,GITHUB_DISPATCH_TOKEN:'test-secret-only'},requests=[];
let current=old,reads=0,deny=false,truncated=0,ack=204;
const fetcher=async(url,init)=>{
 requests.push({url,method:init.method,body:init.body});
 assert.equal(init.redirect,'manual','workerd-compatible redirect rejection');assert.ok(init.signal instanceof AbortSignal);
 assert.equal(init.headers.Authorization,'Bearer test-secret-only');
 const target=new URL(url);assert.equal(target.origin,'https://api.github.com');
 assert.ok(target.pathname.startsWith('/repos/1159312243h-gif/ogf-huayu_map/actions/workflows/data-refresh-watchdog.yml/'));
 if(deny)return new Response('private provider error including token',{status:403});
 if(init.method==='POST') {assert.equal(target.pathname.split('/').at(-1),'dispatches');assert.deepEqual(JSON.parse(init.body),{ref:'main'});return new Response(null,{status:ack});}
 assert.equal(target.searchParams.get('branch'),'main');assert.equal(target.searchParams.get('per_page'),'1');reads++;
 return Response.json(truncated-->0?{total_count:1,workflow_runs:[]}:history(current));
};
const check=(options={})=>{sql.exec('UPDATE refresh_clock SET dispatched_at=NULL');return tick(environment,{now,fetcher,wait:async()=>{},...options});};
assert.equal((await check()).status,'dispatch-accepted');
assert.equal(requests.filter(r=>r.method==='POST').length,1);
requests.length=0;assert.equal((await tick(environment,{now,fetcher})).status,'local-dispatch-cooldown');assert.equal(requests.length,0,'persisted cooldown protects against an eventually consistent GitHub list');
let status=await (await worker.fetch(new Request('https://clock.test/health'),environment)).json();
assert.equal(status.outcome,'local-dispatch-cooldown');assert.equal(status.checkedAt,new Date(now).toISOString());assert.equal(status.lastDispatchedAt,status.checkedAt);
assert.doesNotMatch(JSON.stringify(status),/test-secret-only|private provider/);
current={...old,created_at:new Date(now-60000).toISOString()};requests.length=0;assert.equal((await check()).status,'recent-check');assert.ok(!requests.some(r=>r.method==='POST'));
current=old;truncated=2;const waits=[];assert.equal((await check({wait:async ms=>waits.push(ms)})).status,'dispatch-accepted');assert.deepEqual(waits,[1000,2000]);
truncated=3;requests.length=0;await assert.rejects(check(),/incomplete/);assert.ok(!requests.some(r=>r.method==='POST'));truncated=0;
// A real SQLite conditional lease protects simultaneous cron invocations across isolates.
let release;const held=new Promise(resolve=>{release=resolve;});reads=0;
const delayed=check({fetcher:async(url,init)=>{if(!reads)await held;return fetcher(url,init);}});
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal((await check()).reason,'clock-lease-active');release();await delayed;
// A scheduled/manual check starting during the read must prevent duplicate dispatch.
reads=0;requests.length=0;current=old;
assert.equal((await check({fetcher:async(url,init)=>{const response=await fetcher(url,init);if(reads===1)current={...old,status:'queued'};return response;}})).status,'check-already-active');
assert.ok(!requests.some(r=>r.method==='POST'));current=old;
deny=true;await assert.rejects(check(),/^Error: github-http-403$/);deny=false;
status=await (await worker.fetch(new Request('https://clock.test/health'),environment)).json();assert.equal(status.outcome,'github-http-403');
ack=200;await assert.rejects(check(),/acknowledgement/);ack=204;
for(const env of [{DB},{GITHUB_DISPATCH_TOKEN:'test'}])await assert.rejects(tick(env,{now,fetcher}),/configured/);
for(const url of ['https://clock.test/run','https://clock.test/?workflow=deploy.yml','https://clock.test/__scheduled'])assert.equal((await worker.fetch(new Request(url),environment)).status,404);
assert.equal((await worker.fetch(new Request('https://clock.test/health',{method:'POST'}),environment)).status,405);
assert.equal((await worker.fetch(new Request('https://clock.test/health'),{DB})).status,503);
sql.exec('UPDATE refresh_clock SET dispatched_at=NULL');const promises=[];await createWorker(fetcher).scheduled({scheduledTime:now},environment,{waitUntil(promise){promises.push(promise);}});await Promise.all(promises);
assert.equal(promises.length,1,'scheduled event retains the actual dispatched work');
const workflow=await readFile(new URL('../.github/workflows/update-clock.yml',import.meta.url),'utf8');
assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/actions: write|contents: write/);
assert.match(workflow,/secrets\.HUAYU_REFRESH_GITHUB_TOKEN/);
sql.close();
console.log('Independent clock passed: actual SQLite cross-invocation lease, fixed repository/workflow/main, GitHub cooldown and race checks, bounded incomplete-history retries, private-error redaction, scheduled work lifetime and public mutation rejection.');

// Exercise the actual multipart deployment request against a free-plan API fixture.
const {deployUpdateClock}=await import('./deploy-update-clock.mjs');
const deployEnvironment={CLOUDFLARE_ACCOUNT_ID:'fixture-account',CLOUDFLARE_API_TOKEN:'fixture-cloudflare-secret',HUAYU_REFRESH_GITHUB_TOKEN:'fixture-github-secret'};
const deploymentCalls=[],deploymentOutputs=[];
const deployFetcher=async(url,init)=>{
 const parsed=new URL(url);assert.equal(parsed.origin,'https://api.cloudflare.com');assert.ok(parsed.pathname.startsWith('/client/v4/accounts/fixture-account/'));
 assert.equal(init.headers.Authorization,'Bearer fixture-cloudflare-secret');assert.equal(init.redirect,'error');
 deploymentCalls.push({path:parsed.pathname,method:init.method});
 const suffix=parsed.pathname.replace('/client/v4/accounts/fixture-account','');
 if(suffix==='/d1/database')return Response.json({success:true,result:[{name:'ogf-atlas-update-clock',uuid:'clock-db'}]});
 if(suffix==='/d1/database/clock-db/query'){assert.equal(JSON.parse(init.body).sql,SCHEMA);return Response.json({success:true,result:[]});}
 if(suffix==='/workers/scripts/ogf-atlas-update-clock'){
   assert.ok(init.body instanceof FormData);const metadata=JSON.parse(init.body.get('metadata'));
   if('limits' in metadata)return Response.json({success:false,errors:[{code:100328,message:'CPU limits are not supported for the Free plan.'}]},{status:400});
   assert.equal(metadata.main_module,'worker.mjs');assert.equal(metadata.compatibility_date,'2026-11-26');
   assert.deepEqual(metadata.bindings,[{type:'d1',name:'DB',id:'clock-db'},{type:'secret_text',name:'GITHUB_DISPATCH_TOKEN',text:'fixture-github-secret'}]);
   assert.equal(await init.body.get('worker.mjs').text(),'fixture worker source');
   return Response.json({success:true,result:{}});
 }
 if(suffix==='/workers/scripts/ogf-atlas-update-clock/subdomain'){assert.deepEqual(JSON.parse(init.body),{enabled:true});return Response.json({success:true,result:{}});}
 if(suffix==='/workers/scripts/ogf-atlas-update-clock/schedules'){assert.deepEqual(JSON.parse(init.body),[{cron:'*/5 * * * *'}]);return Response.json({success:true,result:[]});}
 if(suffix==='/workers/subdomain')return Response.json({success:true,result:{subdomain:'fixture-clock'}});
 throw Error('Unexpected deployment endpoint');
};
const deployed=await deployUpdateClock({environment:deployEnvironment,fetcher:deployFetcher,readSource:async()=> 'fixture worker source',writeOutput:async value=>deploymentOutputs.push(value)});
assert.equal(deployed.status,'deployed');assert.equal(deployed.healthUrl,'https://ogf-atlas-update-clock.fixture-clock.workers.dev/health');
assert.deepEqual(deploymentOutputs,['health_url='+deployed.healthUrl+'\n']);assert.equal(deploymentCalls.length,6);
assert.doesNotMatch(JSON.stringify(deployed),/fixture-cloudflare-secret|fixture-github-secret/);
let deniedCalls=0;
await assert.rejects(deployUpdateClock({environment:deployEnvironment,fetcher:async(url,init)=>{
 deniedCalls++;if(url.endsWith('/workers/scripts/ogf-atlas-update-clock'))return Response.json({success:false,errors:[{message:'No access fixture-cloudflare-secret fixture-github-secret fixture-account'}]},{status:403});
 return deployFetcher(url,init);
},readSource:async()=> 'fixture worker source',writeOutput:async()=>assert.fail('Denied deployment cannot report a health URL')}),error=>/HTTP 403/.test(error.message)&&!error.message.includes('fixture-cloudflare-secret')&&!error.message.includes('fixture-github-secret'));
assert.equal(deniedCalls,3,'permission failure must stop before activation and schedules');
console.log('Clock deployment passed: actual multipart upload uses free-plan defaults, preserves database/secret bindings and schedule, and never claims deployment or reveals credentials after denial.');
