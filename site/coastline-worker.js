"use strict";
importScripts("./vendor/polygon-clipping-0.15.7.js", "./coastline.js?v=2");
let pending=null;
self.onmessage=async ({data})=>{
  try {
    if(data.type==="seed") {
      if(!pending || typeof data.land!=="boolean")throw Error("陆海归属读取失败");
      pending.metadata.classification=data.metadata;
      finish(HuayuCoastline.landGeometry([],pending.bounds,data.land));
      return;
    }
    if(pending)throw Error("海岸线任务正在执行");
    const part=data.part || "land";
    if(!["land","sea"].includes(part))throw Error("请选择陆地或海域截取范围");
    const bounds=HuayuCoastline.bounds(data.features);
    const response=await fetch(`/api/coastline?${new URLSearchParams({bbox:[bounds.west,bounds.south,bounds.east,bounds.north].join(",")})}`,
      {signal:AbortSignal.timeout(40000),cache:"no-store"});
    const payload=await response.json();
    if(!response.ok)throw Error(payload.error||"海岸线读取失败");
    if(!Array.isArray(payload.elements)||!payload.fetchedAt)throw Error("海岸线数据不完整");
    pending={features:data.features,bounds,part,metadata:{algorithm:HuayuCoastline.VERSION,part,source:"OpenGeofiction natural=coastline",
      fetchedAt:payload.fetchedAt,sourceTimestamp:payload.sourceTimestamp||null,includesInlandWater:true,
      note:"按 OGF 海岸线计算的制图估算；河流、湖泊计入陆地口径，海域单列，不代表法定面积。"}};
    const land=HuayuCoastline.landGeometry(payload.elements,bounds);
    if(land===null)self.postMessage({type:"seed",bounds});else finish(land);
  } catch(error) {self.postMessage({type:"error",message:error.message||"海岸线处理失败"});}
};
function finish(land) {
  const rows=HuayuCoastline.analyze(pending.features,land,undefined,pending.part);
  if(new TextEncoder().encode(JSON.stringify(rows)).byteLength>32*1024*1024)throw Error("截取结果超过 32 MiB，请减少行政区后分批下载");
  self.postMessage({type:"result",rows,metadata:pending.metadata});
  pending=null;
}
