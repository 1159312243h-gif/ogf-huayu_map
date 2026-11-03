import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const exportModule = await readFile(new URL("../site/map-export.js", import.meta.url), "utf8");
const feature = { type: "Feature", properties: { name: "测试区", osm_id: 10, admin_level: 6,
  admin_center: { coordinates: [152.96, 14.65], name: "中心", osm_id: 20, osm_type: "node",
    match_method: "relation_admin_centre", tags: { place: "town" } } },
  geometry: { type: "Polygon", coordinates: [
    [[152.9, 14.6], [153, 14.6], [153, 14.7], [152.9, 14.7], [152.9, 14.6]],
    [[152.91, 14.61], [152.92, 14.61], [152.92, 14.62], [152.91, 14.62], [152.91, 14.61]],
  ] } };
const features = [feature];
const downloads = [], canvases = [], requests = [], statuses = [];
let centerQueries = 0, activeRequests = 0, maxActiveRequests = 0, symbols = 0;
const control = (value = "", checked = false) => ({ value, checked, disabled: false, hidden: false,
  textContent: "", querySelector: () => ({ textContent: "" }) });
const elements = {
  boundaryFormat: control("png"), boundaryResolution: control("2400"),
  boundaryIncludeCoordinates: control("", true), boundaryIncludePoints: control("", true),
  boundaryIncludeBasemap: control(), boundaryResolutionNote: control(), boundaryFormatNote: control(),
  boundaryLevelStatus: control(), boundaryExtentStatus: control(), boundaryDownloadButton: control(),
  boundaryExtentFieldset: control(), boundaryCoordinateFields: control(),
  boundaryExtentModes: [control("administrative", true), control("coordinates")],
  boundaryIncludeHighlight: control("",true), boundaryIncludeBuildings: control("",true),
  boundaryClipCoastline: control(), boundaryCoastlinePart: control("land"),
  boundaryBasemapStyle: control("carto"), boundaryBasemapOptions: control(), boundaryBuildingsNote: control(),
  boundaryClipShape: control("rectangle"), boundaryPolygonControls: control(),
  boundaryCustomResolution: control("3600"), boundaryCustomResolutionLabel: control(),
};
const context = vm.createContext({ Blob, TextEncoder, elements, administrativeExportBusy: false, currentView: "download",
  administrativePolygonPoints: null, administrativeExportPolygon: null,
  BASEMAP_STYLES: {carto:{label:"OGF-Carto US"}},
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  document: { createElement(type) {
    assert.equal(type, "canvas");
    const canvas = { width: 0, height: 0, texts: [], draws: [], scaleFactors: [] };
    const ctx = new Proxy({
      scale: (x, y) => canvas.scaleFactors.push([x, y]),
      fillText: text => canvas.texts.push(text),
      drawImage: (...args) => canvas.draws.push(args.slice(1)),
      stroke: () => { canvas.strokes=(canvas.strokes||0)+1; },
      measureText: text => ({ width: String(text).length * 8 }),
      getImageData: (x,y,width=canvas.width,height=canvas.height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    canvas.getContext = () => ctx;
    canvases.push(canvas);
    return canvas;
  } },
  administrativeExportBoundaries: () => [{ label: "测试区", feature }],
  administrativeExportFeatures: () => features,
  administrativeExportRenderOrder: items => items,
  ensureAdministrativeExportCenters: async () => { centerQueries += 1; return ""; },
  drawAdministrativeCenterSymbol: () => { symbols += 1; },
  loadAdministrativeTile: async (zoom, x, y) => {
    requests.push([zoom, x, y]); activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await Promise.resolve(); activeRequests -= 1;
    return { tile: true };
  },
  canvasToBlob: async (canvas, mime) => new Blob([JSON.stringify([canvas.width, canvas.height])], { type: mime }),
  downloadBlob: (blob, name) => downloads.push({ blob, name }),
  setStatus: (_, text, error) => statuses.push({ text, error }), showToast: () => {},
  syncMapLayers: () => {}, cancelAdministrativeBoxPick: () => {},
  updateAdministrativeCoastControls: () => {},
  humanizeError: error => { throw error; },
});
context.window=context;
vm.runInContext(exportModule,context);
for (const name of ["administrativeExportResolution", "activeAdministrativeFeatureBounds", "administrativeBoundaryImageLayout",
  "administrativeExportMask", "administrativeExportBasemapBounds",
  "administrativeTilePlan", "administrativeMercatorNormalized", "administrativeExportCenters", "administrativeBoundaryFeatureKey",
  "administrativeLevelLabel", "administrativeLevelColor", "administrativeCenterSymbol",
  "renderAdministrativeBoundaryCanvas", "renderAdministrativeBasemapCanvas", "drawAdministrativeCanvasFeature",
  "drawAdministrativeCanvasLabel", "drawAdministrativeCoordinateGrid", "administrativeGridStep", "administrativeGridPrecision",
  "drawAdministrativeCanvasCenters", "drawAdministrativeCenterLegend", "buildAdministrativeGeoTiff",
  "administrativeExportManifest", "administrativeExportReadme", "buildAdministrativeShapefileEntries",
  "encodeAdministrativeShapefileLayer", "administrativeShapeRecord", "administrativeSignedArea", "sameAdministrativeCoordinate",
  "encodeAdministrativeShapeContent", "writeShapefileHeader", "encodeAdministrativeDbf", "encodeDbfText",
  "buildAdministrativeOsmXml", "xmlEscape", "buildStoredZip", "crc32", "safeDownloadName",
  "captureAdministrativeDownload", "buildAdministrativeDownload", "downloadAdministrativeBoundary", "updateAdministrativeExportAvailability", "updateAdministrativeExportOptions",
  "updateAdministrativeExtentStatus", "updateAdministrativeResolutionNote"]) {
  const declaration = app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}
const plain = value => JSON.parse(JSON.stringify(value));
const bounds = context.activeAdministrativeFeatureBounds(features);
const centers = context.administrativeExportCenters(features);
const centreAnnotation = `测试区 · ${context.administrativeLevelLabel(feature.properties.admin_level)}`;
const original = JSON.stringify(features);
const drawing=[[152.9,14.6],[153,14.6],[153,14.7],[152.9,14.7]];
const drawingBefore=JSON.stringify(drawing);
assert.equal(context.HuayuMapExport.polygon(drawing).geometry.coordinates[0].length,5);
assert.equal(JSON.stringify(drawing),drawingBefore,"closing a polygon preserves the original points");
for(const invalid of [null,[],[null,null,null],[[0,0],[1,1],[0,1],[1,0]],[[0,0],[1,0],[2,0]],[[0,0],[0,0],[1,1]],
  [[0,0],[181,0],[1,1]],[[0,0],[1,0],[1,86]]]) {
  assert.equal(context.HuayuMapExport.polygon(invalid),null,"invalid drawing must not be exported");
}
const tiffTags = async blob => {
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getUint16(2, true), 42);
  const start = view.getUint32(4, true), tags = new Map();
  for (let i = 0; i < view.getUint16(start, true); i += 1) {
    const offset = start + 2 + i * 12, tag = view.getUint16(offset, true), type = view.getUint16(offset + 2, true);
    const count = view.getUint32(offset + 4, true), value = view.getUint32(offset + 8, true);
    tags.set(tag, type === 12 ? Array.from({ length: count }, (_, j) => view.getFloat64(value + j * 8, true)) : value);
  }
  return tags;
};
const zipEntries = async blob => {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), result = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    result.set(new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength)), bytes.slice(start, start + length));
    offset = start + length;
  }
  return result;
};

