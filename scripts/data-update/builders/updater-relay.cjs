// CI-only authenticated route through our existing Pages Worker; credentials stay in memory.
const RELAY="https://ogf-atlas.pages.dev/api/data-update/source";
const AUDIENCE="https://ogf-atlas.pages.dev/data-update";
function createRelayFetcher({fetcher=globalThis.fetch,environment=process.env,now=()=>Date.now()}={}){
  let identity=null,pending=null;
  async function token(signal){
    if(identity&&identity.expiresAt>now()+60000)return identity.value;
    if(!pending)pending=(async()=>{
      const url=new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL||"");
      if(url.protocol!=="https:"||!url.hostname.endsWith(".actions.githubusercontent.com")||url.username||url.password||url.port)throw Error("Updater job identity endpoint is unavailable");
      const secret=environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!secret)throw Error("Updater job identity is unavailable");
      url.searchParams.set("audience",AUDIENCE);
      const response=await fetcher(url.href,{headers:{Authorization:"Bearer "+secret},redirect:"error",signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)])});
      if(!response.ok)throw Error("Updater job identity HTTP "+response.status);
      const payload=await response.json(),value=payload.value;
      if(typeof value!=="string"||value.length>16000)throw Error("Updater job identity is invalid");
      let claims;try{claims=JSON.parse(Buffer.from(value.split(".")[1],"base64url").toString("utf8"));}catch{throw Error("Updater job identity is invalid");}
      if(claims.aud!==AUDIENCE||!Number.isFinite(claims.exp)||claims.exp*1000<=now())throw Error("Updater job identity is invalid");
      identity={value,expiresAt:claims.exp*1000};return value;
    })().finally(()=>{pending=null;});
    return pending;
  }
  return async function relayFetch(input,init={}){
    const original=new URL(String(input));
    if(original.username||original.password||original.origin!=="https://overpass.opengeofiction.net"||original.pathname!=="/api/interpreter")throw Error("Unsupported updater source");
    const headers=new Headers(init.headers);if(headers.has("authorization")||headers.has("cookie")||headers.has("proxy-authorization"))throw Error("Source credentials cannot enter the updater relay");
    const body=init.body instanceof URLSearchParams?init.body:new URLSearchParams(typeof init.body==="string"?init.body:"");
    const query=String(init.method||"GET").toUpperCase()==="POST"?body.get("data"):original.searchParams.get("data");
    if(typeof query!=="string")throw Error("Updater source query is missing");
    const value=await token(init.signal);
    const response=await fetcher(RELAY,{method:"POST",redirect:"error",credentials:"omit",headers:{Authorization:"Bearer "+value,"Content-Type":"application/json"},
      body:JSON.stringify({query}),signal:init.signal});
    if(response.status===401||response.status===403)identity=null;
    return response;
  };
}
module.exports={createRelayFetcher,RELAY,AUDIENCE};
