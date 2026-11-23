import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
class Element{
 constructor(){this.children=[];this.value="";this.textContent="";this.dataset={};this.elements=[];this.classList={contains:()=>false,toggle(){},add(){},remove(){}};}
 addEventListener(){}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}reset(){this.resets=(this.resets||0)+1;}querySelectorAll(){return [];}focus(){}scrollIntoView(){}
 get childElementCount(){return this.children.length;}
}
const tick=()=>new Promise(r=>setImmediate(r));
for(const kind of ["dataset","feature-info"]){
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 let revision=1,fail=false,reads=0;
 const root={HuayuPersonalData:{getCurrentUser:()=>null},HuayuDatasetTools:{KINDS:{other:"其他"}},addEventListener(){},dispatchEvent(){}};
 root.HuayuAtlas={getCurrentView:()=>"none",getSelectedFeature:()=>({type:"node",id:1,label:"selected"}),map:{on(){}},openView(){},refreshIcons(){}};
 const doc={getElementById:get,createElement:()=>new Element(),addEventListener(){}};
 const payload=()=>kind==="dataset"?{items:[{id:1,title:"共享包版本"+revision,kind:"other",scope:{label:"范围"},stats:{rows:2},author:{id:2,displayName:"作者"},observedDate:"2026-11-23"}],nextCursor:null}:{items:[{id:1,title:"投稿版本"+revision,author:{id:2,username:"author",displayName:"作者"},createdAt:0,revision:1,properties:[]}],total:1,nextCursor:null};
 const context={window:root,document:doc,location:{search:""},URLSearchParams,URL,AbortController,AbortSignal,Map,Set,Date,Object,Error,DOMException,setTimeout,clearTimeout,fetch:async(url,options)=>{reads++;assert.equal(options.cache,"no-store");if(fail)throw Error("network");return {ok:true,json:async()=>payload()};}};
 const name=kind==="dataset"?"shared-datasets.js":"feature-info.js";
 vm.runInNewContext(await readFile(new URL("../site/"+name,import.meta.url),"utf8"),context);
 const client=kind==="dataset"?root.HuayuSharedDatasets:root.HuayuFeatureInfo;client.setActive(true);await tick();assert.equal(reads,1);
 get(kind+"-title").value="未发布草稿";client.setActive(false);revision=2;client.setActive(true);await tick();assert.equal(reads,2,"重新打开已读面板必须核对新发布内容");
 const list=get(kind==="dataset"?"dataset-list":"feature-info-list"),text=()=>list.children[0]?.children[0]?.textContent;
 assert.ok(text().endsWith("2"));assert.equal(get(kind+"-title").value,"未发布草稿","重新读取不得清除已有草稿");
 client.setActive(false);fail=true;client.setActive(true);await tick();assert.ok(text().endsWith("2"),"读取失败保留上次完整列表");
 client.setActive(false);const before=reads;await tick();assert.equal(reads,before,"收起不额外读取");
}
console.log("Shared panel refresh passed: reopen fetches newer public data, API no-store, original draft retention, failure keeps complete list and hidden panels do not read.");
