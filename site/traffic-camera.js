(function installTrafficCamera(root){
  "use strict";
  function target(car,mode,bearing=0){
    if(mode!=="3d")return {center:car.coordinate,pitch:0,bearing:0};
    let heading=90-car.angle*180/Math.PI;
    while(heading-bearing>180)heading-=360;
    while(heading-bearing< -180)heading+=360;
    return {center:car.coordinate,pitch:55,bearing:heading};
  }
  // A bounded ground window is essential for pitched cameras whose visible horizon is enormous.
  function laneWindow(bounds,coordinate){
    const dx=Math.min(.025,Math.max(.0006,(bounds[2]-bounds[0])*.65)),dy=Math.min(.025,Math.max(.0006,(bounds[3]-bounds[1])*.65));
    return [coordinate[0]-dx,coordinate[1]-dy,coordinate[0]+dx,coordinate[1]+dy];
  }
  function laneView(car,guidance){
    const g=guidance?.id===car.id?guidance:car,n=Math.max(1,Math.min(24,g.lanes||car.lanes||1)),lane=Math.max(1,Math.min(n,g.lane||car.lane||1));
    const source=g.laneSource==="tag"?"标签":g.laneSource==="width"?"路宽估算":"道路类型估算";
    const structure=g.tunnel?"隧道":g.bridge?"桥梁／高架":g.elevated?"非地面道路":"地面道路";
    return {n,lane,source,structure,shared:Boolean(g.shared),reverse:Boolean(g.reverseLanes),total:g.totalLanes||null,
      summary:g.shared?"双向共享 1 车道":`本方向 ${n} 车道 · 当前第 ${lane} 道`,
      note:`${g.totalLanes?`本条道路共 ${g.totalLanes} 道 · `:""}${source} · 车道位置示意`};
  }
  // A separate straightened diagram, never map geometry or invented underground cars.
  function tunnelView(car,guidance,vehicles){
    const g=guidance?.id===car.id?guidance:car;if(!g.tunnel)return null;
    const view=laneView(car,guidance),width=288/view.n;
    const x=lane=>16+((view.reverse?view.n-lane:lane-1)+.5)*width;
    const selected={id:car.id,x:x(view.lane),y:90,width:Math.min(16,width*.55)};
    const nearby=[];
    if(car.phase==='edge'&&car.roadId!==undefined)for(const v of vehicles){
      if(v.id===car.id||!v.tunnel||v.hiddenSample||v.phase!=='edge'||v.roadId!==car.roadId||Math.cos(v.angle-car.angle)<.6)continue;
      const dx=(v.coordinate[0]-car.coordinate[0])*111320*Math.cos(car.coordinate[1]*Math.PI/180),dy=(v.coordinate[1]-car.coordinate[1])*111320;
      const along=dx*Math.cos(car.angle)+dy*Math.sin(car.angle);
      if(!Number.isFinite(along)||along< -25||along>90)continue;
      const lane=Math.max(1,Math.min(view.n,v.lane||1));
      nearby.push({id:v.id,x:x(lane),y:90-along*.8,width:selected.width,distance:Math.abs(along)});
    }
    nearby.sort((a,b)=>a.distance-b.distance||a.id-b.id);
    return {n:view.n,reverse:view.reverse,selected,nearby:nearby.slice(0,16)};
  }
  root.HuayuTrafficCamera=Object.freeze({target,laneWindow,laneView,tunnelView});
})(globalThis);
