import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import fs from "node:fs";
import vm from "node:vm";
import {road, simpleBridge, reviewFixtures} from "./bridge-fixtures.mjs";

const source = await readFile(new URL("../site/bridge-models.js", import.meta.url), "utf8");
const context = vm.createContext({console, setTimeout, clearTimeout});
vm.runInContext(source, context);
const bridges = context.HuayuBridgeModels;
const plain = value => JSON.parse(JSON.stringify(value));
const prepare = features => bridges.prepare(plain(features));
const mesh = (prepared, terrain) => bridges.geometry(prepared,
  prepared.plans.map(plan => plan.samples.map((sample, i) => terrain?.(sample, i, plan) ?? 0)));
let cases = 0;
function check(name, fn) { fn(); cases++; console.log(`passed: ${name}`); }

check("bridge preference defaults off, persists explicit choices and resets safely", () => {
  const storage=new Map(),events=[];
  const load=()=>{const c=vm.createContext({setTimeout,clearTimeout,
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},dispatchEvent:event=>events.push(event)});
    vm.runInContext(source,c);return c;};
  const c=load(),api=c.HuayuBridgeModels;
  assert.equal(api.getPreferences().enabled,false);
  api.setPreferences({enabled:true});assert.equal(load().HuayuBridgeModels.getPreferences().enabled,true);
  assert.equal(events.at(-1).type,"huayu-bridge-settings-change");assert.equal(events.at(-1).detail.saved,true);
  api.setPreferences(api.DEFAULTS);assert.equal(load().HuayuBridgeModels.getPreferences().enabled,false);
  storage.set(api.STORAGE_KEY,'{"enabled":"true"}');assert.equal(load().HuayuBridgeModels.getPreferences().enabled,false);
  storage.set(api.STORAGE_KEY,'broken');assert.equal(load().HuayuBridgeModels.getPreferences().enabled,false);
  c.localStorage.setItem=()=>{throw Error("denied");};
  assert.equal(api.setPreferences({enabled:true}),false);assert.equal(api.getPreferences().enabled,true);
  assert.equal(events.at(-1).detail.saved,false);
  api.setPreferences(api.DEFAULTS);assert.equal(api.getPreferences().enabled,false);
});

check("disabled bridge setting avoids modeling and regional bridge requests, including preview links", () => {
  const app=fs.readFileSync(new URL("../site/app.js",import.meta.url),"utf8");
  const extract=name=>{const start=app.indexOf(`  function ${name}(`);return app.slice(start,app.indexOf("\n  function ",start+1));};
  let enabled=false,syncs=0,disposals=0;
  const model={getPreferences:()=>({enabled}),dispose(){disposals++;},sync(map,features,options){syncs++;assert.equal(options.enabled,true);}};
  const map={getStyle:()=>({layers:[{}]}),getZoom:()=>11},state={active:true,primaryActive:true,groundRenderFeatures:[]};
  const c=vm.createContext({window:{HuayuBridgeModels:model},huayuLiveBasemapStates:new Map([[map,state]]),
    huayuOverlayPalette:()=>({}),HUAYU_LIVE_BASEMAP_MIN_ZOOM:12.5,HUAYU_ROAD_OVERVIEW_MIN_ZOOM:10.5,
    HUAYU_ROAD_OVERVIEW_MIN_TILE_ZOOM:11,HUAYU_LIVE_BASEMAP_MIN_TILE_ZOOM:13,HUAYU_LIVE_BASEMAP_MAX_TILE_ZOOM:15,
    LOCAL_BRIDGE_PREVIEW:true,bridgePreviewPaused:false,HUAYU_LIVE_BASEMAP_LAYERS:{road:"road",roadCasing:"case"},
    observeHuayuMapGestures(){},updateHuayuBridgePreviewStatus(){},clamp:(n,a,b)=>Math.max(a,Math.min(n,b)),map,state});
  vm.runInContext(["bridgeModelsEnabled","huayuLiveBasemapMinimumZoom","huayuLiveBasemapTileZoom","syncHuayuBridgeModels"].map(extract).join("\n"),c);
  vm.runInContext("syncHuayuBridgeModels(map,state);minimum=huayuLiveBasemapMinimumZoom();tileZoom=huayuLiveBasemapTileZoom(map);",c);
  assert.equal(syncs,0);assert.equal(disposals,1);assert.equal(c.minimum,12.5);assert.equal(c.tileZoom,13);
  enabled=true;vm.runInContext("syncHuayuBridgeModels(map,state);minimum=huayuLiveBasemapMinimumZoom();tileZoom=huayuLiveBasemapTileZoom(map);",c);
  assert.equal(syncs,1);assert.equal(c.minimum,10.5);assert.equal(c.tileZoom,11);
  enabled=false;vm.runInContext("syncHuayuBridgeModels(map,state);",c);assert.equal(syncs,1);assert.equal(disposals,2);
});

check("worker starts from loaded code and exactly matches the main algorithm", () => {
  const messages = [], worker = vm.createContext({self: {postMessage: message => messages.push(message)}});
  const program = bridges.workerSource();
  vm.runInContext(program, worker);
  worker.self.onmessage({data: {id: 1, action: "prepare", features: plain(reviewFixtures)}});
  assert.equal(messages[0].error, undefined);
  const prepared = messages[0].result;
  assert.deepEqual(plain(prepared), plain(prepare(reviewFixtures)));
  worker.self.onmessage({data: {id: 2, action: "geometry", prepared,
    elevations: prepared.plans.map(plan => plan.samples.map(() => 0))}});
  assert.equal(messages[1].error, undefined);
  assert.deepEqual([...messages[1].result.positions], [...mesh(prepared).positions]);
  assert.deepEqual(plain(messages[1].result.hideIds), plain(mesh(prepared).hideIds));
});

check("100 m selects slopes instead of excluding roads; ways still aggregate", () => {
  for (const length of [9, 49, 80, 100]) {
    const result = mesh(prepare(simpleBridge(length)));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].kind, "slopes");
    assert.ok(result.accepted[0].maxGrade <= bridges.RULES.maxGrade);
    assert.ok(result.hideIds.includes("b"));
  }
  const fixtures = simpleBridge(240);
  fixtures.splice(1, 1, road("b-1", [[0, 0], [70, 0]], {bridge: 1, layer: 1}),
    road("b-2", [[70, 0], [140, 0]], {bridge: 1, layer: 1}),
    road("b-3", [[140, 0], [240, 0]], {bridge: 1, layer: 1}));
  const result = prepare(fixtures);
  assert.equal(result.plans.length, 1);
  assert.ok(Math.abs(result.plans[0].length - 240) < 0.01);
  assert.deepEqual(plain(mesh(result).hideIds), ["b-1", "b-2", "b-3", "b-left", "b-right"]);
});

