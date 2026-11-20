import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import "../site/transit-template-core.js";
import "../site/transit-station-data.js";
import "../site/shared-dataset-core.js";
const T=globalThis.HuayuTransitTemplates,D=globalThis.HuayuDatasetTools;
assert.equal(T.builtins.length,53);
assert.deepEqual(new Set(T.builtins.map(v=>v.template.family)),new Set(Object.keys(T.families)));
const route={...T.demo,demo:false,title:'线路 <script>alert(1)</script>',sourceId:'relation/123',stops:Array.from({length:113},(_,i)=>({name:'站点'+i,nameEn:'Stop '+i,transfers:i%9===0?['换乘 <img onerror="x">']:[]}))};
const snapshot=JSON.stringify(route);
for(const {template} of T.builtins){
  assert.deepEqual(T.parse(JSON.stringify(template)),template);
  const result=T.render(template,route,{current:8});
  assert.match(result.svg,/&lt;script&gt;/u);assert.doesNotMatch(result.svg,/<script|<img|foreignObject|javascript:|<image\s/iu);
  assert.match(result.svg,/非实时到站/u);assert.match(result.svg,/relation\/123/u);
  assert.equal(result.stationCount,113);assert.ok(result.width>0&&result.height>0);
  assert.equal([...result.svg.matchAll(/data-stop-index=/gu)].length,template.family==='bus-rollsign'?0:113);
  if(template.family!=='bus-rollsign'){assert.match(result.svg,/站点112/u);assert.match(result.svg,/Stop 112/u);}
  const records=T.packageRecords(template),normalized=D.normalize(JSON.stringify(records),'json',{kind:'other'});
  assert.deepEqual(T.parse(records),template);assert.deepEqual(T.parse({data:normalized}),template);
  assert.equal(normalized.stats.located,0);assert.equal(normalized.stats.linked,0);
}
assert.equal(JSON.stringify(route),snapshot,'模板不能改写源线路');
const reversed=T.render(T.builtins[4].template,route,{reverse:true,current:0}).svg;
assert.ok(reversed.indexOf('<title>1. 站点112')<reversed.indexOf('<title>2. 站点111'));
assert.match(T.render(T.builtins[0].template,T.demo).svg,/示例线路 · 非真实运营数据/u);
const large=T.normalize({...T.builtins[0].template,title:'长名称模板',sourceUrl:'https://example.com/'+('a'.repeat(1800)),license:'文'.repeat(200),author:'作'.repeat(120)});
const parts=T.packageRecords(large);assert.ok(parts.length>1);assert.ok(parts.every(p=>p.template.length<=1800));
const normalized=D.normalize(JSON.stringify(parts),'json',{kind:'other'});assert.deepEqual(T.parse({data:normalized}),large);
assert.throws(()=>T.parse(parts.slice(1)));assert.throws(()=>T.parse([...parts].reverse()));
assert.throws(()=>T.parse('<svg onload="x"/>'));
for(const bad of [
 {...T.builtins[0].template,script:'run'},
 {...T.builtins[0].template,sourceUrl:'javascript:alert(1)'},
 {...T.builtins[0].template,sourceUrl:'https://user:password@example.com'},
 {...T.builtins[0].template,family:'constructor'},
 {...T.builtins[0].template,style:{...T.builtins[0].template.style,background:'url(https://x)'}},
 {...T.builtins[0].template,style:{...T.builtins[0].template.style,columns:0}},
 {...T.builtins[0].template,style:{...T.builtins[0].template.style,onload:'x'}}
])assert.throws(()=>T.normalize(bad));
assert.throws(()=>T.render(T.builtins[0].template,{stops:[]}));

const buses=T.builtins.filter(v=>v.template.family==='bus-stop');
assert.equal(buses.length,26);
for(const id of ['compact','split','wide','cards','hub','bilingual'])assert.ok(buses.some(t=>t.template.style.busLayout===id));
assert.deepEqual(new Set(buses.map(v=>v.template.style.busLayout)),new Set(Object.keys(T.busLayouts)));
const legacy=JSON.parse(JSON.stringify(buses[0].template));delete legacy.style.busLayout;
assert.equal(T.parse(legacy).style.busLayout,'strip','旧模板必须仍可导入');
const withService={...T.demo,demo:false,service:{hours:'Mo-Fr 05:30-23:00',fare:'2 CNY',operator:'公交 <script>不执行</script>',interval:'12'}};
for(const {template} of buses){
 const missing=T.render(template,T.demo,{current:2});
 assert.equal(missing.stationName,T.demo.stops[2].name);assert.equal(missing.realtime,false);assert.match(missing.svg,/未提供/u);
 assert.match(missing.svg,/开往/u);assert.match(missing.svg,/下一站/u);assert.match(missing.svg,/仅展示当前线路/u);
 assert.match(missing.svg,/本站/u);assert.match(missing.svg,/<path|行驶方向/u);
 const actual=T.render(template,withService,{current:3}),back=T.render(template,withService,{reverse:true,current:3});
 assert.match(actual.svg,/05:30-23:00/u);assert.match(actual.svg,/2 CNY/u);assert.match(actual.svg,/12/u);assert.match(actual.svg,/&lt;script&gt;不执行&lt;\/script&gt;/u);
 assert.equal(back.stationName,T.demo.stops.at(-4).name);assert.match(back.svg,/05:30-23:00/u,'反向不杜撰时刻');
 const unset=T.render(template,withService);assert.equal(unset.stationName,null);assert.match(unset.svg,/请选择本站/u);
 const one=T.render(template,{...T.demo,stops:[{name:'单站'}]},{current:0});assert.equal(one.stationCount,1);assert.match(one.svg,/未提供/u);
 if(['lcd','led','ink'].includes(template.style.busLayout)){
  assert.match(actual.svg,/最近一班/u);assert.match(actual.svg,/后续一班/u);assert.match(actual.svg,/未接入/u);
  assert.doesNotMatch(actual.svg,/\d+\s*分钟/u,'没有到站数据不得生成到站分钟数');
 }
}
assert.throws(()=>T.normalize({...buses[0].template,style:{...buses[0].template.style,busLayout:'constructor'}}));
assert.throws(()=>T.normalize({...T.builtins[4].template,style:{...T.builtins[4].template.style,busLayout:'lcd'}}));


