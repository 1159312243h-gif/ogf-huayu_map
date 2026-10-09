import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDatasetFile } from "./update-all-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const release = JSON.parse(await fs.readFile(path.join(root, "release.json"), "utf8"));

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

const manifestLines = (await fs.readFile(path.join(root, "release", "SHA256.txt"), "utf8"))
  .trim().split(/\r?\n/u).filter(Boolean);
const manifest = new Map(manifestLines.map((line) => {
  const match = line.match(/^([0-9A-F]{64})  (.+)$/u);
  assert.ok(match, `无效的 SHA-256 清单行：${line}`);
  return [match[2], match[1]];
}));

const files = await listFiles(site);
assert.equal(files.length, manifest.size, "生产文件数量与 SHA-256 清单不一致");
for (const file of files) {
  const relative = path.relative(site, file).split(path.sep).join("/");
  const actual = createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();
  assert.equal(actual, manifest.get(relative), `文件校验失败：${relative}`);
}

for (const required of ["_headers", "_worker.js", "app.js", "index.html", "huayu-style.json",
  "transit-preload.json", "transit-relations.json", "station-access.json", "railway-routing.json",
  "terrain-preload.json.gz"]) {
  assert.ok(manifest.has(required), `缺少生产文件：${required}`);
}

const index = await fs.readFile(path.join(site, "index.html"), "utf8");
const app = await fs.readFile(path.join(site, "app.js"), "utf8");
const terrainPreload = await readDatasetFile(path.join(site,"terrain-preload.json.gz"));
assert.equal(terrainPreload.schema,"open-small-mountains-v1");
assert.ok(terrainPreload.features.some((feature) => feature.properties?.reliefRole === "surface")
  && terrainPreload.coverage.every((region) => region.complete), "发布地形快照必须完整且包含山体面");
assert.ok((await fs.stat(path.join(site, "terrain-preload.json.gz"))).size < 25 * 1024 * 1024,
  "发布地形快照不得超过 Cloudflare Pages 单文件上限");
assert.ok(app.includes("function loadHuayuTerrainPreload(state)")
  && app.includes("huayuTerrainPreloadCovers(visibleBounds)")
  && app.includes(`HUAYU_TERRAIN_PRELOAD_RECHECK_MS = ${release.expectedTerrainPreloadRevalidateSeconds / 60} * 60 * 1000`),
  "地形首次加载必须使用发布快照，并检查三小时脚本生成的替换包");
const styles = await fs.readFile(path.join(site, "styles.css"), "utf8");
const worker = await fs.readFile(path.join(site, "_worker.js"), "utf8");
const headers = await fs.readFile(path.join(site, "_headers"), "utf8");
const transitPreload = JSON.parse(await fs.readFile(path.join(site, "transit-preload.json"), "utf8"));
const transitServices = JSON.parse(await fs.readFile(path.join(site, "transit-services.json"), "utf8"));
const dataUpdater = await fs.readFile(path.join(root, "scripts", "update-all-data.mjs"), "utf8");
const compactTransitBuilder = await fs.readFile(
  path.join(root, "scripts", "data-update", "builders", "compact-transit-preload.cjs"), "utf8",
);
const dataRefreshWorkflow = await fs.readFile(path.join(root, ".github", "workflows", "data-refresh.yml"), "utf8");
const jinchuanRailOperatingRule = transitServices.railOperatingRules
  ?.find((rule) => rule.id === "jinchuan-passenger-rail");
const pingzhangYanhuaJourney = jinchuanRailOperatingRule?.requiredTransferJourneys
  ?.find((journey) => journey.fromStationIds?.includes(404677559)
    && journey.toStationIds?.includes(416327117));
assert.deepEqual(pingzhangYanhuaJourney?.viaStationIds, [403358828],
  "平章至雁华铁路规则必须强制经津川换乘");
assert.deepEqual(pingzhangYanhuaJourney?.viaStationNames, ["津川"],
  "津川换乘规则必须保留数据刷新后的站名回退");
assert.deepEqual(pingzhangYanhuaJourney?.segmentRouteLabels, ["", "津川城铁雁华线"],
  "津川换乘后的乘车段必须明确显示津川城铁雁华线");
assert.ok(app.includes("stationMatches(originStop, journey.fromStationIds, journey.fromStationNames)")
  && app.includes("transitStationComplexKey(stop.name) === name")
  && app.includes("viaStationNames: stationNames(journey.viaStationNames)")
  && app.includes("const requiredOperatingPairs = pairs.filter")
  && app.includes("const candidatePairs = requiredOperatingPairs.length ? requiredOperatingPairs : pairs")
  && app.includes("plan.railOperatingRuleId = railPath.operatingRuleId || null")
  && app.includes("const requiredOperatingRuleIds = new Set(unrestrictedPlanPool")
  && app.includes("identity: `train:operating-segment:${operatingRuleId}:${index}`"),
"铁路运营规则必须支持稳定站名和途经站恢复，并在端点邻近时约束候选车站与最终方案");
assert.ok(index.includes(release.entryScript), "index.html 未引用 release.json 指定的应用版本");
assert.equal((index.match(/data-map-overlay=/gu) || []).length, 2,
  "地图图层菜单必须提供交通与地形两个独立开关");