check("same-layer short bridge has a smooth arch and exact joins", () => {
  const result = mesh(prepare(simpleBridge(240)));
  assert.equal(result.accepted.length, 1);
  const plan = result.accepted[0];
  assert.equal(plan.kind, "arch");
  assert.deepEqual(plain(plan.approachLengths), [100, 100]);
  assert.ok(Math.max(...plan.heights) > 5);
  assert.ok(Math.abs(plan.heights[0] - 0.045) < 1e-6);
  assert.ok(Math.abs(plan.heights.at(-1) - 0.045) < 1e-6);
  assert.ok(plan.maxGrade < 0.06);
  assert.ok(Math.abs(plan.heights[1] - plan.heights[0]) / (plan.samples[1].s - plan.samples[0].s) < 0.005);
});

check("350 m boundary, long bridges have an actual flat central deck", () => {
  assert.equal(prepare(simpleBridge(350)).plans[0].kind, "arch");
  const result = mesh(prepare(simpleBridge(600)));
  const plan = result.accepted[0];
  assert.equal(plan.kind, "plateau");
  const middle = plan.samples.filter(sample => sample.s > plan.rampLengths[0] + 1
    && sample.s < plan.samples.at(-1).s - plan.rampLengths[1] - 1);
  assert.ok(middle.length > 20);
  assert.ok(middle.every(sample => Math.abs(sample.height - 5) < 1e-7));
  assert.ok(plan.maxGrade <= bridges.RULES.maxGrade);
});

check("different-layer short connection is monotonic with no invented hump", () => {
  const result = mesh(prepare(simpleBridge(180, {end: 1})));
  const plan = result.accepted.find(plan => plan.ids.includes("b"));
  assert.equal(plan.kind, "incline");
  assert.ok(plan.heights.every((z, i) => !i || z >= plan.heights[i - 1]));
  assert.ok(Math.abs(plan.heights.at(-1) - 5.045) < 1e-6);
  assert.ok(plan.maxGrade <= 0.08);
});

check("short available approaches generate slopes without crossing ground junctions", () => {
  assert.equal(mesh(prepare(simpleBridge(240, {approach: 49}))).accepted.length, 1);
  assert.equal(prepare(simpleBridge(240, {approach: 50})).plans.length, 1);
  const split = simpleBridge(240);
  split.splice(0, 1, road("b-left-a", [[-160, 0], [-70, 0]]), road("b-left-b", [[-70, 0], [0, 0]]));
  assert.equal(prepare(split).plans[0].approachLengths[0], 100);
  const junction = simpleBridge(240);
  junction.push(road("side-road", [[-160, 0], [-160, 200]]));
  assert.ok(prepare(junction).plans[0].approachLengths[0] <= 100);
  const closeJunction = simpleBridge(240, {approach: 40});
  closeJunction.push(road("branch", [[-40, 0], [-40, 100]]));
  assert.equal(mesh(prepare(closeJunction)).accepted.length, 1);
  assert.ok(prepare(closeJunction).plans[0].approachLengths.some(length => length <= 40.01));
  const short = mesh(prepare(simpleBridge(101, {layer: 4, approach: 50})));
  assert.equal(short.accepted.length, 1);
  assert.ok(short.accepted[0].maxGrade <= 0.08);
});

check("two close bridges partition their shared approach without overlap", () => {
  const fixtures = [road("a-left", [[-160, 0], [0, 0]]),
    road("a", [[0, 0], [200, 0]], {bridge: 1, layer: 1}),
    road("shared", [[200, 0], [350, 0]]),
    road("b", [[350, 0], [550, 0]], {bridge: 1, layer: 1}),
    road("b-right", [[550, 0], [710, 0]])];
  const plans = prepare(fixtures).plans;
  assert.equal(plans.length, 2);
  assert.ok(plans.every(plan => plan.approachLengths.some(length => Math.abs(length - 75) < 0.01)));
  assert.deepEqual(plain(plans[0].samples.at(-1).coordinate), plain(plans[1].samples[0].coordinate));
});

check("shared node IDs, interior junctions and planar crossings are distinct", () => {
  const fixtures = simpleBridge(240);
  fixtures.push(road("under", [[120, -100], [120, 0], [120, 100]], {}, ["u1", "u2", "u3"]));
  assert.equal(prepare(fixtures).plans.length, 1);
  const nonConnected = simpleBridge(240);
  nonConnected[0].properties.roadNodes = ["a1", "a2"];
  const isolated = mesh(prepare(nonConnected)).accepted[0];
  assert.equal(isolated.approachLengths[0], 0, "coincident separate OSM nodes must not be joined");
  assert.ok(!isolated.parts.some(part => part.id === "b-left"));
  assert.ok(isolated.heights[0] >= 5, "an unknown continuation cannot be invented as a ground landing");
  const sameLayerJunction = mesh(prepare(reviewFixtures));
  assert.equal(sameLayerJunction.joined, 1, "a Y junction needs a filled deck connection as well as matching heights");
  const branches = sameLayerJunction.accepted.filter(plan => plan.ids.some(id => id.startsWith("junction-")));
  assert.equal(branches.length, 3);
  const junctionHeights = branches.flatMap(plan => plan.samples.map((sample, i) => ({sample, z: plan.heights[i]})))
    .filter(({sample}) => sample.coordinate[0] === road("x", [[300, -230], [301, -230]]).geometry.coordinates[0][0]
      && sample.coordinate[1] === road("x", [[300, -230], [301, -230]]).geometry.coordinates[0][1]);
  assert.equal(junctionHeights.length, 3);
  assert.ok(junctionHeights.every(({z}) => Math.abs(z - 5.045) < 1e-6));
});

check("different elevated layers share one anchor and do not duplicate ramps", () => {
  const fixtures = [road("left", [[-160, 0], [0, 0]]),
    road("level-1", [[0, 0], [300, 0]], {bridge: 1, layer: 1}),
    road("level-2", [[300, 0], [700, 0]], {bridge: 1, layer: 2}),
    road("right", [[700, 0], [900, 0]])];
  const plans = mesh(prepare(fixtures)).accepted;
  assert.equal(plans.length, 2);
  assert.equal(plans[0].approachLengths[1], 0);
  assert.equal(plans[1].approachLengths[0], 0);
  assert.ok(Math.abs(plans[0].heights.at(-1) - plans[1].heights[0]) < 1e-6);
});

