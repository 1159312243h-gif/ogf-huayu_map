(function (root) {
  "use strict";

  const LAYER_ID = "ogf-atlas-building-roofs";
  const VERSION = "8.0-roof-restore-v2";
  const SUPPORTED = new Set(["flat", "gabled", "gabled_height_moved", "skillion", "hipped",
    "half-hipped", "side_hipped", "side_half-hipped", "mansard", "gambrel", "hipped-and-gabled",
    "pyramidal", "crosspitched", "sawtooth", "butterfly", "cone", "dome", "onion", "round"]);
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
    const radial = ["pyramidal", "cone", "dome", "onion"].includes(feature?.properties?.roofShape);
    const rings = values.map(polygon => polygon?.length === 1 ? simpleRing(polygon[0], radial ? 64 : 4) : null);
    return rings.length && rings.every(Boolean) ? rings : [];
  }

  function simpleRing(source, limit = 4) {
    if (!Array.isArray(source) || source.length < 4 || source.length > 257) return null;
    const ring = source.map(p => [Number(p?.[0]), Number(p?.[1])]);
    if (!ring.flat().every(Number.isFinite)) return null;
    if (distance(ring[0], ring.at(-1)) < 1e-6) ring.pop();
    let changed = true;
    while (changed && ring.length > 3) {
      changed = false;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
        // Only redundant, exactly collinear source vertices may be omitted in the mesh.
        if (distance(a,b) + distance(b,c) - distance(a,c) > 1e-6) continue;
        ring.splice(i,1); changed = true; break;
      }
    }
    if (ring.length < 3 || ring.length > limit || ![3,64].includes(limit) && ring.length !== 4) return null;
    let sign = 0;
    for (let i = 0; i < ring.length; i++) {
      const a=ring[i],b=ring[(i+1)%ring.length],c=ring[(i+2)%ring.length];
      const cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
      if (distance(a,b)<.5 || Math.abs(cross)<1e-14 || sign && Math.sign(cross)!==sign) return null;
      sign=Math.sign(cross);
    }
    // Convex turns alone do not reject self-intersecting star polygons.
    for (let i=0;i<ring.length;i++) for(let j=i+2;j<ring.length;j++) {
      if(i===0 && j===ring.length-1)continue;
      const a=ring[i],b=ring[(i+1)%ring.length],c=ring[j],d=ring[(j+1)%ring.length];
      const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
      if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0)return null;
    }
    return ring;
  }

  function orientedRing(ring, properties) {
    const pairA = distance(ring[0], ring[1]) + distance(ring[2], ring[3]);
    const pairB = distance(ring[1], ring[2]) + distance(ring[3], ring[0]);
    let useA = pairA >= pairB;
    if (properties.roofOrientation === "across") useA = !useA;
    if (typeof properties.roofDirection === "number" && Number.isFinite(properties.roofDirection)) {
      const direction = Number(properties.roofDirection);
      const slopeA = bearing(midpoint(ring[2], ring[3]), midpoint(ring[0], ring[1]));
      const slopeB = bearing(midpoint(ring[3], ring[0]), midpoint(ring[1], ring[2]));
      useA = bearingDifference(direction, slopeA) <= bearingDifference(direction, slopeB);
    }
    let result = useA ? [...ring] : [ring[1], ring[2], ring[3], ring[0]];
    const a=midpoint(result[3],result[0]), b=midpoint(result[1],result[2]);
    if(b[0]<a[0]-1e-12 || Math.abs(b[0]-a[0])<=1e-12 && b[1]<a[1])
      result=[result[2],result[3],result[0],result[1]];
    const [p,q,r]=result;
    if((q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0])<0)
      result=[result[3],result[2],result[1],result[0]];
    return result;
  }

  function roofTriangles(feature) {
    const properties = feature?.properties || {};
    const shape = properties.roofShape;
    const base = Number(properties.roofBaseHeight);
    const top = Number(properties.roofTopHeight);
    if (!SUPPORTED.has(shape) || shape === "flat" || properties.roofModel !== 1
      || !Number.isFinite(base) || !Number.isFinite(top) || top <= base) return [];
    const result = [];
    let footprint;
    const add = (kind, ...points) => {
      if (kind === "wall" && properties.roofOnly === 1) return;
      const [a,b,c]=points,lat=a[1]*Math.PI/180;
      const ab=[(b[0]-a[0])*111320*Math.cos(lat),(b[1]-a[1])*111320,b[2]-a[2]];
      const ac=[(c[0]-a[0])*111320*Math.cos(lat),(c[1]-a[1])*111320,c[2]-a[2]];
      if(Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])<1e-8)return;
      result.push({kind, points, footprint});
    };
    const face=(kind,points)=>{for(let i=1;i<points.length-1;i++)add(kind,points[0],points[i],points[i+1]);};
    for (const sourceRing of polygons(feature)) {
      footprint=sourceRing;
      if (["pyramidal", "cone", "dome", "onion"].includes(shape)) {
        const center=sourceRing.reduce((s,p)=>[s[0]+p[0]/sourceRing.length,s[1]+p[1]/sourceRing.length],[0,0]);
        const levels=shape==="dome"?Array.from({length:13},(_,i)=>[Math.cos(i/12*Math.PI/2),Math.sin(i/12*Math.PI/2)])
          :shape==="onion"?[[1,0],[.62,0],[.77,.15],[1,.38],[.93,.56],[.67,.74],[.34,.88],[0,1]]:[[1,0],[0,1]];
        const at=(p,[radius,height])=>[...interpolate(center,p,radius),base+(top-base)*height];
        for(let k=1;k<levels.length;k++)for(let i=0;i<sourceRing.length;i++) {
          const p=sourceRing[i],q=sourceRing[(i+1)%sourceRing.length];
          face("roof",[at(p,levels[k-1]),at(q,levels[k-1]),at(q,levels[k]),at(p,levels[k])]);
        }
        continue;
      }
      const ring = orientedRing(sourceRing, properties);
      const [p0, p1, p2, p3] = ring;
      const low = (point) => [point[0], point[1], base];
      const high = (point) => [point[0], point[1], top];
      const endA = midpoint(p3, p0), endB = midpoint(p1, p2);
      const at=(u,v,h)=>[...interpolate(interpolate(p0,p1,u),interpolate(p3,p2,u),v),base+(top-base)*h];
      if (["hipped","half-hipped","side_hipped","side_half-hipped"].includes(shape)) {
        const inset=Math.min(.45,Math.max(.08,(distance(p0,p3)+distance(p1,p2))/4/Math.max(.1,distance(endA,endB))));
        const half=shape.includes("half"),one=shape.startsWith("side_");
        const end=(u,kind)=>{
          const amount=kind==="half"?.5:kind==="hip"?1:0;
          return {ridge:at(u===0?inset*amount:1-inset*amount,.5,1),
            cuts:kind==="half"?[at(u,.25,.5),at(u,.75,.5)]:null,kind};
        };
        const a=end(0,one?"gable":half?"half":"hip"),b=end(1,half?"half":"hip");
        face("roof",[low(p0),low(p1),...(b.cuts?[b.cuts[0]]:[]),b.ridge,a.ridge,...(a.cuts?[a.cuts[0]]:[])]);
        face("roof",[low(p2),low(p3),...(a.cuts?[a.cuts[1]]:[]),a.ridge,b.ridge,...(b.cuts?[b.cuts[1]]:[])]);
        for(const [e,x,y] of [[a,p0,p3],[b,p1,p2]]) {
          if(e.cuts){face("wall",[low(x),low(y),e.cuts[1],e.cuts[0]]);face("roof",[e.cuts[0],e.cuts[1],e.ridge]);}
          else face(e.kind==="gable"?"wall":"roof",[low(x),low(y),e.ridge]);
        }
      } else if(shape==="mansard" || shape==="hipped-and-gabled") {
        const ringAt=(inset,h)=>[[inset,inset],[1-inset,inset],[1-inset,1-inset],[inset,1-inset]].map(([u,v])=>at(u,v,h));
        const layers=shape==="mansard"?[[0,0],[.16,.72],[.3,1]]:[[0,0],[.16,.55]];
        for(let i=1;i<layers.length;i++) {
          const a=ringAt(...layers[i-1]),b=ringAt(...layers[i]);
          for(let k=0;k<4;k++)face("roof",[a[k],a[(k+1)%4],b[(k+1)%4],b[k]]);
        }
        const cap=ringAt(...layers.at(-1));
        if(shape==="mansard")face("roof",cap);
        else {
          const a=at(.16,.5,1),b=at(.84,.5,1);
          face("roof",[cap[0],cap[1],b,a]);face("roof",[cap[2],cap[3],a,b]);
          face("wall",[cap[0],cap[3],a]);face("wall",[cap[1],cap[2],b]);
        }
      } else if(shape==="crosspitched") {
        const center=at(.5,.5,1),corners=ring.map(low);
        for(let i=0;i<4;i++) {
          const next=(i+1)%4,previous=(i+3)%4,a=high(midpoint(ring[i],ring[next])),b=high(midpoint(ring[previous],ring[i]));
          face("roof",[corners[i],a,center,b]);face("wall",[corners[i],corners[next],a]);
        }
      } else {
        let profile=shape==="gambrel"?[[0,0],[.22,.65],[.5,1],[.78,.65],[1,0]]
          :shape==="gabled_height_moved"?[[0,0],[.5,.7],[.5,1],[1,.3]]
          :shape==="butterfly"?[[0,1],[.5,0],[1,1]]
          :shape==="round"?Array.from({length:17},(_,i)=>[(1-Math.cos(i/16*Math.PI))/2,Math.sin(i/16*Math.PI)])
          :shape==="skillion"?[[0,0],[1,1]]:[[0,0],[.5,1],[1,0]];
        if(shape==="sawtooth") {
          const count=Math.max(2,Math.min(6,Math.round((distance(p0,p3)+distance(p1,p2))/16)));
          profile=[[0,0]];for(let i=1;i<=count;i++)profile.push([i/count,1],[i/count,0]);
        }
        if(["skillion","gabled_height_moved","sawtooth"].includes(shape)
          && typeof properties.roofDirection==="number" && Number.isFinite(properties.roofDirection)) {
          const downhill=bearing(midpoint(p2,p3),midpoint(p0,p1));
          if(Math.cos((properties.roofDirection-downhill)*Math.PI/180)<0)profile=profile.map(([v,h])=>[1-v,h]).reverse();
        }
        for(let i=1;i<profile.length;i++) {
          const [v0,h0]=profile[i-1],[v1,h1]=profile[i];
          face(v0===v1 && properties.roofOnly!==1?"wall":"roof",[at(0,v0,h0),at(1,v0,h0),at(1,v1,h1),at(0,v1,h1)]);
          if(shape!=="gabled")
            for(const u of [0,1])face("wall",[at(u,v0,0),at(u,v1,0),at(u,v1,h1),at(u,v0,h0)]);
        }
        if(shape==="gabled")for(const u of [0,1])
          face("wall",[at(u,0,0),at(u,1,0),at(u,profile[1][0],1)]);
        for(const [v,h] of [profile[0],profile.at(-1)])if(h>0)
          face("wall",[at(0,v,0),at(1,v,0),at(1,v,h),at(0,v,h)]);
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
    const items=[];let count=0;
    for(const feature of data?.features || []) {
      if(typeof feature.id!=="string" && typeof feature.id!=="number")continue;
      const triangles=roofTriangles(feature);
      if(!triangles.length || count+triangles.length>120000)continue;
      count+=triangles.length;items.push({feature,triangles});
    }
    return items;
  }

  // Continue the native fill-extrusion wall above its eaves. MapLibre shades
  // sRGB vertex colours directly; Three's Lambert material uses linear colours
  // and different lights, so even identical tags previously produced a seam.
  // Keep this equation in step with the bundled MapLibre 5.24 fillExtrusion shader.
  const WALL_VERTEX_SHADER = `
    precision highp float;
    uniform mat4 projectionMatrix;
    uniform mat4 modelViewMatrix;
    uniform vec3 wallLightPosition;
    uniform vec3 wallLightColor;
    uniform float wallLightIntensity;
    uniform float wallVerticalGradient;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec3 color;
    attribute vec2 wallHeights;
    varying vec3 wallColor;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      float colorValue = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float directional = clamp(dot(normal, wallLightPosition), 0.0, 1.0);
      directional = mix(1.0-wallLightIntensity, max(1.0-colorValue+wallLightIntensity, 1.0), directional);
      if (normal.y != 0.0) {
        // The native wall's top-edge brightness continues over the whole
        // gable, rather than restarting a second vertical gradient there.
        float topShade = clamp((1.0+wallHeights.x)*sqrt(max(0.0,wallHeights.y)/150.0),
          mix(0.7,0.98,1.0-wallLightIntensity), 1.0);
        directional *= mix(1.0, topShade, wallVerticalGradient);
      }
      wallColor = clamp((color+vec3(0.03))*directional*wallLightColor,
        mix(vec3(0.0),vec3(0.3),vec3(1.0)-wallLightColor),vec3(1.0));
    }`;
  const WALL_FRAGMENT_SHADER = `
    precision highp float;
    uniform float wallOpacity;
    varying vec3 wallColor;
    void main() { gl_FragColor = vec4(wallColor,1.0)*wallOpacity; }`;

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
        if (!this.alive || !(map.getLayersOrder ? map.style : map.getStyle?.())) return;
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
      if (this.map.getStyle && !(this.map.getLayersOrder ? this.map.style : this.map.getStyle())) return;
      const layer = this.options.buildingLayer;
      if (!this.map.getLayer(layer)) return;
      const matches = items => ["any",
          // GeoJSON tiling coerces unpromoted string IDs to zero. The OSM
          // type/id properties survive tiling and distinguish ways/relations.
          ["in", ["concat", ["coalesce", ["get", "osmType"], ""], ":",
            ["to-string", ["coalesce", ["get", "osmId"], ""]]],
            ["literal", items.filter(item=>item.feature.properties?.osmType
              && item.feature.properties.osmId!==undefined)
              .map(item=>`${item.feature.properties.osmType}:${item.feature.properties.osmId}`)]],
          ["in", ["id"], ["literal", items.filter(item=>!item.feature.properties?.osmType
            || item.feature.properties.osmId===undefined).map(item=>item.feature.id)]]];
      const expression = shaped
        ? ["case", ["all", ["==", ["get", "roofModel"], 1], matches(this.items)],
          ["get", "roofBaseHeight"], ["get", "renderHeight"]]
        : ["get", "renderHeight"];
      if (JSON.stringify(this.map.getPaintProperty(layer, "fill-extrusion-height")) !== JSON.stringify(expression)) {
        this.map.setPaintProperty(layer, "fill-extrusion-height", expression);
      }
      // A zero-height native extrusion still draws a flat cap. Hide only roofs
      // actually supplied by the mesh, and restore the exact filter on fallback.
      if (this.wallFilter === undefined) this.wallFilter = this.map.getFilter(layer) ?? null;
      const roofOnly = shaped ? this.items.filter(item => item.feature.properties?.roofOnly === 1) : [];
      const filter = roofOnly.length ? ["all", this.wallFilter ?? true, ["!", matches(roofOnly)]] : this.wallFilter;
      if (JSON.stringify(this.map.getFilter(layer) ?? null) !== JSON.stringify(filter)) this.map.setFilter(layer, filter);
      const cap = this.options.roofCapLayer;
      if (cap && this.map.getLayer(cap)) {
        if (this.capFilter === undefined) this.capFilter = this.map.getFilter(cap) ?? null;
        const capFilter = shaped && this.items.length
          ? ["all", this.capFilter ?? true, ["!", matches(this.items)]] : this.capFilter;
        if (JSON.stringify(this.map.getFilter(cap) ?? null) !== JSON.stringify(capFilter)) this.map.setFilter(cap, capFilter);
      }
    }

    async apply() {
      if (!this.alive || !(this.map.style && this.map.getLayersOrder ? this.map.getLayersOrder().length : this.map.getStyle?.()?.layers?.length)) return;
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
              owner.updateWallLighting();
              root.HuayuSunlight?.applyScene(map, owner.scene);
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
      const batches = {roof:[], wall:[]}, color = new T.Color();
      const nativePaint = this.map.style?.getLayer?.(this.options.buildingLayer)?.paint;
      for (const item of this.items) {
        const feature = item.feature, properties = feature.properties || {};
        const rings = polygons(feature), all = rings.flat();
        const center = all.reduce((sum, point) => [sum[0] + point[0] / all.length,
          sum[1] + point[1] / all.length], [0, 0]);
        const elevation = this.map.getTerrain?.() ? Number(this.map.queryTerrainElevation(center)) || 0 : 0;
        const nativeColor = nativePaint?.get("fill-extrusion-color")?.evaluate(feature, {});
        for (const triangle of item.triangles) {
          color.set(taggedColor(properties, triangle.kind === "roof", this.options.night, this.options));
          const rgb = triangle.kind === "wall"
            ? nativeColor ? [nativeColor.r,nativeColor.g,nativeColor.b] : color.clone().convertLinearToSRGB().toArray()
            : [color.r,color.g,color.b];
          const vertices=[];
          for (const point of triangle.points) {
            const coordinate = root.maplibregl.MercatorCoordinate.fromLngLat(point);
            const ratio = coordinate.meterInMercatorCoordinateUnits() / this.scale;
            vertices.push([(coordinate.x - this.origin.x) / this.scale,
              -(coordinate.y - this.origin.y) / this.scale, (elevation + point[2]) * ratio]);
          }
          let normal=[0,0,0];
          if(triangle.kind === "wall") {
            const [a,b,c]=vertices,ab=b.map((v,i)=>v-a[i]),ac=c.map((v,i)=>v-a[i]);
            let nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2];
            const face=triangle.points.reduce((sum,p)=>[sum[0]+p[0]/3,sum[1]+p[1]/3],[0,0]);
            const footprint=triangle.footprint;
            const wallCenter=footprint.reduce((sum,p)=>[sum[0]+p[0]/footprint.length,sum[1]+p[1]/footprint.length],[0,0]);
            // GeoJSON tile rings are rewound by MapLibre. Its extrusion
            // lighting normal points into the outer ring, in east/south axes.
            // Match that convention independently of the source winding.
            if(nx*(face[0]-wallCenter[0])+ny*(face[1]-wallCenter[1])>0) {nx=-nx;ny=-ny;}
            const length=Math.hypot(nx,ny)||1;
            normal=[(Math.floor(nx/length*8192)*2+1)/16384,Math.trunc(-ny/length*16384)/16384,0];
          }
          batches[triangle.kind].push({vertices,rgb,normal,heights:[Math.max(0,Number(properties.renderMinHeight)||0)
            +elevation-(this.map.getTerrain?.() && !(Number(properties.renderMinHeight)>0)?10:0),Number(properties.roofBaseHeight)+elevation]});
        }
      }
      const positions=[],colors=[],heights=[],wallNormals=[];
      for(const batch of [batches.roof,batches.wall])for(const triangle of batch)for(const vertex of triangle.vertices) {
        positions.push(...vertex);colors.push(...triangle.rgb);heights.push(...triangle.heights);wallNormals.push(...triangle.normal);
      }
      if (!positions.length) return;
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
      geometry.setAttribute("wallHeights", new T.Float32BufferAttribute(heights, 2));
      geometry.computeVertexNormals();
      const roofVertices=batches.roof.length*3;
      for(let i=roofVertices;i<positions.length/3;i++)geometry.attributes.normal.setXYZ(i,...wallNormals.slice(i*3,i*3+3));
      geometry.addGroup(0,roofVertices,0);geometry.addGroup(roofVertices,batches.wall.length*3,1);
      const material = new T.MeshLambertMaterial({vertexColors: true, side: T.DoubleSide,
        polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
      material.depthTest = true; material.depthWrite = true;
      this.wallMaterial = new T.RawShaderMaterial({vertexShader:WALL_VERTEX_SHADER,fragmentShader:WALL_FRAGMENT_SHADER,
        side:T.DoubleSide,uniforms:{wallLightPosition:{value:new T.Vector3()},wallLightColor:{value:new T.Vector3(1,1,1)},
          wallLightIntensity:{value:.5},wallVerticalGradient:{value:1},wallOpacity:{value:1}},
        blending:T.CustomBlending,blendSrc:T.OneFactor,blendDst:T.OneMinusSrcAlphaFactor,depthTest:true,depthWrite:true});
      this.mesh = new T.Mesh(geometry, [material,this.wallMaterial]); this.mesh.frustumCulled = false;
      this.geometry = geometry; this.material = material; this.scene.add(this.mesh);
      this.updateWallLighting();
    }

    updateWallLighting() {
      if(!this.wallMaterial)return;
      // Read the same evaluated light and paint as the native wall, including
      // light transitions and viewport-relative rotation, on each render.
      const light=this.map.style?.light?.properties,settings=this.map.getLight?.()||{};
      const [radius,azimuth,polar]=settings.position||[1.15,210,30];
      const phi=polar*Math.PI/180,theta=(azimuth+90)*Math.PI/180;
      const position=light?.get("position")||{x:radius*Math.cos(theta)*Math.sin(phi),y:radius*Math.sin(theta)*Math.sin(phi),z:radius*Math.cos(phi)};
      const angle=(light?.get("anchor")||settings.anchor||"viewport")==="viewport"?(this.map.getBearing?.()||0)*Math.PI/180:0;
      const uniforms=this.wallMaterial.uniforms,cos=Math.cos(angle),sin=Math.sin(angle);
      uniforms.wallLightPosition.value.set(position.x*cos-position.y*sin,position.x*sin+position.y*cos,position.z);
      const tint=light?.get("color");
      if(tint)uniforms.wallLightColor.value.set(tint.r,tint.g,tint.b);
      else {const color=new this.T.Color(settings.color||"#fff").convertLinearToSRGB();uniforms.wallLightColor.value.set(color.r,color.g,color.b);}
      uniforms.wallLightIntensity.value=light?.get("intensity")??settings.intensity??.5;
      const paint=this.map.style?.getLayer?.(this.options.buildingLayer)?.paint;
      uniforms.wallVerticalGradient.value=paint?.get("fill-extrusion-vertical-gradient")===false?0:1;
      const opacity=paint?.get("fill-extrusion-opacity")??1;
      uniforms.wallOpacity.value=opacity;this.wallMaterial.transparent=opacity<1;
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
      this.wallMaterial?.dispose();this.wallMaterial=null;
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
      if ((this.map.getLayersOrder ? this.map.style : this.map.getStyle?.()) && this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      this.releaseGraphics();
    }
  }

  root.HuayuBuildingRoofs = {
    VERSION, LAYER_ID, SUPPORTED, simpleRing, polygons, orientedRing, roofTriangles, taggedColor, describe,
    sync(map, data, options) {
      let controller = controllers.get(map);
      if (!controller) { controller = new Controller(map, options); controllers.set(map, controller); }
      controller.update(data, options); return controller;
    },
    dispose(map) { controllers.get(map)?.destroy(); controllers.delete(map); },
    get: (map) => controllers.get(map),
  };
})(typeof window !== "undefined" ? window : globalThis);
