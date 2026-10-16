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
  root.HuayuMapExport={MIN_RESOLUTION,MAX_RESOLUTION,resolution,polygon,mask,flatten,attribution,vectorCanvas,waitForMap};
})(typeof window!=="undefined"?window:globalThis);