// A shared station identity is mandatory. Names and transfer labels are not evidence.
const stationSnapshot=JSON.stringify(T.demoStation);
for(const {template} of buses){
 const station=T.renderStation(template,T.demoStation);
 assert.equal(station.lineCount,3);assert.equal(station.stationName,'大学城');assert.equal(station.realtime,false);
 assert.equal(station.stationCount,20);assert.equal([...station.svg.matchAll(/data-board-route-index=/gu)].length,3);
 assert.equal([...station.svg.matchAll(/data-stop-index=/gu)].length,20);
 for(const ref of ['demo/28','demo/56','demo/104'])assert.ok(station.svg.includes(ref));
 assert.match(station.svg,/示例站牌 · 非真实运营数据/u);assert.match(station.svg,/非全站完整清单/u);assert.ok([...station.svg.matchAll(/data-route-separator=/gu)].length>=2,template.title+' separates all three routes');
 if(['lcd','led','ink'].includes(template.style.busLayout))assert.match(station.svg,/后续一班/u);
 assert.doesNotMatch(station.svg,/<script|foreignObject|<image\s/iu);
}
assert.equal(JSON.stringify(T.demoStation),stationSnapshot);
const real={...withService,from:'',to:'',type:'bus',relationKind:'route',sourceId:'relation/100',stops:withService.stops.map((s,i)=>({...s,sourceId:'node/'+(i+100)}))};
let board=T.addStationLine(null,real,{current:3});const saved=JSON.stringify(board);
const second={...real,ref:'56',sourceId:'relation/101',stops:[real.stops[1],real.stops[3],real.stops[7]]};
board=T.addStationLine(board,second,{current:1});assert.equal(board.lines.length,2);assert.equal(JSON.parse(saved).lines.length,1);
const replaced=T.addStationLine(board,{...second,title:'更新后的线路'},{current:1});assert.equal(replaced.lines.length,2);assert.equal(board.lines.at(-1).route.title,second.title);
const backwards=T.addStationLine(board,second,{reverse:true,current:1});assert.equal(backwards.lines.length,3);assert.equal(second.stops[0].sourceId,'node/101');
assert.throws(()=>T.addStationLine(board,{...second,stops:second.stops.map(s=>({...s,sourceId:'node/99999'}))},{current:1}),/编号不同/u);
assert.throws(()=>T.addStationLine(board,{...second,type:'subway'},{current:1}),/只接受公交/u);
assert.throws(()=>T.addStationLine(board,{...second,relationKind:'route_master'},{current:1}),/具体方向/u);
assert.throws(()=>T.addStationLine(board,{...second,stops:[{name:'大学城'}]},{current:0}),/编号/u);
assert.throws(()=>T.addStationLine(board,second,{current:-1}),/选择/u);
assert.throws(()=>T.addStationLine(board,T.demo,{current:3}),/编号不同/u);
assert.throws(()=>T.renderStation(buses[0].template,{...board,stationId:'node/999'}),/不属于/u);
assert.throws(()=>T.renderStation(buses[0].template,{...board,lines:[board.lines[0],board.lines[0]]}),/重复/u);
assert.throws(()=>T.renderStation(T.builtins[4].template,board),/仅适用于公交/u);
assert.throws(()=>T.renderStation(buses[0].template,null),/加入/u);
const evil=T.addStationLine(null,{...real,title:'线路 <script>bad</script>',stops:real.stops.map(stop=>({...stop,name:'<img onerror="x">'}))},{current:3});
for(const {template} of buses){
 const safe=T.renderStation(template,evil);assert.match(safe.svg,/&lt;img/u);assert.doesNotMatch(safe.svg,/<img|<script/iu);
 const long=T.addStationLine(null,{...real,stops:route.stops.map((stop,i)=>({...stop,sourceId:'node/'+(i+1000)}))},{current:75});
 const large=T.renderStation(template,long);assert.equal(large.renderedStations,113);assert.match(large.svg,/Stop 112/u);
 assert.equal(large.width,template.style.busLayout==='wide'?1920:1440);
 const encoded=T.parse(T.packageRecords(template));assert.equal(encoded.style.busLayout,template.style.busLayout);
}
const english=T.render(buses.find(t=>t.template.style.busLayout==='bilingual').template,{...T.demo,stops:[{name:'大学城',nameEn:'University Town'},{name:'海滨公园'}]},{current:0});
assert.match(english.svg,/University Town/u);assert.doesNotMatch(english.svg,/Seaside Park/u);
const firstLast=T.render(buses.find(t=>t.template.style.busLayout==='hub').template,{...T.demo,service:{first:'06:10',last:'22:40'}},{current:0});assert.match(firstLast.svg,/06:10/u);assert.match(firstLast.svg,/22:40/u);

const index=await readFile(new URL('../site/index.html',import.meta.url),'utf8');
const ui=await readFile(new URL('../site/transit-templates.js',import.meta.url),'utf8');
const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
for(const [,id] of ui.matchAll(/\$\("([a-z-]+)"\)/gu))assert.ok(index.includes('id="line-template-'+id+'"'),'缺少真实控件 '+id);
for(const asset of ['transit-station-data.js','transit-template-core.js','transit-templates.js','transit-templates.css'])assert.ok(index.includes('./'+asset));
const pos=app.indexOf('    getTransitTemplateLine: () => {'),end=app.indexOf('\n    openView: showView,',pos);
assert.ok(pos>0&&end>pos);
const getter=app.slice(pos,end).replace('    getTransitTemplateLine: ','').replace(/,\s*$/u,'');
const context=vm.createContext({focusedTransitGuideStops:route.stops,focusedTransitGuideLabel:'已选公交',focusedTransitGuideColor:'#b00000',focusedTransitGuideReversed:false,
 focusedTransitGuideRelation:{id:123,tags:{ref:'8',route:'bus',type:'route',opening_hours:'Mo-Fr 06:00-22:00',charge:'2 CNY',operator:'测试公交',interval:'15'}},selectedTransitRoot:null,
 window:{HuayuTransitStationData:globalThis.HuayuTransitStationData},selectedTransitItems:[],transitFareRelations:()=>[],transitRouteInfo:()=>({identity:'same-line'}),transitGuideRoundtripInfo:()=>({roundtrip:false}),currentTransitGuideStopOrder:()=>route.stops.map((s,i)=>({...s,sourceId:1000+i,routes:[{identity:'same-line',label:'本线'},{identity:'other',label:'换乘线'}]})),uniqueTransitRoutes:r=>r});
const actual=vm.runInContext('('+getter+')()',context);
assert.equal(actual.service.hours,'Mo-Fr 06:00-22:00');assert.equal(actual.service.fare,'2 CNY');assert.equal(actual.service.operator,'测试公交');assert.equal(actual.service.interval,'15');assert.equal(actual.service.first,'');
assert.equal(actual.type,'bus');assert.equal(actual.relationKind,'route');assert.equal(actual.stops[0].sourceId,'node/1000');
assert.equal(actual.stops.length,113);assert.equal(actual.sourceId,'relation/123');assert.deepEqual(JSON.parse(JSON.stringify(actual.stops[0].transfers)),[{ref:'',identity:'other',label:'换乘线'}]);
context.focusedTransitGuideStops=[];assert.equal(vm.runInContext('('+getter+')()',context),null);
const refs=JSON.parse(await readFile(new URL('../site/transit-template-references.json',import.meta.url),'utf8'));
assert.ok(refs.items.some(r=>r.kind==='bus')&&refs.items.some(r=>r.kind==='lcd'));for(const r of refs.items)assert.match(r.url,/^https:\/\//u);
console.log(JSON.stringify({status:'passed',templates:T.builtins.length,checks:['all six display families','113 stops retained','safe labels and schema','reverse without source mutation','explicit demo and manual station','shared record chunk roundtrip','real current-guide adapter and transfer identity','UI controls and references','three-line same-station board with full orders','identity rejects opposite stops and transfer guesses','line direction dedupe and immutable collection']}));

// Only visible text is user-facing. Provenance remains in metadata, without
// dumping source IDs, redundant titles or collection statistics onto the sign.
const visible=svg=>[...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gu)].map(m=>m[1]).join(' ');
const scheduled={...real,title:'临川大学6号工医小循环',roundtrip:true,service:{...real.service,interval:'',departures:'07:10;08:30;17:40'},serviceNote:'原始线路标签；缺项仅在总关系一致时继承'};
for(const {template} of buses){
 for(const reverse of [false,true]){
  const image=T.render(template,scheduled,{current:scheduled.stops.length-1,reverse}),shown=visible(image.svg);
  assert.doesNotMatch(shown,/原始线路标签|relation\/|已加入|同站多线路|手动预览|方向为手动/u,template.title);
  assert.doesNotMatch(shown,/环线|循环|首站|始发/u);assert.match(image.svg,/data-loop-return="true"/u);assert.match(shown,/发车时刻/u);assert.match(image.svg,/07:10;08:30;17:40/u);
  assert.doesNotMatch(shown,/班次间隔/u,'exact departures do not need an invented interval');assert.match(image.svg,/<metadata>/u);assert.match(image.svg,/relation\/100/u);
  assert.equal(image.stationCount,scheduled.stops.length);
 }
 const station=T.renderStation(template,T.addStationLine(null,scheduled,{current:scheduled.stops.length-1})),shown=visible(station.svg);
 assert.doesNotMatch(shown,/原始线路标签|relation\/|已加入|同站多线路|临川大学6号工医小循环|手动预览/u);assert.match(station.svg,/data-loop-return="true"/u);
 const duplicate={...scheduled,stops:[...scheduled.stops,scheduled.stops[0]]};
 const closed=T.render(template,duplicate,{current:duplicate.stops.length-1});assert.ok(visible(closed.svg).replace(/\s+/gu,' ').includes('下一站 '+duplicate.stops[1].name),'repeated endpoint advances to second stop');assert.equal(closed.stationCount,duplicate.stops.length);
 const single=T.render(template,{...scheduled,stops:[scheduled.stops[0]]},{current:0});assert.match(visible(single.svg),/终点站/u);assert.match(visible(single.svg),/未提供/u);
 const longSchedule=Array.from({length:30},(_,i)=>String(i%24).padStart(2,'0')+':10').join(';');
 const long=T.render(template,{...scheduled,service:{...scheduled.service,departures:longSchedule}},{current:0});assert.match(visible(long.svg),/发车时刻/u);assert.ok(long.height>0);assert.equal(long.renderedStations,scheduled.stops.length);
}
context.focusedTransitGuideStops=route.stops;context.focusedTransitGuideRelation.tags.name='临川大学7号医文小循环';assert.equal(vm.runInContext('('+getter+')()',context).roundtrip,true,'real adapter shares loop recognition');
console.log('Passed: all 26 visible signs are clean; full-source metadata; closed, reversed, repeated-endpoint and single-stop loops; timetables independent from headways.');