let previousBoundary, previousBasemap, previousZoom = -1;
for (const resolution of [1200, 2400, 4800]) {
  for (const includePoints of [true, false]) {
    const before = symbols;
    const rendered = context.renderAdministrativeBoundaryCanvas(features, "测试区", { resolution, includePoints, includeCoordinates: true });
    assert.equal(Math.max(rendered.canvas.width, rendered.canvas.height), resolution);
    assert.equal(symbols > before, includePoints, "point symbols and legend obey inclusion");
    assert.equal(rendered.canvas.texts.some(text => text.includes("中心未标注")), false,
      "excluding known centres must not mark their area labels as missing");
    assert.equal(rendered.canvas.texts.includes(centreAnnotation), includePoints,
      "centre annotations obey the point-feature choice");
    assert.equal(rendered.canvas.texts.some(text => text.startsWith(centreAnnotation) && text !== centreAnnotation), false,
      "omitting centres must not create replacement area annotations");
    assert.ok(rendered.canvas.texts.includes("测试区"), "document title remains when map annotations are omitted");
    assert.deepEqual(plain(rendered.bounds), plain(bounds));
    if (previousBoundary) {
      assert.ok(Math.abs(rendered.geoReference.pixelScaleX * rendered.canvas.width
        - previousBoundary.geoReference.pixelScaleX * previousBoundary.canvas.width) < 1e-9);
      assert.ok(Math.abs(rendered.geoReference.tieX / rendered.canvas.width
        - previousBoundary.geoReference.tieX / previousBoundary.canvas.width) < 1e-9);
    }
    previousBoundary = rendered;
    const baseline = symbols;
    const basemap = await context.renderAdministrativeBasemapCanvas(features, "测试区", bounds,
      { resolution, includePoints, includeCoordinates: true });
    assert.equal(Math.max(basemap.canvas.width, basemap.canvas.height), resolution);
    assert.equal(symbols > baseline, includePoints, "composited basemap also obeys point inclusion");
    assert.equal(basemap.canvas.texts.includes(centreAnnotation), includePoints,
      "basemap centre annotations obey the point-feature choice");
    assert.equal(basemap.canvas.texts.some(text => text.startsWith(centreAnnotation) && text !== centreAnnotation), false,
      "basemap export must not create replacement area annotations");
    const geo = basemap.geoReference, earth = Math.PI * 6378137 * 2;
    const northwest = context.administrativeMercatorNormalized(bounds.minLon, bounds.maxLat);
    const southeast = context.administrativeMercatorNormalized(bounds.maxLon, bounds.minLat);
    assert.ok(Math.abs(geo.tieLon + geo.pixelScaleX * basemap.canvas.width - (southeast.x * earth - earth / 2)) < 1e-6);
    assert.ok(Math.abs(geo.tieLat - geo.pixelScaleY * basemap.canvas.height - (earth / 2 - southeast.y * earth)) < 1e-6);
    if (previousBasemap) assert.deepEqual(plain(basemap.bounds), plain(previousBasemap.bounds));
    previousBasemap = basemap;
    if (resolution === 1200) {
      for (const image of [rendered, basemap]) {
        const tags = await tiffTags(context.buildAdministrativeGeoTiff(image));
        assert.equal(tags.get(256), image.canvas.width); assert.equal(tags.get(257), image.canvas.height);
        assert.deepEqual(tags.get(33550), [image.geoReference.pixelScaleX, image.geoReference.pixelScaleY, 0]);
        assert.deepEqual(tags.get(33922), [image.geoReference.tieX, image.geoReference.tieY, 0,
          image.geoReference.tieLon, image.geoReference.tieLat, 0]);
        const withoutCoordinates = await tiffTags(context.buildAdministrativeGeoTiff(image, false));
        assert.equal(withoutCoordinates.has(33550), false);
      }
    }
  }
  const plan = context.administrativeTilePlan(bounds, resolution);
  assert.ok(plan.zoom > previousZoom, "higher resolution selects finer native tiles for the same area");
  previousZoom = plan.zoom;
  for (const extent of [bounds, { minLon: -180, maxLon: 180, minLat: -85, maxLat: 85 },
    { minLon: 100, maxLon: 100.0001, minLat: 1, maxLat: 2 }]) {
    const bounded = context.administrativeTilePlan(extent, resolution);
    assert.equal(Math.max(bounded.width, bounded.height), resolution);
    assert.ok((bounded.lastTileX - bounded.firstTileX + 1) * (bounded.lastTileY - bounded.firstTileY + 1) <= 512);
  }
}
assert.ok(maxActiveRequests <= 8, "basemap downloads stay within the concurrency budget");
assert.throws(() => context.administrativeTilePlan({ ...bounds, maxLon: NaN }), /INVALID_EXPORT_BOUNDS/u);
assert.equal(context.administrativeExportResolution("invalid"), 2400);
for (const size of [800,1600,3200,6400,8192,3601]) {
  const plan=context.administrativeTilePlan(bounds,size);
  assert.equal(Math.max(plan.width,plan.height),size);
  assert.ok((plan.lastTileX-plan.firstTileX+1)*(plan.lastTileY-plan.firstTileY+1)<=512);
}
elements.boundaryResolution.value="custom";
for(const invalid of ["", "511", "8193", "1200.5", "NaN"]) {
  elements.boundaryCustomResolution.value=invalid;
  assert.equal(context.administrativeExportResolution(),null);
  context.updateAdministrativeExportAvailability();assert.equal(elements.boundaryDownloadButton.disabled,true);
}
elements.boundaryCustomResolution.value="3601";
assert.equal(context.administrativeExportResolution(),3601);
elements.boundaryResolution.value="2400";
for(const renderer of ["renderAdministrativeBoundaryCanvas","renderAdministrativeBasemapCanvas"]) {
  const options={resolution:800,includePoints:false,includeCoordinates:false,includeHighlight:false};
  const rendered=await context[renderer](features,"test",renderer.includes("Basemap")?bounds:options,options);
  assert.equal(rendered.canvas.strokes||0,0,"disabled highlight paints no boundary stroke");
}
const transparent=await context.renderAdministrativeBasemapCanvas(features,"test",bounds,
  {resolution:800,includePoints:false,maskFeatures:[feature]});
