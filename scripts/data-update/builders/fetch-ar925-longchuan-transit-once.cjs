const { readFile, writeFile } = require("node:fs/promises");

const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const output = "work/ar925-longchuan-transit-raw.json";
// OGF administrative relation 478412: 龙川市 Loongchuan, AR925.
const bounds = [-0.39, 141.53, 0.25, 142.10];
const bbox = bounds.join(",");
const routePattern = "^(subway|light_rail|tram|monorail|train|bus|trolleybus)$";
const query = `[out:json][timeout:180];
(
  rel["type"="route"]["route"~"${routePattern}"](${bbox});
  rel["type"="route_master"]["route_master"~"${routePattern}"](${bbox});
)->.seedRelations;
rel(br.seedRelations)["type"="route_master"]->.parentMasters;
rel(r.seedRelations)["type"="route"]["route"~"${routePattern}"]->.childRoutes;
(.seedRelations;.parentMasters;.childRoutes;)->.railRelations;
way(r.railRelations)->.relationWays;
node(r.railRelations)->.relationNodes;
(
  nwr["railway"~"^(station|halt|tram_stop)$"]["name"](${bbox});
  nwr["station"="subway"]["name"](${bbox});
  nwr["subway"="yes"]["name"](${bbox});
  nwr["public_transport"~"^(station|stop_position|platform)$"]["name"](${bbox});
  nwr["train"="yes"]["name"](${bbox});
  nwr["highway"="bus_stop"]["name"](${bbox});
  nwr["amenity"="bus_station"]["name"](${bbox});
)->.namedStations;
way["railway"~"^(rail|narrow_gauge|subway|light_rail|tram|monorail)$"](${bbox})->.railWays;
.railRelations out body center;
(.relationWays;.railWays;);out body geom;
(.relationNodes;.namedStations;);out body center;`;

(async () => {
  if (process.argv.includes("--resume")) {
    try {
      const cached = JSON.parse(await readFile(output, "utf8"));
      if (Array.isArray(cached.elements) && cached.elements.length) {
        console.log(JSON.stringify({ output, cached: true, elements: cached.elements.length }, null, 2));
        return;
      }
    } catch {}
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(210000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Overpass ${response.status}: ${body.slice(0, 1000)}`);
  const payload = JSON.parse(body);
  if (payload.remark || !Array.isArray(payload.elements) || !payload.elements.length) {
    throw new Error(payload.remark || "AR925 Longchuan response is empty");
  }
  await writeFile(output, JSON.stringify(payload));
  const relations = payload.elements.filter((item) => item.type === "relation");
  const stations = payload.elements.filter((item) => item.tags?.name
    && (item.tags.railway === "station" || item.tags.railway === "halt"
      || item.tags.station === "subway" || item.tags.subway === "yes"
      || ["station", "stop_position", "platform"].includes(item.tags.public_transport)
      || item.tags.train === "yes" || item.tags.highway === "bus_stop"
      || item.tags.amenity === "bus_station"));
  const airportMatches = payload.elements.filter((item) => /(机场|航站楼|airport)/iu.test(item.tags?.name || ""));
  console.log(JSON.stringify({
    output,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    bounds,
    elements: payload.elements.length,
    relations: relations.length,
    stations: stations.length,
    routeTypes: [...new Set(relations.map((item) => item.tags?.route || item.tags?.route_master).filter(Boolean))],
    relationNames: relations.map((item) => item.tags?.name).filter(Boolean),
    airportMatches: airportMatches.map((item) => item.tags?.name),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
