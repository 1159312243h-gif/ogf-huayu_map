import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {datasetNames} from './update-all-data.mjs';
import {refreshDecision,ensureDataRefresh} from './ensure-data-refresh.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'huayu-refresh-watchdog-')),now=Date.parse('2026-11-26T12:00:00Z');
try {
await fs.mkdir(path.join(root,'site'));
const catalogNames=['brand-catalog.json','huaxia-admin-catalog.json'];
const generation=(age,files=datasetNames)=>files.map(file=>({file,generatedAt:new Date(now-age).toISOString()}));
const old=generation(7*3600000),fresh=generation(2*3600000);
const run={id:40,head_branch:'main',status:'completed',created_at:new Date(now-8*3600000).toISOString()};
const decision=values=>refreshDecision({generations:old,activeRuns:[],recentRun:run,now,...values});
assert.equal(decision({}).action,'dispatch','a missed three-hour trigger must recover');
assert.equal(decision({generations:fresh}).action,'none');
assert.equal(decision({generations:generation(3*3600000)}).action,'dispatch');
for(const status of ['queued','in_progress','waiting','pending','requested']){
 assert.equal(decision({activeRuns:[{...run,status}]}).action,'wait','do not duplicate or cancel '+status);
 assert.equal(decision({recentRun:{...run,status}}).action,'wait','a run started between history reads prevents duplicate dispatch');
}
assert.equal(decision({recentRun:{...run,created_at:new Date(now-30*60000).toISOString()}}).reason,'one-hour-dispatch-cooldown');
assert.equal(decision({recentRun:{...run,created_at:new Date(now-3600000).toISOString()}}).action,'dispatch');
assert.equal(decision({generations:[...fresh.slice(1),old[0]]}).action,'dispatch','oldest of all seven snapshots controls');
for(const generations of [old.slice(1),old.map(g=>({...g,generatedAt:'bad'})),old.map(g=>({...g,generatedAt:new Date(now+1000).toISOString()})),old.map(()=>old[0])])assert.throws(()=>decision({generations}),/Incomplete/);
assert.throws(()=>decision({activeRuns:[{...run,head_branch:'other',status:'in_progress'}]}),/Invalid/);
assert.throws(()=>decision({recentRun:{...run,status:'unknown'}}),/Invalid/);
const catalog=(age)=>generation(age,catalogNames).map(g=>({...g,sourceTime:g.generatedAt}));
const directoryDecision=generations=>decision({generations,expectedFiles:catalogNames});
assert.equal(directoryDecision(catalog(2*3600000)).action,'none');
assert.equal(directoryDecision([catalog(2*3600000)[0],catalog(9*3600000)[1]]).action,'dispatch','a failed admin catalog cannot hide behind a fresh brand catalog');
assert.equal(directoryDecision(catalog(1*3600000).map(g=>({...g,sourceTime:new Date(now-8*3600000).toISOString()}))).action,'dispatch','recent packaging does not disguise old sources');
for(const sourceTime of ['',undefined,'bad',new Date(now+1).toISOString()])assert.throws(()=>directoryDecision(catalog(3600000).map(g=>({...g,sourceTime}))),/Incomplete/);
async function seed(generations){for(const g of generations){const body=JSON.stringify({generatedAt:g.generatedAt,readAt:g.generatedAt,dbTimestamp:g.sourceTime||g.generatedAt,sourceTime:g.sourceTime||g.generatedAt});await fs.writeFile(path.join(root,'site',g.file),g.file.endsWith('.gz')?gzipSync(body):body);}}
await seed(old);await seed(catalog(2*3600000));
const environment={GITHUB_REPOSITORY:'1159312243h-gif/ogf-huayu_map',GITHUB_REF:'refs/heads/main',GITHUB_TOKEN:'test-only-secret'};
const requests=[];
const states={'data-refresh.yml':{recent:run},'brand-refresh.yml':{recent:run}};
let truncate=false,deny=false,dispatchStatus=204;
const fetcher=async(input,init)=>{
 const url=new URL(input);requests.push({url:url.href,method:init.method,body:init.body});
 assert.equal(url.origin,'https://api.github.com');
 const match=url.pathname.match(/^\/repos\/1159312243h-gif\/ogf-huayu_map\/actions\/workflows\/(data-refresh\.yml|brand-refresh\.yml)\/(runs|dispatches)$/);
 assert.ok(match,'only two fixed production workflows may be used');
 const state=states[match[1]];
 assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer test-only-secret');assert.ok(init.signal instanceof AbortSignal);
 if(deny)return new Response(null,{status:403});
 if(init.method==='POST'){assert.equal(match[2],'dispatches');assert.deepEqual(JSON.parse(init.body),{ref:'main'});return new Response(null,{status:dispatchStatus});}
 assert.equal(url.searchParams.get('branch'),'main');const status=url.searchParams.get('status');
 if(status)return Response.json({total_count:truncate?101:state.active===status?1:0,workflow_runs:state.active===status?[{...run,status}]:[]});
 return Response.json({total_count:state.recent?300:0,workflow_runs:state.recent?[state.recent]:[]});
};
const check=(options={})=>ensureDataRefresh({root,environment,fetcher,now,wait:async()=>{},...options});
const dispatches=()=>requests.filter(r=>r.method==='POST');
let metadataReads=0;const metadataWaits=[];
const recoveredMetadata=await check({wait:async ms=>metadataWaits.push(ms),fetcher:async(input,init)=>{const u=new URL(input);if(u.pathname.includes('data-refresh.yml')&&u.searchParams.get('status')==='queued'&&++metadataReads<3)return Response.json({total_count:1,workflow_runs:[]});return fetcher(input,init);}});
assert.equal(recoveredMetadata.status,'dispatch-accepted');assert.deepEqual(metadataWaits,[1000,2000]);assert.ok(metadataReads>=3);requests.length=0;
const output=path.join(root,'nested','report.json');
const passed=await check({output});
assert.equal(passed.status,'dispatch-accepted');assert.equal(passed.workflow,'data-refresh.yml');assert.equal(dispatches().length,1);
assert.doesNotMatch(JSON.stringify(passed),/test-only-secret/);assert.deepEqual(passed.targets[0].generations,old);
assert.equal(JSON.parse(await fs.readFile(output)).status,'dispatch-accepted');
const saved=new Map(await Promise.all([...datasetNames,...catalogNames].map(async f=>[f,await fs.readFile(path.join(root,'site',f))])));
for(const g of old)assert.equal(JSON.parse(g.file.endsWith('.gz')?gunzipSync(saved.get(g.file)):saved.get(g.file)).generatedAt,g.generatedAt);
await check();for(const [f,bytes] of saved)assert.deepEqual(await fs.readFile(path.join(root,'site',f)),bytes,'watchdog never writes data or original acquisition dates');
for(const workflow of Object.keys(states))for(const status of ['queued','in_progress','waiting','pending','requested']){
 states[workflow].active=status;requests.length=0;assert.equal((await check()).status,'waiting');assert.equal(dispatches().length,0,'both shared writers must be protected');states[workflow].active=null;
}
await seed(fresh);requests.length=0;assert.equal((await check()).status,'current');assert.equal(dispatches().length,0);
await seed(catalog(9*3600000));requests.length=0;assert.equal((await check()).workflow,'brand-refresh.yml');assert.equal(dispatches().length,1,'catalog-only recovery works with fresh national data');
await seed(old);requests.length=0;assert.equal((await check()).workflow,'brand-refresh.yml');assert.equal(dispatches().length,1,'only the oldest overdue writer is dispatched');
states['brand-refresh.yml'].recent={...run,created_at:new Date(now-30*60000).toISOString()};requests.length=0;assert.equal((await check()).workflow,'data-refresh.yml');assert.equal(dispatches().length,1,'per-workflow cooldown does not starve the other overdue writer');states['brand-refresh.yml'].recent=run;
for(const workflow of Object.keys(states)){
 states[workflow].recent={...run,status:'in_progress'};requests.length=0;assert.equal((await check()).status,'waiting');assert.equal(dispatches().length,0);states[workflow].recent=run;
}
let catalogHistoryReads=0;
requests.length=0;const racing=await check({fetcher:async(input,init)=>{const u=new URL(input);if(u.pathname.includes('brand-refresh.yml')&&!u.searchParams.has('status')&&++catalogHistoryReads===1)states['brand-refresh.yml'].active='queued';return fetcher(input,init);}});
assert.equal(racing.status,'waiting');assert.equal(dispatches().length,0,'second lock read catches the other writer starting before dispatch');states['brand-refresh.yml'].active=null;
truncate=true;requests.length=0;await assert.rejects(check(),/truncated/);assert.equal(dispatches().length,0);truncate=false;
deny=true;requests.length=0;await assert.rejects(check(),/HTTP 403/);assert.equal(dispatches().length,0);deny=false;
dispatchStatus=500;await assert.rejects(check(),/HTTP 500/);dispatchStatus=200;await assert.rejects(check(),/acknowledgement/);dispatchStatus=204;
for(const workflow of Object.keys(states)){states[workflow].recent=null;requests.length=0;assert.equal((await check()).status,'dispatch-accepted');states[workflow].recent=run;}
await fs.writeFile(path.join(root,'site','huaxia-admin-catalog.json'),JSON.stringify({readAt:new Date(now).toISOString()}));requests.length=0;await assert.rejects(check(),/Incomplete/);assert.equal(requests.length,0,'missing source dates prevent any dispatch');
requests.length=0;for(const env of [{...environment,GITHUB_REPOSITORY:'other/repo'},{...environment,GITHUB_REF:'refs/heads/other'},{...environment,GITHUB_TOKEN:''}])await assert.rejects(check({environment:env}));assert.equal(requests.length,0);
const project=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const workflow=await fs.readFile(path.join(project,'.github/workflows/data-refresh-watchdog.yml'),'utf8');
assert.match(workflow,/cron: "37 \* \* \* \*"/u);assert.match(workflow,/actions: write/u);assert.doesNotMatch(workflow,/contents: write|id-token: write|secrets\./u);
assert.match(workflow,/workflow_run:/u);assert.match(workflow,/Refresh transit and terrain data/u);assert.match(workflow,/node scripts\/ensure-data-refresh\.mjs/u);
assert.match(await fs.readFile(path.join(project,'.github/workflows/data-refresh.yml'),'utf8'),/cron: "17 \*\/3 \* \* \*"/u);
assert.match(await fs.readFile(path.join(project,'.github/workflows/brand-refresh.yml'),'utf8'),/cron: "43 \*\/3 \* \* \*"/u);
console.log('Refresh watchdog passed: seven national snapshots plus both catalog dates and sources, partial catalog failure, oldest-first serial recovery, both writer locks and races, cooldown, fixed dispatch, denied/incomplete history, no data rewrite and unchanged three-hour schedules.');
} finally {assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(),'huayu-refresh-watchdog-')));await fs.rm(root,{recursive:true,force:true});}
