(function (root) {
  "use strict";
  const MIN_RESOLUTION = 512, MAX_RESOLUTION = 8192;
  function resolution(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= MIN_RESOLUTION && number <= MAX_RESOLUTION ? number : null;
  }
  function polygon(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > 200) return null;
    if (points.some(point => !Array.isArray(point))) return null;
    const ring = points.map(point => point.slice(0, 2));
    if (ring.some(p => p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85.051128)) return null;
    if (ring[0].every((v, i) => v === ring.at(-1)[i])) ring.pop();
    if (ring.length < 3) return null;
    const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const on = (a,b,p) => Math.abs(cross(a,b,p)) < 1e-14 && p[0] >= Math.min(a[0],b[0])-1e-12 && p[0] <= Math.max(a[0],b[0])+1e-12
      && p[1] >= Math.min(a[1],b[1])-1e-12 && p[1] <= Math.max(a[1],b[1])+1e-12;
    for (let i=0;i<ring.length;i++) {
      const a=ring[i],b=ring[(i+1)%ring.length];
      if (a.every((v,k)=>v===b[k])) return null;
      for(let j=i+1;j<ring.length;j++) {
        if(j===i+1 || (i===0 && j===ring.length-1)) continue;
        const c=ring[j],d=ring[(j+1)%ring.length];
        if((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)) return null;
      }
    }
    const area=ring.reduce((sum,p,i)=>sum+p[0]*ring[(i+1)%ring.length][1]-ring[(i+1)%ring.length][0]*p[1],0);
    if(Math.abs(area)<1e-12 || Math.max(...ring.map(p=>p[0]))-Math.min(...ring.map(p=>p[0]))>180) return null;
    ring.push(ring[0].slice());
    return {type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[ring]}};
  }
  function mask(canvas, features, project) {
    if (!features?.length) return;
    const layer=root.document.createElement("canvas");layer.width=canvas.width;layer.height=canvas.height;
    const ctx=layer.getContext("2d");ctx.fillStyle="#fff";
    for(const feature of features) {
      const geometry=feature.geometry;
      const polygons=geometry?.type==="Polygon"?[geometry.coordinates]:geometry?.type==="MultiPolygon"?geometry.coordinates:[];
      for(const rings of polygons) {
        ctx.beginPath();
        for(const ring of rings) {ring.forEach((point,index)=>{const [x,y]=project(point);if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();}
        ctx.fill("evenodd");
      }
    }
    const context=canvas.getContext("2d");context.save();context.setTransform(1,0,0,1,0,0);
    context.globalCompositeOperation="destination-in";context.drawImage(layer,0,0);context.restore();
    layer.width=layer.height=1;
  }
  function flatten(canvas) {
    const ctx=canvas.getContext("2d");ctx.save();ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation="destination-over";ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();
  }
  function attribution(canvas, text, scale=1, clipped=false) {
    const ctx=canvas.getContext("2d"),pad=Math.max(2,Math.ceil(8*scale)),height=Math.max(12,Math.ceil(26*scale));
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.font=`${16*scale}px system-ui, sans-serif`;
    const preferred=Math.ceil(ctx.measureText(text).width+pad*2);
    let box;
    for(let y=canvas.height-height-pad;y>=pad;y-=Math.max(height,Math.floor(canvas.height/24))) {
      if(!clipped) {box={x:pad,y,width:canvas.width-pad*2};break;}
      const pixels=ctx.getImageData(0,y,canvas.width,height).data;
      let start=0;
      for(let x=0;x<=canvas.width;x++) {
        let opaque=x<canvas.width;
        for(let row=0;opaque&&row<height;row++)if(pixels[(row*canvas.width+x)*4+3]!==255)opaque=false;
        if(opaque)continue;
        const width=x-start-pad*2;
        if(width>=Math.min(preferred,180*scale) && (!box||width>box.width))box={x:start+pad,y,width};
        start=x+1;
      }
      if(box?.width>=preferred)break;
    }
    if(!box) {ctx.restore();throw new Error("裁切范围过窄，无法保留完整来源署名，请调整范围");}
    const width=Math.min(preferred,box.width);
    ctx.fillStyle="rgba(255, 255, 255, 0.88)";ctx.fillRect(box.x,box.y,width,height);
    ctx.fillStyle="#4f595e";ctx.textBaseline="middle";ctx.fillText(text,box.x+pad,box.y+height/2,width-pad*2);
    ctx.restore();
    return {x:box.x,y:box.y,width,height};
  }
  function waitForMap(map, timeout=45000) {
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);map.off("idle",ready);map.off("error",failed);};
      const ready=()=>{if(!map.loaded() || !map.areTilesLoaded())return;cleanup();resolve();};
      const failed=event=>{cleanup();reject(new Error(`底图资源未能完整加载：${event.error?.message || "未知错误"}`));};
      map.on("idle",ready);map.on("error",failed);
      timer=setTimeout(()=>{cleanup();reject(new Error("底图加载超时，请缩小范围或稍后重试"));},timeout);
      map.triggerRepaint();
    });
  }
  async function vectorCanvas({canvas,bounds,style,prepare,beforeCapture,onProgress}) {
    const host=root.document.createElement("div");host.className="map-export-renderer";host.setAttribute("aria-hidden","true");
    root.document.body.appendChild(host);
    let map,dispose;
    try {
      const northwest=root.maplibregl.MercatorCoordinate.fromLngLat([bounds.minLon,bounds.maxLat]);
      const southeast=root.maplibregl.MercatorCoordinate.fromLngLat([bounds.maxLon,bounds.minLat]);
      const world=canvas.width/(southeast.x-northwest.x),zoom=Math.log2(world/512);
      const block=1536,gutter=128;
      const columns=Math.ceil(canvas.width/block),rows=Math.ceil(canvas.height/block);
      const ctx=canvas.getContext("2d");
      host.style.width=`${Math.min(block,canvas.width)+gutter*2}px`;
      host.style.height=`${Math.min(block,canvas.height)+gutter*2}px`;
      map=new root.maplibregl.Map({container:host,style,preserveDrawingBuffer:true,pixelRatio:1,interactive:false,
        attributionControl:false,fadeDuration:0,renderWorldCopies:false,center:[(bounds.minLon+bounds.maxLon)/2,(bounds.minLat+bounds.maxLat)/2],zoom,
        pitch:0,bearing:0,maxZoom:24});
      await waitForMap(map);
      dispose=await prepare(map,zoom);
      for(let row=0;row<rows;row++)for(let column=0;column<columns;column++) {
        const x=column*block,y=row*block,w=Math.min(block,canvas.width-x),h=Math.min(block,canvas.height-y);
        // Render a margin around each block for labels and symbol collisions.
        const captureH=Math.max(1,Math.round(h*world/(canvas.height/(southeast.y-northwest.y))));
        host.style.width=`${w+gutter*2}px`;host.style.height=`${captureH+gutter*2}px`;map.resize();
        const center=new root.maplibregl.MercatorCoordinate(northwest.x+(x+w/2)/world,
          northwest.y+(y+h/2)*(southeast.y-northwest.y)/canvas.height).toLngLat();
        map.jumpTo({center,zoom,pitch:0,bearing:0});
        await waitForMap(map);
        if(beforeCapture) {await beforeCapture(map);await waitForMap(map);}
        const source=map.getCanvas(),sx=source.width/(w+gutter*2),sy=source.height/(captureH+gutter*2);
        ctx.drawImage(source,gutter*sx,gutter*sy,w*sx,captureH*sy,x,y,w,h);
        onProgress?.(row*columns+column+1,rows*columns);
      }
    } finally {try{dispose?.();}finally{map?.remove();host.remove();}}
  }
  // A separate, north-up renderer for selected objects. Coordinates stay intact;
  // fitting adds space around their full extent rather than clipping to the pick box.
  function featureLayout(features, size = 2400) {
    size = resolution(size);
    if (!size) throw Error("图片长边须为 512–8192 的整数像素");
    const half = Math.PI * 6378137, limit = 85.05112878;
    let left=Infinity, right=-Infinity, top=-Infinity, bottom=Infinity, count=0;
    const mercator = coordinate => {
      const [lon,lat]=coordinate || [];
      if (!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lon)>180||Math.abs(lat)>limit) throw Error("地物坐标超出墨卡托图片支持范围");
      return [lon/180*half, Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))*6378137];
    };
    const visitCoordinates = coordinates => {
      if (!Array.isArray(coordinates)) throw Error("地物几何不完整");
      if (typeof coordinates[0] === "number") {
        const [x,y]=mercator(coordinates);left=Math.min(left,x);right=Math.max(right,x);
        bottom=Math.min(bottom,y);top=Math.max(top,y);count++;
      } else coordinates.forEach(visitCoordinates);
    };
    const visit = geometry => {
      if (geometry?.type === "GeometryCollection") geometry.geometries.forEach(visit);
      else if (["Point","MultiPoint","LineString","MultiLineString","Polygon","MultiPolygon"].includes(geometry?.type)) visitCoordinates(geometry.coordinates);
      else throw Error("不支持的地物几何");
    };
    features.forEach(feature=>visit(feature.geometry));
    if (!count) throw Error("清单中没有可绘制的地物");
    if (right-left>half) throw Error("地物跨度超过 180°，请分批导出图片");
    let spanX=Math.max(right-left,100),spanY=Math.max(top-bottom,100);
    spanX=Math.max(spanX,spanY*.3);spanY=Math.max(spanY,spanX*.3);
    const centerX=(left+right)/2,centerY=(top+bottom)/2;
    const widthMeters=Math.min(half*2,spanX*1.2),heightMeters=Math.min(half*2,spanY*1.2);
    left=Math.max(-half,Math.min(half-widthMeters,centerX-widthMeters/2));right=left+widthMeters;
    bottom=Math.max(-half,Math.min(half-heightMeters,centerY-heightMeters/2));top=bottom+heightMeters;
    const width=Math.max(1,Math.round(size*widthMeters/Math.max(widthMeters,heightMeters)));
    const height=Math.max(1,Math.round(size*heightMeters/Math.max(widthMeters,heightMeters)));
    const latitude = y => (2*Math.atan(Math.exp(y/6378137))-Math.PI/2)*180/Math.PI;
    return {width,height,bounds:{minLon:left/half*180,maxLon:right/half*180,minLat:latitude(bottom),maxLat:latitude(top)},
      project(coordinate) {const [x,y]=mercator(coordinate);return [(x-left)/widthMeters*width,(top-y)/heightMeters*height];},
      geoReference:{epsg:3857,pixelScaleX:widthMeters/width,pixelScaleY:heightMeters/height,tieX:0,tieY:0,tieLon:left,tieLat:top}};
  }

  const featurePalettes = {
    map:{paper:"#f5f3ed",ink:"#41525d",building:"#c8b8a5",road:"#f3b85a",railway:"#815e80",water:"#8bc4e3",vegetation:"#a9c88d",landuse:"#d5d5b3",point:"#d35447",halo:"#fffdf5"},
    night:{paper:"#172436",ink:"#d4dfec",building:"#51677f",road:"#e9b85e",railway:"#bd9cdd",water:"#244e70",vegetation:"#3c6857",landuse:"#374d58",point:"#ff9f89",halo:"#172436"},
    blueprint:{paper:"#123f70",ink:"#d5eeff",building:"#356596",road:"#a2d8ff",railway:"#ffffff",water:"#25578a",vegetation:"#407f99",landuse:"#28517c",point:"#ffffff",halo:"#123f70"},
    monochrome:{paper:"#ffffff",ink:"#202020",building:"#eeeeee",road:"#555555",railway:"#202020",water:"#e5e5e5",vegetation:"#f4f4f4",landuse:"#fafafa",point:"#202020",halo:"#ffffff"},
  };

  function drawFeatures(canvas, features, layout, options = {}) {
    const palette=featurePalettes[options.style];
    if (!palette) throw Error("请选择有效的地物渲染风格");
    const ctx=canvas.getContext("2d"),scale=Math.max(.5,Math.max(canvas.width,canvas.height)/1200);
    ctx.save();
    try {
      if (options.background === "paper") {ctx.fillStyle=palette.paper;ctx.fillRect(0,0,canvas.width,canvas.height);}
      ctx.lineJoin="round";ctx.lineCap="round";
      const path = (points, close=false) => {
        points.forEach((point,index)=>{const [x,y]=layout.project(point);if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});
        if(close)ctx.closePath();
      };
      const jobs=[];
      const collect=(geometry,feature)=>{
        if(geometry.type==="GeometryCollection")geometry.geometries.forEach(g=>collect(g,feature));
        else if(geometry.type.startsWith("Multi"))geometry.coordinates.forEach(coordinates=>collect({type:geometry.type.slice(5),coordinates},feature));
        else jobs.push({geometry,feature});
      };
      features.forEach(feature=>collect(feature.geometry,feature));
      const order={Polygon:0,LineString:1,Point:2};jobs.sort((a,b)=>order[a.geometry.type]-order[b.geometry.type]);
      for(const {geometry,feature} of jobs) {
        const tags=feature.properties?.tags||{},kind=feature.properties?.kind;
        const color=options.style==="map" && /^#[0-9a-f]{6}$/iu.test(feature.properties?.color||tags.colour||"")
          ? (feature.properties.color||tags.colour) : palette[kind]||palette.point;
        ctx.setLineDash([]);ctx.strokeStyle=palette.ink;ctx.lineWidth=1.2*scale;ctx.fillStyle=color;
        if(geometry.type==="Polygon") {
          ctx.beginPath();geometry.coordinates.forEach(ring=>path(ring,true));ctx.fill("evenodd");ctx.stroke();
        } else if(geometry.type==="LineString") {
          const road=kind==="road",width=(road?(["motorway","trunk"].includes(tags.highway)?5:3.5):2)*scale;
          ctx.beginPath();path(geometry.coordinates);ctx.strokeStyle=palette.ink;ctx.lineWidth=width+1.5*scale;ctx.stroke();
          ctx.strokeStyle=color;ctx.lineWidth=width;
          if(kind==="railway" || tags.construction || tags.proposed || feature.properties?.status==="proposed")ctx.setLineDash([6*scale,4*scale]);
          ctx.stroke();
        } else if(geometry.type==="Point") {
          const [x,y]=layout.project(geometry.coordinates);ctx.beginPath();ctx.arc(x,y,4*scale,0,Math.PI*2);ctx.fill();ctx.stroke();
        }
      }
      if(options.labels) {
        ctx.setLineDash([]);ctx.font=`${12*scale}px system-ui, sans-serif`;ctx.textBaseline="middle";
        ctx.strokeStyle=palette.halo;ctx.fillStyle=palette.ink;ctx.lineWidth=3*scale;
        const occupied=[];
        const first=geometry=>!geometry?undefined:geometry.type==="GeometryCollection"?first(geometry.geometries[0])
          : geometry.type==="Point"?geometry.coordinates
          : geometry.type==="MultiPolygon"?geometry.coordinates[0]?.[0]?.[0]
          : ["MultiLineString","Polygon"].includes(geometry.type)?geometry.coordinates[0]?.[0]:geometry.coordinates[0];
        for(const feature of features) {
          const name=String(feature.properties?.name||feature.properties?.tags?.name||"").slice(0,80),anchor=first(feature.geometry);
          if(!name||!anchor)continue;
          const point=layout.project(anchor),x=point[0]+7*scale,y=point[1]-7*scale,w=ctx.measureText(name).width,h=16*scale;
          const box={x,y:y-h/2,w,h};
          if(x+w>canvas.width-6*scale||y<h||y>canvas.height-35*scale||occupied.some(b=>x<b.x+b.w&&x+w>b.x&&box.y<b.y+b.h&&box.y+h>b.y))continue;
          ctx.strokeText(name,x,y);ctx.fillText(name,x,y);occupied.push(box);
          if(occupied.length>=200)break;
        }
      }
    } finally {ctx.restore();}
  }
  root.HuayuMapExport={MIN_RESOLUTION,MAX_RESOLUTION,resolution,polygon,mask,flatten,attribution,vectorCanvas,waitForMap,featureLayout,drawFeatures};
})(typeof window!=="undefined"?window:globalThis);