// Apply presentation rules to every family, every city name and every ring member
// rotation. An arbitrary serialization origin must never become a destination.
for(const {template} of T.builtins){
 const local={...scheduled,title:'测试线路',source:'测试来源',serviceNote:'原始线路标签',stops:scheduled.stops.map((stop,i)=>({...stop,name:'城站'+i}))};
 for(const current of [0,2,local.stops.length-1,-1])for(const reverse of [false,true]){
  const image=T.render(template,local,{current,reverse}),shown=visible(image.svg);
  assert.doesNotMatch(shown,/环线|循环|首站|始发|原始线路标签|relation\/|测试来源|手动预览|版式：/u,template.title);
  if(current>=0&&(template.family==='bus-stop'||template.family==='bus-rollsign'))assert.match(shown,/下一站/u);
  assert.match(image.svg,/<metadata>/u);assert.match(image.svg,/relation\/100/u);assert.equal(image.stationCount,local.stops.length);
  assert.doesNotMatch(image.svg,/<g data-stop-index="\d+"><title>\d+\./u,'ring tooltips do not imply an operating origin');
 }
 const rotated={...local,stops:[...local.stops.slice(3),...local.stops.slice(0,3)]};
 const image=T.render(template,rotated,{current:1});assert.doesNotMatch(visible(image.svg),/环线|循环|首站|始发/u);
}
console.log('Passed: no assumed ring origin in all 53 templates, explicit multi-route dividers, metadata retained, arbitrary rotations and reverse previews.');

// A loop may have a tagged terminal; missing tags must not erase its terminal
// field or turn an arbitrary first member into an operational destination.
for(const {template} of T.builtins){
 const tagged={...scheduled,from:'明确起点甲',to:'明确终点乙'};
 for(const reverse of [false,true]){
  const image=T.render(template,tagged,{current:3,reverse}),shown=visible(image.svg);
  assert.match(shown,/明确终点乙/u,template.title+' retains the tagged ring terminal');
  const widths=[...image.svg.matchAll(/<path\b[^>]*data-(?:route-segment|loop-return)="true"[^>]*>/gu)].map(m=>Number(m[0].match(/stroke-width="([\d.]+)"/u)?.[1]));
  if(template.family!=='bus-rollsign'){assert.ok(widths.length>=2);assert.equal(new Set(widths).size,1,template.title+' main and closure strokes match');}
 }
 if(template.family==='bus-stop')assert.match(visible(T.renderStation(template,T.addStationLine(null,tagged,{current:3})).svg),/明确终点乙/u);
 const unknown=T.render(template,{...tagged,from:'',to:''},{current:3});assert.match(visible(unknown.svg),/终点站/u);assert.match(visible(unknown.svg),/未提供/u);
}
const open={...real,from:'显式出发',to:'显式到达',roundtrip:false};
assert.match(visible(T.render(buses[1].template,open,{current:2}).svg),/显式到达/u);
assert.match(visible(T.render(buses[1].template,open,{current:2,reverse:true}).svg),/显式到达/u);
context.focusedTransitGuideRelation.tags={...context.focusedTransitGuideRelation.tags,from:'端点甲',to:'端点乙'};
let adapter=vm.runInContext('('+getter+')()',context);assert.equal(adapter.from,'端点甲');assert.equal(adapter.to,'端点乙');
context.focusedTransitGuideReversed=true;adapter=vm.runInContext('('+getter+')()',context);assert.equal(adapter.to,'端点乙');
console.log('Passed: tagged and missing ring terminals, open-route reversal, endpoint adapter and matching main/closure widths across all 53 templates.');

for(const {template} of T.builtins){
 const tagged={...open,from:'属性起点',to:'属性终点'};
 for(const reverse of [false,true]){
  const shown=visible(T.render(template,tagged,{current:2,reverse}).svg);
  assert.match(shown,/属性终点/u,template.title+' destination comes from to on both preview orders');
  const missing=visible(T.render(template,{...tagged,from:'',to:''},{current:2,reverse}).svg);
  assert.match(missing,/未提供/u);
  assert.doesNotMatch(missing,new RegExp('(?:开往|→)\\s*'+tagged.stops.at(-1).name,'u'),'last serialized member is not a tagged destination');
 }
}
const nonterminal={...open,to:'另一个运营终点',stops:[{name:'列表末站'}]};
assert.ok(visible(T.render(buses[1].template,nonterminal,{current:0}).svg).replace(/\s+/gu,' ').includes('下一站 未提供'));
const arrived={...nonterminal,to:'列表末站'};
assert.ok(visible(T.render(buses[1].template,arrived,{current:0}).svg).replace(/\s+/gu,' ').includes('下一站 终点站'));
console.log('Passed: endpoints remain line attributes in every family; no first/last member fallback or preview rewrite; terminal arrival requires tagged destination.');

// Complete screen exports, declarative imports, and generated-only animations.
const screens=T.builtins.filter(p=>p.template.style.screenLayout);
assert.equal(screens.length,21);assert.equal(screens.filter(p=>p.template.family==='bus-interior').length,9);
for(const {template} of screens){
  for(const current of [-1,0,112])for(const reverse of [false,true]){
    const o=T.render(template,route,{current,reverse});assert.equal(o.renderedStations,113);assert.equal(o.screenLayout,template.style.screenLayout);assert.equal(o.realtime,false);
    assert.doesNotMatch(o.svg,/<animate|<script|foreignObject|<image\b/iu);assert.match(o.svg,/站点112/u);assert.match(o.svg,/Stop 112/u);
    assert.equal([...o.svg.matchAll(/data-stop-index=/gu)].length,113);
    if(template.style.screenLayout==='marquee'){
      assert.match(o.motionSvg,/<animateTransform/u);assert.match(o.motionSvg,/data-marquee-track/u);assert.match(o.motionSvg,/站点112/u);
      assert.equal([...o.motionSvg.matchAll(/data-stop-index=/gu)].length,226,'two full sequences make a seamless loop');
    }else if(current>=0)assert.match(o.motionSvg,/<animate attributeName="opacity"/u);
    assert.deepEqual(T.parse(T.packageRecords(template)),template);
  }
  const ordinary=T.render(template,{...route,roundtrip:false},{current:0});assert.doesNotMatch(ordinary.svg,/data-loop-return/u,'ring preset does not invent a circular service');
  const ring=T.render(template,{...route,roundtrip:true},{current:0});assert.match(ring.svg,/data-loop-return/u);
  const evil=T.render(template,{...route,stops:[{name:'<svg onload="x">',nameEn:'<script>alert(1)</script>'}]},{current:0});
  for(const svg of [evil.svg,evil.motionSvg].filter(Boolean)){assert.doesNotMatch(svg,/<script|<svg onload|foreignObject/iu);assert.match(svg,/&lt;svg/u);}
}
assert.throws(()=>T.normalize({...screens[0].template,style:{...screens[0].template.style,screenLayout:'<script>'}}));
assert.throws(()=>T.normalize({...buses[0].template,style:{...buses[0].template.style,screenLayout:'marquee'}}));
assert.throws(()=>T.normalize({...T.builtins[2].template,style:{...T.builtins[2].template.style,screenLayout:'marquee'}}));
assert.equal(T.normalize({...screens[0].template,style:{...screens[0].template.style,screenLayout:undefined}}).style.screenLayout,'alternating');
console.log('Passed: 21 interior screens, complete 113-station static exports, safe generated marquee/pulse, roundtrip-only closure, new shared schema and legacy family restrictions.');


