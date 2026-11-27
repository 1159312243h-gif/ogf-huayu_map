import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCHEMA} from '../workers/update-watchdog/worker.mjs';
const ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID,TOKEN=process.env.CLOUDFLARE_API_TOKEN;
const GITHUB=process.env.HUAYU_REFRESH_GITHUB_TOKEN;
const NAME='ogf-atlas-update-clock',DATABASE='ogf-atlas-update-clock';
if(!ACCOUNT||!TOKEN||!GITHUB)throw Error('Independent scheduler deployment credentials unavailable');
const ROOT=`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
async function api(route,method='GET',body) {
  const form=body instanceof FormData;
  const response=await fetch(ROOT+route,{method,redirect:'error',signal:AbortSignal.timeout(45000),
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
const source=await fs.readFile(fileURLToPath(new URL('../workers/update-watchdog/worker.mjs',import.meta.url)),'utf8');
const form=new FormData();
form.append('metadata',JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-11-26',
  bindings:[{type:'d1',name:'DB',id:database.uuid},{type:'secret_text',name:'GITHUB_DISPATCH_TOKEN',text:GITHUB}],
  limits:{cpu_ms:10}}));
form.append('worker.mjs',new Blob([source],{type:'application/javascript+module'}),'worker.mjs');
await api(`/workers/scripts/${NAME}`,'PUT',form);
await api(`/workers/scripts/${NAME}/subdomain`,'POST',{enabled:true});
await api(`/workers/scripts/${NAME}/schedules`,'PUT',[{cron:'*/5 * * * *'}]);
const subdomain=await api('/workers/subdomain');
if(!/^[a-z0-9-]+$/.test(subdomain.subdomain||''))throw Error('Scheduler health hostname unavailable');
const healthUrl=`https://${NAME}.${subdomain.subdomain}.workers.dev/health`;
const result={status:'deployed',name:NAME,healthUrl,cron:'*/5 * * * *',githubWorkflow:'data-refresh-watchdog.yml',
  checkedAt:new Date().toISOString()};
if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,'health_url='+healthUrl+'\n');
console.log(JSON.stringify(result,null,2));
