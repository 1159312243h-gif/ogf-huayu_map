const {fetchWithRetry}=require('./overpass-network.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Each attempt owns a fresh deadline. Do not multiply HTTP retry loops or
// subdivide a healthy query merely because a streamed body was incomplete.
async function requestTerrainElements(query,label,{fetch:request,wait=pause,timeout=55000}={}) {
  request ||= (url,options)=>fetchWithRetry(url,options,{retryStatuses:[]});
  let limited=0,broken=0;
  for(;;) {
    let response;
    try {
      response=await request('https://overpass.opengeofiction.net/api/interpreter',{
        method:'POST',body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(timeout)});
      if(response.status===429 && limited<5) {
        const header=response.headers.get('retry-after');
        const requested=header===null?0:/^\s*\d+\s*$/u.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-Date.now());
        await response.body?.cancel().catch(()=>{});
        if(requested>120000)throw Error('Terrain '+label+': HTTP 429; Retry-After exceeds bounded retry window');
        const delay=Math.max(Math.min(120000,30000*++limited),Number.isFinite(requested)?requested:0);
        console.log('Terrain rate limit '+label+': retry in '+delay/1000+'s');await wait(delay);continue;
      }
      if(!response.ok) {await response.body?.cancel().catch(()=>{});throw Error('Terrain '+label+': HTTP '+response.status);}
      const payload=await response.json();
      if(payload.remark || !Array.isArray(payload.elements))throw Error(payload.remark || 'invalid data');
      return payload.elements;
    } catch(error) {
      if(!(error instanceof SyntaxError) || broken++>=1)throw error;
      await response?.body?.cancel().catch(()=>{});
      console.log('Terrain incomplete JSON '+label+': retry same query after 10s');await wait(10000);
    }
  }
}
module.exports={requestTerrainElements};
