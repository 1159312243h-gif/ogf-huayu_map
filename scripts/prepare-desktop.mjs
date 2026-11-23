import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {gunzipSync} from "node:zlib";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {publicFile,dataFile,codeId,digest,validateManifest,sourceTime}=require("../apps/desktop/local-client.cjs");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),site=path.join(root,"site");
async function walk(dir,prefix=""){const result=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())result.push(...await walk(path.join(dir,entry.name),name+"/"));else if(entry.isFile()&&publicFile(name))result.push(name);}return result.sort();}
export async function prepareDesktop({check=false,bundle=false}={}){
 const names=(await walk(site)).filter(n=>n!=="app-cache-version.js"),files=[];
 const code=[];for(const name of names){if(!dataFile(name)){const b=await fs.readFile(path.join(site,name));code.push({path:name,bytes:b.length,sha256:digest(b),kind:"code"});}}
 const marker='self.HUAYU_CACHE_BUILD = "'+codeId(code)+'";\n',markerPath=path.join(site,"app-cache-version.js");
 if(check){if(await fs.readFile(markerPath,"utf8")!==marker)throw Error("跨平台程序缓存版本需要同步");}else await fs.writeFile(markerPath,marker);
 names.push("app-cache-version.js");names.sort();
 for(const name of names){const bytes=await fs.readFile(path.join(site,name));const decoded=name.endsWith(".gz")?gunzipSync(bytes):bytes;files.push({path:name,bytes:bytes.length,sha256:digest(bytes),kind:dataFile(name)?"data":"code",...(dataFile(name)?{sourceTime:sourceTime(bytes,name),decodedBytes:decoded.length,decodedSha256:digest(decoded)}:{})});}
 const config=JSON.parse(await fs.readFile(path.join(root,"apps/app.json"),"utf8"));
 const manifest=validateManifest({schema:"huayu-desktop-assets-v1",runtime:1,version:config.version,revision:codeId(files),files});
 const body=JSON.stringify(manifest,null,2)+"\n",filename=path.join(site,"desktop-assets.json");
 if(check){if(await fs.readFile(filename,"utf8")!==body)throw Error("桌面本地资源清单需要同步");}else await fs.writeFile(filename,body);
 if(bundle){const dir=path.join(root,"apps/desktop/renderer");await fs.mkdir(dir,{recursive:true});
  for(const f of files){await fs.mkdir(path.dirname(path.join(dir,f.path)),{recursive:true});await fs.copyFile(path.join(site,f.path),path.join(dir,f.path));}
  await fs.writeFile(path.join(dir,"desktop-assets.json"),body);
 }
 if(process.argv.includes("--mobile")){
  const dir=path.join(root,"apps/android/app/src/main/assets/huayu");await fs.mkdir(dir,{recursive:true});
  for(const f of files){await fs.mkdir(path.dirname(path.join(dir,f.path)),{recursive:true});await fs.copyFile(path.join(site,f.path),path.join(dir,f.path));}
  await fs.writeFile(path.join(dir,"desktop-assets.json"),body);
 }
 return {revision:manifest.revision,files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0),bundled:bundle};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareDesktop({check:process.argv.includes("--check"),bundle:process.argv.includes("--bundle")})));
