const fs = require("node:fs/promises");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const target = "outputs/ogf-atlas/station-access.json";
const cacheDirectory = "work/station-access-cache";
const longitudeBreaks = [139.6123328, 143, 146.5, 150, 153.5, 157, 160.5, 164, 166.8539534];
const latitudeBreaks = [2.9833913, 12, 21, 30, 37.2533652];
const slices = latitudeBreaks.slice(0, -1).flatMap((south, latitudeIndex) =>
  longitudeBreaks.slice(0, -1).map((west, longitudeIndex) => [
    south,
    west,
    latitudeBreaks[latitudeIndex + 1],
    longitudeBreaks[longitudeIndex + 1],
  ]));

function queryFor(kind, bounds) {
  const bbox = bounds.join(",");
  const setup = `rel(28652);map_to_area->.country;
    nwr["railway"~"^(station|halt)$"](area.country)(${bbox})->.stations;`;
  if (kind === "features") return `[out:json][timeout:180];${setup}
    (node["railway"="subway_entrance"](area.country)(${bbox});
     node(around.stations:650)["entrance"];
     rel["public_transport"="stop_area"](area.country)(${bbox});
     way["building"="train_station"](area.country)(${bbox});
     way["railway"="station"](area.country)(${bbox}););out body geom;`;
  return `[out:json][timeout:180];${setup}
    way(around.stations:650)["highway"~"^(footway|pedestrian|steps|path|corridor)$"];
    out body geom;`;
}

async function fetchSlice(kind, bounds, index) {
  const cachePath = `${cacheDirectory}/${kind}-${index + 1}-${slices.length}.json`;
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Array.isArray(cached.elements)) {
      console.log(`Using cached station access ${kind} ${index + 1}/${slices.length}: ${cached.elements.length}`);
      return cached.elements;
    }
  } catch {}
  const query = queryFor(kind, bounds);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`Fetching station access ${kind} ${index + 1}/${slices.length}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(210000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${kind} ${response.status}: ${body.slice(0, 500)}`);
      const payload = JSON.parse(body);
      if (payload.remark || !Array.isArray(payload.elements)) {
        throw new Error(payload.remark || `${kind} response is malformed`);
      }
      await fs.mkdir(cacheDirectory, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(payload));
      console.log(`Fetched station access ${kind} ${index + 1}/${slices.length}: ${payload.elements.length}`);
      return payload.elements;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      console.warn(`Station access ${kind} slice ${index + 1} attempt ${attempt} failed: ${error.message}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

(async () => {
  const collected = [];
  for (const kind of ["features", "paths"]) {
    for (const [index, bounds] of slices.entries()) {
      collected.push(...await fetchSlice(kind, bounds, index));
    }
  }
  const elements = [...new Map(collected.map((item) => [`${item.type}:${item.id}`, item])).values()].map((item) => {
    const { bounds, ...element } = item;
    if (element.members) element.members = element.members.map(({ geometry, ...member }) => member);
    return element;
  });
  if (!elements.length) throw new Error("station access result is empty");
  const dataset = {
    format: 1,
    generatedAt: new Date().toISOString(),
    source: endpoint,
    countryRelation: 28652,
    elements,
  };
  await fs.writeFile(target, JSON.stringify(dataset));
  console.log(JSON.stringify({
    target,
    slices: slices.length,
    elements: elements.length,
    entrances: elements.filter((item) => item.tags?.railway === "subway_entrance" || item.tags?.entrance).length,
    paths: elements.filter((item) => item.tags?.highway).length,
    stopAreas: elements.filter((item) => item.tags?.public_transport === "stop_area").length,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
