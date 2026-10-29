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
    "detail-name", "detail-summary", "detail-status", "scope", "live", "branch-query", "location-list", "locations-more", "fit",
    "city-query", "city-status", "city-results", "city-scope", "reset", "recognition"];
  const fields = Object.fromEntries(ids.map(id => [id, el(`brand-${id}`)]));
  const searchBox = el("brand-search-matches");
  const markers = atlas.getBrandMarkerLayer();
  const store = data.createStore((url, options) => fetch(url, {...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(32000)])}));
  let catalog = null, catalogPromise = null, active = false, timer = null, movementTimer = null;
  let selected = null, locations = null, locationKey = "", discovery = null, discovering = false, catalogLimit = 30, locationLimit = 40, visiblePoints = [];
  let searchSequence = 0, loadSequence = 0, catalogCheckedAt = 0, lastLocationCheck = 0, fitOnLoad = false;
  let citySequence = 0, citySearching = false, city = null, discoveryScope = "", lastDiscoveryCheck = 0;
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
    const all = discovery?.kind === fields.kind.value ? discovery.entries : catalog?.[fields.kind.value === "brand" ? "brands" : "operators"] || [];
    return fields.kind.value === "brand" ? data.filterEntries(all, fields.recognition.value || "all") : all;
  }
  const countsLabel = entry => entry.candidate ? `待确认店名 · ${entry.count} 个地图要素`
    : `标签 ${entry.taggedCount ?? entry.count} · 名称识别 ${entry.namedCount || 0}`;
  function queryEntry(name, kind) {
    if (kind !== "brand") return {name, categories: []};
    const matching = (catalog?.brands || []).filter(entry => [entry.name, ...(entry.aliases || [])]
      .some(value => data.normalize(value) === data.normalize(name)));
    return matching.length === 1 ? matching[0] : {name, categories: [], candidate: true};
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
    card.append(text("strong", entry.name), text("small", `${kind === "brand" ? entry.candidate ? "店名候选" : "品牌" : "运营者"} · ${entry.count.toLocaleString()} 个地图要素`),
      ...(kind === "brand" ? [text("small", countsLabel(entry))] : []),
      text("small", entry.categories.slice(0, 2).map(([key]) => categoryLabel(key)).join(" / ")));
    return card;
  }
  function renderCatalog() {
    fields["catalog-list"].replaceChildren();
    const found = data.matches(entries(), fields.query.value, fields.category.value, fields.sort.value);
    found.slice(0, catalogLimit).forEach(entry => fields["catalog-list"].append(catalogCard(entry, fields.kind.value)));
    fields.more.hidden = Boolean(selected) || found.length <= catalogLimit;
    if (!catalog && !discovery) return;
    const kindLabel = fields.kind.value === "brand" ? "品牌" : "运营者";
    fields.recognition.disabled = fields.kind.value !== "brand";
    const all = entries(), known = all.filter(entry => !entry.candidate), candidates = all.filter(entry => entry.candidate),
      sum = field => all.reduce((total, entry) => total + (entry[field] || 0), 0);
    fields.reset.hidden = !discovery;
    fields["catalog-status"].textContent = discovery
      ? `${discovery.city ? `${discovery.city.name}行政边界内` : "当前矩形视野内"}：${discovery.truncated ? "已读取部分中至少" : "已识别"} ${known.length} 个不同${kindLabel}，筛选后 ${found.length} 项；${all.reduce((total, entry) => total + entry.count, 0).toLocaleString()} 个地图要素。${fields.kind.value === "brand" ? `另有 ${candidates.length} 个待确认店名；标签 ${sum("taggedCount")}、名称识别 ${sum("namedCount")}、候选 ${sum("candidateCount")} 个要素。候选不混入品牌总数。` : ""}${discovery.truncated ? "仅读取前 2000 个候选要素，品牌数不是完整总数。" : ""}${discovery.stale ? "更新失败，保留旧结果。" : ""}读取 ${date(discovery.fetchedAt)}；上游 ${date(discovery.dbTimestamp)}。${fields.kind.value === "brand" ? "名称识别仅限商业设施；不确定归属保留为候选。" : "运营者仍按 operator 标签统计。"}`
      : `全域目录文字匹配：${found.length} 项，不是城市范围统计。目录：${catalog.brands.filter(entry => !entry.candidate).length.toLocaleString()} 品牌 / ${catalog.brands.filter(entry => entry.candidate).length.toLocaleString()} 待确认店名 / ${catalog.operators.length.toLocaleString()} 运营者。生成 ${date(catalog.generatedAt)}；上游 ${date(catalog.dbTimestamp)}。${catalog.coverage || ""}`;
    if (discovery?.unassigned) fields["catalog-status"].textContent += `${discovery.unassigned} 个已读要素存在归属冲突或缺少有效店名，未计入。`;
    if (fields.query.value.trim()) {
      fields["catalog-list"].append(button(`按${fields.kind.value === "brand" && fields.recognition.value !== "tag" ? "品牌或店名" : ` ${fields.kind.value} 标签`}查询“${fields.query.value.trim()}”`,
        () => openEntry(queryEntry(fields.query.value.trim(), fields.kind.value), fields.kind.value)));
    }
  }
  async function checkCatalog(force = false) {
    if (!catalog && !discovery) {
      fields.category.disabled = true;
      fields.category.replaceChildren(new Option("正在加载分类…", ""));
      fields["catalog-status"].textContent = "正在加载品牌目录与分类…";
    }
    try {
      await loadCatalog(force);
      if (discovery?.kind === "brand") {
        const recognized = data.recognizeBrands(discovery.elements, catalog.brands, Boolean(discovery.includeNames));
        discovery = {...discovery, entries: data.aggregate(recognized, "brand"), unassigned: discovery.elements.length - recognized.length};
      }
      updateCategories(); if (!discovering) renderCatalog();
    }
    catch {
      if (discovery) {
        updateCategories(); renderCatalog();
        fields["catalog-status"].textContent += "全域目录检查失败，当前范围结果保留。";
        return;
      }
      if (!catalog && !discovery) fields.category.replaceChildren(new Option("分类暂不可用", ""));
      fields["catalog-status"].textContent = catalog ? "新版目录暂时无法读取，继续使用已有目录。" : "目录暂时不可用；点击“检查新版目录”重试，或输入完整名称按标签查找。";
    }
  }
  function scopeParams() {
    if (fields.scope.value === "city" && city) return {scope: "city", relation: String(city.id)};
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
      if (selected.kind === "brand") {
        const match = element.brandMatch;
        card.append(text("small", match?.source === "tag" ? `标签标注：brand=${tags.brand}` : match?.source === "name"
          ? `名称识别：${match.field}=${match.value} → ${match.name}` : `待确认店名：${match?.field || "name"}=${match?.value || tags.name || ""}`));
      }
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
    fields["detail-status"].textContent = `${locations.stale ? "更新失败，保留旧结果。" : ""}本次查询 ${locations.scannedTotal ?? locations.total} 个地图要素，匹配 ${locations.elements.length} 个，筛选后 ${found.length} 个，${points.length} 个可定位。${selected.kind === "brand" ? `标签 ${locations.elements.filter(e => e.brandMatch?.source === "tag").length}、名称识别 ${locations.elements.filter(e => e.brandMatch?.source === "name").length}、待确认 ${locations.elements.filter(e => e.brandMatch?.source === "candidate").length}。` : ""}${locations.truncated ? "仅读取前 500 个候选，请缩小范围；并非全部地点。" : ""}读取 ${date(locations.fetchedAt)}；上游 ${date(locations.dbTimestamp)}。${fields.scope.value === "city" && city ? `${city.name}行政边界内查询。` : fields.scope.value === "world" ? "全球查询。" : "当前矩形视野查询。"}`;
  }
  async function loadLocations(force = false) {
    if (!active || document.hidden || !selected) return;
    const sequence = ++loadSequence;
    const params = new URLSearchParams({mode: "locations", kind: selected.kind, name: selected.name, ...scopeParams()});
    const includeNames = selected.kind === "brand" && fields.recognition.value !== "tag";
    if (includeNames) {
      params.set("includeNames", "1");
      if (selected.candidate) params.set("candidate", "1");
      if (selected.aliases?.length) params.set("aliases", JSON.stringify(selected.aliases));
    }
    const key = params.toString();
    if (key !== locationKey) {locations = null; fields["location-list"].replaceChildren(); clearMarkers();}
    locationKey = key; lastLocationCheck = Date.now();
    fields["detail-status"].textContent = locations ? "正在检查更新，保留已有地点…" : "正在读取地点…";
    try {
      const result = await store.load(key, `/api/brands?${params}`, force);
      if (!result || sequence !== loadSequence || !active) return;
      const elements = selected.kind === "brand" ? data.recognizeBrands(result.elements,
        [...(catalog?.brands || []), ...(selected.candidate ? [] : [selected])], includeNames)
        .filter(element => element.brandMatch.name === selected.name
          && (!fields.recognition.value || fields.recognition.value === "all" || element.brandMatch.source === fields.recognition.value)) : result.elements;
      locations = {...result, scannedTotal: result.total, elements}; renderLocations();
      if (fitOnLoad && fields.scope.value === "world") {fitOnLoad = false; fitLocations();}
    } catch (error) {
      if (sequence !== loadSequence || !active) return;
      fields["detail-status"].textContent = `${error.message}。可以刷新重试。`;
    }
  }
  function openEntry(entry, kind) {
    citySequence++; citySearching = false; fields["city-results"].hidden = true;
    selected = null; loadSequence++; store.cancel();
    if (kind !== fields.kind.value) fields.recognition.value = "all";
    atlas.openView("brands");
    selected = {...entry, kind}; locations = null; locationKey = ""; locationLimit = 40;
    fitOnLoad = true; el("brand-browse").hidden = true;
    fields.detail.hidden = false; fields["catalog-list"].hidden = true; fields.more.hidden = true;
    fields["detail-name"].textContent = entry.name;
    fields["detail-summary"].textContent = `${entry.candidate ? "待确认店名；尚未证明属于连锁品牌" : kind === "brand" ? "品牌；支持原始标签及商业设施名称识别" : "运营者；原始 operator 标签完全匹配"}${entry.count ? ` · 目录快照 ${entry.count} 个地图要素` : ""}。点、线、面可能指向同一场所，数量不等于营业门店总数。`;
    fields["branch-query"].value = "";
    if (discovery?.city) fields.scope.value = "city";
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
      if (!selected && discovery?.city && !discovering && !citySearching && fields.live.checked
        && Date.now() - lastDiscoveryCheck >= data.REFRESH_MS) loadDiscovery(discovery.city, true);
    }, 10000);
  }
  function setActive(next) {
    if (active === next) return;
    active = next;
    if (active) {
      checkCatalog();
      if (selected) {renderLocations(); loadLocations();}
    } else {
      citySequence++; citySearching = false; discovering = false;
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
      searchBox.replaceChildren(text("h2", "品牌、店名与运营者 · 选择后查看地点"));
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
    if (!catalog) fields["catalog-list"].append(button("按完整名称查询", () => openEntry(queryEntry(fields.query.value.trim(), fields.kind.value), fields.kind.value)));
  });
  fields.query.addEventListener("input", () => {
    if (selected || discovering) closeDetail();
    catalogLimit = 30; renderCatalog();
  });
  fields["city-query"].addEventListener("input", () => {
    if (discovering) closeDetail();
    citySequence++; citySearching = false; fields["city-results"].hidden = true;
    fields["city-status"].textContent = "输入城市后点击“查城市”，选择真实行政边界。";
  });
  [fields.kind, fields.category, fields.sort].forEach(field => field.addEventListener("change", () => {
    const previousCity = discovery?.city;
    if (field === fields.kind) {discovery = null; updateCategories();}
    closeDetail(); catalogLimit = 30; renderCatalog();
    if (field === fields.kind && previousCity) loadDiscovery(previousCity);
  }));
  fields.recognition.addEventListener("change", () => {
    const previousCity = discovery?.city, previousView = discovery && !discovery.city;
    closeDetail(); catalogLimit = 30; updateCategories(); renderCatalog();
    if (previousCity || previousView) loadDiscovery(previousCity || null);
  });
  fields.more.addEventListener("click", () => {catalogLimit += 30; renderCatalog();});
  el("brand-catalog-refresh").addEventListener("click", () => checkCatalog(true));
  fields.reset.addEventListener("click", () => {
    citySequence++; citySearching = false; closeDetail(); discovery = null; city = null;
    fields["city-results"].hidden = true; fields["city-scope"].disabled = true;
    if (fields.scope.value === "city") fields.scope.value = "world";
    fields["city-status"].textContent = "已返回全域目录；文字匹配数不是城市范围统计。";
    updateCategories(); renderCatalog();
  });
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
  async function loadDiscovery(targetCity = null, force = false, resetFilters = false) {
    closeDetail(); const sequence = ++loadSequence, kind = fields.kind.value;
    discovering = true; discoveryScope = targetCity ? "city" : "view"; lastDiscoveryCheck = Date.now();
    const params = new URLSearchParams({kind, mode: "discover", scope: discoveryScope});
    const includeNames = kind === "brand" && fields.recognition.value !== "tag";
    if (includeNames) params.set("includeNames", "1");
    if (targetCity) params.set("relation", String(targetCity.id));
    else {
      const b = atlas.map.getBounds();
      Object.entries({south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast()}).forEach(([key, value]) => params.set(key, value.toFixed(6)));
    }
    fields["catalog-status"].textContent = targetCity ? `正在读取${targetCity.name}行政边界内的${kind === "brand" ? "品牌" : "运营者"}…` : "正在发现当前矩形视野内的品牌…";
    if (targetCity) fields["city-status"].textContent = `正在按${targetCity.name}真实行政边界读取数据…`;
    try {
      if (includeNames && !catalog) await loadCatalog().catch(() => null);
      if (sequence !== loadSequence || !active) return;
      const payload = await store.load(params.toString(), `/api/brands?${params}`, force);
      if (!payload || sequence !== loadSequence || !active || kind !== fields.kind.value) return;
      if (payload.stale) throw Error("实时发现暂不可用，未替换已有目录");
      if (targetCity && payload.cityRelation !== targetCity.id) throw Error("返回的行政区与所选城市不一致，请重试");
      const recognized = kind === "brand" ? data.recognizeBrands(payload.elements, catalog?.brands || [], includeNames) : payload.elements;
      discovery = {...payload, kind, city: targetCity, entries: data.aggregate(recognized, kind), unassigned: payload.elements.length - recognized.length};
      if (resetFilters) {fields.query.value = ""; fields.category.value = ""; catalogLimit = 30;}
      city = targetCity; fields["city-scope"].disabled = !city;
      if (city) {
        fields["city-scope"].textContent = `${city.name}行政边界`;
        fields["city-status"].textContent = `已按${city.name}真实行政边界统计。移动或缩放地图不会改变城市范围。`;
      } else {
        if (fields.scope.value === "city") fields.scope.value = "world";
        fields["city-status"].textContent = "当前使用地图矩形视野；如需全市统计，请查找城市行政边界。";
      }
      updateCategories(); renderCatalog();
    } catch (error) {
      if (sequence === loadSequence && active) {
        if (discovery?.city?.id === targetCity?.id && discovery?.kind === kind) discovery = {...discovery, stale: true};
        renderCatalog();
        fields["catalog-status"].textContent = `${targetCity ? `${targetCity.name}城市统计` : "当前范围发现"}失败：${error.message}。${fields["catalog-status"].textContent}`;
        if (targetCity) fields["city-status"].textContent = `${targetCity.name}城市统计暂不可用，请重试；已有结果保留。`;
      }
    }
    finally {if (sequence === loadSequence) discovering = false;}
  }
  el("brand-discover").addEventListener("click", () => {
    citySequence++; citySearching = false; fields["city-results"].hidden = true;
    loadDiscovery();
  });
  el("brand-city-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = fields["city-query"].value.trim(), sequence = ++citySequence;
    fields["city-results"].replaceChildren(); fields["city-results"].hidden = true;
    if (!query) {fields["city-status"].textContent = "请输入城市或行政区名称，例如：津川。"; return;}
    closeDetail(); citySearching = true;
    fields["city-status"].textContent = `正在查找“${query}”的真实行政边界…`;
    try {
      const candidates = (await atlas.findAdministrativeCities(query)).filter(result => result.osm_type === "relation"
        && Number.isSafeInteger(Number(result.osm_id)) && Number(result.osm_id) > 0);
      if (sequence !== citySequence || !active) return;
      if (!candidates.length) {fields["city-status"].textContent = "未找到可查询的真实行政边界，请补全城市名称重试；未用文字匹配或矩形代替统计。"; return;}
      const choose = candidate => {
        citySequence++; citySearching = false; fields["city-results"].hidden = true;
        loadDiscovery({id: Number(candidate.osm_id), name: candidate.name || candidate.display_name.split(",")[0]}, false, true);
      };
      if (candidates.length === 1) {choose(candidates[0]); return;}
      fields["city-status"].textContent = "请选择要统计的行政区，同名地区分别保留：";
      candidates.forEach(candidate => {
        const card = button("", () => {if (sequence === citySequence && active) choose(candidate);}, "brand-card");
        card.append(text("strong", candidate.name || candidate.display_name),
          text("small", `${candidate.display_name || ""} · 行政层级 ${candidate.extratags?.admin_level || "未提供"} · relation/${candidate.osm_id}`));
        fields["city-results"].append(card);
      });
      fields["city-results"].hidden = false;
    } catch (error) {
      if (sequence !== citySequence || !active) return;
      fields["city-status"].textContent = error.message === "CITY_SEARCH_TOO_BROAD" ? "同名行政区过多，请补全名称重试。"
        : "行政边界服务暂时不可用，请重试；已有结果保留，这不表示城市不存在。";
    } finally {if (sequence === citySequence) citySearching = false;}
  });
  atlas.map.on("moveend", () => {
    if (!active) return;
    if (discovering && discoveryScope === "view") {
      discovering = false; loadSequence++; store.cancel();
      fields["catalog-status"].textContent = "地图范围已改变，请重新发现当前范围的品牌。";
    }
    if (!selected && discovery && !discovery.city) {
      const pendingCity = discovering && discoveryScope === "city";
      discovery = null;
      if (!pendingCity) {loadSequence++; store.cancel();}
      updateCategories(); if (!pendingCity) renderCatalog();
    }
    if (!selected || fields.scope.value !== "view") return;
    loadSequence++; store.cancel(); clearTimeout(movementTimer);
    movementTimer = setTimeout(() => loadLocations(), 700);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {citySequence++; citySearching = false; discovering = false; loadSequence++; store.cancel(); clearMarkers(); clearTimeout(movementTimer);}
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