const alphaTags=await tiffTags(context.buildAdministrativeGeoTiff(transparent));
assert.equal(alphaTags.get(277),4,"clipped TIFF retains a fourth alpha band");
assert.equal(alphaTags.get(338),2,"TIFF declares unassociated alpha");

// Areas without confirmed centres previously kept a fallback label even when
// point features were excluded. Both raster paths must suppress that label.
const withoutCenter = { ...feature, properties: { name: "无中心测试区", osm_id: 11, admin_level: 6 } };
for (const includePoints of [false, true]) {
  const options = { includePoints, resolution: 1200 };
  const images = [context.renderAdministrativeBoundaryCanvas([withoutCenter], "测试导出", options),
    await context.renderAdministrativeBasemapCanvas([withoutCenter], "测试导出", bounds, options)];
  for (const { canvas } of images) {
    assert.equal(canvas.texts.some(text => text.startsWith("无中心测试区 ·")), includePoints,
      "fallback area annotations also obey the point-feature choice");
  }
}

for (const includePoints of [true, false]) {
  const options = { includePoints };
  const entries = context.buildAdministrativeShapefileEntries(features, centers, "测试区", options);
  assert.equal(entries.some(entry => entry.name === "administrative-centres.shp"), includePoints);
  const shape = entries.find(entry => entry.name === "administrative-boundaries.shp");
  assert.equal(new DataView(shape.data.buffer).getInt32(144, true), 2, "boundary hole survives export");
  const xml = context.buildAdministrativeOsmXml(features, centers, "", options);
  assert.equal(xml.includes('role="admin_centre"'), includePoints);
  assert.equal(xml.includes('role="inner"'), true, "OSM retains boundary holes and required geometry nodes");
  assert.equal(xml.includes(`v="${includePoints ? "included" : "excluded"}"`), true);
  const report = context.administrativeExportManifest(features, centers, "测试区", "", options);
  assert.equal(report.centerCount, includePoints ? 1 : 0);
  assert.equal(report.includePoints, includePoints);
  assert.equal(report.missingCenters.length, 0, "excluded point features must not be reported as unresolved");
}

