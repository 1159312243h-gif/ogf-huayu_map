const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const {createHash,webcrypto} = require("node:crypto");
const {gzipSync} = require("node:zlib");

// Prepare the existing material, rather than asking every new browser to
// infer the same national overview. The browser still refines close views.
async function renderRuntime(siteDirectory) {
  const source = await fs.readFile(path.join(siteDirectory, "app.js"), "utf8");
  const declaration = name => {
    const result = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
    if (!result) throw new Error(`Missing shared terrain function: ${name}`);
    return result;
  };
  const factory = vm.createContext({});
  for (const name of ["HUAYU_MOUNTAIN_WOODLAND_MIN_AREA", "HUAYU_REGIONAL_MOUNTAIN_SURFACE_MIN_AREA", "HUAYU_TERRAIN_MIN_ZOOM"]) {
    vm.runInContext(source.match(new RegExp(`  const ${name} = [^;]+;`, "u"))[0], factory);
  }
  const functions = declaration("huayuTerrainMeshWorkerSource").match(/const functions = \[([^]*?)\];/u)[1]
    .split(",").map(name => name.trim());
  for (const name of functions) vm.runInContext(declaration(name), factory);
  vm.runInContext(declaration("huayuTerrainMeshWorkerSource"), factory);
  const runtime = vm.createContext({Float32Array, Uint8Array, TextEncoder, crypto:webcrypto,
    performance, setTimeout, clearTimeout, self:{}});
  vm.runInContext(factory.huayuTerrainMeshWorkerSource(), runtime);
  vm.runInContext(declaration("huayuMountainSurfaceOverviewFeatures"), runtime);
  runtime.renderFingerprint = createHash("sha256").update(functions.map(name=>declaration(name)).join("\n")).digest("hex");
  return runtime;
}

async function writeTerrainRenderCache(siteDirectory, payload) {
  const runtime = await renderRuntime(siteDirectory);
  const directory = path.join(siteDirectory, "terrain-render-cache");
  await fs.mkdir(directory, {recursive:true});
  const span = 8;
  const groups = new Map();
  const surfaces = payload.features.filter(feature => feature.properties?.reliefRole === "surface");
  const context = payload.features.filter(feature => feature.properties?.materialOcclusion);
  for (const feature of surfaces) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
    for (const polygon of polygons) for (const [x,y] of polygon[0]) {
      west=Math.min(west,x);east=Math.max(east,x);south=Math.min(south,y);north=Math.max(north,y);
    }
    for (let y=Math.floor(south/span);y<Math.ceil(north/span);y++) {
      for (let x=Math.floor(west/span);x<Math.ceil(east/span);x++) {
        const id=`${y}-${x}`;
        if (!groups.has(id)) groups.set(id,{id,cell:{key:`published/${id}`,level:-1,span,
          bounds:{west:x*span,east:(x+1)*span,south:Math.max(-85,y*span),north:Math.min(85,(y+1)*span)}},features:[]});
        groups.get(id).features.push(feature);
      }
    }
  }
  const entries=[];
  for (const group of [...groups.values()].sort((a,b)=>a.id.localeCompare(b.id))) {
    const occlusions=context.filter(feature=>runtime.huayuMountainSurfaceFeatureIntersectsViewport(feature,group.cell.bounds));
    const features=runtime.huayuMountainSurfaceLandscapes(
      runtime.huayuMountainSurfaceOverviewFeatures(group.features,group.cell.bounds,7),occlusions)
      .sort((a,b)=>Number(b.properties.reliefArea)-Number(a.properties.reliefArea));
    const water=occlusions.filter(feature=>feature.properties.materialOcclusion==="water" && !feature.properties.bridge);
    const signature=createHash("sha256").update(`overview-v2:${runtime.renderFingerprint}:`
      + [...features,...occlusions].map(feature=>feature.terrainDigest || JSON.stringify(feature)).join("|")).digest("hex");
    const filename=`${group.id}-${signature.slice(0,16)}.json.gz`;
    const target=path.join(directory,filename);
    let bytes;
    try {bytes=(await fs.stat(target)).size;} catch {}
    if (!bytes) {
      const built=await runtime.huayuWoodlandMaterialBuildGeometry(features,{features:water},group.cell.bounds,7);
      if (!built.values.length) continue;
      const encoded=Buffer.from(built.values.buffer,built.values.byteOffset,built.values.byteLength).toString("base64");
      // Geometry is also the exact coverage mask, including holes and open-land
      // colours; no raster outline, new height model or second layer is added.
      const packet={format:1,model:"woodland-material-overview-v1",coordinateSpace:"cell-local-v1",cell:group.cell,
        surfaces:features,occlusions,vertices:encoded,renderedNeighbors:built.renderedNeighbors};
      const body=gzipSync(JSON.stringify(packet),{level:9});
      if (body.length>=25*1024*1024) throw new Error(`Terrain render block exceeds Pages limit: ${group.id}`);
      await fs.writeFile(target,body);
      bytes=body.length;
      console.log(`Terrain prepared material ${group.id}: ${features.length} surfaces, ${built.values.length/9} vertices`);
    }
    entries.push({id:group.id,cell:group.cell,url:`./terrain-render-cache/${filename}`,bytes});
  }
  return entries;
}

module.exports={renderRuntime,writeTerrainRenderCache};
