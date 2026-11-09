import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const source=await readFile(new URL("../site/traffic-simulation.js",import.meta.url),"utf8");
class Element{
  children=[];value="";hidden=false;open=true;
  set textContent(value){this.text=value;this.children=[];}
  get textContent(){return this.text||this.children.map(c=>c.textContent).join("");}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.text="";this.children=nodes;}
}
const boundary={osm_type:"relation",osm_id:1,name:"整市",geojson:{type:"Polygon",coordinates:[]}};
const point={osm_type:"node",osm_id:431549267,name:"合江市",display_name:"合江市, 汤海共和国",category:"place",type:"city",lon:"141.4226814",lat:"35.9421869"};
function context(){
  const jobs=[],events=[],locations=[],ui={};
  for(const key of ["cancel","regionStatus","regions","chosen","query","results"])ui[key]=new Element();
  const map={on(){},getBounds:()=>({getWest:()=>150,getSouth:()=>12,getEast:()=>151,getNorth:()=>13})};
  const c=vm.createContext({ui,enabled:true,map,regions:[boundary],generation:0,candidateGeneration:0,candidate:null,priorityWorker:null,
    latest:null,previous:null,selected:null,trip:null,worker:null,network:[],roadStates:new Map(),cachedRegion:null,
    regionProgress:"",searchGeneration:0,searching:false,root:{HuayuAtlas:{getTrafficContext:()=>({map,center:[150,12]}),
      prepareTrafficCamera:(...args)=>{locations.push(args);return true;}}},
    document:{createElement:()=>new Element()},stopFollowing(){},refreshUi(){},receive:e=>{c.latest=e.data;},
    ensureGraphics(){},sendViewport(){},scenario:()=>({}),isPaused:()=>false,rate:()=>1,count:()=>600,
    Worker:class{messages=[];terminated=false;constructor(){jobs.push(this);}postMessage(m){events.push(m.action);this.messages.push(m);}terminate(){this.terminated=true;}}
  });
  for(const name of ["cancelCandidate","buildRegions","renderRegions","searchRegions"]){
    const fn=source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`,"u"));
    // Some small helpers are written on a single line.
    vm.runInContext(name==="cancelCandidate"||name==="renderRegions"?source.split("\n").find(l=>l.startsWith(`  function ${name}(`)):fn[0],c);
  }
  return {c,jobs,events,locations,ui};
}
const full={data:{generation:1,regional:true,demand:{pairs:2},bounds:[150,12,151,13]}};
{
  const {c,jobs,events}=context();c.buildRegions();const [all,near]=jobs,latePreview=near.onmessage;
  assert.deepEqual(events.slice(0,2),["build-region","build-preview"],"full requests start before any preview reply");
  assert.equal(all.messages[0].previewPending,true);
  all.onmessage(full);assert.equal(c.worker,all);assert.ok(near.terminated);assert.ok(c.latest.regional);
  latePreview({data:{generation:1,preview:true,demand:{pairs:1}}});assert.equal(c.worker,all);assert.ok(c.latest.regional,"late preview cannot replace full city");
}
{
  const {c,jobs,ui}=context();c.buildRegions();const [all,near]=jobs;
  near.onmessage({data:{generation:1,preview:true,demand:{pairs:1}}});assert.equal(c.worker,near);
  assert.equal(all.messages.at(-1).action,"load-slots");
  all.onmessage({data:{error:"数据服务 HTTP 504"}});assert.ok(all.terminated);assert.equal(c.worker,near);assert.ok(c.latest.preview);
  assert.match(ui.regionStatus.textContent,/附近预览继续运行/);
  assert.match(ui.regionStatus.textContent,/HTTP 504/);
  c.buildRegions();assert.equal(jobs.length,3,"reuse an existing preview instead of launching a second one");
  assert.equal(jobs[2].messages[0].previewPending,false);
}
{
  const {c,jobs,ui}=context();c.buildRegions();jobs[0].onmessage({data:{error:"signal is aborted without reason"}});
  assert.match(ui.regionStatus.textContent,/请求中断或超时/u);assert.doesNotMatch(ui.regionStatus.textContent,/signal|aborted/u);
  assert.equal(c.worker,null);assert.ok(jobs.every(w=>w.terminated));
}
{
  const {c,jobs}=context();c.buildRegions();const [all,near]=jobs;
  near.onmessage({data:{previewUnavailable:true}});assert.ok(near.terminated);assert.equal(all.messages.at(-1).action,"load-slots");
  const late=all.onmessage;c.cancelCandidate();late(full);assert.equal(c.worker,null);assert.ok(all.terminated);
}
{
  const {c,jobs,ui}=context();c.buildRegions();
  jobs[0].onerror({message:"Failed to execute importScripts: network error"});
  assert.match(ui.regionStatus.textContent,/程序文件未能加载.*启动模拟程序.*本地预览.*网页服务/);
  assert.equal(c.worker,null);assert.ok(jobs.every(w=>w.terminated));assert.equal(ui.cancel.hidden,true);
}
{
  const {c,jobs,ui}=context();c.buildRegions();const [all,near]=jobs;
  near.onmessage({data:{generation:1,preview:true,demand:{pairs:1}}});
  all.onmessage({data:{progress:"全域建筑已就绪，正在准备人口"}});all.onerror({message:"Out of memory"});
  assert.match(ui.regionStatus.textContent,/可用内存不足.*全域建筑已就绪.*附近预览继续运行/);
  assert.ok(all.terminated);assert.equal(c.worker,near);assert.equal(near.terminated,false);
}
{
  const {c,jobs,ui}=context();c.buildRegions();jobs[0].onmessage(full);
  const running=c.worker;c.buildRegions();const next=jobs.at(-1);
  next.onmessage({data:{progress:"完整路网已就绪"}});next.onmessageerror({});
  assert.match(ui.regionStatus.textContent,/结果传输失败.*完整路网已就绪.*保留已有模拟/);
  assert.equal(c.worker,running);assert.equal(running.terminated,false);assert.ok(c.latest.regional);assert.ok(next.terminated);
}
{
  const {c,ui,locations}=context();let complete;
  c.root.HuayuAtlas.findAdministrativeCities=(_q,{onPlaces,exactNames})=>{assert.equal(exactNames,true,"simulation must request exact names instead of fuzzy boundary winners");onPlaces([point,{...point,osm_id:2,category:"railway",type:"station"}]);return new Promise(resolve=>{complete=resolve;});};
  ui.query.value="合江市";const pending=c.searchRegions();
  const button=ui.results.children[0];assert.match(button.textContent,/合江市.*定位城市点/);button.onclick();
  assert.equal(locations[0][0][0],141.4226814);assert.equal(locations[0][1],14);assert.equal(c.regions.length,1,"a point is never added as an administrative region");
  complete([]);await pending;assert.match(ui.results.textContent,/未查到完整行政边界/);
  const results=new Map();c.root.HuayuAtlas.findAdministrativeCities=(q,o)=>new Promise(resolve=>results.set(q,{resolve,onPlaces:o.onPlaces}));
  ui.query.value="旧";const old=c.searchRegions();ui.query.value="新";const fresh=c.searchRegions();
  results.get("新").resolve([{...boundary,osm_id:2,name:"新市"}]);await fresh;
  results.get("旧").onPlaces([point]);results.get("旧").resolve([]);await old;assert.equal(ui.results.children[0].textContent,"新市");
  ui.results.children[0].onclick();assert.equal(ui.results.children.length,0);
}
{
  const {c,ui}=context();ui.query.value="合江市";let searches=0;
  c.root.HuayuAtlas.findAdministrativeCities=async(_q,{onPlaces})=>{searches++;onPlaces([point]);throw Error("CITY_SEARCH_UNAVAILABLE");};
  await c.searchRegions();assert.match(ui.results.textContent,/合江市.*定位城市点/);assert.match(ui.results.textContent,/连接失败/);
  const retry=ui.results.children.find(n=>n.textContent==="重试查找");assert.ok(retry);retry.onclick();await new Promise(setImmediate);
  assert.equal(searches,2);assert.match(ui.results.textContent,/合江市.*定位城市点/);assert.equal(c.regions.length,1);
}
console.log("Traffic loading passed: immediate full-region start, bounded preview slots, atomic takeover, late/cancelled responses, international city-point location and honest boundary requirements.");
