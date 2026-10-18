(function(root) {
  "use strict";
  const SOURCE="ogf-atlas-facility-details",LAYER="ogf-atlas-ferris-wheels",controllers=new WeakMap();
  const EMPTY=Object.freeze([]);
  // This factory is also executed in the geometry worker. No map or DOM state.
  function createFacilityGeometry() {
    const polygons=g=>g?.type==="Polygon" ? [g.coordinates] : g?.type==="MultiPolygon" ? g.coordinates : [];
    const value=v=>String(v || "").trim().toLowerCase();
    const measure=(v,fallback)=>{
      const match=String(v ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|')?$/i);
      const n=match && Number(match[1])*(/^(ft|')$/i.test(match[2] || "") ? 0.3048 : 1);
      return n>0 && n<=1000 ? n : fallback;
    };
    function kind(tags={}) {
      if(["yes","1","true"].includes(value(tags.disused)) || ["yes","1","true"].includes(value(tags.abandoned))
        || tags.construction || tags.proposed)return "";
      if(["big_wheel","ferris_wheel"].includes(value(tags.attraction)) || value(tags.man_made)==="ferris_wheel")return "ferris-wheel";
      if(value(tags.amenity)==="parking")return "parking";
      if(value(tags.amenity)==="toilets")return "toilet";
      if((value(tags.shop) && !["no","vacant","closed","disused","abandoned"].includes(value(tags.shop)))
        || ["cafe","fast_food","ice_cream","restaurant"].includes(value(tags.amenity)))return "kiosk";
      return "";
    }
    function inRing(p,ring) {
      let inside=false;
      for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
        const a=ring[i],b=ring[j];
        if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      }
      return inside;
    }
    const inside=(p,poly)=>inRing(p,poly[0]) && !poly.slice(1).some(r=>inRing(p,r));
    function fits(corners,poly) {
      if(!corners.every(p=>inside(p,poly)) || poly.slice(1).some(r=>inRing(r[0],[...corners,corners[0]])))return false;
      const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      return !poly.some(r=>r.slice(1).some((d,i)=>corners.some((a,j)=>{
        const b=corners[(j+1)%4],c=r[i];
        return cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0;
      })));
    }
    function frame(ring) {
      const origin=ring[0],sx=111320*Math.cos(origin[1]*Math.PI/180);
      const xy=ring.map(p=>[(p[0]-origin[0])*sx,(p[1]-origin[1])*111320]);
      let length=0,angle=0;
      for(let i=1;i<xy.length;i++) {
        const dx=xy[i][0]-xy[i-1][0],dy=xy[i][1]-xy[i-1][1],n=Math.hypot(dx,dy);
        if(n>length){length=n;angle=Math.atan2(dy,dx);}
      }
      const cos=Math.cos(angle),sin=Math.sin(angle),rot=xy.map(([x,y])=>[x*cos+y*sin,-x*sin+y*cos]);
      return {angle,lo:[Math.min(...rot.map(p=>p[0])),Math.min(...rot.map(p=>p[1]))],
        hi:[Math.max(...rot.map(p=>p[0])),Math.max(...rot.map(p=>p[1]))],
        project:([x,y])=>[origin[0]+(x*cos-y*sin)/sx,origin[1]+(x*sin+y*cos)/111320]};
    }
    function center(geometry) {
      if(geometry?.type==="Point")return geometry.coordinates;
      if(geometry?.type==="LineString") {
        const points=geometry.coordinates;
        return points.length>=2 ? points[0].map((v,i)=>(v+points.at(-1)[i])/2) : null;
      }
      let best=null,area=0;
      for(const poly of polygons(geometry)) {
        const f=frame(poly[0]),size=(f.hi[0]-f.lo[0])*(f.hi[1]-f.lo[1]);
        if(size<=area)continue;
        for(let row=0;row<9;row++)for(let col=0;col<9;col++) {
          const x=(col+0.5)/9,y=(row+0.5)/9,p=f.project([f.lo[0]+x*(f.hi[0]-f.lo[0]),f.lo[1]+y*(f.hi[1]-f.lo[1])]);
          if(inside(p,poly) && (!best || size>area || Math.hypot(x-.5,y-.5)<best.distance)) {
            best={point:p,distance:Math.hypot(x-.5,y-.5)};area=size;
          }
        }
      }
      return best?.point || null;
    }
    function wheel(feature) {
      const t=feature.properties,point=center(feature.geometry);if(!point)return null;
      const base=measure(t.min_height,0),height=measure(t.height,base+36);
      if(height<=base+2)return null;
      const poly=polygons(feature.geometry).find(p=>inside(point,p)),line=feature.geometry.type==="LineString" ? feature.geometry.coordinates : null;
      let angle=poly || line ? frame(poly?.[0] || line).angle : 0;
      const direction=String(t.direction ?? "").trim();
      if(direction!=="" && Number.isFinite(Number(direction)))angle=Math.PI/2-Number(direction)*Math.PI/180;
      let diameter=measure(t.diameter,(height-base)*0.86);
      if(poly){const f=frame(poly[0]);diameter=Math.min(diameter,Math.max(f.hi[0]-f.lo[0],f.hi[1]-f.lo[1]));}
      if(line){const f=frame(line);diameter=Math.min(diameter,Math.max(f.hi[0]-f.lo[0],f.hi[1]-f.lo[1]));}
      diameter=Math.min(diameter,(height-base)*0.9);
      if(poly) {
        const sx=111320*Math.cos(point[1]*Math.PI/180),cos=Math.cos(angle),sin=Math.sin(angle);
        let fitted=false;
        for(let attempt=0;attempt<24 && diameter>=2;attempt++,diameter*=.85) {
          const r=diameter/2,size=Math.max(.6,Math.min(2.6,r*.11)),thickness=Math.max(1.5,r*.14);
          const x=r+Math.max(size/2,r*.018),y=thickness*1.5+Math.max(.14,r*.018);
          const corners=[[-x,-y],[x,-y],[x,y],[-x,y]].map(([u,v])=>[point[0]+(u*cos-v*sin)/sx,point[1]+(u*sin+v*cos)/111320]);
          if(fits(corners,poly)){fitted=true;break;}
        }
        if(!fitted)return null;
      }
      if(diameter<2)return null;
      return {key:feature.id,center:point,base,height,diameter,angle,estimated:!t.height || !t.diameter};
    }
    function smallFacilities(features,context={}) {
      if(!context.coverage?.length)return [];
      const cells=new Map(),global=[],result=[],occupied=[],seen=new Set();
      const bounds=geometry=>{
        const points=geometry.type==="Point" ? [geometry.coordinates] : geometry.type==="LineString" ? geometry.coordinates
          : geometry.type==="MultiLineString" ? geometry.coordinates.flat() : polygons(geometry).flat(2);
        const b={west:Infinity,east:-Infinity,south:Infinity,north:-Infinity};
        for(const p of points){b.west=Math.min(b.west,p[0]);b.east=Math.max(b.east,p[0]);b.south=Math.min(b.south,p[1]);b.north=Math.max(b.north,p[1]);}return b;
      };
      // Spatial index contains only loaded buildings, facility areas and ground obstacles.
      const obstacles=[...(context.obstacles || []),...features.filter(f=>["toilet","kiosk"].includes(kind(f.properties)) && polygons(f.geometry).length)];
      for(const feature of obstacles) {
        if(!feature.geometry)continue;
        const b=bounds(feature.geometry),p=feature.properties || {};
        const padding=polygons(feature.geometry).length ? 0 : measure(p.width,0)/2 || 4;
        const padX=padding/(111320*Math.max(.1,Math.cos((b.south+b.north)/2*Math.PI/180))),padY=padding/111320;
        const item={feature,b},x0=Math.floor((b.west-padX)/.001),x1=Math.floor((b.east+padX)/.001),y0=Math.floor((b.south-padY)/.001),y1=Math.floor((b.north+padY)/.001);
        if(!Number.isFinite(x0))continue;
        if((x1-x0+1)*(y1-y0+1)>256){global.push(item);continue;}
        for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
          const key=`${x}/${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(item);
        }
      }
      const distance=(p,a,b)=>{
        const sx=111320*Math.cos(p[1]*Math.PI/180),ax=(a[0]-p[0])*sx,ay=(a[1]-p[1])*111320,
          dx=(b[0]-a[0])*sx,dy=(b[1]-a[1])*111320,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy || 1)));
        return Math.hypot(ax+dx*t,ay+dy*t);
      };
      const touches=(a,b,c,d)=>{
        const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
        return Math.max(a[0],b[0])>=Math.min(c[0],d[0]) && Math.max(c[0],d[0])>=Math.min(a[0],b[0])
          && Math.max(a[1],b[1])>=Math.min(c[1],d[1]) && Math.max(c[1],d[1])>=Math.min(a[1],b[1])
          && cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0;
      };
      const edgeDistance=(a,b,c,d)=>touches(a,b,c,d) ? 0
        : Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b));
      const overlaps=(corners,poly)=>{
        const rectangle=[...corners,corners[0]];
        return corners.some(c=>inside(c,poly)) || poly.some(r=>r.some(c=>inRing(c,rectangle))
          || r.slice(1).some((d,i)=>corners.some((a,j)=>touches(a,corners[(j+1)%4],r[i],d))));
      };
      for(const f of features.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)))) {
        if(result.length>=128)break;
        const t=f.properties || {},type=kind(t),point=f.geometry?.coordinates;
        if(!["toilet","kiosk"].includes(type) || f.geometry?.type!=="Point" || t.osmType && t.osmType!=="node"
          || !Array.isArray(point) || !point.every(Number.isFinite) || seen.has(f.id))continue;
        seen.add(f.id);
        const active=v=>value(v) && !["no","false","0"].includes(value(v));
        if(active(t.building) || active(t["building:part"]) || active(t.indoor)
          || ["indoor","underground","roof","rooftop"].includes(value(t.location))
          || active(t.tunnel) || value(t.layer) && Number(t.layer)!==0 || value(t.level) && Number(t.level)!==0 || measure(t.min_height,0)>0)continue;
        const width=measure(t.width,type==="toilet" ? 4.8 : 3.2),depth=measure(t.length,type==="toilet" ? 3.2 : 2.8),height=measure(t.height,type==="toilet" ? 3.1 : 2.9);
        if(width<1 || depth<1 || width>20 || depth>20 || height<1.8 || height>20)continue;
        const rawDirection=String(t.direction ?? "").trim(),directed=rawDirection!=="" && Number.isFinite(Number(rawDirection));
        const sx=111320*Math.cos(point[1]*Math.PI/180),nearby=new Set(global);
        const cellX=Math.floor(point[0]/.001),cellY=Math.floor(point[1]/.001);
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const item of cells.get(`${cellX+dx}/${cellY+dy}`) || [])nearby.add(item);
        const reach=Math.hypot(width,depth)/2;
        const local=[...nearby].map(({feature,b})=>{
          const p=feature.properties || {},g=feature.geometry;
          return {b,polys:polygons(g),lines:g.type==="LineString" ? [g.coordinates] : g.type==="MultiLineString" ? g.coordinates : [],
            ignored:p.tunnel || Number(p.layer)<0,
            clearance:measure(p.width,0)/2 || (p.renderKind==="road" ? (/^(path|footway|steps|cycleway)$/.test(p.highway) ? 1 : 4) : p.renderKind==="railway" ? 2.5 : 2)};
        }).filter(item=>!item.ignored && point[0]>=item.b.west-(reach+item.clearance+.15)/sx
          && point[0]<=item.b.east+(reach+item.clearance+.15)/sx
          && point[1]>=item.b.south-(reach+item.clearance+.15)/111320
          && point[1]<=item.b.north+(reach+item.clearance+.15)/111320);
        // A fixed center inside a building, water or actual road width cannot fit at any size.
        if(local.some(item=>item.polys.some(poly=>inside(point,poly))
          || item.lines.some(line=>line.slice(1).some((b,i)=>distance(point,line[i],b)<=item.clearance+.15))))continue;
        const angles=directed ? [Math.PI-Number(rawDirection)*Math.PI/180] : [0,Math.PI/2];
        let nearest=Infinity,roadAngle;
        if(!directed)for(const {feature} of nearby) {
          if(feature.properties?.renderKind!=="road" || feature.geometry.type!=="LineString")continue;
          const line=feature.geometry.coordinates;
          for(let i=1;i<line.length;i++) {
            const n=distance(point,line[i-1],line[i]);
            if(n<nearest && n<30){nearest=n;roadAngle=Math.atan2((line[i][1]-line[i-1][1])*111320,(line[i][0]-line[i-1][0])*sx);}
          }
        }
        if(Number.isFinite(roadAngle))angles.push(roadAngle);
        const fixedWidth=Number.isFinite(measure(t.width,NaN)),fixedDepth=Number.isFinite(measure(t.length,NaN));
        let placement;
        for(const scale of fixedWidth && fixedDepth ? [1] : [1,.85,.7,.6,.5]) {
          const w=fixedWidth ? width : width*scale,d=fixedDepth ? depth : depth*scale;
          if(!fixedWidth && w<(type==="toilet" ? 2.4 : 1.6) || !fixedDepth && d<(type==="toilet" ? 1.6 : 1.4))continue;
          for(const angle of angles) {
            const cos=Math.cos(angle),sin=Math.sin(angle);
            const corners=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]]
              .map(([x,y])=>[point[0]+(x*cos-y*sin)/sx,point[1]+(x*sin+y*cos)/111320]);
            if(!corners.every(p=>context.coverage.some(b=>p[0]>=b.west && p[0]<=b.east && p[1]>=b.south && p[1]<=b.north)))continue;
            const rectangle=[...corners,corners[0]];
            const blocked=local.some(({polys,lines,clearance,b})=>{
              const radius=Math.hypot(w,d)/2;
              if(point[0]<b.west-(radius+clearance+.15)/sx || point[0]>b.east+(radius+clearance+.15)/sx
                || point[1]<b.south-(radius+clearance+.15)/111320 || point[1]>b.north+(radius+clearance+.15)/111320)return false;
              if(polys.length)return polys.some(poly=>overlaps(corners,poly));
              return lines.some(line=>line.slice(1).some((b,i)=>inRing(b,rectangle) || inRing(line[i],rectangle)
                || corners.some((a,j)=>edgeDistance(a,corners[(j+1)%4],line[i],b)<=clearance+.15)));
            });
            if(blocked || occupied.some(other=>overlaps(corners,[other]) || other.slice(1).some((b,i)=>
              corners.some((a,j)=>edgeDistance(a,corners[(j+1)%4],other[i],b)<=.2))))continue;
            placement={width:w,depth:d,angle,corners};break;
          }
          if(placement)break;
        }
        if(!placement)continue;
        occupied.push([...placement.corners,placement.corners[0]]);
        result.push({key:f.id,type,center:point,width:placement.width,depth:placement.depth,height,base:0,angle:placement.angle,estimated:!fixedWidth || !fixedDepth || !t.height,
          colors:{wall:t.facilityWallColor || "",wallNight:t.facilityWallNightColor || "",roof:t.facilityRoofColor || "",roofNight:t.facilityRoofNightColor || ""}});
      }
      return result;
    }
    function build(features,context) {
      const result=[],wheels=[],seen=new Set();let remaining=2048,spaces=0,areas=0;
      const aisles=features.filter(f=>f.properties?.service==="parking_aisle" && f.geometry?.type==="LineString");
      const aisleNear=point=>aisles.some(f=>f.geometry.coordinates.slice(1).some((b,i)=>{
        const a=f.geometry.coordinates[i],sx=111320*Math.cos(point[1]*Math.PI/180);
        const ax=(a[0]-point[0])*sx,ay=(a[1]-point[1])*111320,dx=(b[0]-a[0])*sx,dy=(b[1]-a[1])*111320;
        const ratio=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy || 1)));
        return Math.hypot(ax+dx*ratio,ay+dy*ratio)<3.5;
      }));
      for(const feature of features.slice(0,2048).sort((a,b)=>String(a.id).localeCompare(String(b.id)))) {
        if(seen.has(feature.id))continue;seen.add(feature.id);
        const t=feature.properties || {},type=kind(t);
        if(type==="ferris-wheel"){const item=wheel(feature);if(item && wheels.length<16)wheels.push(item);continue;}
        if(type!=="parking")continue;
        const point=center(feature.geometry);if(!point)continue;
        const parking=value(t.parking),underground=parking==="underground" || value(t.location)==="underground";
        const garage=Boolean(["multi-storey","multistorey","rooftop","garage_boxes","carports","sheds"].includes(parking)
          || t.building && !["no","false","0"].includes(value(t.building)) || t["building:part"] && value(t["building:part"])!=="no");
        const surface=!underground && !garage && !["yes","1","true"].includes(value(t.covered))
          && !["roof","rooftop"].includes(value(t.location)) && !(Number(t.layer)>0) && !(Number(t.min_height)>0);
        const p={facilityPart:"parking-label",name:t.name || "",underground,garage,schematic:true};
        result.push({type:"Feature",id:`${feature.id}:label`,properties:p,geometry:{type:"Point",coordinates:point}});
        if(!surface || !polygons(feature.geometry).length || areas++>=64)continue;
        result.push({...feature,id:`${feature.id}:outline`,properties:{...p,surface:value(t.surface),facilityPart:"parking-outline"}});
        let count=0;
        for(const poly of polygons(feature.geometry)) {
          const f=frame(poly[0]);
          const width=f.hi[0]-f.lo[0]-1.2,depth=f.hi[1]-f.lo[1]-1.2;
          const capacity=/^\d+$/.test(String(t.capacity ?? "").trim()) ? Number(t.capacity) : NaN;
          const limit=Number.isInteger(capacity) && capacity>=0 ? Math.min(128,capacity) : 128;
          // Narrow roadside lots use parallel bays; paired perpendicular rows open toward a 6 m aisle.
          const parallel=depth<11,bayWidth=parallel ? 6 : 2.6,bayDepth=parallel ? 2.25 : 5,rows=[];
          if(width<bayWidth || depth<bayDepth || count>=limit)continue;
          let used=0;
          if(parallel){rows.push({y:0,reverse:false});used=bayDepth;}
          else {
            while(used+16<=depth && rows.length<80){rows.push({y:used,reverse:false},{y:used+11,reverse:true});used+=16.6;}
            if(rows.length)used-=.6;
            const gap=rows.length ? .6 : 0;
            if(used+gap+11<=depth){rows.push({y:used+gap,reverse:false});used+=gap+11;}
          }
          const columns=Math.min(Math.floor(width/bayWidth),Math.ceil((limit-count)/rows.length));
          const startX=(f.lo[0]+f.hi[0]-columns*bayWidth)/2,startY=(f.lo[1]+f.hi[1]-used)/2;
          for(const row of rows) {
            for(let col=0;col<columns && count<limit && remaining>0;col++) {
              // Neighboring bays share the same painted separator instead of two parallel strokes.
              const x=startX+col*bayWidth,low=startY+row.y,high=low+bayDepth;
              const corners=[[x,low],[x+bayWidth,low],[x+bayWidth,high],[x,high]].map(f.project);
              // Keep the complete stall inside, including concavities and holes.
              const probes=corners.concat(corners.map((a,i)=>a.map((n,k)=>(n+corners[(i+1)%4][k])/2)));
              if(!probes.every(p=>inside(p,poly) && !aisleNear(p)) || poly.slice(1).some(r=>inRing(r[0],[...corners,corners[0]])))continue;
              const crosses=(a,b,c,d)=>{
                const cross=(u,v,w)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);
                return cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0;
              };
              if(poly.some(r=>r.slice(1).some((b,i)=>corners.some((a,j)=>crosses(a,corners[(j+1)%4],r[i],b)))))continue;
              result.push({type:"Feature",id:`${feature.id}:stall:${spaces++}`,
                properties:{...p,facilityPart:"parking-space",parkingLayout:parallel ? "parallel" : "perpendicular"},
                geometry:{type:"LineString",coordinates:row.reverse ? [corners[0],corners[3],corners[2],corners[1]] : [corners[3],corners[0],corners[1],corners[2]]}});
              count++;remaining--;
            }
          }
        }
      }
      return {data:{type:"FeatureCollection",features:result},wheels,spaces,small:smallFacilities(features,context)};
    }
    return {kind,build,inside,wheel,smallFacilities};
  }
  const geometry=createFacilityGeometry();
  class Controller {
    constructor(map,options) {
      this.map=map;this.options=options;this.alive=true;this.features=EMPTY;this.revision=0;
      this.onTerrain=event=>{if(!event?.sourceId || event.sourceId===map.getTerrain?.()?.source)this.schedule();};
      this.onMove=()=>this.schedule();
      map.on("terrain",this.onTerrain);map.on("sourcedata",this.onTerrain);map.on("moveend",this.onMove);
      this.unbind=options.observeGestures?.(()=>{this.interacting=true;},()=>{this.interacting=false;this.schedule();});
    }
    update(features,options) {
      const contextChanged=this.options.context!==options.context;
      this.options=options;
      if(contextChanged || this.features!==features && (this.features.length || features.length || !this.prepared)){
        this.features=features;this.dirty=true;this.revision++;
      }
      if(contextChanged && !this.interacting)this.position();
      this.schedule();
    }
    schedule() {
      if(!this.alive || this.timer || this.interacting)return;
      this.timer=root.setTimeout(()=>{this.timer=null;if(this.alive && !this.interacting)void this.apply();},80);
    }
    async prepare() {
      const features=this.features,context=this.options.context;
      if(this.workerUnavailable || !root.Worker || !root.Blob || !root.URL?.createObjectURL)return geometry.build(features,context);
      if(!this.worker) {
        const blob=new root.Blob([`const geometry=(${createFacilityGeometry.toString()})();onmessage=event=>{try{postMessage({id:event.data.id,result:geometry.build(event.data.features,event.data.context)})}catch(error){postMessage({id:event.data.id,error:String(error)})}};`],{type:"text/javascript"});
        const url=root.URL.createObjectURL(blob);
        try {this.worker=new root.Worker(url);}catch{this.workerUnavailable=true;return geometry.build(features,context);}
        finally{root.URL.revokeObjectURL(url);}
        this.pending=new Map();
        this.worker.onmessage=event=>{const task=this.pending.get(event.data.id);if(!task)return;
          this.pending.delete(event.data.id);root.clearTimeout(task.timer);event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.result);};
        this.worker.onerror=()=>{this.workerUnavailable=true;this.stopWorker();};
      }
      try{return await new Promise((resolve,reject)=>{
        const id=this.revision,timer=root.setTimeout(()=>{this.pending.delete(id);reject(new Error("facility geometry timeout"));},15000);
        this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,features,context});
      });}catch(error){if(this.workerUnavailable && this.alive)return geometry.build(features,context);throw error;}
    }
    ensureLayers() {
      const map=this.map;if(!map.getSource(SOURCE))map.addSource(SOURCE,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
      const before=map.getStyle().layers.find(l=>["fill-extrusion","symbol","circle"].includes(l.type))?.id;
      const fill=`${SOURCE}-surface`;
      const fillColor=this.options.night ? "#303a3d" : ["match",["get","surface"],
        ["grass","grass_paver"],"#bcc9ae",["gravel","unpaved","ground","dirt"],"#d5cdbb",
        ["asphalt"],"#b7c1c2","#c6cecb"];
      if(!map.getLayer(fill))map.addLayer({id:fill,type:"fill",source:SOURCE,minzoom:15.25,
        filter:["==",["get","facilityPart"],"parking-outline"],paint:{"fill-color":fillColor}},before);
      if(JSON.stringify(map.getPaintProperty(fill,"fill-color"))!==JSON.stringify(fillColor))map.setPaintProperty(fill,"fill-color",fillColor);
      for(const [suffix,part,color,width,opacity] of [
        ["outline","parking-outline",this.options.night ? "#56676c" : "#a5b2af",
          ["interpolate",["linear"],["zoom"],16,.35,19,.65,22,1],.75],
        ["spaces","parking-space",this.options.night ? "#91a4a8" : "#f4f5ee",
          ["interpolate",["exponential",2],["zoom"],16,.12,20,1.25,22,3.5],
          ["interpolate",["linear"],["zoom"],16,0,17,.4,18,.8,19,.95]]]) {
        const id=`${SOURCE}-${suffix}`;
        if(!map.getLayer(id))map.addLayer({id,type:"line",source:SOURCE,minzoom:16,
          filter:["==",["get","facilityPart"],part],layout:{"line-cap":"butt","line-join":"round"},
          paint:{"line-color":color,"line-width":width,"line-opacity":opacity}},before);
        for(const [key,next] of [["line-color",color],["line-width",width],["line-opacity",opacity]])
          if(JSON.stringify(map.getPaintProperty(id,key))!==JSON.stringify(next))map.setPaintProperty(id,key,next);
      }
      const id=`${SOURCE}-labels`;
      if(!map.getLayer(id))map.addLayer({id,type:"symbol",source:SOURCE,minzoom:15.25,
        filter:["==",["get","facilityPart"],"parking-label"],layout:{"text-field":"P","text-font":["Noto Sans Regular"],
          "text-size":["interpolate",["linear"],["zoom"],15.25,11,19,14],"text-padding":5},
        paint:{"text-color":this.options.night ? "#93b1bd" : "#587b8c","text-halo-color":this.options.night ? "#273236" : "#edf1ed","text-halo-width":1}});
      for(const [name,color] of [["text-color",this.options.night ? "#93b1bd" : "#587b8c"],
        ["text-halo-color",this.options.night ? "#273236" : "#edf1ed"]]) {
        if(map.getPaintProperty(id,name)!==color)map.setPaintProperty(id,name,color);
      }
    }
    async apply() {
      const map=this.map;if(!this.alive || !map.getStyle?.()?.layers?.length || this.interacting)return;
      if(this.dirty && !this.preparing && this.failedRevision!==this.revision) {
        const revision=this.revision,features=this.features,context=this.options.context;this.preparing=true;
        try {const result=await this.prepare();if(!this.alive || revision!==this.revision)return;
          const sameModels=this.prepared && JSON.stringify([result.wheels,result.small])===JSON.stringify([this.prepared.wheels,this.prepared.small]);
          if(sameModels){result.wheels=this.prepared.wheels;result.small=this.prepared.small;}
          if(this.prepared && this.preparedFeatures===features)result.data=this.prepared.data;
          this.prepared=result;this.preparedFeatures=features;this.preparedContext=context;
          this.dirty=false;this.meshDirty=this.meshDirty || !sameModels;
        }catch(error){if(this.alive){this.failedRevision=revision;console.warn("Facility details unavailable; keeping the existing map.",error);}}
        finally{this.preparing=false;if(this.alive && revision!==this.revision)this.schedule();}
      }
      if(!this.alive || this.interacting || !this.prepared)return;
      this.ensureLayers();
      const flat=this.options.satellite,source=map.getSource(SOURCE);
      if(this.applied?.data!==this.prepared.data || this.appliedSource!==source) {
        source.setData(this.prepared.data);this.applied=this.prepared;this.appliedSource=source;
      }
      for(const suffix of ["surface","outline","spaces","labels"]) {
        const id=`${SOURCE}-${suffix}`,visibility=flat ? "none" : "visible";
        if(map.getLayoutProperty(id,"visibility")!==visibility)map.setLayoutProperty(id,"visibility",visibility);
      }
      const hasModels=()=>this.prepared.wheels.length>0 || map.getZoom()>=17 && this.prepared.small?.length>0;
      let wanted=!flat && map.getPitch()>0.5 && map.getZoom()>=14 && hasModels();
      if(this.layer)this.layer.enabled=wanted;
      if(wanted && !this.layer && !this.failed && !this.starting)await this.start();
      if(!this.alive)return;
      wanted=!this.options.satellite && map.getPitch()>0.5 && map.getZoom()>=14 && hasModels();
      if(this.layer)this.layer.enabled=wanted;
      if(this.layer && wanted && (this.meshDirty || this.sceneNight!==this.options.night)) {
        try {this.build();this.meshDirty=false;this.sceneNight=this.options.night;}
        catch(error){this.layer.enabled=false;this.failed=true;console.warn("Ferris wheel models unavailable; keeping map symbols.",error);}
      }
      if(this.layer?.enabled)this.position();
      const element=root.document?.getElementById("map");
      if(element){element.dataset.huayuFerrisWheels=String(this.layer?.enabled && !this.failed ? this.prepared.wheels.length : 0);
        element.dataset.huayuParkingSpaces=String(flat ? 0 : this.prepared.spaces);
        element.dataset.huayuOutdoorFacilities=String(this.layer?.enabled && !this.failed && map.getZoom()>=17
          && this.preparedContext===this.options.context ? this.prepared.small?.length || 0 : 0);}
      map.triggerRepaint();
    }
    async start() {
      this.starting=true;
      try {
        this.T=await import("./three-0.160.1.module.min.js");
        if(!this.alive || this.options.satellite || this.map.getPitch()<=0.5)return;
        const owner=this,T=this.T;
        this.layer={id:LAYER,type:"custom",renderingMode:"3d",enabled:false,
          onAdd(map,gl){owner.renderer=new T.WebGLRenderer({canvas:map.getCanvas(),context:gl,antialias:true});owner.renderer.autoClear=false;
            owner.scene=new T.Scene();owner.camera=new T.Camera();owner.scene.add(new T.AmbientLight(0xffffff,1.5));
            const light=new T.DirectionalLight(0xffffff,1.1);light.position.set(-60,-40,100);owner.scene.add(light);},
          render(gl,args){if(!owner.alive || !owner.layer?.enabled || !owner.origin || owner.options.satellite || owner.map.getPitch()<=0.5)return;
            const matrix=args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args;
            owner.camera.projectionMatrix.fromArray(matrix).multiply(owner.transform);owner.renderer.resetState();
            owner.renderer.setViewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);owner.renderer.render(owner.scene,owner.camera);owner.renderer.resetState();},
          onRemove(){owner.release();}};
        const before=this.map.getStyle().layers.find(l=>["symbol","circle"].includes(l.type))?.id;
        this.map.addLayer(this.layer,before);this.meshDirty=true;
      }catch(error){this.failed=true;if(this.map.getLayer(LAYER))this.map.removeLayer(LAYER);this.layer=null;
        this.release();console.warn("Ferris wheel renderer unavailable; retaining map symbols.",error);}
      finally{this.starting=false;if(this.alive)this.schedule();}
    }
    build() {
      const T=this.T;this.clear();
      const first=this.prepared.wheels[0] || this.prepared.small?.[0];if(!first)return;
      this.origin=root.maplibregl.MercatorCoordinate.fromLngLat(first.center);
      this.scale=this.origin.meterInMercatorCoordinateUnits();
      this.transform=new T.Matrix4().makeTranslation(this.origin.x,this.origin.y,0).scale(new T.Vector3(this.scale,-this.scale,this.scale));
      const metal=new T.MeshLambertMaterial({color:this.options.night ? "#788895" : "#ece9dc"});
      const paint=new T.MeshLambertMaterial({color:this.options.night ? "#78979d" : "#6d9ba4"});
      const glass=new T.MeshLambertMaterial({color:this.options.night ? "#e3bd72" : "#68879b"});
      const cylinder=new T.CylinderGeometry(1,1,1,6).rotateX(Math.PI/2),box=new T.BoxGeometry(1,1,1),ring=new T.TorusGeometry(1,0.018,6,64).rotateX(Math.PI/2);
      this.resources=[metal,paint,glass,cylinder,box,ring];this.groups=[];
      for(const wheel of this.prepared.wheels) {
        const group=new T.Group(),h=wheel.height-wheel.base,r=wheel.diameter/2,z=h-r-h*.045,thickness=Math.max(1.5,r*.14);
        const pieces={rings:[],bars:[],cabins:[],windows:[]};
        const addBox=(name,x,y,z,sx,sy,sz)=>pieces[name].push({position:[x,y,z],scale:[sx,sy,sz]});
        const bar=(a,b,radius)=>pieces.bars.push({position:a.map((v,i)=>(v+b[i])/2),scale:[radius,radius,Math.hypot(...b.map((v,i)=>v-a[i]))],
          direction:b.map((v,i)=>v-a[i])});
        for(const y of [-thickness/2,thickness/2]) {
          pieces.rings.push({position:[0,y,z],scale:[r,r,r]});
          for(let i=0;i<24;i++){const a=i/24*Math.PI*2;bar([0,y,z],[Math.cos(a)*r,y,z+Math.sin(a)*r],Math.max(.08,r*.007));}
          const legRadius=Math.max(.14,r*.018);
          for(const x of [-r*.55,r*.55])bar([x,y*3,legRadius],[0,y,z],legRadius);
        }
        bar([0,-thickness,z],[0,thickness,z],Math.max(.3,r*.04));
        const size=Math.max(.6,Math.min(2.6,r*.11));
        for(let i=0;i<16;i++) {
          const a=i/16*Math.PI*2,x=Math.cos(a)*r,cz=z+Math.sin(a)*r;
          addBox("cabins",x,0,cz,size,thickness*.85,size*1.25);
          addBox("windows",x,-thickness*.43,cz+size*.1,size*.72,.04,size*.55);
          addBox("windows",x,thickness*.43,cz+size*.1,size*.72,.04,size*.55);
        }
        for(const [key,geom,material] of [["rings",ring,paint],["bars",cylinder,metal],["cabins",box,paint],["windows",box,glass]]) {
          const items=pieces[key],mesh=new T.InstancedMesh(geom,material,items.length),object=new T.Object3D();mesh.frustumCulled=false;
          items.forEach((piece,i)=>{object.position.fromArray(piece.position);object.scale.fromArray(piece.scale);object.quaternion.identity();
            if(piece.direction)object.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),new T.Vector3(...piece.direction).normalize());
            object.updateMatrix();mesh.setMatrixAt(i,object.matrix);});
          group.add(mesh);
        }
        group.rotation.z=wheel.angle;this.scene.add(group);this.groups.push({group,wheel});
      }
      this.buildSmall(box);
      this.position();
    }
    buildSmall(box) {
      const T=this.T,batches=new Map(),night=this.options.night;
      const colors=night ? {wall:"#7c8178",roof:"#52696d",door:"#354b50",glass:"#9cb9bc",trim:"#9caa9f",awning:"#8a6851"}
        : {wall:"#e0ddce",roof:"#63858a",door:"#4f6b70",glass:"#79a6af",trim:"#f4edda",awning:"#c89460"};
      const add=(item,key,x,y,z,w,d,h)=>{
        const explicit=key==="wall" ? item.colors[night ? "wallNight" : "wall"] : key==="roof" ? item.colors[night ? "roofNight" : "roof"] : "";
        const color=explicit || colors[key];if(!batches.has(color))batches.set(color,[]);
        batches.get(color).push({item,position:[x,y,z],scale:[w,d,h]});
      };
      for(const item of this.prepared.small || []) {
        const {width:w,depth:d,height:h,type}=item;
        add(item,"wall",0,0,h*.46,w*.92,d*.9,h*.92);
        add(item,"roof",0,0,h*.96,w,d,h*.08);
        if(type==="toilet") {
          for(const x of [-w*.23,w*.23]){
            add(item,"door",x,-d*.455,h*.37,w*.23,.04,h*.68);
            add(item,"glass",x,-d*.464,h*.78,w*.22,.05,h*.1);
            add(item,"trim",x,-d*.474,h*.6,.14,.04,.17);
          }
          add(item,"trim",0,-d*.46,h*.44,.08,.05,h*.86);
        }else{
          add(item,"glass",0,-d*.455,h*.54,w*.7,.04,h*.29);
          add(item,"trim",0,-d*.47,h*.36,w*.75,.05,h*.05);
          for(let i=0;i<6;i++)add(item,i%2 ? "trim" : "awning",(i-2.5)*w/6,-d*.38,h*.77,w/6,d*.22,h*.07);
          add(item,"door",w*.465,0,h*.35,.03,d*.35,h*.62);
        }
      }
      this.facilityBatches=[];
      for(const [color,items] of batches){
        const material=new T.MeshLambertMaterial({color}),mesh=new T.InstancedMesh(box,material,items.length);
        mesh.frustumCulled=false;this.resources.push(material);this.scene.add(mesh);this.facilityBatches.push({mesh,items});
      }
    }
    position() {
      if(!this.origin)return;
      for(const {group,wheel} of this.groups || []) {
        const p=root.maplibregl.MercatorCoordinate.fromLngLat(wheel.center),ratio=p.meterInMercatorCoordinateUnits()/this.scale;
        const elevation=this.map.getTerrain?.() ? this.map.queryTerrainElevation(wheel.center) : 0;
        group.visible=Number.isFinite(elevation);if(!group.visible)continue;
        group.position.set((p.x-this.origin.x)/this.scale,-(p.y-this.origin.y)/this.scale,(elevation+wheel.base)*ratio);group.scale.setScalar(ratio);
      }
      const T=this.T,placements=new Map(),object=new T.Object3D();
      for(const item of this.prepared.small || []) {
        const p=root.maplibregl.MercatorCoordinate.fromLngLat(item.center),ratio=p.meterInMercatorCoordinateUnits()/this.scale;
        const elevation=this.map.getTerrain?.() ? this.map.queryTerrainElevation(item.center) : 0;
        placements.set(item,{x:(p.x-this.origin.x)/this.scale,y:-(p.y-this.origin.y)/this.scale,z:(elevation+item.base)*ratio,
          ratio,visible:Number.isFinite(elevation) && this.map.getZoom()>=17 && this.preparedContext===this.options.context});
      }
      for(const {mesh,items} of this.facilityBatches || []) {
        items.forEach((part,i)=>{
          const p=placements.get(part.item),a=part.item.angle,cos=Math.cos(a),sin=Math.sin(a),[x,y,z]=part.position;
          object.position.set(p.x+(x*cos-y*sin)*p.ratio,p.y+(x*sin+y*cos)*p.ratio,p.visible ? p.z+z*p.ratio : 0);
          object.rotation.set(0,0,a);object.scale.fromArray(part.scale).multiplyScalar(p.visible ? p.ratio : 0);
          object.updateMatrix();mesh.setMatrixAt(i,object.matrix);
        });mesh.instanceMatrix.needsUpdate=true;
      }
    }
    clear(){for(const {group} of this.groups || []){this.scene?.remove(group);group.children.forEach(mesh=>mesh.dispose());}
      for(const {mesh} of this.facilityBatches || []){this.scene?.remove(mesh);mesh.dispose();}this.facilityBatches=[];
      this.resources?.forEach(r=>r.dispose());this.groups=[];this.resources=[];this.origin=null;}
    release(){this.clear();this.renderer?.dispose();this.renderer=null;}
    stopWorker(){this.worker?.terminate();this.worker=null;for(const task of this.pending?.values() || []){root.clearTimeout(task.timer);task.reject(new Error("facility worker stopped"));}this.pending?.clear();}
    destroy(){this.alive=false;root.clearTimeout(this.timer);this.unbind?.();this.stopWorker();this.map.off("terrain",this.onTerrain);
      this.map.off("sourcedata",this.onTerrain);this.map.off("moveend",this.onMove);
      if(this.map.getStyle?.()){if(this.map.getLayer(LAYER))this.map.removeLayer(LAYER);
        for(const suffix of ["surface","outline","spaces","labels"]){const id=`${SOURCE}-${suffix}`;if(this.map.getLayer(id))this.map.removeLayer(id);}
        if(this.map.getSource(SOURCE))this.map.removeSource(SOURCE);}
      this.release();}
  }
  root.HuayuFacilityModels={SOURCE,LAYER,createFacilityGeometry,kind:geometry.kind,
    sync(map,features=EMPTY,options={}){let c=controllers.get(map);if(!c){c=new Controller(map,options);controllers.set(map,c);}c.update(features,options);return c;},
    dispose(map){controllers.get(map)?.destroy();controllers.delete(map);},get:map=>controllers.get(map)};
})(typeof window!=="undefined" ? window : globalThis);