// Exercise the download handler: both content choices and dimensions must
// reach each actual export branch, including the raster inside vector ZIPs.
elements.boundaryResolution.value = "1200";
for (const format of ["png", "jpg", "tif", "osm", "shp"]) {
  for (const basemap of [false, true]) {
    for (const includePoints of [false, true]) {
      elements.boundaryFormat.value = format;
      elements.boundaryIncludeBasemap.checked = basemap;
      elements.boundaryIncludePoints.checked = includePoints;
      const queriesBefore = centerQueries, downloadsBefore = downloads.length, symbolsBefore = symbols;
      const canvasesBefore = canvases.length;
      await context.downloadAdministrativeBoundary();
      assert.equal(downloads.length, downloadsBefore + 1, `${format}: a file was generated`);
      assert.equal(centerQueries - queriesBefore, includePoints ? 1 : 0, "excluded points skip supplementary network query");
      const file = downloads.at(-1);
      if (!includePoints) {
        for (const canvas of canvases.slice(canvasesBefore)) {
          assert.equal(canvas.texts.some(text => text.startsWith(centreAnnotation)), false,
            `${format}: excluding points must also exclude map annotations`);
        }
      }
      if (["png", "jpg", "tif"].includes(format)) {
        assert.equal(symbols > symbolsBefore, includePoints);
        if (format === "tif") {
          const tags = await tiffTags(file.blob);
          assert.equal(Math.max(tags.get(256), tags.get(257)), 1200);
        } else assert.equal(Math.max(...JSON.parse(await file.blob.text())), 1200);
      } else if (format === "osm" && !basemap) {
        assert.equal((await file.blob.text()).includes('role="admin_centre"'), includePoints);
      } else {
        const archive = await zipEntries(file.blob);
        const info = JSON.parse(new TextDecoder().decode(archive.get("export-info.json")));
        assert.equal(info.includePoints, includePoints); assert.equal(info.centerCount, includePoints ? 1 : 0);
        if (format === "shp") assert.equal(archive.has("administrative-centres.shp"), includePoints);
        else assert.equal(new TextDecoder().decode(archive.get("administrative-boundaries.osm")).includes('role="admin_centre"'), includePoints);
        assert.equal(archive.has("ogf-basemap.tif"), basemap);
        if (basemap) {
          const tags = await tiffTags(new Blob([archive.get("ogf-basemap.tif")]));
          assert.equal(Math.max(tags.get(256), tags.get(257)), 1200);
          assert.equal(info.basemap.width, tags.get(256)); assert.equal(info.basemap.height, tags.get(257));
        }
      }
      assert.equal(statuses.at(-1).error, false, "successful intentional exclusions are not errors");
    }
  }
}
elements.boundaryFormat.value = "shp";
elements.boundaryIncludeBasemap.checked = false;
context.updateAdministrativeExportOptions();
assert.equal(elements.boundaryResolution.disabled, true);
assert.equal(elements.boundaryResolution.value, "1200", "vector mode does not discard the selected size");
elements.boundaryIncludeBasemap.checked = true;
context.updateAdministrativeExportOptions();
assert.equal(elements.boundaryResolution.disabled, false);
assert.match(elements.boundaryResolutionNote.textContent, /1200/u);
elements.boundaryIncludeBasemap.checked = false;
elements.boundaryResolution.value="custom";
elements.boundaryCustomResolution.value="";
context.updateAdministrativeExportAvailability();
assert.equal(elements.boundaryDownloadButton.disabled,false,"a disabled raster-size input cannot block vector-only downloads");
await context.downloadAdministrativeBoundary();
assert.equal(downloads.at(-1).name.endsWith("-shp.zip"),true);
elements.boundaryResolution.value="1200";
elements.boundaryFormat.value = "png";
elements.boundaryIncludePoints.checked = false;
context.updateAdministrativeExportOptions();
assert.match(elements.boundaryFormatNote.textContent, /不绘制点符号与地名注记/u);
assert.match(elements.boundaryResolutionNote.textContent, /不绘制地名注记/u);
assert.equal(elements.boundaryResolutionNote.textContent.includes("图例"), false);
assert.equal(JSON.stringify(features), original, "export options do not mutate source features or centres");

