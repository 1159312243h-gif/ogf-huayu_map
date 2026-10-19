// The 19 explicit values in iD's roof:shape field, including its native flat fallback.
// https://github.com/openstreetmap/id-tagging-schema/blob/main/data/fields/roof/shape.json
export const roofShapeCases = [
  ["flat","水平式"],["gabled","山墙式"],["gabled_height_moved","山墙式（高差）"],["skillion","斜棚式"],
  ["hipped","庑殿式"],["side_hipped","单侧庑殿式"],["half-hipped","半庑殿半山墙式"],
  ["side_half-hipped","单侧半庑殿式"],["mansard","孟莎式"],["gambrel","复式"],
  ["hipped-and-gabled","歇山式"],["pyramidal","攒尖式"],["crosspitched","十字脊式"],
  ["sawtooth","锯齿式"],["butterfly","蝴蝶式"],["cone","尖顶式"],["round","弯隆式"],
  ["onion","洋葱式"],["dome","圆穹式"],
];
export const roofShapeElements = roofShapeCases.map(([shape,name],index)=>{
  const radial=["cone","dome","onion"].includes(shape),x=(index%5)*.0006,y=-Math.floor(index/5)*.00055;
  const points=radial?Array.from({length:32},(_,i)=>[x+Math.cos(i/32*2*Math.PI)*.00014,y+Math.sin(i/32*2*Math.PI)*.0001])
    :[[x-.0002,y-.0001],[x+.0002,y-.0001],[x+.0002,y+.0001],[x-.0002,y+.0001]];
  return {type:"way",id:10000+index,tags:{building:"yes",height:"15","roof:height":"6","roof:shape":shape,
    "building:colour":"#f5f5f0","roof:colour":"#687782",name},geometry:[...points,points[0]].map(([lon,lat])=>({lon,lat}))};
});
