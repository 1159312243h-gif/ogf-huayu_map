  function trafficRegionQueries(ids,b) {
    const LIMITS={regions:4};
    if(!Array.isArray(ids)||!ids.length||ids.length>LIMITS.regions||ids.some(id=>!Number.isSafeInteger(id)||id<=0)
      ||!Array.isArray(b)||b.length!==4||b.some(v=>!Number.isFinite(v))||b[0]>=b[2]||b[1]>=b[3]
      ||b[0]<-180||b[2]>180||b[1]<-90||b[3]>90||b[2]-b[0]>12||b[3]-b[1]>12)throw Error("行政区或范围无效，最多 4 区且跨度不超过 12°");
    const areas=ids.map(id=>`area(${3600000000+id});`).join(""),rels=ids.map(id=>`rel(${id});`).join("");
    const pattern="motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service";
    const bbox=`${b[1]},${b[0]},${b[3]},${b[2]}`;
    return [
      `[out:json][timeout:80];(${areas})->.a;(${rels}rel(area.a)[boundary=administrative];)->.r;(.r;node(r.r:"admin_centre");node(area.a)[population];node(area.a)["population:hx"];node(area.a)[place~"^(country|state|province|region|city|town|suburb|quarter|neighbourhood|village|hamlet)$"];);out body geom;out count;`,
      `[out:json][timeout:80];(${areas})->.a;(way(area.a)[highway~"^(${pattern})(_link)?$"];${ids.length>1?`way(${bbox})[highway~"^(motorway|trunk|primary|secondary)(_link)?$"];`:""});out body geom;out count;`,
      `[out:json][timeout:80];(${areas})->.a;(nwr(area.a)[amenity~"^(parking|parking_entrance|school|university|college|kindergarten|hospital|clinic|doctors|cafe|restaurant|fast_food|bank|marketplace|post_office)$"];nwr(area.a)[railway~"^(station|halt)$"];nwr(area.a)[public_transport=station][train=yes];nwr(area.a)[aeroway~"^(aerodrome|terminal)$"];nwr(area.a)[shop][shop!~"^(no|vacant|closed)$"];nwr(area.a)[office];nwr(area.a)[leisure~"^(park|garden|sports_centre|stadium)$"];nwr(area.a)[landuse~"^(residential|industrial|commercial|retail)$"];)->.f;(nwr.f[amenity=parking];nwr.f[aeroway=aerodrome];nwr.f[landuse];)->.shape;(.f; - .shape;)->.rest;.rest out body center;.shape out body geom;.f out count;`,
      `[out:json][timeout:80];(${areas})->.a;nwr(area.a)[building][building!=no];out body geom;out count;`
    ];
  }

const fetchTrafficRegion=(()=>{
const regions={LIMITS:{bytes:32*1024*1024,objects:60000},queries:trafficRegionQueries};
const TTL=120000;
async function bounded(promise,ms=200){
  let timer;
  try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}
  catch{return null;}finally{clearTimeout(timer);}
}
function reply(body,headers){
  // Upstream JSON is uncompressed. Compress the same full payload on the edge;
  // never simplify its geometry or omit tags to reduce download size.
  const stream=(typeof body==="string"?new Blob([body]).stream():body).pipeThrough(new CompressionStream("gzip"));
  return new Response(stream,{headers:{"Content-Type":"application/json; charset=UTF-8",
    "Content-Encoding":"gzip","Cache-Control":"public, max-age=120, must-revalidate, no-transform",...headers},encodeBody:"manual"});
}
async function fetchTrafficRegion(request,context={}){
  const url=new URL(request.url);
  if(request.method!=="GET")return new Response(null,{status:405});
  let query,part;
  try{
    const ids=(url.searchParams.get("ids")||"").split(",").map(Number).sort((a,b)=>a-b);
    const bounds=(url.searchParams.get("bounds")||"").split(",").map(Number);
    part=url.searchParams.get("part");
    if(!/^[0-3]$/u.test(part)||new Set(ids).size!==ids.length)throw Error();
    query=regions.queries(ids,bounds)[Number(part)];
  }catch{return new Response("行政区查询范围无效",{status:400});}
  const reload=url.searchParams.get("reload")==="1";
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(query));
  const hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,"0")).join("");
  const key=new Request(`${url.origin}/__traffic-region-v1/${hash}`);
  if(!reload&&globalThis.caches?.default){
    const cached=await bounded(caches.default.match(key));
    const readAt=Number(cached?.headers.get("x-huayu-read-at"));
    if(cached&&readAt>0&&Date.now()>=readAt&&Date.now()-readAt<TTL){
      const body=await bounded(cached.text());
      if(body)return reply(body,{"x-huayu-read-at":String(readAt),"x-huayu-traffic-cache":"HIT",
        "Cache-Control":`public, max-age=${Math.max(0,Math.floor((TTL-Date.now()+readAt)/1000))}, must-revalidate, no-transform`});
    }
  }
  try{
    // Forward bytes as they arrive: buffering the whole region here would turn
    // a slow but healthy transfer into the client's 95 s response timeout.
    const controller=new AbortController();let timer,hard,reader,size=0,chunks=[],cacheable=true;
    const abort=()=>controller.abort(),arm=ms=>{clearTimeout(timer);timer=setTimeout(abort,ms);};
    const cleanup=()=>{clearTimeout(timer);clearTimeout(hard);request.signal.removeEventListener("abort",abort);};
    request.signal.addEventListener("abort",abort,{once:true});if(request.signal.aborted)abort();
    hard=setTimeout(abort,300000);arm(95000);
    let response;
    try{
      response=await fetch("https://overpass.opengeofiction.net/api/interpreter",{method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`data=${encodeURIComponent(query)}`,signal:controller.signal,credentials:"omit"});
      if(!response.ok){cleanup();const status=response.status;await response.body?.cancel();return new Response(null,{status,headers:{"Cache-Control":"no-store","Retry-After":response.headers.get("retry-after")||"3"}});}
      if(!response.body)throw Error("区域数据响应为空");
      if(Number(response.headers.get("content-length"))>regions.LIMITS.bytes)throw Error("区域响应超过 32 MiB");
      reader=response.body.getReader();arm(30000);
    }catch(error){cleanup();abort();await response?.body?.cancel().catch(()=>{});throw error;}
    const readAt=Date.now(),headers={"x-huayu-read-at":String(readAt),"x-huayu-traffic-cache":"MISS"};
    const stream=new ReadableStream({
      async pull(output){
        try{
          const {value,done}=await reader.read();
          if(done){
            cleanup();output.close();
            if(cacheable&&globalThis.caches?.default){
              const write=(async()=>{
                const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}chunks=[];
                const body=new TextDecoder().decode(bytes),payload=JSON.parse(body),counts=payload.elements?.filter(e=>e.type==="count");
                if(payload.remark||counts?.length!==1||!Number.isSafeInteger(Number(counts[0].tags?.total))
                  ||Number(counts[0].tags.total)!==payload.elements.length-1||payload.elements.length-1>regions.LIMITS.objects)return;
                const ids=new Set(),point=p=>p&&Number.isFinite(p.lon)&&Math.abs(p.lon)<=180&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90;
                for(const e of payload.elements){
                  if(e.type==="count")continue;
                  const identity=`${e.type}:${e.id}`;
                  if(!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0||ids.has(identity))return;
                  ids.add(identity);
                  if(e.type==="node"&&!point(e)||e.geometry?.some(p=>!point(p)))return;
                  if(part==="1"&&(e.type!=="way"||!e.geometry?.length||e.nodes?.length!==e.geometry.length))return;
                  if(e.members?.some(m=>m.geometry?.some(p=>!point(p))))return;
                }
                await caches.default.put(key,new Response(body,{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=120",...headers}}));
              })().catch(()=>{});
              context.waitUntil?.(write);
            }
            return;
          }
          size+=value.length;if(size>regions.LIMITS.bytes)throw Error("区域响应超过 32 MiB");
          // Cache memory has its own cap, independent of the accepted input.
          if(size>8*1024*1024){cacheable=false;chunks=[];}else if(cacheable)chunks.push(value);
          arm(30000);output.enqueue(value);
        }catch(error){cleanup();abort();chunks=[];await reader.cancel().catch(()=>{});output.error(error);}
      },
      async cancel(){cleanup();abort();chunks=[];await reader.cancel().catch(()=>{});}
    });
    // A live stream has not passed its final count yet. Only the already
    // validated edge HIT may be stored by the browser's HTTP cache.
    return reply(stream,{...headers,"Cache-Control":"no-store"});
  }catch(error){
    const reason=error.name==="AbortError"?"区域数据响应超时或请求已取消":String(error.message||"区域数据读取失败");
    return new Response(JSON.stringify({error:reason}),{status:error.status||502,
      headers:{"Content-Type":"application/json","Cache-Control":"no-store","x-huayu-error":encodeURIComponent(reason)}});
  }
}

return fetchTrafficRegion;
})();

const OGF_OVERPASS_URL = "https://overpass.opengeofiction.net/api/interpreter";
const BUILDING_TILE_ZOOMS = new Set([11, 12, 13, 14, 15]);
const BUILDING_CACHE_SECONDS = 120;
const BUILDING_QUERY_TIMEOUT_MS = 30000;
const STRUCTURE_TILE_ZOOMS = BUILDING_TILE_ZOOMS;
const STRUCTURE_REFRESH_SECONDS = 120;
const STRUCTURE_RETENTION_SECONDS = 604800;
const STRUCTURE_QUERY_TIMEOUT_MS = 20000;
const LIVE_BASEMAP_TILE_ZOOMS = new Set([13, 14, 15]);
const ROAD_OVERVIEW_TILE_ZOOMS = new Set([11, 12]);
const LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS = new Set([13, 14]);
const LIVE_BASEMAP_SNAPSHOT_REFRESH_SECONDS = 10800;
const LIVE_BASEMAP_SNAPSHOT_RETENTION_SECONDS = 604800;
const LIVE_BASEMAP_DETAIL_REFRESH_SECONDS = 120;
const LIVE_BASEMAP_DETAIL_RETENTION_SECONDS = 1800;
const LIVE_BASEMAP_QUERY_TIMEOUT_MS = 30000;
const TERRAIN_TILE_ZOOM = 9;
const TERRAIN_REFRESH_SECONDS = 10800;
const TERRAIN_RETENTION_SECONDS = 604800;
const TERRAIN_QUERY_TIMEOUT_MS = 35000;
const TRANSIT_TILE_ZOOMS = Object.freeze({ rail: 10, bus: 12 });
const TRANSIT_REFRESH_SECONDS = 10800;
const TRANSIT_RETENTION_SECONDS = 604800;
const TRANSIT_QUERY_TIMEOUT_MS = Object.freeze({ rail: 40000, bus: 20000 });
const liveBasemapRefreshes = new Map();
const terrainTileRefreshes = new Map();
const transitTileRefreshes = new Map();
const structureTileRefreshes = new Map();
const PERSONAL_SESSION_COOKIE = "huayu_session";
const PERSONAL_SESSION_SECONDS = 30 * 24 * 60 * 60;
// Workers currently caps PBKDF2 at 100,000 iterations.
const PERSONAL_PASSWORD_ITERATIONS = 100000;
const PERSONAL_MAX_JSON_BYTES = 64 * 1024;
const PERSONAL_MAX_IMAGE_BYTES = 768 * 1024;
const PERSONAL_MAX_OVERLAY_BYTES = 10 * 1024 * 1024;
const PERSONAL_MAX_OVERLAYS = 20;
const PERSONAL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const textEncoder = new TextEncoder();

function buildingTileBounds(z, x, y) {
  const scale = 2 ** z;
  const longitude = (tileX) => tileX / scale * 360 - 180;
  const latitude = (tileY) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / scale))) * 180 / Math.PI;
  return {
    west: longitude(x),
    east: longitude(x + 1),
    north: latitude(y),
    south: latitude(y + 1),
  };
}

function buildingOverpassQuery(bounds) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  return `[out:json][timeout:25];way["building"]["building"!="no"](${bbox})->.buildingWays;`
    + `rel["building"]["building"!="no"](${bbox})->.buildingRelations;`
    + `way["building:part"]["building:part"!="no"](${bbox})->.buildingPartWays;`
    + `rel["building:part"]["building:part"!="no"](${bbox})->.buildingPartRelations;`
    + `way["historic"~"^(palace|castle|temple|shrine|monument|archaeological_site|city_gate)$"](${bbox})->.ancientWays;`
    + `rel["historic"~"^(palace|castle|temple|shrine|monument|archaeological_site|city_gate)$"](${bbox})->.ancientRelations;`
    + `way["building:architecture"~"^(traditional|hanok|pagoda|temple|palace|castle)$"](${bbox})->.ancientArchitectureWays;`
    + `rel["building:architecture"~"^(traditional|hanok|pagoda|temple|palace|castle)$"](${bbox})->.ancientArchitectureRelations;`
    + `way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;`
    + `(.buildingWays;.buildingRelations;.buildingPartWays;.buildingPartRelations;.ancientWays;.ancientRelations;`
    + `.ancientArchitectureWays;.ancientArchitectureRelations;.barrierWays;way(r.buildingRelations);way(r.buildingPartRelations);`
    + `way(r.ancientRelations);way(r.ancientArchitectureRelations););out body geom;`;
}

function structureOverpassQuery(bounds, zoom) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const clearanceWays = zoom >= 14
    ? `way["highway"](${bbox})->.pavilionClearanceWays;` : "";
  return `[out:json][timeout:15];way["barrier"~"^(wall|fence|gate|entrance)$"](${bbox})->.barrierWays;${clearanceWays}(`
    + `nwr["amenity"="shelter"]["shelter_type"~"^(gazebo|pavilion|picnic_shelter)$"](${bbox});`
    + `nwr["amenity"="shelter"]["shelter_type"!~"."](${bbox});`
    + `nwr["leisure"="gazebo"](${bbox});`
    + `nwr["man_made"~"^(gazebo|pavilion)$"](${bbox});nwr["building"~"^(gazebo|pavilion)$"](${bbox});`
    + `nwr["building:part"~"^(gazebo|pavilion)$"](${bbox});)->.pavilionStructures;`
    + `(.barrierWays;.pavilionStructures;way(r.pavilionStructures);`
    + `${zoom >= 14 ? ".pavilionClearanceWays;" : ""});out body geom;`;
}

