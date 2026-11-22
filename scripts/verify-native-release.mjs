import {readFile,appendFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
const REPO="1159312243h-gif/ogf-huayu_map";
export function assertNativeRelease(manifest,release,ref,published=false){
 if(manifest.schema!=="huayu-app-releases-v1"||!/^apps-v\d+\.\d+\.\d+-preview\.\d+$/u.test(manifest.release)||!/^[a-f0-9]{40}$/u.test(manifest.sourceSha))throw Error("Invalid release scope");
 if(Boolean(release.draft)===published||!release.prerelease||release.tag_name!==manifest.release||release.target_commitish!==manifest.sourceSha)throw Error("Release phase or target commit mismatch");
 if(ref&&(ref.type!=="commit"||ref.sha!==manifest.sourceSha)||published&&!ref)throw Error("Release tag source mismatch");
 for(const item of manifest.items){
  const expected="https://github.com/"+REPO+"/releases/download/"+manifest.release+"/"+encodeURIComponent(item.filename);
  if(item.url!==expected)throw Error("Package URL scope mismatch");
  const matches=release.assets.filter(asset=>asset.name===item.filename);
  if(matches.length!==1||matches[0].size!==item.bytes||matches[0].digest!=="sha256:"+item.sha256
    ||published&&matches[0].browser_download_url!==item.url)throw Error("Uploaded package checksum or URL mismatch: "+item.filename);
 }
 for(const asset of release.assets.filter(item=>/\.(exe|apk|deb|dmg|AppImage)$/u.test(item.name)))
  if(!manifest.items.some(item=>item.filename===asset.name))throw Error("Unindexed application artifact");
 return {status:"passed",phase:published?"published":"draft",release:manifest.release,sourceSha:manifest.sourceSha,packages:manifest.items.length,remoteDigestsVerified:true,tagVerified:Boolean(ref)};
}
async function main(){
 const manifest=JSON.parse(await readFile(process.argv[2],"utf8")),token=process.env.GH_TOKEN;
 if(process.env.GITHUB_REPOSITORY!==REPO||!token)throw Error("Invalid verification credentials/scope");
 async function api(route,method="GET",body,missing=false){
  const response=await fetch("https://api.github.com/repos/"+REPO+route,{method,headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(30000)});
  if(missing&&response.status===404)return null;
  if(!response.ok)throw Error("Release verification HTTP "+response.status);
  return response.json();
 }
 let release=await api("/releases/tags/"+manifest.release,"GET",undefined,true);
 if(!release){const matches=(await api("/releases?per_page=100")).filter(item=>item.tag_name===manifest.release);
  if(matches.length>1)throw Error("Ambiguous release draft");release=matches[0]||null;}
 if(process.argv.includes("--probe")&&!release){if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,"exists=false\n");console.log("No previous draft");return;}
 if(!release)throw Error("Release draft not found");
 async function tag(){
  let ref=(await api("/git/ref/tags/"+manifest.release,"GET",undefined,true))?.object||null;
  for(let i=0;ref?.type==="tag"&&i<3;i++)ref=(await api("/git/tags/"+ref.sha)).object;
  return ref;
 }
 if(process.argv.includes("--published")){console.log(JSON.stringify(assertNativeRelease(manifest,release,await tag(),true)));return;}
 const before=assertNativeRelease(manifest,release,await tag(),false);
 if(process.argv.includes("--probe")&&process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,"exists=true\n");
 console.log(JSON.stringify(before));
 if(process.argv.includes("--publish")){
  // A draft has no public tag/asset URLs yet. Verify its exact target and bytes
  // first, then require the real published tag and URLs after GitHub creates them.
  release=await api("/releases/"+release.id,"PATCH",{draft:false});
  console.log(JSON.stringify(assertNativeRelease(manifest,release,await tag(),true)));
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
 await main();
