import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,mkdir,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),base=path.join(root,".data-update");
await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,"app-index-"));
const input=path.join(directory,"input"),output=path.join(directory,"output"),source="a".repeat(40);
try{
 await mkdir(input);
 for(const name of ["Huayu-Atlas-9.0.0-win-x64.exe","Huayu-Atlas-9.0.0-linux-x86_64.AppImage","app-debug.apk"])await writeFile(path.join(input,name),Buffer.from("package "+name));
 const run=(dest,tag="apps-v9.0.0-preview.1")=>spawnSync(process.execPath,[path.join(root,"scripts/index-native-packages.mjs"),input,dest,tag,source],{cwd:root,env:{...process.env,GITHUB_REPOSITORY:"1159312243h-gif/ogf-huayu_map"},encoding:"utf8",windowsHide:true});
 assert.equal(run(output).status,0);
 const index=JSON.parse(await readFile(path.join(output,"app-releases.json"),"utf8"));
 assert.equal(index.items.length,3);
 for(const item of index.items){const bytes=await readFile(path.join(output,item.filename));assert.equal(item.sha256,createHash("sha256").update(bytes).digest("hex"));assert.equal(item.bytes,bytes.length);assert.equal(item.sourceSha,source);assert.ok(item.url.startsWith("https://github.com/1159312243h-gif/ogf-huayu_map/releases/download/"));}
 assert.ok(index.items.some(item=>item.filename==="Huayu-Atlas-9.0.0-android-test.apk"));
 assert.notEqual(run(path.join(directory,"bad"),"../bad").status,0,"不接受任意发布标签");
 assert.notEqual(run(output).status,0,"不能覆盖旧的校验产物");
 await rm(path.join(input,"app-debug.apk"));
 assert.notEqual(run(path.join(directory,"missing")).status,0,"缺平台不能准备发布");
 console.log("Native package index passed: exact file hashes/sizes, Android identity, repository scope, required platforms and no overwrite.");
}finally{
 const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(base)+path.sep+"app-index-"))throw Error("Unsafe temporary directory");
 await rm(resolved,{recursive:true});
}
