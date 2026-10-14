import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const frames = [], present = new Set(), sources = new Map(), layers = new Map(), listeners = new Map();
const canvas = {style: {}};
let serial = 1, submissions = 0, conversions = 0, focused = null;
const plain = value => JSON.parse(JSON.stringify(value));
const geometry = {type: "MultiPolygon", coordinates: [
  [[[155.7, 9.4], [155.9, 9.4], [155.9, 9.6], [155.7, 9.6], [155.7, 9.4]],
    [[155.75, 9.45], [155.8, 9.45], [155.8, 9.5], [155.75, 9.45]]],
  [[[156, 9.5], [156.1, 9.5], [156.1, 9.6], [156, 9.5]]],
]};
const path = geometry => ({id: serial++, feature: {type: "Feature", properties: {name: "测试区"}, geometry},
  options: {color: "#d83a2e", weight: 3.5, opacity: 0.96, fill: true, fillColor: "#e84b3c", fillOpacity: 0.055},
  toGeoJSON(precision) {assert.equal(precision, false); conversions++; return this.feature;}});
const boundary = path(geometry), road = path({type: "LineString", coordinates: [[152, 14], [152.1, 14.1]]});
road.options.fill = false;
const group = paths => ({eachLayer(fn) {paths.forEach(fn);}, paths});
const boundaryGroup = group([boundary]), roadGroup = group([road]), divisionGroup = group([]);
const groups = [
  {id: "boundary", group: boundaryGroup, order: 425, haloOrder: 420, haloWidth: 8},
  {id: "division", group: divisionGroup, order: 423, haloOrder: 421, haloWidth: 4.5},
  {id: "road", group: roadGroup, order: 418, haloOrder: 414, haloWidth: 11},
];
present.add(boundaryGroup); present.add(roadGroup);
const featureStates = [];
const glMap = {
  getStyle: () => ({layers: [{id: "base"}]}), getSource: id => sources.get(id), getLayer: id => layers.get(id),
  addSource(id, source) {sources.set(id, {...source, setData(data) {this.data = data; submissions++;}}); submissions++;},
  addLayer(layer) {layers.set(layer.id, layer);}, removeLayer(id) {layers.delete(id);}, removeSource(id) {sources.delete(id);},
  setFeatureState: (target, state) => featureStates.push({target, state}), getCanvas: () => canvas,
  on(event, layer, handler) {if (!handler) {handler = layer; layer = "";}
    const key = `${event}:${layer}`; assert.ok(!listeners.has(key), "no duplicate highlight listeners"); listeners.set(key, handler);},
  off(event, layer, handler) {if (!handler) {handler = layer; layer = "";}
    const key = `${event}:${layer}`; assert.equal(listeners.get(key), handler); listeners.delete(key);},
};
const context = vm.createContext({window: {L: {stamp: layer => layer.id, DomEvent: {stopPropagation: event => {event.stopped = true;}}},
  requestAnimationFrame: fn => {frames.push(fn); return frames.length;}},
  map: {hasLayer: layer => present.has(layer)}, mapHighlightGroups: groups,
  mapHighlightFrame: null, mapHighlightProjectionPending: false, mapHighlightRevision: 1,
  vectorPerspectiveActive: true, vectorPerspectiveMap: glMap, vectorHighlightState: null,
  VECTOR_HIGHLIGHT_SOURCE: "highlights", placeSubdivisionHitLayer: group([]),
  mapFeatureSelectionEnabled: true, mapPickTarget: null, administrativeBoxPicking: false,
  focusAdministrativeDivision: (feature, layer) => {focused = {feature, layer};},
});
for (const name of ["scheduleMapHighlightProjection", "vectorHighlightCollection", "syncVectorHighlightOverlay", "removeVectorHighlightOverlay"]) {
  const declaration = app.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "u"))?.[0];
  assert.ok(declaration, name); vm.runInContext(declaration, context);
}

context.syncVectorHighlightOverlay();
assert.deepEqual(plain(sources.get("highlights").data.features[0].geometry), geometry,
  "native highlights retain the full geographic multipolygon, separate parts and holes");
