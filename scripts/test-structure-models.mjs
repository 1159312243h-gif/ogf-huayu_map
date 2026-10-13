import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {pavilionTagRuntime} from './test-pavilion-tags.mjs';

const context=vm.createContext({setTimeout,clearTimeout,console});
vm.runInContext(await readFile(new URL('../site/structure-models.js',import.meta.url),'utf8'),context);
const api=context.HuayuStructureModels,copy=value=>JSON.parse(JSON.stringify(value));
const polygon=(x=0,y=0,length=30,width=3,angle=0)=>{
  const point=([a,b])=>[x+(a*Math.cos(angle)-b*Math.sin(angle))/111320,y+(a*Math.sin(angle)+b*Math.cos(angle))/111320];
  return [[[-length/2,-width/2],[length/2,-width/2],[length/2,width/2],[-length/2,width/2],[-length/2,-width/2]].map(point)];
};
const area=(id,properties,coordinates=polygon())=>({type:'Feature',properties:{osmId:String(id),...properties},geometry:{type:'Polygon',coordinates}});
for(const angle of [0,0.25,0.8,1.6]) {
  const p=polygon(0,0,30,3,angle),fit=api.fitPolygon(p,true);assert.ok(fit);
  assert.ok(Math.abs(fit.length-30)<0.04 && Math.abs(fit.width-3)<0.005);
  assert.ok(api.rectangleInside(fit.corners,p),'All corners/edges stay in the real footprint.');
}
const hole=polygon(0,0,30,20).concat(polygon(0,0,2,2));
assert.equal(api.fitPolygon(hole),null,'A fitted rectangle may not fill an enclosed mapped hole.');
const raw=[{type:'way',id:1,tags:{building:'pavilion',height:'8',min_height:'2'},
  geometry:polygon(0,0,8,8)[0].map(([lon,lat])=>({lon,lat}))},
  {type:'way',id:2,tags:{building:'yes',name:'望月亭'},geometry:polygon(0.001,0,8,8)[0].map(([lon,lat])=>({lon,lat}))}];
const pavilions=copy(pavilionTagRuntime.huayuPavilionFeatureCollection(raw).features);
const inputs={pavilions,buildingPrimary:true,walls:[area(3,{renderKind:'extrusion',barrierKind:'fence',height:3}),
  area(4,{renderKind:'extrusion',barrierKind:'wall',height:4,minHeight:1})],
  cityWalls:[area(5,{renderKind:'extrusion',relationId:'5',height:10}),area(6,{renderKind:'extrusion',structureKind:'city-gate',height:10})],
  supplemental:[area(7,{busFacilityPart:'shelter-roof',buildingReplacement:1,height:3,minHeight:2.8,modelMinHeight:0}),
    area(8,{fountainArea:true,fountainModelEligible:true,fountainHeight:2.4}),
    {type:'Feature',properties:{osmType:'node',osmId:'9',kind:'fountain',fountainModelEligible:true},geometry:{type:'Point',coordinates:[0.0001,0]}},
    {type:'Feature',properties:{osmType:'node',osmId:'10',kind:'fountain',name:'喷泉广场'},geometry:{type:'Point',coordinates:[0,0]}}]};
const items=api.describe(inputs),at=id=>items.find(item=>item.key.endsWith(`:${id}`));
assert.equal(api.describe(inputs,new Set()).length,0,'Classic defaults never prepare replacement geometry.');
assert.deepEqual(copy(api.describe(inputs,new Set(['cityWall'])).map(item=>item.category)),['cityWall']);
assert.equal(at(1).pieces[0].base,2,'A tagged pavilion base is not its roof underside.');
assert.equal(at(2),undefined,'Name-only pavilions stay ordinary buildings.');
assert.equal(at(5).key,'relation:5');assert.equal(at(6),undefined,'City gates are not repeatable wall panels.');
assert.equal(at(7).pieces[0].base,0,'Shelter supports must reach the mapped ground base.');
assert.ok(at(8)&&at(9));assert.equal(at(10),undefined,'Named attractions do not become 3D fountains.');
assert.equal(api.describe({...inputs,buildingPrimary:false}).filter(item=>['pavilion','busShelter'].includes(item.category)).length,0,
  'Do not duplicate buildings while the published owner is still active.');
