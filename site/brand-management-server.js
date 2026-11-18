// Standalone Worker factory; account roles remain unchanged.
function createBrandManagementServer(deps) {
  const {core,builtins,json,readJson,requireUser,currentUser,publicUser,sameOrigin}=deps;
  const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
  const admin=(user,env)=>publicUser(user,env).role==="admin";
  function text(value,max,required=false) {
    if(typeof value!=="string"||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||required&&!value.trim())fail("brand_management_text_invalid");
    return value.trim();
  }
  function link(value) {
    const result=text(value||"",2048);
    if(result){let parsed;try{parsed=new URL(result);}catch{fail("brand_management_url_invalid");}
      if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password)fail("brand_management_url_invalid");}
    return result;
  }
  function identity(value) {
    const name=text(value,160,true);if(/[\r\n\t]/u.test(name))fail("brand_management_text_invalid");
    const matching=builtins.filter(e=>e.kind==="brand"&&[e.name,...e.aliases||[]].some(v=>core.normalize(v)===core.normalize(name)));
    if(matching.length>1)fail("brand_management_ambiguous");
    return matching[0]?{key:matching[0].key,name:matching[0].name}:{key:"brand:"+core.normalize(name),name};
  }
  const select="SELECT a.*,u.username,u.display_name,r.username AS reviewer_username FROM brand_manager_applications a JOIN users u ON u.id=a.user_id LEFT JOIN users r ON r.id=a.reviewed_by";
  const application=row=>row?{id:row.id,key:row.brand_key,name:row.brand_name,
    applicant:{id:row.user_id,username:row.username,displayName:row.display_name},
    statement:row.statement,sourceUrl:row.source_url,status:row.status,decisionSource:row.decision_source,
    reviewNote:row.review_note,reviewer:row.reviewer_username||null,createdAt:row.created_at,updatedAt:row.updated_at,revision:row.revision}:null;
  const missing=error=>/no such table/iu.test(String(error.message));
  async function permission(env,user,key) {
    if(!env.DB||!user)return {available:false,managed:false,banned:false};
    try{
      const [grant,ban]=await Promise.all([
        env.DB.prepare("SELECT user_id FROM brand_manager_grants WHERE brand_key=? AND user_id=?").bind(key,user.id).first(),
        env.DB.prepare("SELECT user_id FROM brand_manager_bans WHERE brand_key=? AND user_id=?").bind(key,user.id).first()
      ]);
      return {available:true,managed:Boolean(grant)&&!ban,banned:Boolean(ban)};
    }catch(error){if(missing(error))return {available:false,managed:false,banned:false};throw error;}
  }
  function event(env,id,token,actor,now) {
    return env.DB.prepare("INSERT INTO brand_management_events(id,application_id,status,decision_source,note,actor_id,created_at) SELECT ?,id,status,decision_source,review_note,?,? FROM brand_manager_applications WHERE id=? AND decision_token=?")
      .bind(crypto.randomUUID(),actor,now,id,token);
  }
  function grant(env,id,token,actor,now) {
    return env.DB.prepare("INSERT INTO brand_manager_grants(brand_key,brand_name,user_id,application_id,granted_by,granted_at) SELECT brand_key,brand_name,user_id,id,?,? FROM brand_manager_applications WHERE id=? AND decision_token=? AND status='approved' ON CONFLICT(brand_key,user_id) DO UPDATE SET application_id=excluded.application_id,granted_by=excluded.granted_by,granted_at=excluded.granted_at")
      .bind(actor,now,id,token);
  }
  function createProfile(env,id,token,actor,now) {
    return env.DB.prepare("INSERT INTO brand_profiles(brand_key,brand_name,edited_by,updated_at) SELECT brand_key,brand_name,?,? FROM brand_manager_applications WHERE id=? AND decision_token=? AND status='approved' ON CONFLICT(brand_key) DO NOTHING")
      .bind(actor,now,id,token);
  }
  async function apply(env,user,body) {
    core.fields(body,["name","statement","sourceUrl","revision"]);
    const brand=identity(body.name),statement=text(body.statement,2000,true),sourceUrl=link(body.sourceUrl),now=Date.now(),token=crypto.randomUUID();
    const ban=await env.DB.prepare("SELECT reason FROM brand_manager_bans WHERE brand_key=? AND user_id=?").bind(brand.key,user.id).first();
    if(ban)fail("brand_management_banned",403);
    const previous=await env.DB.prepare("SELECT * FROM brand_manager_applications WHERE brand_key=? AND user_id=?").bind(brand.key,user.id).first();
    if(previous&&["pending","approved"].includes(previous.status))fail("brand_management_already_applied",409);
    if(previous&&body.revision!==previous.revision)fail("brand_management_revision_conflict",409);
    const id=previous?.id||crypto.randomUUID();
    const result=await env.DB.batch([
      env.DB.prepare("INSERT INTO brand_manager_applications(id,brand_key,brand_name,user_id,statement,source_url,status,decision_source,decision_token,created_at,updated_at) SELECT ?,?,?,?,?,?,'pending','applicant',?,?,? WHERE NOT EXISTS(SELECT 1 FROM brand_manager_bans WHERE brand_key=? AND user_id=?) ON CONFLICT(brand_key,user_id) DO UPDATE SET statement=excluded.statement,source_url=excluded.source_url,status='pending',decision_source='applicant',review_note='',reviewed_by=NULL,decision_token=excluded.decision_token,updated_at=excluded.updated_at,revision=brand_manager_applications.revision+1 WHERE brand_manager_applications.revision=? AND brand_manager_applications.status IN ('rejected','withdrawn','revoked')")
        .bind(id,brand.key,brand.name,user.id,statement,sourceUrl,token,now,now,brand.key,user.id,previous?.revision||0),
      // All first-claim decisions execute inside the same serialized D1 transaction.
      env.DB.prepare("UPDATE brand_manager_applications SET status='approved',decision_source='auto',revision=revision+1 WHERE id=? AND decision_token=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM brand_manager_grants g WHERE g.brand_key=brand_manager_applications.brand_key) AND NOT EXISTS(SELECT 1 FROM brand_manager_applications other WHERE other.brand_key=brand_manager_applications.brand_key AND other.id<>brand_manager_applications.id AND other.status IN ('pending','approved'))")
        .bind(id,token),
      grant(env,id,token,null,now),createProfile(env,id,token,user.id,now),event(env,id,token,user.id,now)
    ]);
    if(!result[0].meta.changes)fail("brand_management_revision_conflict",409);
    return json({item:application(await env.DB.prepare(select+" WHERE a.id=?").bind(id).first())},201);
  }
  async function decide(env,user,id,body) {
    core.fields(body,["action","revision","note"]);
    if(!Number.isSafeInteger(body.revision)||body.revision<1)fail("invalid_revision");
    const row=await env.DB.prepare(select+" WHERE a.id=?").bind(id).first();
    if(!row)fail("brand_management_not_found",404);
    const isAdmin=admin(user,env),action=body.action;
    if(action==="withdraw"){if(row.user_id!==user.id)fail("brand_management_forbidden",403);}
    else if(!isAdmin)fail("administrator_required",403);
    const transitions={withdraw:["pending"],approve:["pending","rejected","revoked"],reject:["pending"],revoke:["approved"],ban:["pending","approved","rejected","withdrawn","revoked"],unban:["banned"]};
    if(!transitions[action]?.includes(row.status))fail("brand_management_transition_invalid",409);
    const status={withdraw:"withdrawn",approve:"approved",reject:"rejected",revoke:"revoked",ban:"banned",unban:"revoked"}[action];
    const note=text(body.note||"",1000,["ban","reject"].includes(action)),now=Date.now(),token=crypto.randomUUID();
    const statements=[
      env.DB.prepare("UPDATE brand_manager_applications SET status=?,decision_source=?,review_note=?,reviewed_by=?,decision_token=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND status=?")
        .bind(status,action==="withdraw"?"applicant":"admin",note,action==="withdraw"?null:user.id,token,now,id,body.revision,row.status),
      env.DB.prepare("DELETE FROM brand_manager_grants WHERE application_id=? AND EXISTS(SELECT 1 FROM brand_manager_applications WHERE id=? AND decision_token=? AND status<>'approved')").bind(id,id,token)
    ];
    if(action==="approve"){
      const blocked=await env.DB.prepare("SELECT user_id FROM brand_manager_bans WHERE brand_key=? AND user_id=?").bind(row.brand_key,row.user_id).first();
      if(blocked)fail("brand_management_banned",403);
      statements.push(grant(env,id,token,user.id,now),createProfile(env,id,token,user.id,now));
    }
    if(action==="ban")statements.push(env.DB.prepare("INSERT INTO brand_manager_bans(brand_key,user_id,reason,banned_by,created_at) SELECT brand_key,user_id,?,?,? FROM brand_manager_applications WHERE id=? AND decision_token=? ON CONFLICT(brand_key,user_id) DO UPDATE SET reason=excluded.reason,banned_by=excluded.banned_by,created_at=excluded.created_at").bind(note,user.id,now,id,token));
    if(action==="unban")statements.push(env.DB.prepare("DELETE FROM brand_manager_bans WHERE brand_key=? AND user_id=? AND EXISTS(SELECT 1 FROM brand_manager_applications WHERE id=? AND decision_token=?)").bind(row.brand_key,row.user_id,id,token));
    statements.push(event(env,id,token,user.id,now));
    const result=await env.DB.batch(statements);
    if(!result[0].meta.changes)fail("brand_management_revision_conflict",409);
    return json({item:application(await env.DB.prepare(select+" WHERE a.id=?").bind(id).first())});
  }
  async function readBrand(request,env,url) {
    const brand=identity(url.searchParams.get("name")),user=await currentUser(request,env);
    const [profile,managers,access,own]=await Promise.all([
      env.DB.prepare("SELECT p.*,u.username,u.display_name FROM brand_profiles p LEFT JOIN users u ON u.id=p.edited_by WHERE p.brand_key=?").bind(brand.key).first(),
      env.DB.prepare("SELECT u.id,u.username,u.display_name FROM brand_manager_grants g JOIN users u ON u.id=g.user_id WHERE g.brand_key=? AND u.disabled=0 ORDER BY g.granted_at,u.id").bind(brand.key).all(),
      permission(env,user,brand.key),
      user?env.DB.prepare(select+" WHERE a.brand_key=? AND a.user_id=?").bind(brand.key,user.id).first():null
    ]);
    return json({key:brand.key,name:profile?.brand_name||brand.name,
      profile:profile?{description:profile.description,website:profile.website,revision:profile.revision,updatedAt:profile.updated_at,editedBy:profile.username||null}:null,
      managers:managers.results.map(u=>({id:u.id,username:u.username,displayName:u.display_name})),
      canEdit:Boolean(profile&&user&&(admin(user,env)||access.managed)),banned:access.banned,application:application(own)});
  }
  async function saveProfile(env,user,body) {
    core.fields(body,["name","description","website","revision"]);
    const brand=identity(body.name),description=text(body.description,5000),website=link(body.website);
    if(!Number.isSafeInteger(body.revision)||body.revision<1)fail("invalid_revision");
    const access=await permission(env,user,brand.key),isAdmin=admin(user,env);
    if(!isAdmin&&!access.managed)fail(access.banned?"brand_management_banned":"brand_management_forbidden",403);
    const result=await env.DB.prepare("UPDATE brand_profiles SET description=?,website=?,edited_by=?,updated_at=?,revision=revision+1 WHERE brand_key=? AND revision=? AND (?=1 OR (EXISTS(SELECT 1 FROM brand_manager_grants WHERE brand_key=brand_profiles.brand_key AND user_id=?) AND NOT EXISTS(SELECT 1 FROM brand_manager_bans WHERE brand_key=brand_profiles.brand_key AND user_id=?)))")
      .bind(description,website,user.id,Date.now(),brand.key,body.revision,isAdmin?1:0,user.id,user.id).run();
    if(!result.meta.changes)fail("brand_management_revision_conflict",409);
    return json({ok:true});
  }
  async function list(env,user,url) {
    const scope=url.searchParams.get("scope")||"mine",status=url.searchParams.get("status")||"all",offset=Number(url.searchParams.get("offset")||0);
    if(!["mine","admin"].includes(scope)||!["all","pending","approved","rejected","revoked","banned","withdrawn"].includes(status)||!Number.isSafeInteger(offset)||offset<0)fail("brand_management_query_invalid");
    if(scope==="admin"&&!admin(user,env))fail("administrator_required",403);
    const clauses=[],values=[];if(scope==="mine"){clauses.push("a.user_id=?");values.push(user.id);}if(status!=="all"){clauses.push("a.status=?");values.push(status);}
    const where=clauses.length?" WHERE "+clauses.join(" AND "):"";
    const [rows,count]=await Promise.all([
      env.DB.prepare(select+where+" ORDER BY a.updated_at DESC,a.id LIMIT 21 OFFSET ?").bind(...values,offset).all(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM brand_manager_applications a"+where).bind(...values).first()
    ]);
    return json({items:rows.results.slice(0,20).map(application),offset,total:count.total,nextOffset:rows.results.length>20?offset+20:null});
  }
  return {permission,async handle(request,env) {
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith("/api/brand-management/"))return null;
    try{
      if(!sameOrigin(request))fail("cross_origin_request_blocked",403);
      if(!env.DB)fail("brand_management_unavailable",503);
      if(path==="/api/brand-management/brand"&&request.method==="GET")return await readBrand(request,env,url);
      const user=await requireUser(request,env);
      if(path==="/api/brand-management/session"&&request.method==="GET"){
        const [grants,bans]=await Promise.all([
          env.DB.prepare("SELECT brand_key,brand_name FROM brand_manager_grants WHERE user_id=?").bind(user.id).all(),
          env.DB.prepare("SELECT brand_key FROM brand_manager_bans WHERE user_id=?").bind(user.id).all()
        ]);
        return json({userId:user.id,grants:grants.results.map(r=>({key:r.brand_key,name:r.brand_name})),bans:bans.results.map(r=>r.brand_key)});
      }
      if(path==="/api/brand-management/applications"){
        if(request.method==="GET")return await list(env,user,url);
        if(request.method==="POST")return await apply(env,user,await readJson(request,16384));
      }
      if(path==="/api/brand-management/brand"&&request.method==="PATCH")return await saveProfile(env,user,await readJson(request,32768));
      const match=path.match(/^\/api\/brand-management\/applications\/([a-zA-Z0-9_-]{1,80})(\/events)?$/u);
      if(match&&match[2]&&request.method==="GET"){
        const owner=await env.DB.prepare("SELECT user_id FROM brand_manager_applications WHERE id=?").bind(match[1]).first();
        if(!owner)fail("brand_management_not_found",404);
        if(owner.user_id!==user.id&&!admin(user,env))fail("brand_management_forbidden",403);
        const rows=await env.DB.prepare("SELECT e.status,e.decision_source,e.note,e.created_at,u.username FROM brand_management_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.application_id=? ORDER BY e.created_at,e.id").bind(match[1]).all();
        return json({items:rows.results.map(r=>({status:r.status,decisionSource:r.decision_source,note:r.note,createdAt:r.created_at,actor:r.username||null}))});
      }
      if(match&&!match[2]&&request.method==="PATCH")return await decide(env,user,match[1],await readJson(request,8192));
      fail("not_found",404);
    }catch(error){return json({error:error.status?error.message:"brand_management_unavailable"},error.status||503);}
  }};
}
