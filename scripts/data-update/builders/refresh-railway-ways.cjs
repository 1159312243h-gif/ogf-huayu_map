const fs = require("node:fs");
const {createHash} = require("node:crypto");

const railwayTypes = new Set(["rail", "narrow_gauge", "subway", "light_rail", "tram", "monorail"]);

function completeGeometry(way) {
  return Array.isArray(way.nodes) && Array.isArray(way.geometry) && way.nodes.length > 0
    && way.nodes.length === way.geometry.length
    && way.geometry.every(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
}

function validateResponse(payload, requestedIds, allowUnresolvedGeometry = false) {
  if (payload?.remark || !Array.isArray(payload?.elements)
    || !Number.isFinite(Date.parse(payload.osm3s?.timestamp_osm_base))) {
    throw new Error(payload?.remark || "Incomplete railway verification response");
  }
  const ways = payload.elements.filter(item => item.type === "way");
  const counts = payload.elements.filter(item => item.type === "count");
  const ids = new Set(requestedIds);
  if (counts.length !== 1 || Number(counts[0].tags?.ways) !== ways.length
    || Number(counts[0].tags?.total) !== ways.length
    || payload.elements.length !== ways.length + 1
    || new Set(ways.map(way => way.id)).size !== ways.length
    || ways.some(way => !ids.has(way.id))) {
    throw new Error("Railway verification count/identity mismatch");
  }
  for (const way of ways) {
    if (!railwayTypes.has(way.tags?.railway)) continue;
    if (!allowUnresolvedGeometry && !completeGeometry(way)) {
      throw new Error(`Incomplete current railway geometry: ${way.id}`);
    }
  }
  return ways;
}

// Cache lives inside one updater run. Never fall back to geometry from a
// published baseline when a current lookup fails or has an incomplete count.
async function refreshRailwayWays(requestedIds, options = {}) {
  const ids = [...new Set(requestedIds)].sort((a, b) => a - b);
  const prefix = options.cachePrefix || "work/railway-routing-baseline-refresh";
  const fetchImpl = options.fetchImpl || fetch;
  const current = [], removed = [], sourceTimestamps = [], officialChecks = [];
  async function officialWay(id) {
    const cachePath = `${prefix}-official-${id}.json`;
    let saved;
    if (fs.existsSync(cachePath)) saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    else {
      const response = await fetchImpl(`https://opengeofiction.net/api/0.6/way/${id}/full.json`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok && response.status !== 410) throw new Error(`Official railway verification HTTP ${response.status}: ${id}`);
      saved = {id, status: response.status, checkedAt: new Date().toISOString(),
        payload: response.status === 410 ? null : await response.json()};
    }
    if (saved.id !== id || ![200, 410].includes(saved.status)
      || !Number.isFinite(Date.parse(saved.checkedAt))) throw new Error(`Invalid official railway verification: ${id}`);
    let way = null;
    if (saved.status === 200) {
      const elements = saved.payload?.elements;
      const ways = elements?.filter(item => item.type === "way");
      if (ways?.length !== 1 || ways[0].id !== id) throw new Error(`Incomplete official railway response: ${id}`);
      const nodes = new Map(elements.filter(item => item.type === "node").map(node => [node.id, node]));
      way = {...ways[0], geometry: ways[0].nodes?.map(ref => ({lat: nodes.get(ref)?.lat, lon: nodes.get(ref)?.lon}))};
      if (railwayTypes.has(way.tags?.railway) && !completeGeometry(way)) {
        throw new Error(`Incomplete official railway geometry: ${id}`);
      }
    }
    fs.writeFileSync(cachePath, JSON.stringify(saved));
    officialChecks.push({id, status: saved.status, checkedAt: saved.checkedAt});
    return way;
  }
  for (let offset = 0; offset < ids.length; offset += 350) {
    const batch = ids.slice(offset, offset + 350);
    const hash = createHash("sha256").update(JSON.stringify(batch)).digest("hex").slice(0, 16);
    const cachePath = `${prefix}-${hash}.json`;
    let payload;
    if (fs.existsSync(cachePath)) {
      payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      validateResponse(payload, batch, true);
    } else {
      const query = `[out:json][timeout:90];way(id:${batch.join(",")});out body geom;out count;`;
      const response = await fetchImpl("https://overpass.opengeofiction.net/api/interpreter", {
        method: "POST", headers: {"content-type": "application/x-www-form-urlencoded;charset=UTF-8"},
        body: new URLSearchParams({data: query}), signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`Railway verification HTTP ${response.status}`);
      payload = await response.json();
      validateResponse(payload, batch, true);
      fs.writeFileSync(cachePath, JSON.stringify(payload));
    }
    const returned = new Map(validateResponse(payload, batch, true).map(way => [way.id, way]));
    for (const id of batch) {
      let way = returned.get(id);
      // Overpass can omit geometry after nodes move. Confirm absences and
      // changed classifications against the primary API before discarding.
      if (!way || !railwayTypes.has(way.tags?.railway) || !completeGeometry(way)) way = await officialWay(id);
      if (!way) removed.push({id, reason: "deleted"});
      else if (!railwayTypes.has(way.tags?.railway)) removed.push({id, reason: "no-longer-railway"});
      else if (way.nodes.length < 2) removed.push({id, reason: "non-drawable"});
      else current.push(way);
    }
    sourceTimestamps.push(payload.osm3s.timestamp_osm_base);
    if (options.onBatch) options.onBatch({offset, total: ids.length, returned: returned.size});
  }
  return {ways: current, verification: {checkedAt: new Date().toISOString(),
    checkedWayIds: ids, retainedWayIds: current.map(way => way.id), removed, sourceTimestamps, officialChecks}};
}

function assertBaselineRetention(baselineIds, currentIds, verification) {
  const checked = new Set(verification?.checkedWayIds || []);
  const removed = new Map((verification?.removed || []).map(item => [item.id, item.reason]));
  const official = new Map((verification?.officialChecks || []).map(item => [item.id, item.status]));
  for (const id of baselineIds) {
    if (currentIds.has(id)) continue;
    if (!checked.has(id) || !["deleted", "no-longer-railway", "non-drawable"].includes(removed.get(id))
      || !verification.sourceTimestamps?.length
      || verification.sourceTimestamps.some(value => !Number.isFinite(Date.parse(value)))
      || (removed.get(id) === "deleted" && official.get(id) !== 410)
      || (removed.get(id) === "no-longer-railway" && official.get(id) !== 200)) {
      throw new Error(`Published railway lost without complete current-source verification: ${id}`);
    }
  }
  for (const id of removed.keys()) {
    if (currentIds.has(id)) throw new Error(`Removed railway was reintroduced: ${id}`);
  }
}

module.exports = {refreshRailwayWays, validateResponse, assertBaselineRetention};
