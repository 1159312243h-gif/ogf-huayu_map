(function(root) {
  "use strict";
  const LAYER_ID="ogf-atlas-imported-structures",EMPTY=Object.freeze([]),controllers=new WeakMap();
  const CATEGORIES=new Set(["pavilion","busShelter","fountain","fence","wall","cityWall"]);
  const MIN_ZOOM={pavilion:14,busShelter:17.5,fountain:16,fence:14,wall:14,cityWall:12};
  const hash=value=>{let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
  const polygons=geometry=>geometry?.type==="Polygon" ? [geometry.coordinates] : geometry?.type==="MultiPolygon" ? geometry.coordinates : [];
  function inRing(point,ring) {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j],cross=(point[0]-a[0])*(b[1]-a[1])-(point[1]-a[1])*(b[0]-a[0]);
      if(Math.abs(cross)<1e-8 && point[0]>=Math.min(a[0],b[0])-1e-8 && point[0]<=Math.max(a[0],b[0])+1e-8
        && point[1]>=Math.min(a[1],b[1])-1e-8 && point[1]<=Math.max(a[1],b[1])+1e-8)return true;
      if((a[1]>point[1])!==(b[1]>point[1]) && point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  function inside(point,polygon) {return inRing(point,polygon[0]) && !polygon.slice(1).some(ring=>inRing(point,ring));}
  function intersect(a,b,c,d) {
    const cross=(u,v,w)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);
    return cross(a,b,c)*cross(a,b,d)<-1e-10 && cross(c,d,a)*cross(c,d,b)<-1e-10;
  }
  function rectangleInside(corners,polygon) {
    if(!corners.every(point=>inside(point,polygon)))return false;
    for(const ring of polygon)for(let i=1;i<ring.length;i++)for(let j=0;j<4;j++) {
      if(intersect(corners[j],corners[(j+1)%4],ring[i-1],ring[i]))return false;
    }
    // A hole completely enclosed by the rectangle must also reject the fit.
    return !polygon.slice(1).some(ring=>inRing(ring[0],[...corners,corners[0]]));
  }
  function fitPolygon(polygon,strict=false) {
    if(!polygon?.[0]?.length)return null;
    const geographic=polygon[0][0],sx=111320*Math.cos(geographic[1]*Math.PI/180),sy=111320;
    const local=polygon.map(ring=>ring.map(p=>[(p[0]-geographic[0])*sx,(p[1]-geographic[1])*sy]));
    let longest=0,angle=0;
    for(let i=1;i<local[0].length;i++) {
      const a=local[0][i-1],b=local[0][i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(length>longest){longest=length;angle=Math.atan2(b[1]-a[1],b[0]-a[0]);}
    }
    const cos=Math.cos(angle),sin=Math.sin(angle),rotated=local[0].map(([x,y])=>[x*cos+y*sin,-x*sin+y*cos]);
    const lo=[Math.min(...rotated.map(p=>p[0])),Math.min(...rotated.map(p=>p[1]))],hi=[Math.max(...rotated.map(p=>p[0])),Math.max(...rotated.map(p=>p[1]))];
    const center=[(lo[0]+hi[0])/2,(lo[1]+hi[1])/2],length=hi[0]-lo[0],width=hi[1]-lo[1];
    const toLocal=([x,y])=>[x*cos-y*sin,x*sin+y*cos];
    for(const scale of strict ? [0.999,0.99,0.95] : [0.999,0.9,0.8,0.7,0.6,0.5]) {
      const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>toLocal([center[0]+x*length*scale/2,center[1]+y*width*scale/2]));
      if(!rectangleInside(corners,local))continue;
      const point=toLocal(center);
      return {center:[geographic[0]+point[0]/sx,geographic[1]+point[1]/sy],length:length*scale,width:width*scale,
        angle,corners:corners.map(p=>[geographic[0]+p[0]/sx,geographic[1]+p[1]/sy])};
    }
    return null;
  }
  const sourceKey=(feature,fallback="way")=>`${feature.properties?.osmType || (feature.properties?.relationId ? "relation" : fallback)}:${feature.properties?.osmId}`;
  function describe(inputs,categories=CATEGORIES) {
    const result=[],seen=new Set();
    function area(feature,category,strict=false) {
      if(!categories.has(category))return;
      const key=sourceKey(feature,category==="cityWall" && feature.properties.relationId ? "relation" : "way"),unique=`${category}:${key}`;
      if(seen.has(unique))return;seen.add(unique);
      const p=feature.properties,base=Number(p.modelMinHeight ?? p.fountainMinHeight ??
        (category==="pavilion" || category==="busShelter" ? 0 : p.minHeight) ?? 0);
      const height=Number(p.height ?? p.fountainHeight ?? p.renderHeight ?? 0);
      const finalBase=base;
      if(!Number.isFinite(height) || height<=finalBase)return;
      const pieces=[];
      for(const polygon of polygons(feature.geometry)) {
        const fit=fitPolygon(polygon,strict);if(!fit || fit.length<0.05 || fit.width<0.04)return;
        const count=strict ? Math.ceil(fit.length/(category==="cityWall" ? 12 : category==="wall" ? 5 : 4)) : 1;
        if(count>256)return;
        for(let i=0;i<count;i++) {
          const along=(i+0.5)/count-0.5,dx=Math.cos(fit.angle)*fit.length*along,dy=Math.sin(fit.angle)*fit.length*along;
          pieces.push({...fit,center:[fit.center[0]+dx/(111320*Math.cos(fit.center[1]*Math.PI/180)),fit.center[1]+dy/111320],
            length:fit.length/count,base:finalBase,height,key,category,properties:p});
        }
      }
      if(pieces.length)result.push({key,category,pieces,feature});
    }
    for(const feature of inputs.pavilions || EMPTY)if(feature.properties?.pavilionPart==="roof"
      && (inputs.buildingPrimary || feature.properties.osmType==="node"))area(feature,"pavilion");
    for(const feature of inputs.walls || EMPTY)if(feature.properties?.renderKind==="extrusion") {
      const category=feature.properties.barrierKind==="fence" ? "fence" : "wall";area(feature,category,true);
    }
    for(const feature of inputs.cityWalls || EMPTY)if(feature.properties?.renderKind==="extrusion"
      && feature.properties.structureKind!=="city-gate")area(feature,"cityWall",true);
    for(const feature of inputs.supplemental || EMPTY) {
      const p=feature.properties || {};
      if(p.busFacilityPart==="shelter-roof" && (inputs.buildingPrimary || !p.buildingReplacement))area(feature,"busShelter");
      else if(p.fountainArea && p.fountainModelEligible)area(feature,"fountain");
    }
    for(const feature of inputs.supplemental || EMPTY) {
      const p=feature.properties || {},key=sourceKey(feature,"node");
      if(!categories.has("fountain") || p.kind!=="fountain" || p.mappedArea || !p.fountainModelEligible || seen.has(`fountain:${key}`) || feature.geometry.type!=="Point")continue;
      seen.add(`fountain:${key}`);
      const diameter=Number(p.fountainDiameter || 4),base=Number(p.fountainMinHeight || 0),height=Number(p.fountainHeight || 2.4);
      if(!(diameter>0 && height>base))continue;
      result.push({key,category:"fountain",feature,pieces:[{center:feature.geometry.coordinates.slice(),length:diameter,width:diameter,angle:0,
        base,height,key,category:"fountain",properties:p}]});
    }
    return result;
  }
  function plan(items,assets,options={}) {
    const batches=new Map(),keys=new Map();let count=0,triangles=0;
    for(const item of items.slice().sort((a,b)=>hash(`${a.category}:${a.key}`)-hash(`${b.category}:${b.key}`) || a.key.localeCompare(b.key))) {
      const asset=assets.get(item.category);
      if(!asset || asset.triangles>20000 || options.satellite || options.zoom<MIN_ZOOM[item.category]
        || options.pitch<=0.5 && ["wall","fence","cityWall"].includes(item.category))continue;
      if(options.bounds && !item.pieces.some(p=>{
        const corners=p.corners || [p.center],xs=corners.map(v=>v[0]),ys=corners.map(v=>v[1]),b=options.bounds;
        return Math.max(...xs)>=b.west && Math.min(...xs)<=b.east && Math.max(...ys)>=b.south && Math.min(...ys)<=b.north;
      }))continue;
      const cost=item.pieces.length*asset.triangles;
      if(count+item.pieces.length>256 || triangles+cost>400000)continue;
      if(!batches.has(asset))batches.set(asset,[]);batches.get(asset).push(...item.pieces);
      if(!keys.has(item.category))keys.set(item.category,new Set());keys.get(item.category).add(item.key);
      count+=item.pieces.length;triangles+=cost;
    }
    return {batches,keys,count,triangles};
  }
  function expression(filter) {
    if(!Array.isArray(filter))return filter || true;
    const [op,field,...values]=filter;
    if(["all","any","none"].includes(op)) {
      const converted=[op==="none" ? "any" : op,...filter.slice(1).map(expression)];return op==="none" ? ["!",converted] : converted;
    }
    if(typeof field!=="string")return filter;
    const property=field==="$type" ? ["geometry-type"] : field==="$id" ? ["id"] : ["get",field];
    if(["==","!=","<",">","<=",">="].includes(op))return [op,property,...values];
    if(["in","!in"].includes(op)){const converted=["in",property,["literal",values]];return op==="!in" ? ["!",converted] : converted;}
    if(op==="!has")return ["!",["has",field]];
    return filter;
  }
  class Controller {
    constructor(map,options) {
      this.map=map;this.options=options;this.alive=true;this.filters=new Map();this.inputs={};this.descriptors=[];
      this.onTerrain=event=>{if(!this.alive || map.getStyle && !map.getStyle())return;
        if(!event.sourceId || event.sourceId===map.getTerrain?.()?.source)this.refreshElevation();};
      this.onMoveEnd=()=>this.schedule();this.onRemove=()=>this.destroy();
      this.onStyle=()=>{if(this.alive && map.getStyle?.() && this.layer && !map.getLayer(LAYER_ID)){this.layer=null;this.signature=null;this.schedule();}};
      map.on("sourcedata",this.onTerrain);map.on("terrain",this.onTerrain);map.on("moveend",this.onMoveEnd);map.on("remove",this.onRemove);
      map.on("styledata",this.onStyle);
      this.unbind=options.observeGestures?.(()=>{this.interacting=true;},()=>{this.interacting=false;this.schedule();});
    }
    update(inputs,options) {
      this.options=options;
      if(Object.keys(inputs).some(key=>this.inputs[key]!==inputs[key])){this.inputs=inputs;this.describeDirty=true;this.dirty=true;}
      this.schedule();
    }
    schedule() {
      if(!this.alive || this.interacting || this.timer)return;
      this.timer=root.setTimeout(()=>{this.timer=null;if(this.alive && !this.interacting)void this.apply();},70);
    }
    async apply() {
      if(!this.alive || this.interacting || !this.map.getStyle?.()?.layers?.length)return;
      const assets=new Map();
      for(const [category,id] of Object.entries(root.HuayuModelOptions?.getSelections() || {}))if(CATEGORIES.has(category)
        && root.HuayuModelAssets?.state(id).status==="ready")assets.set(category,root.HuayuModelAssets.get(id));
      const scope=[...assets.keys()].sort().join(',');
      if(this.describeDirty || scope!==this.descriptorScope) {
        this.descriptors=assets.size ? describe(this.inputs,new Set(assets.keys())) : [];
        this.descriptorScope=scope;this.describeDirty=false;
      }
      const satellite=this.options.satellite,bounds=this.map.getBounds();
      const next=plan(this.descriptors,assets,{satellite,zoom:this.map.getZoom(),pitch:this.map.getPitch(),
        bounds:{west:bounds.getWest()-0.001,east:bounds.getEast()+0.001,south:bounds.getSouth()-0.001,north:bounds.getNorth()+0.001}});
      const signature=`${this.options.night}:${satellite}:${[...next.batches].map(([asset,batch])=>`${asset.record.id}:${asset.record.importedAt}:${JSON.stringify(asset.record.config)}:${batch.map(p=>`${p.key}:${p.center}`).join(';')}`).join('|')}`;
      if(!next.count){this.current=next;if(this.layer)this.layer.enabled=false;this.refreshFilters();this.notify();return;}
      if(this.failed)return;
      if(!this.layer && !this.starting) {
        this.starting=true;
        try {
          this.T=await import("./three-0.160.1.module.min.js");if(!this.alive || this.options.satellite || this.interacting)return;
          const owner=this,T=this.T;
          this.layer={id:LAYER_ID,type:"custom",renderingMode:"3d",enabled:false,
            onAdd(map,gl) {
              owner.gl=gl;owner.renderer=new T.WebGLRenderer({canvas:map.getCanvas(),context:gl,antialias:true});owner.renderer.autoClear=false;
              owner.scene=new T.Scene();owner.camera=new T.Camera();owner.scene.add(new T.AmbientLight(0xffffff,1.6));
              const light=new T.DirectionalLight(0xffffff,1.1);light.position.set(-60,-40,100);owner.scene.add(light);
            },
            render(gl,args) {
              if(!owner.alive || !owner.layer?.enabled || !owner.origin || !owner.renderer)return;
              const matrix=args?.defaultProjectionData?.mainMatrix || args?.projectionMatrix || args;
              owner.camera.projectionMatrix.fromArray(matrix).multiply(owner.transform);
              owner.renderer.resetState();owner.renderer.setViewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
              owner.renderer.render(owner.scene,owner.camera);owner.renderer.resetState();
              owner.renderCount=(owner.renderCount || 0)+1;
            },onRemove(){owner.releaseGraphics();},
          };
          const before=this.map.getStyle().layers.find(layer=>["symbol","circle"].includes(layer.type))?.id;
          this.map.addLayer(this.layer,before);
        } catch(error) {
          this.failed=true;this.current={keys:new Map(),count:0};
          if(this.map.getLayer(LAYER_ID))this.map.removeLayer(LAYER_ID);
          this.layer=null;this.releaseGraphics();this.refreshFilters();
          console.warn("Structure models unavailable; keeping existing models.",error);return;
        } finally {this.starting=false;if(this.alive)this.schedule();}
        // Selections, data or satellite mode may have changed during import.
        return;
      }
      if(!this.alive || this.starting || !this.renderer)return;
      if(this.dirty || signature!==this.signature) {
        try {this.build(next);this.signature=signature;this.dirty=false;}
        catch(error){this.clear();this.current={keys:new Map(),count:0};this.layer.enabled=false;this.refreshFilters();this.notify();console.warn("Structure model fitting failed; retaining original models.",error);return;}
      }
      this.current=next;this.layer.enabled=true;this.refreshFilters();this.notify();this.map.triggerRepaint();
    }
    build(next) {
      const T=this.T,first=[...next.batches.values()][0][0],old={meshes:this.meshes,resources:this.resources,origin:this.origin,scale:this.scale,transform:this.transform};
      this.origin=root.maplibregl.MercatorCoordinate.fromLngLat(first.center);this.scale=this.origin.meterInMercatorCoordinateUnits();
      this.transform=new T.Matrix4().makeTranslation(this.origin.x,this.origin.y,0).scale(new T.Vector3(this.scale,-this.scale,this.scale));
      this.meshes=[];this.resources=[];
      try {for(const [asset,batch] of next.batches)for(const piece of asset.pieces) {
        const geometry=piece.geometry.clone(),materials=[piece.material].flat().map(m=>m.clone());
        const wall=new Float32Array(batch.length*4),roof=new Float32Array(batch.length*4),roofBase=new Float32Array(batch.length);
        batch.forEach((item,i)=>{
          const p=item.properties,keys=["building:colour","building:color","colour","color"];
          roofBase[i]=p.pavilionRoofDepth ? 1-Number(p.pavilionRoofDepth)/(item.height-item.base) : 0.7;
          const materialWall=this.options.night ? "buildingMaterialNightColor" : "buildingMaterialColor";
          const materialRoof=this.options.night ? "roofMaterialNightColor" : "roofMaterialColor";
          for(const [properties,array] of [
            [[...keys,materialWall],wall],
            [["roof:colour","roof:color",...keys,materialRoof,materialWall],roof],
          ]) {
            const value=properties.map(key=>p[key]).find(value=>value
              && (root.CSS?.supports?.("color",value) ?? /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\(|hsla?\()/iu.test(value)));
            if(value){const color=new T.Color(value);array.set([color.r,color.g,color.b,1],i*4);}
          }
        });
        geometry.setAttribute("huayuWallColor",new T.InstancedBufferAttribute(wall,4));geometry.setAttribute("huayuRoofColor",new T.InstancedBufferAttribute(roof,4));
        geometry.setAttribute("huayuRoofBase",new T.InstancedBufferAttribute(roofBase,1));
        materials.forEach(material=>{
          material.depthTest=true;material.depthWrite=!material.transparent;
          if(this.options.night)material.color.multiplyScalar(0.65);
          material.onBeforeCompile=shader=>{
            shader.vertexShader='attribute vec4 huayuWallColor; attribute vec4 huayuRoofColor; attribute float huayuRoofBase; varying vec4 vHuayuWall; varying vec4 vHuayuRoof; varying float vHuayuHeight;\n'+shader.vertexShader;
            shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvHuayuWall=huayuWallColor; vHuayuRoof=huayuRoofColor; vHuayuHeight=position.z-huayuRoofBase;');
            shader.fragmentShader='varying vec4 vHuayuWall; varying vec4 vHuayuRoof; varying float vHuayuHeight;\n'+shader.fragmentShader;
            shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\nvec4 huayuTag=vHuayuHeight>0.0 && vHuayuRoof.a>0.5 ? vHuayuRoof : vHuayuWall; diffuseColor.rgb=mix(diffuseColor.rgb,huayuTag.rgb,huayuTag.a);');
          };
          material.customProgramCacheKey=()=>"huayu-structure-colors-v2-material";
        });
        const mesh=new T.InstancedMesh(geometry,materials.length===1 ? materials[0] : materials,batch.length);mesh.frustumCulled=false;
        this.resources.push(geometry,...materials);this.meshes.push({mesh,batch,asset});
      }
      this.position();
      } catch(error){this.clear();Object.assign(this,old);throw error;}
      for(const {mesh} of old.meshes || []){this.scene.remove(mesh);mesh.dispose();}
      old.resources?.forEach(resource=>resource.dispose());
      for(const {mesh} of this.meshes)this.scene.add(mesh);
    }
    position() {
      if(!this.alive || !this.origin || this.map.getStyle && !this.map.getStyle())return;
      const T=this.T,object=new T.Object3D();
      for(const {mesh,batch,asset} of this.meshes || []) {
        batch.forEach((item,index)=>{
          const coordinate=root.maplibregl.MercatorCoordinate.fromLngLat(item.center),ratio=coordinate.meterInMercatorCoordinateUnits()/this.scale;
          const elevation=this.map.getTerrain?.() ? this.map.queryTerrainElevation(item.center) || 0 : 0;
          const swap=asset.record.category!=="cityWall" && asset.size[1]>asset.size[0];
          object.rotation.set(0,0,item.angle+(swap ? Math.PI/2 : 0));
          object.position.set((coordinate.x-this.origin.x)/this.scale,-(coordinate.y-this.origin.y)/this.scale,(elevation+item.base)*ratio);
          object.scale.set((swap ? item.width : item.length)*ratio,(swap ? item.length : item.width)*ratio,(item.height-item.base)*ratio);
          object.updateMatrix();
          // Keep tagged vertical height while both ends of a wall follow the existing slope.
          if(this.map.getTerrain?.() && ["fence","wall","cityWall"].includes(item.category)) {
            const angle=object.rotation.z,sx=111320*Math.cos(item.center[1]*Math.PI/180);
            for(const [axis,length,direction] of [[0,object.scale.x/ratio,angle],[1,object.scale.y/ratio,angle+Math.PI/2]]) {
              const dx=Math.cos(direction)*length/2/sx,dy=Math.sin(direction)*length/2/111320;
              const low=this.map.queryTerrainElevation([item.center[0]-dx,item.center[1]-dy]);
              const high=this.map.queryTerrainElevation([item.center[0]+dx,item.center[1]+dy]);
              if(Number.isFinite(low) && Number.isFinite(high))object.matrix.elements[axis*4+2]=(high-low)*ratio;
            }
          }
          mesh.setMatrixAt(index,object.matrix);
        });mesh.instanceMatrix.needsUpdate=true;
      }
      this.map.triggerRepaint();
    }
    refreshElevation() {if(!this.elevationTimer)this.elevationTimer=root.setTimeout(()=>{this.elevationTimer=null;if(this.alive)this.position();},120);}
    refreshFilters() {
      if(this.map.getStyle && !this.map.getStyle())return;
      const groups=this.options.layers || {};
      for(const [category,ids] of Object.entries(groups))for(const id of ids) {
        if(!this.map.getLayer(id))continue;
        const current=this.map.getFilter(id),saved=this.filters.get(id);
        const base=saved && JSON.stringify(current)===saved.applied ? saved.base : current;
        const keys=[...this.current?.keys.get(category) || []];
        const type=["coalesce",["get","osmType"],["case",["all",["has","relationId"],["!=",["get","relationId"],""]],"relation",category==="fountain" ? "node" : "way"]];
        const filter=keys.length && !this.options.satellite ? ["all",expression(base),["!",["in",
          ["concat",type,":",["to-string",["get","osmId"]]],
          ["literal",keys]]]] : base;
        const applied=JSON.stringify(filter);this.filters.set(id,{base,applied});
        if(applied!==JSON.stringify(current))this.map.setFilter(id,filter);
      }
    }
    notify() {
      const element=root.document?.getElementById("map");if(!element)return;
      element.dataset.huayuImportedStructures=String(this.current?.count || 0);
      element.dataset.huayuImportedStructureCategories=[...this.current?.keys.keys() || []].join(',');
    }
    clear() {
      for(const {mesh} of this.meshes || []){this.scene?.remove(mesh);mesh.dispose();}
      this.resources?.forEach(resource=>resource.dispose());this.meshes=[];this.resources=[];
    }
    releaseGraphics() {this.clear();this.renderer?.dispose();this.renderer=null;this.origin=null;}
    destroy() {
      if(!this.alive)return;this.alive=false;root.clearTimeout(this.timer);root.clearTimeout(this.elevationTimer);this.unbind?.();
      this.map.off("sourcedata",this.onTerrain);this.map.off("terrain",this.onTerrain);this.map.off("moveend",this.onMoveEnd);this.map.off("remove",this.onRemove);
      this.map.off("styledata",this.onStyle);
      this.current={keys:new Map(),count:0};this.refreshFilters();
      if((!this.map.getStyle || this.map.getStyle()) && this.map.getLayer(LAYER_ID))this.map.removeLayer(LAYER_ID);
      this.releaseGraphics();
    }
  }
  root.HuayuStructureModels={LAYER_ID,CATEGORIES,fitPolygon,rectangleInside,describe,plan,expression,
    sync(map,inputs,options) {let controller=controllers.get(map);if(!controller){controller=new Controller(map,options);controllers.set(map,controller);}controller.update(inputs,options);return controller;},
    refreshFilters:map=>controllers.get(map)?.refreshFilters(),refreshElevation:map=>controllers.get(map)?.refreshElevation(),
    dispose(map){controllers.get(map)?.destroy();controllers.delete(map);},get:map=>controllers.get(map)};
})(typeof window!=="undefined" ? window : globalThis);
