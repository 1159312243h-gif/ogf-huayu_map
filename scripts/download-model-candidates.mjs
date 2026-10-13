import {createServer} from "node:http";
import {readFile,writeFile,mkdir,rename} from "node:fs/promises";
import {createHash,randomBytes} from "node:crypto";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import vm from "node:vm";
import {inspectGlb} from "../site/model-import/runtime.js";
import {prepareKnownModel} from "./prepare-model-candidates.mjs";
import {prepareCityWall} from "./prepare-city-wall-model.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const site=path.join(root,"site"),output=path.join(root,".data-update","model-downloads");
const api="https://api.sketchfab.com/v3/models/",maxDownload=192*1024*1024;
export async function candidates() {
  const context=vm.createContext({localStorage:{getItem(){return null;}}});
  vm.runInContext(await readFile(path.join(site,"model-options.js"),"utf8"),context);
  return context.HuayuModelOptions.candidates.filter(candidate=>!candidate.bundled);
}
export function downloadUrl(value) {
  const url=new URL(value);
  if(url.protocol!=="https:" || url.username || url.password || !/(^|\.)(sketchfab\.com|amazonaws\.com|cloudfront\.net)$/u.test(url.hostname))
    throw new Error("官方下载接口返回了不支持的文件域名。");
  return url;
}
export function verifyMetadata(candidate,metadata) {
  if(metadata.uid!==candidate.uid)throw new Error("来源模型 ID 不一致。");
  if(!metadata.isDownloadable)return {downloadable:false,note:"作者未开放下载，保留待授权文件。"};
  if(metadata.license?.slug!=="by" || !/^https?:\/\/creativecommons\.org\/licenses\/by\/4\.0\/?$/u.test(metadata.license?.url || ""))
    throw new Error("当前许可不是已确认的 CC BY 4.0，已停止本项下载。");
  return {downloadable:true};
}
async function atomicJson(file,value) {
  const temp=`${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`);await rename(temp,file);
}
export async function updateAttribution(catalog,batchSite=site) {
  const file=path.join(batchSite,"model-import","ATTRIBUTION.md"),marker="\n<!-- BATCH_MODELS -->\n";
  const existing=(await readFile(file,"utf8")).split(marker)[0].trimEnd();
  const notices=catalog.models.map(model=>[
    `## ${model.name}`,`Author: ${model.author} (${model.authorUrl})`,`Source: ${model.source}`,
    `License: ${model.license} (${model.licenseUrl})`,`File: ${model.url}`,`SHA-256: ${model.sha256}`,
    model.changes || "Original geometry and embedded textures retained. Orientation and bounds are fitted by the importer.",
    "No author endorsement is implied.",
  ].join("\n\n")).join("\n\n");
  const temporary=`${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary,`${existing}${marker}\n${notices}\n`);await rename(temporary,file);
}
async function getJson(url,token) {
  const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(30000),
    headers:{Accept:"application/json",...(token ? {Authorization:`Token ${token}`} : {})}});
  if(response.status===401 || response.status===403)throw new Error("Sketchfab 下载认证失败，请检查 API token 与账户下载资格。");
  if(!response.ok)throw new Error(`官方 API 返回 HTTP ${response.status}。`);
  return response.json();
}
async function fetchModel(url) {
  let response;
  for(let attempt=0;attempt<5;attempt++) {
    response=await fetch(downloadUrl(url),{redirect:"manual",signal:AbortSignal.timeout(120000)});
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();url=new URL(response.headers.get("location"),url).href;continue;
    }
    break;
  }
  if(!response.ok)throw new Error(`模型下载返回 HTTP ${response.status}。`);
  const length=Number(response.headers.get("content-length"));
  if(length>maxDownload){await response.body?.cancel();throw new Error("原件超过 192 MiB 下载预算。");}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body) {
    bytes+=chunk.length;if(bytes>maxDownload){await response.body.cancel().catch(()=>{});throw new Error("原件超过 192 MiB 下载预算。");}
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function describeGlb(buffer) {
  const inspected=inspectGlb(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
  const json=JSON.parse(buffer.subarray(20,20+buffer.readUInt32LE(12)).toString("utf8"));
  return {json,inspected};
}
export async function startServer(port=54345,{workspaceRoot=root,refreshManifest=true}={}) {
  const site=path.join(workspaceRoot,"site"),output=path.join(workspaceRoot,".data-update","model-downloads");
  const list=await candidates(),items=list.map(candidate=>({id:candidate.id,label:candidate.label,status:"pending",note:""}));
  const state={running:false,message:"等待填入一次 Sketchfab API token。",items};
  try {
    const previous=JSON.parse(await readFile(path.join(output,"batch-report.json"),"utf8"));
    if(previous.running===false && previous.items?.length===items.length && previous.items.every((item,index)=>item.id===items[index].id)) {
      state.message=previous.message;
      previous.items.forEach((item,index)=>Object.assign(items[index],{status:item.status,note:item.note}));
    }
  } catch {}
  let origin=`http://127.0.0.1:${port}`;
  const page=await readFile(new URL("model-batch-page.html",import.meta.url));
  const catalogPath=path.join(site,"model-import","bundled-candidates.json");
  let browser;
  async function validate(candidate,buffer) {
    const {json,inspected}=describeGlb(buffer);
    const staging=path.join(output,`${candidate.id}.glb`);
    await writeFile(staging,buffer);
    if(!browser) {
      const dependency=path.resolve(path.dirname(process.execPath),"..","node_modules","playwright","index.mjs");
      const {chromium}=await import(pathToFileURL(dependency).href);
      browser=await chromium.launch({channel:"msedge",headless:true,args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
    }
    const tab=await browser.newPage({viewport:{width:640,height:480}});
    try {
      await tab.goto(`${origin}/batch/preview`);
      const info=await tab.evaluate(async({id,category})=>{
        const engine=await import('/model-import/runtime.js?v=birch-coverage-v1');
        const bytes=await (await fetch(`/batch/files/${id}.glb`)).arrayBuffer();
        const gltf=await engine.parse(bytes),config={up:'y',yaw:category==='cityWall' ? 90 : 0,
          part:id==='chain-link-fence' ? '0/0/0/2' : 'all'};
        // A pack cannot be planted at every map position. Review its complete single-object part first.
        const choices=engine.parts(gltf);
        const asset=engine.bundle(gltf,config);
        engine.createPreview(document.getElementById('preview'),gltf,config);
        return {triangles:asset.triangles,primitives:asset.pieces.length,config,parts:choices};
      },{id:candidate.id,category:candidate.category});
      if(!info.review)await tab.locator('#preview').screenshot({path:path.join(output,`${candidate.id}-preview.png`)});
      return {...info,inspected,sourceNotice:json.asset?.extras?.source || null};
    } finally {await tab.close();}
  }
  async function run(token,{offline=false}={}) {
    state.running=true;state.message=offline ? "使用已下载原件转换、检查与导入，不需要再次认证。" : state.message;
    await mkdir(output,{recursive:true});
    for(const [index,candidate] of list.entries()) {
      const item=items[index];
      try {
        item.status="checking";
        const sourceFile=path.join(output,`${candidate.id}-source.json`);
        const stored=offline ? JSON.parse(await readFile(sourceFile,"utf8")) : null;
        const metadata=offline ? {...stored,viewerUrl:stored.source,user:{displayName:stored.author,profileUrl:stored.authorUrl}}
          : await getJson(`${api}${candidate.uid}`);
        const verification=verifyMetadata(candidate,metadata);
        if(!offline)await atomicJson(sourceFile,{
          uid:metadata.uid,name:metadata.name,source:metadata.viewerUrl,author:metadata.user?.displayName,
          authorUrl:metadata.user?.profileUrl,license:metadata.license,isDownloadable:metadata.isDownloadable,
          faces:metadata.faceCount,animations:metadata.animationCount,checkedAt:new Date().toISOString(),
        });
        if(!verification.downloadable){item.status="blocked";item.note=verification.note;continue;}
        const originalPath=path.join(output,`${candidate.id}-original.glb`);
        let buffer;
        try {buffer=await readFile(originalPath);item.status="cached";}catch(error){if(error.code!=="ENOENT")throw error;}
        if(!buffer) {
          if(offline)throw new Error("本项原件尚未下载，离线处理不会发起认证或下载请求。");
          item.status="downloading";
          const response=await getJson(`${api}${candidate.uid}/download`,token);
          if(!response.glb?.url)throw new Error("官方接口没有提供 GLB 文件，需先转换提供的原始格式。");
          buffer=await fetchModel(response.glb.url);
          if(response.glb.size && buffer.length!==response.glb.size)throw new Error("下载文件大小与官方接口不一致。");
          if(buffer.length<28 || buffer.readUInt32LE(0)!==0x46546c67 || buffer.readUInt32LE(8)!==buffer.length)
            throw new Error("下载文件不是完整 GLB。");
          await writeFile(`${originalPath}.partial`,buffer);await rename(`${originalPath}.partial`,originalPath);
        }
        const hash=createHash("sha256").update(buffer).digest("hex");
        const downloadFile=path.join(output,`${candidate.id}-download.json`);
        if(offline) {
          const downloaded=JSON.parse(await readFile(downloadFile,"utf8"));
          if(downloaded.sha256!==hash || downloaded.bytes!==buffer.length)throw new Error("原件与下载记录的大小或哈希不一致。");
        } else await atomicJson(downloadFile,{id:candidate.id,bytes:buffer.length,sha256:hash,downloadedAt:new Date().toISOString()});
        item.status="validating";
        const preparation=candidate.category==="cityWall" ? await prepareCityWall(buffer) : prepareKnownModel(candidate.id,buffer);
        buffer=preparation.buffer;
        const preparedHash=createHash("sha256").update(buffer).digest("hex");
        const info=await validate(candidate,buffer);
        await atomicJson(path.join(output,`${candidate.id}-inspection.json`),info);
        if(info.review){item.status="downloaded";item.note="灌木组已校验，需选择完整单株及 LOD，避免整组重复布置。";continue;}
        const filename=`${candidate.id}-${preparedHash.slice(0,12)}.glb`;
        await writeFile(path.join(site,"model-import","assets",filename),buffer);
        const catalog=JSON.parse(await readFile(catalogPath,"utf8"));
        const record={id:candidate.id,uid:candidate.uid,category:candidate.category,name:metadata.name,
          url:`./model-import/assets/${filename}`,bytes:buffer.length,sha256:preparedHash,
          triangles:info.triangles,primitives:info.primitives,config:info.config,
          source:metadata.viewerUrl,author:metadata.user.displayName,authorUrl:metadata.user.profileUrl,
          license:"CC BY 4.0",licenseUrl:"https://creativecommons.org/licenses/by/4.0/",checkedAt:new Date().toISOString(),
          ...(preparation.changes ? {changes:preparation.changes,sourceSha256:hash} : {})};
        catalog.models=catalog.models.filter(model=>model.id!==candidate.id).concat(record);
        await updateAttribution(catalog,site);
        await atomicJson(catalogPath,catalog);
        item.status="registered";item.note=`已登记可替换文件，${info.triangles} 三角面；刷新地图后可选择。`;
      } catch(error) {item.status="failed";item.note=error.message?.includes("token") ? error.message : String(error.message || "本项未完成。").slice(0,240);}
      finally {await atomicJson(path.join(output,"batch-report.json"),state);}
    }
    token=null;state.running=false;
    state.message=`批次结束：${items.filter(item=>item.status==="registered").length} 款文件已导入，${items.filter(item=>item.status==="downloaded").length} 款原件待处理。未开放下载或失败的项目已列明，其他结果保留。`;
    await atomicJson(path.join(output,"batch-report.json"),state);
    await browser?.close();browser=null;
    // Refresh only file hashes; data snapshots and release version are unchanged.
    if(refreshManifest) {
      const {spawn}=await import("node:child_process");
      await new Promise(resolve=>spawn(process.execPath,["scripts/update-manifest.mjs"],{cwd:workspaceRoot,stdio:"ignore"}).once("close",resolve));
    }
  }
  const server=createServer(async(request,response)=>{
    const reply=(status,body,type="application/json; charset=utf-8")=>{
      response.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});response.end(body);};
    try {
      if(request.headers.host!==`127.0.0.1:${port}`)return reply(403,'{"message":"仅允许本机地址。"}');
      const url=new URL(request.url,origin);
      if(request.method==="GET" && url.pathname==="/")return reply(200,page,"text/html; charset=utf-8");
      if(request.method==="GET" && url.pathname==="/batch/status")return reply(200,JSON.stringify(state));
      if(request.method==="POST" && url.pathname==="/batch/start") {
        state.lastAttemptAt=new Date().toISOString();
        if(request.headers.origin!==origin || request.headers["content-type"]!=="application/json") {
          state.lastError="请求来源未通过检查，请从本地批量页面提交。";
          return reply(403,JSON.stringify({message:state.lastError}));
        }
        if(state.running)return reply(409,'{"message":"正在处理当前批次，请等待结果。"}');
        const chunks=[];let bytes=0;
        for await(const chunk of request){bytes+=chunk.length;if(bytes>1024)return reply(413,'{"message":"输入过长。"}');chunks.push(chunk);}
        const {token}=JSON.parse(Buffer.concat(chunks));
        if(typeof token!=="string" || !/^[a-zA-Z0-9_-]{20,128}$/u.test(token)) {
          state.lastError="Token 格式不正确，请仅复制 Sketchfab 设置中显示的 API token。";
          return reply(400,JSON.stringify({message:state.lastError}));
        }
        state.lastError="";state.running=true;state.message="批量下载进行中，可保持此页查看结果。";
        void run(token).catch(()=>{state.running=false;state.message="批次异常停止，已成功的文件保留。";});
        return reply(202,JSON.stringify({message:state.message}));
      }
      if(request.method==="GET" && url.pathname==="/batch/preview")return reply(200,'<div id="preview" style="width:600px;height:420px"></div>',"text/html; charset=utf-8");
      if(request.method==="GET") {
        const match=url.pathname.match(/^\/batch\/files\/([a-z0-9-]+)\.glb$/u);
        if(match) {
          if(!list.some(candidate=>candidate.id===match[1]))return reply(404,'{}');
          return reply(200,await readFile(path.join(output,`${match[1]}.glb`)),"model/gltf-binary");
        }
        const file=path.resolve(site,`.${decodeURIComponent(url.pathname)}`);
        if(!file.startsWith(`${site}${path.sep}`))return reply(403,'{}');
        const type={".js":"text/javascript; charset=utf-8",".json":"application/json",".glb":"model/gltf-binary"}[path.extname(file)];
        if(type)return reply(200,await readFile(file),type);
      }
      reply(404,'{"message":"Not found"}');
    } catch {reply(400,'{"message":"请求未完成。"}');}
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",resolve);});
  port=server.address().port;origin=`http://127.0.0.1:${port}`;
  return {server,state,origin,runOffline:()=>run(null,{offline:true})};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==="--offline") {
    const service=await startServer(0);
    try {await service.runOffline();console.log(JSON.stringify(service.state,null,2));}
    finally {await new Promise(resolve=>service.server.close(resolve));}
    if(service.state.items.some(item=>item.status==="failed"))process.exitCode=1;
  } else {
    const service=await startServer(Number(process.argv[2] || 54345));
    console.log(`Model batch import: ${service.origin}/`);
  }
}
