(function (root) {
  "use strict";
  const STORAGE_KEY = "ogf-atlas-render-settings-v1";
  const DEFAULTS = Object.freeze({treeModel: "classic", vegetationDensity: "dense", gardenFlowers: true});
  const LAYER_ID = "ogf-atlas-natural-trees";
  const EMPTY = Object.freeze([]);
  const controllers = new WeakMap();
  let libraryPromise;
  function normalize(value) {
    return {treeModel: ["natural", "tiered"].includes(value?.treeModel) ? value.treeModel : "classic",
      vegetationDensity: ["light", "standard", "dense"].includes(value?.vegetationDensity) ? value.vegetationDensity : "dense",
      gardenFlowers: typeof value?.gardenFlowers === "boolean" ? value.gardenFlowers : true};
  }
  let preferences;
  try { preferences = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); }
  catch { preferences = {...DEFAULTS}; }
  function hash(value) {
    let result = 2166136261;
    for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return result >>> 0;
  }
  function treeKey(feature) {
    const p = feature.properties || {};
    return p.plantKey || `${p.osmType}:${String(p.osmId).replace(/:(trunk|canopy)$/, "")}`;
  }
  function disk(feature) {
    const ring = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates[0]
      : feature.geometry?.coordinates?.[0]?.[0];
    if (!ring?.length) return null;
    const points = ring.slice(0, -1);
    const center = [0, 0];
    for (const p of points) {center[0] += p[0] / points.length; center[1] += p[1] / points.length;}
    const cosine = Math.cos(center[1] * Math.PI / 180);
    const radius = Math.max(...points.map(p => Math.hypot((p[0] - center[0]) * cosine, p[1] - center[1]) * 111320));
    return center.every(Number.isFinite) && radius > 0 ? {center, radius} : null;
  }
  function describe(ground, garden) {
    const parts = new Map();
    for (const f of ground) {
      const kind = f.properties?.renderKind;
      if (kind !== "tree-trunk" && kind !== "tree-canopy") continue;
      const key = treeKey(f);
      if (!parts.has(key)) parts.set(key, {key, parts: []});
      const tree = parts.get(key);
      tree.parts.push(f);
      tree[kind === "tree-canopy" ? "canopy" : "trunk"] = f;
    }
    const trees = [];
    for (const tree of parts.values()) {
      const shape = tree.canopy && disk(tree.canopy), trunk = tree.trunk && disk(tree.trunk);
      if (!shape || !trunk) continue;
      const p = tree.canopy.properties, t = tree.trunk.properties;
      trees.push({...tree, ...shape, base: Number(t.treeBase) || 0, crownBase: Number(p.treeBase),
        height: Number(p.treeHeight), trunkHeight: Number(t.treeHeight), trunkRadius: trunk.radius,
        variant: Number(p.canopyVariant) || 0, garden: false,
        category: p.treeLeafType === "needleleaved" ? "pine" : "broadleaf",
        group: p.treeOrigin === "woodland" ? `${p.osmType}:${p.sourceOsmId}` : null});
    }
    const gardenTrees = new Map();
    for (const f of garden) {
      const p = f.properties;
      if (p?.plantType !== "tree") continue;
      let tree = gardenTrees.get(p.plantKey);
      if (!tree) {
        tree = {key: p.plantKey, center: [p.plantX, p.plantY], radius: p.plantRadius,
          base: p.plantGround, height: p.plantHeight, crownBase: Infinity, trunkHeight: 0,
          trunkRadius: 0.12, variant: hash(p.plantKey) % 3, garden: true, category: "broadleaf", group: p.gardenOrigin, parts: []};
        gardenTrees.set(tree.key, tree);
      }
      tree.parts.push(f);
      tree.height = Math.max(tree.height, p.plantHeight);
      if (String(f.id).endsWith(":trunk")) tree.trunkHeight = p.plantHeight;
      else tree.crownBase = Math.min(tree.crownBase, p.plantBase);
    }
    return trees.concat([...gardenTrees.values()]).filter(t => Number.isFinite(t.height)
      && Number.isFinite(t.crownBase) && t.height > t.crownBase && t.center.every(Number.isFinite));
  }
  function gardenPlants(garden) {
    const result=new Map();
    for(const feature of garden) {
      const p=feature.properties;
      if(!["flower","shrub"].includes(p?.plantType))continue;
      let item=result.get(p.plantKey);
      if(!item){item={key:p.plantKey,center:[p.plantX,p.plantY],radius:p.plantRadius,base:p.plantGround,height:p.plantHeight,
        category:p.plantType==="flower" ? "flowers" : "shrubs",garden:true,group:p.gardenOrigin,parts:[]};result.set(item.key,item);}
      item.height=Math.max(item.height,p.plantHeight);item.parts.push(feature);
    }
    return [...result.values()].filter(item=>item.center.every(Number.isFinite) && item.height>item.base && item.radius>0);
  }
  function importedAssets() {
    const result=new Map();
    for(const [category,id] of Object.entries(root.HuayuModelOptions?.getSelections() || {})) {
      const state=root.HuayuModelAssets?.state(id),asset=root.HuayuModelAssets?.get(id);
      if(state?.status==="ready" && asset)result.set(category,asset);
    }
    return result;
  }
  function importedBatches(items,assets,selected,flowers=true) {
    const batches=new Map(),keys=new Set();let budget=400000,count=0;
    const sorted=items.slice().sort((a,b)=>Number(Boolean(a.group))-Number(Boolean(b.group)) || hash(a.key)-hash(b.key));
    for(const item of sorted) {
      const asset=assets.get(item.category);
      if(!selected.has(item.key) || !asset || item.category==="flowers" && !flowers || asset.triangles>20000
        || count>=256 || asset.triangles>budget)continue;
      if(!batches.has(asset))batches.set(asset,[]);
      batches.get(asset).push(item);keys.add(item.key);budget-=asset.triangles;count++;
    }
    return {batches,keys};
  }
  function selection(items, density) {
    const ratio = {light: 0.45, standard: 0.7, dense: 1}[density] || 1;
    const selected = new Set(), groups = new Map();
    for (const item of items) {
      if (!item.group || item.group.startsWith("node:")) {selected.add(item.key); continue;}
      if (!groups.has(item.group)) groups.set(item.group, new Map());
      groups.get(item.group).set(item.key, item);
    }
    for (const group of groups.values()) {
      const ranked = [...group.keys()].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
      ranked.slice(0, Math.ceil(ranked.length * ratio)).forEach(key => selected.add(key));
    }
    return selected;
  }
  function loadLibrary() {
    if (!libraryPromise) libraryPromise = import("./three-0.160.1.module.min.js")
      .catch(error => {libraryPromise = null; throw error;});
    return libraryPromise;
  }
  class Controller {
    constructor(map, options) {
      this.map = map; this.options = options; this.ground = EMPTY; this.garden = EMPTY;
      this.trees = []; this.alive = true; this.status = "classic";
      this.layer = null; this.timer = null; this.filterSignatures = new Map();
      this.onTerrain = event => {
        if (event.sourceId && event.sourceId !== map.getTerrain?.()?.source) return;
        this.refreshElevation();
      };
      this.onTerrainMode = () => this.refreshElevation();
      map.on("sourcedata", this.onTerrain); map.on("terrain", this.onTerrainMode);
    }
    update(ground, garden, options) {
      const changed = this.ground !== ground || this.garden !== garden || this.options.night !== options.night;
      this.options = options;
      const imports=importedAssets();
      const key = `${preferences.treeModel}:${preferences.vegetationDensity}:${preferences.gardenFlowers}:${Boolean(options.satellite)}:${[...imports].map(([key,asset])=>`${key}:${asset.record.importedAt}`).join("|")}`;
      this.assets=imports;
      const layers = [options.trunk, options.canopy, options.plants].map(id => this.map.getLayer(id));
      if (!changed && this.appliedKey === key && layers.every((layer, i) => layer === this.appliedLayers?.[i])) return;
      if (changed) {
        this.ground = ground; this.garden = garden; this.trees = describe(ground, garden);
        this.plants = gardenPlants(garden);
        this.sceneDirty = true;
      }
      this.apply();
      this.appliedKey = key; this.appliedLayers = layers;
    }
    setFilter(id, value) {
      if (!this.map.getLayer(id)) return;
      const signature = JSON.stringify(value);
      if (this.filterSignatures.get(id) === signature && JSON.stringify(this.map.getFilter(id)) === signature) return;
      this.filterSignatures.set(id, signature); this.map.setFilter(id, value);
    }
    apply() {
      if (!this.alive) return;
      const modeled = preferences.treeModel !== "classic" && !this.options.satellite;
      const wanted=(modeled || this.assets?.size>0) && !this.options.satellite;
      if (wanted && !this.layer && !this.loading && this.status !== "failed") this.start();
      if (!wanted) this.status = "classic";
      else if (this.layer) this.status = "ready";
      const ready = wanted && Boolean(this.layer);
      const items = this.trees.filter(t => !t.garden).map(t => ({key: t.key, group: t.group}));
      const plants = new Map(this.garden.map(f => [f.properties.plantKey,
        {key: f.properties.plantKey, group: f.properties.gardenOrigin}]));
      this.selected = selection([...items, ...plants.values()], preferences.vegetationDensity);
      this.imported=ready ? importedBatches([...this.trees,...this.plants || []],this.assets || new Map(),this.selected,preferences.gardenFlowers)
        : {batches:new Map(),keys:new Set()};
      const treeIds = this.trees.filter(t => !t.garden && this.selected.has(t.key))
        .flatMap(t => t.parts.map(f => f.properties.osmId));
      for (const [id, kind] of [[this.options.trunk, "tree-trunk"], [this.options.canopy, "tree-canopy"]]) {
        const base = ["==", ["get", "renderKind"], kind];
        const hiddenIds=this.trees.filter(tree=>!tree.garden && this.imported.keys.has(tree.key))
          .flatMap(tree=>tree.parts.map(feature=>feature.properties.osmId));
        const density=preferences.vegetationDensity === "dense" ? base
          : ["all", base, ["any", ["!=", ["get", "treeOrigin"], "woodland"],
            ["in", ["get", "osmId"], ["literal", treeIds]]]];
        this.setFilter(id,ready && modeled ? ["all",base,false] : hiddenIds.length
          ? ["all",density,["!",["in",["get","osmId"],["literal",hiddenIds]]]] : density);
      }
      const gardenFilter = ["all", ["==", ["get", "renderKind"], "garden-plant"]];
      if (ready && modeled) gardenFilter.push(["!=", ["get", "plantType"], "tree"]);
      if (this.imported.keys.size) gardenFilter.push(["!",["in",["get","plantKey"],["literal",[...this.imported.keys]]]]);
      if (!preferences.gardenFlowers) gardenFilter.push(["!=", ["get", "plantType"], "flower"]);
      if (preferences.vegetationDensity !== "dense") gardenFilter.push(["in", ["get", "plantKey"],
        ["literal", [...plants.keys()].filter(key => this.selected.has(key))]]);
      this.setFilter(this.options.plants, gardenFilter);
      const signature = `${preferences.treeModel}:${preferences.vegetationDensity}:${preferences.gardenFlowers}:${this.options.night}:${[...this.assets || []].map(([key,asset])=>`${key}:${asset.record.importedAt}`).join("|")}`;
      if (ready && (this.sceneDirty || this.sceneSignature !== signature)) {
        this.buildScene(); this.sceneSignature = signature; this.sceneDirty = false;
      }
      if (this.layer) this.layer.enabled = ready;
      this.notify(); this.map.triggerRepaint();
    }
    async start() {
      this.loading = true; this.status = "loading"; this.notify();
      try {
        const THREE = await loadLibrary();
        if (!this.alive || preferences.treeModel === "classic" && !this.assets?.size || this.options.satellite) return;
        this.THREE = THREE;
        const owner = this;
        const layer = {id: LAYER_ID, type: "custom", renderingMode: "3d", enabled: false,
          onAdd(map, gl) {
            owner.gl = gl;
            owner.renderer = new THREE.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
            owner.renderer.autoClear = false;
            owner.camera = new THREE.Camera(); owner.scene = new THREE.Scene();
            owner.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
            const light = new THREE.DirectionalLight(0xffffff, 1.1);
            light.position.set(-60, -40, 100); owner.scene.add(light);
          },
          render(gl, args) {
            if (!layer.enabled || !owner.origin || mapZoom(owner.map) < 14) return;
            const matrix = args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args;
            owner.woodGroup.visible = mapZoom(owner.map) >= 14;
            owner.gardenGroup.visible = mapZoom(owner.map) >= 16;
            owner.camera.projectionMatrix.fromArray(matrix).multiply(owner.transform);
            // Use MapLibre's target and depth buffer, without clearing ground or buildings.
            owner.renderer.resetState();
            owner.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            owner.renderer.render(owner.scene, owner.camera);
            owner.renderer.resetState();
          },
          onRemove() {owner.releaseGraphics();},
        };
        const before = this.map.getStyle().layers.find(l => l.type === "symbol" || l.type === "circle")?.id;
        this.map.addLayer(layer, before); this.layer = layer;
        this.status = "ready"; this.sceneDirty = true;
      } catch (error) {
        if (!this.alive) return;
        this.status = "failed";
        if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
        this.releaseGraphics();
        console.warn("Tree renderer unavailable; retaining classic trees.", error);
      } finally {this.loading = false; if (this.alive) this.apply();}
    }
    buildScene() {
      const T = this.THREE;
      this.clearMeshes();
      const trees = preferences.treeModel !== "classic" ? this.trees.filter(t => this.selected.has(t.key) && !this.imported.keys.has(t.key)) : [];
      const tiered = preferences.treeModel === "tiered";
      this.woodGroup = new T.Group(); this.gardenGroup = new T.Group();
      this.scene.add(this.woodGroup, this.gardenGroup);
      const origin=trees[0] || [...this.imported.batches.values()][0]?.[0];
      if (!origin) {this.origin = null; return;}
      this.origin = root.maplibregl.MercatorCoordinate.fromLngLat(origin.center);
      this.scale = this.origin.meterInMercatorCoordinateUnits();
      this.transform = new T.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0)
        .scale(new T.Vector3(this.scale, -this.scale, this.scale));
      const trunkGeometry = new T.CylinderGeometry(tiered ? 1 : 0.8, 1, 1, 7).rotateX(Math.PI / 2);
      const crownGeometry = tiered ? new T.CylinderGeometry(1, 1, 1, 12).rotateX(Math.PI / 2)
        : new T.SphereGeometry(1, 14, 10);
      const trunkMaterial = new T.MeshLambertMaterial({color: this.options.night ? "#6b6254" : "#8c7860"});
      const crownMaterial = new T.MeshLambertMaterial({color: "#ffffff"});
      this.resources = [trunkGeometry, crownGeometry, trunkMaterial, crownMaterial];
      this.meshes = [];
      for (const garden of [false, true]) {
        const batch = trees.filter(t => t.garden === garden);
        if (!batch.length) continue;
        const trunks = new T.InstancedMesh(trunkGeometry, trunkMaterial, batch.length);
        const crowns = new T.InstancedMesh(crownGeometry, crownMaterial, batch.length * (tiered ? 2 : 3));
        trunks.frustumCulled = crowns.frustumCulled = false;
        (garden ? this.gardenGroup : this.woodGroup).add(trunks, crowns);
        this.meshes.push({batch, trunks, crowns, tiered});
      }
      this.importMeshes=[];
      for(const [asset,batch] of this.imported.batches) for(const garden of [false,true]) {
        const subset=batch.filter(item=>Boolean(item.garden)===garden);if(!subset.length)continue;
        for(const piece of asset.pieces) {
          const materials=[piece.material].flat().map(material=>material.clone());
          materials.forEach(material=>{material.depthTest=true;material.depthWrite=!material.transparent;});
          this.resources.push(...materials);
          const mesh=new T.InstancedMesh(piece.geometry,materials.length===1 ? materials[0] : materials,subset.length);
          mesh.frustumCulled=false;(garden ? this.gardenGroup : this.woodGroup).add(mesh);
          this.importMeshes.push({batch:subset,mesh});
        }
      }
      this.positionMeshes();
    }
    positionMeshes() {
      if (!this.origin || !this.meshes) return;
      const T = this.THREE, object = new T.Object3D(), color = new T.Color();
      const colors = this.options.night ? ["#395b48", "#42634e", "#55785f"] : ["#5f9569", "#629575", "#7ba483"];
      for (const {batch, trunks, crowns, tiered} of this.meshes) {
        batch.forEach((tree, index) => {
          const coordinate = root.maplibregl.MercatorCoordinate.fromLngLat(tree.center);
          const ratio = coordinate.meterInMercatorCoordinateUnits() / this.scale;
          const x = (coordinate.x - this.origin.x) / this.scale, y = -(coordinate.y - this.origin.y) / this.scale;
          let elevation = 0;
          if (this.map.getTerrain?.()) elevation = this.map.queryTerrainElevation(tree.center) || 0;
          const trunkHeight = tree.trunkHeight - tree.base;
          object.rotation.set(0, 0, 0);
          object.position.set(x, y, (elevation + tree.base + trunkHeight / 2) * ratio);
          object.scale.set(tree.trunkRadius * ratio, tree.trunkRadius * ratio, trunkHeight * ratio);
          object.updateMatrix(); trunks.setMatrixAt(index, object.matrix);
          const span = tree.height - tree.crownBase;
          if (tiered) {
            // Coaxial cylinders share an exact join and keep the source crown's height.
            for (let level = 0; level < 2; level++) {
              const low = level ? 0.62 : 0, high = level ? 1 : 0.62;
              const radius = tree.radius * (level ? 0.72 : 1) * ratio;
              object.position.set(x, y, (elevation + tree.crownBase + span * (low + high) / 2) * ratio);
              object.scale.set(radius, radius, span * (high - low) * ratio);
              object.updateMatrix(); crowns.setMatrixAt(index * 2 + level, object.matrix);
              color.set(colors[(tree.variant + level) % colors.length]); crowns.setColorAt(index * 2 + level, color);
            }
            return;
          }
          const angle = hash(tree.key) / 0xffffffff * Math.PI * 2;
          for (let lobe = 0; lobe < 3; lobe++) {
            const side = lobe === 0 ? 0 : lobe === 1 ? -1 : 1;
            const offset = side * tree.radius * 0.38;
            object.position.set(x + Math.cos(angle) * offset * ratio, y + Math.sin(angle) * offset * ratio,
              (elevation + tree.crownBase + span * (lobe === 2 ? 0.57 : 0.5)) * ratio);
            object.rotation.z = angle;
            object.scale.set(tree.radius * (lobe ? 0.6 : 0.9) * ratio,
              tree.radius * (lobe ? 0.62 : 0.88) * ratio, span * (lobe ? 0.37 : 0.5) * ratio);
            object.updateMatrix(); crowns.setMatrixAt(index * 3 + lobe, object.matrix);
            color.set(colors[(tree.variant + lobe) % colors.length]); crowns.setColorAt(index * 3 + lobe, color);
          }
        });
        trunks.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = true;
        crowns.instanceColor.needsUpdate = true;
      }
      for(const {batch,mesh} of this.importMeshes || []) {
        batch.forEach((item,index)=>{
          const coordinate=root.maplibregl.MercatorCoordinate.fromLngLat(item.center);
          const ratio=coordinate.meterInMercatorCoordinateUnits()/this.scale;
          const elevation=this.map.getTerrain?.() ? this.map.queryTerrainElevation(item.center) || 0 : 0;
          object.rotation.set(0,0,hash(item.key)/0xffffffff*Math.PI*2);
          object.position.set((coordinate.x-this.origin.x)/this.scale,-(coordinate.y-this.origin.y)/this.scale,(elevation+item.base)*ratio);
          object.scale.set(item.radius*2*ratio,item.radius*2*ratio,(item.height-item.base)*ratio);
          object.updateMatrix();mesh.setMatrixAt(index,object.matrix);
        });
        mesh.instanceMatrix.needsUpdate=true;
      }
      this.map.triggerRepaint();
    }
    refreshElevation() {
      if (!this.layer?.enabled || this.timer) return;
      this.timer = root.setTimeout(() => {
        this.timer = null;
        if (this.alive) this.positionMeshes();
      }, 120);
    }
    clearMeshes() {
      for (const {trunks, crowns} of this.meshes || []) {trunks.dispose(); crowns.dispose();}
      for(const {mesh} of this.importMeshes || [])mesh.dispose();this.importMeshes=null;
      this.resources?.forEach(resource => resource.dispose()); this.resources = null; this.meshes = null;
      if (this.woodGroup) this.scene?.remove(this.woodGroup, this.gardenGroup);
    }
    releaseGraphics() {
      this.clearMeshes(); this.renderer?.dispose(); this.renderer = null; this.scene = null; this.origin = null;
      this.layer = null;
    }
    notify() {
      this.options.onStatus?.(this.status);
      const element = root.document?.getElementById("map");
      if (element) {
        element.dataset.huayuTreeModel = this.layer?.enabled && this.imported?.keys.size ? "imported"
          : this.layer?.enabled ? preferences.treeModel : "classic";
        element.dataset.huayuImportedPlants=String(this.layer?.enabled ? this.imported?.keys.size || 0 : 0);
        element.dataset.huayuNaturalTrees = String(this.layer?.enabled && preferences.treeModel === "natural"
          ? this.trees.filter(t => this.selected?.has(t.key) && !this.imported?.keys.has(t.key)).length : 0);
      }
    }
    destroy() {
      this.alive = false; root.clearTimeout(this.timer);
      this.map.off("sourcedata", this.onTerrain); this.map.off("terrain", this.onTerrainMode);
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      this.releaseGraphics();
    }
  }
  function mapZoom(map) {return map.getZoom();}
  root.HuayuVegetation = {
    DEFAULTS, STORAGE_KEY, LAYER_ID, normalize, describe, selection, gardenPlants, importedBatches,
    getPreferences: () => ({...preferences}),
    setPreferences(value) {
      preferences = normalize({...preferences, ...value});
      let saved = true;
      try {root.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));} catch {saved = false;}
      root.dispatchEvent(new root.CustomEvent("huayu-render-settings-change", {detail: {saved}}));
      return saved;
    },
    sync(map, ground = EMPTY, garden = EMPTY, options) {
      let controller = controllers.get(map);
      if (!controller) {controller = new Controller(map, options); controllers.set(map, controller);}
      controller.update(ground, garden, options);
      return controller;
    },
    refreshElevation(map) {controllers.get(map)?.refreshElevation();},
    dispose(map) {controllers.get(map)?.destroy(); controllers.delete(map);},
  };
})(typeof window !== "undefined" ? window : globalThis);