assert.ok(index.includes('data-map-overlay="transit"')
  && index.includes('data-map-overlay="terrain" checked')
  && !index.includes("data-map-view="),
"交通与地形必须是可叠加开关，且默认仅开启地形");
assert.ok(index.includes('id="map-transit-layer-options"')
  && (index.match(/data-transit-layer=/gu) || []).length === 8
  && styles.includes(".map-transit-layer-options[hidden]")
  && app.includes('elements.mapTransitLayerOptions.hidden = mapViewMode !== "transit";')
  && app.includes("function syncTransitLayerToggles()")
  && app.includes("syncTransitLayerToggles();"),
"交通图层菜单必须直接提供四类显示筛选，并与交通状态浮窗同步");
assert.ok(app.includes('showView("place", { preservePerspective: true });')
  && app.includes('elements.panel.classList.add("is-hidden");')
  && app.includes('updateActiveAction("map-view");')
  && app.includes('setLayerPresence(routeLayer, view === "directions");'),
"打开地图视图菜单时必须退出导航面板并隐藏导航图层，同时保留导航结果数据");
assert.ok(app.includes('let mapViewMode = "normal";')
  && app.includes("let terrainOverlayEnabled = true;")
  && app.includes("function setTransitOverlayEnabled(enabled, options = {})")
  && app.includes("function setTerrainOverlayEnabled(enabled, options = {})")
  && app.includes('? (terrainOverlayEnabled ? "组合图" : "交通图")')
  && app.includes(': (terrainOverlayEnabled ? "地形图" : "视图")'),
"交通与地形状态必须彼此独立，并覆盖四种组合状态");
assert.ok(app.includes(`\"huayu:model-version\": \"${release.expectedBuildingModel}\"`), "建筑模型版本不一致");
assert.ok(app.includes(`HUAYU_LIVE_BUILDING_MIN_ZOOM = ${release.expectedBuildingMinZoom}`), "建筑起始缩放级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedBuildingTileZooms.join(", ")}])`), "Worker 建筑分片级别不一致");
assert.ok(worker.includes(`BUILDING_CACHE_SECONDS = ${release.expectedBuildingCacheSeconds}`),
  "Worker 建筑缓存周期不一致");
assert.ok(worker.includes(`STRUCTURE_REFRESH_SECONDS = ${release.expectedStructureRefreshSeconds}`)
  && worker.includes("fetchStructureTile") && release.structureProbe.startsWith("/api/structures/"),
"Worker 缺少独立墙、栅栏与亭子三小时分片接口");
assert.ok(app.includes(`HUAYU_LIVE_BASEMAP_MIN_ZOOM = ${release.expectedLiveBasemapMinZoom}`),
  "实时底图起始缩放级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedLiveBasemapTileZooms.join(", ")}])`),
  "Worker 实时底图分片级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedLiveBasemapSnapshotZooms.join(", ")}])`),
  "Worker 稳定快照分片级别不一致");
assert.ok(worker.includes(`LIVE_BASEMAP_SNAPSHOT_REFRESH_SECONDS = ${release.expectedLiveBasemapSnapshotRefreshSeconds}`),
  "Worker 稳定快照刷新周期不一致");
assert.ok(worker.includes(`LIVE_BASEMAP_DETAIL_REFRESH_SECONDS = ${release.expectedLiveBasemapDetailRefreshSeconds}`),
  "Worker 近景实时刷新周期不一致");
assert.ok(worker.includes("live-basemap") && worker.includes("fetchLiveBasemapTile"),
  "Worker 缺少实时底图接口");
assert.ok(worker.includes('node["natural"="tree"](${bbox})->.basemapTrees;')
  && app.includes('node["natural"="tree"](${bbox})->.basemapTrees;')
  && worker.includes("const treeNodes = zoom >= 15")
  && app.includes("const treeNodes = tile.z >= 15")
  && worker.includes('schema", "huayu-live-basemap-v8-progressive-terrain"'),
"实时底图必须仅在 z15 查询树木点，并使用渐进地形缓存 schema");
assert.ok(app.includes('treeTrunk: "ogf-atlas-huayu-tree-trunk"')
  && app.includes('treeCanopy: "ogf-atlas-huayu-tree-canopy"')
  && app.includes('filter: ["==", ["get", "renderKind"], "tree-trunk"]')
  && app.includes('filter: ["==", ["get", "renderKind"], "tree-canopy"]')
  && app.includes('treeOrigin: clusterIndex === null ? "mapped" : "woodland"'),
"树木点必须渲染独立树干和树冠，林地生成树必须保留来源标识");
assert.ok(app.includes("function huayuTreeRandom(seedValue)")
  && app.includes("function huayuWoodlandTreeCenters(element, geometry, areaSquareMeters)")
  && app.includes('huayuTreeRandom(`${element?.type}:${element?.id}:woodland-grid`)')
  && app.includes("HUAYU_WOODLAND_CLUSTER_TREE_LIMIT = 240"),
"小面积林地必须使用要素 ID 驱动的确定性面内采样，并限制每批树木数量");
assert.ok(app.includes("HUAYU_TERRAIN_MIN_ZOOM = 5.5")
  && app.includes("function rebuildHuayuTerrainData(state)")
  && app.includes("HUAYU_TERRAIN_TILE_ZOOM = 9")
  && app.includes("function fetchHuayuTerrainTile(tile, externalSignal)")
  && app.includes("function refreshHuayuTerrainTiles(glMap, state, visibleBounds)")
  && app.includes("huayuTerrainSharedTileCache")
  && app.includes('fetch(`/api/terrain/${tile.z}/${tile.x}/${tile.y}.json`')
  && app.includes("const terrainBeforeId = huayuLiveBasemapFirstExistingLayer")
  && app.includes("glMap.addLayer(woodlandMaterialLayer, woodlandBeforeId)")
  && app.includes("if (area >= HUAYU_MOUNTAIN_WOODLAND_MIN_AREA) return;")
  && app.includes('["mountain", "peak"].includes(properties.featureClass)')
  && app.includes("useHuayuTerrainData(state)")
  && app.includes("山|岭|谷|岳|峰|岗|丘|峦|坡|峡")
  && app.includes("const woodlandMaterialLayer = createHuayuWoodlandMaterialLayer(palette)")
  && app.includes("{ includeMountainRelief: true }")
  && app.includes("huayuMountainWoodlandEligible(element, geometry, terrainPeaks)")
  && app.includes("area < HUAYU_MOUNTAIN_WOODLAND_MIN_AREA")
  && !app.includes('reliefRole: "ridge"')
  && !app.includes('id: HUAYU_LIVE_BASEMAP_LAYERS.mountainRelief,'),
"山名小山、山地草原和合格大林地可进入山体，森林公园必须排除；不得恢复分级挤出");
assert.ok(app.includes("const HUAYU_TERRAIN_LAYER_IDS = [")
  && app.includes("function syncHuayuTerrainOverlay(glMap = currentVectorBasemap())")
  && app.includes("function suspendHuayuTerrainTiles(state)")
  && app.includes("if (!terrainOverlayEnabled) {")
  && app.includes("state.terrainPendingTiles.forEach((pending) => pending.controller.abort())")
  && app.includes("state.terrainQueue = []")
  && app.includes("state.terrainVisibleTileKeys = new Set()")
  && app.includes("if (terrainOverlayEnabled) scheduleHuayuLiveBasemap(glMap, 0)"),
"地形开关必须隐藏山体并停止其请求，同时不得关闭基础地图中的树木模型");
const terrainLayerList = app.match(/const HUAYU_TERRAIN_LAYER_IDS = \[([\s\S]*?)\];/u)?.[1] || "";
assert.doesNotMatch(terrainLayerList, /treeTrunk|treeCanopy/u,
  "树木模型不得被地形图层开关隐藏");
assert.match(terrainLayerList, /mountainOverviewTexture/u,
  "地形开关必须控制原有二维山林材质");
assert.doesNotMatch(terrainLayerList, /mountainSurface|mountainContour|mountainOverviewContour/u,
  "不得另加三维山体、等高线或林地描边图层");
assert.doesNotMatch(terrainLayerList, /mountainOverview,|mountainRelief/u,
  "地形开关不得恢复旧分级挤出或人工山脊图层");
assert.ok(app.includes('mountainOverviewTexture: "ogf-atlas-huayu-mountain-overview-texture"')
  && !app.includes('"ogf-atlas-huayu-mountain-surface"')
  && !app.includes('"ogf-atlas-huayu-mountain-overview-contour"')
  && app.includes('HUAYU_WOODLAND_TEXTURE_IMAGE = "ogf-atlas-huayu-woodland-texture"')
  && app.includes("function ensureHuayuWoodlandTextureImage(glMap, palette)")
  && app.includes('huayuTreeRandom("huayu-woodland-texture-v1")')
  && app.includes('glMap.setPaintProperty("landcover-wood", "fill-pattern",')
  && app.includes("context.fillStyle = palette.liveLandWood;")
  && app.includes("glMap.addLayer(woodlandMaterialLayer, woodlandBeforeId)")
  && app.includes("const woodlandBeforeId = huayuLiveBasemapFirstExistingLayer")
  && app.includes('glMap.moveLayer("landcover-grass-park", "landcover-farmland")')
  && app.includes("huayuTerrainOverviewLayerOrder")
  && app.includes('mapElement.dataset.huayuTerrainModel = "flat-textured-woodland-contours"')
  && app.includes('mapElement.dataset.huayuTerrainContourMode = "woodland-material"')
  && app.includes('mapElement.dataset.huayuTerrainPerspectiveMode = "flat"')
  && app.includes("function huayuMountainSurfaceModel(feature, polygonGeometry)")
  && !app.includes("huayuMountainContourInterpolatedElevation")
  && !app.includes("u_height_scale")
  && app.includes('renderingMode: "2d"')
  && app.includes("gl_Position = u_matrix * vec4(a_position.xy, 0.0, 1.0);")
  && !app.includes("function huayuMountainContourFeatures(feature)")
  && !app.includes('renderKind: "terrain-contour"')
  && !app.includes('"huayu:component": "height-field-contours"')
  && app.includes("in float a_elevation;")
  && app.includes("out vec2 v_world_position;")
  && app.includes("float huayuCanopyTexture(vec2 worldPosition)")
  && app.includes("float canopyGrain = smoothstep(0.58, 0.82, huayuSurfaceNoise(")
  && app.includes("0.86 + canopyTexture * 0.26 - canopyGrain * 0.1, textureAmount);")
  && app.includes("uniform vec3 u_contour_color;")
  && app.includes("float minorPhase = fract(max(0.0, v_elevation) / interval);")
  && app.includes("vec3 shaded = mix(color * v_light * textureShade, u_contour_color, contour);")
  && app.includes("const model = huayuMountainSurfaceModel(feature, polygonGeometry)")
  && app.includes("const heightAt = (coordinate) =>")
  && app.includes("edgeDistance(coordinate, edgeFadeMeters)")
  && !app.includes("HUAYU_TOPOGRAPHIC_CONTOUR_IMAGE")
  && !app.includes("ensureHuayuTopographicContourImage")
  && !app.includes('visibility", nextEnabled ? "none" : "visible"'),
"林冠纹理、明暗与等高线必须合成在原有二维山林材质中，不得抬升几何或另加图层");
const flatWoodlandFactorySource = app.match(
  /function createHuayuWoodlandMaterialLayer\(palette\) \{[\s\S]*?\n  \}(?=\n\n  function syncHuayuTerrainOverlay)/u,
)?.[0];
assert.ok(flatWoodlandFactorySource, "缺少二维山林材质实现");
assert.doesNotMatch(flatWoodlandFactorySource, /gl\.clear\(|gl\.depthMask\(true\)|renderingMode: "3d"/u,
  "二维山林不得清空或写入地图深度缓冲");
const flatWoodlandLayer = Function("HUAYU_LIVE_BASEMAP_LAYERS", "terrainOverlayEnabled",
  "huayuMountainSurfaceRgb", `return (${flatWoodlandFactorySource});`)(
  { mountainOverviewTexture: "existing-woodland-material" }, true, () => [0.5, 0.5, 0.5],
)({ mountainRelief: ["", "", "", "", ""], mountainContour: "" });
assert.equal(flatWoodlandLayer.id, "existing-woodland-material", "必须复用原山林材质 ID");
assert.equal(flatWoodlandLayer.renderingMode, "2d", "山林材质必须使用二维渲染");
const flatWoodlandVerticesSource = app.match(
  /function huayuMountainSurfaceFeatureVertices\([\s\S]*?\n  \}(?=\n\n  function huayuMountainSurfaceRgb)/u,
)?.[0];
assert.ok(flatWoodlandVerticesSource, "缺少山林平面几何实现");
const makeFlatWoodlandVertices = Function("HUAYU_TERRAIN_MIN_ZOOM", "clamp",
  "huayuMountainSurfaceModel", "huayuMountainContourInterval", "window",
  `return (${flatWoodlandVerticesSource});`)(7.5,
  (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
  () => ({ bounds: { west: 0, east: 1, south: 0, north: 1 }, cosine: 1,
    areaSquareMeters: 1e8, peakHeight: 800, heightAt: ([x, y]) => 100 + 300 * x + 400 * y }),
  () => 80, { maplibregl: { MercatorCoordinate: {
    fromLngLat: ({ lng, lat }, altitude) => ({ x: lng, y: lat, z: altitude }),
  } } },
);
for (const zoom of [7.5, 11, 15, 19]) {
  const vertices = makeFlatWoodlandVertices({ geometry: { type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }, 600, null, zoom);
  assert.ok(vertices.length > 0, "二维山林仍应生成可见几何");
  const elevations = new Set();
  for (let index = 0; index < vertices.length; index += 9) {
    assert.equal(vertices[index + 2], 0, `z${zoom} 山林顶点必须贴地`);
    elevations.add(vertices[index + 7]);
  }
  assert.ok(elevations.size > 1, "平面材质必须保留明暗和等高线所需的数值变化");
}
const terrainSyncSource = app.match(
  /function syncHuayuTerrainOverlay\([\s\S]*?\n  \}(?=\n\n  function syncHuayuMountainFeatureOrder)/u,
)?.[0];
assert.ok(terrainSyncSource);
for (const enabled of [false, true]) {
  const paints = [];
  const materialStates = [];
  const glMap = { getStyle: () => ({}), getLayer: () => ({}), hasImage: () => true,
    getLayoutProperty: () => "visible", setLayoutProperty: () => {},
    setPaintProperty: (...args) => paints.push(args) };
  const syncTerrain = Function("terrainOverlayEnabled", "currentVectorBasemap", "HUAYU_TERRAIN_LAYER_IDS",
    "HUAYU_LIVE_BASEMAP_LAYERS", "huayuWoodlandMaterialLayers", "HUAYU_WOODLAND_TEXTURE_IMAGE", "document",
    `return (${terrainSyncSource});`)(enabled, () => glMap, ["mountain-material"],
    { mountainOverviewTexture: "mountain-material" },
    { get: () => ({ setEnabled: (value) => materialStates.push(value) }) },
    "base-woodland-texture", { getElementById: () => null });
  syncTerrain(glMap);
  assert.deepEqual(materialStates, [enabled], "地形开关应只控制山体材质");
  assert.deepEqual(paints, [["landcover-wood", "fill-pattern", "base-woodland-texture"]],
    "关闭地形时基础树冠纹理必须保留");
}
const mountainNameSource = app.match(/function huayuMountainWoodlandName\(value\) \{[\s\S]*?\n  \}/u)?.[0];
const landPatternSource = app.match(/function huayuLiveLandPattern\([\s\S]*?\n  \}/u)?.[0];
assert.ok(landPatternSource);
const landImages = new Set(["base-woodland-texture"]);
const landImageMap = { hasImage: (id) => landImages.has(id), addImage: (id) => landImages.add(id) };
const makeLandPattern = Function("ensureHuayuWoodlandTextureImage", "HUAYU_WOODLAND_TEXTURE_IMAGE", "document",
  `return (${landPatternSource});`)(() => true, "base-woodland-texture", {
  createElement: () => ({ getContext: () => ({ fillRect: () => {}, getImageData: () => ({}) }) }),
});
const mixedLandPattern = makeLandPattern(landImageMap, {}, ["match", ["get", "featureClass"],
  "wood", "#cfe7cf", "park", "#d6ebd2", "residential", "#edf1f2", "#edf1f2"]);
assert.equal(mixedLandPattern[3], "base-woodland-texture", "实时林地必须继续使用基础树冠纹理");
assert.equal(mixedLandPattern[5], "ogf-atlas-land-color-#d6ebd2", "公园必须保留原有底色");
for (let index = 3; index < mixedLandPattern.length; index += 2) {
  assert.ok(landImages.has(mixedLandPattern[index]), "实时土地的每个分支都必须有有效纹理，避免空图");
}
assert.ok(landImages.has(mixedLandPattern.at(-1)), "实时土地的默认分支必须保留填充");
const mountainEligibleSource = app.match(
  /function huayuMountainWoodlandEligible\([\s\S]*?\n  \}/u,
)?.[0];
assert.ok(mountainNameSource && mountainEligibleSource);
const mountainName = Function(`return (${mountainNameSource});`)();
const mountainPlainName = Function(`return (${app.match(/function huayuMountainPlainName\([\s\S]*?\n  \}/u)?.[0]});`)();
const forestPark = Function("huayuPreferredFeatureName",
  `return (${app.match(/function huayuForestPark\([\s\S]*?\n  \}/u)?.[0]});`)((tags) => tags.name || "");
const mountainLandKind = Function("huayuForestPark", "huayuWoodlandArea", "huayuMountainWoodlandName",
  `return (${app.match(/function huayuMountainLandKind\([\s\S]*?\n  \}/u)?.[0]});`)(forestPark,
  (tags) => tags.natural === "wood" || tags.landuse === "forest", mountainName);
const mountainEligible = Function("huayuMountainLandKind", "huayuGeometryAreaSquareMeters",
  "HUAYU_MOUNTAIN_WOODLAND_MIN_AREA", "HUAYU_REGIONAL_WOODLAND_MIN_AREA", "huayuMountainWoodlandName", "huayuPointInPolygonGeometry", "huayuMountainPlainName",
  `return (${mountainEligibleSource});`)(
  mountainLandKind,
  (geometry) => geometry.area, 1000000, 25000000, mountainName, () => true, mountainPlainName,
);
assert.equal(mountainEligible({ tags: { natural: "wood", name: "大华山脉" } }, { area: 2e6 }), true);
assert.equal(mountainEligible({ tags: { natural: "wood", name: "林区", alt_name: "大华岭;华岭" } },
  { area: 2e6 }), true, "山名别名不得被主名称遮蔽");
assert.equal(mountainEligible({ tags: { natural: "wood", name: "小山" } }, { area: 1e4 }), true,
  "有明确山名的小山不得被面积规则排除");
assert.equal(mountainEligible({ tags: { natural: "wood", name: "树林" } }, { area: 1e4 }), false,
  "无山名的普通小林地仍保留原有树木规则");
assert.equal(mountainEligible({ tags: { leisure: "garden", name: "梅岭" } }, { area: 6000 }), true,
  "临大梅岭的花园面应保留真实范围的小山");
assert.equal(mountainEligible({ tags: { leisure: "park", natural: "wood", name: "梅岭" } },
  { area: 6000 }), false, "普通公园不扩大为山体");
assert.equal(mountainEligible({ tags: { landuse: "grass", name: "一得阁拉米高山草地" } },
  { area: 50e9 }), true, "已标注的高山草地应作为缓山地");
assert.equal(mountainEligible({ tags: { landuse: "grass", name: "草地" } },
  { area: 50e9 }), false, "普通草地不能仅凭面积生成山地");
assert.equal(mountainEligible({ tags: { natural: "wood", name: "大华国家森林公园（景区）" } },
  { area: 2e6 }, [{ coordinates: [0, 0] }]), false, "森林公园不得因峰顶变成山体");
assert.equal(mountainEligible({ tags: { natural: "wood" } }, { area: 2e6 }, [{ coordinates: [0, 0] }]), true,
  "已标注峰顶所在大林地应支持山体材质");
assert.equal(mountainEligible({ tags: { natural: "wood", name: "林区" } }, { area: 2e6 }), false,
  "缺少山地依据的普通林地应保留树冠纹理");
assert.equal(mountainEligible({ tags: { natural: "wood" } }, { area: 88e6 }), true,
  "区域性大林地不得仅因没有名称而失去地形材质");
assert.equal(mountainEligible({ tags: { natural: "wood", name: "北沛口林区（平原）" } },
  {area:50e9}), false, "明确标注平原的林地不得生成山峰");
assert.ok(app.includes("function huayuForestPark(tags = {})")
  && app.includes("function huayuWoodlandArea(tags = {})")
  && app.indexOf('if (huayuForestPark(tags) || leisure === "playground") return "park";')
    < app.indexOf('if (natural === "wood") return "wood";')
  && app.includes('huayuMountainLandKind(tags) !== "garden"')
  && app.includes('|| !["wood", "park"].includes(featureClass)) return;')
  && app.includes('"wood", 5,')
  && app.includes('"park", 6,'),
"森林公园必须优先按公园显示，可保留树木，但不得进入山地标签；公园绘制顺序必须高于林地");
assert.ok(worker.includes(`TERRAIN_TILE_ZOOM = ${release.expectedTerrainTileZoom}`)
  && worker.includes(`TERRAIN_REFRESH_SECONDS = ${release.expectedTerrainRefreshSeconds}`)
  && worker.includes("function terrainOverpassQuery(bounds)")
  && worker.includes("fetchTerrainTile")
  && worker.includes("huayu-terrain-v5-open-small-mountains")
  && worker.includes('node["natural"~"^(peak|volcano)$"](${bbox})->.terrainPeaks;')
  && !worker.includes("way(r.terrainRelations)")
  && worker.includes('"X-OGF-Terrain-Policy": "snapshot-3h"'),
"Worker 缺少独立低缩放山体接口或三小时缓存");
assert.ok(worker.includes(`TRANSIT_TILE_ZOOMS = Object.freeze({ rail: ${release.expectedTransitRailTileZoom}, bus: ${release.expectedTransitBusTileZoom} })`)
  && worker.includes(`TRANSIT_REFRESH_SECONDS = ${release.expectedTransitRefreshSeconds}`)
  && worker.includes("fetchTransitTile")
  && worker.includes("huayu-transit-tile-v2-area-stations")
  && worker.includes('"X-OGF-Transit-Policy": "snapshot-3h"'),
"Worker 缺少轨道与公交三小时分片缓存");
assert.ok(app.includes('fetchTransitSnapshotTiles("rail", bounds, 18000)')
  && app.includes('fetchTransitSnapshotTiles("bus", busBounds, 25000)')
  && app.includes("mergeTransitSnapshotElements")
  && app.includes("TRANSIT_DATA_CACHE_KEY = \"5.5-transit-3h-v1\""),
"交通视图必须优先使用三小时分片，同时保留预加载与直连兜底");
assert.equal(release.expectedTransitPreloadRevalidateSeconds, 300, "预加载包重验证周期必须为五分钟");
assert.ok(app.includes("const TRANSIT_PRELOAD_REVALIDATE_MS = 5 * 60 * 1000")
  && app.includes("const TRANSIT_LIVE_COVERAGE_REFRESH_MS = 3 * 60 * 60 * 1000")
  && app.includes("function scheduleTransitPreloadRefresh")
  && app.includes("function refreshTransitPreloadPackage")
  && app.includes('revalidate ? { cache: "no-cache" } : {}')
  && app.includes('document.addEventListener("visibilitychange"')
  && app.includes("entry.refreshAt > now")
  && app.includes("scheduleTransitCoverageRefresh(transitLiveCoverageRefreshDelay(map.getCenter()))"),
"全国交通预加载包必须热重验证，轨道与公交实时覆盖必须在三小时到期后自动更新");
for (const name of ["transit-preload.json", "transit-relations.json", "railway-routing.json",
  "railway-connections.json", "station-access.json", "airports.json"]) {
  assert.match(headers, new RegExp(`/${name.replace(".", "\\.")}\\r?\\n  Cache-Control: public, max-age=300, must-revalidate`, "u"),
    `${name} 仍被浏览器长期锁定，定时更新无法生效`);
}
assert.ok(dataRefreshWorkflow.includes('cron: "17 */3 * * *"')
  && dataRefreshWorkflow.includes("contents: write")
  && dataRefreshWorkflow.includes("npm run data:update")
  && dataRefreshWorkflow.includes("npm run test:data-update")
  && dataRefreshWorkflow.includes('git commit -m "Refresh generated OGF data"')
  && dataRefreshWorkflow.includes("pages deploy site --project-name=ogf-atlas")
  && dataRefreshWorkflow.includes("npm run verify:online"),
"全国交通数据必须每三小时重建、校验，仅在变化时提交并部署");
assert.equal((app.match(/state\.timer && state\.timerRunAt <= nextRunAt/g) || []).length, 3,
  "客户端实时底图、建筑和轻量结构物必须保留更早的刷新任务");
assert.ok(app.includes("const readyKeys = keys.filter((key) => state.tileCache.has(key))")
  && app.includes("if (!complete)")
  && app.includes('state.status = state.snapshotReady ? "retained" : "partial"')
  && app.includes("syncHuayuLiveBuildingPrimaryLayers(state.glMap, state, state.snapshotReady)")
  && app.includes("scheduleHuayuLiveBuildingCoverageFinalize(state)"),
"建筑分片必须完整后原子接管，冷启动的局部分片不得与发布建筑叠加");
assert.ok(app.includes("return clamp(Math.floor(glMap.getZoom()) + 1"),
  "建筑必须保留比底图细一级的分片，避免密集城区大分片阻塞");
assert.ok(app.includes("visibleTileSignature")
  && app.includes("const visibleTilesChanged = nextVisibleTileSignature !== state.visibleTileSignature")
  && app.includes("if (visibleTilesChanged) mergeHuayuLiveBuildingTiles(state)"),
"建筑倾斜视角必须复用未变化的可视瓦片集合，避免滚轮每步重复合并");
assert.ok(app.includes('state.status = state.snapshotReady ? "retained" : "loading"')
  && app.includes("syncHuayuLiveBuildingPrimaryLayers(state.glMap, state, true);")
  && app.includes("state.snapshotReady = true;"),
"建筑新覆盖加载期间必须保留上一份完整实时快照，不得清空或显示局部分片");
const buildingReplacementSyncSource = app.match(/function syncHuayuBuildingReplacementLayers\(glMap, liveOwnsBuildings\) \{[\s\S]*?\n  \}/u)?.[0];
const buildingPrimarySyncSource = app.match(/function syncHuayuLiveBuildingPrimaryLayers\(glMap, state, enabled\) \{[\s\S]*?\n  \}/u)?.[0];
assert.ok(buildingReplacementSyncSource && buildingPrimarySyncSource,
  "无法读取建筑所有权切换函数");
const vectorBuildingLayers = ["building", "building-top", "building-3d"];
const ancientBuildingLayers = { roof: "ancient-roof", outline: "ancient-outline" };
const pavilionLayers = ["pavilion-base", "pavilion-columns", "pavilion-roof"];
const busFacilityLayers = { model: "bus-facility-model" };
const buildingLayerState = new Map([
  ...vectorBuildingLayers.map((id) => [id, "visible"]),
  ["live-building", "none"],
  ...Object.values(ancientBuildingLayers).map((id) => [id, "none"]),
]);
const buildingLayerFilters = new Map();
const buildingMap = {
  getLayer: () => true,
  setLayoutProperty: (id, property, value) => {
    assert.equal(property, "visibility");
    buildingLayerState.set(id, value);
  },
  setFilter: (id, filter) => buildingLayerFilters.set(id, filter),
};
const syncBuildingReplacements = Function("HUAYU_PAVILION_BASE_LAYER",
  "HUAYU_PAVILION_COLUMN_LAYER", "HUAYU_PAVILION_LAYER", "HUAYU_BUS_FACILITY_LAYERS",
  `"use strict"; return (${buildingReplacementSyncSource});`)(...pavilionLayers, busFacilityLayers);
const syncBuildingOwners = Function("HUAYU_VECTOR_BUILDING_LAYER_IDS", "HUAYU_LIVE_BUILDING_LAYER",
  "HUAYU_ANCIENT_BUILDING_LAYERS", "syncHuayuBuildingReplacementLayers",
  `"use strict"; return (${buildingPrimarySyncSource});`)(vectorBuildingLayers, "live-building",
  ancientBuildingLayers, syncBuildingReplacements);
const buildingOwnerState = { primaryActive: false };
syncBuildingOwners(buildingMap, buildingOwnerState, true);
assert.ok(vectorBuildingLayers.every((id) => buildingLayerState.get(id) === "none")
  && ["live-building", ...Object.values(ancientBuildingLayers)]
    .every((id) => buildingLayerState.get(id) === "visible")
  && buildingOwnerState.primaryActive,
"实时建筑接管时必须一次关闭全部发布建筑，并显示实时建筑与古建筑部件");
assert.deepEqual(buildingLayerFilters.get("pavilion-roof"),
  ["==", ["get", "pavilionPart"], "roof"], "实时建筑接管后应显示面状亭子模型");
assert.deepEqual(buildingLayerFilters.get("bus-facility-model"), ["has", "busFacilityPart"],
  "实时建筑接管后应显示面状候车亭模型");
syncBuildingOwners(buildingMap, buildingOwnerState, false);
assert.ok(vectorBuildingLayers.every((id) => buildingLayerState.get(id) === "visible")
  && ["live-building", ...Object.values(ancientBuildingLayers)]
    .every((id) => buildingLayerState.get(id) === "none")
  && !buildingOwnerState.primaryActive,
"发布建筑兜底时必须先关闭全部实时建筑部件，再恢复发布建筑");
assert.deepEqual(buildingLayerFilters.get("pavilion-roof"),
  ["all", ["==", ["get", "pavilionPart"], "roof"],
    ["==", ["get", "osmType"], "node"]],
"发布建筑兜底时仅节点亭子可继续显示，面状亭子不得与建筑叠加");
assert.deepEqual(buildingLayerFilters.get("bus-facility-model"),
  ["all", ["has", "busFacilityPart"],
    ["!=", ["coalesce", ["get", "buildingReplacement"], 0], 1]],
"发布建筑兜底时面状候车亭模型不得与建筑面重复");
const mergeBuildingTilesSource = app.match(/function mergeHuayuLiveBuildingTiles\(state\) \{[\s\S]*?\n  \}/u)?.[0];
assert.ok(mergeBuildingTilesSource, "无法读取实时建筑分片合并状态机");
const buildingOwnershipCalls = [];
const appliedBuildingStates = [];
const mergeBuildingTiles = Function("clearHuayuLiveBuildingPrimarySync",
  "syncHuayuLiveBuildingPrimaryLayers", "updateHuayuLiveBuildingDiagnostics",
  "applyHuayuLiveBuildings", `"use strict"; return (${mergeBuildingTilesSource});`)(
  () => {},
  (_map, state, enabled) => {
    state.primaryActive = Boolean(enabled);
    buildingOwnershipCalls.push(Boolean(enabled));
  },
  () => {},
  (_map, state) => appliedBuildingStates.push({
    snapshotReady: state.snapshotReady,
    featureCount: state.data.features.length,
  }),
);
const buildingTileEntry = (key, revision) => ({
  revision,
  loadedAt: revision * 1000,
  data: { type: "FeatureCollection", features: [{
    type: "Feature", id: `live-building:${key}`,
    properties: { osmId: key }, geometry: null,
  }] },
});
const coldPartialBuildings = {
  glMap: {}, visibleTileKeys: new Set(["a", "b"]),
  tileCache: new Map([["a", buildingTileEntry("a", 1)]]),
  pendingTiles: new Map(), queuedTileKeys: new Set(),
  data: { type: "FeatureCollection", features: [] },
  dataReady: false, coverageReady: false, snapshotReady: false,
  primaryActive: false, primaryRevision: 0, renderSignature: "",
  renderRevision: 0, lastMergeKeyCount: 0, lastMergeReadyCount: 0,
};
mergeBuildingTiles(coldPartialBuildings);
assert.equal(coldPartialBuildings.status, "partial");
assert.equal(coldPartialBuildings.data.features.length, 0,
  "冷启动半包不得提交局部实时建筑");
assert.equal(buildingOwnershipCalls.at(-1), false,
  "冷启动半包必须继续由发布建筑兜底");
const retainedBuildings = {
  ...coldPartialBuildings,
  data: { type: "FeatureCollection", features: [{ id: "previous-complete" }] },
  dataReady: true, snapshotReady: true, primaryActive: true,
};
mergeBuildingTiles(retainedBuildings);
assert.equal(retainedBuildings.status, "retained");
assert.equal(retainedBuildings.data.features[0].id, "previous-complete",
  "新视窗半包不得覆盖上一份完整实时建筑快照");
assert.equal(buildingOwnershipCalls.at(-1), true,
  "替换快照加载期间必须保持上一份完整实时建筑的所有权");
const completeBuildings = {
  ...coldPartialBuildings,
  tileCache: new Map([
    ["a", buildingTileEntry("a", 2)],
    ["b", buildingTileEntry("b", 3)],
  ]),
};
mergeBuildingTiles(completeBuildings);
assert.equal(completeBuildings.snapshotReady, true);
assert.equal(completeBuildings.coverageReady, true);
assert.equal(completeBuildings.data.features.length, 2,
  "完整可见分片必须合并为一份实时建筑快照");
assert.deepEqual(appliedBuildingStates.at(-1), { snapshotReady: true, featureCount: 2 },
  "完整建筑快照必须整体提交后再进入所有权切换");
assert.ok(app.includes("const HUAYU_WALL_MIN_ZOOM = HUAYU_LIVE_BUILDING_MIN_ZOOM")
  && (app.match(/minzoom: HUAYU_WALL_MIN_ZOOM/g) || []).length === 6
  && app.includes('[[10, 0.45], [15, 1.1]')
  && app.includes('[[10, 0.35], [16, 0.8]'),
"普通墙与栅栏必须和建筑模型使用相同起始比例尺，并在远景使用克制线宽");
assert.ok(app.includes('way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;')
  && worker.includes('way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;')
  && app.includes("wallData: huayuWallFeatureCollection(result.payload.elements)")
  && app.includes("fetch(`/api/structures/${tile.z}/${tile.x}/${tile.y}.json`")
  && worker.includes('schema", "huayu-structures-v2-open-pavilions"')
  && worker.includes('schema", "huayu-building-v5"')
  && !app.includes("function refreshHuayuWalls")
  && !app.includes("glMap.getZoom() < 14.75"),
"墙和栅栏必须使用独立轻量分片与三小时缓存，不得被建筑查询超时连带清空");
const buildingWorkerQuerySource = worker.match(/function buildingOverpassQuery\(bounds\) \{[\s\S]*?\n\}/u)?.[0] || "";
const buildingClientQuerySource = app.match(/function huayuLiveBuildingTileQuery\(tile\) \{[\s\S]*?\n  \}/u)?.[0] || "";
assert.ok(buildingWorkerQuerySource && buildingClientQuerySource
  && !buildingWorkerQuerySource.includes("pavilionStructures")
  && !buildingClientQuerySource.includes("pavilionStructures")
  && !buildingWorkerQuerySource.includes('nwr["amenity"="shelter"]')
  && !buildingClientQuerySource.includes('nwr["amenity"="shelter"]'),
"重型建筑查询不得继续包含亭子选择器");
assert.ok(app.includes("const layersReady = ensureHuayuWallLayers(glMap) && ensureHuayuPavilionLayer(glMap);")
  && app.indexOf("glMap.getSource(HUAYU_WALL_SOURCE)?.setData(state.wallData")
    < app.indexOf("glMap.getSource(HUAYU_PAVILION_SOURCE)?.setData(state.pavilionData"),
"墙体和亭子必须由轻量结构物加载器原子提交");
assert.ok(app.includes("function positionHuayuWallsAboveBuildings(glMap)")
  && app.includes("positionHuayuWallsAboveBuildings(glMap);")
  && app.includes("function syncHuayuWallPerspectiveLayers(glMap) {\n    // Source requests can keep isStyleLoaded() false")
  && app.includes("if (!glMap?.getStyle?.()) return;")
  && app.includes('glMap.setLayoutProperty(layerId, "visibility", perspective ? "none" : "visible")')
  && app.includes("polygons.push([huayuNormalizedWallRing(ring, false)])")
  && app.includes("huayuWallSegmentPolygons(coordinates, width, fence ? 0.12 : 0.2)")
  && app.includes("if (state.snapshotReady && !replacementReady)")
  && app.includes('"retained-complete"')
  && app.includes("state.snapshotReady = replacementReady"),
"墙和栅栏必须在俯视线层与透视立体层之间互斥切换，并原子替换完整分片快照");
const wallPerspectiveSyncSource = app.match(/function syncHuayuWallPerspectiveLayers\(glMap\) \{[\s\S]*?\n  \}/u)?.[0];
assert.ok(wallPerspectiveSyncSource, "无法读取墙体透视显隐同步函数");
const wallLayerIds = {
  extrusion: "wall-extrusion",
  casing: "wall-casing",
  line: "wall-line",
  fenceExtrusion: "fence-extrusion",
  fenceCasing: "fence-casing",
  fenceLine: "fence-line",
};
let testedWallPitch = 48;
const wallVisibility = new Map();
const wallLayerMap = {
  getStyle: () => ({ layers: [] }),
  getPitch: () => testedWallPitch,
  getLayer: () => true,
  setLayoutProperty: (id, property, value) => {
    assert.equal(property, "visibility");
    wallVisibility.set(id, value);
  },
};
const syncWallPerspective = Function("HUAYU_WALL_LAYERS", "positionHuayuWallsAboveBuildings",
  `"use strict"; return (${wallPerspectiveSyncSource});`)(wallLayerIds, () => {});
syncWallPerspective(wallLayerMap);
assert.ok([wallLayerIds.extrusion, wallLayerIds.fenceExtrusion]
  .every((id) => wallVisibility.get(id) === "visible")
  && [wallLayerIds.casing, wallLayerIds.line, wallLayerIds.fenceCasing, wallLayerIds.fenceLine]
    .every((id) => wallVisibility.get(id) === "none"),
"透视模式只能显示墙和栅栏的立体层，平面线不得穿过建筑重复渲染");
testedWallPitch = 0;
syncWallPerspective(wallLayerMap);
assert.ok([wallLayerIds.extrusion, wallLayerIds.fenceExtrusion]
  .every((id) => wallVisibility.get(id) === "none")
  && [wallLayerIds.casing, wallLayerIds.line, wallLayerIds.fenceCasing, wallLayerIds.fenceLine]
    .every((id) => wallVisibility.get(id) === "visible"),
"俯视模式只能显示墙和栅栏的平面线，立体层不得同时渲染");
assert.ok(app.includes('ancientKind,')
  && app.includes('HUAYU_ANCIENT_BUILDING_LAYERS')
  && app.includes('"huayu:component": "ancient-building-roof-cap"')
  && app.includes('"huayu:component": "ancient-building-outline"')
  && app.includes('building:architecture')
  && worker.includes('ancientWays')
  && worker.includes('ancientArchitectureWays'),
"古建筑必须从当前 OGF 标签查询并使用独立屋顶压檐和轮廓层");
assert.ok(app.includes('function huayuPavilionKind(tags = {})')
  && app.includes('structureKind === "pavilion"')
  && app.includes('function huayuPavilionNodeRadius(element, contextElements = [], fallbackRadiusMeters = 2.6)')
  && app.includes('function huayuPavilionColumnGeometry(geometry, osmType = "way")')
  && app.includes('function huayuPavilionInteriorPoint(polygon)')
  && app.includes('pavilionPart: "roof"')
  && app.includes('pavilionPart: "column"')
  && app.includes('pavilionPart: "base"')
  && app.includes('mapElement.dataset.huayuLivePavilions')
  && app.includes('palette.pavilionRoof')
  && app.includes('palette.pavilionColumn')
  && app.includes('palette.pavilionBase')
  && app.includes('nwr["amenity"="shelter"]')
  && app.includes('way["highway"](${bbox})->.pavilionClearanceWays;')
  && app.includes('way(r.pavilionStructures)')
  && worker.includes('nwr["amenity"="shelter"]')
  && worker.includes('way["highway"](${bbox})->.pavilionClearanceWays;')
  && worker.includes('way(r.pavilionStructures)')
  && worker.includes('schema", "huayu-structures-v2-open-pavilions"'),
"亭子与凉亭必须使用道路净距自适应节点轮廓、真实面屋顶、薄地台和开放立柱结构");
const pavilionKindSource = app.match(/function huayuPavilionKind\(tags = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
const liveBuildingHeightSource = app.match(/function huayuLiveBuildingHeight\(tags = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionRoofDepthSource = app.match(/function huayuPavilionRoofDepth\(tags = \{\}, height = 3\.6\) \{[\s\S]*?\n  \}/)?.[0];
const liveBuildingMinHeightSource = app.match(/function huayuLiveBuildingMinHeight\(tags = \{\}, height\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(pavilionKindSource && liveBuildingHeightSource && pavilionRoofDepthSource && liveBuildingMinHeightSource,
  "无法读取亭子分类或高度函数");
const pavilionKind = Function(`"use strict"; return (${pavilionKindSource});`)();
const parsePavilionMeasurement = (value, fallback, maximum) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(maximum, parsed) : fallback;
};
const pavilionHeight = Function("huayuPavilionKind", "parseHuayuWallMeasurement",
  `"use strict"; return (${liveBuildingHeightSource});`)(pavilionKind, parsePavilionMeasurement);
const pavilionRoofDepth = Function("parseHuayuWallMeasurement",
  `"use strict"; return (${pavilionRoofDepthSource});`)(parsePavilionMeasurement);
const pavilionMinHeight = Function("huayuPavilionKind", "huayuPavilionRoofDepth", "parseHuayuWallMeasurement",
  `"use strict"; return (${liveBuildingMinHeightSource});`)(pavilionKind, pavilionRoofDepth, parsePavilionMeasurement);
assert.equal(pavilionKind({ leisure: "gazebo" }), "pavilion", "leisure=gazebo 未识别为凉亭");
assert.equal(pavilionKind({ amenity: "shelter", shelter_type: "picnic_shelter" }), "pavilion",
  "picnic_shelter 未识别为亭子");
assert.equal(pavilionKind({ amenity: "shelter" }), "pavilion", "普通 amenity=shelter 未识别为亭子");
assert.equal(pavilionKind({ amenity: "shelter", shelter_type: "public_transport" }), "",
  "公共交通候车亭不得识别为通用亭子");
assert.equal(pavilionKind({ building: "roof", name: "望湖亭" }), "pavilion", "命名亭子屋顶未识别");
assert.equal(pavilionKind({ tourism: "attraction", name: "睡莲亭" }), "pavilion", "景点节点亭子未识别");
assert.equal(pavilionKind({ amenity: "shelter", building: "yes", name: "公明亭" }), "pavilion",
  "带建筑轮廓的命名亭子未识别");
assert.equal(pavilionKind({ building: "yes", name: "晴风亭" }), "pavilion",
  "仅带普通建筑标签的命名亭子未识别");
assert.equal(pavilionKind({ amenity: "police", building: "yes", name: "保安亭" }), "",
  "保安亭不得误识别为休憩亭子");
assert.equal(pavilionKind({ public_transport: "station", railway: "station", name: "归云亭" }), "",
  "名称以亭结尾的车站不得误识别为亭子");
assert.equal(pavilionKind({ building: "roof", name: "普通雨棚" }), "", "普通屋顶被误识别为亭子");
assert.equal(pavilionHeight({ leisure: "gazebo", height: "5.2" }), 5.2, "亭子未优先使用 height");
assert.equal(pavilionHeight({ man_made: "pavilion", "building:levels": "2" }), 6,
  "亭子未使用 building:levels 推导高度");
assert.equal(pavilionHeight({ leisure: "gazebo" }), 3.6, "亭子默认高度错误");
assert.equal(pavilionRoofDepth({ leisure: "gazebo", "roof:height": "1.1" }, 5), 1.1,
  "亭子未使用 roof:height");
assert.equal(pavilionMinHeight({ leisure: "gazebo" }, 3.6), 2.8,
  "无底高参数的亭子应只建模架空屋顶");
assert.equal(pavilionMinHeight({ leisure: "gazebo", min_height: "2.1" }, 4.2), 2.1,
  "亭子未尊重显式 min_height");
const pavilionDistanceSource = app.match(/function huayuPavilionPointSegmentDistanceMeters\(point, first, second\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionRoadHalfWidthSource = app.match(/function huayuPavilionRoadHalfWidth\(tags = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionNodeRadiusSource = app.match(/function huayuPavilionNodeRadius\(element, contextElements = \[\], fallbackRadiusMeters = 2\.6\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionNodeGeometrySource = app.match(/function huayuPavilionNodeGeometry\(element, contextElements = \[\], fallbackRadiusMeters = 2\.6\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(pavilionDistanceSource && pavilionRoadHalfWidthSource && pavilionNodeRadiusSource
  && pavilionNodeGeometrySource, "无法读取节点亭子道路净距或轮廓函数");
const pavilionDistance = Function(`"use strict"; return (${pavilionDistanceSource});`)();
const pavilionRoadHalfWidth = Function("parseHuayuWallMeasurement",
  `"use strict"; return (${pavilionRoadHalfWidthSource});`)(parsePavilionMeasurement);
const pavilionWallCoordinates = (element) => (element?.geometry || [])
  .map((point) => [Number(point.lon), Number(point.lat)])
  .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));
const pavilionNodeRadius = Function("parseHuayuWallMeasurement", "huayuWallCoordinates",
  "huayuPavilionPointSegmentDistanceMeters", "huayuPavilionRoadHalfWidth", "huayuPavilionKind",
  `"use strict"; return (${pavilionNodeRadiusSource});`)(parsePavilionMeasurement,
  pavilionWallCoordinates, pavilionDistance, pavilionRoadHalfWidth, pavilionKind);
const pavilionNodeGeometry = Function("huayuPavilionNodeRadius",
  `"use strict"; return (${pavilionNodeGeometrySource});`)(pavilionNodeRadius);
const pavilionNodePolygon = pavilionNodeGeometry({
  type: "node", lat: 14.6353833, lon: 152.9625553,
  tags: { amenity: "shelter", shelter_type: "gazebo" },
});
assert.equal(pavilionNodePolygon.type, "Polygon", "节点型凉亭未生成屋顶轮廓");
assert.equal(pavilionNodePolygon.coordinates[0].length, 9, "节点型凉亭屋顶应为闭合八边形");
assert.deepEqual(pavilionNodePolygon.coordinates[0][0], pavilionNodePolygon.coordinates[0].at(-1),
  "节点型凉亭屋顶未闭合");
const pavilionCenter = [152.9625553, 14.6353833];
const pavilionFirstPoint = pavilionNodePolygon.coordinates[0][0];
const pavilionDefaultRadius = Math.hypot(
  (pavilionFirstPoint[0] - pavilionCenter[0]) * 111320 * Math.cos(pavilionCenter[1] * Math.PI / 180),
  (pavilionFirstPoint[1] - pavilionCenter[1]) * 111320,
);
assert.ok(pavilionDefaultRadius > 2.9 && pavilionDefaultRadius < 3.1,
  "无道路约束的节点型亭子应扩大到约 3 米半径");
const nearbyFootway = {
  type: "way", tags: { highway: "footway" }, geometry: [
    { lon: 152.9625924, lat: 14.63534 }, { lon: 152.9625924, lat: 14.63543 },
  ],
};
const constrainedRadius = pavilionNodeRadius({
  type: "node", lat: 14.6353833, lon: 152.9625553,
  tags: { amenity: "shelter", shelter_type: "gazebo" },
}, [nearbyFootway]);
assert.ok(constrainedRadius >= 0.8 && constrainedRadius < 2.7,
  "临近步道的节点亭子必须按道路净距缩小");
const explicitWidthPolygon = pavilionNodeGeometry({
  type: "node", lat: 14.6353833, lon: 152.9625553, tags: { amenity: "shelter", width: "8" },
});
const explicitWidthPoint = explicitWidthPolygon.coordinates[0][0];
const explicitWidthRadius = Math.hypot(
  (explicitWidthPoint[0] - pavilionCenter[0]) * 111320 * Math.cos(pavilionCenter[1] * Math.PI / 180),
  (explicitWidthPoint[1] - pavilionCenter[1]) * 111320,
);
assert.ok(explicitWidthRadius > 3.9 && explicitWidthRadius < 4.1,
  "节点型亭子必须优先使用显式 width 参数");
const pavilionRingPerimeterSource = app.match(/function huayuPavilionRingPerimeter\(ring\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionSampleRingSource = app.match(/function huayuPavilionSampleRing\(ring, count\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionWallPointInRingSource = app.match(/function huayuWallPointInRing\(point, ring\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionPolygonContainsPointSource = app.match(/function huayuPavilionPolygonContainsPoint\(point, polygon\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionDistanceToRingsSource = app.match(/function huayuPavilionDistanceToRings\(point, polygon\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionInteriorPointSource = app.match(/function huayuPavilionInteriorPoint\(polygon\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionMoveTowardSource = app.match(/function huayuPavilionMoveTowardMeters\(point, target, meters\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionColumnRingSource = app.match(/function huayuPavilionColumnRing\(center, radiusMeters\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionInsetColumnCenterSource = app.match(/function huayuPavilionInsetColumnCenter\(boundaryPoint, interiorPoint, columnRadius, polygon\) \{[\s\S]*?\n  \}/)?.[0];
const pavilionColumnGeometrySource = app.match(/function huayuPavilionColumnGeometry\(geometry, osmType = "way"\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(pavilionRingPerimeterSource && pavilionSampleRingSource && pavilionWallPointInRingSource
  && pavilionPolygonContainsPointSource && pavilionDistanceToRingsSource && pavilionInteriorPointSource
  && pavilionMoveTowardSource && pavilionColumnRingSource && pavilionInsetColumnCenterSource
  && pavilionColumnGeometrySource,
  "无法读取亭子立柱几何函数");
const pavilionRingPerimeter = Function("huayuPavilionPointSegmentDistanceMeters",
  `"use strict"; return (${pavilionRingPerimeterSource});`)(pavilionDistance);
const pavilionSampleRing = Function("huayuPavilionPointSegmentDistanceMeters",
  `"use strict"; return (${pavilionSampleRingSource});`)(pavilionDistance);
const pavilionPointKey = (point) => `${Number(point[0]).toFixed(7)},${Number(point[1]).toFixed(7)}`;
const pavilionWallPointInRing = Function(`"use strict"; return (${pavilionWallPointInRingSource});`)();
const pavilionPolygonContainsPoint = Function("huayuWallPointInRing",
  `"use strict"; return (${pavilionPolygonContainsPointSource});`)(pavilionWallPointInRing);
const pavilionDistanceToRings = Function("huayuPavilionPointSegmentDistanceMeters",
  `"use strict"; return (${pavilionDistanceToRingsSource});`)(pavilionDistance);
const pavilionInteriorPoint = Function("huayuWallPointKey", "huayuPavilionPolygonContainsPoint",
  "huayuPavilionDistanceToRings", `"use strict"; return (${pavilionInteriorPointSource});`)(
  pavilionPointKey, pavilionPolygonContainsPoint, pavilionDistanceToRings);
const pavilionMoveToward = Function(`"use strict"; return (${pavilionMoveTowardSource});`)();
const pavilionColumnRing = Function("huayuNormalizedWallRing",
  `"use strict"; return (${pavilionColumnRingSource});`)((ring) => ring);
const pavilionInsetColumnCenter = Function("huayuPavilionMoveTowardMeters", "huayuPavilionColumnRing",
  "huayuPavilionPolygonContainsPoint", `"use strict"; return (${pavilionInsetColumnCenterSource});`)(
  pavilionMoveToward, pavilionColumnRing, pavilionPolygonContainsPoint);
const pavilionColumnGeometry = Function("huayuWallPointKey", "huayuPavilionRingPerimeter",
  "huayuPavilionSampleRing", "huayuPavilionInteriorPoint", "huayuPavilionInsetColumnCenter",
  "huayuPavilionColumnRing", "huayuPavilionPolygonContainsPoint",
  `"use strict"; return (${pavilionColumnGeometrySource});`)(pavilionPointKey,
  pavilionRingPerimeter, pavilionSampleRing, pavilionInteriorPoint, pavilionInsetColumnCenter,
  pavilionColumnRing, pavilionPolygonContainsPoint);
const facePavilionGeometry = {
  type: "Polygon", coordinates: [[
    [152.9356827, 14.6368156], [152.9356458, 14.6367194],
    [152.9357802, 14.6366711], [152.9358171, 14.6367674],
    [152.9356827, 14.6368156],
  ]],
};
const facePavilionColumns = pavilionColumnGeometry(facePavilionGeometry, "way");
assert.equal(facePavilionColumns.type, "MultiPolygon", "面状亭子必须生成独立立柱几何");
assert.equal(facePavilionColumns.coordinates.length, 5, "四角面状亭子应生成四根内缩边柱和一根中心柱");
assert.ok(facePavilionColumns.coordinates.every((column) => column[0].slice(0, -1)
  .every((point) => pavilionPolygonContainsPoint(point, facePavilionGeometry.coordinates))),
"每根亭柱的完整截面都必须位于原始亭面内");
const facePavilionColumnCenters = facePavilionColumns.coordinates.map((column) => {
  const points = column[0].slice(0, -1);
  return points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
    .map((value) => value / points.length);
});
assert.ok(facePavilionColumnCenters.slice(0, 4).every((center, index) =>
  pavilionDistance(center, facePavilionGeometry.coordinates[0][index],
    facePavilionGeometry.coordinates[0][index]) > 0.1),
"面亭边柱中心不得继续落在原始轮廓顶点上");
const facePavilionInteriorPoint = pavilionInteriorPoint(facePavilionGeometry.coordinates);
assert.ok(pavilionDistance(facePavilionColumnCenters.at(-1), facePavilionInteriorPoint,
  facePavilionInteriorPoint) < 0.1, "面亭必须在面内净空中心增加中心柱");
const pavilionBaseFeatureSource = app.match(/id: `live-pavilion-base:\$\{key\}`,[\s\S]*?\n        \}\);/u)?.[0] || "";
assert.ok(pavilionBaseFeatureSource.includes('pavilionPart: "base"')
  && pavilionBaseFeatureSource.includes("renderHeight: 0.14")
  && pavilionBaseFeatureSource.includes("renderMinHeight: 0")
  && pavilionBaseFeatureSource.includes("geometry,"),
"亭子地台必须沿原始亭面生成 0.14 米薄铺层");
assert.ok(app.includes('filter: ["==", ["get", "pavilionPart"], "roof"]')
  && app.includes('filter: ["==", ["get", "pavilionPart"], "column"]')
  && app.includes('filter: ["==", ["get", "pavilionPart"], "base"]'),
"亭子屋顶、立柱与地台必须由三个独立过滤图层渲染，四周保持通透");
const publicTransportShelterSource = app.match(/function huayuIsPublicTransportShelter\(element\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(publicTransportShelterSource, "无法读取公交候车亭排除函数");
const isPublicTransportShelter = Function(`"use strict"; return (${publicTransportShelterSource});`)();
assert.equal(isPublicTransportShelter({ type: "node", tags: {
  amenity: "shelter", shelter_type: "public_transport", bus: "yes",
} }), true, "公交候车亭不得进入通用亭子模型");
assert.ok(app.includes("source: HUAYU_LIVE_BASEMAP_SOURCE")
  && app.includes("function huayuLiveBasemapPolygonSignature"),
  "体育场详细面和嵌套子场地必须使用实时底图主数据源");
assert.ok(app.includes("function huayuLiveBasemapSportsRelationGeometry(relation, waysById, runningTrackOuterWayIds)")
  && app.includes('huayuSportKind(relation?.tags) !== "soccer"')
  && app.includes("sharedTrackOuters.length === outerMembers.length")
  && app.includes("runningTrackOuterWayIds.has(String(member.ref))"),
"复合足球场与跑道共用最外层轮廓时必须排除外围草地，仅保留跑道内侧球场");
const sportsRelationGeometrySource = app.match(/function huayuLiveBasemapSportsRelationGeometry\(relation, waysById, runningTrackOuterWayIds\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(sportsRelationGeometrySource, "无法读取复合体育场几何修正函数");
const huayuLiveBasemapSportsRelationGeometry = Function(
  "huayuCityWallRelationGeometry", "huayuSportKind",
  `"use strict"; return (${sportsRelationGeometrySource});`,
)(
  (relation) => ({ outerRefs: (relation.members || [])
    .filter((member) => member.type === "way" && member.role !== "inner")
    .map((member) => member.ref) }),
  (tags) => String(tags?.sport || "") === "soccer" ? "soccer" : "",
);
const compositePitchFixture = {
  tags: { leisure: "pitch", sport: "soccer" },
  members: [
    { type: "way", ref: 100, role: "outer" },
    { type: "way", ref: 101, role: "inner" },
    { type: "way", ref: 102, role: "outer" },
  ],
};
assert.deepEqual(huayuLiveBasemapSportsRelationGeometry(
  compositePitchFixture, new Map(), new Set(["100"]),
), { outerRefs: [102] }, "跑道共用外围仍被错误渲染成足球场绿色");
assert.deepEqual(huayuLiveBasemapSportsRelationGeometry(
  compositePitchFixture, new Map(), new Set(),
), { outerRefs: [100, 102] }, "无跑道共用边界的正常复合足球场被误裁剪");
assert.ok(app.includes('runningOverview: "ogf-atlas-huayu-sports-running-overview"')
  && app.includes('["==", ["get", "sportsArea"], "running"]')
  && app.includes('maxzoom: 15.25'),
  "跑道必须在小比例尺体育层交接时保留独立实时兜底");
assert.ok(app.includes("function positionHuayuSportsBelowBuildings(glMap)")
  && app.includes('const HUAYU_SPORTS_SOURCE = "ogf-atlas-huayu-sports"')
  && app.includes("function applyHuayuSportsSnapshot(glMap, state)")
  && app.includes("const loadedEntries = [...state.visibleTileKeys]")
  && app.includes("state.tileCache.get(key)")
  && app.includes("state.sportsRenderSignature === signature")
  && app.includes("applyHuayuSportsSnapshot(state.glMap, state)")
  && app.includes("function syncHuayuSportsSnapshotLayers(glMap, state = huayuLiveBasemapStates.get(glMap))")
  && app.includes("const liveVisible = Boolean(state?.sportsDataReady)")
  && app.includes('state?.primaryActive ? "live" : "retained-live"')
  && app.includes("syncHuayuSportsSnapshotLayers(glMap, state)")
  && app.includes("syncHuayuSportsSnapshotLayers(glMap)"),
"实时操场必须按已返回瓦片渐进显示，移动与透视扩大视野时保留最后有效体育数据并保持在建筑层下方");
assert.ok(app.includes("function huayuLiveBasemapRenderPlan(state)")
  && app.includes("...state.detailTileKeys")
  && app.includes("...(snapshotReady ? state.snapshotTileKeys : [])")
  && app.includes('return { activeTier: "snapshot", renderKeys: state.snapshotTileKeys }'),
"近景实时底图必须在完整快照之上补充细节，不得因缩放切换丢失完整用地或透视远端要素");
const liveBasemapRenderPlanSource = app.match(/function huayuLiveBasemapRenderPlan\(state\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(liveBasemapRenderPlanSource, "无法读取实时底图缩放衔接函数");
const huayuLiveBasemapRenderPlan = Function("huayuLiveBasemapKeysReady",
  `"use strict"; return (${liveBasemapRenderPlanSource});`)(
  (state, keys) => Boolean(keys?.size) && [...keys].every((key) => state.tileCache.has(key)),
);
const combinedBasemapPlan = huayuLiveBasemapRenderPlan({
  detailTileKeys: new Set(["15/detail-a", "15/detail-b"]),
  snapshotTileKeys: new Set(["14/snapshot"]),
  tileCache: new Map([["15/detail-a", {}], ["15/detail-b", {}], ["14/snapshot", {}]]),
});
assert.equal(combinedBasemapPlan.activeTier, "live", "完整近景分片未成为实时主层");
assert.deepEqual([...combinedBasemapPlan.renderKeys], ["15/detail-a", "15/detail-b", "14/snapshot"],
  "近景实时主层没有保留完整父级快照作为连续性补足");
assert.ok(app.includes("state.applyTimer = window.setTimeout(() => {")
  && app.includes("applyHuayuLiveBuildings(glMap, state);")
  && app.includes("window.clearTimeout(state.applyTimer);")
  && app.includes("applyTimer: null,"),
"建筑完整分片在样式加载期间未能应用时必须自动重试，不能永久停留在部分覆盖状态");
const primaryVectorStart = app.indexOf("const HUAYU_LIVE_BASEMAP_PRIMARY_VECTOR_LAYERS = [");
const primaryVectorEnd = app.indexOf("];", primaryVectorStart);
assert.ok(primaryVectorStart >= 0 && primaryVectorEnd > primaryVectorStart
  && app.slice(primaryVectorStart, primaryVectorEnd).includes('"landuse-sports"')
  && app.includes("if (liveBasemapState?.primaryActive) {")
  && app.includes("syncHuayuLiveBasemapPrimaryLayers(glMap, liveBasemapState, true);"),
"完整实时体育数据接管后必须同步隐藏发布层，加载期间仍由统一接管状态保留兜底");
assert.ok(worker.includes("pitch|track|stadium|sports_centre"),
  "Worker 实时底图查询必须包含跑道和体育场");
assert.ok(app.includes("function huayuPoiLabelTextField()")
  && app.includes('["index-of", "（", ["var", "label"]]')
  && app.includes('["poi-level-1", "poi-level-2", "poi-level-3", "huayu-poi-facilities", "huayu-poi-toilets"]'),
"POI 注记必须保留全角括号兼容和长后缀成组换行规则");
assert.ok(app.includes('huayuForestPark(tags) && huayuMountainLandKind(tags) !== "garden"')
  && app.includes('importantParkLarge: "ogf-atlas-huayu-important-park-large"')
  && app.includes('["!=", "subclass", "park"], ["!=", "class", "park"]')
  && app.includes('[HUAYU_LIVE_BASEMAP_LAYERS.importantParkLarge, 14, 0]')
  && app.includes('publishedParkLayout["text-variable-anchor"] = ["top", "right", "bottom", "left"]'),
"命名公园必须使用实时面内部点，并按面积分级替换旧瓦片代表点");
assert.ok(app.includes("const TRANSIT_RENDER_DELAY_MS = 220")
  && app.includes("function vectorTransitFeatureSignature")
  && app.includes("vectorTransitOverlaySignature")
  && app.includes("if (vectorTransitOverlayMap === glMap && vectorTransitOverlaySignature === signature)")
  && app.includes("const hasUsableNetwork = Boolean(transitNetworkData?.lines?.length)")
  && app.includes("function findPreloadedTransitRelationsInBounds")
  && app.includes("实时公共交通查询暂时不可用，已使用本地预载索引"),
"公共交通连续移动必须合并重绘，并避免向 MapLibre 重复提交未变化的交通数据");
assert.ok(app.includes("let transitLiveCoverageAreas = []")
  && app.includes("const preserveLiveNetwork = !snapshotChanged")
  && app.includes('["live", "hybrid"].includes(transitNetworkData?.source)')
  && app.includes("scheduleTransitCoverageRefresh();")
  && app.includes("loadTransitNetwork({ ensureCoverage: true, background: true })")
  && !app.includes("loadTransitNetwork({ ensureCoverage: true });")
  && app.includes("if (baseNetwork) {\n      scheduleTransitNetworkRender({ force: true, immediate: true });")
  && app.includes("scheduleTransitCoverageRetry()")
  && app.includes('setStatus(elements.transitNetworkStatus, "已保留现有交通数据；当前位置正在后台重试更新。", false)')
  && app.includes("const infrastructureWays = (payload.elements || []).filter")
  && !app.includes("const infrastructureWays = baseNetwork ? []")
  && app.includes("const nextTransitNetworkLayer = window.L.layerGroup()")
  && app.includes("nextTransitNetworkLayer.eachLayer((layer) => transitNetworkLayer.addLayer(layer))"),
"交通实时数据必须在移动后持续保留，分片失败时后台重试，并使用原子图层换帧");
assert.ok(app.includes("function shouldShowTransitStopLabel(stop, displayIsRail, zoom)")
  && app.includes("if (zoom >= 13) return true")
  && app.includes("if (zoom < 12) return false")
  && app.includes("stop.isInterchange || stop.isMainline || hasMainlineRoute || markerRoutes.length >= 2")
  && (app.match(/shouldShowTransitStopLabel\(stop, displayIsRail, zoom\)/g) || []).length === 4
  && !app.includes("displayIsRail ? zoom >= 13 : zoom >= 16")
  && app.includes("if (shouldShowLabel && !entry.labelMarker)"),
  "公共交通站点标签必须在 z12 显示干线站、换乘站和多线路站，z13 起显示全部轨道站");
assert.ok(app.includes("isInterchange: stop[13] === 1")
  && compactTransitBuilder.includes("stop.isInterchange ? 1 : 0")
  && dataUpdater.includes('step("enforce-transit-service-rules.cjs")'),
"交通紧凑预载包必须持久化人工换乘标志，并在定时更新中重新应用规则");
const huaxiaTransitSnapshot = transitPreload.snapshots.find((snapshot) => snapshot.id === "huaxia");
assert.ok(huaxiaTransitSnapshot?.network, "缺少华夏交通预载快照");
const transitRouteTable = huaxiaTransitSnapshot.network.routeTable;
const transitStopByName = (name) => huaxiaTransitSnapshot.network.stops.find((stop) => stop[5] === name);
const transitStopById = (id) => huaxiaTransitSnapshot.network.stops.find((stop) => stop[0] === id);
const routeRefAt = (index) => String(transitRouteTable[index]?.[5] || "").trim();
const routeLabelAt = (index) => String(transitRouteTable[index]?.[4] || "").trim();
const jinchuanMetroStop = transitStopById(424888164);
const jinchuanRailwayStop = transitStopById(403358828);
const jinchuanStationRule = transitServices.stationDisplayMergeOverrides
  ?.find((rule) => rule.id === "jinchuan-main-station-interchange");
assert.ok(jinchuanMetroStop && ["JS01", "JS03"].every((ref) =>
  jinchuanMetroStop[8]?.some((index) => routeRefAt(index) === ref)),
"津川火车站必须保留 JS01/JS03 两条地铁线路");
assert.ok(jinchuanRailwayStop?.[8]?.some((index) => routeLabelAt(index).includes("津川城铁航空港线")),
  "津川铁路站必须保留津川城铁航空港线");
assert.deepEqual(jinchuanStationRule?.stationNames, ["津川", "津川火车站"],
  "津川铁路站与地铁站必须保留为同一显示换乘复合体");
assert.equal(jinchuanStationRule?.anchorStationId, 424888164,
  "津川换乘符号必须锚定津川火车站地铁站点");
assert.ok(app.includes("function collapseParallelPublicTransitRailLinesForDisplay(lines)")
  && app.includes("const connected = joinConnectedTransitLines(group, 1)")
  && app.includes("collapseParallelPublicTransitRailLinesForDisplay(visibleSourceLines)"),
"市域铁路双线显示必须只连接真实连续轨道并压成运营中线，禁止生成假折返");
const southeastCornerStop = transitStopByName("东南角");
assert.ok(southeastCornerStop && southeastCornerStop[13] === 1,
  "东南角必须在预载包中保留换乘标志");
assert.ok(["R", "I", "P"].every((ref) => southeastCornerStop[11]?.some((index) => routeRefAt(index) === ref)),
"东南角必须在预载包中保留 R/I/P 三线展示设定");
const southeastCornerRule = transitServices.stationInterchangeOverrides
  ?.find((rule) => rule.id === "beihu-southeast-corner-three-line");
assert.ok((southeastCornerRule?.stationCount ?? 1) === 1
  && southeastCornerRule?.symbolMode === "single-ring"
  && southeastCornerRule?.mergeNearbyUnnamedWithinMeters === 80,
"东南角必须保留单个三线换乘符号及同组无名站显示合并规则");
assert.ok(app.includes("const fill = uniqueColors.length > 1")
  && app.includes("conic-gradient(${uniqueColors.map"),
"多线换乘站必须在单个站圈内按线路颜色分区");
assert.ok(app.includes("is-station-complex")
  && app.includes("mergeNearbyUnnamedWithinMeters")
  && styles.includes(".rail-stop-symbol.is-station-complex > i"),
"交通视图必须使用多站换乘符号，并在点击前合并同组无名站标记");
const yujiaqiaoStop = transitStopByName("郁家桥");
assert.ok(yujiaqiaoStop && yujiaqiaoStop[13] === 1,
  "郁家桥必须在预载包中保留换乘标志");
const wangtieYujiaqiaoStop = transitStopByName("望铁郁家桥");
assert.ok(wangtieYujiaqiaoStop && wangtieYujiaqiaoStop[0] !== yujiaqiaoStop[0],
  "郁家桥与望铁郁家桥必须保留为两个独立站点");
const yujiaqiaoRule = transitServices.stationInterchangeOverrides
  ?.find((rule) => rule.id === "beihu-yujiaqiao-interchange");
assert.equal(yujiaqiaoRule?.mergeNearbyUnnamedWithinMeters, 30,
  "郁家桥必须合并共享线路的近邻无名站显示标记");
assert.deepEqual(yujiaqiaoRule?.routeNames, ["捷运纵贯线"],
  "郁家桥必须保留纵贯线换乘信息");
const beihuInterchangeMatrix = [
  ["beihu-north-station-three-line", "北沪车站", ["R", "I", "M"]],
  ["beihu-erchong-interchange", "二重", ["M", "CY"]],
  ["beihu-yujiaqiao-interchange", "郁家桥", ["CY"]],
  ["beihu-zhongshan-xinde-interchange", "中山信德", ["BL"]],
  ["beihu-southeast-corner-three-line", "东南角", ["R", "I", "P"]],
  ["beihu-aiguo-road-interchange", "爱国路", ["R", "P"]],
  ["beihu-ximending-interchange", "西门町", ["P", "BL"]],
];
for (const [id, stationName, routeRefs] of beihuInterchangeMatrix) {
  const rule = transitServices.stationInterchangeOverrides?.find((item) => item.id === id);
  assert.deepEqual(rule?.stationNames, [stationName], `北沪换乘站名规则丢失：${stationName}`);
  assert.deepEqual(rule?.routeRefs, routeRefs, `北沪换乘线路顺序变化：${stationName}`);
  assert.equal(rule?.symbolMode, "single-ring", `北沪换乘站必须使用单环符号：${stationName}`);
}
assert.ok(app.includes('stop.interchangeSymbolMode = override.symbolMode')
  && app.includes('stop.interchangeSymbolMode !== "single-ring"'),
"北沪单环换乘符号必须在实时数据融合后继续强制生效");
for (const stop of huaxiaTransitSnapshot.network.stops) {
  for (const index of [...(stop[8] || []), ...(stop[11] || [])]) {
    assert.ok(transitRouteTable[index], `站点 ${stop[5]} 存在线路索引越界`);
  }
}
for (const id of ["beihu-southeast-corner-three-line", "beihu-yujiaqiao-interchange"]) {
  assert.ok(transitServices.stationInterchangeOverrides?.some((rule) => rule.id === id
    && rule.source === "user_confirmed"), `缺少人工换乘规则：${id}`);
}
assert.ok(!transitServices.stationTransferAliases?.some((rule) => rule.id === "beihu-yujiaqiao-station-complex")
  && !transitServices.stationDisplayMergeOverrides?.some((rule) => rule.id === "beihu-yujiaqiao-station-complex"),
"郁家桥与望铁郁家桥不得配置为同一站点复合体");
const publishedTransitStationSyncSource = app.match(
  /function syncPublishedTransitStationLayers\(glMap = currentVectorBasemap\(\)\) \{[\s\S]*?\n  \}/u,
)?.[0];
assert.ok(publishedTransitStationSyncSource
  && app.includes("syncPublishedTransitStationLayers(glMap);")
  && app.includes("syncPublishedTransitStationLayers();"),
"交通视图必须接管底图铁路站图标，并在底图加载和视图切换时同步");
const publishedVisibility = new Map([["poi-railway", "visible"]]);
const publishedFilters = new Map([
  ["poi-level-1", ["all", ["==", "rank", 1]]],
  ["poi-level-2", ["all", ["==", "rank", 2]]],
  ["poi-level-3", ["all", ["==", "rank", 3]]],
]);
const publishedLayerMap = {
  getStyle: () => ({ layers: [] }),
  getLayer: (id) => publishedVisibility.has(id) || publishedFilters.has(id),
  getLayoutProperty: (id) => publishedVisibility.get(id),
  setLayoutProperty: (id, property, value) => {
    assert.equal(property, "visibility");
    publishedVisibility.set(id, value);
  },
  getFilter: (id) => publishedFilters.get(id),
  setFilter: (id, value) => publishedFilters.set(id, value),
};
const publishedLayerState = new WeakMap();
const makePublishedTransitStationSync = (mode) => Function(
  "currentVectorBasemap", "publishedTransitStationLayerStates",
  "PUBLISHED_TRANSIT_STATION_LAYER_IDS", "PUBLISHED_GENERAL_POI_LAYER_IDS", "mapViewMode",
  `"use strict"; return (${publishedTransitStationSyncSource});`,
)(() => null, publishedLayerState, ["poi-railway"], ["poi-level-1", "poi-level-2", "poi-level-3"], mode);
const originalPublishedFilters = new Map([...publishedFilters].map(([id, filter]) => [id, structuredClone(filter)]));
makePublishedTransitStationSync("transit")(publishedLayerMap);
assert.equal(publishedVisibility.get("poi-railway"), "none",
  "交通视图未隐藏底图原有铁路站图标");
for (const filter of publishedFilters.values()) {
  assert.deepEqual(filter.at(-1), ["any", ["!=", "class", "railway"], ["!=", "subclass", "station"]],
    "交通视图未从通用 POI 图层排除铁路站点");
}
makePublishedTransitStationSync("normal")(publishedLayerMap);
assert.equal(publishedVisibility.get("poi-railway"), "visible",
  "退出交通视图后未恢复底图铁路站图标");
assert.deepEqual(publishedFilters, originalPublishedFilters,
  "退出交通视图后未恢复通用 POI 图层过滤器");
const transitStopLabelSource = app.match(/function shouldShowTransitStopLabel\(stop, displayIsRail, zoom\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(transitStopLabelSource, "无法读取公共交通站名分级函数");
const makeTransitStopLabelRule = Function(
  "selectedNetworkStationId", "getVisibleTransitRoutes", "transitLayerCategory",
  `"use strict"; return (${transitStopLabelSource});`,
);
const visibleFixtureRoutes = (routes) => routes;
const fixtureRouteCategory = (route) => route?.type === "train" ? "railway" : "metro";
const transitStopLabelRule = makeTransitStopLabelRule(null, visibleFixtureRoutes, fixtureRouteCategory);
assert.equal(transitStopLabelRule({ name: "换乘站", isInterchange: true, routes: [] }, true, 11), false,
  "z11 不应提前显示轨道站名");
assert.equal(transitStopLabelRule({ name: "换乘站", isInterchange: true, routes: [] }, true, 12), true,
  "z12 未显示换乘站名");
assert.equal(transitStopLabelRule({ name: "干线站", isMainline: true, routes: [] }, true, 12), true,
  "z12 未显示干线站名");
assert.equal(transitStopLabelRule({ name: "多线路站", routes: [{ id: 1 }, { id: 2 }] }, true, 12), true,
  "z12 未显示多线路站名");
assert.equal(transitStopLabelRule({ name: "普通轨道站", routes: [{ id: 1 }] }, true, 12), false,
  "z12 不应显示全部普通轨道站名");
assert.equal(transitStopLabelRule({ name: "普通轨道站", routes: [{ id: 1 }] }, true, 13), true,
  "z13 未显示普通轨道站名");
assert.equal(transitStopLabelRule({ name: "公交站", routes: [{ id: 1 }] }, false, 15), false,
  "公交站名不应在 z16 前出现");
assert.equal(transitStopLabelRule({ name: "公交站", routes: [{ id: 1 }] }, false, 16), true,
  "公交站名未在 z16 出现");
const selectedTransitStopLabelRule = makeTransitStopLabelRule("7", visibleFixtureRoutes, fixtureRouteCategory);
assert.equal(selectedTransitStopLabelRule({ id: 7, name: "已选站", routes: [] }, true, 10), true,
  "已选站点应在任意交通缩放级别保留站名");
assert.ok(index.includes('id="map-feature-selection"')
  && app.includes('MAP_FEATURE_SELECTION_STORAGE_KEY = "ogf-atlas-map-feature-selection"')
  && app.includes("if (!mapFeatureSelectionEnabled) return;")
  && app.includes("preservePerspective: vectorPerspectiveActive")
  && app.includes("function clearActiveMapFeatureSelection()")
  && app.includes("if (!mapFeatureSelectionEnabled) clearActiveMapFeatureSelection()")
  && app.includes("placeMarker.remove()")
  && app.includes("hideTransitStationDetail()"),
"地图必须提供持久化要素选择开关，交通视图普通选点和透视选点不得被旧拦截逻辑阻断");
assert.ok(app.includes("function currentVectorCameraSnapshot()")
  && app.includes('BASEMAP_STYLES[previousBasemapId]?.kind === "vector"')
  && app.includes("center: perspectiveSnapshot.center")
  && app.includes("zoom: perspectiveSnapshot.zoom")
  && app.includes("silent: true"),
"华域标准、深夜与 Vector 图层切换必须保留完整透视相机状态");
assert.ok(app.includes('const FUZZY_ADMINISTRATIVE_SUFFIXES = ["市", "区", "县"]')
  && app.includes("function fuzzyAdministrativeSearchQueries(query)")
  && app.includes("async function searchFuzzyAdministrativePlaces(query)")
  && app.includes("await Promise.all(queries.map")
  && app.includes("function fuzzyAdministrativeDisplayResults(results)")
  && app.includes("? fuzzyAdministrativeDisplayResults(results) : []")
  && !app.includes("if (pointOfInterestCollectionResults(combinedResults, query).length)"),
"无后缀中文行政区搜索必须补查市区县，并在同名普通地点存在时仍保留行政区结果");
assert.ok(app.includes("function selectTransitBusGuideMemberOrder")
  && app.includes("explicitly tagged stop/platform members are the authoritative order")
  && app.includes('if (transitRelationRouteType(relation) !== "bus") return null')
  && app.includes("const requestedFrom = normalizeTransitStopName(relation?.tags?.from || \"\")")
  && app.includes("const busMemberOrder = selectTransitBusGuideMemberOrder(stops, relation)"),
"公交线路图必须优先使用关系中的 stop/platform 成员顺序，并按 from/to 校正方向");
assert.ok(app.includes("Rail route masters may group stops by direction or construction phase")
  && app.includes("transitGuideOrderAgreement(ordered, geometryOrder) >= 0.9")
  && app.includes("? ordered : geometryOrder")
  && app.includes("return orientTransitGuideOrder(continuousOrder, relation)"),
"轨道交通总关系的合并站序与连续几何冲突时必须回退到实际线路顺序");
assert.ok(app.includes("function transitGuideDirectRoundtripInfo(relation)")
  && app.includes("function transitGuideRoundtripInfo(relation, items = selectedTransitItems)")
  && app.includes('String(relation?.tags?.type || "") !== "route_master"')
  && app.includes("const childInfo = children.map(transitGuideDirectRoundtripInfo)")
  && app.includes("anchor: normalizedAnchors.size === 1 ? anchors[0] : \"\"")
  && app.includes("renderTransitLineGuide({ label, color: lineColor, lengthMeters, relation: selectedRelation })")
  && app.includes("? orientTransitGuideOrder(directionalStops, guideRelation)")
  && app.includes("const end = roundtripInfo.roundtrip ? start")
  && app.includes('roundtripInfo.roundtrip ? " · 环线" : ""'),
"环线线路向导必须从闭环子关系继承共同锚点，正向与换向均显示同一站为起终点");
const transitGuideDirectRoundtripInfoSource = app.match(/function transitGuideDirectRoundtripInfo\(relation\) \{[\s\S]*?\n  \}/)?.[0];
const transitGuideRoundtripInfoSource = app.match(/function transitGuideRoundtripInfo\(relation, items = selectedTransitItems\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(transitGuideDirectRoundtripInfoSource && transitGuideRoundtripInfoSource,
  "无法读取环线向导识别函数");
const normalizeGuideStopName = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
const transitGuideDirectRoundtripInfo = Function("normalizeTransitStopName",
  `"use strict"; return (${transitGuideDirectRoundtripInfoSource});`)(normalizeGuideStopName);
const transitGuideRoundtripInfo = Function(
  "transitGuideDirectRoundtripInfo", "normalizeTransitStopName", "transitRelationRouteType",
  `"use strict"; return (${transitGuideRoundtripInfoSource});`,
)(transitGuideDirectRoundtripInfo, normalizeGuideStopName,
  (relation) => String(relation?.tags?.route || relation?.tags?.route_master || ""));
const ringMasterFixture = {
  type: "relation",
  id: 547550,
  tags: { type: "route_master", route_master: "subway", name: "津川轨道交通4号线", ref: "JS04" },
  members: [{ type: "relation", ref: 547548 }, { type: "relation", ref: 547549 }],
};
const ringChildrenFixture = [547548, 547549].map((id, index) => ({
  type: "relation",
  id,
  tags: { type: "route", route: "subway", name: `津川轨道交通4号线${index ? "外圈" : "内圈"}`, from: "虚谷", to: "虚谷" },
}));
assert.deepEqual(transitGuideRoundtripInfo(ringMasterFixture, [ringMasterFixture, ...ringChildrenFixture]),
  { roundtrip: true, anchor: "虚谷" }, "津川4号线总关系未继承内外环共同起终站");
assert.deepEqual(transitGuideRoundtripInfo({
  type: "relation", tags: { type: "route", route: "subway", from: "长宁湖", to: "石木" },
}, []), { roundtrip: false, anchor: "" }, "普通线路被错误识别为环线");
assert.ok(app.includes("function transitStationPointElement(item)")
  && app.includes('id: `${item.type}:${item.id}`')
  && app.includes("...items.filter((item) => item.type !== \"node\").map(transitStationPointElement).filter(Boolean)")
  && app.includes('nwr["railway"~"^(station|halt|tram_stop)$"]')
  && worker.includes('nwr["railway"~"^(station|halt|tram_stop)$"]')
  && worker.includes(".railStations out body center;")
  && worker.includes('huayu-transit-tile-v2-area-stations'),
"交通实时分片必须查询并归一化以 way/relation 绘制的车站，并绕开旧节点专用缓存");
const mergeTransitSnapshotElementsSource = app.match(/function mergeTransitSnapshotElements\(packets\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(mergeTransitSnapshotElementsSource, "无法读取交通分片要素合并函数");
const mergeTransitSnapshotElements = Function(
  `"use strict"; return (${mergeTransitSnapshotElementsSource});`,
)();
const mergedStationArea = mergeTransitSnapshotElements([{ payload: { elements: [{
  type: "way", id: 45055830, geometry: [{ lat: 24.091, lon: 142.006 }],
  tags: { railway: "station", name: "大仓山" },
}, {
  type: "way", id: 45055830, center: { lat: 24.0916621, lon: 142.006377 },
  tags: { railway: "station", name: "大仓山" },
}] } }])[0];
assert.equal(mergedStationArea.geometry.length, 1, "车站面中心输出不得覆盖线路几何");
assert.deepEqual(mergedStationArea.center, { lat: 24.0916621, lon: 142.006377 },
  "同一车站面的 Overpass 几何与中心记录必须合并");
const transitStationPointElementSource = app.match(/function transitStationPointElement\(item\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(transitStationPointElementSource, "无法读取面状车站中心点归一化函数");
const transitStationPointElement = Function("isRailStationCandidate",
  `"use strict"; return (${transitStationPointElementSource});`,
)((item) => ["station", "halt", "tram_stop"].includes(item?.tags?.railway)
  || item?.tags?.station === "subway" || item?.tags?.subway === "yes"
  || item?.tags?.public_transport === "station");
assert.deepEqual(transitStationPointElement({
  type: "way", id: 45055830, center: { lat: 24.0916621, lon: 142.006377 },
  tags: { railway: "station", station: "subway", name: "大仓山" },
}), {
  type: "node", id: "way:45055830", center: { lat: 24.0916621, lon: 142.006377 },
  sourceElementType: "way", sourceElementId: 45055830,
  lat: 24.0916621, lon: 142.006377,
  tags: { railway: "station", station: "subway", name: "大仓山" },
}, "北沪面状车站未转换为可吸附的站点中心");
assert.equal(transitStationPointElement({
  type: "way", id: 1, center: { lat: 24.09, lon: 142.01 }, tags: { railway: "rail" },
}), null, "普通轨道 way 不得被误转换为车站");
assert.ok(app.includes("if (node.sourceElementType)")
  && app.includes("areaTrackNearest?.distance <= 60"),
"未入线路关系的面状车站必须按严格轨道距离补充，且不得放宽普通点状车站规则");
const transitLayerCategorySource = app.match(/function transitLayerCategory\(routeOrType\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(transitLayerCategorySource, "无法读取交通线路图层分类函数");
const transitLayerCategory = Function("METRO_ROUTE_TYPES",
  `"use strict"; return (${transitLayerCategorySource});`,
)(new Set(["subway", "light_rail", "monorail"]));
[
  "jinchuan-city-rail",
  "beihu-wangtie",
  "gaoyang-shentie",
  "gaoyang-jintie",
].forEach((publicTransitRailSystem) => {
  assert.equal(transitLayerCategory({ type: "train", publicTransitRailSystem }), "railway",
    `${publicTransitRailSystem} 必须归入铁路显示图层，不得归入地铁`);
});
assert.equal(transitLayerCategory({ type: "train" }), "railway",
  "普通国铁线路不得被并入默认城市轨道图层");
const isUrbanRailTransitRouteSource = app.match(/function isUrbanRailTransitRoute\(route\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(isUrbanRailTransitRouteSource, "无法读取市域铁路导航资格函数");
const isUrbanRailTransitRoute = Function(
  "publicTransitRailSystemForRoute", "URBAN_TRAIN_ROUTE_LABEL", "URBAN_TRAIN_SERVICE_LABEL",
  "URBAN_TRAIN_OPERATOR_LABEL", "urbanRailText",
  `"use strict"; return (${isUrbanRailTransitRouteSource});`,
)(() => null, /$a/u, /$a/u, /$a/u, () => ({ label: "", service: "", operator: "" }));
assert.equal(isUrbanRailTransitRoute({ type: "train", publicTransitRailSystem: "jinchuan-city-rail" }), true,
  "铁路图层中的津川城铁仍必须参与公交地铁导航");
assert.equal(isUrbanRailTransitRoute({ type: "train", publicTransitRailSystem: "beihu-wangtie" }), true,
  "铁路图层中的北沪望铁仍必须参与公交地铁导航");
assert.equal(isUrbanRailTransitRoute({ type: "train", publicTransitRailSystem: "gaoyang-jintie" }), true,
  "铁路图层中的高阳金铁仍必须参与公交地铁导航");
assert.equal(isUrbanRailTransitRoute({ type: "train" }), false,
  "未登记的普通铁路不得自动参与公交地铁导航");
const railStationTransferTrackOffsetSource = app.match(
  /function railStationTransferTrackOffsetMeters\(stop\) \{[\s\S]*?\n  \}/,
)?.[0];
assert.ok(railStationTransferTrackOffsetSource, "无法读取铁路站内换乘轨道范围函数");
const railStationTransferTrackOffsetMeters = Function(
  "RAIL_STATION_TRANSFER_MAX_METERS", "RAIL_STATION_TRANSFER_MAX_TRACK_OFFSET_METERS",
  `"use strict"; return (${railStationTransferTrackOffsetSource});`,
)(650, 250);
assert.equal(railStationTransferTrackOffsetMeters({ isMainline: true }), 650,
  "大型主线铁路客站必须覆盖完整车站范围内的不同线路轨道");
assert.equal(railStationTransferTrackOffsetMeters({ isMainline: false }), 250,
  "普通铁路站不得扩大既有轨道吸附范围");
assert.ok((app.match(/candidate\.offset <= railStationTransferTrackOffsetMeters\(stop\)/g) || []).length === 3
  && app.includes("if (distance > (stop.isMainline ? railStationTransferTrackOffsetMeters(stop) : 500)) return;"),
"铁路物理建图与全国铁路换乘建图必须统一使用车站级轨道范围");
assert.ok(app.includes("return normalizedB - normalizedA;")
  && app.includes("every higher-level boundary remains visible")
  && app.includes('[8, "#2f7d4a"]')
  && app.includes('[6, "#1769e0"]'),
  "行政区下级边界必须先画乡镇、后画区县，并使用明确区分的层级颜色");
assert.ok(app.includes('map.createPane("admin-subdivision-hit")')
  && app.includes('const placeSubdivisionHitLayer = window.L.geoJSON(null, {')
  && app.includes('pane: "admin-subdivision-hit"')
  && app.includes('setLayerPresence(placeSubdivisionHitLayer, administrativeBoundaryView')
  && (app.match(/placeSubdivisionHitLayer\.clearLayers\(\)/g) || []).length >= 2
  && (app.match(/placeSubdivisionHitLayer\.addData\(/g) || []).length === 2
  && app.includes('const placeSubdivisionLayer = window.L.geoJSON(null, {\n    pane: "admin-subdivision",\n    interactive: false,'),
"行政区可见边界必须与下级优先的透明命中层分离，并覆盖加载、清空和显隐生命周期");
assert.ok(app.includes('const panelVisible = !elements.panel.classList.contains("is-hidden")')
  && app.includes('const administrativeSearchView = panelVisible')
  && app.includes('&& view === "place"')
  && app.includes('&& Boolean(selectedAdministrativeBoundary)')
  && app.includes('const downloadView = panelVisible && view === "download"')
  && app.includes('const administrativeBoundaryView = administrativeSearchView || downloadView')
  && app.includes('setLayerPresence(placeExportSelectionLayer, downloadView')
  && app.includes('setLayerPresence(administrativeExportBoxLayer, downloadView')
  && /function showPanel\(\)[\s\S]*?classList\.remove\("is-hidden"\);\s*syncMapLayers\(currentView\);/.test(app)
  && /function hidePanel\(\)[\s\S]*?classList\.add\("is-hidden"\);\s*cancelAdministrativeBoxPick\(\);\s*syncMapLayers\(currentView\);/.test(app),
"行政区覆盖层必须只在打开的行政区搜索或地图下载面板显示，下载清单与范围框不得影响其他功能");
assert.ok(app.includes("function administrativeExportRenderOrder(features, parentKeys)")
  && app.includes("return Number(parentA) - Number(parentB);")
  && (app.match(/administrativeExportRenderOrder\(features, parentKeys\)\.forEach/g) || []).length === 2,
"行政区栅格导出必须按层级绘制，并将所选上级边界置于最上层");
const administrativeOrderSource = app.match(/function administrativeDivisionRenderOrder\(features\) \{[\s\S]*?\n  \}/)?.[0];
const administrativeInteractionOrderSource = app.match(/function administrativeDivisionInteractionOrder\(features\) \{[\s\S]*?\n  \}/)?.[0];
const administrativeColorSource = app.match(/function administrativeLevelColor\(level\) \{[\s\S]*?\n  \}/)?.[0];
const administrativeExportOrderSource = app.match(/function administrativeExportRenderOrder\(features, parentKeys\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(administrativeOrderSource && administrativeInteractionOrderSource
  && administrativeColorSource && administrativeExportOrderSource,
  "无法读取行政边界层级函数");
const administrativeOrder = Function(`"use strict"; return (${administrativeOrderSource});`)();
const administrativeInteractionOrder = Function(`"use strict"; return (${administrativeInteractionOrderSource});`)();
const administrativeColor = Function(`"use strict"; return (${administrativeColorSource});`)();
const administrativeExportOrder = Function("administrativeDivisionRenderOrder", "administrativeBoundaryFeatureKey",
  `"use strict"; return (${administrativeExportOrderSource});`)(administrativeOrder, (feature) => feature.id);
const hierarchyFixtures = [
  { id: "county", properties: { admin_level: 6 } },
  { id: "township", properties: { admin_level: 8 } },
  { id: "city", properties: { admin_level: 5 } },
];
assert.deepEqual(administrativeOrder(hierarchyFixtures).map((feature) => feature.id), ["township", "county", "city"],
  "地图行政边界层级顺序错误");
assert.deepEqual(administrativeInteractionOrder(hierarchyFixtures).map((feature) => feature.id), ["city", "county", "township"],
  "地图行政边界命中顺序没有优先更下级行政区");
assert.deepEqual(administrativeExportOrder(hierarchyFixtures, new Set(["city"])).map((feature) => feature.id),
  ["township", "county", "city"], "栅格导出未将所选上级行政边界置顶");
assert.equal(administrativeColor(6), "#1769e0", "区县级边界颜色错误");
assert.equal(administrativeColor(8), "#2f7d4a", "乡镇级边界颜色错误");
assert.ok(app.includes("let transitBusRetryTimer = null")
  && app.includes("let transitBusRetryAt = 0")
  && app.includes("function getTransitBusCoverageBounds")
  && app.includes("const latitudeSpan = clamp(Math.max(viewport.getNorth() - viewport.getSouth(), 0.03) * 1.12, 0.03, 0.08)")
  && app.includes("const longitudeSpan = clamp(Math.max(viewport.getEast() - viewport.getWest(), 0.05) * 1.12, 0.05, 0.12)")
  && app.includes("function splitTransitBusCoverageBounds")
  && app.includes("const responses = cached.complete ? cached.packets.map")
  && app.includes(": await Promise.all(requestBounds.map")
  && app.includes("const successfulResponses = responses.filter(Boolean)")
  && app.includes("The map traffic view needs both stop markers and their route identities")
  && app.includes("[out:json][timeout:12];(node[\"highway\"=\"bus_stop\"]")
  && app.includes('rel(bn.busStops)["type"="route"]["route"="bus"]->.busRoutes')
  && app.includes('rel(br.busRoutes)["type"="route_master"]->.busMasters')
  && app.includes("enrichTransitRelationTypes(busElements)")
  && app.includes("transitBusRetryAt = Date.now() + 8000")
  && app.includes("正在追加公交站"),
"地图交通视图的公交查询必须使用窄范围、恢复站点线路关系并在临时失败后自动重试");

for (const script of ["app.js", "_worker.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(site, script)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${script} 语法检查失败：${result.stderr}`);
}

const workerTest = spawnSync(process.execPath, [path.join(root, "scripts", "test-worker.mjs")], {
  encoding: "utf8",
});
assert.equal(workerTest.status, 0, `Worker 接口测试失败：${workerTest.stderr || workerTest.stdout}`);
const terrainTest = spawnSync(process.execPath, [path.join(root, "scripts", "test-terrain-loading.mjs")], {
  encoding: "utf8",
});
assert.equal(terrainTest.status, 0, `山体加载回归测试失败：${terrainTest.stderr || terrainTest.stdout}`);
const terrainPreloadTest = spawnSync(process.execPath, [path.join(root, "scripts", "test-terrain-preload.mjs")], {
  encoding: "utf8",
});
assert.equal(terrainPreloadTest.status, 0,
  `地形发布快照回归测试失败：${terrainPreloadTest.stderr || terrainPreloadTest.stdout}`);

console.log(JSON.stringify({
  status: "passed",
  release: release.releaseVersion,
  productionFiles: files.length,
  manifestEntries: manifest.size,
}, null, 2));