function liveBasemapOverpassQuery(bounds, zoom) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  if (zoom < 13) {
    return `[out:json][timeout:45];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${bbox});`
      + `way["highway"]["layer"](${bbox});way["highway"]["bridge"]["bridge"!="no"](${bbox});way["highway"]["tunnel"]["tunnel"!="no"](${bbox});)->.roads;`
      + `node(w.roads)->.roadNodes;way(bn.roadNodes)["highway"]->.approaches;(.roads;.approaches;);out body geom;`;
  }
  const highwaySelector = zoom <= 13
    ? `["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]` : `["highway"]`;
  const elevatedWays = zoom <= 13
    ? `way["highway"]["layer"](${bbox});way["highway"]["bridge"]["bridge"!="no"](${bbox});way["highway"]["tunnel"]["tunnel"!="no"](${bbox});` : "";
  const treeNodes = zoom >= 15
    ? `node["natural"="tree"](${bbox})->.basemapTrees;` : "";
  const gardenNodes = zoom >= 15
    ? `(node["leisure"="garden"](${bbox});node["landuse"="flowerbed"](${bbox});)->.basemapGardens;` : "";
  return `[out:json][timeout:${zoom <= 13 ? 45 : 25}];(`
    + `way${highwaySelector}(${bbox});`
    + elevatedWays
    + `way["railway"~"^(rail|narrow_gauge|light_rail|tram|monorail)$"](${bbox});`
    + `way["waterway"](${bbox});`
    + `way["natural"~"^(water|wood|scrub|grassland|wetland|beach|sand)$"](${bbox});`
    + `way["landuse"](${bbox});`
    + `way["leisure"~"^(park|garden|pitch|track|stadium|sports_centre|playground|fitness_station|swimming_pool)$"](${bbox});`
    + `way["amenity"~"^(school|university|college|hospital|clinic|parking|fire_station|recycling|waste_disposal|waste_transfer_station|waster_transfer_station|fuel|charging_station)$"](${bbox});`
    + `)->.basemapWays;(`
    + `rel["type"="multipolygon"]["natural"~"^(water|wood|scrub|grassland|wetland|beach|sand)$"](${bbox});`
    + `rel["type"="multipolygon"]["landuse"](${bbox});`
    + `rel["type"="multipolygon"]["leisure"~"^(park|garden|pitch|track|stadium|sports_centre|playground|fitness_station|swimming_pool)$"](${bbox});`
    + `rel["type"="multipolygon"]["amenity"~"^(school|university|college|hospital|clinic|parking|fire_station|recycling|waste_disposal|waste_transfer_station|waster_transfer_station|fuel|charging_station)$"](${bbox});`
    + `)->.basemapRelations;`
    + `node["place"~"^(city|town|village|suburb|neighbourhood|hamlet)$"](${bbox})->.basemapPlaces;`
    + treeNodes
    + gardenNodes
    + `(node["natural"~"^(peak|volcano)$"]["name"](${bbox});`
    + `node["amenity"="university"]["name"](${bbox});)->.basemapImportantLabels;`
    + `(.basemapWays;.basemapRelations;.basemapPlaces;${zoom >= 15 ? ".basemapTrees;.basemapGardens;" : ""}.basemapImportantLabels;`
    + `way(r.basemapRelations););out body geom;`;
}

function terrainOverpassQuery(bounds) {
  const latitudePad = 2000 / 111320;
  const longitudePad = latitudePad / Math.max(0.1,
    Math.cos(Math.max(Math.abs(bounds.south), Math.abs(bounds.north)) * Math.PI / 180));
  bounds = { south: Math.max(-85, bounds.south - latitudePad), north: Math.min(85, bounds.north + latitudePad),
    west: Math.max(-180, bounds.west - longitudePad), east: Math.min(180, bounds.east + longitudePad) };
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  const namedRelief = `["name"~"高山|山地|山区|山坡|丘陵|荒原|alpine|upland|mountain|[山岭谷岳峰岗丘峦坡峡]$",i]`;
  return `[out:json][timeout:30];(`
    + `way["natural"="wood"](${bbox});`
    + `way["landuse"="forest"](${bbox});`
    + `way["natural"~"^(scrub|heath|fell|bare_rock|scree)$"](${bbox});`
    + `way["natural"="grassland"]${namedRelief}(${bbox});`
    + `way["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `way["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainWays;(`
    + `rel["type"="multipolygon"]["natural"="wood"](${bbox});`
    + `rel["type"="multipolygon"]["landuse"="forest"](${bbox});`
    + `rel["type"="multipolygon"]["natural"~"^(scrub|heath|fell|bare_rock|scree)$"](${bbox});`
    + `rel["type"="multipolygon"]["natural"="grassland"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["landuse"~"^(grass|meadow)$"]${namedRelief}(${bbox});`
    + `rel["type"="multipolygon"]["leisure"="garden"]${namedRelief}(${bbox});`
    + `)->.terrainRelations;`
    + `(node["natural"~"^(peak|volcano|saddle)$"](${bbox});node["ele"](${bbox});)->.terrainPeaks;`
    + `(.terrainWays;.terrainRelations;.terrainPeaks;);out body geom;`;
}

function transitTileOverpassQuery(kind, bounds) {
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  if (kind === "rail") {
    return `[out:json][timeout:35];rel["type"="route"]["route"~"^(subway|light_rail|tram|monorail|train)$"](${bbox})->.bboxRailRoutes;`
      + `rel(br.bboxRailRoutes)["type"="route_master"]->.railMasters;`
      + `rel(r.railMasters)["type"="route"]["route"~"^(subway|light_rail|tram|monorail|train)$"]->.masterRailRoutes;`
      + `(.bboxRailRoutes;.masterRailRoutes;)->.railRoutes;way(r.railRoutes)->.railWays;`
      + `way["railway"~"^(rail|narrow_gauge)$"][!"service"](${bbox})->.railInfrastructure;`
      + `node(r.railRoutes)->.routeStopNodes;`
      + `(nwr["railway"~"^(station|halt|tram_stop)$"](${bbox});nwr["station"="subway"](${bbox});`
      + `nwr["subway"="yes"](${bbox});nwr["public_transport"="station"](${bbox});)->.railStations;`
      + `(.railMasters;.railRoutes;);out body;(.railWays;.railInfrastructure;);out body geom;`
      + `.routeStopNodes out body;.railStations out body center;`;
  }
  return `[out:json][timeout:15];(node["highway"="bus_stop"](${bbox});node["amenity"="bus_station"](${bbox});`
    + `node["public_transport"="station"]["bus"="yes"](${bbox});`
    + `node["public_transport"="platform"]["bus"="yes"](${bbox});`
    + `node["public_transport"="stop_position"]["bus"="yes"](${bbox});)->.busStops;`
    + `rel(bn.busStops)["type"="route"]["route"="bus"]->.busRoutes;`
    + `rel(br.busRoutes)["type"="route_master"]->.busMasters;`
    + `(.busStops;.busRoutes;.busMasters;);out body;`;
}

function buildingJsonResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });
}

function cachedBuildingResponse(response, cacheStatus, headerName = "X-OGF-Building-Cache") {
  const headers = new Headers(response.headers);
  headers.set(headerName, cacheStatus);
  const fetchedAt = Date.parse(headers.get("X-OGF-Building-Fetched-At") || "");
  const age = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : BUILDING_CACHE_SECONDS;
  const remaining = Math.max(0, BUILDING_CACHE_SECONDS - age);
  headers.set("X-OGF-Building-Policy", "live-2m");
  headers.set("X-OGF-Building-Refresh-After", String(remaining));
  headers.set("Cache-Control", `public, max-age=${Math.min(15, remaining)}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function liveBasemapCachePolicy(z) {
  const snapshot = LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z) || ROAD_OVERVIEW_TILE_ZOOMS.has(z);
  return {
    name: snapshot ? "snapshot-3h" : "live-2m",
    refreshSeconds: snapshot ? LIVE_BASEMAP_SNAPSHOT_REFRESH_SECONDS : LIVE_BASEMAP_DETAIL_REFRESH_SECONDS,
    retentionSeconds: snapshot ? LIVE_BASEMAP_SNAPSHOT_RETENTION_SECONDS : LIVE_BASEMAP_DETAIL_RETENTION_SECONDS,
    browserSeconds: snapshot ? 60 : 15,
  };
}

function liveBasemapClientResponse(response, cacheStatus, policy) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Basemap-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  const refreshAfter = cacheStatus === "STALE" ? 30
    : Math.max(0, policy.refreshSeconds - ageSeconds);
  headers.set("X-OGF-Basemap-Cache", cacheStatus);
  headers.set("X-OGF-Basemap-Policy", policy.name);
  headers.set("X-OGF-Basemap-Age", String(ageSeconds));
  headers.set("X-OGF-Basemap-Refresh-After", String(refreshAfter));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : policy.browserSeconds}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchBuildingTile(request, context, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const scale = 2 ** z;
  if (!BUILDING_TILE_ZOOMS.has(z) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_building_tile",
      requiredZooms: [...BUILDING_TILE_ZOOMS],
    }), 400);
  }

  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-building-v8-roof-only");
  cacheUrl.searchParams.set("refresh", "live-2m");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached && Date.now() - Date.parse(cached.headers.get("X-OGF-Building-Fetched-At") || "") < BUILDING_CACHE_SECONDS * 1000)
    return cachedBuildingResponse(cached, "HIT");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILDING_QUERY_TIMEOUT_MS);
  try {
    const query = buildingOverpassQuery(buildingTileBounds(z, x, y));
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return buildingJsonResponse(JSON.stringify({
        error: "overpass_error",
        status: upstream.status,
      }), 502, { "Cache-Control": "no-store" });
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      return buildingJsonResponse(JSON.stringify({ error: "invalid_overpass_json" }), 502, {
        "Cache-Control": "no-store",
      });
    }
    if (!Array.isArray(payload?.elements) || payload.remark) {
      return buildingJsonResponse(JSON.stringify({ error: "invalid_overpass_payload" }), 502, {
        "Cache-Control": "no-store",
      });
    }

    const fetchedAt = new Date().toISOString();
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=${BUILDING_CACHE_SECONDS}, s-maxage=${BUILDING_CACHE_SECONDS}`,
      "X-OGF-Building-Cache": "MISS",
      "X-OGF-Building-Fetched-At": fetchedAt,
      "X-OGF-Building-Tile": `${z}/${x}/${y}`,
    });
    context.waitUntil(caches.default.put(cacheKey, response.clone()));
    return cachedBuildingResponse(response, "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : "overpass_unavailable",
    }), 504, { "Cache-Control": "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}

function structureTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Structure-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Structure-Cache", cacheStatus);
  headers.set("X-OGF-Structure-Policy", "live-2m");
  headers.set("X-OGF-Structure-Age", String(ageSeconds));
  headers.set("X-OGF-Structure-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, STRUCTURE_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : Math.min(15, Math.max(0, STRUCTURE_REFRESH_SECONDS - ageSeconds))}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadStructureTile(cacheKey, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRUCTURE_QUERY_TIMEOUT_MS);
  try {
    const query = structureOverpassQuery(buildingTileBounds(z, x, y), z);
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements) || payload.remark) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${STRUCTURE_RETENTION_SECONDS}`,
      "X-OGF-Structure-Fetched-At": new Date().toISOString(),
      "X-OGF-Structure-Tile": `${z}/${x}/${y}`,
      "X-OGF-Structure-Policy": "live-2m",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshStructureTile(cacheKey, z, x, y) {
  const refreshKey = cacheKey.url;
  if (structureTileRefreshes.has(refreshKey)) return structureTileRefreshes.get(refreshKey);
  const refresh = loadStructureTile(cacheKey, z, x, y)
    .finally(() => structureTileRefreshes.delete(refreshKey));
  structureTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchStructureTile(request, context, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const scale = 2 ** z;
  if (!STRUCTURE_TILE_ZOOMS.has(z) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_structure_tile",
      requiredZooms: [...STRUCTURE_TILE_ZOOMS],
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-structures-v5-wall-gates");
  cacheUrl.searchParams.set("refresh", "live-2m");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Structure-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < STRUCTURE_REFRESH_SECONDS) return structureTileClientResponse(cached, "HIT");
    const refresh = refreshStructureTile(cacheKey, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return structureTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshStructureTile(cacheKey, z, x, y);
    return structureTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

async function loadLiveBasemapTileOnce(cacheKey, z, x, y, policy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), z <= 13 ? 50000 : LIVE_BASEMAP_QUERY_TIMEOUT_MS);
  try {
    const query = liveBasemapOverpassQuery(buildingTileBounds(z, x, y), z);
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }

    const fetchedAt = new Date().toISOString();
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${policy.retentionSeconds}`,
      "X-OGF-Basemap-Fetched-At": fetchedAt,
      "X-OGF-Basemap-Tile": `${z}/${x}/${y}`,
      "X-OGF-Basemap-Policy": policy.name,
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLiveBasemapTile(cacheKey, z, x, y, policy) {
  try {
    return await loadLiveBasemapTileOnce(cacheKey, z, x, y, policy);
  } catch (error) {
    if (!LIVE_BASEMAP_SNAPSHOT_TILE_ZOOMS.has(z) && !ROAD_OVERVIEW_TILE_ZOOMS.has(z)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return loadLiveBasemapTileOnce(cacheKey, z, x, y, policy);
  }
}

function refreshLiveBasemapTile(cacheKey, z, x, y, policy) {
  const refreshKey = cacheKey.url;
  if (liveBasemapRefreshes.has(refreshKey)) return liveBasemapRefreshes.get(refreshKey);
  const refresh = loadLiveBasemapTile(cacheKey, z, x, y, policy)
    .finally(() => liveBasemapRefreshes.delete(refreshKey));
  liveBasemapRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchLiveBasemapTile(request, context, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const scale = 2 ** z;
  if ((!LIVE_BASEMAP_TILE_ZOOMS.has(z) && !ROAD_OVERVIEW_TILE_ZOOMS.has(z)) || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_live_basemap_tile",
      requiredZooms: [...ROAD_OVERVIEW_TILE_ZOOMS, ...LIVE_BASEMAP_TILE_ZOOMS],
    }), 400);
  }

  const policy = liveBasemapCachePolicy(z);
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", z < 13 ? "huayu-road-overview-v2-tunnels" : z === 13 ? "huayu-live-basemap-v11-tunnels"
    : z >= 15 ? "huayu-live-basemap-v9-garden-nodes" : "huayu-live-basemap-v8-progressive-terrain");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Basemap-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < policy.refreshSeconds) {
      return liveBasemapClientResponse(cached, "HIT", policy);
    }
    const refresh = refreshLiveBasemapTile(cacheKey, z, x, y, policy);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return liveBasemapClientResponse(cached, "STALE", policy);
  }

  try {
    const response = await refreshLiveBasemapTile(cacheKey, z, x, y, policy);
    return liveBasemapClientResponse(response.clone(), "MISS", policy);
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

function terrainTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Terrain-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Terrain-Cache", cacheStatus);
  headers.set("X-OGF-Terrain-Policy", "snapshot-3h");
  headers.set("X-OGF-Terrain-Age", String(ageSeconds));
  headers.set("X-OGF-Terrain-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, TERRAIN_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : 60}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadTerrainTile(cacheKey, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TERRAIN_QUERY_TIMEOUT_MS);
  try {
    const query = terrainOverpassQuery(buildingTileBounds(z, x, y));
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    if (payload.remark) {
      const error = new Error("incomplete_terrain_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${TERRAIN_RETENTION_SECONDS}`,
      "X-OGF-Terrain-Fetched-At": new Date().toISOString(),
      "X-OGF-Terrain-Tile": `${z}/${x}/${y}`,
      "X-OGF-Terrain-Policy": "snapshot-3h",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshTerrainTile(cacheKey, z, x, y) {
  const refreshKey = cacheKey.url;
  if (terrainTileRefreshes.has(refreshKey)) return terrainTileRefreshes.get(refreshKey);
  const refresh = loadTerrainTile(cacheKey, z, x, y)
    .finally(() => terrainTileRefreshes.delete(refreshKey));
  terrainTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

async function fetchTerrainTile(request, context, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const scale = 2 ** z;
  if (z < 6 || z > TERRAIN_TILE_ZOOM || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_terrain_tile",
      requiredZoom: TERRAIN_TILE_ZOOM,
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-terrain-v8-height-field");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Terrain-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < TERRAIN_REFRESH_SECONDS) return terrainTileClientResponse(cached, "HIT");
    const refresh = refreshTerrainTile(cacheKey, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return terrainTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshTerrainTile(cacheKey, z, x, y);
    return terrainTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

function transitTileClientResponse(response, cacheStatus) {
  const headers = new Headers(response.headers);
  const fetchedAt = Date.parse(headers.get("X-OGF-Transit-Fetched-At") || "");
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
  headers.set("X-OGF-Transit-Cache", cacheStatus);
  headers.set("X-OGF-Transit-Policy", "snapshot-3h");
  headers.set("X-OGF-Transit-Age", String(ageSeconds));
  headers.set("X-OGF-Transit-Refresh-After", String(cacheStatus === "STALE"
    ? 30 : Math.max(0, TRANSIT_REFRESH_SECONDS - ageSeconds)));
  headers.set("Cache-Control", `public, max-age=${cacheStatus === "STALE" ? 0 : 60}, must-revalidate`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function loadTransitTileOnce(cacheKey, kind, z, x, y) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSIT_QUERY_TIMEOUT_MS[kind]);
  try {
    const query = transitTileOverpassQuery(kind, buildingTileBounds(z, x, y));
    const upstream = await fetch(OGF_OVERPASS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const error = new Error("overpass_error");
      error.responseStatus = 502;
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const error = new Error("invalid_overpass_json");
      error.responseStatus = 502;
      throw error;
    }
    if (!Array.isArray(payload?.elements)) {
      const error = new Error("invalid_overpass_payload");
      error.responseStatus = 502;
      throw error;
    }
    const response = buildingJsonResponse(body, 200, {
      "Cache-Control": `public, max-age=0, s-maxage=${TRANSIT_RETENTION_SECONDS}`,
      "X-OGF-Transit-Fetched-At": new Date().toISOString(),
      "X-OGF-Transit-Tile": `${kind}/${z}/${x}/${y}`,
      "X-OGF-Transit-Policy": "snapshot-3h",
    });
    await caches.default.put(cacheKey, response.clone());
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function refreshTransitTile(cacheKey, kind, z, x, y) {
  const refreshKey = cacheKey.url;
  if (transitTileRefreshes.has(refreshKey)) return transitTileRefreshes.get(refreshKey);
  const refresh = loadTransitTileOnce(cacheKey, kind, z, x, y)
    .finally(() => transitTileRefreshes.delete(refreshKey));
  transitTileRefreshes.set(refreshKey, refresh);
  return refresh;
}

function personalJson(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomToken(size = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value))));
}

async function hashPassword(password, saltHex, iterations = PERSONAL_PASSWORD_ITERATIONS) {
  const salt = new Uint8Array(String(saltHex).match(/.{1,2}/gu)?.map((value) => Number.parseInt(value, 16)) || []);
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return bytesToHex(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations,
  }, key, 256));
}

function constantTimeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0)
      ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  }
  return difference === 0;
}

function normalizeUsername(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateUsername(value) {
  const username = String(value || "").trim().normalize("NFKC");
  return /^[\p{L}\p{N}_-]{3,32}$/u.test(username) ? username : null;
}

function validatePassword(value) {
  const password = String(value || "");
  return password.length >= 10 && password.length <= 128 && password.trim().length >= 1;
}

function validateOverlayBounds(value) {
  const bounds = {
    west: Number(value?.west),
    south: Number(value?.south),
    east: Number(value?.east),
    north: Number(value?.north),
  };
  if (!Object.values(bounds).every(Number.isFinite)
    || bounds.west < -180 || bounds.east > 180 || bounds.south < -85 || bounds.north > 85
    || bounds.east - bounds.west < 0.000001 || bounds.north - bounds.south < 0.000001
    || bounds.east - bounds.west > 30 || bounds.north - bounds.south > 30) return null;
  return bounds;
}

function validImageSignature(bytes, type) {
  const data = new Uint8Array(bytes);
  if (type === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => data[index] === value);
  }
  if (type === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === "image/webp") {
    return String.fromCharCode(...data.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...data.slice(8, 12)) === "WEBP";
  }
  return false;
}

function d1BlobBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value);
  }
  return null;
}

function parseCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function sessionCookie(value, maxAge = PERSONAL_SESSION_SECONDS) {
  return `${PERSONAL_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function personalBindingsAvailable(environment) {
  return Boolean(environment?.DB);
}

function bootstrapAdminUsernames(environment) {
  return new Set(String(environment?.ADMIN_USERNAMES || "").split(",")
    .map(normalizeUsername).filter(Boolean));
}

function publicUser(user, environment) {
  const role = user?.role === "admin" || bootstrapAdminUsernames(environment).has(user?.username_normalized)
    ? "admin" : "user";
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role,
    createdAt: user.created_at,
  };
}

async function readJsonBody(request, maximumBytes = PERSONAL_MAX_JSON_BYTES) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maximumBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function sameOriginMutation(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function currentPersonalUser(request, environment) {
  const token = parseCookie(request, PERSONAL_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const user = await environment.DB.prepare(`SELECT users.*, sessions.id AS session_id
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ? AND users.disabled = 0`)
    .bind(tokenHash, now).first();
  if (!user) return null;
  user.session_id = tokenHash;
  return user;
}

async function requirePersonalUser(request, environment) {
  const user = await currentPersonalUser(request, environment);
  if (!user) throw Object.assign(new Error("authentication_required"), { status: 401 });
  return user;
}

async function createPersonalSession(environment, userId) {
  const token = randomToken();
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    environment.DB.prepare(`INSERT INTO sessions
      (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256Hex(token), userId, now, now + PERSONAL_SESSION_SECONDS * 1000),
  ]);
  return token;
}

function normalizedSearchHistory(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter((item) => {
    const key = item.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (!item || item.length > 200 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function normalizedFavorites(items) {
  // Keep the optional account place labels aligned with saved-places.js.
  const tags = new Map([
    ["home", "家庭住址"], ["hometown", "故乡"], ["kindergarten", "幼儿园"],
    ["primary", "小学"], ["middle", "初中"], ["high", "高中"],
    ["college", "大专"], ["university", "大学"], ["graduate", "研究生院校"],
    ["work", "工作单位"], ["former-home", "曾经住过"], ["other", "其他经历"],
  ]);
  const tagKey = value => value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const presets = new Map([...tags].flatMap(([id, title]) => [[tagKey(id), id], [tagKey(title), id]]));
  let hasDefault = false;
  const source = items && typeof items === "object" && !Array.isArray(items) ? items : {};
  return Object.entries(source).slice(0, 200).flatMap(([key, place]) => {
    const lat = Number(place?.lat);
    const lng = Number(place?.lng);
    if (!key || key.length > 100 || !place || place.lat == null || place.lng == null
      || place.lat === "" || place.lng === "" || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 85 || Math.abs(lng) > 180) return [];
    const placeTags = [...new Set(Array.isArray(place.placeTags) ? place.placeTags : [])].filter(tag => tags.has(tag));
    const customTags = [], seen = new Set();
    for (const value of Array.isArray(place.customTags) ? place.customTags.slice(0, 100) : []) {
      if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) continue;
      const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (!text || Array.from(text).length > 24) continue;
      const key = tagKey(text), preset = presets.get(key);
      if (preset) {if (!placeTags.includes(preset)) placeTags.push(preset);continue;}
      if (seen.has(key) || customTags.length >= 8) continue;
      seen.add(key);customTags.push(text);
    }
    const isDefault = place.isDefault === true && !hasDefault;
    hasDefault ||= isDefault;
    return [[key, {
      lat,
      lng,
      zoom: Number.isFinite(Number(place.zoom)) ? Math.min(20, Math.max(1, Number(place.zoom))) : 13,
      label: String(place.label || "收藏地点").slice(0, 200),
      ...(placeTags.length ? {placeTags} : {}),
      ...(customTags.length ? {customTags} : {}),
      ...(isDefault ? {isDefault:true} : {}),
    }]];
  });
}

async function personalDataForUser(environment, userId) {
  const [historyResult, favoriteResult, overlayResult] = await Promise.all([
    environment.DB.prepare(`SELECT query FROM search_history WHERE user_id = ?
      ORDER BY updated_at DESC LIMIT 10`).bind(userId).all(),
    environment.DB.prepare(`SELECT favorite_key, payload FROM favorites WHERE user_id = ?
      ORDER BY updated_at DESC LIMIT 200`).bind(userId).all(),
    environment.DB.prepare(`SELECT id, name, mime_type, byte_size, west, south, east, north,
      opacity, visible, created_at, updated_at FROM image_overlays WHERE user_id = ?
      ORDER BY created_at DESC`).bind(userId).all(),
  ]);
  const favorites = Object.create(null);
  (favoriteResult.results || []).forEach((item) => {
    try { favorites[item.favorite_key] = JSON.parse(item.payload); } catch {}
  });
  return {
    searchHistory: (historyResult.results || []).map((item) => item.query),
    favorites,
    overlays: (overlayResult.results || []).map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.mime_type,
      byteSize: item.byte_size,
      bounds: { west: item.west, south: item.south, east: item.east, north: item.north },
      opacity: item.opacity,
      visible: Boolean(item.visible),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      imageUrl: `/api/overlays/${encodeURIComponent(item.id)}/image`,
    })),
  };
}

async function replaceSearchHistory(environment, userId, items) {
  const queries = normalizedSearchHistory(items);
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM search_history WHERE user_id = ?").bind(userId),
    ...queries.map((query, index) => environment.DB.prepare(`INSERT INTO search_history
      (user_id, query_key, query, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(userId, query.normalize("NFKC").toLocaleLowerCase("zh-CN"), query, now - index)),
  ]);
  return queries;
}

async function replaceFavorites(environment, userId, items) {
  const favorites = normalizedFavorites(items);
  const now = Date.now();
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM favorites WHERE user_id = ?").bind(userId),
    ...favorites.map(([key, place], index) => environment.DB.prepare(`INSERT INTO favorites
      (user_id, favorite_key, payload, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(userId, key, JSON.stringify(place), now - index)),
  ]);
  return Object.fromEntries(favorites);
}

async function mergePersonalData(environment, userId, payload) {
  const localHistory = normalizedSearchHistory(payload?.searchHistory);
  const existing = await personalDataForUser(environment, userId);
  // Account metadata wins over an older browser copy; a guest import must not
  // erase labels/defaults or create a second default at another coordinate.
  const combined = { ...existing.favorites };
  for (const [key, place] of normalizedFavorites(payload?.favorites)) {
    if (!Object.hasOwn(combined, key)) combined[key] = place;
  }
  const localFavorites = normalizedFavorites(combined);
  const now = Date.now();
  const statements = [];
  localHistory.forEach((query, index) => {
    statements.push(environment.DB.prepare(`INSERT INTO search_history
      (user_id, query_key, query, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, query_key) DO UPDATE SET query = excluded.query,
      updated_at = MAX(search_history.updated_at, excluded.updated_at)`)
      .bind(userId, query.normalize("NFKC").toLocaleLowerCase("zh-CN"), query, now - index));
  });
  localFavorites.forEach(([key, place], index) => {
    statements.push(environment.DB.prepare(`INSERT INTO favorites
      (user_id, favorite_key, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, favorite_key) DO UPDATE SET payload = excluded.payload,
      updated_at = MAX(favorites.updated_at, excluded.updated_at)`)
      .bind(userId, key, JSON.stringify(place), now - index));
  });
  if (statements.length) await environment.DB.batch(statements);
  return personalDataForUser(environment, userId);
}

