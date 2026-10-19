import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {pavilionTagRuntime as runtime} from "./test-pavilion-tags.mjs";
import {roofShapeCases,roofShapeElements} from "./fixtures/roof-shapes.mjs";
const copy=value=>JSON.parse(JSON.stringify(value));
const context=vm.createContext({setTimeout,clearTimeout});
vm.runInContext(await readFile(new URL("../site/building-roofs.js",import.meta.url),"utf8"),context);
const api=context.HuayuBuildingRoofs,data=runtime.huayuLiveBuildingFeatureCollection(roofShapeElements);
assert.deepEqual([...api.SUPPORTED].sort(),roofShapeCases.map(([key])=>key).sort());
const original=JSON.stringify(data),stats=[];
for(let i=0;i<roofShapeCases.length;i++) {
  const [shape]=roofShapeCases[i],f=data.features[i],p=f.properties,triangles=api.roofTriangles(f);
  assert.equal(runtime.huayuRoofShape({"roof:shape":shape}),shape);
  assert.equal(p.roofShape,shape);
  if(shape==="flat"){assert.equal(p.roofModel,undefined);assert.equal(p.renderHeight,15);assert.equal(triangles.length,0);continue;}
  assert.equal(p.roofModel,1,shape);assert.equal(p.roofBaseHeight,9);assert.equal(p.roofTopHeight,15);
  assert.ok(triangles.length>0 && triangles.length<=1536,shape);
  const ring=api.polygons(f)[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
  for(const t of triangles)for(const point of t.points) {
    assert.ok(point.every(Number.isFinite) && point[2]>=9-1e-9 && point[2]<=15+1e-9,shape);
    assert.ok(point[0]>=Math.min(...xs)-1e-10 && point[0]<=Math.max(...xs)+1e-10
      && point[1]>=Math.min(...ys)-1e-10 && point[1]<=Math.max(...ys)+1e-10,`${shape} preserves the source footprint`);
    let sign=0;
    for(let k=0;k<ring.length;k++) {
      const a=ring[k],b=ring[(k+1)%ring.length],cross=(b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]);
      if(Math.abs(cross)<1e-14)continue;
      assert.ok(!sign || Math.sign(cross)===sign,`${shape} does not bulge outside a convex source outline`);sign=Math.sign(cross);
    }
  }
  // Rewinding or changing the first source node must not rotate an asymmetric roof.
  const signature=ts=>ts.map(t=>t.kind+":"+t.points.map(p=>p.map(n=>n.toFixed(9)).join(",")).sort().join(";")).sort();
  const reversed=copy(f);reversed.geometry.coordinates[0].reverse();
  if(!["cone","dome","onion","pyramidal"].includes(shape))
    assert.deepEqual(signature(api.roofTriangles(reversed)),signature(triangles),`${shape} winding-independent geometry`);
  stats.push({shape,roof:triangles.filter(t=>t.kind==="roof").length,wall:triangles.filter(t=>t.kind==="wall").length});
}
assert.equal(JSON.stringify(data),original,"roof meshing never rewrites source footprints or metadata");
const byShape=shape=>data.features.find(f=>f.properties.roofShape===shape);
const triangleHeights=(triangles,x,y)=>{
  const result=[];
  for(const {kind,points:[a,b,c]}of triangles) {
    if(kind!=="roof")continue;
    const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(d)<1e-16)continue;
    const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/d;
    const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/d,w=1-u-v;
    if(Math.min(u,v,w)>=-1e-8)result.push(u*a[2]+v*b[2]+w*c[2]);
  }
  return [...new Set(result.map(h=>Number(h.toFixed(7))))].sort((a,b)=>a-b);
};
const triangleHeight=(triangles,x,y,shape="roof")=>{
  const result=triangleHeights(triangles,x,y);
  assert.ok(result.length,`${shape} covers every interior sample at ${x}, ${y}`);
  // Onion roofs have an intentional overhang: its underside and bulb can both
  // intersect a vertical ray. All other styles must remain a single surface.
  if(shape!=="onion")assert.ok(result.at(-1)-result[0]<1e-5,`${shape} patches do not overlap at different heights at ${x}, ${y}: ${result}`);
  return result.at(-1);
};
for(const f of data.features.filter(f=>f.properties.roofModel===1)) {
  const ring=api.polygons(f)[0],center=ring.reduce((s,p)=>[s[0]+p[0]/ring.length,s[1]+p[1]/ring.length],[0,0]);
  const tris=api.roofTriangles(f);
  for(const point of ring)for(const r of [.17,.43,.71,.93])
    triangleHeight(tris,center[0]+(point[0]-center[0])*r,center[1]+(point[1]-center[1])*r,f.properties.roofShape);
}
const onion=byShape("onion"),onionRing=api.polygons(onion)[0],onionTris=api.roofTriangles(onion);
const onionCenter=onionRing.reduce((s,p)=>[s[0]+p[0]/onionRing.length,s[1]+p[1]/onionRing.length],[0,0]);
const bulbRay=triangleHeights(onionTris,...onionCenter.map((v,k)=>v+(onionRing[0][k]-v)*.71));
assert.equal(bulbRay.length,3,"onion overhang has one eaves underside, one lower bulb and one upper bulb surface");
assert.equal(bulbRay[0],9);assert.ok(bulbRay[1]>9 && bulbRay[2]>12);
assert.equal(triangleHeight(onionTris,...onionCenter,"onion"),15,"the onion tip reaches its tagged total height");
assert.equal(stats.find(s=>s.shape==="hipped").wall,0);
assert.ok(stats.find(s=>s.shape==="half-hipped").wall>0,"half hips retain lower gable walls");
assert.ok(stats.find(s=>s.shape==="side_hipped").wall>0,"one hip retains the opposite gable");
assert.ok(stats.find(s=>s.shape==="mansard").roof>stats.find(s=>s.shape==="hipped").roof);
for(const [a,b]of [["gabled","gabled_height_moved"],["gabled","gambrel"],["gabled","round"],["hipped","half-hipped"]]) {
  const heightProfile=shape=>{
    const f=byShape(shape),ring=api.orientedRing(api.polygons(f)[0],f.properties),tris=api.roofTriangles(f);
    return [.1,.3,.53,.7,.9].map(v=>{
      const a=ring[0].map((n,k)=>(n+ring[1][k])/2),b=ring[2].map((n,k)=>(n+ring[3][k])/2);
      return triangleHeight(tris,a[0]+(b[0]-a[0])*v,a[1]+(b[1]-a[1])*v).toFixed(4);
    });
  };
  if(b!=="half-hipped")assert.notDeepEqual(heightProfile(a),heightProfile(b),`${a} and ${b} have distinct profiles`);
}
const moved=byShape("gabled_height_moved"),movedRing=api.orientedRing(api.polygons(moved)[0],moved.properties);
const movedCenter=movedRing.reduce((s,p)=>[s[0]+p[0]/4,s[1]+p[1]/4],[0,0]);
assert.deepEqual(triangleHeights(api.roofTriangles(moved),...movedCenter),[13.2,15],
  "height-moved gables have two ridge levels joined by a vertical wall, rather than just an off-centre ridge");
