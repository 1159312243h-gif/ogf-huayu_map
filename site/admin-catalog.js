(function installAdministrativeCatalog(root){
  "use strict";
  const RELATION=28652,TTL=3*60*60*1000,MAX=20000,KEY="huayu-huaxia-admin-catalog-v1";
  const ENDPOINT="https://overpass.opengeofiction.net/api/interpreter";
  function query(id=RELATION){
    if(id!==RELATION)throw Error("国家关系无效");
    // Check the area itself, so a missing map_to_area cannot look like a
    // successful national catalog containing only the root relation.
    return `[out:json][timeout:90];rel(${id})->.country;area(${3600000000+id})->.scope;.scope out count;(.country;rel(area.scope)["boundary"="administrative"]["admin_level"];)->.admins;.admins out tags center;.admins out count;`;
  }
  function validate(value){
    if(value?.schema!==KEY||value.relationId!==RELATION||!Array.isArray(value.elements)
      ||value.elements.length<2||value.elements.length>MAX||value.total!==value.elements.length
      ||!Number.isFinite(Date.parse(value.readAt))||!Number.isFinite(Date.parse(value.sourceTime)))throw Error("行政区清单不完整");
    const ids=new Set();
    for(const e of value.elements){
      if(e.type!=="relation"||!Number.isSafeInteger(e.id)||e.id<=0||ids.has(e.id)
        ||e.tags?.boundary!=="administrative"||!Number.isSafeInteger(Number(e.tags.admin_level))||Number(e.tags.admin_level)<=0
        ||!Number.isFinite(e.center?.lat)||Math.abs(e.center.lat)>90||!Number.isFinite(e.center?.lon)||Math.abs(e.center.lon)>180)throw Error("行政区清单对象无效");
      ids.add(e.id);
    }
    if(!value.elements.some(e=>e.id===RELATION&&Number(e.tags.admin_level)===2))throw Error("缺少华夏国家关系");
    return value;
  }
  function build(payload,previous=null,readAt=new Date().toISOString()){
    const counts=payload?.elements?.filter(e=>e.type==="count"),elements=payload?.elements?.filter(e=>e.type!=="count");
    if(payload?.remark||counts?.length!==2||Number(counts[0].tags?.areas)!==1||Number(counts[0].tags?.total)!==1
      ||Number(counts[1].tags?.relations)!==elements?.length||Number(counts[1].tags?.total)!==elements?.length)throw Error("国家范围或行政区计数不完整");
    const result=validate({schema:KEY,relationId:RELATION,readAt,sourceTime:payload.osm3s?.timestamp_osm_base,
      total:elements.length,elements});
    if(previous&&result.total<validate(previous).total*.6)throw Error("行政区数量异常缩减，保留完整旧清单");
    return result;
  }
  class Loader{
    constructor({fetcher=root.fetch?.bind(root),storage,now=()=>Date.now()}={}){
      this.fetcher=fetcher;this.now=now;this.current=null;this.pending=null;this.pendingLive=false;this.listeners=new Set();
      try{this.storage=storage===undefined?root.localStorage:storage;}catch{}
    }
    accept(value){
      validate(value);
      if(Date.parse(value.readAt)>this.now()+60000)throw Error("清单读取时间无效");
      if(this.current&&Date.parse(value.readAt)<Date.parse(this.current.readAt))return this.current;
      if(this.current&&value.total<this.current.total*.6)throw Error("行政区数量异常缩减，保留完整旧清单");
      this.current=value;
      try{const text=JSON.stringify(value);if(text.length<=2*1024*1024)this.storage?.setItem(KEY,text);}catch{}
      for(const notify of this.listeners)notify(value);
      return value;
    }
    async live(){
      const response=await this.fetcher(`${ENDPOINT}?${new URLSearchParams({data:query()})}`,{signal:AbortSignal.timeout(110000),cache:"no-store",credentials:"omit"});
      if(!response.ok)throw Error(`行政区服务 HTTP ${response.status}`);
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;
        if(size>8*1024*1024)throw Error("行政区清单超过 8 MiB");chunks.push(value);}}
      finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
      return this.accept(build(JSON.parse(new TextDecoder().decode(bytes)),this.current,new Date(this.now()).toISOString()));
    }
    async snapshot(){
      const response=await this.fetcher("./huaxia-admin-catalog.json",{cache:"no-cache",signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error("完整预制清单暂不可用");
      const text=await response.text();if(text.length>2*1024*1024)throw Error("清单超过容量");
      return this.accept(JSON.parse(text));
    }
    refresh(live=false){
      if(this.pending)return live&&!this.pendingLive?this.pending.then(()=>this.refresh(true)):this.pending;
      this.pendingLive=live;
      this.pending=(async()=>{
        if(!live){try{await this.snapshot();}catch(error){if(!this.current)return this.live();}}
        if(live||!this.current)return this.live();
        return this.current;
      })().finally(()=>{
        this.pending=null;
        this.pendingLive=false;
        // The first stale snapshot must also become usable immediately; the
        // slow live query runs after that complete result is available.
        if(!live&&this.current&&this.now()-Date.parse(this.current.readAt)>=TTL)void this.refresh(true).catch(()=>{});
      });
      return this.pending;
    }
    load(){
      if(!this.current){try{const cached=JSON.parse(this.storage?.getItem(KEY)||"null");if(cached)this.accept(cached);}catch{}}
      if(this.current){void this.refresh().catch(()=>{});return Promise.resolve(this.current);}
      return this.refresh();
    }
  }
  root.HuayuAdministrativeCatalog=Object.freeze({RELATION,TTL,KEY,query,validate,build,Loader});
})(globalThis);
