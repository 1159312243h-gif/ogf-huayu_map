import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const read=relative=>readFile(new URL("../"+relative,import.meta.url),"utf8");
const code=await read("site/app-platform.js");
function page({native=false,ios=false,failChunk=false,desktop=null,local=false}={}) {
 const events=new Map(),elements=new Map([["app-install",{textContent:"",addEventListener(){}}],["app-install-status",{textContent:""}]]);
 const doc={readyState:"complete",getElementById:id=>elements.get(id),addEventListener(type,handler){events.set(type,handler);}};
 class Anchor {click(){this.clicked=true;}}
 const root={document:doc,Blob,URL,Uint8Array,String,Object,Map,Promise,Error,HTMLAnchorElement:Anchor,
  location:{origin:"https://ogf-atlas.pages.dev",href:"https://ogf-atlas.pages.dev/"},
  navigator:{userAgent:"test"},matchMedia:()=>({matches:false}),isSecureContext:false,
  addEventListener(type,handler){events.set(type,handler);},setTimeout,clearTimeout,btoa:value=>Buffer.from(value,"binary").toString("base64")};
 if(desktop)root.huayuDesktop={platform:desktop,version:"9.0.1",localAssets:local,assetRevision:local?"a".repeat(64):null,bundledPublicData:local};
 const sent=[],chunks=[];let nativeResult={cancelled:false};
 const reply=payload=>{sent.push(payload);if(payload.action==="begin")return {ok:true,result:"task-1"};
  if(payload.action==="chunk"){if(failChunk)return {ok:false,error:"磁盘写入失败"};chunks.push(Buffer.from(payload.data,"base64"));}
  return {ok:true,result:payload.action==="finish"?nativeResult:null};};
 if(native)root.huayuNative={postMessage(value){const payload=JSON.parse(value),result=reply(payload);queueMicrotask(()=>root.huayuNative.onmessage({data:JSON.stringify({id:payload.id,...result})}));}};
 if(ios)root.webkit={messageHandlers:{huayuNative:{postMessage:async payload=>reply(payload)}}};
 vm.runInNewContext(code,root);
 return {root,events,elements,sent,chunks,cancel:()=>{nativeResult={cancelled:true};}};
}
const desktopClient=page({desktop:"win32"});
assert.equal(desktopClient.root.HuayuApp.status().platform,"windows");assert.equal(desktopClient.root.HuayuApp.status().nativeFileSave,true);
const localized=page({desktop:"win32",local:true});assert.equal(localized.root.HuayuApp.status().localAssets,true);assert.equal(localized.root.HuayuApp.status().assetRevision,"a".repeat(64));assert.equal(desktopClient.root.HuayuApp.status().localAssets,false);
const browser=page();
assert.equal(browser.root.HuayuApp.status().native,false);
const anchor=new browser.root.HTMLAnchorElement();anchor.click();assert.equal(anchor.clicked,true,"浏览器原下载不被替换");
let prompts=0,prevented=false;
browser.events.get("beforeinstallprompt")({preventDefault(){prevented=true;},prompt:async()=>{prompts++;},userChoice:Promise.resolve({outcome:"accepted"})});
assert.equal(prevented,true);assert.equal(prompts,0,"不能自动安装");
assert.equal(browser.root.HuayuApp.status().canPromptInstall,true);
assert.equal((await browser.root.HuayuApp.install()).status,"accepted");assert.equal(prompts,1);
assert.equal(browser.root.HuayuApp.status().canPromptInstall,false);
const ipadPage=page();ipadPage.root.navigator.platform="MacIntel";ipadPage.root.navigator.maxTouchPoints=5;
await ipadPage.root.HuayuApp.install();assert.match(ipadPage.elements.get("app-install-status").textContent,/Safari/u,"桌面模式的iPad仍显示Safari主屏幕安装步骤");
const installPage=await read("site/apps.html");assert.match(installPage,/name="apple-mobile-web-app-capable" content="yes"/u);
const bytes=Buffer.alloc(600001);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
for(const options of [{native:true},{ios:true}]){
 const p=page(options);assert.equal(p.root.HuayuApp.status().nativeFileSave,true);
 await p.root.HuayuApp.saveBlob(new Blob([bytes]),"测试../线路图.csv");
 assert.equal(p.sent[0].name.includes("/"),false);
 assert.equal(p.sent[0].size,bytes.length);assert.equal(p.sent.filter(m=>m.action==="finish").length,1);
 assert.equal(createHash("sha256").update(Buffer.concat(p.chunks)).digest("hex"),createHash("sha256").update(bytes).digest("hex"),"分块保存逐字节一致");
 p.cancel();await p.root.HuayuApp.saveBlob(new Blob(["data"]),"取消.csv");assert.match(p.elements.get("app-install-status").textContent,/取消/);
}
const broken=page({native:true,failChunk:true});
await assert.rejects(broken.root.HuayuApp.saveBlob(new Blob(["data"]),"失败.csv"),/磁盘/);
assert.ok(broken.sent.some(m=>m.action==="cancel"));assert.ok(!broken.sent.some(m=>m.action==="finish"),"半文件不进入成功保存");
await import("./test-app-cache.mjs");
const cfg=JSON.parse(await read("apps/app.json")),release=JSON.parse(await read("release.json"));
assert.equal(cfg.origin,release.productionUrl);
const manifest=JSON.parse(await read("site/manifest.webmanifest"));
assert.equal(manifest.scope,"/");assert.equal(manifest.id,"/");assert.ok(manifest.icons.some(i=>i.sizes==="512x512"));
const desktop=await read("apps/desktop/main.cjs"),preload=await read("apps/desktop/preload.cjs");
assert.match(desktop,/nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true/u);
assert.ok(!desktop.includes('webSecurity:false'));assert.ok(!desktop.includes('"--no-sandbox"'));
assert.ok(!preload.includes("ipcRenderer"));assert.ok(!preload.includes("fs"));
const android=await read("apps/android/app/src/main/java/dev/huayu/atlas/MainActivity.java");
assert.match(android,/Collections.singleton\(ORIGIN\)/u);assert.match(android,/!mainFrame/u);assert.ok(!android.includes("addJavascriptInterface"));
assert.match(android,/ACTION_CREATE_DOCUMENT/u);assert.match(android,/received!=expected/u);
const ios=await read("apps/ios/Sources/App.swift");
assert.match(ios,/message.frameInfo.isMainFrame/u);assert.match(ios,/security.host == origin/u);
assert.match(ios,/UIDocumentPickerViewController\(forExporting/u);assert.match(ios,/received == expected/u);
const html=await read("site/index.html");assert.ok(html.includes('rel="manifest"'));assert.ok(html.includes('id="app-install"'));
await import("../site/map-agent-contract.js");await import("../site/map-agent-tools.js");
globalThis.HuayuApp={status:()=>({platform:"android",native:true,installed:true,onlineRequired:true})};
const tool=globalThis.HuayuAgentTools.create({atlas:{}});
assert.equal((await tool.execute("get_app_status",{})).platform,"android","助手实际调用客户端处理器");
delete globalThis.HuayuApp;
console.log("App checks passed: explicit installation, byte-exact Android/iOS streaming, cancellation/failure, cache isolation, native origin guards and real assistant status.");

await import("./test-app-downloads.mjs");
await import("./test-desktop-local.mjs");

await import("./test-shared-client-refresh.mjs");
