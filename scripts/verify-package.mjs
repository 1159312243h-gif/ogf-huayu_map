import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  "transit-preload.json", "transit-relations.json", "station-access.json", "railway-routing.json"]) {
  assert.ok(manifest.has(required), `缺少生产文件：${required}`);
}

const index = await fs.readFile(path.join(site, "index.html"), "utf8");
const app = await fs.readFile(path.join(site, "app.js"), "utf8");
const worker = await fs.readFile(path.join(site, "_worker.js"), "utf8");
assert.ok(index.includes(release.entryScript), "index.html 未引用 release.json 指定的应用版本");
assert.ok(app.includes(`\"huayu:model-version\": \"${release.expectedBuildingModel}\"`), "建筑模型版本不一致");
assert.ok(app.includes(`HUAYU_LIVE_BUILDING_MIN_ZOOM = ${release.expectedBuildingMinZoom}`), "建筑起始缩放级别不一致");
assert.ok(worker.includes(`new Set([${release.expectedBuildingTileZooms.join(", ")}])`), "Worker 建筑分片级别不一致");
assert.ok(worker.includes(`BUILDING_CACHE_SECONDS = ${release.expectedBuildingCacheSeconds}`),
  "Worker 建筑缓存周期不一致");
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
assert.equal((app.match(/state\.timer && state\.timerRunAt <= nextRunAt/g) || []).length, 2,
  "客户端实时底图和建筑必须保留更早的刷新任务");
assert.ok(app.includes("const readyKeys = keys.filter((key) => state.tileCache.has(key))")
  && app.includes('state.status = complete ? (idle ? "ready" : "refreshing") : "partial"')
  && app.includes("[...state.visibleTileKeys].every((key) => state.tileCache.has(key))")
  && app.includes("scheduleHuayuLiveBuildingCoverageFinalize(state)"),
"建筑分片必须渐进显示，并在完整覆盖前保留矢量兜底");
assert.ok(app.includes("return clamp(Math.floor(glMap.getZoom()) + 1"),
  "建筑必须保留比底图细一级的分片，避免密集城区大分片阻塞");
assert.ok(app.includes("visibleTileSignature")
  && app.includes("const visibleTilesChanged = nextVisibleTileSignature !== state.visibleTileSignature")
  && app.includes("if (visibleTilesChanged) mergeHuayuLiveBuildingTiles(state)"),
"建筑倾斜视角必须复用未变化的可视瓦片集合，避免滚轮每步重复合并");
assert.ok(app.includes("Do not invalidate the displayed model")
  && app.includes("if (!state.dataReady) {")
  && app.includes("syncHuayuLiveBuildingPrimaryLayers(state.glMap, state, true);"),
"建筑新覆盖加载期间必须保留上一帧模型，不得清空实时源造成闪烁");
assert.ok(app.includes("const HUAYU_WALL_MIN_ZOOM = HUAYU_LIVE_BUILDING_MIN_ZOOM")
  && (app.match(/minzoom: HUAYU_WALL_MIN_ZOOM/g) || []).length === 6
  && app.includes('[[10, 0.45], [15, 1.1]')
  && app.includes('[[10, 0.35], [16, 0.8]'),
"普通墙与栅栏必须和建筑模型使用相同起始比例尺，并在远景使用克制线宽");
assert.ok(app.includes('way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;')
  && worker.includes('way["barrier"~"^(wall|fence)$"](${bbox})->.barrierWays;')
  && app.includes("wallData: huayuWallFeatureCollection(result.payload.elements)")
  && app.includes("const nextWallData = { type: \"FeatureCollection\", features: wallFeatures };")
  && worker.includes('schema", "huayu-building-v5"')
  && !app.includes("function refreshHuayuWalls")
  && !app.includes("glMap.getZoom() < 14.75"),
"墙和栅栏必须复用建筑分片与缓存，不得恢复近景独立大范围查询");
assert.ok(app.includes("function positionHuayuWallsAboveBuildings(glMap)")
  && app.includes("positionHuayuWallsAboveBuildings(glMap);")
  && app.includes('glMap.setLayoutProperty(layerId, "visibility", "visible")')
  && app.includes("huayuWallSegmentPolygons(coordinates, width, fence ? 0.12 : 0.2)")
  && app.includes("if (complete || !state.wallDataReady)")
  && app.includes('"retained-complete"')
  && app.includes("wallRenderSignature"),
"墙和栅栏在透视视角必须保留轮廓、位于建筑之上，并原子切换完整分片快照");
assert.ok(app.includes('ancientKind,')
  && app.includes('HUAYU_ANCIENT_BUILDING_LAYERS')
  && app.includes('"huayu:component": "ancient-building-roof-cap"')
  && app.includes('"huayu:component": "ancient-building-outline"')
  && app.includes('building:architecture')
  && worker.includes('ancientWays')
  && worker.includes('ancientArchitectureWays'),
"古建筑必须从当前 OGF 标签查询并使用独立屋顶压檐和轮廓层");
assert.ok(app.includes("source: HUAYU_LIVE_BASEMAP_SOURCE")
  && app.includes("function huayuLiveBasemapPolygonSignature"),
  "体育场详细面和嵌套子场地必须使用实时底图主数据源");
assert.ok(app.includes('runningOverview: "ogf-atlas-huayu-sports-running-overview"')
  && app.includes('["==", ["get", "sportsArea"], "running"]')
  && app.includes('maxzoom: 15.25'),
  "跑道必须在小比例尺体育层交接时保留独立实时兜底");
assert.ok(app.includes("function positionHuayuSportsBelowBuildings(glMap)")
  && app.includes('const HUAYU_SPORTS_SOURCE = "ogf-atlas-huayu-sports"')
  && app.includes("function applyHuayuSportsSnapshot(glMap, state)")
  && app.includes('state.activeTier === "fallback"')
  && app.includes("state.sportsRenderSignature === state.renderSignature")
  && app.includes("function syncHuayuSportsSnapshotLayers(glMap, state = huayuLiveBasemapStates.get(glMap))")
  && app.includes("const liveVisible = Boolean(state?.sportsDataReady)")
  && app.includes('state?.primaryActive ? "live" : "retained-live"')
  && app.includes("syncHuayuSportsSnapshotLayers(glMap, state)")
  && app.includes("syncHuayuSportsSnapshotLayers(glMap)"),
"实时操场必须只接收完整快照，透视扩大视野时保留最后完整体育数据并保持在建筑层下方");
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
assert.ok(app.includes('leisure === "park" && ["Polygon", "MultiPolygon"].includes(geometry?.type)')
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
assert.ok(app.includes("const shouldShowLabel = Boolean(stop.name)")
  && app.includes("if (shouldShowLabel && !entry.labelMarker)"),
"公共交通站点标签应按缩放级别延迟创建，避免远景一次性创建全部隐藏标签");
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
  && app.includes("const responses = await Promise.all(requestBounds.map")
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

console.log(JSON.stringify({
  status: "passed",
  release: release.releaseVersion,
  productionFiles: files.length,
  manifestEntries: manifest.size,
}, null, 2));
