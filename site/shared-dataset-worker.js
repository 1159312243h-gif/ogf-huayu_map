"use strict";
importScripts("./transport-timetable-core.js?v=1","./shared-dataset-core.js?v=9.0-timetables-v1");
onmessage=({data})=>{
  try{const result=HuayuDatasetTools.normalize(data.content,data.format,data.options);postMessage({result:{...result,...(result.timetable?{timetable:{schema:result.timetable.schema,mode:result.timetable.mode,tripCount:result.timetable.trips.length}}:{}),records:result.records.slice(0,20)}});}
  catch(error){postMessage({error:String(error.message||error)});}
};
