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
