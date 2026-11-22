import fs from "node:fs/promises";
import path from "node:path";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
const [input,output,tag,sourceSha]=process.argv.slice(2),repo=process.env.GITHUB_REPOSITORY;
if(!input||!output||!/^apps-v\d+\.\d+\.\d+-preview\.\d+$/u.test(tag||"")||!/^[a-f0-9]{40}$/u.test(sourceSha||"")||repo!=="1159312243h-gif/ogf-huayu_map")throw Error("Invalid application release scope");
const root=path.resolve(input),destination=path.resolve(output);
await fs.mkdir(destination,{recursive:true});
async function files(directory){const list=[];for(const item of await fs.readdir(directory,{withFileTypes:true})){const absolute=path.join(directory,item.name);if(item.isSymbolicLink())throw Error("Unexpected artifact link");if(item.isDirectory())list.push(...await files(absolute));else if(item.isFile())list.push(absolute);}return list;}
const artifacts=(await files(root)).filter(file=>/\.(?:exe|AppImage|deb|dmg|apk)$/u.test(file));
const items=[],names=new Set();
for(const file of artifacts){
 const original=path.basename(file),extension=path.extname(file),android=extension===".apk";
 if(!android&&!/^Huayu-Atlas-[a-zA-Z0-9._-]+$/u.test(original))throw Error("Unexpected application filename");
 if(android&&original!=="app-debug.apk")throw Error("Unexpected Android artifact");
 const filename=android?"Huayu-Atlas-9.0.0-android-test.apk":original;
 if(names.has(filename))throw Error("Repeated application artifact");names.add(filename);
 const platform=android?"android":extension===".exe"?"windows":extension===".dmg"?"macos":"linux";
 const arch=android?"通用":/(?:arm64|aarch64)/u.test(original)?"arm64":/(?:x64|x86_64|amd64)/u.test(original)?"x64":null;
 if(!arch)throw Error("Application architecture missing");
 const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);
 const sha256=hash.digest("hex"),size=(await fs.stat(file)).size;
 await fs.copyFile(file,path.join(destination,filename),fs.constants.COPYFILE_EXCL);
 items.push({platform,arch,label:({windows:"Windows",linux:"Linux",macos:"macOS",android:"Android"})[platform]+" "+arch+" · 测试版"+(extension===".deb"?"（Deb）":extension===".AppImage"?"（AppImage）":""),
  version:"9.0.0",bytes:size,sha256,url:"https://github.com/"+repo+"/releases/download/"+tag+"/"+filename,filename,signed:android,signing:android?"Android开发测试签名":"未签名／未公证",sourceSha});
}
for(const platform of ["windows","linux","android"])if(!items.some(item=>item.platform===platform))throw Error("Required application missing: "+platform);
const manifest={schema:"huayu-app-releases-v1",release:tag,sourceSha,generatedAt:new Date().toISOString(),items};
await fs.writeFile(path.join(destination,"app-releases.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
await fs.writeFile(path.join(destination,"SHA256SUMS.txt"),items.map(item=>item.sha256+"  "+item.filename).join("\n")+"\n",{flag:"wx"});
const notes="华域地图首批应用测试包\n\n应用共用线上地图、账号与共享资料，使用需要联网。iPhone、iPad本批使用Safari添加到主屏幕。\n\nWindows／Linux／macOS为未签名或未公证测试包；Android为开发测试签名，尚未完成各类实机验收或商店上架。请核对SHA256SUMS.txt。原生组件升级需新包，地图功能与数据沿用网站更新。\n\n构建来源："+sourceSha+"\n";
await fs.writeFile(path.join(destination,"RELEASE_NOTES.md"),notes,{flag:"wx"});
console.log(JSON.stringify(manifest,null,2));