check("viewport edges keep loaded elevated neighbors without selecting unrelated bridges", () => {
  const fixtures = [road("left", [[-160, 0], [0, 0]]),
    road("level-1", [[0, 0], [300, 0]], {bridge: 1, layer: 1}),
    road("level-2", [[300, 0], [700, 0]], {bridge: 1, layer: 2}),
    road("right", [[700, 0], [900, 0]]), ...simpleBridge(240, {y: 2000, id: "outside"})];
  const point = fixtures[1].geometry.coordinates[0];
  const prepared = bridges.prepare(plain(fixtures), {west: point[0] - 0.00001, east: point[0] + 0.0001,
    south: point[1] - 0.0001, north: point[1] + 0.0001});
  const result = mesh(prepared);
  assert.deepEqual(plain(result.accepted.flatMap(plan => plan.ids)), ["level-1", "level-2"]);
  assert.ok(!result.hideIds.some(id => id.startsWith("outside")));
  assert.ok(!prepared.sourceRoads.some(feature => feature.properties.osmId.startsWith("outside")),
    "unused roads need not be cloned to and from the geometry worker");
});

check("short layered roads, closed elevated rings and unmarked viaducts all render", () => {
  const fixtures = [road("loop", [[0, 0], [70, 0], [70, 70], [0, 70], [0, 0]], {layer: 2}),
    road("short-high", [[250, 0], [280, 0]], {layer: 3}),
    road("unmarked", [[300, 300], [600, 300]], {layer: 1})];
  const result = mesh(prepare(fixtures));
  assert.deepEqual(plain(result.hideIds), ["loop", "short-high", "unmarked"]);
  assert.equal(result.rejected.length, 0);
  assert.ok(result.accepted.every(p => p.maxGrade <= 0.08));
  assert.ok(result.positions.every(Number.isFinite));
});

check("wide views retain more than 128 bridges with lighter geometry and matching styles", () => {
  const fixtures = Array.from({length: 180}, (_, i) => simpleBridge(80, {y: i * 250, id: `wide-${i}`})).flat();
  const p = bridges.prepare(plain(fixtures), undefined, 13), result = bridges.geometry(p,
    p.plans.map(p => p.samples.map(() => 0)), false, {zoom: 13, casingWidth: 2, surfaceWidth: 1.5});
  assert.equal(result.accepted.filter(p => p.level > 0).length, 180);
  assert.equal(result.rejected.length, 0);
  assert.ok(result.positions.length / 9 <= bridges.RULES.maxTriangles);
  assert.ok(p.plans.reduce((n, p) => n + p.samples.length, 0) <= bridges.RULES.maxSamples);
  const latitude = p.plans[0].samples[0].coordinate[1], meters = 40075016.68557849 * Math.cos(latitude * Math.PI / 180) / (512 * 2 ** 13);
  const xs = [...result.positions.slice(0, 9)];
  assert.ok(Math.hypot(xs[0] - xs[3], xs[1] - xs[4]) >= meters * 1.9,
    "a distant deck must remain as readable as the original styled road");
});

check("ground forks carry all branches down gradually instead of pinning a ramp to zero", () => {
  const fixtures = [road("bridge", [[0, 0], [25, 0], [80, 0]], {layer: 1, bridge: 1}),
    road("west", [[-120, 0], [0, 0]]), road("east", [[80, 0], [95, 0]]),
    road("east-a", [[95, 0], [200, 50]]), road("east-b", [[95, 0], [200, -50]]),
    road("under", [[75, -100], [75, 100]], {}, ["under-a", "under-b"])];
  const result = mesh(prepare(fixtures)), bridge = result.accepted.find(p => p.ids.includes("bridge"));
  assert.ok(bridge, "a nearby fork is not a reason to remove the bridge");
  assert.equal(result.rejected.length, 0);
  assert.ok(result.accepted.every(p => p.maxGrade <= 0.08));
  const junction = result.accepted.flatMap(p => p.samples.map((s, i) => ({s, z: p.heights[i]})))
    .filter(({s}) => s.heightKey === "node:95:0");
  assert.equal(junction.length, 3);
  assert.ok(junction.every(({z}) => Math.abs(z - junction[0].z) < 1e-6));
  assert.ok(junction[0].z > 0.1);
});

check("crossing clearance uses the actual lower deck and survives coarse sampling", () => {
  const fixtures = [...simpleBridge(180, {layer: 2}),
    road("lower", [[90, -200], [90, 200]], {layer: 1}, ["lower-a", "lower-b"])];
  for (const zoom of [13, 18]) {
    const p = bridges.prepare(plain(fixtures), undefined, zoom), result = bridges.geometry(p,
      p.plans.map(p => p.samples.map(() => 0)), false, {zoom});
    const upper = result.accepted.find(p => p.ids.includes("b")), lower = result.accepted.find(p => p.ids.includes("lower"));
    assert.ok(upper && lower);
    const index = upper.samples.findIndex(s => s.crossing?.roadId === "lower");
    const lowerIndex = lower.samples.findIndex(s => s.heightKey === upper.samples[index].crossing.lowerKey);
    assert.ok(upper.heights[index] - lower.heights[lowerIndex] >= 2.5 - 1e-6);
    assert.ok(upper.maxGrade <= 0.08 && lower.maxGrade <= 0.08);
  }
});

check("different layers continuing through a shared interior node stay grade separated", () => {
  const fixtures = [road("upper", [[-150, 0], [0, 0], [150, 0]], {layer: 2}),
    road("lower", [[0, -150], [0, 0], [0, 150]], {layer: 1})];
  const result = mesh(prepare(fixtures));
  assert.equal(result.rejected.length, 0);
  const upper = result.accepted.find(p => p.ids.includes("upper")), lower = result.accepted.find(p => p.ids.includes("lower"));
  assert.ok(upper.heights.every(z => Math.abs(z - 10.045) < 1e-6));
  assert.ok(lower.heights.every(z => Math.abs(z - 5.045) < 1e-6));
  assert.equal(result.joined, 0, "an interior crossing must not become an interchange ramp");
});