// Use the actual coast intersection algorithm while exercising every download
// branch. Original administrative vectors and derived land must coexist.
for (const file of ["vendor/polygon-clipping-0.15.7.js","coastline.js"]) {
  vm.runInContext(await readFile(new URL(`../site/${file}`,import.meta.url),"utf8"),context);
}
const coastLand=[[[[152.9,14.6],[152.95,14.6],[152.95,14.7],[152.9,14.7],[152.9,14.6]]]];
const coastMetadata={fetchedAt:"2026-11-03T01:00:00Z",sourceTimestamp:"2026-11-03T00:55:00Z",includesInlandWater:true};
context.analyzeAdministrativeCoast=async (input,_signal,part)=>({rows:context.HuayuCoastline.analyze(input,coastLand,undefined,part),metadata:coastMetadata});
elements.boundaryClipCoastline.checked=true;
elements.boundaryIncludePoints.checked=false;
elements.boundaryIncludeBasemap.checked=false;
for (const part of ["land","sea"]) {
elements.boundaryCoastlinePart.value=part;
for (const format of ["png","jpg","tif","shp","osm"]) {
  elements.boundaryFormat.value=format;
  const job=context.captureAdministrativeDownload();
  assert.equal(job.options.clipCoastline,true);
  assert.equal(job.options.coastPart,part);
  elements.boundaryClipCoastline.checked=false;
  elements.boundaryCoastlinePart.value=part==="sea"?"land":"sea";
  const result=await context.buildAdministrativeDownload(job);
  assert.equal(result.coastline.part,part,"export uses queued land/sea choice, independent of current controls");
  assert.match(result.name,new RegExp(part==="sea"?"仅海域":"仅陆地"));
  assert.equal(result.coastline.sourceTimestamp,coastMetadata.sourceTimestamp);
  const area=result.coastline.areas[0];
  assert.ok(area.landSquareMeters>0&&area.seaSquareMeters>0);
  assert.equal(area.totalSquareMeters,area.landSquareMeters+area.seaSquareMeters);
  if(format==="tif"){
    const tags=await tiffTags(result.blob);assert.equal(tags.get(277),4);assert.equal(tags.get(338),2);
  }
  if(format==="shp"||format==="osm") {
    const entries=await zipEntries(result.blob);
    const clipped=JSON.parse(new TextDecoder().decode(entries.get(`coastline-${part}.geojson`))).features[0];
    assert.equal(clipped.properties.area_square_meters,part==="sea"?area.seaSquareMeters:area.landSquareMeters);
    if(part==="land") {
      assert.equal(context.activeAdministrativeFeatureBounds([clipped]).maxLon,152.95);
      assert.equal(clipped.geometry.coordinates[0].length,2,"land clipping retains the inland administrative hole");
    } else {
      assert.equal(context.activeAdministrativeFeatureBounds([clipped]).minLon,152.95,"marine geometry excludes all land");
      assert.equal(entries.has("coastline-land.geojson"),false);
    }
    assert.ok(entries.has("coastline-areas.csv"));
    const info=JSON.parse(new TextDecoder().decode(entries.get("export-info.json")));
    assert.equal(info.coastline.areas[0].seaSquareMeters,area.seaSquareMeters);
    assert.equal(info.coastline.includesInlandWater,true);
    assert.equal(info.coastPart,part);
    if(format==="shp") {
      assert.ok(entries.has(`coastline-${part}.shp`));
      const dbf=entries.get(`coastline-${part}.dbf`),view=new DataView(dbf.buffer,dbf.byteOffset),decoder=new TextDecoder();
      const header=view.getUint16(8,true);let record=header+1;
      const attributes={};
      for(let descriptor=32;descriptor<header-1;descriptor+=32) {
        const field=decoder.decode(dbf.slice(descriptor,descriptor+11)).replaceAll("\0",""),length=dbf[descriptor+16];
        attributes[field]=decoder.decode(dbf.slice(record,record+length)).trim();record+=length;
        if(field.endsWith("_M2")){assert.equal(dbf[descriptor+11],0x4e);assert.equal(dbf[descriptor+17],3);}
      }
      assert.equal(attributes.DERIVED,`coastline-${part}-v1`);
      assert.ok(Math.abs(Number(attributes.LAND_M2)-area.landSquareMeters)<.001);
      assert.ok(Math.abs(Number(attributes.SEA_M2)-area.seaSquareMeters)<.001);
      const originalShape=entries.get("administrative-boundaries.shp");
      assert.equal(new DataView(originalShape.buffer,originalShape.byteOffset).getFloat64(52,true),153,
        "original administrative boundary retains its sea extent");
    } else assert.ok(entries.has("administrative-boundaries.osm"));
  }
  assert.equal(JSON.stringify(features),original);
  elements.boundaryClipCoastline.checked=true;
  elements.boundaryCoastlinePart.value=part;
}
}
elements.boundaryCoastlinePart.value="land";
const originalAnalysis=context.analyzeAdministrativeCoast,coastJob=context.captureAdministrativeDownload();
context.analyzeAdministrativeCoast=async()=>{throw Error("coast-source-failed");};
await assert.rejects(context.buildAdministrativeDownload(coastJob),/coast-source-failed/);
context.analyzeAdministrativeCoast=async input=>({rows:context.HuayuCoastline.analyze(input,[]),metadata:coastMetadata});
await assert.rejects(context.buildAdministrativeDownload(coastJob),/没有可下载的陆地/);
const seaJob=JSON.parse(JSON.stringify(coastJob));seaJob.options.coastPart="sea";
context.analyzeAdministrativeCoast=async input=>({rows:context.HuayuCoastline.analyze(input,[feature.geometry.coordinates],undefined,"sea"),metadata:coastMetadata});
await assert.rejects(context.buildAdministrativeDownload(seaJob),/没有可下载的海域/);
assert.equal(JSON.stringify(features),original,"coastline failures preserve source boundaries and queued snapshots");
context.analyzeAdministrativeCoast=originalAnalysis;
// Exercise the actual Huayu export preparation, not just the retry helper:
// recover individual failed tiles without committing a partial building source.
const retryRequests=[],retryDelays=[],buildingWrites=[],retryProgress=[],signals=[];
const retryAttempts=new Map(),buildingCache=new Map();
let failure="recover",active=0,maximumActive=0,cleanups=0;
const exportTiles=[{key:"a"},{key:"b"},{key:"c"}];
const exportMap={on:()=>{},off:()=>{},getLayer:()=>true,getStyle:()=>({layers:[]}),
  getSource:()=>({setData:data=>buildingWrites.push(plain(data))}),setLayoutProperty:()=>{}};
