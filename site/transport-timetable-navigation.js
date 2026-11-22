(function(root){
 "use strict";
 const core=root.HuayuTimetableCore;
 function create({read=fetch,describe,now=()=>Date.now()}){
  let generation=0,controller=null;
  function cancel(){generation++;controller?.abort();controller=null;}
  function matchStop(stop,keys){const required=stop.ref?"id:"+stop.ref:stop.code?"code:"+core.name(stop.code):"name:"+core.name(stop.name);return keys.includes(required);}
  function fitTrip(trip,leg){
   if(trip.routeId&&!(leg.routeIds||[]).includes(trip.routeId))return null;
   const start=trip.stops.findIndex(s=>matchStop(s,leg.fromKeys));
   if(start<0)return null;
   let end=-1;for(let i=start+1;i<trip.stops.length;i++)if(matchStop(trip.stops[i],leg.toKeys)){end=i;break;}
   if(end<0)return null;
   const subset=trip.stops.slice(start,end+1),positions=[];let cursor=0;
   for(const s of subset){let at=-1;for(let i=cursor;i<leg.stops.length;i++)if(matchStop(s,leg.stops[i].keys)){at=i;break;}
    if(at<0)return null;positions.push(at);cursor=at+1;}
   // Never imply a user service confirms an inferred physical connection.
   if(leg.unconfirmed&&trip.mode!=="flight")return null;
   const paths=positions.slice(1).map((at,i)=>leg.sections.slice(positions[i],at).flat());
   return {trip:{...trip,calendarOffset:trip.stops[0].offsetMinutes,stops:subset},paths};
  }
  async function enrich(plans,{departureAt=now(),signal}={}){
   cancel();const token=generation;controller=new AbortController();
   const current=()=>token===generation&&!signal?.aborted&&!controller?.signal.aborted;
   const descriptors=plans.map(describe),pairs=[],keys=new Map();
   for(const d of descriptors)for(const leg of d.legs)if(leg.mode&&leg.fromKeys.length&&leg.toKeys.length){
    const p={mode:leg.mode,from:leg.fromKeys,to:leg.toKeys},key=JSON.stringify(p);
    if(!keys.has(key)){keys.set(key,pairs.length);pairs.push(p);}leg.queryIndex=keys.get(key);
   }
   if(!pairs.length)return plans;
   const resultPairs=[];
   try{
    for(let offset=0;offset<pairs.length;offset+=100){
     if(!current())throw new DOMException("班次查询已改变","AbortError");
     const r=await read("/api/timetables/match",{method:"POST",credentials:"same-origin",cache:"no-store",
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000),...(signal?[signal]:[])]),
      headers:{"Content-Type":"application/json"},body:JSON.stringify({pairs:pairs.slice(offset,offset+100)})});
     if(!r.ok)throw Error("共享班次服务暂不可用");const data=await r.json();
     if(!Array.isArray(data.pairs)||data.pairs.length!==Math.min(100,pairs.length-offset)||new Set(data.pairs.map(p=>p.index)).size!==data.pairs.length)throw Error("共享班次响应不完整");
     for(const p of data.pairs){if(!Number.isSafeInteger(p.index)||p.index<0||p.index>=Math.min(100,pairs.length-offset)||!Array.isArray(p.items))throw Error("共享班次响应无效");resultPairs[offset+p.index]=p;}
    }
   }catch(e){if(!current())throw new DOMException("班次查询已被新规划取代","AbortError");
    return plans.map(p=>({...p,timetableStatus:"共享班次读取暂不可用，使用原默认方案"}));}
   if(!current())throw new DOMException("班次查询已被新规划取代","AbortError");
   return plans.map((plan,index)=>{
    const d=descriptors[index];let elapsed=d.prefix,delta=0;const selected=[],edgeChanges=new Map();
    for(const leg of d.legs){
     let best=null;const response=resultPairs[leg.queryIndex];
     if(leg.mode&&response?.complete===true){
      for(const record of response.items){
       try{const fit=fitTrip(record.trip,leg);if(!fit)continue;
        const service=core.nextService(fit.trip,0,fit.trip.stops.length-1,departureAt+elapsed*1000,fit.paths);
        if(service&&(!best||service.arrival<best.arrival))best={...service,source:record.source,datasetId:record.datasetId,tripIndex:record.tripIndex};
       }catch{} // Missing geometry or infeasible partial times cannot become a timetable match.
      }
     }
     if(best){
      const duration=best.waitSeconds+best.rideSeconds,weights=leg.edgeIndexes.map(i=>Math.max(0,plan.path.edges[i].distance||0)),total=weights.reduce((a,b)=>a+b,0);
      leg.edgeIndexes.forEach((edgeIndex,i)=>edgeChanges.set(edgeIndex,{duration:best.rideSeconds*(total?weights[i]/total:1/weights.length)+(i?0:best.waitSeconds),
       sharedTimetable:best}));
      delta+=duration-leg.seconds;elapsed+=duration;selected.push(best);
     }else elapsed+=leg.seconds;
    }
    if(!selected.length)return {...plan,timetableStatus:resultPairs.some(p=>p&&!p.complete)?"共享班次候选未读全，保留默认方案":"未找到48小时内符合停靠点、方向和接驳时间的共享班次，使用默认方案"};
    return {...plan,path:{...plan.path,edges:plan.path.edges.map((e,i)=>edgeChanges.has(i)?{...e,...edgeChanges.get(i),route:{...e.route,
     sharedTripNo:edgeChanges.get(i).sharedTimetable.tripId}}:e)},duration:plan.duration+delta,sharedTimetables:selected,
     departureAt,arrivalAt:departureAt+(plan.duration+delta)*1000,timetableStatus:"已优先使用 "+selected.length+" 段共享班次；其余段沿用默认估算"};
   });
  }
  return Object.freeze({enrich,cancel,fitTrip});
 }
 root.HuayuTimetableNavigation=Object.freeze({create});
})(globalThis);
