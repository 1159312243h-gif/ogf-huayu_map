import {readFile} from "node:fs/promises";
import network from './data-update/builders/overpass-network.cjs';
import relay from './data-update/builders/updater-relay.cjs';
let identityLogged=false;
const fetcher=relay.createRelayFetcher({onIdentity:info=>{if(!identityLogged){identityLogged=true;console.log(JSON.stringify({identity:info}));}}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(let attempt=0;attempt<30;attempt++){
 try{
  const response=await network.fetchWithRetry('https://overpass.opengeofiction.net/api/interpreter',{method:'POST',body:new URLSearchParams({data:'[out:json][timeout:10];rel(28652);out count;'}),signal:AbortSignal.timeout(45000)},{fetcher});
  if(!response.ok){
    let reason;try{reason=(await response.json()).reason;}catch{}
    if(typeof reason==='string'&&/^identity_[a-z_0-9]+(?::[a-z_,]+)?$/u.test(reason)){
      const error=Error('HTTP '+response.status+' '+reason);error.permanent=response.status===403;throw error;
    }
    throw Error('HTTP '+response.status);
  }
  const payload=await response.json();if(payload.remark||Number(payload.elements?.[0]?.tags?.total)!==1)throw Error('Incomplete source probe');
  if(response.headers.get('x-huayu-source-route')!=='github-oidc')throw Error('Source relay was not used');
  // Exercise a mapped multipolygon response large enough to cross several
  // stream chunks. A genuinely removed relation is valid when count is zero.
  const largeQuery='[out:json][timeout:60];rel(458397)->.r;.r out count;.r out body geom;';
  const large=await fetcher('https://overpass.opengeofiction.net/api/interpreter',{method:'POST',body:new URLSearchParams({data:largeQuery}),signal:AbortSignal.timeout(90000)});
  if(!large.ok)throw Error('Large source probe HTTP '+large.status+' '+(large.headers.get('x-huayu-source-error')||''));
  const text=await large.text(),complete=JSON.parse(text),total=Number(complete.elements?.[0]?.tags?.total);
  if(complete.remark||![0,1].includes(total)||complete.elements?.length!==total+1
    ||total===1&&(complete.elements[1].type!=='relation'||complete.elements[1].id!==458397||!complete.elements[1].members?.length))throw Error('Incomplete large source probe');
  // Reproduce the inventory window that failed in the real national rebuild.
  const cover=JSON.parse(await readFile(new URL("../site/transit-preload.json",import.meta.url),"utf8")).snapshots.find(s=>s.id==="huaxia");
  const [[south,west],[north,east]]=cover.bounds,rows=Math.ceil((north-south)/9),cols=Math.ceil((east-west)/4);
  const bbox=[south+(north-south)*2/rows,west+(east-west)*4/cols,south+(north-south)*3/rows,west+(east-west)*5/cols].join(",");
  const filters=["[natural=water]","[waterway]","[landuse=reservoir]","[building]","[leisure~\"^(garden|park|pitch|swimming_pool)$\"]"];
  const inventoryQuery="[out:json][timeout:35];("+filters.flatMap(f=>["way"+f+"("+bbox+");","rel[type=multipolygon]"+f+"("+bbox+");"]).join("")+");out tags bb;out count;";
  const inventory=await fetcher("https://overpass.opengeofiction.net/api/interpreter",{method:"POST",body:new URLSearchParams({data:inventoryQuery}),signal:AbortSignal.timeout(90000)});
  if(!inventory.ok)throw Error("Inventory source probe HTTP "+inventory.status+" "+(inventory.headers.get("x-huayu-source-error")||""));
  const inventoryText=await inventory.text();let inventoryData;try{inventoryData=JSON.parse(inventoryText);}catch{throw Error("Inventory source JSON truncated: bytes="+Buffer.byteLength(inventoryText)+" transfer="+inventory.headers.get("x-huayu-source-encoding"));}
  const counts=inventoryData.elements?.filter(e=>e.type==="count");if(inventoryData.remark||counts?.length!==1||Number(counts[0].tags.total)!==inventoryData.elements.length-1)throw Error("Incomplete inventory probe");
  console.log(JSON.stringify({inventorySourceProbe:"passed",bytes:Buffer.byteLength(inventoryText),elements:inventoryData.elements.length-1,transfer:inventory.headers.get("x-huayu-source-encoding")}));
  const final=await fetcher('https://overpass.opengeofiction.net/api/interpreter',{method:'POST',body:new URLSearchParams({data:'[out:json][timeout:10];rel(28652);out count;'}),signal:AbortSignal.timeout(45000)});
  if(!final.ok)throw Error('Sequential source probe HTTP '+final.status+' '+(final.headers.get('x-huayu-source-error')||''));
  const released=await final.json();if(released.remark||Number(released.elements?.[0]?.tags?.total)!==1)throw Error('Incomplete sequential source probe');
  console.log(JSON.stringify({status:'passed',route:'github-oidc',sourceTime:payload.osm3s?.timestamp_osm_base,largeResponseBytes:Buffer.byteLength(text),largeResponseComplete:true,sequentialSourceRead:true}));break;
 }catch(error){if(error.permanent||attempt===29)throw Error('Updater relay did not become ready: '+error.message);console.log('Waiting for updater relay: '+error.message);await delay(20000);}
}
