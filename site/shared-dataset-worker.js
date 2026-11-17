"use strict";
importScripts("./shared-dataset-core.js?v=9.0-shared-data-v1");
onmessage=({data})=>{
  try{const result=HuayuDatasetTools.normalize(data.content,data.format,data.options);postMessage({result:{...result,records:result.records.slice(0,20)}});}
  catch(error){postMessage({error:String(error.message||error)});}
};
