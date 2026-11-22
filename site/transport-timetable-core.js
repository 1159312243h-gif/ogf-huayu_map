// Shared verbatim by local preview, upload Worker, and navigation.
function createTransportTimetableCore(){
 "use strict";
 const kinds={rail_timetable:"rail",urban_timetable:"urban",flight_timetable:"flight"};
 const defaults={rail:{speedKmh:120,acceleration:.6,deceleration:.7,lateralAcceleration:.65,dwell:120},
  urban:{speedKmh:80,acceleration:1,deceleration:1,lateralAcceleration:.8,dwell:45},
  flight:{speedKmh:800,acceleration:1.5,deceleration:1.5,lateralAcceleration:1,dwell:2400}};
 const error=s=>{throw Object.assign(Error(s),{status:400});};
 const text=v=>v==null?"":String(v).trim(),name=v=>text(v).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ");
 const number=(v,d)=>v===""||v==null?d:Number(v);
 function date(v){if(!/^\d{4}-\d{2}-\d{2}$/u.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)error("开行日期无效");return v;}
 function offset(v){const m=text(v||"+08:00").match(/^([+-])(\d{2}):(\d{2})$/u);if(!m||Number(m[2])>14||Number(m[3])>59||Number(m[2])===14&&Number(m[3]))error("时区须为 ±HH:mm（如 +08:00）");return (m[1]==="-"?-1:1)*(Number(m[2])*60+Number(m[3]));}
 function clock(v){if(v==null||v==="")return null;const m=text(v).match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/u);if(!m||Number(m[1])>71)error("时刻须为 HH:mm 或 HH:mm:ss，跨日可使用 24:10");return Number(m[1])*3600+Number(m[2])*60+Number(m[3]||0);}
 function ref(v){const s=text(v).replace(":", "/");if(!s)return "";const m=s.match(/^(node|way|relation)\/([1-9]\d{0,15})$/u);if(!m||!Number.isSafeInteger(Number(m[2])))error("停靠点编号须为 node/123、way/123 或 relation/123");return m[1]+"/"+Number(m[2]);}
 function stopKeys(s){return [...new Set([s.ref&&"id:"+s.ref,s.code&&"code:"+name(s.code),s.name&&"name:"+name(s.name)].filter(Boolean))];}
 function parameters(p,mode){const d=defaults[mode],result={};
  for(const [key,column,min,max] of [["speedKmh","vehicle_speed_kmh",1,1500],["acceleration","acceleration_mps2",.01,8],["deceleration","deceleration_mps2",.01,8],["lateralAcceleration","lateral_acceleration_mps2",.01,4],["dwell","dwell_seconds",0,86400]]){
   const v=number(p[column],d[key]);if(!Number.isFinite(v)||v<min||v>max)error("车辆参数无效："+column);result[key]=v;
  }return result;
 }
 function normalize(records,kind){
  const mode=kinds[kind];if(!mode)return null;
  const groups=new Map();
  records.forEach((r,index)=>{
   const p=r.properties,tripId=text(p.trip_id||p.trip_no||p["车次号"]||p["航班号"]||"未命名班次");
   if(tripId.length>100)error("车次／航班编号过长");
   const n=number(p.stop_sequence,index+1);if(!Number.isSafeInteger(n)||n<1)error("stop_sequence 须为正整数");
   let identity=text(p.stop_id);if(!identity&&r.target)identity=r.target.type+"/"+r.target.id;
   const s={sequence:n,ref:ref(identity),name:text(p.stop_name||p.station||p["站名"]||p.name),code:text(p.stop_code).toUpperCase(),
    arrival:clock(p.arrival),departure:clock(p.departure??p.time??p["停靠时间"]),offsetMinutes:offset(p.utc_offset)};
   if(!s.ref&&!s.code&&!s.name)error("每行须有停靠点名称、stop_id 或 stop_code");
   if(s.name.length>200||s.code.length>20)error("停靠点文字过长");
   if(r.geometry?.type==="Point")s.point={lon:r.geometry.coordinates[0],lat:r.geometry.coordinates[1]};
   const start=text(p.service_date||p.start_date),end=text(p.service_date||p.end_date);
   if(start)date(start);if(end)date(end);if(start&&end&&start>end)error("开行日期范围倒置");
   const days=text(p.service_days||"1234567").replace(/[ ,;；]/gu,"");
   if(!/^[1-7]+$/u.test(days)||new Set(days).size!==days.length)error("service_days 用 1 至 7 表示周一至周日");
   const route=ref(p.route_id),vehicle=parameters(p,mode),meta={mode,tripId,routeId:route,startDate:start,endDate:end,days,vehicle};
   const signature=JSON.stringify(meta),key=tripId;
   if(!groups.has(key))groups.set(key,{...meta,stops:[],signature});
   const trip=groups.get(key);if(trip.signature!==signature)error("同车次的开行日期、线路和车辆参数不一致，请使用不同 trip_id");
   trip.stops.push(s);
  });
  const trips=[...groups.values()];
  for(const t of trips){
   t.stops.sort((a,b)=>a.sequence-b.sequence);delete t.signature;
   if(t.stops.length<2||new Set(t.stops.map(s=>s.sequence)).size!==t.stops.length)error("每个班次至少两站且站序不能重复");
   if(t.stops[0].departure===null&&t.stops[0].arrival===null)error("首个停靠点至少填写出发时间或到达时间");
   let previous=null;
   for(const s of t.stops){
    // HH:mm rolls forward at midnight; explicit 24+ values must be consistent.
    for(const k of ["arrival","departure"]){let value=s[k];if(value===null)continue;
     let utc=value-s.offsetMinutes*60;if(previous!==null&&utc<previous){if(value>=86400)error("显式跨日时刻早于前一停靠事件");while(utc<previous){utc+=86400;value+=86400;}}
     s[k+"Seconds"]=utc;previous=utc;
    }
   }
  }
  return {schema:"huayu-timetable-v1",mode,trips};
 }
 const radians=x=>x*Math.PI/180;
 function distance(a,b){const dy=radians(b.lat-a.lat),dx=radians(b.lon-a.lon),v=Math.sin(dy/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dx/2)**2;return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));}
 function speed(v){const m=text(v).match(/^(\d+(?:\.\d+)?)(?:\s*(mph|km\/h|kmh))?$/iu);return m?Number(m[1])*(m[2]?.toLowerCase()==="mph"?1.609344:1):null;}
 function estimate(segments,vehicle=defaults.rail,mode="rail"){
  if(!Array.isArray(segments)||!segments.length)error("没有完整实际路径，不能估算铁路运行时间");
  const p={...defaults[mode],...vehicle};let points=[],caps=[],trackUnknown=false;
  for(const segment of segments){
   const geometry=segment.geometry||segment,limit=speed(segment.maxspeed??segment.tags?.maxspeed??segment.tags?.["maxspeed:rail"]);
   if(!limit)trackUnknown=true;
   if(!Array.isArray(geometry)||geometry.length<2||geometry.some(v=>!Number.isFinite(v.lat)||!Number.isFinite(v.lon)))error("路径几何不完整");
   if(points.length&&distance(points.at(-1),geometry[0])>2)error("轨道不连续，不能用直线补齐");
   for(let i=0;i<geometry.length;i++){
    const v=geometry[i],cap=Math.min(p.speedKmh,limit||p.speedKmh)/3.6;
    if(points.length&&distance(points.at(-1),v)<.001){caps[caps.length-1]=Math.min(caps.at(-1),cap);continue;}
    points.push(v);caps.push(cap);
   }
  }
  if(points.length<2)error("路径长度不足");
  if(mode==="flight"){const meters=points.slice(1).reduce((s,v,i)=>s+distance(points[i],v),0);return {seconds:Math.ceil(meters/(p.speedKmh/3.6)+1200),meters,estimated:true,method:"航空航程／巡航速度 + 20分钟起降滑行假设",trackUnknown:true};}
  let curved=0;
  for(let i=1;i<points.length-1;i++){
   const a=points[i-1],b=points[i],c=points[i+1],lat=radians(b.lat);
   const x1=radians(a.lon-b.lon)*6371000*Math.cos(lat),y1=radians(a.lat-b.lat)*6371000;
   const x2=radians(c.lon-b.lon)*6371000*Math.cos(lat),y2=radians(c.lat-b.lat)*6371000;
   const twiceArea=Math.abs(x1*y2-y1*x2),ab=Math.hypot(x1,y1),bc=Math.hypot(x2,y2),ac=Math.hypot(x2-x1,y2-y1);
   if(twiceArea>1e-6&&ab>.01&&bc>.01){const radius=ab*bc*ac/(2*twiceArea),curveCap=Math.sqrt(p.lateralAcceleration*radius);
    if(curveCap<caps[i]){caps[i]=curveCap;curved++;}}
  }
  // Subdivide long original segments without changing their alignment or bend radii.
  const nodes=[{cap:caps[0]}],lengths=[],limits=[];let meters=0;
  for(let i=1;i<points.length;i++){const d=distance(points[i-1],points[i]),count=Math.max(1,Math.ceil(d/200)),limit=Math.min(p.speedKmh/3.6,
    // Vertex bend limits apply at the vertex; straight interiors keep the track/vehicle cap.
    Math.max(caps[i-1],caps[i]));
   for(let j=1;j<=count;j++){lengths.push(d/count);limits.push(limit);nodes.push({cap:j===count?caps[i]:limit});}meters+=d;
  }
  nodes[0].cap=nodes.at(-1).cap=0;
  const velocities=nodes.map(n=>n.cap);
  for(let i=1;i<nodes.length;i++)velocities[i]=Math.min(velocities[i],Math.sqrt(velocities[i-1]**2+2*p.acceleration*lengths[i-1]));
  for(let i=nodes.length-2;i>=0;i--)velocities[i]=Math.min(velocities[i],Math.sqrt(velocities[i+1]**2+2*p.deceleration*lengths[i]));
  let seconds=0;
  for(let i=0;i<lengths.length;i++){
   const d=lengths[i],u=velocities[i],v=velocities[i+1],a=p.acceleration,b=p.deceleration;
   const peak=Math.min(limits[i],Math.sqrt((2*a*b*d+b*u*u+a*v*v)/(a+b)));
   const accelerating=Math.max(0,(peak*peak-u*u)/(2*a)),braking=Math.max(0,(peak*peak-v*v)/(2*b));
   seconds+=Math.max(0,peak-u)/a+Math.max(0,peak-v)/b+Math.max(0,d-accelerating-braking)/Math.max(.001,peak);
  }
  return {seconds:Math.ceil(seconds),meters,estimated:true,method:"分段限速、曲率与加减速包络",trackUnknown,curvedVertices:curved,vehicle:p};
 }
 function resolveTimes(trip,paths=[]){
  const t={...trip,stops:trip.stops.map(s=>({...s})),estimates:[]};let previous=null;
  for(let i=0;i<t.stops.length;i++){
   const s=t.stops[i];let arr=s.arrivalSeconds??null,dep=s.departureSeconds??null;
   if(i&&arr===null){if(dep!==null)arr=dep;else {if(!paths[i-1])error("缺失时刻且未确认连续路径");const e=estimate(paths[i-1],t.vehicle,t.mode);arr=previous+e.seconds;t.estimates.push({toIndex:i,...e});}}
   if(i===0&&arr===null)arr=dep;
   if(dep===null){dep=arr+(i>0&&i<t.stops.length-1?t.vehicle.dwell:0);s.departureEstimated=dep!==arr;}
   if(previous!==null&&arr<previous||dep<arr)error("停靠时间与前段运行／停站时间冲突");
   s.arrivalSeconds=arr;s.departureSeconds=dep;s.timeEstimated=t.estimates.some(e=>e.toIndex===i)||s.departureEstimated||i>0&&s.arrivalSeconds==null;previous=dep;
  }return t;
 }
 function nextService(trip,fromIndex,toIndex,readyAt,paths=[]){
  const t=resolveTimes(trip,paths),from=t.stops[fromIndex],to=t.stops[toIndex];
  if(!from||!to||fromIndex>=toIndex)return null;
  let best=null;
  // Service days belong to the first stop's local departure date.
  const firstOffset=(t.calendarOffset??t.stops[0].offsetMinutes)*60000,base=Date.parse(new Date(readyAt+firstOffset).toISOString().slice(0,10));
  const maxOffset=Math.ceil(t.stops.reduce((m,s)=>Math.max(m,s.departureSeconds),0)/86400)+1;
  for(let day=-maxOffset;day<=2;day++){
   const midnight=base+day*86400000,key=new Date(midnight).toISOString().slice(0,10),weekday=new Date(midnight).getUTCDay()||7;
   if(t.startDate&&key<t.startDate||t.endDate&&key>t.endDate||!t.days.includes(String(weekday)))continue;
   const departure=midnight+from.departureSeconds*1000,arrival=midnight+to.arrivalSeconds*1000;
   if(departure<readyAt||departure>readyAt+48*3600000)continue;
   const candidate={tripId:t.tripId,mode:t.mode,departure,arrival,waitSeconds:(departure-readyAt)/1000,rideSeconds:(arrival-departure)/1000,
    estimated:t.stops.slice(fromIndex,toIndex+1).some(s=>s.timeEstimated),serviceDate:key,stops:t.stops.slice(fromIndex,toIndex+1),estimates:t.estimates,vehicle:t.vehicle};
   if(!best||candidate.arrival<best.arrival||candidate.arrival===best.arrival&&candidate.departure<best.departure)best=candidate;
  }return best;
 }
 return Object.freeze({kinds,defaults,normalize,stopKeys,name,ref,estimate,resolveTimes,nextService,distance});
}
globalThis.HuayuTimetableCore=createTransportTimetableCore();