const retryContext=vm.createContext({AbortController,DOMException,Date,Map,
  clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  ensureVectorBasemapLibrary:async()=>{},prepareVectorBasemap:async()=>{},fetchJson:async()=>({version:8}),
  BASEMAP_STYLES:{huayu:{label:"华域标准",url:"/fixture-style.json"}},
  setStatus:()=>{},elements:{boundaryLevelStatus:{}},
  ensureHuayuPoiImages:()=>{},applyHuayuSatelliteTextures:()=>{},ensureHuayuLiveBasemapLayers:()=>{},
  ensureHuayuLiveBuildingLayer:()=>{},addHuayuPoiImage:()=>{},activateHuayuModelOcclusion:()=>{},
  deactivateHuayuModelOcclusion:()=>{cleanups++;},
  huayuWoodlandMaterialLayers:new Map(),terrainOverlayEnabled:false,
  HUAYU_LIVE_BASEMAP_MIN_ZOOM:99,HUAYU_LIVE_BUILDING_MIN_ZOOM:10,
  HUAYU_LIVE_BUILDING_SOURCE:"buildings",HUAYU_LIVE_BUILDING_LAYER:"building-layer",
  HUAYU_ANCIENT_BUILDING_LAYERS:{ancient:"ancient"},HUAYU_VECTOR_BUILDING_LAYER_IDS:["base-buildings"],
  administrativeExportTiles:()=>exportTiles,huayuLiveBuildingSharedTileCache:buildingCache,
  huayuLiveBuildingEntryFresh:entry=>Boolean(entry?.fresh),fetchHuayuLiveBuildingTile:()=>{},
  loadHuayuModelTile:async(kind,tile,_fetch,signal)=>{
    assert.equal(kind,"building");signals.push(signal);retryRequests.push(tile.key);
    const attempt=(retryAttempts.get(tile.key)||0)+1;retryAttempts.set(tile.key,attempt);
    active++;maximumActive=Math.max(maximumActive,active);
    try {
      await Promise.resolve();
      if(failure==="recover"&&tile.key==="a"&&attempt<3)throw Error("BUILDING_TILE_HTTP_504");
      if(failure==="persistent")throw Error("BUILDING_TILE_HTTP_504");
      if(failure==="denied")throw Error("BUILDING_TILE_HTTP_403");
      if(failure==="incomplete")throw Error("INCOMPLETE_MODEL_TILE");
      return {data:{features:[{id:tile.key}]},loadedAt:123};
    } finally {active--;}
  },
});
retryContext.window={setTimeout:(callback,delay)=>{retryDelays.push(delay);return setTimeout(callback,0);},clearTimeout,
  HuayuMapExport:{vectorCanvas:async({prepare})=>{let cleanup;try{cleanup=await prepare(exportMap,12);}finally{cleanup?.();}}}};