async function deleteUserData(environment, userId) {
  await environment.DB.batch([
    environment.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM search_history WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM favorites WHERE user_id = ?").bind(userId),
    environment.DB.prepare(`DELETE FROM image_overlay_blobs WHERE overlay_id IN
      (SELECT id FROM image_overlays WHERE user_id = ?)`).bind(userId),
    environment.DB.prepare("DELETE FROM image_overlays WHERE user_id = ?").bind(userId),
    environment.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

async function fetchTransitTile(request, context, kind, z, x, y) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return buildingJsonResponse(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, OPTIONS" });
  }
  const requiredZoom = TRANSIT_TILE_ZOOMS[kind];
  const scale = 2 ** z;
  if (!Number.isInteger(requiredZoom) || z !== requiredZoom || x < 0 || y < 0 || x >= scale || y >= scale) {
    return buildingJsonResponse(JSON.stringify({
      error: "invalid_transit_tile",
      requiredZooms: TRANSIT_TILE_ZOOMS,
    }), 400);
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("schema", "huayu-transit-tile-v2-area-stations");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const fetchedAt = Date.parse(cached.headers.get("X-OGF-Transit-Fetched-At") || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (Date.now() - fetchedAt) / 1000) : Infinity;
    if (ageSeconds < TRANSIT_REFRESH_SECONDS) return transitTileClientResponse(cached, "HIT");
    const refresh = refreshTransitTile(cacheKey, kind, z, x, y);
    context.waitUntil(refresh.then(() => undefined).catch(() => undefined));
    return transitTileClientResponse(cached, "STALE");
  }
  try {
    const response = await refreshTransitTile(cacheKey, kind, z, x, y);
    return transitTileClientResponse(response.clone(), "MISS");
  } catch (error) {
    return buildingJsonResponse(JSON.stringify({
      error: error?.name === "AbortError" ? "overpass_timeout" : String(error?.message || "overpass_unavailable"),
      ...(Number.isFinite(error?.upstreamStatus) ? { status: error.upstreamStatus } : {}),
    }), error?.responseStatus || 504, { "Cache-Control": "no-store" });
  }
}

async function handleAuthApi(request, environment, url) {
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const user = await currentPersonalUser(request, environment);
    if (!user) return personalJson({ user: null }, 401);
    const data = await personalDataForUser(environment, user.id);
    return personalJson({ user: publicUser(user, environment), ...data });
  }
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const password = String(body.password || "");
    const displayName = String(body.displayName || username || "").trim().slice(0, 40);
    if (!username) return personalJson({ error: "invalid_username" }, 400);
    if (!validatePassword(password)) return personalJson({ error: "invalid_password" }, 400);
    const usernameNormalized = normalizeUsername(username);
    if (await environment.DB.prepare("SELECT id FROM users WHERE username_normalized = ?")
      .bind(usernameNormalized).first()) return personalJson({ error: "username_taken" }, 409);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = Date.now();
    const user = {
      id: crypto.randomUUID(), username, username_normalized: usernameNormalized,
      display_name: displayName || username, role: "user", created_at: now,
    };
    try {
      await environment.DB.prepare(`INSERT INTO users
        (id, username, username_normalized, display_name, password_salt, password_hash,
          password_iterations, role, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, ?, ?)`)
        .bind(user.id, user.username, user.username_normalized, user.display_name, salt,
          await hashPassword(password, salt), PERSONAL_PASSWORD_ITERATIONS, now, now).run();
    } catch (error) {
      if (/unique|constraint/iu.test(String(error?.message || error))) {
        return personalJson({ error: "username_taken" }, 409);
      }
      throw error;
    }
    const token = await createPersonalSession(environment, user.id);
    return personalJson({ user: publicUser(user, environment), searchHistory: [], favorites: {}, overlays: [] },
      201, { "Set-Cookie": sessionCookie(token) });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const usernameNormalized = normalizeUsername(body.username);
    const password = String(body.password || "");
    const user = await environment.DB.prepare("SELECT * FROM users WHERE username_normalized = ?")
      .bind(usernameNormalized).first();
    const fallbackSalt = "00000000000000000000000000000000";
    const candidate = await hashPassword(password, user?.password_salt || fallbackSalt,
      Number(user?.password_iterations) || PERSONAL_PASSWORD_ITERATIONS);
    if (!user || user.disabled || !constantTimeEqual(candidate, user.password_hash)) {
      return personalJson({ error: "invalid_credentials" }, 401);
    }
    const token = await createPersonalSession(environment, user.id);
    const data = await personalDataForUser(environment, user.id);
    return personalJson({ user: publicUser(user, environment), ...data }, 200,
      { "Set-Cookie": sessionCookie(token) });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookie(request, PERSONAL_SESSION_COOKIE);
    if (token) await environment.DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(await sha256Hex(token)).run();
    return personalJson({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return null;
}

async function handleAccountApi(request, environment, url) {
  if (url.pathname === "/api/account" && request.method === "PATCH") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    const displayName = String(body.displayName ?? user.display_name).trim().slice(0, 40);
    if (!displayName) return personalJson({ error: "invalid_display_name" }, 400);
    if (body.newPassword != null) {
      const currentCandidate = await hashPassword(String(body.currentPassword || ""), user.password_salt,
        Number(user.password_iterations));
      if (!constantTimeEqual(currentCandidate, user.password_hash)) {
        return personalJson({ error: "invalid_current_password" }, 403);
      }
      if (!validatePassword(body.newPassword)) return personalJson({ error: "invalid_password" }, 400);
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      await environment.DB.batch([
        environment.DB.prepare(`UPDATE users SET display_name = ?, password_salt = ?, password_hash = ?,
          password_iterations = ?, updated_at = ? WHERE id = ?`)
          .bind(displayName, salt, await hashPassword(String(body.newPassword), salt),
            PERSONAL_PASSWORD_ITERATIONS, Date.now(), user.id),
        environment.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?")
          .bind(user.id, user.session_id),
      ]);
    } else {
      await environment.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
        .bind(displayName, Date.now(), user.id).run();
    }
    user.display_name = displayName;
    return personalJson({ user: publicUser(user, environment) });
  }
  if (url.pathname === "/api/account" && request.method === "DELETE") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    const candidate = await hashPassword(String(body.password || ""), user.password_salt,
      Number(user.password_iterations));
    if (!constantTimeEqual(candidate, user.password_hash)) {
      return personalJson({ error: "invalid_current_password" }, 403);
    }
    await deleteUserData(environment, user.id);
    return personalJson({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return null;
}

async function handlePersonalDataApi(request, environment, url) {
  if (url.pathname === "/api/personal/sync" && request.method === "POST") {
    const user = await requirePersonalUser(request, environment);
    return personalJson(await mergePersonalData(environment, user.id, await readJsonBody(request, 512 * 1024)));
  }
  if (url.pathname === "/api/personal/search-history" && request.method === "PUT") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request);
    return personalJson({ searchHistory: await replaceSearchHistory(environment, user.id, body.items) });
  }
  if (url.pathname === "/api/personal/favorites" && request.method === "PUT") {
    const user = await requirePersonalUser(request, environment);
    const body = await readJsonBody(request, 512 * 1024);
    return personalJson({ favorites: await replaceFavorites(environment, user.id, body.items) });
  }
  return null;
}

async function handleOverlayApi(request, environment, url) {
  const imageMatch = url.pathname.match(/^\/api\/overlays\/([^/]+)\/image$/u);
  if (imageMatch && request.method === "GET") {
    const user = await requirePersonalUser(request, environment);
    const overlay = await environment.DB.prepare(`SELECT image_overlays.mime_type, image_overlays.byte_size,
      image_overlays.updated_at, image_overlay_blobs.image_data FROM image_overlays
      JOIN image_overlay_blobs ON image_overlay_blobs.overlay_id = image_overlays.id
      WHERE image_overlays.id = ? AND image_overlays.user_id = ?`)
      .bind(decodeURIComponent(imageMatch[1]), user.id).first();
    if (!overlay) return personalJson({ error: "overlay_not_found" }, 404);
    const image = d1BlobBytes(overlay.image_data);
    if (!image) return personalJson({ error: "image_not_found" }, 404);
    if (image.byteLength !== Number(overlay.byte_size)) {
      return personalJson({ error: "image_storage_corrupt" }, 500);
    }
    const headers = new Headers({
      "Content-Type": overlay.mime_type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(overlay.byte_size),
      "ETag": `W/\"${encodeURIComponent(imageMatch[1])}-${overlay.updated_at}-${overlay.byte_size}\"`,
    });
    return new Response(image, { headers });
  }
  if (url.pathname === "/api/overlays" && request.method === "GET") {
    const user = await requirePersonalUser(request, environment);
    return personalJson({ overlays: (await personalDataForUser(environment, user.id)).overlays });
  }
  if (url.pathname === "/api/overlays" && request.method === "POST") {
    const user = await requirePersonalUser(request, environment);
    const usage = await environment.DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(byte_size), 0) AS bytes FROM image_overlays WHERE user_id = ?`)
      .bind(user.id).first();
    if (Number(usage?.total || 0) >= PERSONAL_MAX_OVERLAYS) {
      return personalJson({ error: "overlay_limit_reached" }, 409);
    }
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > PERSONAL_MAX_IMAGE_BYTES + 128 * 1024) {
      return personalJson({ error: "image_too_large" }, 413);
    }
    const form = await request.formData();
    const image = form.get("image");
    if (!image || typeof image.arrayBuffer !== "function" || !PERSONAL_IMAGE_TYPES.has(image.type)) {
      return personalJson({ error: "invalid_image" }, 400);
    }
    if (image.size <= 0 || image.size > PERSONAL_MAX_IMAGE_BYTES) {
      return personalJson({ error: "image_too_large" }, 413);
    }
    const bounds = validateOverlayBounds({
      west: form.get("west"), south: form.get("south"), east: form.get("east"), north: form.get("north"),
    });
    if (!bounds) return personalJson({ error: "invalid_bounds" }, 400);
    const opacity = Math.min(1, Math.max(0.1, Number(form.get("opacity")) || 0.75));
    const id = crypto.randomUUID();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[image.type];
    const objectKey = `users/${user.id}/overlays/${id}.${extension}`;
    const name = String(form.get("name") || image.name || "地图贴图").trim().slice(0, 100) || "地图贴图";
    const bytes = await image.arrayBuffer();
    if (!validImageSignature(bytes, image.type)) return personalJson({ error: "invalid_image" }, 400);
    if (Number(usage?.bytes || 0) + image.size > PERSONAL_MAX_OVERLAY_BYTES) {
      return personalJson({ error: "overlay_storage_limit_reached" }, 409);
    }
    const now = Date.now();
    await environment.DB.batch([
      environment.DB.prepare(`INSERT INTO image_overlays
        (id, user_id, name, object_key, mime_type, byte_size, west, south, east, north,
          opacity, visible, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, user.id, name, objectKey, image.type, image.size, bounds.west, bounds.south,
          bounds.east, bounds.north, opacity, now, now),
      environment.DB.prepare(`INSERT INTO image_overlay_blobs (overlay_id, image_data)
        VALUES (?, ?)`).bind(id, bytes),
    ]);
    return personalJson({ overlay: {
      id, name, mimeType: image.type, byteSize: image.size, bounds, opacity, visible: true,
      createdAt: now, updatedAt: now, imageUrl: `/api/overlays/${encodeURIComponent(id)}/image`,
    } }, 201);
  }
  const overlayMatch = url.pathname.match(/^\/api\/overlays\/([^/]+)$/u);
  if (overlayMatch && request.method === "PATCH") {
    const user = await requirePersonalUser(request, environment);
    const id = decodeURIComponent(overlayMatch[1]);
    const existing = await environment.DB.prepare("SELECT * FROM image_overlays WHERE id = ? AND user_id = ?")
      .bind(id, user.id).first();
    if (!existing) return personalJson({ error: "overlay_not_found" }, 404);
    const body = await readJsonBody(request);
    const name = body.name == null ? existing.name : String(body.name).trim().slice(0, 100);
    const opacity = body.opacity == null ? existing.opacity : Math.min(1, Math.max(0.1, Number(body.opacity)));
    const visible = body.visible == null ? existing.visible : Number(Boolean(body.visible));
    if (!name || !Number.isFinite(opacity)) return personalJson({ error: "invalid_overlay" }, 400);
    const now = Date.now();
    await environment.DB.prepare(`UPDATE image_overlays SET name = ?, opacity = ?, visible = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`).bind(name, opacity, visible, now, id, user.id).run();
    return personalJson({ ok: true, updatedAt: now });
  }
  if (overlayMatch && request.method === "DELETE") {
    const user = await requirePersonalUser(request, environment);
    const id = decodeURIComponent(overlayMatch[1]);
    const existing = await environment.DB.prepare(`SELECT id FROM image_overlays
      WHERE id = ? AND user_id = ?`).bind(id, user.id).first();
    if (!existing) return personalJson({ error: "overlay_not_found" }, 404);
    await environment.DB.batch([
      environment.DB.prepare("DELETE FROM image_overlay_blobs WHERE overlay_id = ?").bind(id),
      environment.DB.prepare("DELETE FROM image_overlays WHERE id = ? AND user_id = ?").bind(id, user.id),
    ]);
    return personalJson({ ok: true });
  }
  return null;
}

async function handleAdminApi(request, environment, url) {
  if (!url.pathname.startsWith("/api/admin/")) return null;
  const admin = await requirePersonalUser(request, environment);
  if (publicUser(admin, environment).role !== "admin") {
    return personalJson({ error: "administrator_required" }, 403);
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const result = await environment.DB.prepare(`SELECT users.id, users.username, users.username_normalized,
      users.display_name, users.role, users.disabled, users.created_at,
      (SELECT COUNT(*) FROM search_history WHERE user_id = users.id) AS search_count,
      (SELECT COUNT(*) FROM favorites WHERE user_id = users.id) AS favorite_count,
      (SELECT COUNT(*) FROM image_overlays WHERE user_id = users.id) AS overlay_count
      FROM users ORDER BY users.created_at DESC LIMIT 500`).all();
    return personalJson({ users: (result.results || []).map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: publicUser(user, environment).role,
      disabled: Boolean(user.disabled),
      createdAt: user.created_at,
      searchCount: user.search_count,
      favoriteCount: user.favorite_count,
      overlayCount: user.overlay_count,
    })) });
  }
  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/u);
  if (match && request.method === "PATCH") {
    const id = decodeURIComponent(match[1]);
    const body = await readJsonBody(request);
    if (id === admin.id && (body.disabled === true || body.role === "user")) {
      return personalJson({ error: "cannot_lock_current_admin" }, 409);
    }
    const target = await environment.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
    if (!target) return personalJson({ error: "user_not_found" }, 404);
    const statements = [];
    if (body.disabled != null) statements.push(environment.DB.prepare(
      "UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?",
    ).bind(Number(Boolean(body.disabled)), Date.now(), id));
    if (["user", "admin"].includes(body.role)) statements.push(environment.DB.prepare(
      "UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
    ).bind(body.role, Date.now(), id));
    if (!statements.length) return personalJson({ error: "invalid_user_update" }, 400);
    await environment.DB.batch(statements);
    if (body.disabled === true) await environment.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    return personalJson({ ok: true });
  }
  if (match && request.method === "DELETE") {
    const id = decodeURIComponent(match[1]);
    if (id === admin.id) return personalJson({ error: "cannot_delete_current_admin" }, 409);
    if (!await environment.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first()) {
      return personalJson({ error: "user_not_found" }, 404);
    }
    await deleteUserData(environment, id);
    return personalJson({ ok: true });
  }
  return null;
}

