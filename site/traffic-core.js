(function installTrafficCore(root) {
  "use strict";
  const STEP = 0.05, GAP = 7, RADIUS = 850;
  const TYPES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lerp = (a, b, t) => a + (b - a) * t;
  // Simulation estimates only: never write inferred lanes back to OGF or navigation.
  function laneSpec(p, bidirectional, drivingSide = "right", reverse = false) {
    const count = value => /^\d+$/.test(String(value ?? "")) && Number(value) <= 24 ? Number(value) : null;
    const total = count(p.lanes), f = count(p["lanes:forward"]), b = count(p["lanes:backward"]), sharedTurn = count(p["lanes:both_ways"]) || 0;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet)?\s*$/i.exec(String(p.width || ""));
    const parsedWidth = match ? Number(match[1]) * (/^(ft|feet)$/i.test(match[2]) ? 0.3048 : 1) : 0;
    const width = parsedWidth >= 2 && parsedWidth <= 80 ? parsedWidth : 0;
    const defaults = p.highway === "trunk" ? (bidirectional ? 8 : 4)
      : p.highway === "primary" ? (bidirectional ? 6 : 3)
      : p.highway === "motorway" ? (bidirectional ? 4 : 3)
      : /_link$/.test(p.highway) || /^(service|living_street)$/.test(p.highway) ? 1 : 2;
    const explicit = total > 0 || f !== null || b !== null;
    let n = total > 0 ? total : f !== null || b !== null ? (f || 0) + (b || 0) + sharedTurn
      : width ? Math.max(1, Math.floor(width / 3)) : defaults;
    if(!bidirectional&&(reverse?b:f)!==null)n=reverse?b:f;
    if(!n&&explicit)return {forward:0,backward:0,forwardOffsets:[],backwardOffsets:[]};
    n = clamp(n, 1, 24);
    const shared = bidirectional && n === 1 && !(f > 0 || b > 0);
    let forward, backward, middle = Math.min(sharedTurn, Math.max(0,n-2));
    if(bidirectional&&f!==null&&b!==null&&total>f+b&&!sharedTurn)middle=total-f-b;
    if (!bidirectional) {forward = n; backward = 0; middle = 0;}
    else if (shared) {forward = backward = 1; middle = 0;}
    else {
      forward = f ?? (b !== null ? Math.max(1,n-middle-b) : Math.ceil((n-middle)/2));
      backward = b ?? Math.max(1,n-middle-forward);
      n = forward + backward + middle;
    }
    const laneWidth = width ? width / (shared ? 1 : n) : /^(service|living_street)$/.test(p.highway) ? (shared ? 4.4 : 2.8)
      : /^(residential|unclassified)$/.test(p.highway) ? 3 : 3.2;
    const side = drivingSide === "left" ? -1 : 1;
    const offsets = (number, opposite) => Array.from({length:number},(_,i) => shared ? side*(width||4.4)/4
      : side * (bidirectional ? opposite + middle - n/2 + i + 0.5 : i - (n-1)/2) * laneWidth);
    return {forward,backward,middle,shared,total:n,width:width || laneWidth * (shared ? 1 : n),laneWidth,
      source:explicit?"tag":width?"width":"class",forwardOffsets:offsets(forward,backward),backwardOffsets:offsets(backward,forward)};
  }
  const laneOffset = (edge, lane = 0) => edge.laneOffsets?.[clamp(lane || 0,0,edge.lanes-1)] ?? edge.offset;
  const nextLane = (incoming, outgoing, lane = 0) => clamp(Math.round(((lane || 0)+0.5) * outgoing.lanes / incoming.lanes - 0.5),0,outgoing.lanes-1);
  function projection(center) {
    const sx = 111320 * Math.cos(center[1] * Math.PI / 180), sy = 111320;
    return {xy: p => [(p[0] - center[0]) * sx, (p[1] - center[1]) * sy],
      lngLat: p => [center[0] + p[0] / sx, center[1] + p[1] / sy]};
  }
  function path(points) {
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    return {points, cumulative, length: cumulative.at(-1)};
  }
  function sample(line, s, offset = 0) {
    s = clamp(s, 0, line.length);
    let lo = 1, hi = line.points.length - 1;
    while (lo < hi) {const mid = (lo + hi) >> 1; if (line.cumulative[mid] < s) lo = mid + 1; else hi = mid;}
    const a = line.points[lo - 1], b = line.points[lo], length = line.cumulative[lo] - line.cumulative[lo - 1];
    const t = length ? (s - line.cumulative[lo - 1]) / length : 0;
    const dx = (b[0] - a[0]) / (length || 1), dy = (b[1] - a[1]) / (length || 1);
    // Bounded miter offsets keep adjacent segments and cars continuous at bends.
    const normal = i => {
      if(i<=0||i>=line.points.length-1)return [dy,-dx];
      const before=line.points[i-1],at=line.points[i],after=line.points[i+1];
      const la=distance(before,at)||1,lb=distance(at,after)||1;
      const ax=(at[1]-before[1])/la,ay=-(at[0]-before[0])/la,bx=(after[1]-at[1])/lb,by=-(after[0]-at[0])/lb;
      const den=1+ax*bx+ay*by;
      return den>0.25?[(ax+bx)/den,(ay+by)/den]:[bx,by];
    };
    const na=offset?normal(lo-1):[0,0],nb=offset?normal(lo):[0,0];
    const vx=b[0]-a[0]+offset*(nb[0]-na[0]),vy=b[1]-a[1]+offset*(nb[1]-na[1]);
    return {x: lerp(a[0], b[0], t) + lerp(na[0],nb[0],t)*offset,
      y: lerp(a[1], b[1], t) + lerp(na[1],nb[1],t)*offset, angle: Math.atan2(vy,vx)};
  }
  const marked = value => value !== undefined && value !== null && !["", "no", "0", "false"].includes(String(value).toLowerCase());
  function roadLevel(p) {
    const explicit = p.layerExplicit ?? (p.layer !== undefined && p.layer !== "");
    return explicit && Number.isFinite(Number(p.layer)) ? Number(p.layer) : marked(p.tunnel) ? -1 : marked(p.bridge) ? 1 : 0;
  }
  function allowed(p) {
    // An explicit car-specific permission overrides a general access tag.
    const access = p.motorcar || p.motor_vehicle || p.vehicle || p.access || "yes";
    return TYPES.has(p.highway) && !["no", "private", "agricultural", "forestry"].includes(access);
  }
  function speed(p) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kph)?\s*$/i.exec(String(p.maxspeed || ""));
    const kph = m ? Number(m[1]) * (m[2]?.toLowerCase() === "mph" ? 1.609344 : 1)
      : p.highway === "living_street" ? 15 : p.highway === "service" ? 20 : /motorway|trunk/.test(p.highway) ? 70 : 40;
    return clamp(kph / 3.6, 1.4, 30);
  }
  function buildGraph(features, options = {}) {
    const center = options.center || [0, 0], radius = options.regional ? 2000000 : clamp(options.radius || RADIUS, 100, 1500);
    const maxWays=options.regional?40000:3000,maxEdges=options.regional?160000:6000;
    const project = projection(center), ways = [], seen = new Set(), uses = new Map();
    // Work only on supplied, bounded, already loaded road data. Never snap nearby nodes.
    for (const f of features || []) {
      const p = f.properties || {}, coords = f.geometry?.coordinates, ids = p.roadNodes;
      if (f.geometry?.type !== "LineString" || !allowed(p,options.regional) || !ids?.length || ids.length !== coords.length) continue;
      const key = String(f.id || p.osmId);
      if (seen.has(key)) continue;
      seen.add(key);
      const points = coords.map(project.xy);
      if (!points.every(v => v.every(Number.isFinite)) || !ids.every(v => v !== null && String(v))) continue;
      // Clip at actual nodes; crossing the local boundary never invents a connection.
      let run = [];
      const endpoints = new Set([String(ids[0]),String(ids.at(-1))]);
      const flush = () => {if (run.length >= 2) ways.push({p, key, run, endpoints}); run = [];};
      for (let i = 0; i < ids.length; i++) {
        if (Math.hypot(...points[i]) > radius) {flush(); continue;}
        if (run.length && distance(run.at(-1).point, points[i]) < 0.1) continue;
        run.push({id: String(ids[i]), point: points[i]});
      }
      flush();
      if (ways.length >= maxWays) break;
    }
    {
      const layers=new Map();
      for(const w of ways)for(let i=0;i<w.run.length;i++){
        const n=w.run[i],level=roadLevel(w.p);
        if(!layers.has(n.id))layers.set(n.id,{levels:new Set(),end:false});
        const v=layers.get(n.id);v.levels.add(level);v.end ||= w.endpoints.has(n.id);
      }
      // Continuous roads crossing at different layers remain separate; actual endpoints can join ramps.
      for(const w of ways)for(const n of w.run){const v=layers.get(n.id);if(v.levels.size>1&&!v.end)n.id+=`@${roadLevel(w.p)}`;}
    }
    for (const w of ways) for (const n of w.run) uses.set(n.id, (uses.get(n.id) || 0) + 1);
    const nodes = new Map(), edges = [];
    const node = n => {if (!nodes.has(n.id)) nodes.set(n.id, {id: n.id, point: n.point, out: [], degree: 0}); return nodes.get(n.id);};
    const add = (w, run, reverse, bidirectional) => {
      if (edges.length >= maxEdges) {if(options.regional)throw Error("区域道路分段超过 160000，请减少范围");return;}
      if (reverse) run = [...run].reverse();
      const line = path(run.map(n => n.point));
      if (line.length < 3) return;
      const from = node(run[0]), to = node(run.at(-1));
      if (from.id === to.id && line.length < 15) return;
      const spec = laneSpec(w.p,bidirectional,options.drivingSide,reverse);
      const laneOffsets = reverse && bidirectional ? spec.backwardOffsets : spec.forwardOffsets;
      if(!laneOffsets.length)return;
      const e = {id: edges.length,segment:`${w.key}:${[from.id,to.id].sort().join(":")}`, from: from.id, to: to.id, line, speed: speed(w.p), name: String(w.p.name || w.p.highway),
        highway:w.p.highway,service:w.p.service||"",internal:/^(service|living_street)$/.test(w.p.highway),accessOnly:/^(service|living_street)$/.test(w.p.highway)||w.p.access==="destination",
        roadId:String(w.p.osmId??w.key),layer:roadLevel(w.p),bridge:marked(w.p.bridge)||roadLevel(w.p)>0,tunnel:marked(w.p.tunnel)||roadLevel(w.p)<0,
        elevated:Boolean(roadLevel(w.p)||marked(w.p.bridge)||marked(w.p.tunnel)),
        lanes:laneOffsets.length,laneOffsets,laneSpec:spec,bidirectional,reverse,
        motorway: /^(motorway|trunk)/.test(w.p.highway), offset:laneOffsets[0]};
      edges.push(e); from.out.push(e.id); from.degree++; to.degree++;
    };
    for (const w of ways) {
      const one = String(w.p.oneway || "").toLowerCase();
      const reverse = one === "-1" || one === "reverse";
      const forward = ["yes", "1", "true"].includes(one) || (!one && (w.p.junction === "roundabout" || w.p.highway === "motorway"));
      let start = 0;
      for (let i = 1; i < w.run.length; i++) if (i === w.run.length - 1 || uses.get(w.run[i].id) > 1 || options.accessNodes?.has(w.run[i].id)) {
        const run = w.run.slice(start, i + 1);
        add(w, run, reverse, !forward && !reverse);
        if (!forward && !reverse) add(w, run, true, true);
        start = i;
      }
    }
    for (const e of edges) {
      e.start = nodes.get(e.from).degree > 2 ? Math.min(7, e.line.length * 0.2) : Math.min(3, e.line.length * 0.15);
      e.end = e.line.length - (nodes.get(e.to).degree > 2 ? Math.min(7, e.line.length * 0.2) : Math.min(3, e.line.length * 0.15));
      e.length = e.end - e.start;
      e.next = nodes.get(e.to).out.filter(id => edges[id].to !== e.from);
    }
    const physical=new Map(edges.map(e=>[e.segment,e]));
    const structures={bridges:[...physical.values()].filter(e=>e.bridge&&!e.tunnel).length,tunnels:[...physical.values()].filter(e=>e.tunnel).length};
    return {center, radius, nodes, edges,structures,regional:Boolean(options.regional)};
  }
  function turnPath(incoming, outgoing, lane = 0, targetLane = nextLane(incoming,outgoing,lane)) {
    const a = sample(incoming.line, incoming.end, laneOffset(incoming,lane)), b = sample(outgoing.line, outgoing.start, laneOffset(outgoing,targetLane));
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) * 0.55);
    const p = [a.x + Math.cos(a.angle) * d, a.y + Math.sin(a.angle) * d];
    const q = [b.x - Math.cos(b.angle) * d, b.y - Math.sin(b.angle) * d];
    const points = [];
    for (let i = 0; i <= 20; i++) {const t = i / 20, u = 1 - t;
      points.push([u*u*u*a.x + 3*u*u*t*p[0] + 3*u*t*t*q[0] + t*t*t*b.x,
        u*u*u*a.y + 3*u*u*t*p[1] + 3*u*t*t*q[1] + t*t*t*b.y]);}
    return path(points);
  }
  function laneGeometry(graph, bounds) {
    const project=projection(graph.center),features=[],seen=new Set(),deferred=[];let vertices=0,roads=0,estimated=0,limited=false;
    if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3])return {features,roads,estimated,limited};
    const [west,south]=project.xy(bounds.slice(0,2)),[east,north]=project.xy(bounds.slice(2));
    // Clip in metres before serialization; a long regional road cannot upload its whole way.
    const clip=(a,b)=>{
      let lo=0,hi=1;const dx=b[0]-a[0],dy=b[1]-a[1];
      for(const [p,q] of [[-dx,a[0]-west],[dx,east-a[0]],[-dy,a[1]-south],[dy,north-a[1]]]){
        if(!p){if(q<0)return null;continue;}const t=q/p;
        if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return null;
      }
      return [[lerp(a[0],b[0],lo),lerp(a[1],b[1],lo)],[lerp(a[0],b[0],hi),lerp(a[1],b[1],hi)]];
    };
    const clipped=points=>{const parts=[];let part=[];
      for(let i=1;i<points.length;i++){const pair=clip(points[i-1],points[i]);
        if(!pair){if(part.length)parts.push(part);part=[];continue;}
        if(part.length&&distance(part.at(-1),pair[0])>0.01){parts.push(part);part=[];}
        if(!part.length)part.push(pair[0]);part.push(pair[1]);
      }if(part.length)parts.push(part);return parts;
    };
    const candidates=[],cx=(west+east)/2,cy=(south+north)/2;
    for(const e of graph.edges){
      if(seen.has(e.segment))continue;seen.add(e.segment);
      const roadParts=clipped(e.line.points);if(!roadParts.length)continue;
      if(e.elevated){
        // A 2-D lane line here would put a bridge or an underground road on
        // the ground. Keep its measured lane allocation available to the UI;
        // accepted bridge plans are drawn by traffic-surfaces at deck height,
        // while tunnels remain simulation-only until a real underground
        // surface is available.
        if(deferred.length<1200)deferred.push({roadId:e.roadId,name:e.name,lanes:e.laneSpec.total,laneSource:e.laneSpec.source,bridge:e.bridge,tunnel:e.tunnel,elevated:true});
        else limited=true;
        continue;
      }
      let closest=Infinity;
      for(const part of roadParts)for(let i=1;i<part.length;i++){
        const a=part[i-1],b=part[i],dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((cx-a[0])*dx+(cy-a[1])*dy)/(dx*dx+dy*dy||1),0,1);
        closest=Math.min(closest,(a[0]+t*dx-cx)**2+(a[1]+t*dy-cy)**2);
      }
      candidates.push({e,closest});
    }
    candidates.sort((a,b)=>a.closest-b.closest||a.e.id-b.e.id);
    for(const {e} of candidates){
      const spec=e.laneSpec,scale=1/(156543.033928*Math.cos(graph.center[1]*Math.PI/180)),batch=[];
      const add=(points,kind,width)=>{const parts=clipped(points);if(parts.length)batch.push({type:"Feature",properties:{kind,pixels0:width*scale,estimated:spec.source!=="tag"},geometry:{type:"MultiLineString",coordinates:parts.map(part=>part.map(project.lngLat))}});};
      add(e.line.points,"surface",spec.width);
      const stations=[e.start,...e.line.cumulative.slice(1,-1).filter(s=>s>e.start&&s<e.end),e.end];
      const mark=(offset,kind)=>add(stations.map(s=>{const p=sample(e.line,s,offset);return [p.x,p.y];}),kind,kind==="center"?0.15:0.12);
      mark(-spec.width/2+0.15,"edge");mark(spec.width/2-0.15,"edge");
      const own=e.laneOffsets;
      for(let i=1;i<own.length;i++)mark((own[i-1]+own[i])/2,"divider");
      if(e.bidirectional&&!spec.shared){
        const opposite=(e.reverse?spec.forwardOffsets:spec.backwardOffsets).map(v=>-v);
        for(let i=1;i<opposite.length;i++)mark((opposite[i-1]+opposite[i])/2,"divider");
        const inner=own[0],other=opposite[0];
        if(opposite.length){
          if(spec.middle){mark(inner-Math.sign(inner-other)*spec.laneWidth/2,"center");mark(other+Math.sign(inner-other)*spec.laneWidth/2,"center");}
          else mark((inner+other)/2,"center");
        }
      }
      const size=batch.reduce((n,f)=>n+f.geometry.coordinates.reduce((n,p)=>n+p.length,0),0);
      if(roads>=1200||vertices+size>80000){limited=true;break;}
      vertices+=size;roads++;if(spec.source!=="tag")estimated++;features.push(...batch);
    }
    return {features,roads,estimated,limited,vertices,deferred, deferredElevated:deferred.filter(e=>e.bridge&&!e.tunnel).length, deferredTunnel:deferred.filter(e=>e.tunnel).length};
  }
  class Simulation {
    constructor(graph, options = {}) {
      this.graph = graph; this.cars = []; this.locks = new Map(); this.time = 0; this.serial = 0;
      this.seed = options.seed || 12345; this.viewBudget = clamp(options.count ?? 240, 24, 1200); this.paused = false; this.completed = 0;
      this.project = projection(graph.center); this.accumulator = 0;
      this.startHour=Number.isFinite(options.startHour)?options.startHour:8;
      this.demand=new root.HuayuTrafficDemand.Demand(graph,options.demandFeatures||[],options);
      this.departureCredit=0;this.returnCredit=0;this.pending=0;this.arrived=0;this.returned=0;this.selected=null;this.scheduleBucket=-1;
      this.historyBacklog=new Map();this.historyPending=0;
      this.sourceTimes=options.sourceTimes||[];this.roadSamples=new Map();this.networkRevision=0;
      this.fill(true);
    }
    random() {this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296;}
    available(edge, position, except, lane = 0) {
      return this.cars.every(c => c === except || c.phase !== "edge" || c.edge !== edge || (c.lane||0)!==lane || Math.abs(c.s - position) >= GAP + 2)
        && ![...this.locks.values()].some(l=>l.car!==except?.id&&l.out===edge&&(l.lane||0)===lane&&position<GAP+2);
    }
    chooseLane(edge, position, id, except) {
      const n=this.graph.edges[edge].lanes;
      for(let i=0;i<n;i++){const lane=(id+i)%n;if(this.available(edge,position,except,lane))return lane;}
      return null;
    }
    fill(initial = false) {
      const outboundVolume=this.demand.total*this.demand.meanDuration,returnVolume=this.demand.returnTotal*this.demand.returnDuration;
      const wanted=initial?Math.min(240,Math.ceil((outboundVolume+returnVolume)/3600)):Math.floor(this.departureCredit)+this.historyPending;
      for(let i=0;i<Math.min(initial?240:120,wanted)&&this.cars.length<600;i++) {
        const returning=initial?this.random()<returnVolume/(outboundVolume+returnVolume||1)
          :this.historyPending>0&&(this.departureCredit<1||this.random()<this.historyPending/(this.historyPending+this.departureCredit));
        let pair;
        if(returning&&!initial){let n=this.random()*this.historyPending;for(const [p,count] of this.historyBacklog){n-=count;if(n<0){pair=p;break;}}}
        else pair=this.demand.choose(this.random(),returning?"return":"outward");
        if(!pair)continue;
        const ids=returning?pair.back:pair.outward;
        const car={id:++this.serial,pair,route:ids,index:0,returning,phase:"edge",s:0,v:0,wait:null,age:0,queueSeconds:0};
        if(initial){
          let remaining=this.random()*ids.reduce((n,id)=>n+this.graph.edges[id].length,0);
          while(car.index<ids.length-1&&remaining>this.graph.edges[ids[car.index]].length)remaining-=this.graph.edges[ids[car.index++]].length;
          car.s=Math.min(remaining,Math.max(0,this.graph.edges[ids[car.index]].length-12));
        }
        car.edge=ids[car.index];car.next=ids[car.index+1]??null;
        car.lane=this.chooseLane(car.edge,car.s,car.id);
        if(car.lane===null)continue;
        this.cars.push(car);if(!initial){if(returning){const remaining=this.historyBacklog.get(pair)-1;
          if(remaining)this.historyBacklog.set(pair,remaining);else this.historyBacklog.delete(pair);this.historyPending--;
        }else this.departureCredit=Math.max(0,this.departureCredit-1);}
      }
    }
    setCount(count) {this.viewBudget = clamp(Number(count) || 240, 24, 1200);}
    advance(seconds) {
      if (this.paused) return;
      this.accumulator += clamp(seconds, 0, 0.25);
      while (this.accumulator + 1e-9 >= STEP) {this.step(); this.accumulator -= STEP;}
    }
    step() {
      this.time += STEP;
      const bucket=`${Math.floor((this.startHour*3600+this.time)/300)}:${Math.floor(this.time/300)}`;
      if(bucket!==this.scheduleBucket){this.scheduleBucket=bucket;this.demand.schedule(this.startHour+this.time/3600,this.time);this.networkRevision++;}
      this.departureCredit+=this.demand.total/3600*STEP;
      this.returnCredit+=this.demand.historyTotal/3600*STEP;
      // FIFO reservations serialize conflicting movements. These are simulated yields, not real signals.
      const waiting = this.cars.filter(c => c.phase === "edge" && c.next !== null && this.graph.edges[c.edge].length - c.s < 25)
        .filter(c => !this.cars.some(other => other !== c && other.phase === "edge" && other.edge === c.edge && (other.lane||0)===(c.lane||0) && other.s > c.s))
        .sort((a, b) => (a.wait ?? this.time) - (b.wait ?? this.time) || a.id - b.id);
      for (const c of waiting) {
        c.wait ??= this.time;
        const e = this.graph.edges[c.edge];
        const lane=nextLane(e,this.graph.edges[c.next],c.lane);
        if (!this.locks.has(e.to) && this.available(c.next, 0, c,lane)) this.locks.set(e.to, {car: c.id, out: c.next,lane});
      }
      const occupancy = new Map();
      for (const c of this.cars) if (c.phase === "edge") {const key=`${c.edge}:${c.lane||0}`;if (!occupancy.has(key)) occupancy.set(key, []); occupancy.get(key).push(c);}
      for (const group of occupancy.values()) group.sort((a,b) => b.s - a.s);
      const remove = new Set();
      // Front to rear updates use the preceding vehicle's new position, preserving minimum gaps.
      const ordered = [...this.cars].sort((a,b) => a.edge - b.edge || b.s - a.s);
      for (const c of ordered) {
        c.age += STEP;
        if(c.phase==="dwell") {
          if(this.time>=c.departAt) {
            const first=c.pair.back[0];
            const lane=this.chooseLane(first,0,c.id,c);
            if(lane!==null) {
              c.returning=true;c.route=c.pair.back;c.index=0;c.edge=first;c.lane=lane;c.s=0;c.next=c.route[1]??null;c.v=0;c.phase="edge";c.wait=null;
            }
          }
          continue;
        }
        const e = this.graph.edges[c.edge];
        if (c.phase === "turn") {
          c.v = Math.min(5, c.v + STEP * 1.5); c.s += c.v * STEP;
          if (c.s >= c.turn.length) {c.edge = c.next;c.lane=c.targetLane;c.targetLane=null; c.s = 0; c.phase = "edge"; c.release = e.to;c.index++; c.next = c.route?.[c.index+1]??null; c.wait = null;}
          continue;
        }
        if (c.release && c.s >= Math.min(GAP,e.length*0.4)) {if (this.locks.get(c.release)?.car === c.id) this.locks.delete(c.release); c.release = null;}
        const group = occupancy.get(`${c.edge}:${c.lane||0}`), ahead = group?.findLast(other => other.phase === "edge" && other.edge === c.edge && other.s > c.s && other !== c);
        let room = ahead ? Math.max(0, ahead.s - c.s - GAP) : Infinity;
        const owned = this.locks.get(e.to)?.car === c.id;
        if (c.next !== null && !owned) room = Math.min(room, Math.max(0, e.length - c.s - GAP));
        let desired = Math.min(e.speed, Math.sqrt(2 * 2.5 * room));
        if (c.next !== null && e.length - c.s < 16) desired = Math.min(desired, 5);
        c.v = Math.max(0, Math.min(desired, c.v + 1.5 * STEP));
        c.s += Math.min(c.v * STEP, room);
        if(c.v<0.5)c.queueSeconds+=STEP;
        if (c.s >= e.length - 0.001) {
          if (c.next === null) {
            this.completed++;
            if(c.returning||!c.pair){remove.add(c);this.returned++;}
            else {
              this.arrived++;c.phase="dwell";c.v=0;c.wait=null;
              c.departAt=this.time+root.HuayuTrafficDemand.DWELL[c.pair.destination.kind]*60*(0.8+this.random()*0.4);
              for(const [id,l] of this.locks)if(l.car===c.id)this.locks.delete(id);c.release=null;
            }
          }
          else if (owned && this.available(c.next, 0, c,this.locks.get(e.to).lane||0)) {
            if (c.release && this.locks.get(c.release)?.car === c.id) this.locks.delete(c.release);
            c.release = null;c.targetLane=this.locks.get(e.to).lane||0;c.turn = turnPath(e, this.graph.edges[c.next],c.lane,c.targetLane); c.phase = "turn"; c.s = 0; c.v = Math.min(c.v,5);
          }
        }
        // Arrivals leave the road, dwell off street, and later return by a reachable route.
      }
      if (remove.size) {
        this.cars = this.cars.filter(c => !remove.has(c));
        for (const [id, l] of this.locks) if (!this.cars.some(c => c.id === l.car)) this.locks.delete(id);
      }
      if (Math.round(this.time / STEP) % 20 === 0) {
        // Returns from visits begun before this scenario are demand at a facility,
        // not cars wandering in from a random road. Preserve blocked trips by OD.
        for(let i=0;i<120&&this.returnCredit>=1;i++){
          const pair=this.demand.choose(this.random(),"history");if(!pair)break;
          this.historyBacklog.set(pair,(this.historyBacklog.get(pair)||0)+1);this.historyPending++;this.returnCredit--;
        }
        this.fill();this.sampleRoads();
      }
    }
    sampleRoads() {
      const groups=new Map();
      for(const c of this.cars)if(c.phase!=="dwell") {
        if(!groups.has(c.edge))groups.set(c.edge,[]);groups.get(c.edge).push(c);
      }
      this.roadSamples=new Map([...groups].map(([id,cars])=>[id,{id,count:cars.length,
        ratio:cars.reduce((n,c)=>n+c.v/this.graph.edges[id].speed,0)/cars.length,
        waiting:cars.filter(c=>c.v<0.5&&c.queueSeconds>2).length}]));
    }
    network() {
      const segments=new Map();
      for(const e of this.graph.edges){
        if(!segments.has(e.segment))segments.set(e.segment,{id:e.id,ids:[],name:e.name,roadId:e.roadId,bridge:e.bridge,tunnel:e.tunnel,elevated:e.elevated,coordinates:e.line.points.map(this.project.lngLat),hourly:0});
        const s=segments.get(e.segment);s.ids.push(e.id);s.hourly+=this.demand.flows.get(e.id)||0;
      }
      return [...segments.values()];
    }
    selectedRoute() {
      const c=this.cars.find(c=>c.id===this.selected);if(!c?.pair)return null;
      const origin=c.returning?c.pair.destination:c.pair.home,destination=c.returning?c.pair.home:c.pair.destination;
      return {id:c.id,returning:c.returning,origin:{name:origin.name,coordinate:origin.access},destination:{name:destination.name,coordinate:destination.access},
        coordinates:c.route.flatMap(id=>this.graph.edges[id].line.points.map(this.project.lngLat))};
    }
    snapshot() {
      const moving=this.cars.filter(c=>c.phase!=="dwell");
      return {time: this.time,clockHour:(this.startHour+this.time/3600)%24,completed: this.completed, edges: this.graph.edges.length, nodes: this.graph.nodes.size,structures:this.graph.structures,
        demand:this.demand.summary(),arrived:this.arrived,returned:this.returned,dwelling:this.cars.length-moving.length,moving:moving.length,
        pending:Math.floor(this.departureCredit)+this.historyPending+Math.floor(this.returnCredit),capacityLimited:this.cars.length>=600,viewBudget:this.viewBudget,
        waiting:moving.filter(c=>c.v<0.5&&c.queueSeconds>2).length,networkRevision:this.networkRevision,sourceTimes:this.sourceTimes,
        vehicles: this.cars.map(c => {
          const e = this.graph.edges[c.edge], next=c.phase==="turn"?this.graph.edges[c.next]:null,
            p = c.phase === "turn" ? sample(c.turn, c.s) : sample(e.line, e.start + c.s, laneOffset(e,c.lane));
          return {id: c.id,coordinate: this.project.lngLat([p.x,p.y]),angle:p.angle,speed:c.v*3.6,road:e.name,waiting:c.phase!=="dwell"&&c.v<0.5,
            roadId:e.roadId,roadWidth:e.laneSpec.width,elevated:e.elevated,tunnel:e.tunnel,nextRoadId:next?.roadId,nextElevated:next?.elevated,nextTunnel:next?.tunnel,turnProgress:next?clamp(c.s/c.turn.length,0,1):0,
            lane:(c.lane||0)+1,lanes:e.lanes,laneSource:e.laneSpec.source,
            phase:c.phase,returning:c.returning,purpose:root.HuayuTrafficDemand.PURPOSES[c.pair?.destination.kind]||"行驶",
            origin:c.pair?(c.returning?c.pair.destination.name:c.pair.home.name):"",destination:c.pair?(c.returning?c.pair.home.name:c.pair.destination.name):"",
            distance:c.pair?.distance||0,queueSeconds:c.queueSeconds,dwellRemaining:c.phase==="dwell"?Math.max(0,c.departAt-this.time):0};
        })};
    }
  }
  root.HuayuTrafficCore = Object.freeze({buildGraph, Simulation, projection, sample, turnPath, laneSpec, laneOffset, nextLane, laneGeometry, STEP, GAP, RADIUS});
})(globalThis);
