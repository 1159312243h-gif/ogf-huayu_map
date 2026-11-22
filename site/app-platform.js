(function(root) {
  "use strict";
  const doc=root.document, android=root.huayuNative, ios=root.webkit?.messageHandlers?.huayuNative;
  const desktop=root.huayuDesktop?.platform;
  const mobile=Boolean(android?.postMessage||ios?.postMessage);
  const platform=android?.postMessage?"android":ios?.postMessage?"ios":({win32:"windows",darwin:"macos",linux:"linux"}[desktop]||desktop||"web");
  const pending=new Map();let serial=0,installPrompt=null,saving=false;
  const installed=()=>Boolean(desktop||mobile||root.matchMedia?.("(display-mode: standalone)").matches||root.navigator?.standalone);
  const report=(message)=>{const el=doc.getElementById("app-install-status");if(el)el.textContent=message;root.HuayuAtlas?.showToast?.(message);};
  function status() {return {platform,installed:installed(),native:mobile||Boolean(desktop),canPromptInstall:Boolean(installPrompt),
    nativeFileSave:mobile||Boolean(desktop),onlineRequired:true,accountService:"existing-same-origin",automaticInstall:false};}
  function receive(value) {
    let message;try{message=typeof value==="string"?JSON.parse(value):value;}catch{return;}
    const task=pending.get(message?.id);if(!task)return;pending.delete(message.id);root.clearTimeout(task.timer);
    if(message.ok)task.resolve(message.result);else task.reject(Error(message.error||"文件保存失败"));
  }
  if(android?.postMessage)android.onmessage=event=>receive(event.data);
  function callNative(action,fields={}) {
    const message={id:"export-"+(++serial),action,...fields};
    if(ios?.postMessage)return ios.postMessage(message).then(reply=>{
      if(!reply?.ok)throw Error(reply?.error||"文件保存失败");return reply.result;
    });
    return new Promise((resolve,reject)=>{
      const timer=root.setTimeout(()=>{pending.delete(message.id);reject(Error("保存窗口等待超时，请重试"));},action==="finish"?600000:30000);
      pending.set(message.id,{resolve,reject,timer});
      try{android.postMessage(JSON.stringify(message));}catch(error){root.clearTimeout(timer);pending.delete(message.id);reject(error);}
    });
  }
  const filename=value=>String(value||"华域地图数据").replace(/[\\/:*?"<>|\u0000-\u001f]/gu,"-").replace(/^\.+/u,"").slice(0,120)||"华域地图数据";
  async function saveBlob(blob,name) {
    if(!mobile)return false;
    if(saving)throw Error("请先完成当前文件的保存");
    if(!(blob instanceof Blob))throw Error("导出文件尚未生成");
    saving=true;let token;
    try{
      token=await callNative("begin",{name:filename(name),mime:blob.type||"application/octet-stream",size:blob.size});
      for(let offset=0;offset<blob.size;offset+=196608){
        const bytes=new Uint8Array(await blob.slice(offset,offset+196608).arrayBuffer());
        let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        await callNative("chunk",{token,data:root.btoa(binary)});
      }
      const result=await callNative("finish",{token});
      report(result?.cancelled?"已取消保存":"文件已保存");return true;
    }catch(error){if(token)try{await callNative("cancel",{token});}catch{}throw error;}
    finally{saving=false;}
  }
  async function saveAnchor(anchor) {
    try {
      const url=new URL(anchor.href,root.location.href);
      if(url.origin!==root.location.origin&&!["blob:","data:"].includes(url.protocol))throw Error("请在浏览器打开外部下载链接");
      if(url.protocol==="blob:"&&!url.href.startsWith("blob:"+root.location.origin+"/"))throw Error("下载来源无效");
      const response=await root.fetch(url.href,{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw Error("下载失败（"+response.status+"）");
      await saveBlob(await response.blob(),anchor.download);
    }catch(error){report(error.message||"保存失败，请重试");}
  }
  if(mobile&&root.HTMLAnchorElement){
    const original=root.HTMLAnchorElement.prototype.click;
    root.HTMLAnchorElement.prototype.click=function(){
      if(this.download&&this.href){void saveAnchor(this);return;}
      return original.apply(this,arguments);
    };
    doc.addEventListener("click",event=>{
      const anchor=event.target.closest?.("a[download]");
      if(anchor?.href){event.preventDefault();void saveAnchor(anchor);}
    },true);
  }
  async function install() {
    if(installed()){report("已在应用窗口中运行");return {status:"installed"};}
    if(!installPrompt){report((/iPad|iPhone|iPod/u.test(root.navigator.userAgent)||(root.navigator.platform==="MacIntel"&&root.navigator.maxTouchPoints>1))?"在 Safari 的分享菜单选择“添加到主屏幕”":"在浏览器菜单选择“安装华域地图”或“安装此网站为应用”");return {status:"manual"};}
    const prompt=installPrompt;installPrompt=null;render();await prompt.prompt();
    const choice=await prompt.userChoice;report(choice.outcome==="accepted"?"已提交安装请求":"已取消安装");render();return {status:choice.outcome};
  }
  function render(){
    const button=doc.getElementById("app-install");if(button)button.textContent=installed()?"应用已安装":"安装到设备";
    const label=doc.getElementById("app-install-status");if(label&&!label.textContent)label.textContent=installed()?"当前在应用窗口运行；地图与共享数据需要联网。":"Windows、Linux、macOS、Android 可从支持的浏览器安装；iOS 使用 Safari 添加到主屏幕。";
  }
  root.addEventListener("beforeinstallprompt",event=>{event.preventDefault();installPrompt=event;render();});
  root.addEventListener("appinstalled",()=>{installPrompt=null;report("华域地图已安装");render();});
  function init(){
    doc.getElementById("app-install")?.addEventListener("click",()=>{void install().catch(()=>report("安装未完成，请使用浏览器安装菜单"));});
    render();
    if(!mobile&&!desktop&&root.isSecureContext&&"serviceWorker" in root.navigator)
      root.navigator.serviceWorker.register("/app-sw.js",{scope:"/",updateViaCache:"none"}).catch(()=>{});
  }
  root.HuayuApp=Object.freeze({status,install,saveBlob});
  if(doc.readyState==="loading")doc.addEventListener("DOMContentLoaded",init,{once:true});else init();
})(globalThis);
