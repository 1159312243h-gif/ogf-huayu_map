import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import worker from "../site/_worker.js";
import "../site/map-agent-providers.js";
import "../site/map-agent-contract.js";
import "../site/map-agent-tools.js";
const source=await readFile(new URL("../site/map-agent.js",import.meta.url),"utf8"),html=await readFile(new URL("../site/index.html",import.meta.url),"utf8");
class El{
  constructor(){this.value="";this.children=[];this.hidden=false;this.listeners={};this.textContent="";}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  get firstElementChild(){return this.children[0];}
  remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}
  addEventListener(name,fn){this.listeners[name]=fn;}
  querySelector(){return this.option||(this.option=new El());}
}
const nodes=new Map([...html.matchAll(/id="(agent-[^"]+)"/gu)].map(m=>[m[1],new El()]));
const $=id=>nodes.get("agent-"+id),events={},storage=new Map(),mapActions=[],seen=[];
const document={getElementById:id=>nodes.get(id),createElement:()=>new El(),addEventListener(){}};
const root={HuayuAtlas:{openAgentPanel:panel=>mapActions.push(panel),openView(){}},HuayuAgentProviders:globalThis.HuayuAgentProviders,HuayuAgentContract:globalThis.HuayuAgentContract,HuayuAgentTools:globalThis.HuayuAgentTools,addEventListener(name,fn){events[name]=fn;}};
const previousFetch=globalThis.fetch;
let mode="map",modelCalls=0,modelsCancelled=false;
globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith("https://api.deepseek.com/"));
  if(options.method==="GET"){
    if(mode==="cancel-models")return new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>{modelsCancelled=true;reject(new DOMException("cancel","AbortError"));},{once:true}));
    return Response.json({data:[{id:"deepseek-flash"},{id:"deepseek-v4-pro"}]});
  }
  const b=JSON.parse(options.body);seen.push(b);modelCalls++;
  if(mode==="text"){assert.equal(b.tools,undefined);return Response.json({choices:[{message:{content:"仅对话回答"}}]});}
  if(modelCalls===1)return Response.json({choices:[{message:{content:null,reasoning_content:"first thought",tool_calls:[{id:"open_search",type:"function",function:{name:"open_panel",arguments:'{"panel":"search"}'}}]}}]});
  const assistants=b.messages.filter(m=>m.role==="assistant");
  assert.equal(assistants.length,modelCalls-1,"only provider assistant turns may enter history");
  assert.equal(assistants[0].reasoning_content,"first thought");assert.equal(b.messages.find(m=>m.role==="tool").tool_call_id,"open_search");
  if(modelCalls===3)assert.equal(assistants[1].reasoning_content,"final thought","non-tool reasoning is replayed on the next turn");
  return Response.json({choices:[{message:{content:"模型原始回答",reasoning_content:"final thought"}}]});
};
async function clientFetch(path,options={}){
  return worker.fetch(new Request("https://atlas.test"+path,{method:options.method||"GET",headers:{Origin:"https://atlas.test",...options.headers},...(options.body?{body:options.body}:{}),signal:options.signal}),{},{});
}
try{
  const context={...root,document,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{search:""},URLSearchParams,AbortController,AbortSignal,DOMException,fetch:clientFetch,console,DataTransfer:class{}};
  vm.runInNewContext(source,context);await new Promise(setImmediate);
  $("provider").value="deepseek";$("provider").onchange();
  assert.equal($("base-url").value,"https://api.deepseek.com");
  $("api-key").value="client-only-secret";$("model").value="deepseek-flash";$("remember").checked=true;
  $("connection-form").onsubmit({preventDefault(){}});
  assert.equal($("send").disabled,false);
  assert.ok([...storage.values()].every(v=>!v.includes("client-only-secret")));
  $("input").value="打开搜索";await $("form").onsubmit({preventDefault(){}});
  assert.deepEqual(mapActions,["search"]);
  $("input").value="继续";await $("form").onsubmit({preventDefault(){}});
  $("input").value="再继续";await $("form").onsubmit({preventDefault(){}});
  assert.equal(seen.length,3);assert.equal(mapActions.length,1);
  $("models-read").onclick();await new Promise(setImmediate);
  assert.deepEqual($("models").children.map(o=>o.value),["deepseek-flash","deepseek-v4-pro"]);
  mode="text";$("tool-mode").value="text";$("tool-mode").oninput({target:{id:"agent-tool-mode"}});
  $("connection-form").onsubmit({preventDefault(){}});
  $("input").value="你好";await $("form").onsubmit({preventDefault(){}});
  assert.equal(mapActions.length,1,"text-only never executes a map action");
  assert.match($("service").textContent,/仅对话/u);
  mode="cancel-models";const pending=$("models-read").onclick();await new Promise(setImmediate);
  context.HuayuMapAgent.reset();await pending;
  assert.equal(modelsCancelled,true);assert.deepEqual($("models").children.map(o=>o.value),["deepseek-flash","deepseek-v4-pro"]);
  events["huayu:account-changed"]();
  assert.equal($("api-key").value,"");assert.equal($("models").children.length,0);
  assert.ok([...storage.values()].every(v=>!v.includes("client-only-secret")));
}finally{globalThis.fetch=previousFetch;}
console.log("Actual agent client passed: official preset, model list, handoff and non-tool reasoning across turns, text-only no-map behavior, cancellation, credential-free preferences and account cleanup.");
