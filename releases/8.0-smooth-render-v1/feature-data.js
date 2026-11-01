(function(root) {
  "use strict";
  const kinds = {all:"所有有标签物体",building:"建筑",road:"道路",railway:"铁路",water:"水体",vegetation:"植被",landuse:"用地",amenity:"公共设施",shop:"商店",tourism:"旅游与历史",boundary:"边界",custom:"自定义标签"};
  const condition=(tag,values=[])=>({tag,values});
  const subtype=(id,label,tag,values)=>({id,label,conditions:[condition(tag,values)]});
  const buildingSubtype=(id,label,values)=>({id,label,conditions:[condition("building",values),condition("building:part",values)]});
  const subtypes={
    building:[buildingSubtype("residential","住宅与宿舍",["residential","house","apartments","detached","semidetached_house","terrace","dormitory"]),
      buildingSubtype("commercial","商业与零售建筑",["commercial","retail","supermarket","kiosk"]),buildingSubtype("office","办公楼",["office"]),
      buildingSubtype("industrial","工业与仓储建筑",["industrial","warehouse"]),buildingSubtype("education","学校与教学建筑",["school","university","college","kindergarten"]),
      buildingSubtype("medical","医疗建筑",["hospital","clinic"]),buildingSubtype("religious","宗教建筑",["church","cathedral","chapel","mosque","temple","shrine"]),
      buildingSubtype("public","公共与交通建筑",["public","civic","government","train_station","transportation"]),buildingSubtype("garage","车库与停车楼",["garage","garages","parking"]),
      buildingSubtype("roof","棚顶与附属建筑",["roof","shed","hut","greenhouse"])],
    road:[subtype("motorway","高速公路", "highway",["motorway","motorway_link"]),subtype("primary","快速路与主干道","highway",["trunk","trunk_link","primary","primary_link"]),
      subtype("secondary","次干道与支路","highway",["secondary","secondary_link","tertiary","tertiary_link"]),subtype("residential","居住街道","highway",["residential","living_street","unclassified"]),
      subtype("service","内部与服务道路","highway",["service"]),subtype("walking","步行道与台阶","highway",["footway","pedestrian","steps","path"]),
      subtype("cycleway","自行车道","highway",["cycleway"]),subtype("construction","在建与规划道路","highway",["construction","proposed"])],
    railway:[subtype("rail","普通铁路","railway",["rail","narrow_gauge"]),subtype("subway","地铁轨道","railway",["subway"]),
      subtype("light","轻轨与有轨电车","railway",["light_rail","tram"]),subtype("monorail","单轨与磁悬浮","railway",["monorail","maglev"]),
      subtype("station","车站与停靠点","railway",["station","halt","tram_stop"]),subtype("platform","站台","railway",["platform"]),
      subtype("disused","废弃与停用铁路","railway",["abandoned","disused"]),subtype("construction","在建与规划铁路","railway",["construction","proposed"])],
    water:[{id:"river",label:"河流与溪流",conditions:[condition("waterway",["river","stream"]),condition("water",["river","stream"])]},
      subtype("canal","运河","waterway",["canal"]),subtype("drain","排水渠与沟渠","waterway",["drain","ditch"]),
      subtype("lake","湖泊","water",["lake"]),subtype("pond","池塘","water",["pond"]),subtype("reservoir","水库与蓄水池","water",["reservoir","basin"])],
    vegetation:[{id:"forest",label:"森林与林地",conditions:[condition("natural",["wood"]),condition("landuse",["forest"])]},
      subtype("tree","单棵树木","natural",["tree"]),subtype("scrub","灌丛与荒原","natural",["scrub","heath"]),
      {id:"grass",label:"草地与草甸",conditions:[condition("natural",["grassland"]),condition("landuse",["grass","meadow"])]}],
    landuse:[subtype("residential","居住用地","landuse",["residential"]),subtype("commercial","商业与零售用地","landuse",["commercial","retail"]),
      subtype("industrial","工业用地","landuse",["industrial"]),subtype("farmland","农田与农场","landuse",["farmland","farmyard"]),
      subtype("orchard","果园与葡萄园","landuse",["orchard","vineyard"]),subtype("forest","林业用地","landuse",["forest"]),
      subtype("grass","草地与草甸","landuse",["grass","meadow"]),subtype("recreation","休闲绿地","landuse",["recreation_ground","village_green"]),
      subtype("construction","在建与待开发用地","landuse",["construction","brownfield","greenfield"]),subtype("cemetery","墓地","landuse",["cemetery"])],
    amenity:[subtype("education","教育与科研","amenity",["school","university","college","kindergarten","research_institute"]),
      subtype("medical","医疗与药房","amenity",["hospital","clinic","doctors","dentist","pharmacy"]),
      {id:"government",label:"政务与司法",conditions:[condition("amenity",["townhall","courthouse","embassy"]),condition("office",["government","diplomatic"])]},
      subtype("safety","警务与消防","amenity",["police","fire_station"]),subtype("transport","客运与渡轮设施","amenity",["bus_station","ferry_terminal","taxi"]),
      subtype("parking","停车与充能设施","amenity",["parking","parking_entrance","bicycle_parking","fuel","charging_station"]),
      subtype("food","餐饮与咖啡","amenity",["restaurant","cafe","fast_food","food_court","bar","pub"]),subtype("finance","银行与取款机","amenity",["bank","atm"]),
      subtype("culture","文化与社区设施","amenity",["library","theatre","cinema","arts_centre","community_centre"]),
      subtype("public","便民与公共小设施","amenity",["toilets","drinking_water","bench","waste_basket","post_box","post_office"]),
      subtype("office","办公机构","office",[])],
    shop:[subtype("grocery","超市与食品店","shop",["supermarket","convenience","greengrocer","bakery","butcher","seafood"]),
      subtype("mall","商场与百货","shop",["mall","department_store"]),subtype("clothing","服饰与鞋包","shop",["clothes","shoes","bag","jewelry"]),
      subtype("electronics","数码与家电","shop",["electronics","computer","mobile_phone","appliance"]),
      subtype("home","家居与五金","shop",["furniture","hardware","doityourself","houseware"]),
      subtype("books","书店与文具","shop",["books","stationery","newsagent"]),subtype("services","生活服务","shop",["hairdresser","beauty","laundry","dry_cleaning","car_repair"])],
    tourism:[subtype("lodging","住宿","tourism",["hotel","motel","hostel","guest_house","apartment"]),
      subtype("museum","博物馆与展馆","tourism",["museum","gallery"]),subtype("attraction","景点与观景点","tourism",["attraction","viewpoint"]),
      subtype("camping","露营与野餐","tourism",["camp_site","caravan_site","picnic_site"]),subtype("information","游客服务","tourism",["information"]),
      subtype("memorial","纪念碑与纪念物","historic",["monument","memorial"]),subtype("heritage","遗址与古迹","historic",["castle","city_gate","ruins","archaeological_site","citywalls"])],
    boundary:[subtype("administrative","行政区边界","boundary",["administrative"]),subtype("protected","保护区与国家公园","boundary",["protected_area","national_park"]),
      subtype("postal","邮政区界","boundary",["postal_code"]),subtype("maritime","海上边界","boundary",["maritime"])],
  };
  function downloadFilters(kind,options={}) {
    const id=options.subtype||"",selected=subtypes[kind]?.find(item=>item.id===id);
    if(id&&!selected)throw Error("该细分类不属于当前物体类型，请重新选择");
    const name=String(options.name||"").trim(),nameMode=options.nameMode||"contains";
    if(name.length>100||/[\x00-\x1f\x7f]/u.test(name))throw Error("名称最多 100 个字符，不能含控制字符");
    if(!["contains","exact"].includes(nameMode))throw Error("名称匹配方式无效");
    return {kind,tag:options.tag||"",value:options.value||"",name,nameMode,detail:selected?.conditions||[]};
  }
  function matchesFilters(tags,filters) {
    if(!matches(tags,filters.kind,filters))return false;
    if(filters.detail?.length&&!filters.detail.some(c=>c.values.length?c.values.includes(tags[c.tag]):tags[c.tag]!==undefined&&tags[c.tag]!=="no"))return false;
    const name=(filters.name||"").toLowerCase();if(!name)return true;
    return Object.entries(tags).some(([tag,value])=>/^(name|official_name|short_name|alt_name|loc_name|old_name)(:.*)?$/u.test(tag)
      && (filters.nameMode==="exact"?String(value).toLowerCase()===name:String(value).toLowerCase().includes(name)));
  }
  const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const same = (a,b) => a && b && a[0] === b[0] && a[1] === b[1];
  const key = e => `${e.type}/${e.id}`;
  function matches(tags,kind,value={}) {
    const has = name => tags[name] !== undefined && tags[name] !== "no";
    if(kind==="all")return Object.keys(tags).length>0;
    if(kind==="custom")return has(value.tag) && (!value.value || tags[value.tag]===value.value);
    return {building:has("building")||has("building:part"),road:has("highway"),railway:has("railway"),
      water:has("water")||has("waterway")||tags.natural==="water",vegetation:["wood","scrub","tree","heath","grassland"].includes(tags.natural)||["forest","grass","meadow"].includes(tags.landuse),
      landuse:has("landuse"),amenity:has("amenity")||has("office"),shop:has("shop"),tourism:has("tourism")||has("historic"),boundary:has("boundary")}[kind]||false;
  }
  function kind(tags) {return Object.keys(kinds).find(k=>!["all","custom"].includes(k)&&matches(tags,k))||"all";}
  function inRing(p,ring) {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j];
      if(Math.abs((p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]))<1e-12
        &&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]))return true;
      if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  const polygons = g => g.type==="Polygon"?[g.coordinates]:g.type==="MultiPolygon"?g.coordinates:[];
  const contains = (g,p) => g.type==="GeometryCollection"?g.geometries.some(child=>contains(child,p)):polygons(g).some(rings=>inRing(p,rings[0])&&!rings.slice(1).some(r=>inRing(p,r)));
  function joinRings(parts) {
    const todo=parts.map(p=>p.map(c=>c.slice())),rings=[];
    while(todo.length) {
      const ring=todo.shift();
      while(!same(ring[0],ring.at(-1))) {
        const index=todo.findIndex(p=>same(ring.at(-1),p[0])||same(ring.at(-1),p.at(-1)));
        if(index<0)return null;
        const next=todo.splice(index,1)[0];if(!same(ring.at(-1),next[0]))next.reverse();for(const point of next.slice(1))ring.push(point);
      }
      if(ring.length<4)return null;rings.push(ring);
    }
    return rings;
  }
  function decode(payload) {
    if(!Array.isArray(payload?.elements)||!Array.isArray(payload.rootKeys)||payload.remark)throw Error("物体数据不完整，请重试");
    const elements=new Map();
    for(const e of payload.elements) {
      if(!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0)continue;
      const previous=elements.get(key(e));elements.set(key(e),{...previous,...e,geometry:e.geometry||previous?.geometry,tags:e.tags||previous?.tags});
    }
    const wayCoordinates = e => {
      const coordinates=e?.geometry?.map(p=>[p?.lon,p?.lat])||e?.nodes?.map(id=>{const n=elements.get(`node/${id}`);return [n?.lon,n?.lat];});
      return coordinates?.length>=2&&coordinates.every(validPoint)?coordinates:null;
    };
    const geometry = (e,seen=new Set()) => {
      if(seen.has(key(e)))return null;
      const nextSeen=new Set(seen);nextSeen.add(key(e));
      if(e.type==="node")return validPoint([e.lon,e.lat])?{type:"Point",coordinates:[e.lon,e.lat]}:null;
      const tags=e.tags||{};
      if(e.type==="way") {
        const coordinates=wayCoordinates(e);if(!coordinates)return null;
        const area=tags.area==="yes"||tags.area!=="no"&&(tags.building||tags["building:part"]||tags.landuse||tags.leisure||tags.amenity||tags.shop||tags.tourism||tags.boundary||["water","wood","scrub","wetland","beach","sand","grassland","heath"].includes(tags.natural));
        return {type:area&&coordinates.length>=4&&same(coordinates[0],coordinates.at(-1))?"Polygon":"LineString",coordinates:area&&coordinates.length>=4&&same(coordinates[0],coordinates.at(-1))?[coordinates]:coordinates};
      }
      if(tags.type!=="multipolygon"&&tags.type!=="boundary"&&tags.boundary===undefined) {
        const geometries=(e.members||[]).map(member=>{const object=elements.get(`${member.type}/${member.ref}`);return object&&geometry(object,nextSeen);});
        if(!geometries.length||geometries.some(g=>!g))return null;
        if(geometries.every(g=>g.type==="Point"))return {type:"MultiPoint",coordinates:geometries.map(g=>g.coordinates)};
        if(geometries.every(g=>["LineString","MultiLineString"].includes(g.type)))return {type:"MultiLineString",coordinates:geometries.flatMap(g=>g.type==="LineString"?[g.coordinates]:g.coordinates)};
        return {type:"GeometryCollection",geometries};
      }
      if((e.members||[]).some(m=>m.type==="relation"&&["outer","inner", ""].includes(m.role||"")))return null;
      const members=(e.members||[]).filter(m=>m.type==="way"&&["outer","inner", ""].includes(m.role||""));
      if(!members.length)return null;
      const lines=members.map(m=>({role:m.role||"outer",coordinates:wayCoordinates({...elements.get(`way/${m.ref}`),geometry:m.geometry||elements.get(`way/${m.ref}`)?.geometry})}));
      if(lines.some(p=>!p.coordinates))return null;
      const outer=joinRings(lines.filter(p=>p.role!=="inner").map(p=>p.coordinates)),inner=joinRings(lines.filter(p=>p.role==="inner").map(p=>p.coordinates));
      if(!outer?.length||!inner)return null;
      const result=outer.map(r=>[r]);
      for(const hole of inner) {
        const candidates=outer.map((r,i)=>({i,r,area:Math.abs(r.reduce((a,p,k)=>a+p[0]*r[(k+1)%r.length][1]-p[1]*r[(k+1)%r.length][0],0))})).filter(p=>inRing(hole[0],p.r)).sort((a,b)=>a.area-b.area);
        if(!candidates.length)return null;result[candidates[0].i].push(hole);
      }
      return {type:"MultiPolygon",coordinates:result};
    };
    const features=[],unresolved=[];
    for(const id of new Set(payload.rootKeys)) {
      const e=elements.get(id),g=e&&geometry(e);
      if(!g) {unresolved.push(id);continue;}
      const tags=e.tags||{},category=kind(tags);
      features.push({type:"Feature",id,properties:{...tags,name:tags["name:zh"]||tags.name||`${kinds[category]} ${e.id}`,osm_type:e.type,osm_id:e.id,kind:category,tags:{...tags}},geometry:g});
    }
    return {features,elements:[...elements.values()],elementIndex:elements,unresolved,fetchedAt:payload.fetchedAt};
  }
  function entry(data,feature) {
    const index=data.elementIndex||new Map(data.elements.map(e=>[key(e),e])),selected=new Map(),todo=[feature.id];
    while(todo.length) {
      const id=todo.pop();if(selected.has(id))continue;
      const object=index.get(id);if(!object)throw Error("物体缺少原始成员或节点，请重新读取");
      if(object.type==="node"&&!validPoint([object.lon,object.lat]))throw Error("物体原始节点坐标不完整，请重新读取");
      selected.set(id,object);
      if(object.type==="way") {
        if(!object.nodes?.length)throw Error("物体缺少原始节点，请重新读取");
        for(const node of object.nodes)todo.push(`node/${node}`);
      }
      if(object.type==="relation")for(const member of object.members||[])todo.push(`${member.type}/${member.ref}`);
    }
    return {feature,elements:[...selected.values()],fetchedAt:data.fetchedAt};
  }
  function parts(g) {return g.type==="GeometryCollection"?g.geometries.flatMap(parts):g.type==="Point"?[[g.coordinates]]:g.type==="MultiPoint"?g.coordinates.map(p=>[p]):g.type==="LineString"?[g.coordinates]:g.type==="MultiLineString"?g.coordinates:polygons(g).flat();}
  function flattenFeatures(features) {
    return features.flatMap(feature=>{
      const geometry=feature.geometry;
      if(geometry.type==="GeometryCollection")return flattenFeatures(geometry.geometries.map(g=>({...feature,geometry:g})));
      if(geometry.type==="MultiPoint")return geometry.coordinates.map(p=>({...feature,geometry:{type:"Point",coordinates:p}}));
      return [feature];
    });
  }
  function distance(g,point) {
    if(contains(g,point))return 0;
    const sx=111320*Math.cos(point[1]*Math.PI/180),sy=111320;
    const local=p=>[(p[0]-point[0])*sx,(p[1]-point[1])*sy];
    let best=Infinity;
    for(const line of parts(g)) {
      for(let i=0;i<line.length;i++) {
        const a=local(line[i]),b=local(line[Math.min(i+1,line.length-1)]),dx=b[0]-a[0],dy=b[1]-a[1];
        const t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/(dx*dx+dy*dy||1)));
        best=Math.min(best,Math.hypot(a[0]+t*dx,a[1]+t*dy));
      }
    }
    return best;
  }
  function rank(features,point,radius) {
    return features.map(f=>{
      const d=distance(f.geometry,point),ps=parts(f.geometry).flat();
      const bounds=ps.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);
      const box=(bounds[2]-bounds[0])*(bounds[3]-bounds[1]);
      const enclosed=contains(f.geometry,point);
      return {f,d,score:enclosed?(f.properties.kind==="building"?-100000:-1000)+Math.log1p(box*1e10):d+(f.properties.kind==="boundary"?radius*10:0)};
    }).filter(p=>p.d<=radius).sort((a,b)=>a.score-b.score||a.f.id.localeCompare(b.f.id)).slice(0,40).map(p=>p.f);
  }
  function intersects(g,masks) {
    if(!masks?.length)return true;
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const segments=(a,b,c,d)=>Math.max(a[0],b[0])>=Math.min(c[0],d[0])&&Math.max(c[0],d[0])>=Math.min(a[0],b[0])
      &&Math.max(a[1],b[1])>=Math.min(c[1],d[1])&&Math.max(c[1],d[1])>=Math.min(a[1],b[1])
      &&cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0;
    return masks.some(f=>{
      const mask=f.geometry;
      if(parts(g).some(line=>line.some(p=>contains(mask,p))))return true;
      if(parts(mask).some(line=>line.some(p=>contains(g,p))))return true;
      return parts(g).some(line=>line.some((p,i)=>i>0&&parts(mask).some(ring=>ring.some((q,j)=>j>0&&segments(line[i-1],p,ring[j-1],q)))));
    });
  }
  const escape = value => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  function osm(entries) {
    if (entries.some(entry => entry.derived)) throw Error("清单含线路图几何，请选择 GeoJSON、SHP 或 CSV；OSM 仅支持完整原始物体");
    const elements=new Map();for(const entry of entries)for(const e of entry.elements)elements.set(key(e),e);
    const objects=[...elements.values()].sort((a,b)=>["node","way","relation"].indexOf(a.type)-["node","way","relation"].indexOf(b.type)||a.id-b.id);
    const lines=objects.map(e=>{
      let body=Object.entries(e.tags||{}).map(([k,v])=>`<tag k="${escape(k)}" v="${escape(v)}"/>`);
      if(e.type==="way") {
        if(!e.nodes?.length)throw Error("缺少原始道路节点，无法完整导出 OSM");
        body=[...e.nodes.map(id=>{if(!elements.has(`node/${id}`))throw Error("缺少原始道路节点，无法完整导出 OSM");return `<nd ref="${id}"/>`;}),...body];
      }
      if(e.type==="relation")body=[...(e.members||[]).map(m=>{if(!elements.has(`${m.type}/${m.ref}`))throw Error("缺少关系成员，无法完整导出 OSM");return `<member type="${escape(m.type)}" ref="${m.ref}" role="${escape(m.role||"")}"/>`;}),...body];
      return `<${e.type} id="${e.id}"${e.type==="node"?` lat="${e.lat}" lon="${e.lon}"`:""}>${body.join("")}</${e.type}>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="Huayu Map" upload="false"><note>OpenGeofiction and contributors; selected objects with required dependencies. Not for upload.</note>\n${lines.join("\n")}\n</osm>`;
  }
  function csv(features) {
    const cell=v=>`"${String(v??"").replace(/^[=+@\-\t\r]/u,"'$&").replace(/"/g,'""')}"`;
    return "\ufeff"+[["osm_type","osm_id","name","kind","geometry","tags"],...features.map(f=>[f.properties.osm_type,f.properties.osm_id,f.properties.name,kinds[f.properties.kind],JSON.stringify(f.geometry),JSON.stringify(f.properties.tags)])].map(row=>row.map(cell).join(",")).join("\r\n");
  }
  root.HuayuFeatures={kinds,subtypes,downloadFilters,matchesFilters,matches,kind,decode,entry,contains,distance,rank,intersects,parts,flattenFeatures,osm,csv};
})(typeof window!=="undefined"?window:globalThis);
