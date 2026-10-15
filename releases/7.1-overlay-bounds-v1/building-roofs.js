(function (root) {
  "use strict";

  const LAYER_ID = "ogf-atlas-building-roofs";
  const SUPPORTED = new Set(["gabled", "hipped", "pyramidal", "skillion"]);
  const controllers = new WeakMap();

  function distance(first, second) {
    const latitude = (first[1] + second[1]) / 2 * Math.PI / 180;
    return Math.hypot((second[0] - first[0]) * 111320 * Math.cos(latitude),
      (second[1] - first[1]) * 111320);
  }

  function midpoint(first, second) {
    return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
  }

  function interpolate(first, second, amount) {
    return [first[0] + (second[0] - first[0]) * amount,
      first[1] + (second[1] - first[1]) * amount];
  }

  function bearing(first, second) {
    const latitude = (first[1] + second[1]) / 2 * Math.PI / 180;
    const east = (second[0] - first[0]) * Math.cos(latitude);
    const north = second[1] - first[1];
    return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  }

  function bearingDifference(first, second) {
    const difference = Math.abs(first - second) % 180;
    return Math.min(difference, 180 - difference);
  }

  function polygons(feature) {
    const geometry = feature?.geometry;
    const values = geometry?.type === "Polygon" ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    return values.filter((polygon) => polygon?.length === 1 && polygon[0]?.length === 5)
      .map((polygon) => polygon[0].slice(0, -1).map((point) => point.map(Number)))
      .filter((ring) => ring.length === 4 && ring.flat().every(Number.isFinite));
  }

  function orientedRing(ring, properties) {
    const pairA = distance(ring[0], ring[1]) + distance(ring[2], ring[3]);
    const pairB = distance(ring[1], ring[2]) + distance(ring[3], ring[0]);
    let useA = pairA >= pairB;
    if (properties.roofOrientation === "across") useA = !useA;
    if (Number.isFinite(Number(properties.roofDirection))) {
      const direction = Number(properties.roofDirection);
      const slopeA = bearing(midpoint(ring[2], ring[3]), midpoint(ring[0], ring[1]));
      const slopeB = bearing(midpoint(ring[3], ring[0]), midpoint(ring[1], ring[2]));
      useA = bearingDifference(direction, slopeA) <= bearingDifference(direction, slopeB);
    }
    return useA ? ring : [ring[1], ring[2], ring[3], ring[0]];
  }

  function roofTriangles(feature) {
    const properties = feature?.properties || {};
    const shape = properties.roofShape;
    const base = Number(properties.roofBaseHeight);
    const top = Number(properties.roofTopHeight);
    if (!SUPPORTED.has(shape) || properties.roofModel !== 1
      || !Number.isFinite(base) || !Number.isFinite(top) || top <= base) return [];
    const result = [];
    const add = (kind, ...points) => result.push({kind, points});
    for (const sourceRing of polygons(feature)) {
      const ring = orientedRing(sourceRing, properties);
      const [p0, p1, p2, p3] = ring;
      const low = (point) => [point[0], point[1], base];
      const high = (point) => [point[0], point[1], top];
      const endA = midpoint(p3, p0), endB = midpoint(p1, p2);
      if (shape === "gabled") {
        const rA = high(endA), rB = high(endB);
        add("roof", low(p0), low(p1), rB); add("roof", low(p0), rB, rA);
        add("roof", low(p2), low(p3), rA); add("roof", low(p2), rA, rB);
        add("wall", low(p1), low(p2), rB); add("wall", low(p3), low(p0), rA);
      } else if (shape === "hipped") {
        const center = midpoint(endA, endB);
        const longSpan = Math.max(0.1, distance(endA, endB));
        const shortSpan = (distance(p0, p3) + distance(p1, p2)) / 2;
        const inset = Math.min(0.45, Math.max(0.08, shortSpan / (2 * longSpan)));
        const rA = high(interpolate(endA, center, inset));
        const rB = high(interpolate(endB, center, inset));
        add("roof", low(p0), low(p1), rB); add("roof", low(p0), rB, rA);
        add("roof", low(p2), low(p3), rA); add("roof", low(p2), rA, rB);
        add("roof", low(p1), low(p2), rB); add("roof", low(p3), low(p0), rA);
      } else if (shape === "pyramidal") {
        const apex = high([(p0[0] + p1[0] + p2[0] + p3[0]) / 4,
          (p0[1] + p1[1] + p2[1] + p3[1]) / 4]);
        for (let index = 0; index < 4; index += 1) {
          add("roof", low(ring[index]), low(ring[(index + 1) % 4]), apex);
        }
      } else {
        let lowSide = 0;
        if (Number.isFinite(Number(properties.roofDirection))) {
          const direction = Number(properties.roofDirection);
          const fromSecondToFirst = bearing(midpoint(p2, p3), midpoint(p0, p1));
          lowSide = bearingDifference(direction, fromSecondToFirst) <= 45 ? 0 : 2;
        }
        const heights = lowSide === 0 ? [base, base, top, top] : [top, top, base, base];
        const at = (point, index) => [point[0], point[1], heights[index]];
        add("roof", at(p0, 0), at(p1, 1), at(p2, 2));
        add("roof", at(p0, 0), at(p2, 2), at(p3, 3));
        const highSide = lowSide === 0 ? [p2, p3] : [p0, p1];
        add("wall", low(highSide[0]), low(highSide[1]), high(highSide[1]));
        add("wall", low(highSide[0]), high(highSide[1]), high(highSide[0]));
        const addSlopedEnd = (first, second, firstIndex, secondIndex) => {
          if (heights[firstIndex] === heights[secondIndex]) return;
          const highIndex = heights[firstIndex] > heights[secondIndex] ? firstIndex : secondIndex;
          add("wall", low(first), low(second), at(ring[highIndex], highIndex));
        };
        addSlopedEnd(p1, p2, 1, 2);
        addSlopedEnd(p3, p0, 3, 0);
      }
    }
    return result;
  }

  function taggedColor(properties, roof, night, options) {
    const explicit = roof
      ? ["roof:colour", "roof:color", "building:colour", "building:color", "colour", "color"]
      : ["building:colour", "building:color", "colour", "color"];
    const valid = (value) => typeof value === "string" && value.trim()
      && (root.CSS?.supports?.("color", value) ?? /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\(|hsla?\()/iu.test(value));
    const tagged = explicit.map((key) => properties[key]).find(valid);
    if (tagged) return tagged;
    const material = roof
      ? [night ? properties.roofMaterialNightColor : properties.roofMaterialColor,
        night ? properties.buildingMaterialNightColor : properties.buildingMaterialColor]
      : [night ? properties.buildingMaterialNightColor : properties.buildingMaterialColor];
    return material.find(valid) || (properties.ancientKind
      ? roof ? options.ancientRoof : options.ancientWall
      : roof ? options.roofDefault : options.wallDefault);
  }

  function describe(data) {
    return (data?.features || []).map((feature) => ({feature, triangles: roofTriangles(feature)}))
      .filter((item) => item.triangles.length);
  }

  class Controller {
    constructor(map, options) {
      this.map = map; this.options = options; this.data = null; this.items = []; this.alive = true;
      this.onCamera = () => this.schedule();
      this.onTerrain = (event) => {
        if (!event.sourceId || event.sourceId === map.getTerrain?.()?.source) {
          this.elevationDirty = true; this.schedule();
        }
      };
      this.onStyle = () => {
        if (!this.alive || !map.getStyle?.()) return;
        if (this.layer && !map.getLayer(LAYER_ID)) {
          this.layer = null; this.renderer = null; this.scene = null; this.mesh = null; this.dirty = true;
        }
        this.schedule();
      };
      this.onRemove = () => this.destroy();
      for (const event of ["pitch", "zoom", "moveend"]) map.on(event, this.onCamera);
      map.on("sourcedata", this.onTerrain); map.on("terrain", this.onTerrain);
      map.on("styledata", this.onStyle); map.on("remove", this.onRemove);
    }

    update(data, options) {
      if (this.data !== data) {
        this.data = data; this.items = describe(data); this.dirty = true;
      }
      const appearance = `${options.night}:${options.satellite}:${options.enabled}:${options.wallDefault}:`
        + `${options.roofDefault}:${options.ancientWall}:${options.ancientRoof}`;
      if (this.appearance !== appearance) { this.appearance = appearance; this.dirty = true; }
      this.options = options; this.schedule();
    }

    wanted() {
      return this.options.enabled && !this.options.satellite && this.items.length
        && this.map.getPitch() > 0.5 && this.map.getZoom() >= 14;
    }

    schedule() {
      if (!this.alive || this.timer) return;
      this.timer = root.setTimeout(() => {
        this.timer = null;
        if (this.alive) void this.apply();
      }, 50);
    }

    setWallMode(shaped) {
      const layer = this.options.buildingLayer;
      if (!this.map.getLayer(layer)) return;
      const expression = shaped
        ? ["case", ["==", ["get", "roofModel"], 1], ["get", "roofBaseHeight"], ["get", "renderHeight"]]
        : ["get", "renderHeight"];
      if (JSON.stringify(this.map.getPaintProperty(layer, "fill-extrusion-height")) !== JSON.stringify(expression)) {
        this.map.setPaintProperty(layer, "fill-extrusion-height", expression);
      }
    }

    async apply() {
      if (!this.alive || !this.map.getStyle?.()?.layers?.length) return;
      if (!this.wanted()) {
        if (this.layer) this.layer.enabled = false;
        this.setWallMode(false); this.notify(); this.map.triggerRepaint(); return;
      }
      if (!this.layer && !this.starting) {
        this.starting = true;
        try {
          this.T = await import("./three-0.160.1.module.min.js");
          if (!this.alive || !this.wanted()) return;
          const owner = this, T = this.T;
          this.layer = {id: LAYER_ID, type: "custom", renderingMode: "3d", enabled: false,
            onAdd(map, gl) {
              owner.gl = gl;
              owner.renderer = new T.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
              owner.renderer.autoClear = false; owner.camera = new T.Camera(); owner.scene = new T.Scene();
              owner.scene.add(new T.AmbientLight(0xffffff, 1.45));
              const light = new T.DirectionalLight(0xffffff, 1.15);
              light.position.set(-60, -40, 100); owner.scene.add(light);
            },
            render(gl, args) {
              if (!owner.layer?.enabled || !owner.mesh || !owner.origin || !owner.renderer) return;
              const matrix = args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args;
              owner.camera.projectionMatrix.fromArray(matrix).multiply(owner.transform);
              owner.renderer.resetState();
              owner.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
              owner.renderer.render(owner.scene, owner.camera); owner.renderer.resetState();
            },
            onRemove() { owner.releaseGraphics(); },
          };
          const before = this.map.getStyle().layers.find((layer) => ["symbol", "circle"].includes(layer.type))?.id;
          this.map.addLayer(this.layer, before);
        } catch (error) {
          this.failed = true; this.setWallMode(false); this.releaseGraphics();
          console.warn("Sloped building roofs unavailable; retaining flat roofs.", error);
          return;
        } finally { this.starting = false; if (this.alive) this.schedule(); }
        return;
      }
      if (!this.renderer || this.failed) return;
      if (this.dirty || this.elevationDirty) {
        try { this.build(); this.dirty = false; this.elevationDirty = false; }
        catch (error) {
          this.clearMesh(); this.layer.enabled = false; this.setWallMode(false);
          console.warn("Sloped building roof geometry failed; retaining flat roofs.", error); return;
        }
      }
      this.layer.enabled = Boolean(this.mesh); this.setWallMode(Boolean(this.mesh));
      this.notify(); this.map.triggerRepaint();
    }

    build() {
      this.clearMesh();
      const first = this.items[0]?.triangles[0]?.points[0];
      if (!first) { this.origin = null; return; }
      const T = this.T;
      this.origin = root.maplibregl.MercatorCoordinate.fromLngLat(first);
      this.scale = this.origin.meterInMercatorCoordinateUnits();
      this.transform = new T.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0)
        .scale(new T.Vector3(this.scale, -this.scale, this.scale));
      const positions = [], colors = [], color = new T.Color();
      for (const item of this.items) {
        const feature = item.feature, properties = feature.properties || {};
        const rings = polygons(feature), all = rings.flat();
        const center = all.reduce((sum, point) => [sum[0] + point[0] / all.length,
          sum[1] + point[1] / all.length], [0, 0]);
        const elevation = this.map.getTerrain?.() ? Number(this.map.queryTerrainElevation(center)) || 0 : 0;
        for (const triangle of item.triangles) {
          color.set(taggedColor(properties, triangle.kind === "roof", this.options.night, this.options));
          for (const point of triangle.points) {
            const coordinate = root.maplibregl.MercatorCoordinate.fromLngLat(point);
            const ratio = coordinate.meterInMercatorCoordinateUnits() / this.scale;
            positions.push((coordinate.x - this.origin.x) / this.scale,
              -(coordinate.y - this.origin.y) / this.scale, (elevation + point[2]) * ratio);
            colors.push(color.r, color.g, color.b);
          }
        }
      }
      if (!positions.length) return;
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      const material = new T.MeshLambertMaterial({vertexColors: true, side: T.DoubleSide});
      material.depthTest = true; material.depthWrite = true;
      this.mesh = new T.Mesh(geometry, material); this.mesh.frustumCulled = false;
      this.geometry = geometry; this.material = material; this.scene.add(this.mesh);
    }

    notify() {
      const element = root.document?.getElementById("map");
      if (!element) return;
      element.dataset.huayuSlopedRoofs = String(this.items.length);
      element.dataset.huayuSlopedRoofsActive = String(Boolean(this.layer?.enabled && this.mesh));
    }

    clearMesh() {
      if (this.mesh) this.scene?.remove(this.mesh);
      this.geometry?.dispose(); this.material?.dispose();
      this.mesh = null; this.geometry = null; this.material = null;
    }

    releaseGraphics() {
      this.clearMesh(); this.renderer?.dispose(); this.renderer = null; this.origin = null;
    }

    destroy() {
      if (!this.alive) return;
      this.alive = false; root.clearTimeout(this.timer); this.setWallMode(false);
      for (const event of ["pitch", "zoom", "moveend"]) this.map.off(event, this.onCamera);
      this.map.off("sourcedata", this.onTerrain); this.map.off("terrain", this.onTerrain);
      this.map.off("styledata", this.onStyle); this.map.off("remove", this.onRemove);
      if (this.map.getStyle?.() && this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      this.releaseGraphics();
    }
  }

  root.HuayuBuildingRoofs = {
    LAYER_ID, SUPPORTED, polygons, orientedRing, roofTriangles, taggedColor, describe,
    sync(map, data, options) {
      let controller = controllers.get(map);
      if (!controller) { controller = new Controller(map, options); controllers.set(map, controller); }
      controller.update(data, options); return controller;
    },
    dispose(map) { controllers.get(map)?.destroy(); controllers.delete(map); },
    get: (map) => controllers.get(map),
  };
})(typeof window !== "undefined" ? window : globalThis);
