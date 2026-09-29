const fs = require("node:fs");
const {gzipSync} = require("node:zlib");
const {createHash} = require("node:crypto");

(async () => {
  const elements = new Map();
  const fullRailwayPath = "work/huaxia-full-railways-raw.json";
  if (fs.existsSync(fullRailwayPath)) {
    const payload = JSON.parse(fs.readFileSync(fullRailwayPath, "utf8"));
    payload.elements.filter(way => way.type === "way").forEach(way => elements.set(way.id, way));
  }
  const regionDirectory="work/railway-routing-country-regions";
  if(fs.existsSync(regionDirectory))for(const filename of fs.readdirSync(regionDirectory)) {
    const payload=JSON.parse(fs.readFileSync(`${regionDirectory}/${filename}`,"utf8"));
    payload.elements.filter(way=>way.type==="way").forEach(way=>elements.set(way.id,way));
  }
  const relationSnapshots=require("../outputs/ogf-atlas/transit-relations.json").snapshots;
  const additionalRegionWayIds = new Set(relationSnapshots
    .filter((snapshot) => snapshot.id !== "huaxia")
    .flatMap((snapshot) => (snapshot.elements || []).filter((way) => way.type === "way"
      && ["rail", "narrow_gauge", "subway", "light_rail", "tram", "monorail"].includes(way.tags?.railway)))
    .map((way) => way.id));
  const known=relationSnapshots.flatMap(snapshot=>(snapshot.elements||[]).filter(way=>way.type==="way"
    && (snapshot.id === "huaxia"
      ? ["rail","narrow_gauge"].includes(way.tags?.railway)
      : ["rail","narrow_gauge","subway","light_rail","tram","monorail"].includes(way.tags?.railway))));
  known.forEach(way=>{if(!elements.has(way.id))elements.set(way.id,way);});
  const currentIdsPath = "work/railway-routing-ids-current.json";
  const sourceIdsPath = fs.existsSync(currentIdsPath) ? currentIdsPath : "work/railway-routing-ids.json";
  const sourceIds=JSON.parse(fs.readFileSync(sourceIdsPath,"utf8")).elements.map(way=>way.id);
  const baselinePath = "work/history-feeder-compare/ogf-atlas-v2.1.5-2026-09-19/railway-routing.json";
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baselineIds = new Set((baseline.ways || []).map((way) => way[0]));
  if (baselineIds.size < 8000) throw new Error(`Published railway baseline is unexpectedly small: ${baselineIds.size}`);
  for (const way of baseline.ways || []) {
    if (elements.has(way[0])) continue;
    elements.set(way[0], {
      type: "way",
      id: way[0],
      nodes: way[1],
      geometry: (way[2] || []).map((point) => ({ lat: point[0], lon: point[1] })),
      tags: { name: way[3] || "", maxspeed: way[4] || "", highspeed: way[5] ? "yes" : "" },
    });
  }
  const batchDirectory = "work/railway-routing-way-batches";
  if (fs.existsSync(batchDirectory)) for (const filename of fs.readdirSync(batchDirectory)) {
    const payload = JSON.parse(fs.readFileSync(`${batchDirectory}/${filename}`, "utf8"));
    payload.elements.forEach(way => elements.set(way.id, way));
  }
  const missing=sourceIds.filter(id=>!elements.has(id)).sort((a,b)=>a-b);
  const batches=[];
  if (missing.length && process.argv.includes("--fetch-missing-once")) {
    for (let index = 0; index < missing.length; index += 350) batches.push(missing.slice(index, index + 350));
  }
  fs.mkdirSync("work/railway-routing-way-batches",{recursive:true});
  let next=0;
  const failed=[];
  async function worker() {
    while(next<batches.length) {
      const index=next++;
      const query=`[out:json][timeout:30];way(id:${batches[index].join(",")});out body geom;`;
      const batchHash=createHash("sha256").update(JSON.stringify(batches[index])).digest("hex").slice(0,16);
      const cachePath=`work/railway-routing-way-batches/batch-${batchHash}.json`;
      let payload=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,"utf8")):null;
      for(let attempt=0;attempt<1;attempt+=1) {
        if(payload)break;
        try{
          const response=await fetch("https://overpass.opengeofiction.net/api/interpreter",{
            method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
            body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(90000),
          });
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const parsed=await response.json();
          if(parsed.remark)throw new Error(parsed.remark);
          payload=parsed;
          fs.writeFileSync(cachePath,JSON.stringify(payload));
          break;
        }catch(error){failed.push({index,error:error.message});}
      }
      if(!payload)continue;
      payload.elements.forEach(way=>elements.set(way.id,way));
      console.log(`Railway batch ${index+1}/${batches.length}: ${payload.elements.length} ways`);
    }
  }
  await worker();
  if(failed.length)throw new Error(`Incomplete railway batches: ${JSON.stringify(failed)}`);
  const allowedWayIds = new Set([...sourceIds, ...baselineIds, ...additionalRegionWayIds]);
  const ways = [...elements.values()].filter(way=>allowedWayIds.has(way.id)
    && way.type==="way" && way.nodes?.length===way.geometry?.length
    && way.geometry.length>1 && way.geometry.every(point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lon)));
  if(ways.length<8000)throw new Error(`Insufficient cached railway data: ${ways.length} ways`);
  const validIds = new Set(ways.map(way => way.id));
  // These two current OGF ways each contain only one node. They are valid
  // tagged objects but cannot form a drawable or routable line segment.
  const invalidSourceWayIds = [592659, 2473820].filter(id => sourceIds.includes(id));
  const invalidSourceWayIdSet = new Set(invalidSourceWayIds);
  const missingSourceIds = sourceIds.filter(id => !validIds.has(id) && !invalidSourceWayIdSet.has(id));
  const stations = new Map();
  const places = new Map();
  const addStation = (id, lat, lon, name, sourceLat = lat, sourceLon = lon) => {
    const label = String(name || "").trim();
    if (id == null || !Number.isFinite(lat) || !Number.isFinite(lon) || !label
      || /(?:未命名|待命名|无名(?:站|车站)|\bunnamed\b|\bunknown\b)/iu.test(label)) return;
    stations.set(String(id), [id, lat, lon, label,
      Number.isFinite(sourceLat) ? sourceLat : lat, Number.isFinite(sourceLon) ? sourceLon : lon]);
  };
  for (const snapshot of relationSnapshots) {
    for (const station of snapshot.elements || []) {
      const tags = station.tags || {};
      if (!["station", "halt"].includes(tags.railway) || tags.station === "subway"
        || tags.subway === "yes" || tags.tram === "yes" || tags.train === "no"
        || ["no", "private"].includes(String(tags.access || "").toLowerCase())
        || ["yes", "true", "1"].includes(String(tags.disused || tags.abandoned || "").toLowerCase())) continue;
      addStation(station.id, Number(station.lat ?? station.center?.lat),
        Number(station.lon ?? station.center?.lon), tags.name);
    }
  }
  const preloadPath = "outputs/ogf-atlas/transit-preload.json";
  if (fs.existsSync(preloadPath)) {
    const preload = JSON.parse(fs.readFileSync(preloadPath, "utf8"));
    (preload.snapshots || []).forEach((snapshot) => {
      const network = snapshot.network;
      if (network?.format !== 2) return;
      (network.stops || []).filter((stop) => stop[9] === 1).forEach((stop) =>
        addStation(stop[0], stop[1], stop[2], stop[5], stop[3], stop[4]));
    });
  }
  const stationSnapshots = ["work/jinchuan-rail-stations-live-20260921.json"];
  stationSnapshots.filter((path) => fs.existsSync(path)).forEach((path) => {
    const payload = JSON.parse(fs.readFileSync(path, "utf8"));
    (payload.stations || []).forEach((station) => {
      const tags = station.tags || {};
      if (!["station", "halt"].includes(tags.railway) || tags.station === "subway"
        || tags.subway === "yes" || tags.tram === "yes" || tags.train === "no"
        || ["no", "private"].includes(String(tags.access || "").toLowerCase())
        || ["yes", "true", "1"].includes(String(tags.disused || tags.abandoned || "").toLowerCase())) return;
      addStation(station.id, Number(station.lat), Number(station.lon), tags.name);
    });
  });
  const placeSnapshots = ["work/huaxia-railway-direction-places-live-20260922.json"];
  placeSnapshots.filter((path) => fs.existsSync(path)).forEach((path) => {
    const payload = JSON.parse(fs.readFileSync(path, "utf8"));
    (payload.elements || []).forEach((place) => {
      const tags = place.tags || {};
      const label = String(tags.name || "").trim();
      const kind = String(tags.place || "").trim();
      const lat = Number(place.lat), lon = Number(place.lon);
      if (!["city", "town"].includes(kind) || !label || /^(?:市|县|区|镇|乡|地方|街道)$/u.test(label)
        || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const key = `${place.type || "node"}/${place.id}`;
      places.set(key, [key, lat, lon, label, kind]);
    });
  });
  const data = {format:1,generatedAt:new Date().toISOString(),source:"OpenGeofiction",
    coverage:{sourceWays:sourceIds.length,drawableSourceWays:sourceIds.length-invalidSourceWayIds.length,
      missingWays:missingSourceIds.length,invalidSourceWayIds,complete:!missingSourceIds.length,
      sourceRule:'railway=rail|narrow_gauge and no service tag',baseline:'published-snapshot-compatible-current-ids',
      additionalCountries:["Kadah (卡达赫)"],additionalRegions:["AR925 Loongchuan (龙川市)"]},
    stations:[...stations.values()],places:[...places.values()],
    ways:ways.map(way=>[
    way.id, way.nodes, way.geometry.map(point=>[point.lat,point.lon]),way.tags?.name||"",
    way.tags?.maxspeed||"",way.tags?.highspeed==="yes"?1:0,
  ])};
  const json = JSON.stringify(data);
  fs.writeFileSync("outputs/ogf-atlas/railway-routing.json",json);
  console.log(JSON.stringify({ways:ways.length,stations:stations.size,places:places.size,points:ways.reduce((sum,way)=>sum+way.nodes.length,0),
    bytes:Buffer.byteLength(json),gzipBytes:gzipSync(json).length,coverage:data.coverage,sharedNodeTopologyPreserved:true},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
