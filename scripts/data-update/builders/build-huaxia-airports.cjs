const { readFile, writeFile } = require("node:fs/promises");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const target = "outputs/ogf-atlas/airports.json";
const rawCache = "work/huaxia-airports-raw.json";
const query = `[out:json][timeout:180];rel(28652);map_to_area->.country;
  nwr["aeroway"~"^(aerodrome|terminal)$"]["name"](area.country);
  out body center;`;

function pointFor(element) {
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const deltaLat = (b.lat - a.lat) * radians;
  const deltaLon = (b.lon - a.lon) * radians;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function isUsableAirport(element) {
  const tags = element.tags || {};
  const text = [tags.name, tags["name:en"], tags["aerodrome:type"], tags.landuse, tags.military, tags.status]
    .filter(Boolean)
    .join(" ");
  if (tags.access === "private" || tags.military === "airfield" || tags.landuse === "military") return false;
  if (/(军用|空军|air\s*force|military|在建|建设中|proposed|construction|废弃|abandoned|disused)/iu.test(text)) return false;
  return Boolean(tags.iata || tags.icao || tags.ref
    || /(机场|航空港|airport|aerodrome|airfield)/iu.test(text));
}

(async () => {
  let result = null;
  if (process.argv.includes("--resume")) {
    try {
      const cached = JSON.parse(await readFile(rawCache, "utf8"));
      if (Array.isArray(cached.elements) && cached.elements.length) result = cached;
    } catch {}
  }
  if (!result) {
    const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(210000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`airport query ${response.status}: ${body.slice(0, 800)}`);
    result = JSON.parse(body);
    await writeFile(rawCache, JSON.stringify(result));
  }
  if (result.remark || !Array.isArray(result.elements) || !result.elements.length) {
    throw new Error(result.remark || "airport response is empty");
  }
  const elements = result.elements;
  const terminals = elements
    .filter((item) => item.tags?.aeroway === "terminal" && pointFor(item))
    .map((item) => ({ ...pointFor(item), id: `${item.type}:${item.id}`, name: item.tags.name || "航站楼" }))
    .filter((item) => /(terminal|航站楼|航站|候机|航厦)/iu.test(item.name));
  const airports = elements
    .filter((item) => item.tags?.aeroway === "aerodrome" && pointFor(item) && isUsableAirport(item))
    .map((item) => {
      const point = pointFor(item);
      const nearestTerminal = terminals
        .map((terminal) => ({ terminal, distance: distanceMeters(point, terminal) }))
        .filter((candidate) => candidate.distance <= 7000)
        .sort((a, b) => a.distance - b.distance)[0]?.terminal;
      const tags = item.tags || {};
      return {
        id: `${item.type}:${item.id}`,
        name: tags.name,
        lat: point.lat,
        lon: point.lon,
        accessLat: nearestTerminal?.lat ?? point.lat,
        accessLon: nearestTerminal?.lon ?? point.lon,
        terminal: nearestTerminal?.name || "",
        iata: tags.iata || "",
        icao: tags.icao || "",
        ref: tags.ref || "",
        type: tags["aerodrome:type"] || "",
        serves: tags.serves || "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "OpenGeofiction Overpass",
    flightRelations: [],
    airports,
  };
  await writeFile(target, JSON.stringify(payload));
  console.log(JSON.stringify({ target, airports: airports.length, terminals: terminals.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
