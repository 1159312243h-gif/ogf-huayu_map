import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const root=new URL("../",import.meta.url),source=await readFile(new URL("site/brand-management-server.js",root),"utf8");
const block="// BEGIN BRAND MANAGEMENT\n"+source+"\nconst brandManagementApi=createBrandManagementServer({core:createBrandLogoCore(),builtins:"+JSON.stringify(JSON.parse(await readFile(new URL("site/brand-logos.json",root),"utf8")).items)+",json:personalJson,readJson:readJsonBody,requireUser:requirePersonalUser,currentUser:currentPersonalUser,publicUser,sameOrigin:sameOriginMutation});\n// END BRAND MANAGEMENT";
const url=new URL("site/_worker.js",root),worker=await readFile(url,"utf8"),start="// BEGIN BRAND MANAGEMENT",end="// END BRAND MANAGEMENT";
if(process.argv.includes("--check"))assert.ok(worker.includes(block),"品牌管理 Worker 与模块不一致，请运行 sync-brand-management.mjs");
else await writeFile(url,worker.includes(start)?worker.slice(0,worker.indexOf(start))+block+worker.slice(worker.indexOf(end)+end.length):worker.replace("// BEGIN BRAND LOGOS",block+"\n\n// BEGIN BRAND LOGOS"));