for(const name of ["loadAdministrativeBuildingTile","renderAdministrativeHuayuBasemap"])
  vm.runInContext(app.match(new RegExp(`  async function ${name}\\([^]*?\\n  \\}`,"u"))[0],retryContext);
const retryOptions={basemapStyle:"huayu",includeBuildings:true,onProgress:message=>retryProgress.push(message)};
const retryOptionsBefore={...retryOptions};
await retryContext.renderAdministrativeHuayuBasemap({},bounds,retryOptions);
assert.equal(retryAttempts.get("a"),3);assert.equal(retryAttempts.get("b"),1);assert.equal(retryAttempts.get("c"),1);
assert.deepEqual(retryDelays,[1000,3000]);
assert.equal(buildingWrites.length,1);assert.equal(buildingWrites[0].features.length,3);
assert.ok(retryProgress.some(message=>message.includes("重试（2/2）")));
assert.ok(maximumActive<=3,"tile retries retain the three-request concurrency budget");
assert.equal(cleanups,1);assert.ok(signals.every(signal=>signal.aborted));
assert.deepEqual(retryOptions,retryOptionsBefore,"recovery does not disable user-selected models or modify download options");
retryRequests.length=retryDelays.length=buildingWrites.length=0;retryAttempts.clear();failure="persistent";
await assert.rejects(retryContext.renderAdministrativeHuayuBasemap({},bounds,retryOptions),error=>
  /建筑模型.*HTTP 504.*自动重试 2 次/u.test(error.message)&&!error.message.includes("BUILDING_TILE_HTTP"));
