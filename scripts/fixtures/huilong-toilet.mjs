// Actual OGF geometry read on 2026-10-18 beside 回龙巷. No mapped road width.
export const huilongToilet={type:"Feature",id:"node:429362967",properties:{amenity:"toilets",osmType:"node"},
  geometry:{type:"Point",coordinates:[152.9357801,14.638498]}};
export const huilongRoad={type:"Feature",id:"way:41513260",properties:{renderKind:"road",highway:"residential",name:"回龙巷",width:"",lanes:""},
  geometry:{type:"LineString",coordinates:[
    [152.9332208,14.6395014],[152.9334896,14.6393718],[152.9336138,14.6393158],
    [152.9339215,14.6391846],[152.934068,14.6391302],[152.9341085,14.639115],
    [152.9343101,14.6390374],[152.9346041,14.6389075],[152.934899,14.6387604],
    [152.935147,14.6386503],[152.9353111,14.6385774],[152.935595,14.6384916],
    [152.935907,14.6384334],[152.9362632,14.6383669],[152.9365965,14.6382965],[152.9367292,14.6382484]]}};
export const huilongBuildings=[
  {id:41974655,ring:[[152.9357578,14.6384957],[152.9357919,14.6385799],[152.9356965,14.6386162],[152.9356625,14.6385319],[152.9357578,14.6384957]]},
  {id:41974622,ring:[[152.9358975,14.6384623],[152.9359337,14.6385458],[152.935839,14.6385839],[152.9358031,14.6385005],[152.9358975,14.6384623]]},
].map(({id,ring})=>({type:"Feature",id:`way:${id}`,properties:{building:"residential"},geometry:{type:"Polygon",coordinates:[ring]}}));
export const huilongContext={coverage:[{west:152.9296875,east:152.940673828125,south:14.636738848907621,north:14.647368383896621}],
  obstacles:[huilongRoad,...huilongBuildings]};
