import {readFile,writeFile,mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import vm from "node:vm";

const root=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
// These are real mapped locality nodes/anchors, not administrative bbox centres.
export const samples=[
  {name:"津川",lat:14.63709,lon:152.93387,anchor:"existing map regression window"},
  {name:"上京都",node:126401531,lat:12.49166,lon:148.4176544,relation:28660},
  {name:"南滨市",node:183520901,lat:9.4800352,lon:153.4459619,relation:363176},
  {name:"高阳府",node:298541103,lat:9.4838375,lon:155.8363718,relation:347805},
  {name:"北沪市",node:437492137,lat:24.053362,lon:142.1205132,relation:309351},
  {name:"荣坳市（原西省）",node:408977963,lat:19.6093769,lon:142.3239004,relation:309347},
  {name:"Nyerqak（卡达赫）",node:399244466,lat:57.5144148,lon:148.2904371,relation:305055},
  {name:"Yaladaam（卡达赫）",node:399518301,lat:57.734014,lon:148.7846402,relation:305055},
  {name:"Othaki（Hespi-Szaja）",node:125634235,lat:51.4029847,lon:0.0799169,relation:43812},
  {name:"龙川市（AR925）",lat:-0.0120003,lon:141.869562,anchor:"existing ferry-stop regression window"},
];

export function tileAt(sample,z){return {z,x:Math.floor((sample.lon+180)/360*2**z),
  y:Math.floor((1-Math.asinh(Math.tan(sample.lat*Math.PI/180))/Math.PI)/2*2**z)};}
export function inspectPacket(payload,response,now=Date.now()){
  if(!response.ok)throw Error(`HTTP ${response.status}: ${payload?.error || "source unavailable"}`);
  if(payload?.remark || !Array.isArray(payload?.elements))throw Error(payload?.remark || "incomplete source packet");
  const source=Date.parse(payload.osm3s?.timestamp_osm_base),fetched=Date.parse(response.headers.get("X-OGF-Basemap-Fetched-At") || "");
  if(!Number.isFinite(source))throw Error("source timestamp missing");
  const counts=payload.elements.filter(e=>e.type==="count"),elements=payload.elements.filter(e=>e.type!=="count");
  const validCounts=counts.length===1 && ["nodes","ways","relations","total"].every(key=>/^\d+$/u.test(String(counts[0].tags?.[key]??"")))
    && Number(counts[0].tags.total)===elements.length
    && ["node","way","relation"].every(type=>Number(counts[0].tags[type+"s"])===elements.filter(e=>e.type===type).length)
    && elements.every(e=>["node","way","relation"].includes(e.type)&&Number.isSafeInteger(e.id)&&e.id>0)
    && new Set(elements.map(e=>`${e.type}:${e.id}`)).size===elements.length;
  if(counts.length&&!validCounts)throw Error("source count/identity mismatch");
  return {sourceTime:new Date(source).toISOString(),fetchedAt:Number.isFinite(fetched)?new Date(fetched).toISOString():null,
    sourceAgeMinutes:Math.round(Math.max(0,now-source)/600)/100,
    fetchedAgeMinutes:Number.isFinite(fetched)?Math.round(Math.max(0,now-fetched)/600)/100:null,
    sourceComplete:validCounts,legacyUncounted:!counts.length,cache:response.headers.get("X-OGF-Basemap-Cache"),
    policy:response.headers.get("X-OGF-Basemap-Policy"),refreshAfter:response.headers.get("X-OGF-Basemap-Refresh-After"),
    objects:elements.length,roads:elements.filter(e=>e.tags?.highway).length,
    water:elements.filter(e=>e.tags?.waterway||e.tags?.natural==="water"||e.tags?.landuse==="reservoir").length,
    namedObjects:elements.filter(e=>e.tags?.name).length,
    contentHash:createHash("sha256").update(JSON.stringify(elements)).digest("hex"),
    examples:elements.filter(e=>e.tags?.name&&(e.tags.highway||e.tags.waterway||e.tags.natural==="water"))
      .slice(0,3).map(e=>({id:`${e.type}:${e.id}`,name:e.tags.name,kind:e.tags.highway||e.tags.waterway||"water"}))};
}

export async function audit({origin="https://ogf-atlas.pages.dev",zooms=[14,15],localWorker=false,output,selected=samples,fetcher=fetch}={}){
  const app=await readFile(path.join(root,"site/app.js"),"utf8"),runtime=vm.createContext({});
  vm.runInContext(app.match(/  function validateHuayuBasemapPayload\([^]*?\n  \}/u)[0],runtime);
  let worker,context;
  if(localWorker){const cache=new Map();globalThis.caches={default:{match:async req=>cache.get(req.url)?.clone(),put:async(req,res)=>{cache.set(req.url,res.clone());}}};
    worker=(await import("../site/_worker.js")).default;context={waitUntil(promise){promise.catch(()=>{});}};}
  const work=selected.flatMap(sample=>zooms.map(z=>({sample,tile:tileAt(sample,z)}))),results=[];
  async function run(){for(;;){const next=work.shift();if(!next)return;const {sample,tile}=next,started=Date.now();
    const tileKey=`${tile.z}/${tile.x}/${tile.y}`,url=`${origin}/api/live-basemap/${tileKey}.json`;
    let row={name:sample.name,anchorNode:sample.node||null,relation:sample.relation||null,location:[sample.lon,sample.lat],tile:tileKey};
    try{const response=localWorker?await worker.fetch(new Request(url),{ASSETS:{fetch:async()=>new Response("missing",{status:404})}},context)
      :await fetcher(url,{cache:"no-cache",signal:AbortSignal.timeout(tile.z<=13?65000:40000)});
      const payload=await response.json();row={...row,...inspectPacket(payload,response)};
      if(row.sourceComplete)runtime.validateHuayuBasemapPayload(payload);
      const sourceBudget=tile.z>=15?15:195;
      row.status=!row.sourceComplete?"unverified":row.sourceAgeMinutes>sourceBudget?"source-lagging":"passed";
    }catch(error){row.status="failed";row.error=error.message;}
    row.elapsedMs=Date.now()-started;results.push(row);console.log(JSON.stringify(row));
  }}
  await Promise.all([run(),run()]);
  results.sort((a,b)=>selected.findIndex(s=>s.name===a.name)-selected.findIndex(s=>s.name===b.name)||Number(a.tile.split("/")[0])-Number(b.tile.split("/")[0]));
  const report={checkedAt:new Date().toISOString(),mode:localWorker?"local-current-worker":"deployed-worker",origin,
    scope:"Ten locality windows in multiple countries; not every city and not an edit-to-render guarantee",
    status:results.every(row=>row.status==="passed")?"passed":"attention-required",results,
    summary:Object.fromEntries(["passed","unverified","source-lagging","failed"].map(status=>[status,results.filter(row=>row.status===status).length]))};
  if(output){const target=path.resolve(root,output);if(target===root||!target.startsWith(root+path.sep))throw Error("Audit output must be inside this workspace");
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+"\n");}
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const value=(flag,fallback)=>{const i=process.argv.indexOf(flag);return i<0?fallback:process.argv[i+1];};
  const zooms=value("--zooms","14,15").split(",").map(Number);if(zooms.some(z=>![13,14,15].includes(z)))throw Error("Audit zooms must be 13,14,15");
  const report=await audit({origin:value("--origin","https://ogf-atlas.pages.dev"),zooms,
    localWorker:process.argv.includes("--local-worker"),output:value("--output",".data-update/basemap-city-audit.json")});
  console.log(JSON.stringify({status:report.status,checkedAt:report.checkedAt,summary:report.summary}));
  if(report.status!=="passed")process.exitCode=1;
}
