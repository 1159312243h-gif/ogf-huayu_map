const {setTimeout:pause}=require('node:timers/promises');
// Retry only syntactically incomplete/corrupt transport bodies, never semantic validation.
async function recoverSourceBody(read,{wait=pause}={}) {
  for(let attempt=0;;attempt++) {
    try{return await read();}
    catch(error){
      if(!(error instanceof SyntaxError)||attempt>=2)throw error;
      const delay=10000*(attempt+1);
      console.log('Incomplete source JSON: retry the same complete read in '+delay/1000+'s');
      await wait(delay);
    }
  }
}
module.exports={recoverSourceBody};
