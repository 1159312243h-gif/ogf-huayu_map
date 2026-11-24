import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {selectResumableRun,runScheduledUpdate} from './run-scheduled-data-update.mjs';
import {datasetNames} from './update-all-data.mjs';
const root=await fs.mkdtemp(path.resolve('.data-update/scheduled-update-test-')),now=Date.parse('2026-11-20T16:00:00Z');
const write=async(dir,value)=>{await fs.mkdir(dir,{recursive:true});for(const name of datasetNames){const body=JSON.stringify({generatedAt:'2026-11-20T14:00:00Z',sourceTime:'2026-11-20T13:00:00Z',value});await fs.writeFile(path.join(dir,name),name.endsWith('.gz')?gzipSync(body):body);}};
await write(path.join(root,'site'),1);
const run=async(id,{mode='update',status='failed',value=1,complete=true,startedAt='2026-11-20T15:30:00Z'}={})=>{const dir=path.join(root,'.data-update/runs',id);await write(path.join(dir,'baseline'),value);if(complete)await fs.mkdir(path.join(dir,'outputs/ogf-atlas'),{recursive:true});const report={status,mode,startedAt,runDirectory:'X:/previous-runner/untrusted-location'};await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report));return dir;};
assert.equal(await selectResumableRun(root,now),null);
await run('run-20261120T080000Z',{startedAt:'2026-11-20T15:59:00Z'});assert.equal(await selectResumableRun(root,now),null,'retries must not extend the six-hour original-generation limit');
await run('run-20261120T150100Z',{value:2});await run('run-20261120T150200Z',{complete:false});await run('run-20261120T150300Z',{status:'passed'});await run('run-20261120T150400Z',{mode:'dry-run'});assert.equal(await selectResumableRun(root,now),null);
const valid=await run('run-20261120T150500Z');const selected=await selectResumableRun(root,now);assert.equal(selected.runDirectory,valid,'restore only the actual workspace directory, never a cached absolute path');assert.equal(selected.startedAt,'2026-11-20T15:30:00Z','preserve the original acquisition metadata');
await write(path.join(root,'site'),3);assert.equal(await selectResumableRun(root,now),null,'a changed published baseline starts a fresh complete generation');
console.log('Scheduled update resume passed: recent failed complete checkpoints only, original-age cap, same seven-file baseline, portable paths and source-time preservation.');

await write(path.join(root,'site'),1);
const logs=path.join(valid,'logs');await fs.mkdir(logs,{recursive:true});const logfile=path.join(logs,'build-terrain-preload.log');
await fs.writeFile(logfile,'Terrain context: HTTP 429 relay-concurrency');
let calls=0,waits=[];
assert.equal(await runScheduledUpdate(root,{now:()=>now,log:()=>{},wait:async ms=>waits.push(ms),execute:async args=>{calls++;assert.deepEqual(args,['--resume']);return calls===1?1:0;}}),0);
assert.equal(calls,2);assert.deepEqual(waits,[30000]);
for(const error of ['HTTP 403','Incomplete official transit response','Published railway lost without complete current-source verification','count mismatch']){
 await fs.writeFile(logfile,error);calls=0;
 assert.equal(await runScheduledUpdate(root,{now:()=>now,log:()=>{},wait:async()=>{throw Error('unexpected retry');},execute:async()=>{calls++;return 1;}}),1);
 assert.equal(calls,1,'permanent/integrity failures cannot be retried as successful updates');
}
await fs.writeFile(logfile,'fetch failed');calls=0;
assert.equal(await runScheduledUpdate(root,{now:()=>now,log:()=>{},wait:async()=>{},execute:async()=>{calls++;return 1;}}),1);
assert.equal(calls,2,'persistent transient errors have exactly one automatic retry');
console.log('Scheduled recovery passed: one same-generation transient retry, unchanged source age, no retry for permissions/count/proof failures, and bounded persistent failure.');
