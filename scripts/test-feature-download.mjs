import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import worker, {featureDataQuery} from "../site/_worker.js";

const moduleSource=await readFile(new URL("../site/feature-data.js",import.meta.url),"utf8");
const exportSource=await readFile(new URL("../site/map-export.js",import.meta.url),"utf8");
const app=await readFile(new URL("../site/app.js",import.meta.url),"utf8");
const context=vm.createContext({TextEncoder,Blob,Map,Set,AbortController,URLSearchParams,structuredClone});
context.window=context;vm.runInContext(moduleSource,context);
vm.runInContext(exportSource,context);
const F=context.HuayuFeatures;
const nodes=[[0,0],[4,0],[4,4],[0,4],[1,1],[2,1],[2,2],[1,2],[6,6]].map(([lon,lat],i)=>({type:"node",id:i+1,lon,lat}));
nodes[8].tags={amenity:"bench",name:"=测试长椅"};
const elements=[...nodes,{type:"way",id:10,nodes:[1,2,3],tags:{highway:"residential",name:"测试路"}},
  {type:"way",id:11,nodes:[3,4,1]}, {type:"way",id:12,nodes:[5,6,7,8,5]},
  {type:"relation",id:20,tags:{type:"multipolygon",building:"yes",name:"测试楼"},members:[
    {type:"way",ref:10,role:"outer"},{type:"way",ref:11,role:"outer"},{type:"way",ref:12,role:"inner"}]}];
const original=JSON.stringify(elements);
const data=F.decode({elements,rootKeys:["way/10","relation/20","node/9"],fetchedAt:"2026-10-15T00:00:00Z"});
assert.equal(data.unresolved.length,0);
const road=data.features[0],building=data.features[1],bench=data.features[2];
assert.equal(road.geometry.type,"LineString");assert.equal(bench.geometry.type,"Point");
assert.equal(building.geometry.coordinates[0].length,2);
assert.equal(F.contains(building.geometry,[1.5,1.5]),false,"孔洞内不得误选为建筑");
assert.equal(F.rank(data.features,[3,2],30)[0].id,"relation/20");
const mask=(min,max)=>({geometry:{type:"Polygon",coordinates:[[[min,min],[max,min],[max,max],[min,max],[min,min]]]}});
assert.equal(F.intersects(building.geometry,[mask(1.2,1.8)]),false,"全在孔洞内的范围不选中外部建筑");
assert.equal(F.intersects(road.geometry,[{geometry:{type:"Polygon",coordinates:[[[1,-1],[2,-1],[2,1],[1,1],[1,-1]]]}}]),true,"道路穿过范围即选中且不截断");
const selectedRoad=F.entry(data,road),selectedBuilding=F.entry(data,building);
assert.deepEqual(Array.from(selectedRoad.elements,e=>`${e.type}/${e.id}`).sort(),["node/1","node/2","node/3","way/10"]);
const xml=F.osm([selectedRoad]);
assert.ok(xml.includes('<nd ref="1"/><nd ref="2"/><nd ref="3"/>'));
assert.ok(!xml.includes('id="9"')&&!xml.includes('<relation'),"OSM 不得夹带未选择的附近物体");
assert.ok(F.osm([selectedBuilding]).includes('role="inner"'));
assert.equal(F.osm([selectedBuilding,selectedRoad]).split('<way id="10"').length,2,"共享成员去重");
assert.equal(JSON.stringify(elements),original,"解析、选中及导出不得改写原始数据");
assert.ok(F.csv([bench]).includes("'=测试长椅"));
assert.throws(()=>F.entry({...data,elementIndex:null,elements:elements.filter(e=>e.id!==2)},road),/缺少/u);
assert.equal(F.decode({elements:elements.filter(e=>e.id!==11),rootKeys:["relation/20"]}).unresolved.length,1);
assert.throws(()=>F.decode({elements,rootKeys:[],remark:"timeout"}),/不完整/u);
assert.equal(F.matches({"building:part":"yes"},"building"),true);
assert.equal(F.matches({"building:material":"brick"},"custom",{tag:"building:material",value:"brick"}),true);
assert.equal(F.matches({power:"tower"},"all"),true);
const education=F.downloadFilters("amenity",{subtype:"education",name:"临川"});
assert.equal(F.matchesFilters({amenity:"university",name:"临川大学"},education),true);
assert.equal(F.matchesFilters({amenity:"hospital",name:"临川大学医院"},education),false,"名称不能把医院变成学校");
assert.equal(F.matchesFilters({amenity:"university",name:"津州大学"},education),false);
assert.equal(F.matchesFilters({amenity:"university","name:en":"LINCHUAN University"},F.downloadFilters("amenity",{subtype:"education",name:"linchuan"})),true);
assert.equal(F.matchesFilters({amenity:"school",alt_name:"临川书院"},education),true);
assert.equal(F.matchesFilters({amenity:"university",name:"临川大学"},F.downloadFilters("amenity",{name:"临川",nameMode:"exact"})),false);
assert.equal(F.matchesFilters({amenity:"university",official_name:"临川大学"},F.downloadFilters("amenity",{name:"临川大学",nameMode:"exact"})),true);
assert.equal(F.matchesFilters({"building:part":"apartments"},F.downloadFilters("building",{subtype:"residential"})),true);
assert.equal(F.matchesFilters({highway:"motorway_link"},F.downloadFilters("road",{subtype:"motorway"})),true);
assert.equal(F.matchesFilters({office:"government",name:"临川办事处"},F.downloadFilters("amenity",{subtype:"office",name:"临川"})),true);
assert.equal(F.matchesFilters({office:"no"},F.downloadFilters("amenity",{subtype:"office"})),false);
assert.equal(F.matchesFilters({building:"yes",name:"校舍"},F.downloadFilters("building",{subtype:"education"})),false,"未标用途的建筑不按名称猜测细分类");
assert.equal(F.matchesFilters({power:"tower",name:"A+B[1].*"},F.downloadFilters("custom",{tag:"power",value:"tower",name:"A+B[1].*"})),true);
assert.throws(()=>F.downloadFilters("road",{subtype:"education"}),/细分类/u);
assert.throws(()=>F.downloadFilters("all",{name:"x".repeat(101)}),/100/u);
const mixed=F.decode({elements:[...elements,{type:"relation",id:30,tags:{type:"route",route:"bus"},members:[{type:"way",ref:10,role:""},{type:"node",ref:9,role:"stop"}]}],rootKeys:["relation/30"]});
assert.equal(mixed.features[0].geometry.type,"GeometryCollection");
assert.equal(F.flattenFeatures(mixed.features).length,2,"混合关系的站点和线段都保留");
assert.equal(F.entry(mixed,mixed.features[0]).elements.length,6);
const query=parameters=>featureDataQuery(new URL(`https://local/api/features?${new URLSearchParams(parameters)}`));
for(const params of [{mode:"object",type:"way",id:"1;out;"},{mode:"pick",lat:0,lon:0,radius:500},
  {mode:"area",south:0,west:0,north:3,east:3,kind:"all"},{mode:"area",south:0,west:0,north:.01,east:.01,kind:"custom",tag:'x"]'}])assert.throws(()=>query(params));
