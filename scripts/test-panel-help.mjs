import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/map-agent-contract.js";
import "../site/map-agent-tools.js";
const html=await readFile(new URL("../site/index.html",import.meta.url),"utf8");
const source=await readFile(new URL("../site/map-help.js",import.meta.url),"utf8");
const ids=[...html.matchAll(/\bid="([^"]+)"/gu)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length,"页面不能重复 ID");
for(const [,references] of html.matchAll(/aria-describedby="([^"]+)"/gu))for(const id of references.split(" "))assert.ok(ids.includes(id),"描述关联丢失："+id);
const formIds=["dataset-title","dataset-file","dataset-date","dataset-source","dataset-license","dataset-scope-label"];
for(const id of formIds)assert.match(html,new RegExp('<input[^>]*id="'+id+'"[^>]*required|<input[^>]*required[^>]*id="'+id+'"'),"必填要求保留："+id);
const operations=html.slice(0,html.indexOf('<section id="help-view"'));
assert.ok(!/<(?:input|textarea)[^>]*placeholder="[^"]*津川/u.test(operations),"日常占位示例使用通用文字");
assert.ok(operations.indexOf('id="line-template-preview"')<operations.indexOf('id="line-template-through-controls"'),"模板预览先于高级参数");
assert.match(operations,/id="dataset-timetable-note"[^>]*hidden/u);
assert.match(operations,/默认每日开行、UTC\+08:00/u);
assert.match(operations,/未校准情景，非实测路况/u);
assert.match(operations,/密钥仅本页暂存/u);

