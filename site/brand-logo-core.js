// Shared logo identity, map matching and bounded source queries.
function createBrandLogoCore() {
  "use strict";
  const normalize=v=>String(v||"").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu," ").trim();
  const fail=message=>{throw Object.assign(Error(message),{status:400});};
  function fields(v,allowed){if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail("logo_fields_invalid");}
  function text(v,n,required=false){if(typeof v!=="string"||v.length>n||/[\u0000-\u001f\u007f]/u.test(v)||required&&!v.trim())fail("logo_text_invalid");return v.trim();}
  function metadata(v) {
    const kind=v.kind;if(!["brand","operator","transit"].includes(kind))fail("logo_kind_invalid");
    const name=text(v.name,160,true),aliases=v.aliases||[];
    if(!Array.isArray(aliases)||aliases.length>20)fail("logo_aliases_invalid");
    const clean=[...new Map(aliases.map(a=>{const s=text(a,160,true);return [normalize(s),s];})).values()].filter(a=>normalize(a)!==normalize(name));
    const source=text(v.source||"",500,true),sourceUrl=text(v.sourceUrl||"",2048);
    if(sourceUrl){let u;try{u=new URL(sourceUrl);}catch{return fail("logo_source_invalid");}if(u.protocol!=="https:"||u.username||u.password)fail("logo_source_invalid");}
    if(v.rightsConfirmed!==true)fail("logo_rights_required");
    return {kind,name,key:kind+":"+normalize(name),aliases:clean,source,sourceUrl};
  }
  const facilities={shop:null,craft:null,office:"^(company|insurance|estate_agent|travel_agent|financial|telecommunication|it|lawyer|accountant|educational_institution|employment_agency)$",
    amenity:"^(bank|atm|bureau_de_change|cafe|restaurant|fast_food|ice_cream|bar|pub|food_court|pharmacy|fuel|charging_station|post_office|car_rental|car_sharing|bicycle_rental|veterinary|cinema|theatre|casino|internet_cafe)$",
    tourism:"^(hotel|motel|hostel|guest_house|apartment)$",healthcare:"^(hospital|clinic|dentist|pharmacy|physiotherapist|optometrist)$",
    leisure:"^(fitness_centre|sports_centre|bowling_alley|amusement_arcade)$"};
  const facility=t=>Object.entries(facilities).some(([key,pattern])=>typeof t[key]==="string"&&t[key].trim()
    && !/^(no|vacant|disused|abandoned|construction|proposed)$/iu.test(t[key])&&(!pattern||new RegExp(pattern,"u").test(t[key])));
  const compatible=(entry,t)=>!entry.categories?.length||entry.categories.some(([category])=>Object.keys(facilities).some(k=>category===k+"="+t[k])
    ||["amenity=bank","amenity=atm"].includes(category)&&["bank","atm"].includes(t.amenity));
  const station=t=>/^(station|halt|subway_entrance|tram_stop)$/u.test(t.railway)||t.public_transport==="station"||t.subway==="yes";
  function matcher(entries) {
    const indices=new Map();
    for(const e of entries)for(const v of [e.name,...e.aliases||[]]){
      const key=e.kind+":"+normalize(v);if(!indices.has(key))indices.set(key,[]);
      indices.get(key).push(e);
    }
    const lookup=(kind,v)=>{const a=indices.get(kind+":"+normalize(v));return a?.length===1?a[0]:null;};
    const choose=(kind,values)=>{const a=[...new Set(values.filter(Boolean).map(v=>lookup(kind,v)).filter(Boolean))];return a.length===1?a[0]:null;};
    function match(tags) {
      if(station(tags)){const a=choose("transit",[tags.network,tags["network:zh"],tags["network:en"],tags.operator,tags["operator:zh"]]);if(a)return a;}
      if(tags.brand)return lookup("brand",tags.brand);
      const tagged=choose("brand",Object.entries(tags).filter(([k])=>/^brand:[a-z]{2,3}$/u.test(k)).map(([,v])=>v));if(tagged)return tagged;
      if(tags.operator){const a=lookup("operator",tags.operator);if(a)return a;}
      if(!facility(tags))return null;
      const names=Object.entries(tags).filter(([k])=>/^(name(:.*)?|official_name|short_name|alt_name)$/u.test(k))
        .flatMap(([k,v])=>k==="alt_name"?String(v).split(";"):[v]),hits=new Set();
      for(const value of names){const full=normalize(value);
        for(let i=full.length;i>=1;i--){const a=lookup("brand",full.slice(0,i));if(!a||!compatible(a,tags))continue;const s=full.slice(i);
          if(!s||i>=2&&(/^[\s（(·-]/u.test(s)||/^[\p{L}\p{N} ·-]{1,64}(店|支行|分行|营业部|营业厅|营业处|支局|分校|分院)$/u.test(s))){hits.add(a);break;}
        }}
      return hits.size===1?[...hits][0]:null;
    }
    return {match,transit(stop,routes=[]){
      const values=[stop.logoTags||stop.tags||stop,...routes.filter(r=>["subway","light_rail","monorail","tram"].includes(r.type))];
      if(!routes.some(r=>["subway","light_rail","monorail","tram"].includes(r.type))&&!stop.isSubway)return null;
      const hits=new Set(values.map(t=>choose("transit",[t.network,t.operator,t["network:zh"],t["network:en"],t.tags?.network,t.tags?.operator])).filter(Boolean));
      return hits.size===1?[...hits][0]:null;
    }};
  }
  const escape=v=>String(v).replace(/[.*+?^$()|[\]\\{}]/gu,"\\$&");
  function query(entries,bounds) {
    if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(v=>!Number.isFinite(v))||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]
      ||bounds[0]<-180||bounds[2]>180||bounds[1]<-85||bounds[3]>85||bounds[2]-bounds[0]>.8||bounds[3]-bounds[1]>.8)fail("logo_bounds_invalid");
    if(entries.length>1000)fail("logo_catalog_too_large");
    const bbox=[bounds[1],bounds[0],bounds[3],bounds[2]].map(v=>v.toFixed(6)).join(","),sel=[];
    for(const kind of ["brand","operator","transit"]){
      const names=entries.filter(e=>e.kind===kind).flatMap(e=>[e.name,...e.aliases||[]]);if(!names.length)continue;
      const exact="^("+[...new Set(names)].map(escape).join("|")+")$", pattern=JSON.stringify(exact);
      if(kind==="brand"){
        sel.push('nwr[~"^brand(:[a-z]{2,3})?$"~'+pattern+',i]('+bbox+');');
        const namePattern=JSON.stringify("^("+[...new Set(names)].map(escape).join("|")+")($|[[:space:]（(·-]|.*(店|支行|分行|营业部|营业厅|营业处|支局|分校|分院)$)");
        for(const key of Object.keys(facilities))
          sel.push('nwr[!"brand"]["'+key+'"][~"^(name(:.*)?|official_name|short_name|alt_name)$"~'+namePattern+',i]('+bbox+');');
      }else{
        for(const key of kind==="operator"?["operator"]:["network","operator"]){
          const filter='[~"^'+key+'(:[a-z]{2,3})?$"~'+pattern+',i]';
          sel.push('nwr'+filter+(kind==="transit"?'[~"^(railway|public_transport|subway)$"~"^(station|halt|subway_entrance|tram_stop|yes)$"]':"")+'('+bbox+');');
          if(kind==="transit")sel.push('rel["route"~"^(subway|light_rail|monorail|tram)$"]'+filter+'('+bbox+')->.lr;nwr(r.lr:"stop")('+bbox+');nwr(r.lr:"platform")('+bbox+');.lr;');
        }
      }
    }
    return "[out:json][timeout:25][maxsize:8388608];("+sel.join("")+");out body center;out count;";
  }
  // Generated from brand-data.js by scripts/sync-brand-logos.mjs.
  // BEGIN BRAND PLACE LABEL
  function placeLabel(tags, identity = {}) {
    const clean = value => typeof value === "string" ? value.trim() : "";
    const name = clean(tags["name:zh"]) || clean(tags.name), branch = clean(tags.branch);
    if (identity.kind === "transit") return name || clean(identity.name) || "未命名车站";
    const brand = clean(tags.brand) || (identity.kind === "brand" ? clean(identity.name) : "");
    const base = (branch && brand ? brand : name || brand || clean(tags.operator) || clean(identity.name)) || branch || "未命名设施";
    return branch && normalize(base) !== normalize(branch) ? base + " · " + branch : base;
  }
  // END BRAND PLACE LABEL
  function markers(elements,entries) {
    const match=matcher(entries),inherited=new Map(),out=[],seen=new Set();
    for(const rel of elements.filter(e=>e.type==="relation"&&/^(subway|light_rail|monorail|tram)$/u.test(e.tags?.route))){
      const logo=match.match({...rel.tags,railway:"station"});if(!logo)continue;
      for(const m of rel.members||[]){const id=m.type+"/"+m.ref;if(!inherited.has(id))inherited.set(id,new Set());inherited.get(id).add(logo);}
    }
    for(const e of elements){
      if(!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0)continue;
      const id=e.type+"/"+e.id,t=e.tags||{},rel=inherited.get(id);
      let logo=match.match(t);if(!logo&&rel?.size===1)logo=[...rel][0];
      if(!logo||e.tags?.route||logo.kind==="transit"&&!station(t)&&!rel)continue;
      const lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180||seen.has(id))continue;
      if(logo.kind==="transit"&&(t.public_transport==="platform"||t.public_transport==="stop_position"||t.railway==="platform"))continue;
      seen.add(id);const name=t["name:zh"]||t.name||logo.name,label=placeLabel(t,logo);
      out.push({type:e.type,id:e.id,lat,lon,name,label,logoKey:logo.key,kind:logo.kind,tags:t});
    }
    return out;
  }
  // Suppress only accepted nearby source points with the same displayed name.
  // A same-name feature elsewhere or with another explicit brand stays visible.
  function suppressionExpression(places){
    const groups=new Map();
    for(const p of places){
      if(!p.name||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))continue;
      if(!groups.has(p.name))groups.set(p.name,[]);
      const dy=8/111320,dx=dy/Math.max(.087,Math.cos(p.lat*Math.PI/180));
      const w=p.lon-dx,e=p.lon+dx,b=p.lat-dy,t=p.lat+dy;
      groups.get(p.name).push([[[w,b],[e,b],[e,t],[w,t],[w,b]]]);
    }
    if(!groups.size)return true;
    return ["match",["coalesce",["get","name:zh"],["get","name"],""],...Array.from(groups,([name,coordinates])=>
      [name,["!",["within",{type:"MultiPolygon",coordinates}]]]).flat(),true];
  }
  function filterExpression(f){
    if(!Array.isArray(f))return f;
    const [op,key,...values]=f,property=k=>k==="$type"?["geometry-type"]:k==="$id"?["id"]:["get",k];
    if(["all","any","none"].includes(op)){const v=values.length?[key,...values]:key===undefined?[]:[key];return op==="none"?["!",["any",...v.map(filterExpression)]]:[op,...v.map(filterExpression)];}
    if(["==","!=",">",">=","<","<="].includes(op)&&typeof key==="string")return [op,property(key),...values];
    if(["in","!in"].includes(op)&&typeof key==="string"){const v=["in",property(key),["literal",values]];return op==="!in"?["!",v]:v;}
    if(op==="!has")return ["!",["has",key]];
    return f;
  }
  return Object.freeze({normalize,fields,metadata,matcher,query,placeLabel,markers,filterExpression,suppressionExpression});
}
globalThis.HuayuBrandLogoCore=createBrandLogoCore();
