const fs = require("node:fs/promises");
const path = require("node:path");
const {createHash} = require("node:crypto");

// Context is part of the same successful snapshot transaction as the mountain
// geometry. Inventory first avoids downloading every building in distant cities.
async function buildTerrainContext({surfaces, slices, runtime, cacheDirectory, fetch: request = fetch, resume = false,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds))}) {
  const boundsOf = geometry => {
    const b = {west:Infinity,east:-Infinity,south:Infinity,north:-Infinity};
    const visit = value => {
      if (typeof value?.[0] === "number") {
        b.west=Math.min(b.west,value[0]); b.east=Math.max(b.east,value[0]);
        b.south=Math.min(b.south,value[1]); b.north=Math.max(b.north,value[1]);
      } else if (Array.isArray(value)) value.forEach(visit);
    };
    visit(geometry.coordinates); return b;
  };
  const intersects = (a,b) => a.west<=b.east && a.east>=b.west && a.south<=b.north && a.north>=b.south;
  const index = new Map();
  const surfaceIds = new Set();
  for (const feature of surfaces) {
    surfaceIds.add(`${feature.properties.osmType}:${feature.properties.sourceOsmId}`);
    const bounds=boundsOf(feature.geometry);
    const polygons=feature.geometry.type==="Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const contains=polygons.map(polygon=>runtime.huayuMountainOuterContains(polygon[0],boundsOf({coordinates:[polygon[0]]})));
    const item={feature,bounds,contains:point=>contains.some(test=>test(point))};
    for (let y=Math.floor(bounds.south);y<=Math.floor(bounds.north);y++) {
      for (let x=Math.floor(bounds.west);x<=Math.floor(bounds.east);x++) {
        const key=`${y}/${x}`; if (!index.has(key)) index.set(key,[]); index.get(key).push(item);
      }
    }
  }
  const candidates = bounds => {
    const found=new Set();
    for (let y=Math.floor(bounds.south);y<=Math.floor(bounds.north);y++) {
      for (let x=Math.floor(bounds.west);x<=Math.floor(bounds.east);x++) {
        for (const item of index.get(`${y}/${x}`)||[]) if (intersects(item.bounds,bounds)) found.add(item);
      }
    }
    return [...found];
  };
  const isWater = tags => tags.natural==="water" || tags.waterway || tags.landuse==="reservoir";
  const selected = item => {
    const tags=item.tags||{};
    if (!isWater(tags) && !tags.building && !/^(garden|park|pitch|swimming_pool)$/u.test(tags.leisure||"")) return false;
    if (surfaceIds.has(`${item.type}:${item.id}`) || !item.bounds) return false;
    const b={west:item.bounds.minlon,east:item.bounds.maxlon,south:item.bounds.minlat,north:item.bounds.maxlat};
    if (!Object.values(b).every(Number.isFinite)) throw Error("Invalid terrain context inventory bounds");
    const nearby=candidates(b);
    if (!nearby.length) return false;
    // Water lines can cross a range with both endpoints outside it. Keep their
    // complete geometries; buildings/gardens use their mapped interior location.
    if (isWater(item.tags||{})) return true;
    const points=[[(b.west+b.east)/2,(b.south+b.north)/2],[b.west,b.south],[b.east,b.north],
      [b.west,b.north],[b.east,b.south]];
    return nearby.some(({contains})=>points.some(contains));
  };
  await fs.mkdir(cacheDirectory,{recursive:true});
  const queryElements = async query => {
    const key=createHash("sha256").update(query).digest("hex");
    const target=path.join(cacheDirectory,`context-${key}.json`);
    if (resume) {
      try {const cached=JSON.parse(await fs.readFile(target,"utf8"));
        if (cached.query===query && Array.isArray(cached.elements) && !cached.remark) return cached.elements;
      } catch {}
    }
    for (let attempt=0;attempt<3;attempt++) {
      const response=await request("https://overpass.opengeofiction.net/api/interpreter",{
        method:"POST",body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(150000)});
      if (response.status===429 && attempt<2) {
        const retryAfter=response.headers.get("retry-after") || "";
        const requestedDelay=/^\s*\d+\s*$/u.test(retryAfter) ? Number(retryAfter)*1000
          : Math.max(0,Date.parse(retryAfter)-Date.now()) || 0;
        const delay=Math.max(30000*(attempt+1),requestedDelay);
        if (delay>120000) throw Error("Terrain context: HTTP 429; Retry-After exceeds the bounded retry window");
        await response.body?.cancel();
        console.log(`Terrain context rate limit: retry in ${Math.ceil(delay/1000)}s`);
        await wait(delay);
        continue;
      }
      if (!response.ok) throw Error(`Terrain context: HTTP ${response.status}`);
      const payload=await response.json();
      if (payload.remark || !Array.isArray(payload.elements)) {
        if (attempt<2) continue;
        throw Error(payload.remark || "Invalid terrain context response");
      }
      await fs.writeFile(target,JSON.stringify({query,elements:payload.elements}));
      return payload.elements;
    }
  };
  const inventory=new Map();
  for (const slice of slices) {
    if (!candidates(slice.bounds).length) continue;
    const b=slice.bounds;
    const bbox=`${b.south},${b.west},${b.north},${b.east}`;
    const filters=['["natural"="water"]','["waterway"]','["landuse"="reservoir"]',
      '["building"]','["leisure"~"^(garden|park|pitch|swimming_pool)$"]'];
    const query=`[out:json][timeout:90];(${filters.flatMap(filter=>[
      `way${filter}(${bbox});`,`rel["type"="multipolygon"]${filter}(${bbox});`]).join("")});out tags bb;`;
    const items=await queryElements(query);
    for (const item of items) if (selected(item)) inventory.set(`${item.type}:${item.id}`,item);
    console.log(`Terrain context inventory ${slice.id}: ${inventory.size} mapped features`);
  }
  const features=[];
  for (const [type,batchSize] of [["way",150],["relation",4]]) {
    const items=[...inventory.values()].filter(item=>item.type===type);
    for (let offset=0;offset<items.length;offset+=batchSize) {
      const batch=items.slice(offset,offset+batchSize);
      const query=`[out:json][timeout:120];${type}(id:${batch.map(item=>item.id).join(",")});out body geom;`;
      const elements=await queryElements(query);
      const byId=new Map(elements.map(item=>[String(item.id),item]));
      for (const item of batch) {
        const element=byId.get(String(item.id));
        if (!element) throw Error(`Missing terrain context geometry: ${type}:${item.id}`);
        const tags=element.tags||{};
        if (tags.tunnel && tags.tunnel!=="no") continue;
        let geometry;
        if (type==="relation") geometry=runtime.huayuCityWallRelationGeometry(element,new Map(
          (element.members||[]).filter(member=>member.type==="way" && member.geometry?.length)
            .map(member=>[String(member.ref),member])));
        else {
          const coordinates=runtime.huayuWallCoordinates(element);
          if (coordinates.length<2) throw Error(`Empty terrain context geometry: ${type}:${item.id}`);
          geometry={type: coordinates.length>3 && runtime.huayuWallPointKey(coordinates[0])
            ===runtime.huayuWallPointKey(coordinates.at(-1)) ? "Polygon" : "LineString",coordinates};
          if (geometry.type==="Polygon") geometry.coordinates=[coordinates];
        }
        if (!geometry && type==="relation" && (element.members||[]).some(member=>member.type==="way")
          && (element.members||[]).filter(member=>member.type==="way").every(member=>member.geometry?.length)) {
          // Complete OGF responses can contain broken, unclosed multipolygons.
          // Match the basemap parser: do not invent a closing edge or a rectangle.
          console.warn(`Terrain context skipped unclosed source relation: ${item.id}`);
          continue;
        }
        if (!geometry) throw Error(`Invalid terrain context geometry: ${type}:${item.id}`);
        const water=isWater(tags);
        const kind=water ? "water" : tags.building ? "building" : "garden";
        features.push({type:"Feature",id:`terrain-context:${type}:${item.id}`,geometry,properties:{
          renderKind:water ? geometry.type.includes("LineString") ? "waterway" : "water" : "terrain-context",
          featureClass:water ? tags.waterway || tags.water || "water" : kind,
          materialOcclusion:kind,landscapeKind:kind==="garden" ? tags.leisure || "garden" : "",
          terrainContext:1,osmType:type,osmId:String(item.id),
          name:runtime.huayuPreferredFeatureName(tags),layer:Number(tags.layer)||0,tunnel:0,bridge:tags.bridge&&tags.bridge!=="no"?1:0,
          terrainValley:water && tags.water!=="pond"
            && (!tags.waterway || ["river","stream","riverbank"].includes(tags.waterway)) ? 1 : 0,
          width:Number.parseFloat(tags.width)||0,intermittent:tags.intermittent==="yes"?1:0,
        }});
      }
      console.log(`Terrain context geometry ${type}: ${Math.min(items.length,offset+batchSize)}/${items.length}`);
    }
  }
  return features.sort((a,b)=>a.id.localeCompare(b.id));
}
module.exports={buildTerrainContext};
