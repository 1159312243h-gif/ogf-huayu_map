const linear = Float32Array.from({length:256}, (_,value) => {
  const channel=value/255;
  return channel<=0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4;
});
const encode = value => Math.round(255*(value<=0.0031308 ? value*12.92 : 1.055*value**(1/2.4)-0.055));

// Sample between texel centers, as the renderer's linear filter does.
export function alphaCoverage(data,width,height,alphaTest,repeat=true) {
  const threshold=alphaTest*255*16;
  let covered=0;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const center=data[(y*width+x)*4+3];
    for(const dy of [-1,1]) for(const dx of [-1,1]) {
      const nx=repeat ? (x+dx+width)%width : Math.max(0,Math.min(width-1,x+dx));
      const ny=repeat ? (y+dy+height)%height : Math.max(0,Math.min(height-1,y+dy));
      const alpha=9*center+3*data[(y*width+nx)*4+3]+3*data[(ny*width+x)*4+3]+data[(ny*width+nx)*4+3];
      if(alpha>=threshold)covered++;
    }
  }
  return covered/(width*height*4);
}

function preserveCoverage(raw,width,height,target,alphaTest,repeat) {
  const adjusted=new Uint8ClampedArray(raw.length);
  adjusted.set(raw);
  let best=Infinity,bestScale=1,low=0,high=255;
  const evaluate=scale=>{
    for(let i=3;i<raw.length;i+=4) adjusted[i]=Math.round(Math.min(255,raw[i]*scale));
    const coverage=alphaCoverage(adjusted,width,height,alphaTest,repeat);
    const error=Math.abs(coverage-target);
    if((target===0 || coverage>0) && (error<best || error===best && Math.abs(scale-1)<Math.abs(bestScale-1))) {
      best=error;bestScale=scale;
    }
    return coverage;
  };
  evaluate(1);evaluate(high);
  for(let i=0;i<14;i++) {
    const middle=(low+high)/2;
    if(evaluate(middle)<target)low=middle;
    else high=middle;
  }
  for(let i=3;i<raw.length;i+=4)adjusted[i]=Math.round(Math.min(255,raw[i]*bestScale));
  return adjusted;
}

export function buildFoliageMipmaps(data,width,height,{alphaTest=0.3,srgb=true,repeat=true}={}) {
  if(!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width>2048 || height>2048
    || data.length!==width*height*4 || !Number.isFinite(alphaTest) || alphaTest<=0 || alphaTest>1)
    throw new Error("Invalid foliage texture dimensions or alpha threshold.");
  const coverage=alphaCoverage(data,width,height,alphaTest,repeat);
  const levels=[{data:new Uint8ClampedArray(data),width,height}];
  let pixels=new Float32Array(data.length);
  for(let i=0;i<data.length;i+=4) {
    for(let channel=0;channel<3;channel++)pixels[i+channel]=srgb ? linear[data[i+channel]] : data[i+channel]/255;
    pixels[i+3]=data[i+3]/255;
  }
  while(width>1 || height>1) {
    const nextWidth=Math.max(1,Math.floor(width/2)),nextHeight=Math.max(1,Math.floor(height/2));
    const next=new Float32Array(nextWidth*nextHeight*4),raw=new Uint8ClampedArray(next.length);
    for(let y=0;y<nextHeight;y++) for(let x=0;x<nextWidth;x++) {
      const startX=Math.floor(x*width/nextWidth),endX=Math.floor((x+1)*width/nextWidth);
      const startY=Math.floor(y*height/nextHeight),endY=Math.floor((y+1)*height/nextHeight);
      const index=(y*nextWidth+x)*4;
      let alpha=0;
      for(let sy=startY;sy<endY;sy++) for(let sx=startX;sx<endX;sx++) {
        const sample=(sy*width+sx)*4,weight=pixels[sample+3];
        alpha+=weight;
        for(let channel=0;channel<3;channel++)next[index+channel]+=pixels[sample+channel]*weight;
      }
      for(let channel=0;channel<3;channel++) {
        next[index+channel]=alpha ? next[index+channel]/alpha : 0;
        raw[index+channel]=srgb ? encode(next[index+channel]) : Math.round(next[index+channel]*255);
      }
      next[index+3]=alpha/((endX-startX)*(endY-startY));
      // Keep sub-byte alpha until the last level, without compounding coverage adjustments.
      raw[index+3]=alpha>0 ? Math.max(1,Math.round(next[index+3]*255)) : 0;
    }
    levels.push({data:preserveCoverage(raw,nextWidth,nextHeight,coverage,alphaTest,repeat),width:nextWidth,height:nextHeight});
    pixels=next;width=nextWidth;height=nextHeight;
  }
  return {levels,coverage,bytes:levels.reduce((total,level)=>total+level.data.byteLength,0)};
}
