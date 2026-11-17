(function(root){
  "use strict";
  function create(options){
    const {atlas,fetch:read=fetch,getFile=()=>null}=options,contract=root.HuayuAgentContract,refs=new Map();
    let sequence=0;
    const guard=ctx=>{if(ctx.signal?.aborted||ctx.isCurrent&&!ctx.isCurrent())throw new DOMException("已取消","AbortError");};
    const refFor=result=>{
      if(result.lat==null||String(result.lat).trim()===""||(result.lon??result.lng)==null||String(result.lon??result.lng).trim()==="")throw Error("来源结果缺少有效位置");
      const lat=Number(result.lat),lng=Number(result.lon??result.lng);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>85||Math.abs(lng)>180)throw Error("来源结果缺少有效位置");
      const ref="place-"+(++sequence);refs.set(ref,result);
      if(refs.size>200)refs.delete(refs.keys().next().value);
      return {ref,label:String(result.name||result.display_name||result.label||"地图物体"),lat:Number(result.lat),lng:Number(result.lon??result.lng),
        type:result.osm_type||result.type,id:result.osm_id||result.id,source:"OpenGeofiction"};
    };
    const resolve=ref=>{const r=refs.get(ref);if(!r)throw Error("地点引用已失效，请重新搜索或引用地图选中物体");return r;};
    async function json(path,ctx){
      const r=await read(path,{credentials:"same-origin",cache:"no-store",signal:ctx.signal});
      if(!r.ok)throw Error("查询暂时失败（"+r.status+"），请重试");const data=await r.json();guard(ctx);return data;
    }
    const handlers={
      get_capabilities:async()=>({version:contract.version,panels:contract.panels,tools:contract.tools.map(({name,description,effect})=>({name,description,effect}))}),
      get_map_context:async()=>{
        const view=atlas.getDatasetContext?.(),camera=view?.perspective&&view.vector||atlas.map;
        const c=camera.getCenter(),b=camera.getBounds(),f=atlas.getSelectedFeature();
        return {center:{lat:c.lat,lng:c.lng},zoom:camera.getZoom()+(view?.perspective?1:0),perspective:Boolean(view?.perspective),bounds:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],
          selected:f?refFor({osm_type:f.type,osm_id:f.id,name:f.label,lat:f.lat,lon:f.lng}):null,
          attachment:getFile()?{name:getFile().name,size:getFile().size,contentSentToModel:false}:null};
      },
      search_places:async({query},ctx)=>{
        const results=await atlas.searchForAgent(query);guard(ctx);
        return {query,items:results.slice(0,8).map(refFor),limit:8,complete:false,source:"OpenGeofiction 地名及设施索引"};
      },
      locate_place:async({ref},ctx)=>{guard(ctx);atlas.selectAgentPlace(resolve(ref));return {status:"located",handoff:true,message:"已定位并打开物体详情。"};},
      prepare_navigation:async({originRef,destinationRef,mode},ctx)=>{
        const origin=resolve(originRef),destination=resolve(destinationRef);guard(ctx);
        atlas.prepareAgentNavigation(origin,destination,mode);
        return {status:"draft",handoff:true,message:"导航起终点已填好，请在导航页开始规划；尚未计算路线。"};
      },
      search_shared_info:async({query},ctx)=>{
        const data=await json("/api/feature-info/search?q="+encodeURIComponent(query),ctx);
        return {source:"用户共享投稿，保留各作者观点",items:data.items.map(i=>({...i,...refFor({osm_type:i.type,osm_id:i.id,name:i.label,lat:i.lat,lon:i.lng})})),complete:!data.hasMore};
      },
      search_datasets:async({query,kind=""},ctx)=>{
        const data=await json("/api/datasets?"+new URLSearchParams({q:query,kind}),ctx);
        return {source:"用户共享数据包",items:data.items.map(i=>({id:i.id,title:i.title,kind:i.kind,scope:{kind:i.scope?.kind,label:i.scope?.label,target:i.scope?.target},source:i.source,observedDate:i.observedDate,unit:i.unit,stats:i.stats,author:i.author})),nextCursor:data.nextCursor,complete:!data.nextCursor};
      },
      open_dataset:async({id},ctx)=>{
        if(!/^[a-zA-Z0-9_-]{1,80}$/u.test(id))throw Error("数据包编号无效");guard(ctx);
        await options.datasets().openFromAgent(id,ctx.signal);guard(ctx);
        return {status:"opened",handoff:true,message:"已打开共享数据包，可查看完整资料、制图或加入下载清单。"};
      },
      prepare_feature_info:async(args,ctx)=>{
        if(!options.personal()?.isAuthenticated())throw Error("请先登录，再准备共享信息");
        const r=resolve(args.ref),type=r.osm_type,id=Number(r.osm_id);if(!["node","way","relation"].includes(type)||!Number.isSafeInteger(id)||id<=0)throw Error("请选择有原始编号的物体");
        guard(ctx);const selected=atlas.getSelectedFeature();
        if(selected?.type!==type||selected?.id!==id)throw Error("地图已选中其他物体，请重新定位目标后再准备草稿");
        options.features().prepareDraft(args);
        return {status:"draft",handoff:true,message:"共享信息草稿已填入原表单，请核对原始物体、文字和属性后发布；尚未公开。"};
      },
      prepare_dataset:async(args,ctx)=>{
        if(!options.personal()?.isAuthenticated())throw Error("请先登录，再准备共享数据包");
        const file=getFile();if(!file)throw Error("请先在助手中选择本机 CSV、JSON 或 GeoJSON 附件");
        guard(ctx);const result=await options.datasets().prepareFromAgent(file,args,ctx.signal);guard(ctx);
        return {status:"draft",handoff:true,message:"附件已带入数据页面并完成预览，尚未发布。请补齐来源与口径后勾选共享并发布。",stats:result?.stats};
      },
      open_panel:async({panel},ctx)=>{guard(ctx);atlas.openAgentPanel(panel);return {status:"opened",handoff:true,message:"已打开"+contract.panels.find(p=>p.id===panel).title+"；可在该页继续操作。"};}
    };
    for(const tool of contract.tools)if(typeof handlers[tool.name]!=="function")throw Error("助手功能缺少处理器："+tool.name);
    return Object.freeze({reset(){refs.clear();},list:()=>contract.tools,
      async execute(name,args,ctx={}){contract.argumentsFor(name,args);guard(ctx);const result=await handlers[name](args,ctx);guard(ctx);return result;}});
  }
  root.HuayuAgentTools=Object.freeze({create});
})(globalThis);
