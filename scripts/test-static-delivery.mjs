import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../site/_worker.js';
const routes=JSON.parse(await readFile(new URL('../site/_routes.json',import.meta.url),'utf8'));
assert.equal(routes.version,1);assert.ok(routes.include.length<=100);assert.deepEqual(routes.exclude,[]);
const matches=(pattern,path)=>pattern.endsWith('*')?path.startsWith(pattern.slice(0,-1)):path===pattern;
const handled=path=>routes.include.some(p=>matches(p,path))&&!routes.exclude.some(p=>matches(p,path));
for(const path of ['/api/auth/login','/api/feature-info','/api/datasets','/api/agent/status','/api/buildings/15/1/2.json',
 '/api/traffic-region','/api/data-update/source','/api/future-new-feature','/terrain-preload.json.gz',
 '/terrain-preload-chunks/generation/hash.json.gz','/terrain-render-cache/generation/hash.json.gz'])assert.equal(handled(path),true,path);
for(const path of ['/','/index.html','/app.js','/styles.css','/maplibre-gl.js','/building-roofs.js','/updater-jwks.json',
 '/model-import/assets/real-model.glb','/transit-preload.json','/brand-catalog.json'])assert.equal(handled(path),false,path+' should use the static CDN');
const raw=new Uint8Array([31,139,8,0,1,2,3,4]);
for(const path of ['/terrain-preload.json.gz','/terrain-preload-chunks/gen/part.json.gz','/terrain-render-cache/gen/part.json.gz']){
 const response=await worker.fetch(new Request('https://local.test'+path),{ASSETS:{fetch:async()=>new Response(raw)}},{});
 assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),'gzip');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),raw,'terrain routing keeps the existing exact gzip bytes');
}
console.log('Static delivery passed: ordinary assets bypass Worker; all current/future APIs and exact gzip terrain handling remain routed.');
