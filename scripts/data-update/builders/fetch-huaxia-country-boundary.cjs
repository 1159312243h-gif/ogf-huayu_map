const { readFile, writeFile } = require("node:fs/promises");

const target = "work/huaxia-country-boundary.json";
const url = "https://nominatim.opengeofiction.net/lookup?osm_ids=R28652&format=json&polygon_geojson=1";

(async () => {
  if (process.argv.includes("--resume")) {
    try {
      const cached = JSON.parse(await readFile(target, "utf8"));
      if (["Polygon", "MultiPolygon"].includes(cached.geometry?.type)) {
        console.log(JSON.stringify({ target, cached: true, type: cached.geometry.type }, null, 2));
        return;
      }
    } catch {}
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "OGF-Atlas/3.0 (national railway build)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const results = await response.json();
  const result = results.find((item) => item.osm_type === "relation" && Number(item.osm_id) === 28652);
  const geometry = result?.geojson;
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
    throw new Error("Huaxia relation 28652 did not return polygon geometry");
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    source: url,
    relationId: 28652,
    label: result.display_name || "华夏共和国",
    boundingbox: result.boundingbox,
    geometry,
  };
  await writeFile(target, JSON.stringify(payload));
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  console.log(JSON.stringify({
    target,
    type: geometry.type,
    polygons: polygons.length,
    rings: polygons.reduce((sum, polygon) => sum + polygon.length, 0),
    points: polygons.reduce((sum, polygon) => sum
      + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0), 0),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
