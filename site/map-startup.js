(function(root){
 "use strict";
 const doc=root.document;let painted=false,failed=false,resourceFailed=false,action=null,slowTimer=0;
 const box=()=>doc.getElementById('map-startup-status');
 function show(message,retry){const element=box();if(!element)return;element.hidden=false;doc.getElementById('map-startup-message').textContent=message;doc.getElementById('map-startup-retry').hidden=!retry;}
 function failedLoad(message,retry){failed=true;action=retry||null;show(message,true);}
 function ready(options={}){painted=true;root.clearTimeout(slowTimer);if(resourceFailed||options.baseOnly&&failed&&action)return;failed=false;action=null;if(box())box().hidden=true;}
 function stage(message){if(!painted&&!failed)show(message,false);}
 function init(){const button=doc.getElementById('map-startup-retry');if(!button||button.dataset.bound)return;button.dataset.bound='true';button.addEventListener('click',()=>{
  if(action){const retry=action;action=null;failed=false;show('正在重新准备地图组件…',false);void retry();}
  else root.location.reload();
 });if(doc.getElementById('map')?.dataset.mapPainted==='true'){ready({baseOnly:true});return;}slowTimer=root.setTimeout(()=>{if(!painted&&!failed)failedLoad('地图资源加载较慢，请检查网络后重试。');},15000);}
 // Run independently of ordered feature scripts, including a stalled download.
 if(box())init();else{const observer=new MutationObserver(()=>{if(box()){observer.disconnect();init();}});observer.observe(doc.documentElement,{childList:true,subtree:true});}
 root.addEventListener('error',event=>{const target=event.target,url=target?.tagName==='SCRIPT'?target.src:target?.tagName==='LINK'&&target.rel==='stylesheet'?target.href:null;
  if(url&&target.dataset?.mapOptional!=='true'&&new URL(url,root.location.href).origin===root.location.origin&&!painted){resourceFailed=true;failedLoad('地图程序或样式文件未完整加载，请重试。');}
 },true);
 root.addEventListener('pagehide',()=>root.clearTimeout(slowTimer),{once:true});
 root.HuayuMapStartup=Object.freeze({ready,stage,failed:failedLoad});
})(globalThis);
