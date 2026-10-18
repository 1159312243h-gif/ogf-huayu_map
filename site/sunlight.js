(function (root) {
  "use strict";
  const STORAGE_KEY = "ogf-atlas-sunlight-v1";
  const today = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const DEFAULTS = Object.freeze({enabled: false, date: today(), minutes: 720, brightness: 100, contrast: 35,
    shadows: true, shadowOpacity: 28});
  const controllers = new WeakMap(), scenes = new WeakMap();
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  const number = (v, fallback, low, high) => typeof v === "number" && Number.isFinite(v) ? clamp(v, low, high) : fallback;
  const validDate = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)
    && value.slice(0, 4) !== "0000" && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  function normalize(value) {
    const legacy = {spring: "03-20", summer: "06-21", autumn: "09-22", winter: "12-21"}[value?.season];
    return {enabled: value?.enabled === true,
      date: validDate(value?.date) ? value.date : legacy ? `${DEFAULTS.date.slice(0, 4)}-${legacy}` : DEFAULTS.date,
      minutes: Math.round(number(value?.minutes, DEFAULTS.minutes, 0, 1439)),
      brightness: Math.round(number(value?.brightness, DEFAULTS.brightness, 50, 150)),
      contrast: Math.round(number(value?.contrast, DEFAULTS.contrast, 0, 100)),
      shadows: value?.shadows !== false,
      shadowOpacity: Math.round(number(value?.shadowOpacity, DEFAULTS.shadowOpacity, 0, 60))};
  }
  let preferences;
  try { preferences = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); }
  catch { preferences = {...DEFAULTS}; }
  // Local apparent solar time avoids imposing real-world time zones on OGF.
  // Calendar date supplies solar declination (NOAA solar-coordinate equations).
  // The same date has opposite seasons in the two hemispheres.
  function solarPosition(latitude, minutes, date) {
    const lat = clamp(Number(latitude) || 0, -85, 85) * Math.PI / 180;
    const radians = Math.PI / 180;
    const julian = Date.parse(`${validDate(date) ? date : DEFAULTS.date}T12:00:00Z`) / 86400000 + 2440587.5;
    const century = (julian - 2451545) / 36525;
    const meanLongitude = (280.46646 + century * (36000.76983 + century * .0003032)) % 360;
    const anomaly = (357.52911 + century * (35999.05029 - .0001537 * century)) * radians;
    const center = Math.sin(anomaly) * (1.914602 - century * (.004817 + .000014 * century))
      + Math.sin(2 * anomaly) * (.019993 - .000101 * century) + Math.sin(3 * anomaly) * .000289;
    const omega = (125.04 - 1934.136 * century) * radians;
    const longitude = (meanLongitude + center - .00569 - .00478 * Math.sin(omega)) * radians;
    const obliquity = (23 + (26 + (21.448 - century * (46.815 + century * (.00059 - .001813 * century))) / 60) / 60
      + .00256 * Math.cos(omega)) * radians;
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
    const hour = (clamp(Number(minutes) || 0, 0, 1439) / 60 - 12) * Math.PI / 12;
    const east = -Math.cos(declination) * Math.sin(hour);
    const north = Math.cos(lat) * Math.sin(declination) - Math.sin(lat) * Math.cos(declination) * Math.cos(hour);
    const up = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hour);
    const altitude = Math.asin(clamp(up, -1, 1)) * 180 / Math.PI;
    const azimuth = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
    return {altitude, azimuth, east, north, up};
  }
  function lighting(latitude, settings = preferences) {
    const sun = solarPosition(latitude, settings.minutes, settings.date);
    const daylight = clamp((sun.altitude + 6) / 16, 0, 1);
    const warmth = 1 - clamp(sun.altitude / 35, 0, 1);
    const gain = settings.brightness / 100;
    const rgb = [1, 1 - .13 * warmth, 1 - .26 * warmth].map((v, i) =>
      clamp(((1 - daylight) * .42 + daylight * v) * gain, 0, 1));
    const color = "#" + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const intensity = settings.contrast / 100 * .42 / Math.sqrt(gain) * daylight;
    return {sun, daylight, color, intensity, ambient: (1.6 - settings.contrast / 100 * .65) * (.32 + .68 * daylight) * gain,
      direct: settings.contrast / 100 * 1.8 * daylight * gain,
      native: {anchor: "map", position: [1, sun.azimuth, 90 - Math.max(0, sun.altitude)], color, intensity}};
  }
  class Controller {
    constructor(map) {
      this.map = map; this.alive = true; this.gradients = new Map(); this.revision = 0;
      this.styleRef = map.style;
      this.original = JSON.parse(JSON.stringify(map.getLight()));
      this.shadows = root.HuayuSunShadows?.create(map);
      this.onChange = () => this.apply();
      this.onMove = () => this.apply();
      this.onStyle = () => {if (!this.applying) this.apply();};
      this.onRemove = () => this.destroy(false);
      map.on("moveend", this.onMove); map.on("styledata", this.onStyle); map.on("remove", this.onRemove);
      root.addEventListener("huayu-sunlight-change", this.onChange);
      this.apply();
    }
    apply() {
      if (!this.alive || this.applying) return;
      // getStyle() also serializes every live GeoJSON source. Time-slider input
      // only needs metadata and layer definitions, not megabytes of model data.
      const style = this.map.style?.stylesheet || this.map.getStyle?.();
      if (!style) return;
      this.applying = true;
      try {
        if (this.map.style && this.map.style !== this.styleRef) {
          this.styleRef = this.map.style; this.original = JSON.parse(JSON.stringify(this.map.getLight()));
          this.gradients.clear(); this.signature = null;
        }
        const latitude = this.map.getCenter().lat;
        const theme = String(style.metadata?.["ogf-atlas:theme"] || "");
        const next = preferences.enabled && theme.startsWith("huayu") && !theme.startsWith("huayu-satellite") ? lighting(latitude) : null;
        let changed = false;
        const sceneSignature = JSON.stringify(next);
        if (this.sceneSignature !== sceneSignature) {this.sceneSignature = sceneSignature; this.revision++;}
        const signature = JSON.stringify(next?.native || this.original);
        this.current = next;
        this.shadows?.update(next, preferences);
        if ((signature !== this.signature || next && JSON.stringify(this.map.getLight()) !== signature) && (next || this.signature)) {
          this.map.setLight(next?.native || this.original, {duration: 0});
          this.signature = signature; changed = true;
        }
        const layers = this.map.getLayersOrder?.().map(id => this.map.style?.getLayer?.(id) || this.map.getLayer(id)) || style.layers || [];
        for (const layer of layers) {
          if (layer.type !== "fill-extrusion") continue;
          if (next && !this.gradients.has(layer.id)) {
            this.gradients.set(layer.id, this.map.getPaintProperty(layer.id, "fill-extrusion-vertical-gradient") ?? true);
          }
          if (!next && !this.gradients.has(layer.id)) continue;
          const desired = next ? false : this.gradients.get(layer.id);
          if (this.map.getPaintProperty(layer.id, "fill-extrusion-vertical-gradient") !== desired) {
            this.map.setPaintProperty(layer.id, "fill-extrusion-vertical-gradient", desired); changed = true;
          }
        }
        if (!next) this.gradients.clear();
        if (changed) this.map.triggerRepaint();
        const statusSignature = `${latitude}:${sceneSignature}`;
        if (this.statusSignature !== statusSignature) {
          this.statusSignature = statusSignature;
          root.dispatchEvent(new root.CustomEvent("huayu-sunlight-status", {detail: {latitude, active: Boolean(next), sun: next?.sun}}));
        }
      } finally { this.applying = false; }
    }
    destroy(restore = true) {
      if (!this.alive) return;
      this.alive = false;
      this.map.off("moveend", this.onMove); this.map.off("styledata", this.onStyle); this.map.off("remove", this.onRemove);
      root.removeEventListener("huayu-sunlight-change", this.onChange);
      this.shadows?.destroy();
      if (restore && this.signature && (this.map.style || this.map.getStyle?.())) {
        this.map.setLight(this.original, {duration: 0});
        for (const [id, gradient] of this.gradients) if (this.map.getLayer(id))
          this.map.setPaintProperty(id, "fill-extrusion-vertical-gradient", gradient);
      }
      this.gradients.clear(); controllers.delete(this.map);
    }
  }
  function applyScene(map, scene) {
    if (!scene) return;
    let state = scenes.get(scene);
    if (!state) {
      state = {lights: scene.children.filter(l => l.isAmbientLight || l.isDirectionalLight).map(light =>
        ({light, intensity: light.intensity, color: light.color.clone(), position: light.position.clone()}))};
      scenes.set(scene, state);
    }
    const controller = controllers.get(map), current = controller?.current;
    const signature = current ? controller.sceneSignature : "default";
    if (state.signature === signature) return;
    state.signature = signature;
    for (const item of state.lights) {
      const {light} = item;
      if (!current) {light.intensity = item.intensity; light.color.copy(item.color); light.position.copy(item.position); continue;}
      light.intensity = light.isAmbientLight ? current.ambient : current.direct;
      light.color.set(light.isAmbientLight ? "#ffffff" : current.color);
      if (light.isDirectionalLight) light.position.set(current.sun.east * 100, current.sun.north * 100, Math.max(.01, current.sun.up) * 100);
    }
  }
  root.HuayuSunlight = {STORAGE_KEY, DEFAULTS, today, validDate, normalize, solarPosition, lighting, applyScene,
    getPreferences: () => ({...preferences}),
    setPreferences(changes) {
      preferences = normalize({...preferences, ...changes});
      let saved = true;
      try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { saved = false; }
      root.dispatchEvent(new root.CustomEvent("huayu-sunlight-change", {detail: {saved}})); return saved;
    },
    sync(map) {
      const theme = String((map?.style?.stylesheet || map?.getStyle?.())?.metadata?.["ogf-atlas:theme"] || "");
      if (!theme.startsWith("huayu") || theme.startsWith("huayu-satellite")) {
        controllers.get(map)?.destroy(); return null;
      }
      let controller = controllers.get(map);
      if (!controller) {controller = new Controller(map); controllers.set(map, controller);}
      return controller;
    },
    get: map => controllers.get(map),
    syncBuildings(map, data, enabled) {controllers.get(map)?.shadows?.setBuildings(data, enabled);},
    dispose: map => controllers.get(map)?.destroy(),
  };
})(typeof window !== "undefined" ? window : globalThis);
