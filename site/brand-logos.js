(function start(){
 "use strict";
 if(!window.HuayuAtlas){addEventListener("huayu:map-ready",start,{once:true});return;}
 if(window.HuayuBrandLogos)return;
 const atlas=HuayuAtlas,core=HuayuBrandLogoCore,$=id=>document.getElementById("logo-"+id),sourceId="huayu-brand-logo-points",layerId=sourceId+"-symbols";
 let entries=[],match=core.matcher([]),epoch=0,read=null,timer=null,gl=null,drawn=null,places=null,lastRead=0,enabled=true,editing=null,prepared=null,preparing=0,busy=false;
 let mutationEpoch=0,drawEpoch=0,registrySignature="",placeSignature="",filters=new Map(),registryRequest=null,registryReadAt=0;
 let requestBounds=null,requestSignature="",retryBounds=null,retrySignature="",retryTimer=null,retryCount=0,nextAttemptAt=0,forcePlaces=false,placeCache=[];
 const placeCacheKey="huayu-brand-logo-windows-v1";
 const covers=(outer,inner)=>outer&&inner[0]>=outer[0]&&inner[1]>=outer[1]&&inner[2]<=outer[2]&&inner[3]<=outer[3];
 function validResult(p){return p&&Array.isArray(p.items)&&p.items.length<=3000&&Number.isFinite(p.fetchedAt)&&p.fetchedAt>0&&p.fetchedAt<=Date.now()+60000
   &&new Set(p.items.map(e=>e.type+"/"+e.id)).size===p.items.length
   &&p.items.every(e=>["node","way","relation"].includes(e.type)&&Number.isSafeInteger(e.id)&&e.id>0&&Number.isFinite(e.lat)&&Math.abs(e.lat)<=85
     &&Number.isFinite(e.lon)&&Math.abs(e.lon)<=180&&typeof e.name==="string"&&typeof e.label==="string"&&e.tags&&entries.some(v=>v.key===e.logoKey));}
 try{const raw=sessionStorage.getItem(placeCacheKey);if(raw&&raw.length<=2*1024*1024){const saved=JSON.parse(raw);if(Array.isArray(saved)&&saved.length<=8)placeCache=saved;}}catch{}
 function cachedPlaces(bounds,sig){return placeCache.find(p=>p.signature===sig&&Array.isArray(p.bounds)&&p.bounds.length===4&&p.bounds.every(Number.isFinite)
   &&covers(p.bounds,bounds)&&Date.now()-p.fetchedAt<3*3600000&&validResult(p));}
 function rememberPlaces(p,sig){
   placeCache=placeCache.filter(v=>v.signature===sig&&validResult(v)&&Date.now()-v.fetchedAt<3*3600000&&JSON.stringify(v.bounds)!==JSON.stringify(p.bounds));
   placeCache.unshift({...p,signature:sig});placeCache=placeCache.slice(0,8);
   while(placeCache.length&&JSON.stringify(placeCache).length>2*1024*1024)placeCache.pop();
   try{sessionStorage.setItem(placeCacheKey,JSON.stringify(placeCache));}catch{}
 }
 function cancelPlaces(){read?.abort();epoch++;requestBounds=null;requestSignature="";clearTimeout(retryTimer);retryTimer=null;}
 function retryPlaces(ms){clearTimeout(retryTimer);nextAttemptAt=Date.now()+ms;retryTimer=setTimeout(()=>{retryTimer=null;schedule();},ms);}
 const assets=new Map(),loading=new Map(),failed=new Map(),leaflet=L.layerGroup(),rows=new Map();
 const user=()=>window.HuayuPersonalData?.getCurrentUser();
 const txt=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;};
 const button=(label,fn)=>{const n=txt("button",label,"text-button");n.type="button";n.onclick=fn;return n;};
 const errors={logo_already_exists:"这个名称已有共享 logo，请由原作者、获批品牌管理者或管理员维护。",logo_forbidden:"只能维护自己上传的标识或获批品牌的 logo；被禁止管理的品牌不可操作。",logo_service_unavailable:"共享标识服务暂不可用，请稍后重试。",personal_data_service_not_configured:"账号与共享标识服务尚未配置。",logo_places_busy:"地点服务正在处理其他区域，稍后自动重试。",logo_places_cancelled:"地点查询已取消。",logo_places_too_large:"当前区域标识过多，请放大后查看。",logo_revision_conflict:"内容已被更新，请刷新后重试。",logo_png_invalid:"图片无效，请重新选择后预览。",logo_source_invalid:"来源链接须为 HTTPS。",logo_rights_required:"请确认你有权公开使用这个标识。",logo_places_incomplete:"上游数据未完整返回，保留原标识后重试。",logo_places_unavailable:"地点服务暂不可用，保留现有结果。",logo_bounds_invalid:"当前近景范围过大，请放大后查看 logo。",logo_catalog_too_large:"标识目录超过本次读取能力，保留原显示。",authentication_required:"请先登录。"};
 const message=e=>errors[e.message]||e.message||"操作失败，请重试";
 async function api(url,options={}){const r=await fetch(url,{cache:"no-store",...options,headers:{"Content-Type":"application/json",...options.headers}}),data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||"读取失败"),{status:r.status,retryAfterMs:data.retryAfterMs,retryable:data.retryable});return data;}
 function status(s){$("status").textContent=s;}
 function getEntry(kind,name){return entries.find(e=>e.kind===kind&&core.normalize(e.name)===core.normalize(name));}
 function image(entry,cls="brand-logo-thumbnail"){
   const img=document.createElement("img");img.src=entry.imageUrl;img.alt=entry.name+" logo";img.className=cls;img.loading="lazy";img.addEventListener("error",()=>img.hidden=true,{once:true});return img;
 }
 function drawLibrary(){
   const q=core.normalize($("query").value),found=entries.filter(e=>core.normalize([e.name,...e.aliases,e.author?.displayName||"",e.source].join(" ")).includes(q));
   $("list").replaceChildren();
   for(const e of found.slice(0,80)){
     const card=txt("article","","brand-card logo-library-card");card.append(image(e),txt("strong",e.name),txt("small",({brand:"品牌",operator:"运营者",transit:"地铁／轨道系统"})[e.kind]+" · "+(e.builtin?"内置来源":e.author?.displayName||e.author?.username)));
     card.append(txt("small",e.aliases.length?"明确别名："+e.aliases.join("；"):"按完整名称匹配"),txt("small",e.source));
     if(e.sourceUrl){const a=txt("a","来源");a.href=e.sourceUrl;a.target="_blank";a.rel="noopener noreferrer";card.append(a);}
     const blocked=window.HuayuBrandManagement?.isBanned(e),managed=window.HuayuBrandManagement?.canManage(e);
     if(!e.builtin&&!blocked&&(user()?.id===e.author?.id||user()?.role==="admin"||managed)){
       card.append(button("替换 / 编辑",()=>edit(e)),button("删除",()=>remove(e)));
     }else if(e.builtin&&user()&&!blocked)card.append(button("上传新版",()=>edit(e)));
     $("list").append(card);
   }
   $("count").textContent=found.length+" 个标识"+(found.length>80?"，请输入名称细化筛选":"");
   $("submit").disabled=busy||!user()||Boolean(window.HuayuBrandManagement?.isBanned({kind:$("kind").value,key:$("kind").value+":"+core.normalize($("name").value)}));$("login").hidden=Boolean(user());
 }
 function reset(){
   preparing++;editing=null;prepared=null;$("form").reset();$("name").disabled=false;$("kind").disabled=false;$("preview").replaceChildren();$("submit").textContent="公开共享 logo";
 }
 function edit(e){
   if(busy)return;reset();editing=e;$("section").open=true;$("kind").value=e.kind;$("name").value=e.name;$("aliases").value=e.aliases.join("；");
   $("source").value=e.source;$("source-url").value=e.sourceUrl||"";$("name").disabled=true;$("kind").disabled=true;$("preview").append(image(e));
   $("submit").textContent=e.builtin?"发布新版 logo":"保存修改";$("form").scrollIntoView({block:"nearest"});
 }
 async function remove(e){
   if(busy||!confirm("删除“"+e.name+"”的共享 logo？地图会恢复内置 logo 或原符号。"))return;
   const token=++mutationEpoch,account=user()?.id;busy=true;drawLibrary();
   try{await api("/api/brand-logos/"+e.id,{method:"DELETE",body:JSON.stringify({revision:e.revision})});if(token!==mutationEpoch||account!==user()?.id)return;if(editing?.id===e.id)reset();await refresh(true);status("已删除，共享地图标识已更新。");}
   catch(e){if(token===mutationEpoch)status(message(e));}finally{if(token===mutationEpoch){busy=false;drawLibrary();}}
 }
 async function prepare(file){
   const token=++preparing,account=user()?.id;prepared=null;$("preview").replaceChildren();if(!file)return;
   if(!/\.(png|jpe?g|webp|svg)$/iu.test(file.name)||file.size>8*1024*1024)throw Error("请选择不超过 8 MiB 的 PNG、JPG、WebP 或 SVG。");
   if(/\.svg$/iu.test(file.name)){
     const doc=new DOMParser().parseFromString(await file.text(),"image/svg+xml");
     if(doc.querySelector("parsererror,script,style,foreignObject,iframe,audio,video,animate,set")||doc.documentElement.localName!=="svg")throw Error("SVG 含不支持的内容。");
     for(const n of doc.querySelectorAll("*"))for(const a of n.attributes)if(/^on/iu.test(a.name)||/href$/iu.test(a.name)&&!a.value.startsWith("#")||/url\s*\(\s*[^#]/iu.test(a.value)||/@import/iu.test(a.value))throw Error("SVG 不能包含脚本、外部图片或外部字体。");
     if(/@import|url\s*\(\s*[^#]/iu.test(doc.documentElement.textContent))throw Error("SVG 不能引用外部资源。");
   }
   const url=URL.createObjectURL(file),img=new Image();
   try{
     await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error("图片无法解码"));img.src=url;});
     if(img.naturalWidth>8192||img.naturalHeight>8192||img.naturalWidth*img.naturalHeight>32e6)throw Error("图片像素过大，请先缩小。");
     const c=document.createElement("canvas");c.width=c.height=128;const ctx=c.getContext("2d"),s=120/Math.max(img.naturalWidth,img.naturalHeight);
     ctx.drawImage(img,(128-img.naturalWidth*s)/2,(128-img.naturalHeight*s)/2,img.naturalWidth*s,img.naturalHeight*s);
     if(!ctx.getImageData(0,0,128,128).data.some((v,i)=>i%4===3&&v))throw Error("图片完全透明，请重新选择。");
     const data=c.toDataURL("image/png");if(data.length>180000)throw Error("标识转换后仍过大，请简化图片。");
     if(token!==preparing||account!==user()?.id)return;
     prepared=data;const p=document.createElement("img");p.src=data;p.alt="上传预览";p.className="logo-upload-preview";$("preview").replaceChildren(p);status("预览已准备，确认名称、来源及公开使用权后发布。");
   }finally{URL.revokeObjectURL(url);}
 }
 async function submit(event){
   event.preventDefault();if(busy||!user())return;const account=user().id,token=++mutationEpoch,draft=preparing;
   try{
     if(!prepared&&(!editing||editing.builtin))throw Error("请先选择 logo 图片。");
     const m={kind:$("kind").value,name:$("name").value,aliases:$("aliases").value.split(/[；;\n]/u).map(s=>s.trim()).filter(Boolean),source:$("source").value,sourceUrl:$("source-url").value,rightsConfirmed:$("rights").checked};
     core.metadata(m);busy=true;drawLibrary();const body=editing&&!editing.builtin?{revision:editing.revision,aliases:m.aliases,source:m.source,sourceUrl:m.sourceUrl,rightsConfirmed:m.rightsConfirmed}:m;
     if(prepared)body.image=prepared;
     await api(editing&&!editing.builtin?"/api/brand-logos/"+editing.id:"/api/brand-logos",{method:editing&&!editing.builtin?"PATCH":"POST",body:JSON.stringify(body)});
     if(account!==user()?.id||token!==mutationEpoch)return;if(draft===preparing)reset();await refresh(true);if(token!==mutationEpoch)return;status("已共享。地图将按当前范围更新，其他用户在下一次自动检查或手动刷新后读取。");
   }catch(e){if(account===user()?.id&&token===mutationEpoch)status(message(e));}finally{if(token===mutationEpoch){busy=false;drawLibrary();}}
 }
 function refresh(force=false){
   if(registryRequest)return force?registryRequest.then(()=>refresh(true)):registryRequest;if(!force&&Date.now()-registryReadAt<120000)return Promise.resolve();
   registryRequest=(async()=>{
     try{
       const next=await api("/api/brand-logos");
       if(!Array.isArray(next.items))throw Error("标识目录格式无效");
       const signature=JSON.stringify(next.items.map(e=>[e.key,e.imageUrl,e.aliases,e.categories]));
       const previousEntries=new Map(entries.map(e=>[e.key,e]));
       registryReadAt=Date.now();entries=next.items;
       if(signature!==registrySignature){
         registrySignature=signature;entries=next.items;match=core.matcher(entries);
         // A newly uploaded system must not erase unrelated ready shop logos.
         // Retain only identities whose matching is unchanged or revalidated; keep the old window signature until a complete new query succeeds.
         const identity=e=>JSON.stringify([e.kind,e.name,e.aliases,e.categories]);
         const unchanged=new Set(entries.filter(e=>previousEntries.has(e.key)&&identity(e)===identity(previousEntries.get(e.key))).map(e=>e.key));
         if(places)places={...places,items:places.items.filter(p=>unchanged.has(p.logoKey)||match.match(p.tags)?.key===p.logoKey)};
         placeSignature="";cancelPlaces();retryBounds=null;retrySignature="";retryCount=0;nextAttemptAt=0;lastRead=0;drawn=null;
         const activeUrls=new Set(entries.map(e=>e.imageUrl));for(const url of assets.keys())if(!activeUrls.has(url))assets.delete(url);
         dispatchEvent(new CustomEvent("huayu:brand-logos-changed"));atlas.refreshBrandLogoTransit?.();schedule();
       }
       drawLibrary();if(!next.sharedAvailable)status("共享标识服务尚未配置或暂不可用，继续显示四个内置 logo。");
     }catch(e){registryReadAt=Date.now()-90000;status("logo 目录暂不可用，已有标识保留："+message(e));}
   })().finally(()=>registryRequest=null);return registryRequest;
 }
 async function loadImage(e){
   if(assets.has(e.imageUrl))return assets.get(e.imageUrl);if(loading.has(e.imageUrl))return loading.get(e.imageUrl);
   if(Date.now()-(failed.get(e.imageUrl)||0)<30000)return null;
   const task=(async()=>{try{
     const r=await fetch(e.imageUrl,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("image");const bmp=await createImageBitmap(await r.blob());
     const c=document.createElement("canvas");c.width=c.height=72;const ctx=c.getContext("2d");const scale=68/Math.max(bmp.width,bmp.height);ctx.drawImage(bmp,(72-bmp.width*scale)/2,(72-bmp.height*scale)/2,bmp.width*scale,bmp.height*scale);bmp.close();
     const data=ctx.getImageData(0,0,72,72);assets.set(e.imageUrl,data);return data;
   }catch{failed.set(e.imageUrl,Date.now());return null;}finally{loading.delete(e.imageUrl);}})();loading.set(e.imageUrl,task);return task;
 }
 function imageId(map,e){
   const data=assets.get(e.imageUrl);if(!data)return null;const id="huayu-logo-"+e.id+"-"+String(e.imageUrl).split("=").at(-1).replace(/[^a-zA-Z0-9_-]/gu,"").slice(-20);
   if(!map.hasImage(id))map.addImage(id,data);return id;
 }
 async function preload(values){let changed=false;await Promise.all(values.map(async e=>{const had=assets.has(e.imageUrl);if(await loadImage(e)&&!had)changed=true;}));if(changed){drawn=null;atlas.refreshBrandLogoTransit?.();}}
 function restoreFilters(){
   if(!gl)return;for(const [id,s] of filters)try{if(gl.getLayer(id)&&JSON.stringify(gl.getFilter(id))===JSON.stringify(s.applied))gl.setFilter(id,s.base);}catch{}filters.clear();
 }
 function suppress(accepted){
   if(!gl)return;const layers=gl.getLayersOrder().map(id=>gl.getLayer(id)).filter(layer=>layer.type==="symbol"&&(layer.sourceLayer==="poi"||layer.source==="ogf-atlas-huayu-supplemental-pois")),targetIds=JSON.stringify(layers.map(layer=>layer.id));const key=JSON.stringify(accepted.map(p=>[p.type,p.id,p.name,p.lat,p.lon]));if(gl.__huayuLogoNames===key&&gl.__huayuLogoTargets===targetIds&&[...filters].every(([id,s])=>JSON.stringify(gl.getFilter(id))===JSON.stringify(s.applied)))return;restoreFilters();gl.__huayuLogoNames=key;gl.__huayuLogoTargets=targetIds;if(!accepted.length)return;
   for(const layer of layers){
     const id=layer.id;
     const base=gl.getFilter(id),clause=core.suppressionExpression(accepted),applied=base?["all",core.filterExpression(base),clause]:clause;
     try{gl.setFilter(id,applied);filters.set(id,{base,applied});}catch{}
   }
 }
 function detach(){
   if(!gl)return;restoreFilters();
   try{gl.off("moveend",schedule);gl.off("style.load",styleLoaded);gl.off("styledata",schedule);for(const id of [layerId])if(gl.getLayer(id))gl.removeLayer(id);if(gl.getSource(sourceId))gl.removeSource(sourceId);
     for(const id of gl.listImages().filter(id=>id.startsWith("huayu-logo-")))gl.removeImage(id);delete gl.__huayuLogoNames;}catch{}gl=null;drawn=null;
 }
 function styleLoaded(){drawn=null;filters.clear();if(gl)delete gl.__huayuLogoNames;schedule();}
 function pick(point){
   if(!enabled||!atlas.canSelectBrandLogo?.()||!gl?.getLayer(layerId))return false;
   const eventPoint=gl.project([point.lng,point.lat]);let p;
   try{const hit=gl.queryRenderedFeatures(eventPoint,{layers:[layerId]})[0];p=rows.get(hit?.properties?.identity);}
   catch{
     // The engine can briefly retain an old feature index while a tile changes.
     // Only accept a ready logo within its own small screen hitbox.
     let distance=14;
     for(const row of rows.values()){const at=gl.project([row.lon,row.lat]),d=Math.hypot(at.x-eventPoint.x,at.y-eventPoint.y);if(d<distance){distance=d;p=row;}}
   }
   if(!p)return false;
   atlas.selectBrandLogoPlace(p);return true;
 }
 function clearMap(){drawEpoch++;if(gl){suppress([]);if(gl.getSource(sourceId))gl.getSource(sourceId).setData({type:"FeatureCollection",features:[]});}leaflet.clearLayers();drawn=null;rows.clear();}
 async function draw(){
   const token=++drawEpoch;
   if(!enabled||document.hidden){clearMap();return;}const context=atlas.getBrandLogoContext();if(context.vector!==gl){detach();gl=context.vector;if(gl){gl.on("moveend",schedule);gl.on("style.load",styleLoaded);gl.on("styledata",schedule);}}
   if(context.satellite&&!context.labels||context.zoom<14||!places){clearMap();return;}
   const byKey=new Map(entries.map(e=>[e.key,e])),candidates=places.items.filter(p=>!(p.kind==="transit"&&context.transit));
   await preload([...new Set(candidates.map(p=>byKey.get(p.logoKey)).filter(Boolean))]);if(token!==drawEpoch||!enabled||document.hidden||context.vector!==atlas.getBrandLogoContext().vector)return;
   const ready=candidates.filter(p=>assets.has(byKey.get(p.logoKey)?.imageUrl)).map(p=>({...p,label:core.placeLabel(p.tags,byKey.get(p.logoKey))}));rows.clear();ready.forEach(p=>rows.set(p.type+"/"+p.id,p));
   if(gl){
     if(!gl.style||!gl.getLayersOrder().length)return;
     const features=ready.map(p=>({type:"Feature",id:p.type+"/"+p.id,geometry:{type:"Point",coordinates:[p.lon,p.lat]},properties:{identity:p.type+"/"+p.id,name:p.label,icon:imageId(gl,byKey.get(p.logoKey))}})),signature=JSON.stringify(features);
     if(!gl.getSource(sourceId))gl.addSource(sourceId,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
     if(!gl.getLayer(layerId))gl.addLayer({id:layerId,type:"symbol",source:sourceId,minzoom:14,layout:{"icon-image":["get","icon"],"icon-size":.4,"icon-allow-overlap":false,"text-field":["get","name"],"text-size":11,"text-font":["Noto Sans Regular"],"text-offset":[0,1.6],"text-anchor":"top","text-optional":true,"icon-pitch-alignment":"viewport","text-pitch-alignment":"viewport"},paint:{"text-color":context.night?"#f4f4f4":"#303f46","text-halo-color":context.night?"#263238":"#ffffff","text-halo-width":1.5}});
     if(drawn!==signature){gl.getSource(sourceId).setData({type:"FeatureCollection",features});drawn=signature;}
     suppress(ready);leaflet.clearLayers();
   }else{
     const signature=JSON.stringify(ready);if(drawn===signature)return;leaflet.clearLayers();
     for(const p of ready){const node=document.createElement("span");node.append(image(byKey.get(p.logoKey)),txt("span",p.label));
       L.marker([p.lat,p.lon],{icon:L.divIcon({html:node,className:"brand-logo-map-marker",iconSize:[32,32],iconAnchor:[16,16]})}).on("click",()=>atlas.handleBrandLogoClick(p)).addTo(leaflet);}
     if(!atlas.map.hasLayer(leaflet))leaflet.addTo(atlas.map);drawn=signature;
   }
 }
 async function update(){
   if(!enabled||document.hidden){cancelPlaces();clearMap();return;}await refresh();
   if(!enabled||document.hidden)return;
   const c=atlas.getBrandLogoContext();if(c.zoom<14||c.satellite&&!c.labels){cancelPlaces();clearMap();return;}
   const b=c.bounds,bounds=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],sig=registrySignature;
   if(!covers(places?.bounds,bounds)||placeSignature!==sig){
     const saved=cachedPlaces(bounds,sig);
     if(saved){places=saved;placeSignature=sig;lastRead=saved.fetchedAt;await draw();
       $("map-status").textContent="已恢复完整地点缓存："+saved.items.length+" 个地点。来源 "+(saved.dbTimestamp||new Date(saved.fetchedAt).toISOString())+"；正在按原始时间检查更新。";}
   }
   // Style and camera events for the same buffered window must not cancel its live request.
   if(requestSignature===sig&&covers(requestBounds,bounds)&&!forcePlaces){await draw();return;}
   if(!forcePlaces&&covers(places?.bounds,bounds)&&placeSignature===sig&&!places.stale&&Date.now()-lastRead<120000){await draw();return;}
   if(!forcePlaces&&retrySignature===sig&&covers(retryBounds,bounds)&&Date.now()<nextAttemptAt){await draw();return;}
   const sameRetry=retrySignature===sig&&covers(retryBounds,bounds),force=forcePlaces;
   cancelPlaces();read=new AbortController();const token=epoch,dx=(bounds[2]-bounds[0])*.18,dy=(bounds[3]-bounds[1])*.18;
   const expanded=[Math.max(-180,bounds[0]-dx),Math.max(-85,bounds[1]-dy),Math.min(180,bounds[2]+dx),Math.min(85,bounds[3]+dy)];
   if(!sameRetry||forcePlaces)retryCount=0;forcePlaces=false;requestBounds=expanded;requestSignature=sig;retryBounds=expanded;retrySignature=sig;
   try{
     core.query(entries,expanded);
     $("map-status").textContent="正在读取近景 logo 地点"+(retryCount?"（自动重试 "+retryCount+"/2）":"")+"，保留已有标识…";
     const result=await api("/api/brand-logo-places?bounds="+expanded.map(n=>n.toFixed(6)).join(",")+(force?"&refresh=1":""),{signal:AbortSignal.any([read.signal,AbortSignal.timeout(90000)])});
     if(token!==epoch||document.hidden||!enabled)return;if(!validResult(result))throw Error("logo_places_incomplete");
     places={...result,bounds:expanded};lastRead=result.fetchedAt;placeSignature=sig;rememberPlaces(places,sig);atlas.refreshBrandLogoTransit?.();await draw();
     $("map-status").textContent=(result.stale?"上游暂不可用，保留完整缓存：":"近景 logo 已更新：")+result.items.length+" 个地点。来源 "+(result.dbTimestamp||new Date(result.fetchedAt).toISOString())+"；重叠标识按比例尺避让，放大可查看。";
     if(result.stale){retryCount=2;retryPlaces(Math.max(30000,Math.min(120000,result.retryAfterMs||30000)));}else{retryCount=0;nextAttemptAt=0;}
   }catch(e){
     if(token!==epoch||document.hidden||!enabled)return;
     const transient=e.retryable!==false&&(!e.status||[408,425,429,500,502,503,504].includes(e.status));
     if(transient&&!["logo_bounds_invalid","logo_catalog_too_large","logo_places_incomplete"].includes(e.message)&&retryCount<2){
       retryCount++;retryPlaces(Math.max([1500,6000][retryCount-1],Math.min(120000,e.retryAfterMs||0)));
       $("map-status").textContent=message(e)+" 将自动重试（"+retryCount+"/2）；原有符号与已加载 logo 保留。";
     }else{nextAttemptAt=Date.now()+120000;$("map-status").textContent=message(e)+" 原有符号与已加载 logo 保留，可点“刷新 logo”重试。";}
   }finally{if(token===epoch){requestBounds=null;requestSignature="";}}
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>update().catch(e=>{$("map-status").textContent=message(e);}),450);}
 addEventListener("huayu:brand-management-changed",drawLibrary);
 $("name").addEventListener("input",drawLibrary);$("kind").addEventListener("change",drawLibrary);
 $("file").onchange=()=>prepare($("file").files[0]).catch(e=>status(message(e)));$("form").onsubmit=submit;
 $("cancel").onclick=reset;$("refresh").onclick=async()=>{cancelPlaces();forcePlaces=true;nextAttemptAt=0;retryCount=0;await refresh(true);schedule();};$("query").oninput=drawLibrary;
 $("enabled").onchange=()=>{enabled=$("enabled").checked;try{localStorage.setItem("huayu-brand-logos-enabled",String(enabled));}catch{}atlas.refreshBrandLogoTransit?.();schedule();};
 try{enabled=localStorage.getItem("huayu-brand-logos-enabled")!=="false";}catch{}$("enabled").checked=enabled;
 atlas.map.on("moveend baselayerchange",schedule);addEventListener("huayu:account-changed",()=>{mutationEpoch++;reset();busy=false;drawLibrary();});
 document.addEventListener("visibilitychange",()=>{if(document.hidden){cancelPlaces();clearTimeout(timer);}else schedule();});
 const interval=setInterval(()=>{if(!document.hidden)schedule();},120000);
 addEventListener("pagehide",()=>{cancelPlaces();clearTimeout(timer);clearInterval(interval);detach();leaflet.clearLayers();});
 function transitEntry(stop,routes){
   if(!enabled)return null;let e=match.transit(stop,routes);
   if(!e){const ids=new Set([stop.sourceId,stop.id,...stop.displaySourceIds||[]].filter(Boolean).map(id=>String(id).replace(/:/gu,"/").replace(/^([nwr])(\d+)$/u,(_,t,n)=>({n:"node",w:"way",r:"relation"})[t]+"/"+n)));
     const hits=new Set((places?.items||[]).filter(p=>p.kind==="transit"&&ids.has(p.type+"/"+p.id)).map(p=>p.logoKey));if(hits.size===1)e=entries.find(e=>e.key===[...hits][0]);}
   return e||null;
 }
 window.HuayuBrandLogos=Object.freeze({sync:schedule,refresh,pick,entries:()=>entries,image,getEntry,
   transitEntry:(stop,routes)=>{const e=transitEntry(stop,routes);if(e&&!assets.has(e.imageUrl)){preload([e]).then(schedule);return null;}return e;},
   transitIcon:(map,stop,routes)=>{const e=transitEntry(stop,routes);if(!e)return null;const id=imageId(map,e);if(!id)preload([e]).then(schedule);return id;},
   prepareForBrand:(name,kind="brand")=>{
     if(busy)return;const e=getEntry(kind,name),manager=window.HuayuBrandManagement;
     if(e&&!manager?.isBanned(e)&&(e.builtin&&user()||user()?.id===e.author?.id||user()?.role==="admin"||manager?.canManage(e))){edit(e);return;}
     reset();$("section").open=true;$("name").value=name;$("kind").value=kind;drawLibrary();$("form").scrollIntoView({block:"nearest"});
   }
 });
 refresh().then(schedule);
})();