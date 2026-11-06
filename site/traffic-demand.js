(function installTrafficDemand(root) {
  "use strict";
  const PURPOSES = {work:"通勤",education:"上学",errand:"购物／办事",health:"就医",leisure:"休闲",transport:"车站／机场接送与换乘"};
  const DWELL = {work:480,education:360,errand:15,health:45,leisure:30,transport:20}; // Scenario minutes, not observed visits.
  const RESIDENTIAL = new Set(["apartments","residential","house","detached","terrace","dormitory","semidetached_house"]);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  function population(value,max=10000000) {
    const text=String(value ?? "").trim();
    if(!/^(?:\d+|\d{1,3}(?:[, ]\d{3})+)$/.test(text))return 0;
    const n=Number(text.replace(/[, ]/g,""));return n>0&&n<=max?n:0;
  }
  function category(p) {
    if(p.disused && p.disused!=="no" || p.abandoned && p.abandoned!=="no" || ["construction","proposed","demolished","ruins"].includes(p.building)
      || p["building:part"] || p.buildingPart || Number(p.minHeight)>0 || Number(p.level)>0)return null;
    if(hubType(p))return "transport";
    if(["school","university","college","kindergarten"].some(v=>v===p.amenity||v===p.building)||p.featureClass==="education")return "education";
    if(["hospital","clinic","doctors"].some(v=>v===p.amenity||v===p.building)||p.healthcare&&p.healthcare!=="no"||p.featureClass==="healthcare")return "health";
    if(p.building==="retail" || p.shop && !["no","vacant","closed"].includes(p.shop) || ["cafe","restaurant","fast_food","bank","marketplace","post_office"].includes(p.amenity))return "errand";
    if(["park","garden","sports_centre","stadium","playground"].includes(p.leisure) || ["park","sports"].includes(p.featureClass))return "leisure";
    if(p.office && p.office!=="no" || ["office","commercial","industrial","retail","warehouse"].includes(p.building))return "work";
    if(RESIDENTIAL.has(p.building))return "home";
    const land=p.landuse||p.featureClass;
    if(land==="residential")return "home";
    if(["commercial","industrial"].includes(land))return "work";
    if(land==="retail")return "errand";
    return null;
  }
  function hubType(p){
    if(p.disused&&p.disused!=="no"||p.abandoned&&p.abandoned!=="no"||p.construction&&p.construction!=="no"||p.proposed&&p.proposed!=="no"||p.access==="private"||p.access==="no")return null;
    if(["aerodrome","terminal"].includes(p.aeroway)&&p.aerodrome!=="military"&&p["aerodrome:type"]!=="military")return "air";
    if((p.railway==="station"||p.railway==="halt"||p.public_transport==="station"&&p.train==="yes")
      &&p.passenger!=="no"&&p.train!=="no"&&p.station!=="freight"&&p["railway:traffic_mode"]!=="freight"&&p.station!=="subway"&&p.subway!=="yes"&&p.light_rail!=="yes")return "rail";
    return null;
  }
  function hubWeight(p){return population(p.capacity)||population(p["capacity:persons"])||
    (population(p["passengers:annual"],2e9)||population(p.passengers,2e9))/365||(hubType(p)==="air"?12000:5000);}
  function rings(geometry) {return geometry?.type==="Polygon"?[geometry.coordinates]:geometry?.type==="MultiPolygon"?geometry.coordinates:[];}
  function contains(point,geometry) {
    const inside=ring=>{let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1]) && point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;
    }return yes;};
    return rings(geometry).some(poly=>inside(poly[0])&&!poly.slice(1).some(inside));
  }
  function measure(geometry,project) {
    const polys=rings(geometry);let area=0,x=0,y=0,vertices=0,maxRadius=0;
    for(const poly of polys)for(let h=0;h<poly.length;h++) {
      const ring=poly[h].map(project.xy);let sum=0;
      for(let i=1;i<ring.length;i++)sum+=ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1];
      area+=(h?-1:1)*Math.abs(sum)/2;
      if(!h)for(const p of ring.slice(0,-1)){x+=p[0];y+=p[1];vertices++;}
      for(const p of ring)maxRadius=Math.max(maxRadius,Math.hypot(...p));
    }
    if(geometry?.type==="Point") {
      const p=project.xy(geometry.coordinates);return {area:0,coordinate:geometry.coordinates,point:p,maxRadius:Math.hypot(...p)};
    }
    if(!vertices||!Number.isFinite(area))return null;
    // This is an estimated road access location, never a claimed building entrance.
    const point=[x/vertices,y/vertices];return {area:Math.max(0,area),point,coordinate:project.lngLat(point),maxRadius};
  }
  function prepareSites(features,graph,options={}) {
    const project=root.HuayuTrafficCore.projection(graph.center),unique=new Map(),nonPassenger=new Set(options.nonPassengerStationIds||[]);
    const basis={taggedResidents:0,estimatedResidents:0,populationSites:0,residentialSites:0,poiSites:0,
      unconnected:0,outside:0,omitted:0,unknownBuildings:0,limited:false};
    // Raw records win over derived render features of the same source object.
    for(const f of features||[]) {
      const p=f.properties||{},key=`${p.osmType||""}:${p.osmId||f.id}`;
      if(!unique.has(key)||p.trafficRaw)unique.set(key,f);
    }
    const candidates=[],residentialLand=[...unique.values()].filter(f=>f.properties?.landuse==="residential");
    for(const [id,f] of unique) {
      const p=f.properties||{};let kind=category(p);
      if(kind==="transport"&&p.osmType==="node"&&nonPassenger.has(Number(p.osmId)))continue;
      if(!kind&&p.building==="yes"&&!p.buildingPart&&!p["building:part"]&&!p.disused&&!p.abandoned) {
        const location=measure(f.geometry,project);
        if(location&&residentialLand.some(land=>contains(location.coordinate,land.geometry)))kind="home";
      }
      if(!kind){if(p.building==="yes")basis.unknownBuildings++;continue;}
      const m=measure(f.geometry,project);if(!m)continue;
      // Never allocate a whole city's/place point population to this neighbourhood.
      if(m.maxRadius>graph.radius||p.place){basis.outside++;continue;}
      const land=Boolean(p.landuse||p.renderKind==="land"),tagged=kind==="home"&&m.area>0?(population(p.population)||population(p["population:hx"])):0;
      const levels=clamp(Number(p["building:levels"])||((p.heightSource==="levels"||p.heightSource==="tagged")?Math.round(Number(p.height)/3):2)||2,1,60);
      const residents=kind==="home"?(tagged||m.area*levels*0.8*(land?0.25:1)/35):0;
      if(kind==="home"&&residents<=0)continue;
      const scale={work:45,education:12,errand:45,health:35,leisure:100}[kind]||35;
      const weight=kind==="home"?residents:clamp(kind==="transport"?hubWeight(p):population(p.capacity)||population(p["capacity:persons"])||m.area*(land?0.25:1)/scale||10,1,kind==="transport"?20000:5000);
      candidates.push({id,kind,name:String(p.name||({home:"住宅",work:"工作区",education:"教育设施",errand:"商业设施",health:"医疗设施",leisure:"休闲设施",transport:"车站／机场"}[kind])),
        ...m,geometry:f.geometry,land,tagged,weight,memberIds:p.trafficMembers||[],explicit:Boolean(p.trafficRaw)});
    }
    const memberIds=new Set(candidates.filter(s=>s.memberIds.length).flatMap(s=>s.memberIds));
    // Suppress member ways, outer land envelopes and duplicate POI points; keep holes.
    const sites=candidates.filter(s=>!memberIds.has(s.id)).filter(s=>!candidates.some(o=>o!==s&&o.kind===s.kind
      && (s.land&&!o.land&&contains(o.coordinate,s.geometry)
        || !s.area&&o.area>0&&contains(s.coordinate,o.geometry))));
    const accessNodes=[...graph.nodes.values()].filter(n=>n.out.some(id=>!graph.edges[id].motorway));
    const result=[];
    // Fixed spatial ordering rather than input arrival order; quotas keep both origins and destinations.
    for(const s of sites.sort((a,b)=>a.id.localeCompare(b.id))) {
      if(result.filter(r=>r.kind===s.kind).length>=(s.kind==="home"?128:32)){basis.limited=true;continue;}
      let near=null,d=150;
      for(const n of accessNodes){const delta=Math.hypot(n.point[0]-s.point[0],n.point[1]-s.point[1]);if(delta<d){near=n;d=delta;}}
      if(!near){basis.unconnected++;continue;}
      s.node=near.id;s.access=project.lngLat(near.point);s.accessDistance=d;result.push(s);
      if(s.kind==="home"){
        basis.residentialSites++;if(s.tagged){basis.taggedResidents+=s.weight;basis.populationSites++;}else basis.estimatedResidents+=s.weight;
      }else basis.poiSites++;
    }
    basis.omitted=Math.max(0,candidates.length-result.length-basis.unconnected);
    basis.taggedResidents=Math.round(basis.taggedResidents);basis.estimatedResidents=Math.round(basis.estimatedResidents);
    return {sites:result,basis};
  }
  function shortestPaths(graph,start) {
    const cost=new Map([[start,0]]),meters=new Map([[start,0]]),prev=new Map(),heap=[];
    const push=(id,d)=>{let i=heap.length;heap.push([id,d]);while(i){const j=(i-1)>>1;if(heap[j][1]<=d)break;heap[i]=heap[j];i=j;}heap[i]=[id,d];};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][1]<heap[j][1])j++;if(last[1]<=heap[j][1])break;heap[i]=heap[j];i=j;}heap[i]=last;}return first;};
    push(start,0);
    while(heap.length) {
      const [id,d]=pop();if(d!==cost.get(id)||d>1800)continue;
      for(const ei of graph.nodes.get(id)?.out||[]) {
        const e=graph.edges[ei],penalty=e.highway==="service"?8:e.highway==="living_street"?4:e.highway==="residential"?1.4:1;
        const next=d+e.line.length/e.speed*penalty+2;
        if(next<(cost.get(e.to)??Infinity)) {cost.set(e.to,next);prev.set(e.to,ei);meters.set(e.to,meters.get(id)+e.line.length);push(e.to,next);}
      }
    }
    return {cost,meters,prev};
  }
  function route(tree,graph,start,end) {
    if(start===end||!tree.prev.has(end))return null;
    const path=[];let id=end;
    while(id!==start&&path.length<=graph.edges.length) {const e=graph.edges[tree.prev.get(id)];if(!e)return null;path.push(e.id);id=e.from;}
    return id===start?path.reverse():null;
  }
  const peak=(h,at,width)=>Math.exp(-0.5*((h-at)/width)**2);
  function activity(kind,hour) {
    if(kind==="transport")return 0.18+1.2*peak(hour,7.8,1.6)+1.3*peak(hour,18,2)+0.35*peak(hour,12,2.5);
    if(kind==="work")return 0.05+1.4*peak(hour,8,1.4)+0.2*peak(hour,14,2);
    if(kind==="education")return 0.01+1.5*peak(hour,7.6,0.8)+0.15*peak(hour,13,0.7);
    if(kind==="errand")return 0.02+0.7*peak(hour,12,2)+peak(hour,18,2.2);
    if(kind==="health")return 0.04+0.7*peak(hour,10,2)+0.4*peak(hour,15,1.5);
    return 0.02+0.5*peak(hour,11,2)+peak(hour,18,2.5);
  }
  class Demand {
    constructor(graph,features,options={}) {
      this.graph=graph;Object.assign(this,prepareSites(features,graph,options));this.pairs=[];this.multiplier=clamp(Number(options.demandFactor)||1,0.25,8);
      this.basis.limited ||= Boolean(options.trafficInputLimited);
      const trees=new Map(),getTree=id=>{if(!trees.has(id))trees.set(id,shortestPaths(graph,id));return trees.get(id);};
      for(const home of this.sites.filter(s=>s.kind==="home")) {
        const tree=getTree(home.node);
        for(const destination of this.sites.filter(s=>s.kind!=="home")) {
          if(home.node===destination.node)continue;
          const distance=tree.meters.get(destination.node);if(!(distance>=40&&distance<=3000))continue;
          const outward=route(tree,graph,home.node,destination.node),back=route(getTree(destination.node),graph,destination.node,home.node);
          if(!outward||!back)continue;
          // Dijkstra is node based; reject any route requiring an immediate reverse/U-turn.
          if([outward,back].some(ids=>ids.some((id,i)=>i&&graph.edges[id].to===graph.edges[ids[i-1]].from)))continue;
          this.pairs.push({home,destination,outward,back,distance,attraction:Math.sqrt(destination.weight)*Math.exp(-distance/650),
            duration:outward.reduce((n,id)=>n+graph.edges[id].length/graph.edges[id].speed+3,0)});
        }
      }
      this.basis.unservedHomes=this.sites.filter(s=>s.kind==="home"&&!this.pairs.some(p=>p.home===s)).length;
      this.schedule(options.startHour??8);
    }
    schedule(hour,elapsed=0) {
      this.hour=((hour%24)+24)%24;
      const shifts=new Map([0,...Object.values(DWELL)].map(minutes=>[minutes,{sums:new Map(),intensities:new Map()}]));
      for(const [minutes,group] of shifts)for(const p of this.pairs) {
        const h=((this.hour-minutes/60)%24+24)%24,a=activity(p.destination.kind,h);
        group.sums.set(p.home.id,(group.sums.get(p.home.id)||0)+p.attraction*a);
        group.intensities.set(p.home.id,Math.max(group.intensities.get(p.home.id)||0,a));
      }
      const volume=(p,minutes)=>{const group=shifts.get(minutes),h=((this.hour-minutes/60)%24+24)%24;
        return p.home.weight*(p.home.participation??1)*0.22*Math.min(1.6,group.intensities.get(p.home.id)||0)*0.35/1.4*this.multiplier
          *p.attraction*activity(p.destination.kind,h)/(group.sums.get(p.home.id)||1);};
      this.total=0;this.returnTotal=0;this.historyTotal=0;this.flows=new Map();this.meanDuration=0;this.returnDuration=0;
      for(const p of this.pairs) {
        // Assumptions: base 0.22 departures/person/hour, 35% car share, 1.4 occupants/car.
        p.hourly=volume(p,0);p.returnHourly=volume(p,DWELL[p.destination.kind]);
        this.total+=p.hourly;p.cumulative=this.total;this.meanDuration+=p.hourly*p.duration;
        this.returnTotal+=p.returnHourly;p.returnCumulative=this.returnTotal;
        p.historical=elapsed<DWELL[p.destination.kind]*60?p.returnHourly:0;
        this.historyTotal+=p.historical;p.historyCumulative=this.historyTotal;
        const backDuration=p.back.reduce((n,id)=>n+this.graph.edges[id].length/this.graph.edges[id].speed+3,0);
        this.returnDuration+=p.returnHourly*backDuration;
        for(const id of p.outward)this.flows.set(id,(this.flows.get(id)||0)+p.hourly);
        for(const id of p.back)this.flows.set(id,(this.flows.get(id)||0)+p.returnHourly);
      }
      this.meanDuration/=this.total||1;this.returnDuration/=this.returnTotal||1;
    }
    choose(random,mode="outward") {
      const field=mode==="history"?"historyCumulative":mode==="return"?"returnCumulative":"cumulative";
      const total=mode==="history"?this.historyTotal:mode==="return"?this.returnTotal:this.total;
      if(total<=0)return null;const n=random*total;return this.pairs.find(p=>p[field]>n)||null;
    }
    summary() {return {...this.basis,sites:this.sites.length,pairs:this.pairs.length,hourly:this.total,returnHourly:this.returnTotal,personHourly:this.total*1.4/0.35,
      multiplier:this.multiplier,carShare:0.35,occupancy:1.4,squareMetersPerResident:35};}
  }
  root.HuayuTrafficDemand=Object.freeze({Demand,prepareSites,shortestPaths,route,activity,category,population,hubType,hubWeight,PURPOSES,DWELL});
})(globalThis);
