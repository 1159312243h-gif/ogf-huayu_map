(function(root){
  "use strict";
  function start(){
    const atlas=root.HuayuAtlas,$=id=>document.getElementById("agent-"+id),contract=root.HuayuAgentContract;
    let file=null,messages=[],status=null,busy=false,epoch=0,controller=null;
    const runtime=root.HuayuAgentTools.create({atlas,getFile:()=>file,personal:()=>root.HuayuPersonalData,
      features:()=>root.HuayuFeatureInfo,datasets:()=>root.HuayuSharedDatasets,brands:()=>root.HuayuBrandManagement,templates:()=>root.HuayuLineTemplateUI});
    const element=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text||"";if(cls)el.className=cls;return el;};
    const button=(text,fn)=>{const b=element("button",text,"text-button");b.type="button";b.onclick=fn;return b;};
    function note(text){$("status").textContent=text;}
    function entry(role,text){
      const card=element("article",undefined,"agent-message agent-"+role);
      card.append(element("strong",({user:"你",assistant:"地图助手",tool:"操作结果"})[role]),element("p",text));$("messages").append(card);
      // Visible transcript is also bounded; no conversation is saved to browser storage.
      while($("messages").children.length>80)$("messages").firstElementChild.remove();
      return card;
    }
    const errors={agent_not_configured:"模型服务尚未配置。功能接口已准备好，可先使用下方现有功能入口。",
      authentication_required:"请先登录再使用已配置的模型服务。",personal_data_service_not_configured:"账号服务尚未配置。",
      agent_provider_unavailable:"模型服务暂时不可用，请稍后重试。",agent_response_invalid:"模型返回了无效操作，尚未执行。",
      agent_history_invalid:"对话过长，请清空后重新开始。",agent_tool_history_invalid:"对话操作链无效，请清空后重新开始。",
      agent_timeout:"模型响应超时；可在连接选项中增加等待时间后重试。",agent_configuration_invalid:"请检查 API 地址、接口协议、模型名称及密钥。",
      agent_provider_authentication_failed:"密钥无效或没有此模型的权限，请检查服务商配置。",agent_provider_not_found:"接口路径或模型不存在，请核对地址与模型 ID。",
      agent_provider_rate_limited:"服务商配额不足或请求过于频繁，请稍后重试。",agent_provider_request_rejected:"服务商拒绝此请求，请检查协议及模型是否支持工具调用。",
      agent_tools_unsupported:"接口已响应，但未完成地图工具测试；可选择支持工具的模型，或改为仅对话模式。",agent_redirect_blocked:"接口发生重定向，已停止转发密钥；请填写最终 API 地址。"};
    Object.assign(errors,{agent_provider_balance:"服务商余额或配额不足，请在对应平台核对。",agent_provider_region_blocked:"服务商限制了当前部署地区的访问，请核对官方服务范围。",agent_model_not_found:"此模型 ID 不存在或没有权限，可先读取可用模型。",agent_response_incomplete:"模型输出达到长度上限，尚未执行不完整操作；请简化请求或换用其他模型。",agent_provider_refused:"模型服务拒绝了此次内容请求，未执行地图操作。",agent_response_too_large:"模型返回资料过大，请缩短对话或降低模型思考用量。",agent_unavailable:"接口连接未完成，请核对服务商地址和服务状态。",payload_too_large:"对话资料过长，请清空对话后继续。"});
    const providers=root.HuayuAgentProviders;
    let connection=null,tested=false,configEpoch=0;
    const preferenceKey=()=>"huayu-map-agent-connection-v1:"+(root.HuayuPersonalData?.getCurrentUser()?.id||"guest");
    function remember(){
      try{
        if($("remember").checked)localStorage.setItem(preferenceKey(),JSON.stringify({preset:$("provider").value,protocol:$("protocol").value,baseUrl:$("base-url").value.trim(),model:$("model").value.trim(),toolMode:$("tool-mode").value,timeoutSeconds:Number($("timeout").value)}));
        else localStorage.removeItem(preferenceKey());
      }catch{$("config-status").textContent="此浏览器不允许保存设置，当前页面仍可使用。";}
    }

    async function readModels(){
      if(busy)return;
      let candidate;try{candidate=providers.normalize({protocol:$("protocol").value,baseUrl:$("base-url").value.trim(),model:$("model").value.trim(),apiKey:$("api-key").value.trim()},{requireModel:false});}
      catch{$("models-status").textContent="先填写 API 地址、协议和密钥，再读取可用模型。";return;}
      const current=++epoch,generation=configEpoch;busy=true;controller=new AbortController();auth();$("models-status").textContent="正在读取此接口可用模型…";
      try{
        const r=await fetch("/api/agent/models",{method:"POST",credentials:"same-origin",cache:"no-store",signal:controller.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({connection:candidate})});
        const data=await r.json();if(epoch!==current||generation!==configEpoch)return;if(!r.ok)throw Error(data.error||"agent_unavailable");
        $("models").replaceChildren(...data.models.map(id=>{const o=document.createElement("option");o.value=id;return o;}));
        $("models-status").textContent=data.models.length?"已读取 "+data.models.length+" 个模型，在模型输入框中选择或填写。"+(data.complete?"":"当前仅为接口返回的一页。"):"此接口没有返回模型，可按服务商给出的 ID 手填。";
      }catch(e){if(epoch===current&&generation===configEpoch)$("models-status").textContent=(errors[e.message]||"模型列表暂不可用")+" 仍可手填服务商提供的模型 ID。";}
      finally{if(epoch===current){busy=false;controller=null;auth();}}
    }

    function loadSettings(){
      $("api-key").value="";connection=null;tested=false;
      $("source").value="user";$("protocol").value="openai";$("provider").value="openai";
      $("base-url").value=providers.presets[0].baseUrl;$("model").value="";$("tool-mode").value="auto";$("timeout").value="180";$("models").replaceChildren();$("models-status").textContent="";$("remember").checked=false;
      try{
        const saved=JSON.parse(localStorage.getItem(preferenceKey())||"null");
        if(saved){
          const clean=providers.normalize({protocol:saved.protocol,baseUrl:saved.baseUrl,model:saved.model,...(saved.toolMode?{toolMode:saved.toolMode}:{}),...(saved.timeoutSeconds!==undefined?{timeoutSeconds:saved.timeoutSeconds}:{})},{requireKey:false});
          $("provider").value=providers.presets.some(p=>p.id===saved.preset)?saved.preset:"custom";
          $("protocol").value=clean.protocol;$("base-url").value=clean.baseUrl;$("model").value=clean.model;$("tool-mode").value=clean.toolMode||"auto";$("timeout").value=String(clean.timeoutSeconds||180);$("remember").checked=true;
        }
      }catch{}
      $("config-status").textContent="填写你自己的接口和模型，应用后即可对话；API 密钥不会保存。";
    }
    function dirty(event){
      if(!event||["agent-protocol","agent-base-url","agent-api-key"].includes(event.target?.id)){$("models").replaceChildren();$("models-status").textContent="";}
      configEpoch++;connection=null;tested=false;reset();auth();
      $("config-status").textContent="设置已修改，请重新应用配置。";
    }
    function applySettings(){
      const value={protocol:$("protocol").value,baseUrl:$("base-url").value.trim(),model:$("model").value.trim(),apiKey:$("api-key").value.trim(),toolMode:$("tool-mode").value,timeoutSeconds:Number($("timeout").value)};
      const candidate=providers.normalize(value);
      configEpoch++;reset();connection=candidate;tested=false;$("base-url").value=candidate.baseUrl;remember();auth();
      $("config-status").textContent="配置已应用，尚未验证连接；可测试工具调用或直接发送消息。";
      return candidate;
    }
    async function testSettings(){
      if(busy)return;
      let candidate;try{candidate=applySettings();}catch{$("config-status").textContent="请填写有效的公开 HTTPS API 地址、模型名称和密钥。";return;}
      const current=++epoch,generation=configEpoch;busy=true;controller=new AbortController();auth();
      $("config-status").textContent="正在测试连接与结果回传…";
      try{
        const r=await fetch("/api/agent/test",{method:"POST",credentials:"same-origin",cache:"no-store",signal:controller.signal,
          headers:{"Content-Type":"application/json"},body:JSON.stringify({connection:candidate})});
        const result=await r.json();if(epoch!==current||generation!==configEpoch)return;
        if(!r.ok||!result.ok)throw Error(result.error||"agent_unavailable");
        tested=true;$("config-status").textContent=result.toolCalling?"连接成功，地图工具及结果回传均通过；尚未执行地图操作。":"连接成功，当前仅对话，不能自动操作地图。";$("connection-section").open=false;note(result.toolCalling?"连接与两轮工具测试通过，可开始对话。":"仅对话连接成功；地图操作请使用菜单。");auth();
      }catch(e){if(epoch===current&&generation===configEpoch){tested=false;$("config-status").textContent=errors[e.message]||"测试未完成，请检查接口、模型及网络后重试。";}}
      finally{if(epoch===current){busy=false;controller=null;auth();}}
    }
    for(const p of providers.presets){const o=document.createElement("option");o.value=p.id;o.textContent=p.label;$("provider").append(o);}
    $("provider").onchange=()=>{
      const p=providers.presets.find(p=>p.id===$("provider").value);
      $("protocol").value=p.protocol;$("base-url").value=p.baseUrl;$("model").value="";$("api-key").value="";dirty();
    };
    for(const id of ["protocol","base-url","model","api-key","tool-mode","timeout"])$(id).oninput=dirty;
    $("remember").onchange=()=>{if(connection)remember();};
    $("source").onchange=()=>{configEpoch++;reset();auth();};
    $("connection-form").onsubmit=event=>{event.preventDefault();try{applySettings();$("connection-section").open=false;}catch{$("config-status").textContent="请填写有效的公开 HTTPS API 地址、模型名称和密钥。";}};
    $("config-test").onclick=testSettings;
    $("models-read").onclick=readModels;
    $("config-clear").onclick=()=>{
      configEpoch++;try{localStorage.removeItem(preferenceKey());}catch{}reset();loadSettings();auth();
      $("config-status").textContent="已清除当前页面密钥及此账号在本机记住的接口设置。";
    };
    loadSettings();
    function auth(){
      const loggedIn=root.HuayuPersonalData?.isAuthenticated(),own=$("source").value==="user",ready=own?Boolean(connection):Boolean(status?.configured);
      $("send").disabled=busy||!status||!ready||!own&&status.requiresLogin&&!loggedIn;
      $("connection-fields").disabled=busy||!own;$("source").disabled=busy;
      const option=$("source").querySelector('option[value="site"]');option.disabled=!status?.configured;option.textContent=status?.configured?"使用站点提供的接口":"使用站点提供的接口（未配置）";
      $("models-read").disabled=busy||!own;$("stop").disabled=!busy;$("attach").disabled=busy;$("file-preview").disabled=busy||!file;
      $("input").disabled=busy;
      $("service").textContent=!status?"正在检查对话服务…":own?connection?(tested?"自备接口已连接 · ":"自备接口已应用（未测试） · ")+connection.model+(connection.toolMode==="text"?" · 仅对话":" · 地图工具"):"请先配置自己的 AI 接口 · 地图功能接口已就绪":!status.configured?"站点未提供模型接口":status.requiresLogin&&!loggedIn?"站点模型已配置 · 登录后可对话":"正在使用站点模型接口";
    }
    async function refresh(){
      try{const r=await fetch("/api/agent/status",{cache:"no-store",credentials:"same-origin",signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();status=await r.json();}
      catch{status=null;auth();$("service").textContent="暂时无法读取模型服务状态；现有地图功能可继续使用。";return;}
      auth();
    }
    function output(result){
      const card=entry("tool",result.message||result.source||"已读取当前功能信息");
      if(result.items){
        if(!result.items.length)card.append(element("p","当前查询未找到结果。"));
        for(const i of result.items.slice(0,12)){
          const row=element("div",undefined,"agent-result");
          row.append(element("p",i.label||i.title||"查询结果"));
          const meta=[i.sharedNames,i.source,i.observedDate,i.scope?.label,i.unit,i.type&&i.id?i.type+"/"+i.id:""].filter(Boolean).join(" · ");
          if(meta)row.append(element("small",meta));
          if(i.ref)row.append(button("在地图定位",()=>manual("locate_place",{ref:i.ref})));
          else if(i.id)row.append(button("打开数据包",()=>manual("open_dataset",{id:i.id})));
          card.append(row);
        }
        if(result.complete===false)card.append(element("small","这是当前页／限定数量结果，可在对应功能继续查询。"));
      }
      if(result.selected)card.append(element("p","选中："+result.selected.label+" · "+result.selected.type+"/"+result.selected.id));
      if(result.tools)card.append(element("p","当前功能清单已读取，可通过下方入口继续操作。"));
      if(result.stats)card.append(element("p",result.stats.rows+" 条记录，"+result.stats.located+" 条有位置。"));
    }
    async function manual(name,args){
      if(busy){note("请先停止当前对话操作，再使用功能入口。");return;}
      const current=epoch,abort=new AbortController();
      try{output(await runtime.execute(name,args,{signal:abort.signal,isCurrent:()=>epoch===current}));}
      catch(e){note(e.message);}
    }
    function reset(clear=true){
      epoch++;controller?.abort();controller=null;busy=false;messages=[];runtime.reset();
      if(clear){$("input").value="";file=null;$("attach").value="";$("file-name").textContent="尚未选择附件";$("messages").replaceChildren();}
      auth();
    }
    async function send(event){
      event.preventDefault();const prompt=$("input").value.trim();if(busy||!prompt)return;
      const own=$("source").value==="user",activeConnection=own?connection:null;
      if(!status||own&&!activeConnection||!own&&!status.configured){note("请先配置并应用自己的 AI 接口，或选择已启用的站点接口。");return;}
      if(!own&&status.requiresLogin&&!root.HuayuPersonalData?.isAuthenticated()){note(errors.authentication_required);return;}
      if(messages.length>=32){note("本段对话较长，请清空后继续；地图操作和已保存数据会保留。");return;}
      busy=true;const current=++epoch;controller=new AbortController();const signal=controller.signal;
      const context={signal,isCurrent:()=>epoch===current},check=()=>{if(signal.aborted||epoch!==current)throw new DOMException("已取消","AbortError");};
      messages.push({role:"user",content:prompt});entry("user",prompt);$("input").value="";auth();
      try{
        for(let round=0;round<6;round++){
          check();note("正在理解请求并查询地图…");
          const r=await fetch("/api/agent/chat",{method:"POST",credentials:"same-origin",cache:"no-store",signal,
            headers:{"Content-Type":"application/json"},body:JSON.stringify({messages,...(activeConnection?{connection:activeConnection}:{})})});
          const data=await r.json();check();if(!r.ok)throw Error(data.error||"agent_unavailable");
          const m=data.message;if(m?.role!=="assistant")throw Error("agent_response_invalid");
          const calls=m.tool_calls||[];
          // Validate the complete batch before executing any action.
          for(const call of calls){if(call.type!=="function")throw Error("agent_response_invalid");contract.argumentsFor(call.function.name,JSON.parse(call.function.arguments));}
          messages.push(m);
          if(!calls.length){entry("assistant",m.content||"本次查询已完成。");note("本轮对话结束");return;}
          let handoff=false,lastMessage="";
          for(const call of calls){
            check();note("正在执行："+call.function.name);
            let result;
            if(handoff)result={error:"已打开操作页面，其余动作暂不执行。请返回助手后继续。"};
            else try{result=await runtime.execute(call.function.name,JSON.parse(call.function.arguments),context);check();output(result);}
            catch(e){check();result={error:e.message};entry("tool","操作未完成："+e.message);}
            messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
            if(result.handoff){handoff=true;lastMessage=result.message;}
          }
          if(handoff){const reply=lastMessage+" 如需继续对话，再点菜单中的“助手”。";entry("assistant",reply);note("已转到对应功能，尚未自动发布任何内容。");return;}
          if(messages.length>=32)break;
        }
        const text="本轮已执行多步查询，暂时停在这里。可继续提出下一步需求，或使用已列出的功能入口。";
        entry("assistant",text);note("等待下一步操作");
      }catch(e){
        if(epoch!==current||signal.aborted)return;
        const text=errors[e.message]||"本轮对话暂未完成，请重试；模型未确认的操作不会显示为完成。";
        entry("assistant",text);note(text);$("input").value=prompt;
        // Remove an unanswered user prompt; executed tool results remain paired.
        if(messages.at(-1)?.role==="user")messages.pop();
      }finally{if(epoch===current){busy=false;controller=null;auth();}}
    }
    $("form").onsubmit=send;
    $("stop").onclick=()=>{reset(false);entry("assistant","已停止。下一次对话将使用新上下文；已完成的地图操作仍保留。");note("已停止");};
    $("clear").onclick=()=>{reset();note("已清空本页对话和附件引用。");};
    $("refresh").onclick=refresh;
    $("attach").onchange=()=>{file=$("attach").files[0]||null;$("file-name").textContent=file?file.name+" · 仅在本机，未发布":"尚未选择附件";auth();};
    $("file-preview").onclick=async()=>{
      if(!file||busy)return;
      if(!root.HuayuPersonalData?.isAuthenticated()){note("请先登录，再转入共享数据上传表单。");return;}
      const current=++epoch;busy=true;controller=new AbortController();auth();
      try{await root.HuayuSharedDatasets.prepareFromAgent(file,{title:file.name.replace(/\.[^.]+$/u,""),kind:"other",scopeLabel:""},controller.signal,false);if(epoch===current)note("已带入数据表单，请填写类型、范围和来源后校验；尚未发布。");}
      catch(e){if(epoch===current)note(e.message);}
      finally{if(epoch===current){busy=false;controller=null;auth();}}
    };
    for(const p of contract.panels.filter(p=>p.id!=="agent"))$("capabilities").append(button(p.title,()=>manual("open_panel",{panel:p.id})));
    document.addEventListener("click",event=>{
      if(!busy)return;
      const action=event.target.closest("[data-action]"),close=event.target.closest("#close-panel,[data-minimize-panel='tool-panel']");
      if(close||action&&action.dataset.action!=="agent"){reset(false);note("已停止对话操作；下一次从新上下文开始。");}
    },true);
    root.addEventListener("huayu:account-changed",()=>{configEpoch++;reset();loadSettings();auth();note("账号已变化，对话、地点引用、附件及 API 密钥已清空。");});
    root.addEventListener("pagehide",()=>{configEpoch++;reset();connection=null;tested=false;$("api-key").value="";auth();});
    root.HuayuMapAgent=Object.freeze({refreshStatus:refresh,reset});
    refresh();if(new URLSearchParams(location.search).get("panel")==="agent")atlas.openView("agent",{preservePerspective:true});
  }
  if(root.HuayuAtlas)start();else root.addEventListener("huayu:map-ready",start,{once:true});
})(globalThis);
