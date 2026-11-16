(function installTrafficSimulation(root) {
  "use strict";
  const LAYER = "ogf-atlas-traffic-cars", MAX = 1200;
  const FLOW="ogf-atlas-traffic-flow", ROUTE="ogf-atlas-traffic-trip", STOPS="ogf-atlas-traffic-stops";
  const LANES="ogf-atlas-traffic-lanes",laneLayers=[LANES,`${LANES}-edge`,`${LANES}-divider`,`${LANES}-center`];
  let laneRequest=0,laneTimer=0,laneBounds=null,laneWorker=null,laneResult=null;
  let bridgeRequest=0,bridgeResult=null,bridgeWorker=null,bridgeIndex=null,bridgeBounds=null,bridgeAt=0,bridgeTimer=0;
  const colors = ["#e5e0d5", "#d2674f", "#50869b", "#e4b85c", "#78847b", "#9c8eaf"];
  let enabled = false, paused = false, selected = null, following = false, worker = null, generation = 0;
  let lanesBeforeSimulation=null;
  let bridgeSource=null,simulationBridgeRoads=[];
  let map, layer, graphics, alive = 0, frame = 0, lastFrame = 0, followAt = 0, lastUi = 0;
  let center, signature, latest, previous, received = 0, projected = [], preparing = false, status = "默认关闭，开启后可选择城市、区县、省、国家或局部街区。";
  let flowDirty=true,routeDirty=true,flowRatios=new Map(),previousVehicles=new Map(),basisDemand=null;
  let network=[], roadStates=new Map(), trip=null, pendingContext=false, pendingSignature=null, pendingTimer=0;
  let regions=[],searchGeneration=0,candidate=null,candidateGeneration=0,searching=false;
  let cachedRegion=null,priorityWorker=null,regionProgress="";
  let picking=null,tripRequest=0,tripPending=false;
  let cameraHoldUntil=0,lastFollowDetail=0,lastHud=0;
  let trafficViewport=null,trafficViewportWorker=null,lastTrafficViewport=0;
  const touchPointers=new Set(),mapPointers=new Map();let followPinch=false;
  const tripMarkers=new Map();
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
    const text=!root.HuayuBridgeModels?.get(map)?.visible?'模拟已自动开启桥面；放大到街道近景，完整桥面就绪后自动显示车道，准备期间保留车道示意。'
      :`桥上汽车和路况跟随实际显示的桥面高度${graphics?.bridgeData?.limited?'；本视窗车道细节达到预算，请放大查看其余部分':''}。隧道参与计算，不在地面显示地下汽车。`;
    if(note.textContent!==text)note.textContent=text;
  }
  function refreshUi() {
    refreshBridgeNote();
    refreshStructureLanes();
    ui.enabled.checked = enabled; ui.controls.hidden = !enabled;
    ui.regions.hidden=!regional();ui.overview.hidden=!regional();ui.near.hidden=regional();
    ui.overview.disabled=!latest?.regional;
    ui.pause.textContent = paused ? "继续模拟" : "暂停模拟";
    ui.follow.disabled = !selected || !latest?.vehicles.some(v => v.id === selected && v.phase!=="dwell");
    ui.stop.hidden = !following&&!picking; ui.stop.textContent=picking?"取消车辆选点 · Esc":"停止跟随 · Esc";
    ui.follow.textContent = following ? `正在 ${ui.followMode.value.toUpperCase()} 跟随` : "跟随所选车辆";
    ui.startTrip.disabled=!worker||!latest?.edges||tripPending||latest.vehicles.some(v=>v.manual&&v.phase!=="dwell");
    ui.endTrip.disabled=tripPending||!latest?.vehicles.some(v=>v.manual);
    const car = latest?.vehicles.find(v => v.id === selected);
    ui.vehicle.textContent = car ? `车辆 ${car.id} · ${car.returning?"返程":car.purpose}：${car.origin} → ${car.destination}。${car.phase==="dwell"?`已到达${car.parked?`，在${car.parkingName}示意车位停车`:"，在目的地停留"}，约 ${Math.ceil(car.dwellRemaining/60)} 分钟后返程（车辆不占行车道）`:`${car.phase==="parking"?"正在驶入示意车位 · ":car.phase==="unparking"?"正在驶出车位 · ":""}${car.road} · ${Math.round(car.speed)} km/h${car.waiting?" · 排队／让行":" · 行驶中"}，累计等待 ${Math.round(car.queueSeconds)} 秒`}。` : "点击地图上的车辆，或从列表选择，可查看用途、路线和停留。";
    if(car&&car.phase!=="dwell")ui.vehicle.textContent+=` 本方向第 ${car.lane||1}／${car.lanes||1} 车道（${car.laneSource==="tag"?"标签":car.laneSource==="width"?"路宽估算":"道路类型估算"}）。`;
    if(car?.manual)ui.vehicle.textContent=car.phase==="dwell"?`自定义车辆 ${car.id} · 已到达 ${car.destination}，本次行程结束。`:"自定义观察车 · "+ui.vehicle.textContent;
    refreshFollowHud();
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
        ui.summary.textContent=`${latest.regionNames.join("、")} · 已知人口 ${d.totalResidents.toLocaleString()} 人（已接路约 ${Math.round(d.taggedResidents).toLocaleString()} 人，未接路约 ${Math.round(d.unconnectedResidents).toLocaleString()} 人${d.missingPopulation?`；${d.missingPopulation} 个行政区缺直接人口，未知部分未补算`:""}）· 模拟 ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}。路段计算约 ${latest.moving.toLocaleString()} 辆在途、${latest.waiting.toLocaleString()} 辆排队，${latest.pending.toLocaleString()} 车次等待进入路网；累计到达 ${latest.arrived}、返家 ${latest.returned}。预计去程 ${Math.round(d.hourly).toLocaleString()}、返程 ${Math.round(d.returnHourly).toLocaleString()} 车次／小时，25 公里内约 ${(d.nearbyShare*100).toFixed(1)}%，100 公里以上约 ${(d.remoteShare*100).toFixed(1)}%。近景从 ${latest.sampleCount} 个行程样本中最多绘制 ${count()} 辆，样本不等于总车数。${latest.parking?`停车占用约 ${latest.parking.occupied}／${latest.parking.capacity} 位，入场排队约 ${latest.parking.waiting} 辆。`:""}`;
        if(updateBasis){const rows=d.populationRows||[];
        ui.basis.textContent=`分层人口合计 ${d.totalResidents.toLocaleString()} 人；父子人口只分配一次。接入道路过远未分配 ${Math.round(d.unconnectedResidents).toLocaleString()} 人，无往返设施未分配 ${Math.round(d.unservedResidents).toLocaleString()} 人；${d.crossPairs} 组跨区域可达起终点。${d.missingPopulation} 个行政区无直接人口，采用已知下级，未知部分不填零；${d.populationConflicts.length} 处上下级人口冲突（保留下级）：${d.populationConflicts.map(c=>`${c.name}上级 ${c.parent.toLocaleString()}、下级合计 ${c.children.toLocaleString()}`).join("；")}。${rows.map(r=>`${r.name}：${r.population===null?"未标":r.population.toLocaleString()}，${r.source}${r.residual?`，上级剩余分配 ${r.residual.toLocaleString()} 人`:""}`).join("；")}。最早上游时间：${stamp}。人口及设施接入点为估算，不是实测出入口。区域／小区人口表示整片范围，优先按全域建筑的用途、占地及楼层分配位置，分区过多时空间合并并保留全部人口；缺少建筑时使用住宅用地或范围内道路回退。${d.parkingNote||""}`;
        ui.basis.textContent+=(d.allocationNote||"")+(d.distanceNote||"")+(d.transportNote||"");
        if(d.populationLocalities){const l=d.populationLocalities;
          ui.basis.textContent+=` 地名人口覆盖：${l.total} 个国家／省／城市／社区等地名点中，${l.withPopulation} 个有有效人口，${l.withoutPopulation} 个未标；未标地点可使用已知上级总人口分配位置，不另造人口。上级也未标时，该部分人口未知。`;}
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
        const label=v.id+" · "+(v.manual?"自定义 · ":"")+(v.parked?"已停车":v.phase==="dwell"?"停留":v.returning?"返程":v.purpose)+" · "+v.destination;
        if(option.text!==label)option.text=label;
      }
      for(const [id,option] of options)if(!ids.has(id)){option.remove();options.delete(id);}
      ui.select.append(fragment);ui.select.value=selected?String(selected):"";
    }
  }
  function stopFollowing() {
    if (!following) return;
    following = false; followAt = 0;cameraHoldUntil=0; try{if(map?.isEasing())map.stop();}catch{} syncFollowPaint();refreshUi();
  }
  function syncFollowPaint(){
    if(!map?.style||map._removed)return;
    if(map.getLayer(FLOW))map.setPaintProperty(FLOW,"line-opacity",.8);
    if(map.getLayer(ROUTE)){map.setPaintProperty(ROUTE,"line-color",following?"#1695ed":"#f5c844");
      map.setPaintProperty(ROUTE,"line-width",following?3:5);map.setPaintProperty(ROUTE,"line-opacity",following ? .7 : .9);}
  }
  function refreshFollowHud(){
    if(!ui.hud)return;
    const car=latest?.vehicles.find(v=>v.id===selected);ui.hud.hidden=!following||!car;
    if(!following||!car){ui.marker.hidden=true;return;}
    const guide=latest.guidance?.id===selected?latest.guidance:null,view=root.HuayuTrafficCamera.laneView(car,guide);
    const text=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
    text(ui.hudTitle,`${car.manual?"自定义观察车":"模拟车辆"} ${car.id}${paused?" · 已暂停":""}`);
    const traffic=guide?.traffic,label=!traffic?"暂无模拟路况":traffic.count<=0?"暂无在途量":traffic.ratio<.35?"模拟拥堵":traffic.ratio<.65?"模拟缓行":"模拟畅通";
    text(ui.hudTraffic,`当前路段：${label}${traffic?.count>0?` · 约 ${Math.round(traffic.waiting)} 辆排队`:""} · 周边展示 ${graphics?.drawnOthers||0} 辆`);
    ui.hudTraffic.dataset.state=traffic?.count>0&&traffic.ratio<.65?"slow":"normal";
    text(ui.hudRoad,car.road||"未命名道路");text(ui.hudSpeed,String(Math.round(car.speed)));
    const arrows={left:"↰",right:"↱",straight:"↑",arrive:"●"},turns={left:"左转",right:"右转",straight:"继续直行",arrive:"到达道路接入点"};
    text(ui.hudSymbol,arrows[guide?.turn]||"↑");
    text(ui.hudNext,guide?`${car.phase==="turn"?"正在转弯":`${Math.round(guide.remaining)} 米后${turns[guide.turn]||"继续行驶"}`} · ${guide.nextRoad||car.destination}`:car.destination);
    text(ui.hudLanes,view.summary);text(ui.hudStructure,view.structure);text(ui.hudSource,view.note);
    const laneKey=`${view.n}:${view.lane}:${view.shared}:${view.reverse}`;
    if(ui.hudStrip.dataset.key!==laneKey){ui.hudStrip.dataset.key=laneKey;ui.hudStrip.replaceChildren();
      for(let index=0;index<view.n;index++){const i=view.reverse?view.n-index:index+1,lane=document.createElement("span"),arrow=document.createElement("b"),label=document.createElement("small");
        arrow.textContent=i===view.lane?"▲":"↑";label.textContent=view.shared?"共享":String(i);lane.append(arrow,label);
        if(i===view.lane){lane.className="is-current";lane.setAttribute("aria-label",`当前第 ${i} 车道`);}ui.hudStrip.append(lane);}
    }
    refreshTunnelView(car,guide);
    let note=view.shared?"窄双向路共享路面；蓝色为当前车辆位置。":"蓝色为当前车辆所在车道；示意不代表转向专用车道。";
    if(view.structure==="隧道")note="隧道示意按当前车道及附近车辆位置更新；未绘制地下实景，车辆与车道不投到地面。";
    else if(guide?.bridge||guide?.elevated)note=bridgeIndex?"桥面分道线与汽车使用已显示桥面的高度；俯视与 3D 均自动显示近景车道。":"正在准备完整桥面与高度，车道信息继续显示。";
    else if(map?.getZoom()<16)note="已缩小：地图隐藏细标线，车道数量与当前车道继续显示。";
    else if(!ui.lanes.checked)note="已隐藏地图分道线，车道信息仍显示；可在模拟设置开启近景车道。";
    text(ui.hudSurface,note);text(ui.hudMode,ui.followMode.value==="3d"?"切换 2D":"切换 3D");
    ui.hudBridge.hidden=!(guide?.bridge&&!guide?.tunnel&&map?.getPitch()<5);
    text(ui.hudBridge,map?.getPitch()<5?"开启 3D 桥面车道":"开启桥面与实景车道");
    if(guide?.tunnel)ui.marker.hidden=true;
  }
  function refreshTunnelView(car,guide){
    const view=root.HuayuTrafficCamera.tunnelView(car,guide,latest.vehicles);
    ui.hudTunnel.hidden=!view;ui.hudStrip.hidden=Boolean(view);if(!view)return;
    const svg=ui.hudTunnelScene,key=`${view.n}:${view.reverse}`;
    const node=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
    if(svg.dataset.key!==key){
      svg.dataset.key=key;svg.replaceChildren(node('rect',{x:16,y:4,width:288,height:116,rx:6,class:'traffic-tunnel-road'}));
      for(let i=1;i<view.n;i++){const x=16+i*288/view.n;svg.append(node('line',{x1:x,x2:x,y1:4,y2:120,class:'traffic-tunnel-divider'}));}
      svg._cars=node('g',{});svg._pool=[];svg.append(svg._cars);
      svg._halo=node('rect',{class:'traffic-tunnel-halo',rx:6});svg._selected=node('rect',{class:'traffic-tunnel-car is-selected',rx:3});svg.append(svg._halo,svg._selected);
    }
    const position=(e,c,pad=0)=>{for(const [k,v] of Object.entries({x:c.x-c.width/2-pad,y:c.y-10-pad,width:c.width+pad*2,height:20+pad*2}))e.setAttribute(k,String(v));};
    position(svg._selected,view.selected);position(svg._halo,view.selected,4);
    for(let i=0;i<view.nearby.length;i++){if(!svg._pool[i]){svg._pool[i]=node('rect',{class:'traffic-tunnel-car',rx:3});svg._cars.append(svg._pool[i]);}const e=svg._pool[i];e.removeAttribute('display');position(e,view.nearby[i]);}
    for(let i=view.nearby.length;i<svg._pool.length;i++)svg._pool[i].setAttribute('display','none');
  }
  function onFollowDrag(event){if(!following||!event.originalEvent)return;
    if(followPinch||touchPointers.size>1||(event.originalEvent.touches?.length||0)>1)return;
    stopFollowing();
  }
  function onFollowZoom(){if(following)cameraHoldUntil=performance.now()+600;}
  function onFollowZoomInput(){
    if(!following)return;
    const now=performance.now();
    // Release our camera ease before MapLibre handles the first wheel/touch event.
    // Later events in the same gesture must not interrupt its zoom animation.
    if(now>cameraHoldUntil&&map?.isEasing())map.stop();
    cameraHoldUntil=now+600;
  }
  function onFollowPointerDown(event){
    if(event.pointerType==="touch")touchPointers.add(event.pointerId);
    if(event.target!==map?.getCanvas())return;
    mapPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(touchPointers.size>1)followPinch=true;
    onFollowZoomInput();
  }
  function onFollowPointerMove(event){
    const start=mapPointers.get(event.pointerId);
    if(following&&start&&!followPinch&&mapPointers.size===1&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>8)stopFollowing();
  }
  function onFollowPointerUp(event){
    touchPointers.delete(event.pointerId);mapPointers.delete(event.pointerId);
    if(!mapPointers.size)followPinch=false;
    onFollowZoom();
  }
  function followZoom(delta){if(!following||!map)return;
    cameraHoldUntil=performance.now()+650;
    const car=latest?.vehicles.find(v=>v.id===selected);
    map.easeTo({center:car?.coordinate||map.getCenter(),zoom:Math.max(map.getMinZoom(),Math.min(map.getMaxZoom(),map.getZoom()+delta)),duration:350});
    requestLanes(true);
  }
  function releaseGraphics() {
    if (!graphics) return;
    const old=graphics;graphics=null;projected=[];
    clearBridgeGraphics(old);old.parts.forEach(mesh=>mesh.dispose());old.resources.forEach(r => r.dispose());
    old.renderer.dispose();
  }
  function disposeMap(expectedMap) {
    if(expectedMap && map!==expectedMap)return;
    cancelTripPick();tripRequest++;tripPending=false;
    for(const marker of tripMarkers.values())marker.remove();tripMarkers.clear();
    alive++; stopFollowing(); cancelAnimationFrame(frame); frame = 0;
    searchGeneration++;searching=false;
    cancelCandidate();cachedRegion=null;worker?.terminate(); worker = null; generation++;
    clearTimeout(pendingTimer);pendingTimer=0;pendingSignature=null;pendingContext=false;
    clearTimeout(laneTimer);laneTimer=0;laneRequest++;laneBounds=null;laneWorker=null;laneResult=null;
    clearTimeout(bridgeTimer);bridgeTimer=0;bridgeRequest++;bridgeResult=null;bridgeWorker=null;bridgeIndex=null;bridgeBounds=null;
    network=[];roadStates.clear();trip=null;flowDirty=routeDirty=true;flowRatios.clear();previousVehicles.clear();basisDemand=null;decoder=new root.HuayuTrafficProtocol.Decoder();
    setBridgeRoads(null);if(ui.structureLanes)ui.structureLanes.hidden=true;
    trafficViewport=null;trafficViewportWorker=null;lastTrafficViewport=0;
    const oldMap=map;map = null; layer = null; center = null; signature = null;
    touchPointers.clear();mapPointers.clear();followPinch=false;
    latest = previous = null; selected = null; preparing = false;regionProgress="";
    // Map removal can discard its style before cleanup listeners run.
    // Releasing our resources must not depend on a live style/getLayer.
    try {
      oldMap?.off("moveend", onMove);oldMap?.off("dragstart",onFollowDrag);oldMap?.off("zoom",onFollowZoom); oldMap?.off("remove", onRemove);
      if (oldMap?.getLayer(LAYER)) oldMap.removeLayer(LAYER);
      for(const id of [...laneLayers,FLOW,ROUTE,STOPS,`${STOPS}-names`])if(oldMap?.getLayer(id))oldMap.removeLayer(id);
      for(const id of [LANES,FLOW,ROUTE,STOPS])if(oldMap?.getSource(id))oldMap.removeSource(id);
    } catch {} finally {releaseGraphics();}
  }
  function onRemove() {disposeMap(); if (enabled) {setStatus("等待华域矢量底图就绪…"); refreshUi();}}
  function setEnabled(value) {
    const changed=enabled!==Boolean(value);
    if(changed&&value){lanesBeforeSimulation=ui.lanes.checked;ui.lanes.checked=true;}
    else if(changed&&lanesBeforeSimulation!==null){ui.lanes.checked=lanesBeforeSimulation;lanesBeforeSimulation=null;}
    enabled = Boolean(value); paused = false;
    if (!enabled) {disposeMap(); setStatus("已关闭车流模拟。地图功能保持原有状态。");}
    else if(regional()) {setStatus("请选择城市／区县／省份，再点击加载并模拟。");syncContext();}
    else syncContext(true);
    if(changed)root.dispatchEvent(new CustomEvent("huayu-traffic-render-change"));
    refreshUi();
  }
  function onMove() {
    if(enabled&&map)requestLanes();
    if (!enabled || !map || preparing) return;
    if(regional()||latest?.regional){sendViewport();return;}
    if(following)return;
    const c = map.getCenter();
    const meters = center ? Math.hypot((c.lng - center[0]) * 111320 * Math.cos(c.lat*Math.PI/180), (c.lat-center[1])*111320) : Infinity;
    if (meters > 450) syncContext(true);
    else if (map.getZoom() < 14) setStatus("模拟仍在当前街区；放大到街道可查看汽车，或点击“移近当前街区”。");
  }
  function sendViewport(force=false){
    if(!map||!worker||!latest?.regional)return;
    const b=map.getBounds(),raw=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],car=following&&latest.vehicles.find(v=>v.id===selected);
    const bounds=car?root.HuayuTrafficCamera.laneWindow(raw,car.coordinate):raw;
    if(bounds[2]-bounds[0]>.12||bounds[3]-bounds[1]>.12)return;
    if(car&&!force){
      const inner=bounds.map((v,i)=>car.coordinate[i%2]+(v-car.coordinate[i%2])*.7);
      if(trafficViewportWorker===worker&&trafficViewport&&inner[0]>=trafficViewport[0]&&inner[1]>=trafficViewport[1]&&inner[2]<=trafficViewport[2]&&inner[3]<=trafficViewport[3])return;
      if(performance.now()-lastTrafficViewport<1500)return;
    }
    trafficViewport=bounds;trafficViewportWorker=worker;lastTrafficViewport=performance.now();
    worker.postMessage({action:"viewport",generation,bounds});
  }
  function requestLanes(force=false){
    if(!map||!worker||!latest)return;
    const visible=ui.lanes.checked&&map.getZoom()>=16;
    for(const id of laneLayers)if(map.getLayer(id))map.setLayoutProperty(id,"visibility",visible?"visible":"none");
    if(!visible){clearTimeout(laneTimer);laneRequest++;laneBounds=null;if(ui.structureLanes)ui.structureLanes.hidden=true;ui.laneStatus.textContent=ui.lanes.checked?"放大到街道近景显示车道。":"已隐藏分道线，车辆仍按车道行驶。";return;}
    const b=map.getBounds(),c=map.getCenter(),car=following&&latest.vehicles.find(v=>v.id===selected);
    const anchor=car?.coordinate||[c.lng,c.lat],window=root.HuayuTrafficCamera.laneWindow([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],anchor);
    const bounds=window.map((v,i)=>anchor[i%2]+(v-anchor[i%2])*.7);
    refreshStructureLanes();
    if(!force&&laneWorker===worker&&laneBounds&&bounds[0]>=laneBounds[0]&&bounds[1]>=laneBounds[1]&&bounds[2]<=laneBounds[2]&&bounds[3]<=laneBounds[3])return;
    clearTimeout(laneTimer);const token=++laneRequest;
    laneTimer=setTimeout(()=>{
      laneTimer=0;if(!map||!worker||!enabled||token!==laneRequest)return;
      // A horizontal camera can have enormous ground bounds. Keep near geometry bounded.
      laneBounds=window;laneWorker=worker;
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
    const before=map.getLayer(LAYER)?LAYER:undefined;
    for(const [kind,color,dash] of [["edge","#f5f2e6"],["divider","#faf8ee",[25,25]],["center","#f2cb61"]]){
      const id=`${LANES}-${kind}`;if(map.getLayer(id))continue;
      map.addLayer({id,type:"line",source:LANES,minzoom:16,filter:["==",["get","kind"],kind],layout:{"line-join":"round","line-cap":"butt"},paint:{"line-color":color,"line-width":pixels(.65),"line-opacity":.92,...(dash?{"line-dasharray":dash}:{})}},before);
    }
    const visibility=ui.lanes.checked&&map.getZoom()>=16?"visible":"none";
    for(const id of laneLayers)map.setLayoutProperty(id,"visibility",visibility);
    updateLaneStatus();
  }
  function updateLaneStatus(){
    const result=laneResult;if(!result)return;
    const bridgeNote=result.deferredElevated?`；另有 ${result.deferredElevated} 段桥梁／高架已计入车流，按已接管的合法桥面区间显示分道线，未就绪部分保留原道路` : "";
    const tunnelNote=result.deferredTunnel?`；另有 ${result.deferredTunnel} 段隧道已计入车流，自动显示独立车道图（非地下实景）` : "";
    ui.laneStatus.textContent=`近景 ${result.roads} 段路面，${result.estimated} 段车道数为估算${result.limited?"；本视窗达细节预算，请放大查看其余道路":""}${bridgeNote}${tunnelNote}。窄双向路保留共享路面。`;
    refreshStructureLanes();
  }
  function setBridgeRoads(features){
    if(bridgeSource===features)return;
    bridgeSource=features;simulationBridgeRoads=root.HuayuBridgeModels?.trafficRoads(features)||[];
    root.dispatchEvent(new CustomEvent("huayu-traffic-roads-change"));
  }
  function refreshStructureLanes(){
    if(!ui.structureLanes)return;
    const visible=enabled&&!following&&map&&laneWorker===worker&&ui.lanes.checked&&map.getZoom()>=16&&!document.hidden;
    const b=visible?map.getBounds():null;
    const view=visible?root.HuayuTrafficCamera.structureView(laneResult?.deferred||[],ui.structureSelect.value,
      [b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],graphics?.bridgeData?bridgeIndex?.roadIds:null):null;
    ui.structureLanes.hidden=!view;if(!view)return;
    const key=view.choices.map(r=>`${r.roadId}:${r.name}`).join('|');
    if(ui.structureSelect.dataset.key!==key){ui.structureSelect.dataset.key=key;ui.structureSelect.replaceChildren();
      for(const r of view.choices)ui.structureSelect.add(new Option(`${r.tunnel?'隧道':'桥梁／高架'} · ${r.name}`,r.roadId));}
    ui.structureSelect.value=view.road.roadId;
    ui.structureCount.textContent=`本条道路共 ${view.road.lanes} 道 · ${view.source}`;
    const laneKey=view.road.directions.join(',');
    if(ui.structureStrip.dataset.key!==laneKey){ui.structureStrip.dataset.key=laneKey;ui.structureStrip.replaceChildren();
      for(const direction of view.road.directions){const lane=document.createElement('span');lane.textContent=direction===1?'↑':direction===-1?'↓':'↕';
        lane.setAttribute('aria-label',direction===1?'正向车道':direction===-1?'反向车道':'双向共享车道');ui.structureStrip.append(lane);}}
    ui.structureNote.textContent=view.road.tunnel?'隧道车道示意 · 非地下实景；跟随隧道车辆可查看附近样本车。':'该段桥面尚未就绪，保留车道示意；有效桥面就绪后自动显示地图标线。';
  }
  function clearBridgeGraphics(g=graphics){
    if(!g)return;for(const mesh of g.bridgeMeshes||[]){g.bridgeScene?.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}g.bridgeMeshes=[];g.bridgeData=null;
  }
  function syncBridgeSurfaces(){
    if(!map||!worker||!graphics||document.hidden)return;
    const controller=root.HuayuBridgeModels?.get(map),result=controller?.visible?controller.result:null;
    if(!result){clearTimeout(bridgeTimer);bridgeTimer=0;if(bridgeResult){bridgeRequest++;bridgeResult=null;bridgeWorker=null;bridgeIndex=null;bridgeBounds=null;clearBridgeGraphics();refreshBridgeNote();}return;}
    const now=performance.now(),unchanged=result===bridgeResult&&bridgeWorker===worker;
    if(unchanged&&now-bridgeAt<750){
      // Paused camera moves may have no later animation frame. Finish the trailing check once.
      if(!bridgeTimer)bridgeTimer=setTimeout(()=>{bridgeTimer=0;syncBridgeSurfaces();},750-(now-bridgeAt));
      return;
    }
    clearTimeout(bridgeTimer);bridgeTimer=0;bridgeAt=now;
    const b=map.getBounds(),c=map.getCenter(),car=following&&latest?.vehicles.find(v=>v.id===selected),anchor=car?.coordinate||[c.lng,c.lat];
    const window=root.HuayuTrafficCamera.laneWindow([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],anchor),inner=window.map((v,i)=>anchor[i%2]+(v-anchor[i%2])*.7);
    if(unchanged&&bridgeBounds&&inner[0]>=bridgeBounds[0]&&inner[1]>=bridgeBounds[1]&&inner[2]<=bridgeBounds[2]&&inner[3]<=bridgeBounds[3])return;
    if(result!==bridgeResult){bridgeIndex=root.HuayuTrafficSurfaces.index(result.accepted);bridgeResult=result;clearBridgeGraphics();}
    if(bridgeWorker!==worker)clearBridgeGraphics();
    bridgeBounds=window;bridgeWorker=worker;
    worker.postMessage({action:"bridge-surfaces",generation,request:++bridgeRequest,bounds:bridgeBounds,origin:result.origin,
      plans:result.accepted.map(p=>({samples:p.samples,heights:p.heights,surfaceWidths:p.surfaceWidths}))});
  }
  function showBridgeSurfaces(data){
    if(!graphics)return;clearBridgeGraphics();const g=graphics,T=g.T;
    g.bridgeScene ||= new T.Scene();g.bridgeCamera ||= new T.Camera();
    const build=(positions,colors,opacity,order,color='#fff')=>{const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(positions,3));if(colors)geometry.setAttribute('color',new T.BufferAttribute(colors,3));
      const material=new T.MeshBasicMaterial({color,vertexColors:Boolean(colors),side:T.DoubleSide,transparent:true,opacity,depthTest:true,depthWrite:order!==-2,toneMapped:false});
      const mesh=new T.Mesh(geometry,material);mesh.renderOrder=order;mesh.frustumCulled=false;g.bridgeScene.add(mesh);return mesh;};
    // Pavement/marks write shared depth so a later bridge draw cannot cover them.
    // Flow remains translucent without blocking the physical deck or vehicles.
    g.bridgeMeshes=[build(data.positions,data.colors,1,-1),build(data.flow,new Float32Array(data.flow.length),.8,-2),build(data.surface,null,1,-3,'#7d8183')];g.bridgeData=data;updateBridgeFlow();refreshBridgeNote();refreshStructureLanes();
    map.triggerRepaint();
  }
  function updateBridgeFlow(){
    const g=graphics;if(!g?.bridgeData)return;const attr=g.bridgeMeshes[1].geometry.getAttribute('color');let dirty=false;
    for(const group of g.bridgeData.groups){let ratio=-1;for(const id of group.ids||[]){const r=roadStates.get(id)?.ratio;if(Number.isFinite(r))ratio=ratio<0?r:Math.min(ratio,r);}
      const band=ratio<0?-1:ratio<.35?0:ratio<.65?1:2;if(group.band===band)continue;group.band=band;g.color.set(band<0?'#8793a3':band===0?'#d75343':band===1?'#d69a28':'#369c79');
      for(let i=group.start;i<group.start+group.count;i++)attr.setXYZ(i,g.color.r,g.color.g,g.color.b);dirty=true;}
    if(dirty)attr.needsUpdate=true;
  }
  function selectCar(id) {
    if(following&&Number(id)!==selected)stopFollowing();
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
    syncFollowPaint();
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
          const haloGeometry=new T.RingGeometry(2.8,3.2,40),haloMaterial=new T.MeshBasicMaterial({color:"#188aff",transparent:true,opacity:.85,depthTest:true,depthWrite:false,side:T.DoubleSide,toneMapped:false});
          const halo=new T.Mesh(haloGeometry,haloMaterial);halo.visible=false;scene.add(halo);
          graphics = {T,renderer,scene,camera,parts,halo,resources:[box,bodyMaterial,glass,tires,haloGeometry,haloMaterial],dummy:new T.Object3D(),
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
          const rect = mapInstance.getCanvas(),canvasBox=following?rect.getBoundingClientRect():null,overlayBox=following?ui.marker.offsetParent?.getBoundingClientRect():null;
          let n=0,bridgeCars=0; projected=[];g.halo.visible=false;ui.marker.hidden=true;
          const terrain = mapInstance.getTerrain?.();
          const view=mapInstance.getBounds();
          if(g.bridgeMeshes?.length){g.bridgeMeshes[0].visible=g.bridgeMeshes[2].visible=ui.lanes.checked&&mapInstance.getZoom()>=16;g.bridgeMeshes[1].visible=ui.overlay.checked;}
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
            g.color.set(car.id===selected ? "#087dff" : colors[car.id%colors.length]);g.parts[0].setColorAt(n,g.color);
            const clip = new T.Vector3(x,y,z+1).applyMatrix4(g.camera.projectionMatrix);
            if(car.id===selected){g.halo.position.set(x,y,z+.035);g.halo.visible=true;
              if(following&&clip.z>=-1&&clip.z<=1){ui.marker.hidden=false;ui.marker.style.left=`${canvasBox.left-(overlayBox?.left||0)+(clip.x+1)*canvasBox.width/2}px`;ui.marker.style.top=`${canvasBox.top-(overlayBox?.top||0)+(1-clip.y)*canvasBox.height/2}px`;
                ui.marker.querySelector("i").style.transform=`rotate(${90-angle*180/Math.PI-mapInstance.getBearing()}deg)`;}}
            if(clip.z>=-1&&clip.z<=1) projected.push({id:car.id,x:(clip.x+1)*rect.clientWidth/2,y:(1-clip.y)*rect.clientHeight/2});
            n++;
          }
          g.drawn=n;g.drawnOthers=n-(g.halo.visible?1:0);g.drawnBridge=bridgeCars;g.parts.forEach(mesh=>{mesh.count=n;mesh.instanceMatrix.needsUpdate=true;});
          if(g.parts[0].instanceColor)g.parts[0].instanceColor.needsUpdate=true;
          root.HuayuSunlight?.applyScene(mapInstance,g.scene);
          g.renderer.resetState();g.renderer.setViewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
          const bridgeTransform=root.HuayuBridgeModels?.get(mapInstance)?.transform;
          if(g.bridgeMeshes?.length&&bridgeTransform){
            // Use the deck's exact origin and camera matrix, avoiding cross-origin depth jitter.
            g.bridgeCamera.projectionMatrix.copy(g.projection).multiply(bridgeTransform);
            g.renderer.render(g.bridgeScene,g.bridgeCamera);
          }
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
    const moving=()=>latest&&(latest.moving||latest.vehicles.some(v=>v.manual&&v.phase!=="dwell"));
    if(frame || !enabled || document.hidden || !map || !moving()) return;
    const tick = now => {
      frame=0;
      if(!enabled || document.hidden || !map || !moving())return;
      if(now-lastFrame>=32) {
        lastFrame=now;
        if(map.getZoom()>=14) map.triggerRepaint();
        if(following&&now-lastFollowDetail>750){lastFollowDetail=now;requestLanes();sendViewport();}
        if(following && now-followAt>400 && now>cameraHoldUntil && !mapPointers.size && !map.isZooming()) {
          followAt=now;const car=latest.vehicles.find(v=>v.id===selected);
          if(!car||car.phase==="dwell")stopFollowing();
          else if(!isPaused()) {
            // Reuse one continuous ease. Avoid moveend/rebuild work on every animation frame.
            map.easeTo({...root.HuayuTrafficCamera.target(car,ui.followMode.value,map.getBearing()),offset:ui.followMode.value==="3d"?[0,ui.hud.offsetParent.clientHeight*.2]:[0,0],duration:700,easing:t=>t,easeId:"huayu-traffic-follow"});
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
    if(event.data.tripResult||event.data.tripError){
      if(event.data.tripRequest!==tripRequest)return;
      tripPending=false;
      if(event.data.tripError)ui.tripStatus.textContent=event.data.tripError;
      else if(event.data.tripResult.ended){stopFollowing();selectCar(null);ui.tripStatus.textContent="自定义行程已结束，可重新设置起点。";}
      else {const result=event.data.tripResult;selectCar(result.id);setTripPoint("start",result.coordinate);
        ui.tripStatus.textContent=`已从起点发车 → ${result.destination}，约 ${(result.distance/1000).toFixed(2)} 公里。${paused?"模拟已暂停，点击继续模拟后行驶。":""}`;follow();}
      refreshUi();return;
    }
    if(event.data.bridgeGeometry||event.data.bridgeError){if(event.data.bridgeRequest!==bridgeRequest)return;
      if(event.data.bridgeGeometry)showBridgeSurfaces(event.data.bridgeGeometry);
      else {bridgeBounds=null;bridgeAt=performance.now()+1500;}return;}
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
    startFrames();if(performance.now()-lastHud>200){lastHud=performance.now();refreshFollowHud();}if(!previous || performance.now()-lastUi>800){lastUi=performance.now();refreshUi();}
  }
  function syncContext(force=false) {
    if(!enabled || !root.HuayuAtlas)return;
    if(regional()&&force){buildRegions();return;}
    const context=root.HuayuAtlas.getTrafficContext(force ? null : center,regional()||!force&&Boolean(worker));
    if(!context?.map || context.satellite) {disposeMap();setStatus("车流仅在华域标准／深夜矢量底图中显示，请切回华域底图。");refreshUi();return;}
    if(map && map!==context.map)disposeMap();
    if(!map){map=context.map;map.on("moveend",onMove);map.on("dragstart",onFollowDrag);map.on("zoom",onFollowZoom);map.on("remove",onRemove);}
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
    cancelTripPick();tripRequest++;tripPending=false;stopFollowing();signature=context.signature;center=context.center;
    setBridgeRoads(context.roads);
    selected=null;latest=previous=null;network=[];roadStates.clear();trip=null;generation++;
    worker?.terminate(); worker=null;
    try {
      worker=new Worker("./traffic-worker.js?v=8.0-auto-structure-lanes-v1");
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
    const keepZoom=following;cancelTripPick();following=true;
    const target=root.HuayuTrafficCamera.target(car,ui.followMode.value,map.getBearing());
    if(!root.HuayuAtlas.prepareTrafficCamera(car.coordinate,keepZoom?map.getZoom():Math.max(map.getZoom(),19),{mode:ui.followMode.value,bearing:target.bearing})){following=false;refreshUi();return;}
    if(!keepZoom)root.HuayuAtlas.hidePanel();
    followAt=0;cameraHoldUntil=0;lastFollowDetail=0;requestLanes(true);sendViewport(true);syncFollowPaint();refreshUi();startFrames();
  }
  function cancelTripPick(){picking=null;map?.getCanvas().classList.remove("traffic-picking");if(ui.stop)refreshUi();}
  function readTripPoint(input,optional=false){
    const value=input.value.trim();if(!value&&optional)return null;
    const tokens=value.split(/[,，\s]+/),parts=tokens.map(Number);
    if(parts.length!==2||tokens.some(t=>!t)||parts.some(n=>!Number.isFinite(n))||Math.abs(parts[0])>85||Math.abs(parts[1])>180)throw Error("坐标请按“纬度,经度”填写，纬度 −85～85，经度 −180～180");
    return [parts[1],parts[0]];
  }
  function setTripPoint(kind,coordinate){
    const input=kind==="start"?ui.start:ui.destination;
    input.value=`${coordinate[1].toFixed(6)},${coordinate[0].toFixed(6)}`;
    tripMarkers.get(kind)?.remove();
    if(map&&root.maplibregl?.Marker)tripMarkers.set(kind,new root.maplibregl.Marker({color:kind==="start"?"#16856e":"#c66a31"}).setLngLat(coordinate).addTo(map));
  }
  function beginTripPick(kind){
    if(!enabled||!map||!latest?.edges){ui.tripStatus.textContent="请先开启模拟并加载街区或行政区路网。";return;}
    stopFollowing();
    if(!root.HuayuAtlas.canPickTraffic()||!root.HuayuAtlas.prepareTrafficCamera(undefined,map.getZoom(),{mode:"2d",bearing:0}))return;
    picking=kind;map.getCanvas().classList.add("traffic-picking");
    ui.tripStatus.textContent=`请点击地图上的${kind==="start"?"起点":"终点"}道路；Esc 或右下角按钮取消。`;refreshUi();
  }
  function startTrip(){
    if(!worker||!latest?.edges)return;
    try{const start=readTripPoint(ui.start),destination=readTripPoint(ui.destination,true);
      cancelTripPick();stopFollowing();tripPending=true;ui.tripStatus.textContent="正在已加载路网中查找可达路线与安全发车车道…";
      worker.postMessage({action:"start-trip",generation,request:++tripRequest,start,destination});refreshUi();
    }catch(error){ui.tripStatus.textContent=error.message;}
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
  function buildRegions(reuse=false,reload=false){
    if(!enabled)return;
    const context=root.HuayuAtlas.getTrafficContext(null,true);
    if(!context?.map||context.satellite){setStatus("请先切回华域标准或深夜底图。");return;}
    if(!regions.length){setStatus("请先查找并添加行政区。");return;}
    if(map&&map!==context.map)disposeMap();
    if(!map){map=context.map;map.on("moveend",onMove);map.on("dragstart",onFollowDrag);map.on("zoom",onFollowZoom);map.on("remove",onRemove);}
    cancelCandidate();const token=++candidateGeneration,nextGeneration=generation+1,expectedMap=map;
    const next=new Worker("./traffic-worker.js?v=8.0-auto-structure-lanes-v1");candidate=next;ui.cancel.hidden=false;
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
      cancelTripPick();tripRequest++;tripPending=false;stopFollowing();worker?.terminate();worker=next;candidate=null;ui.cancel.hidden=true;
      generation=nextGeneration;center=d.bounds?[(d.bounds[0]+d.bounds[2])/2,(d.bounds[1]+d.bounds[3])/2]:context.center;
      cachedRegion=newInput?{key,input:newInput}:cachedRegion;
      setBridgeRoads(cachedRegion?.input.roads||null);
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
      next.postMessage({action:"build-region",generation:nextGeneration,regions,viewport,previewPending,reload:reload&&cachedRegion?.key===key,regionalInput:reuse&&cachedRegion?.key===key?cachedRegion.input:undefined,options,paused:isPaused(),rate:rate()});};
    if(latest?.demand.pairs){loadFull();return;}
    // The preview has its own worker so a failed/cancelled full-region load cannot remove it.
    const near=new Worker("./traffic-worker.js?v=8.0-auto-structure-lanes-v1");priorityWorker=near;
    const previewDone=()=>{if(token===candidateGeneration&&candidate===next)next.postMessage({action:"load-slots",generation:nextGeneration});};
    const skipPreview=()=>{if(priorityWorker===near){near.terminate();priorityWorker=null;}previewDone();};
    near.onerror=skipPreview;
    near.onmessage=event=>{if(token!==candidateGeneration||!enabled||map!==expectedMap||candidate!==next)return;
      const d=event.data;
      if(d.error||d.previewUnavailable||!d.demand?.pairs){skipPreview();return;}
      priorityWorker=null;cancelTripPick();tripRequest++;tripPending=false;stopFollowing();worker?.terminate();worker=near;generation=nextGeneration;
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
    Object.assign(ui,{followMode:document.getElementById("traffic-follow-mode"),start:document.getElementById("traffic-start"),destination:document.getElementById("traffic-destination"),
      startTrip:document.getElementById("traffic-start-trip"),endTrip:document.getElementById("traffic-end-trip"),tripStatus:document.getElementById("traffic-trip-status")});
    Object.assign(ui,{hud:document.getElementById("traffic-follow-hud"),marker:document.getElementById("traffic-follow-marker"),
      hudTitle:document.getElementById("traffic-follow-title"),hudRoad:document.getElementById("traffic-follow-road"),hudNext:document.getElementById("traffic-follow-next"),
      hudSpeed:document.getElementById("traffic-follow-speed"),hudSymbol:document.getElementById("traffic-follow-symbol"),hudLanes:document.getElementById("traffic-follow-lane-count"),
      hudStructure:document.getElementById("traffic-follow-structure"),hudStrip:document.getElementById("traffic-follow-lane-strip"),hudSource:document.getElementById("traffic-follow-lane-source"),
      hudSurface:document.getElementById("traffic-follow-surface-note"),hudMode:document.getElementById("traffic-follow-mode-toggle")});
    ui.hudBridge=document.getElementById("traffic-follow-bridge");
    ui.hudTraffic=document.getElementById("traffic-follow-traffic");
    ui.hudTunnel=document.getElementById("traffic-follow-tunnel");ui.hudTunnelScene=document.getElementById("traffic-follow-tunnel-scene");
    ui.structureLanes=document.getElementById("traffic-structure-lanes");ui.structureSelect=document.getElementById("traffic-structure-select");
    ui.structureCount=document.getElementById("traffic-structure-count");ui.structureStrip=document.getElementById("traffic-structure-strip");ui.structureNote=document.getElementById("traffic-structure-note");
    ui.structureSelect.addEventListener('change',refreshStructureLanes);
    if(!ui.enabled)return;
    ui.enabled.addEventListener("change",()=>setEnabled(ui.enabled.checked));
    ui.pause.addEventListener("click",()=>{paused=!paused;if(paused)stopFollowing();worker?.postMessage({action:"pause",paused:isPaused()});refreshUi();if(!paused)startFrames();});
    ui.reset.addEventListener("click",()=>syncContext(true));
    ui.scope.addEventListener("change",()=>{disposeMap();syncContext(!regional());refreshUi();});
    document.getElementById("traffic-region-search").addEventListener("click",searchRegions);
    ui.query.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();void searchRegions();}});
    ui.query.addEventListener("input",()=>{searchGeneration++;searching=false;ui.results.replaceChildren();});
    document.getElementById("traffic-region-build").addEventListener("click",()=>buildRegions(false,true));
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
    ui.follow.addEventListener("click",follow);ui.stop.addEventListener("click",()=>{if(picking){cancelTripPick();ui.tripStatus.textContent="已取消车辆选点。";}else stopFollowing();});
    ui.followMode.addEventListener("change",()=>{if(following)follow();});
    ui.hudMode.addEventListener("click",()=>{ui.followMode.value=ui.followMode.value==="3d"?"2d":"3d";follow();});
    document.getElementById("traffic-follow-zoom-in").addEventListener("click",()=>followZoom(.5));
    document.getElementById("traffic-follow-zoom-out").addEventListener("click",()=>followZoom(-.5));
    document.getElementById("traffic-follow-settings").addEventListener("click",()=>root.HuayuAtlas.openView("simulation",{preservePerspective:true}));
    ui.hudBridge.addEventListener("click",()=>{if(map?.getPitch()<5){ui.followMode.value="3d";follow();}refreshFollowHud();});
    document.getElementById("traffic-pick-start").addEventListener("click",()=>beginTripPick("start"));
    document.getElementById("traffic-pick-destination").addEventListener("click",()=>beginTripPick("destination"));
    document.getElementById("traffic-current-start").addEventListener("click",()=>{if(!map)return;const p=map.getCenter();setTripPoint("start",[p.lng,p.lat]);ui.tripStatus.textContent="已将地图中心设为起点。";});
    document.getElementById("traffic-clear-destination").addEventListener("click",()=>{ui.destination.value="";tripMarkers.get("destination")?.remove();tripMarkers.delete("destination");ui.tripStatus.textContent="终点将自动选择最近的可达设施。";});
    for(const [kind,input] of [["start",ui.start],["destination",ui.destination]])input.addEventListener("change",()=>{tripMarkers.get(kind)?.remove();tripMarkers.delete(kind);try{const p=readTripPoint(input,true);if(p)setTripPoint(kind,p);}catch(error){ui.tripStatus.textContent=error.message;}});
    ui.startTrip.addEventListener("click",startTrip);
    ui.endTrip.addEventListener("click",()=>{if(!worker)return;stopFollowing();tripPending=true;worker.postMessage({action:"end-trip",generation,request:++tripRequest});refreshUi();});
    document.getElementById("reset-render-settings").addEventListener("click",()=>setEnabled(false));
    document.addEventListener("visibilitychange",()=>{worker?.postMessage({action:"pause",paused:isPaused()});if(document.hidden){cancelAnimationFrame(frame);frame=0;clearTimeout(bridgeTimer);bridgeTimer=0;cancelTripPick();stopFollowing();}else {refreshStructureLanes();startFrames();map?.triggerRepaint();}});
    document.getElementById("map").addEventListener("pointerdown",onFollowPointerDown,{passive:true,capture:true});
    document.addEventListener("pointermove",onFollowPointerMove,{passive:true,capture:true});
    for(const type of ["pointerup","pointercancel"])document.addEventListener(type,onFollowPointerUp,{passive:true,capture:true});
    root.addEventListener("blur",()=>{touchPointers.clear();mapPointers.clear();followPinch=false;onFollowZoom();});
    document.getElementById("map").addEventListener("wheel",onFollowZoomInput,{passive:true,capture:true});
    document.getElementById("map").addEventListener("click",event=>{
      if(!enabled || !map || !root.HuayuAtlas.canPickTraffic())return;
      const rect=map.getCanvas().getBoundingClientRect();
      if(picking){
        if(root.HuayuAtlas.getCurrentView()!=="simulation"){cancelTripPick();return;}
        const point=map.unproject([event.clientX-rect.x,event.clientY-rect.y]),kind=picking;
        cancelTripPick();setTripPoint(kind,[point.lng,point.lat]);ui.tripStatus.textContent=`已设置${kind==="start"?"起点":"终点"}，点击“发车并跟随”开始。`;
        event.preventDefault();event.stopImmediatePropagation();return;
      }
      if(pick(null,{x:event.clientX-rect.x,y:event.clientY-rect.y})){event.preventDefault();event.stopPropagation();}
    },{capture:true});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"){cancelTripPick();stopFollowing();}else if(following&&["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key))stopFollowing();});
    refreshUi();
    if(new URLSearchParams(root.location.search).get("panel")==="simulation")root.HuayuAtlas.openView("simulation",{preservePerspective:true});
  }
  root.HuayuTraffic=Object.freeze({syncContext,pick,disposeMap,setEnabled,isEnabled:()=>enabled,getBridgeRoads:()=>simulationBridgeRoads,
    inspect:()=>({enabled,paused,following,followMode:ui.followMode?.value,picking,tripPending,selected,hasWorker:Boolean(worker),hasGraphics:Boolean(graphics),generation,status,center,frame:!!frame,
      pendingContext,loadingRegion:Boolean(candidate),regions:regions.map(r=>({name:r.name,id:r.osm_id})),searching,
      drawn:graphics?.drawn||0,drawnOthers:graphics?.drawnOthers||0,trafficViewport,drawnBridge:graphics?.drawnBridge||0,bridgeSurfaces:graphics?.bridgeData?{segments:graphics.bridgeData.segments,limited:graphics.bridgeData.limited,flowBands:[...new Set(graphics.bridgeData.groups.map(g=>g.band))]}:null,route:trip,networkSize:network.length,lanes:laneResult?{roads:laneResult.roads,estimated:laneResult.estimated,vertices:laneResult.vertices,limited:laneResult.limited,bounds:laneBounds,deferredElevated:laneResult.deferredElevated,deferredTunnel:laneResult.deferredTunnel}:null,snapshot:latest})});
  if(root.HuayuAtlas)start();else root.addEventListener("huayu:map-ready",start,{once:true});
})(window);
