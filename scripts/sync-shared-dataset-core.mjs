import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const source=await readFile(new URL("../site/shared-dataset-core.js",import.meta.url),"utf8");
const factory=source.slice(source.indexOf("function createSharedDatasetTools()"),source.indexOf("globalThis.HuayuDatasetTools="));
const url=new URL("../site/_worker.js",import.meta.url),worker=await readFile(url,"utf8");
const start="// BEGIN SHARED DATASET CORE\n",end="// END SHARED DATASET CORE";
const block=start+factory+end;
if(process.argv.includes("--check"))assert.ok(worker.includes(block),"共享数据解析器与独立 Worker 不一致，请运行 sync-shared-dataset-core.mjs");
else await writeFile(url,worker.includes(start)?worker.slice(0,worker.indexOf(start))+block+worker.slice(worker.indexOf(end)+end.length):worker.replace("async function handlePersonalApi(",block+"\n\nasync function handlePersonalApi("));
