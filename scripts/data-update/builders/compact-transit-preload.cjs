const { readFile, writeFile } = require("node:fs/promises");
const { gzipSync } = require("node:zlib");

const sourcePath = "outputs/ogf-atlas/transit-preload.json";
const networkTarget = "outputs/ogf-atlas/transit-preload.json";
const relationsTarget = "outputs/ogf-atlas/transit-relations.json";
const shouldWrite = process.argv.includes("--write");
const toleranceMeters = 2;
const earthRadiusMeters = 6371000;
const huaxiaBoundaryPath = "work/huaxia-country-boundary.json";
let huaxiaBoundaryGeometry = null;

function roundCoordinate(value) {
  return Math.round(Number(value) * 1e7) / 1e7;
}

function pointSegmentDistanceSquared(point, start, end, cosLatitude) {
  const radians = Math.PI / 180;
  const scaleX = earthRadiusMeters * radians * cosLatitude;
  const scaleY = earthRadiusMeters * radians;
  const px = point.lon * scaleX;
  const py = point.lat * scaleY;
  const ax = start.lon * scaleX;
  const ay = start.lat * scaleY;
  const bx = end.lon * scaleX;
  const by = end.lat * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  const offsetX = px - (ax + dx * ratio);
  const offsetY = py - (ay + dy * ratio);
  return offsetX * offsetX + offsetY * offsetY;
}

function simplifyGeometry(geometry, tolerance) {
  if (!Array.isArray(geometry) || geometry.length <= 2) return geometry || [];
  const keep = new Uint8Array(geometry.length);
  keep[0] = 1;
  keep[geometry.length - 1] = 1;
  const stack = [[0, geometry.length - 1]];
  const toleranceSquared = tolerance * tolerance;
  const averageLatitude = geometry.reduce((sum, point) => sum + point.lat, 0) / geometry.length;
  const cosLatitude = Math.cos(averageLatitude * Math.PI / 180);

  while (stack.length) {
    const [startIndex, endIndex] = stack.pop();
    let farthestIndex = -1;
    let farthestDistance = toleranceSquared;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = pointSegmentDistanceSquared(
        geometry[index],
        geometry[startIndex],
        geometry[endIndex],
        cosLatitude,
      );
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex === -1) continue;
    keep[farthestIndex] = 1;
    stack.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
  }

  return geometry.filter((_, index) => keep[index]);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const intersects = (y > point[1]) !== (previousY > point[1])
      && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y || Number.EPSILON) + x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.some((polygon) => pointInRing(point, polygon[0])
    && !polygon.slice(1).some((ring) => pointInRing(point, ring)));
}

function nationalRailwayEligible(snapshotId, lat, lon) {
  if (snapshotId !== "huaxia") return true;
  return Number.isFinite(lat) && Number.isFinite(lon)
    && pointInGeometry([lon, lat], huaxiaBoundaryGeometry);
}

