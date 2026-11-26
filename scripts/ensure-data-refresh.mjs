import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {datasetNames,readDatasetFile} from './update-all-data.mjs';

const REPOSITORY='1159312243h-gif/ogf-huayu_map';
const API='https://api.github.com/repos/'+REPOSITORY;
const ACTIVE=['queued','in_progress','waiting','pending','requested'];
const PERIOD=3*3600000,COOLDOWN=3600000;
const TARGETS=[
  {workflow:'data-refresh.yml',files:datasetNames.map(file=>({file,timestampKey:'generatedAt'}))},
  {workflow:'brand-refresh.yml',files:[
    {file:'brand-catalog.json',timestampKey:'generatedAt',sourceKey:'dbTimestamp'},
    {file:'huaxia-admin-catalog.json',timestampKey:'readAt',sourceKey:'sourceTime'},
  ]},
];
export function refreshDecision({generations,activeRuns,recentRun,now=Date.now(),expectedFiles=datasetNames}) {
  const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now;
  if(!Array.isArray(generations)||generations.length!==expectedFiles.length
    ||generations.some(g=>!expectedFiles.includes(g.file)||!validDate(g.generatedAt)||('sourceTime' in g&&!validDate(g.sourceTime)))
    ||new Set(generations.map(g=>g.file)).size!==expectedFiles.length)throw Error('Incomplete published generation dates');
  const oldest=Math.min(...generations.flatMap(g=>[Date.parse(g.generatedAt),...('sourceTime' in g?[Date.parse(g.sourceTime)]:[])]));
  const ageMinutes=Math.round((now-oldest)/60000);
  if(!Array.isArray(activeRuns))throw Error('Incomplete active workflow state');
  const validRun=r=>Number.isSafeInteger(r.id)&&r.id>0&&r.head_branch==='main'&&['completed',...ACTIVE].includes(r.status)
    &&validDate(r.created_at);
  for(const r of activeRuns)if(!validRun(r)||!ACTIVE.includes(r.status))throw Error('Invalid active refresh run');
  if(recentRun&&!validRun(recentRun))throw Error('Invalid recent refresh run');
  const sourceDates=generations.filter(g=>'sourceTime' in g).map(g=>Date.parse(g.sourceTime));
  const common={oldestDataAt:new Date(oldest).toISOString(),oldestGeneratedAt:new Date(Math.min(...generations.map(g=>Date.parse(g.generatedAt)))).toISOString(),
    oldestSourceAt:sourceDates.length?new Date(Math.min(...sourceDates)).toISOString():null,ageMinutes};
  if(activeRuns.length)return {...common,action:'wait',reason:'refresh-already-active',runs:activeRuns.map(r=>({id:r.id,status:r.status}))};
  if(recentRun&&ACTIVE.includes(recentRun.status))return {...common,action:'wait',reason:'refresh-already-active',runs:[{id:recentRun.id,status:recentRun.status}]};
  if(now-oldest<PERIOD)return {...common,action:'none',reason:'generation-under-three-hours'};
  if(recentRun&&now-Date.parse(recentRun.created_at)<COOLDOWN)return {...common,action:'wait',reason:'one-hour-dispatch-cooldown',run:recentRun.id};
  return {...common,action:'dispatch',reason:'published-generation-overdue'};
}
export async function ensureDataRefresh({root,environment=process.env,fetcher=fetch,now=Date.now(),output,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(environment.GITHUB_REPOSITORY!==REPOSITORY||environment.GITHUB_REF!=='refs/heads/main')throw Error('Refresh watchdog is restricted to the production repository main branch');
  const token=environment.GITHUB_TOKEN;
  if(typeof token!=='string'||!token)throw Error('Workflow token unavailable');
  const targets=await Promise.all(TARGETS.map(async target=>({...target,generations:await Promise.all(target.files.map(async def=>{
    const data=await readDatasetFile(path.join(root,'site',def.file));
    return {file:def.file,generatedAt:data[def.timestampKey],...(def.sourceKey?{sourceTime:data[def.sourceKey]}:{})};
  }))})));
  // Reject incomplete dates before any dispatch, including a partially refreshed catalog pair.
  for(const target of targets)refreshDecision({generations:target.generations,expectedFiles:target.files.map(f=>f.file),activeRuns:[],now});
  async function api(route,method='GET',body){
    const response=await fetcher(API+route,{method,redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('Refresh watchdog GitHub '+method+' HTTP '+response.status);
    if(method==='POST'){if(response.status!==204)throw Error('Unexpected workflow dispatch acknowledgement');return null;}
    const packet=await response.json();
    if(!Number.isSafeInteger(packet.total_count)||packet.total_count<0||!Array.isArray(packet.workflow_runs))throw Error('Incomplete workflow response');
    return packet;
  }
  async function history(workflow){
    const prefix='/actions/workflows/'+workflow,active=[];
    for(const status of ACTIVE){
      const route=prefix+'/runs?branch=main&per_page=100&status='+status;
      let packet;
      for(let attempt=0;attempt<3;attempt++){
        packet=await api(route);
        if(packet.total_count===packet.workflow_runs.length)break;
        if(attempt===2)throw Error('Active workflow list was truncated: '+workflow+' '+status+' reported='+packet.total_count+' returned='+packet.workflow_runs.length);
        await wait(1000*(attempt+1));
      }
      for(const run of packet.workflow_runs){if(run.status!==status)throw Error('Active workflow status mismatch');active.push(run);}
    }
    const recent=await api(prefix+'/runs?branch=main&per_page=1');
    if(recent.total_count>0&&recent.workflow_runs.length!==1||recent.total_count===0&&recent.workflow_runs.length!==0)throw Error('Missing most recent workflow state');
    return {active,recentRun:recent.workflow_runs[0]};
  }
  async function decide(){
    const histories=await Promise.all(targets.map(t=>history(t.workflow)));
    // Both writers share one GitHub concurrency group: never enqueue a second writer,
    // which could replace an already pending scheduled run.
    const active=histories.flatMap(h=>[...h.active,...(h.recentRun&&ACTIVE.includes(h.recentRun.status)?[h.recentRun]:[])]);
    return targets.map((target,i)=>({workflow:target.workflow,generations:target.generations,
      ...refreshDecision({generations:target.generations,expectedFiles:target.files.map(f=>f.file),activeRuns:active,recentRun:histories[i].recentRun,now})}));
  }
  let decisions=await decide();
  if(decisions.some(d=>d.action==='dispatch'))decisions=await decide(); // Recheck both locks immediately before dispatch.
  const ordered=[...decisions].sort((a,b)=>Date.parse(a.oldestDataAt)-Date.parse(b.oldestDataAt));
  const selected=ordered.find(d=>d.action==='dispatch')||ordered.find(d=>d.action==='wait')||ordered[0];
  const {generations,...decision}=selected;
  const report={checkedAt:new Date(now).toISOString(),...decision,targets:decisions};
  if(decision.action==='dispatch'){
    await api('/actions/workflows/'+decision.workflow+'/dispatches','POST',{ref:'main'});
    report.status='dispatch-accepted';
  }else report.status=decision.action==='wait'?'waiting':'current';
  if(output){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
  console.log(JSON.stringify(await ensureDataRefresh({root,output:path.join(root,'.data-update/refresh-watchdog.json')}),null,2));
}