check("overview tile selection, query parity and preview camera preserve broad coverage", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const extract = name => { const start = app.indexOf(`  function ${name}(`); return app.slice(start, app.indexOf("\n  function ", start + 1)); };
  const bounds = {west:148, east:149, south:12, north:13}, tile = {z:13,x:1,y:1};
  let tileCounts={13:49,14:196,15:196};
  let tileZoom = 15;
  const c = vm.createContext({huayuLiveBasemapTileZoom: () => tileZoom, HUAYU_LIVE_BASEMAP_SNAPSHOT_MAX_TILE_ZOOM:14,
    HUAYU_LIVE_BASEMAP_MIN_TILE_ZOOM:13, HUAYU_LIVE_BASEMAP_MAX_VISIBLE_TILES:64,
    HUAYU_ROAD_OVERVIEW_MIN_TILE_ZOOM:11,
    HUAYU_LIVE_BASEMAP_TILE_CACHE_LIMIT:72,
    huayuLiveBuildingVisibleTiles: (bounds,z) => Array.from({length:tileCounts[z]},(_,i)=>({key:`${z}/${i}`})),
    huayuLiveBuildingTileBounds: () => bounds, bounds, tile});
  vm.runInContext(`${extract("huayuLiveBasemapViewTiles")}\n${extract("huayuLiveBasemapTileQuery")}\nresult=huayuLiveBasemapViewTiles(null,bounds);query=huayuLiveBasemapTileQuery(tile);`, c);
  assert.equal(c.result.snapshotTiles.length,49);assert.equal(c.result.detailTiles.length,0);
  tileCounts={13:49,14:25,15:64};
  vm.runInContext("result=huayuLiveBasemapViewTiles(null,bounds);",c);
  assert.equal(c.result.snapshotTiles.length,25);assert.equal(c.result.detailTiles.length,0,
    "overview plus detail must fit the existing 72-tile cache together");
  assert.ok(c.query.includes('way["highway"]["layer"](') && c.query.includes('way["highway"]["bridge"]'));
  const worker = fs.readFileSync(new URL("../site/_worker.js", import.meta.url),"utf8");
  const start = worker.indexOf("function liveBasemapOverpassQuery(");
  vm.runInContext(`${worker.slice(start,worker.indexOf("\nfunction ",start+1))}\nworkerQuery=liveBasemapOverpassQuery(bounds,13);`,c);
  assert.equal(c.query,c.workerQuery,"browser fallback and Worker must request the same regional roads");
  for (const zoom of [11, 12]) {
    c.tile = {z:zoom}; tileZoom = zoom; tileCounts = {11:16,12:64};
    vm.runInContext("query=huayuLiveBasemapTileQuery(tile);workerQuery=liveBasemapOverpassQuery(bounds,tile.z);result=huayuLiveBasemapViewTiles(null,bounds);",c);
    assert.equal(c.query,c.workerQuery);
    assert.ok(c.query.includes('way(bn.roadNodes)["highway"]'), "overview must include true connected approaches");
    assert.ok(!c.query.includes('basemapRelations') && !c.query.includes('basemapTrees'), "regional views cannot request near-view land and models");
    assert.equal(c.result.snapshotTiles.length,tileCounts[zoom]);assert.equal(c.result.detailTiles.length,0);
  }
  for(const zoom of [13,15,18]) {
    let camera;const current={getCenter:()=>({lng:148.4,lat:12.5}),getZoom:()=>zoom};
    const cameraContext=vm.createContext({currentVectorBasemap:()=>current,selectedBasemapId:"huayu",
      enterVectorPerspectiveMode:(pitch,bearing,options)=>{camera={pitch,bearing,...options};}});
    vm.runInContext(`${extract("inspectHuayuBridgePreview")}\ninspectHuayuBridgePreview();`,cameraContext);
    assert.equal(camera.zoom,zoom,"entering bridge preview cannot force a close zoom");
    assert.deepEqual(plain(camera.center),[148.4,12.5]);
  }
});

check("local diagnostic panel is opt-in while default preview keeps the camera", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const start=app.indexOf("  function initializeHuayuBridgePreview(");
  const source=app.slice(start,app.indexOf("\n  function ",start+1));
  let tilted=0,scheduled,enabled=false;
  const current={};const state={active:true};
  const context=vm.createContext({LOCAL_BRIDGE_PREVIEW:true,LOCAL_BRIDGE_DEBUG:false,
    bridgeModelsEnabled:()=>enabled,
    bridgePreviewPanel:null,bridgePreviewStarted:false,currentVectorBasemap:()=>current,
    document:{createElement(){throw new Error("default preview must not create a panel");}},
    window:{setTimeout(fn){scheduled=fn;return 1;}},inspectHuayuBridgePreview(){tilted++;},current,state});
  vm.runInContext(`${source}\ninitializeHuayuBridgePreview(current,state);`,context);
  assert.equal(scheduled,undefined,"local preview cannot override the default-off setting");
  enabled=true;vm.runInContext("initializeHuayuBridgePreview(current,state);",context);
  scheduled();assert.equal(tilted,1);assert.equal(context.bridgePreviewPanel,null);
});

check("regional road ownership preserves original land, water and rail and restores all on fallback", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const start=app.indexOf("  function syncHuayuLiveBasemapPrimaryLayers(");
  const source=app.slice(start,app.indexOf("\n  function ",start+1));
  const ids=["highway-primary","bridge-primary","water","landcover-wood","railway"];
  const visibility=new Map(ids.map(id=>[id,"visible"]));let zoom=11.5;
  const map={getZoom:()=>zoom,getLayer:()=>true,getLayoutProperty:id=>visibility.get(id),
    setLayoutProperty:(id,key,value)=>visibility.set(id,value)};
  const state={publishedLayerVisibility:new Map(),roadOverview:true};
  const context=vm.createContext({HUAYU_LIVE_BASEMAP_PRIMARY_VECTOR_LAYERS:ids,HUAYU_LIVE_BASEMAP_MIN_ZOOM:12.5,
    window:{},syncHuayuSportsSnapshotLayers(){},map,state});
  vm.runInContext(`${source}\nsyncHuayuLiveBasemapPrimaryLayers(map,state,true);`,context);
  assert.equal(visibility.get("highway-primary"),"none");assert.equal(visibility.get("bridge-primary"),"none");
  for(const id of ids.slice(2))assert.equal(visibility.get(id),"visible");
  zoom=15;vm.runInContext("syncHuayuLiveBasemapPrimaryLayers(map,state,true);",context);
  assert.equal(visibility.get("water"),"visible","a retained road-only tier cannot hide water when zooming in");
  state.roadOverview=false;vm.runInContext("syncHuayuLiveBasemapPrimaryLayers(map,state,true);",context);
  assert.ok(ids.every(id=>visibility.get(id)==="none"));
  vm.runInContext("syncHuayuLiveBasemapPrimaryLayers(map,state,false);",context);
  assert.ok(ids.every(id=>visibility.get(id)==="visible"));
});

check("missing topology, tunnel, invalid data, duplicate tiles and reversed ways", () => {
  const fixtures = simpleBridge(240), original = JSON.stringify(fixtures);
  const baseline = mesh(prepare(fixtures));
  const reversed = plain(fixtures).reverse();
  for (const feature of reversed) { feature.geometry.coordinates.reverse(); feature.properties.roadNodes.reverse(); }
  const second = mesh(prepare(reversed));
  assert.equal(second.accepted.length, baseline.accepted.length);
  const samples = result => result.accepted.flatMap(plan => plan.samples.map((sample, i) =>
    `${sample.coordinate.map(value => value.toFixed(7))}:${plan.heights[i].toFixed(4)}`)).sort();
  assert.deepEqual(samples(second), samples(baseline));
  assert.equal(mesh(prepare([...fixtures, ...fixtures])).accepted.length, 1);
  assert.equal(JSON.stringify(fixtures), original, "the rendering plan must never mutate original map data");
  const missing = plain(fixtures); delete missing[1].properties.roadNodes;
  assert.equal(prepare(missing).plans.length, 0);
  assert.equal(mesh(prepare(missing)).inventory.missingTopology, 1);
  const tunnel = plain(fixtures); tunnel[1].properties.tunnel = 1;
  assert.equal(prepare(tunnel).plans.length, 0);
  const invalid = plain(fixtures); invalid[1].geometry.coordinates[1][0] = NaN;
  assert.equal(prepare(invalid).plans.length, 0);
});