const slope=copy(byShape("skillion")),center=slope.geometry.coordinates[0].slice(0,4).reduce((s,p)=>[s[0]+p[0]/4,s[1]+p[1]/4],[0,0]);
for(const [first,second,point]of [[0,180,[center[0],center[1]+.00005]],[90,270,[center[0]+.0001,center[1]]]]) {
  slope.properties.roofDirection=first;const a=triangleHeight(api.roofTriangles(slope),...point);
  slope.properties.roofDirection=second;const b=triangleHeight(api.roofTriangles(slope),...point);
  assert.ok(Math.abs(a-b)>2,"opposite slope directions exchange the high and low edges");
}
for(const direction of [undefined,null,"",false,"garbage"]) {
  slope.properties.roofDirection=direction;
  assert.deepEqual(copy(api.roofTriangles(slope)),copy(api.roofTriangles({...slope,properties:{...slope.properties,roofDirection:undefined}})));
}
for(const value of ["90garbage","eastish","NaN",""])assert.equal(runtime.huayuRoofDirection({"roof:direction":value}),null);
assert.equal(runtime.huayuRoofDirection({"roof:direction":0}),0);
const source=roofShapeElements[1],make=tags=>runtime.huayuLiveBuildingFeatureCollection([{...source,tags:{...source.tags,height:"40","roof:height":undefined,"roof:angle":"45",...tags}}]).features[0];
const ridgeAxis=f=>{
  const top=api.roofTriangles(f).flatMap(t=>t.points).filter(p=>p[2]===f.properties.roofTopHeight);
  const [a,b]=[...new Map(top.map(p=>[p.join(","),p])).values()];
  assert.ok(a && b,"gabled roofs have two distinct ridge endpoints");
  return Math.abs(a[0]-b[0])>Math.abs(a[1]-b[1])?"long":"short";
};
assert.equal(ridgeAxis(make({"roof:orientation":"along"})),"long");
assert.equal(ridgeAxis(make({"roof:orientation":"across"})),"short");
assert.equal(ridgeAxis(make({})),"long","untagged orientation defaults to the long-edge ridge");
assert.equal(ridgeAxis(make({"roof:orientation":"across","roof:direction":"N"})),"long",
  "a valid numeric/compass direction takes precedence over orientation");
