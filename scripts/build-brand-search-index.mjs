import{readFile,writeFile,rename,unlink}from"node:fs/promises";
import{fileURLToPath}from"node:url";import path from"node:path";import"../site/brand-data.js";
export function buildSearchIndex(catalog){return globalThis.HuayuBrandData.buildSearchIndex(catalog);}
export async function replaceCatalogFiles(file,candidate,{move=rename}={}){
  globalThis.HuayuBrandData.validateCatalog(candidate);
  const index=buildSearchIndex(candidate),body=JSON.stringify(candidate),search=JSON.stringify(index);
  if(Buffer.byteLength(body)>16*1024*1024)throw Error("CATALOG_TOO_LARGE");
  if(Buffer.byteLength(search)>8*1024*1024)throw Error("SEARCH_INDEX_TOO_LARGE");
  const files=[{file,body},{file:path.join(path.dirname(file),"brand-search-index.json"),body:search}];
  for(const entry of files){entry.temp=entry.file+"."+process.pid+".pending";try{entry.before=await readFile(entry.file);}catch(e){if(e.code!=="ENOENT")throw e;entry.before=null;}}
  let changed=false;
  try{
    for(const entry of files)await writeFile(entry.temp,entry.body,{flag:"wx"});
    globalThis.HuayuBrandData.validateCatalog(JSON.parse(await readFile(files[0].temp,"utf8")));
    globalThis.HuayuBrandData.validateSearchIndex(JSON.parse(await readFile(files[1].temp,"utf8")));
    for(const entry of files){await move(entry.temp,entry.file);changed=true;}
  }catch(error){
    if(changed)for(const entry of files){if(entry.before===null)await unlink(entry.file).catch(e=>{if(e.code!=="ENOENT")throw e;});else await writeFile(entry.file,entry.before);}
    throw error;
  }finally{for(const entry of files)await unlink(entry.temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}
}
const root=fileURLToPath(new URL("../",import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const catalog=JSON.parse(await readFile(path.join(root,"site/brand-catalog.json"),"utf8")),index=buildSearchIndex(catalog);
  const file=path.join(root,"site/brand-search-index.json"),body=JSON.stringify(index);
  if(process.argv.includes("--check")){if(await readFile(file,"utf8")!==body)throw Error("品牌搜索索引与完整目录不一致");}
  else{if(Buffer.byteLength(body)>8*1024*1024)throw Error("SEARCH_INDEX_TOO_LARGE");const temp=file+"."+process.pid+".pending";try{await writeFile(temp,body,{flag:"wx"});await rename(temp,file);}finally{await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}}
  console.log(JSON.stringify({status:"passed",bytes:Buffer.byteLength(body),brands:index.brands.length,operators:index.operators.length,sourceTime:index.dbTimestamp}));
}