// Missing data may be simulated only on the presentation copy, never on source data.
const simOptions={enabled:true,seed:'regression-seed',now:new Date(2026,10,19,12,8).getTime(),current:3};
const noService={...route,from:'属性始发',to:'属性终到',service:{},roundtrip:false};
const beforeSimulation=JSON.stringify(noService),generated=T.simulateService(noService,simOptions);
assert.equal(JSON.stringify(noService),beforeSimulation);
for(const key of ['hours','first','last','fare','operator','interval','departures'])assert.ok(generated.service[key]);
assert.match(generated.service.departures,/模拟/u);assert.match(generated.service.operator,/模拟/u);
assert.equal(generated.to,noService.to);assert.equal(generated.from,noService.from);assert.equal(generated.roundtrip,false);
assert.equal(generated.stops.length,113);assert.ok(generated.simulation.arrival.next.minutes>=0);
assert.ok(Date.parse(generated.simulation.arrival.following.at)>Date.parse(generated.simulation.arrival.next.at));
assert.deepEqual(T.simulateService(noService,simOptions),generated,'same seed, route, time and stop preserve the result');
const nextMinute=T.simulateService(noService,{...simOptions,now:simOptions.now+60000});
assert.equal(nextMinute.service.interval,generated.service.interval);
assert.equal(nextMinute.service.fare,generated.service.fare);
if(generated.simulation.arrival.next.minutes>1){
 assert.equal(nextMinute.simulation.arrival.next.at,generated.simulation.arrival.next.at);
 assert.equal(nextMinute.simulation.arrival.next.minutes,generated.simulation.arrival.next.minutes-1);
}
assert.notEqual(T.simulateService(noService,{...simOptions,seed:'another-seed'}).service.operator,generated.service.operator);
assert.equal(T.simulateService(noService,{enabled:false}).simulation,null);
const complete={...noService,service:{hours:'05:30-23:00',first:'05:30',last:'23:00',fare:'3.5 CNY',operator:'原始运营公司',interval:'00:10',departures:'07:15;12:15;18:20'}};
const preserved=T.simulateService(complete,simOptions);
assert.deepEqual(preserved.service,complete.service);assert.deepEqual(preserved.simulation.generatedFields,[]);
assert.match(preserved.simulation.basis,/时刻表/u);
const timetableOnly=T.simulateService({...noService,service:{departures:'09:10;11:00;17:20'}},simOptions);
assert.equal(timetableOnly.service.departures,'09:10;11:00;17:20');assert.equal(timetableOnly.service.interval,'','exact schedules do not invent regular headways');
const blankEnd=T.simulateService({...noService,from:'',to:''},simOptions);assert.equal(blankEnd.from,'');assert.equal(blankEnd.to,'');
for(const interval of ['10','00:10','PT10M','每 10 分钟','10–15 分钟']){
 const o=T.simulateService({...noService,service:{hours:'24/7',interval}},simOptions);
 assert.equal(o.service.interval,interval);
 assert.ok(o.simulation.arrival.following.minutes-o.simulation.arrival.next.minutes>=9);
 assert.ok(o.simulation.arrival.following.minutes-o.simulation.arrival.next.minutes<=13);
}
const unparsed=T.simulateService({...noService,service:{interval:'高峰加密'}},simOptions);
assert.equal(unparsed.service.interval,'高峰加密');assert.match(unparsed.simulation.basis,/随机班次间隔/u);
const overnight=T.simulateService({...noService,service:{hours:'22:00-04:00',interval:'10'}},{...simOptions,now:new Date(2026,10,20,1,8).getTime(),current:0});
assert.ok(overnight.simulation.arrival.next.minutes<=10);
const midnight=T.simulateService({...noService,service:{hours:'24/7',interval:'10'}},{...simOptions,now:new Date(2026,10,19,23,59).getTime(),current:0});
assert.ok(midnight.simulation.arrival.next.minutes<=10);
for(const {template} of T.builtins){
 const image=T.render(template,noService,{current:3,simulation:simOptions});
 assert.doesNotMatch(visible(image.svg),/模拟|非实时运营信息/u,template.title+' omits generated simulation text from artwork');
 if(image.motionSvg)assert.doesNotMatch(visible(image.motionSvg),/模拟|非实时运营信息/u);
 assert.match(image.svg,/含模拟数据/u,'provenance remains in metadata');
 assert.match(image.svg,/generatedFields/u);assert.match(image.svg,/referenceTime/u);
 assert.equal(image.renderedStations,template.family==='bus-rollsign'?0:113);
 assert.doesNotMatch(image.svg,/data-loop-return/u);
 const clean=T.render(template,noService,{current:3,simulation:{enabled:false}});
 assert.doesNotMatch(visible(clean.svg),/含模拟数据/u);
}
for(const {template} of buses){
 const image=T.renderStation(template,T.demoStation,{simulation:simOptions});
 assert.doesNotMatch(visible(image.svg),/模拟|非实时运营信息/u);assert.match(image.svg,/generatedFields/u);assert.equal(image.renderedStations,20);
 if(['lcd','led','ink','wide'].includes(template.style.busLayout))assert.match(visible(image.svg),/分钟/u);
}
assert.ok(index.includes('line-template-line-choice'));
for(const marker of ['simulate-missing','simulate-again','time-refresh','simulation-status'])assert.ok(index.includes('line-template-'+marker));
assert.ok(ui.includes('selectedData()')&&ui.includes('getPreviewOptions'));
console.log('Passed: stable missing-data simulation, source and topology preservation, real timetables/headways, midnight/overnight arrivals, all 53 exports clean with metadata provenance, all 26 station layouts and loaded-line picker.');