function compactNetwork(network, snapshotId) {
  if (network?.format === 2) {
    return {
      ...network,
      stops: (network.stops || []).map((stop) => {
        const tuple = [...stop];
        if (tuple.length < 12) tuple[11] = null;
        tuple[12] = nationalRailwayEligible(
          snapshotId,
          Number.isFinite(tuple[3]) ? tuple[3] : tuple[1],
          Number.isFinite(tuple[4]) ? tuple[4] : tuple[2],
        ) ? 1 : 0;
        return tuple;
      }),
    };
  }
  const routeTable = [];
  const routeIndexes = new Map();
  const compactRoute = (route) => {
    const tuple = [route.id, route.type, route.color, route.identity, route.label,
      route.ref || null, route.sourceRef || null, route.relationKind || null,
      route.isRouteMaster ? 1 : 0, route.routeMasterId ?? null,
      route.routeMasterIds || [], route.childRelationIds || [], route.isServiceRelation ? 1 : 0,
      route.serviceRelationId ?? null, route.from || null, route.to || null,
      route.serviceFrom || null, route.serviceTo || null, route.serviceName || null,
      route.operator || null, route.network || null, route.service || null,
      Number.isFinite(route.speedKmh) ? route.speedKmh : null];
    const key = JSON.stringify(tuple);
    if (!routeIndexes.has(key)) {
      routeIndexes.set(key, routeTable.length);
      routeTable.push(tuple);
    }
    return routeIndexes.get(key);
  };

  const lines = (network.lines || []).map((line) => {
    const geometry = simplifyGeometry(line.geometry, toleranceMeters)
      .map((point) => [roundCoordinate(point.lat), roundCoordinate(point.lon)]);
    return [
      line.id,
      geometry,
      (line.routes || []).map(compactRoute),
      (line.bbox || []).map(roundCoordinate),
    ];
  });
  const stops = (network.stops || []).map((stop) => {
    const displayRoutes = (stop.displayRoutes || []).map(compactRoute);
    return [
      stop.id,
      roundCoordinate(stop.lat),
      roundCoordinate(stop.lon),
      Number.isFinite(stop.sourceLat) ? roundCoordinate(stop.sourceLat) : null,
      Number.isFinite(stop.sourceLon) ? roundCoordinate(stop.sourceLon) : null,
      stop.name || "",
      stop.isRail ? 1 : 0,
      stop.isBus ? 1 : 0,
      (stop.routes || []).map(compactRoute),
      stop.isMainline ? 1 : 0,
      stop.sourceId ?? null,
      displayRoutes.length ? displayRoutes : null,
      nationalRailwayEligible(
        snapshotId,
        Number.isFinite(stop.sourceLat) ? stop.sourceLat : stop.lat,
        Number.isFinite(stop.sourceLon) ? stop.sourceLon : stop.lon,
      ) ? 1 : 0,
      stop.isInterchange ? 1 : 0,
    ];
  });

  return {
    format: 2,
    routeTable,
    lines,
    stops,
    meta: {
      routeCount: network.routeCount || 0,
      includeBus: Boolean(network.includeBus),
      stationDataUnavailable: Boolean(network.stationDataUnavailable),
      source: network.source || "preloaded",
      sourceLabel: network.sourceLabel || "华夏共和国",
      mainlineStationsReconciled: Boolean(network.mainlineStationsReconciled),
    },
  };
}

(async () => {
  const payload = JSON.parse(await readFile(sourcePath, "utf8"));
  huaxiaBoundaryGeometry = JSON.parse(await readFile(huaxiaBoundaryPath, "utf8")).geometry;
  if (!huaxiaBoundaryGeometry) throw new Error("Missing Huaxia country boundary geometry");
  let existingRelations = { snapshots: [] };
  try {
    existingRelations = JSON.parse(await readFile(relationsTarget, "utf8"));
  } catch {}
  const existingRelationSnapshots = new Map((existingRelations.snapshots || [])
    .map((snapshot) => [snapshot.id, snapshot]));
  const networkPayload = {
    generatedAt: payload.generatedAt,
    snapshots: (payload.snapshots || []).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.label,
      bounds: snapshot.bounds,
      network: compactNetwork(snapshot.network, snapshot.id),
    })),
  };
  const relationsPayload = {
    generatedAt: payload.generatedAt,
    snapshots: (payload.snapshots || []).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.label,
      bounds: snapshot.bounds,
      elements: Array.isArray(snapshot.elements)
        ? snapshot.elements : existingRelationSnapshots.get(snapshot.id)?.elements || [],
    })),
  };
  const networkJson = JSON.stringify(networkPayload);
  const relationsJson = JSON.stringify(relationsPayload);

  if (shouldWrite) {
    await writeFile(networkTarget, networkJson);
    await writeFile(relationsTarget, relationsJson);
  }

  console.log(JSON.stringify({
    wroteFiles: shouldWrite,
    toleranceMeters,
    network: {
      bytes: Buffer.byteLength(networkJson),
      gzipBytes: gzipSync(networkJson, { level: 9 }).length,
      snapshots: networkPayload.snapshots.map((snapshot) => ({
        id: snapshot.id,
        routes: snapshot.network.routeTable.length,
        lines: snapshot.network.lines.length,
        points: snapshot.network.lines.reduce((sum, line) => sum + line[1].length, 0),
        stops: snapshot.network.stops.length,
      })),
    },
    relations: {
      bytes: Buffer.byteLength(relationsJson),
      gzipBytes: gzipSync(relationsJson, { level: 9 }).length,
      snapshots: relationsPayload.snapshots.map((snapshot) => ({
        id: snapshot.id,
        elements: snapshot.elements.length,
      })),
    },
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
