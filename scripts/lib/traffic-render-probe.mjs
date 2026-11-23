import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as T from '../../site/three-0.160.1.module.min.js';
const surfacesContext=vm.createContext({});
vm.runInContext(await readFile(new URL('../../site/traffic-surfaces.js',import.meta.url),'utf8'),surfacesContext);
const surfaces=surfacesContext.HuayuTrafficSurfaces;
export function prepareTrafficRender(source,{count=600,selected=2,following=false,paused=false,surfaceRuntime=surfaces}={}){
 const match=source.match(/        render\(gl,args\) \{([^]*?)\n        \},\n        onRemove/u);if(!match)throw Error('Missing actual vehicle render handler');
 const origin=[0,0],radius=40075016.68557849,merc=p=>({x:(p[0]+180)/360,y:(180-180/Math.PI*Math.log(Math.tan(Math.PI/4+p[1]*Math.PI/360)))/360,meterInMercatorCoordinateUnits:()=>1/(radius*Math.cos(p[1]*Math.PI/180))});
 const plans=[{heights:[8,12],samples:[[-.01,0],[.01,0]].map(coordinate=>({coordinate,roadId:'elevated',width:12}))}],bridgeIndex=surfaceRuntime.index(plans);
 const vehicles=Array.from({length:1200},(_,i)=>({id:i+1,coordinate:[(i-600)*.0000001,0],angle:i%2?3.1:-3.1,roadId:i%17?'plain':'elevated',elevated:i%17===0,roadWidth:10,phase:i%83?'edge':'dwell',parked:i%166===0,tunnel:i%71===0,hiddenSample:i%97===0}));
 const previousVehicles=new Map(vehicles.map(c=>[c.id,{...c,coordinate:[c.coordinate[0]-.00000001,0],angle:-c.angle}]));
 const canvas={clientWidth:1100,clientHeight:760,getBoundingClientRect:()=>({left:0,top:0,width:1100,height:760})};
 const map={getZoom:()=>18,getBounds:()=>({contains:p=>Math.abs(p[0])<.001}),getCanvas:()=>canvas,getTerrain:()=>({source:'terrain'}),queryTerrainElevation:()=>4,project:()=>({x:500,y:350}),getBearing:()=>35};
 const box=new T.BoxGeometry(1,1,1),material=new T.MeshBasicMaterial(),parts=Array.from({length:3},()=>new T.InstancedMesh(box,material,1200));parts.forEach(p=>p.count=0);
 const graphics={T,scene:new T.Scene(),camera:new T.Camera(),parts,halo:{visible:false,position:new T.Vector3()},dummy:new T.Object3D(),color:new T.Color(),projection:new T.Matrix4(),transform:new T.Matrix4(),scaleVector:new T.Vector3(),clip:new T.Vector3(),renderer:{resetState(){},setViewport(){},render(){}}};
 const marker={hidden:true,style:{},offsetParent:{getBoundingClientRect:()=>({left:0,top:0})},querySelector:()=>({style:{}})};
 const context=vm.createContext({graphics,latest:{vehicles},previousVehicles,center:origin,mapInstance:map,map,document:{hidden:false},syncBridgeSurfaces(){},isPaused:()=>paused,received:50,performance:{now:()=>100},following,selected,count:()=>count,projected:[],ui:{marker,lanes:{checked:true},overlay:{checked:true}},carParts:[[4.2,1.75,.85,.65],[2.15,1.5,.65,1.38],[3.6,1.9,.35,.23]],colors:['#e5e0d5','#d2674f','#50869b','#e4b85c','#78847b','#9c8eaf'],bridgeIndex,root:{maplibregl:{MercatorCoordinate:{fromLngLat:merc}},HuayuTrafficSurfaces:surfaceRuntime,HuayuSunlight:{applyScene(){}}}});
 const actualParts=source.split('\n').find(line=>line.startsWith('  const carParts ='));if(actualParts)vm.runInContext(actualParts,context);
 const render=vm.runInContext('({render(gl,args){'+match[1]+'\n}}).render',context),gl={drawingBufferWidth:1100,drawingBufferHeight:760},matrix=new T.Matrix4().toArray();
 return {run(){render(gl,matrix);},capture(){const n=graphics.drawn;const matrices=parts.map(p=>Array.from(p.instanceMatrix.array.slice(0,n*16))),colors=Array.from(parts[0].instanceColor?.array.slice(0,n*3)||[]);
   const signature=createHash('sha256').update(JSON.stringify({matrices,colors})).digest('hex');
   const upload=attribute=>attribute.updateRanges.length?attribute.updateRanges.reduce((n,r)=>n+r.count,0):attribute.array.length;
   return {signature,drawn:n,drawnOthers:graphics.drawnOthers,drawnBridge:graphics.drawnBridge,projected:{count:context.projected.length,sha256:createHash('sha256').update(JSON.stringify(context.projected)).digest('hex')},halo:graphics.halo.visible,markerHidden:marker.hidden,uploadBytes:4*(parts.reduce((n,p)=>n+upload(p.instanceMatrix),0)+(parts[0].instanceColor?upload(parts[0].instanceColor):0))};
  },dispose(){parts.forEach(p=>p.dispose());box.dispose();material.dispose();}};
}
