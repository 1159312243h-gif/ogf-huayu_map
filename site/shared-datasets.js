(function(root){
  "use strict";
  function start(){
    const atlas=root.HuayuAtlas,$=id=>document.getElementById(`dataset-${id}`),tools=root.HuayuDatasetTools;
    let active=false,loaded=false,items=[],cursor=null,reading=null,detailReading=null,themeReading=null,readEpoch=0,detailEpoch=0,themeEpoch=0,editEpoch=0,accountEpoch=0,parser=null,parseEpoch=0,parseReject=null;
    let file=null,content="",format="",attachment=null,editing=null,current=null,currentData=null,analysis=null,theme=null;
    let busy=false,leaflet=null,vector=null,drawn=null,vectorDrawn=null,syncing=false;
    const sourceId="huayu-shared-dataset",layers=[sourceId+"-fill",sourceId+"-line",sourceId+"-point"];
    const user=()=>root.HuayuPersonalData?.getCurrentUser()||null;
    const canEdit=item=>Boolean(user()&&(user().id===item.author.id||user().role==="admin"));
    const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    const button=(text,fn)=>{const b=el("button",text,"text-button");b.type="button";b.onclick=fn;return b;};
    const message=error=>({personal_data_service_not_configured:"共享数据库尚未配置",personal_data_failure:"共享数据服务暂时不可用，请重试",authentication_required:"请先登录",payload_too_large:"上传请求超出托管平台实际限制，数据尚未发布"})[error.message]||error.message||"操作失败，请重试";
    async function request(path,options={}){
      const response=await fetch(path,{credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(120000),...options,headers:{"Content-Type":"application/json",...options.headers}});
      const body=await response.json();if(!response.ok)throw Object.assign(Error(body.error||"请求失败"),{status:response.status});return body;
    }
    function auth(){
      $("auth-note").textContent=user()?`以 ${user().displayName||user().username} 上传。数据包将公开共享。`:"登录后可上传；游客可查看和下载。";
      $("publish").disabled=busy||!user();$("preview").disabled=busy;$("file").disabled=busy||Boolean(editing);
    }
    function metadata(){
      return {title:$("title").value,kind:$("kind").value,description:$("description").value,
        scope:{kind:$("scope-kind").value,label:$("scope-label").value,...attachment},source:$("source").value,
        sourceUrl:$("source-url").value,observedDate:$("date").value,unit:$("unit").value,period:$("period").value,license:$("license").value};
    }
    function fields(){return Object.fromEntries(["lng","lat","name","value","type","id"].map(k=>[k,$(`field-${k}`).value.trim()]).filter(v=>v[1]));}
    function table(container,records,title,columns,meta={}){
      const wrapper=el("div",undefined,"dataset-table-scroll"),table=el("table");table.append(el("caption",title));
      Object.assign(table.dataset,{exportSource:meta.source||"用户共享数据包",sourceTime:meta.observedDate||"",exportWarning:`仅显示前 ${records.length} 条预览记录，完整数据请下载数据包`});
      const head=el("thead"),row=el("tr");for(const c of columns)row.append(el("th",c));head.append(row);table.append(head);
      const body=el("tbody");for(const record of records){const row=el("tr");for(const k of columns)row.append(el("td",record[k]==null?"":String(record[k])));body.append(row);}table.append(body);wrapper.append(table);container.replaceChildren(wrapper);
    }
    function cancelParser(){parser?.terminate();parser=null;parseEpoch++;const reject=parseReject;parseReject=null;reject?.(Error("本次预览已取消"));}
    async function parse(){
      if(!file)throw Error("请先选择文件");cancelParser();const epoch=parseEpoch;
      const options={kind:$("kind").value,scope:metadata().scope,fields:fields()};
      $("upload-status").textContent="正在后台校验文件与坐标…";
      const result=await new Promise((resolve,reject)=>{
        parseReject=reject;
        parser=new Worker("./shared-dataset-worker.js?v=9.0-shared-data-v1");
        parser.onmessage=e=>{const p=parser;parser=null;parseReject=null;p?.terminate();if(epoch!==parseEpoch)return reject(Error("本次预览已取消"));e.data.error?reject(Error(e.data.error)):resolve(e.data.result);};
        parser.onerror=()=>{parser?.terminate();parser=null;parseReject=null;reject(Error("文件校验程序未能加载，请刷新重试"));};
        parser.postMessage({content,format,options});
      });
      $("columns").replaceChildren(...result.columns.map(c=>{const o=el("option");o.value=c;return o;}));
      table($("preview-result"),result.records.slice(0,20).map(r=>r.properties),"上传预览（前20条）",result.columns.slice(0,10));
      $("upload-status").textContent=`校验通过：${result.stats.rows} 条，${result.stats.located} 条有位置，${result.stats.linked} 条关联原要素。尚未上传。`;
      return result;
    }
    function clearForm(){
      editEpoch++;cancelParser();$("form").reset();file=null;content="";format="";attachment=null;editing=null;$("date").value=new Date().toLocaleDateString("en-CA");
      $("preview-result").replaceChildren();$("columns").replaceChildren();$("upload-status").textContent="";$("scope-note").textContent="范围名称只作说明；空间定位以文件几何／坐标为准。";
      $("edit-cancel").hidden=true;$("publish").textContent="发布共享数据包";$("file").required=true;
      for(const id of ["kind","scope-kind","scope-label","use-selection"])$(id).disabled=false;auth();
    }
    async function publish(event){
      event.preventDefault();if(busy||!user())return;if(!$("shared").checked){$("upload-status").textContent="请先确认数据公开共享。";return;}
      const epoch=accountEpoch;
      try{
        busy=true;auth();let payload;
        if(editing)payload={revision:editing.revision,metadata:metadata()};
        else {await parse();payload={metadata:metadata(),content,format,filename:file.name,fields:fields(),shared:true};}
        if(epoch!==accountEpoch)return;
        $("upload-status").textContent=editing?"正在保存资料…":"正在上传并原子保存完整数据包…";
        const result=await request(editing?`/api/datasets/${editing.id}`:"/api/datasets",{method:editing?"PATCH":"POST",body:JSON.stringify(payload)});
        if(epoch!==accountEpoch)return;
        clearForm();$("upload-status").textContent="已公开保存。大家现在可查询、下载和生成专题图。";
        await loadList();await open(result.item.id);
      }catch(error){if(epoch===accountEpoch)$("upload-status").textContent=message(error)+"；草稿已保留。";}
      finally{busy=false;auth();}
    }
    async function edit(summary){
      if(busy||!canEdit(summary))return;const epoch=accountEpoch,selection=++editEpoch;let item;
      try{item=(await request(`/api/datasets/${summary.id}`)).item;}catch(error){if(epoch===accountEpoch&&selection===editEpoch&&active)$("list-status").textContent=message(error);return;}
      if(epoch!==accountEpoch||selection!==editEpoch||busy||!active||!canEdit(item))return;clearForm();editing=item;attachment={...(item.scope.target?{target:item.scope.target}:{}),...(item.scope.geometry?{geometry:item.scope.geometry}:{})};
      for(const [id,k] of [["title","title"],["kind","kind"],["source","source"],["source-url","sourceUrl"],["date","observedDate"],["unit","unit"],["period","period"],["license","license"],["description","description"]])$(id).value=item[k];
      $("scope-kind").value=item.scope.kind;$("scope-label").value=item.scope.label;$("file").required=false;$("shared").checked=true;
      for(const id of ["kind","scope-kind","scope-label","use-selection"])$(id).disabled=true;
      $("edit-cancel").hidden=false;$("publish").textContent="保存数据包资料";$("upload-section").open=true;$("upload-status").textContent="保留原作者与原文件。更换文件、范围或分类请另发新包。";auth();$("title").focus();
    }
    async function remove(item){
      if(!canEdit(item)||!confirm(`删除共享数据包“${item.title}”？其他人将无法继续读取这份文件。`))return;
      const epoch=accountEpoch;
      try{await request(`/api/datasets/${item.id}`,{method:"DELETE",body:JSON.stringify({revision:item.revision})});
        if(epoch!==accountEpoch)return;if(current?.id===item.id){current=null;currentData=null;$("detail").hidden=true;hideTheme();}if(editing?.id===item.id)clearForm();await loadList();}
      catch(error){if(epoch===accountEpoch)$("list-status").textContent=message(error);}
    }
    function renderList(){
      $("list").replaceChildren(...items.map(item=>{
        const card=el("article",undefined,"feature-info-card");card.append(el("h3",item.title),el("p",`${tools.KINDS[item.kind]} · ${item.scope.label} · ${item.stats.rows} 条 · ${item.unit||"未指定单位"}`,"feature-info-meta"),
          el("p",`统计：${item.observedDate}${item.period?` · ${item.period}`:""} · ${item.author.displayName||item.author.username}`,"feature-info-meta"));
        const actions=el("div",undefined,"feature-info-actions");actions.append(button("查看与生成专题图",()=>open(item.id)));
        if(canEdit(item))actions.append(button("编辑资料",()=>edit(item)),button("删除",()=>remove(item)));card.append(actions);return card;
      }));$("more").hidden=!cursor;
    }
    async function loadList(more=false){
      reading?.abort();const controller=new AbortController();reading=controller;const epoch=++readEpoch;
      const query=new URLSearchParams({q:$("query").value.trim(),kind:$("filter").value});if(more&&cursor)query.set("after",cursor);
      $("list-status").textContent="正在读取共享数据目录…";
      try{const result=await request(`/api/datasets?${query}`,{signal:controller.signal});if(epoch!==readEpoch||!active)return;
        items=more?[...new Map([...items,...result.items].map(item=>[item.id,item])).values()]:result.items;cursor=result.nextCursor;loaded=true;renderList();
        $("list-status").textContent=items.length?`已读取 ${items.length} 包${cursor?"，下方可继续加载":""}。` : "当前条件下暂无共享数据包。";
      }catch(error){if(error.name!=="AbortError"&&epoch===readEpoch)$("list-status").textContent=message(error)+(items.length?"；保留上次目录。":"。");}
    }
    function artifact(item,data){return root.HuayuDownloadCenter.fileArtifact({id:`dataset-${item.id}-${item.revision}`,title:item.title,filename:`${item.title}.json`,
      kind:"table",blob:new Blob([JSON.stringify({metadata:item,data},null,2)],{type:"application/json"}),source:item.source,sourceTime:item.observedDate,warning:"用户共享资料；保留原作者、单位和统计口径"});}
    async function open(id,signal){
      if(signal?.aborted)throw new DOMException("已取消","AbortError");
      themeReading?.abort();themeEpoch++;detailReading?.abort();detailReading=new AbortController();const epoch=++detailEpoch;$("list-status").textContent="正在读取完整数据包…";
      try{const result=await request(`/api/datasets/${id}/data`,{signal:AbortSignal.any([detailReading.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])])});if(epoch!==detailEpoch||!active||signal?.aborted)return;
        current=result.item;currentData=result.data;analysis=null;hideTheme();$("detail").hidden=false;$("detail-title").textContent=current.title;
        $("detail-meta").replaceChildren(el("p",`${tools.KINDS[current.kind]} · ${current.scope.label} · ${current.stats.rows} 条（${current.stats.located} 条有位置）`),
          el("p",`统计日期：${current.observedDate} · 单位：${current.unit||"未指定"} · 时段／口径：${current.period||"未提供"}`),el("p",`来源：${current.source} · 许可：${current.license}`),
          el("p",`作者：${current.author.displayName||current.author.username} · 上传：${new Date(current.createdAt).toLocaleString()} · 版本 ${current.revision}`),el("p",current.description));
        if(current.sourceUrl){const link=el("a","查看来源");link.href=current.sourceUrl;link.target="_blank";link.rel="noopener noreferrer";$("detail-meta").append(link);}
        $("detail-meta").append(el("p",`原件 SHA-256：${current.sha256}`,"dataset-hash"));
        const columns=["value",...currentData.columns];$("theme-field").replaceChildren(...columns.map(k=>{const o=el("option",k==="value"?"自动识别的主指标":k);o.value=k;return o;}));
        $("theme-unit").value=current.unit;
        $("theme-mode").value=currentData.records.some(r=>r.value!==null)?"numeric":"category";
        if($("theme-mode").value==="category"){$("theme-field").value=currentData.columns.find(k=>/^(category|type|分类|类型|route|线路)$/u.test(k))||currentData.columns[0]||"value";$("theme-unit").value="";}
        $("downloads").replaceChildren();const item=current,data=currentData;
        root.HuayuDownloadCenter.createActions($("downloads"),()=>artifact(item,data),{downloadLabel:"下载完整标准化数据"});
        $("downloads").append(button("下载上传原件",async()=>{try{const r=await fetch(`/api/datasets/${item.id}/download`,{cache:"no-store"});if(!r.ok)throw Error("原件读取失败");root.HuayuDownloadCenter.download(await r.blob(),item.filename);}catch(e){$("analysis-status").textContent=message(e);}}));
        table($("records"),data.records.slice(0,50).map(r=>r.properties),"记录预览（前50条）",data.columns.slice(0,10),item);
        $("analysis-summary").replaceChildren();$("legend").replaceChildren();$("theme-downloads").replaceChildren();$("analysis-status").textContent="请选择字段并生成专题图。";$("list-status").textContent="完整数据包已读取。";return true;
      }catch(error){if(epoch===detailEpoch&&!signal?.aborted)$("list-status").textContent=message(error)+"；已有结果保留。";}
    }
    async function analyze(){
      if(!current)return;themeReading?.abort();themeReading=new AbortController();const item=current,epoch=++themeEpoch;$("analysis-status").textContent="后台正在统计当前字段…";
      try{const q=new URLSearchParams({field:$("theme-field").value,mode:$("theme-mode").value,unit:$("theme-unit").value.trim()});const result=await request(`/api/datasets/${item.id}/analysis?${q}`,{signal:AbortSignal.any([themeReading.signal,AbortSignal.timeout(120000)])});
        if(epoch!==themeEpoch||current?.id!==item.id||!active)return;
        if(result.item.revision!==item.revision)throw Error("数据包资料已更新，请重新打开后计算");
        const candidate=root.HuayuDatasetTheme.prepare(result.analysis);analysis=result.analysis;theme=candidate;drawn=vectorDrawn=null;syncLayer();
        $("legend").replaceChildren(...theme.legend.map(v=>{const row=el("span"),swatch=el("i");swatch.style.background=v.color;row.append(swatch,document.createTextNode(v.label));return row;}));
        $("analysis-status").textContent=`${analysis.rows} 条：已画 ${analysis.plotted}，缺指标 ${analysis.missing}，有指标但无位置 ${analysis.unlocated}。${analysis.categoryCount>12?"图例列前12类，其他类别灰色。":""}${!analysis.plotted?"请补充坐标／几何；未用范围中心伪造位置。":"专题图已显示，可收起面板浏览。"}`;
        if(analysis.mode==="numeric")table($("analysis-summary"),[{有效数:analysis.count,记录算术和:analysis.sum,最小:analysis.min,最大:analysis.max,平均:analysis.mean}],"当前字段后台统计",["有效数","记录算术和","最小","最大","平均"],item);
        else table($("analysis-summary"),analysis.categories.map(([分类,条数])=>({分类,条数})),"类别统计（最多12类）",["分类","条数"],item);
        $("theme-downloads").replaceChildren();const snapshot=analysis,themeItem={...item,unit:analysis.unit};
        root.HuayuDownloadCenter.createActions($("theme-downloads"),()=>root.HuayuDownloadCenter.fileArtifact({id:`theme-${item.id}-${item.revision}-${q}`,title:`${item.title}专题图`,filename:`${item.title}专题图.svg`,blob:new Blob([root.HuayuDatasetTheme.svg(snapshot,themeItem)],{type:"image/svg+xml"}),source:item.source,sourceTime:item.observedDate}),{downloadLabel:"下载专题图 SVG"});
        $("theme-downloads").append(button("下载专题图 PNG",async()=>{try{const svg=root.HuayuDatasetTheme.svg(snapshot,themeItem),url=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml"}));
          try{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement("canvas");canvas.width=1600;canvas.height=1000;canvas.getContext("2d").drawImage(image,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));if(!blob)throw Error("PNG 生成失败");root.HuayuDownloadCenter.download(blob,`${item.title}专题图.png`);}finally{URL.revokeObjectURL(url);}}
          catch(error){$("analysis-status").textContent=message(error);}}));
      }catch(error){if(epoch===themeEpoch)$("analysis-status").textContent=message(error)+"；已有专题图保留。";}
    }
    function detachVector(){if(!vector)return;for(const event of ["styledata","style.load","idle"])vector.off(event,syncLayer);try{for(const id of layers)if(vector.getLayer(id))vector.removeLayer(id);if(vector.getSource(sourceId))vector.removeSource(sourceId);}catch{}vector=null;vectorDrawn=null;}
    function syncLayer(){
      if(syncing)return;syncing=true;
      try{
        const context=atlas.getDatasetContext();
        if(!theme){if(leaflet){context.map.removeLayer(leaflet);leaflet=null;}detachVector();drawn=null;return;}
        if(context.perspective&&context.vector){
          if(leaflet)context.map.removeLayer(leaflet);
          if(vector!==context.vector){detachVector();vector=context.vector;for(const event of ["styledata","style.load","idle"])vector.on(event,syncLayer);}
          // Other map sources may keep loading; only the style definition is needed to add an independent overlay.
          if(!vector.getSource(sourceId)){if(!vector.getStyle()?.version)return;vector.addSource(sourceId,{type:"geojson",data:theme.geojson});vectorDrawn=theme;}
          else if(vectorDrawn!==theme){vector.getSource(sourceId).setData(theme.geojson);vectorDrawn=theme;}
          if(!vector.getLayer(layers[0]))vector.addLayer({id:layers[0],type:"fill",source:sourceId,filter:["==",["geometry-type"],"Polygon"],paint:{"fill-color":["get","color"],"fill-opacity":.55}});
          if(!vector.getLayer(layers[1]))vector.addLayer({id:layers[1],type:"line",source:sourceId,filter:["!=",["geometry-type"],"Point"],paint:{"line-color":["get","color"],"line-width":2.5}});
          if(!vector.getLayer(layers[2]))vector.addLayer({id:layers[2],type:"circle",source:sourceId,filter:["==",["geometry-type"],"Point"],paint:{"circle-color":["get","color"],"circle-radius":["get","radius"],"circle-opacity":.85,"circle-stroke-color":"#ffffff","circle-stroke-width":1}});
        }else{
          detachVector();if(drawn!==theme){if(leaflet)context.map.removeLayer(leaflet);
            leaflet=root.L.geoJSON(theme.geojson,{style:f=>({color:f.properties.color,fillColor:f.properties.color,fillOpacity:.55,weight:2.5}),
              pointToLayer:(f,latlng)=>root.L.circleMarker(latlng,{color:"#fff",weight:1,fillColor:f.properties.color,fillOpacity:.9,radius:f.properties.radius}),
              onEachFeature:(f,l)=>{const popup=el("div");popup.append(el("strong",f.properties.name),el("p",`${f.properties.value} ${analysis?.unit||""}`));l.bindPopup(popup);}});drawn=theme;}
          if(!context.map.hasLayer(leaflet))leaflet.addTo(context.map);
        }
      }catch(error){$("analysis-status").textContent=`专题图层暂未就绪：${message(error)}。原地图继续可用。`;}
      finally{syncing=false;}
    }
    function hideTheme(){themeReading?.abort();themeEpoch++;theme=null;syncLayer();$("legend").replaceChildren();$("analysis-status").textContent="专题图已隐藏，可重新计算并显示。";}
    function fit(){
      if(!theme?.geojson.features.length)return;
      const layer=root.L.geoJSON(theme.geojson),bounds=layer.getBounds();if(!bounds.isValid())return;const c=atlas.getDatasetContext();
      if(c.perspective&&c.vector)c.vector.fitBounds([[bounds.getWest(),bounds.getSouth()],[bounds.getEast(),bounds.getNorth()]],{padding:60,maxZoom:17});else c.map.fitBounds(bounds,{padding:[35,35],maxZoom:18});
    }
    function template(){
      const metric={population:"population",gdp:"gdp",land_price:"land_price",demand:"trips",schedule:"frequency"}[$("kind").value]||"value";
      const columns=["name","longitude","latitude","osm_type","osm_id",metric];
      if($("kind").value==="poi")columns.push("amenity","shop","category");
      if($("kind").value==="schedule")columns.push("trip_id","route","station","arrival","departure","service_days");
      if($("kind").value==="demand")columns.push("origin_id","destination_id","start_time","end_time");
      root.HuayuDownloadCenter.download(new Blob(["\uFEFF",columns.join(","),"\r\n"],{type:"text/csv;charset=utf-8"}),`${tools.KINDS[$("kind").value]}模板.csv`);
    }
    async function chooseFile(selected,signal) {
      if(signal?.aborted)throw new DOMException("已取消","AbortError");
      cancelParser();file=null;content="";$("preview-result").replaceChildren();if(!selected)return;
      const epoch=parseEpoch;
      const ext=selected.name.split(".").at(-1).toLowerCase();if(!["csv","json","geojson"].includes(ext))throw Error("支持 CSV、JSON、GeoJSON；压缩包和表格请先转换");
      const bytes=await selected.arrayBuffer(),decoded=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);if(signal?.aborted)throw new DOMException("已取消","AbortError");if(epoch!==parseEpoch)return;
      file=selected;content=decoded;format=ext;$("upload-status").textContent=`已选 ${selected.name}，请校验后发布。`;
    }
    $("file").onchange=()=>{const task=chooseFile($("file").files[0]),token=parseEpoch;task.catch(error=>{if(token===parseEpoch)$("upload-status").textContent=message(error);});};
    $("preview").onclick=()=>{if(!busy)parse().catch(error=>$("upload-status").textContent=message(error));};
    $("form").onsubmit=publish;$("edit-cancel").onclick=clearForm;
    $("use-selection").onclick=()=>{const c=atlas.getDatasetContext(),f=atlas.getSelectedFeature();
      if(c.scope){$("scope-kind").value="region";$("scope-label").value=c.scope.label;attachment={target:c.scope.target,geometry:c.scope.geometry};}
      else if(f){$("scope-kind").value="feature";$("scope-label").value=f.label;attachment={target:{type:f.type,id:f.id},...(c.featureScope?.geometry?{geometry:c.featureScope.geometry}:{})};}
      else {$("scope-note").textContent="请先搜索或选中一个原始要素／行政区，再打开数据菜单。";return;}
      $("scope-note").textContent=`已关联 ${attachment.target.type}:${attachment.target.id}${attachment.geometry?" 的原始几何（只有单条汇总记录时用作其范围）":"；点坐标仍以文件为准"}。`;
    };
    for(const id of ["scope-kind","scope-label"])$(id).oninput=()=>{attachment=null;$("scope-note").textContent="已修改范围说明，原关联已解除；可重新关联。";};
    $("refresh").onclick=()=>loadList();$("search").onclick=()=>loadList();$("filter").onchange=()=>loadList();$("query").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();loadList();}};
    $("more").onclick=()=>loadList(true);$("show-theme").onclick=analyze;$("hide-theme").onclick=hideTheme;$("fit-theme").onclick=fit;$("template").onclick=template;
    $("theme-field").onchange=()=>{$("theme-unit").value=$("theme-field").value==="value"||currentData?.primaryColumns?.includes($("theme-field").value)?current?.unit||"":"";};
    $("theme-mode").onchange=()=>{if($("theme-mode").value==="category")$("theme-unit").value="";else $("theme-field").onchange();};
    root.addEventListener("huayu:account-changed",()=>{accountEpoch++;detailEpoch++;detailReading?.abort();themeReading?.abort();themeEpoch++;clearForm();renderList();});
    atlas.map.on("baselayerchange moveend",syncLayer);
    root.addEventListener("pagehide",()=>{reading?.abort();detailReading?.abort();detailEpoch++;cancelParser();hideTheme();});
    root.HuayuSharedDatasets=Object.freeze({syncLayer,
      async openFromAgent(id,signal) {
        if(signal?.aborted)throw new DOMException("已取消","AbortError");
        atlas.openView("datasets",{preservePerspective:true});
        const opened=await open(id,signal);
        if(signal?.aborted)throw new DOMException("已取消","AbortError");
        if(!opened)throw Error("数据包未能完整读取，请在数据页面重试");
      },
      async prepareFromAgent(selected,meta,signal,preview=true) {
        if(!user())throw Error("请先登录");
        if(editing||file||$("title").value.trim())throw Error("数据页面已有草稿，请先发布或处理原草稿");
        if(signal?.aborted)throw new DOMException("已取消","AbortError");
        const account=accountEpoch;
        atlas.openView("datasets",{preservePerspective:true});$("upload-section").open=true;
        $("title").value=meta.title||selected.name;$("kind").value=meta.kind||"other";$("scope-label").value=meta.scopeLabel||"";
        $("source").value=meta.source||"";$("unit").value=meta.unit||"";$("shared").checked=false;
        if(["feature","region","large"].includes(meta.scopeKind)){$("scope-kind").value=meta.scopeKind;attachment=null;$("scope-note").textContent="范围仅为本数据包的说明，未关联地图选中物体。";}
        for(const [key,id] of [["description","description"],["license","license"],["sourceUrl","source-url"]])if(typeof meta[key]==="string")$(id).value=meta[key];
        const transfer=new DataTransfer();transfer.items.add(selected);$("file").files=transfer.files;
        await chooseFile(selected,signal);
        if(signal?.aborted||account!==accountEpoch)throw new DOMException("已取消","AbortError");
        if(!preview)return null;
        const cancel=()=>cancelParser();signal?.addEventListener("abort",cancel,{once:true});
        try{return await parse();}finally{signal?.removeEventListener("abort",cancel);}
      },
      setActive(value){const next=Boolean(value);if(active===next)return;active=next;
      if(active){auth();if(!loaded)loadList();}else{reading?.abort();detailReading?.abort();themeReading?.abort();readEpoch++;detailEpoch++;themeEpoch++;editEpoch++;cancelParser();}}});
    clearForm();root.HuayuSharedDatasets.setActive(atlas.getCurrentView()==="datasets"&&!document.getElementById("tool-panel").classList.contains("is-hidden"));
    if(new URLSearchParams(location.search).get("panel")==="datasets")atlas.openView("datasets",{preservePerspective:true});
  }
  if(root.HuayuAtlas)start();else root.addEventListener("huayu:map-ready",start,{once:true});
})(window);
