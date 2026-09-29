const fs = require("node:fs");

const countryArea = 3600305055;
const countryRelation = 305055;
const query = `[out:json][timeout:180];
  area(${countryArea})->.country;
  rel["ogf:id"="UL23d"]->.countryRelation;
  rel["type"="route"]["route"~"^(subway|light_rail|tram|monorail|train)$"](area.country)->.railRoutes;
  rel(br.railRoutes)["type"="route_master"]->.railMasters;
  (.railRoutes;.railMasters;)->.railRelations;
  way(r.railRoutes)->.railWays;
  node(r.railRoutes)->.railStops;
  way["railway"~"^(subway|light_rail|tram|monorail)$"]["name"](area.country)->.namedTracks;
  way["railway"~"^(rail|narrow_gauge)$"][!"service"](area.country)->.railInfrastructure;
  (nwr["railway"~"^(station|halt|tram_stop)$"]["name"](area.country);
   nwr["station"="subway"]["name"](area.country);
   nwr["subway"="yes"]["name"](area.country);
   nwr["public_transport"~"^(station|stop_position|platform)$"]["name"](area.country);
   nwr["building"="train_station"]["name"](area.country);
   nwr["train"="yes"]["name"](area.country);)->.railStations;
  .countryRelation out bb tags;
  .railRelations out body center;
  (.railWays;.namedTracks;.railInfrastructure;);out body geom;
  (.railStops;.railStations;);out body center;`;

(async () => {
  const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
  const output = "work/cardahe-rail-raw.json";
  if (process.argv.includes("--resume") && fs.existsSync(output)) {
    const cached = JSON.parse(fs.readFileSync(output, "utf8"));
    if (Array.isArray(cached.elements) && cached.elements.length) {
      console.log(JSON.stringify({ output, cached: true, elements: cached.elements.length }, null, 2));
      return;
    }
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(240000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);
  const payload = JSON.parse(body);
  if (payload.remark || !Array.isArray(payload.elements) || !payload.elements.length) {
    throw new Error(payload.remark || "Kadah railway response is empty");
  }
  fs.writeFileSync(output, JSON.stringify(payload));
  const counts = payload.elements.reduce((result, item) => {
    result[item.type] = (result[item.type] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({ countryArea, countryRelation, timestamp: payload.osm3s?.timestamp_osm_base, counts }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
