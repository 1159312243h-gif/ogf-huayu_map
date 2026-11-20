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
      get_brand_profile:async({name},ctx)=>{
        const data=await json("/api/brand-management/brand?name="+encodeURIComponent(name),ctx);
        return {name:data.name,source:"用户共享品牌资料",profile:data.profile?{description:data.profile.description,website:data.profile.website,updatedAt:data.profile.updatedAt,editedBy:data.profile.editedBy}:null,
          managers:(data.managers||[]).map(p=>({username:p.username,displayName:p.displayName}))};
      },
      prepare_brand_management:async(args,ctx)=>{
        if(!options.personal()?.isAuthenticated())throw Error("请先登录，再准备品牌管理申请");
        guard(ctx);const result=await options.brands().prepareFromAgent(args,ctx);guard(ctx);
        return {status:"draft",handoff:true,name:result.name,message:"管理申请草稿已填入品牌原表单，请核对后提交；尚未申请或获得权限。"};
      },
      get_transit_templates:async()=>({items:options.templates().catalog(),selectedLine:options.templates().getContext(),selectedDirections:options.templates().getDirections?.()||[],selectedStation:options.templates().getStationContext?.()||null,previewOptions:options.templates().getPreviewOptions?.()||null,limits:"默认按用户要求补全缺失运营资料和模拟到站，可用 simulateMissing 关闭。真实值优先；模拟时间、票价、间隔、发车时刻和运营方的来源保留在页面及 SVG 元数据，图片不印模拟字样或底部说明，同线分行只显示一次大号线路编号，不写回源数据或共享模板，不随机生成站序、终点或环线。可用 lineSourceId 选择 selectedStation.lines 或 selectedDirections 里已读的完整线路／方向套用任意单线模板。公交车厢全线屏支持走马灯、交错站名、斜排、折返、闭合回接和邻站放大，原界面可暂停、调速及查看完整静态图；动画仅为手动演示，下载为完整静态图。本批30张参考对应到53套实际模板，包含高阳黑黄站牌与地理站点／发车表详情、各地纸质／电子牌和车厢屏。高阳详情可用 load_transit_template_geography 读取真实道路背景及成员道路几何；无成员几何时虚线只表示站点连线；发车日期条件保留，车厢、门侧、左右出口、设施和屏幕状态可用 passenger 手动设置，仅为预览；未提供的跳停／通告不编造。公交含纸质、灯箱、杆挂及 LCD／LED／电子墨水屏结构；支持单线路、按站查询或用户已收录的同站多线路；可用 load_transit_station_template 查询所选公交／轨道站点的已登记关系；load_transit_through_candidates 读取首尾相接的真实线路候选，throughConnections 接入完整站序；operatingPattern 设置大小交路与跳停，保留全线并置灰不停站，下一站仅取停靠站；仅为本页人工预览；所有模板线在站点下方，灰显站圈保留遮挡，图片不附底部交路说明灰字，独立运行箭头在第一行站点上方。可用 throughServices 设置附加区间色条，真实控件和 PNG/SVG 共同显示，不改变 OGF 或导航；轨道按完整主关系及全部分期／上下行读取，默认全线总览，复用原线路页组装与排序，未经过本站的分期不指定当前站；轨道站序按已读真实连续轨道校正，全线各站核对明确站体与换乘。地图切换站点自动刷新，已读线路先定位且后台核对完整关系，完整缓存仅复用两分钟并保留源时间；轨道定位本站，换乘用线路原色与编号，不包含未登记线路，无实时到站；所有版式支持线路分隔和闭合方向，不推断环线运营首站，起终点仅按线路 from/to 属性显示，缺失终点标为未提供，总关系多方向终点不一致时提示选择具体方向，支持 route 与 route_master 制式标签，预览换向不改写属性，主线与回接线等粗，公交环线站点均衡排在闭合圈两侧，折返段使用相同圆角和描边；无锡园林屏为浅色宽屏、窄花边牌、拱形站灯和独立到站页；运行资料先按线路、明确上级和运营方安排读取，发车时刻与间隔分开；启用补全后图片显示补全值，页面另列模拟来源，关闭后保留未提供。JSON 模板须由用户主动选择并在原表单核对后共享。"}),
      load_transit_station_template:async({ref},ctx)=>{guard(ctx);const r=ref?resolve(ref):null;const station=r?{type:r.osm_type,id:Number(r.osm_id),name:r.name}:null;const result=await options.templates().loadStation(station,ctx);guard(ctx);return {...result,status:"preview",handoff:true,message:"已在原页面按真实停靠关系生成本站线路预览；公交为站牌，轨道默认完整主关系全线总览，可选全部分期／方向，按实际归属定位本站，范围以返回 scope 为准；未发布或下载。"};},
      load_transit_through_candidates:async(args,ctx)=>{guard(ctx);const result=await options.templates().loadThroughCandidates(args,ctx);guard(ctx);return {...result,status:"loaded",message:"已读取真实端点线路候选，尚未自动拼接；可按返回 choices 设置 throughConnections。"};},
      load_transit_template_geography:async(args,ctx)=>{guard(ctx);const result=await options.templates().loadGeography(args,ctx);guard(ctx);return {...result,status:"loaded"};},
      prepare_transit_template:async(args,ctx)=>{guard(ctx);const result=options.templates().prepare(args);return {...result,status:"preview",handoff:true,message:"已在原线路页面准备显示图预览，未下载或发布；当前站不代表实时车辆位置。"};},
      open_panel:async({panel},ctx)=>{guard(ctx);atlas.openAgentPanel(panel);return {status:"opened",handoff:true,message:"已打开"+contract.panels.find(p=>p.id===panel).title+"；可在该页继续操作。"};}
    };
    for(const tool of contract.tools)if(typeof handlers[tool.name]!=="function")throw Error("助手功能缺少处理器："+tool.name);
    return Object.freeze({reset(){refs.clear();},list:()=>contract.tools,
      async execute(name,args,ctx={}){contract.argumentsFor(name,args);guard(ctx);const result=await handlers[name](args,ctx);guard(ctx);return result;}});
  }
  root.HuayuAgentTools=Object.freeze({create});
})(globalThis);
