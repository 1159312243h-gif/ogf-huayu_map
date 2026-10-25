(function (root) {
  "use strict";
  const VERSION = "7.5-roof-only-v1", PREFIX = "ogf-atlas-sun-shadow";
  const scriptUrl = root.document?.currentScript?.src;
  const R = 6378137, rad = Math.PI / 180, MAX_VERTICES = 400000;
  const project = point => [R * point[0] * rad,
    R * Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, point[1])) * rad / 2))];
  const unproject = point => [point[0] / R / rad, (2 * Math.atan(Math.exp(point[1] / R)) - Math.PI / 2) / rad];
  const polygons = f => f.geometry?.type === "Polygon" ? [f.geometry.coordinates]
    : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : [];

  // Keep original rings, holes, parts and heights. Prepared data is local to the
  // worker and replaced only when the complete displayed building owner changes.
  function prepare(data) {
    const items = [];
    const modeled = new Map((root.HuayuBuildingRoofs?.describe(data) || [])
      .map(item => [item.feature.id, item.triangles]));
    for (const feature of data?.features || []) {
      const p = feature.properties || {}, height = Number(p.renderHeight), bottom = Number(p.renderMinHeight || 0);
      if (p.structureKind && p.structureKind !== "building") continue;
      if (!Number.isFinite(height) || !Number.isFinite(bottom) || height <= bottom || height <= 0) continue;
      const rings = polygons(feature);
      if (!rings.length || !rings.every(poly => poly.length && poly.every(ring => ring.length >= 4
        && ring.every(pt => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))))) continue;
      const mercator = rings.map(poly => poly.map(ring => ring.map(project)));
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      let vertices = 0;
      for (const poly of mercator) for (const ring of poly) for (const pt of ring) {
        bounds[0] = Math.min(bounds[0], pt[0]); bounds[1] = Math.min(bounds[1], pt[1]);
        bounds[2] = Math.max(bounds[2], pt[0]); bounds[3] = Math.max(bounds[3], pt[1]); vertices++;
      }
      const lat = (rings[0][0][0][1] + rings[0][0][1][1]) / 2;
      const scale = 1 / Math.cos(lat * rad);
      const roof = modeled.get(feature.id) || [];
      items.push({rings: mercator, bounds, height, bottom, scale, vertices,
        roofOnly: p.roofOnly === 1 && roof.length > 0,
        eaves: roof.length ? Number(p.roofBaseHeight) : height,
        roof: roof.map(triangle => triangle.points.map(pt => [...project(pt), pt[2]]))});
    }
    return items;
  }
  // Shadow projection uses building height above its local ground plane. The
  // resulting mask drapes with MapLibre terrain; it is not terrain ray tracing.
  function offset(sun, height, scale = 1) {
    if (!(sun?.up > 0)) return [0, 0];
    return [-sun.east / sun.up * height * scale, -sun.north / sun.up * height * scale];
  }
  function faces(item, sun, shaped) {
    const shift = (point, height) => {
      const delta = offset(sun, height, item.scale);
      return [point[0] + delta[0], point[1] + delta[1]];
    };
    const top = shaped && item.roof.length ? item.eaves : item.height;
    const result = [];
    if (!(shaped && item.roofOnly)) for (const poly of item.rings) {
      // Even-odd filling preserves courtyard voids. Swept inner walls then cast
      // their real shadows into the courtyard without erasing other buildings.
      result.push(poly.map(ring => ring.map(pt => shift(pt, top))));
      if (item.bottom > 0) result.push(poly.map(ring => ring.map(pt => shift(pt, item.bottom))));
      for (const ring of poly) for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        result.push([[shift(a, item.bottom), shift(b, item.bottom), shift(b, top), shift(a, top)]]);
      }
    }
    if (shaped) for (const triangle of item.roof) result.push([triangle.map(pt => shift(pt, pt[2]))]);
    return result;
  }
  function drawMask(context, items, job) {
    const {extent, width, height, sun, shaped} = job;
    const sx = width / (extent[2] - extent[0]), sy = height / (extent[3] - extent[1]);
    context.clearRect(0, 0, width, height); context.fillStyle = "#000000";
    let count = 0, vertices = 0, omitted = 0;
    for (const item of items) {
      const shift = offset(sun, item.height, item.scale), b = item.bounds;
      if (b[2] + Math.max(0, shift[0]) < extent[0] || b[0] + Math.min(0, shift[0]) > extent[2]
        || b[3] + Math.max(0, shift[1]) < extent[1] || b[1] + Math.min(0, shift[1]) > extent[3]) continue;
      if (vertices + item.vertices > MAX_VERTICES) {omitted++; continue;}
      vertices += item.vertices; count++;
      for (const face of faces(item, sun, shaped)) {
        context.beginPath();
        for (const ring of face) {
          ring.forEach((pt, i) => context[i ? "lineTo" : "moveTo"]((pt[0] - extent[0]) * sx, (extent[3] - pt[1]) * sy));
          context.closePath();
        }
        // All casters are opaque in ONE mask. Overlap never compounds darkness.
        context.fill("evenodd");
      }
    }
    return {count, vertices, omitted};
  }

  const inWorker = typeof root.document === "undefined" && typeof root.importScripts === "function";
  if (inWorker) {
    root.importScripts(`./building-roofs.js?v=${VERSION}`);
    let items = [], revision = 0;
    root.onmessage = async ({data: message}) => {
      try {
        if (message.type === "buildings") {items = prepare(message.data); revision = message.revision; return;}
        const {job} = message;
        if (message.type !== "render" || revision !== job.revision) return;
        const canvas = new OffscreenCanvas(job.width, job.height), context = canvas.getContext("2d");
        const stats = drawMask(context, items, job);
        // A small physical penumbra, applied after the union, softens raster edges.
        const output = new OffscreenCanvas(job.width, job.height), out = output.getContext("2d");
        out.filter = `blur(${Math.min(2, Math.max(.6, job.width / (job.extent[2] - job.extent[0]) * .4))}px)`;
        out.drawImage(canvas, 0, 0);
        const blob = await output.convertToBlob({type: "image/png"});
        root.postMessage({id: job.id, revision: job.revision, blob, stats});
      } catch (error) {root.postMessage({id: message.job?.id, revision: message.job?.revision, error: String(error.message || error)});}
    };
  }

  class Controller {
    constructor(map) {
      this.map = map; this.alive = true; this.revision = 0; this.sequence = 0; this.state = "off";
      this.onStart = () => {this.moving = true; this.cancel();};
      this.onEnd = () => {this.moving = false; this.schedule();};
      this.onData = e => {
        if (e.sourceId === this.pending?.id && map.isSourceLoaded(e.sourceId)) this.commit();
      };
      this.onError = e => {if (e.sourceId === this.pending?.id) this.fail();};
      this.onRender = () => {
        const shaped = this.shaped();
        if (shaped !== this.lastShaped) {this.lastShaped = shaped; this.schedule();}
      };
      for (const event of ["movestart", "zoomstart", "rotatestart", "pitchstart"]) map.on(event, this.onStart);
      for (const event of ["moveend", "zoomend", "rotateend", "pitchend"]) map.on(event, this.onEnd);
      map.on("sourcedata", this.onData); map.on("error", this.onError); map.on("render", this.onRender);
    }
    notify(state) {
      if (this.state === state) return;
      this.state = state;
      root.dispatchEvent(new root.CustomEvent("huayu-sunlight-status"));
    }
    setBuildings(data, enabled) {
      if (this.data !== data) {this.data = data; this.revision++; this.sentRevision = null; this.cancel();}
      if (this.owner !== Boolean(enabled)) {this.owner = Boolean(enabled); this.cancel();}
      if (!this.owner) {this.clear(); this.stopWorker();}
      this.schedule();
    }
    update(light, settings) {
      this.light = light; this.settings = settings;
      const key = light && settings.shadows && settings.shadowOpacity > 0 && light.sun.altitude > 0
        ? `${settings.date}:${settings.minutes}:${this.map.getCenter().lat.toFixed(2)}` : "off";
      if (key !== this.key) {
        this.key = key; this.failedKey = null; this.cancel(); this.clear();
        this.notify(key === "off" ? "off" : "preparing");
      }
      if (key === "off") {this.stopWorker(); this.notify("off"); return;}
      this.opacity = settings.shadowOpacity / 100 * Math.min(1, light.sun.altitude / 6);
      if (this.display && this.map.getLayer(this.display.id)
        && this.map.getPaintProperty(this.display.id, "raster-opacity") !== this.opacity)
        this.map.setPaintProperty(this.display.id, "raster-opacity", this.opacity);
      this.schedule();
    }
    cancel() {
      this.sequence++; root.clearTimeout(this.timer);
      if (!this.workerBusy) root.clearTimeout(this.watchdog);
      this.timer = null; this.job = null; this.removeImage(this.pending); this.pending = null;
    }
    shaped() {return Boolean(root.HuayuBuildingRoofs?.get(this.map)?.layer?.enabled);}
    wanted() {return this.alive && this.key && this.key !== "off" && this.owner && this.data
      && this.map.getZoom() >= 14 && !this.moving;}
    schedule() {
      if (!this.alive) return;
      if (this.failedKey === `${this.key}:${this.revision}`) return;
      if (!this.wanted()) {
        if (this.key !== "off" && !this.moving) {this.clear(); this.notify(this.map.getZoom() < 14 ? "zoom" : "waiting");}
        return;
      }
      if (this.timer || this.job || this.pending || this.workerBusy) return;
      this.timer = root.setTimeout(() => {this.timer = null; if (this.wanted()) this.render();}, 120);
    }
    bounds() {
      const b = this.map.getBounds(), sw = project([b.getWest(), b.getSouth()]), ne = project([b.getEast(), b.getNorth()]);
      const dx = ne[0] - sw[0], dy = ne[1] - sw[1];
      return [sw[0] - dx * .15, sw[1] - dy * .15, ne[0] + dx * .15, ne[1] + dy * .15];
    }
    render() {
      const extent = this.bounds(), shaped = this.shaped();
      const signature = `${this.key}:${this.revision}:${shaped}:${extent.map(v => Math.round(v)).join(":")}`;
      if (this.display?.signature === signature && this.map.getLayer(this.display.id)) return;
      if (!root.Worker || !root.OffscreenCanvas) {this.notify("unavailable"); return;}
      try {
        if (!this.worker) {
          this.worker = new root.Worker(new URL(`sunlight-shadows.js?v=${VERSION}`, scriptUrl));
          this.worker.onmessage = event => {
            this.workerBusy = false; root.clearTimeout(this.watchdog);
            if (event.data.error && event.data.id == null) {this.fail(); return;}
            this.receive(event.data); this.schedule();
          };
          this.worker.onerror = () => this.fail();
        }
        if (this.sentRevision !== this.revision) {
          this.worker.postMessage({type: "buildings", data: this.data, revision: this.revision});
          this.sentRevision = this.revision;
        }
        const spanX = extent[2] - extent[0], spanY = extent[3] - extent[1];
        const canvas = this.map.getCanvas(), longest = Math.min(2048, Math.max(768, Math.max(canvas.width, canvas.height) * 1.3));
        const pixelScale = longest / Math.max(spanX, spanY);
        const job = {id: ++this.sequence, revision: this.revision, extent, shaped, signature,
          width: Math.max(1, Math.round(spanX * pixelScale)), height: Math.max(1, Math.round(spanY * pixelScale)), sun: this.light.sun};
        this.job = job; this.workerBusy = true; this.worker.postMessage({type: "render", job}); this.notify("preparing");
        this.watchdog = root.setTimeout(() => this.fail(), 20000);
      } catch {this.fail();}
    }
    receive(result) {
      if (!this.alive || !this.wanted() || result.id !== this.job?.id || result.revision !== this.revision) return;
      if (result.error) {this.fail(); return;}
      const job = this.job; this.job = null;
      const id = `${PREFIX}-${job.id}`, url = root.URL.createObjectURL(result.blob), e = job.extent;
      const coordinates = [unproject([e[0], e[3]]), unproject([e[2], e[3]]), unproject([e[2], e[1]]), unproject([e[0], e[1]])];
      this.pending = {id, url, signature: job.signature, stats: result.stats};
      this.watchdog = root.setTimeout(() => this.fail(), 20000);
      try {
        this.map.addSource(id, {type: "image", url, coordinates});
        const layers = this.map.getLayersOrder?.().map(id => this.map.style?.getLayer?.(id) || this.map.getLayer(id))
          || this.map.getStyle().layers;
        const before = layers.find(l => l.type === "fill-extrusion" || l.type === "symbol")?.id;
        this.map.addLayer({id, type: "raster", source: id, metadata: {"huayu:sun-shadow": true},
          paint: {"raster-opacity": 0, "raster-opacity-transition": {duration: 0}, "raster-fade-duration": 0}}, before);
      } catch {this.fail();}
    }
    commit() {
      if (!this.alive || !this.pending || !this.wanted()) return;
      const old = this.display; this.display = this.pending; this.pending = null;
      root.clearTimeout(this.watchdog);
      this.map.setPaintProperty(this.display.id, "raster-opacity", this.opacity);
      this.removeImage(old); this.notify("ready");
    }
    removeImage(image) {
      if (!image) return;
      if (this.map.style || this.map.getStyle?.()) {
        if (this.map.getLayer(image.id)) this.map.removeLayer(image.id);
        if (this.map.getSource(image.id)) this.map.removeSource(image.id);
      }
      root.URL.revokeObjectURL(image.url);
    }
    clear() {this.removeImage(this.display); this.display = null;}
    stopWorker() {this.worker?.terminate(); this.worker = null; this.workerBusy = false; this.sentRevision = null; root.clearTimeout(this.watchdog);}
    fail() {this.failedKey = `${this.key}:${this.revision}`; this.cancel(); this.stopWorker(); this.notify("unavailable");}
    destroy() {
      this.alive = false; this.cancel(); this.clear(); this.stopWorker(); this.data = null;
      for (const event of ["movestart", "zoomstart", "rotatestart", "pitchstart"]) this.map.off(event, this.onStart);
      for (const event of ["moveend", "zoomend", "rotateend", "pitchend"]) this.map.off(event, this.onEnd);
      this.map.off("sourcedata", this.onData); this.map.off("error", this.onError); this.map.off("render", this.onRender);
    }
  }
  root.HuayuSunShadows = {prepare, project, unproject, offset, faces, drawMask, Controller, create: map => new Controller(map)};
})(typeof window !== "undefined" ? window : globalThis);