// Execute the real help controller with a small DOM supporting native node moves.
let document;
class Node {
  constructor(tag="div",attrs={}){this.tagName=tag;this.attrs=attrs;this.id=attrs.id||"";this.dataset=Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith("data-")).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));this.children=[];this.parentNode=null;this.hidden="hidden" in attrs;this.open="open" in attrs;this.value="";this.listeners=new Map();this.ownText="";}
  get textContent(){return this.ownText+this.children.map(n=>n.textContent).join(" ");}
  set textContent(v){this.ownText=v;this.children=[];}
  get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
  get isConnected(){return Boolean(this.parentNode);}
  append(n){this.insertBefore(n,null);}
  insertBefore(n,before){if(n.parentNode)n.parentNode.children.splice(n.parentNode.children.indexOf(n),1);n.parentNode=this;const i=before?this.children.indexOf(before):this.children.length;assert.ok(i>=0);this.children.splice(i,0,n);}
  matches(s){return s.startsWith(".")?(this.attrs.class||"").split(" ").includes(s.slice(1)):s.startsWith("[")?s.slice(1,-1) in this.attrs:this.tagName===s;}
  querySelectorAll(s){return this.children.flatMap(n=>[...(n.matches(s)?[n]:[]),...n.querySelectorAll(s)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  closest(s){return this.matches(s)?this:this.parentNode?.closest(s);}
  addEventListener(t,fn){if(!this.listeners.has(t))this.listeners.set(t,[]);this.listeners.get(t).push(fn);}
  emit(t,event={}){for(const fn of this.listeners.get(t)||[])fn(event);}
  focus(){document.activeElement=this;}
  scrollIntoView(){this.scrolled=true;}
  showModal(){this.open=true;}
  close(){this.open=false;this.emit("close");}
}
const root=new Node(),stack=[root],byId=new Map(),voids=new Set(["input","img","br","hr","link","meta","source","wbr"]);
for(const m of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/giu)){
  if(!m[1]){if(m[3])stack.at(-1).ownText+=m[3];continue;}
  const tag=m[1].toLowerCase();if(m[0].startsWith("</")){while(stack.length>1){if(stack.pop().tagName===tag)break;}continue;}
  const attrs=Object.fromEntries([...m[2].matchAll(/([a-z_:][a-z0-9_:.-]*)(?:="([^"]*)")?/giu)].map(a=>[a[1],a[2]??""]));
  const node=new Node(tag,attrs);stack.at(-1).append(node);if(node.id)byId.set(node.id,node);if(!voids.has(tag)&&!m[0].endsWith("/>"))stack.push(node);
}
document=new Node();document.getElementById=id=>byId.get(id)||null;document.createComment=()=>new Node("#comment");document.activeElement=null;
const window=new Node(),sandbox={document,window,Error,Object,String,Map,Set};vm.runInNewContext(source,sandbox);
const help=window.HuayuMapHelp,view=byId.get("help-view"),dialog=byId.get("help-dialog"),search=byId.get("help-search");
const topics=view.querySelectorAll("[data-help-section]");
assert.equal(topics.length,14);assert.equal(help.topics().length,14);
for(const node of root.querySelectorAll("[data-help-target]"))assert.ok(topics.some(t=>t.id===node.dataset.helpTarget),"帮助入口必须对应真实主题");
const originalParent=view.parentNode,field=byId.get("dataset-title"),trigger=root.querySelectorAll("[data-help-target]").find(n=>n.dataset.helpTarget==="help-datasets");
field.value="未发布草稿";trigger.focus();
assert.equal(help.open("help-datasets",trigger).contextual,true);
assert.equal(dialog.open,true);assert.equal(view.hidden,false);assert.equal(view.parentNode.id,"help-dialog-content");
assert.equal(field.value,"未发布草稿");
const dataset=byId.get("help-datasets");assert.equal(dataset.open,true);assert.equal(document.activeElement.tagName,"summary");
const step=dataset.querySelector(".help-step");step.open=true;
search.value="UTC+08:00";search.emit("input");
assert.equal(byId.get("help-timetables").hidden,false);assert.ok(byId.get("help-timetables").querySelectorAll(".help-step").some(n=>n.open));
assert.equal(byId.get("help-personal").hidden,true);
search.value="不存在的帮助词";search.emit("input");assert.equal(byId.get("help-no-results").hidden,false);
byId.get("help-search-clear").emit("click");assert.equal(search.value,"");assert.equal(step.open,true,"清空后恢复小节展开状态");
let intercepted=false;search.value="车次";search.focus();
window.emit("keydown",{key:"Escape",preventDefault(){},stopImmediatePropagation(){intercepted=true;}});
assert.equal(intercepted,true);assert.equal(search.value,"");assert.equal(dialog.open,true);
window.emit("keydown",{key:"Escape",preventDefault(){},stopImmediatePropagation(){}});
assert.equal(dialog.open,false);assert.equal(view.parentNode,originalParent);assert.equal(view.hidden,true);assert.equal(field.value,"未发布草稿");assert.equal(document.activeElement,trigger);
help.open("help-simulation",trigger);
document.emit("click",{target:new Node("button",{"data-action":"simulation"})});
assert.equal(dialog.open,false,"前往既有功能先关闭帮助");
view.hidden=false;
assert.equal(help.open("help-map").contextual,false,"独立帮助页目录无需再开窗口");
assert.throws(()=>help.open("missing"),/主题/);
view.hidden=true;
globalThis.HuayuMapHelp=help;
const runtime=globalThis.HuayuAgentTools.create({atlas:{}});
const opened=await runtime.execute("open_help",{topic:"help-brands"});assert.equal(opened.status,"opened");assert.equal(dialog.open,true);help.close();
const stopped=new AbortController();stopped.abort();
await assert.rejects(runtime.execute("open_help",{topic:"help-map"},{signal:stopped.signal}),{name:"AbortError"});
assert.equal(dialog.open,false);
assert.throws(()=>globalThis.HuayuAgentContract.argumentsFor("open_help",{topic:"missing"}));
const contractTopics=globalThis.HuayuAgentContract.tools.find(t=>t.name==="open_help").parameters.properties.topic.enum;
assert.deepEqual([...contractTopics].sort(),topics.map(t=>t.id).sort());
delete globalThis.HuayuMapHelp;
console.log("面板与帮助检查通过：14主题、链接、必填控件、搜索／展开、返回草稿与焦点、Esc隔离和助手实际处理器。");