// Shared annotations are separate from OGF tags and private account data.
function featureInfoIdentity(type, value) {
  const text = String(value ?? "");
  const id = Number(text);
  return ["node", "way", "relation"].includes(type) && /^[1-9]\d{0,15}$/u.test(text)
    && Number.isSafeInteger(id) ? {type, id} : null;
}

function featureInfoFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))) {
    throw Object.assign(new Error("invalid_contribution_fields"), {status:400});
  }
}

function featureInfoText(value, maximum, required = true) {
  if (typeof value !== "string") throw Object.assign(new Error("invalid_contribution_text"), {status:400});
  const text = value.trim();
  if ((required && !text) || [...text].length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw Object.assign(new Error("invalid_contribution_text"), {status:400});
  }
  return text;
}

function featureInfoProperties(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw Object.assign(new Error("invalid_contribution_properties"), {status:400});
  }
  const seen = new Set();
  return value.map(property => {
    featureInfoFields(property,["key","value"]);
    const key = featureInfoText(property.key,80), text = featureInfoText(property.value,512);
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_:.-]*$/u.test(key) || seen.has(key)) {
      throw Object.assign(new Error("invalid_contribution_properties"), {status:400});
    }
    seen.add(key);
    return {key,value:text};
  });
}

function featureInfoContent(body, previousProperties = []) {
  const properties = body.properties === undefined ? previousProperties : featureInfoProperties(body.properties);
  const title = featureInfoText(body.title ?? "",80,!properties.length) || "属性补充";
  const content = featureInfoText(body.content ?? "",5000,!properties.length);
  const sourceUrl = featureInfoText(body.sourceUrl ?? "", 2048, false);
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw Object.assign(new Error("invalid_contribution_source"), {status:400});
    }
  }
  return {title, content, sourceUrl, properties};
}

const FEATURE_INFO_SELECT = `SELECT c.*, u.username, u.display_name,
  editor.username AS editor_username, editor.display_name AS editor_name,
  (SELECT json_group_array(json_object('key', property_key, 'value', property_value))
    FROM (SELECT property_key, property_value FROM feature_contribution_properties
      WHERE contribution_id = c.id ORDER BY position)) AS properties_json
  FROM feature_contributions c JOIN users u ON u.id = c.user_id
  LEFT JOIN users editor ON editor.id = c.edited_by`;

function publicFeatureInfo(row) {
  return {id:row.id, feature:{type:row.feature_type, id:row.feature_id, label:row.feature_name, lat:row.lat, lng:row.lng},
    author:{id:row.user_id, username:row.username, displayName:row.display_name},
    title:row.title, content:row.content, sourceUrl:row.source_url, revision:row.revision,
    properties:JSON.parse(row.properties_json || "[]"),
    createdAt:row.created_at, updatedAt:row.updated_at,
    editedBy:row.editor_username ? {username:row.editor_username, displayName:row.editor_name} : null};
}

async function handleFeatureInfoApi(request, environment, url) {
  const path = url.pathname;
  if (path !== "/api/feature-info" && path !== "/api/feature-info/search"
    && !path.startsWith("/api/feature-info/")) return null;
  if (path === "/api/feature-info/search") {
    if (request.method !== "GET") return personalJson({error:"method_not_allowed"}, 405, {Allow:"GET"});
    const query = featureInfoText(url.searchParams.get("q"), 100);
    const rows = await environment.DB.prepare(`SELECT c.feature_type, c.feature_id, c.feature_name, c.lat, c.lng,
      COUNT(*) AS matching_count, MAX(c.updated_at) AS updated_at,
      (SELECT group_concat(property_value, '／') FROM (SELECT DISTINCT p.property_value
        FROM feature_contribution_properties p JOIN feature_contributions n ON n.id = p.contribution_id
        WHERE n.feature_type = c.feature_type AND n.feature_id = c.feature_id
        AND p.property_key IN ('name', 'name:zh') ORDER BY p.property_value LIMIT 3)) AS shared_names
      FROM feature_contributions c
      WHERE instr(lower(c.feature_name || char(10) || c.title || char(10) || c.content), lower(?)) > 0
        OR EXISTS (SELECT 1 FROM feature_contribution_properties p WHERE p.contribution_id = c.id
          AND instr(lower(p.property_key || char(10) || p.property_value), lower(?)) > 0)
      GROUP BY c.feature_type, c.feature_id ORDER BY updated_at DESC, c.feature_type, c.feature_id LIMIT 13`).bind(query,query).all();
    return personalJson({items:rows.results.slice(0,12).map(row => ({type:row.feature_type, id:row.feature_id,
      label:row.feature_name, sharedNames:row.shared_names || "", lat:row.lat, lng:row.lng, matchingCount:row.matching_count})), hasMore:rows.results.length > 12});
  }
  if (path === "/api/feature-info" && request.method === "GET") {
    const feature = featureInfoIdentity(url.searchParams.get("type"), url.searchParams.get("id"));
    if (!feature) return personalJson({error:"invalid_feature_identity"},400);
    const limit = Number(url.searchParams.get("limit") || 20), cursor = url.searchParams.get("after");
    const parts = cursor?.match(/^(\d{1,16}):([a-zA-Z0-9_-]{1,80})$/u);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor && !parts)) return personalJson({error:"invalid_page"},400);
    const rows = await environment.DB.prepare(`${FEATURE_INFO_SELECT}
      WHERE c.feature_type = ? AND c.feature_id = ?
      ${parts ? "AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))" : ""}
      ORDER BY c.created_at, c.id LIMIT ?`).bind(feature.type, feature.id,
      ...(parts ? [Number(parts[1]),Number(parts[1]),parts[2]] : []), limit+1).all();
    const page = rows.results.slice(0,limit), last = page.at(-1);
    const total = await environment.DB.prepare("SELECT COUNT(*) AS count FROM feature_contributions WHERE feature_type = ? AND feature_id = ?")
      .bind(feature.type,feature.id).first("count");
    return personalJson({items:page.map(publicFeatureInfo), total,
      nextCursor:rows.results.length > limit && last ? `${last.created_at}:${last.id}` : null});
  }
  const match = path.match(/^\/api\/feature-info\/([a-zA-Z0-9_-]{1,80})$/u);
  if (!(path === "/api/feature-info" && request.method === "POST")
    && !(match && ["PATCH","DELETE"].includes(request.method))) {
    return personalJson({error:"method_not_allowed"},405,{Allow:match ? "PATCH, DELETE" : "GET, POST"});
  }
  const user = await requirePersonalUser(request, environment);
  const body = await readJsonBody(request, 32*1024), now = Date.now();
  if (path === "/api/feature-info") {
    featureInfoFields(body,["feature","title","content","sourceUrl","properties"]);
    featureInfoFields(body.feature,["type","id","label","lat","lng"]);
    const feature = featureInfoIdentity(body.feature.type,body.feature.id);
    const label = featureInfoText(body.feature.label,200), {lat,lng} = body.feature;
    if (!feature || typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 85 || Math.abs(lng) > 180) return personalJson({error:"invalid_feature_identity"},400);
    const {title,content,sourceUrl,properties} = featureInfoContent(body), id = crypto.randomUUID();
    // One atomic statement enforces per-account limits even for concurrent requests.
    const insert = environment.DB.prepare(`INSERT INTO feature_contributions
      (id,feature_type,feature_id,feature_name,lat,lng,user_id,title,content,source_url,created_at,updated_at,edited_by)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM feature_contributions WHERE user_id = ?) < 1000 AND
      (SELECT COUNT(*) FROM feature_contributions WHERE user_id = ? AND feature_type = ? AND feature_id = ?) < 20 AND
      (SELECT COUNT(*) FROM feature_contributions WHERE user_id = ? AND created_at > ?) < 5`)
      .bind(id,feature.type,feature.id,label,lat,lng,user.id,title,content,sourceUrl,now,now,user.id,
        user.id,user.id,feature.type,feature.id,user.id,now-60000);
    const [result] = await environment.DB.batch([insert,...properties.map((property,position) => environment.DB.prepare(
      `INSERT INTO feature_contribution_properties (contribution_id,property_key,property_value,position)
       SELECT id,?,?,? FROM feature_contributions WHERE id = ?`).bind(property.key,property.value,position,id))]);
    if (!result.meta.changes) return personalJson({error:"contribution_limit"},429,{"Retry-After":"60"});
    const row = await environment.DB.prepare(`${FEATURE_INFO_SELECT} WHERE c.id = ?`).bind(id).first();
    return personalJson({item:publicFeatureInfo(row)},201);
  }
  featureInfoFields(body,request.method === "DELETE" ? ["revision"] : ["revision","title","content","sourceUrl","properties"]);
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) return personalJson({error:"invalid_revision"},400);
  const row = await environment.DB.prepare(`${FEATURE_INFO_SELECT} WHERE c.id = ?`).bind(match[1]).first();
  if (!row) return personalJson({error:"contribution_not_found"},404);
  const admin = publicUser(user,environment).role === "admin";
  if (row.user_id !== user.id && !admin) return personalJson({error:"contribution_forbidden"},403);
  let result;
  if (request.method === "DELETE") {
    result = await environment.DB.prepare("DELETE FROM feature_contributions WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)")
      .bind(row.id,body.revision,user.id,admin ? 1 : 0).run();
  } else {
    const {title,content,sourceUrl,properties} = featureInfoContent(body,JSON.parse(row.properties_json || "[]"));
    const update = environment.DB.prepare(`UPDATE feature_contributions SET title = ?, content = ?, source_url = ?,
      updated_at = ?, edited_by = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)`)
      .bind(title,content,sourceUrl,now,user.id,row.id,body.revision,user.id,admin ? 1 : 0);
    // Every statement uses the same pre-update revision and permission guard.
    // D1 executes the batch transactionally, including property removal/replacement.
    const guard = "SELECT id FROM feature_contributions WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)";
    const statements = body.properties === undefined ? [] : [environment.DB.prepare(
      `DELETE FROM feature_contribution_properties WHERE contribution_id IN (${guard})`)
      .bind(row.id,body.revision,user.id,admin ? 1 : 0),
      ...properties.map((property,position) => environment.DB.prepare(
        `INSERT INTO feature_contribution_properties (contribution_id,property_key,property_value,position)
         SELECT id,?,?,? FROM feature_contributions WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)`)
        .bind(property.key,property.value,position,row.id,body.revision,user.id,admin ? 1 : 0))];
    result = (await environment.DB.batch([...statements,update])).at(-1);
  }
  if (!result.meta.changes) return personalJson({error:"contribution_conflict"},409);
  if (request.method === "DELETE") return personalJson({ok:true});
  const updated = await environment.DB.prepare(`${FEATURE_INFO_SELECT} WHERE c.id = ?`).bind(row.id).first();
  return personalJson({item:publicFeatureInfo(updated)});
}

const DATASET_SELECT = `SELECT d.*, u.username, u.display_name, e.username AS editor_username,
  e.display_name AS editor_name FROM shared_datasets d JOIN users u ON u.id = d.user_id
  LEFT JOIN users e ON e.id = d.edited_by`;

