// Retry read-only queries to the official OGF service; validation stays with each caller.
const {setTimeout:pause}=require('node:timers/promises');
const {createRelayFetcher}=require("./updater-relay.cjs");
let relayFetcher;
const ORIGIN='https://overpass.opengeofiction.net';
function transient(error){
  if(error?.name==='AbortError'||error?.name==='TimeoutError')return false;
  return ['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','ECONNREFUSED'].includes(error?.cause?.code||error?.code)
    || error instanceof TypeError && error.message==='fetch failed';
}
async function fetchWithRetry(input,init={},options={}){
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin!==ORIGIN||url.pathname!=='/api/interpreter')return (options.fetcher||globalThis.fetch)(input,init);
  const fetcher=options.fetcher||(process.env.OGF_UPDATER_RELAY==="1"?(relayFetcher||=createRelayFetcher()):globalThis.fetch);
  const sleep=options.sleep||((ms,signal)=>pause(ms,undefined,{signal}));
  const delays=options.delays||[10000,30000];
  for(let attempt=0;;attempt++){
    init.signal?.throwIfAborted();
    let response,retryAfter;
    try{
      response=await fetcher(input,init);
      if(!(options.retryStatuses||[429,502,503,504]).includes(response.status)||attempt>=delays.length)return response;
      const header=response.headers.get('retry-after');
      retryAfter=header===null?0:(Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-Date.now());
      await response.body?.cancel().catch(()=>{});
      if(retryAfter>60000)throw Error('OGF Retry-After exceeds the bounded retry window');
    }catch(error){
      if(init.signal?.aborted||!transient(error)||attempt>=delays.length)throw error;
    }
    const delay=Math.min(60000,Math.max(delays[attempt],Number.isFinite(retryAfter)?retryAfter:0));
    (options.warn||console.warn)('OGF connection temporarily unavailable; retry '+(attempt+1)+' in '+Math.ceil(delay/1000)+'s');
    await sleep(delay,init.signal);
  }
}
module.exports={fetchWithRetry};