assert.equal(sources.get("highlights").data.features[1].properties.fillOpacity, 0, "roads retain line-only highlighting");
assert.equal(layers.size, 9, "one retained highlight set, including white casings");
const order = [...layers.keys()];
assert.ok(order.indexOf("highlights-boundary-halo") < order.indexOf("highlights-boundary-line"));
assert.ok(order.indexOf("highlights-road-line") < order.indexOf("highlights-boundary-line"));
const originalData = sources.get("highlights").data;
for (let i = 0; i < 50; i++) {
  context.scheduleMapHighlightProjection({type: i % 2 ? "zoomend" : "resize"});
  context.scheduleMapHighlightProjection();
  assert.equal(frames.length, 1, "camera and panel changes coalesce");
  frames.shift()();
}
assert.equal(submissions, 1, "native camera changes never re-upload geographic geometry");
assert.equal(conversions, 2, "camera changes do not re-serialize all boundary vertices");
assert.equal(sources.get("highlights").data, originalData);

present.delete(boundaryGroup);
context.scheduleMapHighlightProjection(); frames.shift()();
assert.deepEqual(plain(sources.get("highlights").data.features.map(feature => feature.properties.group)), ["road"]);
present.add(boundaryGroup);
context.scheduleMapHighlightProjection(); frames.shift()();
assert.deepEqual(plain(sources.get("highlights").data.features[0].geometry), geometry, "reopening the panel restores its real boundary");
const division = path({type: "Polygon", coordinates: geometry.coordinates[0]});
divisionGroup.paths.push(division); present.add(divisionGroup); context.mapHighlightRevision++;
context.syncVectorHighlightOverlay();
const event = {features: [{id: division.id}], originalEvent: {}};
listeners.get("mousemove:highlights-division-fill")(event);
assert.equal(canvas.style.cursor, "pointer");
assert.equal(featureStates.at(-1).state.hover, true);
const beforeHover = submissions;
listeners.get("mousemove:highlights-division-fill")(event);
assert.equal(submissions, beforeHover, "hover uses feature state, not a full source upload");
listeners.get("click:highlights-division-fill")(event);
assert.equal(focused.layer, division, "native hit-testing opens the actual selected administrative division");
assert.equal(event.originalEvent.stopped, true);
focused = null; context.mapFeatureSelectionEnabled = false;
listeners.get("click:highlights-division-fill")(event);
assert.equal(focused.layer, division, "loaded administrative divisions remain navigable when generic map selection is off");
focused = null; context.mapPickTarget = "origin";
listeners.get("click:highlights-division-fill")(event);
assert.equal(focused, null, "route endpoint picking keeps priority over administrative navigation");
context.mapPickTarget = null; context.administrativeBoxPicking = true;
listeners.get("click:highlights-division-fill")(event);
assert.equal(focused, null, "administrative export box picking keeps priority over subdivision navigation");
context.administrativeBoxPicking = false;
context.mapFeatureSelectionEnabled = true;

boundary.feature.geometry = {type: "Polygon", coordinates: geometry.coordinates[1]};
context.mapHighlightRevision++;
context.syncVectorHighlightOverlay();
assert.deepEqual(plain(sources.get("highlights").data.features[0].geometry), boundary.feature.geometry,
  "late selected geometry replaces old highlights even when layer identity is reused");
sources.clear(); layers.clear();
listeners.get("style.load:")();
assert.ok(sources.has("highlights") && layers.has("highlights-boundary-line"), "style reload restores the current selection");

context.scheduleMapHighlightProjection();
context.vectorPerspectiveActive = false;
context.removeVectorHighlightOverlay();
frames.shift()();
assert.equal(sources.size, 0); assert.equal(layers.size, 0); assert.equal(listeners.size, 0);
assert.equal(canvas.style.cursor, "");
context.vectorPerspectiveActive = true;
context.syncVectorHighlightOverlay();
assert.equal(listeners.size, 4, "repeated perspective entry has only one listener set");
context.vectorPerspectiveActive = false; context.removeVectorHighlightOverlay();

// Use the shipped Leaflet SVG renderer to verify retained paths at new zooms,
// rather than checking just that a projection callback was called.
const element = () => ({style: {}, className: "", attributes: {}, children: [],
  setAttribute(key, value) {this.attributes[key] = value;}, removeAttribute(key) {delete this.attributes[key];},
  appendChild(child) {this.children.push(child);}, addEventListener() {}, removeEventListener() {}, createSVGRect() {}});
const leafletWindow = {devicePixelRatio: 1, screen: {}, addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() {return 1;}, cancelAnimationFrame() {}, setTimeout() {}, clearTimeout() {}};
const runtime = vm.createContext({window: leafletWindow, navigator: {userAgent: "node", platform: "Win32"},
  document: {documentElement: {style: {transform: ""}}, createElement: element, createElementNS: element},
  console, setTimeout() {}, clearTimeout() {}});