assert.equal(retryAttempts.get("a"),3);assert.equal(buildingWrites.length,0);
assert.equal(cleanups,2);assert.ok(signals.every(signal=>signal.aborted),"persistent failure cleans up every outstanding request");
for(const [mode,expected] of [["denied",/HTTP 403/u],["incomplete",/INCOMPLETE_MODEL_TILE/u]]) {
  failure=mode;retryRequests.length=retryDelays.length=0;
  await assert.rejects(retryContext.loadAdministrativeBuildingTile(exportTiles[0],new AbortController().signal),expected);
  assert.equal(retryRequests.length,1);assert.equal(retryDelays.length,0,"non-transient errors are not retried");
}
const cancelled=new AbortController();cancelled.abort();retryRequests.length=0;
await assert.rejects(retryContext.loadAdministrativeBuildingTile(exportTiles[0],cancelled.signal),{name:"AbortError"});
assert.equal(retryRequests.length,0);
failure="persistent";retryRequests.length=retryDelays.length=0;
const cancelDuringProgress=new AbortController();
await assert.rejects(retryContext.loadAdministrativeBuildingTile(exportTiles[0],cancelDuringProgress.signal,()=>cancelDuringProgress.abort()),{name:"AbortError"});
assert.equal(retryRequests.length,1);assert.equal(retryDelays.length,0);
failure="recover";retryRequests.length=0;
buildingCache.set("a",{fresh:true,data:{features:[{id:"cached"}]},loadedAt:100});
const cached=await retryContext.loadAdministrativeBuildingTile(exportTiles[0],new AbortController().signal);
assert.equal(cached.loadedAt,100);assert.equal(retryRequests.length,0,"valid cached model source times are preserved");
console.log("Huayu download recovery passed: bounded tile retries, complete model source, unchanged options, readable errors, cache reuse and cancellation cleanup.");
console.log("Administrative export passed: all formats, independent points/highlights, 800–8192 and custom image sizes, valid polygon selection, native tile detail, bounded requests, preserved holes, TIFF alpha and georeferencing.");
