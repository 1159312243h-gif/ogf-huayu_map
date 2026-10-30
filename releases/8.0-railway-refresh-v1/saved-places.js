(function (root) {
  "use strict";
  const tags = [
    ["home", "家庭住址"], ["hometown", "故乡"], ["kindergarten", "幼儿园"],
    ["primary", "小学"], ["middle", "初中"], ["high", "高中"],
    ["college", "大专"], ["university", "大学"], ["graduate", "研究生院校"],
    ["work", "工作单位"], ["former-home", "曾经住过"], ["other", "其他经历"],
  ];
  const tagKey = value => String(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
  function cleanCustomTag(value) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
    const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    return text && Array.from(text).length <= 24 ? text : null;
  }
  function normalizePlaceTags(place, maximum = 8) {
    const placeTags = [...new Set(Array.isArray(place.placeTags) ? place.placeTags : [])]
      .filter(value => tags.some(tag => tag[0] === value));
    const customTags = [], seen = new Set();
    for (const value of Array.isArray(place.customTags) ? place.customTags.slice(0, 100) : []) {
      const text = cleanCustomTag(value);
      if (!text) continue;
      const key = tagKey(text), preset = tags.find(([id, title]) => tagKey(id) === key || tagKey(title) === key);
      if (preset) {if (!placeTags.includes(preset[0])) placeTags.push(preset[0]);continue;}
      if (seen.has(key) || customTags.length >= maximum) continue;
      seen.add(key);customTags.push(text);
    }
    return {...(placeTags.length ? {placeTags} : {}), ...(customTags.length ? {customTags} : {})};
  }
  function customLabels(items) {
    const labels = new Map();
    for (const place of Object.values(normalize(items))) {
      for (const label of place.customTags || []) if (!labels.has(tagKey(label))) labels.set(tagKey(label), label);
    }
    return [...labels.values()].sort((a,b) => a.localeCompare(b, "zh-CN"));
  }
  function normalize(items) {
    let hasDefault = false;
    const result = Object.create(null);
    for (const [key, place] of Object.entries(items && typeof items === "object" && !Array.isArray(items) ? items : {}).slice(0, 200)) {
      const lat = Number(place?.lat), lng = Number(place?.lng);
      if (!key || key.length > 100 || !place || place.lat == null || place.lng == null
        || place.lat === "" || place.lng === "" || !Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 85 || Math.abs(lng) > 180) continue;
      const item = {lat, lng, zoom: Number.isFinite(Number(place.zoom)) ? Math.min(20, Math.max(1, Number(place.zoom))) : 13,
        label: String(place.label || "收藏地点").slice(0, 200)};
      Object.assign(item, normalizePlaceTags(place));
      if (place.isDefault === true && !hasDefault) {item.isDefault = true; hasDefault = true;}
      result[key] = item;
    }
    return result;
  }
  function describe(place) {
    return [place.isDefault ? "默认位置" : "", ...(place.placeTags || []).map(id => tags.find(tag => tag[0] === id)?.[1]), ...(place.customTags || [])]
      .filter(Boolean).join(" · ");
  }
  function matches(items, query = "", tag = "all") {
    const text = String(query).normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
    return Object.entries(normalize(items)).filter(([, place]) =>
      (tag === "all" || tag === "default" && place.isDefault || place.placeTags?.includes(tag)
        || tag.startsWith("custom:") && place.customTags?.some(label => tagKey(label) === tag.slice(7)))
      && (!text || `${place.label} ${describe(place)} ${place.lat},${place.lng}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(text)))
      .sort((a, b) => Number(Boolean(b[1].isDefault)) - Number(Boolean(a[1].isDefault)));
  }

  function start() {
    const atlas = root.HuayuAtlas;
    if (!atlas || !root.document) return;
    const byId = id => document.getElementById(id);
    const list = byId("saved-list"), form = byId("saved-place-form"), query = byId("saved-place-filter"),
      filter = byId("saved-place-tag-filter"), status = byId("saved-place-status"),
      name = byId("saved-place-name"), lat = byId("saved-place-lat"), lng = byId("saved-place-lng"),
      defaultBox = byId("saved-place-default"), labels = byId("saved-place-tags"), customInput = byId("saved-place-custom-tags");
    let editingKey = null, editingZoom = 15;
    const authenticated = () => Boolean(root.HuayuPersonalData?.isAuthenticated());
    const option = (value, label) => {const item=document.createElement("option");item.value=value;item.textContent=label;return item;};
    filter.append(option("all", "全部标签"), option("default", "默认位置"), ...tags.map(tag => option(...tag)));
    tags.forEach(([id, title]) => {
      const label=document.createElement("label"), input=document.createElement("input");
      input.type="checkbox";input.value=id;input.name="placeTags";label.append(input,document.createTextNode(title));labels.append(label);
    });
    function message(text, error = false) {status.textContent=text;status.classList.toggle("is-error",error);}
    function button(text, action, className = "text-button") {
      const item=document.createElement("button");item.type="button";item.className=className;
      item.textContent=text;item.addEventListener("click",action);return item;
    }
    function edit(key = null, place = atlas.getSelectedPlace()) {
      if (!authenticated()) {atlas.openView("account");atlas.showToast("请先登录后设置个人地点");return;}
      editingKey=key;editingZoom=place.zoom || 15;
      name.value=place.label || "";lat.value=place.lat;lng.value=place.lng;defaultBox.checked=Boolean(place.isDefault);
      labels.querySelectorAll("input").forEach(input => {input.checked=Boolean(place.placeTags?.includes(input.value));});
      customInput.value=(place.customTags || []).join("，");
      byId("saved-place-editor-title").textContent=key ? "编辑收藏地点" : "添加个人地点";
      form.hidden=false;message("可修改名称与坐标，标签按需选择。");name.focus();
    }
    function render() {
      byId("saved-place-add").hidden=!authenticated();
      byId("saved-place-login-note").hidden=authenticated();
      if (!authenticated()) {form.hidden=true;editingKey=null;}
      const favorites = atlas.getFavorites(), currentFilter = filter.value || "all", custom = customLabels(favorites);
      filter.replaceChildren(option("all", "全部标签"), option("default", "默认位置"), ...tags.map(tag => option(...tag)),
        ...custom.map(label => option(`custom:${tagKey(label)}`, `自定义：${label}`)));
      if ([...filter.options].some(item => item.value === currentFilter)) filter.value=currentFilter;
      byId("saved-place-custom-suggestions").replaceChildren(...custom.map(label => option(label,label)));
      list.replaceChildren();
      const items=matches(favorites,query.value,filter.value);
      const total=Object.keys(favorites).length;
      byId("favorites-status").textContent=`共 ${total} 个收藏，当前显示 ${items.length} 个。${authenticated() ? "标签和默认位置随账号保存。" : "登录后可设置个人地点并同步。"}`;
      for (const [key, place] of items) {
        const row=document.createElement("article");row.className="saved-place-card";
        const locate=button(place.label,()=>atlas.selectSavedPlace(place),"saved-place-title");
        const detail=document.createElement("p");detail.textContent=`${describe(place) || "普通收藏"} · ${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`;
        const actions=document.createElement("div");actions.className="saved-place-actions";
        actions.append(button("设为起点",()=>atlas.useSavedRoutePoint("origin",place)),button("去这里",()=>atlas.useSavedRoutePoint("destination",place)));
        if (authenticated()) actions.append(button("编辑",()=>edit(key,place)));
        actions.append(button("删除",()=>{
          if (!root.confirm(`删除收藏“${place.label}”${place.isDefault ? "并取消默认位置" : ""}？`)) return;
          const next=atlas.getFavorites();delete next[key];atlas.saveFavorites(next);
          if(editingKey===key){form.hidden=true;editingKey=null;}message("已删除收藏，正在保存。");render();
        }));
        row.append(locate,detail,actions);list.append(row);
      }
      if(!items.length){const empty=document.createElement("p");empty.className="view-status";empty.textContent=total?"没有符合名称或标签的收藏。":"可先搜索或在地图上选点，再添加收藏。";list.append(empty);}
      renderRouteShortcuts();
    }
    function renderRouteShortcuts() {
      for (const target of ["origin","destination"]) {
        const select=byId(`route-saved-${target}`), current=select.value;
        select.replaceChildren(option("",target==="origin"?"从收藏选择起点":"从收藏选择终点"));
        for(const [key,place] of matches(atlas.getFavorites())) select.append(option(key,`${describe(place)?`${describe(place)}：`:""}${place.label}`));
        select.disabled=select.options.length===1;
        if([...select.options].some(item=>item.value===current))select.value=current;
      }
    }
    byId("saved-place-add").addEventListener("click",()=>edit());
    byId("saved-place-login").addEventListener("click",()=>atlas.openView("account"));
    byId("saved-place-sync-retry").addEventListener("click",()=>root.HuayuPersonalData?.retrySync());
    byId("saved-place-cancel").addEventListener("click",()=>{form.hidden=true;editingKey=null;message("");});
    byId("saved-place-use-selected").addEventListener("click",()=>{const place=atlas.getSelectedPlace();lat.value=place.lat;lng.value=place.lng;editingZoom=place.zoom;if(!name.value)name.value=place.label;});
    byId("saved-place-use-center").addEventListener("click",()=>{const center=atlas.map.getCenter();lat.value=Number(center.lat.toFixed(7));lng.value=Number(center.lng.toFixed(7));editingZoom=atlas.map.getZoom();});
    query.addEventListener("input",render);filter.addEventListener("change",render);
    form.addEventListener("submit",event=>{
      event.preventDefault();if(!authenticated()){form.hidden=true;return;}
      const point={lat:Number(lat.value),lng:Number(lng.value),label:name.value.trim(),zoom:editingZoom,
        placeTags:[...labels.querySelectorAll("input:checked")].map(input=>input.value),isDefault:defaultBox.checked};
      const custom = customInput.value.split(/[,，、;；]/u).map(value=>value.trim()).filter(Boolean);
      if (custom.some(value=>!cleanCustomTag(value))) {
        message("自定义标签每个最多 24 个字，请用逗号分隔。",true);customInput.focus();return;
      }
      Object.assign(point,normalizePlaceTags({...point,customTags:custom},9));
      if (point.customTags?.length > 8) {message("每个地点最多添加 8 个自定义标签。",true);customInput.focus();return;}
      if(!point.label || !lat.value.trim() || !lng.value.trim() || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
        || Math.abs(point.lat)>85 || Math.abs(point.lng)>180){message("请输入名称和有效经纬度。",true);return;}
      const next=atlas.getFavorites(), key=atlas.placeKey(point);
      if(editingKey && editingKey!==key)delete next[editingKey];
      const existing=next[key];
      if(existing && key!==editingKey){
        point.placeTags=[...new Set([...(existing.placeTags || []),...point.placeTags])];
        const mergedCustom=normalizePlaceTags({customTags:[...(existing.customTags || []),...(point.customTags || [])]},9).customTags;
        if(mergedCustom?.length > 8){message("合并后的地点最多保留 8 个自定义标签，请编辑已有地点。",true);return;}
        if(mergedCustom?.length)point.customTags=mergedCustom;
        point.isDefault ||= existing.isDefault===true;
      }
      if(!next[key] && Object.keys(next).length>=200){message("每个账号最多保存 200 个收藏地点。",true);return;}
      if(point.isDefault)for(const place of Object.values(next))delete place.isDefault;
      next[key]=point;
      if(!atlas.saveFavorites(next)){message("收藏未能保存，请重试。",true);return;}
      form.hidden=true;editingKey=null;message("已保存地点，正在同步到账号。");render();
    });
    for(const target of ["origin","destination"])byId(`route-saved-${target}`).addEventListener("change",event=>{
      const place=atlas.getFavorites()[event.target.value];if(place)atlas.useSavedRoutePoint(target,place);event.target.value="";
    });
    root.addEventListener("huayu:favorites-updated",render);
    root.addEventListener("huayu:account-changed",()=>{
      form.reset();form.hidden=true;editingKey=null;query.value="";filter.value="all";
      byId("saved-place-sync-retry").hidden=true;message("");render();
    });
    root.addEventListener("huayu:personal-sync-status",event=>{
      if(event.detail?.kind==="favorites"){
        message(event.detail.message,Boolean(event.detail.error));
        byId("saved-place-sync-retry").hidden=!event.detail.error;
      }
    });
    root.HuayuSavedPlaces.render=render;
    render();
  }
  root.HuayuSavedPlaces={tags,normalize,describe,matches,customLabels};
  if(root.HuayuAtlas)start();else root.addEventListener?.("huayu:map-ready",start,{once:true});
})(typeof window!=="undefined"?window:globalThis);