vm.runInContext(await readFile(new URL("../site/leaflet.js", import.meta.url), "utf8"), runtime);
const L = leafletWindow.L, size = L.point(1280, 900), centre = L.latLng(9.52, 155.84);
L.Browser.any3d = true;
let zoom = 10, origin;
const geographicMap = {
  getSize: () => size, getZoom: () => zoom, getCenter: () => centre,
  getZoomScale: (z, from) => 2 ** (z - from), project: (ll, z) => L.CRS.EPSG3857.latLngToPoint(ll, z),
  _getNewPixelOrigin: () => origin, containerPointToLayerPoint: point => point,
  latLngToLayerPoint: ll => L.CRS.EPSG3857.latLngToPoint(ll, zoom).round().subtract(origin),
};
origin = geographicMap.project(centre, zoom).subtract(size.divideBy(2)).round();
const renderer = L.svg({padding: 0.1}); renderer._map = geographicMap; renderer._initContainer();
renderer.on("update", renderer._updatePaths, renderer);
const polygon = L.polygon([[9.49,155.75],[9.49,155.93],[9.6,155.93],[9.6,155.75]], {noClip: true, smoothFactor: 0});
polygon._map = geographicMap; polygon._renderer = renderer; renderer._initPath(polygon); renderer._reset();
boundaryGroup.paths.splice(0, boundaryGroup.paths.length, polygon);
groups.splice(1); present.clear(); present.add(boundaryGroup);
for (const nextZoom of [11, 13, 10, 12, 9]) {
  zoom = nextZoom; centre.lng += 0.001;
  origin = geographicMap.project(centre, zoom).subtract(size.divideBy(2)).round();
  context.scheduleMapHighlightProjection({type: "zoomend"});
  context.scheduleMapHighlightProjection({type: "resize"});
  frames.shift()();
  const point = geographicMap.latLngToLayerPoint(polygon.getLatLngs()[0][0]);
  assert.ok(polygon.getElement().attributes.d.startsWith(`M${point.x} ${point.y}`), "SVG path is repainted at the current geographic projection");
  assert.equal(renderer._zoom, zoom);
  assert.ok(renderer._container.style.transform.endsWith("scale(1)"), "no old zoom transform remains on the retained highlight");
}
console.log("Highlights passed: geographic geometry, native camera reuse, late selection, panel visibility, style reload, hit-testing, cleanup and retained SVG projection.");

// Fractional native zooms can round back to the unchanged retained Leaflet
// view. A no-op setView must still hand the basemap camera back explicitly.
const retainedCenter = {lat: 14.63, lng: 152.96};
let nativeCamera = {zoom: 11.179, center: {...retainedCenter}, pitch: 48, bearing: 28}, setViews = 0;
const nativeMap = {getCenter: () => nativeCamera.center, getZoom: () => nativeCamera.zoom, stop() {},
  jumpTo(options) {nativeCamera = {...nativeCamera, ...options};}};
const noop = () => {};
const exitContext = vm.createContext({vectorPerspectiveActive: true, vectorPerspectiveMap: nativeMap,
  map: {setView() {setViews++;}, getZoom: () => 12, getCenter: () => retainedCenter},
  mapViewMode: "normal", elements: {appShell: {classList: {remove: noop}}},
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  syncVectorCameraControls: noop, syncVectorCameraFromMap: noop, handleVectorPerspectiveMoveEnd: noop,
  removeVectorTransitOverlay: noop, removeVectorHighlightOverlay: noop, setMaplibrePerspectiveInteraction: noop,
  syncHuayuCityWallPerspectiveLayers: noop, syncHuayuWallPerspectiveLayers: noop, syncHuayuElevatedGreenLayers: noop,
  syncHuayuTerrainPerspective: noop, restoreLeafletPerspectiveInteraction: noop, showToast: noop,
});
vm.runInContext(app.match(/  function exitVectorPerspectiveMode\([^]*?\n  \}/u)[0], exitContext);
exitContext.exitVectorPerspectiveMode({silent: true});
assert.equal(setViews, 1);
assert.equal(nativeCamera.zoom, 11, "native basemap must match Leaflet even if setView emits no camera event");
assert.deepEqual(Array.from(nativeCamera.center), [retainedCenter.lng, retainedCenter.lat]);
assert.equal(nativeCamera.pitch, 0); assert.equal(nativeCamera.bearing, 0);
console.log("Camera handoff passed: fractional native zoom cannot leave the overhead basemap at a different scale.");
