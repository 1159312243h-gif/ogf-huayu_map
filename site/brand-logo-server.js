// Embedded alongside the shared core in the standalone Pages Worker.
function createBrandLogoServer(deps) {
  const {core,builtins,json,readJson,requireUser,publicUser,sameOrigin,brandManagement}=deps;
  const cache=new Map(),pending=new Map(),retryAfter=new Map();
  let generation=0;
  function invalidatePlaces(){generation++;cache.clear();retryAfter.clear();}
  const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
  const select="SELECT l.id,l.kind,l.name,l.name_key,l.aliases_json,l.source,l.source_url,l.user_id,l.image_hash,l.created_at,l.updated_at,l.revision,u.username,u.display_name FROM brand_logos l JOIN users u ON u.id=l.user_id";
  const item=r=>({id:r.id,key:r.name_key,kind:r.kind,name:r.name,aliases:JSON.parse(r.aliases_json),source:r.source,sourceUrl:r.source_url,
    author:{id:r.user_id,username:r.username,displayName:r.display_name},revision:r.revision,updatedAt:r.updated_at,
    imageUrl:"/api/brand-logos/"+r.id+"/image?v="+r.image_hash,builtin:false});
  async function catalog(env){
    let rows=[],available=Boolean(env.DB);
    if(available)try{const data=await env.DB.prepare(select+" ORDER BY l.updated_at DESC LIMIT 1001").all();if(data.results.length>1000)fail("logo_catalog_too_large",503);rows=data.results.map(r=>({...item(r),categories:builtins.find(e=>e.key===r.name_key)?.categories||[]}));}catch(e){if(e.message==="logo_catalog_too_large")throw e;available=false;}
    const merged=new Map(builtins.map(e=>[e.key,e]));rows.forEach(e=>merged.set(e.key,e));
    return {items:[...merged.values()],sharedAvailable:available};
  }
  const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  const crc=bytes=>{let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;};
  async function png(data){
    if(typeof data!=="string"||data.length>180000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(data))fail("logo_png_invalid");
    let bytes;try{bytes=Uint8Array.from(atob(data.slice(22)),c=>c.charCodeAt(0));}catch{return fail("logo_png_invalid");}
    if(bytes.length>128*1024||bytes.length<45||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))fail("logo_png_invalid");
    const view=new DataView(bytes.buffer),keep=[bytes.slice(0,8)],compressed=[];let at=8,width,height,channels,ended=false;
    while(at<bytes.length){
      if(at+12>bytes.length)fail("logo_png_invalid");const n=view.getUint32(at),end=at+12+n;if(end>bytes.length)fail("logo_png_invalid");
      const kind=String.fromCharCode(...bytes.slice(at+4,at+8));if(crc(bytes.subarray(at+4,at+8+n))!==view.getUint32(at+8+n))fail("logo_png_invalid");
      if(at===8&&kind!=="IHDR")fail("logo_png_invalid");
      if(kind==="IHDR"){
        if(width||n!==13)fail("logo_png_invalid");width=view.getUint32(at+8);height=view.getUint32(at+12);channels=bytes[at+17]===6?4:bytes[at+17]===2?3:0;
        if(width<1||height<1||width>256||height>256||bytes[at+16]!==8||!channels||bytes[at+18]||bytes[at+19]||bytes[at+20])fail("logo_png_invalid");
      }else if(kind==="IDAT")compressed.push(bytes.slice(at+8,at+8+n));
      else if(kind==="IEND"){if(n||end!==bytes.length)fail("logo_png_invalid");ended=true;}
      else if(!/^[a-z]/u.test(kind))fail("logo_png_invalid");
      if(["IHDR","IDAT","IEND"].includes(kind))keep.push(bytes.slice(at,end));at=end;
    }
    if(!ended||!compressed.length)fail("logo_png_invalid");
    let decoded=0;try{
      const reader=new Blob(compressed).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
      while(true){const {value,done}=await reader.read();if(done)break;decoded+=value.length;if(decoded>(width*channels+1)*height){await reader.cancel();fail("logo_png_invalid");}}
    }catch{return fail("logo_png_invalid");}
    if(decoded!==(width*channels+1)*height)fail("logo_png_invalid");
    const blob=new Uint8Array(await new Blob(keep).arrayBuffer()),digest=await crypto.subtle.digest("SHA-256",blob);
    return {bytes:blob,hash:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,"0")).join("")};
  }
  function pause(ms,signal){
    return new Promise((resolve,reject)=>{
      signal.throwIfAborted();
      const abort=()=>{clearTimeout(timer);reject(signal.reason);};
      const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
      signal.addEventListener("abort",abort,{once:true});
    });
  }
  async function sourcePlaces(query,entries,signal){
    const upstream="https://overpass.opengeofiction.net/api/interpreter";
    for(let attempt=0;attempt<3;attempt++){
      signal.throwIfAborted();
      const method=attempt>0&&encodeURIComponent(query).length<14000?"GET":"POST";
      try{
        const response=await fetch(upstream+(method==="GET"?"?data="+encodeURIComponent(query):""),{method,
          headers:{Accept:"application/json",...(method==="POST"?{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"}:{})},
          ...(method==="POST"?{body:"data="+encodeURIComponent(query)}:{}),
          signal:AbortSignal.any([signal,AbortSignal.timeout(27000)]),credentials:"omit",redirect:"error"});
        if(!response.ok){
          await response.body?.cancel();
          throw Object.assign(Error("logo_places_unavailable"),{status:502,retryable:[408,425,429,500,502,503,504].includes(response.status)});
        }
        const reader=response.body.getReader(),parts=[];let bytes=0;
        try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024)fail("logo_places_too_large",413);parts.push(value);}}
        finally{await reader.cancel().catch(()=>{});}
        let data;try{data=JSON.parse(await new Blob(parts).text());}catch{return fail("logo_places_incomplete",502);}
        const count=data.elements?.filter(e=>e.type==="count"),elements=data.elements?.filter(e=>e.type!=="count"),total=Number(count?.[0]?.tags?.total);
        if(data.remark||count?.length!==1||!Number.isSafeInteger(total)||total<0||total!==elements.length
          ||elements.some(e=>!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)||e.id<=0||!e.tags)
          ||new Set(elements.map(e=>e.type+"/"+e.id)).size!==elements.length)fail("logo_places_incomplete",502);
        if(total>3000)fail("logo_places_too_large",413);
        return {items:core.markers(elements,entries),fetchedAt:Date.now(),dbTimestamp:data.osm3s?.timestamp_osm_base||null,stale:false};
      }catch(e){
        signal.throwIfAborted();
        if(attempt===2||e.status&&!e.retryable)throw e;
        await pause([800,2000][attempt],signal);
      }
    }
  }
  async function joinSource(task,signal){
    signal.throwIfAborted();task.users++;
    let abort;
    try{return await Promise.race([task.promise,new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});
    })]);}
    finally{signal.removeEventListener("abort",abort);if(--task.users===0&&!task.done)task.controller.abort();}
  }
  async function places(request,env,url){
    const entries=(await catalog(env)).items,bounds=(url.searchParams.get("bounds")||"").split(",").map(Number);
    const query=core.query(entries,bounds),key=query,previous=cache.get(key),now=Date.now(),force=url.searchParams.get("refresh")==="1";
    request.signal.throwIfAborted();
    if(!force&&previous&&now-previous.fetchedAt<120000)return json(previous);
    const fallback=()=>previous&&now-previous.fetchedAt<=3*3600000
      ?json({...previous,stale:true,retryAfterMs:30000,error:"logo_places_unavailable"})
      :json({error:"logo_places_unavailable",retryAfterMs:30000},503);
    if(!force&&(retryAfter.get(key)||0)>now)return fallback();
    let task=pending.get(key);
    if(task?.controller.signal.aborted){pending.delete(key);task=null;}
    if(!task){
      if(pending.size>=2)return json({error:"logo_places_busy",retryAfterMs:3000},503);
      task={controller:new AbortController(),users:0,done:false};const currentGeneration=generation;
      task.promise=sourcePlaces(query,entries,AbortSignal.any([task.controller.signal,AbortSignal.timeout(85000)]))
        .then(result=>{
          if(currentGeneration===generation&&!task.controller.signal.aborted){
            cache.delete(key);cache.set(key,result);while(cache.size>8)cache.delete(cache.keys().next().value);retryAfter.delete(key);
          }
          return result;
        }).finally(()=>{task.done=true;if(pending.get(key)===task)pending.delete(key);});
      task.promise.catch(()=>{});pending.set(key,task);
    }
    try{return json(await joinSource(task,request.signal));}
    catch(e){
      if(request.signal.aborted)return json({error:"logo_places_cancelled"},499);
      if(!e.status||e.retryable){
        retryAfter.set(key,Date.now()+30000);while(retryAfter.size>8)retryAfter.delete(retryAfter.keys().next().value);
        return fallback();
      }
      throw e;
    }
  }
  return {png,catalog,async handle(request,env){
    const url=new URL(request.url),path=url.pathname;
    if(path!=="/api/brand-logo-places"&&!path.startsWith("/api/brand-logos"))return null;
    try{
      if(!sameOrigin(request))fail("cross_origin_request_blocked",403);
      if(path==="/api/brand-logo-places"){if(request.method!=="GET")fail("method_not_allowed",405);return await places(request,env,url);}
      if(path==="/api/brand-logos"&&request.method==="GET")return json(await catalog(env));
      const image=path.match(/^\/api\/brand-logos\/([a-zA-Z0-9_-]{1,80})\/image$/u);
      if(image&&request.method==="GET"){
        if(!env.DB)fail("logo_not_found",404);
        const row=await env.DB.prepare("SELECT image_data,image_hash FROM brand_logos WHERE id=?").bind(image[1]).first();
        if(!row||url.searchParams.get("v")!==row.image_hash)fail("logo_not_found",404);
        return new Response(row.image_data,{headers:{"Content-Type":"image/png","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'","Cache-Control":"public, max-age=31536000, immutable"}});
      }
      if(!env.DB)fail("personal_data_service_not_configured",503);
      const user=await requireUser(request,env),body=await readJson(request,196608),now=Date.now();
      const id=path.match(/^\/api\/brand-logos\/([a-zA-Z0-9_-]{1,80})$/u)?.[1];
      if(path==="/api/brand-logos"&&request.method==="POST"){
        core.fields(body,["kind","name","aliases","source","sourceUrl","rightsConfirmed","image"]);
        const m=core.metadata(body),image=await png(body.image),id=crypto.randomUUID();
        const access=m.kind==="brand"&&brandManagement?await brandManagement.permission(env,user,m.key):null,admin=publicUser(user,env).role==="admin";
        if(access?.banned&&!admin)fail("logo_forbidden",403);
        const duplicate=await env.DB.prepare("SELECT id FROM brand_logos WHERE name_key=?").bind(m.key).first();
        if(duplicate)fail("logo_already_exists",409);
        try{const guarded=m.kind==="brand"&&access?.available;
          const result=await env.DB.prepare("INSERT INTO brand_logos(id,kind,name,name_key,aliases_json,source,source_url,user_id,edited_by,image_data,image_hash,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?"+(guarded?" WHERE (?=1 OR NOT EXISTS(SELECT 1 FROM brand_manager_bans WHERE brand_key=? AND user_id=?))":""))
            .bind(id,m.kind,m.name,m.key,JSON.stringify(m.aliases),m.source,m.sourceUrl,user.id,user.id,image.bytes.buffer,image.hash,now,now,...(guarded?[admin?1:0,m.key,user.id]:[])).run();
          if(!result.meta.changes)fail("logo_forbidden",403);
        }
        catch(e){if(String(e.message).includes("UNIQUE"))fail("logo_already_exists",409);throw e;}
        invalidatePlaces();return json({item:item(await env.DB.prepare(select+" WHERE l.id=?").bind(id).first())},201);
      }
      if(!id||!["PATCH","DELETE"].includes(request.method))fail("not_found",404);
      core.fields(body,request.method==="DELETE"?["revision"]:["revision","aliases","source","sourceUrl","rightsConfirmed","image"]);
      const row=await env.DB.prepare(select+" WHERE l.id=?").bind(id).first();if(!row)fail("logo_not_found",404);
      const admin=publicUser(user,env).role==="admin",access=row.kind==="brand"&&brandManagement?await brandManagement.permission(env,user,row.name_key):null;
      if(!admin&&(access?.banned||row.user_id!==user.id&&!access?.managed))fail("logo_forbidden",403);
      // Recheck brand grants and bans inside the write, so concurrent revocation cannot authorize a late update.
      const guarded=row.kind==="brand"&&access?.available;
      const guard=guarded?"(?=1 OR (NOT EXISTS(SELECT 1 FROM brand_manager_bans WHERE brand_key=brand_logos.name_key AND user_id=?) AND (user_id=? OR EXISTS(SELECT 1 FROM brand_manager_grants WHERE brand_key=brand_logos.name_key AND user_id=?))))":"(user_id=? OR ?=1)";
      const guardValues=guarded?[admin?1:0,user.id,user.id,user.id]:[user.id,admin?1:0];
      if(!Number.isSafeInteger(body.revision)||body.revision<1)fail("invalid_revision");
      let result;
      if(request.method==="DELETE")result=await env.DB.prepare("DELETE FROM brand_logos WHERE id=? AND revision=? AND "+guard).bind(id,body.revision,...guardValues).run();
      else {
        const m=core.metadata({...body,kind:row.kind,name:row.name}),image=body.image?await png(body.image):null;
        result=await env.DB.prepare("UPDATE brand_logos SET aliases_json=?,source=?,source_url=?,image_data=COALESCE(?,image_data),image_hash=COALESCE(?,image_hash),updated_at=?,edited_by=?,revision=revision+1 WHERE id=? AND revision=? AND "+guard)
          .bind(JSON.stringify(m.aliases),m.source,m.sourceUrl,image?.bytes.buffer||null,image?.hash||null,now,user.id,id,body.revision,...guardValues).run();
      }
      if(!result.meta.changes)fail("logo_revision_conflict",409);
      invalidatePlaces();return json(request.method==="DELETE"?{ok:true}:{item:item(await env.DB.prepare(select+" WHERE l.id=?").bind(id).first())});
    }catch(e){return json({error:e.status?e.message:"logo_service_unavailable",...(e.retryable===false?{retryable:false}:{})},e.status||503);}
  }};
}
