import fs from "node:fs";
import path from "node:path";
import {deflateSync} from "node:zlib";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),check=process.argv.includes("--check");
const crc=bytes=>{let c=0xffffffff;for(const byte of bytes){c^=byte;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum]);};
function inside(x,y,polygon){let hit=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
function distance(x,y,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);}
function png(size){
 const rows=Buffer.alloc((size*3+1)*size),map=[[25,30],[44,24],[64,31],[83,25],[83,78],[64,84],[44,77],[25,83]],road=[[32,66],[48,52],[62,59],[77,43]];
 for(let py=0;py<size;py++)for(let px=0;px<size;px++){
  const values=[0,0,0];
  for(const ox of [.25,.75])for(const oy of [.25,.75]){
   const x=(px+ox)*108/size,y=(py+oy)*108/size;
   let color=[23,104,93];
   if(inside(x,y,map))color=[255,255,255];
   if(distance(x,y,[44,25],[44,77])<1.3||distance(x,y,[64,32],[64,83])<1.3)color=[23,104,93];
   if(road.slice(1).some((end,i)=>distance(x,y,road[i],end)<3))color=[237,184,84];
   if(Math.hypot(x-77,y-43)<6)color=[23,104,93];
   color.forEach((v,i)=>values[i]+=v);
  }
  const offset=py*(size*3+1)+1+px*3;values.forEach((v,i)=>rows[offset+i]=Math.round(v/4));
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(rows,{level:9})),chunk("IEND",Buffer.alloc(0))]);
}
function emit(relative,content){const file=path.join(root,relative),bytes=Buffer.isBuffer(content)?content:Buffer.from(content);if(check){if(!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes))throw Error("应用文件需要同步："+relative);}else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}}
const small=png(192),large=png(512),ios=png(1024);
emit("site/app-icons/icon-192.png",small);emit("site/app-icons/icon-512.png",large);
emit("apps/desktop/icons/icon-512.png",large);
emit("apps/ios/Sources/Assets.xcassets/AppIcon.appiconset/icon-1024.png",ios);
emit("apps/ios/Sources/Assets.xcassets/AppIcon.appiconset/Contents.json",JSON.stringify({images:[{filename:"icon-1024.png",idiom:"universal",platform:"ios",size:"1024x1024"}],info:{author:"xcode",version:1}},null,2)+"\n");
emit("apps/desktop/app.json",fs.readFileSync(path.join(root,"apps/app.json")));
console.log(check?"Application assets match":"Application assets prepared");
