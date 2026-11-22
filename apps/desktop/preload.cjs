const {contextBridge}=require("electron");
contextBridge.exposeInMainWorld("huayuDesktop",Object.freeze({platform:process.platform,version:"9.0.0"}));
