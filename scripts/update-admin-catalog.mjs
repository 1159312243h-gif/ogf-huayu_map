import {readFile,writeFile,rename,unlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import "../site/admin-catalog.js";
import overpassNetwork from "./data-update/builders/overpass-network.cjs";
import {recoverSourceBody} from "./lib/source-body-recovery.mjs";
const C=globalThis.HuayuAdministrativeCatalog;
export async function replaceAdministrativeCatalog(file,candidate){
  C.validate(candidate);
  const temporary=`${file}.${process.pid}.pending`;
  try{await writeFile(temporary,JSON.stringify(candidate),{flag:"wx"});
    C.validate(JSON.parse(await readFile(temporary,"utf8")));await rename(temporary,file);
  }finally{await unlink(temporary).catch(e=>{if(e.code!=="ENOENT")throw e;});}
}
async function main(){
  const file=new URL("../site/huaxia-admin-catalog.json",import.meta.url);
  let previous;try{previous=C.validate(JSON.parse(await readFile(file,"utf8")));}catch(e){if(e.code!=="ENOENT")throw e;}
  if(process.argv.includes("--check")){C.validate(previous);console.log(JSON.stringify({total:previous.total,readAt:previous.readAt,sourceTime:previous.sourceTime}));return;}
  const loader=new C.Loader({storage:null,fetcher:overpassNetwork.fetchWithRetry});loader.current=previous;
  const candidate=await recoverSourceBody(()=>loader.live());
  await replaceAdministrativeCatalog(fileURLToPath(file),candidate);
  console.log(JSON.stringify({total:candidate.total,readAt:candidate.readAt,sourceTime:candidate.sourceTime}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
