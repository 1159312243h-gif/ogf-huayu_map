const fs = require("node:fs");

const preloadPath = "outputs/ogf-atlas/transit-preload.json";
const relationsPath = "outputs/ogf-atlas/transit-relations.json";
const maximumDistanceMeters = 280;

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
    .replace(/[\s·•・()（）\[\]【】\-—–_]/gu, "")
    .replace(/(?:火车站|火車站|铁路车站|鐵路車站|地铁站|地鐵站|轻轨站|輕軌站|车站|車站|站)$/u, "");
}

function distanceMeters(first, second) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.lat - first.lat) * radians;
  const longitudeDelta = (second.lon - first.lon) * radians;
  const firstLatitude = first.lat * radians;
  const secondLatitude = second.lat * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function isRailStation(item) {
  const tags = item.tags || {};
  if (item.type !== "node" || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)
    || !String(tags.name || "").trim()) return false;
  if (tags.public_transport === "stop_position" && tags.railway === "stop") return false;
  return ["station", "halt", "tram_stop"].includes(tags.railway)
    || tags.station === "subway" || tags.subway === "yes"
    || tags.monorail === "yes" || tags.light_rail === "yes"
    || tags.public_transport === "station";
}

function stationMode(item) {
  const tags = item.tags || {};
  if (tags.station === "subway" || tags.subway === "yes" || tags.railway === "subway") return "subway";
  if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
  if (tags.monorail === "yes" || tags.railway === "monorail") return "monorail";
  if (tags.light_rail === "yes" || tags.railway === "light_rail") return "light_rail";
  return "train";
}

function projectPoint(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = Math.cos(point.lat * Math.PI / 180) * latitudeScale;
  const px = point.lon * longitudeScale;
  const py = point.lat * latitudeScale;
  const ax = start[1] * longitudeScale;
  const ay = start[0] * latitudeScale;
  const bx = end[1] * longitudeScale;
  const by = end[0] * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  const x = ax + ratio * dx;
  const y = ay + ratio * dy;
  return { lat: y / latitudeScale, lon: x / longitudeScale, distance: Math.hypot(px - x, py - y) };
}

function nearestCompatibleLine(point, mode, network) {
  let nearest = null;
  for (const line of network.lines || []) {
    const compatibleRoutes = (line[2] || []).filter((index) => network.routeTable[index]?.[1] === mode);
    if (!compatibleRoutes.length) continue;
    const bbox = line[3];
    const padding = 0.004;
    if (bbox && (point.lat < bbox[0] - padding || point.lat > bbox[2] + padding
      || point.lon < bbox[1] - padding || point.lon > bbox[3] + padding)) continue;
    for (let index = 1; index < (line[1] || []).length; index += 1) {
      const projected = projectPoint(point, line[1][index - 1], line[1][index]);
      if (!nearest || projected.distance < nearest.distance) {
        nearest = { ...projected, routeIndexes: compatibleRoutes };
      }
    }
  }
  return nearest;
}

const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
const relations = JSON.parse(fs.readFileSync(relationsPath, "utf8"));
const report = [];

for (const snapshot of preload.snapshots || []) {
  const source = relations.snapshots.find((item) => item.id === snapshot.id);
  const network = snapshot.network;
  if (!source || network?.format !== 2) continue;
  const stopIds = new Set((network.stops || []).flatMap((stop) => [stop[0], stop[10]])
    .filter((id) => id !== null && id !== undefined).map(String));
  const stopsByName = new Map();
  for (const stop of network.stops || []) {
    const name = normalizeName(stop[5]);
    if (!name) continue;
    if (!stopsByName.has(name)) stopsByName.set(name, []);
    stopsByName.get(name).push(stop);
  }

  const additions = [];
  for (const item of (source.elements || []).filter(isRailStation)) {
    if (stopIds.has(String(item.id))) continue;
    const point = { lat: item.lat, lon: item.lon };
    const sameName = stopsByName.get(normalizeName(item.tags?.name)) || [];
    if (sameName.some((stop) => distanceMeters(point, { lat: stop[1], lon: stop[2] }) <= 400)) continue;
    const mode = stationMode(item);
    const nearest = nearestCompatibleLine(point, mode, network);
    if (!nearest || nearest.distance > maximumDistanceMeters) continue;
    const stop = [
      item.id,
      nearest.lat,
      nearest.lon,
      item.lat,
      item.lon,
      item.tags?.name || "",
      1,
      0,
      [...new Set(nearest.routeIndexes)],
      mode === "train" ? 1 : 0,
      item.id,
      null,
    ];
    network.stops.push(stop);
    stopIds.add(String(item.id));
    const name = normalizeName(stop[5]);
    if (!stopsByName.has(name)) stopsByName.set(name, []);
    stopsByName.get(name).push(stop);
    additions.push({
      id: item.id,
      name: stop[5],
      mode,
      distanceMeters: Math.round(nearest.distance),
      routes: stop[8].map((index) => network.routeTable[index]?.[4]).filter(Boolean),
    });
  }
  report.push({ snapshot: snapshot.id, additions });
}

preload.generatedAt = new Date().toISOString();
fs.writeFileSync(preloadPath, JSON.stringify(preload));
console.log(JSON.stringify({
  status: "written",
  maximumDistanceMeters,
  report,
}, null, 2));