check("terrain uses real endpoints and rejects buried or excessively steep decks", () => {
  const prepared = prepare(simpleBridge(240));
  const elevated = mesh(prepared, () => 30);
  assert.ok(Math.abs(elevated.accepted[0].heights[0] - 30.045) < 1e-6);
  assert.ok(Math.max(...elevated.accepted[0].heights) > 35);
  const steep = mesh(prepared, sample => sample.s / 2);
  assert.equal(steep.accepted.length, 0);
  assert.equal(steep.hideIds.length, 0);
  const buried = mesh(prepared, (sample, i, plan) => i > 5 && i < plan.samples.length - 5 ? 60 : 0);
  assert.equal(buried.accepted.length, 0);
  const absent = bridges.geometry(prepared, [prepared.plans[0].samples.map(() => null)]);
  assert.equal(absent.accepted.length, 0);
});

check("bridge and lower road retain real clearance instead of an intersecting deck", () => {
  const fixtures = simpleBridge(240);
  fixtures.push(road("under", [[120, -100], [120, 100]], {}, ["under-1", "under-2"]));
  const valid = mesh(prepare(fixtures));
  assert.equal(valid.accepted.length, 1);
  assert.ok(valid.accepted[0].samples.some(sample => sample.crossingLevel === 0));
  const highLowerRoad = plain(fixtures); highLowerRoad.at(-1).properties.layer = 0.8;
  const conflict = mesh(prepare(highLowerRoad));
  const upper = conflict.accepted.find(plan => plan.ids.includes("b"));
  assert.ok(upper, "the height solver should raise a feasible crossing instead of discarding it");
  assert.ok(upper.samples.some((s, i) => s.crossing && upper.heights[i] >= 6.5));
  assert.ok(upper.maxGrade <= 0.08);
});

check("geometry is finite, within budget, correctly sized and avoids piers on roads", () => {
  const prepared = prepare(reviewFixtures), result = mesh(prepared);
  assert.ok(result.positions.every(Number.isFinite));
  assert.equal(result.positions.length, result.colors.length);
  assert.equal(result.positions.length % 9, 0);
  assert.ok(result.positions.length / 9 <= bridges.RULES.maxTriangles);
  const arch = prepared.plans.find(plan => plan.ids.includes("arch"));
  assert.ok(arch.samples.some(sample => sample.pier));
  const x = road("p", [[120, 450], [121, 450]]).geometry.coordinates[0][0];
  assert.ok(arch.samples.filter(sample => Math.abs(sample.coordinate[0] - x) * 111320 < 10)
    .every(sample => !sample.pier));
  assert.equal(bridges.roadWidth({width: "12 m"}), 12);
  assert.equal(bridges.roadWidth({lanes: "2"}), 7.3);
  assert.equal(bridges.roadWidth({highway: "footway"}), 3);
});

check("approach cuts preserve the exact unmodeled portions and underpass", () => {
  const fixtures = simpleBridge(240), original = JSON.stringify(fixtures);
  fixtures.push(road("under", [[120, -100], [120, 100]], {}, ["under-a", "under-b"]));
  const result = mesh(prepare(fixtures));
  assert.deepEqual(plain(result.hideIds), ["b", "b-left", "b-right"]);
  assert.equal(result.remainder.features.length, 2);
  const left = result.remainder.features.find(f => f.properties.osmId === "b-left").geometry.coordinates;
  const right = result.remainder.features.find(f => f.properties.osmId === "b-right").geometry.coordinates;
  const plan = result.accepted[0];
  assert.deepEqual(plain(left[0]), fixtures[0].geometry.coordinates[0]);
  assert.deepEqual(plain(right.at(-1)), fixtures[2].geometry.coordinates.at(-1));
  assert.deepEqual(plain(left.at(-1)), plain(plan.samples[0].coordinate));
  assert.deepEqual(plain(right[0]), plain(plan.samples.at(-1).coordinate));
  assert.equal(JSON.stringify(fixtures.slice(0, 3)), original);
  const two = [road("left", [[-160, 0], [0, 0]]),
    road("a", [[0, 0], [200, 0]], {bridge: 1, layer: 1}),
    road("shared", [[200, 0], [350, 0]]),
    road("b", [[350, 0], [550, 0]], {bridge: 1, layer: 1}), road("right", [[550, 0], [710, 0]])];
  assert.ok(!mesh(prepare(two)).remainder.features.some(f => f.properties.osmId === "shared"),
    "two approaches meeting at their ground anchor must remove the entire shared flat interval");
});

check("short elevated continuations join naturally; genuine terrain failure stays atomic", () => {
  const fixtures = [road("left", [[-160, 0], [0, 0]]),
    road("long", [[0, 0], [300, 0]], {bridge: 1, layer: 1}),
    road("short", [[300, 0], [380, 0]], {bridge: 1, layer: 1}),
    road("right", [[380, 0], [540, 0]]), ...simpleBridge(240, {id: "independent", y: 500})];
  // Force a genuine layer boundary so the 80 m continuation is a separate run.
  fixtures[2].properties.layer = 2;
  const result = mesh(prepare(fixtures));
  assert.equal(result.accepted.length, 3);
  const long = result.accepted.find(p => p.ids.includes("long")), short = result.accepted.find(p => p.ids.includes("short"));
  assert.ok(Math.abs(long.heights.at(-1) - short.heights[0]) < 1e-6);
  assert.ok(short.maxGrade <= 0.08);
  assert.ok(result.hideIds.includes("long") && result.hideIds.includes("short"));
  const terrain = [road("left", [[-160, 0], [0, 0]]),
    road("level-1", [[0, 0], [300, 0]], {bridge: 1, layer: 1}),
    road("level-2", [[300, 0], [700, 0]], {bridge: 1, layer: 2}), road("right", [[700, 0], [900, 0]])];
  const failed = mesh(prepare(terrain), (sample, i, plan) => plan.ids.includes("level-1") && i > 5 && i < 20 ? 60 : 0);
  assert.equal(failed.positions.length, 0);
  assert.equal(failed.hideIds.length, 0);
  assert.equal(failed.remainder.features.length, 0);
});

