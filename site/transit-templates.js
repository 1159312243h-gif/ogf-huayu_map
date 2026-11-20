(function(root){
  "use strict";
  function start(){
    const core=root.HuayuTransitTemplates,atlas=root.HuayuAtlas,$=id=>document.getElementById("line-template-"+id);
    if(!core||!$("workspace"))return;
    let entries=core.builtins.map(v=>({...v})),selected=entries[0],template=selected.template,output=null,url=null,epoch=0,sharedEpoch=0,sharedController=null,shareController=null,busy=false,cursor=null,sharedItems=[],stationBoard=null,stationLoader=root.HuayuTransitStationData.create({rules:()=>atlas.getTransitTemplateRules?.()||{},buildFamily:(root,items,station)=>atlas.buildTransitTemplateFamily(root,items,station)}),stationController=null,stationEpoch=0,serviceOverrides=new Map(),throughOverrides=new Map(),stationChoice=null,stationPending=false,stationCandidate=null,stationTarget=null,stationTask=null,stationRequestKey=null,stationRestoreView=null,guideSignature=JSON.stringify(atlas.getTransitTemplateLine());
    const reducedMotion=root.matchMedia("(prefers-reduced-motion: reduce)");
    let playing=!reducedMotion.matches,previewVisible=false,simulationSeed=String(root.crypto.getRandomValues(new Uint32Array(1))[0]),simulationNow=Date.now(),simulationTimer=null;
    const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
    const status=(message,error=false)=>{$("status").textContent=message;$("status").classList.toggle("is-error",error);};
    const button=(title,handler)=>{const b=el("button",title);b.type="button";b.className="text-button";b.onclick=handler;return b;};
    const guard=fn=>async()=>{try{await fn();}catch(e){if(e.name!=="AbortError")status(e.message,true);}};
    const richLayouts=new Set(["nanjing","chongqing-screen","wuxi-screen","fuzhou","platform","ningbo","suzhou","songjiang","macau","macau-fold","wayfinding"]);
    const rich=t=>t.family==="metro-guide"||richLayouts.has(t.style.screenLayout);
    function catalog(){return entries.map(v=>({id:v.id,title:v.template.title,family:v.template.family,busLayout:v.template.style.busLayout,screenLayout:v.template.style.screenLayout,animated:Boolean(v.template.style.screenLayout)||v.template.family==="metro-guide",author:v.template.author,shared:v.shared||false}));}
    function fillOptions(){
      const family=$("family").value,matching=entries.filter(v=>!family||v.template.family===family);
      $("preset").replaceChildren(...matching.map(v=>{const o=el("option",v.template.title+(v.shared?" · 共享":""));o.value=v.id;return o;}));
      if(!matching.includes(selected))selected=matching[0];
      if(selected){$("preset").value=selected.id;apply(selected.template);}
    }
    function controls(){
      $("screen-layout-row").hidden=!template.style.screenLayout;$("screen-layout").value=template.style.screenLayout||"alternating";
      $("bus-layout-row").hidden=template.family!=="bus-stop";$("bus-layout").value=template.style.busLayout||"strip";
      $("columns").disabled=template.family==="bus-stop"||rich(template);
      $("passenger-controls").hidden=!rich(template);
      $("title").value=template.title;$("background").value=template.style.background;$("text").value=template.style.text;
      $("accent").value=template.style.accent==="route"?"#326da6":template.style.accent;
      $("use-route-color").checked=template.style.accent==="route";$("accent").disabled=$("use-route-color").checked;
      $("columns").value=template.style.columns;$("author").value=template.author;$("license").value=template.license;$("source-url").value=template.sourceUrl;
      $("attribution").textContent=selected.shared?"共享上传者："+selected.uploader+"。版式作者与许可按上传声明保留。":selected.id.startsWith("custom-")?"本机导入的版式，未公开；请保留原作者与许可。":"内置为原创通用版式；城市参考库见下方。";
    }
    function apply(t){template=core.normalize(t);controls();refreshStops(true);render();}

    function activeStationBoard(){return stationPending?stationCandidate:stationBoard;}
    function chosenStationLine(){return activeStationBoard()?.lines.find(e=>e.key===$("line-choice").value)||null;}
    function selectedData(){return chosenStationLine()?.route||(stationPending?stationCandidate?.lines[0]?.route:atlas.getTransitTemplateLine()||stationBoard?.lines[0]?.route)||null;}
    function loadedDirections(){return atlas.getTransitTemplateDirections?.()||[];}
    function lineChoices(){
      const previous=$("line-choice").value,lines=activeStationBoard()?.lines||[],guide=atlas.getTransitTemplateLine(),options=[];
      if(guide&&!stationPending){const option=el("option","当前地图线路 · "+(guide.ref||guide.title));option.value="";options.push(option);}
      for(const dir of stationPending?[]:loadedDirections()){const option=el("option",dir.title+" · "+dir.sourceId);option.value="mapdir/"+dir.sourceId;options.push(option);}
      for(const entry of lines){const option=el("option",(entry.overview?"全线总览 · "+entry.route.title:entry.route.title+" → "+(entry.route.to||"未提供终点"))+" · "+entry.route.sourceId);option.value=entry.key;options.push(option);}
      $("line-choice").replaceChildren(...options);if(options.some(o=>o.value===previous))$("line-choice").value=previous;
      $("line-choice-row").hidden=$("source").value!=="selected"||(!lines.length&&!loadedDirections().length);
    }
    function rawData(){return $("source").value==="demo"?core.demo:selectedData();}
    function simulationOptions(){return {enabled:$("simulate-missing").checked,seed:simulationSeed,now:simulationNow};}
    function simulated(route,current=Number($("current").value)){return route?core.simulateService(route,{...simulationOptions(),current}):null;}
    function simulationSummary(){
      const b=board(),routes=stationMode()?b?.lines.map(e=>simulated(e.route,e.current))||[]:[simulated(data())].filter(Boolean);
      const names={hours:"运行时间",first:"首班",last:"末班",fare:"票价",operator:"运营方",interval:"班次间隔",departures:"发车时刻"};
      $("simulate-again").disabled=!$("simulate-missing").checked;$("time-refresh").disabled=!$("simulate-missing").checked;
      $("simulation-status").textContent=!$("simulate-missing").checked?"已关闭模拟补全，缺失资料保留为未提供；实时到站未接入。":!routes.length?"先选择已读线路，或切换示例线路，再生成模拟资料。":routes.map(r=>{
        const info=r.simulation;return (r.ref||r.title)+"："+(info.generatedFields.length?"模拟补全 "+info.generatedFields.map(k=>names[k]).join("、"):"运营字段均沿用已读资料")+"；最近一班 "+info.arrival.next.label+"。";
      }).join("\n")+" 参考时间："+new Date(simulationNow).toLocaleString()+"（设备时间）。含模拟数据，非实时运营信息。";
    }
    function scheduleSimulation(){
      clearTimeout(simulationTimer);simulationTimer=null;
      if(!$("simulate-missing").checked||document.hidden||!$("workspace").open||(!previewVisible&&!$("dialog").open))return;
      simulationTimer=setTimeout(()=>{simulationTimer=null;if(document.activeElement?.closest?.("#line-template-workspace input,#line-template-workspace textarea")){scheduleSimulation();return;}simulationNow=Date.now();render();},60000-Date.now()%60000+30);
    }

    const geographies=new Map(),geographyTried=new Set();let geographyController=null,geographyVersion=0,geographyActive="";
    const geographyKey=r=>JSON.stringify([r.sourceId,r.stops.map(p=>[p.lat,p.lon??p.lng])]);
    function passengerOptions(overrides={}){
      const count=overrides.cars??$("vehicle-cars").value,cars=count?Number(count):undefined,car=Number(overrides.car??$("vehicle-car").value);
      if(count&&(!Number.isInteger(cars)||cars<1||cars>24)||!Number.isInteger(car)||car<1||car>(cars||rawData()?.passenger?.cars||6))throw Error("请填写有效的编组节数和当前车厢");
      const value={cars,car,doorSide:$("door-side").value,doorLabel:$("door-label").value,phase:$("vehicle-phase").value,page:$("screen-page").value,leftExit:$("left-exit").value,rightExit:$("right-exit").value,facilities:["wc","accessible","lift","stairs"].filter(k=>$("facility-"+k).checked),...overrides,manual:true};
      if(!["unknown","left","right","both"].includes(value.doorSide)||!["running","approaching","arrived","closing"].includes(value.phase)||!["route","platform","cycle"].includes(value.page)||!Array.isArray(value.facilities)||value.facilities.some(k=>!["wc","accessible","lift","stairs"].includes(k)))throw Error("车厢导视参数无效");
      return {...value,cars,car};
    }
    const throughKey=route=>JSON.stringify([route.sourceId,route.stops.map(v=>v.sourceId||v.name)]);

    const connections=new Map(),connectionRoutes=new Map(),operatingOverrides=new Map();
    let throughController=null,throughEpoch=0,connectionChoices=[];
    const rawConnections=route=>connections.get(throughKey(route))||[];
    function joinedData(route=rawData(),values=route?rawConnections(route):[]){
      return route?values.reduce((r,v)=>core.connectThroughRoute(r,v.route,v),route):null;
    }
    function availableConnectionRoutes(){
      const raw=rawData();
      return [...new Map([...(activeStationBoard()?.lines||[]).map(e=>e.route),atlas.getTransitTemplateLine(),...(raw?connectionRoutes.get(throughKey(raw))||[]:[])].filter(r=>r?.stops?.length).map(r=>[r.sourceId,r])).values()];
    }
    function operatingValue(route=joinedData()){return route?operatingOverrides.has(throughKey(route))?operatingOverrides.get(throughKey(route)):route.operatingPattern||null:null;}
    function cancelThroughLoad(){
      throughController?.abort();throughController=null;throughEpoch++;$("connect-cancel").hidden=true;
    }
    async function loadThroughCandidates({endpoint='both',refresh=false}={},ctx={}){
      const route=joinedData(),raw=rawData();if(!route||route.demo||route.overview||route.roundtrip||!['start','end','both'].includes(endpoint))throw Error('请先选择已读的非环线具体方向');
      cancelThroughLoad();const version=throughEpoch,key=throughKey(raw),signature=throughKey(route),controller=new AbortController();throughController=controller;$("connect-cancel").hidden=false;
      const abort=()=>controller.abort();ctx.signal?.addEventListener('abort',abort,{once:true});if(ctx.signal?.aborted)controller.abort();
      try{
        const endpoints=endpoint==='both'?[route.stops[0],route.stops.at(-1)]:[endpoint==='start'?route.stops[0]:route.stops.at(-1)],loaded=[];
        for(const stop of endpoints){
          const result=await stationLoader.load({sourceId:stop.sourceId,sourceIds:stop.memberSourceIds||[],mode:'rail',name:stop.name},{signal:controller.signal,refresh,onProgress:message=>$("connect-status").textContent=message});
          loaded.push(result);
        }
        controller.signal.throwIfAborted();if(version!==throughEpoch||!rawData()||key!==throughKey(rawData())||signature!==throughKey(joinedData())||ctx.isCurrent&&!ctx.isCurrent())throw new DOMException('已取消','AbortError');
        const routes=[...new Map(loaded.flatMap(r=>r.entries.map(e=>({...e.route,sourceTime:r.sourceTime,fetchedAt:r.fetchedAt}))).map(r=>[r.sourceId,r])).values()];
        connectionRoutes.set(key,routes);while(connectionRoutes.size>8)connectionRoutes.delete(connectionRoutes.keys().next().value);
        throughController=null;$("connect-cancel").hidden=true;render();
        const choices=core.throughConnectionOptions(joinedData(),availableConnectionRoutes());
        $("connect-status").textContent=choices.length?'已核对首末站线路，可选择相接方向加入；来源时间：'+loaded.map(v=>v.sourceTime||'上游未提供').join('；'):'首末站未读取到可接入的其他具体方向；不按名称或距离虚构相连。';
        return {complete:true,choices,sourceTimes:loaded.map(v=>v.sourceTime),realtime:false};
      }catch(e){if(e.name!=='AbortError'&&version===throughEpoch)$("connect-status").textContent=e.message+'；已有完整图与拼接保留。';throw e;}
      finally{ctx.signal?.removeEventListener('abort',abort);if(version===throughEpoch){throughController=null;$("connect-cancel").hidden=true;}}
    }
    function connectRoute(choice){
      const raw=rawData(),route=availableConnectionRoutes().find(r=>r.sourceId===choice?.lineSourceId);
      if(!raw||!route||stationPending)throw Error('请使用已读取的相接线路');
      const value={route,attach:choice.attach,reverse:choice.reverse};
      joinedData(raw,[...rawConnections(raw),value]); // Validate before replacing any complete state.
      cancelThroughLoad();connections.set(throughKey(raw),[...rawConnections(raw),value]);$("current").value='-1';refreshStops();render();
    }
    function operatingControls(route){
      const pattern=operatingValue(route),key=throughKey(route),changed=$("operating-stops").dataset.key!==key;
      if(changed){
        $("operating-stops").dataset.key=key;
        $("operating-name").value=pattern?.name||'本次交路';
        for(const [id,value] of [['operating-from',pattern?.fromIndex??0],['operating-to',pattern?.toIndex??route.stops.length-1]]){
          $(id).replaceChildren(...route.stops.map((s,i)=>{const o=el('option',(i+1)+'. '+s.name);o.value=String(i);return o;}));$(id).value=String(value);
        }
        $("operating-stops").replaceChildren(...route.stops.map((s,i)=>{const label=el('label'),input=el('input');label.className='line-template-check';input.type='checkbox';input.value=String(i);input.checked=Boolean(pattern?.skipIndexes.includes(i));label.append(input,el('span',(i+1)+'. '+s.name));return label;}));
      }
      $("operating-status").textContent=pattern?pattern.name+'：'+route.stops[pattern.fromIndex].name+' → '+route.stops[pattern.toIndex].name+'，跳停 '+pattern.skipIndexes.length+' 站；其余完整站序保留。':'当前全程各站停靠。可设置大小交路或勾选跳停站，应用后更新灯态与下一站。';
    }
    function applyOperating(){
      const route=joinedData();if(!route||stationPending)throw Error('请等待线路完整读取');
      const value=core.normalizeOperatingPattern(route,{name:$("operating-name").value,fromIndex:$("operating-from").value,toIndex:$("operating-to").value,skipIndexes:[...$("operating-stops").querySelectorAll('input:checked')].map(e=>e.value)});
      operatingOverrides.set(throughKey(route),value);$("operating-stops").dataset.key='';refreshStops();render();
    }
    function throughValues(route=joinedData()){return route?throughOverrides.get(throughKey(route))||route.throughServices||[]:[];}
    function throughControls(){
      const route=joinedData(),rail=route&&['subway','light_rail','monorail','tram','train'].includes(route.type);$("through-controls").hidden=!rail;$("through-add").disabled=!rail||stationPending;
      if(!rail){$("through-list").replaceChildren();return;}
      connectionChoices=core.throughConnectionOptions(route,availableConnectionRoutes());
      const previousConnection=$("connect-choice").value;$("connect-choice").replaceChildren(...connectionChoices.map((v,i)=>{const o=el('option',(v.attach==='end'?'接在线尾':'接在线首')+' · '+(v.ref||v.title)+' · '+(v.reverse?'反向站序':'原方向'));o.value=String(i);return o;}));if([...$("connect-choice").options].some(o=>o.value===previousConnection))$("connect-choice").value=previousConnection;
      $("connect-add").disabled=stationPending||!connectionChoices.length;$("connect-load").disabled=stationPending||Boolean(route.overview||route.roundtrip||route.demo);$("connect-undo").disabled=!rawConnections(rawData()).length;
      $("connect-list").replaceChildren(...(route.throughRoute?.segments||[]).map(v=>el('p',(v.ref||v.name)+' · '+route.stops[v.fromIndex].name+' → '+route.stops[v.toIndex].name+(v.reverse?'（反向站序）':''))));operatingControls(route);
      const choices=select=>{const previous=select.value;select.replaceChildren(...route.stops.map((s,i)=>{const o=el('option',(i+1)+'. '+s.name);o.value=String(i);return o;}));if([...select.options].some(o=>o.value===previous))select.value=previous;};
      const changed=$("through-list").dataset.sourceId!==route.sourceId;choices($("through-from"));choices($("through-to"));if(changed){$("through-from").value='0';$("through-to").value=String(route.stops.length-1);}$("through-list").dataset.sourceId=route.sourceId;
      const loaded=[...availableConnectionRoutes(),...loadedDirections()],previous=$("through-known").value,custom=el('option','手动填写贯通线路');custom.value='';
      $("through-known").replaceChildren(custom,...[...new Map(loaded.map(r=>[r.sourceId,r])).values()].filter(r=>r.sourceId!==route.sourceId).map(r=>{const o=el('option',(r.ref||r.title)+' · '+r.sourceId);o.value=r.sourceId;return o;}));$("through-known").value=previous;
      $("through-list").replaceChildren(...throughValues(route).map((v,index)=>{const card=el('div'),text=el('span',v.ref+(v.name&&v.name!==v.ref?' · '+v.name:'')+'：'+route.stops[v.fromIndex].name+' → '+route.stops[v.toIndex].name);text.style.borderLeft='5px solid '+v.color;text.style.paddingLeft='8px';card.append(text,button('移除此区间',()=>{const next=throughValues(route).filter((_,i)=>i!==index);throughOverrides.set(throughKey(route),next);render();}));return card;}));
      $("through-status").textContent='当前 '+(route.ref||route.title)+' 已设置 '+throughValues(route).length+' 个贯通运行区间。本站标注仅用于本页及图片，未改变线路关系或导航。';
    }
    function addThroughService(){
      const route=joinedData();if(!route||stationPending)throw Error('请等待真实线路读取完成');
      const value={ref:$("through-ref").value,name:$("through-name").value,color:$("through-color").value,fromIndex:Number($("through-from").value),toIndex:Number($("through-to").value)};
      const next=core.normalizeThroughServices(route,[...throughValues(route),value]);throughOverrides.set(throughKey(route),next);render();
    }
    function decorate(route){
      if(!route)return route;
      route=joinedData(route);const passenger=passengerOptions();
      return {...route,operatingPattern:operatingValue(route),throughServices:throughValues(route),passenger:{...route.passenger,...passenger,cars:passenger.cars??route.passenger?.cars},geography:geographies.get(geographyKey(route))||route.geography||null};
    }
    function geographyRoutes(){const b=board();return stationMode()?b?.lines.map(e=>e.route)||[]:[data()].filter(Boolean);}
    function cancelGeography(){geographyController?.abort();geographyController=null;geographyVersion++;geographyActive="";$("geography-cancel").hidden=true;}
    async function loadGeography({refresh=false}={},ctx={}){
      const routes=geographyRoutes();if(!routes.length)throw Error("请先读取线路和全部站点坐标");
      cancelGeography();const version=geographyVersion,controller=new AbortController(),signature=JSON.stringify(routes.map(geographyKey));geographyController=controller;geographyActive=signature;$("geography-cancel").hidden=false;
      if(ctx.signal?.aborted)controller.abort();const abort=()=>controller.abort();ctx.signal?.addEventListener("abort",abort,{once:true});
      try{
        const loaded=[];
        for(const [i,r] of routes.entries()){
          $("geography-status").textContent="正在读取实际城市路网 "+(i+1)+" / "+routes.length+"；当前图保留，可取消。";
          loaded.push(await stationLoader.loadGeography(r,{signal:controller.signal,refresh}));
        }
        controller.signal.throwIfAborted();if(version!==geographyVersion||ctx.isCurrent&&!ctx.isCurrent())throw new DOMException("已取消","AbortError");
        loaded.forEach((g,i)=>geographies.set(geographyKey(routes[i]),g));while(geographies.size>12)geographies.delete(geographies.keys().next().value);
        $("geography-status").textContent="已读取实际道路背景；线路成员道路按原几何绘制，未取得成员几何时虚线仅表示站点连线。OGF 源时间："+(loaded.map(g=>g.sourceTime||"未提供").join("；"));
        geographyController=null;geographyActive="";$("geography-cancel").hidden=true;render();
        return {complete:true,routeCount:routes.length,roadCount:loaded.reduce((a,g)=>a+g.roads.length,0),sourceTimes:loaded.map(g=>g.sourceTime),realtime:false};
      }catch(e){if(e.name!=="AbortError"&&version===geographyVersion)$("geography-status").textContent=e.message+"；原图保留，可点击重新读取道路。";throw e;}
      finally{ctx.signal?.removeEventListener("abort",abort);if(version===geographyVersion){geographyController=null;geographyActive="";$("geography-cancel").hidden=true;}}
    }
    function scheduleGeography(){
      const enabled=template.style.busLayout==="gaoyang-detail",visible=$("workspace").open&&!document.getElementById("transit-view").hidden&&!document.hidden,routes=enabled?geographyRoutes():[],signature=JSON.stringify(routes.map(geographyKey));
      $("geography-controls").hidden=!enabled;
      if(geographyController&&(!enabled||!visible||signature!==geographyActive)){geographyTried.delete(geographyActive);cancelGeography();}
      if(!enabled||!visible||!routes.length||routes.some(r=>r.demo)||routes.every(r=>geographies.has(geographyKey(r)))||geographyTried.has(signature)||geographyController)return;
      geographyTried.add(signature);loadGeography().catch(()=>{});
    }

    function withService(route){const values=serviceOverrides.get(route?.sourceId);return decorate(route&&values?{...route,service:{...route.service,...values},serviceNote:"用户补填，未核验（仅本页站牌）"}:route);}
    function data(){return withService(rawData());}
    function serviceRoutes(){const current=rawData(),lines=(($("source").value==="demo"?core.demoStation:activeStationBoard())?.lines||[]).map(e=>e.route),candidates=stationMode()&&lines.length?lines:current?[current]:lines;return [...new Map(candidates.map(r=>[r.sourceId,r])).values()];}
    function serviceControls(){const routes=serviceRoutes(),previous=$("service-line").value;$("service-line").replaceChildren(...routes.map(r=>{const o=el("option",(r.ref||r.title)+" · "+r.sourceId);o.value=r.sourceId;return o;}));if(routes.some(r=>r.sourceId===previous))$("service-line").value=previous;fillService();}
    function fillService(){const raw=serviceRoutes().find(r=>r.sourceId===$("service-line").value),route=withService(raw);for(const key of ["hours","first","last","fare","operator","interval","departures"]){$("service-"+key).disabled=!route;$("service-"+key).value=route?.service?.[key]||"";$("service-"+key).placeholder=route&&!route.service?.[key]&&$("simulate-missing").checked?simulated(route)?.service?.[key]||"":"";}$("service-source").textContent=route?(route.serviceNote||"原始线路标签")+" · "+Object.entries(raw.serviceSources||{}).filter(([,ids])=>ids.length).map(([key,ids])=>key+": "+ids.join("、")).join("；"):"选择或读取真实线路后可编辑。";}
    function captureStationView(){if(!stationPending)stationRestoreView={selected,template,source:$("source").value,display:$("display").value,lineChoice:$("line-choice").value,current:$("current").value,reverse:$("reverse").checked};}
    function restoreStationView(){
      const previous=stationRestoreView;if(previous){selected=previous.selected;$("family").value=previous.template.family;$("source").value=previous.source;$("display").value=previous.display;$("reverse").checked=previous.reverse;fillOptions();template=previous.template;controls();lineChoices();$("line-choice").value=previous.lineChoice;refreshStops();if([...$("current").options].some(o=>o.value===previous.current))$("current").value=previous.current;}
      render();
    }
    function cancelStation(){cancelThroughLoad();stationController?.abort();stationController=null;stationTask=null;stationRequestKey=null;stationEpoch++;stationPending=false;stationCandidate=null;stationTarget=null;$("station-cancel").hidden=true;}
    function selectedStation(){const feature=atlas.getSelectedFeature?.();return stationChoice==='station'?atlas.getTransitTemplateStation?.():root.HuayuTransitStationData.stationFromFeature(feature)||atlas.getTransitTemplateStation?.();}
    function stationBoardFor(loaded){return {stationId:loaded.stationId,stationName:loaded.stationName,rail:loaded.mode==='rail',demo:false,lines:loaded.entries.map(e=>({...e,key:e.route.sourceId+'|'+loaded.stationId})),complete:loaded.complete,scope:loaded.scope,sourceTime:loaded.sourceTime,fetchedAt:loaded.fetchedAt,operatorStatus:loaded.operatorStatus,selection:stationTarget||selectedStation()};}
    function stageStation(station){
      const preferred=chosenStationLine()?.route.sourceId||stationRestoreView?.lineChoice?.split('|')[0];stationTarget=station;stationPending=true;
      const preview=stationLoader.preview(station);stationCandidate=preview?stationBoardFor(preview):null;
      $("source").value='selected';$("display").value=stationCandidate?.rail?'line':stationCandidate?'station':'line';lineChoices();
      $("line-choice").value=stationCandidate?.lines.find(e=>e.route.sourceId===preferred)?.key||stationCandidate?.lines[0]?.key||'';
      $("current").value='-1';$("reverse").checked=false;refreshStops(true);
      if(preview&&(preview.mode==='rail'?!['metro-guide','metro-lcd','metro-led'].includes(template.family):template.family!=='bus-stop')){$("family").value=preview.mode==='rail'?'metro-guide':'bus-stop';selected=entries.find(e=>e.template.family===$("family").value);fillOptions();}else render();
      $("station-load-status").textContent='已选中 '+(station.name||station.sourceId)+'；'+(preview?'先显示已读的本站线路，正在核对完整停靠关系…':'正在读取本站真实线路，完成后自动更新…');
    }
    async function loadStation(station,ctx={}){
      station=station||selectedStation();
      if(!station)throw Error('请先在地图上点选车站，或输入站名搜索');
      const requestKey=JSON.stringify([root.HuayuTransitStationData.stationRef(station),station.mode||'',[...root.HuayuTransitStationData.stationRefs(station,[])].sort()]);
      if(stationTask&&requestKey===stationRequestKey&&!ctx.refresh&&!ctx.signal&&!ctx.isCurrent)return stationTask;
      const preferred=chosenStationLine()?.route.sourceId;captureStationView();cancelStation();const version=stationEpoch,controller=new AbortController();stationController=controller;stationRequestKey=requestKey;
      if(ctx.signal?.aborted)controller.abort();const onAbort=()=>controller.abort();ctx.signal?.addEventListener('abort',onAbort,{once:true});
      const check=()=>{controller.signal.throwIfAborted();if(version!==stationEpoch||ctx.isCurrent&&!ctx.isCurrent())throw new DOMException('已取消','AbortError');};
      stationTask=(async()=>{try{
        check();if(!ctx.automatic){atlas.openView('transit',{preservePerspective:true});$("workspace").open=true;}
        stageStation(station);$("station-cancel").hidden=false;
        const loaded=await stationLoader.load(station,{signal:controller.signal,refresh:Boolean(ctx.refresh),onProgress:message=>{if(version===stationEpoch)$("station-load-status").textContent=message;}});check();
        stationBoard=stationBoardFor(loaded);stationPending=false;stationCandidate=null;stationTarget=null;
        $("source").value='selected';lineChoices();$("line-choice").value=stationBoard.lines.find(e=>e.route.sourceId===preferred)?.key||stationBoard.lines[0].key;$("reverse").checked=false;$("current").value='-1';$("display").value=stationBoard.rail?'line':'station';refreshStops(true);
        const rail=stationBoard.rail,family=rail?'metro-guide':'bus-stop';
        if(rail?!['metro-guide','metro-lcd','metro-led'].includes(template.family):template.family!=='bus-stop'){$("family").value=family;selected=entries.find(e=>e.template.family===family);fillOptions();}else render();
        $("station-load-status").textContent='已读取 '+loaded.stationName+' · '+loaded.stationId+' 的 '+loaded.entries.length+' 条'+(rail?'轨道':'公交')+'线路总览／分期方向。默认全线总览，可切换具体方向；未停靠本站的分段不指定当前站。范围：'+loaded.scope+'。'+(loaded.cached?' 复用两分钟内完整数据，可点击重新读取强制更新。':'')+(loaded.sourceTime?' OGF 数据时间：'+loaded.sourceTime:'')+(loaded.operatorStatus==='unavailable'?' 运营方补充安排暂未读取成功；保留已读资料。':'');
        return {stationId:loaded.stationId,stationName:loaded.stationName,mode:rail?'rail':'bus',lineCount:loaded.entries.length,complete:true,scope:loaded.scope,sourceTime:loaded.sourceTime,operatorStatus:loaded.operatorStatus,cached:Boolean(loaded.cached)};
      }catch(e){if(version===stationEpoch){stationPending=false;stationCandidate=null;stationTarget=null;restoreStationView();$("station-load-status").textContent=(e.name==='AbortError'?'已取消读取':e.message)+'；仍保留此前的完整线路图，未生成新站点图。';}throw e;}
      finally{ctx.signal?.removeEventListener('abort',onAbort);if(version===stationEpoch){stationController=null;stationTask=null;stationRequestKey=null;$("station-cancel").hidden=true;}}})();return stationTask;
    }
    function stationSelected(){const station=selectedStation();if(!station)return;if($("workspace").open)guard(()=>loadStation(station,{automatic:true}))();else{captureStationView();cancelStation();stageStation(station);}}
    async function searchStation(){cancelStation();const version=stationEpoch,controller=new AbortController();stationController=controller;$("station-cancel").hidden=false;$("station-load-status").textContent="正在搜索车站…";
      try{const result=await stationLoader.search($("station-query").value,{signal:controller.signal});if(version!==stationEpoch)return;$("station-results").replaceChildren(...result.items.map(item=>{const card=el("div"),b=button(item.name+" · "+item.sourceId,guard(()=>loadStation(item)));const location=el("small",Number.isFinite(item.lat)&&Number.isFinite(item.lng)?item.lat.toFixed(5)+", "+item.lng.toFixed(5):"原始车站要素");card.append(b,location);return card;}));$("station-load-status").textContent=result.items.length?"请选择具体车站；同名及对向站按编号分开。"+(result.hasMore?"匹配较多，仅列前 60 项，请补充名称或编号。":""):"没有找到此站名；可用地图点选或完整 OGF 编号。";
      }catch(e){if(e.name!=="AbortError"&&version===stationEpoch)$("station-load-status").textContent=e.message;}
      finally{if(version===stationEpoch){stationController=null;$("station-cancel").hidden=true;}}
    }
    function refreshStops(preferStation=false){
      const route=data(),previous=$("current").value,stops=$("reverse").checked?[...(route?.stops||[])].reverse():route?.stops||[];
      const none=el("option","未指定本站／当前站（全线示意）");none.value="-1";
      $("current").replaceChildren(none,...stops.map((s,i)=>{const index=$("reverse").checked?stops.length-1-i:i,state=route?core.stopState(route,index):"stopping",o=el("option",(i+1)+". "+s.name+(state==="stopping"?"":"（本交路不停靠）"));o.value=i;o.disabled=state!=="stopping";return o;}));
      $("current").value=[...$("current").options].some(o=>o.value===previous&&!o.disabled)?previous:"-1";
      if(preferStation&&route?.type==="bus"&&(template.family==="bus-stop"||template.family==="bus-rollsign"||template.style.screenLayout)&&stops.length&&$("current").value==="-1")$("current").value="0";
      if(preferStation&&activeStationBoard()&&$("source").value==="selected"){const stationId=activeStationBoard().stationId,match=stops.findIndex(stop=>stop.sourceId===stationId||stop.memberSourceIds?.includes(stationId));$("current").value=String(match>=0&&!$("current").options[match+1]?.disabled?match:-1);}
    }
    function stationMode(){return template.family==="bus-stop"&&$("display").value==="station";}
    function board(){const b=$("source").value==="demo"?core.demoStation:activeStationBoard();return b?{...b,lines:b.lines.map(item=>({...item,route:withService(item.route)}))}:null;}
    function exportContext(){if(!stationMode())return data();const b=board();return b?{title:b.stationName+" · 同站多线路",demo:b.demo,source:"逐条已读取的公交线路关系"}:null;}
    function refreshBoard(){
      $("station-controls").hidden=!stationMode();$("display").disabled=template.family!=="bus-stop";
      const demoBoard=stationMode()&&$("source").value==="demo";$("current").closest("label").hidden=demoBoard;$("reverse").closest("label").hidden=demoBoard;
      const b=board();$("station-refresh").disabled=!stationBoard&&!stationTarget;$("station-summary").textContent=b?b.stationName+" · "+b.stationId+" · 已加入 "+b.lines.length+" 条线路／方向（"+(b.complete?"本站已登记停靠关系已读完":stationPending?"正在核对本站完整关系":"非全站完整清单")+"）":"尚未加入线路；先在下方读取公交线路，选好本站，再加入本站牌。";
      $("station-add").disabled=stationPending||$("source").value==="demo"||!data()||data().type!=="bus";$("station-clear").disabled=stationPending||$("source").value==="demo"||!stationBoard;
      $("station-lines").replaceChildren(...(b?.lines||[]).map(item=>{
        const card=el("div"),stops=item.route.stops;card.append(el("span",(item.route.ref||item.route.title)+(item.route.roundtrip?" · 终点站 "+(item.route.to||"未提供")+" · 下一站 "+(stops[item.current+1]?.name||(stops.length>1&&stops[0].sourceId===stops.at(-1).sourceId?stops[1]:stops[0]).name):" → "+(item.route.to||"未提供"))));
        if(!b.demo&&!stationPending)card.append(button("移除此方向",()=>{const lines=stationBoard.lines.filter(v=>v.key!==item.key);cancelStation();stationBoard=lines.length?{...stationBoard,lines,complete:false}:null;render();}));return card;
      }));
    }


    function motionSvg(target){return $(target).querySelector("svg");}
    function mountMotion(target){
      $(target).replaceChildren();if(!output?.motionSvg)return;
      // Source is exclusively the safe SVG generated by core, never imported SVG.
      const doc=new DOMParser().parseFromString(output.motionSvg,"image/svg+xml");
      if(doc.querySelector("parsererror"))throw Error("动态线路屏生成失败");
      const svg=document.importNode(doc.documentElement,true),speed=Number($("motion-speed").value);
      for(const a of svg.querySelectorAll("animate,animateTransform"))a.setAttribute("dur",parseFloat(a.getAttribute("dur"))/speed+"s");
      $(target).append(svg);
    }
    function syncMotion(){
      const active=Boolean(output?.motionSvg)&&!$("full-map").checked,large=$("dialog").open;
      $("motion-controls").hidden=!output?.motionSvg;$("motion-preview").hidden=!active;$("image").hidden=active;
      $("large-motion").hidden=!active;$("large-image").hidden=active;$("large-motion-toggle").hidden=!active;
      for(const id of ["motion-toggle","large-motion-toggle"]){$(id).textContent=playing?"暂停动画":"播放动画";$(id).setAttribute("aria-pressed",String(playing));}
      $("motion-toggle").disabled=!active;$("motion-speed").disabled=!active;
      for(const id of ["motion-preview","large-motion"]){
        const svg=motionSvg(id);if(!svg)continue;
        const visible=id==="large-motion"?large:previewVisible&&!large;
        if(active&&playing&&visible&&!document.hidden)svg.unpauseAnimations();else svg.pauseAnimations();
      }
    }
    const motionObserver=new IntersectionObserver(items=>{previewVisible=items.some(item=>item.isIntersecting);syncMotion();scheduleSimulation();});
    motionObserver.observe($("preview"));document.addEventListener("visibilitychange",()=>{syncMotion();if(!document.hidden&&$("simulate-missing").checked){simulationNow=Date.now();if(previewVisible||$("dialog").open)render();}scheduleSimulation();});$("workspace").addEventListener("toggle",scheduleSimulation);
    reducedMotion.addEventListener("change",()=>{if(reducedMotion.matches){playing=false;syncMotion();}});
    function render(){
      passengerOptions();simulationNow=Date.now();lineChoices();
      epoch++;output=null;$("motion-preview").replaceChildren();$("large-motion").replaceChildren();syncMotion();if(url){URL.revokeObjectURL(url);url=null;}$("image").removeAttribute("src");
      refreshBoard();serviceControls();throughControls();simulationSummary();scheduleSimulation();const route=data(),multi=stationMode(),subject=multi?board():route;
      $("order-status").textContent=route?.type!=="bus"&&route?(route.orderBasis==="line-page"?"全线站序与‘线路’页共用完整主关系、全部分段及原有排序处理器；全线总览不表示全部分段贯通运营。":route.orderBasis==="connected-track"?"站序已按所选线路的实际轨道连接校正；起终点仍使用该关系 from/to。":route.orderWarning||"站序沿用已读线路方向；换乘按完整站体关系显示。"):"";
      $("endpoint-status").textContent=multi||!route?"":route.endpointState==="choose-direction"?"总关系未填写统一终点，各方向／分段终点不同。请在上方选择已读取的具体方向，再按该关系的 from/to 显示。":route.endpointState==="incomplete"?"总关系的方向数据尚未读全；不能据此推定终点，请重新读取线路。":!route.to?"当前关系未填写 to 终点属性；不会用成员顺序或随机资料代替终点。":"起终点来自 "+route.sourceId+"："+(route.from||"未提供起点")+" → "+route.to;$("demo-note").hidden=!subject?.demo;
      for(const id of ["svg","png","queue","zoom"])$(id).disabled=!subject;
      if(!subject){$("preview").hidden=true;if(stationPending){status("已选中 "+(stationTarget?.name||selectedStation()?.name||"车站")+"，正在准备本站真实线路，读取后自动更新；当前没有套用示例。");return;}if(multi){status("请先选中公交线路及本站，点击‘加入本站牌’；换线时会保留本站牌，按相同要素编号核对归属。");return;}status("请在下方搜索并选中一条线路，待站序读取后即可套用模板；也可切换示例线路。");return;}
      try{
        output=multi?core.renderStation(template,subject,{simulation:simulationOptions()}):core.render(template,route,{current:Number($("current").value),reverse:$("reverse").checked,simulation:simulationOptions()});
        for(const option of $("scale").options)option.textContent=option.value+"× · 宽 "+output.width*Number(option.value)+" px";
        url=URL.createObjectURL(new Blob([output.svg],{type:"image/svg+xml"}));$("image").src=url;$("image").alt=(multi?subject.stationName:route.title)+" · "+template.title;if($("dialog").open)$("large-image").src=url;
        scheduleGeography();mountMotion("motion-preview");if($("dialog").open)mountMotion("large-motion");
        $("preview").hidden=false;syncMotion();
        if(multi){status((subject.demo?"示例站牌":"已收录 "+subject.stationName)+" · "+output.lineCount+" 条线路／方向 · 共 "+output.stationCount+" 个线路站次，完整站序均保留。"+(subject.complete?"本站已登记公交停靠关系已读完；":"当前为手动收录清单；")+($("simulate-missing").checked?"已补全模拟资料与到站演示，非实时运营。":"到站预报未接入。"));return;}
        status((route.demo?"正在显示示例线路":"已套用 "+route.title)+" · "+output.stationCount+" 站。"+(template.family==="bus-rollsign"?"车载前／后路牌显示终点及手动预览的下一站。":template.style.screenLayout?"车厢内完整站序；走马灯与灯效支持暂停、调速，下载保留完整静态图。":template.family==="bus-stop"?"本站为手动选择；仅展示本线，服务资料优先按已读线路显示。":"已保留全部站点，长线自动分行。")+"当前位置仅为手动预览。"+($("simulate-missing").checked?"缺失运营资料与到站时间已模拟补全；图片只保留乘车信息，补全来源见本页说明。":""));
      }catch(e){$("preview").hidden=true;status(e.message,true);}
    }
    function edit(){
      try{template=core.normalize({...template,title:$("title").value,author:$("author").value,license:$("license").value,sourceUrl:$("source-url").value,
        style:{...template.style,background:$("background").value,text:$("text").value,accent:$("use-route-color").checked?"route":$("accent").value,columns:Number($("columns").value),...(template.family==="bus-stop"?{busLayout:$("bus-layout").value}:{}),...(template.style.screenLayout?{screenLayout:$("screen-layout").value}:{})}});
        $("accent").disabled=$("use-route-color").checked;$("columns").disabled=template.family==="bus-stop"||rich(template);$("passenger-controls").hidden=!rich(template);render();return template;
      }catch(e){status(e.message,true);throw e;}
    }
    function artifact(ext,blob){const route=exportContext();return root.HuayuDownloadCenter.fileArtifact({id:"line-template-"+Date.now(),title:(route?.title||"线路")+" · "+template.title,
      filename:(route?.title||"线路")+"-"+template.title+"."+ext,blob,kind:"image",source:route?.demo?"演示数据":route?.source||"OpenGeofiction",warning:($("simulate-missing").checked?"含模拟数据；":"")+"静态模板示意；当前站为手动预览，非实时运营信息"});}
    async function imageBlob(){
      if(!output)throw Error("请先准备线路预览");const snapshot=output,version=epoch,scale=Number($("scale").value);
      const image=new Image(),objectUrl=URL.createObjectURL(new Blob([snapshot.svg],{type:"image/svg+xml"}));
      try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error("图片生成失败，请下载 SVG"));image.src=objectUrl;});
        if(version!==epoch)throw Error("预览已改变，请重新导出");
        const canvas=document.createElement("canvas");canvas.width=snapshot.width*scale;canvas.height=snapshot.height*scale;
        const context=canvas.getContext("2d");if(!context)throw Error("设备无法生成此尺寸的 PNG，请降低倍率或下载 SVG");
        context.drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        if(!blob)throw Error("设备无法生成此尺寸的 PNG，请降低倍率或下载 SVG");if(version!==epoch)throw Error("预览已改变，请重新导出");return blob;
      }finally{URL.revokeObjectURL(objectUrl);}
    }
    async function exportImage(kind,queue=false){
      if(!output)throw Error("请先准备线路预览");const version=epoch;
      const blob=kind==="png"?await imageBlob():new Blob([output.svg],{type:"image/svg+xml"});
      if(version!==epoch)throw Error("预览已改变，请重新导出");
      const a=artifact(kind,blob);if(queue)root.HuayuDownloadCenter.add(a);else root.HuayuDownloadCenter.download(a.blob,a.name);
      status(queue?"当前线路显示图已加入统一下载清单。":"已生成 "+kind.toUpperCase()+" 文件。");
    }
    function importTemplate(t,meta={}){
      const entry={id:"custom-"+Date.now()+"-"+entries.length,template:core.normalize(t),...meta};
      entries.push(entry);selected=entry;$("family").value=entry.template.family;fillOptions();status("已导入模板，可套用当前线路；下载 JSON 可保存版式，登录后可准备共享发布。");
    }
    async function prepareShare(){
      if(busy)return;
      if(!root.HuayuPersonalData?.isAuthenticated())throw Error("请先登录，再共享模板；本机预览与下载无需登录");
      const t=edit(),file=new File([JSON.stringify(core.packageRecords(t),null,2)],t.title+".json",{type:"application/json"});
      busy=true;$("share").disabled=true;shareController=new AbortController();
      try{await root.HuayuSharedDatasets.prepareFromAgent(file,{title:"线路显示模板 · "+t.title,kind:"other",scopeLabel:"公共交通线路显示版式（不含线路数据）",scopeKind:"large",unit:"套",
          source:t.author||"用户上传模板",sourceUrl:t.sourceUrl,license:t.license,description:"华域线路显示模板。选择任意已读取线路即可套用；不含真实车辆位置或到站预报。"},shareController.signal);
        status("模板已带入共享数据表单，请核对作者、许可等信息后勾选共享并发布；当前尚未公开。");
      }finally{busy=false;$("share").disabled=false;shareController=null;}
    }
    async function shared(more=false){
      sharedController?.abort();sharedController=new AbortController();const current=++sharedEpoch;
      const q=new URLSearchParams({kind:"other",q:"线路显示模板"});if(more&&cursor)q.set("after",cursor);
      $("shared-status").textContent="正在读取共享模板目录…";
      try{const response=await fetch("/api/datasets?"+q,{cache:"no-store",credentials:"same-origin",signal:AbortSignal.any([sharedController.signal,AbortSignal.timeout(30000)])});
        if(!response.ok)throw Error("共享目录暂时不可用（"+response.status+"）");const result=await response.json();if(current!==sharedEpoch)return;
        sharedItems=more?[...new Map([...sharedItems,...result.items].map(i=>[i.id,i])).values()]:result.items;cursor=result.nextCursor;
        $("shared-list").replaceChildren(...sharedItems.map(item=>{
          const card=el("div"),label=el("p",item.title+" · "+(item.author.displayName||item.author.username));
          card.append(label,button("读取并使用",guard(async()=>{
            const version=++sharedEpoch;
            const response=await fetch("/api/datasets/"+encodeURIComponent(item.id)+"/data",{cache:"no-store",credentials:"same-origin",signal:AbortSignal.any([sharedController.signal,AbortSignal.timeout(30000)])});
            if(!response.ok)throw Error("模板读取失败，请重试");const value=await response.json();if(version!==sharedEpoch)return;
            importTemplate(core.parse(value),{shared:true,uploader:value.item.author.displayName||value.item.author.username});
          })),button("查看来源／管理",guard(()=>root.HuayuSharedDatasets.openFromAgent(item.id))));return card;
        }));
        $("shared-more").hidden=!cursor;$("shared-status").textContent=sharedItems.length?"已读取 "+sharedItems.length+" 包。使用前会校验模板格式；作者及管理员可在共享数据页维护。":"暂无共享模板，可导出自己的版式并发布。";
      }catch(e){if(e.name!=="AbortError"&&current===sharedEpoch)$("shared-status").textContent=e.message+"；已读取目录保留。";}
    }
    for(const [value,title] of Object.entries(core.families)){const o=el("option",title);o.value=value;$("family").append(o);}
    for(const [value,title] of Object.entries(core.screenLayouts)){const o=el("option",title);o.value=value;$("screen-layout").append(o);}
    for(const [value,title] of Object.entries(core.busLayouts)){const o=el("option",title);o.value=value;$("bus-layout").append(o);}

    $("connect-load").onclick=guard(()=>loadThroughCandidates({refresh:true}));
    $("connect-cancel").onclick=()=>{cancelThroughLoad();$("connect-status").textContent='已取消，原完整拼接保留。';};
    $("connect-add").onclick=guard(()=>connectRoute(connectionChoices[Number($("connect-choice").value)]));
    $("connect-undo").onclick=()=>{const route=rawData();cancelThroughLoad();connections.set(throughKey(route),rawConnections(route).slice(0,-1));$("current").value='-1';refreshStops();render();};
    $("operating-apply").onclick=guard(applyOperating);
    $("operating-reset").onclick=()=>{const route=joinedData();if(route){operatingOverrides.set(throughKey(route),null);$("operating-stops").dataset.key='';refreshStops();render();}};

    $("through-add").onclick=guard(addThroughService);$("through-clear").onclick=()=>{const route=joinedData();if(route){throughOverrides.set(throughKey(route),[]);render();}};
    $("through-known").onchange=()=>{const r=activeStationBoard()?.lines.find(e=>e.route.sourceId===$("through-known").value)?.route||loadedDirections().find(e=>e.sourceId===$("through-known").value);if(r){$("through-ref").value=r.ref||'';$("through-name").value=r.title;$("through-color").value=/^#[0-9a-f]{6}$/iu.test(r.color||'')?r.color:'#6d797f';}};
    $("geography-load").onclick=guard(()=>loadGeography({refresh:true}));$("geography-cancel").onclick=()=>{cancelGeography();$("geography-status").textContent="已取消，原道路背景保留。";};
    for(const id of ["vehicle-cars","vehicle-car","door-side","door-label","vehicle-phase","screen-page","left-exit","right-exit","facility-wc","facility-accessible","facility-lift","facility-stairs"])$(id).onchange=guard(render);
    $("workspace").addEventListener("toggle",()=>{scheduleGeography();if($("workspace").open&&stationPending&&!stationController)guard(()=>loadStation(stationTarget||selectedStation()))();});
    const geographyObserver=new MutationObserver(scheduleGeography);geographyObserver.observe(document.getElementById("transit-view"),{attributes:true,attributeFilter:["hidden"]});
    document.addEventListener("visibilitychange",scheduleGeography);
    $("family").onchange=fillOptions;$("preset").onchange=()=>{selected=entries.find(v=>v.id===$("preset").value);apply(selected.template);};
    $("source").onchange=()=>{cancelStation();stationPending=false;lineChoices();$("current").value="-1";refreshStops(true);render();};
    $("line-choice").onchange=guard(()=>{cancelThroughLoad();const choice=$("line-choice").value;if(choice.startsWith("mapdir/"))atlas.selectTransitTemplateDirection(choice.slice(7));$("reverse").checked=false;$("current").value="-1";refreshStops(true);render();});
    $("simulate-missing").onchange=render;$("simulate-again").onclick=()=>{simulationSeed=String(root.crypto.getRandomValues(new Uint32Array(1))[0]);simulationNow=Date.now();render();};$("time-refresh").onclick=()=>{simulationNow=Date.now();render();};
    $("display").onchange=()=>{refreshStops(true);render();};
    $("station-add").onclick=guard(()=>{cancelStation();stationBoard=core.addStationLine(stationBoard,data(),{current:Number($("current").value),reverse:$("reverse").checked});render();});
    $("station-clear").onclick=()=>{cancelStation();stationBoard=null;render();};
    $("station-search").onclick=guard(searchStation);$("station-query").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();searchStation();}};
    $("station-refresh").onclick=guard(()=>loadStation(stationTarget||stationBoard?.selection||selectedStation(),{refresh:true}));
    $("station-selected").onclick=guard(()=>loadStation(selectedStation()));$("station-cancel").onclick=()=>{cancelStation();restoreStationView();$("station-load-status").textContent='已取消读取，原完整线路图保留。';};
    $("service-line").onchange=fillService;for(const key of ["hours","first","last","fare","operator","interval","departures"])$("service-"+key).onchange=()=>{const id=$("service-line").value;if(!id)return;const values=Object.fromEntries(["hours","first","last","fare","operator","interval","departures"].map(k=>[k,$("service-"+k).value]));serviceOverrides.set(id,values);render();};
    $("service-reset").onclick=()=>{serviceOverrides.delete($("service-line").value);render();};
    $("current").onchange=render;$("reverse").onchange=()=>{$("current").value="-1";refreshStops(true);render();};
    for(const id of ["title","background","text","accent","use-route-color","columns","bus-layout","screen-layout","author","license","source-url"])$(id).onchange=guard(edit);
    $("svg").onclick=guard(()=>exportImage("svg"));$("png").onclick=guard(()=>exportImage("png"));$("queue").onclick=guard(()=>exportImage($("format").value,true));
    $("download").onclick=guard(()=>{const t=edit();root.HuayuDownloadCenter.download(new Blob([JSON.stringify(t,null,2)],{type:"application/json"}),t.title+".json");status("已导出模板 JSON；其中不含当前线路资料。");});
    $("upload").onchange=guard(async()=>{const file=$("upload").files[0];if(file){const current=++epoch;const text=await file.text();if(current!==epoch)return;importTemplate(core.parse(text));}$("upload").value="";});
    $("share").onclick=guard(prepareShare);$("shared-refresh").onclick=()=>shared();$("shared-more").onclick=()=>shared(true);
    $("motion-toggle").onclick=$("large-motion-toggle").onclick=()=>{playing=!playing;syncMotion();};
    $("motion-speed").onchange=()=>{mountMotion("motion-preview");if($("dialog").open)mountMotion("large-motion");syncMotion();};$("full-map").onchange=syncMotion;
    $("zoom").onclick=()=>{if(!url)return;$("large-image").src=url;$("large-image").style.width=output.width+"px";$("large-image").alt=$("image").alt;mountMotion("large-motion");$("dialog").showModal();const small=motionSvg("motion-preview"),large=motionSvg("large-motion");if(small&&large)large.setCurrentTime(small.getCurrentTime());syncMotion();};
    $("dialog").addEventListener("close",()=>{syncMotion();scheduleSimulation();});
    $("close").onclick=()=>$("dialog").close();$("dialog").onclick=e=>{if(e.target===$("dialog"))$("dialog").close();};
    root.addEventListener('huayu:transit-station-selected',()=>{stationChoice='station';guideSignature=JSON.stringify(atlas.getTransitTemplateLine());stationSelected();});
    root.addEventListener('huayu:feature-selected',()=>{stationChoice='feature';if(root.HuayuTransitStationData.stationFromFeature(atlas.getSelectedFeature?.()))stationSelected();});
    root.addEventListener('huayu:transit-guide-changed',()=>{const route=atlas.getTransitTemplateLine(),signature=JSON.stringify(route),changed=signature!==guideSignature;guideSignature=signature;if(stationPending||stationController||!changed)return;if(route){$("source").value='selected';lineChoices();$("line-choice").value='';}$("current").value='-1';refreshStops(true);render();});
    root.addEventListener("huayu:account-changed",()=>{shareController?.abort();sharedController?.abort();sharedEpoch++;});
    root.addEventListener("pagehide",()=>{clearTimeout(simulationTimer);cancelGeography();geographyObserver.disconnect();motionObserver.disconnect();playing=false;syncMotion();cancelStation();shareController?.abort();sharedController?.abort();if(url)URL.revokeObjectURL(url);});
    $("references").ontoggle=async()=>{
      if(!$("references").open||$("reference-list").children.length)return;
      try{const response=await fetch("./transit-template-references.json",{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error("参考目录暂时不可用");const refs=await response.json();
        $("reference-list").replaceChildren(el("p",refs.note),...refs.items.map(item=>{const p=el("p"),a=el("a",item.title);a.href=item.url;a.target="_blank";a.rel="noopener noreferrer";p.append(a);
          if(item.cities)p.append(el("small",item.cities.join("、")));if(item.observation)p.append(el("small",item.observation));p.append(el("small",item.license));return p;}));
        for(const item of refs.userReferences?.items||[]){const p=el("p",String(item.index)+". "+item.title);p.append(el("small",item.observation));for(const id of item.templates){const entry=entries.find(e=>e.id===id);if(entry)p.append(button("套用："+entry.template.title,()=>{selected=entry;$("family").value=entry.template.family;fillOptions();}));} $("reference-list").append(p);}
      }catch(e){status(e.message,true);}
    };
    fillOptions();
    root.HuayuLineTemplateUI=Object.freeze({catalog,loadStation,loadGeography,loadThroughCandidates,getDirections:loadedDirections,getPreviewOptions:()=>({throughConnections:rawData()?rawConnections(rawData()).map(v=>({lineSourceId:v.route.sourceId,attach:v.attach,reverse:v.reverse})):[],connectionOptions:core.throughConnectionOptions(joinedData(),availableConnectionRoutes()),operatingPattern:operatingValue(),throughServices:throughValues(),stops:joinedData()?.stops.map((v,i)=>({index:String(i),sourceId:v.sourceId,name:v.name}))||[],passenger:passengerOptions(),simulateMissing:$("simulate-missing").checked,realtime:false}),getContext:()=>{const route=joinedData(selectedData());return route?{throughConnections:route.throughRoute?.segments||[],operatingPattern:operatingValue(route),title:route.title,sourceId:route.sourceId,overview:Boolean(route.overview),stationCount:route.stops.length,from:route.from,to:route.to,endpointState:route.endpointState||null}:null;},
      getStationContext:()=>{const b=activeStationBoard();return b?{stationName:b.stationName,stationId:b.stationId,mode:b.rail?'rail':'bus',lineCount:b.lines.length,complete:Boolean(b.complete),pending:stationPending,scope:b.scope||'手动收录',sourceTime:b.sourceTime||null,lines:b.lines.map(e=>({sourceId:e.route.sourceId,title:e.route.title,ref:e.route.ref,overview:Boolean(e.overview),servesSelectedStation:e.current>=0}))}:null;},
      prepare({templateId,source="selected",display="line",lineSourceId,simulateMissing,passenger,throughServices,throughConnections,operatingPattern}){
        const entry=entries.find(v=>v.id===templateId);if(!entry)throw Error("请先查询模板目录，使用返回的真实模板编号");
        if(stationPending)throw Error('正在核对新站点数据，请等待完成后再套用模板');
        if(passenger){if(!rich(entry.template))throw Error("此模板不支持车厢导视参数，请选择参考车厢屏或轨道导视");passengerOptions(passenger);}
        if(display==="station"&&entry.template.family!=="bus-stop")throw Error("同站多线路请选择公交站牌模板");
        if(display==="station"&&source==="selected"&&(!stationBoard||stationBoard.rail))throw Error("请先在原界面把已读取的同站公交线路加入本站牌");
        if(lineSourceId&&source!=="selected")throw Error("指定已读线路编号时请选择 selected 来源");
        if(lineSourceId){const entry=stationBoard?.lines.find(e=>e.route.sourceId===lineSourceId),direction=loadedDirections().find(e=>e.sourceId===lineSourceId);if(!entry&&!direction&&atlas.getTransitTemplateLine()?.sourceId!==lineSourceId)throw Error("请使用已读线路清单里的真实关系编号");if(direction&&!entry)atlas.selectTransitTemplateDirection(lineSourceId);lineChoices();$("line-choice").value=entry?.key||"";}
        if(display==="line"&&source==="selected"&&!selectedData())throw Error("请先在‘线路’页搜索并选中真实线路，待站序加载后再套用模板");
        const base=source==='demo'?core.demo:selectedData();
        let candidate=base,connectionValues=base?rawConnections(base):[];
        if(throughConnections!==undefined){
          if(!Array.isArray(throughConnections)||throughConnections.length>20)throw Error('贯通拼接最多20段');
          connectionValues=throughConnections.map(v=>{const route=availableConnectionRoutes().find(r=>r.sourceId===v.lineSourceId);if(!route||Object.keys(v).some(k=>!['lineSourceId','attach','reverse'].includes(k)))throw Error('请先读取相接线路，再用真实编号拼接');return {route,attach:v.attach,reverse:v.reverse};});
        }
        candidate=joinedData(base,connectionValues);
        const normalizedServices=throughServices===undefined?undefined:core.normalizeThroughServices(candidate,throughServices);
        const normalizedPattern=operatingPattern===undefined?undefined:core.normalizeOperatingPattern(candidate,operatingPattern);
        if(throughConnections!==undefined)connections.set(throughKey(base),connectionValues);
        if(normalizedServices!==undefined)throughOverrides.set(throughKey(candidate),normalizedServices);
        if(normalizedPattern!==undefined){operatingOverrides.set(throughKey(candidate),normalizedPattern);$("operating-stops").dataset.key='';}
        if(passenger){for(const [key,value] of Object.entries(passenger)){const id=({cars:"vehicle-cars",car:"vehicle-car",doorSide:"door-side",doorLabel:"door-label",phase:"vehicle-phase",page:"screen-page",leftExit:"left-exit",rightExit:"right-exit"})[key];if(id)$(id).value=String(value);if(key==="facilities")for(const k of ["wc","accessible","lift","stairs"])$("facility-"+k).checked=value.includes(k);}passengerOptions();}
        if(typeof simulateMissing==="boolean")$("simulate-missing").checked=simulateMissing;
        stationPending=false;selected=entry;$("display").value=display;$("family").value=entry.template.family;$("source").value=source;$("current").value="-1";fillOptions();
        atlas.openView("transit",{preservePerspective:true});$("workspace").open=true;$("workspace").scrollIntoView({block:"start",behavior:"smooth"});
        return {templateId:entry.id,title:entry.template.title,source,display,lineCount:output?.lineCount||1,demo:source==="demo",stationCount:output?.stationCount||0,busLayout:output?.busLayout||entry.template.style.busLayout||null,screenLayout:output?.screenLayout||null,animated:Boolean(output?.motionSvg),throughConnections:rawData()?rawConnections(rawData()).map(v=>({lineSourceId:v.route.sourceId,attach:v.attach,reverse:v.reverse})):[],operatingPattern:operatingValue(),throughServices:throughValues(),passenger:output?.passenger||null,passengerPages:output?.passengerPages||[],simulateMissing:$("simulate-missing").checked,lineSourceId:rawData()?.sourceId||null,realtime:false};
      }});
  }
  if(root.HuayuAtlas)start();else root.addEventListener("huayu:map-ready",start,{once:true});
})(globalThis);
