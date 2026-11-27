import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const CATALOG_FILES=['site/brand-catalog.json','site/brand-search-index.json','site/huaxia-admin-catalog.json',
  'site/desktop-assets.json','site/app-cache-version.js','release/SHA256.txt'];
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
function execute(command,args,{cwd=root,capture=false,allowed=[0]}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:process.env,windowsHide:true,stdio:capture?['ignore','pipe','inherit']:'inherit'});
    let text='';if(capture)child.stdout.on('data',chunk=>{text+=chunk;});
    child.on('error',reject);child.on('close',code=>allowed.includes(code)?resolve({code,text:text.trim()}):reject(Error(path.basename(args[0]||command)+' exited '+code)));
  });
}
export async function dispatchCatalogDeployment({environment=process.env,fetcher=fetch}={}) {
  if(environment.GITHUB_REPOSITORY!=='1159312243h-gif/ogf-huayu_map'||environment.GITHUB_REF!=='refs/heads/main'||!environment.GITHUB_TOKEN)throw Error('Catalog deployment dispatch restricted to production workflow main');
  const response=await fetcher('https://api.github.com/repos/1159312243h-gif/ogf-huayu_map/actions/workflows/deploy.yml/dispatches',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{Authorization:'Bearer '+environment.GITHUB_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify({ref:'main'})});
  if(response.status!==204){await response.body?.cancel();throw Error('Early catalog deployment dispatch HTTP '+response.status);}
}
export async function refreshCatalogsFirst({run=execute,dispatch=dispatchCatalogDeployment,output=process.env.GITHUB_OUTPUT,writeOutput=async text=>{
  if(output)await fs.appendFile(output,text);
},log=console.log}={}) {
  const outcomes={};
  // Each original updater retains its own full-count, identity, shrinkage and atomic-file checks.
  for(const [key,test,script] of [['brands','test-brands.mjs','update-brand-catalog.mjs'],
    ['admins','test-admin-catalog.mjs','update-admin-catalog.mjs']]) {
    try {await run(process.execPath,['scripts/'+test]);await run(process.execPath,['scripts/'+script]);outcomes[key]='success';}
    catch {outcomes[key]='failure';log('::error::'+key+' catalog refresh failed; retaining its last complete files and original dates.');}
  }
  let changed=false;
  if(Object.values(outcomes).includes('success')) {
    for(const args of [['scripts/update-manifest.mjs'],['scripts/verify-package.mjs'],['scripts/test-data-updater.mjs'],
      ['scripts/update-all-data.mjs','--check'],['scripts/check-data-freshness.mjs']])await run(process.execPath,args);
    await run('git',['fetch','origin','main']);
    const head=await run('git',['rev-parse','HEAD'],{capture:true}),latest=await run('git',['rev-parse','origin/main'],{capture:true});
    if(head.text!==latest.text)throw Error('Repository advanced during catalog refresh; refusing to overwrite current main');
    await run('git',['add','--',...CATALOG_FILES]);
    const diff=await run('git',['diff','--cached','--quiet'],{allowed:[0,1]});
    if(diff.code===1) {
      await run('git',['diff','--cached','--check']);
      await run('git',['config','user.name','github-actions[bot]']);
      await run('git',['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);
      await run('git',['commit','-m','Refresh catalogs before long national rebuild']);
      await run('git',['push','origin','HEAD:main']);changed=true;
    }
  }
  await writeOutput('changed='+changed+'\n');
  if(changed)await dispatch();
  const report={changed,outcomes,status:Object.values(outcomes).every(v=>v==='success')?'passed':'partial-failure'};
  log(JSON.stringify(report));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await refreshCatalogsFirst();if(result.status!=='passed')process.exitCode=1;
}
