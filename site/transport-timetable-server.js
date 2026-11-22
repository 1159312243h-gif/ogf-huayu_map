// Shared timetable indexes are committed in the same transaction as dataset chunks.
function timetableInsertStatements(DB,datasetId,timetable){
 if(!timetable)return [];
 const statements=[],core=createTransportTimetableCore();
 timetable.trips.forEach((trip,index)=>{
  statements.push(DB.prepare("INSERT INTO transport_trips(dataset_id,trip_index,mode,trip_id,search_text,data_json) VALUES (?,?,?,?,?,?)")
   .bind(datasetId,index,trip.mode,trip.tripId,[trip.tripId,...trip.stops.map(s=>s.name),...trip.stops.map(s=>s.code)].join("\n"),JSON.stringify(trip)));
  trip.stops.forEach((stop,position)=>core.stopKeys(stop).forEach(key=>statements.push(
   DB.prepare("INSERT INTO transport_calls(dataset_id,trip_index,position,stop_key) VALUES (?,?,?,?)").bind(datasetId,index,position,key))));
 });
 return statements;
}
async function handleTimetableApi(request,environment,url){
 if(!url.pathname.startsWith("/api/timetables"))return null;
 const core=createTransportTimetableCore(),modes=["rail","urban","flight"];
 const select="SELECT t.*,d.title,d.source,d.observed_date,d.revision,u.username,u.display_name FROM transport_trips t JOIN shared_datasets d ON d.id=t.dataset_id JOIN users u ON u.id=d.user_id";
 const item=r=>({datasetId:r.dataset_id,tripIndex:r.trip_index,trip:JSON.parse(r.data_json),
  source:{title:r.title,source:r.source,observedDate:r.observed_date,revision:r.revision,author:{username:r.username,displayName:r.display_name}}});
 const keyValid=k=>typeof k==="string"&&k.length<=240&&/^(?:id:(?:node|way|relation)\/[1-9]\d*|name:.+|code:.+)$/u.test(k);
 const pairSql=(a,b)=>"EXISTS(SELECT 1 FROM transport_calls a JOIN transport_calls b ON a.dataset_id=b.dataset_id AND a.trip_index=b.trip_index AND a.position<b.position WHERE a.dataset_id=t.dataset_id AND a.trip_index=t.trip_index AND a.stop_key IN ("+a.map(()=>"?").join(",")+") AND b.stop_key IN ("+b.map(()=>"?").join(",")+"))";
 if(url.pathname==="/api/timetables/match"&&request.method==="POST"){
  const body=await readJsonBody(request);
  if(!body||!Array.isArray(body.pairs)||body.pairs.length>100)return personalJson({error:"班次匹配查询过多，请分批读取"},400);
  const result=[];
  for(let index=0;index<body.pairs.length;index++){
   const p=body.pairs[index];if(!p||!modes.includes(p.mode)||![p.from,p.to].every(keys=>Array.isArray(keys)&&keys.length>0&&keys.length<=16&&keys.every(keyValid)))
    return personalJson({error:"班次停靠点参数无效"},400);
   const rows=await environment.DB.prepare(select+" WHERE t.mode=? AND "+pairSql(p.from,p.to)+" ORDER BY t.dataset_id,t.trip_index LIMIT 101")
    .bind(p.mode,...p.from,...p.to).all();
   result.push({index,items:rows.results.slice(0,100).map(item),complete:rows.results.length<=100});
  }
  return personalJson({pairs:result,source:"用户共享时刻表，未自动核实实际运营",realtime:false});
 }
 if(url.pathname!=="/api/timetables"||request.method!=="GET")return personalJson({error:"not_found"},404);
 const q=(url.searchParams.get("q")||"").trim(),mode=url.searchParams.get("mode")||"",from=url.searchParams.get("from")||"",to=url.searchParams.get("to")||"";
 const page=Number(url.searchParams.get("page")||0),limit=Number(url.searchParams.get("limit")||20);
 if(q.length>200||mode&&!modes.includes(mode)||!Number.isSafeInteger(page)||page<0||!Number.isSafeInteger(limit)||limit<1||limit>50||from.length>200||to.length>200)
  return personalJson({error:"班次查询参数无效"},400);
 const filter=[],values=[];
 if(q){filter.push("instr(lower(t.search_text),lower(?))>0");values.push(q);}
 if(mode){filter.push("t.mode=?");values.push(mode);}
 if(from&&to){const keys=v=>/^(node|way|relation)[/:]/u.test(v)?["id:"+core.ref(v)]:["name:"+core.name(v),"code:"+core.name(v)];
  const a=keys(from),b=keys(to);filter.push(pairSql(a,b));values.push(...a,...b);
 }
 if(from&&!to||to&&!from){const value=from||to,keys=/^(node|way|relation)[/:]/u.test(value)?["id:"+core.ref(value)]:["name:"+core.name(value),"code:"+core.name(value)];
  filter.push("EXISTS(SELECT 1 FROM transport_calls c WHERE c.dataset_id=t.dataset_id AND c.trip_index=t.trip_index AND c.stop_key IN ("+keys.map(()=>"?").join(",")+"))");values.push(...keys);}
 const rows=await environment.DB.prepare(select+(filter.length?" WHERE "+filter.join(" AND "):"")+" ORDER BY t.dataset_id,t.trip_index LIMIT ? OFFSET ?")
  .bind(...values,limit+1,page*limit).all();
 return personalJson({items:rows.results.slice(0,limit).map(item),nextPage:rows.results.length>limit?page+1:null,complete:rows.results.length<=limit,realtime:false});
}
