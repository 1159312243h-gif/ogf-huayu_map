(function installTrafficProtocol(root){
  "use strict";
  const phases=["edge","dwell","parking","unparking","turn"],stride=13,laneSources=["tag","width","class"];
  class Encoder {
    constructor(){this.reset([]);}
    reset(edges){this.known=new Map();this.labels=[...new Set(edges.map(e=>e.name))];this.roads=new Map(this.labels.map((name,i)=>[name,i]));
      this.surfaces=[...new Map(edges.filter(e=>e.roadId!==undefined).map(e=>[e.roadId,{id:e.roadId,width:e.laneSpec?.width}])).values()];this.surfaceIds=new Map(this.surfaces.map((s,i)=>[s.id,i+1]));this.fresh=true;}
    encode(data){
      const cars=data.vehicles,frames=new Float64Array(cars.length*stride),meta=[],live=new Set();
      cars.forEach((v,i)=>{
        live.add(v.id);const old=this.known.get(v.id);
        if(!old||["purpose","origin","destination","distance","parkingName"].some(key=>old[key]!==v[key])){
          const m={id:v.id,purpose:v.purpose,origin:v.origin,destination:v.destination,distance:v.distance,parkingName:v.parkingName};this.known.set(v.id,m);meta.push(m);
        }
        const flags=Math.max(0,phases.indexOf(v.phase))+(v.returning?8:0)+(v.elevated?16:0)+(v.hiddenSample?32:0)+(v.waiting?64:0)+(v.parked?128:0)+(v.parking?256:0)+(v.nextElevated?512:0)+(v.nextTunnel?1024:0)+(v.tunnel?2048:0);
        const lane=v.lane?v.lane+v.lanes*32+Math.max(0,laneSources.indexOf(v.laneSource))*1024:0;
        frames.set([v.id,v.coordinate[0],v.coordinate[1],v.angle,v.speed,v.queueSeconds,v.dwellRemaining,flags,this.roads.get(v.road)??0,lane,this.surfaceIds.get(v.roadId)||0,this.surfaceIds.get(v.nextRoadId)||0,v.turnProgress||0],i*stride);
      });
      for(const id of this.known.keys())if(!live.has(id))this.known.delete(id);
      if(this.fresh){data.roadLabels=this.labels;data.roadSurfaces=this.surfaces;this.fresh=false;}
      if(meta.length)data.vehicleMeta=meta;
      data.vehicleFrames=frames;delete data.vehicles;return data;
    }
  }
  class Decoder {
    constructor(){this.known=new Map();this.labels=[];this.surfaces=[];}
    decode(data){
      if(!data.vehicleFrames)return data;
      const frames=data.vehicleFrames;
      if(!(frames instanceof Float64Array)||frames.length%stride||frames.length>4096*stride)throw Error("车辆帧格式或数量超限");
      if(data.roadLabels){if(data.roadLabels.length>160000)throw Error("道路名称表超限");this.labels=data.roadLabels;this.known.clear();}
      if(data.roadSurfaces){if(data.roadSurfaces.length>160000)throw Error("道路表面表超限");this.surfaces=data.roadSurfaces;}
      for(const m of data.vehicleMeta||[])this.known.set(m.id,m);
      const live=new Set(),cars=[];
      for(let i=0;i<frames.length;i+=stride){const id=frames[i],meta=this.known.get(id),flags=frames[i+7];if(!meta)throw Error("车辆元数据不完整");
        live.add(id);cars.push({...meta,coordinate:[frames[i+1],frames[i+2]],angle:frames[i+3],speed:frames[i+4],queueSeconds:frames[i+5],dwellRemaining:frames[i+6],
          phase:phases[flags&7],returning:!!(flags&8),elevated:!!(flags&16),hiddenSample:!!(flags&32),waiting:!!(flags&64),parked:!!(flags&128),parking:!!(flags&256),road:this.labels[frames[i+8]],
          ...(frames[i+10]?{roadId:this.surfaces[frames[i+10]-1]?.id,roadWidth:this.surfaces[frames[i+10]-1]?.width,nextRoadId:this.surfaces[frames[i+11]-1]?.id,turnProgress:frames[i+12],nextElevated:!!(flags&512),nextTunnel:!!(flags&1024),tunnel:!!(flags&2048)}:{}),
          ...(frames[i+9]?{lane:frames[i+9]&31,lanes:(frames[i+9]>>5)&31,laneSource:laneSources[frames[i+9]>>10]}:{})});
      }
      for(const id of this.known.keys())if(!live.has(id))this.known.delete(id);
      data.vehicles=cars;delete data.vehicleFrames;delete data.vehicleMeta;delete data.roadLabels;delete data.roadSurfaces;return data;
    }
  }
  root.HuayuTrafficProtocol=Object.freeze({Encoder,Decoder});
})(globalThis);
