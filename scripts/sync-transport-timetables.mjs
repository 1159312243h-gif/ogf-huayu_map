import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const core=await readFile(new URL("../site/transport-timetable-core.js",import.meta.url),"utf8");
const server=await readFile(new URL("../site/transport-timetable-server.js",import.meta.url),"utf8");
const factory=core.slice(core.indexOf("function createTransportTimetableCore()"),core.indexOf("globalThis.HuayuTimetableCore="));
const block="// BEGIN TRANSPORT TIMETABLES\n"+factory+"\n"+server+"\n// END TRANSPORT TIMETABLES";
const url=new URL("../site/_worker.js",import.meta.url),worker=await readFile(url,"utf8"),start="// BEGIN TRANSPORT TIMETABLES",end="// END TRANSPORT TIMETABLES";
if(process.argv.includes("--check"))assert.ok(worker.includes(block),"班次前后端不同步，请运行 sync-transport-timetables.mjs");
else await writeFile(url,worker.includes(start)?worker.slice(0,worker.indexOf(start))+block+worker.slice(worker.indexOf(end)+end.length):worker.replace("const DATASET_SELECT =",block+"\n\nconst DATASET_SELECT ="));
