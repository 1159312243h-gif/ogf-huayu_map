(function installHuayuBridgeModels(root) {
  "use strict";

  const ALGORITHM = "bridge-layer-profile-v4";
  const STORAGE_KEY = "ogf-atlas-bridge-settings-v1";
  const DEFAULTS = Object.freeze({enabled: false});
  const normalize = value => ({enabled: value?.enabled === true});
  let preferences;
  try { preferences = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); }
  catch { preferences = {...DEFAULTS}; }
  function setPreferences(value) {
    preferences = normalize({...preferences, ...value});
    let saved = true;
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
    catch { saved = false; }
    if (root.CustomEvent && root.dispatchEvent) root.dispatchEvent(new root.CustomEvent("huayu-bridge-settings-change",
      {detail: {preferences: {...preferences}, saved}}));
    return saved;
  }
  const LAYER_ID = "ogf-atlas-bridge-models";
  const RULES = Object.freeze({minLength: 100, archLength: 350, minApproach: 50,
    approach: 100, layerHeight: 5, targetGrade: 0.06, maxGrade: 0.08,
    minZoom: 10.5, step: 4, maxModels: 8192, maxSamples: 24000, maxTriangles: 240000});
  const controllers = new WeakMap();
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const distance = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) * Math.PI / 360),
    (b[1] - a[1]) * 111320);
  const interpolate = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];

  function roadWidth(p) {
    const explicit = /^\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet)?\s*$/iu.exec(String(p.width || ""));
    if (explicit) {
      const value = Number(explicit[1]) * (/^(ft|feet)$/iu.test(explicit[2] || "") ? 0.3048 : 1);
      if (value >= 1 && value <= 45) return value;
    }
    const lanes = Number(p.lanes);
    if (Number.isInteger(lanes) && lanes >= 1 && lanes <= 10) return clamp(lanes * 3.25 + 0.8, 3, 35);
    if (/^(footway|path|cycleway|pedestrian|bridleway)$/u.test(p.highway)) return 3;
    if (/_link$/u.test(p.highway)) return 5.5;
    if (/^(motorway|trunk)$/u.test(p.highway)) return p.oneway === "yes" ? 10.5 : 15;
    return /^(primary|secondary|tertiary)$/u.test(p.highway) ? 9 : 6;
  }

  function graph(features) {
    const roads = new Map(), nodes = new Map(), edges = [];
    const ordered = [...(features || [])].sort((a, b) => String(a.properties?.osmId ?? a.id)
      .localeCompare(String(b.properties?.osmId ?? b.id), "en", {numeric: true}));
    for (const feature of ordered) {
      const p = feature.properties || {}, coordinates = feature.geometry?.coordinates;
      // Node IDs are topology. Coincident coordinates or a drawn crossing are
      // insufficient evidence of a junction, including at an interior vertex.
      if (p.renderKind !== "road" || feature.geometry?.type !== "LineString" || !p.highway
        || /^(construction|proposed|steps|raceway|corridor)$/u.test(p.highway)
        || !coordinates?.length || coordinates.length !== p.roadNodes?.length
        || coordinates.some(point => !Array.isArray(point) || point.length < 2
          || !point.slice(0, 2).every(Number.isFinite) || Math.abs(point[1]) > 85 || Math.abs(point[0]) > 180)
        || p.roadNodes.some(id => id === null || id === undefined || String(id) === "")) continue;
      const id = String(p.osmId ?? feature.id);
      if (roads.has(id)) continue;
      const layer = Number(p.layer);
      if (!Number.isFinite(layer) || Math.abs(layer) > 10) continue;
      const level = p.bridge && !p.layerExplicit && layer === 0 ? 1 : layer;
      const road = {id, feature, properties: p, width: roadWidth(p), level, elevated: level > 0 && !p.tunnel,
        tunnel: Boolean(p.tunnel || level < 0), edges: []};
      roads.set(id, road);
      for (let i = 0; i < coordinates.length; i++) {
        const key = String(p.roadNodes[i]), point = coordinates[i];
        if (!nodes.has(key)) nodes.set(key, {key, point, edges: []});
        else if (distance(nodes.get(key).point, point) > 0.3) nodes.get(key).invalid = true;
        if (!i) continue;
        const a = nodes.get(String(p.roadNodes[i - 1])), b = nodes.get(key);
        const length = distance(a.point, b.point);
        if (a === b || length < 0.02) continue;
        const edge = {id: edges.length, segment: i - 1, a, b, length, road};
        edges.push(edge); road.edges.push(edge); a.edges.push(edge); b.edges.push(edge);
      }
    }
    for (const node of [...nodes.values()]) {
      const levels = new Map();
      for (const edge of node.edges) {
        if (!levels.has(edge.road.level)) levels.set(edge.road.level, []); levels.get(edge.road.level).push(edge);
      }
      // A road continuing on both sides of an interior crossing stays on its
      // own layer, even if the source drew both ways with one shared node.
      // A true endpoint/layer transition still has a terminating level group
      // and remains connected. Coordinates alone never create connectivity.
      if (node.invalid || levels.size < 2 || [...levels.values()].some(group => group.length < 2)) continue;
      node.edges = [];
      for (const [level, group] of levels) {
        const split = {...node, key: `${node.key}@layer:${level}`, edges: group}; nodes.set(split.key, split);
        for (const edge of group) { if (edge.a === node) edge.a = split; if (edge.b === node) edge.b = split; }
      }
      nodes.delete(node.key);
    }
    return {roads, nodes, edges};
  }

  const other = (edge, node) => edge.a === node ? edge.b : edge.a;
  const same = (a, b) => a.road.elevated && b.road.elevated && a.road.level === b.road.level
    && Boolean(a.road.properties.bridge) === Boolean(b.road.properties.bridge);

  function chains(network) {
    const seen = new Set(), result = [];
    const continues = (edge, node) => !node.invalid && node.edges.length === 2
      && same(edge, node.edges.find(candidate => candidate !== edge));
    for (const edge of network.edges) {
      if (!edge.road.elevated || seen.has(edge.id)) continue;
      // Find a chain boundary first, so OSM way order and tile order cannot
      // turn one 240 m bridge into two sub-100 m fragments.
      let start = edge.a, cursor = edge, guard = new Set();
      while (continues(cursor, start) && !guard.has(cursor.id)) {
        guard.add(cursor.id); cursor = start.edges.find(candidate => candidate !== cursor);
        start = other(cursor, start);
      }
      // A closed elevated ring is a valid road too. Walk it once from a stable
      // node instead of discarding it because it has no chain boundary.
      if (guard.has(cursor.id)) { start = edge.a; cursor = edge; }
      const parts = [], points = [start.point], vertices = [start];
      let node = start;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id); parts.push(cursor); node = other(cursor, node);
        points.push(node.point); vertices.push(node);
        cursor = continues(cursor, node) ? node.edges.find(candidate => candidate !== cursor) : null;
      }
      result.push({edges: parts, points, vertices, length: parts.reduce((sum, part) => sum + part.length, 0),
        level: edge.road.level});
    }
    return result;
  }

  function approach(chain, atStart) {
    const node = atStart ? chain.vertices[0] : chain.vertices.at(-1);
    const core = new Set(chain.edges);
    const outside = node.edges.filter(edge => !core.has(edge));
    if (node.invalid) return null;
    const anchor = level => ({level, length: 0, points: [node.point], widths: [], anchorKey: `node:${node.key}`,
      junctionKey: outside.some(edge => edge.road.elevated) ? node.key : null});
    // An unloaded continuation is not evidence of a ground landing. Keep the
    // tagged deck height at this endpoint; never invent a road beyond the data.
    if (!outside.length) return anchor(chain.level);
    const levels = new Set(outside.map(edge => edge.road.level));
    // Branches share exactly one height. Ground junctions stay on the ground;
    // transitions are distributed inside the connected elevated network.
    if (levels.size !== 1 || outside.some(edge => edge.road.tunnel))
      return anchor(outside.some(edge => edge.road.level <= 0 || edge.road.tunnel) ? 0
        : Math.max(chain.level, ...levels));
    const level = outside[0].road.level;
    // At a junction between elevated runs, both independently generated decks
    // use the higher shared level. Extending each ramp into the other run would
    // create two conflicting decks on the same piece of road.
    if (level > 0) return anchor(Math.max(level, chain.level));
    // Do not carry a ramp through an ambiguous branch or lift a ground junction.
    if (outside.length !== 1 || node.edges.length !== 2) return anchor(0);
    let current = node, edge = outside[0], length = 0, meetsBridge = false;
    const sections = [], seen = new Set(chain.edges.map(part => part.id));
    while (edge && length < RULES.approach * 2) {
      if (seen.has(edge.id) || edge.road.level !== level || edge.road.tunnel || current.invalid) break;
      seen.add(edge.id);
      const next = other(edge, current);
      if (next.invalid) return null;
      sections.push({a: current.point, b: next.point, length: edge.length, width: edge.road.width,
        edge, forward: current === edge.a});
      length += edge.length; current = next;
      if (current.edges.some(candidate => candidate !== edge && candidate.road.elevated
        && candidate.road.level !== level)) { meetsBridge = true; break; }
      if (current.edges.length !== 2) break;
      edge = current.edges.find(candidate => candidate !== edge);
    }
    // Two bridges sharing a short approach each get half of the available
    // corridor, rather than generating overlapping, incompatible ramps.
    const available = Math.min(RULES.approach, meetsBridge ? length / 2 : length);
    if (available < 0.02) return anchor(0);
    const points = [node.point], widths = [], parts = []; let left = available;
    for (const section of sections) {
      if (left <= 1e-6) break;
      const fraction = Math.min(1, left / section.length);
      points.push(interpolate(section.a, section.b, fraction));
      parts.push({id: section.edge.road.id, segment: section.edge.segment,
        endFraction: section.forward ? fraction : 1 - fraction,
        from: section.forward ? 0 : 1 - fraction, to: section.forward ? fraction : 1});
      widths.push(section.width); left -= section.length;
    }
    const end = parts.at(-1), fraction = end.endFraction;
    return {level, length: available, points, widths, parts,
      anchorKey: fraction < 1e-7 || fraction > 1 - 1e-7
        ? `node:${fraction < 0.5 ? sections[parts.length - 1].edge.a.key : sections[parts.length - 1].edge.b.key}`
        : `cut:${end.id}:${end.segment}:${fraction.toFixed(7)}`};
  }

  function profile(chain, first, last, anchors) {
    const length = first.length + chain.length + last.length;
    const low = anchors?.[0] ?? first.level * RULES.layerHeight, high = anchors?.[1] ?? last.level * RULES.layerHeight;
    const target = Math.max(low, high, chain.level * RULES.layerHeight);
    // Cubic end easing has a maximum derivative of 1.5. Propagating this
    // allowance through connected runs keeps even very short links gradual.
    const grade = RULES.targetGrade / 1.5;
    const top = Math.max(low, high, Math.min(target, (length * grade + low + high) / 2));
    if (Math.abs(low - high) < 1e-6 && top > low && chain.length > RULES.minLength + 1e-6
      && chain.length <= RULES.archLength + 1e-6 && Math.PI * (top - low) / length <= RULES.targetGrade) {
      return {kind: "arch", length, low, high, top,
        height: s => low + (top - low) * Math.sin(Math.PI * clamp(s / length, 0, 1)) ** 2};
    }
    if (Math.abs(low - high) > 1e-6 && chain.length <= RULES.archLength + 1e-6) {
      return {kind: "incline", length, low, high, top,
        height: s => mix(low, high, ease(s / length))};
    }
    let a = top === low ? 0 : Math.max(first.length + Math.min(chain.length / 3, 100), (top - low) / grade);
    let b = top === high ? 0 : Math.max(last.length + Math.min(chain.length / 3, 100), (top - high) / grade);
    if (a + b > length) { a = (top - low) / grade; b = (top - high) / grade; }
    return {kind: chain.length <= RULES.minLength + 1e-6 ? "slopes" : "plateau",
      length, low, high, top, rampA: a, rampB: b,
      height(s) {
        if (a && s < a) return mix(low, top, ease(s / a));
        if (b && s > length - b) return mix(top, high, ease((s - length + b) / b));
        return top;
      }};
  }

  // The lower envelope of endpoint targets under distance constraints. This
  // moves a ramp through multiple short layer fragments instead of deleting
  // the whole interchange or forcing a five-metre step at every boundary.
  function networkAnchors(items) {
    const nodes = new Map(), heap = [];
    const push = entry => { let i = heap.length; heap.push(entry);
      while (i && heap[(i - 1) >> 1].height > entry.height) {
        heap[i] = heap[(i - 1) >> 1]; i = (i - 1) >> 1;
      } heap[i] = entry; };
    for (const item of items) {
      const ends = [item.first, item.last].map(end => {
        if (!nodes.has(end.anchorKey)) nodes.set(end.anchorKey, {height: Infinity, links: []});
        const node = nodes.get(end.anchorKey); node.height = Math.min(node.height, end.level * RULES.layerHeight); return node;
      });
      const limit = (item.first.length + item.chain.length + item.last.length) * RULES.targetGrade / 1.5;
      ends[0].links.push({node: ends[1], limit}); ends[1].links.push({node: ends[0], limit}); item.anchors = ends;
    }
    for (const node of nodes.values()) push({node, height: node.height});
    while (heap.length) {
      const entry = heap[0], tail = heap.pop();
      if (heap.length) { let i = 0; heap[0] = tail;
        while (i * 2 + 1 < heap.length) { let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1].height < heap[child].height) child++;
          if (heap[child].height >= tail.height) break; heap[i] = heap[child]; i = child;
        } heap[i] = tail;
      }
      if (entry.height !== entry.node.height) continue;
      for (const {node, limit} of entry.node.links) if (node.height > entry.height + limit) {
        node.height = entry.height + limit; push({node, height: node.height});
      }
    }
  }

  function prepare(features, bounds, zoom = 18) {
    const network = graph(features), rejected = []; let plans = [];
    let samples = 0;
    // Stable ordering keeps budgets and fallback independent of request order.
    const runs = chains(network).sort((a, b) => a.edges.map(edge => `${edge.road.id}:${edge.id}`).sort()[0]
      .localeCompare(b.edges.map(edge => `${edge.road.id}:${edge.id}`).sort()[0], "en", {numeric: true}));
    // The viewport selects connected elevated components, not isolated pieces.
    // Otherwise moving an endpoint just beyond the viewport could invalidate
    // a perfectly complete bridge that was already loaded in the road source.
    const selected = new Set(), edgeRuns = new Map();
    for (const chain of runs) for (const edge of chain.edges) edgeRuns.set(edge.id, chain);
    const items = [];
    for (const chain of runs) {
      const xs = chain.points.map(p => p[0]), ys = chain.points.map(p => p[1]);
      if (!bounds || Math.max(...xs) >= bounds.west && Math.min(...xs) <= bounds.east
        && Math.max(...ys) >= bounds.south && Math.min(...ys) <= bounds.north) selected.add(chain);
    }
    for (const chain of selected) for (const node of [chain.vertices[0], chain.vertices.at(-1)]) {
      for (const edge of node.edges) if (edgeRuns.has(edge.id)) selected.add(edgeRuns.get(edge.id));
    }
    for (const chain of runs) {
      const ids = [...new Set(chain.edges.map(edge => edge.road.id))].sort();
      const reject = reason => rejected.push({ids, reason});
      if (!selected.has(chain)) continue;
      if (chain.vertices.some(node => node.invalid)) { reject("invalid-topology"); continue; }
      const first = approach(chain, true), last = approach(chain, false);
      if (!first || !last) { reject("missing-or-short-approach"); continue; }
      items.push({chain, first, last, ids});
    }
    networkAnchors(items);
    const totalLength = items.reduce((sum, {chain, first, last}) => sum + chain.length + first.length + last.length, 0);
    // Wider views retain every road with coarser sections and no tiny rails.
    // All original vertices and topology boundaries are still preserved.
    const sectionBudget = Math.min(RULES.maxSamples, RULES.maxTriangles / (zoom >= 17 ? 46 : 20));
    const step = Math.max(RULES.step, zoom < 15 ? 20 : zoom < 17 ? 10 : RULES.step,
      totalLength / Math.max(500, sectionBudget - network.edges.length - items.length * 4));
    for (const {chain, first, last, ids, anchors} of items) {
      const reject = reason => rejected.push({ids, reason});
      const shape = profile(chain, first, last, anchors.map(node => node.height));
      const points = [...first.points.slice().reverse(), ...chain.points.slice(1), ...last.points.slice(1)];
      const widths = [...first.widths.slice().reverse(), ...chain.edges.map(edge => edge.road.width), ...last.widths];
      const coreParts = chain.edges.map(edge => ({id: edge.road.id, segment: edge.segment, from: 0, to: 1}));
      const parts = [...(first.parts || []).slice().reverse(), ...coreParts, ...(last.parts || [])];
      const path = []; let s = 0;
      for (let i = 1; i < points.length; i++) {
        const length = distance(points[i - 1], points[i]);
        const count = Math.max(1, Math.ceil(length / step));
        for (let j = 0; j < count; j++) {
          const along = s + length * j / count;
          const coordinate = interpolate(points[i - 1], points[i], j / count), part = parts[i - 1];
          const source = network.roads.get(part.id).feature.geometry.coordinates;
          path.push({coordinate, s: along, sourceSegment: part.segment,
            fraction: distance(source[part.segment], coordinate) / distance(source[part.segment], source[part.segment + 1]),
            height: shape.height(along), width: widths[i - 1], roadId: parts[i - 1].id,
            core: along >= first.length && along <= first.length + chain.length});
        }
        s += length;
      }
      path.push({coordinate: points.at(-1), s, height: shape.height(s), width: widths.at(-1),
        roadId: parts.at(-1).id, core: last.length === 0, sourceSegment: parts.at(-1).segment,
        fraction: distance(network.roads.get(parts.at(-1).id).feature.geometry.coordinates[parts.at(-1).segment], points.at(-1))
          / distance(network.roads.get(parts.at(-1).id).feature.geometry.coordinates[parts.at(-1).segment],
            network.roads.get(parts.at(-1).id).feature.geometry.coordinates[parts.at(-1).segment + 1])});
      let grade = 0;
      for (let i = 1; i < path.length; i++) grade = Math.max(grade,
        Math.abs(path[i].height - path[i - 1].height) / (path[i].s - path[i - 1].s));
      if (grade > RULES.maxGrade + 1e-6) { reject("grade-over-8-percent"); continue; }
      if (plans.length >= RULES.maxModels || samples + path.length > RULES.maxSamples) { reject("budget"); continue; }
      samples += path.length;
      plans.push({ids, kind: shape.kind, level: chain.level, length: chain.length,
        approachLengths: [first.length, last.length], endpointLayers: [first.level, last.level],
        anchorKeys: [first.anchorKey, last.anchorKey],
        junctionKeys: [first.junctionKey || null, last.junctionKey || null],
        endConnections: [chain.vertices[0], chain.vertices.at(-1)].map(node => ({coordinate: node.point,
          roads: [...new Set(node.edges.filter(edge => !chain.edges.includes(edge)).map(edge => edge.road.id))]})),
        requiredEdges: [...new Set([chain.vertices[0], chain.vertices.at(-1)].flatMap(node => node.edges
          .filter(edge => edge.road.elevated && !chain.edges.includes(edge)).map(edge => edge.id)))], parts,
        rampLengths: [shape.rampA || 0, shape.rampB || 0], samples: path,
        highway: chain.edges[0].road.properties.highway, edgeIds: chain.edges.map(edge => edge.id)});
    }
    // If an approach reaches a ground fork before 100 m, allow the slope to
    // continue down every real branch. Pinning that fork to zero would make
    // otherwise valid short ramps impossible, or leave the side road detached.
    const groundDistance = new Map(), queue = [];
    for (const {chain} of items) for (const node of [chain.vertices[0], chain.vertices.at(-1)])
      if (node.edges.some(edge => !edge.road.elevated && !edge.road.tunnel)) {
        groundDistance.set(node, 0); queue.push(node);
      }
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], start = groundDistance.get(node);
      for (const edge of node.edges) {
        if (edge.road.elevated || edge.road.tunnel) continue;
        const end = other(edge, node), next = start + edge.length;
        if (next < RULES.approach && next < (groundDistance.get(end) ?? Infinity)) {
          groundDistance.set(end, next); queue.push(end);
        }
      }
    }
    const cuts = new Map();
    for (const part of plans.flatMap(plan => plan.parts)) {
      const key = `${part.id}:${part.segment}`;
      if (!cuts.has(key)) cuts.set(key, []); cuts.get(key).push([part.from, part.to]);
    }
    for (const edge of network.edges) {
      if (edge.road.elevated || edge.road.tunnel || edge.a.invalid || edge.b.invalid) continue;
      const key = `${edge.road.id}:${edge.segment}`, intervals = [];
      const a = (RULES.approach - (groundDistance.get(edge.a) ?? Infinity)) / edge.length;
      const b = (RULES.approach - (groundDistance.get(edge.b) ?? Infinity)) / edge.length;
      if (a > 0) intervals.push([0, Math.min(1, a)]);
      if (b > 0) intervals.push([Math.max(0, 1 - b), 1]);
      intervals.sort((a, b) => a[0] - b[0]);
      if (intervals.length === 2 && intervals[0][1] >= intervals[1][0]) intervals.splice(0, 2, [0, 1]);
      let rest = intervals;
      for (const [from, to] of cuts.get(key) || []) rest = rest.flatMap(([a, b]) => to <= a || from >= b ? [[a, b]]
        : [[a, Math.min(b, from)], [Math.max(a, to), b]].filter(([a, b]) => b - a > 1e-7));
      for (const [from, to] of rest) {
        const length = (to - from) * edge.length, count = Math.max(1, Math.ceil(length / step));
        if (length < 0.02 || plans.length >= RULES.maxModels || samples + count + 1 > RULES.maxSamples) continue;
        const anchor = fraction => fraction < 1e-7 ? `node:${edge.a.key}` : fraction > 1 - 1e-7 ? `node:${edge.b.key}`
          : `cut:${edge.road.id}:${edge.segment}:${fraction.toFixed(7)}`;
        const path = Array.from({length: count + 1}, (_, i) => ({coordinate: interpolate(edge.a.point, edge.b.point, mix(from, to, i / count)),
          fraction: mix(from, to, i / count), s: length * i / count, height: 0, width: edge.road.width,
          roadId: edge.road.id, sourceSegment: edge.segment, core: false}));
        plans.push({ids: [edge.road.id], kind: "ground-ramp", level: 0, length, approachLengths: [0, 0], endpointLayers: [0, 0],
          anchorKeys: [anchor(from), anchor(to)], junctionKeys: [from < 1e-7 ? edge.a.key : null, to > 1 - 1e-7 ? edge.b.key : null],
          requiredEdges: [], edgeIds: [`ground:${key}:${from}:${to}`], rampLengths: [0, 0], samples: path,
          parts: [{id: edge.road.id, segment: edge.segment, from, to}]});
        samples += path.length;
      }
    }
    const joins = new Map();
    for (const plan of plans) for (const key of plan.anchorKeys) {
      if (!joins.has(key)) joins.set(key, []); joins.get(key).push(plan);
    }
    for (const plan of plans) plan.groundFixed = plan.anchorKeys.map((key, index) => {
      const neighbors = joins.get(key);
      const node = key.startsWith("node:") ? network.nodes.get(key.slice(5)) : null;
      const flexible = node && neighbors.length > 1 && node.edges.every(edge => !edge.road.tunnel
        && neighbors.some(plan => plan.parts.some(part => part.id === edge.road.id && part.segment === edge.segment
          && (node === edge.a ? part.from < 1e-7 : part.to > 1 - 1e-7))));
      if (flexible) plan.requiredEdges.push(...neighbors.filter(other => other !== plan).flatMap(other => other.edgeIds));
      return plan.endpointLayers[index] === 0 && !flexible;
    });
    plans = completePlans(plans, rejected);
    const usedRoads = new Set(plans.flatMap(plan => plan.parts.map(part => part.id)));
    const sourceRoads = [...network.roads.values()].filter(road => usedRoads.has(road.id)).map(road => road.feature);
    const inventory = {roads: network.roads.size,
      missingTopology: (features || []).filter(feature => feature.properties?.renderKind === "road"
        && (feature.properties.bridge || Number(feature.properties.layer) > 0)
        && (!Array.isArray(feature.properties.roadNodes) || feature.properties.roadNodes.length !== feature.geometry?.coordinates?.length
          || feature.properties.roadNodes.some(id => id === null || id === undefined || String(id) === ""))).length,
      elevated: new Set(network.edges.filter(edge => edge.road.elevated)
      .map(edge => edge.road.id)).size, runs: selected.size};
    // Candidate piers avoid the actual footprint of other roads, even if those
    // roads cross without a shared OSM node. Use a grid instead of all-pairs.
    if (!plans.length) return {algorithm: ALGORITHM, plans, rejected, sourceRoads, inventory};
    const cells = new Map(), origin = plans[0].samples[0].coordinate;
    const sx = 111320 * Math.cos(origin[1] * Math.PI / 180);
    const local = p => [(p[0] - origin[0]) * sx, (p[1] - origin[1]) * 111320];
    const key = (x, y) => `${x},${y}`;
    for (const edge of network.edges) {
      if (edge.road.tunnel) continue;
      const a = local(edge.a.point), b = local(edge.b.point), pad = edge.road.width / 2 + 5;
      // Long diagonals are sampled along their line, not their whole bounding box.
      const n = Math.max(1, Math.ceil(edge.length / 35)), entry = {edge, a, b, pad};
      for (let i = 0; i <= n; i++) {
        const x = Math.floor(mix(a[0], b[0], i / n) / 50), y = Math.floor(mix(a[1], b[1], i / n) / 50);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const cell = key(x + dx, y + dy);
          if (!cells.has(cell)) cells.set(cell, new Set()); cells.get(cell).add(entry);
        }
      }
    }
    for (const plan of plans) {
      const own = new Set(plan.ids); let previous = -Infinity;
      for (const sample of plan.samples) {
        if (!sample.core) continue;
        const p = local(sample.coordinate), nearby = cells.get(key(Math.floor(p[0] / 50), Math.floor(p[1] / 50))) || [];
        let blocked = false;
        for (const {edge, a, b, pad} of nearby) {
          if (own.has(edge.road.id)) continue;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy), 0, 1);
          const gap = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
          if (gap < pad) blocked = true;
        }
        if (!blocked && sample.s - plan.approachLengths[0] >= 20
          && plan.length + plan.approachLengths[0] - sample.s >= 20 && sample.s - previous >= 45) {
          sample.pier = true; previous = sample.s;
        }
      }
      // Clearance is checked at actual centreline intersections. Merely being
      // close to a merging/parallel ramp is not a bridge crossing. Insert the
      // intersection into the profile so coarse overview sections cannot miss it.
      const expanded = [];
      for (let i = 1; i < plan.samples.length; i++) {
        const first = plan.samples[i - 1], last = plan.samples[i]; expanded.push(first);
        if (!first.core || !last.core) continue;
        const a = local(first.coordinate), b = local(last.coordinate), rx = b[0] - a[0], ry = b[1] - a[1];
        const nearby = cells.get(key(Math.floor((a[0] + b[0]) / 100), Math.floor((a[1] + b[1]) / 100))) || [];
        const inserts = [];
        for (const {edge, a: c, b: d} of nearby) {
          if (own.has(edge.road.id) || edge.road.level >= plan.level) continue;
          const sx = d[0] - c[0], sy = d[1] - c[1], det = rx * sy - ry * sx;
          if (Math.abs(det) < 1e-8) continue;
          const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / det;
          const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / det;
          if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) continue;
          const coordinate = interpolate(first.coordinate, last.coordinate, clamp(t, 0, 1));
          const shared = [edge.a, edge.b].some(node => plan.junctionKeys.includes(node.key) && distance(node.point, coordinate) < 0.5);
          const merging = plan.endConnections?.some(end => end.roads.includes(edge.road.id)
            && distance(end.coordinate, coordinate) < Math.max(12, edge.road.width + first.width));
          if (shared || merging) continue;
          const sample = {...first, coordinate, s: mix(first.s, last.s, t), height: mix(first.height, last.height, t),
            fraction: mix(first.fraction, first.sourceSegment === last.sourceSegment && first.roadId === last.roadId
              ? last.fraction : distance(network.roads.get(first.roadId).feature.geometry.coordinates[first.sourceSegment], last.coordinate)
                / distance(network.roads.get(first.roadId).feature.geometry.coordinates[first.sourceSegment],
                  network.roads.get(first.roadId).feature.geometry.coordinates[first.sourceSegment + 1]), t),
            pier: false, crossingLevel: edge.road.level,
            crossing: {roadId: edge.road.id, segment: edge.segment, fraction: clamp(u, 0, 1)}};
          inserts.push(sample);
        }
        for (const sample of inserts.sort((a, b) => a.s - b.s)) {
          const previous = expanded.at(-1);
          if (sample.s - previous.s > 1e-5 && last.s - sample.s > 1e-5) expanded.push(sample);
          else Object.assign(sample.s - previous.s <= 1e-5 ? previous : last,
            {crossingLevel: sample.crossingLevel, crossing: sample.crossing, pier: false});
        }
      }
      expanded.push(plan.samples.at(-1)); plan.samples = expanded;
    }
    const spans = new Map();
    for (const plan of plans) for (let i = 1; i < plan.samples.length; i++) {
      const a = plan.samples[i - 1], b = plan.samples[i], source = network.roads.get(a.roadId).feature.geometry.coordinates;
      const length = distance(source[a.sourceSegment], source[a.sourceSegment + 1]);
      const end = distance(source[a.sourceSegment], b.coordinate) / length, key = `${a.roadId}:${a.sourceSegment}`;
      if (!spans.has(key)) spans.set(key, []); spans.get(key).push({plan, a, b, end});
    }
    const heightKey = (plan, sample) => sample.s < 1e-5 ? plan.anchorKeys[0]
      : plan.length + plan.approachLengths[0] + plan.approachLengths[1] - sample.s < 1e-5 ? plan.anchorKeys[1]
        : `road:${sample.roadId}:${sample.sourceSegment}:${sample.fraction.toFixed(7)}`;
    for (const plan of plans) for (const sample of [...plan.samples]) {
      if (!sample.crossing) continue;
      const cross = sample.crossing, span = (spans.get(`${cross.roadId}:${cross.segment}`) || []).find(({a, end}) =>
        cross.fraction >= Math.min(a.fraction, end) - 1e-6 && cross.fraction <= Math.max(a.fraction, end) + 1e-6);
      if (!span) continue;
      const {plan: lowerPlan, a, b, end} = span, t = clamp((cross.fraction - a.fraction) / (end - a.fraction), 0, 1);
      let lower = t < 1e-6 ? a : t > 1 - 1e-6 ? b : null;
      if (!lower) {
        lower = {...a, coordinate: sample.coordinate, s: mix(a.s, b.s, t), height: mix(a.height, b.height, t),
          fraction: cross.fraction, pier: false};
        delete lower.crossing; delete lower.crossingLevel;
        lowerPlan.samples.push(lower);
      }
      cross.lowerKey = heightKey(lowerPlan, lower);
    }
    for (const plan of plans) {
      plan.samples.sort((a, b) => a.s - b.s);
      const unique = [];
      for (const sample of plan.samples) {
        if (unique.length && sample.s - unique.at(-1).s < 1e-5) {
          if (sample.crossing) Object.assign(unique.at(-1), {crossing: sample.crossing, crossingLevel: sample.crossingLevel});
        } else unique.push(sample);
      }
      plan.samples = unique;
      for (const sample of unique) sample.heightKey = heightKey(plan, sample);
    }
    return {algorithm: ALGORITHM, plans, rejected, sourceRoads, inventory};
  }

  function deckHeights(prepared, elevations) {
    const nodes = new Map(), rows = [];
    prepared.plans.forEach((plan, index) => {
      const ground = elevations[index];
      if (!ground || ground.length !== plan.samples.length || !ground.every(Number.isFinite)) { rows.push(null); return; }
      const total = plan.samples.at(-1).s;
      const row = plan.samples.map((sample, i) => {
        const key = sample.heightKey || `${index}:${i}`;
        if (!nodes.has(key)) nodes.set(key, {height: -Infinity, links: [], queued: false, updates: 0});
        const node = nodes.get(key), z = mix(ground[0], ground.at(-1), ease(sample.s / total)) + sample.height + 0.045;
        node.height = Math.max(node.height, z);
        if (i === 0 && (plan.groundFixed?.[0] ?? plan.endpointLayers[0] === 0)
          || i === plan.samples.length - 1 && (plan.groundFixed?.[1] ?? plan.endpointLayers[1] === 0))
          node.fixed = ground[i] + 0.045;
        if (sample.crossing && !sample.crossing.lowerKey)
          node.height = Math.max(node.height, ground[i] + sample.crossingLevel * RULES.layerHeight + 2.55);
        return node;
      });
      for (let i = 1; i < row.length; i++) {
        const limit = (plan.samples[i].s - plan.samples[i - 1].s) * 0.075;
        row[i - 1].links.push({node: row[i], gain: -limit}); row[i].links.push({node: row[i - 1], gain: -limit});
      }
      rows.push(row);
    });
    prepared.plans.forEach((plan, index) => {
      if (!rows[index]) return;
      plan.samples.forEach((sample, i) => {
        const lower = nodes.get(sample.crossing?.lowerKey);
        if (lower && lower !== rows[index][i]) lower.links.push({node: rows[index][i], gain: 2.5});
      });
    });
    // Propagate clearance and slope through the same connected height graph.
    // Ground landings remain fixed. A genuinely impossible input is checked
    // below and retains its original road instead of creating a cliff.
    const parent = node => {
      let root = node; while (root.parent !== root) root = root.parent;
      while (node.parent !== node) { const next = node.parent; node.parent = root; node = next; }
      return root;
    };
    for (const node of nodes.values()) { node.parent = node; node.back = []; node.cap = node.fixed ?? Infinity; }
    for (const node of nodes.values()) if (node.fixed === undefined) for (const {node: next} of node.links)
      if (next.fixed === undefined) { const a = parent(node), b = parent(next); if (a !== b) b.parent = a; }
    for (const node of nodes.values()) for (const {node: next, gain} of node.links) next.back.push({node, cost: -gain});
    const invalid = new Set();
    // First propagate the space available before fixed landings, including
    // backwards through crossings. A lower ramp may need to descend sooner;
    // only pushing every road upwards needlessly makes such networks fail.
    const caps = [...nodes.values()].filter(node => node.fixed !== undefined);
    caps.forEach(node => { node.queued = true; });
    for (let i = 0; i < caps.length; i++) {
      const current = caps[i]; current.queued = false;
      const component = parent(current);
      if (invalid.has(component)) continue;
      if (current.updates++ > 64) { invalid.add(component); continue; }
      for (const {node, cost} of current.back) {
        const cap = current.cap + cost;
        if (node.fixed !== undefined || cap >= node.cap - 1e-7) continue;
        node.cap = cap;
        if (!node.queued) { node.queued = true; caps.push(node); }
      }
    }
    for (const node of nodes.values()) { node.height = Math.min(node.height, node.cap); node.updates = 0; }
    const queue = [...nodes.values()]; queue.forEach(node => { node.queued = true; if (node.fixed !== undefined) node.height = node.fixed; });
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]; current.queued = false;
      const component = parent(current);
      if (invalid.has(component)) continue;
      // Contradictory source constraints are local to this connected ramp
      // component. Never discard every independent bridge in a city view.
      if (current.updates++ > 64) { invalid.add(component); continue; }
      for (const {node, gain} of current.links) {
        const height = current.height + gain;
        if (node.fixed !== undefined || height <= node.height + 1e-7) continue;
        node.height = height;
        if (!node.queued) { node.queued = true; queue.push(node); }
      }
    }
    return rows.map(row => row && !row.some(node => invalid.has(parent(node))) ? row.map(node => node.height) : null);
  }

  function completePlans(plans, rejected, unneeded = new Set()) {
    while (true) {
      const covered = new Set(plans.flatMap(item => (item.plan || item).edgeIds));
      const next = plans.filter(item => ((item.plan || item).requiredEdges || []).every(id => covered.has(id) || unneeded.has(id)));
      if (next.length === plans.length) return plans;
      for (const item of plans) if (!next.includes(item)) rejected.push({ids: (item.plan || item).ids,
        reason: "incomplete-elevated-connection"});
      plans = next;
    }
  }

  // Subtract only the successfully modeled intervals, including partial ground
  // approaches. The rest of a long way and unrelated underpasses stay intact.
  function remainder(sourceRoads, plans) {
    const cuts = new Map();
    for (const part of plans.flatMap(plan => plan.parts || [])) {
      if (!cuts.has(part.id)) cuts.set(part.id, new Map());
      const segments = cuts.get(part.id);
      if (!segments.has(part.segment)) segments.set(part.segment, []);
      segments.get(part.segment).push([part.from, part.to]);
    }
    const features = [];
    for (const road of sourceRoads || []) {
      const id = String(road.properties.osmId ?? road.id), segments = cuts.get(id);
      if (!segments) continue;
      let line = [];
      const flush = () => {
        if (line.length > 1) features.push({type: "Feature", properties: {...road.properties},
          geometry: {type: "LineString", coordinates: line}});
        line = [];
      };
      const coordinates = road.geometry.coordinates;
      for (let i = 1; i < coordinates.length; i++) {
        const ranges = [...(segments.get(i - 1) || [])].sort((a, b) => a[0] - b[0]);
        let cursor = 0;
        const keep = (from, to) => {
          if (to - from < 1e-8) return;
          const a = interpolate(coordinates[i - 1], coordinates[i], from);
          const b = interpolate(coordinates[i - 1], coordinates[i], to);
          if (!line.length) line.push(a);
          else if (distance(line.at(-1), a) > 0.001) { flush(); line.push(a); }
          line.push(b);
        };
        for (const [from, to] of ranges) {
          keep(cursor, from); flush(); cursor = Math.max(cursor, to);
        }
        keep(cursor, 1);
      }
      flush();
    }
    return {hideIds: [...cuts.keys()].sort(), remainder: {type: "FeatureCollection", features}};
  }

  const rgb = value => {
    if (Array.isArray(value)) return value;
    const hex = /^#([\da-f]{6})$/iu.exec(String(value));
    if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255);
    const css = /^rgba?\(([^)]+)\)$/u.exec(String(value));
    return css ? css[1].split(",").slice(0, 3).map(v => Number(v.trim()) / 255) : [0.8, 0.8, 0.8];
  };
  function styleValue(expression, properties, zoom) {
    if (!Array.isArray(expression)) return expression;
    const [op, ...args] = expression, value = item => styleValue(item, properties, zoom);
    if (op === "zoom") return zoom;
    if (op === "get") return properties[args[0]];
    if (op === "literal") return args[0];
    if (op === "match") {
      const input = value(args[0]);
      for (let i = 1; i < args.length - 1; i += 2) {
        if (Array.isArray(args[i]) ? args[i].includes(input) : args[i] === input) return value(args[i + 1]);
      }
      return value(args.at(-1));
    }
    if (op === "interpolate") {
      const input = value(args[1]), base = args[0][0] === "exponential" ? args[0][1] : 1;
      if (input <= args[2]) return value(args[3]);
      for (let i = 4; i < args.length; i += 2) if (input <= args[i]) {
        const t = base === 1 ? (input - args[i - 2]) / (args[i] - args[i - 2])
          : (base ** (input - args[i - 2]) - 1) / (base ** (args[i] - args[i - 2]) - 1);
        const a = value(args[i - 1]), b = value(args[i + 1]);
        return typeof a === "number" ? mix(a, b, t) : rgb(a).map((c, j) => mix(c, rgb(b)[j], t));
      }
      return value(args.at(-1));
    }
    throw new Error(`Unsupported road style expression: ${op}`);
  }

  function mercator(point) {
    const latitude = point[1] * Math.PI / 180;
    return [(point[0] + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2,
      1 / (40075016.68557849 * Math.cos(latitude))];
  }

  function convexHull(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = values => { const result = [];
      for (const p of values) { while (result.length > 1 && cross(result.at(-2), result.at(-1), p) <= 0) result.pop(); result.push(p); }
      return result;
    };
    return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
  }

  function geometry(prepared, elevations, night = false, style = {}) {
    const origin = prepared.plans[0]?.samples[0]?.coordinate || [0, 0], [ox, oy, scale] = mercator(origin);
    const positions = [], colors = [], accepted = [], rejected = [...prepared.rejected], junctions = new Map();
    const concrete = night ? [0.27, 0.30, 0.32] : [0.61, 0.64, 0.63];
    const properties = new Map((prepared.sourceRoads || []).map(road => [String(road.properties.osmId ?? road.id), road.properties]));
    const zoom = style.zoom ?? 18;
    const paintCache = new Map();
    const paint = (sample, name, fallback) => {
      const key = `${sample.roadId}:${name}`;
      if (!paintCache.has(key)) paintCache.set(key, styleValue(style[name] ?? fallback, properties.get(sample.roadId) || {}, zoom));
      return paintCache.get(key);
    };
    const triangle = (a, b, c, color) => { positions.push(...a, ...b, ...c); colors.push(...color, ...color, ...color); };
    const quad = (a, b, c, d, color) => { triangle(a, b, c, color); triangle(a, c, d, color); };
    const solid = (a, b, c, d, depth, color, side = concrete, top = true) => {
      const down = p => [p[0], p[1], p[2] - depth];
      const aa = down(a), bb = down(b), cc = down(c), dd = down(d);
      if (top) quad(a, b, c, d, color);
      quad(dd, cc, bb, aa, side);
      quad(a, aa, bb, b, side); quad(b, bb, cc, c, side);
      quad(c, cc, dd, d, side); quad(d, dd, aa, a, side);
    };
    let candidates = []; const unneeded = new Set();
    const solved = deckHeights(prepared, elevations);
    const crossingHeights = new Map();
    prepared.plans.forEach((plan, index) => plan.samples.forEach((sample, i) => {
      if (solved[index]) crossingHeights.set(sample.heightKey, solved[index][i]);
    }));
    prepared.plans.forEach((plan, index) => {
      const ground = elevations[index];
      if (!ground || ground.length !== plan.samples.length || !ground.every(Number.isFinite)) {
        rejected.push({ids: plan.ids, reason: "terrain-not-ready"}); return;
      }
      const total = plan.samples.at(-1).s;
      // Bridge decks span terrain; they must not copy every bump of the ground
      // below them. The two actual terrain anchors are kept exactly.
      const heights = solved[index];
      if (!heights || !heights.every(Number.isFinite)) { rejected.push({ids: plan.ids, reason: "terrain-clearance-or-grade"}); return; }
      if (plan.kind === "ground-ramp" && heights.every((z, i) => Math.abs(z - ground[i] - 0.045) < 0.02)) {
        plan.edgeIds.forEach(id => unneeded.add(id)); return;
      }
      let maxGrade = 0;
      for (let i = 1; i < heights.length; i++) maxGrade = Math.max(maxGrade,
        Math.abs(heights[i] - heights[i - 1]) / (plan.samples[i].s - plan.samples[i - 1].s));
      if (maxGrade > RULES.maxGrade + 1e-6 || heights.some((z, i) => z < ground[i] - 0.1
        || Number.isFinite(plan.samples[i].crossingLevel)
          && z + 1e-5 < (crossingHeights.get(plan.samples[i].crossing?.lowerKey)
            ?? ground[i] + plan.samples[i].crossingLevel * RULES.layerHeight) + 2.5)) {
        rejected.push({ids: plan.ids, reason: "terrain-clearance-or-grade"}); return;
      }
      const path = plan.samples.map((sample, i) => {
        const [x, y, unit] = mercator(sample.coordinate), ratio = unit / scale;
        return {x: (x - ox) / scale, y: -(y - oy) / scale, z: heights[i] * ratio,
          ground: ground[i] * ratio, ratio, sample};
      });
      const edges = [];
      for (let i = 0; i < path.length; i++) {
        const p = path[i], a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
        const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        const n1 = la ? [-ay / la, ax / la] : [-by / lb, bx / lb];
        const n2 = lb ? [-by / lb, bx / lb] : n1;
        const nl = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
        const normal = nl > 0.1 ? [(n1[0] + n2[0]) / nl, (n1[1] + n2[1]) / nl] : n2;
        const miter = Math.min(1.7, 1 / Math.max(0.2, normal[0] * n2[0] + normal[1] * n2[1]));
        const metersPerPixel = 40075016.68557849 * Math.cos(p.sample.coordinate[1] * Math.PI / 180) / (512 * 2 ** zoom);
        const surfacePx = paint(p.sample, "surfaceWidth", 9), casingPx = paint(p.sample, "casingWidth", 12);
        const groundWidth = casingPx * metersPerPixel;
        const join = plan.kind === "ground-ramp" ? 0 : Math.min(plan.groundFixed?.[0] ? ease(p.sample.s / 35) : 1,
          plan.groundFixed?.[1] ? ease((total - p.sample.s) / 35) : 1);
        const deckWidth = (p.sample.width + (a.sample.width || p.sample.width)) / 2;
        const width = mix(groundWidth, zoom < 17 ? Math.max(groundWidth, deckWidth) : deckWidth, join) * p.ratio;
        const at = (offset, raise = 0) => [p.x + normal[0] * miter * offset,
          p.y + normal[1] * miter * offset, p.z + raise * p.ratio];
        const surfaceWidth = width * clamp(surfacePx / Math.max(casingPx, surfacePx, 0.001), 0, 1);
        edges.push({left: at(width / 2), right: at(-width / 2), at, width, surfaceWidth, p,
          color: rgb(paint(p.sample, "surfaceColor", night ? "#485256" : "#f3f6f2")),
          casing: rgb(paint(p.sample, "casingColor", night ? "#313d40" : "#aebbb5"))});
      }
      const detailed = zoom >= 17;
      const estimate = (path.length - 1) * (detailed ? 42 : 18) + path.filter(p => p.sample.pier).length * 12;
      candidates.push({plan, path, edges, estimate, maxGrade, heights});
    });
    // Reject invalid connected components before tessellating; the previous
    // path repeatedly generated and discarded the same complete meshes.
    candidates = completePlans(candidates, rejected, unneeded);
    let estimatedTriangles = 0;
    candidates = completePlans(candidates.filter(candidate => {
      if (estimatedTriangles + candidate.estimate > RULES.maxTriangles) {
        rejected.push({ids: candidate.plan.ids, reason: "mesh-budget"}); return false;
      }
      estimatedTriangles += candidate.estimate; return true;
    }), rejected, unneeded);
    for (const {plan, path, edges, maxGrade, heights} of candidates) {
      const total = plan.samples.at(-1).s;
      for (const [index, key] of (plan.junctionKeys || []).entries()) if (key) {
        const edge = index ? edges.at(-1) : edges[0];
        if (!junctions.has(key)) junctions.set(key, []);
        junctions.get(key).push({edge});
      }
      for (let i = 1; i < edges.length; i++) {
        const a = edges[i - 1], b = edges[i], ratio = (a.p.ratio + b.p.ratio) / 2;
        const lift = Math.max(0, Math.min(a.p.z - a.p.ground, b.p.z - b.p.ground));
        solid(a.left, a.right, b.right, b.left, Math.min(0.5 * ratio, lift), a.casing, concrete, false);
        // An unlit top keeps exactly the ground road's sRGB paint. The edge
        // strip uses that road's own casing instead of a separate white rail.
        quad(a.at(a.surfaceWidth / 2), a.at(-a.surfaceWidth / 2),
          b.at(-b.surfaceWidth / 2), b.at(b.surfaceWidth / 2), a.color);
        quad(a.left, a.at(a.surfaceWidth / 2), b.at(b.surfaceWidth / 2), b.left, a.casing);
        quad(a.at(-a.surfaceWidth / 2), a.right, b.right, b.at(-b.surfaceWidth / 2), a.casing);
        for (const sign of (zoom >= 17 ? [-1, 1] : [])) {
          // Low parapets taper at ground joins; supports and bridge sides remain
          // separate from the terrain, with an open passage under the deck.
          const rail = edge => 0.25 * clamp((edge.p.z - edge.p.ground - 0.045 * edge.p.ratio) / (0.9 * edge.p.ratio), 0, 1)
            * (plan.junctionKeys?.[0] ? clamp(edge.p.sample.s / 12, 0, 1) : 1)
            * (plan.junctionKeys?.[1] ? clamp((total - edge.p.sample.s) / 12, 0, 1) : 1);
          const railA = rail(a), railB = rail(b);
          if (railA < 0.08 && railB < 0.08) continue;
          solid(a.at(sign * a.width / 2, railA), a.at(sign * (a.width / 2 - 0.24 * a.p.ratio), railA),
            b.at(sign * (b.width / 2 - 0.24 * b.p.ratio), railB), b.at(sign * b.width / 2, railB),
            Math.max(0.005, (railA + railB) / 2) * ratio, a.casing, a.casing);
        }
      }
      for (const p of path) if (zoom >= 15 && p.sample.pier && p.z - p.ground > 2.8 * p.ratio) {
        const half = Math.min(1, p.sample.width / 5) * p.ratio, top = p.z - 0.5 * p.ratio;
        solid([p.x - half, p.y - half, top], [p.x + half, p.y - half, top],
          [p.x + half, p.y + half, top], [p.x - half, p.y + half, top], top - p.ground, concrete);
      }
      accepted.push({...plan, maxGrade, heights});
    }
    let joined = 0;
    for (const branches of junctions.values()) {
      if (branches.length < 2) continue;
      const points = branches.flatMap(({edge}) => [edge.left, edge.right]), hull = convexHull(points);
      if (hull.length < 3 || Math.max(...points.map(p => p[2])) - Math.min(...points.map(p => p[2])) > 0.15) continue;
      if (positions.length / 9 + hull.length * 4 > RULES.maxTriangles) continue;
      const color = branches[0].edge.color, ratio = branches[0].edge.p.ratio;
      for (let i = 1; i < hull.length - 1; i++) {
        triangle(hull[0], hull[i], hull[i + 1], color);
        triangle([hull[0][0], hull[0][1], hull[0][2] - 0.5 * ratio],
          [hull[i][0], hull[i][1], hull[i][2] - 0.5 * ratio],
          [hull[i + 1][0], hull[i + 1][1], hull[i + 1][2] - 0.5 * ratio], concrete);
      }
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        quad(a, b, [b[0], b[1], b[2] - 0.5 * ratio], [a[0], a[1], a[2] - 0.5 * ratio], concrete);
      }
      joined++;
    }
    const replacement = remainder(prepared.sourceRoads, accepted);
    const linearColors = colors.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return {algorithm: ALGORITHM, origin, scale, positions: new Float32Array(positions),
      colors: new Float32Array(linearColors), accepted, rejected, ...replacement, joined,
      inventory: prepared.inventory};
  }

  function bridgeWorkerMain() {
    self.onmessage = ({data}) => {
      try {
        const result = data.action === "prepare" ? self.HuayuBridgeModels.prepare(data.features, data.bounds, data.zoom)
          : data.action === "geometry" ? self.HuayuBridgeModels.geometry(data.prepared, data.elevations, data.night, data.style)
            : (() => { throw new Error("Unknown bridge task"); })();
        const transfer = data.action === "geometry" ? [result.positions.buffer, result.colors.buffer] : [];
        self.postMessage({id: data.id, result}, transfer);
      } catch (error) { self.postMessage({id: data.id, error: String(error.message || error)}); }
    };
  }

  function workerSource() {
    // No importScripts or additional HTTP slot: basemap API requests can occupy
    // the origin's entire connection pool while the first viewport is loading.
    return `(${installHuayuBridgeModels.toString()})(self);(${bridgeWorkerMain.toString()})();`;
  }

  class Controller {
    constructor(map, options) {
      this.map = map; this.options = options; this.alive = true; this.roads = []; this.revision = 0; this.dirty = true;
      this.filters = new Map(); this.requests = new Map(); this.sequence = 0;
      this.targetLOD = map.getZoom() >= 17 ? 2 : map.getZoom() >= 15 ? 1 : 0;
      this.onCamera = () => {
        if (!this.wanted()) this.show(false);
        const styleKey = JSON.stringify(this.roadStyle());
        if (styleKey !== this.observedStyleKey) { this.observedStyleKey = styleKey; this.elevationDirty = true; this.revision++; }
        const lod = this.map.getZoom() >= 17 ? 2 : this.map.getZoom() >= 15 ? 1 : 0;
        if (lod !== this.targetLOD) { this.targetLOD = lod; this.dirty = true; this.revision++; }
        const b = map.getBounds?.(), previous = this.targetBounds || this.preparedBounds;
        if (b && previous && (b.getWest() < previous.west || b.getEast() > previous.east
          || b.getSouth() < previous.south || b.getNorth() > previous.north)) {
          this.targetBounds = this.bounds(); this.dirty = true; this.revision++;
        }
        this.schedule();
      };
      this.onTerrain = event => { if (!event.sourceId || event.sourceId === map.getTerrain?.()?.source) {
        this.elevationDirty = true; this.schedule();
      }};
      this.onStyle = () => {
        if (!this.alive || !map.getStyle?.()) return;
        if (this.layer && !map.getLayer(LAYER_ID)) {
          this.layer = null; this.releaseGraphics(); this.filters.clear(); this.remainderLayers = null; this.dirty = true;
        }
        this.schedule();
      };
      this.onRemove = () => this.destroy();
      for (const event of ["pitch", "zoom", "moveend"]) map.on(event, this.onCamera);
      map.on("terrain", this.onTerrain); map.on("sourcedata", this.onTerrain);
      map.on("styledata", this.onStyle); map.on("remove", this.onRemove);
      this.unbind = options.observeGestures?.(() => { this.interacting = true; },
        () => { this.interacting = false; this.schedule(); });
    }

    update(features, options) {
      if (this.features !== features) {
        const roads = (features || []).filter(feature => feature.properties?.renderKind === "road");
        if (roads.length !== this.roads.length || roads.some((road, index) => road !== this.roads[index])) {
          const key = roads.map(road => JSON.stringify([road.id, road.geometry, road.properties])).sort().join("\n");
          if (key !== this.roadDataKey) {
            this.roadDataKey = key; this.roads = roads; this.revision++; this.dirty = true;
            this.jobFailed = false; this.retryCount = 0;
          }
        }
        this.features = features;
      }
      if (this.options.night !== options.night) { this.elevationDirty = true; this.revision++; }
      this.options = options;
      this.show(Boolean(this.mesh));
      this.schedule();
    }

    bounds() {
      const b = this.map.getBounds(), pad = 0.004;
      return {west: b.getWest() - pad, east: b.getEast() + pad,
        south: b.getSouth() - pad, north: b.getNorth() + pad};
    }

    retry() {
      if (!this.alive) return;
      root.clearTimeout(this.retryTimer); this.retryTimer = null;
      this.jobFailed = false; this.retryCount = 0; this.dirty = true; this.revision++;
      this.show(Boolean(this.mesh)); this.schedule();
    }

    wanted() {
      return this.alive && this.options.enabled && !this.options.satellite
        && this.map.getPitch() > 0.5 && this.map.getZoom() >= RULES.minZoom;
    }

    schedule() {
      if (!this.alive || this.interacting || this.timer || this.busy) return;
      this.timer = root.setTimeout(() => { this.timer = null; if (this.alive && !this.interacting) void this.apply(); }, 100);
    }

    request(action, payload) {
      if (!this.worker) {
        if (!root.Worker) return Promise.reject(new Error("Bridge worker unavailable"));
        this.workerURL = root.URL.createObjectURL(new root.Blob([workerSource()], {type: "text/javascript"}));
        try { this.worker = new root.Worker(this.workerURL); }
        catch (error) { root.URL.revokeObjectURL(this.workerURL); this.workerURL = null; throw error; }
        this.worker.onmessage = ({data}) => {
          if (this.workerURL) { root.URL.revokeObjectURL(this.workerURL); this.workerURL = null; }
          const pending = this.requests.get(data.id); if (!pending) return;
          this.requests.delete(data.id); root.clearTimeout(pending.timer);
          if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
        };
        this.worker.onerror = () => this.stopWorker(new Error("Bridge worker failed"));
      }
      return new Promise((resolve, reject) => {
        const id = ++this.sequence;
        const timer = root.setTimeout(() => this.stopWorker(new Error("Bridge worker timeout")), 20000);
        this.requests.set(id, {resolve, reject, timer}); this.worker.postMessage({id, action, ...payload});
      });
    }

    stopWorker(error) {
      this.worker?.terminate(); this.worker = null;
      if (this.workerURL) { root.URL.revokeObjectURL(this.workerURL); this.workerURL = null; }
      for (const pending of this.requests.values()) { root.clearTimeout(pending.timer); pending.reject(error); }
      this.requests.clear();
    }

    async ensureLayer() {
      if (this.layer && this.renderer) return;
      const T = this.T ||= await import("./three-0.160.1.module.min.js");
      if (!this.alive || !this.wanted()) return;
      const owner = this;
      this.layer = {id: LAYER_ID, type: "custom", renderingMode: "3d", enabled: false,
        onAdd(map, gl) {
          owner.renderer = new T.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
          owner.renderer.outputColorSpace = T.SRGBColorSpace;
          owner.renderer.autoClear = false; owner.camera = new T.Camera(); owner.scene = new T.Scene();
        },
        render(gl, args) {
          if (!owner.alive || !owner.layer?.enabled || !owner.mesh || !owner.transform) return;
          const matrix = args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args;
          owner.camera.projectionMatrix.fromArray(matrix).multiply(owner.transform);
          owner.renderer.resetState(); owner.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          owner.renderer.render(owner.scene, owner.camera); owner.renderer.resetState();
        },
        onRemove() { owner.releaseGraphics(); },
      };
      const before = this.map.getStyle().layers.find(layer => ["symbol", "circle"].includes(layer.type))?.id;
      this.map.addLayer(this.layer, before);
    }

    roadStyle() {
      const [casing, surface] = this.options.roadLayers || [];
      return {zoom: Math.round(this.map.getZoom() * 1e6) / 1e6, night: Boolean(this.options.night),
        surfaceColor: this.map.getPaintProperty?.(surface, "line-color"),
        casingColor: this.map.getPaintProperty?.(casing, "line-color"),
        surfaceWidth: this.map.getPaintProperty?.(surface, "line-width"),
        casingWidth: this.map.getPaintProperty?.(casing, "line-width")};
    }

    removeRemainder(entry) {
      if (!entry || !this.map.getStyle?.()) return;
      for (const id of entry.layers) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(entry.source)) this.map.removeSource(entry.source);
    }

    async prepareRemainder(result) {
      if (!result.remainder.features.length) return null;
      const signature = JSON.stringify(result.remainder);
      if (signature === this.remainderLayers?.signature) return this.remainderLayers;
      const source = `${LAYER_ID}-remainder-${++this.sequence}`, layers = [];
      const entry = {source, layers, signature, opacities: {}}; this.pendingRemainder = entry;
      try {
        this.map.addSource(source, {type: "geojson", data: result.remainder, tolerance: 0, maxzoom: 22});
        for (const id of this.options.roadLayers || []) {
          const original = this.map.getStyle().layers.find(layer => layer.id === id);
          if (!original) throw new Error("Original road style missing");
          const clone = JSON.parse(JSON.stringify(original));
          clone.id = `${source}-${layers.length}`; clone.source = source;
          delete clone["source-layer"];
          clone.filter = this.filters.get(id) || original.filter || true;
          clone.layout = {...clone.layout, visibility: "visible", "line-cap": "butt"};
          entry.opacities[clone.id] = clone.paint?.["line-opacity"] ?? 1;
          clone.paint = {...clone.paint, "line-opacity": 0};
          this.map.addLayer(clone, id); layers.push(clone.id);
        }
        await new Promise((resolve, reject) => {
          const done = error => {
            root.clearTimeout(timer); this.map.off("sourcedata", loaded); this.map.off("render", loaded);
            if (this.cancelRemainder === cancel) this.cancelRemainder = null;
            if (error) reject(error); else resolve();
          };
          let rendered = false;
          const loaded = event => {
            if (event?.type === "render") rendered = true;
            if (rendered && this.map.isSourceLoaded(source)) done();
          };
          const cancel = () => done(new Error("Bridge remainder cancelled"));
          const timer = root.setTimeout(() => done(new Error("Bridge remainder timeout")), 45000);
          this.cancelRemainder = cancel;
          this.map.on("sourcedata", loaded); this.map.on("render", loaded); this.map.triggerRepaint();
        });
        return entry;
      } catch (error) { this.removeRemainder(entry); throw error; }
      finally { if (this.pendingRemainder === entry) this.pendingRemainder = null; }
    }

    async apply() {
      if (!this.alive || !this.map.getStyle?.()?.layers?.length || this.interacting) return;
      if (!this.wanted()) { this.show(false); return; }
      if (this.jobFailed) return;
      if (!this.dirty && !this.elevationDirty && this.result && this.renderedPrepared === this.prepared) {
        this.show(Boolean(this.mesh)); return;
      }
      const revision = this.revision; this.busy = true;
      this.show(Boolean(this.mesh));
      try {
        if (this.dirty || !this.prepared) {
          const bounds = this.targetBounds || this.bounds(); this.targetBounds = bounds;
          const prepared = await this.request("prepare", {features: this.roads, bounds, zoom: this.map.getZoom()});
          if (!this.alive || revision !== this.revision) return;
          this.prepared = prepared; this.preparedBounds = bounds; this.dirty = false; this.elevationDirty = true;
        }
        if (!this.alive || revision !== this.revision || this.interacting || !this.wanted()) return;
        const elevations = this.elevations();
        if (elevations.some(values => values.some(value => value === null))) { this.waitingTerrain = true; this.show(Boolean(this.mesh)); return; }
        this.waitingTerrain = false;
        const style = this.roadStyle(), styleKey = JSON.stringify(style), elevationKey = JSON.stringify(elevations);
        this.observedStyleKey = styleKey;
        if (this.renderedPrepared === this.prepared && this.styleKey === styleKey && this.elevationKey === elevationKey) {
          this.elevationDirty = false; this.show(Boolean(this.mesh)); return;
        }
        const result = await this.request("geometry", {prepared: this.prepared, elevations, night: this.options.night, style});
        if (!this.alive || revision !== this.revision || this.interacting || !this.wanted()) return;
        if (JSON.stringify(this.elevations()) !== elevationKey) { this.scheduleTerrain = true; return; }
        let remainderLayers;
        if (result.positions.length) {
          await this.ensureLayer();
          if (!this.alive || revision !== this.revision || this.interacting || !this.wanted()) return;
          remainderLayers = await this.prepareRemainder(result);
          if (!this.alive || revision !== this.revision || this.interacting || !this.wanted()) {
            if (remainderLayers !== this.remainderLayers) this.removeRemainder(remainderLayers);
            return;
          }
          if (JSON.stringify(this.elevations()) !== elevationKey) {
            if (remainderLayers !== this.remainderLayers) this.removeRemainder(remainderLayers);
            this.scheduleTerrain = true; return;
          }
          try { this.build(result); }
          catch (error) { if (remainderLayers !== this.remainderLayers) this.removeRemainder(remainderLayers); throw error; }
        } else this.clearMesh();
        const previousRemainder = this.remainderLayers; this.remainderLayers = remainderLayers;
        this.result = result; this.styleKey = styleKey; this.elevationKey = elevationKey; this.renderedPrepared = this.prepared;
        this.jobFailed = false; this.retryCount = 0;
        this.dirty = false; this.elevationDirty = false; this.show(Boolean(this.mesh));
        if (previousRemainder !== remainderLayers) this.removeRemainder(previousRemainder);
      } catch (error) {
        if (!this.alive) return;
        this.jobFailed = true; this.show(false);
        if ((this.retryCount || 0) < 2) {
          const delay = ++this.retryCount * 1500;
          root.clearTimeout(this.retryTimer);
          this.retryTimer = root.setTimeout(() => {
            this.retryTimer = null;
            if (!this.alive) return;
            this.jobFailed = false; this.elevationDirty = true; this.show(Boolean(this.mesh)); this.schedule();
          }, delay);
        }
        console.warn("Bridge models unavailable; retaining the original roads.", error);
      } finally {
        this.busy = false;
        if (this.alive && (revision !== this.revision || this.interacting || this.scheduleTerrain)) this.schedule();
        this.scheduleTerrain = false;
      }
    }

    elevations() {
      const terrain = this.map.getTerrain?.();
      return this.prepared.plans.map(plan => plan.samples.map(sample => {
        if (!terrain) return 0;
        const value = this.map.queryTerrainElevation(sample.coordinate);
        return Number.isFinite(value) ? value : null;
      }));
    }

    build(result) {
      const T = this.T, origin = root.maplibregl.MercatorCoordinate.fromLngLat(result.origin);
      const transform = new T.Matrix4().makeTranslation(origin.x, origin.y, 0)
        .scale(new T.Vector3(result.scale, -result.scale, result.scale));
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.BufferAttribute(result.positions, 3));
      geometry.setAttribute("color", new T.BufferAttribute(result.colors, 3));
      const material = new T.MeshBasicMaterial({vertexColors: true, side: T.DoubleSide, depthTest: true, depthWrite: true,
        toneMapped: false});
      const mesh = new T.Mesh(geometry, material); mesh.frustumCulled = false;
      this.clearMesh(); this.mesh = mesh; this.transform = transform; this.scene.add(mesh);
    }

    show(visible) {
      const enabled = Boolean(visible && this.mesh && this.wanted());
      if (this.layer) this.layer.enabled = enabled;
      for (const [index, id] of (this.remainderLayers?.layers || []).entries()) if (this.map.getLayer(id)) {
        const visibility = enabled ? "visible" : "none";
        if (enabled) for (const key of ["line-color", "line-width", "line-opacity"]) {
          const value = this.map.getPaintProperty(this.options.roadLayers[index], key) ?? (key === "line-opacity" ? 1 : undefined);
          if (value !== undefined && JSON.stringify(this.map.getPaintProperty(id, key)) !== JSON.stringify(value)) {
            this.map.setPaintProperty(id, key, value);
          }
        }
        if (this.map.getLayoutProperty(id, "visibility") !== visibility) this.map.setLayoutProperty(id, "visibility", visibility);
      }
      for (const id of this.options.roadLayers || []) {
        if (!this.map.getLayer(id)) continue;
        if (!this.filters.has(id)) this.filters.set(id, this.map.getFilter(id) || true);
        const base = this.filters.get(id), ids = this.result?.hideIds || [];
        const filter = enabled && ids.length ? ["all", base, ["!", ["in", ["get", "osmId"], ["literal", ids]]]] : base;
        if (JSON.stringify(filter) !== JSON.stringify(this.map.getFilter(id))) this.map.setFilter(id, filter);
      }
      const element = root.document?.getElementById("map");
      if (element && this.alive) {
        element.dataset.huayuBridges = String(this.result?.accepted.filter(plan => plan.kind !== "ground-ramp").length || 0);
        element.dataset.huayuBridgesActive = String(enabled);
        element.dataset.huayuBridgeRejected = String(this.result?.rejected.length || 0);
      }
      this.options.onStatus?.({count: this.result?.accepted.filter(plan => plan.kind !== "ground-ramp").length || 0,
        rejected: this.result?.rejected || [], inventory: this.result?.inventory,
        state: this.options.paused ? "paused" : this.options.satellite ? "satellite"
          : this.map.getPitch() <= 0.5 ? "overhead" : this.map.getZoom() < RULES.minZoom ? "distant"
            : !this.options.enabled ? "loading" : this.jobFailed ? "failed"
              : this.waitingTerrain ? "terrain" : enabled ? "active"
                : this.dirty || this.elevationDirty || !this.result ? "preparing" : "empty"});
      if (this.visible !== enabled) { this.visible = enabled; this.map.triggerRepaint(); }
    }

    clearMesh() {
      if (this.mesh) { this.scene?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
      this.mesh = null;
    }

    releaseGraphics() { this.clearMesh(); this.renderer?.dispose(); this.renderer = null; this.transform = null; }

    destroy() {
      if (!this.alive) return;
      this.show(false); this.alive = false; root.clearTimeout(this.timer); this.unbind?.();
      root.clearTimeout(this.retryTimer);
      this.cancelRemainder?.(); this.removeRemainder(this.pendingRemainder); this.removeRemainder(this.remainderLayers);
      this.stopWorker(new Error("Bridge map removed"));
      for (const event of ["pitch", "zoom", "moveend"]) this.map.off(event, this.onCamera);
      this.map.off("terrain", this.onTerrain); this.map.off("sourcedata", this.onTerrain);
      this.map.off("styledata", this.onStyle); this.map.off("remove", this.onRemove);
      if (this.map.getStyle?.() && this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      this.releaseGraphics();
    }
  }

  root.HuayuBridgeModels = {ALGORITHM, LAYER_ID, RULES, roadWidth, graph, chains, approach, profile, prepare, geometry,
    remainder, styleValue, workerSource, STORAGE_KEY, DEFAULTS, normalize, setPreferences,
    getPreferences: () => ({...preferences}),
    sync(map, features, options) {
      let controller = controllers.get(map);
      if (!controller) { controller = new Controller(map, options); controllers.set(map, controller); }
      controller.update(features, options); return controller;
    },
    get: map => controllers.get(map),
    retry(map) { controllers.get(map)?.retry(); },
    dispose(map) { controllers.get(map)?.destroy(); controllers.delete(map); },
  };
})(typeof window !== "undefined" ? window : globalThis);