assert.ok(query({mode:"area",south:0,west:0,north:.01,east:.01,kind:"custom",tag:"name",value:'a"b'}).includes('"a\\"b"'));
const areaFilters=filters=>({mode:"area",south:0,west:0,north:.01,east:.01,...filters,detail:JSON.stringify(filters.detail)});
const filteredQuery=query(areaFilters(education));
assert.ok(filteredQuery.includes('["amenity"~"^(school|university|college|kindergarten|research_institute)$"]'));
assert.ok(filteredQuery.includes('临川')&&filteredQuery.includes('official_name'),"名称筛选须在上游查询中应用，不能截取大类前 2000 个再筛选");
const escapedName='A+B[1].*"\\';
const escapedPattern=escapedName.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
assert.ok(query(areaFilters(F.downloadFilters("all",{name:escapedName,nameMode:"exact"}))).includes(JSON.stringify(`^${escapedPattern}$`)),"名称特殊字符按普通文字转义，不能注入查询或正则表达式");
for(const invalid of [{detail:'{"tag":"amenity"}'},{detail:JSON.stringify([{tag:'x"]',values:[]}])},
  {detail:JSON.stringify([{tag:"amenity",values:[1]}])},{name:"x".repeat(101)},{name:"bad\nname"},{nameMode:"regex"}])assert.throws(()=>query({mode:"area",south:0,west:0,north:.01,east:.01,kind:"all",...invalid}));