function datasetMetadata(body) {
  featureInfoFields(body,["title","kind","description","scope","source","sourceUrl","observedDate","unit","period","license"]);
  const t=createSharedDatasetTools(), value={title:t.text(body.title,120,true),kind:body.kind,
    description:t.text(body.description||"",2000),scope:t.scope(body.scope),source:t.text(body.source,500,true),
    sourceUrl:t.text(body.sourceUrl||"",2048),observedDate:t.text(body.observedDate,10,true),
    unit:t.text(body.unit||"",80),period:t.text(body.period||"",80),license:t.text(body.license,200,true)};
  if(!Object.hasOwn(t.KINDS,value.kind))throw Object.assign(new Error("数据分类无效"),{status:400});
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(value.observedDate)||!Number.isFinite(Date.parse(value.observedDate))
    ||new Date(value.observedDate).toISOString().slice(0,10)!==value.observedDate)throw Object.assign(new Error("统计日期无效"),{status:400});
  if(["population","gdp","land_price","demand","schedule"].includes(value.kind)&&!value.unit)throw Object.assign(new Error("请填写指标单位"),{status:400});
  if(value.sourceUrl){let u;try{u=new URL(value.sourceUrl);}catch{}
    if(!u||!["http:","https:"].includes(u.protocol)||u.username||u.password)throw Object.assign(new Error("来源链接仅支持 HTTP／HTTPS"),{status:400});}
  return value;
}
function publicDataset(row) {
  return {id:row.id,title:row.title,kind:row.kind,description:row.description,scope:JSON.parse(row.scope_json),
    source:row.source,sourceUrl:row.source_url,observedDate:row.observed_date,unit:row.unit,period:row.period,license:row.license,
    filename:row.filename,format:row.format,sha256:row.sha256,byteSize:row.byte_size,stats:JSON.parse(row.stats_json),
    fields:JSON.parse(row.fields_json),revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,
    author:{id:row.user_id,username:row.username,displayName:row.display_name},
    editedBy:row.editor_username?{username:row.editor_username,displayName:row.editor_name}:null};
}
async function datasetBytes(environment,id,kind) {
  const result=await environment.DB.prepare("SELECT position,data FROM shared_dataset_chunks WHERE dataset_id = ? AND kind = ? ORDER BY position").bind(id,kind).all();
  const chunks=result.results.map(row=>d1BlobBytes(row.data));
  if(!chunks.length||chunks.some((v,i)=>!v||result.results[i].position!==i))throw Error("Shared dataset chunks missing");
  const size=chunks.reduce((n,v)=>n+v.length,0);
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function readDatasetBody(request) {
  const reader=request.body?.getReader();if(!reader)throw Object.assign(Error("invalid_json"),{status:400});
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{throw Object.assign(Error("invalid_json"),{status:400});}
}
async function handleDatasetApi(request,environment,url) {
  const path=url.pathname;if(path!=="/api/datasets"&&!path.startsWith("/api/datasets/"))return null;
  if(path==="/api/datasets"&&request.method==="GET"){
    const q=(url.searchParams.get("q")||"").trim(),kind=url.searchParams.get("kind")||"",after=url.searchParams.get("after")||"";
    const limit=Number(url.searchParams.get("limit")||20),cursor=after.match(/^(\d{1,16}):([a-zA-Z0-9_-]{1,80})$/u);
    if(q.length>200||kind&&!Object.hasOwn(createSharedDatasetTools().KINDS,kind)||!Number.isInteger(limit)||limit<1||limit>50||after&&!cursor)return personalJson({error:"查询或分页参数无效"},400);
    const rows=await environment.DB.prepare(`${DATASET_SELECT} WHERE
      (? = '' OR d.kind = ?) AND (? = '' OR instr(lower(d.title || char(10) || d.description || char(10) || d.scope_json || char(10) || d.source),lower(?)) > 0)
      ${cursor?"AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?))":""}
      ORDER BY d.created_at DESC,d.id DESC LIMIT ?`).bind(kind,kind,q,q,...(cursor?[Number(cursor[1]),Number(cursor[1]),cursor[2]]:[]),limit+1).all();
    const page=rows.results.slice(0,limit),last=page.at(-1);
    return personalJson({items:page.map(row=>{const item=publicDataset(row);delete item.scope.geometry;return item;}),nextCursor:rows.results.length>limit&&last?`${last.created_at}:${last.id}`:null});
  }
  if(["/api/datasets","/api/datasets/validate"].includes(path)&&request.method==="POST"){
    const user=await requirePersonalUser(request,environment),body=await readDatasetBody(request);
    featureInfoFields(body,["metadata","format","filename","content","fields","shared"]);
    if(body.shared!==true)return personalJson({error:"请确认数据包公开共享"},400);
    const metadata=datasetMetadata(body.metadata),tools=createSharedDatasetTools(),filename=tools.text(body.filename,180,true);
    const data=tools.normalize(body.content,body.format,{kind:metadata.kind,scope:metadata.scope,fields:body.fields});
    if(path.endsWith("/validate"))return personalJson({stats:data.stats,columns:data.columns,numericColumns:data.numericColumns,preview:data.records.slice(0,20)});
    const id=crypto.randomUUID(),now=Date.now(),raw=textEncoder.encode(body.content),normalized=textEncoder.encode(JSON.stringify(data)),storageBytes=raw.length+normalized.length;
    const hash=await sha256Hex(body.content);
    const insert=environment.DB.prepare(`INSERT INTO shared_datasets
      (id,user_id,title,kind,description,scope_json,source,source_url,observed_date,unit,period,license,filename,format,sha256,
       byte_size,storage_bytes,stats_json,fields_json,created_at,updated_at,edited_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,user.id,metadata.title,metadata.kind,metadata.description,JSON.stringify(metadata.scope),metadata.source,metadata.sourceUrl,
        metadata.observedDate,metadata.unit,metadata.period,metadata.license,filename,body.format,hash,raw.length,storageBytes,
        JSON.stringify({...data.stats,columns:data.columns,numericColumns:data.numericColumns}),JSON.stringify(body.fields||{}),now,now,user.id);
    const statements=[insert];
    for(const [kind,bytes] of [["original",raw],["normalized",normalized]])for(let offset=0,position=0;offset<bytes.length;offset+=512*1024,position++){
      statements.push(environment.DB.prepare(`INSERT INTO shared_dataset_chunks(dataset_id,kind,position,data)
        SELECT id,?,?,? FROM shared_datasets WHERE id = ?`).bind(kind,position,bytes.slice(offset,offset+512*1024),id));
    }
    const [result]=await environment.DB.batch(statements);
    if(!result.meta.changes)throw Error("Shared dataset was not saved");
    return personalJson({item:publicDataset(await environment.DB.prepare(`${DATASET_SELECT} WHERE d.id = ?`).bind(id).first())},201);
  }
  const match=path.match(/^\/api\/datasets\/([a-zA-Z0-9_-]{1,80})(?:\/(data|download|analysis))?$/u);
  if(!match)return personalJson({error:"not_found"},404);
  const row=await environment.DB.prepare(`${DATASET_SELECT} WHERE d.id = ?`).bind(match[1]).first();
  if(!row)return personalJson({error:"数据包不存在或已删除"},404);
  if(request.method==="GET"){
    const item=publicDataset(row);
    if(match[2]==="download"){
      const bytes=await datasetBytes(environment,row.id,"original");
      if(bytes.length!==row.byte_size||bytesToHex(await crypto.subtle.digest("SHA-256",bytes))!==row.sha256)throw Error("Shared dataset original integrity failure");
      return new Response(bytes,{headers:{"Content-Type":"application/octet-stream",
        "Content-Disposition":`attachment; filename="dataset-${row.id}.${row.format}"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    if(match[2]){
      const data=JSON.parse(new TextDecoder().decode(await datasetBytes(environment,row.id,"normalized")));
      if(match[2]==="analysis"){
        const field=url.searchParams.get("field")||"value",mode=url.searchParams.get("mode")||"numeric",tools=createSharedDatasetTools();
        const explicitUnit=tools.text(url.searchParams.get("unit")||"",80);
        const unit=mode==="category"?"":explicitUnit||(field==="value"||data.primaryColumns?.includes(field)?item.unit:"");
        return personalJson({item,analysis:{...tools.analyze(data,{field,mode}),unit,unitSource:explicitUnit?"view":unit?"dataset":"unspecified"}});
      }
      return personalJson({item,data});
    }return personalJson({item});
  }
  if(match[2]||!["PATCH","DELETE"].includes(request.method))return personalJson({error:"method_not_allowed"},405);
  const user=await requirePersonalUser(request,environment),body=await readDatasetBody(request);
  featureInfoFields(body,request.method==="DELETE"?["revision"]:["revision","metadata"]);
  const admin=publicUser(user,environment).role==="admin";
  if(row.user_id!==user.id&&!admin)return personalJson({error:"只能管理自己上传的数据包"},403);
  if(!Number.isSafeInteger(body.revision)||body.revision<1)return personalJson({error:"invalid_revision"},400);
  let result;
  if(request.method==="DELETE")result=await environment.DB.prepare("DELETE FROM shared_datasets WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)").bind(row.id,body.revision,user.id,admin?1:0).run();
  else {
    const m=datasetMetadata(body.metadata);
    if(m.kind!==row.kind||JSON.stringify(m.scope)!==row.scope_json)return personalJson({error:"修改分类、范围或文件请发布新的数据包，保留原数据口径"},400);
    result=await environment.DB.prepare(`UPDATE shared_datasets SET title = ?, description = ?,source = ?,source_url = ?,observed_date = ?,unit = ?,period = ?,license = ?,updated_at = ?,edited_by = ?,revision = revision + 1
      WHERE id = ? AND revision = ? AND (user_id = ? OR ? = 1)`).bind(m.title,m.description,m.source,m.sourceUrl,m.observedDate,m.unit,m.period,m.license,Date.now(),user.id,row.id,body.revision,user.id,admin?1:0).run();
  }
  if(!result.meta.changes)return personalJson({error:"数据包已被更新，请刷新后重试"},409);
  return request.method==="DELETE"?personalJson({ok:true}):personalJson({item:publicDataset(await environment.DB.prepare(`${DATASET_SELECT} WHERE d.id = ?`).bind(row.id).first())});
}

// BEGIN SHARED DATASET CORE
function createSharedDatasetTools() {
  "use strict";
  const KINDS = Object.freeze({poi:"POI／设施",population:"人口",gdp:"GDP",land_price:"地价",demand:"通行需求",schedule:"车次安排",other:"其他数据"});
  const fail = message => {throw Object.assign(new Error(message), {status:400});};
  const plain = v => v && typeof v === "object" && !Array.isArray(v);
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  function text(value, max=200, required=false) {
    if (typeof value !== "string") fail("文字字段格式无效");
    const v=value.trim();
    if ((required&&!v)||[...v].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail("文字字段为空、过长或含控制字符");
    return v;
  }
  function numeric(v) {
    if(typeof v==="number")return Number.isFinite(v)?v:null;
    if(typeof v!=="string"||!v.trim())return null;
    const s=v.trim();
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(s))return null;
    const n=Number(s);return Number.isFinite(n)?n:null;
  }
  function identity(type,id) {
    if(!["node","way","relation"].includes(type)||!/^\d{1,16}$/u.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<=0)fail("要素类型或编号无效");
    return {type,id:Number(id)};
  }
  function csv(input) {
    const rows=[];let row=[],cell="",quoted=false,ended=false;
    for(let i=0;i<input.length;i++) {
      const c=input[i];
      if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else {quoted=false;ended=true;}}else cell+=c;continue;}
      if(c==='"'){if(cell||ended)fail("CSV 引号位置无效");quoted=true;continue;}
      if(c===","||c==="\n"||c==="\r") {
        row.push(cell);cell="";ended=false;
        if(c!==","){if(c==="\r"&&input[i+1]==="\n")i++;if(row.some(x=>x.trim()))rows.push(row);row=[];}
      } else {if(ended&&c!==" "&&c!=="\t")fail("CSV 引号后存在多余字符");if(!ended)cell+=c;}
    }
    if(quoted)fail("CSV 引号未闭合");
    row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
    const headers=rows.shift()?.map(v=>text(v,80,true));
    if(!headers?.length||new Set(headers).size!==headers.length)fail("CSV 表头为空或重复");
    return rows.map((values,i)=>{if(values.length!==headers.length)fail(`CSV 第 ${i+2} 行列数与表头不同`);return Object.fromEntries(headers.map((k,j)=>[k,values[j]]));});
  }
  function geometry(value,budget={vertices:0}) {
    if(value===null||value===undefined)return null;
    if(!plain(value)||!own(value,"coordinates"))fail("几何格式无效");
    const point=p=>{if(!Array.isArray(p)||p.length<2||p.length>3||p.some(n=>typeof n!=="number"||!Number.isFinite(n))||Math.abs(p[0])>180||Math.abs(p[1])>85)fail("坐标须为 WGS84 经度、纬度（纬度 ±85°）");budget.vertices++;return p.slice(0,2);};
    const line=(r,min)=>{if(!Array.isArray(r)||r.length<min)fail("几何顶点不足");return r.map(point);};
    const ring=r=>{const p=line(r,4);if(p[0][0]!==p.at(-1)[0]||p[0][1]!==p.at(-1)[1])fail("多边形环必须闭合");return p;};
    const poly=p=>{if(!Array.isArray(p)||!p.length)fail("多边形缺少外环");return p.map(ring);};
    let coordinates;
    switch(value.type){
      case "Point":coordinates=point(value.coordinates);break;
      case "MultiPoint":coordinates=line(value.coordinates,1);break;
      case "LineString":coordinates=line(value.coordinates,2);break;
      case "MultiLineString":if(!Array.isArray(value.coordinates)||!value.coordinates.length)fail("线集合为空");coordinates=value.coordinates.map(r=>line(r,2));break;
      case "Polygon":coordinates=poly(value.coordinates);break;
      case "MultiPolygon":if(!Array.isArray(value.coordinates)||!value.coordinates.length)fail("面集合为空");coordinates=value.coordinates.map(poly);break;
      default:fail("仅支持点、线、面及其多部件 GeoJSON 几何");
    }
    return {type:value.type,coordinates};
  }
  function scope(value) {
    if(!plain(value)||!["feature","region","large"].includes(value.kind))fail("请选择单要素、区域或更大范围");
    const result={kind:value.kind,label:text(value.label,200,true)};
    if(value.target)result.target=identity(value.target.type,value.target.id);
    if(value.geometry){result.geometry=geometry(value.geometry);if(value.kind!=="feature"&&!["Polygon","MultiPolygon"].includes(result.geometry.type))fail("区域范围须为真实面几何");}
    return result;
  }
  function normalize(input,format,options={}) {
    if(typeof input!=="string")fail("文件须为 UTF-8 文本");
    const s=input.replace(/^\uFEFF/u,"");let data;
    if(format==="csv")data=csv(s);
    else if(["json","geojson"].includes(format)){try{data=JSON.parse(s);}catch{fail("JSON 无法解析");}
      if(data?.crs)fail("请先转换为 WGS84 经纬度，不能导入其他坐标系");
      if(data?.type==="FeatureCollection")data=data.features;
      else if(data?.type==="Feature")data=[data];
      else if(plain(data)&&Array.isArray(data.records))data=data.records;
    } else fail("支持 CSV、JSON、GeoJSON 文件");
    if(!Array.isArray(data)||!data.length)fail("数据包须含至少一条记录");
    const area=options.scope?scope(options.scope):null,budget={vertices:0},columns=new Set(),primaryColumns=new Set(),numericColumns=new Map(),bounds=[Infinity,Infinity,-Infinity,-Infinity];
    const find=(p,aliases)=>aliases.find(k=>own(p,k));
    const fields=options.fields||{};
    for(const k of Object.keys(fields))if(!["lng","lat","name","value","type","id"].includes(k))fail("字段映射无效");
    for(const v of Object.values(fields))if(typeof v!=="string"||v.length>80)fail("字段映射无效");
    const records=data.map((raw,i)=>{
      if(!plain(raw))fail(`第 ${i+1} 条记录须为对象`);
      const p=raw.type==="Feature"?raw.properties:raw;
      if(!plain(p))fail(`第 ${i+1} 条记录缺少属性`);
      const props=Object.create(null);
      for(const [key,v] of Object.entries(p)) {
        if(key==="geometry"&&raw.type!=="Feature")continue;
        text(key,80,true);if(["__proto__","constructor","prototype"].includes(key))fail("属性名含保留字段");
        if(v!==null&&!["string","number","boolean"].includes(typeof v)||typeof v==="number"&&!Number.isFinite(v))fail(`第 ${i+1} 条属性仅支持文字、数字、布尔或空值`);
        if(typeof v==="string")text(v,2048);
        props[key]=v;columns.add(key);
      }
      const get=(role,aliases)=>fields[role]?fields[role]:find(props,aliases);
      const x=get("lng",["longitude","lon","lng","经度"]),y=get("lat",["latitude","lat","纬度"]);
      let g=geometry(raw.geometry,budget);
      const hasX=x&&props[x]!==null&&props[x]!=="",hasY=y&&props[y]!==null&&props[y]!=="";
      if(!g&&(hasX||hasY)){
        const a=numeric(props[x]),b=numeric(props[y]);if(a===null||b===null)fail(`第 ${i+1} 条经纬度缺失或不是数字`);g=geometry({type:"Point",coordinates:[a,b]},budget);
      }
      const typeKey=get("type",["osm_type","要素类型"]),idKey=get("id",["osm_id","要素编号"]);
      let target=null;
      if(typeKey||idKey){if(props[typeKey]!==""||props[idKey]!=="")target=identity(props[typeKey],props[idKey]);}
      if(!target&&data.length===1&&area?.target)target=area.target;
      if(!g&&data.length===1&&area?.geometry)g=geometry(area.geometry,budget);
      const nameKey=get("name",["name","名称","地区","站名"]),valueKey=get("value",({population:["population","人口","value","值"],gdp:["gdp","GDP","value","值"],land_price:["land_price","地价","value","值"],demand:["trips","demand","通行需求","value","值"],schedule:["frequency","车次","value","值"]})[options.kind]||["value","值"]);
      const value=valueKey?numeric(props[valueKey]):null;
      if(valueKey&&own(props,valueKey))primaryColumns.add(valueKey);
      if(valueKey&&props[valueKey]!==null&&props[valueKey]!==""&&value===null)fail(`第 ${i+1} 条指标不是有效数字，请用单位栏填写单位`);
      if(value!==null&&["population","gdp","land_price","demand","schedule"].includes(options.kind)&&value<0)fail(`第 ${i+1} 条指标不能为负数`);
      for(const [k,v] of Object.entries(props)){const n=numeric(v);if(n!==null){const stat=numericColumns.get(k)||{count:0,sum:0,min:Infinity,max:-Infinity};stat.count++;stat.sum+=n;stat.min=Math.min(stat.min,n);stat.max=Math.max(stat.max,n);if(!Number.isFinite(stat.sum))fail("指标合计超出可计算范围");numericColumns.set(k,stat);}}
      const visit=c=>{if(typeof c[0]==="number"){bounds[0]=Math.min(bounds[0],c[0]);bounds[1]=Math.min(bounds[1],c[1]);bounds[2]=Math.max(bounds[2],c[0]);bounds[3]=Math.max(bounds[3],c[1]);}else for(const p of c)visit(p);};if(g)visit(g.coordinates);
      return {properties:props,geometry:g,target,name:String(nameKey?props[nameKey]??"":target?`${target.type}:${target.id}`:`记录 ${i+1}`),value};
    });
    const result={schema:"huayu-shared-dataset-v1",records,columns:[...columns],primaryColumns:[...primaryColumns],numericColumns:Object.fromEntries(numericColumns),
      stats:{rows:records.length,located:records.filter(r=>r.geometry).length,linked:records.filter(r=>r.target).length,vertices:budget.vertices,bounds:bounds.every(Number.isFinite)?bounds:null}};
    return result;
  }
  function analyze(data,{field="value",mode="numeric"}={}) {
    if(!["numeric","category"].includes(mode))fail("专题图类型无效");
    if(field!=="value"&&!data.columns.includes(field))fail("专题字段不存在");
    let missing=0,unlocated=0;const values=[],features=[],categories=new Map();
    for(let i=0;i<data.records.length;i++){
      const r=data.records[i],raw=field==="value"?r.value:r.properties[field],v=mode==="numeric"?numeric(raw):raw==null||raw===""?null:String(raw);
      if(v===null){missing++;continue;}if(mode==="numeric")values.push(v);else categories.set(v,(categories.get(v)||0)+1);
      if(!r.geometry){unlocated++;continue;}
      features.push({type:"Feature",id:i,geometry:r.geometry,properties:{record:i,name:r.name,value:v}});
    }
    values.sort((a,b)=>a-b);const groups=[...categories].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const stops=values.length?[0,.25,.5,.75,1].map(q=>values[Math.floor((values.length-1)*q)]):[];
    const sum=values.reduce((a,b)=>a+b,0);if(!Number.isFinite(sum))fail("指标合计超出可计算范围");
    return {field,mode,rows:data.records.length,missing,unlocated,plotted:features.length,count:mode==="numeric"?values.length:groups.reduce((n,g)=>n+g[1],0),
      sum:values.length?sum:null,min:values[0]??null,max:values.at(-1)??null,mean:values.length?sum/values.length:null,stops,
      categories:groups.slice(0,12),categoryCount:groups.length,geojson:{type:"FeatureCollection",features}};
  }
  return Object.freeze({KINDS,text,numeric,identity,geometry,scope,normalize,analyze});
}
// END SHARED DATASET CORE

