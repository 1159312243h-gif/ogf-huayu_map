"use strict";
const {app,BrowserWindow,session,shell}=require("electron");
const path=require("node:path");
const config=require("./app.json"),origin=new URL(config.origin).origin;
const smoke=process.argv.includes("--smoke-test");
function trusted(value){try{const url=new URL(value);return url.protocol==="https:"&&url.origin===origin;}catch{return false;}}
function external(value){try{const url=new URL(value);if(["https:","http:"].includes(url.protocol))void shell.openExternal(url.href);}catch{}}
if(!app.requestSingleInstanceLock())app.quit();
let window;
app.on("second-instance",()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.whenReady().then(async()=>{
  const isolated=session.fromPartition(smoke?"huayu-smoke":"persist:huayu-atlas");
  isolated.setPermissionCheckHandler((_contents,permission,requestingOrigin)=>
    trusted(requestingOrigin)&&permission==="clipboard-sanitized-write");
  isolated.setPermissionRequestHandler((contents,permission,callback)=>
    callback(trusted(contents.getURL())&&permission==="clipboard-sanitized-write"));
  window=new BrowserWindow({width:1380,height:900,minWidth:360,minHeight:480,title:config.name,show:!smoke,
    backgroundColor:"#f3f6f5",icon:path.join(__dirname,"icons/icon-512.png"),autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,"preload.cjs"),session:isolated,
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
    await window.loadFile(path.join(__dirname,"offline.html"));
    const result=await window.webContents.executeJavaScript('({node:typeof process,platform:window.huayuDesktop?.platform,isolated:typeof require})');
    const passed=result.node==="undefined"&&result.isolated==="undefined"&&Boolean(result.platform);
    console.log(JSON.stringify({check:"native-desktop-isolation",passed,...result}));
    app.exit(passed?0:1);
  }else await window.loadURL(config.startUrl).catch(()=>{});
});
app.on("window-all-closed",()=>app.quit());
