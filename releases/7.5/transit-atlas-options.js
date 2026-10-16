(function (root) {
  "use strict";
  const labels = {existing: "现有", construction: "在建", proposed: "规划"};
  const railTypes = new Set(["rail", "narrow_gauge", "train", "subway", "light_rail", "tram", "monorail", "maglev"]);
  function lifecycle(tags = {}) {
    for (const state of ["construction", "proposed"]) {
      if ([tags.railway, tags.route, tags.state, tags.status, tags["construction:state"]].includes(state)
        || (railTypes.has(tags[state]) || railTypes.has(tags[`${state}:railway`]))
        || tags[state] === "yes") return state;
    }
    return "existing";
  }
  function routeType(tags = {}) {
    if ([tags.construction, tags.proposed, tags["construction:railway"], tags["proposed:railway"]]
      .some(value => ["station", "halt", "platform", "subway_entrance"].includes(value))) return "";
    const value = [tags.route, tags.route_master, tags["construction:route"], tags["proposed:route"],
      tags["construction:railway"], tags["proposed:railway"], tags.construction, tags.proposed, tags.railway]
      .find(value => railTypes.has(value));
    return ["rail", "narrow_gauge", "maglev"].includes(value) ? "train" : value ||
      (["construction", "proposed"].includes(tags.railway) ? "train" : "");
  }
  // This extra network is for display/export only. Never add it to routing.
  function futureNetwork(items, routeInfo) {
    const index = new Map(items.map(item => [`${item.type}/${item.id}`, item]));
    const memberships = new Map(), lines = [], stops = [];
    const visit = (item, route, state, seen) => {
      if (!item) return;
      const key = `${item.type}/${item.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const own = lifecycle(item.tags), effective = own === "existing" ? state : own;
      if (item.type === "relation") {
        for (const member of item.members || []) visit(index.get(`${member.type}/${member.ref}`), route, effective, seen);
      } else if (effective !== "existing") {
        if (!memberships.has(key)) memberships.set(key, []);
        memberships.get(key).push({...route, atlasLifecycle: effective});
      }
    };
    for (const item of items) {
      if (item.type !== "relation" || !["route", "route_master"].includes(item.tags?.type) || !routeType(item.tags)) continue;
      const type = routeType(item.tags), state = lifecycle(item.tags);
      const route = routeInfo({...item, tags: {...item.tags, route: type}});
      visit(item, route, state, new Set());
    }
    for (const item of items) {
      const state = lifecycle(item.tags), key = `${item.type}/${item.id}`;
      let routes = memberships.get(key) || [];
      if (!routes.length && state !== "existing" && item.type === "way" && routeType(item.tags)) {
        const type = routeType(item.tags);
        routes = [{id: `future-way-${item.id}`, identity: `atlas-future:${type}:${item.tags?.name || item.id}`,
          type, label: item.tags?.name || `${labels[state]}${type === "train" ? "铁路" : "轨道"} #${item.id}`,
          color: /^#[0-9a-f]{6}$/iu.test(item.tags?.colour || "") ? item.tags.colour : "#667c87", atlasLifecycle: state}];
      }
      if (!routes.length) continue;
      if (item.type === "way" && railTypes.has(routeType(item.tags))) {
        const geometry = item.geometry || (item.nodes || []).map(id => index.get(`node/${id}`));
        if (geometry.length < 2 || geometry.some(p => !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) continue;
        lines.push({id: `future-${item.id}`, sourceId: item.id, sourceWayIds: [item.id], geometry,
          routes, atlasLifecycle: state === "existing" ? routes[0].atlasLifecycle : state});
      } else if (item.type === "node" && (/^(station|halt|tram_stop|stop)$/u.test(item.tags?.railway || "")
        || item.tags?.public_transport === "station"
        || [item.tags?.construction, item.tags?.proposed].some(value => ["station", "halt", "tram_stop"].includes(value)))) {
        if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) stops.push({id: `future-${item.id}`, sourceId: item.id,
          name: item.tags?.name || "", lat: item.lat, lon: item.lon, routes, isRail: true});
      }
    }
    return {lines, stops};
  }
  function world(coordinate) {
    const latitude = Math.max(-85.051128, Math.min(85.051128, coordinate[1])) * Math.PI / 180;
    return [(coordinate[0] + 180) / 360, (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2];
  }
  function projection(bounds, rect, viewport = {}) {
    const nw = world([bounds.minLon, bounds.maxLat]), se = world([bounds.maxLon, bounds.minLat]);
    const inset = Math.max(16, Math.min(rect.width, rect.height) * 0.055);
    const scale = Math.min((rect.width - inset * 2) / Math.max(1e-10, se[0] - nw[0]),
      (rect.height - inset * 2) / Math.max(1e-10, se[1] - nw[1])) * (Number(viewport.scale) || 1);
    const cx = rect.x + rect.width / 2 + (Number(viewport.offsetX) || 0);
    const cy = rect.y + rect.height / 2 + (Number(viewport.offsetY) || 0);
    return coordinate => {const p = world(coordinate); return [cx + (p[0] - (nw[0] + se[0]) / 2) * scale,
      cy + (p[1] - (nw[1] + se[1]) / 2) * scale];};
  }
  function downloadEntries(collection, cityKey, fetchedAt) {
    return collection.features.filter(f => ["track", "station"].includes(f.properties.feature_type)).map(feature => {
      const p = feature.properties, text = JSON.stringify([cityKey, p.feature_type, p.source_id, p.route_names, p.lifecycle, feature.geometry]);
      // Stable content identity preserves independent selections and deduplicates repeats.
      let hash = 2166136261; for (const c of text) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
      return {derived: true, elements: [], fetchedAt, feature: {...feature, id: `atlas/${(hash >>> 0).toString(16)}-${text.length}`,
        properties: {...p, name: p.name || p.route_names.join(" / "), kind: "railway", derived_geometry: true,
          source: "OpenGeofiction", city: collection.name, tags: {name: p.name || p.route_names.join(" / "),
            "atlas:geometry": "display-export", "atlas:lifecycle": (p.lifecycle || []).join(";"),
            "atlas:attributes": JSON.stringify(p)}}}};
    });
  }
  root.HuayuTransitAtlas = {labels, lifecycle, routeType, futureNetwork, world, projection, downloadEntries};
})(typeof window !== "undefined" ? window : globalThis);
