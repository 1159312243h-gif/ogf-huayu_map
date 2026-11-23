(function(root){
 "use strict";
 const data=new Set(["transit-preload.json","transit-relations.json","station-access.json","airports.json","railway-routing.json","railway-connections.json","terrain-preload.json.gz","terrain-preload-manifest.json","brand-catalog.json","brand-search-index.json","huaxia-admin-catalog.json","brand-logos.json","app-releases.json"]);
 function dataFile(name){return data.has(name)||/^(terrain-preload-chunks|terrain-render-cache)\/[a-z0-9-]+\.json\.gz$/.test(name);}
 function publicFile(name){return typeof name==="string"&&name.length<240&&!name.startsWith("/")&&!name.includes("\\")&&!name.includes("%")&&!name.split("/").some(p=>!p||p==="."||p===".."||p.startsWith(".")||p.startsWith("_")||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(p))&&/^[a-zA-Z0-9_./-]+$/.test(name)&&!/([-/]server|\.env|\.sql|\.toml)/.test(name)&&name!=="package.json"&&name!=="updater-jwks.json"&&name!=="desktop-assets.json"&&/\.(?:html|js|css|json|gz|svg|png|webp|jpg|glb|txt|md|webmanifest)$/.test(name);}
 function manifest(m){
  if(m?.schema!=="huayu-desktop-assets-v1"||m.runtime!==1||!/^\d+\.\d+\.\d+$/.test(m.version)||!Array.isArray(m.files)||m.files.length<2||m.files.length>512||!/^[a-f0-9]{64}$/.test(m.revision))throw Error("程序资源清单不兼容");
  const names=new Set();let total=0;
  for(const f of m.files){if(!publicFile(f.path)||names.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>25*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha256)||f.kind!==(dataFile(f.path)?"data":"code"))throw Error("程序资源清单无效");
   if(f.decodedBytes!==undefined&&(!Number.isSafeInteger(f.decodedBytes)||f.decodedBytes<0||f.decodedBytes>128*1024*1024||!/^[a-f0-9]{64}$/.test(f.decodedSha256)))throw Error("压缩资源清单无效");names.add(f.path);total+=f.bytes;
  }
  if(total>256*1024*1024||!names.has("index.html")||!names.has("app.js"))throw Error("程序版本不完整");return m;
 }
 function sourceTime(value){return [value?.sourceTime,value?.dbTimestamp,value?.generatedAt,value?.readAt,value?.sourceUpdatedAt].find(v=>typeof v==="string"&&Number.isFinite(Date.parse(v)))||null;}
 function force(request,url){return url.searchParams.has("force")||url.searchParams.has("refresh")||request.cache==="reload";}
 root.HuayuCachePolicy=Object.freeze({dataFile,publicFile,manifest,sourceTime,force,interval:300000,maxData:128*1024*1024});
 if(typeof module!=="undefined")module.exports=root.HuayuCachePolicy;
})(globalThis);
