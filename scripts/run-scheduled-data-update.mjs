import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {datasetNames,readDatasetFile,semanticHash} from './update-all-data.mjs';

export async function selectResumableRun(root,now=Date.now()) {
  const runs=path.join(root,'.data-update','runs');
  let entries;try{entries=await fs.readdir(runs,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const current=new Map(await Promise.all(datasetNames.map(async name=>[name,semanticHash(await readDatasetFile(path.join(root,'site',name)))])));
  const candidates=[];
  for(const entry of entries) {
    if(!entry.isDirectory()||!entry.name.startsWith('run-'))continue;
    const directory=path.join(runs,entry.name);
    try {
      const report=JSON.parse(await fs.readFile(path.join(directory,'report.json'),'utf8'));
      if(report.status!=='failed'||report.mode!=='update')continue;
      const id=entry.name.match(/^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
      const first=id?Date.parse(`${id[1]}-${id[2]}-${id[3]}T${id[4]}:${id[5]}:${id[6]}Z`):Date.parse(report.startedAt);
      if(!Number.isFinite(first)||first>now||now-first>6*3600000)continue;
      if(!(await fs.stat(path.join(directory,'outputs','ogf-atlas'))).isDirectory())continue;
      let same=true;
      for(const name of datasetNames)if(current.get(name)!==semanticHash(await readDatasetFile(path.join(directory,'baseline',name)))){same=false;break;}
      if(same)candidates.push({...report,runDirectory:directory});
    }catch{/* Incomplete, expired or incompatible caches cannot replace a fresh build. */}
  }
  return candidates.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0]||null;
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const selected=await selectResumableRun(root);
  if(selected) {
    await fs.writeFile(path.join(root,'.data-update','latest-report.json'),JSON.stringify(selected,null,2)+'\n');
    console.log('Resuming verified failed update: '+path.basename(selected.runDirectory));
  }else console.log('Starting a fresh complete update; no recent compatible failed run.');
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts','update-all-data.mjs'),...(selected?['--resume']:[])],{cwd:root,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('close',code=>resolve(code??1));});
  process.exitCode=code;
}
