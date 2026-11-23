const {contextBridge}=require("electron");
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1)||"";
contextBridge.exposeInMainWorld("huayuDesktop",Object.freeze({platform:process.platform,version:argument("--huayu-app-version")||"9.0.3",
  localAssets:Boolean(argument("--huayu-local-revision")),assetRevision:argument("--huayu-local-revision"),bundledBytes:Number(argument("--huayu-local-bytes"))||0,
  bundledPublicData:Boolean(argument("--huayu-local-revision")),programUpdates:"verified-on-restart"}));