// Artwork suppresses generated annotations without erasing real text or provenance.
const realOperator={...noService,service:{operator:'模拟交通研究公司',fare:'原价（模拟）'},demo:false};
const realImage=T.render(buses.find(p=>p.template.style.busLayout==='strip').template,realOperator,{simulation:simOptions});
assert.match(visible(realImage.svg),/模拟交通研究公司/u);assert.match(visible(realImage.svg),/原价（模拟）/u);
const wrappedStops=Array.from({length:35},(_,i)=>({name:'长线站'+i,sourceId:'node/'+(51000+i)}));
const wrapped={...noService,sourceId:'relation/991',ref:'R-LONG',stops:wrappedStops};
const pole=buses.find(p=>p.template.style.busLayout==='pole').template;
const badgeCount=svg=>[...svg.matchAll(/<text\b[^>]*>R-LONG<\/text>/gu)].length;
for(const reverse of [false,true]){
 const image=T.render(pole,wrapped,{current:3,reverse,simulation:simOptions});
 assert.equal(badgeCount(image.svg),1,'one large route number for every wrapped route');
 assert.equal(image.renderedStations,35);assert.equal([...image.svg.matchAll(/data-stop-index=/gu)].length,35);
}
let wrappedBoard=T.addStationLine(null,wrapped,{current:3});
wrappedBoard=T.addStationLine(wrappedBoard,{...wrapped,sourceId:'relation/992',ref:'R-OTHER'},{current:3});
const wrappedImage=T.renderStation(pole,wrappedBoard,{simulation:simOptions});
assert.equal(badgeCount(wrappedImage.svg),1);
assert.equal([...wrappedImage.svg.matchAll(/<text\b[^>]*>R-OTHER<\/text>/gu)].length,1);
assert.equal(wrappedImage.renderedStations,70);
console.log('Passed: artwork omits generated simulation text, retains metadata and original values; wrapped routes keep one large number each, full stops and reverse order.');

// New reference structures share the original export and identity boundaries.
const originalIds=['bus-stop-green','bus-stop-red','bus-amber','bus-white','metro-guide','metro-guide-blue','metro-led','metro-lcd','bus-stop-pole','bus-stop-lcd','bus-stop-led','bus-stop-ink','bus-stop-compact','bus-stop-split','bus-stop-wide','bus-stop-cards','bus-stop-hub','bus-stop-bilingual','bus-interior-marquee','bus-interior-alternating','bus-interior-diagonal','bus-interior-return','bus-interior-loop','bus-interior-focus','metro-lcd-diagonal','metro-lcd-return','metro-led-loop','metro-lcd-focus'];
assert.deepEqual(T.builtins.slice(0,28).map(p=>p.id),originalIds,'legacy IDs retain order and templates');
assert.equal(refs.userReferences.items.length,30);
for(const reference of refs.userReferences.items)for(const id of reference.templates)assert.ok(T.builtins.some(t=>t.id===id),'reference must identify a real selectable renderer');
const detailed=T.builtins.find(t=>t.id==='bus-stop-gaoyang-detail').template;
const located={...real,stops:real.stops.map((p,i)=>({...p,lat:14.6+i*.001,lon:i%2?179.999:-179.999})),service:{...real.service,departures:'Mo-Fr 07:10;07:30;Sa 08:15;PH 10:20'}};
const unchanged=JSON.stringify(located);
let geography=T.render(detailed,located,{current:3});
assert.match(geography.svg,/data-geographic-route="true"/u);
for(const day of ['Mo-Fr','Sa','PH'])assert.match(geography.svg,new RegExp('data-timetable-group="'+day+'"','u'));
assert.match(visible(geography.svg),/连线示意/u);
const omitted=T.render(detailed,{...located,stops:located.stops.map((p,i)=>i? p:{...p,lat:undefined})},{current:0});
assert.doesNotMatch(omitted.svg,/data-geographic-route/u);assert.match(visible(omitted.svg),/坐标未完整提供/u);
for(const invalid of [null,'14.6',NaN,Infinity,86]){
 const o=T.render(detailed,{...located,stops:located.stops.map((p,i)=>i?p:{...p,lat:invalid})});
 assert.doesNotMatch(o.svg,/data-geographic-route/u,'missing or invalid coordinate cannot become geographic zero');
}
assert.equal(JSON.stringify(located),unchanged);
for(const {template} of buses.slice(12)){
 const o=T.render(template,{...located,ref:'ONLY-ONCE',stops:route.stops},{current:50});
 assert.equal([...o.svg.matchAll(/<text\b[^>]*>ONLY-ONCE<\/text>/gu)].length,1,template.title);
 assert.equal(o.renderedStations,113);
}
context.focusedTransitGuideStops=route.stops;
context.currentTransitGuideStopOrder=()=>[{name:'真实坐标站',sourceId:23,lat:14.65,lon:152.93,routes:[]}];
const coords=vm.runInContext('('+getter+')()',context).stops[0];assert.equal(coords.lat,14.65);assert.equal(coords.lon,152.93);
console.log('Passed: 30 numbered reference mappings, stable 28 legacy IDs, new 25 real renderers, valid geographic coordinates and dateline, conditional timetable separation, source immutability and one number per route.');


// User-visible rich screen outcomes, not implementation snapshots.
const richIds=['metro-screen-nanjing','metro-screen-wuxi-screen','metro-screen-platform','metro-screen-ningbo','metro-screen-suzhou','bus-interior-songjiang','bus-interior-macau','metro-screen-wayfinding'];
const richRoute={...T.demo,type:'subway',stops:Array.from({length:43},(_,i)=>({name:'站点'+i,sourceId:'node/'+(5000+i)})),passenger:{cars:8,car:3,doorSide:'right',phase:'arrived',leftExit:'A B',rightExit:'C D',facilities:['wc','lift','accessible'],doorLabel:'3车 4门'}};
for(const id of richIds){
 const t=T.builtins.find(v=>v.id===id).template,o=T.render(t,richRoute,{current:5});
 assert.equal(o.stationCount,43);assert.equal([...o.svg.matchAll(/data-stop-index=/gu)].length,43);assert.equal([...o.svg.matchAll(/data-carriage=/gu)].length,8);
 assert.match(o.svg,/3车 4门/u);assert.match(o.svg,/data-pictogram="wc"/u);assert.match(o.svg,/C D/u);assert.doesNotMatch(o.svg,/<animate/u);
 assert.match(o.motionSvg,/data-passenger-page="route"/u);assert.match(o.motionSvg,/data-passenger-page="platform"/u);assert.match(o.motionSvg,/data-door-leaf/u);assert.match(o.motionSvg,/animateTransform/u);
 const unknown=T.render(t,richRoute,{current:-1});assert.match(unknown.svg,/未指定当前站/u);assert.match(unknown.svg,/请选择当前站/u);assert.doesNotMatch(unknown.svg,/data-current-lamp/u);
 const poisoned=T.render(t,{...richRoute,passenger:{...richRoute.passenger,leftExit:'<script>bad</script>'}},{current:5});assert.doesNotMatch(poisoned.svg,/<script>/u);assert.match(poisoned.svg,/&lt;script&gt;/u);
 const json=JSON.stringify(t);assert.ok(!json.includes('3车 4门')&&!json.includes('leftExit')&&!json.includes('geography'));
 if(o.rowCounts.length===2)assert.ok(Math.abs(o.rowCounts[0]-o.rowCounts[1])<=1,id+' balanced two rows');
}
for(const id of ['bus-stop-gaoyang','bus-stop-gaoyang-detail']){
 const t=T.builtins.find(v=>v.id===id).template;
 const short=T.render(t,{...richRoute,stops:richRoute.stops.slice(0,33)},{current:5});assert.equal([...short.svg.matchAll(/data-station-row=/gu)].length,1);
 const long=T.render(t,richRoute,{current:5}),counts=[...long.svg.matchAll(/data-row-count="(\d+)"/gu)].map(m=>+m[1]);assert.equal(counts.reduce((a,b)=>a+b,0),43);assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
}
console.log('Passed: single-row priority, balanced overflow, unknown current neutral, full 43 stops, carriage/exit/facility pictograms, safe manual parameters, separate animated pages and static exports.');