check("surface color follows actual road paint, including zoom and night colors", () => {
  const features = simpleBridge(240); features.forEach(f => { f.properties.featureClass = "motorway"; });
  const p = prepare(features), elevations = p.plans.map(plan => plan.samples.map(() => 0));
  const expression = color => ["interpolate", ["linear"], ["zoom"], 16,
    ["match", ["get", "featureClass"], "motorway", color, "#ffffff"], 20,
    ["match", ["get", "featureClass"], "motorway", color, "#edf1ef"]];
  const srgb = linear => linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  for (const [night, color] of [[false, "#f5c286"], [true, "#c8894d"]]) {
    const result = bridges.geometry(p, elevations, night, {zoom: 18, surfaceColor: expression(color),
      casingColor: "#a38364", surfaceWidth: 8, casingWidth: 12});
    const expected = [0, 2, 4].map(i => parseInt(color.slice(1 + i, 3 + i), 16));
    let found = false;
    for (let i = 0; i < result.colors.length; i += 3) {
      if (expected.every((value, channel) => Math.abs(srgb(result.colors[i + channel]) * 255 - value) < 0.01)) found = true;
    }
    assert.ok(found, `the rendered unlit bridge surface must retain ${color}`);
    // The first cross section is at ground level; its total width must match
    // the same map style, regardless of the wider physical bridge deck.
    const vertices = [...result.positions.slice(18, 27)];
    const width = Math.hypot(vertices[0] - vertices[6], vertices[1] - vertices[7]);
    const latitude = p.plans[0].samples[0].coordinate[1];
    const expectedWidth = 12 * 40075016.68557849 * Math.cos(latitude * Math.PI / 180) / (512 * 2 ** 18);
    assert.ok(Math.abs(width - expectedWidth) < 0.01);
  }
  const blended = bridges.styleValue(["interpolate", ["linear"], ["zoom"], 16, "#000000", 20, "#ffffff"], {}, 18);
  assert.deepEqual(plain(blended), [0.5, 0.5, 0.5]);
});

check("live road ownership includes all vector bridge road layers but keeps bridge railways", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const text = /const HUAYU_LIVE_BASEMAP_PRIMARY_VECTOR_LAYERS = (\[[\s\S]*?\]);/u.exec(app)[1];
  const owned = vm.runInNewContext(text);
  for (const filename of ["huayu-style.json", "huayu-night-style.json"]) {
    const style = JSON.parse(fs.readFileSync(new URL(`../site/${filename}`, import.meta.url), "utf8"));
    const bridgeRoads = style.layers.filter(layer => layer.id.startsWith("bridge-") && !layer.id.includes("railway"));
    assert.ok(bridgeRoads.length > 10);
    assert.ok(bridgeRoads.every(layer => owned.includes(layer.id)));
  }
  assert.ok(!owned.includes("bridge-railway"));
  const order = vm.runInNewContext(/const roadLayerOrder = (\[[\s\S]*?\]);/u.exec(app)[1]);
  const evaluate = (value, properties) => {
    if (!Array.isArray(value)) return value;
    if (value[0] === "get") return properties[value[1]];
    if (value[0] === "==") return evaluate(value[1], properties) === evaluate(value[2], properties);
    if (value[0] === "all") return value.slice(1).every(item => evaluate(item, properties));
    if (value[0] === "case") return evaluate(value[1], properties) ? evaluate(value[2], properties) : evaluate(value[3], properties);
    throw new Error(`Unknown sort expression ${value[0]}`);
  };
  for (const layer of [0, 1, 2, 3]) for (const bridge of [0, 1]) for (const explicit of [0, 1]) {
    const feature = road("order", [[0, 0], [200, 0]], {layer, bridge, layerExplicit: explicit});
    const effectiveLayer = bridges.graph([feature]).roads.get("order").level;
    assert.equal(evaluate(order, feature.properties), effectiveLayer,
      "original-road fallback must use the same layer ordering as the 3D topology, including implicit bridges");
  }
});

check("local bridge links follow the actual perspective camera and preserve the URL query", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const extract = name => {
    const start = app.indexOf(`  function ${name}(`);
    assert.ok(start >= 0);
    return app.slice(start, app.indexOf("\n  function ", start + 1));
  };
  const original = "http://127.0.0.1:4178/?preview=bridges&local=5#map=18/12.4899/148.3619";
  for (const local of [true, false]) {
    let currentUrl = new URL(original), writes = 0;
    const context = vm.createContext({LOCAL_BRIDGE_PREVIEW: local, vectorPerspectiveActive: true,
      vectorPerspectiveMap: {getCenter: () => ({lng: 148.412346, lat: 12.523456}), getZoom: () => 18},
      map: {getZoom: () => 17}, mapViewMode: "terrain",
      clamp: (value, low, high) => Math.max(low, Math.min(high, value)), roundCoordinate: value => Number(value.toFixed(5)),
      history: {replaceState(state, title, value) { writes++; currentUrl = new URL(value, currentUrl); }},
      syncHuayuCityWallPerspectiveLayers() {}, syncHuayuWallPerspectiveLayers() {},
      syncHuayuElevatedGreenLayers() {}, syncVectorTransitOverlay() {}});
    vm.runInContext(`${extract("writeHash")}\n${extract("handleVectorPerspectiveMoveEnd")}\nhandleVectorPerspectiveMoveEnd();`, context);
    assert.equal(writes, local ? 1 : 0);
    assert.equal(currentUrl.search, new URL(original).search);
    assert.equal(currentUrl.hash, local ? "#map=19/12.52346/148.41235" : new URL(original).hash);
    if (local) assert.equal(Number(currentUrl.hash.split("/")[0].slice(5)) - 1, 18,
      "the existing hash zoom must restore the native zoom using the original one-level conversion");
    context.vectorPerspectiveActive = false;
    vm.runInContext("handleVectorPerspectiveMoveEnd();", context);
    assert.equal(writes, local ? 1 : 0, "the retained perspective camera cannot overwrite an overhead location");
  }
});

