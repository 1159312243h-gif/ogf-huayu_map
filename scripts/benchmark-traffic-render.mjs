import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {prepareTrafficRender} from './lib/traffic-render-probe.mjs';
const old=execFileSync('git',['show','506c5bf:site/traffic-simulation.js'],{encoding:'utf8',maxBuffer:10000000}),current=await readFile('site/traffic-simulation.js','utf8');
const ctx=vm.createContext({});vm.runInContext(execFileSync('git',['show','506c5bf:site/traffic-surfaces.js'],{encoding:'utf8'}),ctx);
const before=prepareTrafficRender(old,{count:600,surfaceRuntime:ctx.HuayuTrafficSurfaces}),after=prepareTrafficRender(current,{count:600});
try{
 for(let i=0;i<30;i++){before.run();after.run();}
 const results={before:[],after:[]},frames=100;
 for(let run=0;run<7;run++)for(const [name,probe] of run%2?[['after',after],['before',before]]:[['before',before],['after',after]]){
  const at=performance.now();for(let i=0;i<frames;i++)probe.run();results[name].push((performance.now()-at)/frames);
 }
 const b=before.capture(),a=after.capture(),{uploadBytes:oldBytes,...oldGeometry}=b,{uploadBytes:newBytes,...newGeometry}=a;assert.deepEqual(newGeometry,oldGeometry);
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const report={scope:'actual shared render handler with bundled Three.js, 600 identical drawn cars; Node CPU preparation only, no GPU/FPS claim',sourceCommit:'506c5bf',framesPerRun:frames,runs:7,drawn:a.drawn,exactGeometryParity:true,msPerFrame:results,medianBeforeMs:median(results.before),medianAfterMs:median(results.after),uploadBeforeBytes:oldBytes,uploadAfterBytes:newBytes};
 report.cpuReductionPercent=100*(1-report.medianAfterMs/report.medianBeforeMs);report.uploadReductionPercent=100*(1-newBytes/oldBytes);
 await mkdir('.data-update',{recursive:true});
 await writeFile('.data-update/traffic-render-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{before.dispose();after.dispose();}
