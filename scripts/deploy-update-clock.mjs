import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCHEMA} from '../workers/update-watchdog/worker.mjs';
const NAME='ogf-atlas-update-clock',DATABASE='ogf-atlas-update-clock';
export async function deployUpdateClock({environment=process.env,fetcher=fetch,
  readSource=()=>fs.readFile(fileURLToPath(new URL('../workers/update-watchdog/worker.mjs',import.meta.url)),'utf8'),
  writeOutput=async text=>{if(environment.GITHUB_OUTPUT)await fs.appendFile(environment.GITHUB_OUTPUT,text);}}={}) {
  const ACCOUNT=environment.CLOUDFLARE_ACCOUNT_ID,TOKEN=environment.CLOUDFLARE_API_TOKEN;
  const GITHUB=environment.HUAYU_REFRESH_GITHUB_TOKEN;
  if(!ACCOUNT||!TOKEN||!GITHUB)throw Error('Independent scheduler deployment credentials unavailable');
  const ROOT=`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
  async function api(route,method='GET',body) {
    const form=body instanceof FormData;
    const response=await fetcher(ROOT+route,{method,redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{Authorization:'Bearer '+TOKEN,...(!form?{'Content-Type':'application/json'}:{})},
      ...(body?{body:form?body:JSON.stringify(body)}:{})});
    const packet=await response.json().catch(()=>null);
    if(!response.ok||!packet?.success){const detail=JSON.stringify(packet?.errors||[]).split(TOKEN).join('[redacted]').split(GITHUB).join('[redacted]').split(ACCOUNT).join('[account]').slice(0,500);throw Error(`Scheduler deployment ${method} ${route} HTTP ${response.status}; errors=${detail}`);}
    return packet.result;
  }
  const databases=await api('/d1/database?per_page=100');
  if(!Array.isArray(databases)||databases.length>=100)throw Error('Incomplete scheduler database list');
  const database=databases.find(d=>d.name===DATABASE)||await api('/d1/database','POST',{name:DATABASE});
  if(!database.uuid)throw Error('Scheduler database identity unavailable');
  await api(`/d1/database/${database.uuid}/query`,'POST',{sql:SCHEMA});
  const form=new FormData();
  // The free plan enforces its own CPU limit and rejects a custom limits field.
  form.append('metadata',JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-11-26',
    bindings:[{type:'d1',name:'DB',id:database.uuid},{type:'secret_text',name:'GITHUB_DISPATCH_TOKEN',text:GITHUB}]}));
  form.append('worker.mjs',new Blob([await readSource()],{type:'application/javascript+module'}),'worker.mjs');
  await api(`/workers/scripts/${NAME}`,'PUT',form);
  await api(`/workers/scripts/${NAME}/subdomain`,'POST',{enabled:true});
  await api(`/workers/scripts/${NAME}/schedules`,'PUT',[{cron:'*/5 * * * *'}]);
  const subdomain=await api('/workers/subdomain');
  if(!/^[a-z0-9-]+$/.test(subdomain.subdomain||''))throw Error('Scheduler health hostname unavailable');
  const healthUrl=`https://${NAME}.${subdomain.subdomain}.workers.dev/health`;
  await writeOutput('health_url='+healthUrl+'\n');
  return {status:'deployed',name:NAME,healthUrl,cron:'*/5 * * * *',githubWorkflow:'data-refresh-watchdog.yml',
    checkedAt:new Date().toISOString()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await deployUpdateClock(),null,2));
