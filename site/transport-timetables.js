(function(root){
 "use strict";
 function start(){
  const atlas=root.HuayuAtlas,core=root.HuayuTimetableCore,$=id=>document.getElementById("timetable-"+id);
  const records=new Map();
  let page=0,queryController=null,epoch=0,loaded=[],nextPage=null,estimateController=null;
  const el=(tag,value)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;return n;};
  const display=(seconds,offset)=>{if(seconds==null)return "待估算";const local=seconds+offset*60,day=Math.floor(local/86400),s=((local%86400)+86400)%86400;
   return (day?"第"+(day+1)+"日 ":"")+String(Math.floor(s/3600)).padStart(2,"0")+":"+String(Math.floor(s%3600/60)).padStart(2,"0");};
  async function read(args={},signal){
   const params=new URLSearchParams({q:args.query||"",mode:args.mode||"",from:args.from||"",to:args.to||"",page:String(args.page||0)});
   const r=await fetch("/api/timetables?"+params,{cache:"no-store",signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
   const data=await r.json();if(!r.ok)throw Error(data.error==="personal_data_service_not_configured"?"共享数据库尚未配置":data.error||"班次读取失败");
   for(const record of data.items){const key=record.datasetId+":"+record.tripIndex;records.delete(key);records.set(key,record);}
   while(records.size>100)records.delete(records.keys().next().value);
   return data;
  }
  async function estimateService(args,signal){
    const record=records.get(args.datasetId+":"+args.tripIndex);if(!record)throw Error("请先查询并选择已读取的班次");
    const missing=record.trip.stops.some((s,i)=>i>0&&s.arrivalSeconds==null&&s.departureSeconds==null);
    const paths=missing?await atlas.getTimetablePaths(record.trip,{signal}):[];
    if(signal?.aborted)throw new DOMException("已取消","AbortError");
    return {...record,trip:core.resolveTimes(record.trip,paths)};
  }
  function render(){
   $("results").replaceChildren();
   for(const record of loaded){
    const trip=record.trip,card=el("article");card.className="feature-info-card";
    card.append(el("h4",trip.tripId+" · "+({rail:"铁路",urban:"城铁",flight:"航班"})[trip.mode]),
     el("p",(trip.stops[0].name||trip.stops[0].ref||trip.stops[0].code)+" → "+(trip.stops.at(-1).name||trip.stops.at(-1).ref||trip.stops.at(-1).code)),
     el("p",(trip.startDate||"不限起始日")+" — "+(trip.endDate||"不限结束日")+" · 周 "+trip.days.split("").join("、")),
     el("p",record.source.title+" · "+record.source.author.displayName+" · 来源 "+record.source.source+" · 日期 "+record.source.observedDate));
    const table=el("table"),head=el("tr");for(const title of ["停靠点","到达","出发","UTC时区"])head.append(el("th",title));table.append(head);
    for(const stop of trip.stops){const tr=el("tr");for(const v of [stop.name||stop.ref||stop.code,display(stop.arrivalSeconds,stop.offsetMinutes),display(stop.departureSeconds,stop.offsetMinutes),(stop.offsetMinutes>=0?"+":"-")+String(Math.floor(Math.abs(stop.offsetMinutes)/60)).padStart(2,"0")+":"+String(Math.abs(stop.offsetMinutes)%60).padStart(2,"0")])tr.append(el("td",v));table.append(tr);}
    const wrap=el("div");wrap.className="dataset-table-scroll";wrap.append(table);card.append(wrap);
    const estimate=el("button","估算缺失运行时间");estimate.type="button";estimate.className="text-button";
    estimate.onclick=async()=>{
     estimateController?.abort();estimateController=new AbortController();const token=epoch;estimate.disabled=true;
     try{const data=await estimateService({datasetId:record.datasetId,tripIndex:record.tripIndex},estimateController.signal);if(token!==epoch)return;
      loaded=loaded.map(r=>r===record?data:r);render();$("status").textContent=data.trip.estimates.length?"已根据可确认路径和车辆参数估算；上传时刻保留，估算未发布。":"已保留原时刻并补齐到发字段；无需运行路径估算，尚未发布。";
     }catch(e){if(!estimateController.signal.aborted)$("status").textContent=e.message+"；原时刻表保留。";}finally{estimate.disabled=false;}
    };
    const download=el("button","下载时刻表 JSON");download.type="button";download.className="text-button";
    download.onclick=()=>root.HuayuDownloadCenter.download(new Blob([JSON.stringify(record,null,2)],{type:"application/json"}),trip.tripId+"-时刻表.json");
    card.append(estimate,download);$("results").append(card);
   }
   $("more").hidden=nextPage===null;
  }
  async function search(more=false){
   queryController?.abort();estimateController?.abort();const token=++epoch;queryController=new AbortController();
   $("status").textContent="正在查询共享车次与航班…";
   try{const p=more?nextPage:0,data=await read({query:$("query").value,mode:$("mode").value,from:$("from").value,to:$("to").value,page:p},queryController.signal);
    if(token!==epoch)return;page=p;loaded=more?[...loaded,...data.items]:data.items;nextPage=data.nextPage;render();
    $("status").textContent=loaded.length?"已读 "+loaded.length+" 个班次"+(nextPage!==null?"，可继续翻页":"")+"。共享资料不代表实时运行。":"当前条件下没有共享班次；导航继续使用默认方案。";
   }catch(e){if(token===epoch&&!queryController.signal.aborted)$("status").textContent=e.message+"；保留已显示结果。";}
  }
  $("search").onclick=()=>search();$("more").onclick=()=>search(true);
  $("query").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();search();}};
  $("upload").onclick=()=>{atlas.openView("datasets",{preservePerspective:true});document.getElementById("dataset-upload-section").open=true;};
  $("now").onclick=()=>{$("departure").value="";nav.cancel();};
  const nav=root.HuayuTimetableNavigation.create({describe:plan=>atlas.describeTimetablePlan(plan)});
  for(const id of ["route-origin","route-destination","timetable-departure"])document.getElementById(id).addEventListener("input",()=>nav.cancel());
  document.getElementById("route-form").addEventListener("submit",()=>nav.cancel(),{capture:true});
  document.querySelectorAll("[data-mode]").forEach(n=>n.addEventListener("click",()=>nav.cancel()));
  document.addEventListener("visibilitychange",()=>{if(document.hidden){queryController?.abort();estimateController?.abort();epoch++;}});
  addEventListener("pagehide",()=>{nav.cancel();queryController?.abort();estimateController?.abort();});
  root.HuayuTimetables=Object.freeze({query:read,estimate:estimateService,cancel:nav.cancel,setActive(value){if(!value){queryController?.abort();estimateController?.abort();epoch++;}},enrich(plans){
   const value=$("departure").value,departureAt=value?new Date(value).getTime():Date.now();
   if(!Number.isFinite(departureAt))return Promise.reject(Error("出发时间无效"));
   return nav.enrich(plans,{departureAt});
  }});
 }
 if(root.HuayuAtlas)start();else addEventListener("huayu:map-ready",start,{once:true});
})(window);
