import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./data-update/builders/rail-gap-diagnosis.cjs",import.meta.url),"utf8");
const names=["平章南","逻山","津川","苍湖风景区"];
const graph={nodes:[{lat:0,lon:0},{lat:0,lon:0.001},{lat:0,lon:0.002},{lat:0,lon:0.003}],
  components:[0,0,1,1],nodeAdjacency:[[{to:1}],[{to:0}],[{to:3}],[{to:2}]],
  lines:[{id:1,routes:[{label:"source rail"}],geometry:[{lat:0,lon:0},{lat:0,lon:0.001}]}]};
const original={ways:[],coverage:{baselineVerification:{removed:[]}}};
for(const present of [names,names.slice(0,3),[],["改名后的车站"]]){
  const network={stops:present.map(name=>({name,lat:0,lon:0,routes:[{type:"train"}]}))};
  let built;
  const api={setRailwayData:data=>{built=data;},getRailInfrastructureGraph:()=>graph,
    railNodeCandidatesForStop:()=>[{nodeId:0,lineIndex:0,offset:0}],projectPointToTransitSegment:()=>({distance:0})};
  const exports={};const module={exports};
  const context=vm.createContext({module,exports,structuredClone,process:{argv:[]},console,
    require:Object.assign(name=>name==="node:fs"?{
      readdirSync:()=>[],existsSync:()=>false,readFileSync:()=>JSON.stringify({elements:[]}),
    }:name==="./js03-routing-diagnosis.cjs"?{api,network}:original,{main:{}})});
  vm.runInContext(source,context);
  assert.equal(module.exports.graph,graph,"the real full infrastructure graph must still be built");
  assert.deepEqual(built,original);
  assert.equal(module.exports.selected.length,names.filter(name=>present.includes(name)).length);
  assert.deepEqual(Array.from(module.exports.report.missingDiagnosticStations),names.filter(name=>!present.includes(name)));
  assert.equal(module.exports.candidates.length,4,"optional report samples cannot change gap candidates");
  assert.equal(module.exports.report.tracks,1);
}
console.log("Rail builder diagnostics passed: deleted, renamed or absent optional sample stations do not block all-region infrastructure updates or change gap inference.");
