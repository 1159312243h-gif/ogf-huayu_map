import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile),origin="https://ogf-atlas.pages.dev",limit=8*1024*1024;
export function publicLogoUrl(request){
 const url=new URL(request.url),path=url.pathname;
 if(!["/api/brand-logos","/api/brand-logo-places"].includes(path)&&!/^\/api\/brand-logos\/[a-zA-Z0-9_-]{1,80}\/image$/u.test(path))return null;
 if(request.method!=="GET")return null;
 if(request.headers.has("Origin")&&request.headers.get("Origin")!==url.origin)throw Object.assign(Error("cross_origin_request_blocked"),{status:403});
 const allowed=path==="/api/brand-logo-places"?["bounds","refresh"]:path.endsWith("/image")?["v"]:[];
 if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1))throw Object.assign(Error("invalid_public_logo_query"),{status:400});
 if(path==="/api/brand-logo-places"){
  const b=(url.searchParams.get("bounds")||"").split(",").map(Number);
  if(b.length!==4||b.some(v=>!Number.isFinite(v))||b[0]<-180||b[2]>180||b[1]<-85||b[3]>85
   ||b[0]>=b[2]||b[1]>=b[3]||b[2]-b[0]>.8||b[3]-b[1]>.8
   ||url.searchParams.has("refresh")&&url.searchParams.get("refresh")!=="1")throw Object.assign(Error("logo_bounds_invalid"),{status:400});
 }
 if(path.endsWith("/image")&&!/^[a-zA-Z0-9_-]{1,128}$/u.test(url.searchParams.get("v")||""))throw Object.assign(Error("invalid_logo_version"),{status:400});
 return origin+path+url.search;
}
const powershell="$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$r=Invoke-WebRequest -Uri $env:HUAYU_PREVIEW_PUBLIC_LOGO_URL -Method Get -TimeoutSec 85 -MaximumRedirection 0 -SkipHttpErrorCheck\nif($r.RawContentStream.Length -gt 8388608){throw 'public_logo_response_too_large'}\n[Console]::Out.Write((@{status=[int]$r.StatusCode;contentType=[string]$r.Headers['Content-Type'];body=[Convert]::ToBase64String($r.RawContentStream.ToArray())}|ConvertTo-Json -Compress))";
export async function systemPublicLogoRead(url,signal){
 if(new URL(url).origin!==origin)throw Error("untrusted_logo_origin");
 const {stdout}=await run(process.env.HUAYU_PREVIEW_POWERSHELL||"pwsh",
 ["-NoLogo","-NoProfile","-NonInteractive","-Command",powershell],
 {windowsHide:true,signal,timeout:90000,maxBuffer:12*1024*1024,encoding:"utf8",env:{...process.env,HUAYU_PREVIEW_PUBLIC_LOGO_URL:url}});
 const envelope=JSON.parse(stdout.replace(/^\uFEFF/u,""));
 if(!Number.isInteger(envelope.status)||envelope.status<200||envelope.status>=600||typeof envelope.body!=="string"
  ||!/^[A-Za-z0-9+/]*={0,2}$/u.test(envelope.body))throw Error("invalid_public_logo_response");
 const body=Buffer.from(envelope.body,"base64");if(body.length>limit)throw Error("public_logo_response_too_large");
 return {status:envelope.status,body,contentType:envelope.contentType||"application/json; charset=utf-8"};
}
export function createPublicLogoPreview({read=systemPublicLogoRead,now=()=>Date.now()}={}){
 let catalogSignature="",catalogKeys=new Set(),windows=[];
 const covers=(a,b)=>a[0]<=b[0]&&a[1]<=b[1]&&a[2]>=b[2]&&a[3]>=b[3];
 const pending=new Map(),reply=(value,status=503)=>new Response(JSON.stringify({error:value}),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 return async function handle(request){
  let url;try{url=publicLogoUrl(request);}catch(e){return reply(e.message,e.status||400);}if(!url)return null;
  request.signal.throwIfAborted();
  const target=new URL(url),bounds=target.pathname==="/api/brand-logo-places"?target.searchParams.get("bounds").split(",").map(Number):null;
  const response=result=>new Response(result.body,{status:result.status,headers:{"Content-Type":result.contentType,"Cache-Control":"no-store","X-Huayu-Preview-Source":"public-production-logo-api"}});
  if(bounds&&!target.searchParams.has("refresh")&&catalogSignature){
   const cached=windows.find(w=>w.signature===catalogSignature&&now()>=w.fetchedAt&&now()-w.fetchedAt<120000&&covers(w.bounds,bounds));
   if(cached)return response(cached.result);
  }
  const requestKey=url+"\n"+(bounds?catalogSignature:"");
  let task=pending.get(requestKey);if(task?.controller.signal.aborted){pending.delete(requestKey);task=null;}
  if(!task){
   if(pending.size>=2)return reply("logo_places_busy");
   task={controller:new AbortController(),users:0,done:false,catalogSignature};
   const signal=AbortSignal.any([task.controller.signal,AbortSignal.timeout(90000)]);
   task.promise=Promise.resolve().then(()=>read(url,signal)).finally(()=>{task.done=true;if(pending.get(requestKey)===task)pending.delete(requestKey);});
   task.promise.catch(()=>{});pending.set(requestKey,task);
  }
  task.users++;let abort;
  try{
   const result=await Promise.race([task.promise,new Promise((_,reject)=>{
    abort=()=>reject(request.signal.reason);request.signal.addEventListener("abort",abort,{once:true});
   })]);
   request.signal.throwIfAborted();
   if(result.body.length>limit)throw Error("public_logo_response_too_large");
   if(result.status===200){
    try{
     const data=JSON.parse(Buffer.from(result.body).toString("utf8"));
     if(target.pathname==="/api/brand-logos"&&Array.isArray(data.items)&&data.items.length<=1000&&data.items.every(e=>typeof e.key==="string"&&e.key)){
      const signature=JSON.stringify(data.items.map(e=>[e.key,e.imageUrl,e.aliases,e.categories]));
      if(signature!==catalogSignature){windows=[];catalogSignature=signature;catalogKeys=new Set(data.items.map(e=>e.key));}
     }else if(bounds&&catalogSignature&&task.catalogSignature===catalogSignature&&!data.stale&&!data.error&&Array.isArray(data.items)&&data.items.length<=3000
      &&new Set(data.items.map(p=>p.type+"/"+p.id)).size===data.items.length
      &&data.items.every(p=>["node","way","relation"].includes(p.type)&&Number.isSafeInteger(p.id)&&p.id>0&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=85&&Number.isFinite(p.lon)&&Math.abs(p.lon)<=180&&catalogKeys.has(p.logoKey)&&p.tags)
      &&Number.isFinite(data.fetchedAt)&&data.fetchedAt>0&&data.fetchedAt<=now()+60000&&now()-data.fetchedAt<120000
      &&Number.isFinite(Date.parse(data.dbTimestamp))&&result.body.length<=2*1024*1024){
      windows=windows.filter(w=>w.signature===catalogSignature&&now()-w.fetchedAt<120000
       &&JSON.stringify(w.bounds)!==JSON.stringify(bounds));
      windows.unshift({bounds,signature:catalogSignature,fetchedAt:data.fetchedAt,result});
      windows=windows.slice(0,8);
      while(windows.reduce((n,w)=>n+w.result.body.length,0)>2*1024*1024)windows.pop();
     }
    }catch{}
   }
   return response(result);
  }catch(e){return reply(request.signal.aborted?"logo_places_cancelled":"logo_places_unavailable",request.signal.aborted?499:503);}
  finally{request.signal.removeEventListener("abort",abort);if(--task.users===0&&!task.done)task.controller.abort();}
 };
}
