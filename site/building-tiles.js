(function (root) {
  "use strict";
  const VERSION = "8.0-building-tiles-v1";
  const PREFIX = "huayu-buildings://";
  const workerUrl = root.document?.currentScript?.src;
  const decoder = new TextDecoder();
  const MAX_BYTES = 16 * 1024 * 1024;

  function number(bytes, cursor) {
    let value = 0, factor = 1;
    for (let i = 0; i < 8 && cursor.pos < bytes.length; i++) {
      const byte = bytes[cursor.pos++]; value += (byte & 127) * factor;
      if (!(byte & 128) && Number.isSafeInteger(value)) return value;
      factor *= 128;
    }
    throw Error("Invalid vector tile integer");
  }

  function fields(bytes) {
    const result = [], cursor = {pos: 0};
    while (cursor.pos < bytes.length) {
      const start = cursor.pos, key = number(bytes, cursor), wire = key % 8;
      let data;
      if (wire === 2) {
        const size = number(bytes, cursor), end = cursor.pos + size;
        if (end > bytes.length) throw Error("Truncated vector tile");
        data = bytes.subarray(cursor.pos, end); cursor.pos = end;
      } else if (wire === 0) {
        const begin = cursor.pos;
        while (cursor.pos < bytes.length && bytes[cursor.pos++] & 128) {}
        if (bytes[cursor.pos - 1] & 128) throw Error("Truncated vector tile integer");
        data = bytes.subarray(begin, cursor.pos);
      } else if (wire === 1 || wire === 5) {
        cursor.pos += wire === 1 ? 8 : 4;
        if (cursor.pos > bytes.length) throw Error("Truncated vector tile field");
      } else throw Error("Invalid vector tile field");
      result.push({tag: Math.floor(key / 8), wire, data, raw: bytes.subarray(start, cursor.pos)});
    }
    return result;
  }

  function integer(value, output) {
    do { const byte = value % 128; value = Math.floor(value / 128); output.push(byte + (value ? 128 : 0)); } while (value);
  }

  function join(parts) {
    const size = parts.reduce((sum, p) => sum + p.length, 0);
    if (size > MAX_BYTES * 3) throw Error("Vector tile output too large");
    const result = new Uint8Array(size); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  function message(tag, data) {
    const prefix = []; integer(tag * 8 + 2, prefix); integer(data.length, prefix);
    return join([new Uint8Array(prefix), data]);
  }

  function polygons(bytes) {
    const cursor = {pos: 0}, rings = [];
    let x = 0, y = 0, ring = null;
    const signed = () => { const v = number(bytes, cursor); return v % 2 ? -(v + 1) / 2 : v / 2; };
    while (cursor.pos < bytes.length) {
      const command = number(bytes, cursor), id = command % 8, count = Math.floor(command / 8);
      if (!count || count > bytes.length) throw Error("Invalid polygon command");
      if (id === 1) {
        if (count !== 1 || ring) throw Error("Invalid polygon start");
        x += signed(); y += signed(); ring = [[x, y]];
      } else if (id === 2 && ring) {
        for (let i = 0; i < count; i++) { x += signed(); y += signed(); ring.push([x, y]); }
      } else if (id === 7 && ring && count === 1 && ring.length >= 3) {
        rings.push(ring); ring = null;
      } else throw Error("Invalid polygon ring");
    }
    if (ring) throw Error("Unclosed polygon ring");
    const result = []; let outerSign;
    for (const points of rings) {
      const area = points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1];
      }, 0);
      if (!area) throw Error("Degenerate polygon ring");
      outerSign ??= Math.sign(area);
      if (Math.sign(area) === outerSign) result.push([points]);
      else result.at(-1).push(points);
    }
    return result;
  }

  function geometry(rings) {
    const output = []; let x = 0, y = 0;
    const delta = value => integer(value < 0 ? -value * 2 - 1 : value * 2, output);
    for (const ring of rings) {
      integer(9, output);
      ring.forEach(([nx, ny], i) => {
        if (i === 1) integer((ring.length - 1) * 8 + 2, output);
        delta(nx - x); delta(ny - y); x = nx; y = ny;
      });
      integer(15, output);
    }
    return new Uint8Array(output);
  }

  function splitFeature(bytes) {
    const entries = fields(bytes), type = entries.find(f => f.tag === 3 && f.wire === 0);
    const shape = entries.filter(f => f.tag === 4 && f.wire === 2);
    if (!type || number(type.data, {pos: 0}) !== 3 || shape.length !== 1) return [bytes];
    const parts = polygons(shape[0].data);
    if (parts.length < 2) return [bytes];
    // OpenMapTiles batches unrelated buildings with identical attributes into
    // one MultiPolygon. Give each outer ring (with its holes) its own feature,
    // so ownership can reject an inside building without retaining its whole
    // tile-wide batch. Coordinates, attributes, IDs and all other layers stay.
    return parts.map(part => join(entries.map(f => f === shape[0] ? message(4, geometry(part)) : f.raw)));
  }

  function normalizeTile(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length > MAX_BYTES) return buffer;
    try {
      let changed = false;
      const output = fields(bytes).map(layer => {
        if (layer.tag !== 3 || layer.wire !== 2) return layer.raw;
        const entries = fields(layer.data), name = entries.find(f => f.tag === 1 && f.wire === 2);
        if (!name || decoder.decode(name.data) !== "building") return layer.raw;
        let split = false;
        const parts = entries.flatMap(f => {
          if (f.tag !== 2 || f.wire !== 2) return [f.raw];
          const features = splitFeature(f.data);
          if (features.length === 1) return [f.raw];
          split = true; return features.map(feature => message(2, feature));
        });
        if (!split) return layer.raw;
        changed = true; return message(3, join(parts));
      });
      return changed ? join(output).buffer : buffer;
    } catch { return buffer; } // Damaged/unsupported input keeps the original native fallback.
  }

  let installed = false, worker, nextId = 0;
  const pending = new Map();
  function processTile(buffer, signal) {
    if (!root.Worker || !workerUrl) return Promise.resolve(buffer);
    if (!worker) {
      try {
        worker = new root.Worker(workerUrl);
        worker.onmessage = ({data}) => pending.get(data.id)?.finish(data.buffer);
        worker.onerror = () => {
          worker?.terminate(); worker = null;
          for (const job of [...pending.values()]) job.finish(job.original);
        };
      } catch { return Promise.resolve(buffer); }
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const abort = () => {
        pending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", abort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const finish = result => { pending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(result); };
      const timer = setTimeout(() => finish(buffer), 10000);
      pending.set(id, {finish, original:buffer}); signal.addEventListener("abort", abort, {once:true});
      if (signal.aborted) return abort();
      // Retain the original bytes for failure/timeout fallback; transfer only
      // the worker copy. No unbounded second cache or per-frame conversion.
      const copy = buffer.slice(0);
      try { worker.postMessage({id, buffer:copy}, [copy]); } catch { finish(buffer); }
    });
  }

  function install(library) {
    if (installed) return;
    library.addProtocol("huayu-buildings", async (params, controller) => {
      const response = await fetch(params.url.slice(PREFIX.length), {signal:controller.signal});
      if (!response.ok) throw Error(`Vector tile HTTP ${response.status}`);
      const original = await response.arrayBuffer();
      const data = await processTile(original, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return {data, cacheControl:response.headers.get("cache-control"), expires:response.headers.get("expires")};
    });
    installed = true;
  }

  function request(url, type) {
    // Only the OGF data tiles use this protocol. Glyphs, sprites, styles,
    // navigation, live model requests and third-party basemaps are untouched.
    return {url: installed && type === "Tile" && /^https:\/\/ogf-tileserver-t5qifc5o4q-uc\.a\.run\.app\/data\/openmaptiles\//u.test(url)
      ? PREFIX + url : url};
  }

  if (!root.document && typeof root.postMessage === "function") {
    root.onmessage = ({data}) => {
      const buffer = normalizeTile(data.buffer);
      root.postMessage({id:data.id, buffer}, [buffer]);
    };
  }
  root.HuayuBuildingTiles = {VERSION, normalizeTile, install, request};
})(typeof window !== "undefined" ? window : globalThis);
