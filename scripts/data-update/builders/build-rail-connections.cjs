const fs=require("node:fs");
const {createHash}=require("node:crypto");
const d=require("./rail-gap-diagnosis.cjs");
const {graph}=d;
const original=require("../outputs/ogf-atlas/railway-routing.json");
const originalById=new Map(original.ways.map(w=>[w[0],w]));
const nodeRefs=new Map(),nodeLines=new Map();
graph.lines.forEach(l=>l.nodeIds.forEach((id,i)=>{
  nodeRefs.set(id,l.nodeRefs[i]);
  if(!nodeLines.has(id))nodeLines.set(id,[]);
  nodeLines.get(id).push(l);
}));
const distance=(a,b)=>d.api.transitGeometryLength([a,b]);
const cos=(a,b,c,e)=>{
  const scale=Math.cos(a.lat*Math.PI/180),x=(b.lon-a.lon)*scale,y=b.lat-a.lat,
    tx=(e.lon-c.lon)*scale,ty=e.lat-c.lat;
  return (x*tx+y*ty)/(Math.hypot(x,y)*Math.hypot(tx,ty)||1);
};
const compatible=(a,b)=>nodeLines.get(a).some(l=>nodeLines.get(b).some(m=>{
  const x=d.sources.get(l.id)?.tags||{},y=d.sources.get(m.id)?.tags||{};
  if(x.service||y.service)return false;
  return ["gauge","layer"].every(k=>x[k]==null||y[k]==null||String(x[k])===String(y[k]));
}));
const links=[],used=new Set(),counts=new Map();
const add=(from,to,kind="short-gap",geometry=[graph.nodes[from],graph.nodes[to]],label="短断点推定连接")=>{
  const id=`rail-link:${nodeRefs.get(from)}:${nodeRefs.get(to)}`;
  links.push({id,from:nodeRefs.get(from),to:nodeRefs.get(to),kind,label,
    geometry:geometry.map(p=>[p.lat,p.lon]),distance:distanceTotal(geometry)});
};
const distanceTotal=g=>d.api.transitGeometryLength(g);
const eligible=d.candidates.filter(c=>c.distance>=1&&c.distance<=800&&c.alignment>=0.85&&compatible(c.from,c.to));
const nearest=new Map();
eligible.forEach(c=>[c.from,c.to].forEach(id=>nearest.set(id,Math.min(nearest.get(id)??Infinity,c.distance))));
for(const c of eligible) {
  if((counts.get(c.from)||0)>=2||(counts.get(c.to)||0)>=2
    ||c.distance>nearest.get(c.from)+25||c.distance>nearest.get(c.to)+25)continue;
  add(c.from,c.to);used.add(c.from);used.add(c.to);
  [c.from,c.to].forEach(id=>counts.set(id,(counts.get(id)||0)+1));
}
// A crossover is inferred only inside an already-qualified break in the same double-track corridor.
for(const c of d.candidates) {
  if(c.distance<1||c.distance>15||!used.has(c.from)||!used.has(c.to)||!compatible(c.from,c.to))continue;
  const a=d.ends.find(e=>e.id===c.from),b=d.ends.find(e=>e.id===c.to);
  if(cos(graph.nodes[a.neighbor],a.point,graph.nodes[b.neighbor],b.point)<0.98)continue;
  if(!nodeLines.get(c.from).some(l=>l.routes[0].label&&nodeLines.get(c.to).some(m=>m.routes[0].label===l.routes[0].label)))continue;
  add(c.from,c.to,"short-gap",[a.point,b.point],"断点区间推定并线（未确认道岔）");
}
// Only a forward continuation to an existing node qualifies as an inferred junction.
const cells=new Map(),cell=p=>`${Math.floor(p.lat/0.002)}:${Math.floor(p.lon/0.002)}`;
graph.nodes.forEach((p,i)=>{const k=cell(p);if(!cells.has(k))cells.set(k,[]);cells.get(k).push(i);});
for(const end of d.ends) {
  if(used.has(end.id))continue;
  const y=Math.floor(end.point.lat/0.002),x=Math.floor(end.point.lon/0.002),near=[];
  for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(const id of cells.get(`${y+i}:${x+j}`)||[]) {
    if(graph.components[id]===end.component||used.has(id))continue;
    const p=graph.nodes[id],len=distance(end.point,p);
    if(len<1||len>150||cos(graph.nodes[end.neighbor],end.point,end.point,p)<0.8||!compatible(end.id,id))continue;
    const tangent=graph.nodeAdjacency[id].some(e=>Math.abs(cos(end.point,p,p,graph.nodes[e.to]))>=0.8);
    if(tangent)near.push({id,len});
  }
  near.sort((a,b)=>a.len-b.len);
  if(near.length){add(end.id,near[0].id);used.add(end.id);}
}
// The longer Luohua extension is explicitly user-requested planning, not an OGF track.
for(const sourceWay of [42076843,42076844]) {
  const line=graph.lines.find(l=>l.id===sourceWay),from=line.nodeIds.at(-1),start=graph.nodes[from],prev=graph.nodes[line.nodeIds.at(-2)];
  const target=graph.lines.filter(l=>[34053547,34078316].includes(l.id))
    .flatMap(l=>l.nodeIds.map((id,i)=>({id,line:l,i,p:graph.nodes[id]})))
    .filter(t=>t.i>0&&t.i<t.line.nodeIds.length-1&&t.p.lon>start.lon+0.04&&t.p.lat>15.04&&t.p.lat<15.11)
    .sort((a,b)=>distance(start,a.p)-distance(start,b.p))[0];
  if(!target)throw new Error("Luohua target missing");
  const end=target.p,neighbors=[target.i-1,target.i+1].map(i=>graph.nodes[target.line.nodeIds[i]]),
    next=neighbors.sort((a,b)=>a.lat-b.lat)[0],len=distance(start,end),scale=111320;
  const unit=(a,b)=>{const x=(b.lon-a.lon)*Math.cos(a.lat*Math.PI/180),y=b.lat-a.lat,n=Math.hypot(x,y);return {x:x/n,y:y/n};};
  const u=unit(prev,start),v=unit(end,next),arm=len/3/scale;
  const p1={lat:start.lat+u.y*arm,lon:start.lon+u.x*arm/Math.cos(start.lat*Math.PI/180)},
    p2={lat:end.lat-v.y*arm,lon:end.lon-v.x*arm/Math.cos(end.lat*Math.PI/180)};
  const geometry=Array.from({length:25},(_,i)=>{const t=i/24,s=1-t;return {
    lat:s**3*start.lat+3*s*s*t*p1.lat+3*s*t*t*p2.lat+t**3*end.lat,
    lon:s**3*start.lon+3*s*s*t*p1.lon+3*s*t*t*p2.lon+t**3*end.lon};});
  add(from,target.id,"planned-extension",geometry,"落花规划接入（未建成／未确认运营）");
}
const compact=w=>[w.id,w.nodes,w.geometry.map(p=>[p.lat,p.lon]),w.tags?.name||"",w.tags?.maxspeed||"",w.tags?.highspeed==="yes"?1:0];

