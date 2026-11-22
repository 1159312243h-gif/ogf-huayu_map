// This factory is also embedded verbatim in the standalone Pages Worker.
function createSharedDatasetTools() {
  "use strict";
  const KINDS = Object.freeze({poi:"POI／设施",population:"人口",gdp:"GDP",land_price:"地价",demand:"通行需求",schedule:"车次安排（统计）",rail_timetable:"铁路时刻表",urban_timetable:"城铁时刻表",flight_timetable:"航班时刻表",other:"其他数据"});
  const fail = message => {throw Object.assign(new Error(message), {status:400});};
  const plain = v => v && typeof v === "object" && !Array.isArray(v);
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  function text(value, max=200, required=false) {
    if (typeof value !== "string") fail("文字字段格式无效");
    const v=value.trim();
    if ((required&&!v)||[...v].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail("文字字段为空、过长或含控制字符");
    return v;
  }
  function numeric(v) {
    if(typeof v==="number")return Number.isFinite(v)?v:null;
    if(typeof v!=="string"||!v.trim())return null;
    const s=v.trim();
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(s))return null;
    const n=Number(s);return Number.isFinite(n)?n:null;
  }
  function identity(type,id) {
    if(!["node","way","relation"].includes(type)||!/^\d{1,16}$/u.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<=0)fail("要素类型或编号无效");
    return {type,id:Number(id)};
  }
  function csv(input) {
    const rows=[];let row=[],cell="",quoted=false,ended=false;
    for(let i=0;i<input.length;i++) {
      const c=input[i];
      if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else {quoted=false;ended=true;}}else cell+=c;continue;}
      if(c==='"'){if(cell||ended)fail("CSV 引号位置无效");quoted=true;continue;}
      if(c===","||c==="\n"||c==="\r") {
        row.push(cell);cell="";ended=false;
        if(c!==","){if(c==="\r"&&input[i+1]==="\n")i++;if(row.some(x=>x.trim()))rows.push(row);row=[];}
      } else {if(ended&&c!==" "&&c!=="\t")fail("CSV 引号后存在多余字符");if(!ended)cell+=c;}
    }
    if(quoted)fail("CSV 引号未闭合");
    row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
    const headers=rows.shift()?.map(v=>text(v,80,true));
    if(!headers?.length||new Set(headers).size!==headers.length)fail("CSV 表头为空或重复");
    return rows.map((values,i)=>{if(values.length!==headers.length)fail(`CSV 第 ${i+2} 行列数与表头不同`);return Object.fromEntries(headers.map((k,j)=>[k,values[j]]));});
  }
  function geometry(value,budget={vertices:0}) {
    if(value===null||value===undefined)return null;
    if(!plain(value)||!own(value,"coordinates"))fail("几何格式无效");
    const point=p=>{if(!Array.isArray(p)||p.length<2||p.length>3||p.some(n=>typeof n!=="number"||!Number.isFinite(n))||Math.abs(p[0])>180||Math.abs(p[1])>85)fail("坐标须为 WGS84 经度、纬度（纬度 ±85°）");budget.vertices++;return p.slice(0,2);};
    const line=(r,min)=>{if(!Array.isArray(r)||r.length<min)fail("几何顶点不足");return r.map(point);};
    const ring=r=>{const p=line(r,4);if(p[0][0]!==p.at(-1)[0]||p[0][1]!==p.at(-1)[1])fail("多边形环必须闭合");return p;};
    const poly=p=>{if(!Array.isArray(p)||!p.length)fail("多边形缺少外环");return p.map(ring);};
    let coordinates;
    switch(value.type){
      case "Point":coordinates=point(value.coordinates);break;
      case "MultiPoint":coordinates=line(value.coordinates,1);break;
      case "LineString":coordinates=line(value.coordinates,2);break;
      case "MultiLineString":if(!Array.isArray(value.coordinates)||!value.coordinates.length)fail("线集合为空");coordinates=value.coordinates.map(r=>line(r,2));break;
      case "Polygon":coordinates=poly(value.coordinates);break;
      case "MultiPolygon":if(!Array.isArray(value.coordinates)||!value.coordinates.length)fail("面集合为空");coordinates=value.coordinates.map(poly);break;
      default:fail("仅支持点、线、面及其多部件 GeoJSON 几何");
    }
    return {type:value.type,coordinates};
  }
  function scope(value) {
    if(!plain(value)||!["feature","region","large"].includes(value.kind))fail("请选择单要素、区域或更大范围");
    const result={kind:value.kind,label:text(value.label,200,true)};
    if(value.target)result.target=identity(value.target.type,value.target.id);
    if(value.geometry){result.geometry=geometry(value.geometry);if(value.kind!=="feature"&&!["Polygon","MultiPolygon"].includes(result.geometry.type))fail("区域范围须为真实面几何");}
    return result;
  }
  function normalize(input,format,options={}) {
    if(typeof input!=="string")fail("文件须为 UTF-8 文本");
    const s=input.replace(/^\uFEFF/u,"");let data;
    if(format==="csv")data=csv(s);
    else if(["json","geojson"].includes(format)){try{data=JSON.parse(s);}catch{fail("JSON 无法解析");}
      if(data?.crs)fail("请先转换为 WGS84 经纬度，不能导入其他坐标系");
      if(data?.type==="FeatureCollection")data=data.features;
      else if(data?.type==="Feature")data=[data];
      else if(plain(data)&&Array.isArray(data.records))data=data.records;
    } else fail("支持 CSV、JSON、GeoJSON 文件");
    if(!Array.isArray(data)||!data.length)fail("数据包须含至少一条记录");
    const area=options.scope?scope(options.scope):null,budget={vertices:0},columns=new Set(),primaryColumns=new Set(),numericColumns=new Map(),bounds=[Infinity,Infinity,-Infinity,-Infinity];
    const find=(p,aliases)=>aliases.find(k=>own(p,k));
    const fields=options.fields||{};
    for(const k of Object.keys(fields))if(!["lng","lat","name","value","type","id"].includes(k))fail("字段映射无效");
    for(const v of Object.values(fields))if(typeof v!=="string"||v.length>80)fail("字段映射无效");
    const records=data.map((raw,i)=>{
      if(!plain(raw))fail(`第 ${i+1} 条记录须为对象`);
      const p=raw.type==="Feature"?raw.properties:raw;
      if(!plain(p))fail(`第 ${i+1} 条记录缺少属性`);
      const props=Object.create(null);
      for(const [key,v] of Object.entries(p)) {
        if(key==="geometry"&&raw.type!=="Feature")continue;
        text(key,80,true);if(["__proto__","constructor","prototype"].includes(key))fail("属性名含保留字段");
        if(v!==null&&!["string","number","boolean"].includes(typeof v)||typeof v==="number"&&!Number.isFinite(v))fail(`第 ${i+1} 条属性仅支持文字、数字、布尔或空值`);
        if(typeof v==="string")text(v,2048);
        props[key]=v;columns.add(key);
      }
      const get=(role,aliases)=>fields[role]?fields[role]:find(props,aliases);
      const x=get("lng",["longitude","lon","lng","经度"]),y=get("lat",["latitude","lat","纬度"]);
      let g=geometry(raw.geometry,budget);
      const hasX=x&&props[x]!==null&&props[x]!=="",hasY=y&&props[y]!==null&&props[y]!=="";
      if(!g&&(hasX||hasY)){
        const a=numeric(props[x]),b=numeric(props[y]);if(a===null||b===null)fail(`第 ${i+1} 条经纬度缺失或不是数字`);g=geometry({type:"Point",coordinates:[a,b]},budget);
      }
      const typeKey=get("type",["osm_type","要素类型"]),idKey=get("id",["osm_id","要素编号"]);
      let target=null;
      if(typeKey||idKey){if(props[typeKey]!==""||props[idKey]!=="")target=identity(props[typeKey],props[idKey]);}
      if(!target&&data.length===1&&area?.target)target=area.target;
      if(!g&&data.length===1&&area?.geometry)g=geometry(area.geometry,budget);
      const nameKey=get("name",["stop_name","station","name","名称","地区","站名"]),valueKey=get("value",({population:["population","人口","value","值"],gdp:["gdp","GDP","value","值"],land_price:["land_price","地价","value","值"],demand:["trips","demand","通行需求","value","值"],schedule:["frequency","车次","value","值"]})[options.kind]||["value","值"]);
      const value=valueKey?numeric(props[valueKey]):null;
      if(valueKey&&own(props,valueKey))primaryColumns.add(valueKey);
      if(valueKey&&props[valueKey]!==null&&props[valueKey]!==""&&value===null)fail(`第 ${i+1} 条指标不是有效数字，请用单位栏填写单位`);
      if(value!==null&&["population","gdp","land_price","demand","schedule"].includes(options.kind)&&value<0)fail(`第 ${i+1} 条指标不能为负数`);
      for(const [k,v] of Object.entries(props)){const n=numeric(v);if(n!==null){const stat=numericColumns.get(k)||{count:0,sum:0,min:Infinity,max:-Infinity};stat.count++;stat.sum+=n;stat.min=Math.min(stat.min,n);stat.max=Math.max(stat.max,n);if(!Number.isFinite(stat.sum))fail("指标合计超出可计算范围");numericColumns.set(k,stat);}}
      const visit=c=>{if(typeof c[0]==="number"){bounds[0]=Math.min(bounds[0],c[0]);bounds[1]=Math.min(bounds[1],c[1]);bounds[2]=Math.max(bounds[2],c[0]);bounds[3]=Math.max(bounds[3],c[1]);}else for(const p of c)visit(p);};if(g)visit(g.coordinates);
      return {properties:props,geometry:g,target,name:String(nameKey?props[nameKey]??"":target?`${target.type}:${target.id}`:`记录 ${i+1}`),value};
    });
    const result={schema:"huayu-shared-dataset-v1",records,columns:[...columns],primaryColumns:[...primaryColumns],numericColumns:Object.fromEntries(numericColumns),
      stats:{rows:records.length,located:records.filter(r=>r.geometry).length,linked:records.filter(r=>r.target).length,vertices:budget.vertices,bounds:bounds.every(Number.isFinite)?bounds:null}};
    if(["rail_timetable","urban_timetable","flight_timetable"].includes(options.kind))result.timetable=(globalThis.HuayuTimetableCore||createTransportTimetableCore()).normalize(records,options.kind);
    return result;
  }
  function analyze(data,{field="value",mode="numeric"}={}) {
    if(!["numeric","category"].includes(mode))fail("专题图类型无效");
    if(field!=="value"&&!data.columns.includes(field))fail("专题字段不存在");
    let missing=0,unlocated=0;const values=[],features=[],categories=new Map();
    for(let i=0;i<data.records.length;i++){
      const r=data.records[i],raw=field==="value"?r.value:r.properties[field],v=mode==="numeric"?numeric(raw):raw==null||raw===""?null:String(raw);
      if(v===null){missing++;continue;}if(mode==="numeric")values.push(v);else categories.set(v,(categories.get(v)||0)+1);
      if(!r.geometry){unlocated++;continue;}
      features.push({type:"Feature",id:i,geometry:r.geometry,properties:{record:i,name:r.name,value:v}});
    }
    values.sort((a,b)=>a-b);const groups=[...categories].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const stops=values.length?[0,.25,.5,.75,1].map(q=>values[Math.floor((values.length-1)*q)]):[];
    const sum=values.reduce((a,b)=>a+b,0);if(!Number.isFinite(sum))fail("指标合计超出可计算范围");
    return {field,mode,rows:data.records.length,missing,unlocated,plotted:features.length,count:mode==="numeric"?values.length:groups.reduce((n,g)=>n+g[1],0),
      sum:values.length?sum:null,min:values[0]??null,max:values.at(-1)??null,mean:values.length?sum/values.length:null,stops,
      categories:groups.slice(0,12),categoryCount:groups.length,geojson:{type:"FeatureCollection",features}};
  }
  return Object.freeze({KINDS,text,numeric,identity,geometry,scope,normalize,analyze});
}
globalThis.HuayuDatasetTools=createSharedDatasetTools();