async function handlePersonalApi(request, environment) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/account"
    && !url.pathname.startsWith("/api/personal/") && !url.pathname.startsWith("/api/overlays")
    && !url.pathname.startsWith("/api/admin/") && !url.pathname.startsWith("/api/feature-info") && !url.pathname.startsWith("/api/datasets")) return null;
  if (!personalBindingsAvailable(environment)) {
    return personalJson({ error: "personal_data_service_not_configured" }, 503);
  }
  if (!sameOriginMutation(request)) return personalJson({ error: "cross_origin_request_blocked" }, 403);
  try {
    return await handleDatasetApi(request, environment, url)
      || await handleFeatureInfoApi(request, environment, url)
      || await handleAuthApi(request, environment, url)
      || await handleAccountApi(request, environment, url)
      || await handlePersonalDataApi(request, environment, url)
      || await handleOverlayApi(request, environment, url)
      || await handleAdminApi(request, environment, url)
      || personalJson({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("Personal data API failure", error);
    return personalJson({ error: status >= 500 ? "personal_data_failure" : String(error?.message || "request_failed") }, status);
  }
}

function featureDataQuery(url) {
  const p=url.searchParams,mode=p.get("mode"),number=name=>Number(p.get(name));
  const filters={all:'[~"."~"."]',
    building:'["building"]["building"!="no"]',road:'["highway"]',railway:'["railway"]',water:'["natural"="water"]',
    vegetation:'["natural"~"^(wood|scrub|tree|heath|grassland)$"]',landuse:'["landuse"]',amenity:'["amenity"]',shop:'["shop"]',tourism:'["tourism"]',boundary:'["boundary"]'};
  let select;
  if(mode==="object") {
    const type=p.get("type"),id=number("id");
    if(!["node","way","relation"].includes(type)||!Number.isSafeInteger(id)||id<=0)throw Error("INVALID_OBJECT");
    select=`${type}(${id});`;
  } else if(mode==="pick") {
    const lat=number("lat"),lon=number("lon"),radius=number("radius");
    if(!["lat","lon","radius"].every(n=>p.has(n)&&Number.isFinite(number(n)))||Math.abs(lat)>85||Math.abs(lon)>180||radius<5||radius>250)throw Error("INVALID_POINT");
    const at=`${lat.toFixed(7)},${lon.toFixed(7)}`;
    select=`nwr(around:${radius.toFixed(1)},${at})${filters.all};`;
    const areaKeys=["building","building:part","natural","landuse","leisure","amenity","tourism"];
    select=`is_in(${at})->.scopes;(${select}${areaKeys.map(k=>`way(pivot.scopes)["${k}"];rel(pivot.scopes)["${k}"];`).join("")});`;
    if(p.has("hitType")||p.has("hitId")) {
      const type=p.get("hitType"),id=number("hitId");
      if(!["node","way","relation"].includes(type)||!Number.isSafeInteger(id)||id<=0)throw Error("INVALID_OBJECT");
      select=select.replace(/;$/u,"")+`->.nearby;(.nearby;${type}(${id}););`;
    }
  } else if(mode==="atlas-future") {
    const s=number("south"),w=number("west"),n=number("north"),e=number("east");
    if(!["south","west","north","east"].every(k=>p.has(k)&&Number.isFinite(number(k)))||s>=n||w>=e||s< -85||n>85||w< -180||e>180)throw Error("INVALID_BOUNDS");
    if((n-s)*(e-w)*111.32**2*Math.cos((n+s)/2*Math.PI/180)>50000||n-s>4||e-w>4)throw Error("AREA_TOO_LARGE");
    const bbox=[s,w,n,e].map(v=>v.toFixed(7)).join(","),rail='^(rail|narrow_gauge|train|subway|light_rail|tram|monorail|maglev)$';
    const ways=`way["railway"~"^(construction|proposed)$"](${bbox});`
      + ["construction:railway","proposed:railway","construction","proposed"].map(k=>`way["${k}"~"${rail}"](${bbox});`).join("")
      + ["construction","proposed"].map(k=>`way["railway"~"${rail}"]["${k}"="yes"](${bbox});`).join("")
      + ["state","status"].map(k=>`way["railway"~"${rail}"]["${k}"~"^(construction|proposed)$"](${bbox});`).join("");
    const railRelation=`rel["type"~"^(route|route_master)$"][~"^(route|route_master|construction:route|proposed:route|construction|proposed)$"~"${rail}"]`;
    const relations=["state","status","railway","route"].map(k=>
      `${railRelation}["${k}"~"^(construction|proposed)$"](${bbox});`).join("")
      + ["construction","proposed"].map(k=>`${railRelation}["${k}"="yes"](${bbox});`
        + `rel["type"~"^(route|route_master)$"]["${k}:route"~"${rail}"](${bbox});`).join("");
    select=`(${ways})->.futureWays;rel(bw.futureWays)["type"~"^(route|route_master)$"]->.futureParents;`
      + `(.futureWays;.futureParents;${relations});`;
  } else if(mode==="area") {
    const s=number("south"),w=number("west"),n=number("north"),e=number("east"),kind=p.get("kind");
    if(!["south","west","north","east"].every(k=>p.has(k)&&Number.isFinite(number(k)))||s>=n||w>=e||s< -85||n>85||w< -180||e>180)throw Error("INVALID_BOUNDS");
    const area=(n-s)*(e-w)*111.32**2*Math.cos((n+s)/2*Math.PI/180);
    if(area>2500||n-s>2||e-w>2)throw Error("AREA_TOO_LARGE");
    let selectors;
    if(kind==="custom") {
      const tag=p.get("tag")||"",value=p.get("value")||"";
      if(!/^[a-zA-Z0-9_:.-]{1,80}$/u.test(tag)||value.length>120||/[\x00-\x1f]/u.test(value))throw Error("INVALID_TAG");
      selectors=[`[${JSON.stringify(tag)}${value?`=${JSON.stringify(value)}`:""}]`];
    } else {
      if(!filters[kind])throw Error("INVALID_KIND");
      selectors=[filters[kind],...({building:['["building:part"]["building:part"!="no"]'],water:['["waterway"]','["water"]'],
        vegetation:['["landuse"~"^(forest|grass|meadow)$"]'],amenity:['["office"]'],tourism:['["historic"]']}[kind]||[])];
    }
    const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
    let details=[];
    if(p.has("detail")) {
      if(p.get("detail").length>2048)throw Error("INVALID_DETAIL");
      try {details=JSON.parse(p.get("detail"));}catch {throw Error("INVALID_DETAIL");}
      if(!Array.isArray(details)||details.length>4||details.some(c=>!c||typeof c.tag!=="string"||!/^[a-zA-Z0-9_:.-]{1,80}$/u.test(c.tag)
        ||!Array.isArray(c.values)||c.values.length>24||c.values.some(v=>typeof v!=="string"||!v.length||v.length>80||/[\x00-\x1f\x7f]/u.test(v))))throw Error("INVALID_DETAIL");
    }
    if(details.length)selectors=selectors.flatMap(base=>details.map(c=>base+(c.values.length
      ?`[${JSON.stringify(c.tag)}~${JSON.stringify(`^(${c.values.map(escapeRegex).join("|")})$`)}]`:`[${JSON.stringify(c.tag)}][${JSON.stringify(c.tag)}!="no"]`)));
    const rawName=p.get("name")||"",name=rawName.trim(),nameMode=p.get("nameMode")||"contains";
    if(rawName.length>100||/[\x00-\x1f\x7f]/u.test(rawName)||!["contains","exact"].includes(nameMode))throw Error("INVALID_NAME");
    if(name) {
      const pattern=nameMode==="exact"?`^${escapeRegex(name)}$`:escapeRegex(name);
      selectors=selectors.map(base=>base+`[~"^(name|official_name|short_name|alt_name|loc_name|old_name)(:.*)?$"~${JSON.stringify(pattern)},i]`);
    }
    const bbox=[s,w,n,e].map(v=>v.toFixed(7)).join(",");
    select=`(${selectors.map(f=>`nwr(${bbox})${f};`).join("")});`;
  } else throw Error("INVALID_MODE");
  return `[out:json][timeout:25][maxsize:33554432];${select.replace(/;$/u,"")}->.selected;.selected out count;.selected out body geom 2001;(.selected;>>;);out body;`;
}

async function fetchFeatureData(request) {
  const url=new URL(request.url);
  const json=(value,status,headers={})=>buildingJsonResponse(JSON.stringify(value),status,headers);
  if(request.method!=="GET")return json({error:"仅支持读取地图物体"},405);
  let query;
  try {query=featureDataQuery(url);} catch(error) {
    const message={AREA_TOO_LARGE:"范围过大，请缩小范围后按类型分批读取",INVALID_TAG:"标签名称或值无效",INVALID_DETAIL:"细分类筛选无效，请重新选择",INVALID_NAME:"名称或匹配方式无效，名称最多 100 个字符"}[error.message]||"物体查询参数无效";
    return json({error:message},400);
  }
  try {
    const response=await fetch(OGF_OVERPASS_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
      body:new URLSearchParams({data:query}).toString(),signal:AbortSignal.timeout(32000)});
    if(!response.ok)throw Error(`OGF_HTTP_${response.status}`);
    const reader=response.body.getReader(),chunks=[];let size=0;
    try {while(true) {const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>32*1024*1024)throw Error("TOO_MANY_OBJECTS");chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    const payload=JSON.parse(new TextDecoder().decode(bytes));
    if(payload.remark||!Array.isArray(payload.elements)||payload.elements[0]?.type!=="count")throw Error("INCOMPLETE_FEATURE_DATA");
    const count=Number(payload.elements[0].tags?.total);
    if(!Number.isSafeInteger(count)||count<0)throw Error("INCOMPLETE_FEATURE_DATA");
    if(count>2000)throw Error("TOO_MANY_OBJECTS");
    const roots=payload.elements.slice(1,count+1);
    if(roots.length!==count||roots.some(e=>!["node","way","relation"].includes(e.type)))throw Error("INCOMPLETE_FEATURE_DATA");
    return json({elements:payload.elements.slice(1),rootKeys:roots.map(e=>`${e.type}/${e.id}`),fetchedAt:new Date().toISOString(),source:"OpenGeofiction"},200,{"Cache-Control":"no-store"});
  } catch(error) {
    return json({error:error.message==="TOO_MANY_OBJECTS"?"物体超过单次 2000 个或数据过大，请缩小范围；未加入不完整结果":"地图物体服务暂时不可用，请稍后重试"},error.message==="TOO_MANY_OBJECTS"?413:502,{"Cache-Control":"no-store"});
  }
}

function coastlineQuery(url) {
  const value=url.searchParams.get("bbox")||"";
  const parts=value.split(",");
  const [west,south,east,north]=parts.map(Number);
  if(parts.length!==4||parts.some(p=>!p.trim())||![west,south,east,north].every(Number.isFinite)
    ||west< -180||east>180||south< -85||north>85||east<=west||north<=south||east-west>60.0001||north-south>60.0001)throw Error("INVALID_COASTLINE_BOUNDS");
  // Overpass selects ways by their nodes. Read a surrounding strip too, so
  // ordinary long shoreline segments crossing a small boundary are included.
  const padding=.1;
  return `[out:json][timeout:30][maxsize:33554432];way["natural"="coastline"](${Math.max(-85,south-padding)},${Math.max(-180,west-padding)},${Math.min(85,north+padding)},${Math.min(180,east+padding)})->.coast;`
    + `.coast out count;.coast out body geom 12001;`;
}

async function fetchCoastline(request) {
  const json=(value,status)=>buildingJsonResponse(JSON.stringify(value),status,{"Cache-Control":"no-store"});
  if(request.method!=="GET")return json({error:"仅支持读取海岸线"},405);
  let query;
  try {query=coastlineQuery(new URL(request.url));}catch{return json({error:"海岸线范围无效或过大，请按行政区分批处理"},400);}
  try {
    const response=await fetch(OGF_OVERPASS_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
      body:new URLSearchParams({data:query}).toString(),signal:AbortSignal.timeout(37000)});
    if(!response.ok)throw Error("COASTLINE_UNAVAILABLE");
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>32*1024*1024)throw Error("COASTLINE_LIMIT");chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});}
    const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
    const payload=JSON.parse(new TextDecoder().decode(buffer)),count=Number(payload.elements?.[0]?.tags?.total);
    if(payload.remark||payload.elements?.[0]?.type!=="count"||!Number.isSafeInteger(count)||count<0)throw Error("COASTLINE_INCOMPLETE");
    if(count>12000)throw Error("COASTLINE_LIMIT");
    const elements=payload.elements.slice(1);
    if(elements.length!==count||elements.some(e=>e.type!=="way"||e.tags?.natural!=="coastline"||!e.nodes?.length
      ||e.nodes.length!==e.geometry?.length||e.geometry.some(p=>!Number.isFinite(p?.lon)||!Number.isFinite(p?.lat))))throw Error("COASTLINE_INCOMPLETE");
    if(elements.reduce((s,e)=>s+e.nodes.length,0)>300000)throw Error("COASTLINE_LIMIT");
    return json({elements,fetchedAt:new Date().toISOString(),sourceTimestamp:payload.osm3s?.timestamp_osm_base||null},200);
  }catch(error){return json({error:error.message==="COASTLINE_LIMIT"?"海岸线数据过大，请缩小范围后分批处理":"海岸线读取不完整或暂时不可用，请稍后重试；未采用部分结果"},error.message==="COASTLINE_LIMIT"?413:502);}
}