for(const [kind,subtypes]of Object.entries(F.subtypes)) {
  assert.equal(new Set(subtypes.map(s=>s.id)).size,subtypes.length,"每一大类的细分类编号唯一");
  for(const subtype of subtypes) {
    const filters=F.downloadFilters(kind,{subtype:subtype.id});
    assert.doesNotThrow(()=>query(areaFilters(filters)),`${kind}/${subtype.id} 上游参数必须有效`);
    const example=subtype.conditions[0],tags={[example.tag]:example.values[0]||"company"};
    // Each known subtype's representative tags must still satisfy its parent type.
    assert.equal(F.matchesFilters(tags,filters),true,`${kind}/${subtype.id}`);
  }
}
const savedFetch=globalThis.fetch;
try {
  let upstreamCount=0;
  globalThis.fetch=async()=>{upstreamCount++;return Response.json({elements:[{type:"count",tags:{total:"1"}},elements[9],...nodes]});};
  const request=params=>worker.fetch(new Request(`https://local/api/features?${new URLSearchParams(params)}`),{},{});
  assert.equal((await request({mode:"object",type:"way",id:"invalid"})).status,400);assert.equal(upstreamCount,0);
  const response=await request({mode:"object",type:"way",id:10});
  assert.equal(response.status,200);const payload=await response.json();
  assert.deepEqual(payload.rootKeys,["way/10"]);assert.ok(Date.parse(payload.fetchedAt));
  for(const failure of [{elements:[{type:"count",tags:{total:"2001"}}]}, {elements:[{type:"count",tags:{total:"2"}},elements[9]]},
    {remark:"timeout",elements:[]}]) {
    globalThis.fetch=async()=>Response.json(failure);
    assert.ok([413,502].includes((await request({mode:"object",type:"way",id:10})).status));
  }
} finally {globalThis.fetch=savedFetch;}

const control=(value="")=>({value,disabled:false,hidden:false,textContent:"",querySelector(){return null;},replaceChildren(){},appendChild(){}});
const controls={featureExportFormat:control("shp"),featureExportStatus:control(),featureQueueHeading:control(),featureQueueList:control(),
  featureClearQueue:control(),featureExportButton:control(),featureReadRange:control(),featureAddResults:control(),featureQueryResults:control(),featureQueryStatus:control(),
  featureKind:control("building"),featureTag:control(),featureTagValue:control(),featureOpenQueue:control(),
  featureSubtype:control(),featureName:control(),featureNameMode:control("contains")};
Object.assign(controls,{featureOutputOptions:control(),featureImageOptions:control(),featureImageStyle:control("map"),
  featureImageBackground:control("transparent"),featureImageResolution:control("1200"),featureImageCustom:control("3600"),
  featureImageCustomLabel:control(),featureImageLabels:{checked:true},featureImageNote:control()});
const downloads=[],queue=new Map();
Object.assign(context,{elements:controls,featureDownloadQueue:queue,document:{createElement:()=>({append(){},addEventListener(){}})},
  setStatus:(_,message,error)=>{if(error)throw Error(message);},showToast:()=>{},downloadBlob:(blob,name)=>downloads.push({blob,name}),
  featureExportBusy:false,administrativeExportBusy:false,updateAdministrativeExportAvailability:()=>{},
  featureRangeSequence:0,featureRangeController:null,featureRangeResult:null});
