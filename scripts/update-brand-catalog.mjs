import {readFile, writeFile, rename, unlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import "../site/brand-data.js";

const {aggregate, validateCatalog, namedFacility, namedFacilityQuery, recognizeBrands} = globalThis.HuayuBrandData;
const endpoint = "https://overpass.opengeofiction.net/api/interpreter";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "site/brand-catalog.json");
const MAX_ELEMENTS = 200000;

export function catalogQuery(kind, type = "nwr") {
  if (!["brand", "operator", "name"].includes(kind)) throw Error("INVALID_KIND");
  if (!["node", "way", "rel", "nwr"].includes(type)) throw Error("INVALID_TYPE");
  // Keep the supplied directory's operator scope: tagged facilities, rather than every power/network object.
  const select = kind === "operator"
    ? `(${["shop", "amenity", "tourism", "office", "craft", "leisure", "healthcare", "public_transport"]
      .map(key => `${type}["operator"]["${key}"];`).join("")})`
    : kind === "name" ? namedFacilityQuery(type) : `${type}["brand"]`;
  return `[out:json][timeout:100][maxsize:134217728];${select}->.matches;.matches out count;.matches out tags ${MAX_ELEMENTS};`;
}
export function completeElements(payload, kind) {
  const count = Number(payload?.elements?.[0]?.tags?.total);
  if (payload?.remark || payload?.elements?.[0]?.type !== "count" || !Number.isSafeInteger(count)
    || count < (kind === "name" ? 0 : 1) || count > (kind === "name" ? MAX_ELEMENTS * 3 : MAX_ELEMENTS)
    || payload.elements.length !== count + 1) throw Error(`INCOMPLETE_${kind}_CATALOG`);
  const elements = payload.elements.slice(1);
  if (new Set(elements.map(element => `${element.type}/${element.id}`)).size !== count
    || elements.some(element => !["node", "way", "relation"].includes(element.type)
      || !Number.isSafeInteger(element.id) || element.id <= 0 || (kind === "name" ? !element.tags || "brand" in element.tags
        || !namedFacility(element.tags) : typeof element.tags?.[kind] !== "string"))) throw Error(`INVALID_${kind}_ELEMENTS`);
  return elements;
}
export function buildBrandCatalog(brandPayload, operatorPayload, previous, now = new Date().toISOString(), namePayload = null) {
  const explicit = completeElements(brandPayload, "brand");
  const named = namePayload ? completeElements(namePayload, "name") : [];
  const all = aggregate(recognizeBrands([...explicit, ...named]), "brand");
  // Single independent shops stay discoverable in city/view queries; the world
  // directory only indexes repeated unknown names, without calling them brands.
  const brands = all.filter(entry => !entry.candidate || entry.count >= 2).map(entry => {
    const compact = {...entry};
    if (!entry.namedCount) delete compact.sourceCategories;
    for (const key of ["operators", "brands", "branches", "cities", "names", "aliases"]) {
      if (!compact[key].length) delete compact[key];
    }
    return compact;
  });
  const operators = aggregate(completeElements(operatorPayload, "operator"), "operator");
  if (previous && (brands.filter(entry => !entry.candidate).length < previous.brands.filter(entry => !entry.candidate).length * .6
    || operators.length < previous.operators.length * .6
    || previous.nameCoverage && named.length < previous.nameCoverage.elements * .6)) throw Error("CATALOG_SHRINK_REQUIRES_REVIEW");
  const timestamps = [brandPayload, operatorPayload, ...(namePayload ? [namePayload] : [])].map(payload => payload.osm3s?.timestamp_osm_base || null);
  const dbTimestamp = timestamps.every(value => Number.isFinite(Date.parse(value))) ? timestamps.sort()[0] : null;
  return validateCatalog({schema: "huayu-brand-catalog-v1", generatedAt: now, dbTimestamp,
    source: endpoint, recognitionVersion: namePayload ? 1 : 0,
    ...(namePayload ? {nameCoverage: {elements: named.length, candidateMinimum: 2,
      omittedSingleNames: all.filter(entry => entry.candidate && entry.count < 2).length}} : {}),
    provenance: "独立品牌目录更新器；品牌标签、明确商业设施名称及设施范围内运营者的完整查询。",
    coverage: `${namePayload ? "品牌包含标签标注及名称识别；全域另收录至少两个要素同名的待确认店名，不混入品牌总数；单独店名可在城市／视野发现。" : "品牌按 brand 标签聚合；本快照尚未补读店名。"}运营者仅收录商店、公共设施、旅游、办公、手工、休闲、医疗与公共交通设施。计数为地图要素，非核实门店总量；城市、分店和名称列表为样本。`,
    attribution: "© OpenGeofiction contributors · ODbL", brands, operators});
}
export async function replaceBrandCatalog(file, candidate) {
  validateCatalog(candidate);
  const body = JSON.stringify(candidate);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw Error("CATALOG_TOO_LARGE");
  const temporary = `${file}.${process.pid}.pending`;
  try {
    await writeFile(temporary, body, {flag: "wx"});
    validateCatalog(JSON.parse(await readFile(temporary, "utf8")));
    await rename(temporary, file);
  } finally {await unlink(temporary).catch(error => {if (error.code !== "ENOENT") throw error;});}
}
async function fetchCatalogPart(kind, type) {
  const response = await fetch(endpoint, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams({data: catalogQuery(kind, type)}), signal: AbortSignal.timeout(130000)});
  if (!response.ok) throw Error(`CATALOG_HTTP_${response.status}`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.length; if (size > 64 * 1024 * 1024) throw Error("CATALOG_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(() => {});}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function fetchCatalog(kind) {
  const parts = [];
  for (const type of ["node", "way", "rel"]) {
    console.log(`Reading ${kind}/${type}…`);
    const payload = await fetchCatalogPart(kind, type);
    // Zero elements in a single geometry class is valid; the complete catalog cannot be empty.
    const elements = payload?.elements?.[0]?.type === "count" && Number(payload.elements[0].tags?.total) === 0 && !payload.remark
      && payload.elements.length === 1 ? [] : completeElements(payload, kind);
    if (elements.some(element => element.type !== (type === "rel" ? "relation" : type))) throw Error("INVALID_CATALOG_PART");
    parts.push({...payload, elements});
    console.log(`Validated ${kind}/${type}: ${elements.length} mapped elements`);
  }
  const elements = parts.flatMap(part => part.elements), timestamps = parts.map(part => part.osm3s?.timestamp_osm_base || null);
  return {elements: [{type: "count", tags: {total: String(elements.length)}}, ...elements],
    osm3s: {timestamp_osm_base: timestamps.every(value => Number.isFinite(Date.parse(value))) ? timestamps.sort()[0] : null}};
}
async function main() {
  const previous = validateCatalog(JSON.parse(await readFile(output, "utf8")));
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({brands: previous.brands.filter(entry => !entry.candidate).length,
      candidates: previous.brands.filter(entry => entry.candidate).length, operators: previous.operators.length,
      generatedAt: previous.generatedAt, dbTimestamp: previous.dbTimestamp}));
    return;
  }
  // Nine bounded geometry queries; only a complete generation replaces the directory.
  const brandPayload = await fetchCatalog("brand");
  const operatorPayload = await fetchCatalog("operator");
  const namePayload = await fetchCatalog("name");
  const candidate = buildBrandCatalog(brandPayload, operatorPayload, previous, new Date().toISOString(), namePayload);
  await replaceBrandCatalog(output, candidate);
  console.log(JSON.stringify({brands: candidate.brands.filter(entry => !entry.candidate).length,
    candidates: candidate.brands.filter(entry => entry.candidate).length, operators: candidate.operators.length,
    generatedAt: candidate.generatedAt, dbTimestamp: candidate.dbTimestamp}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(`品牌目录更新失败；保留原有完整目录：${error.message}`); process.exitCode = 1;});
}