const assets=new Map([...api.CATEGORIES].map(category=>[category,{triangles:1000}]));
const settings={zoom:19,pitch:50},planned=api.plan(items,assets,settings);
assert.equal(planned.keys.size,6);assert.ok(planned.count<256 && planned.triangles<400000);
assert.deepEqual(copy([...planned.keys].map(([category,keys])=>[category,[...keys]])),
  copy([...api.plan(items.slice().reverse(),assets,settings).keys].map(([category,keys])=>[category,[...keys]])));
assert.equal(api.plan(items,assets,{...settings,satellite:true}).count,0);
assert.equal(api.plan(items,assets,{zoom:10,pitch:50}).count,0);
assert.ok(!api.plan(items,assets,{zoom:19,pitch:0}).keys.has('cityWall'));
assert.equal(api.plan(items,new Map([['pavilion',{triangles:20001}]]),settings).count,0);
const huge=[{category:'cityWall',key:'way:huge',pieces:Array(90).fill(at(5).pieces[0])}];
assert.equal(api.plan(huge,new Map([['cityWall',{triangles:5000}]]),settings).count,0,
  'A wall must fall back as a whole when it cannot be replaced within the batch budget.');
assert.equal(api.plan([at(3)],assets,{...settings,bounds:{west:-0.00001,east:0.00001,south:-0.00001,north:0.00001}}).count,at(3).pieces.length,
  'A line crossing the view cannot be dropped just because its midpoint is outside.');
const filters=new Map([['city',['==','renderKind','extrusion']]]),listeners=new Map();
const map={on(event,fn){listeners.set(event,fn);},off(event){listeners.delete(event);},getLayer:id=>id==='city',getFilter:id=>filters.get(id),
  setFilter:(id,value)=>filters.set(id,value),triggerRepaint(){}};
const controller=api.sync(map,{}, {layers:{cityWall:['city']}});clearTimeout(controller.timer);controller.timer=null;
controller.current={keys:new Map([['cityWall',new Set(['relation:5'])]])};controller.refreshFilters();
assert.ok(JSON.stringify(filters.get('city')).includes('relation:5'));
const replacement=['==',['get','renderKind'],'extrusion'];filters.set('city',replacement);controller.refreshFilters();
controller.current={keys:new Map()};controller.refreshFilters();assert.deepEqual(filters.get('city'),replacement,'Restore the latest owner filter.');
const T=await import('../site/three-0.160.1.module.min.js');
context.maplibregl={MercatorCoordinate:{fromLngLat:([x,y])=>({x:x*111320,y:-y*111320,meterInMercatorCoordinateUnits:()=>1})}};
map.getTerrain=()=>({source:'existing-height-field'});
map.queryTerrainElevation=([x,y])=>x*111320*0.2+y*111320*0.1;
const mesh=new T.InstancedMesh(new T.BoxGeometry(),new T.MeshBasicMaterial(),1),matrix=new T.Matrix4();
controller.T=T;controller.origin={x:0,y:0};controller.scale=1;
controller.meshes=[{mesh,batch:[at(4).pieces[0]],asset:{size:[5,1,1],record:{category:'wall'}}}];
controller.position();mesh.getMatrixAt(0,matrix);
for(const side of [-0.5,0.5]) {
  const bottom=new T.Vector3(side,0,0).applyMatrix4(matrix),top=new T.Vector3(side,0,1).applyMatrix4(matrix);
  assert.ok(Math.abs(bottom.z-(bottom.x*0.2+bottom.y*0.1+1))<1e-5,'Both ends stay at the terrain plus tagged base.');
  assert.ok(Math.abs(top.z-bottom.z-3)<1e-5,'Following a slope preserves tagged vertical height.');
}
map.getStyle=()=>undefined;
map.getLayer=()=>{throw new Error('Removed MapLibre styles cannot answer getLayer.');};
assert.doesNotThrow(()=>api.dispose(map));assert.equal(listeners.size,0);
console.log('Structure models passed: typed elements, exact footprints/holes, real bases, system ownership, whole-feature fallback, crossing walls, deterministic budgets and cleanup.');
