(function installRegionalTraffic(root){
  "use strict";
  const C=root.HuayuTrafficCore,D=root.HuayuTrafficDemand,R=root.HuayuTrafficRegions;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  // Shared for trips on either side of an administrative border: mostly local, small long-distance tail.
  const distanceWeight=meters=>0.94*Math.exp(-meters/7000)+0.06*Math.exp(-meters/45000);
  const surfaceLot=p=>!["underground","multi-storey","rooftop"].includes(p.parking)&&!["underground","roof"].includes(p.location)&&(!p.building||p.building==="no");
  function buildGraph(input,options={}){
    const cells=new Map(),accessNodes=new Set(),size=0.002;
    for(const f of input.features)if(f.properties.amenity==="parking"&&f.area&&surfaceLot(f.properties)){
      const b=R.bounds(f.area),x0=Math.floor(b[0]/size),x1=Math.floor(b[2]/size),y0=Math.floor(b[1]/size),y1=Math.floor(b[3]/size);
      if((x1-x0+1)*(y1-y0+1)>4096)continue;
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=`${x}:${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(f.area);}
    }
    for(const f of input.roads)if(/^(service|living_street)$/.test(f.properties.highway))f.geometry.coordinates.forEach((p,i)=>{
      if((cells.get(`${Math.floor(p[0]/size)}:${Math.floor(p[1]/size)}`)||[]).some(g=>R.inside(p,g)))accessNodes.add(String(f.properties.roadNodes[i]));
    });
    for(const id of root.HuayuRegionalSites.accessNodes(input))accessNodes.add(id);
    return C.buildGraph(input.roads,{...options,center:input.center,regional:true,accessNodes});
  }
  const searchIndexes=new WeakMap();
  function searchIndex(graph){
    let index=searchIndexes.get(graph);if(index)return index;
    const ids=[...graph.nodes.keys()],byId=new Map(ids.map((id,i)=>[id,i])),incoming=ids.map(()=>[]);
    const from=new Int32Array(graph.edges.length),to=new Int32Array(graph.edges.length),travel=new Float64Array(graph.edges.length);
    for(const e of graph.edges){from[e.id]=byId.get(e.from);to[e.id]=byId.get(e.to);incoming[to[e.id]].push(e.id);
      const penalty=e.highway==="service"?8:e.highway==="living_street"?4:e.highway==="residential"?1.5:1;
      travel[e.id]=e.line.length/e.speed*penalty;}
    index={ids,byId,incoming,from,to,travel,outgoing:ids.map(id=>graph.nodes.get(id).out)};searchIndexes.set(graph,index);return index;
  }
  function tree(graph,start,reverse=false){
    const index=searchIndex(graph),n=index.ids.length,origin=index.byId.get(start),first=origin*3;
    const cost=new Map([[start,0]]),prev=new Map(),meters=new Map([[start,0]]);
    const stateCost=new Float64Array(n*3).fill(Infinity),parent=new Int32Array(n*3).fill(-1),parentEdge=new Int32Array(n*3).fill(-1);
    const traveled=new Float64Array(n*3),best=new Float64Array(n).fill(Infinity),bestState=new Int32Array(n).fill(-1);
    if(origin===undefined)return {cost,prev,meters,parent,parentEdge,bestState,first,index};
    const heapStates=[],heapCosts=[];
    const push=(id,d)=>{let i=heapStates.length;heapStates.push(id);heapCosts.push(d);while(i){const j=(i-1)>>1;if(heapCosts[j]<=d)break;heapStates[i]=heapStates[j];heapCosts[i]=heapCosts[j];i=j;}heapStates[i]=id;heapCosts[i]=d;};
    stateCost[first]=best[origin]=0;bestState[origin]=first;push(first,0);
    while(heapStates.length){const state=heapStates[0],d=heapCosts[0],lastState=heapStates.pop(),lastCost=heapCosts.pop();
      if(heapStates.length){let i=0;while(i*2+1<heapStates.length){let j=i*2+1;if(j+1<heapStates.length&&heapCosts[j+1]<heapCosts[j])j++;if(lastCost<=heapCosts[j])break;heapStates[i]=heapStates[j];heapCosts[i]=heapCosts[j];i=j;}heapStates[i]=lastState;heapCosts[i]=lastCost;}
      if(d!==stateCost[state]||d>14400)continue;
      const node=(state/3)|0,phase=state%3;
      for(const ei of (reverse?index.incoming:index.outgoing)[node]){const e=graph.edges[ei],to=(reverse?index.from:index.to)[ei];
        if(phase===2&&!e.accessOnly)continue;
        const nextPhase=e.accessOnly?(phase===0?0:2):1,key=to*3+nextPhase,next=d+index.travel[ei]+2;
        if(next<stateCost[key]){stateCost[key]=next;parent[key]=state;parentEdge[key]=ei;traveled[key]=traveled[state]+e.line.length;push(key,next);
          if(next<best[to]){best[to]=next;bestState[to]=key;const id=index.ids[to];cost.set(id,next);prev.set(id,ei);meters.set(id,traveled[key]);}}
      }
    }return {cost,prev,meters,parent,parentEdge,bestState,first,index};
  }
  function path(graph,t,start,end,reverse=false){let at=end;const out=[];
    if(t.parent){let state=t.bestState[t.index.byId.get(end)];while(state>=0&&state!==t.first&&out.length<=graph.edges.length){out.push(t.parentEdge[state]);state=t.parent[state];}
      return state===t.first&&out.length?(reverse?out:out.reverse()):null;}
    if(t.states){let state=t.bestState.get(end);while(state&&state!==t.first&&out.length<=graph.edges.length){const s=t.states.get(state);out.push(s.edge);state=s.parent;}
      return state===t.first&&out.length?(reverse?out:out.reverse()):null;}
    while(at!==start&&out.length<=graph.edges.length){const e=graph.edges[t.prev.get(at)];if(!e)return null;out.push(e.id);at=reverse?e.to:e.from;}
    return at===start&&out.length?(reverse?out:out.reverse()):null;
  }
  const residentialAccesses=(graph,input)=>root.HuayuRegionalSites.residentialAccesses(graph,input);
  class RegionalDemand extends D.Demand {
    constructor(graph,input,options){
      super({...graph,nodes:new Map(),edges:[]},[],options);this.graph=graph;this.pairs=[];this.sites=[];
      const project=C.projection(graph.center),nodes=[...graph.nodes.values()].filter(n=>n.out.some(id=>!graph.edges[id].motorway&&!graph.edges[id].elevated));
      graph.incoming=new Map();for(const e of graph.edges){if(!graph.incoming.has(e.to))graph.incoming.set(e.to,[]);graph.incoming.get(e.to).push(e.id);}
      const attachmentIndex=root.HuayuRegionalSites.nodeIndex(nodes);
      const attach=(p,max)=>{const xy=project.xy(p),best=attachmentIndex.nearest(xy,max);
        return best?{node:best.id,point:best.point,access:project.lngLat(best.point),accessDistance:Math.hypot(best.point[0]-xy[0],best.point[1]-xy[1])}:null;
      };
      this.parking=[];
      for(const f of input.features){const p=f.properties;if(p.amenity!=="parking"||["private","no"].includes(p.access)||p.disused&&p.disused!=="no"||p.abandoned&&p.abandoned!=="no")continue;
        const insideNodes=f.area&&surfaceLot(p)?nodes.filter(n=>n.out.some(id=>graph.edges[id].internal)&&R.inside(project.lngLat(n.point),f.area)):[];
        insideNodes.sort((a,b)=>Math.hypot(...project.xy(f.geometry.coordinates).map((v,i)=>v-a.point[i]))-Math.hypot(...project.xy(f.geometry.coordinates).map((v,i)=>v-b.point[i])));
        const n=insideNodes[0],access=n?{node:n.id,point:n.point,access:project.lngLat(n.point),accessDistance:0}:attach(f.geometry.coordinates,1500);if(!access)continue;
        const capacity=D.population(p.capacity),lot={...access,id:f.id,name:p.name||"停车场",coordinate:f.geometry.coordinates,capacity:clamp(capacity||20,1,50000),estimated:!capacity,
          area:f.area,renderable:Boolean(n),spots:[]};
        if(n){const e=graph.edges[n.out[0]],angle=C.sample(e.line,0).angle;
          for(const side of [1,-1])for(const offset of [0,6,-6,12,-12]){
            const point=[n.point[0]-Math.sin(angle)*side*5+Math.cos(angle)*offset,n.point[1]+Math.cos(angle)*side*5+Math.sin(angle)*offset];
            const fits=[[-2.2,-1],[2.2,-1],[2.2,1],[-2.2,1]].every(([a,b])=>R.inside(project.lngLat([point[0]-Math.sin(angle)*a+Math.cos(angle)*b,point[1]+Math.cos(angle)*a+Math.sin(angle)*b]),f.area));
            if(fits&&R.segmentInside(project.lngLat(n.point),project.lngLat(point),f.area)&&lot.spots.length<Math.min(8,lot.capacity))lot.spots.push({point,angle:angle+Math.PI/2});
          }
        }
        this.parking.push(lot);
      }
      let unconnectedResidents=0;const homes=new Map();
      const housing=residentialAccesses(graph,input);
      const slots=new Map(input.population.zones.map(z=>[z,z.geometry?clamp(Math.ceil(z.residents/25000),1,4):z.residents>=3000?2:1]));
      let allocated=[...slots.values()].reduce((n,v)=>n+v,0);
      while(allocated>512){const z=input.population.zones.filter(z=>slots.get(z)>1).sort((a,b)=>a.residents/(slots.get(a)-1)-b.residents/(slots.get(b)-1)||a.id.localeCompare(b.id))[0];
        if(!z)break;slots.set(z,slots.get(z)-1);allocated--;}
      const residentialNodes=nodes.filter(n=>n.out.some(id=>/^(residential|living_street)$/.test(graph.edges[id].highway)));
      for(const z of input.population.zones){
        let accesses=housing.accesses.get(z)||[];
        if(housing.complete){unconnectedResidents+=z.residents*(housing.unconnected.get(z)||0);if(!accesses.length)continue;}
        if(!accesses.length&&slots.get(z)>1){
          const b=z.geometry&&R.bounds(z.geometry),anchor=project.xy(z.coordinate),candidates=residentialNodes.filter(n=>{
            const p=project.lngLat(n.point);return b?p[0]>=b[0]&&p[0]<=b[2]&&p[1]>=b[1]&&p[1]<=b[3]&&R.inside(p,z.geometry)
              :Math.hypot(n.point[0]-anchor[0],n.point[1]-anchor[1])<=450&&input.selected.some(s=>R.inside(p,s.geometry));
          }).sort((a,b)=>Math.hypot(a.point[0]-anchor[0],a.point[1]-anchor[1])-Math.hypot(b.point[0]-anchor[0],b.point[1]-anchor[1])||a.id.localeCompare(b.id));
          const chosen=[];
          while(candidates.length&&chosen.length<slots.get(z)){
            let index=0,best=-1;
            if(chosen.length)for(let j=0;j<candidates.length;j++){
              const p=candidates[j].point,d=Math.min(...chosen.map(n=>Math.hypot(p[0]-n.point[0],p[1]-n.point[1])));
              if(d>best){best=d;index=j;}
            }
            const n=candidates.splice(index,1)[0];chosen.push(n);accesses.push({node:n.id,point:n.point,access:project.lngLat(n.point),accessDistance:0});
          }
        }
        if(!accesses.length){const access=attach(z.coordinate,input.provincial?10000:5000);if(access)accesses.push(access);}
        if(!accesses.length){unconnectedResidents+=z.residents;continue;}
        let assignedResidents=0;
        const connectedResidents=z.residents*(housing.complete?1-(housing.unconnected.get(z)||0):1);
        for(const [i,access] of accesses.entries()){const key=`${z.region}:${access.node}`;
          const weight=i===accesses.length-1?connectedResidents-assignedResidents:z.residents*(access.share??1/accesses.length);assignedResidents+=weight;
          if(homes.has(key)){homes.get(key).weight+=weight;homes.get(key).sources.push(z.name);}
          else homes.set(key,{...z,...access,id:`${z.id}:${access.node}`,kind:"home",weight,sources:[z.name]});}
      }
      let homeSites=[...homes.values()];
      for(let grid=2000;homeSites.length>512&&grid<=1000000;grid*=2){const cells=new Map();
        for(const h of homeSites){const key=`${h.region}:${Math.floor(h.point[0]/grid)}:${Math.floor(h.point[1]/grid)}`;
          if(cells.has(key)){const old=cells.get(key);old.weight+=h.weight;old.sources.push(...h.sources);old.name=`${old.sources[0]}等人口分区`;}else cells.set(key,{...h,sources:[...h.sources]});}
        homeSites=[...cells.values()];
      }
      if(homeSites.length>512)throw Error("人口分区接入点超过 512，请减少行政区范围");
      const facilities=new Map(),airportWeights=new Map(),nonPassenger=new Set(options.nonPassengerStationIds||[]);
      for(const airport of input.features.filter(f=>f.properties.aeroway==="aerodrome"&&f.area&&D.category(f.properties)==="transport")){
        const terminals=input.features.filter(f=>f.properties.aeroway==="terminal"&&D.category(f.properties)==="transport"&&R.inside(f.geometry.coordinates,airport.area));
        if(terminals.length){airportWeights.set(airport.id,0);for(const terminal of terminals)airportWeights.set(terminal.id,D.hubWeight(airport.properties)/terminals.length);}
      }
      for(const record of root.HuayuRegionalSites.prepare(input).records){const f=record.feature,p=f.properties,kind=record.kind;if(!kind||kind==="home"||record.destinationSuppressed)continue;
        if(kind==="transport"&&p.osmType==="node"&&nonPassenger.has(Number(p.osmId)))continue;
        const access=attach(f.geometry.coordinates,1500);if(!access)continue;
        const region=input.selected.find(s=>R.inside(f.geometry.coordinates,s.geometry))?.name;if(!region)continue;
        const key=`${access.node}:${kind}`,weight=kind==="transport"?(airportWeights.get(f.id)??D.hubWeight(p)):D.population(p.capacity)||D.population(p["capacity:persons"])||(record.floor?clamp(record.floor/({work:45,education:12,errand:45,health:35,leisure:100,activity:80}[kind]||45),1,50000):({work:100,education:300,errand:20,health:100,leisure:40,activity:10})[kind]);
        if(!weight)continue;
        if(kind==="transport"){const same=[...facilities.values()].find(d=>d.kind===kind&&d.hubType===D.hubType(p)&&p.name&&d.name===p.name&&Math.hypot(d.point[0]-access.point[0],d.point[1]-access.point[1])<=150);
          if(same){same.weight=Math.max(same.weight,weight);continue;}}
        if(facilities.has(key))facilities.get(key).weight+=weight;
        else facilities.set(key,{...access,id:key,kind,hubType:D.hubType(p),region,coordinate:f.geometry.coordinates,weight,name:p.name||({work:"工作设施",education:"学校",errand:"商业设施",health:"医疗设施",leisure:"休闲设施",transport:"车站／机场",activity:"一般活动（用途未标建筑）"})[kind]});
      }
      for(const d of facilities.values()){let nearest=null,distance=800;
        for(const lot of this.parking){const delta=Math.hypot(lot.point[0]-d.point[0],lot.point[1]-d.point[1]);if(delta<distance){nearest=lot;distance=delta;}}
        if(nearest){d.parking=nearest;d.node=nearest.node;d.access=nearest.access;}
      }
      // Keep separate access points within the budget. Overflow groups cannot move another lot's demand here.
      let destinations=[...facilities.values()];
      for(let grid=250;destinations.length>1800&&grid<=1000000;grid*=2){const cells=new Map();for(const d of destinations){const key=`${d.region}:${d.kind}:${d.parking?.id||"none"}:${Math.floor(d.point[0]/grid)}:${Math.floor(d.point[1]/grid)}`;
        if(cells.has(key)){const old=cells.get(key);old.weight+=d.weight;old.name=`${D.PURPOSES[d.kind]}设施组`;}else cells.set(key,{...d});}destinations=[...cells.values()];}
      if(destinations.length>1800)throw Error("区域设施分区过多，请减少范围");
      const destinationCoverage=new Map(),coveredDestinations=new Set();
      const addPair=(home,destination,out,back)=>{
        const outward=path(graph,out,home.node,destination.node),ret=path(graph,back,home.node,destination.node,true),distance=out.meters.get(destination.node);
        if(!outward||!ret||distance<40||distance>800000)return;
        coveredDestinations.add(destination.id);this.pairs.push({home,destination,outward,back:ret,distance,cross:home.region!==destination.region,
          attraction:Math.sqrt(destination.weight)*distanceWeight(distance),duration:outward.reduce((n,id)=>n+graph.edges[id].line.length/graph.edges[id].speed,0)});
      };
      for(const home of homeSites){
        const out=tree(graph,home.node),back=tree(graph,home.node,true);
        const candidates=destinations.filter(d=>d.node!==home.node&&out.prev.has(d.node)&&back.prev.has(d.node)&&(out.meters.get(d.node)??0)>=40&&(out.meters.get(d.node)??Infinity)<=800000);
        for(const d of candidates){const old=destinationCoverage.get(d.id),cost=out.cost.get(d.node);
          if(!old||cost<old.cost||cost===old.cost&&home.id.localeCompare(old.home.id)<0)destinationCoverage.set(d.id,{home,destination:d,cost});}
        // Include nearby destinations of every purpose and remote regions, with actual road connectivity.
        const picked=new Map();
        for(const group of new Set(candidates.map(d=>`${d.region}:${d.kind}`))){
          const ds=candidates.filter(d=>`${d.region}:${d.kind}`===group).sort((a,b)=>(out.cost.get(a.node)/Math.sqrt(a.weight))-(out.cost.get(b.node)/Math.sqrt(b.weight))||a.id.localeCompare(b.id));
          for(const d of ds.slice(0,4))picked.set(d.id,d);
        }
        for(const destination of picked.values())addPair(home,destination,out,back);
      }
      // Sparse OD must still represent every reachable destination group, not
      // permanently discard all but four buildings of each use near a home.
      const missingByHome=new Map();for(const v of destinationCoverage.values())if(!coveredDestinations.has(v.destination.id)){
        if(!missingByHome.has(v.home))missingByHome.set(v.home,[]);missingByHome.get(v.home).push(v.destination);}
      for(const [home,missing] of missingByHome){const out=tree(graph,home.node),back=tree(graph,home.node,true);for(const d of missing)addPair(home,d,out,back);}
      for(const home of homeSites)home.participation=this.pairs.filter(p=>p.home===home).reduce((n,p)=>Math.max(n,distanceWeight(p.distance)),0);
      this.sites=[...homeSites,...destinations];
      this.basis={taggedResidents:input.population.total-unconnectedResidents,estimatedResidents:0,populationSites:input.population.zones.length,
        residentialSites:homeSites.length,poiSites:destinations.length,unknownBuildings:0,unconnected:0,unconnectedResidents,
        unservedHomes:homeSites.filter(h=>!this.pairs.some(p=>p.home===h)).length,
        unservedResidents:homeSites.filter(h=>!this.pairs.some(p=>p.home===h)).reduce((n,h)=>n+h.weight,0),
        totalResidents:input.population.total,populationRows:input.population.rows,populationConflicts:input.population.conflicts,
        missingPopulation:input.population.missing,limited:false,regional:true,crossPairs:this.pairs.filter(p=>p.cross).length};
      this.basis.residentialLand=housing.land;this.basis.coveredResidentialLand=housing.covered;this.basis.unknownResidentialLand=housing.unknown;
      this.basis.buildings=housing.buildings;this.basis.homeBuildings=housing.homeBuildings;this.basis.unknownBuildings=housing.unknownBuildings;
      this.basis.connectedBuildings=housing.connectedBuildings;this.basis.excludedBuildings=housing.excludedBuildings;this.basis.missingBuildingGeometry=housing.missingGeometry;
      this.basis.fallbackPopulationZones=housing.fallbackPopulationZones;
      this.basis.buildingAudit={footprintArea:housing.footprintArea,floorArea:housing.floorArea,populationFloorWeight:housing.populationFloorWeight,
        levelsTagged:housing.levelsTagged,heightInferred:housing.heightInferred,levelsDefault:housing.levelsDefault,pointFootprintAssumed:housing.pointFootprintAssumed,areas:housing.areaRows};
      this.basis.allocationNote=`全域读取 ${housing.buildings} 栋独立建筑，其中 ${housing.homeBuildings} 栋用于人口位置分配，${housing.connectedBuildings} 栋已接入道路；${housing.unknownBuildings} 栋用途未标，按一半楼面权重分配已有居民并作为一般活动地点，不声称已确认为住宅；${housing.excludedBuildings} 栋为停用、部件或不产生常规人员活动的建筑，${housing.missingGeometry} 栋缺少完整范围。区域／小区人口代表整个范围，不集中到标签点。真实边界和孔洞优先；只有点标签时在真实上级范围内按邻近同级标签分配，没有固定半径截断，这仍是位置估算而非正式下级边界。建筑按占地与楼层分配原有已知人口，缺楼层按两层；不额外新增人口。有建筑时不重复叠加外围住宅用地。${housing.covered}／${housing.land} 处住宅用地作为建筑的分配背景或缺建筑时的回退。${housing.fallbackPopulationZones} 个人口分区未有可用建筑或住宅用地，按本范围合法住宅／服务道路长度粗略分配；未接路份额不挪给其他建筑。人口归组最多 512 处、设施最多 1800 组，空间合并保留全部权重，不能保证逐栋同时有车。${facilities.size} 处设施接入保留为 ${destinations.length} 组，已有不同停车场归属不互相挪用。未知人口、无道路及无往返行程分别保留说明。`;
      this.basis.parkingNote=`采用 ${this.parking.length} 处已标停车场，其中 ${this.parking.filter(p=>p.estimated).length} 处缺少容量，暂按每处 20 位假设；开场占用 50%，无真实入口时以道路节点估算接入。${this.parking.filter(p=>p.spots.length).length} 处具备真实相连内部路及露天面，可显示进场、示意泊位停留与出场，示意入位不代表真实车位布局；缺少连接或仅有点位时不虚构入口。目的地 800 米内选择最近可用停车场，入场默认 300 辆／小时；不是实际车位余量。无已标停车场的目的地保留场外停留，不声称已停车。`;
      this.basis.transportNote=`已接入 ${destinations.filter(d=>d.kind==="transport").length} 组客运车站／机场；读取明确类型、容量或年旅客量，无数据时车站吸引力 5000、机场 12000、停留 20 分钟为假设。机场主体与其航站楼分配同一吸引力，站台和重复站点不重复放大；未接入实际车次／航班。内部路只作首末段，需求仍来自所在人口分区。`;
      this.schedule(options.startHour??8);
    }
    summary(){const s=super.summary(),total=this.total||1;
      return {...s,nearbyShare:this.pairs.filter(p=>p.distance<=25000).reduce((n,p)=>n+p.hourly,0)/total,
        remoteShare:this.pairs.filter(p=>p.distance>100000).reduce((n,p)=>n+p.hourly,0)/total,
        distanceNote:"本地／周边优先：94% 的 7 公里衰减与 6% 的 45 公里长途尾部混合；同距离跨行政边界不额外惩罚，只有远处设施时减少出发，均为未校准假设。"};
    }
  }
  class RegionalSimulation {
    constructor(graph,options){
      this.graph=graph;this.project=C.projection(graph.center);this.input=options.regionalInput;this.demand=new RegionalDemand(graph,this.input,options);this.startHour=options.startHour??8;
      this.time=0;this.generated=0;this.accumulator=0;this.networkRevision=0;this.sourceTimes=this.input.sourceTimes;this.viewBudget=options.count||600;
      this.paused=false;this.selected=null;this.seed=options.seed||12345;this.serial=0;this.cars=[];this.completed=0;this.arrived=0;this.returned=0;
      this.roadSamples=new Map();this.stock=new Float64Array(graph.edges.length);this.backlog=new Float64Array(graph.edges.length);
      this.capacity=graph.edges.map(e=>e.lanes*(/motorway/.test(e.highway)?2000:/trunk/.test(e.highway)?1700:/primary/.test(e.highway)?1400:/secondary/.test(e.highway)?1200:/tertiary/.test(e.highway)?1000:450)/3600);
      this.storage=graph.edges.map(e=>Math.max(1,e.line.length*e.lanes/7));
      this.parking=new Map(this.demand.parking.map(lot=>[lot.id,{...lot,occupied:lot.capacity*0.5,waiting:0,displayEntries:0,visual:new Map()}]));
      const parkingTrips=new Set(this.demand.pairs.map(p=>p.destination.parking?.id));
      this.parkingEntrances=[...this.parking.values()].filter(p=>p.spots.length&&parkingTrips.has(p.id)).slice(0,6).map(p=>({name:p.name,coordinate:p.access}));
      this.buffers=Array.from({length:5},()=>new Float64Array(graph.edges.length));this.actualRatio=this.buffers[4];this.statsRevision=0;this.configure();
      for(const e of graph.edges){
        const n=this.stock[e.id]=Math.min(this.storage[e.id]*0.45,(this.demand.flows.get(e.id)||0)/3600*e.line.length/e.speed),free=Math.max(1,e.line.length/e.speed);
        this.actualRatio[e.id]=n?clamp(this.capacity[e.id]*free/Math.max(n,this.capacity[e.id]*free),0.02,1):1;
      }
      this.sampleRoads();this.populate();
    }
    random(){this.seed=(1664525*this.seed+1013904223)>>>0;return this.seed/4294967296;}
    configure(){
      this.demand.schedule(this.startHour+this.time/3600,this.time);this.inject=new Float64Array(this.graph.edges.length);this.turns=new Map();this.sinks=new Map();
      this.parkingSinks=new Map();this.parkingReturns=new Map();
      for(const p of this.demand.pairs)for(const [ids,flow,returning] of [[p.outward,p.hourly,false],[p.back,p.returnHourly,true]]){
        if(returning&&p.destination.parking){const lot=p.destination.parking;
          if(!this.parkingReturns.has(lot.id))this.parkingReturns.set(lot.id,new Map());const m=this.parkingReturns.get(lot.id);m.set(ids[0],(m.get(ids[0])||0)+flow/3600);
        }else this.inject[ids[0]]+=flow/3600;
        for(let i=0;i<ids.length;i++){const id=ids[i],next=ids[i+1]??-1;
          if(!this.turns.has(id))this.turns.set(id,new Map());const m=this.turns.get(id);m.set(next,(m.get(next)||0)+flow);
          if(next===-1){const s=this.sinks.get(id)||{out:0,back:0};s[returning?"back":"out"]+=flow;this.sinks.set(id,s);
            if(!returning&&p.destination.parking){if(!this.parkingSinks.has(id))this.parkingSinks.set(id,new Map());const m=this.parkingSinks.get(id),key=p.destination.parking.id;m.set(key,(m.get(key)||0)+flow);}
          }
        }
      }
      for(const m of this.turns.values()){const sum=[...m.values()].reduce((n,v)=>n+v,0);for(const [id,v] of m)m.set(id,v/(sum||1));}
      this.rows=this.graph.edges.filter(e=>this.turns.has(e.id)).map(e=>{
        const sink=this.sinks.get(e.id),total=(sink?.out||0)+(sink?.back||0)||1;
        return {e,id:e.id,turns:[...this.turns.get(e.id)],out:(sink?.out||0)/total,back:(sink?.back||0)/total,
          parking:[...(this.parkingSinks.get(e.id)||[])].map(([id,flow])=>[this.parking.get(id),flow/total]),free:Math.max(1,e.line.length/e.speed)};
      });
      this.returnPlans=[...this.parkingReturns].map(([id,m])=>({lot:this.parking.get(id),edges:[...m],total:[...m.values()].reduce((n,v)=>n+v,0)}));
      this.demandState=this.demand.summary();this.statsCache=null;
      this.networkRevision++;
    }
    populate(){
      // A small, explicit sample of the assumed opening occupancy; no extra aggregate cars.
      for(const lot of this.parking.values()){
        if(!lot.spots.length||lot.occupied<1||this.cars.length>=1800)continue;
        const pair=this.demand.pairs.find(p=>p.destination.parking?.id===lot.id&&p.hourly>0);if(!pair)continue;
        const car={id:++this.serial,pair,route:pair.outward,edge:pair.outward.at(-1),index:pair.outward.length-1,s:0,v:0,phase:"edge",returning:false,queueSeconds:0,waitFor:0};
        if(this.startParking(car,lot,true))this.cars.push(car);
      }
      for(let i=this.cars.length;i<1800&&this.demand.pairs.length;i++){const car=this.create(true);if(!car)continue;
      const lot=this.parking.get(car.pair.destination.parking?.id);
      if(!car.returning&&lot?.renderable&&lot.visual.size<Math.min(2,Math.floor(lot.occupied))&&this.random()<0.15&&this.startParking(car,lot,true)){}
      this.cars.push(car);
    }}
    startParking(car,lot,initial=false){
      const edge=this.graph.edges[car.pair.outward.at(-1)],back=this.graph.edges[car.pair.back[0]];
      car.lane=Math.min(car.lane||0,edge.lanes-1);car.exitLane=C.nextLane(edge,back,car.lane);
      const end=C.sample(edge.line,edge.end,C.laneOffset(edge,car.lane)),exit=C.sample(back.line,back.start,C.laneOffset(back,car.exitLane));
      const within=(a,b)=>R.segmentInside(this.project.lngLat(a),this.project.lngLat(b),lot.area);
      const index=lot.spots.findIndex((s,i)=>!lot.visual.has(i)&&within([end.x,end.y],s.point)&&within(s.point,[exit.x,exit.y]));
      if(index<0||!initial&&(lot.displayEntries<1||lot.visual.size>=Math.floor(lot.occupied)))return false;
      if(!initial)lot.displayEntries-=1;
      car.spot=lot.spots[index];car.spotIndex=index;car.lot=lot;lot.visual.set(index,car.id);car.exitPoint=[exit.x,exit.y];
      car.returning=false;car.route=car.pair.outward;car.index=car.route.length-1;car.edge=car.route[car.index];car.s=edge.line.length;car.v=initial?0:2;
      car.departAt=this.time+D.DWELL[car.pair.destination.kind]*60*(initial?0.5:1);
      if(initial)car.phase="dwell";else {car.phase="parking";car.maneuver={from:[end.x,end.y],to:car.spot.point,s:0,length:Math.hypot(car.spot.point[0]-end.x,car.spot.point[1]-end.y)};}
      return true;
    }
    releaseSpot(car){if(car.lot)car.lot.visual.delete(car.spotIndex);car.spot=null;car.lot=null;}
    create(initial=false){const returning=this.random()<this.demand.returnTotal/(this.demand.returnTotal+this.demand.total||1),pair=this.demand.choose(this.random(),returning?"return":"outward");if(!pair)return null;
      const route=returning?pair.back:pair.outward,car={id:++this.serial,pair,route,index:0,edge:route[0],s:0,v:0,phase:"edge",returning,queueSeconds:0,waitFor:0};
      if(initial){let remaining=this.random()*route.reduce((n,id)=>n+this.graph.edges[id].line.length,0);while(car.index<route.length-1&&remaining>this.graph.edges[route[car.index]].line.length)remaining-=this.graph.edges[route[car.index++]].line.length;car.edge=route[car.index];car.s=remaining;}
      car.lane=car.id%this.graph.edges[car.edge].lanes;
      return car;
    }
    advance(seconds){if(this.paused)return;this.accumulator+=Math.max(0,Math.min(seconds,0.25));while(this.accumulator>=0.2-1e-9){this.step(0.2);this.accumulator-=0.2;}}
    step(dt){
      this.time+=dt;if(Math.floor((this.time-dt)/300)!==Math.floor(this.time/300))this.configure();
      const edges=this.graph.edges,[outputs,receiving,requested,delta]=this.buffers;
      outputs.fill(0);receiving.fill(0);requested.fill(0);delta.fill(0);
      for(const {lot,edges:returns,total} of this.returnPlans){const wanted=total*dt,release=Math.min(lot.occupied,wanted);lot.occupied-=release;
        for(const [edge,flow] of returns)this.backlog[edge]+=wanted?release*flow*dt/wanted:0;}
      const parkingRequests=new Map();
      for(const r of this.rows){const {e,id}=r;receiving[id]=Math.max(0,this.storage[id]-this.stock[id]);
        outputs[id]=Math.min(this.stock[id],this.stock[id]/r.free*dt,this.capacity[id]*dt);
        for(const [next,fraction] of r.turns)if(next>=0)requested[next]+=outputs[id]*fraction;
        const sink=r.turns.find(([next])=>next===-1)?.[1]||0;
        for(const [lot,share] of r.parking)parkingRequests.set(lot,(parkingRequests.get(lot)||0)+outputs[id]*sink*share);
      }
      for(const r of this.rows){const {e,id}=r;let accepted=0;
        for(const [next,fraction] of r.turns){let acceptedFraction=1;
          if(next<0){
            for(const [lot,share] of r.parking){const ratio=Math.min(1,Math.max(0,lot.capacity-lot.occupied)/(parkingRequests.get(lot)||1),(300/3600*dt)/(parkingRequests.get(lot)||1));acceptedFraction-=share*(1-ratio);}
          }
          const amount=outputs[id]*fraction*(next<0?acceptedFraction:Math.min(1,receiving[next]/(requested[next]||1)));
          accepted+=amount;if(next>=0)delta[next]+=amount;else {this.arrived+=amount*r.out;this.returned+=amount*r.back;}}
        delta[id]-=accepted;
        this.actualRatio[id]=this.stock[id]>0.01?clamp(accepted/dt/this.stock[id]*e.line.length/e.speed,0,1):1;
      }
      for(const [lot,requested] of parkingRequests){const entered=Math.min(requested,Math.max(0,lot.capacity-lot.occupied),300/3600*dt);lot.occupied+=entered;lot.displayEntries=Math.min(lot.capacity,lot.displayEntries+entered);}
      for(const {id} of this.rows){this.stock[id]=Math.max(0,this.stock[id]+delta[id]);this.backlog[id]+=this.inject[id]*dt;this.generated+=this.inject[id]*dt;
        const add=Math.min(this.backlog[id],Math.max(0,this.storage[id]-this.stock[id]));this.stock[id]+=add;this.backlog[id]-=add;
      }
      if(Math.floor(this.time)!==Math.floor(this.time-dt))this.sampleRoads();
      for(let i=0;i<this.cars.length;i++){
        const c=this.cars[i];
        if(c.phase==="turn"){
          c.v=Math.min(5,c.v+1.5*dt);c.s+=c.v*dt;
          if(c.s>=c.turn.length){c.index++;c.edge=c.route[c.index];c.lane=c.targetLane;c.s=0;c.phase="edge";c.waitFor=c.turnWait||0;}
          continue;
        }
        if(c.phase==="parking"||c.phase==="unparking"){
          c.maneuver.s=Math.min(c.maneuver.length,c.maneuver.s+dt*2);c.v=2;
          if(c.maneuver.s>=c.maneuver.length){if(c.phase==="parking"){c.phase="dwell";c.v=0;c.departAt=this.time+D.DWELL[c.pair.destination.kind]*60;}
            else {c.phase="edge";this.releaseSpot(c);}}
          continue;
        }
        if(c.phase==="dwell"){if(this.time<c.departAt)continue;c.returning=true;c.route=c.pair.back;c.index=0;c.edge=c.route[0];c.lane=c.exitLane??c.id%edges[c.edge].lanes;c.s=0;c.phase="edge";
          if(c.spot){c.phase="unparking";c.maneuver={from:c.spot.point,to:c.exitPoint,s:0,length:Math.hypot(c.spot.point[0]-c.exitPoint[0],c.spot.point[1]-c.exitPoint[1])};continue;}}
        const e=edges[c.edge],state=this.roadSamples.get(e.id),ratio=state?.ratio??1;
        if(c.waitFor>0){c.waitFor=Math.max(0,c.waitFor-dt);c.v=0;c.queueSeconds+=dt;continue;}
        const lot=!c.returning&&c.pair.destination.parking&&this.parking.get(c.pair.destination.parking.id);
        if(c.index===c.route.length-1&&e.line.length-c.s<8&&lot&&(lot.renderable&&lot.spots.length?
          lot.displayEntries<1||lot.visual.size>=Math.floor(lot.occupied):lot.capacity-lot.occupied<0.5)){c.v=0;c.queueSeconds+=dt;continue;}
        c.v=Math.min(e.speed*clamp(ratio,0.04,1),c.v+1.5*dt);c.s+=c.v*dt;
        if(c.s>=e.line.length){if(c.index<c.route.length-1){
            const next=edges[c.route[c.index+1]];c.targetLane=C.nextLane(e,next,c.lane);
            c.turn=C.turnPath(e,next,c.lane,c.targetLane);c.phase="turn";c.s=0;c.v=Math.min(c.v,5);
            // Queue delay comes from aggregate density/capacity, never invented signal timing.
            c.turnWait=Math.min(120,(1-ratio)*15);}
          else if(!c.returning){if(lot?.renderable&&lot.spots.length){if(!this.startParking(c,lot)){c.s=e.line.length-1;c.v=0;c.queueSeconds+=dt;}}
            else {c.phase="dwell";c.v=0;c.departAt=this.time+D.DWELL[c.pair.destination.kind]*60;}}
          else this.cars[i]=this.create()||c;
        }
      }
      const groups=new Map();
      for(const c of this.cars){c.hiddenSample=false;if(c.phase!=="edge")continue;const key=`${c.edge}:${c.lane||0}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
      for(const cars of groups.values()){cars.sort((a,b)=>b.s-a.s||a.id-b.id);let front=Infinity;
        for(const c of cars){const e=edges[c.edge],limit=front-7*e.line.length/e.length;if(c.s>limit){if(limit<0){c.hiddenSample=true;continue;}c.s=limit;c.v=0;c.queueSeconds+=dt;}front=c.s;}}
    }
    sampleRoads(){let moving=0,waiting=0;this.roadSamples.clear();this.statsCache=null;this.statsRevision++;
      for(const lot of this.parking.values())lot.waiting=0;
      for(const e of this.graph.edges){const n=this.stock[e.id],free=Math.max(1,e.line.length/e.speed),ratio=this.actualRatio?.[e.id]??(n?clamp(this.capacity[e.id]*free/Math.max(n,this.capacity[e.id]*free),0.02,1):1);
        const queue=Math.max(0,n*(1-ratio));moving+=n;waiting+=queue;
        const total=this.demand.flows.get(e.id)||1;for(const [id,flow] of this.parkingSinks.get(e.id)||[])this.parking.get(id).waiting+=queue*flow/total;
        if(n>0.01)this.roadSamples.set(e.id,{id:e.id,count:n,ratio,waiting:queue});}
      this.moving=moving;this.waiting=waiting;
    }
    setCount(n){this.viewBudget=clamp(Number(n)||600,24,1200);}
    setViewport(b){
      if(!Array.isArray(b)||b.length!==4||b.some(n=>!Number.isFinite(n))||b[2]-b[0]>0.12||b[3]-b[1]>0.12)return;
      const project=C.projection(this.graph.center),within=p=>p[0]>=b[0]&&p[0]<=b[2]&&p[1]>=b[1]&&p[1]<=b[3],candidates=[];
      this.cars=this.cars.filter(c=>{const keep=!c.focus||c.id===this.selected;if(!keep)this.releaseSpot(c);return keep;});
      for(const pair of this.demand.pairs)for(const returning of [false,true]){
        const route=returning?pair.back:pair.outward,weight=returning?pair.returnHourly:pair.hourly;if(weight<0.01)continue;
        for(let index=0;index<route.length;index++){const e=this.graph.edges[route[index]];
          if(!e.line.points.some(p=>within(project.lngLat(p))))continue;
          candidates.push({pair,returning,route,index,edge:e.id,weight:weight*Math.min(e.line.length,500)});
        }
      }
      let total=0;for(const c of candidates){total+=c.weight;c.cumulative=total;}
      const occupied=new Map();
      for(let i=0;i<1200&&total;i++){
        const pick=this.random()*total;let lo=0,hi=candidates.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(candidates[mid].cumulative<pick)lo=mid+1;else hi=mid;}
        const q=candidates[lo],e=this.graph.edges[q.edge],s=this.random()*e.line.length,lane=i%e.lanes;
        if(!within(project.lngLat([C.sample(e.line,s).x,C.sample(e.line,s).y])))continue;
        const key=`${e.id}:${lane}`,positions=occupied.get(key)||[];if(positions.some(p=>Math.abs(p-s)<8))continue;positions.push(s);occupied.set(key,positions);
        this.cars.push({...q,id:++this.serial,lane,s,v:0,phase:"edge",queueSeconds:0,waitFor:0,focus:true});
      }
    }
    network(){return C.Simulation.prototype.network.call({...this,project:C.projection(this.graph.center)});}
    selectedRoute(){return C.Simulation.prototype.selectedRoute.call({...this,graph:this.graph});}
    snapshot(){const project=this.project,vehicles=this.cars.map(c=>{const e=this.graph.edges[c.edge],next=c.phase==="turn"?this.graph.edges[c.route[c.index+1]]:null;let p=c.phase==="turn"?C.sample(c.turn,c.s):C.sample(e.line,e.start+Math.min(c.s/e.line.length,1)*(e.end-e.start),C.laneOffset(e,c.lane));
      if(c.phase==="dwell"&&c.spot)p={x:c.spot.point[0],y:c.spot.point[1],angle:c.spot.angle};
      else if(c.phase==="parking"||c.phase==="unparking"){const m=c.maneuver,t=m.length?m.s/m.length:1;p={x:m.from[0]+(m.to[0]-m.from[0])*t,y:m.from[1]+(m.to[1]-m.from[1])*t,angle:Math.atan2(m.to[1]-m.from[1],m.to[0]-m.from[0])};}
      return {
        id:c.id,coordinate:project.lngLat([p.x,p.y]),angle:p.angle,speed:c.v*3.6,road:e.name,elevated:e.elevated,hiddenSample:c.hiddenSample,waiting:c.waitFor>0||c.v<0.5,phase:c.phase,returning:c.returning,
        roadId:e.roadId,roadWidth:e.laneSpec.width,tunnel:e.tunnel,nextRoadId:next?.roadId,nextElevated:next?.elevated,nextTunnel:next?.tunnel,turnProgress:next?clamp(c.s/c.turn.length,0,1):0,
        lane:(c.lane||0)+1,lanes:e.lanes,laneSource:e.laneSpec.source,
        purpose:D.PURPOSES[c.pair.destination.kind],origin:c.returning?c.pair.destination.name:c.pair.home.name,destination:c.returning?c.pair.home.name:c.pair.destination.name,
        parked:Boolean(c.spot&&c.phase==="dwell"),parking:!!c.spot,parkingName:c.lot?.name,distance:c.pair.distance,queueSeconds:c.queueSeconds,dwellRemaining:c.phase==="dwell"?Math.max(0,c.departAt-this.time):0};});
      if(!this.statsCache){const hotspots=[...this.roadSamples.values()].filter(s=>s.waiting>2).sort((a,b)=>b.waiting-a.waiting).slice(0,8).map(s=>{
        const e=this.graph.edges[s.id];return {name:e.name,waiting:Math.round(s.waiting),speed:Math.round(e.speed*s.ratio*3.6),coordinate:project.lngLat(e.line.points.at(-1))};});
      this.statsCache={hotspots,pending:Math.round(this.backlog.reduce((n,v)=>n+v,0)),
        parking:{capacity:[...this.parking.values()].reduce((n,p)=>n+p.capacity,0),occupied:Math.round([...this.parking.values()].reduce((n,p)=>n+p.occupied,0)),
          waiting:Math.round([...this.parking.values()].reduce((n,p)=>n+p.waiting,0)),lots:this.parking.size,entrances:this.parkingEntrances,
          hotspots:[...this.parking.values()].sort((a,b)=>b.waiting-a.waiting||Number(b.spots.length>0)-Number(a.spots.length>0)).slice(0,6).map(p=>({name:p.name,occupied:Math.round(p.occupied),capacity:p.capacity,waiting:Math.round(p.waiting),coordinate:p.access,renderable:p.spots.length>0}))}};}
      return {regional:true,time:this.time,clockHour:(this.startHour+this.time/3600)%24,edges:this.graph.edges.length,nodes:this.graph.nodes.size,structures:this.graph.structures,demand:this.demandState,...this.statsCache,
        moving:Math.round(this.moving||0),waiting:Math.round(this.waiting||0),arrived:Math.floor(this.arrived),returned:Math.floor(this.returned),dwelling:vehicles.filter(c=>c.phase==="dwell").length,
        sampleCount:vehicles.length,capacityLimited:false,viewBudget:this.viewBudget,statsRevision:this.statsRevision,
        networkRevision:this.networkRevision,sourceTimes:this.sourceTimes,vehicles,regionNames:this.input.selected.map(s=>s.name),bounds:this.input.bounds};
    }
  }
  root.HuayuRegionalTraffic=Object.freeze({RegionalDemand,RegionalSimulation,tree,path,distanceWeight,buildGraph,residentialAccesses});
})(globalThis);
