import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../site/app-downloads.js",import.meta.url),"utf8");
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.ownText="";}
 set textContent(value){this.ownText=String(value);this.children=[];}
 get textContent(){return this.ownText+this.children.map(n=>n.textContent).join(" ");}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
}
async function render(data,failed=false){
 const target=new Element("div");
 await vm.runInNewContext(source,{document:{getElementById:()=>target,createElement:tag=>new Element(tag)},URL,
  fetch:async()=>{if(failed)throw Error("network");return {ok:true,json:async()=>data};}});
 return target;
}
const entry={label:"Windows x64 · 测试版",version:"9.0.0",bytes:1048576,sha256:"a".repeat(64),signing:"未签名",
 url:"https://github.com/1159312243h-gif/ogf-huayu_map/releases/download/apps-v9.0.0-preview.1/setup.exe"};
const valid=await render({schema:"huayu-app-releases-v1",items:[entry]});
assert.match(valid.textContent,/Windows x64/u);assert.match(valid.textContent,/1\.0 MiB/u);assert.match(valid.textContent,/未签名/u);
assert.equal(valid.children[0].children[2].tag,"details","长哈希放入可展开项");
const empty=await render({schema:"huayu-app-releases-v1",items:[]});assert.match(empty.textContent,/尚未发布/u);
const failed=await render(null,true);assert.match(failed.textContent,/暂时无法读取/u);assert.doesNotMatch(failed.textContent,/尚未发布/u);
for(const bad of [{url:"https://evil.example/setup.exe"},{url:"https://github.com/other/repo/releases/download/tag/setup.exe"},{sha256:"bad"},{bytes:0}]){
 const result=await render({schema:"huayu-app-releases-v1",items:[entry,{...entry,...bad}]});
 assert.match(result.textContent,/暂时无法读取/u);assert.doesNotMatch(result.textContent,/Windows x64/u,"损坏清单不交付部分成功列表");
}
console.log("App downloads passed: verified links, file sizes/signing, collapsed hashes, honest empty/failure states and complete-only rendering.");
\nconst shipped=JSON.parse(await readFile(new URL("../site/app-releases.json",import.meta.url),"utf8"));\nif(shipped.items.length){const actual=await render(shipped);assert.equal(actual.children.length,shipped.items.length);for(const item of shipped.items)assert.ok(actual.textContent.includes(item.label),"每个已发布安装包都应实际显示");}\n