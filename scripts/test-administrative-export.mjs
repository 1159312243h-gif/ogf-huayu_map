import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
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
};
const context = vm.createContext({ Blob, TextEncoder, elements, administrativeExportBusy: false, currentView: "download",
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  document: { createElement(type) {
    assert.equal(type, "canvas");
    const canvas = { width: 0, height: 0, texts: [], draws: [], scaleFactors: [] };
    const ctx = new Proxy({
      scale: (x, y) => canvas.scaleFactors.push([x, y]),
      fillText: text => canvas.texts.push(text),
      drawImage: (...args) => canvas.draws.push(args.slice(1)),
      measureText: text => ({ width: String(text).length * 8 }),
      getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
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
  humanizeError: error => { throw error; },
});
for (const name of ["administrativeExportResolution", "activeAdministrativeFeatureBounds", "administrativeBoundaryImageLayout",
  "administrativeTilePlan", "administrativeMercatorNormalized", "administrativeExportCenters", "administrativeBoundaryFeatureKey",
  "administrativeLevelLabel", "administrativeLevelColor", "administrativeCenterSymbol",
  "renderAdministrativeBoundaryCanvas", "renderAdministrativeBasemapCanvas", "drawAdministrativeCanvasFeature",
  "drawAdministrativeCanvasLabel", "drawAdministrativeCoordinateGrid", "administrativeGridStep", "administrativeGridPrecision",
  "drawAdministrativeCanvasCenters", "drawAdministrativeCenterLegend", "buildAdministrativeGeoTiff",
  "administrativeExportManifest", "administrativeExportReadme", "buildAdministrativeShapefileEntries",
  "encodeAdministrativeShapefileLayer", "administrativeShapeRecord", "administrativeSignedArea", "sameAdministrativeCoordinate",
  "encodeAdministrativeShapeContent", "writeShapefileHeader", "encodeAdministrativeDbf", "encodeDbfText",
  "buildAdministrativeOsmXml", "xmlEscape", "buildStoredZip", "crc32", "safeDownloadName",
  "downloadAdministrativeBoundary", "updateAdministrativeExportAvailability", "updateAdministrativeExportOptions",
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
elements.boundaryFormat.value = "png";
elements.boundaryIncludePoints.checked = false;
context.updateAdministrativeExportOptions();
assert.match(elements.boundaryFormatNote.textContent, /不绘制点符号与地名注记/u);
assert.match(elements.boundaryResolutionNote.textContent, /不绘制地名注记/u);
assert.equal(elements.boundaryResolutionNote.textContent.includes("图例"), false);
assert.equal(JSON.stringify(features), original, "export options do not mutate source features or centres");
console.log("Administrative export passed: point and annotation inclusion in all formats, 1200/2400/4800 pixels, native tile detail, bounded requests, preserved boundaries and TIFF georeferencing.");
