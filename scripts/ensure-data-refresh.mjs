import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {datasetNames,readDatasetFile} from './update-all-data.mjs';

const REPOSITORY='1159312243h-gif/ogf-huayu_map';
const WORKFLOW='data-refresh.yml';
const API='https://api.github.com/repos/'+REPOSITORY;
const ACTIVE=['queued','in_progress','waiting','pending','requested'];
const PERIOD=3*3600000,COOLDOWN=3600000;
export function refreshDecision({generations,activeRuns,recentRun,now=Date.now()}) {
  if(!Array.isArray(generations)||generations.length!==datasetNames.length
    ||generations.some(g=>!datasetNames.includes(g.file)||!Number.isFinite(Date.parse(g.generatedAt))||Date.parse(g.generatedAt)>now)
    ||new Set(generations.map(g=>g.file)).size!==datasetNames.length)throw Error('Incomplete published generation dates');
  const oldest=Math.min(...generations.map(g=>Date.parse(g.generatedAt)));
  const ageMinutes=Math.round((now-oldest)/60000);
  if(!Array.isArray(activeRuns))throw Error('Incomplete active workflow state');
  for(const r of activeRuns)if(!Number.isSafeInteger(r.id)||r.id<=0||r.head_branch!=='main'||!ACTIVE.includes(r.status))throw Error('Invalid active refresh run');
  const common={oldestGeneratedAt:new Date(oldest).toISOString(),ageMinutes};
  if(activeRuns.length)return {...common,action:'wait',reason:'refresh-already-active',runs:activeRuns.map(r=>({id:r.id,status:r.status}))};
  if(now-oldest<PERIOD)return {...common,action:'none',reason:'generation-under-three-hours'};
  if(recentRun){
    const created=Date.parse(recentRun.created_at);
    if(!Number.isSafeInteger(recentRun.id)||recentRun.id<=0||recentRun.head_branch!=='main'||!['completed',...ACTIVE].includes(recentRun.status)||!Number.isFinite(created)||created>now)throw Error('Invalid recent refresh run');
    if(ACTIVE.includes(recentRun.status))return {...common,action:'wait',reason:'refresh-already-active',runs:[{id:recentRun.id,status:recentRun.status}]};
    if(now-created<COOLDOWN)return {...common,action:'wait',reason:'one-hour-dispatch-cooldown',run:recentRun.id};
  }
  return {...common,action:'dispatch',reason:'published-generation-overdue'};
}
export async function ensureDataRefresh({root,environment=process.env,fetcher=fetch,now=Date.now(),output,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(environment.GITHUB_REPOSITORY!==REPOSITORY||environment.GITHUB_REF!=='refs/heads/main')throw Error('Refresh watchdog is restricted to the production repository main branch');
  const token=environment.GITHUB_TOKEN;
  if(typeof token!=='string'||!token)throw Error('Workflow token unavailable');
  const generations=await Promise.all(datasetNames.map(async file=>({file,generatedAt:(await readDatasetFile(path.join(root,'site',file))).generatedAt})));
  async function api(route,method='GET',body){
    const response=await fetcher(API+route,{method,redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('Refresh watchdog GitHub '+method+' HTTP '+response.status);
    if(method==='POST'){if(response.status!==204)throw Error('Unexpected workflow dispatch acknowledgement');return null;}
    const packet=await response.json();
    if(!Number.isSafeInteger(packet.total_count)||packet.total_count<0||!Array.isArray(packet.workflow_runs))throw Error('Incomplete workflow response');
    return packet;
  }
  const prefix='/actions/workflows/'+WORKFLOW;
  const active=[];
  for(const status of ACTIVE){
    const route=prefix+'/runs?branch=main&per_page=100&status='+status;
    let packet;
    for(let attempt=0;attempt<3;attempt++){
      packet=await api(route);
      if(packet.total_count===packet.workflow_runs.length)break;
      if(attempt===2)throw Error('Active workflow list was truncated: '+status+' reported='+packet.total_count+' returned='+packet.workflow_runs.length);
      await wait(1000*(attempt+1));
    }
    for(const run of packet.workflow_runs){if(run.status!==status)throw Error('Active workflow status mismatch');active.push(run);}
  }
  const recent=await api(prefix+'/runs?branch=main&per_page=1');
  if(recent.total_count>0&&recent.workflow_runs.length!==1||recent.total_count===0&&recent.workflow_runs.length!==0)throw Error('Missing most recent workflow state');
  const decision=refreshDecision({generations,activeRuns:active,recentRun:recent.workflow_runs[0],now});
  const report={checkedAt:new Date(now).toISOString(),...decision,generations};
  if(decision.action==='dispatch'){
    await api(prefix+'/dispatches','POST',{ref:'main'});
    report.status='dispatch-accepted';
  }else report.status=decision.action==='wait'?'waiting':'current';
  if(output){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
  console.log(JSON.stringify(await ensureDataRefresh({root,output:path.join(root,'.data-update/refresh-watchdog.json')}),null,2));
}