const brandRequests = new Map();
const brandRetryAfter = new Map();
// Keep these bounded selectors identical to HuayuBrandData; test-brands checks parity.
function brandNamedFacilityQuery(type = "nwr", scope = "", pattern = null) {
  const facilities = {shop: null, craft: null, office: "^(company|insurance|estate_agent|travel_agent|financial|telecommunication|it|lawyer|accountant|educational_institution|employment_agency)$",
    amenity: "^(bank|atm|bureau_de_change|cafe|restaurant|fast_food|ice_cream|bar|pub|food_court|pharmacy|fuel|charging_station|post_office|car_rental|car_sharing|bicycle_rental|veterinary|cinema|theatre|casino|internet_cafe)$",
    tourism: "^(hotel|motel|hostel|guest_house|apartment)$", healthcare: "^(hospital|clinic|dentist|pharmacy|physiotherapist|optometrist)$",
    leisure: "^(fitness_centre|sports_centre|bowling_alley|amusement_arcade)$"};
  const names = `[~"^(name(:.*)?|official_name|short_name|alt_name)$"~${JSON.stringify(pattern || ".")}${pattern ? ",i" : ""}]`;
  return `(${Object.entries(facilities).map(([key, values]) => `${type}[!"brand"]${values
    ? `[${JSON.stringify(key)}~${JSON.stringify(values)}]` : `[${JSON.stringify(key)}][${JSON.stringify(key)}!~"^(no|vacant|disused|abandoned|construction|proposed)$"]`}${names}${scope};`).join("")})`;
}
function brandNameQueryPattern(names, exact = false) {
  return `^(${names.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})${exact ? "$" : "($|[[:space:]（(·-]|.*(店|支行|分行|营业部|营业厅|分校|分院|branch|store)$)"}`;
}
function brandDataQuery(url) {
  const p = url.searchParams, kind = p.get("kind"), mode = p.get("mode") || "locations";
  if (!["brand", "operator"].includes(kind) || !["locations", "discover"].includes(mode)) throw Error("INVALID_BRAND_QUERY");
  const name = p.get("name") || "";
  if (mode === "locations" && (!name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/u.test(name))) throw Error("INVALID_BRAND_NAME");
  let scope = "", cityPrefix = "", city = null;
  if (p.get("scope") === "city") {
    const id = p.get("relation") || "";
    if (!/^[1-9]\d{0,15}$/u.test(id) || !Number.isSafeInteger(Number(id))) throw Error("INVALID_BRAND_CITY");
    city = Number(id);
    // Overpass areas preserve the actual administrative polygon, including holes
    // and separate parts. Never replace a missing area with its bounding box.
    cityPrefix = `rel(${city})["boundary"="administrative"]->.boundary;.boundary map_to_area->.cityArea;.cityArea out count;`;
    scope = "(area.cityArea)";
  } else if (p.get("scope") === "view") {
    const keys = ["south", "west", "north", "east"], values = keys.map(key => Number(p.get(key)));
    const [s, w, n, e] = values;
    if (!keys.every((key, index) => p.has(key) && p.get(key).trim() && Number.isFinite(values[index]))
      || s >= n || w >= e || s < -85 || n > 85 || w < -180 || e > 180
      || n - s > 4 || e - w > 4 || (n - s) * (e - w) * 111.32 ** 2 * Math.cos((n + s) / 2 * Math.PI / 180) > 50000) throw Error("BRAND_AREA_TOO_LARGE");
    scope = `(${values.map(value => value.toFixed(6)).join(",")})`;
  } else if (p.get("scope") !== "world" || mode === "discover") throw Error("INVALID_BRAND_SCOPE");
  const selector = mode === "locations" ? `[${JSON.stringify(kind)}=${JSON.stringify(name)}]` : `[${JSON.stringify(kind)}]`;
  const limit = mode === "discover" ? 2000 : 500;
  const includeNames = kind === "brand" && p.get("includeNames") === "1";
  let select = `nwr${selector}${scope}`;
  if (includeNames) {
    let aliases = [];
    if (p.has("aliases")) {
      try {aliases = JSON.parse(p.get("aliases"));} catch {throw Error("INVALID_BRAND_ALIAS");}
      if (!Array.isArray(aliases) || aliases.length > 12 || aliases.some(value => typeof value !== "string"
        || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/u.test(value))) throw Error("INVALID_BRAND_ALIAS");
    }
    const pattern = mode === "locations" ? brandNameQueryPattern([name, ...aliases], p.get("candidate") === "1") : null;
    select = `(${select};${brandNamedFacilityQuery("nwr", scope, pattern)};)`;
  }
  return {query: `[out:json][timeout:20][maxsize:8388608];${cityPrefix}${select}->.matches;.matches out count;.matches out ${mode === "discover" ? "tags" : "body center"} ${limit};`, limit, mode, city, includeNames};
}
async function fetchBrandData(request) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), {status,
    headers: {"Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store"}});
  if (request.method !== "GET") return json({error: "仅支持读取品牌数据"}, 405);
  const url = new URL(request.url);
  let definition;
  try {definition = brandDataQuery(url);} catch (error) {
    return json({error: error.message === "BRAND_AREA_TOO_LARGE" ? "当前范围过大，请放大地图后读取品牌" : "品牌名称或查询范围无效"}, 400);
  }
  // Canonical query identity excludes arbitrary cache-busting parameters and all personal data.
  const key = new Request(`${url.origin}/__brand-cache-v1?query=${encodeURIComponent(definition.query)}`);
  let previous;
  try {previous = await caches.default.match(key);} catch { /* Network remains available without cache. */ }
  const retained = previous ? await previous.json().catch(() => null) : null;
  if (retained && Date.now() - Date.parse(retained.fetchedAt) < 120000) return json(retained);
  const stale = (error = "品牌服务繁忙，请稍后重试") => retained
    ? json({...retained, stale: true, error: `${error}；保留上次完整结果`}) : json({error}, 502);
  if ((brandRetryAfter.get(key.url) || 0) > Date.now()) return stale();
  if (!brandRequests.has(key.url)) {
    if (brandRequests.size >= 16) return stale();
    const pending = (async () => {
      const response = await fetch(OGF_OVERPASS_URL, {method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        body: new URLSearchParams({data: definition.query}), signal: AbortSignal.timeout(28000)});
      if (!response.ok) throw Error("BRAND_UPSTREAM_FAILURE");
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const {value, done} = await reader.read(); if (done) break;
          size += value.length; if (size > 8 * 1024 * 1024) throw Error("BRAND_RESPONSE_TOO_LARGE");
          chunks.push(value);
        }
      } finally {await reader.cancel().catch(() => {});}
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.remark || !Array.isArray(payload.elements)) throw Error("INCOMPLETE_BRAND_DATA");
      if (definition.city && (payload.elements[0]?.type !== "count" || Number(payload.elements[0].tags?.total) !== 1)) {
        throw Error("BRAND_CITY_BOUNDARY_UNAVAILABLE");
      }
      const countIndex = definition.city ? 1 : 0, count = Number(payload.elements[countIndex]?.tags?.total);
      const elements = payload.elements.slice(countIndex + 1);
      if (payload.elements[countIndex]?.type !== "count" || !Number.isSafeInteger(count) || count < 0
        || elements.length !== Math.min(count, definition.limit)
        || new Set(elements.map(element => `${element.type}/${element.id}`)).size !== elements.length
        || elements.some(element => !["node", "way", "relation"].includes(element.type)
          || !Number.isSafeInteger(element.id) || !element.tags)) throw Error("INCOMPLETE_BRAND_DATA");
      const result = {elements, total: count, truncated: count > definition.limit, includeNames: definition.includeNames,
        ...(definition.city ? {cityRelation: definition.city} : {}),
        fetchedAt: new Date(Date.now()).toISOString(), dbTimestamp: payload.osm3s?.timestamp_osm_base || null,
        source: "OpenGeofiction", stale: false};
      try {await caches.default.put(key, new Response(JSON.stringify(result), {headers: {
        "Content-Type": "application/json", "Cache-Control": "public, max-age=86400"}}));} catch { /* Use the validated live response. */ }
      return result;
    })().finally(() => brandRequests.delete(key.url));
    brandRequests.set(key.url, pending);
  }
  try {return json(await brandRequests.get(key.url));} catch (error) {
    brandRetryAfter.delete(key.url); brandRetryAfter.set(key.url, Date.now() + 60000);
    while (brandRetryAfter.size > 64) brandRetryAfter.delete(brandRetryAfter.keys().next().value);
    return stale(error.message === "BRAND_CITY_BOUNDARY_UNAVAILABLE"
      ? "该行政边界暂时没有可查询的完整区域，请稍后重试；未按矩形范围替代统计" : undefined);
  }
}

export {
  fetchTrafficRegion,
  trafficRegionQueries,
  coastlineQuery,
  normalizedFavorites,
  featureDataQuery,
  brandDataQuery,
  brandNamedFacilityQuery,
  brandNameQueryPattern,
  hashPassword,
  parseCookie,
  validateOverlayBounds,
  validatePassword,
  validateUsername,
  validImageSignature,
};

export default {
  async fetch(request, environment, context) {
    const url = new URL(request.url);
    if (url.pathname === "/api/traffic-region") return fetchTrafficRegion(request, context);
    const personalResponse = await handlePersonalApi(request, environment);
    if (personalResponse) return personalResponse;
    if (url.pathname === "/api/features") return fetchFeatureData(request);
    if (url.pathname === "/api/coastline") return fetchCoastline(request);
    if (url.pathname === "/api/brands") return fetchBrandData(request);
    if (url.pathname === "/terrain-preload.json.gz"
      || (["/terrain-preload-chunks/", "/terrain-render-cache/"].some(prefix => url.pathname.startsWith(prefix))
        && url.pathname.endsWith(".json.gz"))) {
      const asset = await environment.ASSETS.fetch(request);
      if (asset.status !== 200) return asset;
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "application/json; charset=UTF-8");
      headers.set("Content-Encoding", "gzip");
      headers.set("Cache-Control", url.pathname !== "/terrain-preload.json.gz"
        ? "public, max-age=31536000, immutable, no-transform"
        : "public, max-age=300, must-revalidate, no-transform");
      // The asset body already contains gzip bytes. Do not gzip it again.
      return new Response(asset.body, { status: asset.status, headers, encodeBody: "manual" });
    }
    const match = url.pathname.match(/^\/api\/buildings\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (match) {
      return fetchBuildingTile(request, context, ...match.slice(1).map(Number));
    }
    const structureMatch = url.pathname.match(/^\/api\/structures\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (structureMatch) {
      return fetchStructureTile(request, context, ...structureMatch.slice(1).map(Number));
    }
    const liveBasemapMatch = url.pathname.match(/^\/api\/live-basemap\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (liveBasemapMatch) {
      return fetchLiveBasemapTile(request, context, ...liveBasemapMatch.slice(1).map(Number));
    }
    const terrainMatch = url.pathname.match(/^\/api\/terrain\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (terrainMatch) {
      return fetchTerrainTile(request, context, ...terrainMatch.slice(1).map(Number));
    }
    const transitMatch = url.pathname.match(/^\/api\/transit\/(rail|bus)\/(\d+)\/(\d+)\/(\d+)\.json$/u);
    if (transitMatch) {
      return fetchTransitTile(request, context, transitMatch[1], ...transitMatch.slice(2).map(Number));
    }
    return environment.ASSETS.fetch(request);
  },
};
