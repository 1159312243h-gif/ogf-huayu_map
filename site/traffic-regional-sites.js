(function installRegionalSites(root){
  "use strict";
  const R=root.HuayuTrafficRegions,D=root.HuayuTrafficDemand,C=root.HuayuTrafficCore,cache=new WeakMap();
  const area=f=>f.area||(/^(Polygon|MultiPolygon)$/.test(f.geometry?.type)?f.geometry:null);
  const point=f=>f.geometry.type==="Point"?f.geometry.coordinates:D.measure(area(f),C.projection([0,0]))?.coordinate;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const building=p=>Boolean(p.building&&p.building!=="no");
  const inactive=p=>p.disused&&p.disused!=="no"||p.abandoned&&p.abandoned!=="no"||p.proposed&&p.proposed!=="no"||p.construction&&p.construction!=="no"
    ||/^(construction|proposed|demolished|ruins)$/.test(p.building)||p["building:part"]&&p["building:part"]!=="no"||p.buildingPart&&p.buildingPart!=="no";
  function buildingMetrics(f,project){
    const p=f.properties,footprint=D.measure(area(f),project)?.area;
    const meters=v=>{const m=String(v??"").trim().match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|米|ft|feet|foot|')?$/i);return m?Number(m[1])*(/^(ft|feet|foot|')$/i.test(m[2]||"")?.3048:1):NaN;};
    const tagged=Number(p["building:levels"]),height=meters(p.height??p["building:height"]),base=meters(p.min_height??p.minHeight),roof=meters(p["roof:height"]);
    const wall=height-(Number.isFinite(base)?base:0)-(Number.isFinite(roof)?roof:0);
    const source=tagged>0&&tagged<=300?"levels":wall>0&&wall<=1000?"height":"default";
    const levels=source==="levels"?tagged:source==="height"?Math.max(1,Math.round(wall/3)):2;
    return {footprint:footprint>0?footprint:80,footprintEstimated:!(footprint>0),levels,source,floor:(footprint>0?footprint:80)*levels};
  }
  class Index{
    constructor(records){this.cells=new Map();this.large=[];for(const v of records){const b=area(v.feature)&&R.bounds(area(v.feature));if(!b)continue;
      const [x0,y0,x1,y1]=b.map(n=>Math.floor(n/.005));
      if((x1-x0+1)*(y1-y0+1)>4096){this.large.push(v);continue;}
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=`${x}:${y}`;if(!this.cells.has(k))this.cells.set(k,[]);this.cells.get(k).push(v);}
    }}
    at(p){return [...(this.cells.get(`${Math.floor(p[0]/.005)}:${Math.floor(p[1]/.005)}`)||[]),...this.large].filter(v=>R.inside(p,area(v.feature)));}
  }
  function prepare(input){
    const cached=cache.get(input);if(cached?.source===input.features&&cached.sourceCount===input.features.length)return cached;
    const project=C.projection(input.center),all=[...new Map(input.features.map(f=>[f.id,f])).values()];
    const members=new Set(all.flatMap(f=>f.properties.trafficMembers||[])),unique=all.filter(f=>!members.has(f.id));
    const buildings=unique.filter(f=>building(f.properties)),contexts=unique.filter(f=>area(f)&&(f.properties.landuse||f.properties.amenity||f.properties.office));
    const landIndex=new Index(contexts.map(feature=>({feature,kind:D.category(feature.properties),size:D.measure(area(feature),project)?.area||Infinity})));
    const bIndex=new Index(buildings.map(feature=>({feature}))),containedUses=new Map();
    for(const f of unique){if(building(f.properties))continue;const kind=D.category(f.properties);if(!kind||kind==="home")continue;
      for(const b of bIndex.at(point(f))){if(!containedUses.has(b.feature.id))containedUses.set(b.feature.id,new Set());containedUses.get(b.feature.id).add(kind);}}
    const stats={buildings:buildings.length,homeBuildings:0,unknownBuildings:0,inferredBuildings:0,excludedBuildings:0,missingGeometry:0,
      footprintArea:0,floorArea:0,populationFloorWeight:0,levelsTagged:0,heightInferred:0,levelsDefault:0,pointFootprintAssumed:0};
    const records=[],homeBuildings=[];
    for(const f of unique){const p=f.properties,isBuilding=building(p);let kind=D.category(p),homeWeight=0,inferred=false;
      if(isBuilding){
        if(inactive(p)||/^(roof|garage|garages|carport|shed|greenhouse|barn|stable|farm_auxiliary|storage_tank|water_tower)$/.test(p.building)){
          stats.excludedBuildings++;continue;}
        if(!area(f)&&/^(way|relation)$/.test(p.osmType)){stats.missingGeometry++;continue;}
        const context=landIndex.at(point(f)).filter(v=>v.feature!==f&&v.kind).sort((a,b)=>a.size-b.size||a.feature.id.localeCompare(b.feature.id))[0];
        if(!kind){
          const uses=containedUses.get(f.id);
          if(uses?.size===1){kind=[...uses][0];inferred=true;}
          else if(context){kind=context.kind;inferred=true;}
          else if(/^(civic|government|public|hotel|service|transportation|train_station)$/.test(p.building)){kind="work";inferred=true;}
          else if(/^(church|chapel|mosque|temple|synagogue|stadium|sports_hall)$/.test(p.building)){kind="leisure";inferred=true;}
          else {kind="activity";stats.unknownBuildings++;}
        }
        const metrics=buildingMetrics(f,project),floor=metrics.floor;
        stats.footprintArea+=metrics.footprint;stats.floorArea+=floor;
        stats[metrics.source==="levels"?"levelsTagged":metrics.source==="height"?"heightInferred":"levelsDefault"]++;
        if(metrics.footprintEstimated)stats.pointFootprintAssumed++;
        // Weights distribute the existing regional total, never estimate extra residents.
        if(kind==="home"||kind==="activity")homeWeight=floor*(kind==="activity"?.5:1);
        stats.populationFloorWeight+=homeWeight;
        if(homeWeight){stats.homeBuildings++;homeBuildings.push({feature:f,weight:homeWeight});}
        if(inferred)stats.inferredBuildings++;
        const uses=containedUses.get(f.id),destinationSuppressed=kind!=="home"&&uses?.has(kind);
        records.push({feature:f,kind,homeWeight,floor,metrics,inferred,destinationSuppressed});
      }else if(kind)records.push({feature:f,kind,homeWeight:0});
    }
    // Use individual buildings before their enclosing land/campus envelope.
    const coveredLand=new Set(),coveredFacilities=new Set(),envelopes=new Index(records.filter(r=>!building(r.feature.properties)&&area(r.feature)));
    for(const b of records.filter(r=>building(r.feature.properties))){for(const env of envelopes.at(point(b.feature))){
      if(env.kind==="home"&&b.homeWeight)coveredLand.add(env.feature.id);
      if(env.kind===b.kind&&b.kind!=="home")coveredFacilities.add(env.feature.id);
    }}
    const homes=[...homeBuildings,...records.filter(r=>r.kind==="home"&&!building(r.feature.properties)&&!coveredLand.has(r.feature.id)).map(r=>({feature:r.feature,weight:D.measure(area(r.feature),project)?.area||0,land:true}))];
    const result={source:input.features,sourceCount:input.features.length,allBuildings:buildings,records:records.filter(r=>!coveredFacilities.has(r.feature.id)),homes,stats,coveredLand,complete:input.buildingsLoaded===true};cache.set(input,result);return result;
  }
  function nodeIndex(nodes){const cells=new Map(),size=250;for(const n of nodes){const k=`${Math.floor(n.point[0]/size)}:${Math.floor(n.point[1]/size)}`;if(!cells.has(k))cells.set(k,[]);cells.get(k).push(n);}
    return {near(p,r=150){const out=[];for(let x=Math.floor((p[0]-r)/size);x<=Math.floor((p[0]+r)/size);x++)for(let y=Math.floor((p[1]-r)/size);y<=Math.floor((p[1]+r)/size);y++)out.push(...cells.get(`${x}:${y}`)||[]);return out;},
      nearest(p,r=150){let best=null,d=r;for(const n of this.near(p,r)){const delta=Math.hypot(n.point[0]-p[0],n.point[1]-p[1]);if(delta<d||delta===d&&n.id.localeCompare(best?.id||"")<0){best=n;d=delta;}}return best;}};
  }
  function accessNodes(input){
    const project=C.projection(input.center),raw=new Map();
    for(const f of input.roads){const p=f.properties;if(/^(motorway|trunk)/.test(p.highway)||Number(p.layer)||p.bridge&&p.bridge!=="no"||p.tunnel&&p.tunnel!=="no"||p.access==="private"||p.access==="no")continue;
      f.geometry.coordinates.forEach((p,j)=>{const id=String(f.properties.roadNodes[j]);if(!raw.has(id))raw.set(id,{id,point:project.xy(p)});});}
    const index=nodeIndex([...raw.values()]),out=new Set();for(const r of prepare(input).records){if(!building(r.feature.properties))continue;
      const n=index.nearest(project.xy(point(r.feature)));if(n)out.add(n.id);}
    return out;
  }
  function residentialAccesses(graph,input){
    const project=C.projection(graph.center),model=prepare(input),zones=input.population.zones;
    const coverageAreas=input.population.coverageAreas||input.selected.map((s,i)=>({id:s.id||String(i),name:s.name,level:0,geometry:s.geometry}));
    const areaRows=coverageAreas.map(a=>({...a,feature:{area:a.geometry},buildings:0,homeBuildings:0,floorArea:0,residents:0,unconnectedResidents:0}));
    const areaIndex=new Index(areaRows),areaAt=p=>areaIndex.at(p).sort((a,b)=>b.level-a.level||String(a.id).localeCompare(String(b.id)))[0];
    for(const f of model.allBuildings){const a=areaAt(point(f));if(a)a.buildings++;}
    for(const r of model.records)if(r.metrics){const a=areaAt(point(r.feature));if(a){a.floorArea+=r.floor;if(r.homeWeight)a.homeBuildings++;}}
    const areaWeights=new Map();
    const ground=[...graph.nodes.values()].filter(n=>n.out.some(id=>!graph.edges[id].elevated&&!graph.edges[id].motorway)),index=nodeIndex(ground);
    const prepared=zones.filter(z=>!z.locationMissing).map(z=>({z,point:project.xy(z.coordinate),geometry:z.geometry||z.scopeGeometry,bounds:(z.geometry||z.scopeGeometry)&&R.bounds(z.geometry||z.scopeGeometry),level:z.level??(z.geometry?5:10)}));
    const pointScopes=(input.population.pointScopes||zones.filter(z=>!z.geometry&&!z.locationMissing&&!z.allocationKind&&z.scopeGeometry)).map(z=>({...z,point:project.xy(z.coordinate)}));
    const scopeById=new Map(pointScopes.map(z=>[z.id,z])),scopePeers=new Map();
    for(const z of pointScopes){const key=`${z.scopeId}:${z.level}`;if(!scopePeers.has(key))scopePeers.set(key,[]);scopePeers.get(key).push(z);}
    const owners=(p,siteId)=>{const xy=project.xy(p),eligible=prepared.filter(v=>{
      if(v.z.siteId&&v.z.siteId!==siteId||siteId&&v.z.excludedSiteIds?.includes(siteId))return false;
      if(v.bounds&&(p[0]<v.bounds[0]||p[0]>v.bounds[2]||p[1]<v.bounds[1]||p[1]>v.bounds[3]))return false;
      if(v.geometry&&!R.inside(p,v.geometry))return false;
      if(v.z.exclusions?.some(g=>R.inside(p,g)))return false;
      return Boolean(v.geometry)||Math.hypot(xy[0]-v.point[0],xy[1]-v.point[1])<=450&&input.selected.some(s=>R.inside(p,s.geometry));
    }),actual=eligible.filter(v=>v.z.geometry),depth=Math.max(-1,...actual.map(v=>v.level));
      const nearest=a=>a.sort((a,b)=>Math.hypot(xy[0]-a.point[0],xy[1]-a.point[1])-Math.hypot(xy[0]-b.point[0],xy[1]-b.point[1])||a.z.id.localeCompare(b.z.id))[0];
      const membership=new Map(),belongs=z=>{if(membership.has(z.id))return membership.get(z.id);membership.set(z.id,false);
        if(!R.inside(p,z.scopeGeometry))return false;
        const parent=scopeById.get(z.scopeId);if(parent&&!belongs(parent))return false;
        const peers=scopePeers.get(`${z.scopeId}:${z.level}`)||[z];
        const first=peers.reduce((a,b)=>{const da=Math.hypot(xy[0]-a.point[0],xy[1]-a.point[1]),db=Math.hypot(xy[0]-b.point[0],xy[1]-b.point[1]);return db<da||db===da&&b.id.localeCompare(a.id)<0?b:a;});
        const result=first.id===z.id;membership.set(z.id,result);return result;};
      const out=[];if(actual.length)out.push(nearest(actual.filter(v=>v.level===depth)).z);
      const peers=new Map();for(const v of eligible.filter(v=>!v.z.geometry&&v.level>depth&&(!scopeById.has(v.z.id)||belongs(scopeById.get(v.z.id))))){const k=`${v.z.scopeId||"legacy"}:${v.level}`;if(!peers.has(k))peers.set(k,[]);peers.get(k).push(v);}
      // Point labels partition their parent's whole area; they do not define a radius.
      // Each point ancestor also distributes its own residual, already reduced
      // by its children. A fine village must not suppress the whole city's share.
      out.push(...[...peers.values()].map(v=>nearest(v).z));
      return out;};
    const weights=new Map(),totals=new Map(),unconnected=new Map();let covered=0,unknown=0,connectedBuildings=0;
    const add=(z,n,w,p)=>{totals.set(z,(totals.get(z)||0)+w);
      const a=areaAt(p||project.lngLat(n.point));if(a){if(!areaWeights.has(z))areaWeights.set(z,new Map());const m=areaWeights.get(z),v=m.get(a)||{weight:0,unconnected:0};v.weight+=w;if(!n)v.unconnected+=w;m.set(a,v);}
      if(!n)return;
      if(!weights.has(z))weights.set(z,new Map());const entries=weights.get(z),old=entries.get(n.id);
      if(old)old.weight+=w;else entries.set(n.id,{node:n.id,point:n.point,access:project.lngLat(n.point),accessDistance:0,weight:w});};
    for(const h of model.homes){const f=h.feature;if(!h.weight){if(h.land)unknown++;continue;}
      if(!h.land){const p=point(f),ownersAt=owners(p,f.id),n=index.nearest(project.xy(p));for(const z of ownersAt)add(z,n,h.weight,p);if(n&&ownersAt.length)connectedBuildings++;continue;}
      const g=area(f),b=R.bounds(g),a=project.xy(b.slice(0,2)),c=project.xy(b.slice(2)),mid=[(a[0]+c[0])/2,(a[1]+c[1])/2];
      const candidates=ground.filter(n=>n.point[0]>=a[0]&&n.point[0]<=c[0]&&n.point[1]>=a[1]&&n.point[1]<=c[1]&&R.inside(project.lngLat(n.point),g));
      if(!candidates.length){const n=index.nearest(mid);if(n)candidates.push(n);}
      let assigned=false;for(const n of candidates){for(const z of owners(project.lngLat(n.point))){add(z,n,h.weight/candidates.length);assigned=true;}}
      if(assigned)covered++;else unknown++;
    }
    // Some mapped districts have population and roads but no building footprints
    // or residential land yet. Keep their original coarse road fallback across
    // the whole district, rather than treating the population as missing roads.
    const fallbackZones=new Set();
    if(model.complete){const missing=new Set(zones.filter(z=>!totals.has(z)));
      if(missing.size)for(const n of ground){const roads=n.out.map(id=>graph.edges[id]).filter(e=>/^(residential|living_street|service|unclassified)$/.test(e.highway));if(!roads.length)continue;
        for(const z of owners(project.lngLat(n.point)))if(missing.has(z)){fallbackZones.add(z);add(z,n,roads.reduce((sum,e)=>sum+e.line.length,0));}}
    }
    const group=grid=>{const out=new Map();for(const [z,entries] of weights){const cells=new Map();for(const v of entries.values()){
      const k=`${Math.floor(v.point[0]/grid)}:${Math.floor(v.point[1]/grid)}`,old=cells.get(k);
      if(old){const best=v.weight>old.best||v.weight===old.best&&v.node.localeCompare(old.node)<0?v:old;cells.set(k,{...best,weight:old.weight+v.weight,best:Math.max(old.best,v.weight)});}
      else cells.set(k,{...v,best:v.weight});}out.set(z,[...cells.values()].sort((a,b)=>a.node.localeCompare(b.node)));}return out;};
    let grouped=group(400);const reserved=zones.filter(z=>!weights.has(z)).reduce((n,z)=>n+(z.geometry?clamp(Math.ceil(z.residents/25000),1,4):z.residents>=3000?2:1),0);
    for(let grid=800;[...grouped.values()].reduce((n,a)=>n+a.length,0)+reserved>512&&grid<=1024000;grid*=2)grouped=group(grid);
    const accesses=new Map();for(const z of zones){const list=grouped.get(z)||[],total=totals.get(z)||0,connected=list.reduce((n,v)=>n+v.weight,0);
      accesses.set(z,list.map(v=>({...v,share:v.weight/total})));const missing=total?Math.max(0,1-connected/total):model.complete?1:0;unconnected.set(z,missing<1e-12?0:missing);
      if(total){for(const [a,w] of areaWeights.get(z)||[]){a.residents+=z.residents*w.weight/total;a.unconnectedResidents+=z.residents*w.unconnected/total;}}
      else if(model.complete){const a=z.locationMissing?areaRows.find(a=>a.id===z.scopeId):areaAt(z.coordinate);if(a){a.residents+=z.residents;a.unconnectedResidents+=z.residents;}}}
    return {accesses,unconnected,complete:model.complete,land:covered+unknown+model.coveredLand.size,covered:covered+model.coveredLand.size,unknown,
      areaRows:areaRows.map(({geometry,feature,...r})=>r),connectedBuildings,fallbackPopulationZones:fallbackZones.size,...model.stats};
  }
  root.HuayuRegionalSites=Object.freeze({prepare,accessNodes,residentialAccesses,nodeIndex,point,area,buildingMetrics});
})(globalThis);
