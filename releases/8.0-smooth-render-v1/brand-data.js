(function (root) {
  "use strict";
  const REFRESH_MS = 120000;
  const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
  const NAME_KEYS = "^(name(:.*)?|official_name|short_name|alt_name)$";
  const FACILITIES = {shop: null, craft: null, office: "^(company|insurance|estate_agent|travel_agent|financial|telecommunication|it|lawyer|accountant|educational_institution|employment_agency)$",
    amenity: "^(bank|atm|bureau_de_change|cafe|restaurant|fast_food|ice_cream|bar|pub|food_court|pharmacy|fuel|charging_station|post_office|car_rental|car_sharing|bicycle_rental|veterinary|cinema|theatre|casino|internet_cafe)$",
    tourism: "^(hotel|motel|hostel|guest_house|apartment)$", healthcare: "^(hospital|clinic|dentist|pharmacy|physiotherapist|optometrist)$",
    leisure: "^(fitness_centre|sports_centre|bowling_alley|amusement_arcade)$"};
  const nameFields = tags => Object.entries(tags).filter(([key, value]) => new RegExp(NAME_KEYS, "u").test(key)
    && typeof value === "string" && value.trim()).flatMap(([field, value]) => (field === "alt_name" ? value.split(";") : [value]).map(value => ({field, value: value.trim()})));
  function namedFacility(tags) {
    return Object.entries(FACILITIES).some(([key, pattern]) => typeof tags[key] === "string"
      && tags[key].trim() && !/^(no|vacant|disused|abandoned|construction|proposed)$/iu.test(tags[key])
      && (!pattern || new RegExp(pattern, "u").test(tags[key])));
  }
  // This selector is shared by live queries and the complete scheduled directory.
  function namedFacilityQuery(type = "nwr", scope = "", pattern = null) {
    const names = `[~${JSON.stringify(NAME_KEYS)}~${JSON.stringify(pattern || ".")}${pattern ? ",i" : ""}]`;
    return `(${Object.entries(FACILITIES).map(([key, values]) => `${type}[!"brand"]${values
      ? `[${JSON.stringify(key)}~${JSON.stringify(values)}]` : `[${JSON.stringify(key)}][${JSON.stringify(key)}!~"^(no|vacant|disused|abandoned|construction|proposed)$"]`}${names}${scope};`).join("")})`;
  }
  const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  function nameQueryPattern(names, exact = false) {
    return `^(${names.map(escapePattern).join("|")})${exact ? "$" : "($|[[:space:]（(·-]|.*(店|支行|分行|营业部|营业厅|分校|分院|branch|store)$)"}`;
  }
  function createMatcher(entries) {
    const index = new Map();
    for (const entry of entries.filter(entry => !entry.candidate)) {
      for (const name of [entry.name, ...(entry.aliases || [])]) {
        const key = normalize(name);
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(entry);
      }
    }
    const category = tags => Object.keys(FACILITIES).filter(key => tags[key]).map(key => `${key}=${tags[key]}`);
    const compatible = (entry, tags) => !entry.categories?.length || entry.categories.some(([key]) => category(tags).includes(key)
      || ["amenity=bank", "amenity=atm"].includes(key) && ["bank", "atm"].includes(tags.amenity));
    return tags => {
      if (!namedFacility(tags)) return null;
      const fields = nameFields(tags), matches = new Map();
      let knownName = false;
      for (const {field, value} of fields) {
        const full = normalize(value);
        for (let end = full.length; end >= 1; end--) {
          const possible = index.get(full.slice(0, end));
          if (!possible) continue;
          const suffix = full.slice(end);
          if (suffix && end < 2) continue;
          if (suffix && !/^(\s|[（(·-])/u.test(suffix)
            && !/^[\p{Script=Han}\p{L}\p{N} ·-]{1,64}(店|支行|分行|营业部|营业厅|分校|分院)$/u.test(suffix)) continue;
          knownName = true;
          if (possible.size !== 1) continue;
          const entry = [...possible][0];
          if (!compatible(entry, tags)) continue;
          matches.set(entry.name, {name: entry.name, source: "name", field, value});
          break;
        }
      }
      if (matches.size === 1) return [...matches.values()][0];
      // Conflicting aliases or categories remain unassigned, rather than merging brands.
      if (matches.size || knownName || !fields.length) return null;
      const field = fields.find(item => item.field === "name") || fields.find(item => item.field === "name:zh") || fields[0];
      return {name: field.value, source: "candidate", field: field.field, value: field.value};
    };
  }
  function recognizeBrands(elements, reference = [], includeNames = true) {
    const tagged = aggregate(elements, "brand"), unique = new Map();
    for (const entry of [...reference, ...tagged]) if (!entry.candidate && !unique.has(entry.name)) unique.set(entry.name, entry);
    const match = createMatcher([...unique.values()]);
    return elements.flatMap(element => {
      const tags = element.tags || {};
      const recognition = typeof tags.brand === "string" && tags.brand.trim()
        ? {name: tags.brand, source: "tag", field: "brand", value: tags.brand} : includeNames ? match(tags) : null;
      return recognition ? [{...element, brandMatch: recognition}] : [];
    });
  }
  const searchText = new WeakMap();
  function entryText(entry) {
    if (!searchText.has(entry)) searchText.set(entry, normalize([entry.name, ...(entry.branches || []), ...(entry.cities || []),
      ...(entry.names || []), ...(entry.aliases || []), ...(entry.brands || []), ...(entry.operators || [])].join(" ")));
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
      const identity = `${element.type}/${element.id}`, tags = element.tags || {}, recognition = kind === "brand" ? element.brandMatch : null,
        name = tags[kind] || recognition?.name;
      if (seen.has(identity) || !["node", "way", "relation"].includes(element.type)
        || !Number.isSafeInteger(element.id) || element.id <= 0 || typeof name !== "string" || !name.trim()) continue;
      seen.add(identity);
      if (!groups.has(name)) groups.set(name, {name, count: 0, types: {}, categories: new Map(),
        operators: new Set(), brands: new Set(), branches: new Set(), cities: new Set(), names: new Set(), aliases: new Set(),
        taggedCount: 0, namedCount: 0, candidateCount: 0, sourceCategories: {tag: new Map(), name: new Map(), candidate: new Map()}});
      const entry = groups.get(name);
      entry.count++;
      entry[recognition?.source === "name" ? "namedCount" : recognition?.source === "candidate" ? "candidateCount" : "taggedCount"]++;
      if (kind === "brand") Object.entries(tags).filter(([key, value]) => /^brand:[a-z]{2,3}(-[a-z]+)?$/iu.test(key)
        && !/^brand:(ref|url|uid|id|tag|key)$/iu.test(key)
        && typeof value === "string" && value.trim()).forEach(([, value]) => entry.aliases.add(value));
      entry.types[element.type] = (entry.types[element.type] || 0) + 1;
      const category = keys.find(key => tags[key]);
      if (category) {
        const key = `${category}=${tags[category]}`;
        entry.categories.set(key, (entry.categories.get(key) || 0) + 1);
        const counts = entry.sourceCategories[recognition?.source || "tag"];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const [field, tag] of [["operators", "operator"], ["brands", "brand"], ["branches", "branch"], ["cities", "addr:city"], ["names", "name"]]) {
        if (typeof tags[tag] === "string" && tags[tag].trim()) entry[field].add(tags[tag]);
      }
    }
    return [...groups.values()].map(entry => ({...entry,
      categories: [...entry.categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
      branchCount: entry.branches.size,
      candidate: entry.candidateCount === entry.count,
      sourceCategories: Object.fromEntries(Object.entries(entry.sourceCategories).map(([source, counts]) => [source, [...counts].sort((a,b) => b[1]-a[1]).slice(0,6)])),
      ...Object.fromEntries(["operators", "brands", "branches", "cities", "names", "aliases"].map(key => [key, [...entry[key]].sort().slice(0, 12)])),
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function filterEntries(entries, source = "all") {
    if (source === "all") return entries;
    const field = {tag: "taggedCount", name: "namedCount", candidate: "candidateCount"}[source];
    return entries.flatMap(entry => {
      const count = entry[field] ?? (source === "tag" ? entry.count : 0);
      return count ? [{...entry, count, taggedCount: source === "tag" ? count : 0, namedCount: source === "name" ? count : 0,
        candidateCount: source === "candidate" ? count : 0, categories: entry.sourceCategories?.[source] || entry.categories}] : [];
    });
  }
  function validateCatalog(value) {
    if (value?.schema !== "huayu-brand-catalog-v1" || !Number.isFinite(Date.parse(value.generatedAt))
      || !["brands", "operators"].every(key => Array.isArray(value[key]) && value[key].length
        && value[key].every(entry => typeof entry.name === "string" && entry.name.trim()
          && Number.isSafeInteger(entry.count) && entry.count > 0 && Array.isArray(entry.categories)
          && entry.categories.every(item => Array.isArray(item) && typeof item[0] === "string"
            && Number.isSafeInteger(item[1]) && item[1] > 0)
          && (["taggedCount", "namedCount", "candidateCount"].every(field => entry[field] === undefined)
            || ["taggedCount", "namedCount", "candidateCount"].every(field => Number.isSafeInteger(entry[field]) && entry[field] >= 0)
              && entry.taggedCount + entry.namedCount + entry.candidateCount === entry.count)
          && (entry.sourceCategories === undefined || entry.sourceCategories && ["tag", "name", "candidate"].every(source =>
            Array.isArray(entry.sourceCategories[source]) && entry.sourceCategories[source].every(item => Array.isArray(item)
              && typeof item[0] === "string" && Number.isSafeInteger(item[1]) && item[1] > 0)))
          && (entry.candidate === undefined || typeof entry.candidate === "boolean" && entry.candidate === (entry.candidateCount === entry.count))
          && ["operators", "brands", "branches", "cities", "names", "aliases"].every(field => entry[field] === undefined
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
  root.HuayuBrandData = Object.freeze({REFRESH_MS, normalize, matches, aggregate, validateCatalog, place, createStore,
    namedFacility, namedFacilityQuery, nameQueryPattern, createMatcher, recognizeBrands, filterEntries});
})(globalThis);
