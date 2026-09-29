const fs = require("node:fs");
const {api,network} = require("./js03-routing-diagnosis.cjs");
const original = require("../outputs/ogf-atlas/railway-routing.json");
const sources = new Map();
const files = ["outputs/ogf-atlas/transit-relations.json", ...fs.readdirSync("work").filter(n=>n.endsWith("-raw.json")).map(n=>`work/${n}`)];
for (const folder of ["work/railway-routing-regions", "work/railway-routing-country-regions", "work/railway-routing-way-batches"]) {
  if (fs.existsSync(folder)) files.push(...fs.readdirSync(folder).filter(n=>n.endsWith(".json")).map(n=>`${folder}/${n}`));
}
for (const file of files) {
  const payload = JSON.parse(fs.readFileSync(file,"utf8"));
  const items = payload.elements || payload.snapshots?.flatMap(s=>s.elements||[]) || [];
  for (const w of items) if(w.type==="way" && ["rail","narrow_gauge"].includes(w.tags?.railway)
    && w.geometry?.length>1 && w.nodes?.length===w.geometry.length) sources.set(w.id,w);
}
const combined = structuredClone(original);
const ids = new Set(combined.ways.map(w=>w[0]));
const extras = [...sources.values()].filter(w=>!ids.has(w.id));
combined.ways.push(...extras.map(w=>[w.id,w.nodes,w.geometry.map(p=>[p.lat,p.lon]),w.tags.name||"",w.tags.maxspeed||"",w.tags.highspeed==="yes"?1:0]));
const fresh = ["work/rail-gap-focused-raw.json","work/jinchuan-interchange-raw.json"].filter(file=>fs.existsSync(file))
  .flatMap(file=>JSON.parse(fs.readFileSync(file,"utf8")).elements);
const compact = w=>[w.id,w.nodes,w.geometry.map(p=>[p.lat,p.lon]),w.tags.name||"",w.tags.maxspeed||"",w.tags.highspeed==="yes"?1:0];
const freshById = new Map(fresh.map(w=>[w.id,w]));
combined.ways = combined.ways.map(w=>freshById.has(w[0]) ? compact(freshById.get(w[0])) : w);
api.setRailwayData(process.argv.includes("--original") ? original : combined);
const graph = api.getRailInfrastructureGraph(network);
const selected = ["平章南","逻山","津川","苍湖风景区"]
  .map(name=>network.stops.find(s=>s.name===name&&s.routes.some(r=>r.type==="train")));
const componentSizes = new Map();
graph.components.forEach(c=>componentSizes.set(c,(componentSizes.get(c)||0)+1));
const dist = (a,b)=>Math.hypot((a.lat-b.lat)*111320,(a.lon-b.lon)*111320*Math.cos(a.lat*Math.PI/180));
const degree = id => new Set(graph.nodeAdjacency[id].map(e=>e.to)).size;
const ends = graph.nodes.flatMap((point,id)=>degree(id)===1 ? [{id,point,component:graph.components[id],neighbor:graph.nodeAdjacency[id][0].to}] : []);
const cells = new Map();
const key = p=>`${Math.floor(p.lat/0.02)}:${Math.floor(p.lon/0.02)}`;
ends.forEach(e=>{const k=key(e.point);if(!cells.has(k))cells.set(k,[]);cells.get(k).push(e);});
const alignment = (e,target)=>{
  const prev=graph.nodes[e.neighbor], p=e.point, scale=Math.cos(p.lat*Math.PI/180);
  const x=(p.lon-prev.lon)*scale,y=p.lat-prev.lat,tx=(target.lon-p.lon)*scale,ty=target.lat-p.lat;
  return (x*tx+y*ty)/(Math.hypot(x,y)*Math.hypot(tx,ty)||1);
};
const candidates = [];
for (const e of ends) {
  const lat=Math.floor(e.point.lat/0.02),lon=Math.floor(e.point.lon/0.02);
  for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(const other of cells.get(`${lat+i}:${lon+j}`)||[]) {
    if(e.id>=other.id || e.component===other.component)continue;
    const distance=dist(e.point,other.point);
    if(distance>2000)continue;
    candidates.push({from:e.id,to:other.id,fromComponent:e.component,toComponent:other.component,distance,
      alignment:Math.min(alignment(e,other.point),alignment(other,e.point)),geometry:[e.point,other.point]});
  }
}
candidates.sort((a,b)=>a.distance-b.distance);
const projections = selected.map(s=>({name:s.name,lat:s.lat,lon:s.lon,
  candidates:api.railNodeCandidatesForStop(s,graph).map(c=>({component:graph.components[c.nodeId],line:graph.lines[c.lineIndex].id,offset:c.offset})),
  nearest:graph.lines.map(l=>({id:l.id,name:l.routes[0]?.label,distance:Math.min(...l.geometry.slice(1).map((b,i)=>api.projectPointToTransitSegment(s,l.geometry[i],b).distance))})).sort((a,b)=>a.distance-b.distance).slice(0,3)}));
const connectivity = (limit,minAlignment)=>{
  const parent=Array.from({length:componentSizes.size},(_,i)=>i);
  const root = c=>{while(parent[c]!==c){parent[c]=parent[parent[c]];c=parent[c];}return c;};
  const bridges=candidates.filter(c=>c.distance<=limit&&c.alignment>=minAlignment);
  bridges.forEach(c=>{parent[root(c.fromComponent)]=root(c.toComponent);});
  return {limit,minAlignment,bridges:bridges.length,pairs:projections.flatMap((a,i)=>projections.slice(i+1).map(b=>({from:a.name,to:b.name,
    connected:a.candidates.some(c=>b.candidates.some(d=>root(c.component)===root(d.component)))})))};
};
const components=new Set(projections.flatMap(p=>p.candidates.map(c=>c.component)));
const report = {extraActualWays:extras.length,tracks:graph.lines.length,components:componentSizes.size,terminalNodes:ends.length,
  projections,nearSelectedComponents:candidates.filter(c=>components.has(c.fromComponent)||components.has(c.toComponent)).slice(0,35),
  trialConnectivity:[connectivity(300,0.5),connectivity(800,0.5),connectivity(2000,0.5),connectivity(800,-1)],
  fallStations:network.stops.filter(s=>s.name.includes("落花")).map(s=>({name:s.name,lat:s.lat,lon:s.lon})),
};
if (require.main === module) console.log(JSON.stringify(process.argv.includes("--compact")
  ? {...report,nearSelectedComponents:report.nearSelectedComponents.slice(0,3)} : report,null,2));
module.exports={api,network,graph,combined,sources,extras,selected,candidates,ends,componentSizes,report};
