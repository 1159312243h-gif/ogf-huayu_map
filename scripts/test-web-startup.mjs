import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../site/app.js',import.meta.url),'utf8'),startup=await readFile(new URL('../site/map-startup.js',import.meta.url),'utf8');
const html=await readFile(new URL('../site/index.html',import.meta.url),'utf8');
assert.ok(!source.slice(0,source.indexOf('  const map = window.L.map')).includes('await prepareVectorBasemap(selectedBasemapId)'), 'optional vector loading cannot block constructing the real map');
assert.ok(source.includes('createBasemapTileLayer(initialVectorBasemapId ? "carto" : selectedBasemapId)'));
assert.ok(source.indexOf('if(initialVectorBasemapId)void setBasemapStyle')>source.indexOf('window.HuayuAtlas = Object.freeze'), 'map controls and real assistant interfaces exist before vector download');
assert.match(html,/<script async src="\.\/map-startup\.js/u);
assert.ok(html.includes('id="map-startup-status"')&&html.includes('id="map-startup-retry"'));
const elements=new Map(['map-startup-status','map-startup-message','map-startup-retry'].map(id=>[id,{hidden:false,textContent:'',dataset:{},addEventListener(type,fn){this[type]=fn;}}])),events=new Map(),timers=new Map();let serial=0,reloads=0;
const root={document:{getElementById:id=>elements.get(id)},location:{href:'https://ogf-atlas.pages.dev/',origin:'https://ogf-atlas.pages.dev',reload(){reloads++;}},setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),addEventListener(type,fn){events.set(type,fn);},URL,MutationObserver:class{observe(){} disconnect(){}}};
vm.runInNewContext(startup,root);
const box=elements.get('map-startup-status'),button=elements.get('map-startup-retry');
timers.values().next().value();assert.equal(box.hidden,false);assert.equal(button.hidden,false);assert.match(elements.get('map-startup-message').textContent,/加载较慢/);
button.click();assert.equal(reloads,1);events.get('error')({target:{tagName:'SCRIPT',src:root.location.origin+'/maplibre-gl.js',dataset:{mapOptional:'true'}}});let retried=0;root.HuayuMapStartup.failed('矢量等待',()=>retried++);root.HuayuMapStartup.ready({baseOnly:true});assert.equal(box.hidden,false,'late raster tiles cannot hide the pending vector retry');button.click();assert.equal(retried,1);assert.equal(reloads,1);root.HuayuMapStartup.ready();assert.equal(box.hidden,true,'recovered vector does not inherit a fatal program error');
events.get('error')({target:{tagName:'LINK',rel:'stylesheet',href:root.location.origin+'/styles.css'}});
// A later successful map load may only clear ordinary slow loading.
const resourceRoot={...root,HuayuMapStartup:undefined};vm.runInNewContext(startup,resourceRoot);
events.get('error')({target:{tagName:'LINK',rel:'stylesheet',href:root.location.origin+'/styles.css'}});
resourceRoot.HuayuMapStartup.ready();assert.equal(box.hidden,false,'missing critical styles stay actionable after late tiles');
let fail=false,pending=null,requestSerial=0;const layers=new Set(['old']),saved=[],messages=[];const map={hasLayer:layer=>layers.has(layer),removeLayer:layer=>layers.delete(layer)};
const c=vm.createContext({selectedBasemapId:'huayu',BASEMAP_STYLES:{huayu:{kind:'vector',label:'标准'},carto:{label:'基础'},vector:{kind:'vector',label:'矢量'}},currentVectorCameraSnapshot:()=>null,basemapStyleRequestId:0,baseTileLayer:'old',map,vectorPerspectiveActive:false,prepareVectorBasemap:async()=>{if(fail)throw Error('fixture');if(pending)await pending;},
 createBasemapTileLayer:id=>({id,addTo(){layers.add(this);}}),window:{localStorage:{setItem:(k,v)=>saved.push(v)},HuayuMapStartup:{failed:(m,fn)=>messages.push({m,fn})}},showToast:msg=>messages.push({msg}),updateMapViewControls(){},BASEMAP_STORAGE_KEY:'basemap'});
vm.runInContext(source.match(/  async function setBasemapStyle\([^]*?\n  \}/u)[0],c);
fail=true;await c.setBasemapStyle('huayu',{initial:true});assert.equal(c.baseTileLayer,'old');assert.equal(c.selectedBasemapId,'huayu');assert.deepEqual(saved,[]);assert.ok(messages.some(m=>m.fn));
fail=false;await c.setBasemapStyle('carto',{temporary:true});assert.deepEqual(saved,[],'temporary map fallback preserves the saved choice');await c.setBasemapStyle('huayu',{initial:true});assert.equal(c.baseTileLayer.id,'huayu');assert.ok(!layers.has('old'));assert.deepEqual(saved,['huayu']);
pending=new Promise(resolve=>requestSerial=resolve);const late=c.setBasemapStyle('vector');await c.setBasemapStyle('carto');requestSerial();pending=null;await late;assert.equal(c.selectedBasemapId,'carto','late initial/vector downloads cannot override a later user choice');
console.log('Web startup passed: actual nonblocking map initialization, initial retry, saved preference, stale selection rejection, independent slow/error status and no storage clearing.');