check("camera, satellite and failures preserve original roads; cleanup removes listeners", () => {
  const listeners = new Map(), filters = new Map([["roads", ["==", ["get", "renderKind"], "road"]]]);
  const map = {on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); }, getStyle: () => ({layers: [{id: "roads", type: "line"}]}),
    getLayer: id => id === "roads", getPitch: () => 45, getZoom: () => 16, getBounds: () => ({getWest:()=>148,
      getEast:()=>149,getSouth:()=>12,getNorth:()=>13}), getFilter: id => filters.get(id),
    setFilter: (id, value) => filters.set(id, value), triggerRepaint() {}};
  let status;
  const options = {enabled: true, satellite: false, night: false, roadLayers: ["roads"],
    onStatus: value => { status = value; }};
  const controller = bridges.sync(map, simpleBridge(), options);
  controller.preparedBounds = {west: 148.3, east: 148.4, south: 12.3, north: 12.4};
  const revision = controller.revision; controller.dirty = true; controller.onCamera();
  assert.ok(controller.revision > revision, "a camera move invalidates an in-flight plan even while data is already dirty");
  controller.mesh = {geometry: {dispose() {}}, material: {dispose() {}}};
  controller.layer = {enabled: false}; controller.result = {accepted: [{}], rejected: [], hideIds: ["b"]};
  controller.show(true); assert.equal(controller.layer.enabled, true);
  assert.equal(status.state, "active");
  assert.equal(status.count, 1);
  assert.ok(JSON.stringify(filters.get("roads")).includes('"literal",["b"]'));
  map.getZoom = () => 11;
  controller.show(true);assert.equal(controller.layer.enabled,true,"regional zoom must retain valid bridge models");
  map.getZoom = () => 16;
  controller.update(controller.features, {...options, satellite: true});
  assert.equal(controller.layer.enabled, false);
  assert.equal(status.state, "satellite");
  assert.deepEqual(plain(filters.get("roads")), ["==", ["get", "renderKind"], "road"]);
  controller.update(controller.features, options); map.getPitch = () => 0; controller.onCamera();
  assert.equal(controller.layer.enabled, false);
  assert.equal(status.state, "overhead");
  map.getPitch = () => 58;
  controller.update(controller.features, {...options, enabled: false});
  assert.equal(status.state, "loading", "a retained planar road must not be reported as an active 3D model");
  controller.update(controller.features, {...options, enabled: false, paused: true});
  assert.equal(status.state, "paused");
  assert.equal(controller.layer.enabled, false);
  assert.deepEqual(plain(filters.get("roads")), ["==", ["get", "renderKind"], "road"],
    "comparison must restore the same source roads");
  controller.update(controller.features, options);
  controller.show(true);
  assert.equal(status.state, "active");
  assert.equal(controller.layer.enabled, true);
  bridges.dispose(map);
  assert.ok([...listeners.values()].every(set => set.size === 0));
});

await (async () => {
  const listeners = new Map(), layers = new Map(), sources = new Map();
  const base = ["==", ["get", "renderKind"], "road"];
  for (const id of ["casing", "surface"]) layers.set(id, {id, type: "line", source: "original", filter: plain(base),
    layout: {"line-cap": "round"}, paint: {"line-color": "#f5c286", "line-opacity": 1, "line-width": 10}});
  const map = {on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); }, fire(event) { for (const fn of [...(listeners.get(event) || [])]) fn({type: event}); },
    getStyle: () => ({layers: [...layers.values()]}), getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer), removeLayer: id => layers.delete(id),
    getSource: id => sources.get(id), addSource: (id, source) => sources.set(id, {...source, ready: false}),
    removeSource: id => sources.delete(id), isSourceLoaded: id => sources.get(id)?.ready,
    getFilter: id => layers.get(id).filter, setFilter: (id, filter) => { layers.get(id).filter = filter; },
    getLayoutProperty: (id, key) => layers.get(id).layout?.[key],
    setLayoutProperty: (id, key, value) => { layers.get(id).layout[key] = value; },
    getPaintProperty: (id, key) => layers.get(id).paint?.[key],
    setPaintProperty: (id, key, value) => { layers.get(id).paint[key] = value; },
    getPitch: () => 58, getZoom: () => 18, triggerRepaint() {}};
  const controller = bridges.sync(map, simpleBridge(), {enabled: true, satellite: false, roadLayers: ["casing", "surface"]});
  clearTimeout(controller.timer); controller.timer = null;
  const result = mesh(prepare(simpleBridge()));
  const pending = controller.prepareRemainder(result), entry = controller.pendingRemainder;
  assert.deepEqual(plain(map.getFilter("surface")), base, "loading a remainder cannot hide original roads yet");
  assert.ok(entry.layers.every(id => map.getPaintProperty(id, "line-opacity") === 0));
  map.fire("render"); sources.get(entry.source).ready = true; map.fire("sourcedata");
  controller.remainderLayers = await pending;
  controller.mesh = {geometry: {dispose() {}}, material: {dispose() {}}}; controller.result = result;
  controller.show(true);
  assert.ok(entry.layers.every(id => map.getLayoutProperty(id, "visibility") === "visible"
    && map.getPaintProperty(id, "line-opacity") === 1));
  assert.notDeepEqual(plain(map.getFilter("surface")), base);
  assert.equal(await controller.prepareRemainder(result), entry, "unchanged intervals reuse the ready source");
  map.setPaintProperty("surface", "line-color", "#c8894d");
  map.setPaintProperty("surface", "line-width", 12);
  controller.show(true);
  assert.equal(map.getPaintProperty(entry.layers[1], "line-color"), "#c8894d",
    "reusing the remainder must still follow changes to the original day/night road style");
  assert.equal(map.getPaintProperty(entry.layers[1], "line-width"), 12);
  controller.show(false);
  assert.deepEqual(plain(map.getFilter("surface")), base);
  assert.ok(entry.layers.every(id => map.getLayoutProperty(id, "visibility") === "none"));
  bridges.dispose(map);
  assert.equal(sources.size, 0); assert.equal(layers.size, 2);
  assert.ok([...listeners.values()].every(set => set.size === 0));
  cases++; console.log("passed: atomic remainder ownership, reuse, restoration and cleanup");
})();

function lifecycleMap() {
  const listeners = new Map(); let zoom = 18, height = 0;
  let bounds = {west: 148.35, east: 148.38, south: 12.49, north: 12.51};
  const filters = new Map([["roads", true]]);
  return {on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    getStyle: () => ({layers: [{id: "roads", type: "line"}]}), getLayer: id => id === "roads",
    getFilter: id => filters.get(id), setFilter: (id, value) => filters.set(id, value), triggerRepaint() {},
    getPitch: () => 58, getZoom: () => zoom, setZoom: value => { zoom = value; },
    getBounds: () => ({getWest: () => bounds.west, getEast: () => bounds.east,
      getSouth: () => bounds.south, getNorth: () => bounds.north}), setBounds: value => { bounds = value; },
    getTerrain: () => ({source: "dem"}), queryTerrainElevation: () => height, setHeight: value => { height = value; }};
}
function stubGraphics(controller) {
  clearTimeout(controller.timer); controller.timer = null; controller.schedule = () => {};
  controller.ensureLayer = async () => { controller.layer ||= {enabled: false}; };
  controller.prepareRemainder = async () => null;
  controller.build = () => { controller.mesh = {geometry: {dispose() {}}, material: {dispose() {}}}; };
}

