(function installTrafficRegions(root) {
  "use strict";
  const VERSION="8.0-traffic-population-v2", URL="https://overpass.opengeofiction.net/api/interpreter";
  const LIMITS={regions:4,ways:40000,vertices:350000,objects:60000,bytes:32*1024*1024};
  const rings=g=>g?.type==="Polygon"?[g.coordinates]:g?.type==="MultiPolygon"?g.coordinates:[];
  function inside(p,g) {
    const ring=r=>{let v=false;for(let i=0,j=r.length-1;i<r.length;j=i++)if((r[i][1]>p[1])!==(r[j][1]>p[1])&&p[0]<(r[j][0]-r[i][0])*(p[1]-r[i][1])/(r[j][1]-r[i][1])+r[i][0])v=!v;return v;};
    return rings(g).some(r=>ring(r[0])&&!r.slice(1).some(ring));
  }
  function segmentInside(a,b,g){
    if(!inside(a,g)||!inside(b,g))return false;
    const dx=b[0]-a[0],dy=b[1]-a[1];
    for(const poly of rings(g))for(const ring of poly)for(let i=1;i<ring.length;i++){
      const c=ring[i-1],d=ring[i],ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;
      if(!den)continue;
      const cx=c[0]-a[0],cy=c[1]-a[1],t=(cx*ey-cy*ex)/den,u=(cx*dy-cy*dx)/den;
      if(t>0&&t<1&&u>=0&&u<=1)return false;
    }
    return true;
  }
  function bounds(g) {const p=rings(g).flat(2);return [Math.min(...p.map(p=>p[0])),Math.min(...p.map(p=>p[1])),Math.max(...p.map(p=>p[0])),Math.max(...p.map(p=>p[1]))];}
  function anchor(g) {const b=bounds(g),p=[(b[0]+b[2])/2,(b[1]+b[3])/2];return inside(p,g)?p:rings(g)[0][0][0];}
  function feature(e){
    let area=null;
    if(e.type==="way"&&e.geometry){
      if(e.geometry.some(p=>!p||!Number.isFinite(p.lon)||!Number.isFinite(p.lat))||e.nodes?.length!==e.geometry.length)throw Error("设施范围几何不完整");
      if(e.nodes[0]===e.nodes.at(-1)&&e.nodes.length>=4)area={type:"Polygon",coordinates:[e.geometry.map(p=>[p.lon,p.lat])]};
    }else if(e.type==="relation"&&e.tags?.type==="multipolygon"&&e.members?.some(m=>m.geometry))area=geometry(e);
    // An open residential way has complete source geometry but no usable area.
    // Retain it as unallocated input; never invent a closing edge or population.
    const openResidential=e.type==="way"&&(e.tags?.landuse||e.tags?.building)&&e.geometry?.[Math.floor(e.geometry.length/2)];
    const p=e.center?[e.center.lon,e.center.lat]:e.type==="node"?[e.lon,e.lat]:area?anchor(area):openResidential?[openResidential.lon,openResidential.lat]:null;
    if(!p?.every(Number.isFinite))throw Error(`设施 ${e.type}:${e.id} 定位不完整`);
    return {type:"Feature",id:`${e.type}:${e.id}`,properties:{...e.tags,osmId:e.id,osmType:e.type,trafficRaw:true,
      trafficMembers:(e.members||[]).map(m=>`${m.type}:${m.ref}`)},geometry:{type:"Point",coordinates:p},area};
  }
  function geometry(rel) {
    const stitch=role=>{
      const parts=(rel.members||[]).filter(m=>m.type==="way"&&(m.role||"outer")===role).map(m=>(m.geometry||[]).map(p=>[p.lon,p.lat]));
      if(parts.some(p=>p.length<2||p.some(v=>!v.every(Number.isFinite))))throw Error(`行政边界 ${rel.id} 成员几何缺失`);
      const out=[],equal=(a,b)=>a[0]===b[0]&&a[1]===b[1];
      while(parts.length){const line=parts.pop();while(!equal(line[0],line.at(-1))){const i=parts.findIndex(p=>equal(p[0],line.at(-1))||equal(p.at(-1),line.at(-1)));if(i<0)throw Error(`行政边界 ${rel.id} 未闭合`);let next=parts.splice(i,1)[0];if(!equal(next[0],line.at(-1)))next=next.reverse();line.push(...next.slice(1));}if(line.length<4)throw Error("行政边界无有效闭环");out.push(line);}
      return out;
    };
    const outer=stitch("outer"),inner=stitch("inner"),polys=outer.map(r=>[r]);
    if(!outer.length)throw Error(`行政边界 ${rel.id} 无完整外环`);
    for(const hole of inner){const i=polys.findIndex(p=>inside(hole[0],{type:"Polygon",coordinates:p}));if(i<0)throw Error("行政边界孔洞归属不完整");polys[i].push(hole);}
    return polys.length===1?{type:"Polygon",coordinates:polys[0]}:{type:"MultiPolygon",coordinates:polys};
  }
  function number(value) {const s=String(value??"").trim();return /^(?:\d+|\d{1,3}(?:[, ]\d{3})+)$/.test(s)&&Number(s.replace(/[, ]/g,""))<=2e9?Number(s.replace(/[, ]/g,"")):0;}
  function population(tags={}) {return number(tags.population)||number(tags["population:hx"]);}
  function declaredLevel(tags={}){const n=Number(tags.admin_level||tags.capital);return Number.isInteger(n)&&n>=2&&n<=12?n:null;}
  function placeLevel(tags={}){return declaredLevel(tags)||({shi:5,qu:6,xian:6,ting:6,jiedao:8,zhen:8,xiang:8,shequ:10,cun:10})[tags["place:hx"]]
    ||({city:5,town:8,suburb:8,quarter:10,neighbourhood:10,village:10})[tags.place];}
  function populationZones(elements,selected,details=[]) {
    const byId=new Map(elements.map(e=>[`${e.type}:${e.id}`,e])),used=new Set(),allAreas=[];
    for(const e of elements.filter(e=>e.type==="relation"&&e.tags?.boundary==="administrative")) {
      const g=geometry(e),level=Number(e.tags.admin_level)||99,centre=(e.members||[]).find(m=>m.type==="node"&&m.role==="admin_centre"),n=centre&&byId.get(`node:${centre.ref}`);
      const direct=population(e.tags),centrePopulation=n&&(!declaredLevel(n.tags)||declaredLevel(n.tags)===level)?population(n.tags):0,
        p=n&&Number.isFinite(n.lon)&&inside([n.lon,n.lat],g)?[n.lon,n.lat]:anchor(g);
      allAreas.push({id:`relation:${e.id}`,name:e.tags.name||String(e.id),level,geometry:g,coordinate:p,population:direct||centrePopulation,
        centreId:n?.id,centrePopulation,source:direct?(number(e.tags.population)?"population":"population:hx"):centrePopulation?`admin_centre ${n.id} · ${number(n.tags?.population)?"population":"population:hx"}`:"未标人口",children:[]});
    }
    const roots=selected.map(s=>allAreas.find(a=>a.id===`relation:${s.osm_id}`));
    if(roots.some(r=>!r))throw Error("缺少所选行政区完整边界");
    // Overpass can also return a containing province whose centre falls inside
    // the selected city. Ancestors cannot consume that city's population node.
    const areas=allAreas.filter(a=>roots.includes(a)||roots.some(r=>a.level>r.level&&inside(a.coordinate,r.geometry)));
    for(const a of areas)if(a.centrePopulation)used.add(a.centreId);
    const contained=(a,b)=>inside(a.coordinate,b.geometry);
    for(const a of areas){const parents=areas.filter(b=>b.level<a.level&&contained(a,b)).sort((a,b)=>b.level-a.level);a.parent=parents[0];a.parent?.children.push(a);}
    for(const e of elements.filter(e=>e.type==="node"&&population(e.tags)&&!used.has(e.id))) {
      const p=[e.lon,e.lat],level=placeLevel(e.tags);
      if(!level||!roots.some(r=>inside(p,r.geometry)))continue;
      // Match by actual containing administrative geometry/level, never by a similar name.
      const matching=areas.filter(a=>a.level===level&&inside(p,a.geometry));
      if(matching.length===1&&!matching[0].population){const a=matching[0];a.population=population(e.tags);a.source=`辖内 ${e.tags.place||"行政中心"} 节点 ${e.id} · ${number(e.tags.population)?"population":"population:hx"}`;a.coordinate=p;used.add(e.id);continue;}
      if(matching.length){used.add(e.id);continue;} // A second representation of an already counted area.
      const parent=areas.filter(a=>a.level<level&&inside(p,a.geometry)).sort((a,b)=>b.level-a.level)[0];
      if(parent)parent.children.push({id:`node:${e.id}`,name:e.tags.name||e.tags.place,level,coordinate:p,population:population(e.tags),source:`place 节点 · ${number(e.tags.population)?"population":"population:hx"}`,children:[],
        place:e.tags.place,scopeId:parent.id,scopeGeometry:parent.geometry});
    }
    // Building and residential-area population are finer children of the same
    // totals, not extra people to add on top of a district/community label.
    const memberIds=new Set(details.flatMap(f=>f.properties.trafficMembers||[]));
    const validFlag=v=>v&&v!=="no",extent=f=>{const b=f.area&&bounds(f.area);return b?(b[2]-b[0])*(b[3]-b[1]):0;};
    const finer=details.filter(f=>!memberIds.has(f.id)&&population(f.properties)&&((f.properties.building&&f.properties.building!=="no")||f.properties.landuse==="residential")
      &&!validFlag(f.properties["building:part"])&&!validFlag(f.properties.disused)&&!validFlag(f.properties.abandoned)
      &&!(f.properties.osmType==="node"&&used.has(Number(f.properties.osmId))))
      .sort((a,b)=>Boolean(a.properties.building)-Boolean(b.properties.building)||extent(b)-extent(a)||a.id.localeCompare(b.id));
    const fineAreas=[];
    for(const f of finer){if(areas.some(a=>a.id===f.id)||areas.some(a=>a.children.some(c=>c.id===f.id)))continue;
      const p=f.geometry.coordinates,g=f.area;if(!roots.some(r=>inside(p,r.geometry)))continue;
      let parent=fineAreas.filter(a=>a.geometry&&inside(p,a.geometry)).sort((a,b)=>b.level-a.level)[0];
      if(!parent){parent=areas.filter(a=>inside(p,a.geometry)).sort((a,b)=>b.level-a.level)[0];
        const peers=(parent?.children||[]).filter(a=>a.scopeGeometry&&!a.geometry&&inside(p,a.scopeGeometry));
        const dx=Math.cos(p[1]*Math.PI/180),distance=a=>((a.coordinate[0]-p[0])*dx)**2+(a.coordinate[1]-p[1])**2;
        if(peers.length)parent=peers.sort((a,b)=>distance(a)-distance(b)||a.id.localeCompare(b.id))[0];}
      if(!parent)continue;
      const a={id:f.id,name:f.properties.name||"标注人口建筑／住宅区",coordinate:p,geometry:g,level:Math.max(parent.level+1,f.properties.building?14:12),
        population:population(f.properties),source:f.properties.building?"建筑 · population":"住宅区 · population",children:[],
        ...(g?{}:{scopeId:parent.id,scopeGeometry:parent.geometry||parent.scopeGeometry}),allocationKind:f.properties.building?"building":"residential"};
      parent.children.push(a);fineAreas.push(a);
    }
    const zones=[],rows=[],conflicts=[];
    function visit(a,region){let child=0;for(const c of a.children)child+=visit(c,region);
      if(a.population&&child>a.population)conflicts.push({name:a.name,parent:a.population,children:child});
      const residual=Math.max(0,a.population-child),total=Math.max(child,a.population);a.allocated=total;
      // Point communities have no polygon to exclude, but their explicitly
      // counted estate/building descendants must not absorb parent residuals.
      const exclusions=[],excludedSiteIds=[];
      const exclude=c=>{if(!c.allocated)return;if(c.geometry){exclusions.push(c.geometry);return;}
        if(c.allocationKind==="building")excludedSiteIds.push(c.id);for(const v of c.children)exclude(v);};
      for(const c of a.children)exclude(c);
      if(residual)zones.push({id:a.id,name:a.name,coordinate:a.coordinate,geometry:a.geometry,residents:residual,region,source:a.source,level:a.level,
        exclusions,excludedSiteIds,siteId:!a.geometry&&a.allocationKind==="building"?a.id:undefined,allocationKind:a.allocationKind,
        ...(a.scopeGeometry?{place:a.place,scopeId:a.scopeId,scopeGeometry:a.scopeGeometry}:{})});
      rows.push({id:a.id,name:a.name,level:a.level,population:a.population||null,allocated:total,residual,source:a.source,region});return total;
    }
    // Nested selected regions are one population tree, not two copies of the same residents.
    const top=roots.filter(r=>!roots.some(p=>p!==r&&p.level<r.level&&inside(r.coordinate,p.geometry)));
    let total=0;for(const r of top)total+=visit(r,r.name);
    const coverageAreas=areas.filter(a=>roots.includes(a)||roots.includes(a.parent)).map(a=>({id:a.id,name:a.name,level:a.level,geometry:a.geometry,
      residualArea:roots.includes(a)&&areas.some(b=>b.parent===a)}));
    return {zones,rows,conflicts,total,coverageAreas,missing:rows.filter(r=>r.population===null).length};
  }
  async function request(query,fetcher=root.fetch,options={}) {
    const label=options.label||"区域数据";
    for(let attempt=0;attempt<3;attempt++){
      // A retry gets fresh wait/idle/total deadlines. A slow 503
      // must not leave the next attempt with only the old timer's last seconds.
      const controller=new AbortController();let timedOut=false,response,reader,wait=0,timer,lastProgress=0;
      const abort=()=>controller.abort(),timeout=()=>{timedOut=true;abort();};
      const arm=ms=>{clearTimeout(timer);timer=setTimeout(timeout,ms);};
      // Waiting for the query and downloading its body are different phases.
      // Keep a 30 s idle deadline while bytes arrive, with a five-minute cap.
      const hardTimer=setTimeout(timeout,options.timeout||300000);arm(options.timeout||95000);
      if(options.signal?.aborted)abort();else options.signal?.addEventListener("abort",abort,{once:true});
      try {
        if(controller.signal.aborted)throw Error("请求已取消");
        response=await fetcher(URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`data=${encodeURIComponent(query)}`,signal:controller.signal,credentials:"omit"});
        if(!response.ok){const error=Error(`数据服务 HTTP ${response.status}`);
          error.retryable=[408,429,500,502,503,504].includes(response.status);
          const retryAfter=response.headers.get("retry-after"),seconds=Number(retryAfter),date=Date.parse(retryAfter);
          error.retryAfter=Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-Date.now():0;throw error;}
        if(Number(response.headers.get("content-length"))>LIMITS.bytes)throw Error("区域响应超过 32 MiB");
        if(!response.body)throw Error("区域数据响应为空");
        reader=response.body.getReader();const chunks=[];let size=0;arm(Math.min(options.timeout||30000,30000));
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMITS.bytes)throw Error("区域响应超过 32 MiB");chunks.push(value);
          arm(Math.min(options.timeout||30000,30000));
          if(Date.now()-lastProgress>=1000){lastProgress=Date.now();options.onProgress?.({bytes:size});}}
        const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
        let data;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error("区域数据响应无法解析");}
        const count=Array.isArray(data?.elements)&&data.elements.find(e=>e.type==="count"),elements=Array.isArray(data?.elements)&&data.elements.filter(e=>e.type!=="count");
        if(data?.remark){const timeout=/Query timed out|time(?:d)?\s*out/iu.test(data.remark);
          const error=Error(timeout?"上游查询超时，未取得完整数据":"上游未返回完整区域数据");error.retryable=timeout;throw error;}
        if(!count||!elements||Number(count.tags.total)!==elements.length)throw Error("区域数据计数不完整，保留旧模拟");
        if(elements.length>LIMITS.objects)throw Error("区域对象超过 60000，请减少行政区范围");
        return {elements,sourceTime:Date.parse(data.osm3s?.timestamp_osm_base)||null,readAt:Date.now()};
      }catch(error){
        const cancelled=options.signal?.aborted,timeout=timedOut||error.name==="TimeoutError",
          network=error.name==="AbortError"||error.name==="TypeError"&&/fetch|network|connection|load failed/iu.test(error.message);
        const reason=cancelled?"请求已取消":timeout?"响应超时":network?"连接中断或网络不可用":error.message;
        if(cancelled||!(timeout||network||error.retryable)||attempt===2)throw Error(`${label}：${reason}${attempt?`（已自动重试 ${attempt} 次）`:""}`);
        wait=Math.max(2000,Math.min(15000,error.retryAfter||(attempt+1)*3000));
        options.onRetry?.({attempt:attempt+1,reason,wait});
      }finally{
        clearTimeout(timer);clearTimeout(hardTimer);options.signal?.removeEventListener("abort",abort);abort();
        try{if(reader)await reader.cancel();else await response?.body?.cancel();}catch{}
      }
      await new Promise((resolve,reject)=>{
        const done=()=>{options.signal?.removeEventListener("abort",cancel);resolve();};
        const cancel=()=>{clearTimeout(pending);options.signal?.removeEventListener("abort",cancel);reject(Error(`${label}：请求已取消`));};
        const pending=setTimeout(done,wait);
        if(options.signal?.aborted)cancel();else options.signal?.addEventListener("abort",cancel,{once:true});
      });
    }
  }
  async function loadPreview(center,selected,fetcher) {
    // A complete small neighbourhood is a preview, never a fraction of city population.
    if(!selected.some(s=>inside(center,s.geojson)))return null;
    const dx=1500/(111320*Math.cos(center[1]*Math.PI/180)),dy=1500/111320;
    const b=[center[0]-dx,center[1]-dy,center[0]+dx,center[1]+dy],bbox=`${b[1]},${b[0]},${b[3]},${b[2]}`;
    const data=await request(`[out:json][timeout:20];(way(${bbox})[highway~"^(primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$"];nwr(${bbox})[building];nwr(${bbox})[landuse~"^(residential|industrial|commercial|retail)$"];nwr(${bbox})[amenity];nwr(${bbox})[shop];nwr(${bbox})[office];nwr(${bbox})[leisure~"^(park|garden|sports_centre|stadium)$"];);out body geom;out count;`,fetcher,{timeout:28000});
    if(data.elements.length>6000)throw Error("附近预览超过预算，继续准备完整区域");
    const roads=[],demand=[];
    for(const e of data.elements){
      let g;
      if(e.type==="node")g={type:"Point",coordinates:[e.lon,e.lat]};
      else if(e.type==="way"&&e.geometry?.length){
        if(e.geometry.some(p=>!p||!Number.isFinite(p.lon)||!Number.isFinite(p.lat)))throw Error("附近预览几何不完整");
        const coordinates=e.geometry.map(p=>[p.lon,p.lat]);
        if(e.tags?.highway){if(e.nodes?.length!==coordinates.length)throw Error("附近道路节点不完整");
          roads.push({type:"Feature",id:`way:${e.id}`,properties:{...e.tags,roadNodes:e.nodes,osmId:e.id},geometry:{type:"LineString",coordinates}});continue;}
        if(coordinates.length>=4&&e.nodes?.[0]===e.nodes?.at(-1))g={type:"Polygon",coordinates:[coordinates]};
      } else if(e.type==="relation"&&e.tags?.type==="multipolygon")g=geometry(e);
      if(!g)continue;
      const p=g.type==="Point"?g.coordinates:anchor(g);
      if(!p.every(Number.isFinite)||!selected.some(s=>inside(p,s.geojson)))continue;
      demand.push({type:"Feature",id:`${e.type}:${e.id}`,properties:{...e.tags,osmId:e.id,osmType:e.type,trafficRaw:true,
        trafficMembers:(e.members||[]).map(m=>`${m.type}:${m.ref}`)},geometry:g});
    }
    return {center,roads,demand,sourceTimes:[data.sourceTime].filter(Number.isFinite),radius:1500};
  }
  async function load(selected,progress=()=>{},fetcher,options={}) {
    if(!selected.length||selected.length>LIMITS.regions||selected.some(s=>s.osm_type!=="relation"||!/^\d+$/.test(String(s.osm_id))))throw Error("请选择 1–4 个真实行政区");
    const bs=selected.map(s=>bounds(s.geojson)),b=[Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))];
    if(b.some(v=>!Number.isFinite(v))||b[2]-b[0]>12||b[3]-b[1]>12)throw Error("区域跨度超过 12°，请减少范围或选择相邻城市／省份");
    const areas=selected.map(s=>`area(${3600000000+Number(s.osm_id)});`).join(""),rels=selected.map(s=>`rel(${Number(s.osm_id)});`).join("");
    const provincial=selected.some(s=>Number(s.extratags?.admin_level)<5),pattern=provincial?"motorway|trunk|primary|secondary|tertiary|unclassified":"motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service";
    const bbox=`${b[1]},${b[0]},${b[3]},${b[2]}`;
    const queries=[
      `[out:json][timeout:80];(${areas})->.a;(${rels}rel(area.a)[boundary=administrative];)->.r;(.r;node(r.r:"admin_centre");node(area.a)[population];node(area.a)["population:hx"];);out body geom;out count;`,
      `[out:json][timeout:80];(${areas})->.a;${provincial?'(nwr(area.a)[amenity=parking];nwr(area.a)[railway=station];nwr(area.a)[aeroway=terminal];)->.access;':''}(way(area.a)[highway~"^(${pattern})(_link)?$"];${provincial?'way(around.access:300)[highway~"^(service|living_street|residential)$"];':''}${selected.length>1?`way(${bbox})[highway~"^(motorway|trunk|primary|secondary)(_link)?$"];`:""});out body geom;out count;`,
      `[out:json][timeout:80];(${areas})->.a;(nwr(area.a)[amenity~"^(parking|parking_entrance|school|university|college|kindergarten|hospital|clinic|doctors|cafe|restaurant|fast_food|bank|marketplace|post_office)$"];nwr(area.a)[railway~"^(station|halt)$"];nwr(area.a)[public_transport=station][train=yes];nwr(area.a)[aeroway~"^(aerodrome|terminal)$"];nwr(area.a)[shop][shop!~"^(no|vacant|closed)$"];nwr(area.a)[office];nwr(area.a)[leisure~"^(park|garden|sports_centre|stadium)$"];nwr(area.a)[landuse~"^(residential|industrial|commercial|retail)$"];)->.f;(nwr.f[amenity=parking];nwr.f[aeroway=aerodrome];nwr.f[landuse];)->.shape;(.f; - .shape;)->.rest;.rest out body center;.shape out body geom;.f out count;`,
      `[out:json][timeout:80];(${areas})->.a;nwr(area.a)[building][building!=no];out body geom;out count;`
    ];
    const labels=["人口与边界","路网与干道","设施与用地","全域建筑"],responses=new Array(4);let cursor=0,completed=0;
    progress("后台补齐全域：人口、路网、设施、建筑 0／4…");
    // Two bounded requests overlap; avoid flooding the upstream service with all regions at once.
    const capacity=options.capacity||{slots:2},controller=new AbortController();
    await new Promise((resolve,reject)=>{let active=0,failed=false;
      const pump=()=>{if(failed)return;if(completed===queries.length){capacity.wake=null;resolve();return;}
        while(cursor<queries.length&&active<Math.max(1,Math.min(2,capacity.slots))){const i=cursor++;active++;
          request(queries[i],fetcher,{label:labels[i],signal:controller.signal,
            onProgress:({bytes})=>{if(!failed)progress(`后台补齐全域：${completed}／4 已就绪；${labels[i]}已接收 ${(bytes/1024/1024).toFixed(1)} MiB…`);},
            onRetry:({attempt,reason})=>{if(!failed)progress(`后台补齐全域：${completed}／4 已就绪；${labels[i]}${reason}，正在自动重试 ${attempt}／2…`);}
          }).then(result=>{if(failed)return;responses[i]=result;completed++;progress(`后台补齐全域：${completed}／4，${labels[i]}已就绪…`);},error=>{if(failed)return;failed=true;capacity.wake=null;controller.abort();reject(error);}).finally(()=>{active--;pump();});}
      };capacity.wake=pump;pump();});
    const [admin,road,poi,building]=responses;
    let vertices=0;const roads=road.elements.filter(e=>e.type==="way").map(e=>{vertices+=e.nodes?.length||0;if(!e.geometry?.length||e.geometry.length!==e.nodes?.length||e.geometry.some(p=>!p||!Number.isFinite(p.lon)||!Number.isFinite(p.lat)))throw Error("道路节点／几何不完整");return {type:"Feature",id:`way:${e.id}`,properties:{...e.tags,roadNodes:e.nodes,osmId:e.id},geometry:{type:"LineString",coordinates:e.geometry.map(p=>[p.lon,p.lat])}};});
    if(roads.length>LIMITS.ways||vertices>LIMITS.vertices)throw Error("路网超过 40000 条或 35 万节点，请减少范围；未接管部分结果");
    // The same school/shop may occur in both requests. Keep one source object,
    // preferring the full building footprint over the facility centre record.
    const features=[...new Map([...poi.elements,...building.elements].map(e=>[`${e.type}:${e.id}`,e])).values()].map(feature);
    const population=populationZones(admin.elements,selected,features);
    return {roads,features,population,selected:selected.map(s=>({name:s.name,id:s.osm_id,geometry:s.geojson})),
      center:[(b[0]+b[2])/2,(b[1]+b[3])/2],bounds:b,sourceTimes:responses.map(p=>p.sourceTime).filter(Number.isFinite),readAt:Date.now(),buildingsLoaded:true,provincial};
  }
  root.HuayuTrafficRegions=Object.freeze({VERSION,LIMITS,inside,segmentInside,bounds,geometry,feature,population,populationZones,request,loadPreview,load});
})(globalThis);