(async()=>{
  const wayMap=new Map(d.combined.ways
    .filter(w=>!originalById.has(w[0])||JSON.stringify(w)!==JSON.stringify(originalById.get(w[0])))
    .map(w=>[String(w[0]),w]));
  const baselinePath="baseline/railway-connections.json";
  let refreshedBaselineWays=0;
  if(fs.existsSync(baselinePath)) {
    const baseline=JSON.parse(fs.readFileSync(baselinePath,"utf8"));
    const missingIds=[...new Set((baseline.ways||[]).map(w=>w[0])
      .filter(id=>!originalById.has(id)&&!wayMap.has(String(id))))];
    if(missingIds.length) {
      const hash=createHash("sha256").update(JSON.stringify(missingIds)).digest("hex").slice(0,16);
      const cachePath=`work/railway-connections-baseline-refresh-${hash}.json`;
      let current=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,"utf8")):null;
      let lastError;
      for(let attempt=1;!current&&attempt<=3;attempt+=1) {
        try {
          const query=`[out:json][timeout:90];way(id:${missingIds.join(",")});out body geom;`;
          const response=await fetch("https://overpass.opengeofiction.net/api/interpreter",{
            method:"POST",headers:{"content-type":"application/x-www-form-urlencoded;charset=UTF-8"},
            body:`data=${encodeURIComponent(query)}`,signal:AbortSignal.timeout(120000),
          });
          const body=await response.text();
          if(!response.ok)throw new Error(`Overpass ${response.status}: ${body.slice(0,500)}`);
          current=JSON.parse(body);
          if(current.remark||!Array.isArray(current.elements))throw new Error(current.remark||"malformed baseline railway response");
          fs.writeFileSync(cachePath,JSON.stringify(current));
        } catch(error) {
          lastError=error;
          if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*2000));
        }
      }
      if(!current)throw lastError;
      for(const way of current.elements||[]) {
        if(way.type!=="way"||!["rail","narrow_gauge"].includes(way.tags?.railway)
          ||!Array.isArray(way.nodes)||!Array.isArray(way.geometry)
          ||way.nodes.length!==way.geometry.length||way.geometry.length<2)continue;
        wayMap.set(String(way.id),compact(way));
        refreshedBaselineWays+=1;
      }
    }
  }
  const ways=[...wayMap.values()];
  const payload={format:1,generatedAt:new Date().toISOString(),source:"OpenGeofiction cached geometry; inferred links are NOT OGF data or confirmed services",
    limits:{shortGapMeters:800,junctionMeters:150,minFacingCosine:0.85},ways,links};
  fs.writeFileSync("outputs/ogf-atlas/railway-connections.json",JSON.stringify(payload));
  console.log(JSON.stringify({ways:ways.length,links:links.length,refreshedBaselineWays,
    planned:links.filter(l=>l.kind==="planned-extension")},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
