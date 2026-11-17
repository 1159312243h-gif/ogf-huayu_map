(function(root){
  "use strict";
  const palette=["#d5e9f3","#9ac7dd","#5b9fc3","#286b9e","#143f70"],categories=["#286b9e","#cf7940","#62945e","#9b6ba0","#c3a442","#5b9b9d","#b85a6b","#687894","#8c785b","#637e4b","#b3799c","#758a91"];
  const escape=v=>String(v).replace(/[&<>"']/gu,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[c]);
  function prepare(analysis){
    const numeric=analysis.mode==="numeric",keys=analysis.categories.map(c=>c[0]);
    const legend=numeric?analysis.stops.map((v,i)=>({color:palette[i],label:String(v)})):keys.map((v,i)=>({color:categories[i],label:v}));
    if(!numeric&&analysis.categoryCount>12)legend.push({color:"#8b8b8b",label:"其他类别"});
    const features=analysis.geojson.features.map(f=>{let i=numeric?analysis.stops.findIndex(v=>f.properties.value<=v):keys.indexOf(f.properties.value);
      const color=numeric?palette[i<0?4:i]:i<0?"#8b8b8b":categories[i];
      const max=Math.max(Math.abs(analysis.min||0),Math.abs(analysis.max||0)),radius=numeric&&max?3+9*Math.sqrt(Math.min(1,Math.abs(f.properties.value)/max)):6;
      return {...f,properties:{...f.properties,color,radius}};
    });
    return {legend,geojson:{type:"FeatureCollection",features}};
  }
  function svg(analysis,item){
    const theme=prepare(analysis),points=[];
    const project=p=>[p[0]*Math.PI/180,Math.log(Math.tan(Math.PI/4+p[1]*Math.PI/360))];
    function visit(c){if(typeof c[0]==="number")points.push(project(c));else for(const p of c)visit(p);}
    for(const f of theme.geojson.features)visit(f.geometry.coordinates);
    if(!points.length)throw Error("数据包缺少可定位记录，暂不能导出空间专题图");
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    for(const p of points){x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);y0=Math.min(y0,p[1]);y1=Math.max(y1,p[1]);}
    const scale=Math.min(1250/Math.max(x1-x0,.0001),720/Math.max(y1-y0,.0001));
    const xy=p=>{const q=project(p);return [700+(q[0]-(x0+x1)/2)*scale,480-(q[1]-(y0+y1)/2)*scale];};
    const line=p=>p.map((v,i)=>`${i?"L":"M"}${xy(v).map(n=>n.toFixed(2)).join(",")}`).join(" ");
    function shape(g,p){const color=p.color;
      switch(g.type){
        case "Point":{const [x,y]=xy(g.coordinates);return `<circle cx="${x}" cy="${y}" r="${p.radius*1.5}" fill="${color}" stroke="#fff"/>`;}
        case "MultiPoint":return g.coordinates.map(c=>shape({type:"Point",coordinates:c},p)).join("");
        case "LineString":return `<path d="${line(g.coordinates)}" fill="none" stroke="${color}" stroke-width="3"/>`;
        case "MultiLineString":return g.coordinates.map(c=>shape({type:"LineString",coordinates:c},p)).join("");
        case "Polygon":return `<path d="${g.coordinates.map(r=>line(r)+" Z").join(" ")}" fill="${color}" fill-opacity=".75" fill-rule="evenodd" stroke="${color}" stroke-width="1.5"/>`;
        case "MultiPolygon":return g.coordinates.map(c=>shape({type:"Polygon",coordinates:c},p)).join("");
      }return "";
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#fff"/><g font-family="Arial, Microsoft YaHei, sans-serif" fill="#243746"><text x="45" y="55" font-size="27">${escape(item.title)}</text><text x="45" y="91" font-size="16">${escape(`${analysis.field} · ${item.unit||"未指定单位"} · ${item.period||item.observedDate} · 用户共享专题数据`)}</text>${theme.geojson.features.map(f=>shape(f.geometry,f.properties)).join("")}${theme.legend.map((v,i)=>`<rect x="1410" y="${140+i*38}" width="18" height="18" fill="${v.color}"/><text x="1437" y="${155+i*38}" font-size="14">${escape(v.label.slice(0,18))}</text>`).join("")}<text x="45" y="903" font-size="15">${escape(`来源：${item.source.slice(0,100)} · 统计日期：${item.observedDate} · 上传者：${item.author.displayName||item.author.username}`)}</text><text x="45" y="936" font-size="14">${escape(`许可：${item.license.slice(0,100)} · 已画 ${analysis.plotted}/${analysis.rows} 条；缺指标 ${analysis.missing}，有指标但无位置 ${analysis.unlocated}。`)}</text><text x="45" y="970" font-size="14">WGS84 / 墨卡托示意 · 独立数据专题图，未附底图 · 分位数边界可相同，记录算术和未扣除重复范围</text></g></svg>`;
  }
  root.HuayuDatasetTheme=Object.freeze({prepare,svg});
})(globalThis);
