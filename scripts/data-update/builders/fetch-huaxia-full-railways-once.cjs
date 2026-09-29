const { mkdir, readFile, writeFile } = require("node:fs/promises");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const output = "work/huaxia-full-railways-raw.json";
const nonServiceInput = "work/huaxia-nonservice-railways-raw.json";
const cacheDirectory = "work/huaxia-service-railways-cache";
const longitudeBreaks = [139.6123328, 143, 146.5, 150, 153.5, 157, 160.5, 164, 166.8539534];
const latitudeBreaks = [2.9833913, 12, 21, 30, 37.2533652];
const slices = latitudeBreaks.slice(0, -1).flatMap((south, latitudeIndex) =>
  longitudeBreaks.slice(0, -1).map((west, longitudeIndex) => [
    south,
    west,
    latitudeBreaks[latitudeIndex + 1],
    longitudeBreaks[longitudeIndex + 1],
  ]));

async function fetchSlice(bounds, index) {
  const cachePath = `${cacheDirectory}/service-${index + 1}-${slices.length}.json`;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (Array.isArray(cached.elements)) {
      console.log(`Using cached service railway tracks ${index + 1}/${slices.length}: ${cached.elements.length} elements`);
      return cached;
    }
  } catch {}
  const query = `[out:json][timeout:180];rel(28652);map_to_area->.country;
way["railway"~"^(rail|narrow_gauge)$"]["service"](area.country)(${bounds.join(",")});out body geom;`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`Fetching service railway tracks ${index + 1}/${slices.length}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(210000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Overpass ${response.status}: ${body.slice(0, 1000)}`);
      const payload = JSON.parse(body);
      if (payload.remark || !Array.isArray(payload.elements)) {
        throw new Error(payload.remark || "Huaxia service railway response is malformed");
      }
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(cachePath, JSON.stringify(payload));
      console.log(`Fetched service railway tracks ${index + 1}/${slices.length}: ${payload.elements.length} elements`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      console.warn(`Service railway slice ${index + 1} attempt ${attempt} failed: ${error.message}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

(async () => {
  const nonService = JSON.parse(await readFile(nonServiceInput, "utf8"));
  if (!Array.isArray(nonService.elements) || !nonService.elements.length) {
    throw new Error("Huaxia non-service railway slices are missing");
  }
  const servicePayloads = [];
  for (const [index, bounds] of slices.entries()) servicePayloads.push(await fetchSlice(bounds, index));
  const serviceElements = [...new Map(servicePayloads.flatMap((payload) => payload.elements)
    .map((way) => [`${way.type}:${way.id}`, way])).values()];
  const metadata = servicePayloads.find((payload) => payload.osm3s) || {};
  const elements = [...new Map([...nonService.elements, ...serviceElements]
    .map((way) => [`${way.type}:${way.id}`, way])).values()];
  const payload = {
    version: metadata.version,
    generator: metadata.generator,
    osm3s: metadata.osm3s,
    elements,
  };
  if (!elements.length) throw new Error("Huaxia merged railway response is empty");
  await writeFile(output, JSON.stringify(payload));
  const usable = elements.filter((way) => way.type === "way"
    && Array.isArray(way.nodes) && way.nodes.length === way.geometry?.length
    && way.geometry.length > 1);
  console.log(JSON.stringify({
    output,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    nonServiceWays: nonService.elements.length,
    serviceWays: serviceElements.length,
    ways: elements.filter((item) => item.type === "way").length,
    usableWays: usable.length,
    points: usable.reduce((sum, way) => sum + way.geometry.length, 0),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
