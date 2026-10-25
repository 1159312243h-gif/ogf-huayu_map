(function (root) {
  "use strict";
  const REFRESH_MS = 120000;
  const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
  const searchText = new WeakMap();
  function entryText(entry) {
    if (!searchText.has(entry)) searchText.set(entry, normalize([entry.name, ...(entry.branches || []), ...(entry.cities || []),
      ...(entry.names || []), ...(entry.brands || []), ...(entry.operators || [])].join(" ")));
    return searchText.get(entry);
  }
  function matches(entries, query, category = "", sort = "count") {
    const terms = normalize(query).split(" ").filter(Boolean);
    return entries.filter(entry => (!category || entry.categories.some(([key]) => key === category))
      && terms.every(term => entryText(entry).includes(term)))
      .sort((a, b) => {
        const exact = Number(normalize(b.name) === normalize(query)) - Number(normalize(a.name) === normalize(query));
        return exact || (sort === "name" ? 0 : b.count - a.count) || a.name.localeCompare(b.name, "zh-CN");
      });
  }
  function aggregate(elements, kind) {
    if (!["brand", "operator"].includes(kind)) throw Error("INVALID_KIND");
    const groups = new Map(), seen = new Set();
    const keys = ["shop", "amenity", "tourism", "office", "craft", "leisure", "healthcare", "public_transport", "railway", "highway"];
    for (const element of elements) {
      const identity = `${element.type}/${element.id}`, tags = element.tags || {}, name = tags[kind];
      if (seen.has(identity) || !["node", "way", "relation"].includes(element.type)
        || !Number.isSafeInteger(element.id) || element.id <= 0 || typeof name !== "string" || !name.trim()) continue;
      seen.add(identity);
      if (!groups.has(name)) groups.set(name, {name, count: 0, types: {}, categories: new Map(),
        operators: new Set(), brands: new Set(), branches: new Set(), cities: new Set(), names: new Set()});
      const entry = groups.get(name);
      entry.count++;
      entry.types[element.type] = (entry.types[element.type] || 0) + 1;
      const category = keys.find(key => tags[key]);
      if (category) {
        const key = `${category}=${tags[category]}`;
        entry.categories.set(key, (entry.categories.get(key) || 0) + 1);
      }
      for (const [field, tag] of [["operators", "operator"], ["brands", "brand"], ["branches", "branch"], ["cities", "addr:city"], ["names", "name"]]) {
        if (typeof tags[tag] === "string" && tags[tag].trim()) entry[field].add(tags[tag]);
      }
    }
    return [...groups.values()].map(entry => ({...entry,
      categories: [...entry.categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
      branchCount: entry.branches.size,
      ...Object.fromEntries(["operators", "brands", "branches", "cities", "names"].map(key => [key, [...entry[key]].sort().slice(0, 12)])),
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function validateCatalog(value) {
    if (value?.schema !== "huayu-brand-catalog-v1" || !Number.isFinite(Date.parse(value.generatedAt))
      || !["brands", "operators"].every(key => Array.isArray(value[key]) && value[key].length
        && value[key].every(entry => typeof entry.name === "string" && entry.name.trim()
          && Number.isSafeInteger(entry.count) && entry.count > 0 && Array.isArray(entry.categories)
          && entry.categories.every(item => Array.isArray(item) && typeof item[0] === "string"
            && Number.isSafeInteger(item[1]) && item[1] > 0)
          && ["operators", "brands", "branches", "cities", "names"].every(field => entry[field] === undefined
            || Array.isArray(entry[field]) && entry[field].every(item => typeof item === "string"))))) throw Error("INVALID_CATALOG");
    for (const key of ["brands", "operators"]) {
      if (new Set(value[key].map(entry => entry.name)).size !== value[key].length) throw Error("DUPLICATE_CATALOG_NAME");
    }
    return value;
  }
  function place(element) {
    const lat = element?.lat ?? element?.center?.lat, lng = element?.lon ?? element?.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    const tags = element.tags || {};
    return {lat, lng, zoom: 17, label: [tags["name:zh"] || tags.name || tags.brand || tags.operator || "未命名设施", tags.branch]
      .filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(" · "),
      sourceKey: `${element.type}/${element.id}`};
  }
  // Successful complete snapshots alone enter the bounded cache. Failed/late requests never replace them.
  function createStore(fetcher, now = Date.now) {
    const cache = new Map();
    let sequence = 0, controller = null;
    return {
      cancel() {sequence++; controller?.abort(); controller = null;},
      async load(key, url, force = false) {
        this.cancel();
        const token = sequence, previous = cache.get(key);
        if (!force && previous && now() - Date.parse(previous.fetchedAt) < REFRESH_MS && !previous.stale) return previous;
        controller = new AbortController();
        const signal = controller.signal;
        try {
          const response = await fetcher(url, {signal, cache: "no-store"});
          const payload = await response.json();
          if (!response.ok || !Array.isArray(payload.elements) || !Number.isFinite(Date.parse(payload.fetchedAt))) {
            throw Error(payload.error || "品牌服务暂时不可用");
          }
          if (token !== sequence) return null;
          cache.delete(key); cache.set(key, payload);
          while (cache.size > 8) cache.delete(cache.keys().next().value);
          return payload;
        } catch (error) {
          if (token !== sequence || signal.aborted) return null;
          if (previous) return {...previous, stale: true, error: error.message};
          throw error;
        } finally {if (token === sequence) controller = null;}
      },
    };
  }
  root.HuayuBrandData = Object.freeze({REFRESH_MS, normalize, matches, aggregate, validateCatalog, place, createStore});
})(globalThis);
