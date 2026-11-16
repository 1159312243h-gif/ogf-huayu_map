(function installTrafficTrips(root){
  "use strict";
  const C=root.HuayuTrafficCore;
  const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=85;
  // Project only onto the usable part of an actual directed edge. Never join nearby roads.
  function nearest(graph,point){
    const hits=[];
    for(const e of graph.edges){if(e.tunnel)continue;let best=null;
      for(let i=1;i<e.line.points.length;i++){
        const a=e.line.points[i-1],b=e.line.points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=e.line.cumulative[i]-e.line.cumulative[i-1];
        if(!length)continue;
        const lo=Math.max(0,(e.start-e.line.cumulative[i-1])/length),hi=Math.min(1,(e.end-e.line.cumulative[i-1])/length);
        if(lo>hi)continue;
        const t=Math.max(lo,Math.min(hi,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy)));
        const distance=Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy),s=e.line.cumulative[i-1]+t*length-e.start;
        if(!best||distance<best.distance)best={edge:e.id,s:Math.min(s,e.length-0.1),distance};
      }
      if(best&&best.distance<=100)hits.push(best);
    }
    hits.sort((a,b)=>a.distance-b.distance||a.edge-b.edge);
    // Opposite carriageways are valid alternatives; a distant road is not a substitute.
    return hits.filter(h=>h.distance<=Math.min(100,(hits[0]?.distance||0)+5)).slice(0,8);
  }
  function plan(simulation,request){
    if(!valid(request.start)||request.destination&&!valid(request.destination))throw Error("请填写有效的纬度、经度（纬度范围 −85～85）");
    const {graph,project}=simulation,starts=nearest(graph,project.xy(request.start));
    if(!starts.length)throw Error("起点附近 100 米内没有已加载的可行驶道路，请在道路上选点或先加载该区域");
    const destinations=new Map();
    if(request.destination){
      const hits=nearest(graph,project.xy(request.destination));
      if(!hits.length)throw Error("终点附近没有已加载的可行驶道路");
      for(const h of hits){const e=graph.edges[h.edge];for(const node of [e.from,e.to]){
        const n=graph.nodes.get(node);if(Math.hypot(...n.point.map((v,i)=>v-project.xy(request.destination)[i]))>200)continue;
        destinations.set(node,{node,name:"自选终点（道路接入点）",kind:"leisure",access:project.lngLat(n.point)});
      }}
      if(!destinations.size)throw Error("终点距可用道路接入点超过 200 米，请靠近路口选点");
    }else for(const site of simulation.demand.sites||[])if(site.kind!=="home"&&graph.nodes.has(site.node))destinations.set(site.node,site);
    if(!destinations.size)throw Error("没有可自动选择的设施，请手动设置终点");
    // Edge states reuse the graph's legal next movements, including one-way and grade separation.
    const heap=[],cost=new Map(),parents=new Map(),origins=new Map(),meters=new Map();
    const push=(key,d)=>{let i=heap.length;heap.push([key,d]);while(i){const j=(i-1)>>1;if(heap[j][1]<=d)break;heap[i]=heap[j];i=j;}heap[i]=[key,d];};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][1]<heap[j][1])j++;if(last[1]<=heap[j][1])break;heap[i]=heap[j];i=j;}heap[i]=last;}return first;};
    for(const hit of starts){const e=graph.edges[hit.edge],key=e.id*3+(e.accessOnly?0:1),d=(e.length-hit.s)/e.speed;
      cost.set(key,d);origins.set(key,hit);meters.set(key,e.length-hit.s);push(key,d);}
    while(heap.length){const [key,d]=pop();if(cost.get(key)!==d||d>14400)continue;
      const e=graph.edges[Math.floor(key/3)],phase=key%3,destination=destinations.get(e.to);
      if(destination&&meters.get(key)>=40){
        const route=[];let at=key;while(at!==undefined){route.push(Math.floor(at/3));at=parents.get(at);}route.reverse();
        const hit=origins.get(key),first=graph.edges[hit.edge],p=C.sample(first.line,first.start+hit.s);
        return {route,s:hit.s,distance:meters.get(key),home:{name:"自选起点",kind:"home",access:project.lngLat([p.x,p.y])},destination};
      }
      for(const id of e.next){const next=graph.edges[id];if(phase===2&&!next.accessOnly)continue;
        const state=next.accessOnly?(phase===0?0:2):1,k=id*3+state;
        const penalty=next.highway==="service"?8:next.highway==="living_street"?4:1;
        const nd=d+next.length/next.speed*penalty+2;
        if(nd<(cost.get(k)??Infinity)){cost.set(k,nd);parents.set(k,key);origins.set(k,origins.get(key));meters.set(k,meters.get(key)+next.length);push(k,nd);}
      }
    }
    throw Error("起终点在当前路网中不可达，请检查单行、断路或加载范围；不会虚构连接");
  }
  function start(simulation,request){
    if(simulation.cars.some(c=>c.manual&&c.phase!=="dwell"))throw Error("已有自定义车辆在行驶，请先结束该行程");
    if(simulation.cars.filter(c=>!c.manual).length>= (simulation.graph.regional?4000:600))throw Error("当前车辆预算已满，请稍后发车");
    const p=plan(simulation,request),e=simulation.graph.edges[p.route[0]],regional=simulation.graph.regional;
    const s=regional?p.s/e.length*e.line.length:p.s,id=simulation.serial+1;
    let lane=null;
    if(!regional)lane=simulation.chooseLane(e.id,s,id);
    else for(let i=0;i<e.lanes;i++){if(!simulation.cars.some(c=>c.phase==="edge"&&c.edge===e.id&&(c.lane||0)===i&&Math.abs(c.s-s)<9*e.line.length/e.length)){lane=i;break;}}
    if(lane===null)throw Error("起点车道暂时没有安全发车空间，请稍后再试或换一个起点");
    simulation.cars=simulation.cars.filter(c=>!c.manual);
    const pair={home:p.home,destination:p.destination,outward:p.route,back:[],distance:p.distance};
    const car={id:++simulation.serial,manual:true,pair,route:p.route,index:0,edge:e.id,next:p.route[1]??null,s,v:0,lane,
      phase:"edge",returning:false,wait:null,waitFor:0,age:0,queueSeconds:0,manualStart:p.s};
    simulation.cars.push(car);simulation.selected=car.id;
    return {id:car.id,coordinate:p.home.access,destination:p.destination.name,distance:p.distance};
  }
  root.HuayuTrafficTrips=Object.freeze({start,plan});
})(globalThis);
