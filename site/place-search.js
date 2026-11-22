(function installPlaceSearch(root){
  "use strict";
  function createClient({fetcher=root.fetch.bind(root),now=()=>Date.now(),ttl=300000,maxEntries=24,maxBytes=4*1024*1024,concurrency=2}={}){
    const cache=new Map(),pending=new Map(),queue=[];let bytes=0,active=0;
    const error=(message,name="Error")=>Object.assign(new Error(message),{name});
    function remove(key){const entry=cache.get(key);if(entry){bytes-=entry.bytes;cache.delete(key);}}
    function cached(key){
      const entry=cache.get(key);if(!entry)return null;
      if(now()-entry.at>=ttl||now()<entry.at){remove(key);return null;}
      cache.delete(key);cache.set(key,entry);return entry.data;
    }
    function save(key,data,size){
      if(!data.length||size>maxBytes)return;
      remove(key);cache.set(key,{data,bytes:size,at:now()});bytes+=size;
      while(cache.size>maxEntries||bytes>maxBytes)remove(cache.keys().next().value);
    }
    function pump(){
      while(active<concurrency&&queue.length){
        const task=queue.shift();
        if(task.controller.signal.aborted){finish(task,task.controller.signal.reason||error("查询已取消","AbortError"));continue;}
        active++;task.started=true;
        const timer=setTimeout(()=>task.controller.abort(error("搜索服务超时","TimeoutError")),task.timeout);
        let onAbort;
        const aborted=new Promise((_,reject)=>{
          onAbort=()=>reject(task.controller.signal.reason||error("查询已取消","AbortError"));
          task.controller.signal.addEventListener("abort",onAbort,{once:true});
        });
        const read=(async()=>{
          const response=await fetcher(task.key,{cache:"no-cache",credentials:"omit",headers:{Accept:"application/json"},signal:task.controller.signal});
          if(!response.ok)throw error("HTTP_"+response.status);
          const text=await response.text(),data=JSON.parse(text);
          if(!Array.isArray(data))throw error("INVALID_SEARCH_RESPONSE");
          return {data,size:text.length*2};
        })();
        Promise.race([read,aborted]).then(({data,size})=>{
          if(task.controller.signal.aborted)throw task.controller.signal.reason;
          save(task.key,data,size);finish(task,null,data);
        },e=>finish(task,e)).catch(e=>finish(task,e)).finally(()=>{
          clearTimeout(timer);task.controller.signal.removeEventListener("abort",onAbort);active--;pump();
        });
      }
    }
    function finish(task,cause,data){
      if(task.done)return;task.done=true;
      if(pending.get(task.key)===task)pending.delete(task.key);
      if(cause)task.reject(cause);else task.resolve(data);
    }
    function join(task,signal){
      signal?.throwIfAborted();task.users++;let abort;
      const result=signal?Promise.race([task.promise,new Promise((_,reject)=>{
        abort=()=>reject(signal.reason||error("查询已取消","AbortError"));signal.addEventListener("abort",abort,{once:true});
      })]):task.promise;
      return result.finally(()=>{
        if(abort)signal.removeEventListener("abort",abort);
        if(--task.users===0&&!task.done){task.controller.abort(error("查询已取消","AbortError"));if(!task.started){finish(task,task.controller.signal.reason);}}
      });
    }
    return Object.freeze({
      read(key,{signal,timeout=16000,force=false}={}){
        signal?.throwIfAborted();
        const hit=!force&&cached(key);if(hit)return Promise.resolve(hit);
        let task=pending.get(key);if(task?.controller.signal.aborted){pending.delete(key);task=null;}
        if(!task){
          task={key,timeout,users:0,done:false,started:false,controller:new AbortController()};
          task.promise=new Promise((resolve,reject)=>{task.resolve=resolve;task.reject=reject;});
          pending.set(key,task);queue.push(task);Promise.resolve().then(pump);
        }
        return join(task,signal);
      },
      clear(){for(const task of pending.values())task.controller.abort(error("查询已取消","AbortError"));cache.clear();bytes=0;pump();}
    });
  }
  root.HuayuPlaceSearch=Object.freeze({createClient});
})(globalThis);
