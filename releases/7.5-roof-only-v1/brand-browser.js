(function start() {
  "use strict";
  const atlas = window.HuayuAtlas, data = window.HuayuBrandData;
  if (!atlas) {
    window.addEventListener("huayu:map-ready", start, {once: true});
    return;
  }
  if (!data || window.HuayuBrandBrowser) return;
  const el = id => document.getElementById(id);
  const ids = ["query", "kind", "category", "sort", "catalog-list", "catalog-status", "more", "detail",
    "detail-name", "detail-summary", "detail-status", "scope", "live", "branch-query", "location-list", "locations-more", "fit"];
  const fields = Object.fromEntries(ids.map(id => [id, el(`brand-${id}`)]));
  const searchBox = el("brand-search-matches");
  const markers = atlas.getBrandMarkerLayer();
  const store = data.createStore((url, options) => fetch(url, {...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(32000)])}));
  let catalog = null, catalogPromise = null, active = false, timer = null, movementTimer = null;
  let selected = null, locations = null, locationKey = "", discovery = null, discovering = false, catalogLimit = 30, locationLimit = 40, visiblePoints = [];
  let searchSequence = 0, loadSequence = 0, catalogCheckedAt = 0, lastLocationCheck = 0, fitOnLoad = false;
  const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", {hour12: false}) : "未提供";
  const text = (tag, content, className) => {
    const node = document.createElement(tag); node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, className = "text-button") => {
    const node = text("button", label, className); node.type = "button"; node.addEventListener("click", action); return node;
  };
  function categoryLabel(key) {
    const common = {"shop=convenience": "便利店", "shop=supermarket": "超市", "shop=mall": "商场", "amenity=bank": "银行",
      "amenity=fuel": "加油站", "amenity=cafe": "咖啡馆", "amenity=restaurant": "餐厅", "amenity=fast_food": "快餐",
      "tourism=hotel": "酒店", "shop=clothes": "服装", "amenity=parking": "停车场", "office=company": "公司"};
    return common[key] ? `${common[key]} · ${key}` : key;
  }
  async function loadCatalog(force = false) {
    if (catalogPromise) return catalogPromise;
    if (catalog && !force) return catalog;
    catalogCheckedAt = Date.now();
    catalogPromise = (async () => {
      const response = await fetch("./brand-catalog.json", {cache: "no-cache", signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw Error("目录暂时不可用，请重试");
      const next = data.validateCatalog(await response.json());
      catalog = next; return next;
    })().finally(() => {catalogPromise = null;});
    return catalogPromise;
  }
  function entries() {
    return discovery?.kind === fields.kind.value ? discovery.entries : catalog?.[fields.kind.value === "brand" ? "brands" : "operators"] || [];
  }
  function updateCategories() {
    if (!catalog && !discovery) return;
    const previous = fields.category.value;
    fields.category.replaceChildren(new Option("所有分类", ""));
    const keys = [...new Set(entries().flatMap(entry => entry.categories.map(([key]) => key)))].sort();
    keys.forEach(key => fields.category.add(new Option(categoryLabel(key), key)));
    fields.category.value = keys.includes(previous) ? previous : "";
    fields.category.disabled = false;
  }
  function catalogCard(entry, kind) {
    const card = button("", () => openEntry(entry, kind), "brand-card");
    card.append(text("strong", entry.name), text("small", `${kind === "brand" ? "品牌" : "运营者"} · ${entry.count.toLocaleString()} 个地图要素`),
      text("small", entry.categories.slice(0, 2).map(([key]) => categoryLabel(key)).join(" / ")));
    return card;
  }
  function renderCatalog() {
    fields["catalog-list"].replaceChildren();
    const found = data.matches(entries(), fields.query.value, fields.category.value, fields.sort.value);
    found.slice(0, catalogLimit).forEach(entry => fields["catalog-list"].append(catalogCard(entry, fields.kind.value)));
    fields.more.hidden = Boolean(selected) || found.length <= catalogLimit;
    if (!catalog && !discovery) return;
    fields["catalog-status"].textContent = discovery ? `当前范围发现 ${found.length} 个名称；读取 ${date(discovery.fetchedAt)}。${discovery.truncated ? "超过 2000 个要素，仅为部分结果，请缩小范围。" : ""}`
      : `目录：${catalog.brands.length.toLocaleString()} 品牌 / ${catalog.operators.length.toLocaleString()} 运营者；匹配 ${found.length} 项。生成 ${date(catalog.generatedAt)}；上游 ${date(catalog.dbTimestamp)}。${catalog.coverage || ""}`;
    if (fields.query.value.trim()) {
      fields["catalog-list"].append(button(`按 ${fields.kind.value} 标签查询“${fields.query.value.trim()}”`,
        () => openEntry({name: fields.query.value.trim(), categories: []}, fields.kind.value)));
    }
  }
  async function checkCatalog(force = false) {
    if (!catalog && !discovery) {
      fields.category.disabled = true;
      fields.category.replaceChildren(new Option("正在加载分类…", ""));
      fields["catalog-status"].textContent = "正在加载品牌目录与分类…";
    }
    try {await loadCatalog(force); updateCategories(); renderCatalog();}
    catch {
      if (!catalog && !discovery) fields.category.replaceChildren(new Option("分类暂不可用", ""));
      fields["catalog-status"].textContent = catalog ? "新版目录暂时无法读取，继续使用已有目录。" : "目录暂时不可用；点击“检查新版目录”重试，或输入完整名称按标签查找。";
    }
  }
  function scopeParams() {
    if (fields.scope.value === "world") return {scope: "world"};
    const b = atlas.map.getBounds();
    return {scope: "view", south: b.getSouth().toFixed(6), west: b.getWest().toFixed(6), north: b.getNorth().toFixed(6), east: b.getEast().toFixed(6)};
  }
  function clearMarkers() {markers.clearLayers(); if (atlas.map.hasLayer(markers)) atlas.map.removeLayer(markers);}
  function showPlace(element, target) {
    const place = data.place(element); if (!place) return;
    if (target) atlas.useSavedRoutePoint(target, place);
    else atlas.selectSavedPlace(place);
  }
  function renderLocations() {
    fields["location-list"].replaceChildren(); clearMarkers();
    visiblePoints = [];
    if (!locations) return;
    const terms = data.normalize(fields["branch-query"].value).split(" ").filter(Boolean);
    const seen = new Set();
    const found = locations.elements.filter(element => {
      const key = `${element.type}/${element.id}`;
      if (seen.has(key)) return false; seen.add(key);
      return terms.every(term => data.normalize(Object.values(element.tags || {}).join(" ")).includes(term));
    });
    const points = found.filter(element => data.place(element));
    visiblePoints = points.map(data.place);
    const center = atlas.map.getCenter();
    const sorted = [...found].sort((a, b) => {
      const pa = data.place(a), pb = data.place(b);
      return (pa ? atlas.map.distance(center, pa) : Infinity) - (pb ? atlas.map.distance(center, pb) : Infinity);
    });
    sorted.slice(0, locationLimit).forEach(element => {
      const place = data.place(element), tags = element.tags || {}, card = text("article", "", "brand-card");
      card.append(text("strong", place?.label || tags.name || selected.name),
        text("small", [tags["addr:city"], tags["addr:street"], tags["addr:housenumber"], tags.branch].filter(Boolean).join(" · ")),
        text("small", `${element.type}/${element.id}${place ? ` · ${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}` : " · 未提供可定位坐标"}`));
      const actions = text("div", "", "brand-card-actions");
      if (place) actions.append(button("定位 / 收藏", () => showPlace(element)), button("从这里出发", () => showPlace(element, "origin")), button("到这里", () => showPlace(element, "destination")));
      const source = text("a", "原始要素"); source.href = `https://opengeofiction.net/${element.type}/${element.id}`;
      source.target = "_blank"; source.rel = "noopener noreferrer"; actions.append(source); card.append(actions);
      fields["location-list"].append(card);
    });
    if (active && !document.hidden) {
      points.forEach(element => {
        const place = data.place(element);
        const marker = L.circleMarker([place.lat, place.lng], {radius: 6, color: "#087f83", weight: 2, fillColor: "#087f83", fillOpacity: .95});
        marker.feature = {type: "Feature", geometry: {type: "Point", coordinates: [place.lng, place.lat]}, properties: {name: place.label, huayuBrandLocation: true}};
        marker.bindTooltip(text("span", place.label)).on("click", event => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          showPlace(element);
        }).addTo(markers);
      });
      markers.addTo(atlas.map);
    }
    fields.fit.disabled = !points.length;
    fields["locations-more"].hidden = sorted.length <= locationLimit;
    fields["detail-status"].textContent = `${locations.stale ? "更新失败，保留旧结果。" : ""}本次查询 ${locations.total} 个地图要素，筛选后 ${found.length} 个，${points.length} 个可定位。${locations.truncated ? "仅显示前 500 个，请缩小范围；并非全部地点。" : ""}读取 ${date(locations.fetchedAt)}；上游 ${date(locations.dbTimestamp)}。${fields.scope.value === "world" ? "全球查询。" : "当前范围查询。"}`;
  }
  async function loadLocations(force = false) {
    if (!active || document.hidden || !selected) return;
    const sequence = ++loadSequence;
    const params = new URLSearchParams({mode: "locations", kind: selected.kind, name: selected.name, ...scopeParams()});
    const key = params.toString();
    if (key !== locationKey) {locations = null; fields["location-list"].replaceChildren(); clearMarkers();}
    locationKey = key; lastLocationCheck = Date.now();
    fields["detail-status"].textContent = locations ? "正在检查更新，保留已有地点…" : "正在读取地点…";
    try {
      const result = await store.load(key, `/api/brands?${params}`, force);
      if (!result || sequence !== loadSequence || !active) return;
      locations = result; renderLocations();
      if (fitOnLoad && fields.scope.value === "world") {fitOnLoad = false; fitLocations();}
    } catch (error) {
      if (sequence !== loadSequence || !active) return;
      fields["detail-status"].textContent = `${error.message}。可以刷新重试。`;
    }
  }
  function openEntry(entry, kind) {
    selected = null; loadSequence++; store.cancel();
    atlas.openView("brands");
    selected = {...entry, kind}; locations = null; locationKey = ""; locationLimit = 40;
    fitOnLoad = true; el("brand-browse").hidden = true;
    fields.detail.hidden = false; fields["catalog-list"].hidden = true; fields.more.hidden = true;
    fields["detail-name"].textContent = entry.name;
    fields["detail-summary"].textContent = `${kind === "brand" ? "品牌" : "运营者"}${entry.count ? ` · 目录快照 ${entry.count} 个地图要素` : " · 原始标签完全匹配"}。点、线、面可能指向同一场所，数量不等于营业门店总数。`;
    fields["branch-query"].value = "";
    loadLocations();
    fields.detail.scrollIntoView({block: "start"});
  }
  function closeDetail() {
    selected = null; locations = null; discovering = false; fitOnLoad = false; loadSequence++; store.cancel(); clearMarkers();
    el("brand-browse").hidden = false;
    fields.detail.hidden = true; fields["catalog-list"].hidden = false; renderCatalog();
  }
  function updateTimer() {
    clearInterval(timer); timer = null;
    if (!active || document.hidden) return;
    timer = setInterval(() => {
      if (Date.now() - catalogCheckedAt >= 300000) checkCatalog(true);
      if (selected && fields.live.checked && Date.now() - lastLocationCheck >= data.REFRESH_MS) loadLocations(true);
    }, 10000);
  }
  function setActive(next) {
    if (active === next) return;
    active = next;
    if (active) {
      checkCatalog();
      if (selected) {renderLocations(); loadLocations();}
    } else {
      loadSequence++; store.cancel(); clearMarkers(); clearTimeout(movementTimer);
    }
    updateTimer();
  }
  function clearSearch() {searchSequence++; searchBox.replaceChildren(); searchBox.hidden = true;}
  async function search(query) {
    const sequence = ++searchSequence;
    if ([...data.normalize(query)].length < 2) return;
    try {
      await loadCatalog(); if (sequence !== searchSequence) return;
      const found = ["brand", "operator"].flatMap(kind => data.matches(catalog[kind === "brand" ? "brands" : "operators"], query)
        .slice(0, 4).map(entry => ({entry, kind})));
      if (!found.length) return;
      found.sort((a, b) => Number(data.normalize(b.entry.name) === data.normalize(query)) - Number(data.normalize(a.entry.name) === data.normalize(query)));
      searchBox.replaceChildren(text("h2", "品牌与运营者 · 选择后查看地点"));
      found.slice(0, 6).forEach(({entry, kind}) => searchBox.append(catalogCard(entry, kind)));
      searchBox.hidden = false;
    } catch {
      if (sequence !== searchSequence) return;
      searchBox.replaceChildren(button("品牌目录暂时不可用，打开品牌页重试", () => atlas.openView("brands")));
      searchBox.hidden = false;
    }
  }
  el("brand-form").addEventListener("submit", event => {
    event.preventDefault(); closeDetail(); catalogLimit = 30; renderCatalog();
    if (!catalog) fields["catalog-list"].append(button("按完整标签查询", () => openEntry({name: fields.query.value.trim(), categories: []}, fields.kind.value)));
  });
  fields.query.addEventListener("input", () => {if (selected) closeDetail(); catalogLimit = 30; renderCatalog();});
  [fields.kind, fields.category, fields.sort].forEach(field => field.addEventListener("change", () => {
    if (field === fields.kind) {discovery = null; updateCategories();}
    closeDetail(); catalogLimit = 30; renderCatalog();
  }));
  fields.more.addEventListener("click", () => {catalogLimit += 30; renderCatalog();});
  el("brand-catalog-refresh").addEventListener("click", () => {discovery = null; checkCatalog(true);});
  el("brand-detail-close").addEventListener("click", closeDetail);
  el("brand-refresh").addEventListener("click", () => loadLocations(true));
  fields.scope.addEventListener("change", () => loadLocations());
  fields.live.addEventListener("change", () => {updateTimer(); if (fields.live.checked) loadLocations();});
  fields["branch-query"].addEventListener("input", () => {locationLimit = 40; renderLocations();});
  fields["locations-more"].addEventListener("click", () => {locationLimit += 40; renderLocations();});
  function fitLocations() {
    const points = visiblePoints;
    if (points.length) atlas.map.fitBounds(points.map(place => [place.lat, place.lng]), {padding: [50, 50], maxZoom: 17});
  }
  fields.fit.addEventListener("click", fitLocations);
  el("brand-discover").addEventListener("click", async () => {
    closeDetail(); const sequence = ++loadSequence, kind = fields.kind.value;
    discovering = true;
    const params = new URLSearchParams({kind, mode: "discover", scope: "view"});
    const b = atlas.map.getBounds();
    Object.entries({south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast()}).forEach(([key, value]) => params.set(key, value.toFixed(6)));
    fields["catalog-status"].textContent = "正在发现当前范围的品牌…";
    try {
      const payload = await store.load(params.toString(), `/api/brands?${params}`);
      if (!payload || sequence !== loadSequence || !active || kind !== fields.kind.value) return;
      if (payload.stale) throw Error("实时发现暂不可用，未替换已有目录");
      discovery = {...payload, kind, entries: data.aggregate(payload.elements, kind)};
      updateCategories(); renderCatalog();
    } catch (error) {if (sequence === loadSequence && active) fields["catalog-status"].textContent = error.message;}
    finally {if (sequence === loadSequence) discovering = false;}
  });
  atlas.map.on("moveend", () => {
    if (!active) return;
    if (discovering) {
      discovering = false; loadSequence++; store.cancel();
      fields["catalog-status"].textContent = "地图范围已改变，请重新发现当前范围的品牌。";
    }
    if (!selected && discovery) {
      discovery = null; loadSequence++; store.cancel(); updateCategories(); renderCatalog();
    }
    if (!selected || fields.scope.value !== "view") return;
    loadSequence++; store.cancel(); clearTimeout(movementTimer);
    movementTimer = setTimeout(() => loadLocations(), 700);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {loadSequence++; store.cancel(); clearMarkers(); clearTimeout(movementTimer);}
    else if (active) {checkCatalog(true); if (selected) {renderLocations(); if (fields.live.checked) loadLocations();}}
    updateTimer();
  });
  window.addEventListener("pagehide", () => {setActive(false); clearSearch();});
  window.addEventListener("pageshow", () => setActive(atlas.getCurrentView() === "brands"
    && !el("tool-panel").classList.contains("is-hidden")));
  window.HuayuBrandBrowser = Object.freeze({setActive, search, clearSearch});
  if (new URLSearchParams(window.location.search).get("panel") === "brands") atlas.openView("brands");
  setActive(atlas.getCurrentView() === "brands" && !el("tool-panel").classList.contains("is-hidden"));
})();