await (async () => {
  const map = lifecycleMap(), features = simpleBridge(), options = {enabled: true, roadLayers: ["roads"]};
  const controller = bridges.sync(map, features, options), calls = [];
  stubGraphics(controller);
  controller.request = async (action, payload) => {
    calls.push(action);
    return action === "prepare" ? bridges.prepare(payload.features, payload.bounds)
      : bridges.geometry(payload.prepared, payload.elevations, payload.night, payload.style);
  };
  await controller.apply(); assert.equal(controller.layer.enabled, true);
  assert.equal(controller.result.accepted.length, 1);
  const revision = controller.revision;
  controller.update(plain(features).reverse(), options);
  for (let i = 0; i < 100; i++) { map.setZoom(18 + i * 1e-10); controller.onCamera(); }
  controller.onTerrain({sourceId: "dem"}); await controller.apply();
  assert.equal(controller.revision, revision);
  assert.deepEqual(calls, ["prepare", "geometry"], "identical data, camera and DEM events must reuse the complete bridge");
  map.setZoom(19); controller.onCamera(); await controller.apply();
  assert.deepEqual(calls, ["prepare", "geometry", "geometry"], "a meaningful style zoom updates only bridge geometry");
  map.setHeight(20); controller.onTerrain({sourceId: "dem"}); await controller.apply();
  assert.ok(Math.abs(controller.result.accepted[0].heights[0] - 20.045) < 1e-6);
  assert.equal(calls.filter(action => action === "prepare").length, 1);
  map.setBounds({west: 148.34, east: 148.38, south: 12.49, north: 12.51});
  controller.onCamera(); const movingRevision = controller.revision;
  for (let i = 0; i < 100; i++) controller.onCamera();
  assert.equal(controller.revision, movingRevision, "the same pending viewport must not repeatedly cancel its job");
  await controller.apply();
  const changed = plain(features); changed[1].properties.width = "12";
  controller.update(changed, options); await controller.apply();
  assert.equal(calls.filter(action => action === "prepare").length, 3, "real road or viewport changes invalidate topology");
  bridges.dispose(map);
  cases++; console.log("passed: unchanged roads, camera and terrain reuse models while real changes update them");
})();

await (async () => {
  const timers = new Map(); let timerId = 0;
  const retryContext = vm.createContext({console: {warn() {}},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }});
  vm.runInContext(source, retryContext);
  const library = retryContext.HuayuBridgeModels, map = lifecycleMap(); let status, fail = true;
  const controller = library.sync(map, simpleBridge(), {enabled: true, roadLayers: ["roads"], onStatus: value => { status = value; }});
  timers.clear(); controller.timer = null; stubGraphics(controller);
  controller.request = async (action, payload) => {
    if (fail) throw new Error("Transient worker failure");
    return action === "prepare" ? library.prepare(payload.features, payload.bounds)
      : library.geometry(payload.prepared, payload.elevations, payload.night, payload.style);
  };
  await controller.apply(); assert.equal(status.state, "failed"); assert.equal(map.getFilter("roads"), true);
  assert.equal(timers.size, 1);
  const retry = timers.get(controller.retryTimer); timers.clear(); fail = false; retry.fn();
  await controller.apply();
  assert.equal(status.state, "active"); assert.equal(controller.result.accepted.length, 1);
  fail = true; controller.retry(); await controller.apply();
  for (let i = 0; i < 2; i++) {
    const next = timers.get(controller.retryTimer); assert.ok(next); timers.clear(); next.fn(); await controller.apply();
  }
  assert.equal(timers.size, 0, "persistent failures must stop automatic retries after two attempts");
  fail = false; library.retry(map); await controller.apply(); assert.equal(status.state, "active");
  library.dispose(map); assert.equal(timers.size, 0);
  cases++; console.log("passed: transient failures recover, persistent failures stop retrying and manual retry works");
})();

await (async () => {
  const map = lifecycleMap(); let finish, builds = 0;
  const controller = bridges.sync(map, simpleBridge(), {enabled: true, roadLayers: ["roads"]});
  stubGraphics(controller);
  controller.build = () => { builds++; };
  controller.request = async (action, payload) => {
    if (action === "prepare") return bridges.prepare(payload.features, payload.bounds);
    const result = bridges.geometry(payload.prepared, payload.elevations, payload.night, payload.style);
    await new Promise(resolve => { finish = resolve; }); return result;
  };
  const pending = controller.apply();
  await new Promise(resolve => setTimeout(resolve, 0));
  map.setHeight(20); controller.onTerrain({sourceId: "dem"}); finish(); await pending;
  assert.equal(builds, 0, "a DEM change during computation must not install bridges with stale terrain anchors");
  assert.equal(controller.result, undefined); assert.equal(map.getFilter("roads"), true);
  controller.request = async (action, payload) => bridges.geometry(payload.prepared, payload.elevations, payload.night, payload.style);
  await controller.apply();
  assert.ok(Math.abs(controller.result.accepted[0].heights[0] - 20.045) < 1e-6);
  bridges.dispose(map);
  cases++; console.log("passed: late terrain updates cannot install bridges anchored to stale elevations");
})();

await (async () => {
  const map = lifecycleMap(), features = simpleBridge(), options = {enabled: true, roadLayers: ["roads"]};
  const controller = bridges.sync(map, features, options);
  stubGraphics(controller);
  const compute = (action, payload) => action === "prepare" ? bridges.prepare(payload.features, payload.bounds)
    : bridges.geometry(payload.prepared, payload.elevations, payload.night, payload.style);
  controller.request = async (action, payload) => compute(action, payload);
  await controller.apply(); const previous = controller.result; let finish;
  const changed = plain(features); changed[1].properties.width = "12";
  controller.update(changed, options);
  controller.request = async (action, payload) => {
    const result = compute(action, payload);
    if (action === "geometry") await new Promise(resolve => { finish = resolve; });
    return result;
  };
  const pending = controller.apply(); await new Promise(resolve => setTimeout(resolve, 0));
  controller.interacting = true; finish(); await pending;
  assert.equal(controller.result, previous, "dragging retains the previous complete result");
  controller.interacting = false; controller.request = async (action, payload) => compute(action, payload);
  await controller.apply();
  assert.notEqual(controller.result, previous, "after dragging ends the prepared update must finish, not remain stuck forever");
  assert.equal(controller.renderedPrepared, controller.prepared); assert.equal(controller.layer.enabled, true);
  bridges.dispose(map);
  cases++; console.log("passed: dragging during an update resumes the prepared bridge after interaction ends");
})();

console.log(JSON.stringify({status: "passed", cases, algorithm: bridges.ALGORITHM,
  fixtures: reviewFixtures.length, triangles: mesh(prepare(reviewFixtures)).positions.length / 9}));
