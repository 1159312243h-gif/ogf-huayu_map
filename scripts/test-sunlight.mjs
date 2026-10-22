import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "../site/three-0.160.1.module.min.js";
const source = await readFile(new URL("../site/sunlight.js", import.meta.url), "utf8");
function harness(saved) {
  const events = new Map(), visibility = new Set(), storage = new Map(), timers = new Map();
  let now = Date.parse("2026-10-20T04:34:45Z"), sequence = 0, storageWrites = 0;
  // Device local time is UTC+8 even when the test runner uses another zone.
  const local = date => new Date(date.getTime() + 8 * 3600000);
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [now]));}
    static now() {return now;}
    getFullYear() {return local(this).getUTCFullYear();}
    getMonth() {return local(this).getUTCMonth();}
    getDate() {return local(this).getUTCDate();}
    getHours() {return local(this).getUTCHours();}
    getMinutes() {return local(this).getUTCMinutes();}
  }
  if (saved != null) storage.set("ogf-atlas-sunlight-v1", typeof saved === "string" ? saved : JSON.stringify(saved));
  const context = vm.createContext({Date: ClockDate,
    localStorage: {getItem: k => storage.get(k), setItem: (k, v) => {storageWrites++; storage.set(k, v);}},
    CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
    addEventListener: (type, fn) => {if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn);},
    removeEventListener: (type, fn) => events.get(type)?.delete(fn),
    dispatchEvent: event => {for (const fn of events.get(event.type) || []) fn(event);},
    document: {hidden: false, addEventListener: (type, fn) => visibility.add(fn), removeEventListener: (type, fn) => visibility.delete(fn)},
    setTimeout: (fn, delay) => {const id = ++sequence; timers.set(id, {fn, at: now + delay}); return id;},
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  return {context, api: context.HuayuSunlight, events, storage, timers, visibility,
    get storageWrites() {return storageWrites;},
    jump(iso) {
      now = Date.parse(iso);
      for (const [id, timer] of [...timers]) if (timer.at <= now) {timers.delete(id); timer.fn();}
    },
    hide(hidden) {context.document.hidden = hidden; for (const fn of visibility) fn();},
  };
}
const initial = harness(), {context, events} = initial;
const api = context.HuayuSunlight, copy = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(copy(api.getPreferences()), copy(api.DEFAULTS));
assert.deepEqual(copy(api.normalize({enabled: "true", minutes: "720", contrast: null, brightness: NaN, season: "wrong"})), copy(api.DEFAULTS));
assert.ok(api.solarPosition(0, 720, "2026-03-20").altitude > 89.5);
assert.ok(api.solarPosition(14.6, 420, "2026-03-20").east > 0, "morning sun is in the east");
assert.ok(api.solarPosition(14.6, 1020, "2026-03-20").east < 0, "afternoon sun is in the west");
assert.ok(api.solarPosition(40, 720, "2026-06-21").altitude > api.solarPosition(40, 720, "2026-12-21").altitude);
assert.ok(api.solarPosition(-40, 720, "2026-12-21").altitude > api.solarPosition(-40, 720, "2026-06-21").altitude,
  "calendar date has opposite seasons in the viewed hemispheres");
