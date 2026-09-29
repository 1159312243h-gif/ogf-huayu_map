const { readFile, writeFile } = require("node:fs/promises");

const target = "outputs/ogf-atlas/transit-preload.json";

function distanceMeters(a, b) {
  const latitudeScale = 111320;
  const meanLatitude = ((a.lat + b.lat) / 2 * Math.PI) / 180;
  const x = (a.lon - b.lon) * Math.cos(meanLatitude) * latitudeScale;
  const y = (a.lat - b.lat) * latitudeScale;
  return Math.hypot(x, y);
}

function projectPoint(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = Math.cos((point.lat * Math.PI) / 180) * latitudeScale;
  const px = point.lon * longitudeScale;
  const py = point.lat * latitudeScale;
  const ax = start.lon * longitudeScale;
  const ay = start.lat * latitudeScale;
  const bx = end.lon * longitudeScale;
  const by = end.lat * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
  const x = ax + ratio * dx;
  const y = ay + ratio * dy;
  return { lat: y / latitudeScale, lon: x / longitudeScale, distance: Math.hypot(px - x, py - y) };
}

function nearestPoint(point, lines) {
  let nearest = null;
  for (const line of lines) {
    const bbox = line.bbox;
    const padding = 0.004;
    if (bbox && (point.lat < bbox[0] - padding || point.lat > bbox[2] + padding
      || point.lon < bbox[1] - padding || point.lon > bbox[3] + padding)) continue;
    for (let index = 1; index < line.geometry.length; index += 1) {
      const projected = projectPoint(point, line.geometry[index - 1], line.geometry[index]);
      if (!nearest || projected.distance < nearest.distance) nearest = { ...projected, routes: line.routes };
    }
  }
  return nearest;
}

function uniqueRoutes(routes) {
  return [...new Map(routes.map((route) => [route.identity || route.id, route])).values()];
}

function mergeStops(stops) {
  const merged = [];
  for (const stop of stops) {
    const normalizedName = String(stop.name || "").trim().toLocaleLowerCase("zh-CN");
    const existing = normalizedName ? merged.find((item) => {
      if (item.normalizedName !== normalizedName) return false;
      const distance = distanceMeters(item, stop);
      return distance <= 180 && (Boolean(item.isMainline) === Boolean(stop.isMainline) || distance <= 60);
    }) : null;
    if (!existing) {
      merged.push({ ...stop, normalizedName });
      continue;
    }
    existing.isRail ||= stop.isRail;
    existing.isBus ||= stop.isBus;
    existing.isMainline ||= stop.isMainline;
    existing.routes = uniqueRoutes([...(existing.routes || []), ...(stop.routes || [])]);
  }
  return merged.map(({ normalizedName, ...stop }) => stop);
}

function isMainlineStation(node) {
  const tags = node.tags || {};
  return ["station", "halt"].includes(tags.railway)
    && tags.station !== "subway"
    && tags.subway !== "yes"
    && tags.tram !== "yes";
}

(async () => {
  const payload = JSON.parse(await readFile(target, "utf8"));
  const report = [];
  for (const snapshot of payload.snapshots || []) {
    const network = snapshot.network;
    if (!network) continue;
    if (network.format === 2) {
      report.push({ snapshot: snapshot.id, skipped: "already compact" });
      continue;
    }
    const trainLines = network.lines.filter((line) => line.routes.some((route) => route.type === "train"));
    const mainlineNodes = snapshot.elements.filter((item) => item.type === "node"
      && Number.isFinite(item.lat) && Number.isFinite(item.lon) && isMainlineStation(item));
    const mainlineIds = new Set(mainlineNodes.map((node) => node.id));
    const existingById = new Map(network.stops.map((stop) => [stop.id, stop]));
    const mainlineStops = [];
    let repaired = 0;

    for (const node of mainlineNodes) {
      const existing = existingById.get(node.id);
      if (existing?.routes?.some((route) => route.type === "train")) {
        mainlineStops.push({ ...existing, sourceId: existing.sourceId ?? node.id, isMainline: true });
        continue;
      }
      const nearest = nearestPoint(node, trainLines);
      if (!nearest || nearest.distance > 280) {
        if (existing) mainlineStops.push(existing);
        continue;
      }
      repaired += 1;
      mainlineStops.push({
        id: node.id,
        sourceId: node.id,
        lat: nearest.lat,
        lon: nearest.lon,
        sourceLat: node.lat,
        sourceLon: node.lon,
        name: node.tags?.name || node.tags?.local_ref || node.tags?.ref || "",
        isRail: true,
        isBus: false,
        isMainline: true,
        routes: uniqueRoutes(nearest.routes.filter((route) => route.type === "train")),
      });
    }

    const previousStops = network.stops.length;
    network.stops = mergeStops([
      ...network.stops.filter((stop) => !mainlineIds.has(stop.id)),
      ...mainlineStops,
    ]);
    network.mainlineStationsReconciled = true;
    report.push({
      snapshot: snapshot.id,
      mainlineNodes: mainlineNodes.length,
      repaired,
      previousStops,
      currentStops: network.stops.length,
    });
  }
  payload.generatedAt = new Date().toISOString();
  await writeFile(target, JSON.stringify(payload));
  console.log(JSON.stringify({ target, report }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
