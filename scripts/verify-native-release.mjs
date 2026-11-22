import {readFile} from "node:fs/promises";
const manifest=JSON.parse(await readFile(process.argv[2],"utf8")),repo=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN;
if(repo!=="1159312243h-gif/ogf-huayu_map"||!token||!/^apps-v\d+\.\d+\.\d+-preview\.\d+$/u.test(manifest.release)||!/^[a-f0-9]{40}$/u.test(manifest.sourceSha))throw Error("Invalid release verification scope");
async function get(route){const response=await fetch("https://api.github.com/repos/"+repo+route,{headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json"},redirect:"error",signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error("Release verification HTTP "+response.status);return response.json();}
const release=await get("/releases/tags/"+manifest.release);
if(!release.draft)throw Error("Expected a draft release before publication");
let ref=(await get("/git/ref/tags/"+manifest.release)).object;
for(let i=0;ref.type==="tag"&&i<3;i++)ref=(await get("/git/tags/"+ref.sha)).object;
if(ref.type!=="commit"||ref.sha!==manifest.sourceSha)throw Error("Release tag source mismatch");
for(const item of manifest.items){
 const matches=release.assets.filter(asset=>asset.name===item.filename);
 if(matches.length!==1||matches[0].size!==item.bytes||matches[0].digest!=="sha256:"+item.sha256||matches[0].browser_download_url!==item.url)throw Error("Uploaded package checksum mismatch: "+item.filename);
}
console.log(JSON.stringify({status:"passed",release:manifest.release,sourceSha:manifest.sourceSha,packages:manifest.items.length,remoteDigestsVerified:true}));