for (const date of ["2024-02-29", "2000-02-29", "2026-10-18", "0001-01-01", "9999-12-31"]) assert.equal(api.validDate(date), true);
for (const date of ["2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "", null]) {
  assert.equal(api.validDate(date), false);
  assert.equal(api.normalize({date}).date, api.DEFAULTS.date);
}
assert.equal(api.normalize({season: "winter"}).date.slice(5), "12-21", "migrate earlier stored representative season");
const before = api.solarPosition(40, 720, "2026-04-13").altitude, after = api.solarPosition(40, 720, "2026-04-14").altitude;
assert.ok(after > before && after - before < .5, "arbitrary adjacent dates change continuously");
for (const lat of [-85, -67, 0, 14.6, 67, 85]) for (const date of ["2026-03-20", "2026-06-21", "2026-12-21"]) for (const minutes of [0, 360, 720, 1080, 1439]) {
  const result = api.lighting(lat, {...api.DEFAULTS, date, minutes});
  assert.ok(Object.values(result.sun).every(Number.isFinite));
  assert.ok(result.native.position.every(Number.isFinite));
  assert.ok(result.native.position[2] >= 0 && result.native.position[2] <= 90);
  if (result.sun.altitude < -6) assert.equal(result.direct, 0, "no direct sunlight below the horizon");
  if (result.sun.altitude < -6) assert.match(result.color, /^#([0-9a-f]{2})\1\1$/u, "night light must be neutral, without a blue tint");
}
let light = {anchor: "map", position: [1.15, 210, 35], color: "#fffdf8", intensity: .48};
const original = copy(light), listeners = new Map(), gradients = new Map([["walls", true], ["roof", false]]);
const layers = [{id: "walls", type: "fill-extrusion"}, {id: "roof", type: "fill-extrusion"}];
let latitude = 40, writes = 0;
const map = {getLight: () => light, setLight: v => {light = copy(v); writes++;},
  getStyle: () => ({metadata: {"ogf-atlas:theme": "huayu-day"}, layers}), getCenter: () => ({lat: latitude}),
  on: (type, fn) => listeners.set(type, fn), off: type => listeners.delete(type),
  getLayer: id => layers.find(l => l.id === id), getPaintProperty: id => gradients.get(id),
  setPaintProperty: (id, key, value) => {gradients.set(id, value); writes++;}, triggerRepaint() {},
};
const controller = api.sync(map);
assert.equal(api.getPreferences().enabled, true, "first use enables sunlight");
assert.equal(api.getPreferences().timeMode, "realtime");
assert.equal(api.getPreferences().date, "2026-10-20");
assert.equal(api.getPreferences().minutes, 12 * 60 + 34, "use the device's local clock, not UTC");
assert.ok(writes > 0 && controller.current, "default settings apply current sunlight");
assert.equal(initial.timers.size, 1);
api.setPreferences({enabled: true, date: "2026-06-21", minutes: 420});
const morning = copy(light);
assert.equal(light.anchor, "map"); assert.equal(gradients.get("walls"), false);
assert.ok(light.intensity < .2, "default sunlight keeps white shaded walls recognisable");
const stable = writes; controller.apply(); assert.equal(writes, stable, "stable settings never resubmit light or paint");
const scene = new THREE.Scene(), ambient = new THREE.AmbientLight("#ffffff", 1.6), direct = new THREE.DirectionalLight("#ffffff", 1.1);
direct.position.set(-60, -40, 100); scene.add(ambient, direct);
api.applyScene(map, scene); assert.ok(direct.position.x > 0);
api.setPreferences({minutes: 1020}); api.applyScene(map, scene);
assert.ok(direct.position.x < 0); assert.notDeepEqual(copy(light.position), morning.position);
api.setPreferences({minutes: 720}); latitude = -40; listeners.get("moveend")();
assert.ok(controller.current.sun.north > 0, "moving hemispheres updates the sun after the gesture");
api.setPreferences({minutes: 0}); api.applyScene(map, scene);
assert.equal(ambient.color.r, ambient.color.g); assert.equal(ambient.color.g, ambient.color.b);
assert.equal(direct.intensity, 0);
api.setPreferences({minutes: 720});
// Native inward normals are east/south; Three's outward normals are east/north.
for (const [nativeNormal, meshNormal] of [[[-1, 0, 0], [1, 0, 0]], [[0, 1, 0], [0, 1, 0]]]) {
  const sun = controller.current.sun;
  const nativeDot = nativeNormal[0] * -sun.east + nativeNormal[1] * sun.north;
  const meshDot = meshNormal[0] * sun.east + meshNormal[1] * sun.north;
  assert.ok(Math.abs(nativeDot - meshDot) < 1e-12, "native walls and custom meshes face the same sun");
}
layers.push({id: "late", type: "fill-extrusion"}); gradients.set("late", true); listeners.get("styledata")();
assert.equal(gradients.get("late"), false, "late complete building snapshots inherit sunlight without reprocessing geometry");
api.setPreferences({enabled: false}); api.applyScene(map, scene);
assert.deepEqual(light, original); assert.equal(gradients.get("walls"), true); assert.equal(gradients.get("roof"), false);
assert.equal(ambient.intensity, 1.6); assert.equal(direct.intensity, 1.1); assert.deepEqual(direct.position.toArray(), [-60, -40, 100]);
context.localStorage.setItem = () => {throw new Error("denied");};
assert.equal(api.setPreferences({enabled: true}), false); assert.equal(api.getPreferences().enabled, true);
api.dispose(map); assert.equal(listeners.size, 0); assert.equal(events.get("huayu-sunlight-change").size, 0);
assert.equal(initial.timers.size, 0); assert.equal(initial.visibility.size, 0);
assert.deepEqual(light, original);
for (const theme of ["huayu-satellite-v3", "other"]) assert.equal(api.sync({...map, getStyle: () => ({metadata: {"ogf-atlas:theme": theme}})}), null);
const fastMap = {...map, style: {stylesheet: {metadata: {"ogf-atlas:theme": "huayu-day"}},getLayer: id=>layers.find(l=>l.id===id)},
  getLayersOrder:()=>layers.map(l=>l.id), getStyle:()=>{throw new Error("must not serialize complete live GeoJSON during light updates");}};
const fastController=api.sync(fastMap);
api.setPreferences({date:"2026-10-18",minutes:660});fastController.apply();api.dispose(fastMap);
// Real clock lifecycle: surface and shadow inputs must stay on the same instant.
const live = harness(), liveApi = live.api, shadowCalls = [];
live.context.HuayuSunShadows = {create: () => ({update: (value, settings) => shadowCalls.push({value, settings}), destroy() {}})};
let liveLight = copy(original), theme = "huayu-day";
const liveListeners = new Map(), liveMap = {...map,
  getLight: () => liveLight, setLight: value => {liveLight = copy(value);},
  getStyle: () => ({metadata: {"ogf-atlas:theme": theme}, layers: []}),
  on: (type, fn) => liveListeners.set(type, fn), off: type => liveListeners.delete(type),
};
const liveController = liveApi.sync(liveMap);
assert.equal([...live.timers.values()][0].at, Date.parse("2026-10-20T04:35:00Z"), "tick on the minute boundary");
const initialSun = copy(liveController.current.sun);
live.jump("2026-10-20T04:35:00Z");
assert.equal(liveApi.getPreferences().minutes, 755);
assert.notDeepEqual(copy(liveController.current.sun), initialSun);
assert.deepEqual(copy(shadowCalls.at(-1).value.sun), copy(liveController.current.sun));
assert.equal(shadowCalls.at(-1).settings.minutes, 755);
for (let i = 0; i < 5; i++) liveController.apply();
assert.equal(live.timers.size, 1, "style and move events cannot duplicate clock timers");
live.jump("2026-10-20T16:00:12Z");
assert.equal(liveApi.getPreferences().date, "2026-10-21");
assert.equal(shadowCalls.at(-1).settings.date, "2026-10-21", "crossing device midnight updates shadows' date too");
assert.equal(shadowCalls.at(-1).settings.minutes, 0, "late timers read the actual clock without accumulating drift");
assert.equal([...live.timers.values()][0].at, Date.parse("2026-10-20T16:01:00Z"));
live.hide(true); assert.equal(live.timers.size, 0, "hidden tabs stop clock work");
live.jump("2028-02-29T02:21:18Z");
const beforeReturn = shadowCalls.length;
live.hide(false);
assert.equal(shadowCalls.length, beforeReturn + 1);
assert.equal(shadowCalls.at(-1).settings.date, "2028-02-29");
assert.equal(shadowCalls.at(-1).settings.minutes, 621, "returning from sleep immediately catches up");
assert.equal(live.storageWrites, 0, "automatic ticks never write saved preferences");
liveApi.setPreferences({date: "2030-06-21"});
assert.equal(liveApi.getPreferences().timeMode, "manual");
assert.equal(liveApi.getPreferences().minutes, 621, "date-only edits preserve the latest clock time");
assert.equal(live.timers.size, 0);
const manualSun = copy(liveController.current.sun);
live.jump("2028-03-01T06:12:00Z"); live.hide(true); live.hide(false);
assert.equal(liveApi.getPreferences().date, "2030-06-21");
assert.equal(liveApi.getPreferences().minutes, 621);
assert.deepEqual(copy(liveController.current.sun), manualSun, "manual preview stays frozen across time and visibility changes");
const reloadedManual = harness(live.storage.get(liveApi.STORAGE_KEY)).api.getPreferences();
assert.equal(reloadedManual.date, "2030-06-21"); assert.equal(reloadedManual.minutes, 621);
liveApi.setPreferences({timeMode: "realtime"});
assert.equal(liveApi.getPreferences().date, "2028-03-01"); assert.equal(liveApi.getPreferences().minutes, 852);
assert.equal(live.timers.size, 1, "return to reality resumes continuous following");
liveApi.setPreferences({minutes: 420});
assert.equal(liveApi.getPreferences().timeMode, "manual");
assert.equal(liveApi.getPreferences().date, "2028-03-01", "time-only edits retain the current date");
liveApi.setPreferences(liveApi.DEFAULTS);
assert.equal(liveApi.getPreferences().timeMode, "realtime");
assert.equal(liveApi.getPreferences().date, "2028-03-01", "reset uses the current date, not the page-load date");
assert.equal(liveApi.getPreferences().minutes, 852);
assert.equal(harness(live.storage.get(liveApi.STORAGE_KEY)).api.getPreferences().minutes, 754, "reloading realtime ignores saved stale dates and minutes");
liveApi.setPreferences({timeMode: "manual"});
assert.equal(liveApi.getPreferences().minutes, 852); assert.equal(live.timers.size, 0);
liveApi.setPreferences({timeMode: "realtime", enabled: false});
assert.equal(live.timers.size, 0); assert.equal(liveController.current, null);
assert.deepEqual(liveLight, original);
liveApi.setPreferences({enabled: true}); assert.equal(live.timers.size, 1);
theme = "huayu-satellite-v3"; liveController.apply();
assert.equal(live.timers.size, 0); assert.equal(liveController.current, null);
theme = "huayu-night"; liveController.apply(); assert.equal(live.timers.size, 1);
liveApi.dispose(liveMap);
assert.equal(live.timers.size, 0); assert.equal(live.visibility.size, 0); assert.equal(liveListeners.size, 0);
assert.deepEqual(liveLight, original);
for (const saved of [null, "{broken", {}]) {
  const settings = harness(saved).api.getPreferences();
  assert.equal(settings.enabled, true); assert.equal(settings.timeMode, "realtime");
}
assert.equal(harness({enabled: false}).api.getPreferences().enabled, false, "explicit old off preference remains off");
const old = harness({enabled: true, date: "2024-02-29", minutes: 421}).api.getPreferences();
assert.equal(old.timeMode, "manual"); assert.equal(old.date, "2024-02-29"); assert.equal(old.minutes, 421);
const legacy = harness({enabled: false, season: "winter", minutes: 1020}).api.getPreferences();
assert.equal(legacy.timeMode, "manual"); assert.equal(legacy.date, "2026-12-21"); assert.equal(legacy.minutes, 1020); assert.equal(legacy.enabled, false);
console.log("Sunlight passed: real local clock defaults, minute boundaries, midnight, sleep, manual freeze, return-now/reset/reload, legacy preferences, arbitrary calendar dates, hemispheres/polar night, neutral night, consistent directions, shadow time, stable writes and cleanup.");
