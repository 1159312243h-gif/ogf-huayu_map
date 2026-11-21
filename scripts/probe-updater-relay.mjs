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
  const final=await fetcher('https://overpass.opengeofiction.net/api/interpreter',{method:'POST',body:new URLSearchParams({data:'[out:json][timeout:10];rel(28652);out count;'}),signal:AbortSignal.timeout(45000)});
  if(!final.ok)throw Error('Sequential source probe HTTP '+final.status+' '+(final.headers.get('x-huayu-source-error')||''));
  const released=await final.json();if(released.remark||Number(released.elements?.[0]?.tags?.total)!==1)throw Error('Incomplete sequential source probe');
  console.log(JSON.stringify({status:'passed',route:'github-oidc',sourceTime:payload.osm3s?.timestamp_osm_base,largeResponseBytes:Buffer.byteLength(text),largeResponseComplete:true,sequentialSourceRead:true}));break;
 }catch(error){if(error.permanent||attempt===29)throw Error('Updater relay did not become ready: '+error.message);console.log('Waiting for updater relay: '+error.message);await delay(20000);}
}
