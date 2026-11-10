// Explicit on-demand regional audit. Uses the production loader and simulation;
// never changes source data, published snapshots, or the current browser result.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),replay=args.includes('--replay'),refreshPopulation=args.includes('--refresh-population');
const ids=args.filter(a=>/^\d+$/.test(a));
if(!ids.length)throw Error('Usage: node scripts/audit-traffic-regions.mjs [--replay | --refresh-population] relation_id ...');
if(replay&&refreshPopulation)throw Error('Choose --replay or --refresh-population, not both');
const output=path.join(root,'.data-update','traffic-audit');await fs.mkdir(output,{recursive:true});
const context=vm.createContext({console,fetch,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,Float64Array});
for(const name of ['traffic-core','traffic-demand','traffic-regions','traffic-regional-sites','traffic-regional-core'])
  vm.runInContext(await fs.readFile(path.join(root,'site',name+'.js'),'utf8'),context);
const R=context.HuayuTrafficRegions,U=context.HuayuRegionalTraffic;
const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-5,Math.abs(b)*1e-9);
const reports=[];
for(const id of ids){
 const startedAt=new Date().toISOString(),start=Date.now();let stage='boundary',name=id,level,selection,input;
 try{
  if(replay){
   input=JSON.parse(await fs.readFile(path.join(output,id+'-input.json'),'utf8'));
   selection=JSON.parse(await fs.readFile(path.join(output,id+'-selection.json'),'utf8'));
   const raw=JSON.parse(await fs.readFile(path.join(output,id+'-admin.json'),'utf8'));
   input.population=R.populationZones(raw.elements,selection,input.features);
  }else{
   if(refreshPopulation){selection=JSON.parse(await fs.readFile(path.join(output,id+'-selection.json'),'utf8'));name=selection[0].name;level=selection[0].extratags?.admin_level;}
   else {
   const raw=await R.request(`[out:json][timeout:40];rel(${id});out body geom;out count;`,undefined,{label:'审计行政边界'});
   const relation=raw.elements.find(e=>e.type==='relation'&&String(e.id)===id);
   if(!relation)throw Error('未找到行政关系');
   name=relation.tags.name;level=relation.tags.admin_level;
   selection=[{osm_type:'relation',osm_id:relation.id,name,extratags:relation.tags,geojson:R.geometry(relation)}];
   await fs.writeFile(path.join(output,id+'-selection.json'),JSON.stringify(selection));
   }
   stage='complete-input';
   const captures=[];input=await R.load(selection,progress=>console.log(JSON.stringify({id,name,progress})),async(url,o)=>{
    const query=new URLSearchParams(o.body).get('data');
    const kind=query.includes('node(r.r:')?'admin':query.includes('way(area.a)[highway')?'roads':query.includes('[building][building!=no]')?'buildings':'poi';
    if(refreshPopulation&&kind!=='admin')return new Response(await fs.readFile(path.join(output,id+'-'+kind+'.json')));
    const response=await fetch(url,o);
    if(response.ok)captures.push(response.clone().arrayBuffer().then(bytes=>bytes.byteLength<=R.LIMITS.bytes
      ?fs.writeFile(path.join(output,id+'-'+kind+'.json'),new Uint8Array(bytes)):undefined).catch(()=>{}));
    return response;
   });
   await Promise.all(captures);
   input.localityInventoryComplete=true;
   await fs.writeFile(path.join(output,id+'-input.json'),JSON.stringify(input));
  }
  name=selection[0].name;level=selection[0].extratags?.admin_level;stage='population';
  const p=input.population;assert.ok(near(p.zones.reduce((n,z)=>n+z.residents,0),p.total),'人口分区总量不守恒');
  assert.equal(new Set(p.rows.map(r=>r.id)).size,p.rows.length,'同一人口来源被重复计数');
  stage='simulation';const graph=U.buildGraph(input),s=new U.RegionalSimulation(graph,{regionalInput:input,startHour:8,demandFactor:1,count:60});
  const d=s.demand.summary(),homes=s.demand.sites.filter(h=>h.kind==='home');
  assert.ok(near(homes.reduce((n,h)=>n+h.weight,0)+d.unconnectedResidents,d.totalResidents),'道路接入人口不守恒');
  assert.ok(d.unconnectedResidents>=-1e-5&&d.unconnectedResidents<=d.totalResidents+1e-5);
  assert.ok(d.unservedResidents<=d.taggedResidents+1e-5);
  const roadTypes={};for(const f of input.roads)roadTypes[f.properties.highway]=(roadTypes[f.properties.highway]||0)+1;
  // Distinguish valid but incomplete mapping from a healthy demand result.
  const issues=[];
  if(!p.total)issues.push('no-known-population');
  if(p.missing)issues.push('population-coverage-unknown');
  if(p.conflicts.length)issues.push('population-source-conflicts');
  if(p.boundaryWarnings?.length)issues.push('lower-boundary-gaps');
  if(p.total&&d.unconnectedResidents/p.total>.2)issues.push('many-residents-unconnected');
  if(d.taggedResidents&&d.unservedResidents/d.taggedResidents>.2)issues.push('many-residents-without-return-trip');
  if(p.total&&!d.pairs)issues.push('no-reachable-trips');
  stage='aggregate-conservation';
  // Exercise actual demand injection, queue/storage and parking conservation.
  const initial=s.stock.reduce((n,v)=>n+v,0)+[...s.parking.values()].reduce((n,lot)=>n+lot.occupied,0);
  let externalDepartures=0;
  for(let n=0;n<100;n++){
   // Unparked destinations and home arrivals leave the aggregate inventory.
   // Parking arrivals remain inside it; lot releases only transfer to roads.
   for(const r of s.rows){
    const output=Math.min(s.stock[r.id],s.stock[r.id]/r.free*.2,s.capacity[r.id]*.2);
    const sink=r.turns.find(([next])=>next===-1)?.[1]||0;
    externalDepartures+=output*sink*(1-r.parking.reduce((n,[,share])=>n+share,0));
   }
   s.step(.2);
  }
  const snapshot=s.snapshot();
  for(const key of ['moving','waiting','pending','arrived','returned'])assert.ok(Number.isFinite(snapshot[key])&&snapshot[key]>=0,key+' invalid');
  if(snapshot.parking)assert.ok(snapshot.parking.occupied<=snapshot.parking.capacity+1e-5);
  const roadMass=s.stock.reduce((n,v)=>n+v,0)+s.backlog.reduce((n,v)=>n+v,0);
  const parkedMass=[...s.parking.values()].reduce((n,lot)=>n+lot.occupied,0);
  const expected=initial+s.generated-externalDepartures;
  assert.ok(near(roadMass+parkedMass,expected),'道路与停车库存不守恒');
  reports.push({id,name,level,startedAt,finishedAt:new Date().toISOString(),mode:replay?'replayed-complete-source':refreshPopulation?'live-population-with-retained-complete-source':'live-complete-source',
   status:issues.length?'complete-with-limitations':'complete',issues,sourceTimes:input.sourceTimes,readAt:input.readAt,
   roads:input.roads.length,roadTypes,edges:graph.edges.length,buildings:d.buildings,population:p.total,connected:d.taggedResidents,
   unconnected:d.unconnectedResidents,unserved:d.unservedResidents,hourly:d.hourly,pairs:d.pairs,missingPopulation:p.missing,
   populationRows:p.rows,populationConflicts:p.conflicts,boundaryWarnings:p.boundaryWarnings,buildingAudit:d.buildingAudit,
   localities:p.localities,localityInventoryComplete:Boolean(input.localityInventoryComplete),aggregateConservation:true,
   moving:snapshot.moving,ms:Date.now()-start});
 }catch(error){reports.push({id,name,level,startedAt,finishedAt:new Date().toISOString(),status:'not-complete',stage,error:error.message,ms:Date.now()-start});}
 const last=reports.at(-1);await fs.writeFile(path.join(output,id+'-report.json'),JSON.stringify(last,null,2));
 console.log(JSON.stringify({id:last.id,name:last.name,status:last.status,issues:last.issues,error:last.error,population:last.population,connected:last.connected,roads:last.roads,hourly:last.hourly,ms:last.ms}));
}
await fs.writeFile(path.join(output,'report.json'),JSON.stringify({algorithm:R.VERSION,checkedAt:new Date().toISOString(),reports},null,2));
console.log(JSON.stringify({report:path.relative(root,path.join(output,'report.json')),checked:reports.length,notComplete:reports.filter(r=>r.status==='not-complete').length}));
if(reports.some(r=>r.status==='not-complete'))process.exitCode=1;
