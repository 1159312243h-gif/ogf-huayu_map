import network from './data-update/builders/overpass-network.cjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(let attempt=0;attempt<30;attempt++){
 try{
  const response=await network.fetchWithRetry('https://overpass.opengeofiction.net/api/interpreter',{method:'POST',body:new URLSearchParams({data:'[out:json][timeout:10];rel(28652);out count;'}),signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const payload=await response.json();if(payload.remark||Number(payload.elements?.[0]?.tags?.total)!==1)throw Error('Incomplete source probe');
  if(response.headers.get('x-huayu-source-route')!=='github-oidc')throw Error('Source relay was not used');
  console.log(JSON.stringify({status:'passed',route:'github-oidc',sourceTime:payload.osm3s?.timestamp_osm_base}));break;
 }catch(error){if(attempt===29)throw Error('Updater relay did not become ready: '+error.message);console.log('Waiting for updater relay: '+error.message);await delay(20000);}
}
