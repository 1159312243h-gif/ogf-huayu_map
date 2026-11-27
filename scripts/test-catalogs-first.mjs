import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {refreshCatalogsFirst,CATALOG_FILES,dispatchCatalogDeployment} from './refresh-catalogs-first.mjs';
const originalFiles=await Promise.all(CATALOG_FILES.map(async file=>[file,await readFile(new URL('../'+file,import.meta.url))]));
async function exercise({failures=[],advanced=false,diff=1,publicationFailure=null}={}) {
 const commands=[],outputs=[];let result,error;
 try {result=await refreshCatalogsFirst({writeOutput:async text=>outputs.push(text),log:()=>{},dispatch:async()=>{commands.push('dispatch deploy.yml main');},run:async(command,args,options={})=>{
  commands.push(args.join(' '));
  if(failures.some(s=>args[0]?.endsWith(s))||publicationFailure&&args[0]===publicationFailure)throw Error('fixture failure');
  if(args[0]==='rev-parse')return {code:0,text:args[1]==='origin/main'&&advanced?'new-head':'base-head'};
  return {code:args[0]==='diff'&&args.includes('--quiet')?diff:0,text:''};
 }});}catch(e){error=e;}
 return {result,error,commands,outputs};
}
const env={GITHUB_REPOSITORY:'1159312243h-gif/ogf-huayu_map',GITHUB_REF:'refs/heads/main',GITHUB_TOKEN:'test-only'};
let dispatched=false;await dispatchCatalogDeployment({environment:env,fetcher:async(url,init)=>{assert.equal(url,'https://api.github.com/repos/1159312243h-gif/ogf-huayu_map/actions/workflows/deploy.yml/dispatches');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{ref:'main'});assert.equal(init.redirect,'error');dispatched=true;return new Response(null,{status:204});}});assert.equal(dispatched,true);
for(const status of [200,403,500])await assert.rejects(dispatchCatalogDeployment({environment:env,fetcher:async()=>new Response(null,{status})}),/HTTP/);
for(const environment of [{...env,GITHUB_TOKEN:''},{...env,GITHUB_REF:'refs/heads/other'},{...env,GITHUB_REPOSITORY:'other/repo'}])await assert.rejects(dispatchCatalogDeployment({environment,fetcher:async()=>{throw Error('must not request');}}),/restricted/);
const success=await exercise();assert.equal(success.result.status,'passed');assert.deepEqual(success.outputs,['changed=true\n']);
assert.ok(success.commands.indexOf('scripts/update-brand-catalog.mjs')<success.commands.indexOf('scripts/update-admin-catalog.mjs'));
assert.ok(success.commands.indexOf('push origin HEAD:main')<success.commands.indexOf('dispatch deploy.yml main'),'website deployment starts before the subsequent national build');
assert.ok(success.commands.indexOf('scripts/check-data-freshness.mjs')<success.commands.indexOf('push origin HEAD:main'),'all original validators precede a push');
assert.ok(success.commands.includes('add -- '+CATALOG_FILES.join(' ')),'only complete catalog pairs and regenerated manifests are staged');
for(const failed of ['update-brand-catalog.mjs','update-admin-catalog.mjs','test-brands.mjs','test-admin-catalog.mjs']) {
 const partial=await exercise({failures:[failed]});assert.equal(partial.result.status,'partial-failure');
 assert.equal(partial.result.changed,true,'the other complete catalog still publishes');
 assert.deepEqual(partial.outputs,['changed=true\n'],'a later national failure can still deploy the committed catalog');
}
const failed=await exercise({failures:['update-brand-catalog.mjs','update-admin-catalog.mjs']});
assert.equal(failed.result.changed,false);assert.ok(!failed.commands.some(c=>c.startsWith('push ')));
const concurrent=await exercise({advanced:true});assert.match(concurrent.error.message,/advanced/);assert.ok(!concurrent.commands.some(c=>c.startsWith('add ')||c.startsWith('push ')));
for(const publicationFailure of ['push','scripts/verify-package.mjs','scripts/test-data-updater.mjs','scripts/update-all-data.mjs','scripts/check-data-freshness.mjs']) {
 const stopped=await exercise({publicationFailure});assert.ok(stopped.error);assert.deepEqual(stopped.outputs,[],'failed validation/publication cannot report a successful new generation');
}
const unchanged=await exercise({diff:0});assert.deepEqual(unchanged.outputs,['changed=false\n']);assert.ok(!unchanged.commands.some(c=>c.startsWith('push ')));
for(const [file,bytes] of originalFiles)assert.deepEqual(await readFile(new URL('../'+file,import.meta.url)),bytes,'regressions never mutate real snapshots');
const workflow=await readFile(new URL('../.github/workflows/data-refresh.yml',import.meta.url),'utf8');
assert.ok(workflow.indexOf('node scripts/refresh-catalogs-first.mjs')<workflow.indexOf('node scripts/probe-updater-relay.mjs --dense-inventory'));
assert.match(workflow,/group: ogf-atlas-transit-data-refresh/);
assert.match(workflow,/always\(\) && !cancelled\(\) && needs.refresh.outputs.changed/);
assert.match(workflow,/Report any incomplete early catalog refresh/);
console.log('Early catalogs passed: complete independently validated files publish before long national work; partial failures stay visible, both failures retain data, races refuse overwrite, validation/push failure never claims publication and all snapshot bytes remain intact.');