assert.ok(make({"roof:orientation":" across "}).properties.roofHeight>make({"roof:orientation":"along"}).properties.roofHeight*1.9,
  "angle-based height follows the chosen cross-span instead of always using the short edge");
const redundant=copy(source);redundant.geometry.splice(1,0,{lon:(source.geometry[0].lon+source.geometry[1].lon)/2,lat:source.geometry[0].lat});
const redundantModel=runtime.huayuLiveBuildingFeatureCollection([redundant]).features[0];
assert.equal(api.roofTriangles(redundantModel).length,6,"collinear source nodes cannot leave a shortened building without a roof");
assert.equal(redundantModel.geometry.coordinates[0].length,6,"the complete original outline remains unchanged");
const star=Array.from({length:5},(_,i)=>[Math.cos(i*4*Math.PI/5)*.001,Math.sin(i*4*Math.PI/5)*.001]);star.push(star[0]);
assert.equal(runtime.huayuRoofSimpleRing(star,64),null);assert.equal(api.simpleRing(star,64),null);
for(const f of data.features)for(const limit of [4,64]) {
  const ring=f.geometry.coordinates[0];
  assert.deepEqual(copy(api.simpleRing(ring,limit)),copy(runtime.huayuRoofSimpleRing(ring,limit)),
    `${f.properties.roofShape}: parsing and rendering must accept exactly the same outlines`);
}
const crowded={features:Array.from({length:180},(_,i)=>{
  const f=copy(byShape("dome"));f.id=`dome-${i}`;f.properties.osmId=String(50000+i);return f;
})};
const selected=api.describe(crowded),total=selected.reduce((sum,item)=>sum+item.triangles.length,0);
assert.ok(total<=120000 && selected.length<crowded.features.length,"dense curved roofs respect a whole-building mesh budget");
vm.runInContext(await readFile(new URL("../site/sunlight-shadows.js",import.meta.url),"utf8"),context);
const shadows=context.HuayuSunShadows.prepare(data);
for(let i=0;i<data.features.length;i++) {
  const f=data.features[i],roof=api.roofTriangles(f),shadow=shadows[i];
  assert.equal(shadow.eaves,f.properties.roofModel===1?9:15,`${f.properties.roofShape}: matching shadow eaves`);
  assert.equal(shadow.roof.length,roof.length,`${f.properties.roofShape}: exact rendered mesh drives the shadow`);
}
const crowdedShadows=context.HuayuSunShadows.prepare(crowded);
assert.ok(crowdedShadows.slice(0,selected.length).every(item=>item.roof.length>0));
assert.ok(crowdedShadows.slice(selected.length).every(item=>item.roof.length===0 && item.eaves===15),
  "buildings excluded by the whole-mesh budget cast their intact native flat silhouette");
console.log(JSON.stringify({status:"passed",shapes:roofShapeCases.length,stats,directions:"four signed compass directions",denseTriangles:total}));
