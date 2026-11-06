(function installTrafficCore(root) {
  "use strict";
  const STEP = 0.05, GAP = 7, RADIUS = 850;
  const TYPES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lerp = (a, b, t) => a + (b - a) * t;
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
    return {x: lerp(a[0], b[0], t) + dy * offset, y: lerp(a[1], b[1], t) - dx * offset, angle: Math.atan2(dy, dx)};
  }
  function allowed(p,regional=false) {
    // An explicit car-specific permission overrides a general access tag.
    const access = p.motorcar || p.motor_vehicle || p.vehicle || p.access || "yes";
    return TYPES.has(p.highway) && !["no", "private", "agricultural", "forestry"].includes(access)
      && (regional || !Number(p.bridge) && !Number(p.tunnel) && !(Number(p.layer) || 0));
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
      const flush = () => {if (run.length >= 2) ways.push({p, key, run}); run = [];};
      for (let i = 0; i < ids.length; i++) {
        if (Math.hypot(...points[i]) > radius) {flush(); continue;}
        if (run.length && distance(run.at(-1).point, points[i]) < 0.1) continue;
        run.push({id: String(ids[i]), point: points[i]});
      }
      flush();
      if (ways.length >= maxWays) break;
    }
    if(options.regional){
      const layers=new Map();
      for(const w of ways)for(let i=0;i<w.run.length;i++){
        const n=w.run[i],level=Number(w.p.layer)||0;
        if(!layers.has(n.id))layers.set(n.id,{levels:new Set(),end:false});
        const v=layers.get(n.id);v.levels.add(level);v.end ||= i===0||i===w.run.length-1;
      }
      // Continuous roads crossing at different layers remain separate; actual endpoints can join ramps.
      for(const w of ways)for(const n of w.run){const v=layers.get(n.id);if(v.levels.size>1&&!v.end)n.id+=`@${Number(w.p.layer)||0}`;}
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
      const width = Number.parseFloat(w.p.width) || Number(w.p.lanes) * 3.1 || 6;
      const e = {id: edges.length,segment:`${w.key}:${[from.id,to.id].sort().join(":")}`, from: from.id, to: to.id, line, speed: speed(w.p), name: String(w.p.name || w.p.highway),
        highway:w.p.highway,service:w.p.service||"",internal:/^(service|living_street)$/.test(w.p.highway),accessOnly:/^(service|living_street)$/.test(w.p.highway)||w.p.access==="destination",
        elevated:Boolean(Number(w.p.layer)||w.p.bridge&&w.p.bridge!=="no"||w.p.tunnel&&w.p.tunnel!=="no"),
        lanes:clamp(Math.floor(Number(w.p[reverse?"lanes:backward":"lanes:forward"])||Number(w.p.lanes)/(bidirectional?2:1)||1),1,6),
        motorway: /^(motorway|trunk)/.test(w.p.highway), offset: bidirectional ? Math.min(1.6, Math.max(0.8, width / 4)) * (options.drivingSide === "left" ? -1 : 1) : 0};
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
    return {center, radius, nodes, edges,regional:Boolean(options.regional)};
  }
  function turnPath(incoming, outgoing) {
    const a = sample(incoming.line, incoming.end, incoming.offset), b = sample(outgoing.line, outgoing.start, outgoing.offset);
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) * 0.55);
    const p = [a.x + Math.cos(a.angle) * d, a.y + Math.sin(a.angle) * d];
    const q = [b.x - Math.cos(b.angle) * d, b.y - Math.sin(b.angle) * d];
    const points = [];
    for (let i = 0; i <= 20; i++) {const t = i / 20, u = 1 - t;
      points.push([u*u*u*a.x + 3*u*u*t*p[0] + 3*u*t*t*q[0] + t*t*t*b.x,
        u*u*u*a.y + 3*u*u*t*p[1] + 3*u*t*t*q[1] + t*t*t*b.y]);}
    return path(points);
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
    available(edge, position, except) {
      return this.cars.every(c => c === except || c.phase !== "edge" || c.edge !== edge || Math.abs(c.s - position) >= GAP + 2);
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
        if(!this.available(car.edge,car.s)||[...this.locks.values()].some(l=>l.out===car.edge))continue;
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
        .filter(c => !this.cars.some(other => other !== c && other.phase === "edge" && other.edge === c.edge && other.s > c.s))
        .sort((a, b) => (a.wait ?? this.time) - (b.wait ?? this.time) || a.id - b.id);
      for (const c of waiting) {
        c.wait ??= this.time;
        const e = this.graph.edges[c.edge];
        if (!this.locks.has(e.to) && this.available(c.next, 0, c)) this.locks.set(e.to, {car: c.id, out: c.next});
      }
      const occupancy = new Map();
      for (const c of this.cars) if (c.phase === "edge") {if (!occupancy.has(c.edge)) occupancy.set(c.edge, []); occupancy.get(c.edge).push(c);}
      for (const group of occupancy.values()) group.sort((a,b) => b.s - a.s);
      const remove = new Set();
      // Front to rear updates use the preceding vehicle's new position, preserving minimum gaps.
      const ordered = [...this.cars].sort((a,b) => a.edge - b.edge || b.s - a.s);
      for (const c of ordered) {
        c.age += STEP;
        if(c.phase==="dwell") {
          if(this.time>=c.departAt) {
            const first=c.pair.back[0];
            if(this.available(first,0,c)&&![...this.locks.values()].some(l=>l.out===first)) {
              c.returning=true;c.route=c.pair.back;c.index=0;c.edge=first;c.s=0;c.next=c.route[1]??null;c.v=0;c.phase="edge";c.wait=null;
            }
          }
          continue;
        }
        const e = this.graph.edges[c.edge];
        if (c.phase === "turn") {
          c.v = Math.min(5, c.v + STEP * 1.5); c.s += c.v * STEP;
          if (c.s >= c.turn.length) {c.edge = c.next; c.s = 0; c.phase = "edge"; c.release = e.to;c.index++; c.next = c.route?.[c.index+1]??null; c.wait = null;}
          continue;
        }
        if (c.release && c.s >= Math.min(GAP,e.length*0.4)) {if (this.locks.get(c.release)?.car === c.id) this.locks.delete(c.release); c.release = null;}
        const group = occupancy.get(c.edge), ahead = group?.findLast(other => other.phase === "edge" && other.edge === c.edge && other.s > c.s && other !== c);
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
          else if (owned && this.available(c.next, 0, c)) {
            if (c.release && this.locks.get(c.release)?.car === c.id) this.locks.delete(c.release);
            c.release = null;c.turn = turnPath(e, this.graph.edges[c.next]); c.phase = "turn"; c.s = 0; c.v = Math.min(c.v,5);
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
        if(!segments.has(e.segment))segments.set(e.segment,{id:e.id,ids:[],name:e.name,coordinates:e.line.points.map(this.project.lngLat),hourly:0});
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
      return {time: this.time,clockHour:(this.startHour+this.time/3600)%24,completed: this.completed, edges: this.graph.edges.length, nodes: this.graph.nodes.size,
        demand:this.demand.summary(),arrived:this.arrived,returned:this.returned,dwelling:this.cars.length-moving.length,moving:moving.length,
        pending:Math.floor(this.departureCredit)+this.historyPending+Math.floor(this.returnCredit),capacityLimited:this.cars.length>=600,viewBudget:this.viewBudget,
        waiting:moving.filter(c=>c.v<0.5&&c.queueSeconds>2).length,networkRevision:this.networkRevision,sourceTimes:this.sourceTimes,
        vehicles: this.cars.map(c => {
          const e = this.graph.edges[c.edge], p = c.phase === "turn" ? sample(c.turn, c.s) : sample(e.line, e.start + c.s, e.offset);
          return {id: c.id,coordinate: this.project.lngLat([p.x,p.y]),angle:p.angle,speed:c.v*3.6,road:e.name,waiting:c.phase!=="dwell"&&c.v<0.5,
            phase:c.phase,returning:c.returning,purpose:root.HuayuTrafficDemand.PURPOSES[c.pair?.destination.kind]||"行驶",
            origin:c.pair?(c.returning?c.pair.destination.name:c.pair.home.name):"",destination:c.pair?(c.returning?c.pair.home.name:c.pair.destination.name):"",
            distance:c.pair?.distance||0,queueSeconds:c.queueSeconds,dwellRemaining:c.phase==="dwell"?Math.max(0,c.departAt-this.time):0};
        })};
    }
  }
  root.HuayuTrafficCore = Object.freeze({buildGraph, Simulation, projection, sample, turnPath, STEP, GAP, RADIUS});
})(globalThis);