for(const name of ["activeAdministrativeFeatureBounds","encodeAdministrativeShapefileLayer","administrativeShapeRecord","sameAdministrativeCoordinate",
  "administrativeSignedArea","encodeAdministrativeShapeContent","writeShapefileHeader","encodeAdministrativeDbf","encodeDbfText","administrativeLevelLabel",
  "buildStoredZip","crc32","featureObjectRow","addFeatureDownloadEntries","renderFeatureDownloadQueue","featureImageSettings","downloadFeatureQueue","buildFeatureDownload","renderFeatureDownloadImage","invalidateFeatureRange","readFeatureDownloadRange"]) {
  const source=app.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`,"u"))?.[0];assert.ok(source,name);vm.runInContext(source,context);
}
context.addFeatureDownloadEntries([selectedRoad,selectedBuilding,F.entry(data,bench),selectedRoad]);
assert.equal(queue.size,3);
context.addFeatureDownloadEntries(Array.from({length:2001},(_,index)=>({...selectedRoad,feature:{...road,id:`way/${1000+index}`}})));
assert.equal(queue.size,3,"超限批次必须整体拒绝并保留原清单");
const lineEntries=context.encodeAdministrativeShapefileLayer([road],"lines",3);
const shp=lineEntries.find(e=>e.name==="lines.shp").data;
const view=new DataView(shp.buffer,shp.byteOffset,shp.byteLength);
assert.equal(view.getInt32(32,true),3);assert.equal(view.getInt32(108,true),3);
assert.equal(view.getInt32(148,true),3,"线 SHP 保留所有顶点");
await context.downloadFeatureQueue();assert.equal(downloads[0].name.endsWith(".zip"),true);
const zipText=new TextDecoder().decode(await downloads[0].blob.arrayBuffer());
for(const name of ["points.shp","lines.shp","polygons.shp","objects.geojson","attributes.csv"])assert.ok(zipText.includes(name),name);
for(const format of ["geojson","osm","csv"]) {controls.featureExportFormat.value=format;await context.downloadFeatureQueue();}
const downloadedJSON=JSON.parse(await downloads[1].blob.text());
assert.equal(downloadedJSON.features.length,3);assert.equal(downloadedJSON.features[1].properties.tags.building,"yes");
assert.equal(queue.size,3,"下载后保留清单供其他格式下载");

// Full extents, including collections and every multipolygon part, drive fitting.
const multi={...building,id:"derived/multi",geometry:{type:"MultiPolygon",coordinates:[building.geometry.coordinates[0],
  [[[10,10],[11,10],[11,11],[10,11],[10,10]]]]}};
const allImages=[road,bench,multi,mixed.features[0]];
const imageBefore=JSON.stringify(allImages),M=context.HuayuMapExport;
for(const size of [512,800,1200,2400,8192]) {
  const layout=M.featureLayout(allImages,size);
  assert.equal(Math.max(layout.width,layout.height),size);
  for(const coordinate of [[0,0],[11,11],[6,6]]) {
    const [x,y]=layout.project(coordinate);
    assert.ok(x>0&&x<layout.width&&y>0&&y<layout.height,"full objects are inside the image, never cut at query bounds");
    const mercatorX=coordinate[0]*Math.PI*6378137/180;
    const mercatorY=Math.log(Math.tan(Math.PI/4+coordinate[1]*Math.PI/360))*6378137;
    assert.ok(Math.abs(layout.geoReference.tieLon+x*layout.geoReference.pixelScaleX-mercatorX)<1e-7);
    assert.ok(Math.abs(layout.geoReference.tieLat-y*layout.geoReference.pixelScaleY-mercatorY)<1e-7,"pixel reference agrees with draw projection");
  }
}
for(const feature of [bench,{...road,geometry:{type:"LineString",coordinates:[[0,0],[0,4]]}}]) {
  const layout=M.featureLayout([feature],800);assert.ok(layout.width>=240&&layout.height>=240,"single points/straight lines retain space for symbols and attribution");
}
assert.throws(()=>M.featureLayout([bench],511));
assert.throws(()=>M.featureLayout([{geometry:{type:"Point",coordinates:[0,89]}}]));
assert.throws(()=>M.featureLayout([{geometry:{type:"MultiPoint",coordinates:[[-179,0],[179,0]]}}]),/180/);
const fills=[],strokes=[],texts=[];
const ctx=new Proxy({fill(rule){fills.push(rule);},stroke(){strokes.push(this.strokeStyle);},fillText(text){texts.push(text);},measureText:()=>({width:40})},
  {get:(target,key)=>key in target?target[key]:()=>{}});
const canvas={width:1200,height:1200,getContext:()=>ctx};
const layout=M.featureLayout(allImages,1200);
for(const style of ["map","night","blueprint","monochrome"])M.drawFeatures(canvas,allImages,layout,{style,labels:false,background:"transparent"});
assert.ok(fills.filter(rule=>rule==="evenodd").length>=8,"holes stay empty in each polygon part, in every style");
assert.ok(new Set(strokes).size>=4,"render styles produce distinct actual strokes");assert.equal(texts.length,0,"labels toggle is respected");
assert.equal(JSON.stringify(allImages),imageBefore,"rendering must not rewrite geometry or source tags");

// A map task shares the list, but is never inserted into object OSM/GeoJSON.
controls.featureExportFormat.value="osm";
const mapEntry={id:"map/test",elements:[],mapExport:{title:"范围 A",format:"png",options:{resolution:800},features:[]}};
let builtMaps=0;
context.buildAdministrativeDownload=async job=>{builtMaps++;assert.equal(job.title,"范围 A");return {blob:new Blob(["map-image"]),name:"地图.png",message:"完成",warning:false};};
context.addFeatureDownloadEntries([mapEntry,mapEntry]);assert.equal(queue.size,4);
mapEntry.mapExport.title="后来修改的范围";
assert.equal(queue.get("map/test").mapExport.title,"范围 A","queued map settings are immutable snapshots");
const mixedStart=downloads.length;await context.downloadFeatureQueue();
assert.equal(builtMaps,1);assert.match(downloads.at(-1).name,/下载清单.zip$/);
const archive=new TextDecoder().decode(await downloads.at(-1).blob.arrayBuffer());
for(const text of ["地图.png",".osm","download-list.json","<way id=\"10\"","范围 A"])assert.ok(archive.includes(text),text);
assert.ok(!archive.includes('<node id="map/'),"map bounds must not be fabricated as OSM objects");
assert.equal(downloads.length,mixedStart+1,"mixed export downloads one ZIP");
const preserved=JSON.stringify([...queue]);
context.addFeatureDownloadEntries(Array.from({length:10},(_,i)=>({...mapEntry,id:`map/${i}`})));
assert.equal(JSON.stringify([...queue]),preserved,"map batch limit rejects atomically");
let lastError="";context.setStatus=(_,message,error)=>{if(error)lastError=message;};
context.buildAdministrativeDownload=async()=>{throw Error("模拟背景下载失败");};
const failedStart=downloads.length;await context.downloadFeatureQueue();
assert.equal(downloads.length,failedStart);assert.match(lastError,/清单已保留/);
assert.equal(JSON.stringify([...queue]),preserved);assert.equal(context.featureExportBusy,false,"failure releases export lock");
// Changes during a pending map render apply only to a future batch.
let releaseMap,exportedBatch;
const realBuild=context.buildFeatureDownload;
context.buildAdministrativeDownload=()=>new Promise(resolve=>{releaseMap=()=>resolve({blob:new Blob(["map"]),name:"map.png"});});
context.buildFeatureDownload=async(entries,format,settings)=>{
  exportedBatch={entries,format,settings};return {blob:new Blob(["objects"]),name:"objects.png"};
};
controls.featureExportFormat.value="png";controls.featureImageStyle.value="blueprint";
const exporting=context.downloadFeatureQueue();
controls.featureExportFormat.value="csv";controls.featureImageStyle.value="night";
queue.get("way/10").feature.properties.name="下载期间更改的名称";
releaseMap();await exporting;
assert.equal(exportedBatch.format,"png");assert.equal(exportedBatch.settings.style,"blueprint");
assert.equal(exportedBatch.entries.find(e=>e.feature.id==="way/10").feature.properties.name,"测试路");
context.buildFeatureDownload=realBuild;
queue.get("way/10").feature.properties.name="测试路";
queue.delete("map/test");
// Incomplete image backgrounds reject export and release the offscreen canvas.
const failedCanvas={width:1200,height:1200};
context.renderAdministrativeBasemapCanvas=async()=>({canvas:failedCanvas,missingTiles:1});
await assert.rejects(context.renderFeatureDownloadImage([road],"png",{background:"carto",resolution:1200,style:"map"},"test"),/背景瓦片/);
assert.equal(failedCanvas.width,0);assert.equal(failedCanvas.height,0);

// A late response after changing range must never replace the current result or queue.
let finish;
Object.assign(context,{featureDownloadMask:()=>[mask(0,4)],fetchMapFeatureData:()=>new Promise(resolve=>{finish=resolve;}),updateFeatureDownloadMode:()=>{}});
const pending=context.readFeatureDownloadRange();context.invalidateFeatureRange();finish(data);await pending;
assert.equal(context.featureRangeResult,null);assert.equal(queue.size,3);
assert.ok(app.includes('glMap.on("click", handleVectorObjectClick)')&&app.includes('glMap?.off?.("click", handleVectorObjectClick)'));
console.log("Feature downloads passed: real point/line/polygon geometry, holes, range intersection, picking rank, isolated OSM dependencies, original refs/tags, mixed SHP/GeoJSON/CSV, validation, atomic batches and stale request cancellation.");
