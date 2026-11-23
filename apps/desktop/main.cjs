"use strict";
const {app,BrowserWindow,session,shell}=require("electron");
const path=require("node:path");
const {LocalClient}=require("./local-client.cjs");
const config=require("./app.json"),origin=new URL(config.origin).origin;
const smoke=process.argv.includes("--smoke-test");
function trusted(value){try{const url=new URL(value);return url.protocol==="https:"&&url.origin===origin;}catch{return false;}}
function external(value){try{const url=new URL(value);if(["https:","http:"].includes(url.protocol))void shell.openExternal(url.href);}catch{}}
if(smoke)app.setPath("userData",path.join(app.getPath("temp"),"huayu-local-smoke-"+process.pid));
if(!app.requestSingleInstanceLock())app.quit();
let window;
app.on("second-instance",()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.whenReady().then(async()=>{
  const isolated=session.fromPartition(smoke?"huayu-smoke":"persist:huayu-atlas");
  const local=await new LocalClient({origin,bundle:path.join(__dirname,"renderer"),
    directory:path.join(app.getPath("userData"),"local-client"),offline:smoke,
    fetch:(request,options)=>isolated.fetch(request,{...options,bypassCustomProtocolHandlers:true})}).init();
  await isolated.protocol.handle("https",request=>local.handle(request).catch(()=>new Response("网络资源暂不可用",{status:503})));
  isolated.setPermissionCheckHandler((_contents,permission,requestingOrigin)=>
    trusted(requestingOrigin)&&permission==="clipboard-sanitized-write");
  isolated.setPermissionRequestHandler((contents,permission,callback)=>
    callback(trusted(contents.getURL())&&permission==="clipboard-sanitized-write"));
  window=new BrowserWindow({width:1380,height:900,minWidth:360,minHeight:480,title:config.name,show:!smoke,
    backgroundColor:"#f3f6f5",icon:path.join(__dirname,"icons/icon-512.png"),autoHideMenuBar:true,
    webPreferences:{additionalArguments:["--huayu-local-revision="+local.status().revision,"--huayu-local-bytes="+local.status().bundledBytes,"--huayu-app-version="+config.version],preload:path.join(__dirname,"preload.cjs"),session:isolated,
      nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}});
  window.webContents.setWindowOpenHandler(({url})=>{external(url);return {action:"deny"};});
  window.webContents.on("will-navigate",(event,url)=>{
    if(!trusted(url)){event.preventDefault();external(url);}
  });
  window.webContents.on("will-attach-webview",event=>event.preventDefault());
  isolated.on("will-download",(event,item,contents)=>{
    const url=item.getURL();
    if(contents!==window.webContents||!trusted(contents.getURL())
      ||!(trusted(url)||url.startsWith("blob:"+origin+"/"))){event.preventDefault();return;}
    item.setSaveDialogOptions({title:"保存华域地图文件",defaultPath:path.join(app.getPath("downloads"),path.basename(item.getFilename()))});
  });
  window.webContents.on("did-fail-load",(_event,code,_description,_url,main)=>{
    if(main&&code!==-3&&!smoke)void window.loadFile(path.join(__dirname,"offline.html"));
  });
  window.on("closed",()=>{window=null;});
  if(smoke){
    const began=Date.now();
    await window.loadURL(config.startUrl+"#map=4/12.5/148.36");
    let result;
    for(let attempt=0;attempt<150;attempt++){
      result=await window.webContents.executeJavaScript('({node:typeof process,platform:window.huayuDesktop?.platform,isolated:typeof require,local:window.HuayuApp?.status(),mapReady:!!window.HuayuAtlas,leaflet:document.getElementById("map").classList.contains("leaflet-container"),scripts:[...document.scripts].filter(s=>s.src).length,help:!!window.HuayuMapHelp,brands:!!window.HuayuBrandLogos,templates:!!window.HuayuLineTemplateUI,traffic:!!window.HuayuTraffic,datasets:!!window.HuayuSharedDatasets})');
      if(result.mapReady&&result.help&&result.brands&&result.templates&&result.traffic&&result.datasets)break;await new Promise(resolve=>setTimeout(resolve,100));
    }
    const snapshot=await window.webContents.executeJavaScript('(async()=>{const a=await fetch("./transit-preload.json"),b=await fetch("./terrain-preload.json.gz");const transit=await a.json(),bytes=new Uint8Array(await b.arrayBuffer());const terrain=JSON.parse(bytes[0]===31&&bytes[1]===139?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text():new TextDecoder().decode(bytes));const js=await fetch("./app.js");return {transitSource:a.headers.get("X-Huayu-Desktop-Source"),terrainSource:b.headers.get("X-Huayu-Desktop-Source"),transitRegions:transit.snapshots.length,terrainSchema:terrain.schema,scriptSource:js.headers.get("X-Huayu-Desktop-Source")};})()');
    const passed=snapshot.transitSource==="bundled-public-snapshot"&&snapshot.terrainSchema==="open-small-mountains-v1"&&snapshot.scriptSource==="local-code"&&result.node==="undefined"&&result.isolated==="undefined"&&result.local?.localAssets&&result.mapReady&&result.leaflet&&result.help&&result.templates&&result.traffic&&result.datasets;
    if(process.env.HUAYU_SMOKE_SCREENSHOT)await require("node:fs/promises").writeFile(process.env.HUAYU_SMOKE_SCREENSHOT,(await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({check:"native-desktop-local-offline-startup",passed,startupMs:Date.now()-began,snapshot,...result}));
    app.exit(passed?0:1);
  }else{
    await window.loadURL(config.startUrl).catch(()=>{});
    const updateTimer=setTimeout(()=>{if(window?.isFocused())void local.checkForUpdate();},10000);
    const checkTimer=setInterval(()=>{if(window?.isFocused()&&!window.isMinimized())void local.checkForUpdate();},300000);
    updateTimer.unref();checkTimer.unref();
    window.on("focus",()=>{if(Date.now()-local.lastUpdateAttempt>=300000)void local.checkForUpdate();});
    app.on("before-quit",()=>{clearTimeout(updateTimer);clearInterval(checkTimer);});
  }
});
app.on("window-all-closed",()=>app.quit());
