(function installTrafficSimulation(root) {
  "use strict";
  const LAYER = "ogf-atlas-traffic-cars", MAX = 1200;
  const FLOW="ogf-atlas-traffic-flow", ROUTE="ogf-atlas-traffic-trip", STOPS="ogf-atlas-traffic-stops";
  const LANES="ogf-atlas-traffic-lanes",laneLayers=[LANES,`${LANES}-edge`,`${LANES}-divider`,`${LANES}-center`];
  let laneRequest=0,laneTimer=0,laneBounds=null,laneWorker=null,laneResult=null;
  let bridgeRequest=0,bridgeResult=null,bridgeWorker=null,bridgeIndex=null,bridgeBounds=null,bridgeCameraKey=null;
  const colors = ["#e5e0d5", "#d2674f", "#50869b", "#e4b85c", "#78847b", "#9c8eaf"];
  let enabled = false, paused = false, selected = null, following = false, worker = null, generation = 0;
  let map, layer, graphics, alive = 0, frame = 0, lastFrame = 0, followAt = 0, lastUi = 0;
  let center, signature, latest, previous, received = 0, projected = [], preparing = false, status = "默认关闭，开启后可选择城市、区县、省份或局部街区。";
  let flowDirty=true,routeDirty=true,flowRatios=new Map(),previousVehicles=new Map(),basisDemand=null;
  let network=[], roadStates=new Map(), trip=null, pendingContext=false, pendingSignature=null, pendingTimer=0;
  let regions=[],searchGeneration=0,candidate=null,candidateGeneration=0,searching=false;
  let cachedRegion=null,priorityWorker=null,regionProgress="";
  const ui = {};
  let decoder=new root.HuayuTrafficProtocol.Decoder();
  const count = () => Number(ui.count.value);
  const rate = () => Number(ui.rate.value);
  const isPaused = () => paused || document.hidden;
  const regional=()=>ui.scope?.value==="regional";
  function setStatus(value) {status = value; if(ui.status.textContent!==value)ui.status.textContent = value;}
  function refreshBridgeNote(){
    const note=document.getElementById('traffic-bridge-note');if(!note)return;
    note.hidden=!latest?.structures?.bridges;
    if(note.hidden)return;
    const text=root.HuayuBridgeModels?.getPreferences().enabled!==true?'桥梁／高架已参与计算；在“设置 → 桥梁渲染”开启桥面后，可查看桥上汽车、车道和路况。'
      :!root.HuayuBridgeModels?.get(map)?.visible?'桥梁／高架已参与计算；请使用倾斜视角，等待完整桥面与高度就绪。'
      :`桥上汽车和路况跟随实际显示的桥面高度${graphics?.bridgeData?.limited?'；本视窗车道细节达到预算，请放大查看其余部分':''}。隧道参与计算，不在地面显示地下汽车。`;
    if(note.textContent!==text)note.textContent=text;
  }
  function refreshUi() {
    refreshBridgeNote();
    ui.enabled.checked = enabled; ui.controls.hidden = !enabled;
    ui.regions.hidden=!regional();ui.overview.hidden=!regional();ui.near.hidden=regional();
    ui.overview.disabled=!latest?.regional;
    ui.pause.textContent = paused ? "继续模拟" : "暂停模拟";
    ui.follow.disabled = !selected || !latest?.vehicles.some(v => v.id === selected && v.phase!=="dwell");
    ui.stop.hidden = !following; ui.follow.textContent = following ? "正在跟随" : "跟随所选车辆";
    const car = latest?.vehicles.find(v => v.id === selected);
    ui.vehicle.textContent = car ? `车辆 ${car.id} · ${car.returning?"返程":car.purpose}：${car.origin} → ${car.destination}。${car.phase==="dwell"?`已到达${car.parked?`，在${car.parkingName}示意车位停车`:"，在目的地停留"}，约 ${Math.ceil(car.dwellRemaining/60)} 分钟后返程（车辆不占行车道）`:`${car.phase==="parking"?"正在驶入示意车位 · ":car.phase==="unparking"?"正在驶出车位 · ":""}${car.road} · ${Math.round(car.speed)} km/h${car.waiting?" · 排队／让行":" · 行驶中"}，累计等待 ${Math.round(car.queueSeconds)} 秒`}。` : "点击地图上的车辆，或从列表选择，可查看用途、路线和停留。";
    if(car&&car.phase!=="dwell")ui.vehicle.textContent+=` 本方向第 ${car.lane||1}／${car.lanes||1} 车道（${car.laneSource==="tag"?"标签":car.laneSource==="width"?"路宽估算":"道路类型估算"}）。`;
    if(latest) {
      const d=latest.demand,h=Math.floor(latest.clockHour),m=Math.floor((latest.clockHour-h)*60);
      ui.summary.textContent=`模拟 ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")} · 在途 ${latest.moving} 辆／排队 ${latest.waiting} 辆 · 到达停留 ${latest.dwelling} 辆 · 累计到达 ${latest.arrived}、返家 ${latest.returned}。预计出发 ${Math.round(d.personHourly)} 人次／小时，折算 ${Math.round(d.hourly)} 车次，另有约 ${Math.round(d.returnHourly)} 车次返程（${d.multiplier}×情景）。最多绘制 ${count()} 辆，超过上限仍参与计算。${latest.pending?`另有 ${latest.pending} 车次等待安全发车。`:""}${latest.capacityLimited?"计算预算已满，当前不能视为完整路况。":""}`;
      const updateBasis=basisDemand!==d;basisDemand=d;
      if(ui.buildingAudit)ui.buildingAudit.hidden=!latest.regional;
      if(updateBasis&&ui.buildingSummary){ui.buildingRows.replaceChildren();const a=d.buildingAudit;
        if(a){const format=n=>Math.round(n||0).toLocaleString();
          ui.buildingSummary.textContent=`全域 ${format(d.buildings)} 栋独立建筑，${format(d.homeBuildings)} 栋提供居民位置；参与建筑占地约 ${format(a.footprintArea)} m²，楼面面积约 ${format(a.floorArea)} m²。${format(a.levelsTagged)} 栋采用楼层标签、${format(a.heightInferred)} 栋按有效墙高÷3 米推算、${format(a.levelsDefault)} 栋缺标暂按 2 层；${format(a.pointFootprintAssumed)} 个建筑点缺范围暂按 80 m² 占地。已有总人口 ${format(d.totalResidents)} 人按住宅楼面权重分配，用途未标按半权重；一栋建筑可分配多人。各区人口是位置估算，不是新的官方分区人口。`;
          for(const r of a.areas||[]){const row=document.createElement('p');row.className='model-options-summary';row.textContent=`${r.name}${r.residualArea?"（其余区域）":""}：${format(r.buildings)} 栋建筑／${format(r.homeBuildings)} 栋用于人口位置，楼面约 ${format(r.floorArea)} m²；分配约 ${format(r.residents)} 人，其中 ${format(r.unconnectedResidents)} 人未接路。`;ui.buildingRows.append(row);}
        }else ui.buildingSummary.textContent='等待完整区域建筑核算。';}
      const times=latest.sourceTimes||[],stamp=times.length?new Date(Math.min(...times)).toLocaleString():"未提供";
      if(updateBasis)ui.basis.textContent=`已采用 ${d.residentialSites} 处住宅、${d.poiSites} 处设施，${d.pairs} 组可往返起终点；已读人口标签 ${d.taggedResidents} 人（${d.populationSites} 处），面积估算约 ${d.estimatedResidents} 人。未分类建筑 ${d.unknownBuildings} 处、距可用道路过远 ${d.unconnected} 处、没有往返目的地的住宅 ${d.unservedHomes} 处${d.limited?"；已达输入预算，仅为部分样本":""}。最早源记录时间：${stamp}。仅代表当前已加载部分。`;
      if(latest.regional){
        ui.summary.textContent=`${latest.regionNames.join("、")} · 采用 ${d.totalResidents.toLocaleString()} 人 · 模拟 ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}。路段计算约 ${latest.moving.toLocaleString()} 辆在途、${latest.waiting.toLocaleString()} 辆排队，${latest.pending.toLocaleString()} 车次等待进入路网；累计到达 ${latest.arrived}、返家 ${latest.returned}。预计去程 ${Math.round(d.hourly).toLocaleString()}、返程 ${Math.round(d.returnHourly).toLocaleString()} 车次／小时，25 公里内约 ${(d.nearbyShare*100).toFixed(1)}%，100 公里以上约 ${(d.remoteShare*100).toFixed(1)}%。近景从 ${latest.sampleCount} 个行程样本中最多绘制 ${count()} 辆，样本不等于总车数。${latest.parking?`停车占用约 ${latest.parking.occupied}／${latest.parking.capacity} 位，入场排队约 ${latest.parking.waiting} 辆。`:""}`;
        if(updateBasis){const rows=d.populationRows||[];
        ui.basis.textContent=`分层人口合计 ${d.totalResidents.toLocaleString()} 人；父子人口只分配一次。接入道路过远未分配 ${Math.round(d.unconnectedResidents).toLocaleString()} 人，无往返设施未分配 ${Math.round(d.unservedResidents).toLocaleString()} 人；${d.crossPairs} 组跨区域可达起终点。${d.missingPopulation} 个行政区无直接人口，采用已知下级，未知部分不填零；${d.populationConflicts.length} 处上下级人口冲突（保留下级）：${d.populationConflicts.map(c=>`${c.name}上级 ${c.parent.toLocaleString()}、下级合计 ${c.children.toLocaleString()}`).join("；")}。${rows.map(r=>`${r.name}：${r.population===null?"未标":r.population.toLocaleString()}，${r.source}${r.residual?`，上级剩余分配 ${r.residual.toLocaleString()} 人`:""}`).join("；")}。最早上游时间：${stamp}。人口及设施接入点为估算，不是实测出入口。区域／小区人口表示整片范围，优先按全域建筑的用途、占地及楼层分配位置，分区过多时空间合并并保留全部人口；缺少建筑时使用住宅用地或范围内道路回退。${d.parkingNote||""}`;
        ui.basis.textContent+=(d.allocationNote||"")+(d.distanceNote||"")+(d.transportNote||"");
        if(d.boundaryWarnings?.length)ui.basis.textContent+=` 下级边界限制 ${d.boundaryWarnings.length} 处：${d.boundaryWarnings.map(w=>`${w.name}（${w.id}）：${w.pointFallback?"缺少有效闭合边界，按中心点在真实上级范围内估算位置":w.populationUnlocated?"缺少有效边界和中心点，已知人口保留为未定位、未分配":"缺少有效边界和中心点，不推定其范围或人口"}`).join("；")}。所选行政区边界完整，下级估算范围不是正式边界。`;}
      }
      if(latest.preview)ui.summary.textContent=`视野附近约 1.5 公里局部预览；${regionProgress||"全域尚未就绪，可重试加载"}。${ui.summary.textContent}`;
    }else {ui.summary.textContent=regionProgress||"等待路网和出行需求…";ui.basis.textContent="尚未形成需求结果。";if(ui.buildingAudit)ui.buildingAudit.hidden=true;}
    ui.hotspots.replaceChildren();
    for(const h of latest?.hotspots||[]){const b=document.createElement("button");b.type="button";b.className="secondary-button";
      b.textContent=`${h.name} · 约 ${h.waiting} 辆排队 · ${h.speed} km/h`;b.onclick=()=>{stopFollowing();root.HuayuAtlas.prepareTrafficCamera(h.coordinate);};ui.hotspots.append(b);}
    for(const p of latest?.parking?.hotspots||[]){const b=document.createElement("button");b.type="button";b.className="secondary-button";
      b.textContent=`停车 · ${p.name} · ${p.occupied}／${p.capacity} 位 · 约 ${p.waiting} 辆排队${p.renderable?" · 可观察进出场":""}`;b.onclick=()=>{stopFollowing();root.HuayuAtlas.prepareTrafficCamera(p.coordinate);};ui.hotspots.append(b);}
    for(const p of latest?.parking?.entrances||[]){const b=document.createElement("button");b.type="button";b.className="secondary-button";
      b.textContent=`查看停车进出场 · ${p.name}`;b.onclick=()=>{stopFollowing();root.HuayuAtlas.prepareTrafficCamera(p.coordinate);};ui.hotspots.append(b);}
    if (document.activeElement !== ui.select) {
      const options=ui.select._vehicleOptions||(ui.select._vehicleOptions=new Map()),ids=new Set();
      if(!ui.select.options.length)ui.select.add(new Option("选择一辆汽车", ""));
      const fragment=document.createDocumentFragment();
      for(const v of latest?.vehicles||[]){ids.add(v.id);let option=options.get(v.id);
        if(!option){option=new Option("",String(v.id));options.set(v.id,option);fragment.append(option);}
        const label=v.id+" · "+(v.parked?"已停车":v.phase==="dwell"?"停留":v.returning?"返程":v.purpose)+" · "+v.destination;
        if(option.text!==label)option.text=label;
      }
      for(const [id,option] of options)if(!ids.has(id)){option.remove();options.delete(id);}
      ui.select.append(fragment);ui.select.value=selected?String(selected):"";
    }
  }
  function stopFollowing() {
    if (!following) return;
    following = false; followAt = 0; try{map?.stop();}catch{} refreshUi();
  }
  function releaseGraphics() {
    if (!graphics) return;
    const old=graphics;graphics=null;projected=[];
    clearBridgeGraphics(old);old.parts.forEach(mesh=>mesh.dispose());old.resources.forEach(r => r.dispose());
    old.renderer.dispose();
  }
  function disposeMap(expectedMap) {
    if(expectedMap && map!==expectedMap)return;
    alive++; stopFollowing(); cancelAnimationFrame(frame); frame = 0;
    searchGeneration++;searching=false;
    cancelCandidate();cachedRegion=null;worker?.terminate(); worker = null; generation++;
    clearTimeout(pendingTimer);pendingTimer=0;pendingSignature=null;pendingContext=false;
    clearTimeout(laneTimer);laneTimer=0;laneRequest++;laneBounds=null;laneWorker=null;laneResult=null;
    bridgeRequest++;bridgeResult=null;bridgeWorker=null;bridgeIndex=null;bridgeBounds=null;
    network=[];roadStates.clear();trip=null;flowDirty=routeDirty=true;flowRatios.clear();previousVehicles.clear();basisDemand=null;decoder=new root.HuayuTrafficProtocol.Decoder();
    const oldMap=map;map = null; layer = null; center = null; signature = null;
    latest = previous = null; selected = null; preparing = false;regionProgress="";
    // Map removal can discard its style before cleanup listeners run.
    // Releasing our resources must not depend on a live style/getLayer.
    try {
      oldMap?.off("moveend", onMove); oldMap?.off("remove", onRemove);
      if (oldMap?.getLayer(LAYER)) oldMap.removeLayer(LAYER);
      for(const id of [...laneLayers,FLOW,ROUTE,STOPS,`${STOPS}-names`])if(oldMap?.getLayer(id))oldMap.removeLayer(id);
      for(const id of [LANES,FLOW,ROUTE,STOPS])if(oldMap?.getSource(id))oldMap.removeSource(id);
    } catch {} finally {releaseGraphics();}
  }
  function onRemove() {disposeMap(); if (enabled) {setStatus("等待华域矢量底图就绪…"); refreshUi();}}
  function setEnabled(value) {
    enabled = Boolean(value); paused = false;
    if (!enabled) {disposeMap(); setStatus("已关闭车流模拟。地图功能保持原有状态。");}
    else if(regional()) {setStatus("请选择城市／区县／省份，再点击加载并模拟。");syncContext();}
    else syncContext(true);
    refreshUi();
  }
  function onMove() {
    if(enabled&&map)requestLanes();
    if (!enabled || following || !map || preparing) return;
    if(regional()||latest?.regional){sendViewport();return;}
    const c = map.getCenter();
    const meters = center ? Math.hypot((c.lng - center[0]) * 111320 * Math.cos(c.lat*Math.PI/180), (c.lat-center[1])*111320) : Infinity;
    if (meters > 450) syncContext(true);
    else if (map.getZoom() < 14) setStatus("模拟仍在当前街区；放大到街道可查看汽车，或点击“移近当前街区”。");
  }
  function sendViewport(){if(!map||!latest?.regional||following)return;const b=map.getBounds();worker?.postMessage({action:"viewport",bounds:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]});}
  function requestLanes(force=false){
    if(!map||!worker||!latest)return;
    const visible=ui.lanes.checked&&map.getZoom()>=16;
    for(const id of laneLayers)if(map.getLayer(id))map.setLayoutProperty(id,"visibility",visible?"visible":"none");
    if(!visible){clearTimeout(laneTimer);laneRequest++;laneBounds=null;ui.laneStatus.textContent=ui.lanes.checked?"放大到街道近景显示车道。":"已隐藏分道线，车辆仍按车道行驶。";return;}
    const b=map.getBounds(),bounds=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()];
    if(!force&&laneWorker===worker&&laneBounds&&bounds[0]>=laneBounds[0]&&bounds[1]>=laneBounds[1]&&bounds[2]<=laneBounds[2]&&bounds[3]<=laneBounds[3])return;
    clearTimeout(laneTimer);const token=++laneRequest;
    laneTimer=setTimeout(()=>{
      laneTimer=0;if(!map||!worker||!enabled||token!==laneRequest)return;
      // A horizontal camera can have enormous ground bounds. Keep near geometry bounded.
      const c=map.getCenter(),dx=Math.min(0.025,Math.max(.001,(bounds[2]-bounds[0])*.7)),dy=Math.min(.025,Math.max(.001,(bounds[3]-bounds[1])*.7));
      laneBounds=[c.lng-dx,c.lat-dy,c.lng+dx,c.lat+dy];laneWorker=worker;
      worker.postMessage({action:"lanes",generation,request:token,bounds:laneBounds});
    },120);
  }
  function showLanes(result){
    if(!map?.style||map._removed)return;laneResult=result;
    const data={type:"FeatureCollection",features:result.features};
    if(map.getSource(LANES))map.getSource(LANES).setData(data);else map.addSource(LANES,{type:"geojson",data});
    const pixels=(minimum=0)=>["interpolate",["exponential",2],["zoom"],16,["max",minimum,["*",["get","pixels0"],65536]],24,["max",minimum,["*",["get","pixels0"],16777216]]];
    // Keep road surfaces below traffic colors and markings below vehicle/label layers.
    if(!map.getLayer(LANES))map.addLayer({id:LANES,type:"line",source:LANES,minzoom:16,filter:["==",["get","kind"],"surface"],layout:{"line-join":"round","line-cap":"butt"},paint:{"line-color":"#7d8183","line-width":pixels(),"line-opacity":.94}},map.getLayer(FLOW)?FLOW:undefined);
    const before=map.getLayer(ROUTE)?ROUTE:map.getLayer(LAYER)?LAYER:undefined;
    for(const [kind,color,dash] of [["edge","#f5f2e6"],["divider","#faf8ee",[14,14]],["center","#f2cb61"]]){
      const id=`${LANES}-${kind}`;if(map.getLayer(id))continue;
      map.addLayer({id,type:"line",source:LANES,minzoom:16,filter:["==",["get","kind"],kind],layout:{"line-join":"round","line-cap":"butt"},paint:{"line-color":color,"line-width":pixels(.65),"line-opacity":.92,...(dash?{"line-dasharray":dash}:{})}},before);
    }
    const visibility=ui.lanes.checked&&map.getZoom()>=16?"visible":"none";
    for(const id of laneLayers)map.setLayoutProperty(id,"visibility",visibility);
    ui.laneStatus.textContent=`近景 ${result.roads} 段路面，${result.estimated} 段车道数为估算${result.limited?"；本视窗达细节预算，请放大查看其余道路":""}。窄双向路保留共享路面。`;
  }
  function clearBridgeGraphics(g=graphics){
    if(!g)return;for(const mesh of g.bridgeMeshes||[]){g.scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}g.bridgeMeshes=[];g.bridgeData=null;
  }
  function syncBridgeSurfaces(){
    if(!map||!worker||!graphics)return;
    const controller=root.HuayuBridgeModels?.get(map),result=controller?.visible?controller.result:null;
    if(!result){if(bridgeResult){bridgeRequest++;bridgeResult=null;bridgeWorker=null;bridgeIndex=null;bridgeBounds=null;clearBridgeGraphics();refreshBridgeNote();}return;}
    const b=map.getBounds(),c=map.getCenter(),cameraKey=[c.lng.toFixed(6),c.lat.toFixed(6),map.getZoom().toFixed(3),map.getPitch().toFixed(1),map.getBearing().toFixed(1)].join('|'),inside=bridgeBounds&&b.getWest()>=bridgeBounds[0]&&b.getSouth()>=bridgeBounds[1]&&b.getEast()<=bridgeBounds[2]&&b.getNorth()<=bridgeBounds[3];
    if(result===bridgeResult&&bridgeWorker===worker&&(inside||cameraKey===bridgeCameraKey))return;
    bridgeCameraKey=cameraKey;
    if(result!==bridgeResult){bridgeIndex=root.HuayuTrafficSurfaces.index(result.accepted);bridgeResult=result;clearBridgeGraphics();}
    if(bridgeWorker!==worker)clearBridgeGraphics();
    const dx=Math.min(.025,Math.max(.001,(b.getEast()-b.getWest())*.7)),dy=Math.min(.025,Math.max(.001,(b.getNorth()-b.getSouth())*.7));
    bridgeBounds=[c.lng-dx,c.lat-dy,c.lng+dx,c.lat+dy];bridgeWorker=worker;
    worker.postMessage({action:"bridge-surfaces",generation,request:++bridgeRequest,bounds:bridgeBounds,
      plans:result.accepted.map(p=>({samples:p.samples,heights:p.heights,surfaceWidths:p.surfaceWidths}))});
  }
  function showBridgeSurfaces(data){
    if(!graphics)return;clearBridgeGraphics();const g=graphics,T=g.T;
    const build=(positions,colors,opacity)=>{const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(positions,3));geometry.setAttribute('color',new T.BufferAttribute(colors,3));
      const material=new T.MeshBasicMaterial({vertexColors:true,side:T.DoubleSide,transparent:opacity<1,opacity,depthTest:true,depthWrite:false,toneMapped:false});
      const mesh=new T.Mesh(geometry,material);mesh.frustumCulled=false;g.scene.add(mesh);return mesh;};
    g.bridgeMeshes=[build(data.positions,data.colors,1),build(data.flow,new Float32Array(data.flow.length),.8)];g.bridgeData=data;updateBridgeFlow();refreshBridgeNote();map.triggerRepaint();
  }
  function updateBridgeFlow(){
    const g=graphics;if(!g?.bridgeData)return;const attr=g.bridgeMeshes[1].geometry.getAttribute('color');let dirty=false;
    for(const group of g.bridgeData.groups){let ratio=-1;for(const id of group.ids||[]){const r=roadStates.get(id)?.ratio;if(Number.isFinite(r))ratio=ratio<0?r:Math.min(ratio,r);}
      const band=ratio<0?-1:ratio<.35?0:ratio<.65?1:2;if(group.band===band)continue;group.band=band;g.color.set(band<0?'#8793a3':band===0?'#d75343':band===1?'#d69a28':'#369c79');
      for(let i=group.start;i<group.start+group.count;i++)attr.setXYZ(i,g.color.r,g.color.g,g.color.b);dirty=true;}
    if(dirty)attr.needsUpdate=true;
  }
  function selectCar(id) {
    selected=Number(id)||null;worker?.postMessage({action:"select",id:selected});refreshUi();map?.triggerRepaint();
  }
  function syncOverlays() {
    if(!map?.style||map._removed)return;
    updateBridgeFlow();
    const collection=features=>({type:"FeatureCollection",features});
    const before=(map.getLayersOrder?.()||[]).find(id=>map.getLayer(id)?.type==="symbol");
    function source(id,data){if(map.getSource(id))map.getSource(id).setData(data);else map.addSource(id,{type:"geojson",data});}
    if(flowDirty||!map.getSource(FLOW)){
      if(map.getSource(FLOW))map.removeFeatureState({source:FLOW});
      source(FLOW,collection(network.map(e=>({type:"Feature",id:e.id,geometry:{type:"LineString",coordinates:e.coordinates},properties:{hourly:e.hourly}}))));
      flowDirty=false;flowRatios.clear();
    }
    if(!map.getLayer(FLOW))map.addLayer({id:FLOW,type:"line",source:FLOW,minzoom:4,layout:{"line-cap":"round","line-join":"round"},
      paint:{"line-opacity":0.8,"line-color":["step",["coalesce",["feature-state","ratio"],-1],"#8793a3",0,"#d75343",0.35,"#d69a28",0.65,"#369c79"],
      "line-width":["interpolate",["linear"],["get","hourly"],0,1.5,50,3,200,5,1000,8]}},before);
    for(const e of network){if(!e.hourly)continue;let ratio=-1;
      for(const id of e.ids){const r=roadStates.get(id)?.ratio;if(Number.isFinite(r))ratio=ratio<0?r:Math.min(ratio,r);}
      const band=ratio<0?-1:ratio<0.35?0:ratio<0.65?1:2;
      if(flowRatios.get(e.id)!==band){map.setFeatureState({source:FLOW,id:e.id},{ratio});flowRatios.set(e.id,band);}
    }
    const visibility=ui.overlay.checked?"visible":"none";
    if(map.getLayoutProperty(FLOW,"visibility")!==visibility)map.setLayoutProperty(FLOW,"visibility",visibility);
    if(routeDirty||!map.getSource(ROUTE)){
      source(ROUTE,collection(trip?[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:trip.coordinates}}]:[]));
      source(STOPS,collection(trip?[trip.origin,trip.destination].map((p,i)=>({type:"Feature",properties:{name:(i?"终：":"起：")+p.name,color:i?"#c5638f":"#29967d"},geometry:{type:"Point",coordinates:p.coordinate}})):[]));routeDirty=false;
    }
    if(!map.getLayer(ROUTE))map.addLayer({id:ROUTE,type:"line",source:ROUTE,paint:{"line-color":"#f5c844","line-width":5,"line-opacity":0.9}},before);
    if(!map.getLayer(STOPS))map.addLayer({id:STOPS,type:"circle",source:STOPS,paint:{"circle-radius":6,"circle-color":["get","color"],"circle-stroke-color":"#fff","circle-stroke-width":2}},before);
    if(!map.getLayer(STOPS+"-names"))map.addLayer({id:STOPS+"-names",type:"symbol",source:STOPS,layout:{"text-field":["get","name"],"text-size":12,"text-offset":[0,1.5]},paint:{"text-color":"#444","text-halo-color":"#fff","text-halo-width":2}});
  }
  async function ensureGraphics(mapInstance) {
    if (graphics || preparing) return;
    const token = alive;
    preparing = true;
    try {
      const T = await import("./three-0.160.1.module.min.js");
      if (!enabled || map !== mapInstance || token !== alive) return;
      layer = {id:LAYER, type:"custom", renderingMode:"3d",
        onAdd(m, gl) {
          const renderer = new T.WebGLRenderer({canvas:m.getCanvas(),context:gl,antialias:true});
          renderer.autoClear = false; renderer.outputColorSpace = T.SRGBColorSpace;
          const scene = new T.Scene(), camera = new T.Camera();
          scene.add(new T.AmbientLight(0xffffff, 1.8));
          const light = new T.DirectionalLight(0xffffff, 1.1); light.position.set(-30,-20,100); scene.add(light);
          const box = new T.BoxGeometry(1,1,1), bodyMaterial = new T.MeshLambertMaterial({color:0xffffff});
          const glass = new T.MeshLambertMaterial({color:"#36424b"});
          const tires = new T.MeshLambertMaterial({color:"#303131"});
          const parts = [[box,bodyMaterial],[box,glass],[box,tires]].map(([geo,mat]) => {
            const mesh = new T.InstancedMesh(geo,mat,MAX); mesh.frustumCulled = false; mesh.count = 0;
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage); scene.add(mesh); return mesh;
          });
          graphics = {T,renderer,scene,camera,parts,resources:[box,bodyMaterial,glass,tires],dummy:new T.Object3D(),
            color:new T.Color(),projection:new T.Matrix4(),transform:new T.Matrix4()};
        },
        render(gl,args) {
          if (!graphics || !latest || !center || document.hidden || mapInstance.getZoom()<10.5) return;
          syncBridgeSurfaces();
          const g = graphics, T = g.T;
          if(g.originKey!==center){g.originKey=center;g.origin=root.maplibregl.MercatorCoordinate.fromLngLat(center);g.scale=g.origin.meterInMercatorCoordinateUnits();}
          const origin=g.origin,scale=g.scale;
          g.transform.makeTranslation(origin.x,origin.y,0).scale(new T.Vector3(scale,-scale,scale));
          g.projection.fromArray(args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args);
          g.camera.projectionMatrix.copy(g.projection).multiply(g.transform);
          const old=previousVehicles;
          const t = isPaused() ? 1 : Math.min(1,Math.max(0,(performance.now()-received)/100));
          const rect = mapInstance.getCanvas(); let n=0,bridgeCars=0; projected=[];
          const terrain = mapInstance.getTerrain?.();
          const view=mapInstance.getBounds();
          if(g.bridgeMeshes?.length){g.bridgeMeshes[0].visible=ui.lanes.checked&&mapInstance.getZoom()>=16;g.bridgeMeshes[1].visible=ui.overlay.checked;}
          const visible=mapInstance.getZoom()<14?[]:latest.vehicles.filter(c=>(c.phase!=="dwell"||c.parked)&&!c.tunnel&&!c.hiddenSample&&view.contains(c.coordinate));
          if(selected)visible.sort((a,b)=>(b.id===selected)-(a.id===selected)||a.id-b.id);
          for (const car of visible.slice(0,count())) {
            const p = old.get(car.id) || car;
            let coordinate = car.coordinate.map((v,i)=>p.coordinate[i]+(v-p.coordinate[i])*t);
            const screen=mapInstance.project(coordinate);
            if(screen.x < -20||screen.y < -20||screen.x>rect.clientWidth+20||screen.y>rect.clientHeight+20)continue;
            const ground = terrain ? mapInstance.queryTerrainElevation(coordinate) : 0;
            const surface=root.HuayuTrafficSurfaces.vehicle(bridgeIndex,car,coordinate,ground);
            if (!surface) continue; // No ground fallback for a bridge or tunnel without a displayed surface.
            const elevation=surface.height;coordinate=surface.coordinate;
            if(surface.onBridge)bridgeCars++;
            const mc = root.maplibregl.MercatorCoordinate.fromLngLat(coordinate);
            const x = (mc.x-origin.x)/scale, y = -(mc.y-origin.y)/scale, z=elevation+0.12;
            let delta = car.angle-p.angle; while(delta>Math.PI)delta-=2*Math.PI; while(delta<-Math.PI)delta+=2*Math.PI;
            const angle = p.angle+delta*t, d=g.dummy;
            [[4.2,1.75,0.85,0.65],[2.15,1.5,0.65,1.38],[3.6,1.9,0.35,0.23]].forEach((size,k)=>{
              d.position.set(x,y,z+size[3]);d.rotation.set(0,0,angle);d.scale.set(size[0],size[1],size[2]);d.updateMatrix();
              g.parts[k].setMatrixAt(n,d.matrix);
            });
            g.color.set(car.id===selected ? "#f5d342" : colors[car.id%colors.length]);g.parts[0].setColorAt(n,g.color);
            const clip = new T.Vector3(x,y,z+1).applyMatrix4(g.camera.projectionMatrix);
            if(clip.z>=-1&&clip.z<=1) projected.push({id:car.id,x:(clip.x+1)*rect.clientWidth/2,y:(1-clip.y)*rect.clientHeight/2});
            n++;
          }
          g.drawn=n;g.drawnBridge=bridgeCars;g.parts.forEach(mesh=>{mesh.count=n;mesh.instanceMatrix.needsUpdate=true;});
          if(g.parts[0].instanceColor)g.parts[0].instanceColor.needsUpdate=true;
          root.HuayuSunlight?.applyScene(mapInstance,g.scene);
          g.renderer.resetState();g.renderer.setViewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
          g.renderer.render(g.scene,g.camera);g.renderer.resetState();
        },
        onRemove() {releaseGraphics();}
      };
      const before = (mapInstance.getLayersOrder?.() || []).find(id=>["symbol","circle"].includes(mapInstance.getLayer(id)?.type));
      mapInstance.addLayer(layer,before);
    } catch (error) {
      if (token !== alive) return;
      disposeMap(); setStatus(`车辆渲染未能启动：${error.message}。可重试；原地图继续使用。`);
    } finally {if (token === alive) preparing=false;}
  }
  function startFrames() {
    if(frame || !enabled || document.hidden || !map || !latest?.moving) return;
    const tick = now => {
      frame=0;
      if(!enabled || document.hidden || !map || !latest?.moving)return;
      if(now-lastFrame>=32) {
        lastFrame=now;
        if(map.getZoom()>=14) map.triggerRepaint();
        if(following && now-followAt>400) {
          followAt=now;const car=latest.vehicles.find(v=>v.id===selected);
          if(!car||car.phase==="dwell")stopFollowing();
          else if(!isPaused()) {
            // Reuse one continuous ease. Avoid moveend/rebuild work on every animation frame.
            map.easeTo({center:car.coordinate,duration:700,easing:t=>t,easeId:"huayu-traffic-follow"});
          }
        }
        if(now-lastUi>1000){lastUi=now;refreshUi();}
      }
      if(!isPaused())frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
  }
  function receive(event) {
    if(!enabled || event.data.generation!==generation || !map)return;
    if(event.data.bridgeGeometry||event.data.bridgeError){if(event.data.bridgeRequest!==bridgeRequest)return;
      if(event.data.bridgeGeometry)showBridgeSurfaces(event.data.bridgeGeometry);return;}
    if(event.data.laneGeometry||event.data.laneError){
      if(event.data.laneRequest!==laneRequest)return;
      if(event.data.laneGeometry)showLanes(event.data.laneGeometry);
      else {laneBounds=null;ui.laneStatus.textContent="车道准备失败，原道路与模拟继续使用，可重新勾选重试。";}
      return;
    }
    let data;
    try{data=decoder.decode(event.data);}catch{disposeMap();setStatus("车流数据接收失败，请重新加载模拟。");refreshUi();return;}
    if(data.error){disposeMap();setStatus(`车流准备失败：${data.error}。可重试；原地图继续使用。`);refreshUi();return;}
    previous=latest;previousVehicles=new Map((previous?.vehicles||[]).map(c=>[c.id,c]));
    latest={...latest,...data};received=performance.now();
    if(data.network){network=data.network;flowDirty=true;if(laneWorker!==worker)requestLanes(true);}
    if(data.roadStates)roadStates=new Map(data.roadStates.map(s=>[s.id,s]));
    if(Object.hasOwn(data,"route")){trip=data.route;routeDirty=true;}
    if(data.network||data.roadStates||Object.hasOwn(data,"route"))syncOverlays();
    if(!data.moving || isPaused())map.triggerRepaint();
    if(selected&&!data.vehicles.some(v=>v.id===selected)){stopFollowing();selected=null;}
    if(following&&data.vehicles.find(v=>v.id===selected)?.phase==="dwell")stopFollowing();
    if(!latest.edges)setStatus("当前街区未加载可模拟的汽车道路。请移到有道路的区域并放大，随后重试。");
    else if(!latest.demand.pairs)setStatus(`已加载 ${latest.edges} 段道路，但当前住宅／设施不足或没有可往返路线；不生成随机巡游车。可移近住宅与商业混合街区后重新模拟。`);
    else setStatus(`${latest.preview?"视野附近局部预览":latest.regional?`${latest.regionNames.join("、")} · 区域路段计算与近景样本` : "约 850 米街区"} · ${latest.edges} 段道路${latest.structures?`（含 ${latest.structures.bridges} 段桥梁／高架、${latest.structures.tunnels} 段隧道）`:""} · 人口／设施需求情景${paused?" · 已暂停":""}${pendingContext?" · 新数据已到达，点击重新模拟应用":""}。`);
    startFrames();if(!previous || performance.now()-lastUi>800){lastUi=performance.now();refreshUi();}
  }
  function syncContext(force=false) {
    if(!enabled || !root.HuayuAtlas)return;
    if(regional()&&force){buildRegions();return;}
    const context=root.HuayuAtlas.getTrafficContext(force ? null : center,regional()||!force&&Boolean(worker));
    if(!context?.map || context.satellite) {disposeMap();setStatus("车流仅在华域标准／深夜矢量底图中显示，请切回华域底图。");refreshUi();return;}
    if(map && map!==context.map)disposeMap();
    if(!map){map=context.map;map.on("moveend",onMove);map.on("remove",onRemove);}
    if(regional())return;
    if(!context.ready) {
      // Keep the last complete local network while its replacement loads.
      // A camera zoom must not discard an otherwise valid followed vehicle.
      if(worker && latest){setStatus("道路更新中，继续当前街区的完整车流模拟…");return;}
      setStatus("等待当前街区的完整道路数据，移近街区后会自动开始…");refreshUi();return;
    }
    if(!force && worker) {
      if(signature===context.signature)return;
      // Late POI/building/tile refreshes must not reset an active trip or camera.
      if(latest?.demand.pairs){pendingContext=true;setStatus("有新的住宅／设施数据，当前行程继续；点击“以当前街区重新模拟”应用。");return;}
      if(!latest||pendingSignature===context.signature)return;
      pendingSignature=context.signature;clearTimeout(pendingTimer);
      pendingTimer=setTimeout(()=>{pendingTimer=0;syncContext(true);},500);return;
    }
    clearTimeout(pendingTimer);pendingTimer=0;pendingSignature=null;pendingContext=false;
    stopFollowing();signature=context.signature;center=context.center;
    selected=null;latest=previous=null;network=[];roadStates.clear();trip=null;generation++;
    worker?.terminate(); worker=null;
    try {
      worker=new Worker("./traffic-worker.js?v=8.0-traffic-boundaries-v1");
      const currentWorker=worker;
      worker.onmessage=receive;
      worker.onerror=()=>{if(worker!==currentWorker)return;disposeMap();setStatus("车流后台线程未能启动，可点击重新模拟。原地图继续使用。");refreshUi();};
      worker.postMessage({action:"build",generation,features:context.roads,
        options:{center,count:count(),drivingSide:ui.side.value,demandFeatures:context.demand,trafficInputLimited:context.trafficInputLimited,sourceTimes:context.sourceTimes,nonPassengerStationIds:context.nonPassengerStationIds,
          startHour:Number(ui.time.value.split(":")[0])+Number(ui.time.value.split(":")[1])/60,demandFactor:Number(ui.demand.value)},paused:isPaused(),rate:rate()});
      void ensureGraphics(map);setStatus("正在后台准备当前街区车流…");
    } catch(error){disposeMap();setStatus(`无法启动车流：${error.message}`);}
  }
  function follow() {
    const car=latest?.vehicles.find(v=>v.id===selected);
    if(!car||car.phase==="dwell"||!map)return;
    following=true;
    if(!root.HuayuAtlas.prepareTrafficCamera(car.coordinate)){following=false;refreshUi();return;}
    followAt=0;refreshUi();startFrames();
  }
  function pick(latlng, screenPoint) {
    if(!enabled || !latest || !map || !graphics || map.getZoom()<14)return false;
    const point=screenPoint || map.project([latlng.lng,latlng.lat]);
    const hit=projected.map(p=>({...p,d:Math.hypot(p.x-point.x,p.y-point.y)})).filter(p=>p.d<=16).sort((a,b)=>a.d-b.d)[0];
    if(!hit)return false;
    selectCar(hit.id);map.triggerRepaint();
    root.HuayuAtlas.showToast(`已选中模拟车辆 ${selected}，可在“模拟”中跟随`);return true;
  }
  function cancelCandidate(){candidate?.terminate();candidate=null;priorityWorker?.terminate();priorityWorker=null;candidateGeneration++;if(ui.cancel)ui.cancel.hidden=true;}
  function scenario(){const [h,m]=ui.time.value.split(":").map(Number);return {count:count(),drivingSide:ui.side.value,
    startHour:Number.isFinite(h)&&Number.isFinite(m)?h+m/60:8,demandFactor:Number(ui.demand.value),
    nonPassengerStationIds:root.HuayuAtlas.getTrafficContext(null,true)?.nonPassengerStationIds||[]};}
  function buildRegions(reuse=false){
    if(!enabled)return;
    const context=root.HuayuAtlas.getTrafficContext(null,true);
    if(!context?.map||context.satellite){setStatus("请先切回华域标准或深夜底图。");return;}
    if(!regions.length){setStatus("请先查找并添加行政区。");return;}
    if(map&&map!==context.map)disposeMap();
    if(!map){map=context.map;map.on("moveend",onMove);map.on("remove",onRemove);}
    cancelCandidate();const token=++candidateGeneration,nextGeneration=generation+1,expectedMap=map;
    const next=new Worker("./traffic-worker.js?v=8.0-traffic-boundaries-v1");candidate=next;ui.cancel.hidden=false;
    const key=regions.map(r=>r.osm_id).sort().join(",");let newInput=null,lastStage="启动模拟程序";
    regionProgress=ui.regionStatus.textContent="正在读取完整行政区；同时准备视野附近预览…";refreshUi();
    function fail(message){if(token!==candidateGeneration)return;cancelCandidate();
      if(/signal is aborted|AbortError|operation was aborted/iu.test(message))message="区域数据请求中断或超时";
      const kept=latest?.preview?"附近预览继续运行":latest?"保留已有模拟":"本次尚未启动全域模拟";
      regionProgress=ui.regionStatus.textContent=`${message}。${kept}，可重试或减少范围。`;refreshUi();}
    next.onerror=event=>{
      const message=String(event.message||"");
      const reason=/memory|allocation failed/iu.test(message)?"可用内存不足":/importScripts|script|fetch|network/iu.test(message)?"模拟程序文件未能加载":"模拟线程异常中断";
      fail(`${reason}（阶段：${lastStage}）${lastStage==="启动模拟程序"?"，请刷新页面重试；本地预览还需确认网页服务正在运行":""}`);
    };
    next.onmessageerror=()=>fail(`后台结果传输失败（阶段：${lastStage}）`);
    next.onmessage=event=>{const d=event.data;if(token!==candidateGeneration||!enabled||map!==expectedMap)return;
      if(d.progress){lastStage=d.progress;regionProgress=ui.regionStatus.textContent=d.progress;if(!latest||latest.preview)refreshUi();return;}
      if(d.loadedInput){newInput=d.loadedInput;return;}
      if(d.error){fail(d.error);return;}
      if(!d.demand?.pairs){fail(`读取了 ${d.edges} 段道路，但缺少标注人口、设施或往返连通`);return;}
      priorityWorker?.terminate();priorityWorker=null;
      stopFollowing();worker?.terminate();worker=next;candidate=null;ui.cancel.hidden=true;
      generation=nextGeneration;center=d.bounds?[(d.bounds[0]+d.bounds[2])/2,(d.bounds[1]+d.bounds[3])/2]:context.center;
      cachedRegion=newInput?{key,input:newInput}:cachedRegion;
      latest=previous=null;selected=null;trip=null;network=[];roadStates.clear();
      next.onmessage=receive;next.onerror=()=>{if(worker===next){disposeMap();setStatus("区域模拟已停止，原地图继续使用。");refreshUi();}};
      next.postMessage({action:"pause",paused:isPaused()});next.postMessage({action:"rate",rate:rate()});next.postMessage({action:"count",count:count()});
      ui.regionStatus.textContent="区域数据完整，已接管。移动地图保留全域计算；查看全域可看路况线，放大可看样本车。";
      regionProgress="";
      ui.regions.open=false;
      receive(event);sendViewport();void ensureGraphics(map);
    };
    const options=scenario(),b=map.getBounds(),viewport=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()];
    const loadFull=(previewPending=false)=>{if(token!==candidateGeneration||!enabled||map!==expectedMap)return;
      next.postMessage({action:"build-region",generation:nextGeneration,regions,viewport,previewPending,regionalInput:reuse&&cachedRegion?.key===key?cachedRegion.input:undefined,options,paused:isPaused(),rate:rate()});};
    if(latest?.demand.pairs){loadFull();return;}
    // The preview has its own worker so a failed/cancelled full-region load cannot remove it.
    const near=new Worker("./traffic-worker.js?v=8.0-traffic-boundaries-v1");priorityWorker=near;
    const previewDone=()=>{if(token===candidateGeneration&&candidate===next)next.postMessage({action:"load-slots",generation:nextGeneration});};
    const skipPreview=()=>{if(priorityWorker===near){near.terminate();priorityWorker=null;}previewDone();};
    near.onerror=skipPreview;
    near.onmessage=event=>{if(token!==candidateGeneration||!enabled||map!==expectedMap||candidate!==next)return;
      const d=event.data;
      if(d.error||d.previewUnavailable||!d.demand?.pairs){skipPreview();return;}
      priorityWorker=null;stopFollowing();worker?.terminate();worker=near;generation=nextGeneration;
      center=context.center;latest=previous=null;selected=null;trip=null;network=[];roadStates.clear();
      near.onmessage=receive;near.onerror=()=>{if(worker===near){near.terminate();worker=null;setStatus("附近预览中断，等待后台区域结果。");}};
      near.postMessage({action:"pause",paused:isPaused()});near.postMessage({action:"rate",rate:rate()});near.postMessage({action:"count",count:count()});
      receive(event);void ensureGraphics(map);previewDone();
    };
    const local=root.HuayuAtlas.getTrafficContext(null,false);
    loadFull(true);
    near.postMessage({action:"build-preview",generation:nextGeneration,regions,context:{center:context.center,roads:local?.roads||[],demand:local?.demand||[],sourceTimes:local?.sourceTimes||[],trafficInputLimited:!local?.ready||local?.trafficInputLimited},options,paused:isPaused(),rate:rate()});
  }
  function renderRegions(){ui.chosen.replaceChildren();for(const r of regions){const button=document.createElement("button");button.type="button";button.className="secondary-button";button.textContent=`${r.name} · 移除`;button.onclick=()=>{cancelCandidate();regions=regions.filter(x=>x.osm_id!==r.osm_id);renderRegions();ui.regionStatus.textContent="选择已改变，点击加载并模拟应用；当前模拟保留。";};ui.chosen.append(button);}}
  async function searchRegions(){
    const q=ui.query.value.trim();if(!q)return;
    const token=++searchGeneration;searching=true;ui.results.textContent="正在查找完整行政边界…";
    const places=new Map();let boundaries=[];
    const render=(note="")=>{if(token!==searchGeneration)return;
      ui.results.replaceChildren();
      for(const r of boundaries){if(r.osm_type!=="relation"||!r.geojson)continue;
        const b=document.createElement("button");b.className="secondary-button";b.type="button";b.textContent=r.display_name||r.name;
        b.onclick=()=>{if(regions.some(x=>x.osm_id===r.osm_id))return;if(regions.length>=4){ui.regionStatus.textContent="最多选择 4 个行政区。";return;}searchGeneration++;searching=false;cancelCandidate();regions.push(r);renderRegions();ui.results.replaceChildren();ui.regionStatus.textContent="已选择行政区，点击加载并模拟。";};ui.results.append(b);
      }
      if(!boundaries.length)for(const r of places.values()){
        const b=document.createElement("button");b.className="secondary-button";b.type="button";
        b.textContent=`${r.display_name||r.name} · 定位城市点`;
        b.onclick=()=>{if(root.HuayuAtlas.prepareTrafficCamera([Number(r.lon),Number(r.lat)],14))ui.regionStatus.textContent="已定位城市点；可切换“当前街区”模拟附近。整市模拟仍需源地图的完整行政边界。";};ui.results.append(b);
      }
      if(note){const p=document.createElement("p");p.className="model-options-summary";p.textContent=note;ui.results.append(p);}
    };
    const onPlaces=results=>{if(token!==searchGeneration||boundaries.length)return;for(const r of results){
      if((r.category||r.class)!=="place"||!["city","town","village","municipality","borough","suburb"].includes(r.type)
        ||!Number.isFinite(Number(r.lon))||!Number.isFinite(Number(r.lat)))continue;
      places.set(`${r.osm_type}:${r.osm_id}`,r);
    }if(places.size)render("城市点已找到，正在继续查找完整行政边界…");};
    try{boundaries=await root.HuayuAtlas.findAdministrativeCities(q,{onPlaces,exactNames:true});if(token!==searchGeneration)return;
      render(boundaries.length?"":places.size?"已找到城市点，但本次未查到完整行政边界。可先定位并切换“当前街区”；城市点周围的矩形不是行政范围。":"未找到完整行政边界，请补全名称后重试。");
    }catch(e){render(`${e.message==="CITY_SEARCH_TOO_BROAD"?"名称过于宽泛，请补全行政区名称":"查询服务连接失败或超时，本次未能确认行政边界"}${places.size?"；保留已查到的城市点，可先定位并使用当前街区模拟。":"；这不代表城市不存在。"}`);
      if(token===searchGeneration){const retry=document.createElement("button");retry.type="button";retry.className="secondary-button";
        retry.textContent="重试查找";retry.onclick=()=>void searchRegions();ui.results.append(retry);}}
    finally{if(token===searchGeneration)searching=false;}
  }
  function start() {
    Object.assign(ui,{enabled:document.getElementById("traffic-enabled"),controls:document.getElementById("traffic-controls"),
      count:document.getElementById("traffic-count"),rate:document.getElementById("traffic-rate"),side:document.getElementById("traffic-side"),
      pause:document.getElementById("traffic-pause"),reset:document.getElementById("traffic-reset"),near:document.getElementById("traffic-near"),
      status:document.getElementById("traffic-status"),vehicle:document.getElementById("traffic-vehicle"),select:document.getElementById("traffic-select"),
      follow:document.getElementById("traffic-follow"),stop:document.getElementById("traffic-stop-follow")});
    Object.assign(ui,{summary:document.getElementById("traffic-summary"),basis:document.getElementById("traffic-basis"),
      overlay:document.getElementById("traffic-overlay"),lanes:document.getElementById("traffic-lanes"),laneStatus:document.getElementById("traffic-lane-status"),time:document.getElementById("traffic-time"),demand:document.getElementById("traffic-demand")});
    Object.assign(ui,{buildingAudit:document.getElementById("traffic-building-audit"),buildingSummary:document.getElementById("traffic-building-summary"),buildingRows:document.getElementById("traffic-building-rows")});
    Object.assign(ui,{hotspots:document.getElementById("traffic-hotspots"),scope:document.getElementById("traffic-scope"),regions:document.getElementById("traffic-regions"),query:document.getElementById("traffic-region-query"),
      results:document.getElementById("traffic-region-results"),chosen:document.getElementById("traffic-region-selected"),cancel:document.getElementById("traffic-region-cancel"),regionStatus:document.getElementById("traffic-region-status"),overview:document.getElementById("traffic-region-overview")});
    if(!ui.enabled)return;
    ui.enabled.addEventListener("change",()=>setEnabled(ui.enabled.checked));
    ui.pause.addEventListener("click",()=>{paused=!paused;if(paused)stopFollowing();worker?.postMessage({action:"pause",paused:isPaused()});refreshUi();if(!paused)startFrames();});
    ui.reset.addEventListener("click",()=>syncContext(true));
    ui.scope.addEventListener("change",()=>{disposeMap();syncContext(!regional());refreshUi();});
    document.getElementById("traffic-region-search").addEventListener("click",searchRegions);
    ui.query.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();void searchRegions();}});
    ui.query.addEventListener("input",()=>{searchGeneration++;searching=false;ui.results.replaceChildren();});
    document.getElementById("traffic-region-build").addEventListener("click",()=>buildRegions());
    ui.cancel.addEventListener("click",()=>{cancelCandidate();regionProgress=ui.regionStatus.textContent="已取消全域加载，保留已有模拟或附近预览。";refreshUi();});
    document.getElementById("traffic-region-overview").addEventListener("click",()=>{const b=latest?.bounds;if(b&&map){stopFollowing();map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:60,duration:800});}});
    ui.near.addEventListener("click",()=>{root.HuayuAtlas.prepareTrafficCamera();syncContext(true);});
    ui.count.addEventListener("change",()=>{worker?.postMessage({action:"count",count:count()});refreshUi();map?.triggerRepaint();});
    ui.overlay.addEventListener("change",syncOverlays);
    ui.lanes.addEventListener("change",()=>requestLanes(true));
    root.addEventListener('huayu-bridge-settings-change',()=>{refreshBridgeNote();map?.triggerRepaint();});
    ui.time.addEventListener("change",()=>{if(/^\d\d:\d\d$/.test(ui.time.value))regional()?buildRegions(true):syncContext(true);});
    ui.demand.addEventListener("change",()=>regional()?buildRegions(true):syncContext(true));
    ui.rate.addEventListener("change",()=>worker?.postMessage({action:"rate",rate:rate()}));
    ui.side.addEventListener("change",()=>regional()?buildRegions(true):syncContext(true));
    ui.select.addEventListener("change",()=>{stopFollowing();selectCar(ui.select.value);});
    ui.follow.addEventListener("click",follow);ui.stop.addEventListener("click",stopFollowing);
    document.getElementById("reset-render-settings").addEventListener("click",()=>setEnabled(false));
    document.addEventListener("visibilitychange",()=>{worker?.postMessage({action:"pause",paused:isPaused()});if(document.hidden){cancelAnimationFrame(frame);frame=0;stopFollowing();}else startFrames();});
    document.getElementById("map").addEventListener("pointerdown",stopFollowing,{passive:true,capture:true});
    document.getElementById("map").addEventListener("wheel",stopFollowing,{passive:true,capture:true});
    document.getElementById("map").addEventListener("click",event=>{
      if(!enabled || !map || !root.HuayuAtlas.canPickTraffic())return;
      const rect=map.getCanvas().getBoundingClientRect();
      if(pick(null,{x:event.clientX-rect.x,y:event.clientY-rect.y})){event.preventDefault();event.stopPropagation();}
    },{capture:true});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"||following&&["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key))stopFollowing();});
    refreshUi();
    if(new URLSearchParams(root.location.search).get("panel")==="simulation")root.HuayuAtlas.openView("simulation",{preservePerspective:true});
  }
  root.HuayuTraffic=Object.freeze({syncContext,pick,disposeMap,setEnabled,
    inspect:()=>({enabled,paused,following,selected,hasWorker:Boolean(worker),hasGraphics:Boolean(graphics),generation,status,center,frame:!!frame,
      pendingContext,loadingRegion:Boolean(candidate),regions:regions.map(r=>({name:r.name,id:r.osm_id})),searching,
      drawn:graphics?.drawn||0,drawnBridge:graphics?.drawnBridge||0,bridgeSurfaces:graphics?.bridgeData?{segments:graphics.bridgeData.segments,limited:graphics.bridgeData.limited,flowBands:[...new Set(graphics.bridgeData.groups.map(g=>g.band))]}:null,route:trip,networkSize:network.length,lanes:laneResult?{roads:laneResult.roads,estimated:laneResult.estimated,vertices:laneResult.vertices,limited:laneResult.limited}:null,snapshot:latest})});
  if(root.HuayuAtlas)start();else root.addEventListener("huayu:map-ready",start,{once:true});
})(window);