// Every bus layout places its ring stops on both sides of the same perimeter.
for(const {id,template} of buses)for(const count of [1,2,3,4,17,44,45,113])for(const reverse of [false,true]){
 const ringStops=Array.from({length:count},(_,i)=>({sourceId:'node/'+(70000+i),name:'环上站'+i,nameEn:'Ring stop '+i}));
 const o=T.render(template,{...real,roundtrip:true,stops:ringStops},{current:Math.min(2,count-1),reverse});
 const points=[...o.svg.matchAll(/data-loop-station-side="(left|right|top|bottom)" data-loop-x="([\d.]+)" data-loop-y="([\d.]+)"/gu)].map(m=>({side:m[1],x:+m[2],y:+m[3]}));
 assert.equal(points.length,count,id);assert.equal([...o.svg.matchAll(/data-stop-index=/gu)].length,count);
 assert.equal([...o.svg.matchAll(/data-loop-layout=/gu)].length,1,id+' uses one connected loop');
 const groups=Map.groupBy(points,p=>p.side);
 if(count>1){assert.equal(groups.size,2,id);const sizes=[...groups.values()].map(v=>v.length);assert.ok(Math.abs(sizes[0]-sizes[1])<=1,id);}
 for(const [side,ps]of groups)for(let i=1;i<ps.length;i++)assert.ok(side==='left'?ps[i].y>ps[i-1].y:side==='right'?ps[i].y<ps[i-1].y:side==='top'?ps[i].x>ps[i-1].x:ps[i].x<ps[i-1].x,id+' source order follows perimeter');
 assert.doesNotMatch(o.svg,/NaN|Infinity/u);assert.ok(o.svg.includes('Ring stop '+(count-1)));
}
for(const id of ['metro-lcd-return','metro-led-loop','metro-lcd-focus','metro-screen-suzhou','metro-screen-platform','bus-interior-macau-fold']){
 const t=T.builtins.find(e=>e.id===id).template,o=T.render(t,{...richRoute,roundtrip:false,stops:Array.from({length:113},(_,i)=>({name:'站点'+i}))});
 const joins=[...o.svg.matchAll(/<path\b[^>]*data-route-join="true"[^>]*>/gu)].map(m=>m[0]);
 assert.ok(joins.length>=2,id+' covers both sides');
 for(const join of joins){assert.equal([...join.matchAll(/Q /gu)].length,2,id);assert.match(join,/stroke-linecap="round"/u);assert.match(join,/stroke-linejoin="round"/u);assert.match(join,/stroke-width="6"/u);}
 assert.doesNotMatch(o.svg,/data-loop-return/u,'a folded ordinary line is still open');
}
const wxTemplate=T.builtins.find(e=>e.id==='metro-screen-wuxi-screen').template;
const wx=T.render(wxTemplate,{...richRoute,stops:richRoute.stops.map((v,i)=>({...v,transfers:i===3?[{type:'subway',label:'JS02',color:'#469ab4'}]:[]}))},{current:5});
assert.equal(wx.width,1920);assert.match(wx.svg,/data-wuxi-canopy/u);assert.match(wx.svg,/data-garden-rail/u);
assert.equal([...wx.svg.matchAll(/data-garden-lamp=/gu)].length,43);assert.match(wx.svg,/#469ab4/u);
assert.match(wx.motionSvg,/data-garden-window="left"/u);assert.match(wx.motionSvg,/data-door-direction="right"/u);assert.doesNotMatch(wx.motionSvg,/data-door-direction="left"/u);
const wxUnknown=T.render(wxTemplate,{...richRoute,passenger:{doorSide:'unknown'}},{current:-1});
assert.doesNotMatch(wxUnknown.motionSvg,/data-door-direction=|data-current-lamp=/u);
console.log('Passed: all 26 ring layouts balance both sides and preserve ordered full stops; folded open lines have consistent rounded joins; dedicated Wuxi route and arrival pages retain controls and real transfer colours.');


// Exercise the original loaded-direction adapter without inventing a parallel reader.
const directionStart=app.indexOf('    getTransitTemplateDirections: () => {'),selectionStart=app.indexOf('    selectTransitTemplateDirection: sourceId => {',directionStart),lineStart=app.indexOf('    getTransitTemplateLine: () => {',selectionStart);
assert.ok(directionStart>0&&selectionStart>directionStart&&lineStart>selectionStart);
const directionGetter=app.slice(directionStart,selectionStart).replace('    getTransitTemplateDirections: ','').replace(/,\s*$/u,'');
const directionSetter=app.slice(selectionStart,lineStart).replace('    selectTransitTemplateDirection: ','').replace(/,\s*$/u,'');
const dirRoot={type:'relation',id:600,tags:{type:'route_master',route:'subway'}},dirChild={type:'relation',id:601,tags:{from:'甲',to:'乙'}};
const dirSelect={options:[{value:'all',textContent:'总关系',selected:true},{value:'601',textContent:'甲 → 乙',selected:false}],value:'all'};
let dirCalls=0;
const dirContext=vm.createContext({getTransitColor:tags=>tags?.colour||'#326da6',selectedTransitRoot:dirRoot,selectedTransitItems:[dirRoot,dirChild],elements:{transitSegmentControl:{hidden:false},transitSegmentSelect:dirSelect},focusedTransitGuideStops:[{}],renderFocusedTransitSelection:()=>dirCalls++});
const choices=vm.runInContext('('+directionGetter+')()',dirContext);assert.equal(choices.length,2);assert.equal(choices[1].sourceId,'relation/601');assert.equal(choices[1].to,'乙');
const choose=vm.runInContext('('+directionSetter+')',dirContext);choose('relation/601');assert.equal(dirSelect.value,'601');assert.equal(dirCalls,1);
assert.throws(()=>choose('relation/999'),/已读取方向/u);assert.equal(dirCalls,1);assert.equal(dirSelect.value,'601');
dirContext.elements.transitSegmentControl.hidden=true;assert.throws(()=>choose('relation/601'));assert.equal(vm.runInContext('('+directionGetter+')()',dirContext).length,0);
console.log('Passed: original map segment choices and handler are reused; unread or hidden direction IDs do not mutate selection.');

// Every rail display renders separate coloured line symbols, including motion and static exports.
for(const {id,template}of T.builtins.filter(e=>e.template.family.startsWith('metro'))){
 const r={...richRoute,type:'subway',stops:richRoute.stops.slice(0,12).map((v,i)=>({...v,transfers:i===3?[{type:'subway',ref:'JS02',identity:'r2',label:'津川轨道交通2号线',color:'#469ab4'},{type:'subway',ref:'4',identity:'r4',label:'津川轨道交通4号线',color:'#21a675'}]:[]}))};
 const o=T.render(template,r,{current:3});
 for(const svg of [o.svg,o.motionSvg].filter(Boolean)){assert.match(svg,/data-transfer-ref="JS02"/u,id);assert.match(svg,/data-transfer-ref="4"/u,id);assert.match(svg,/#469ab4/u,id);assert.match(svg,/#21a675/u,id);assert.doesNotMatch(visible(svg),/津川轨道交通[24]号线/u,id+' full names remain in titles/metadata only');}
}
console.log('Passed: all rail layouts use separately coloured line-number symbols, in static and animated renders.');

// User-controlled through services use real station indexes and the common export renderer.
const railThrough={type:'subway',sourceId:'relation/900001',ref:'1',title:'贯通测试',from:'站点0',to:'站点19',color:'#c43232',roundtrip:false,stops:Array.from({length:20},(_,i)=>({sourceId:'node/'+(900000+i),name:'站点'+i,transfers:i===6?[{ref:'2',identity:'r2',label:'二号线',color:'#469ab4'},{ref:'4',identity:'r4',label:'四号线',color:'#21a675'},{ref:'8',identity:'r8',label:'八号线',color:'#b975cc'}]:[]})),throughServices:[{ref:'JS02',name:'二号贯通',color:'#469ab4',fromIndex:2,toIndex:14},{ref:'JS08',name:'八号贯通',color:'#b975cc',fromIndex:6,toIndex:19}]};
const throughSnapshot=JSON.stringify(railThrough);
for(const {id,template}of T.builtins.filter(e=>e.template.family.startsWith('metro'))){
 const result=T.render(template,railThrough,{current:6});assert.equal(result.stationCount,20);
 for(const svg of [result.svg,result.motionSvg].filter(Boolean)){assert.match(svg,/data-through-interval="JS02"/u,id);assert.match(svg,/data-through-interval="JS08"/u,id);assert.match(svg,/站点2 → 站点14/u,id);assert.match(svg,/站点6 → 站点19/u,id);assert.match(svg,/data-transfer-ref="8"/u,id);assert.match(svg,/#469ab4/u,id);}
 const reverse=T.render(template,railThrough,{reverse:true,current:13});assert.match(reverse.svg,/站点14 → 站点2/u,id);assert.match(reverse.svg,/站点19 → 站点6/u,id);assert.equal(reverse.renderedStations,20);
 if(template.family==='metro-guide'||template.style.screenLayout)assert.match(result.svg,/data-through-track="JS02"/u,id+' draws actual diagram range stripe');
}
assert.equal(JSON.stringify(railThrough),throughSnapshot,'no source mutation by static, motion or reverse');
const ringThrough={...railThrough,roundtrip:true,throughServices:[{ref:'X',color:'#126743',fromIndex:17,toIndex:3}]};assert.match(T.render(T.builtins.find(v=>v.id==='metro-screen-wuxi-screen').template,ringThrough).svg,/站点17 → 站点3/u);
const valid=T.normalizeThroughServices(railThrough,railThrough.throughServices);assert.deepEqual(T.normalizeThroughServices(railThrough,valid),valid,'normalized values remain valid on redraw');
for(const values of [[{ref:'X',color:'red',fromIndex:0,toIndex:4}],[{ref:'X',color:'#123456',fromIndex:3,toIndex:1}],[{ref:'X',color:'#123456',fromIndex:0,toIndex:99}],[{ref:'',color:'#123456',fromIndex:0,toIndex:3}],[{ref:'X',color:'#123456',fromIndex:0,toIndex:0}],[{ref:'X',color:'#123456',fromIndex:0,toIndex:4,script:'x'}]])assert.throws(()=>T.normalizeThroughServices(railThrough,values));
assert.throws(()=>T.normalizeThroughServices({...railThrough,type:'bus'},railThrough.throughServices));
assert.throws(()=>T.parse({...T.builtins[0].template,throughServices:railThrough.throughServices}),'shared templates cannot contain manual operational data');
console.log('Passed: every rail template shows multiple through intervals and colour keys in static/motion exports; exact real ranges, reverse/ring ranges, no mutation, strict validation, roundtrip-safe normalized controls and shared-template data isolation.');

// The main focused-line guide shares the station-template's real connected-track ordering.
const topologyFixture=JSON.parse(await readFile(new URL('./fixtures/transit-nanguoda-topology.json',import.meta.url),'utf8')),topologyItems=[...new Map(topologyFixture.responses.flatMap(r=>r.payload.elements.filter(e=>e.type!=='count')).map(e=>[e.type+'/'+e.id,e])).values()],topologyRelation=topologyItems.find(e=>e.type==='relation'&&e.id===540664);
const guideOrderSource=app.slice(app.indexOf('  function orderTransitGuideStops('),app.indexOf('  function selectTransitBusGuideMemberOrder('));
const guideVm=vm.createContext({window:{HuayuTransitStationData:globalThis.HuayuTransitStationData},selectedTransitItems:topologyItems,transitRelationRouteType:r=>r.tags.route});
const originalStops=topologyRelation.members.filter(m=>m.role==='stop').map(m=>{const n=topologyItems.find(e=>e.type===m.type&&e.id===m.ref);return {...n,name:n.tags.name,sourceId:n.type+'/'+n.id};}),guideOrder=vm.runInContext('('+guideOrderSource+')',guideVm)(originalStops,topologyItems.filter(e=>e.type==='way'),topologyRelation);
assert.equal(guideOrder[0].name,'鹿山公园');assert.equal(guideOrder.at(-1).name,'农园路');assert.equal(guideOrder[7].name,'津川火车站');assert.equal(originalStops[0].name,'津川火车站','shared app handler never mutates source member order');
console.log('Passed: actual main-guide handler delegates to the same continuous-track order and preserves original member list.');


// Real endpoint composition and a selectable stopping pattern share every rail export.
const stop=i=>({sourceId:'node/'+(99000+i),name:'贯通站'+i,lat:14.6,lon:152.9+i*.001,transfers:[]});
const sourceA={type:'subway',sourceId:'relation/99001',ref:'A',title:'贯通甲线',color:'#cc3131',from:'贯通站0',to:'贯通站3',roundtrip:false,stops:[0,1,2,3].map(stop)};
const sourceB={...sourceA,sourceId:'relation/99002',ref:'B',color:'#246ba1',from:'贯通站3',to:'贯通站6',stops:[3,4,5,6].map(stop)};
const sourceC={...sourceA,sourceId:'relation/99003',ref:'C',from:'贯通站8',to:'贯通站0',stops:[8,7,0].map(stop)};
const originalJourney=JSON.stringify([sourceA,sourceB,sourceC]);
const joined=T.connectThroughRoute(sourceA,sourceB);
assert.deepEqual(joined.stops.map(s=>s.name),[0,1,2,3,4,5,6].map(i=>'贯通站'+i));
assert.equal(joined.throughRoute.segments.length,2);assert.equal(joined.throughRoute.segments[1].fromIndex,3);
const prefixed=T.connectThroughRoute(joined,sourceC,{attach:'start'});
assert.deepEqual(prefixed.stops.map(s=>s.name),[8,7,0,1,2,3,4,5,6].map(i=>'贯通站'+i));
assert.deepEqual(prefixed.throughRoute.segments.map(s=>[s.fromIndex,s.toIndex]),[[0,2],[2,5],[5,8]]);
assert.equal(T.connectThroughRoute(sourceA,{...sourceB,stops:[...sourceB.stops].reverse()},{reverse:true}).stops.length,7);
const aliasB={...sourceB,stops:sourceB.stops.map((s,i)=>i? s:{...s,sourceId:'node/99999',memberSourceIds:['node/99003']})};
assert.equal(T.connectThroughRoute(sourceA,aliasB).stops.length,7);
const areaA={...sourceA,stops:sourceA.stops.map((s,i)=>i===3?{...s,stopAreaIds:['relation/99997']}:s)};
assert.equal(T.connectThroughRoute(areaA,{...aliasB,stops:aliasB.stops.map((s,i)=>i? s:{...s,memberSourceIds:[],stopAreaIds:['relation/99997']})}).stops.length,7);
assert.throws(()=>T.connectThroughRoute(sourceA,{...sourceB,stops:sourceB.stops.map((s,i)=>i?s:{...s,sourceId:'node/99999'})}),/首末站/u,'same name and coordinates do not connect');
assert.throws(()=>T.connectThroughRoute(joined,sourceA));assert.throws(()=>T.connectThroughRoute({...sourceA,overview:true},sourceB));assert.throws(()=>T.connectThroughRoute(sourceA,{...sourceB,roundtrip:true}));
assert.ok(T.throughConnectionOptions(sourceA,[sourceB,sourceC]).some(v=>v.attach==='end'&&!v.reverse));
assert.ok(T.throughConnectionOptions(sourceA,[sourceB,sourceC]).some(v=>v.attach==='start'&&!v.reverse));
const pattern=T.normalizeOperatingPattern(prefixed,{name:'小交路快车',fromIndex:'2',toIndex:'7',skipIndexes:['3','5']});
const journey={...prefixed,operatingPattern:pattern};
assert.equal(T.stopState(journey,0),'outside');assert.equal(T.stopState(journey,3),'skipped');assert.equal(T.stopState(journey,4),'stopping');
assert.equal(T.nextStoppingIndex(journey,journey.stops,2),4);assert.equal(T.nextStoppingIndex(journey,journey.stops,7),-1);
const railTemplates=T.builtins.filter(v=>['metro-guide','metro-lcd','metro-led'].includes(v.template.family));
for(const {id,template} of railTemplates){
 const out=T.render(template,journey,{current:2});
 assert.equal(out.stationCount,9,id);assert.deepEqual(out.stoppingIndexes,[2,4,6,7],id);
 for(const svg of [out.svg,out.motionSvg].filter(Boolean)){
  assert.match(svg,/data-stop-index="0" data-stop-state="outside" filter="url\(#huayu-inactive-stop\)"/u,id);
  assert.match(svg,/data-stop-index="3" data-stop-state="skipped" filter="url\(#huayu-inactive-stop\)"/u,id);
  assert.match(svg,/data-stop-index="4" data-stop-state="stopping"/u,id);
  assert.match(svg,/data-through-line-source="relation\/99002"/u,id);
  assert.match(svg,/小交路快车/u,id);assert.match(svg,/贯通站8/u,id);assert.match(svg,/贯通站6/u,id);
 }
 const reversed=T.render(template,journey,{reverse:true,current:6});
 assert.deepEqual(reversed.operatingPattern.skipIndexes,[3,5],id);
 assert.deepEqual(reversed.stoppingIndexes,[1,2,4,6],id);
 const skippedCurrent=T.render(template,journey,{current:3});
 assert.doesNotMatch(skippedCurrent.svg,/<circle data-current-lamp="true"/u,id+' never lights a skipped current');
 assert.equal(T.render(template,{...journey,operatingPattern:null}).stationCount,9);
}
assert.equal(JSON.stringify([sourceA,sourceB,sourceC]),originalJourney,'composition, reversal and rendering never mutate source lines');
for(const p of [{fromIndex:0,toIndex:3,skipIndexes:[0]},{fromIndex:0,toIndex:3,skipIndexes:[3]},{fromIndex:1,toIndex:3,skipIndexes:[4]},{fromIndex:2,toIndex:1},{fromIndex:null,toIndex:3},{fromIndex:true,toIndex:3},{fromIndex:'',toIndex:3},{fromIndex:0,toIndex:3,skipIndexes:[1,1]},{fromIndex:0,toIndex:3,script:'x'}])assert.throws(()=>T.normalizeOperatingPattern(sourceA,p));
const ringPattern={...journey,roundtrip:true,operatingPattern:T.normalizeOperatingPattern({...journey,roundtrip:true},{fromIndex:7,toIndex:2,skipIndexes:[0]})};
assert.equal(T.nextStoppingIndex(ringPattern,ringPattern.stops,8),1);assert.equal(T.nextStoppingIndex(ringPattern,ringPattern.stops,2),-1);
assert.throws(()=>T.parse({...T.builtins[0].template,operatingPattern:pattern}),'operational settings never enter shared style');
console.log('Passed: real endpoint-only append/prepend/reverse and aliases; full composed lines, all rail static/motion exports, short-turn/skip states, next served station, ring wrap, strict invalid controls and immutable sources.');

const trackLinked=T.connectThroughRoute({...sourceA,trackEndpointIds:['node/1','node/2']},{...sourceB,stops:[4,5,6].map(stop),trackEndpointIds:['node/2','node/3']});assert.equal(trackLinked.stops.length,7);assert.equal(trackLinked.throughRoute.junctions[0].trackNodeId,'node/2');assert.deepEqual(trackLinked.trackEndpointIds,['node/1','node/3']);assert.throws(()=>T.connectThroughRoute({...sourceA,trackEndpointIds:['node/1','node/2']},{...sourceB,stops:[4,5,6].map(stop),trackEndpointIds:['node/9','node/3']}));


// Artwork footers remain clean without losing manual operation metadata or grey stop states.
for(const {id,template} of railTemplates){
 const out=T.render(template,journey,{current:2}),plain=T.render(template,{...journey,operatingPattern:null},{current:2});
 const visible=[...out.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gu)].map(v=>v[1]).join(' ');
 assert.doesNotMatch(visible,/灰色站点|本次交路|小交路快车|运行方向/u,id);
 assert.equal(out.height,plain.height,id+' adds no instructional footer band');
 assert.match(out.svg,/metadata data-operating-pattern="true"/u,id);
 assert.doesNotMatch(out.svg,/<g\b[^>]*data-stop-state="(?:outside|skipped)"[^>]*\bopacity=/u,id+' marker backgrounds remain opaque');
 assert.match(out.svg,/<text\b[^>]*opacity=".4"/u,id+' inactive labels remain grey');
 for(const artwork of [out.svg,out.motionSvg].filter(Boolean))assert.equal([...artwork.matchAll(/data-stop-index=/gu)].length>=journey.stops.length,true,id+' full stations remain');
}
console.log('Passed: every rail artwork omits instructional footer text/band, retains manual provenance, grey labels and opaque station masking.');


// Return paths must never paint after the station rows they connect, across all styles.
const overlapStops=Array.from({length:31},(_,i)=>({sourceId:'node/'+(880000+i),name:i===12?'东南大街':i===13?'熙园':'完整车站'+i,nameEn:'Station '+i}));
for(const {id,template} of T.builtins)for(const roundtrip of [false,true])for(const reverse of [false,true]){
 const out=T.render(template,{...T.demo,demo:false,type:template.family.startsWith('bus')?'bus':'subway',sourceId:'relation/880000',stops:overlapStops,roundtrip},{current:19,reverse});
 for(const svg of [out.svg,out.motionSvg].filter(Boolean)){
  const station=svg.indexOf('<g data-stop-index=');
  if(station<0)continue;
  for(const path of svg.matchAll(/<path\b[^>]*data-(?:route-join|loop-return)="true"[^>]*>/gu))assert.ok(path.index+path[0].length<station,id+' return path must precede station foreground, ring='+roundtrip+', reverse='+reverse);
  const visible=[...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gu)].map(v=>v[1]).join(' ');
  assert.doesNotMatch(visible,/灰色站点|本次交路：|运行方向/u,id);
 }
 assert.equal(out.stationCount,31,id);assert.equal(out.renderedStations,template.family==='bus-rollsign'?0:31,id);
}
console.log('Passed: all 53 templates keep return/loop paths below complete station rows in open/ring, forward/reverse and animated outputs.');


// The running-direction arrow belongs above the first station row, independent of line length.
for(const {id,template} of T.builtins)for(const count of [1,27,61])for(const reverse of [false,true]){
 const route={...T.demo,type:template.family.startsWith('bus')?'bus':'subway',stops:Array.from({length:count},(_,i)=>({sourceId:'node/'+(77000+i),name:'方向测试站'+i})),demo:false,sourceId:'relation/77000'};
 const out=T.render(template,route,{current:-1,reverse});
 for(const svg of [out.svg,out.motionSvg].filter(Boolean)){
  const running=[...svg.matchAll(/<path\b[^>]*data-arrow-role="running"[^>]*d="M ([\d.]+) ([\d.]+)[^"]*"[^>]*>/gu)];
  if(!running.length)continue;
  const first=svg.slice(svg.indexOf('data-station-row="0"')).match(/<circle\b[^>]*cx="([\d.]+)" cy="([\d.]+)"/u);
  assert.ok(first,id+' arrow has a real first station row');
  for(const arrow of running){assert.ok(+arrow[2]+10<+first[2],id+' arrow above first station row');assert.equal(+arrow[1],+first[1],id+' arrow aligned with first station');}
  assert.doesNotMatch(svg,/<text\b[^>]*>运行方向<\/text>/u,id);
 }
}
console.log('Passed: running-direction arrows align above the first row for one-stop, normal and long lines; static, animated and reversed previews share placement.');
