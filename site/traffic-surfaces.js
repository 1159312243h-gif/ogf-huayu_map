(function installTrafficSurfaces(root){
  "use strict";
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t;
  function index(plans){
    const origin=plans[0]?.samples[0]?.coordinate||[0,0],sx=111320*Math.cos(origin[1]*Math.PI/180),cells=new Map();
    const xy=p=>[(p[0]-origin[0])*sx,(p[1]-origin[1])*111320];
    for(const plan of plans)for(let i=1;i<plan.samples.length;i++){
      const a=xy(plan.samples[i-1].coordinate),b=xy(plan.samples[i].coordinate),id=String(plan.samples[i-1].roadId);
      if(!Number.isFinite(plan.heights[i-1])||!Number.isFinite(plan.heights[i]))continue;
      const span={a,b,z0:plan.heights[i-1],z1:plan.heights[i],width:Math.min(plan.surfaceWidths?.[i-1]||plan.samples[i-1].width,plan.surfaceWidths?.[i]||plan.samples[i].width)};
      const seen=new Set(),steps=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/16));
      for(let j=0;j<=steps;j++){const key=`${id}:${Math.floor(mix(a[0],b[0],j/steps)/32)}:${Math.floor(mix(a[1],b[1],j/steps)/32)}`;
        if(seen.has(key))continue;seen.add(key);if(!cells.has(key))cells.set(key,[]);cells.get(key).push(span);}
    }
    return {origin,sx,cells,xy};
  }
  function locate(surface,id,coordinate){
    if(!surface||id===undefined)return null;
    const p=surface.xy(coordinate),cx=Math.floor(p[0]/32),cy=Math.floor(p[1]/32),seen=new Set();let best=null,distance=Infinity;
    for(let x=cx-2;x<=cx+2;x++)for(let y=cy-2;y<=cy+2;y++)for(const span of surface.cells.get(`${id}:${x}:${y}`)||[]){
      if(seen.has(span))continue;seen.add(span);const {a,b}=span,dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
      if(!length2)continue;const t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length2,0,1),q=[mix(a[0],b[0],t),mix(a[1],b[1],t)],d=(p[0]-q[0])**2+(p[1]-q[1])**2;
      if(d<distance&&d<=Math.max(32,span.width)**2){distance=d;best={height:mix(span.z0,span.z1,t),width:span.width,point:q,offset:[p[0]-q[0],p[1]-q[1]]};}
    }
    return best;
  }
  function vehicle(surface,car,coordinate,ground){
    if(car.tunnel||car.nextTunnel)return null;
    const here=locate(surface,car.roadId,coordinate),next=car.phase==='turn'?locate(surface,car.nextRoadId,coordinate):null;
    if(car.elevated&&!here||car.nextElevated&&!next)return null;
    if(!here&&!Number.isFinite(ground)||car.phase==='turn'&&!next&&!Number.isFinite(ground))return null;
    let height=here?.height??ground;
    if(car.phase==='turn')height=mix(height,next?.height??ground,clamp(car.turnProgress||0,0,1));
    if(!Number.isFinite(height))return null;
    // Fit inferred lanes to the actual displayed deck; never widen an explicitly narrow bridge.
    let point=coordinate;
    if(here&&car.phase!=='turn'&&car.roadWidth>here.width-.4){const scale=Math.max(0,(here.width-.4)/car.roadWidth);
      point=[surface.origin[0]+(here.point[0]+here.offset[0]*scale)/surface.sx,surface.origin[1]+(here.point[1]+here.offset[1]*scale)/111320];}
    return {height,coordinate:point,onBridge:Boolean(here||next)};
  }
  function geometry(graph,plans,bounds){
    const origin=graph.center,merc=p=>[(p[0]+180)/360,(180-180/Math.PI*Math.log(Math.tan(Math.PI/4+p[1]*Math.PI/360)))/360],o=merc(origin);
    const unit=p=>1/(40075016.68557849*Math.cos(p[1]*Math.PI/180)),scale=unit(origin),roads=new Map(),byRoad=new Map(),project=root.HuayuTrafficCore.projection(origin);
    for(const e of graph.edges){if(!roads.has(e.roadId)||!e.reverse)roads.set(e.roadId,e);if(!byRoad.has(e.roadId))byRoad.set(e.roadId,[]);byRoad.get(e.roadId).push(e);}
    const marks=[],colors=[],flow=[],groups=[],spans=[];let limited=false;
    for(const plan of plans){
      const path=plan.samples.map((s,i)=>{const m=merc(s.coordinate),ratio=unit(s.coordinate)/scale;
        return {x:(m[0]-o[0])/scale,y:-(m[1]-o[1])/scale,z:plan.heights[i]*ratio,ratio,s,width:plan.surfaceWidths?.[i]||s.width};});
      const at=(i,offset,lift=.07)=>{const p=path[i],a=path[Math.max(0,i-1)],b=path[Math.min(path.length-1,i+1)],ax=p.x-a.x,ay=p.y-a.y,bx=b.x-p.x,by=b.y-p.y,la=Math.hypot(ax,ay),lb=Math.hypot(bx,by);
        const n1=la?[-ay/la,ax/la]:[-by/lb,bx/lb],n2=lb?[-by/lb,bx/lb]:n1,nl=Math.hypot(n1[0]+n2[0],n1[1]+n2[1]),n=nl>.1?[(n1[0]+n2[0])/nl,(n1[1]+n2[1])/nl]:n2,miter=Math.min(1.7,1/Math.max(.2,n[0]*n2[0]+n[1]*n2[1]));
        return [p.x+n[0]*miter*offset*p.ratio,p.y+n[1]*miter*offset*p.ratio,p.z+lift*p.ratio];};
      for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],id=String(a.s.roadId),e=roads.get(id);if(!e)continue;
        if(Math.max(a.s.coordinate[0],b.s.coordinate[0])<bounds[0]||Math.min(a.s.coordinate[0],b.s.coordinate[0])>bounds[2]||Math.max(a.s.coordinate[1],b.s.coordinate[1])<bounds[1]||Math.min(a.s.coordinate[1],b.s.coordinate[1])>bounds[3])continue;
        const center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2],d=(a.s.coordinate[0]-center[0])**2+(a.s.coordinate[1]-center[1])**2;
        spans.push({a,b,id,e,i,at,d});
      }
    }
    spans.sort((a,b)=>a.d-b.d);
    const quad=(out,a,b,c,d)=>out.push(...a,...b,...c,...a,...c,...d);
    let segments=0;
    for(const {a,b,id,e,i,at} of spans){
      const spec=e.laneSpec,offsets=[[-spec.width/2+.15,'edge'],[spec.width/2-.15,'edge']],own=spec.forwardOffsets,opposite=spec.backwardOffsets.map(v=>-v);
      for(const side of [own,opposite])for(let j=1;j<side.length;j++)offsets.push([(side[j-1]+side[j])/2,'divider']);
      if(e.bidirectional&&!spec.shared&&opposite.length){if(spec.middle){offsets.push([own[0]-Math.sign(own[0]-opposite[0])*spec.laneWidth/2,'center'],[opposite[0]+Math.sign(own[0]-opposite[0])*spec.laneWidth/2,'center']);}
        else offsets.push([(own[0]+opposite[0])/2,'center']);}
      if(segments>=1200||(marks.length+flow.length)/3+6*(offsets.length+1)>80000){limited=true;break;}segments++;
      const width=Math.min(a.width,b.width),flowWidth=Math.min(width*.35,3.2),start=flow.length/3;
      quad(flow,at(i-1,-flowWidth/2,.055),at(i-1,flowWidth/2,.055),at(i,flowWidth/2,.055),at(i,-flowWidth/2,.055));
      const p=project.xy([mix(a.s.coordinate[0],b.s.coordinate[0],.5),mix(a.s.coordinate[1],b.s.coordinate[1],.5)]);let nearest=null,best=Infinity;
      for(const edge of byRoad.get(id)||[])for(let k=1;k<edge.line.points.length;k++){const q=edge.line.points[k-1],r=edge.line.points[k],dx=r[0]-q[0],dy=r[1]-q[1],t=clamp(((p[0]-q[0])*dx+(p[1]-q[1])*dy)/(dx*dx+dy*dy||1),0,1),d=(p[0]-q[0]-t*dx)**2+(p[1]-q[1]-t*dy)**2;
        if(d<best){nearest=edge;best=d;}}
      groups.push({roadId:id,ids:(byRoad.get(id)||[]).filter(edge=>edge.segment===nearest?.segment).map(edge=>edge.id),start,count:6});
      const direction=a.s.roadId===b.s.roadId?Math.sign((b.s.sourceSegment-a.s.sourceSegment)||(b.s.fraction-a.s.fraction))||1:1;
      const fit=Math.min(1,Math.max(0,width-.4)/spec.width);
      for(const [offset,kind] of offsets){if(kind==='divider'&&Math.floor((a.s.s+b.s.s)/8)%2)continue;
        const center=-offset*fit*direction,half=kind==='center'?.075:.06,color=kind==='center'?[.89,.60,.12]:[.94,.92,.86];
        quad(marks,at(i-1,center-half),at(i-1,center+half),at(i,center+half),at(i,center-half));for(let j=0;j<6;j++)colors.push(...color);
      }
    }
    return {positions:new Float32Array(marks),colors:new Float32Array(colors),flow:new Float32Array(flow),groups,segments,limited};
  }
  root.HuayuTrafficSurfaces=Object.freeze({index,locate,vehicle,geometry});
})(globalThis);
