import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const SOURCE='https://token.actions.githubusercontent.com/.well-known/jwks';
export async function validateUpdaterKeys(value,now=Date.now()){
 if(value?.source!==SOURCE||!Number.isFinite(Date.parse(value.fetchedAt))||Date.parse(value.fetchedAt)>now+60000
  ||now-Date.parse(value.fetchedAt)>7*86400000||!Array.isArray(value.keys)||!value.keys.length||value.keys.length>16)throw Error('Invalid or expired updater verification keys');
 const ids=new Set();
 for(const key of value.keys){
  if(key.kty!=='RSA'||key.alg&&key.alg!=='RS256'||key.use&&key.use!=='sig'||typeof key.kid!=='string'||key.kid.length>200||ids.has(key.kid)||key.d||key.p||key.q)throw Error('Invalid updater verification key');
  await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);ids.add(key.kid);
 }
 return value;
}
async function main(){
 const file=new URL('../site/updater-jwks.json',import.meta.url);
 if(process.argv.includes('--check')){const value=await validateUpdaterKeys(JSON.parse(await readFile(file,'utf8')));console.log(JSON.stringify({status:'passed',source:value.source,fetchedAt:value.fetchedAt,keys:value.keys.length}));return;}
 const response=await fetch(SOURCE,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('GitHub verification key HTTP '+response.status);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('Verification key response too large');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const candidate=await validateUpdaterKeys({source:SOURCE,fetchedAt:new Date().toISOString(),keys:payload.keys});
 const pending=fileURLToPath(file)+'.pending';
 try{await writeFile(pending,JSON.stringify(candidate));await rename(pending,file);}finally{await unlink(pending).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 console.log(JSON.stringify({status:'refreshed',source:SOURCE,fetchedAt:candidate.fetchedAt,keys:candidate.keys.length}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
