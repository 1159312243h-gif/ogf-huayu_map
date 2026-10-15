import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import {validateOverlayBounds} from "../site/_worker.js";

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type,new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {this.listeners.get(type)?.delete(callback);}
  dispatch(type, properties={}) {
    const event = {type,target:this,button:0,pointerId:1,pointerType:"mouse",clientX:100,clientY:100,
      preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...properties};
    for (const listener of this.listeners.get(type)||[]) {listener(event);if(event.stopped)break;}
    return event;
  }
}
class Element extends Target {
  style={};dataset={};attributes={};children=[];classes=new Set();
  classList={add:name=>this.classes.add(name),toggle:(name,value)=>value?this.classes.add(name):this.classes.delete(name)};
  append(...children){this.children.push(...children);}
  appendChild(child){this.append(child);}
  setAttribute(key,value){this.attributes[key]=String(value);}
  removeAttribute(key){delete this.attributes[key];}
  closest(){return null;}
  contains(target){return target===this;}
  remove(){this.removed=true;}
}
const document=new Target(),window=new Target(),container=new Element(),frames=new Map();
let serial=0,changes=[],state,errors=0;
document.createElementNS=()=>new Element();
const runtime=vm.createContext({document,window,performance:{now:()=>1000},
  requestAnimationFrame(fn){frames.set(++serial,fn);return serial;},cancelAnimationFrame(id){frames.delete(id);}});
vm.runInContext(await readFile(new URL("../site/overlay-bounds.js",import.meta.url),"utf8"),runtime);
const {normalize,fromPoints,translate,create}=window.HuayuOverlayBounds;
const plain=value=>JSON.parse(JSON.stringify(value));
const base={west:151,east:152,south:18,north:19};
for(const invalid of [null,{}, {...base,west:""},{...base,west:null},{...base,north:Infinity},
  {...base,east:150},{...base,north:18},{...base,east:182},{...base,south:-86},{...base,east:151.0000001}]) {
  assert.equal(normalize(invalid),null,"invalid form coordinates cannot create an uploadable selection");
}
for(const bounds of [base,{west:-180,east:-150,south:55,north:85},{west:150,east:180,south:-85,north:-55},
  {...base,east:181},{...base,north:86},{...base,east:151.0000001}]) {
  assert.deepEqual(plain(normalize(bounds)),validateOverlayBounds(bounds),"accepted coordinates match the server limits");
}
assert.deepEqual(plain(fromPoints({lat:19,lng:152},{lat:18,lng:151})),base);
for(const delta of [{lat:100,lng:100},{lat:-200,lng:-400},{lat:1,lng:2}]) {
  const moved=plain(translate(base,delta));assert.ok(normalize(moved));
  assert.equal(moved.east-moved.west,1);assert.equal(moved.north-moved.south,1);
}
function interaction(on=true){return {on,enabled(){return this.on;},enable(){this.on=true;},disable(){this.on=false;}};}
const map={getContainer:()=>container,getSize:()=>({x:800,y:600}),stop(){},
  mouseEventToLatLng:e=>({lng:150+e.clientX/100,lat:20-e.clientY/100}),
  mouseEventToContainerPoint:e=>({x:e.clientX,y:e.clientY}),
  latLngToContainerPoint:p=>({x:(p.lng-150)*100,y:(20-p.lat)*100}),
  dragging:interaction(),doubleClickZoom:interaction(),boxZoom:interaction(false),touchZoom:interaction(),
  on(){},off(){this.removed=true;}};
const editor=create({map,onChange:(bounds,meta)=>changes.push({bounds:plain(bounds),...meta}),
  onState:next=>state=plain(next),onError:()=>errors++});
editor.setVisible(true);editor.setBounds(base);
const down=(x,y,props={})=>container.dispatch("pointerdown",{clientX:x,clientY:y,...props});
const move=(x,y,props={})=>document.dispatch("pointermove",{target:container,clientX:x,clientY:y,...props});
const up=(x,y,props={})=>document.dispatch("pointerup",{target:container,clientX:x,clientY:y,...props});
const bounds=()=>plain(editor.getBounds());
const flush=()=>{for(const [id,fn] of frames){frames.delete(id);fn();}};
editor.begin();down(250,250);move(350,400);up(350,400);
assert.deepEqual(bounds(),{west:152.5,east:153.5,south:16,north:17.5});
assert.equal(state.editing,false);assert.equal(map.dragging.enabled(),true);assert.equal(map.boxZoom.enabled(),false);
assert.equal(container.dispatch("click").prevented,true,"the completing click cannot select a map object");
editor.begin();down(100,100);up(100,100);move(300,300);down(300,300);up(300,300);
assert.deepEqual(bounds(),{west:151,east:153,south:17,north:19});
editor.setBounds(base);down(200,100);move(240,80);up(240,80);
assert.deepEqual(bounds(),{west:151,east:152.4,south:18,north:19.2});
editor.setBounds(base);container.dispatch("dblclick",{clientX:200,clientY:100});move(250,50);down(250,50);up(250,50);
assert.deepEqual(bounds(),{west:151,east:152.5,south:18,north:19.5});assert.equal(state.editing,false);
editor.setBounds(base);down(150,150,{button:2});move(190,120,{button:2});up(190,120,{button:2});
assert.deepEqual(bounds(),{west:151.4,east:152.4,south:18.3,north:19.3});
assert.equal(container.dispatch("contextmenu",{clientX:190,clientY:120}).prevented,true);
editor.setBounds(base);down(150,150,{button:2});up(150,150,{button:2});
assert.equal(editor.isEditing(),false,"a stationary right-click must not lock map dragging");
editor.beginMove();down(150,150,{pointerType:"touch"});move(170,130,{pointerType:"touch"});up(170,130,{pointerType:"touch"});
assert.deepEqual(bounds(),{west:151.2,east:152.2,south:18.2,north:19.2});
editor.setBounds(base);down(200,100);move(100,200);up(100,200);
assert.deepEqual(bounds(),base,"invalid zero-size resizing restores the original valid frame");
assert.equal(errors,1);
for(const cancel of [()=>document.dispatch("keydown",{key:"Escape"}),()=>document.dispatch("pointercancel"),
  ()=>window.dispatch("blur"),()=>editor.setVisible(false)]) {
  editor.setVisible(true);editor.setBounds(base);editor.begin();down(300,300);move(500,500);cancel();
  assert.deepEqual(bounds(),base);assert.equal(map.dragging.enabled(),true);assert.equal(map.boxZoom.enabled(),false);
}
editor.setVisible(true);editor.setImage("blob:test",.6);flush();
assert.equal(container.children[0].children[0].attributes.href,"blob:test");
assert.equal(container.children[0].children[0].attributes.opacity,"0.6");
editor.cancel(true);flush();assert.equal(container.children[0].style.display,"none");
editor.destroy();assert.equal(map.removed,true);assert.equal(container.children[0].removed,true);
for(const target of [document,window,container])assert.ok([...target.listeners.values()].every(set=>set.size===0));
assert.equal(frames.size,0);
console.log("Overlay bounds passed: coordinate limits, reverse corners, draw/two-point/resize/translation, touch, invalid selection, rollback, original map interactions, image preview and cleanup.");
