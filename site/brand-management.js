(function start() {
  "use strict";
  if(!window.HuayuAtlas){addEventListener("huayu:map-ready",start,{once:true});return;}
  if(window.HuayuBrandManagement)return;
  const atlas=HuayuAtlas,core=HuayuBrandLogoCore,$=id=>document.getElementById("brand-management-"+id),section=$("section");
  const user=()=>window.HuayuPersonalData?.getCurrentUser(),text=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;};
  const button=(label,action)=>{const n=text("button",label,"text-button");n.type="button";n.onclick=action;return n;};
  const labels={pending:"待管理员审核",approved:"已获管理权限",rejected:"未通过",withdrawn:"已撤回",revoked:"权限已撤销",banned:"已禁止管理此品牌"};
  const sources={auto:"首次申请自动通过",admin:"管理员处理",applicant:"用户提交"};
  const errors={authentication_required:"请先登录地图账号。",administrator_required:"只有站点管理员可以审核申请。",brand_management_unavailable:"品牌管理服务尚未配置或暂不可用，现有地图继续使用。",brand_management_banned:"你已被禁止管理此品牌，请联系站点管理员。",brand_management_forbidden:"只能管理自己获批的品牌。",brand_management_revision_conflict:"记录或权限已变化，请刷新后重试。",brand_management_already_applied:"你已申请或正在管理此品牌，请刷新查看。",brand_management_transition_invalid:"申请状态已变化，请刷新后重试。",brand_management_text_invalid:"请检查品牌名称、说明及文字长度。",brand_management_url_invalid:"链接必须是有效的 HTTP 或 HTTPS 地址。",brand_management_not_found:"申请记录已不存在。"};
  let active=false,epoch=0,brandEpoch=0,listEpoch=0,rightsEpoch=0,busy=false,current=null,rights=new Set(),bans=new Set(),rightsUser=null,offset=0,nextOffset=null,interval=null;
  const controllers=new Set();
  const date=value=>new Date(value).toLocaleString("zh-CN");
  const status=value=>{$("status").textContent=value;};
  async function api(path,options={}) {
    const controller=new AbortController();controllers.add(controller);
    try{
      const response=await fetch("/api/brand-management/"+path,{cache:"no-store",...options,signal:controller.signal,headers:{"Content-Type":"application/json"}});
      const data=await response.json();if(!response.ok)throw Error(errors[data.error]||"品牌管理操作失败，请刷新后重试。");
      return data;
    }finally{controllers.delete(controller);}
  }
  function cancelReads(){epoch++;brandEpoch++;listEpoch++;rightsEpoch++;for(const c of controllers)c.abort();controllers.clear();}
  function changed(){dispatchEvent(new CustomEvent("huayu:brand-management-changed"));}
  function accountUI() {
    for(const id of ["name","statement","source-url","profile-description","profile-website"])$(id).disabled=busy;
    const logged=Boolean(user());$("login").hidden=logged;$("application-form").hidden=!logged;$("records").hidden=!logged;
    $("admin-option").hidden=user()?.role!=="admin";
    if(user()?.role!=="admin"&&$("scope").value==="admin")$("scope").value="mine";
    const entry={kind:"brand",key:current?.key};
    $("apply").disabled=busy||!logged||!current||current.banned||["approved","pending"].includes(current.application?.status);
    $("profile-form").hidden=!current?.canEdit||!logged;
    $("save").disabled=busy;$("apply").textContent=current?.application&&["rejected","withdrawn","revoked"].includes(current.application.status)?"重新申请":"提交管理申请";
    $("logo").disabled=busy||!current?.canEdit||isBanned(entry);
  }
  function renderPublic(data) {
    const nodes=[];
    nodes.push(text("strong",data.name));
    nodes.push(text("p",data.profile?.description||"尚未填写品牌简介。","view-status"));
    if(data.profile?.website){const a=text("a","品牌官网");a.href=data.profile.website;a.target="_blank";a.rel="noopener noreferrer";nodes.push(a);}
    nodes.push(text("p",data.managers.length?"品牌管理者："+data.managers.map(p=>(p.displayName||p.username)+"（@"+p.username+"）").join("、"):"暂未登记品牌管理者。","view-status"));
    $("public").replaceChildren(...nodes);
    const inline=document.getElementById("brand-profile-public");
    if(inline&&core.normalize(inline.dataset.brandName||"")===core.normalize(data.name)){inline.replaceChildren(...nodes.map(n=>n.cloneNode(true)));inline.hidden=false;}
  }
  async function loadBrand(name,{open=false,ctx=null}={}) {
    const value=String(name||"").trim();if(!value)return;
    const same=current&&core.normalize(current.name)===core.normalize(value);
    if(!same){current=null;$("profile-form").hidden=true;$("public").textContent="正在读取品牌资料…";$("profile-description").value="";$("profile-website").value="";}
    $("name").value=value;if(open){section.open=true;section.scrollIntoView({block:"start"});}
    const token=++brandEpoch,account=user()?.id;
    accountUI();
    try{
      const data=await api("brand?name="+encodeURIComponent(value));
      if(token!==brandEpoch||account!==user()?.id||!active||ctx&&(ctx.signal?.aborted||ctx.isCurrent&&!ctx.isCurrent()))return;
      const dirty=same&&($("profile-description").value!==(current?.profile?.description||"")||$("profile-website").value!==(current?.profile?.website||""));
      current=data;renderPublic(data);
      if(!dirty){$("profile-description").value=data.profile?.description||"";$("profile-website").value=data.profile?.website||"";}
      $("current").textContent=data.application?(labels[data.application.status]+" · "+sources[data.application.decisionSource]+(data.application.reviewNote?" · "+data.application.reviewNote:"")):"首次申请默认通过；已有其他申请或管理者时交由管理员审核。";
      if(data.banned)$("current").textContent="已禁止你管理此品牌；管理员解除禁用后才可重新申请。";
      accountUI();return data;
    }catch(error){if(token===brandEpoch&&account===user()?.id&&!ctx?.signal?.aborted){status(error.message);accountUI();}}
  }
  async function refreshRights() {
    const token=++rightsEpoch,account=user()?.id;
    if(!account){rights.clear();bans.clear();rightsUser=null;changed();return;}
    try{
      const data=await api("session");
      if(token!==rightsEpoch||account!==user()?.id||data.userId!==account||!active)return;
      rights=new Set(data.grants.map(g=>g.key));bans=new Set(data.bans);rightsUser=account;changed();
    }catch(error){if(token===rightsEpoch&&account===user()?.id){rights.clear();bans.clear();rightsUser=null;changed();if(section.open)status(error.message);}}
  }
  function canManage(entry){return user()?.id===rightsUser&&entry?.kind==="brand"&&rights.has(entry.key)&&!bans.has(entry.key);}
  function isBanned(entry){return user()?.role!=="admin"&&user()?.id===rightsUser&&entry?.kind==="brand"&&bans.has(entry.key);}
  async function refreshAll() {
    await Promise.all([refreshRights(),loadApplications()]);
    if(current)await loadBrand(current.name);
  }
  async function apply(event) {
    event.preventDefault();if(busy||!user()||!current)return;
    const token=epoch,account=user().id,brand=current;busy=true;accountUI();
    try{
      const data=await api("applications",{method:"POST",body:JSON.stringify({name:brand.name,statement:$("statement").value,sourceUrl:$("source-url").value,...(brand.application?{revision:brand.application.revision}:{})})});
      if(token!==epoch||account!==user()?.id)return;
      $("statement").value="";$("source-url").value="";
      status(data.item.decisionSource==="auto"?"首次申请已自动通过，可以维护此品牌资料与 logo。":"同品牌已有其他申请或管理者，已提交管理员审核。");
      await refreshAll();
    }catch(error){if(token===epoch&&account===user()?.id)status(error.message);}
    finally{if(token===epoch){busy=false;accountUI();}}
  }
  async function save(event) {
    event.preventDefault();if(busy||!user()||!current?.profile)return;
    const token=epoch,account=user().id,brand=current;busy=true;accountUI();
    try{
      await api("brand",{method:"PATCH",body:JSON.stringify({name:brand.name,revision:brand.profile.revision,description:$("profile-description").value,website:$("profile-website").value})});
      if(token!==epoch||account!==user()?.id)return;
      // The accepted values become the clean baseline; a later user edit stays a draft.
      const baseline={description:$("profile-description").value.trim(),website:$("profile-website").value.trim()};
      current={...current,profile:{...current.profile,...baseline}};status("品牌资料已公开保存。");await loadBrand(brand.name);
    }catch(error){if(token===epoch&&account===user()?.id)status(error.message);}
    finally{if(token===epoch){busy=false;accountUI();}}
  }
  async function decide(item,action,note) {
    if(busy)return;
    if(["ban","reject"].includes(action)&&!note.trim()){status("请填写处理原因。");return;}
    const token=epoch,account=user()?.id;busy=true;accountUI();
    try{
      await api("applications/"+item.id,{method:"PATCH",body:JSON.stringify({action,revision:item.revision,note})});
      if(token!==epoch||account!==user()?.id)return;
      status(action==="ban"?"已禁止该用户管理此品牌，权限已撤销。":action==="unban"?"已解除禁止；用户需重新申请管理权限。":"申请记录已更新。");await refreshAll();
    }catch(error){if(token===epoch&&account===user()?.id)status(error.message);}
    finally{if(token===epoch){busy=false;accountUI();}}
  }
  function card(item,isAdmin) {
    const node=text("article","","brand-card brand-management-card");
    node.dataset.exportPrivate="true";
    node.append(text("strong",item.name),text("small",(item.applicant.displayName||item.applicant.username)+" · @"+item.applicant.username),
      text("p",labels[item.status]+" · "+sources[item.decisionSource],"view-status"),
      text("small","申请："+date(item.createdAt)+"；更新："+date(item.updatedAt)),text("p",item.statement));
    if(item.sourceUrl){const link=text("a","申请依据");link.href=item.sourceUrl;link.target="_blank";link.rel="noopener noreferrer";node.append(link);}
    if(item.reviewNote)node.append(text("p","处理说明："+item.reviewNote));
    const actions=text("div","","brand-toolbar");
    actions.append(button("查看品牌",()=>loadBrand(item.name,{open:true})));
    if(isAdmin){
      const note=document.createElement("textarea");note.rows=2;note.maxLength=1000;note.placeholder="处理原因（驳回或禁止时必填）";note.setAttribute("aria-label","处理 "+item.name+" 的 "+item.applicant.username+" 申请原因");node.append(note);
      const options=[];
      if(["pending","rejected","revoked"].includes(item.status))options.push(["approve","批准管理"]);
      if(item.status==="pending")options.push(["reject","驳回"]);
      if(item.status==="approved")options.push(["revoke","撤销权限"]);
      if(item.status==="banned")options.push(["unban","解除禁止"]);
      else options.push(["ban","禁止管理此品牌"]);
      for(const [action,label] of options)actions.append(button(label,()=>decide(item,action,note.value)));
    }else if(item.status==="pending")actions.append(button("撤回申请",()=>decide(item,"withdraw","")));
    const history=text("div");history.hidden=true;
    actions.append(button("处理记录",async()=>{
      if(!history.hidden){history.hidden=true;return;}
      const token=epoch,account=user()?.id;
      try{const data=await api("applications/"+item.id+"/events");if(token!==epoch||account!==user()?.id)return;
        history.replaceChildren(...data.items.map(e=>text("p",date(e.createdAt)+" · "+labels[e.status]+" · "+sources[e.decisionSource]+(e.actor?" · @"+e.actor:"")+(e.note?" · "+e.note:""),"view-status")));history.hidden=false;
      }catch(error){if(token===epoch)status(error.message);}
    }));
    node.append(actions,history);return node;
  }
  async function loadApplications() {
    if(!user()||!active)return;
    const token=++listEpoch,account=user().id,scope=$("scope").value;
    try{
      const data=await api("applications?scope="+scope+"&status="+$("filter").value+"&offset="+offset);
      if(token!==listEpoch||account!==user()?.id||!active)return;
      nextOffset=data.nextOffset;$("list").replaceChildren(...data.items.map(item=>card(item,scope==="admin")));
      $("count").textContent="共 "+data.total+" 条记录，本页 "+data.items.length+" 条"+(scope==="admin"?"；包括自动通过的申请":"");
      $("previous").disabled=offset===0;$("next").disabled=nextOffset===null;
    }catch(error){if(token===listEpoch&&account===user()?.id)status(error.message);}
  }
  function setActive(value) {
    const next=Boolean(value)&&!document.hidden;if(next===active)return;active=next;clearInterval(interval);interval=null;
    if(!active){cancelReads();busy=false;return;}
    accountUI();refreshRights();
    if(section.open)loadApplications();
    if(current)loadBrand(current.name);
    interval=setInterval(()=>{if(active&&section.open){refreshRights();loadApplications();}},120000);
  }
  $("select").onsubmit=event=>{event.preventDefault();loadBrand($("name").value);};
  $("name").oninput=()=>{brandEpoch++;current=null;$("profile-form").hidden=true;$("public").replaceChildren();$("current").textContent="请点击“查看品牌资料”确认名称。";accountUI();};
  $("application-form").onsubmit=apply;$("profile-form").onsubmit=save;
  $("logo").onclick=()=>{if(current?.canEdit)window.HuayuBrandLogos?.prepareForBrand(current.name,"brand");};
  $("refresh").onclick=()=>refreshAll();
  $("scope").onchange=$("filter").onchange=()=>{offset=0;loadApplications();};
  $("previous").onclick=()=>{offset=Math.max(0,offset-20);loadApplications();};
  $("next").onclick=()=>{if(nextOffset!==null){offset=nextOffset;loadApplications();}};
  section.addEventListener("toggle",()=>{if(section.open&&active){refreshRights();loadApplications();}});
  addEventListener("huayu:account-changed",()=>{
    cancelReads();busy=false;rights.clear();bans.clear();rightsUser=null;offset=0;
    $("application-form").reset();$("profile-form").reset();$("list").replaceChildren();$("count").textContent="";status("");
    if(current){current={...current,canEdit:false,banned:false,application:null};}
    accountUI();changed();if(active){refreshRights();if(section.open)loadApplications();if(current)loadBrand(current.name);}
  });
  document.addEventListener("visibilitychange",()=>setActive(atlas.getCurrentView()==="brands"&&!document.getElementById("tool-panel").classList.contains("is-minimized")));
  addEventListener("pagehide",()=>{setActive(false);rights.clear();bans.clear();rightsUser=null;});
  addEventListener("pageshow",()=>setActive(atlas.getCurrentView()==="brands"&&!document.getElementById("tool-panel").classList.contains("is-minimized")));
  const adminSection=document.getElementById("admin-users");
  if(adminSection)adminSection.append(button("查看品牌管理申请（含自动通过）",()=>{atlas.openView("brands");section.open=true;$("scope").value="admin";offset=0;loadApplications();section.scrollIntoView({block:"start"});}));
  async function prepareFromAgent(args,ctx={}) {
    const guard=()=>{if(ctx.signal?.aborted||ctx.isCurrent&&!ctx.isCurrent())throw new DOMException("已取消","AbortError");};
    guard();if(!user())throw Error("请先登录，再准备品牌管理申请");
    const hasDraft=()=>$("statement").value.trim()||$("source-url").value.trim()
      ||current?.canEdit&&($("profile-description").value!==(current.profile?.description||"")||$("profile-website").value!==(current.profile?.website||""));
    if(busy||hasDraft())throw Error("品牌管理表单已有草稿或正在保存，请先处理原表单");
    const account=user().id,token=epoch;
    atlas.openView("brands");setActive(true);
    const data=await loadBrand(args.name,{open:true,ctx});guard();
    if(account!==user()?.id||token!==epoch)throw new DOMException("已取消","AbortError");
    if(!data||current!==data)throw Error("品牌资料未读取完成，请在品牌页重试");
    if(busy||hasDraft())throw Error("品牌管理表单已有新草稿，请先处理原表单");
    if(data.banned)throw Error("你已被禁止管理此品牌，请联系站点管理员");
    if(["approved","pending"].includes(data.application?.status))throw Error("你已申请或正在管理此品牌，请在品牌页查看记录");
    $("statement").value=args.statement||"";$("source-url").value=args.sourceUrl||"";
    status("助手已准备申请草稿。请核对品牌、说明和依据后提交；尚未申请或获得权限。");
    return {name:data.name};
  }
  window.HuayuBrandManagement=Object.freeze({setActive,canManage,isBanned,prepareFromAgent,
    selectBrand:(name,open=true)=>loadBrand(name,{open}),refresh:refreshAll});
  accountUI();setActive(atlas.getCurrentView()==="brands"&&!document.getElementById("tool-panel").classList.contains("is-minimized"));
})();
