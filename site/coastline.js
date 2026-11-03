(function (root) {
  "use strict";
  const VERSION = "coastline-land-sea-v2";
  const fail = () => { throw Error("海岸线不完整或方向、连接异常，请稍后重试；未采用不完整的截取范围"); };
  const signed = ring => ring.slice(1).reduce((sum,p,i) => sum
    +(ring[i][0]-ring[0][0])*(p[1]-ring[0][1])-(p[0]-ring[0][0])*(ring[i][1]-ring[0][1]),0)/2;
  function contains(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]) inside = !inside;
    }
    return inside;
  }
  function polygons(feature) {
    const geometry = feature?.geometry || feature;
    if (geometry?.type === "Polygon") return [geometry.coordinates];
    if (geometry?.type === "MultiPolygon") return geometry.coordinates;
    throw Error("需要完整的行政区多边形");
  }
  function bounds(features) {
    let west=Infinity, east=-Infinity, south=Infinity, north=-Infinity, count=0;
    for (const feature of features) for (const polygon of polygons(feature)) for (const ring of polygon) {
      if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) fail();
      for (const p of ring) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0])>180 || Math.abs(p[1])>85) fail();
        west=Math.min(west,p[0]);east=Math.max(east,p[0]);south=Math.min(south,p[1]);north=Math.max(north,p[1]);count++;
      }
    }
    if (!count || count>300000 || east-west>60 || north-south>60 || east<=west || north<=south) throw Error("沿海岸线截取范围过大或无效，请按行政区分批下载（跨度最多 60°）");
    const pad=0.00001;
    return {west:Math.max(-180,west-pad),east:Math.min(180,east+pad),south:Math.max(-85,south-pad),north:Math.min(85,north+pad)};
  }
  const rectangle = b => [[b.west,b.south],[b.east,b.south],[b.east,b.north],[b.west,b.north],[b.west,b.south]];
  // OGF coastlines are directed with land on the left. Clip directed segments,
  // then join only their real connections and counterclockwise frame arcs.
  function landGeometry(elements, b, seedLand) {
    const vertices=new Map(), edges=[], unique=new Set();
    const epsilon=1e-9;
    const snap = p => [Math.abs(p[0]-b.west)<epsilon?b.west:Math.abs(p[0]-b.east)<epsilon?b.east:p[0],
      Math.abs(p[1]-b.south)<epsilon?b.south:Math.abs(p[1]-b.north)<epsilon?b.north:p[1]];
    const key = p => p.map(n=>n.toFixed(9)).join(",");
    const vertex = p => {p=snap(p);const id=key(p);if(!vertices.has(id))vertices.set(id,{p,in:[],out:[]});return vertices.get(id);};
    const add = (a,c) => {
      if (key(a)===key(c)) return;
      const id=`${key(a)}>${key(c)}`;
      if(unique.has(id))fail();unique.add(id);
      const from=vertex(a),to=vertex(c),edge={from,to};from.out.push(edge);to.in.push(edge);edges.push(edge);
    };
    const clip = (a,c) => {
      let low=0,high=1;const dx=c[0]-a[0],dy=c[1]-a[1];
      for(const [p,q] of [[-dx,a[0]-b.west],[dx,b.east-a[0]],[-dy,a[1]-b.south],[dy,b.north-a[1]]]) {
        if(p===0) {if(q<0)return;continue;}
        const r=q/p;if(p<0)low=Math.max(low,r);else high=Math.min(high,r);if(low>=high)return;
      }
      add(snap([a[0]+low*dx,a[1]+low*dy]),snap([a[0]+high*dx,a[1]+high*dy]));
    };
    let nodes=0, enclosingSeed, enclosingArea=Infinity;
    for(const way of elements) {
      if(way.type!=="way" || way.tags?.natural!=="coastline" || !Array.isArray(way.geometry)
        || !Array.isArray(way.nodes) || way.nodes.length!==way.geometry.length || way.nodes.length<2)fail();
      nodes+=way.nodes.length;if(nodes>300000)throw Error("海岸线节点过多，请缩小范围");
      const points=way.geometry.map(p=>[p?.lon,p?.lat]);
      if(points.some(p=>!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90))fail();
      if (way.nodes[0]===way.nodes.at(-1) && contains([(b.west+b.east)/2,(b.south+b.north)/2],points)) {
        const a=signed(points);if(Math.abs(a)<enclosingArea){enclosingArea=Math.abs(a);enclosingSeed=a>0;}
      }
      for(let i=1;i<points.length;i++) {if(Math.abs(points[i][0]-points[i-1][0])>180)throw Error("跨日期变更线的范围请分开下载");clip(points[i-1],points[i]);}
    }
    const position = p => p[1]===b.south?(p[0]-b.west)/(b.east-b.west)
      :p[0]===b.east?1+(p[1]-b.south)/(b.north-b.south)
      :p[1]===b.north?2+(b.east-p[0])/(b.east-b.west)
      :p[0]===b.west?3+(b.north-p[1])/(b.north-b.south):null;
    const starts=[],ends=[];
    for(const v of vertices.values()) {
      if(v.in.length>1||v.out.length>1)fail();
      if(!v.in.length||!v.out.length) {
        const t=position(v.p);if(t===null)fail();
        (!v.in.length?starts:ends).push({v,t});
      }
    }
    if(starts.length!==ends.length)fail();
    const border=[...starts.map(p=>({...p,start:true})),...ends.map(p=>({...p,start:false}))].sort((a,c)=>a.t-c.t);
    const corners=rectangle(b);
    for(let i=0;i<border.length;i++) {
      const end=border[i];if(end.start)continue;
      const start=border[(i+1)%border.length];if(!start.start)fail();
      const stop=start.t+(start.t<=end.t?4:0);
      let previous=end.v.p;
      for(let t=Math.floor(end.t)+1;t<stop;t++) {const point=corners[t%4];add(previous,point);previous=point;}
      add(previous,start.v.p);
    }
    const rings=[],visited=new Set();
    for(const edge of edges) {
      if(visited.has(edge))continue;
      const ring=[edge.from.p];let current=edge;
      do {
        if(!current||visited.has(current))fail();
        visited.add(current);ring.push(current.to.p);
        current=current.to.out[0];
      } while(current!==edge);
      if(ring.length<4 || Math.abs(signed(ring))<1e-18)continue;
      rings.push(ring);
    }
    if(!rings.length) {
      if(typeof enclosingSeed==="boolean")seedLand=enclosingSeed;
      if(typeof seedLand!=="boolean")return null;
      return seedLand?[[rectangle(b)]]:[];
    }
    const positive=rings.filter(r=>signed(r)>0), negative=rings.filter(r=>signed(r)<0);
    // A top-level clockwise coast encloses sea in surrounding mainland.
    if(negative.some(r=>!positive.some(p=>contains(r[0],p))))positive.push(rectangle(b));
    const output=positive.map(r=>[r]);
    for(const hole of negative) {
      let owner=-1,area=Infinity;
      positive.forEach((ring,i)=>{const a=Math.abs(signed(ring));if(a<area&&contains(hole[0],ring)){owner=i;area=a;}});
      if(owner<0)fail();output[owner].push(hole);
    }
    return output;
  }
  function area(coordinates) {
    const ringArea = ring => {
      let sum=0;const rad=Math.PI/180;
      for(let i=1;i<ring.length;i++) sum+=(ring[i][0]-ring[i-1][0])*rad*(2+Math.sin(ring[i-1][1]*rad)+Math.sin(ring[i][1]*rad));
      return Math.abs(sum)*6371008.8**2/2;
    };
    return coordinates.reduce((total,rings)=>total+Math.max(0,ringArea(rings[0])-rings.slice(1).reduce((s,r)=>s+ringArea(r),0)),0);
  }
  function analyze(features, land, clipping=root.polygonClipping, part="land") {
    if(!clipping)throw Error("海岸线裁切组件未就绪");
    if(!["land","sea"].includes(part))throw Error("请选择陆地或海域截取范围");
    let vertices=0;
    const rows=features.map(feature=>{
      const original=polygons(feature),landCoordinates=land.length?clipping.intersection(original,land):[];
      const coordinates=part==="sea" ? (landCoordinates.length?clipping.difference(original,landCoordinates):clipping.union(original)) : landCoordinates;
      vertices+=coordinates.reduce((sum,rings)=>sum+rings.reduce((s,r)=>s+r.length,0),0);
      if(vertices>600000)throw Error("截取结果过大，请减少行政区或分批下载");
      const total=area(original),raw=area(landCoordinates);
      if(raw>total+Math.max(1,total*1e-6))fail();
      const landArea=Math.abs(total-raw)<=Math.max(.01,total*1e-12)?total:Math.min(total,raw),seaArea=Math.max(0,total-landArea);
      return {feature:{type:"Feature",properties:{...feature.properties,derived:`coastline-${part}-v1`,
        area_square_meters:part==="sea"?seaArea:landArea,total_m2:total,land_m2:landArea,sea_m2:seaArea},geometry:{type:"MultiPolygon",coordinates}},
        totalSquareMeters:total,landSquareMeters:landArea,seaSquareMeters:seaArea};
    });
    return rows;
  }
  root.HuayuCoastline={VERSION,bounds,landGeometry,analyze,area,polygons,contains};
})(typeof window!=="undefined"?window:globalThis);
