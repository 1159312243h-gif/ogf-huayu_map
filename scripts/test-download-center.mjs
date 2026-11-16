import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/download-center.js", import.meta.url), "utf8");
const context = vm.createContext({Blob, CustomEvent, URL, setTimeout, MutationObserver: undefined, document: undefined});
vm.runInContext(source, context);
const center = context.HuayuDownloadCenter;
const artifact = center.tableArtifact({id:"brand-catalog",title:"品牌目录",filename:"津川品牌",source:"品牌目录快照",
  sourceTime:"2026-11-16T00:00:00Z",columns:[{key:"name",label:"品牌"},{key:"branches",label:"分店"}],
  rows:[{name:"甲,乙",branches:4},{name:'丙 "丁"',branches:2}]});
const csv = await artifact.blob.text();
assert.equal(artifact.name,"津川品牌.csv");
assert.match(csv,/品牌,分店/u);
assert.match(csv,/"甲,乙",4/u);
assert.match(csv,/"丙 ""丁""",2/u);
assert.match(csv,/数据来源,源数据时间,导出时间,导出说明/u);
assert.match(csv,/品牌目录快照,2026-11-16T00:00:00Z,/u);
assert.equal(artifact.source,"品牌目录快照");
assert.equal(artifact.sourceTime,"2026-11-16T00:00:00Z");
assert.match(artifact.warning,/^$/u);
const image = center.imageArtifact({id:"route-atlas",title:"线路图",filename:"津川线路图.png",blob:new Blob(["png"]),source:"线路图绘制"});
assert.equal(image.kind,"image");
assert.equal(image.blob.size,3);
const documentFile = center.fileArtifact({id:"selected-object",title:"所选物体",filename:"所选物体.geojson",
  blob:new Blob(["{}"],{type:"application/geo+json"}),kind:"table",source:"当前选中物体"});
assert.equal(documentFile.kind,"table");
assert.match(documentFile.name,/\.geojson$/u);
const formula = center.tableArtifact({id:"formula",title:"公式安全",columns:["name"],rows:[["=1+1"],["-2"],[ -2 ]]});
assert.match(await formula.blob.text(),/'=1\+1/u);
assert.match(await formula.blob.text(),/'-2,未提供,/u,"string labels are protected without converting numeric negatives");
assert.match(await formula.blob.text(),/\r\n-2,未提供,/u,"numeric negative values remain numeric");
assert.throws(()=>center.imageArtifact({filename:"empty.png",blob:"not-a-blob"}),/文件尚未生成/u);

const emitted=[];
context.dispatchEvent=event=>{emitted.push(event.detail);return true;};
center.add(artifact);
assert.equal(emitted.length,1);
assert.equal(emitted[0].id,artifact.id);
context.dispatchEvent=event=>{event.preventDefault();return false;};
assert.throws(()=>center.add(documentFile),/数量或容量上限/u,"refused queue entries report their failure to the caller");

const domSource = await readFile(new URL("../site/download-center.js", import.meta.url), "utf8");
assert.match(domSource,/querySelectorAll\?\.\("table"\)/u,"new semantic tables are auto-enhanced");
assert.match(domSource,/data-export-private/u,"sensitive tables can opt out");
assert.match(domSource,/tableSnapshot\(table\)/u,"semantic tables export their current rows at click time");
console.log("Download center passed: CSV escaping, provenance, images, shared queue event and automatic semantic-table actions.");
