/* The perspective presentation uses the existing material mesh, including its
 * observed elevations and valleys. No second mountain field is inferred here. */
(function (root) {
  "use strict";
  function clamp(v, a, b) {return Math.max(a, Math.min(b, v));}
  function mix(a, b, t) {return a + (b - a) * t;}
  function smooth(a, b, v) {const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t);}
  function mercator([lng, lat]) {return [(lng + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2];}
  function latitude(y) {return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;}
  function tileBounds(z, x, y) {
    const n = 2 ** z;
    return {west: x / n * 360 - 180, east: (x + 1) / n * 360 - 180,
      north: latitude(y / n), south: latitude((y + 1) / n)};
  }
  function intersects(a, b) {
    return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
  }
  function surfaceCandidates(block, view) {
    if (!block.surfaceIndex) {
      const cells = Array.from({length: 1024}, () => []), bounds = block.bounds;
      const entries = block.surfaces.map((surface, index) => {
        const polygons = surface.geometry.type === "Polygon" ? [surface.geometry.coordinates] : surface.geometry.coordinates;
        const parts = polygons.map(polygon => {
          const box = {west: Infinity, east: -Infinity, south: Infinity, north: -Infinity};
          for (const [x, y] of polygon[0]) {
            box.west = Math.min(box.west, x); box.east = Math.max(box.east, x);
            box.south = Math.min(box.south, y); box.north = Math.max(box.north, y);
          }
          return {polygon, bounds: box};
        });
        for (const part of parts) {
          const box = part.bounds;
          const axis = (v, lo, hi) => clamp(Math.floor((v - lo) / (hi - lo) * 32), 0, 31);
          for (let y = axis(box.south, bounds.south, bounds.north); y <= axis(box.north, bounds.south, bounds.north); y++) {
            for (let x = axis(box.west, bounds.west, bounds.east); x <= axis(box.east, bounds.west, bounds.east); x++) {
              cells[y * 32 + x].push(index);
            }
          }
        }
        return {surface, index, parts};
      });
      block.surfaceIndex = {cells, entries};
    }
    const bounds = block.bounds, selected = new Set(), {cells, entries} = block.surfaceIndex;
    const axis = (v, lo, hi) => clamp(Math.floor((v - lo) / (hi - lo) * 32), 0, 31);
    for (let y = axis(view.south, bounds.south, bounds.north); y <= axis(view.north, bounds.south, bounds.north); y++) {
      for (let x = axis(view.west, bounds.west, bounds.east); x <= axis(view.east, bounds.west, bounds.east); x++) {
        for (const index of cells[y * 32 + x]) selected.add(index);
      }
    }
    return [...selected].sort((a, b) => a - b).map(index => entries[index])
      .filter(entry => entry.parts.some(part => intersects(part.bounds, view)));
  }
  function surfaceMask(surfaces, z, x, y, size, outerOnly = false, candidates = null) {
    const pixels = new Uint8ClampedArray(size * size * 4);
    const n = 2 ** z;
    const project = coordinate => {const [mx, my] = mercator(coordinate); return [(mx * n - x) * size, (my * n - y) * size];};
    const view = tileBounds(z, x, y);
    candidates ||= surfaceCandidates({surfaces, bounds: view}, view);
    const draw = ({surface, index, parts}) => {
      for (const {polygon, bounds} of parts) {
        if (!intersects(bounds, view)) continue;
        const rows = Array.from({length: size}, () => []);
        for (const ring of outerOnly ? polygon.slice(0, 1) : polygon) {
          for (let i = 1; i < ring.length; i++) {
            const [ax, ay] = project(ring[i - 1]), [bx, by] = project(ring[i]);
            if (ay === by) continue;
            const first = Math.max(0, Math.ceil(Math.min(ay, by) - 0.5));
            const last = Math.min(size, Math.ceil(Math.max(ay, by) - 0.5));
            for (let row = first; row < last; row++) rows[row].push(ax + (bx - ax) * (row + 0.5 - ay) / (by - ay));
          }
        }
        for (let row = 0; row < size; row++) {
          const xs = rows[row].sort((a, b) => a - b);
          for (let i = 1; i < xs.length; i += 2) {
            const first = Math.max(0, Math.ceil(xs[i - 1] - 0.5));
            const last = Math.min(size, Math.ceil(xs[i] - 0.5));
            for (let col = first; col < last; col++) {
              const offset = (row * size + col) * 4, owner = index + 1;
              pixels[offset] = surface.properties?.reliefLandKind === "garden" ? 128
                : surface.properties?.reliefLandKind === "open" ? 0 : 255;
              pixels[offset + 1] = owner % 256; pixels[offset + 2] = Math.floor(owner / 256);
              pixels[offset + 3] = 255;
            }
          }
        }
      }
    };
    candidates.forEach(entry => {if (entry.surface.properties?.reliefLandKind === "open") draw(entry);});
    candidates.forEach(entry => {if (entry.surface.properties?.reliefLandKind !== "open") draw(entry);});
    return pixels;
  }
  function noise(x, y) {
    const hash = (x, y) => {const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return v - Math.floor(v);};
    const ix = Math.floor(x), iy = Math.floor(y);
    let u = x - ix, v = y - iy; u *= u * (3 - 2 * u); v *= v * (3 - 2 * v);
    return mix(mix(hash(ix, iy), hash(ix + 1, iy), u), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), u), v);
  }
  function shade(sample, wx, wy, zoom, palette, pixelSlope) {
    const {height, interval, relief, nx, ny, nz, kind, regional} = sample;
    const low = kind === "open" ? palette.openLow : kind === "garden" ? palette.gardenLow : palette.low;
    const high = kind === "open" ? palette.openHigh : kind === "garden" ? palette.gardenHigh : palette.high;
    const scale = 2 ** zoom * 256 * 0.22, detail = smooth(7.5, 13.5, zoom), overview = smooth(5.5, 10, zoom);
    const tx = wx - 0.9, ty = wy - 0.45;
    const broad = noise(tx * Math.min(95000, scale), ty * Math.min(95000, scale));
    const medium = noise(tx * Math.min(310000, scale * 1.8) + 17, ty * Math.min(310000, scale * 1.8) + 43);
    const fineScale = Math.min(mix(310000, 1150000, detail), scale * 2.5);
    const fine = noise(tx * fineScale + 71, ty * fineScale + 19);
    const canopy = broad * 0.38 + medium * 0.32 + mix(medium, fine, detail) * 0.3;
    const grainScale = Math.min(mix(310000, 1150000, detail), 2 ** zoom * 256 * 0.55);
    const grain = smooth(0.58, 0.82, noise(tx * grainScale + 113, ty * grainScale + 29)) * overview;
    let texture = clamp(mix(1, 0.86 + canopy * 0.26 - grain * 0.1, smooth(0.015, 0.28, relief)), 0.78, 1.02);
    if (kind === "open") texture = 0.97 + canopy * 0.06;
    if (kind === "garden") texture = 0.98 + canopy * 0.04;
    texture = mix(1, texture, mix(0.28, 1, overview));
    const normalLength = Math.hypot(nx, ny, nz) || 1, lightLength = Math.hypot(-0.42, -0.34, 0.84);
    const light = clamp(1 + ((nx * -0.42 + ny * -0.34 + nz * 0.84) / normalLength / lightLength - 0.84) * 0.9, 0.72, 1.1);
    const width = Math.max(pixelSlope / interval, 0.00015);
    const line = (period, width, strength, visibility) => {
      const phase = Math.max(0, height) / period % 1;
      return (1 - smooth(width * (strength > 0.5 ? 0.5 : 0.35), width * 1.1, Math.min(phase, 1 - phase)))
        * strength * visibility * (1 - smooth(0.16, 0.4, width));
    };
    const minor = line(interval, width, 0.36, regional ? smooth(8.5, 11, zoom) : smooth(7.5, 9.5, zoom));
    const major = line(interval * 5, width / 5, 0.72, smooth(5.75, 8, zoom));
    const contour = Math.max(minor, major) * smooth(interval * 0.2, interval * 0.8, height) * (kind === "garden" ? 0.85 : 1);
    return low.map((v, i) => Math.round(clamp(mix(mix(v, high[i], smooth(0.08, 1, relief))
      * mix(1, light, mix(0.4, 1, overview)) * texture, palette.contour[i], contour), 0, 1) * 255));
  }
  function triangleCandidates(block, z, x, y) {
    if (!block.triangleIndex) {
      const nw = mercator([block.bounds.west, block.bounds.north]), se = mercator([block.bounds.east, block.bounds.south]);
      const origin = mercator([(block.bounds.west + block.bounds.east) / 2, (block.bounds.south + block.bounds.north) / 2]);
      const cells = Array.from({length: 1024}, () => []), v = block.values;
      for (let start = 0; start < v.length; start += 27) {
        const xs = [0, 9, 18].map(i => (v[start + i] + origin[0] - nw[0]) / (se[0] - nw[0]) * 32);
        const ys = [1, 10, 19].map(i => (v[start + i] + origin[1] - nw[1]) / (se[1] - nw[1]) * 32);
        for (let row = clamp(Math.floor(Math.min(...ys)), 0, 31); row <= clamp(Math.floor(Math.max(...ys)), 0, 31); row++) {
          for (let col = clamp(Math.floor(Math.min(...xs)), 0, 31); col <= clamp(Math.floor(Math.max(...xs)), 0, 31); col++) cells[row * 32 + col].push(start);
        }
      }
      block.triangleIndex = {nw, se, cells};
    }
    const {nw, se, cells} = block.triangleIndex, n = 2 ** z, selected = new Set();
    const firstX = clamp(Math.floor((x / n - nw[0]) / (se[0] - nw[0]) * 32), 0, 31);
    const lastX = clamp(Math.floor(((x + 1) / n - nw[0]) / (se[0] - nw[0]) * 32), 0, 31);
    const firstY = clamp(Math.floor((y / n - nw[1]) / (se[1] - nw[1]) * 32), 0, 31);
    const lastY = clamp(Math.floor(((y + 1) / n - nw[1]) / (se[1] - nw[1]) * 32), 0, 31);
    for (let row = firstY; row <= lastY; row++) for (let col = firstX; col <= lastX; col++) for (const start of cells[row * 32 + col]) selected.add(start);
    return selected;
  }
  function rasterize(block, z, x, y, size, heights, colors, attributes) {
    const {values, surfaces, bounds} = block, n = 2 ** z;
    const origin = mercator([(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2]);
    const candidates = surfaceCandidates(block, tileBounds(z, x, y));
    const owners = surfaceMask(surfaces, z, x, y, size, false, candidates);
    // Clearings, buildings and water cut the colour material, not the ground
    // underneath them. They inherit the exact same mountain elevations.
    const ground = surfaceMask(surfaces, z, x, y, size, true, candidates);
    const maskOwner = (pixels, offset) => pixels[offset + 1] + pixels[offset + 2] * 256;
    const nw = mercator([bounds.west, bounds.north]), se = mercator([bounds.east, bounds.south]);
    // A completed fine cell replaces its whole footprint, including its skirt
    // and truly empty ground. Taking max(old, fine) outside the colour polygon
    // kept coarse high vertices and made a sawtooth rim around refined hills.
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const wx = (x + (col + 0.5) / size) / n, wy = (y + (row + 0.5) / size) / n;
      if (wx >= nw[0] && wx < se[0] && wy >= nw[1] && wy < se[1]) {
        heights[row * size + col] = 0; colors[(row * size + col) * 4 + 3] = 0;
      }
    }
    for (const start of triangleCandidates(block, z, x, y)) {
      const point = i => [(values[start + i * 9] + origin[0]) * n * size - x * size,
        (values[start + i * 9 + 1] + origin[1]) * n * size - y * size];
      const a = point(0), b = point(1), c = point(2);
      const firstX = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]) - 0.5));
      const lastX = Math.min(size - 1, Math.floor(Math.max(a[0], b[0], c[0]) - 0.5));
      const firstY = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) - 0.5));
      const lastY = Math.min(size - 1, Math.floor(Math.max(a[1], b[1], c[1]) - 0.5));
      if (firstX > lastX || firstY > lastY) continue;
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-12) continue;
      const encoded = values[start + 8], owner = Math.floor(Math.abs(encoded) / 256);
      const kind = values[start + 6] >= 4 ? "garden" : values[start + 6] >= 2 ? "open" : "wood";
      const interval = Math.max(1, Math.abs(encoded) % 256);
      const h0 = values[start + 7], h1 = values[start + 16], h2 = values[start + 25];
      const dx = ((b[1] - c[1]) * (h0 - h2) + (c[1] - a[1]) * (h1 - h2)) / det;
      const dy = ((c[0] - b[0]) * (h0 - h2) + (a[0] - c[0]) * (h1 - h2)) / det;
      const pixelSlope = Math.abs(dx) + Math.abs(dy);
      for (let row = firstY; row <= lastY; row++) for (let col = firstX; col <= lastX; col++) {
        const u = ((b[1] - c[1]) * (col + 0.5 - c[0]) + (c[0] - b[0]) * (row + 0.5 - c[1])) / det;
        const v = ((c[1] - a[1]) * (col + 0.5 - c[0]) + (a[0] - c[0]) * (row + 0.5 - c[1])) / det;
        if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
        const index = row * size + col, offset = index * 4;
        const wx = (x + (col + 0.5) / size) / n, wy = (y + (row + 0.5) / size) / n;
        if (wx < nw[0] || wx >= se[0] || wy < nw[1] || wy >= se[1]) continue;
        const groundOwner = maskOwner(ground, offset);
        if (groundOwner && groundOwner !== owner) continue;
        const at = field => values[start + field] * u + values[start + 9 + field] * v + values[start + 18 + field] * (1 - u - v);
        const height = at(7);
        if (!groundOwner) {
          // Preserve the boundary triangles' taper within THIS completed cell.
          heights[index] = Math.max(heights[index], height);
          continue;
        }
        heights[index] = height;
        // A finer block owns this pixel, including a real hole: never retain
        // an older overview colour beneath a newly refined clearing.
        colors[offset + 3] = 0;
        if (maskOwner(owners, offset) !== owner) continue;
        attributes.set([interval, at(6) - (kind === "garden" ? 4 : kind === "open" ? 2 : 0),
          at(3), at(4), at(5), kind === "garden" ? 2 : kind === "open" ? 1 : 0, encoded < 0 ? 1 : 0, pixelSlope], index * 8);
        colors[offset + 3] = kind === "garden" ? 214 : 255;
      }
    }
  }
  function colorize(heights, colors, attributes, z, x, y, size, palette) {
    const n = 2 ** z;
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const i = row * size + col, at = i * 8;
      if (!colors[i * 4 + 3]) continue;
      colors.set(shade({height: heights[i], interval: attributes[at], relief: attributes[at + 1],
        nx: attributes[at + 2], ny: attributes[at + 3], nz: attributes[at + 4],
        kind: attributes[at + 5] === 2 ? "garden" : attributes[at + 5] === 1 ? "open" : "wood", regional: attributes[at + 6]},
      (x + (col + 0.5) / size) / n, (y + (row + 0.5) / size) / n, z, palette, attributes[at + 7]), i * 4);
    }
  }
  function encodeDem(heights) {
    const bytes = new Uint8ClampedArray(heights.length * 4);
    for (let i = 0; i < heights.length; i++) {
      const value = clamp(Math.round((heights[i] + 10000) * 10), 0, 16777215);
      bytes[i * 4] = Math.floor(value / 65536); bytes[i * 4 + 1] = Math.floor(value / 256) % 256;
      bytes[i * 4 + 2] = value % 256; bytes[i * 4 + 3] = 255;
    }
    return bytes;
  }
  function cutContext(colors, contexts, z, x, y, size) {
    const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(colors, size, size), 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    const n = 2 ** z;
    const project = coordinate => {const [mx, my] = mercator(coordinate); return [(mx * n - x) * size, (my * n - y) * size];};
    for (const feature of contexts) {
      // Integrated garden material is already part of the same surface.
      if (feature.properties?.materialOcclusion === "garden") continue;
      const geometry = feature.geometry;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
        : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
      for (const polygon of polygons) {
        ctx.beginPath();
        for (const ring of polygon) {ring.forEach((p, i) => {const xy = project(p); i ? ctx.lineTo(...xy) : ctx.moveTo(...xy);}); ctx.closePath();}
        ctx.fill("evenodd");
      }
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
      const meters = 40075016.7 * Math.cos(latitude((y + 0.5) / n) * Math.PI / 180) / n / size;
      ctx.lineWidth = Math.max(0.75, (Number(feature.properties?.width) || 4) / meters);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const line of lines) {ctx.beginPath(); line.forEach((p, i) => {const xy = project(p); i ? ctx.lineTo(...xy) : ctx.moveTo(...xy);}); ctx.stroke();}
    }
    return canvas;
  }
  function contextCandidates(block, view) {
    // Published packets include a whole region's river and building context.
    // Test their cached bounds before constructing any canvas paths.
    block.contextBounds ||= (block.contexts || []).map(feature => {
      const bounds = {west:Infinity,east:-Infinity,south:Infinity,north:-Infinity};
      const scan = coordinates => {
        if (typeof coordinates[0] === "number") {
          bounds.west = Math.min(bounds.west, coordinates[0]); bounds.east = Math.max(bounds.east, coordinates[0]);
          bounds.south = Math.min(bounds.south, coordinates[1]); bounds.north = Math.max(bounds.north, coordinates[1]);
        } else for (const part of coordinates) scan(part);
      };
      scan(feature.geometry.coordinates);
      return {feature,bounds};
    });
    return block.contextBounds.filter(entry => intersects(entry.bounds, view)).map(entry => entry.feature);
  }
  function tileSources(sources, bounds) {
    // Only the finest complete cells are needed where they fully cover a tile.
    // Rectangle subtraction also handles a tile crossing several fine cells.
    const subtract = (box, cover) => {
      if (!intersects(box, cover)) return [box];
      const w = Math.max(box.west, cover.west), e = Math.min(box.east, cover.east);
      const s = Math.max(box.south, cover.south), n = Math.min(box.north, cover.north);
      return [{...box, east: w}, {...box, west: e},
        {west: w, east: e, south: box.south, north: s}, {west: w, east: e, south: n, north: box.north}]
        .filter(part => part.east > part.west && part.north > part.south);
    };
    const selected = [];
    for (let i = sources.length - 1; i >= 0; i--) {
      const source = sources[i];
      if (!intersects(source.bounds, bounds)) continue;
      let uncovered = [{west: Math.max(source.bounds.west, bounds.west), east: Math.min(source.bounds.east, bounds.east),
        south: Math.max(source.bounds.south, bounds.south), north: Math.min(source.bounds.north, bounds.north)}];
      for (const finer of selected) uncovered = uncovered.flatMap(box => subtract(box, finer.bounds));
      if (uncovered.length) selected.push(source);
    }
    return selected.reverse();
  }
  function workerMain() {
    const packets = new Map(), inflight = new Map(), tiles = new Map(), cancelled = new Set();
    const blockWaiters = new Map(), pairs = new Map(), queue = [];
    const fingerprint = crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      [clamp, mix, smooth, mercator, latitude, tileBounds, intersects, surfaceCandidates, surfaceMask,
        noise, shade, triangleCandidates, rasterize, colorize, encodeDem, cutContext, contextCandidates, tileSources, workerMain].map(f => f.toString()).join("\n")))
      .then(buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join(""));
    let dbPromise, emptyPair;
    const database = () => dbPromise ||= new Promise(resolve => {
      let settled = false;
      const finish = db => {if (settled) {db?.close?.(); return;} settled = true; clearTimeout(timer); resolve(db);};
      const timer = setTimeout(() => finish(null), 500);
      try {
        const request = indexedDB.open("ogf-atlas-terrain-drape-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("tiles", {keyPath: "key"}).createIndex("usedAt", "usedAt");
        request.onsuccess = () => finish(request.result); request.onerror = request.onblocked = () => finish(null);
      } catch {finish(null);}
    });
    const stored = async key => {
      const db = await database(); if (!db) return null;
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 100);
        try {
          const request = db.transaction("tiles").objectStore("tiles").get(key);
          request.onsuccess = () => {clearTimeout(timer); resolve(request.result?.material && request.result?.elevation ? request.result : null);};
          request.onerror = () => {clearTimeout(timer); resolve(null);};
        } catch {clearTimeout(timer); resolve(null);}
      });
    };
    const persist = async entry => {
      const db = await database(); if (!db) return;
      try {
        const store = db.transaction("tiles", "readwrite").objectStore("tiles");
        store.put({...entry, usedAt: Date.now()});
        const rows = [], request = store.index("usedAt").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {rows.push(cursor.value); cursor.continue(); return;}
          let bytes = rows.reduce((n, row) => n + row.material.size + row.elevation.size, 0), count = rows.length;
          for (const row of rows) {if (count <= 96 && bytes <= 32 * 1024 * 1024) break; store.delete(row.key); bytes -= row.material.size + row.elevation.size; count--;}
        };
      } catch { /* Denied/full storage never interrupts terrain presentation. */ }
    };
    const load = descriptor => {
      const key = descriptor.key;
      if (packets.has(key)) {const p = packets.get(key); packets.delete(key); packets.set(key, p); return Promise.resolve(p);}
      if (inflight.has(key)) return inflight.get(key);
      const promise = (async () => {
        if (!descriptor.url) {
          // Main-thread geometry remains resident independently of this bounded
          // tile worker. Recover an evicted complete cell instead of caching an
          // overview under the finer cell's immutable identity.
          return new Promise(resolve => {
            const timer = setTimeout(() => {blockWaiters.delete(key); resolve(null);}, 2000);
            blockWaiters.set(key, block => {clearTimeout(timer); resolve(block);});
            self.postMessage({needBlock: key});
          });
        }
        const response = await fetch(descriptor.url, {cache: "force-cache", signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw new Error(`TERRAIN_MESH_HTTP_${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        const text = data[0] === 31 && data[1] === 139
          ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
          : new TextDecoder().decode(data);
        const packet = JSON.parse(text);
        if (packet.format !== 1 || packet.model !== "woodland-material-overview-v1"
          || packet.coordinateSpace !== "cell-local-v1" || !packet.surfaces?.length) throw new Error("INVALID_TERRAIN_MESH");
        const encoded = atob(packet.vertices), bytes = Uint8Array.from(encoded, c => c.charCodeAt(0));
        if (!bytes.length || bytes.length % 108) throw new Error("INVALID_TERRAIN_TRIANGLES");
        const result = {values: new Float32Array(bytes.buffer), surfaces: packet.surfaces,
          contexts: packet.occlusions || [], bounds: packet.cell.bounds};
        packets.set(key, result); prune(); return result;
      })().finally(() => inflight.delete(key));
      inflight.set(key, promise); return promise;
    };
    const prune = () => {
      const bytes = p => p.values.byteLength + (p.metadataBytes ||= JSON.stringify([p.surfaces, p.contexts]).length * 2)
        + (p.triangleIndex?.cells.reduce((n, cell) => n + cell.length * 8, 0) || 0)
        + (p.surfaceIndex?.cells.reduce((n, cell) => n + cell.length * 8, 0) || 0);
      let size = [...packets.values()].reduce((n, p) => n + bytes(p), 0);
      for (const [key, p] of packets) {
        if (size <= 64 * 1024 * 1024 && packets.size <= 64) break;
        size -= bytes(p); packets.delete(key);
      }
    };
    let active = 0;
    const drain = () => {
      while (active < 4 && queue.length) {
        const job = queue.shift();
        if (cancelled.delete(job.id)) continue;
        active++;
        run(job).finally(() => {active--; drain();});
      }
    };
    const run = async job => {
      try {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
            `${await fingerprint}:${JSON.stringify(job.palette)}:${job.sources.map(s => s.cacheKey || s.key).join('|')}/${job.z}/${job.x}/${job.y}`));
          const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
          let task = pairs.get(key);
          if (!task) {
            task = (async () => {
              let cached = tiles.get(key) || await stored(key);
              if (cached) return cached;
              const loadStarted = performance.now();
              // Start downloads together. A missing national packet must not
              // stop every other tile from downloading behind a serial queue.
              const selected = tileSources(job.sources, tileBounds(job.z, job.x, job.y));
              const blocks = await Promise.all(selected.map(load));
              if (blocks.some(block => !block)) throw new Error("TERRAIN_MESH_NOT_READY");
              const loadMs = Math.round(performance.now() - loadStarted);
            const size = 256, heights = new Float32Array(size * size), colors = new Uint8ClampedArray(size * size * 4);
            const attributes = new Float32Array(size * size * 8), contexts = new Map();
            const started = performance.now();
            // Coarse complete packets remain the fallback. Fine, completed
            // cells replace their pixels without constructing another field.
            for (const block of blocks) {
              rasterize(block, job.z, job.x, job.y, size, heights, colors, attributes);
              for (const feature of contextCandidates(block, tileBounds(job.z, job.x, job.y))) contexts.set(String(feature.id), feature);
            }
            const rasterMs = Math.round(performance.now() - started);
            // Most surrounding tiles contain actual flat ground. Reuse one
            // transparent material / zero DEM pair instead of scheduling two
            // expensive PNG encodes per empty tile. Missing meshes still reject
            // above; a material clearing over raised ground is never empty.
            const empty = !heights.some(height => height !== 0)
              && !colors.some((value, index) => index % 4 === 3 && value !== 0);
            let shadeMs = 0;
            const encode = async () => {
              if (!empty) colorize(heights, colors, attributes, job.z, job.x, job.y, size, job.palette);
              shadeMs = Math.round(performance.now() - started) - rasterMs;
              const image = cutContext(colors, empty ? [] : [...contexts.values()], job.z, job.x, job.y, size);
              const dem = new OffscreenCanvas(size, size);
              dem.getContext("2d").putImageData(new ImageData(encodeDem(heights), size, size), 0, 0);
              return Promise.all([image.convertToBlob({type: "image/png"}), dem.convertToBlob({type: "image/png"})]);
            };
            const [material, elevation] = await (empty ? emptyPair ||= encode().catch(error => {
              emptyPair = null; throw error;
            }) : encode());
              const result = {material, elevation, cpuMs: Math.round(performance.now() - started), loadMs, rasterMs, shadeMs};
              prune(); void persist({key, ...result});
              return result;
            })().finally(() => pairs.delete(key));
            pairs.set(key, task);
          }
          const result = await task;
          tiles.delete(key); tiles.set(key, result);
          let tileBytes = [...tiles.values()].reduce((n, t) => n + t.material.size + t.elevation.size, 0);
          for (const [oldKey, tile] of tiles) {if (tiles.size <= 64 && tileBytes <= 16 * 1024 * 1024) break; tileBytes -= tile.material.size + tile.elevation.size; tiles.delete(oldKey);}
          const buffer = await result[job.kind].arrayBuffer();
          if (!cancelled.delete(job.id)) self.postMessage({id: job.id, buffer, cpuMs: result.cpuMs, loadMs: result.loadMs || 0,
            rasterMs: result.rasterMs || 0, shadeMs: result.shadeMs || 0}, [buffer]);
        } catch (error) {if (!cancelled.delete(job.id)) self.postMessage({id: job.id, error: String(error.message || error)});}
    };
    self.onmessage = ({data: job}) => {
      if (job.block) {packets.set(job.key, job.block); blockWaiters.get(job.key)?.(job.block); blockWaiters.delete(job.key); prune(); return;}
      if (job.cancel) {
        const index = queue.findIndex(queued => queued.id === job.cancel);
        if (index >= 0) queue.splice(index, 1); else cancelled.add(job.cancel);
        return;
      }
      queue.push(job); drain();
    };
  }
  let sequence = 0;
  class Controller {
    constructor(map, material, options) {
      this.map = map; this.material = material; this.options = options;
      this.scheme = `huayuterrain${++sequence}`; this.revision = 0; this.records = new Map();
      this.packetSizes = new WeakMap();
      this.pending = new Map(); this.sequence = 0; this.ready = false;
      this.source = `${material.id}-surface`; this.dem = `${material.id}-elevation`;
      const source = [clamp, mix, smooth, mercator, latitude, tileBounds, intersects, surfaceCandidates, surfaceMask,
        noise, shade, triangleCandidates, rasterize, colorize, encodeDem, cutContext, contextCandidates, tileSources, workerMain]
        .map(f => f.toString()).join("\n") + "\nworkerMain();";
      const url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
      this.worker = new Worker(url); URL.revokeObjectURL(url);
      this.worker.onmessage = ({data}) => {
        if (data.needBlock) {
          // Each revision owns immutable packet references. A refinement can
          // replace the live block while an older visible tile is still loading.
          for (const record of this.records.values()) {
            const packet = record.packets.get(data.needBlock);
            if (packet) {this.worker.postMessage({key: data.needBlock, block: packet}); break;}
          }
          return;
        }
        const pending = this.pending.get(data.id); if (!pending) return;
        this.pending.delete(data.id);
        if (data.error) {
          this.lastError = data.error; pending.reject(new Error(data.error));
          if (!this.ready) {this.setEnabled(false); this.failed = true;}
        }
        else {this.tileCount = (this.tileCount || 0) + 1; this.cpuMs = data.cpuMs; this.loadMs = data.loadMs;
          this.rasterMs = data.rasterMs; this.shadeMs = data.shadeMs; pending.resolve({data: data.buffer});}
        this.options.onTile?.();
      };
      this.worker.onerror = () => {
        this.lastError = "TERRAIN_DRAPE_WORKER_FAILED";
        for (const pending of this.pending.values()) pending.reject(new Error(this.lastError));
        this.pending.clear(); this.setEnabled(false); this.failed = true; this.options.onTile?.();
      };
      this.protocol = async (request, abort) => {
        const parts = request.url.slice(request.url.indexOf("://") + 3).split("/");
        const [kind, revision, z, x, y] = [parts[0], ...parts.slice(1).map(v => Number.parseInt(v, 10))];
        if (!["material", "elevation"].includes(kind) || ![revision, z, x, y].every(Number.isFinite)) throw new Error("INVALID_TERRAIN_TILE");
        const bounds = tileBounds(z, x, y), record = this.records.get(revision);
        if (!record) throw new Error("EXPIRED_TERRAIN_PRESENTATION");
        const sources = record.sources.filter(source => intersects(source.bounds, bounds));
        // Absence in a complete published inventory means real flat ground;
        // an unavailable packet rejects the pair, never returns a false zero.
        return new Promise((resolve, reject) => {
          const id = ++this.sequence;
          const cancelled = () => {this.pending.delete(id); this.worker.postMessage({cancel: id}); reject(new DOMException("Aborted", "AbortError"));};
          if (abort?.signal?.aborted) {cancelled(); return;}
          abort?.signal?.addEventListener("abort", cancelled, {once: true});
          const finish = f => value => {abort?.signal?.removeEventListener("abort", cancelled); f(value);};
          this.pending.set(id, {resolve: finish(resolve), reject: finish(reject)});
          this.worker.postMessage({id, kind, revision, z, x, y, sources, palette: this.options.palette});
        });
      };
      options.library.addProtocol(this.scheme, this.protocol);
      this.onEnd = () => this.schedule(); map.on("moveend", this.onEnd);
    }
    register(block, packet) {
      if (!packet?.values) return;
      if (block.perspectiveRegisteredController === this && block.perspectiveRegisteredPacket === packet) return;
      block.perspectiveRegisteredController = this;
      block.perspectiveRegisteredPacket = packet;
      block.perspectiveKey = `${block.key}:${++this.sequence}`;
      // The worker asks only for packets needed by its visible tile queue.
      // Cloning all previously visited cells here stalls the UI unnecessarily.
    }
    sources() {
      const material = this.material, manifest = material.publishedManifest;
      const sources = (manifest?.renderBlocks || []).map(entry => ({key: entry.url,
        url: new URL(entry.url, root.location.href).href, bounds: entry.cell.bounds, level: -1}));
      for (const block of material.blocks.values()) {
        if (!block.perspectivePacket || block.publishedUrl) continue;
        if (manifest && block.perspectivePacket.generation !== manifest.generatedAt) continue;
        this.register(block, block.perspectivePacket);
        sources.push({key: block.perspectiveKey, cacheKey: block.perspectivePacket.cacheKey, bounds: block.bounds,
          level: block.level, span: block.span, packet: block.perspectivePacket});
      }
      return sources.sort((a, b) => a.level - b.level || (b.span || 8) - (a.span || 8));
    }
    pruneRecords() {
      const bytes = () => {
        const seen = new Set(); let total = 0;
        for (const record of this.records.values()) for (const packet of record.packets.values()) {
          if (seen.has(packet)) continue;
          seen.add(packet);
          if (!this.packetSizes.has(packet)) this.packetSizes.set(packet,
            packet.values.byteLength + JSON.stringify([packet.surfaces, packet.contexts]).length * 2);
          total += this.packetSizes.get(packet);
        }
        return total;
      };
      for (const revision of this.records.keys()) {
        if (this.records.size <= 8 && bytes() <= 64 * 1024 * 1024) break;
        // Current and displayed references already belong to the complete live
        // material; retain them even when one large packet exceeds the budget.
        if (revision !== this.revision && revision !== this.presentedRevision) this.records.delete(revision);
      }
    }
    schedule() {
      if (!this.enabled) return;
      clearTimeout(this.timer); this.timer = setTimeout(() => {
        if (this.material.interacting || this.map.isMoving()) return;
        // Receive all cells from one complete refinement before changing the
        // native source URLs; individual arrivals must not restart every tile.
        if (this.material.rebuildPromise) {this.schedule(); return;}
        void this.refresh();
      }, 650);
    }
    warmTiles(revision, signal) {
      const box = this.map.getBounds(), center = this.map.getCenter();
      const view = {west: box.getWest(), east: box.getEast(), south: box.getSouth(), north: box.getNorth()};
      const jobs = [];
      const add = (kind, maximum) => {
        // Native raster coverage rounds zoom and accounts for its 256px tiles
        // against MapLibre's 512px map tiles. The DEM terrain manager uses
        // 512px coverage. Warming both at floor(mapZoom) prepared the wrong
        // material level and made the native source repeat most cold work.
        let z = clamp(Math.round(this.map.getZoom() + (kind === "material" ? 1 : 0)), 0, maximum), nw, se;
        const budget = kind === "material" ? 48 : 16;
        const extent = () => {
          const n = 2 ** z;
          nw = mercator([view.west, clamp(view.north, -85, 85)]).map(v => Math.floor(v * n));
          se = mercator([view.east, clamp(view.south, -85, 85)]).map(v => Math.floor(v * n));
          nw[0] = clamp(nw[0], 0, n - 1); nw[1] = clamp(nw[1], 0, n - 1);
          se[0] = clamp(se[0], 0, n - 1); se[1] = clamp(se[1], 0, n - 1);
        };
        extent();
        const [cx, cy] = mercator([center.lng, center.lat]).map(v => v * 2 ** z);
        // Keep the warm set within the paired tile cache. Warming a huge
        // horizon bbox evicted the centre before the native source requested
        // it, wasting both preparation and the first visible conversion.
        const radius = Math.ceil(Math.sqrt(budget));
        nw[0] = Math.max(nw[0], Math.floor(cx) - radius); se[0] = Math.min(se[0], Math.floor(cx) + radius);
        nw[1] = Math.max(nw[1], Math.floor(cy) - radius); se[1] = Math.min(se[1], Math.floor(cy) + radius);
        const nearby = [];
        for (let y = nw[1]; y <= se[1]; y++) for (let x = nw[0]; x <= se[0]; x++) {
          nearby.push({kind, z, x, y, distance: (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2});
        }
        jobs.push(...nearby.sort((a, b) => a.distance - b.distance).slice(0, budget));
      };
      add("elevation", 14); add("material", 17);
      jobs.sort((a, b) => a.distance - b.distance);
      return Promise.all(jobs.map(({kind, z, x, y}) => this.protocol({
        url: `${this.scheme}://${kind}/${revision}/${z}/${x}/${y}.png`,
      }, {signal})));
    }
    async refresh() {
      if (!this.enabled) return;
      // A manifest describes coverage but is not yet the complete material
      // that is being displayed. Let its first decoded block arrive before
      // starting a second national decode for a premature native takeover.
      if (!this.ready && this.material.publishedManifest && !this.material.blocks.size) {this.schedule(); return;}
      if (this.material.rebuildPromise) {this.schedule(); return;}
      const sources = this.sources();
      if (!sources.length && !this.material.rawSnapshotData) return;
      const signature = sources.map(source => source.key).join("|");
      if (signature === this.signature) return;
      this.signature = signature;
      const revision = ++this.revision;
      this.records.set(revision, {sources: sources.map(({packet, ...descriptor}) => descriptor),
        packets: new Map(sources.filter(source => source.packet).map(source => [source.key, source.packet]))});
      // Keep earlier generations for in-flight native requests and retries.
      this.pruneRecords();
      const tiles = kind => [`${this.scheme}://${kind}/${revision}/{z}/{x}/{y}.png`];
      this.stageAbort?.abort();
      const stage = this.stageAbort = new AbortController();
      this.options.onChange?.();
      try {await this.warmTiles(revision, stage.signal);} catch (error) {
        if (stage.signal.aborted || !this.enabled || revision !== this.revision) return;
        this.lastError = String(error.message || error);
        // The previous complete presentation remains displayed on update
        // failures; the first conversion still has the exact overhead material.
        this.signature = null; this.options.onTile?.(); return;
      }
      if (stage.signal.aborted || !this.enabled || revision !== this.revision) return;
      if (this.material.rebuildPromise || this.material.rebuildTimer
        || this.sources().map(source => source.key).join("|") !== signature) {
        // The complete original may have gained detail during warming. Do not
        // replace it with an earlier coarse (possibly empty small-hill) version.
        this.signature = null; this.schedule(); return;
      }
      if (this.material.interacting || this.map.isMoving()) {this.signature = null; this.schedule(); return;}
      if (!this.map.getSource(this.dem)) {
        // The base vector source stops at z14. MapLibre's overscaled vector
        // draping requires DEM maxzoom <= that canonical source zoom; a higher
        // value misaligns terrain sampling on roads/water at close scales.
        this.map.addSource(this.dem, {type: "raster-dem", tiles: tiles("elevation"), tileSize: 256, maxzoom: 14, encoding: "mapbox"});
        this.map.addSource(this.source, {type: "raster", tiles: tiles("material"), tileSize: 256, maxzoom: 17});
        const order = this.map.getLayersOrder(), position = order.indexOf(this.material.id), before = order[position + 1];
        this.material.presentationDetached = true;
        try {this.map.removeLayer(this.material.id);} finally {this.material.presentationDetached = false;}
        // The existing material ID changes presentation, not layer count.
        this.map.addLayer({id: this.material.id, type: "raster", source: this.source,
          paint: {"raster-opacity": 1, "raster-fade-duration": 0}}, before);
        this.map.setTerrain({source: this.dem, exaggeration: 1});
        this.options.onChange?.();
      } else {
        this.map.getSource(this.dem).setTiles(tiles("elevation"));
        this.map.getSource(this.source).setTiles(tiles("material"));
      }
      this.presentedRevision = revision;
      this.pruneRecords();
      this.ready = true; this.lastError = "";
      this.options.onChange?.();
      this.schedule();
    }
    setEnabled(enabled) {
      if (!enabled) this.failed = false;
      if (enabled && this.failed) return;
      if (this.enabled === enabled) return;
      this.enabled = enabled;
      if (enabled) {this.signature = null; return this.refresh();}
      clearTimeout(this.timer);
      this.stageAbort?.abort(); this.stageAbort = null; this.ready = false;
      if (!this.map.getSource(this.dem)) return;
      this.map.setTerrain(null);
      const order = this.map.getLayersOrder(), position = order.indexOf(this.material.id), before = order[position + 1];
      this.map.removeLayer(this.material.id);
      this.map.addLayer(this.material, before);
      this.map.removeSource(this.source); this.map.removeSource(this.dem);
      this.options.onChange?.();
    }
    dispose() {
      this.setEnabled(false); clearTimeout(this.timer); this.map.off("moveend", this.onEnd);
      this.options.library.removeProtocol(this.scheme); this.worker.terminate();
      for (const pending of this.pending.values()) pending.reject(new Error("TERRAIN_DRAPE_CLOSED"));
      this.pending.clear(); this.records.clear();
    }
  }
  root.HuayuTerrainPerspective = {Controller, tileBounds, surfaceMask, surfaceCandidates, contextCandidates, tileSources, rasterize, colorize, encodeDem, shade};
})(typeof window === "undefined" ? globalThis : window);
