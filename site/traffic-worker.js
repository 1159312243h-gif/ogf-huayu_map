"use strict";
importScripts("./traffic-core.js?v=8.0-traffic-distribution-v1", "./traffic-demand.js?v=8.0-traffic-distribution-v1",
  "./traffic-regions.js?v=8.0-traffic-distribution-v1", "./traffic-regional-core.js?v=8.0-traffic-distribution-v1", "./traffic-protocol.js?v=8.0-traffic-distribution-v1");
let simulation, timer, encoder, generation = 0, rate = 1, publishedRevision=-1, selectedKey="",publishedStats=-1;
function stop() {clearInterval(timer); timer = null;}
function publish(roads=false) {
  if(!simulation)return;
  const data={generation,...simulation.snapshot(),preview:Boolean(simulation.preview)};
  const fresh=publishedRevision!==simulation.networkRevision;
  if(fresh){data.network=simulation.network();publishedRevision=simulation.networkRevision;}
  if(data.regional&&!fresh){for(const key of ["demand","edges","nodes","sourceTimes","bounds","regionNames"])delete data[key];}
  if(data.regional&&publishedStats===simulation.statsRevision&&!roads){for(const key of ["parking","hotspots","pending"])delete data[key];}
  publishedStats=simulation.statsRevision;
  if(roads)data.roadStates=[...simulation.roadSamples.values()];
  const selected=simulation.cars.find(c=>c.id===simulation.selected),key=selected?`${selected.id}:${selected.returning}`:"none";
  if(key!==selectedKey){data.route=simulation.selectedRoute();selectedKey=key;}
  if(data.regional){encoder??=new HuayuTrafficProtocol.Encoder();if(fresh)encoder.reset(simulation.graph.edges);encoder.encode(data);postMessage(data,[data.vehicleFrames.buffer]);}
  else postMessage(data);
}
function run() {
  stop();
  if (!simulation || simulation.paused || !simulation.graph.edges.length || !simulation.demand.pairs.length) return;
  let ticks = 0;
  timer = setInterval(() => {let remaining=0.05*rate;while(remaining>1e-8){const step=Math.min(0.25,remaining);simulation.advance(step);remaining-=step;}
    if (++ticks % 2 === 0) publish(ticks%20===0);}, 50);
}
onmessage = async ({data}) => {
  try {
    if(data.action==="build-preview"){
      stop();generation=data.generation;publishedRevision=publishedStats=-1;selectedKey="";
      if(!data.regions.some(r=>HuayuTrafficRegions.inside(data.context.center,r.geojson))){postMessage({generation,previewUnavailable:true});return;}
      const options={...data.options,center:data.context.center,radius:1500,demandFeatures:data.context.demand,
        trafficInputLimited:data.context.trafficInputLimited,sourceTimes:data.context.sourceTimes};
      simulation=new HuayuTrafficCore.Simulation(HuayuTrafficCore.buildGraph(data.context.roads,options),options);
      if(!simulation.demand.pairs.length){
        const context=await HuayuTrafficRegions.loadPreview(data.context.center,data.regions);
        if(context){Object.assign(options,{demandFeatures:context.demand,sourceTimes:context.sourceTimes,trafficInputLimited:false});
          simulation=new HuayuTrafficCore.Simulation(HuayuTrafficCore.buildGraph(context.roads,options),options);}
      }
      simulation.preview=true;simulation.paused=data.paused;rate=data.rate||1;publish(true);run();
    } else if(data.action==="build-region"){
      stop();generation=data.generation;publishedRevision=publishedStats=-1;selectedKey="";
      const input=data.regionalInput||await HuayuTrafficRegions.load(data.regions,progress=>postMessage({generation,progress}));
      postMessage({generation,progress:"数据完整，正在后台分配人口、起终点及道路容量…"});
      const options={...data.options,center:input.center,regional:true,regionalInput:input};
      simulation=new HuayuRegionalTraffic.RegionalSimulation(HuayuRegionalTraffic.buildGraph(input,options),options);
      if(data.viewport)simulation.setViewport(data.viewport);
      postMessage({generation,loadedInput:input});
      simulation.paused=data.paused;rate=data.rate||1;publish(true);run();
    } else if (data.action === "build") {
      stop(); generation = data.generation;publishedRevision=publishedStats=-1;selectedKey="";
      simulation = new HuayuTrafficCore.Simulation(HuayuTrafficCore.buildGraph(data.features, data.options), data.options);
      simulation.paused = data.paused; rate = data.rate || 1; publish(true); run();
    } else if (simulation) {
      if (data.action === "pause") {simulation.paused = data.paused; run(); publish();}
      if (data.action === "count") {simulation.setCount(data.count);publish();}
      if (data.action === "select") {simulation.selected=Number(data.id)||null;publish();}
      if (data.action === "rate") rate = Math.max(0.25, Math.min(10, data.rate || 1));
      if (data.action === "viewport") {simulation.setViewport?.(data.bounds);publish();}
    }
  } catch (error) {stop(); postMessage({generation, error: String(error.message || error)});}
};
