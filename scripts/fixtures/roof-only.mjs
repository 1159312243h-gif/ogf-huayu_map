// Tags from the user's raised single-slope roof; synthetic rectangular footprint.
export const raisedSkillionRoof = {
  type: "way", id: 70001,
  tags: {building: "yes", height: "4.5", min_height: "4", "roof:colour": "#575757",
    "roof:direction": "270", "roof:height": "0.5", "roof:shape": "skillion"},
  geometry: [[0,0],[.0002,0],[.0002,.0001],[0,.0001],[0,0]].map(([lon,lat]) => ({lon,lat})),
};
