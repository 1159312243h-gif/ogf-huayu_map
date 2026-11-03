(() => {
  "use strict";
  async function analyze(features, {signal, seed, onProgress, part="land"}={}) {
    if(signal?.aborted)throw new DOMException("已取消","AbortError");
    const worker=new Worker("./coastline-worker.js?v=2");
    return new Promise((resolve,reject)=>{
      let done=false;
      const local=new AbortController();
      const finish=(error,result)=>{
        if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);
        local.abort();worker.terminate();error?reject(error):resolve(result);
      };
      const abort=()=>finish(new DOMException("已取消","AbortError"));
      const timer=setTimeout(()=>finish(Error("海岸线处理超时，请缩小范围或稍后重试")),80000);
      signal?.addEventListener("abort",abort,{once:true});
      worker.onerror=()=>finish(Error("海岸线后台组件加载失败，请刷新后重试"));
      worker.onmessage=async ({data})=>{
        if(done)return;
        if(data.type==="error")finish(Error(data.message));
        else if(data.type==="result")finish(null,data);
        else if(data.type==="seed") {
          try {
            onProgress?.("此范围未穿过海岸线，正在核对陆海归属…");
            const result=await seed(data.bounds,local.signal);
            if(!done)worker.postMessage({type:"seed",land:result.land,metadata:result.metadata});
          }catch(error){finish(error);}
        }
      };
      worker.postMessage({type:"analyze",features,part});
    });
  }
  window.HuayuCoastlineClient={analyze};
})();
