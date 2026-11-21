import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import terrain from './data-update/builders/build-terrain-preload.cjs';
const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
// Frozen published behavior is an independent oracle for indexed ring assembly.
const legacyFunctions=JSON.parse(await readFile(new URL('./fixtures/geometry-parser-legacy.json',import.meta.url),'utf8'));
const legacy=vm.createContext({}),current=vm.createContext({});
for(const [name,source] of Object.entries(legacyFunctions)){vm.runInContext(source,legacy);vm.runInContext(app.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}','u'))[0],current);}
const backend=await terrain.terrainRuntime(fileURLToPath(new URL('../site/',import.meta.url)));
const square=(x,y,size=1)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const compare=segments=>{const frozen=JSON.stringify(segments),expected=JSON.stringify(legacy.huayuWallJoinRings(segments));assert.equal(JSON.stringify(current.huayuWallJoinRings(segments)),expected);assert.equal(JSON.stringify(backend.huayuWallJoinRings(segments)),expected);assert.equal(JSON.stringify(segments),frozen);};
for(const segments of [[],[[]],[[[0,0],[1,0]]],[[[0,0],[1,0]],[[1,0],[1,1]],[[0,0],[1,1]]],
 [square(0,0),square(0,0).slice().reverse()],[[[0,0],[1,0]],[[1,0],[2,0]],[[1,0],[0,0]],[[2,0],[0,0]]],
 [[[0,0],[1,0]],[[1.00000001,0],[1,1]],[[1,1],[0,0]]]])compare(segments);
let seed=9;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
for(let run=0;run<80;run++){const pieces=[];for(let i=0;i<20;i++){const ring=square(i%5,Math.floor(i/5),.7);for(let j=1;j<ring.length;j++)pieces.push(random()<.5?[ring[j-1],ring[j]]:[ring[j],ring[j-1]]);}for(let i=pieces.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pieces[i],pieces[j]]=[pieces[j],pieces[i]];}compare(pieces);}
const members=[],ways=new Map();let id=0;const add=(ring,role)=>{const ref=++id;members.push({type:'way',ref,role});ways.set(String(ref),{geometry:ring.map(([lon,lat])=>({lon,lat}))});};
for(let i=0;i<72;i++){add(square(i%12*3,Math.floor(i/12)*3,2),'outer');add(square(i%12*3+.5,Math.floor(i/12)*3+.5,.5),'inner');}
add(square(.2,.2,.9),'outer');add(square(.3,.3,.1),'inner');add(square(100,100,.5),'inner');
const relation={members},expected=JSON.stringify(legacy.huayuCityWallRelationGeometry(relation,ways));for(const runtime of [current,backend])assert.equal(JSON.stringify(runtime.huayuCityWallRelationGeometry(relation,ways)),expected,'islands, nested outer rings, smallest containing polygon and outside holes keep their exact original order');
const count=180000,long=[[1,0],...Array.from({length:count},(_,i)=>[1-i/count,i/count]),[0,0]],pieces=[[[0,0],[1,0]],long];
for(const runtime of [current,backend]){const result=runtime.huayuWallJoinRings(pieces);assert.equal(result.length,1);assert.equal(result[0].length,count+3);assert.deepEqual(Array.from(result[0].at(-1)),[0,0]);}
console.log('Indexed geometry passed: frozen legacy coordinates/order/holes, ambiguous and rounded joins, randomized pieces, frontend/backend parity and 180000-point completeness.');

const overlapping={members:[]},overlapWays=new Map();for(let i=0;i<300;i++){overlapping.members.push({type:'way',ref:i,role:'outer'});overlapWays.set(String(i),{geometry:square(0,0,10).map(([lon,lat])=>({lon,lat}))});}overlapping.members.push({type:'way',ref:999,role:'inner'});overlapWays.set('999',{geometry:square(1,1,1).map(([lon,lat])=>({lon,lat}))});
const overlapExpected=JSON.stringify(legacy.huayuCityWallRelationGeometry(overlapping,overlapWays));for(const runtime of [current,backend])assert.equal(JSON.stringify(runtime.huayuCityWallRelationGeometry(overlapping,overlapWays)),overlapExpected,'overlapping large bounds must use a complete conservative fallback when the index budget is reached');
