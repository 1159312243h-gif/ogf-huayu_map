// Shared browser/Worker adapters. Credentials never enter model messages or persistent storage.
function createMapAgentProviders() {
  "use strict";
  const presets=[
    {id:"openai",label:"OpenAI",protocol:"openai",baseUrl:"https://api.openai.com/v1"},
    {id:"deepseek",label:"DeepSeek 官方",protocol:"openai",baseUrl:"https://api.deepseek.com"},
    {id:"qwen",label:"通义千问（阿里云）",protocol:"openai",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {id:"moonshot",label:"Moonshot / Kimi",protocol:"openai",baseUrl:"https://api.moonshot.cn/v1"},
    {id:"zhipu",label:"智谱 GLM",protocol:"openai",baseUrl:"https://open.bigmodel.cn/api/paas/v4"},
    {id:"anthropic",label:"Anthropic / Claude",protocol:"anthropic",baseUrl:"https://api.anthropic.com/v1"},
    {id:"gemini",label:"Google / Gemini",protocol:"gemini",baseUrl:"https://generativelanguage.googleapis.com/v1beta"},
    {id:"openai-responses",label:"OpenAI · Responses",protocol:"responses",baseUrl:"https://api.openai.com/v1"},
    {id:"doubao",label:"豆包 / 火山方舟",protocol:"openai",baseUrl:"https://ark.cn-beijing.volces.com/api/v3"},
    {id:"siliconflow",label:"硅基流动",protocol:"openai",baseUrl:"https://api.siliconflow.cn/v1"},
    {id:"xai",label:"xAI / Grok",protocol:"openai",baseUrl:"https://api.x.ai/v1"},
    {id:"mistral",label:"Mistral",protocol:"openai",baseUrl:"https://api.mistral.ai/v1"},
    {id:"groq",label:"Groq",protocol:"openai",baseUrl:"https://api.groq.com/openai/v1"},
    {id:"openrouter",label:"OpenRouter",protocol:"openai",baseUrl:"https://openrouter.ai/api/v1"},
    {id:"custom",label:"自定义接口",protocol:"openai",baseUrl:""}
  ];
  const fail=()=>{throw Object.assign(Error("agent_configuration_invalid"),{status:400});};
  const text=(value,max)=>typeof value==="string"&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
  function normalize(value,{requireKey=true,requireModel=true}={}) {
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["protocol","baseUrl","model","apiKey","toolMode","timeoutSeconds"].includes(k)))return fail();
    const {protocol}=value;if(!["openai","responses","anthropic","gemini"].includes(protocol)||!text(value.baseUrl,2048)||requireModel&&!text(value.model,200))return fail();
    let url;try{url=new URL(value.baseUrl.trim());}catch{return fail();}
    const host=url.hostname.toLowerCase();
    // The shared proxy accepts public HTTPS APIs only, and never follows credential-bearing redirects.
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.port&&url.port!=="443"
      ||!host.includes(".")||/^[\d.]+$/u.test(host)||host.includes(":")
      ||/(?:^|\.)(?:localhost|local|internal|lan|home|invalid)$/u.test(host)
      ||host==="metadata.google.internal"||host.endsWith(".localhost")||url.pathname.includes("//"))return fail();
    let path=url.pathname.replace(/\/+$/u,"");
    const suffix={openai:"/chat/completions",responses:"/responses",anthropic:"/messages"}[protocol];
    if(suffix&&path.endsWith(suffix))path=path.slice(0,-suffix.length);
    if(protocol==="gemini"&&/\/models(?:\/|$)/u.test(path)){
      const m=path.match(/^(.*)\/models\/([^/]+):generateContent$/u);
      if(!m||value.model&&decodeURIComponent(m[2])!==value.model.trim().replace(/^models\//u,""))return fail();path=m[1];
    }
    if(!path&&["api.openai.com","api.anthropic.com"].includes(host))path="/v1";
    if(!path&&host==="generativelanguage.googleapis.com")path="/v1beta";
    url.pathname=path;const baseUrl=url.href.replace(/\/$/u,"");
    const result={protocol,baseUrl,model:typeof value.model==="string"?value.model.trim():""};
    if(value.toolMode!==undefined){if(!["auto","text"].includes(value.toolMode))return fail();result.toolMode=value.toolMode;}
    if(value.timeoutSeconds!==undefined){if(!Number.isInteger(value.timeoutSeconds)||value.timeoutSeconds<30||value.timeoutSeconds>600)return fail();result.timeoutSeconds=value.timeoutSeconds;}
    if(requireKey){if(!text(value.apiKey,4096)||/\s/u.test(value.apiKey.trim()))return fail();result.apiKey=value.apiKey.trim();}
    return result;
  }
  const args=value=>{try{return JSON.parse(value);}catch{throw Error("agent_response_invalid");}};
  function geminiSchema(s) {
    if(s.anyOf){const value=s.anyOf.find(v=>v.type!=="null");return {...geminiSchema(value),nullable:s.anyOf.some(v=>v.type==="null")};}
    const result={type:s.type.toUpperCase()};
    if(s.properties)result.properties=Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,geminiSchema(v)]));
    if(s.required?.length)result.required=s.required;
    if(s.items)result.items=geminiSchema(s.items);
    if(s.enum)result.enum=s.enum;
    return result;
  }
  function rawBuild(connection,messages,system,tools,test=false) {
    const c=normalize(connection),headers={"Content-Type":"application/json"};
    const definitions=test?tools.filter(t=>t.name==="get_capabilities"):tools;
    if(c.protocol==="responses")return responsesBuild(c,messages,system,definitions);
    if(c.protocol==="openai") {
      headers.Authorization="Bearer "+c.apiKey;
      const history=messages.map(m=>{
        if(m.role==="tool")return {role:"tool",tool_call_id:m.tool_call_id,content:m.content};
        if(m.role==="user")return {role:"user",content:m.content};
        return {role:"assistant",content:m.content,
          ...(typeof m.reasoning_content==="string"?{reasoning_content:m.reasoning_content}:new URL(c.baseUrl).hostname==="api.deepseek.com"?{reasoning_content:""}:{}),
          ...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(({id,type,function:fn})=>({id,type,function:fn}))}:{})};
      });
      return {url:c.baseUrl+"/chat/completions",headers,body:{model:c.model,messages:[{role:"system",content:system},...history],
        tools:definitions.map(({name,description,parameters})=>({type:"function",function:{name,description,parameters}})),
        tool_choice:"auto",stream:false}};
    }
    if(c.protocol==="anthropic") {
      headers["x-api-key"]=c.apiKey;headers["anthropic-version"]="2023-06-01";
      const history=[];
      for(const m of messages){
        if(m.role==="tool"){
          const part={type:"tool_result",tool_use_id:m.tool_call_id,content:m.content},last=history.at(-1);
          if(last?.role==="user"&&Array.isArray(last.content)&&last.content.every(p=>p.type==="tool_result"))last.content.push(part);
          else history.push({role:"user",content:[part]});
        }else if(m.role==="assistant"){
          const content=[...(historyState(m.providerData).anthropicThinking||[]),...(m.content?[{type:"text",text:m.content}]:[]),...(m.tool_calls||[]).map(t=>({type:"tool_use",id:t.id,name:t.function.name,input:args(t.function.arguments)}))];
          history.push({role:"assistant",content:content.length?content:[{type:"text",text:"继续"}]});
        }else history.push({role:"user",content:m.content});
      }
      return {url:c.baseUrl+"/messages",headers,body:{model:c.model,max_tokens:test?2048:8192,system,messages:history,
        tools:definitions.map(({name,description,parameters})=>({name,description,input_schema:parameters})),tool_choice:{type:"auto"},stream:false}};
    }
    headers["x-goog-api-key"]=c.apiKey;
    const names=new Map(),history=[];
    for(const m of messages){
      if(m.role==="tool"){
        let response;try{response=JSON.parse(m.content);}catch{response={result:m.content};}
        if(!response||typeof response!=="object"||Array.isArray(response))response={result:response};
        const part={functionResponse:{name:names.get(m.tool_call_id),response}},last=history.at(-1);
        if(last?.role==="user"&&last.parts.every(p=>p.functionResponse))last.parts.push(part);
        else history.push({role:"user",parts:[part]});
      }else if(m.role==="assistant"){
        const parts=[...(m.content?[{text:m.content}]:[]),...(m.tool_calls||[]).map(t=>{
          names.set(t.id,t.function.name);return {functionCall:{name:t.function.name,args:args(t.function.arguments)},
            ...(t.providerData?.thoughtSignature?{thoughtSignature:t.providerData.thoughtSignature}:{})};
        })];history.push({role:"model",parts:parts.length?parts:[{text:"继续"}]});
      }else history.push({role:"user",parts:[{text:m.content}]});
    }
    return {url:c.baseUrl+"/models/"+encodeURIComponent(c.model.replace(/^models\//u,""))+":generateContent",headers,
      body:{systemInstruction:{parts:[{text:system}]},contents:history,tools:[{functionDeclarations:definitions.map(({name,description,parameters})=>({name,description,parameters:geminiSchema(parameters)}))}],
        toolConfig:{functionCallingConfig:{mode:"AUTO"}},
        generationConfig:{maxOutputTokens:test?2048:8192}}};
  }
  function response(protocol,payload) {
    if(protocol==="openai"){
      const choice=payload.choices?.[0],m=choice?.message;if(!m)throw Error("agent_response_invalid");
      if(choice.finish_reason==="length")throw Error("agent_response_incomplete");
      if(choice.finish_reason==="content_filter")throw Error("agent_provider_refused");
      return {content:contentText(m.content),tool_calls:(m.tool_calls||[]).map(t=>({...t,function:{name:t.function?.name,arguments:typeof t.function?.arguments==="string"?t.function.arguments:JSON.stringify(t.function?.arguments)}})),...(typeof m.reasoning_content==="string"?{reasoning_content:m.reasoning_content}:{})};
    }
    if(protocol==="responses")return responsesResponse(payload);
    if(protocol==="anthropic"){
      if(payload.stop_reason==="max_tokens")throw Error("agent_response_incomplete");
      if(!Array.isArray(payload.content))throw Error("agent_response_invalid");
      return {...(payload.content.some(p=>["thinking","redacted_thinking"].includes(p.type))?{providerData:historyState({anthropicThinking:payload.content.filter(p=>["thinking","redacted_thinking"].includes(p.type))})}:{}),content:payload.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"),tool_calls:payload.content.filter(p=>p.type==="tool_use").map(p=>({id:p.id,type:"function",function:{name:p.name,arguments:JSON.stringify(p.input)}}))};
    }
    if(payload.candidates?.[0]?.finishReason==="MAX_TOKENS")throw Error("agent_response_incomplete");
    if(payload.promptFeedback?.blockReason||["SAFETY","RECITATION"].includes(payload.candidates?.[0]?.finishReason))throw Error("agent_provider_refused");
    const parts=payload.candidates?.[0]?.content?.parts;if(!Array.isArray(parts))throw Error("agent_response_invalid");
    return {content:parts.filter(p=>typeof p.text==="string"&&!p.thought).map(p=>p.text).join("\n"),
      tool_calls:parts.filter(p=>p.functionCall).map((p,i)=>({id:"gemini_"+i,type:"function",function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})},
        ...(p.thoughtSignature?{providerData:{thoughtSignature:p.thoughtSignature}}:{})}))};
  }
  const contentText=v=>v==null?"":typeof v==="string"?v:Array.isArray(v)?v.map(p=>p.text||p.refusal||"").join("\n"):v;
  function historyState(value){
    if(value===undefined)return {};
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["responsesReasoning","anthropicThinking"].includes(k)))throw Error("agent_response_invalid");
    const clean={};
    for(const [kind,list] of Object.entries(value)){
      if(!Array.isArray(list)||list.length>8)throw Error("agent_response_invalid");
      clean[kind]=list.map(p=>{
        const keys=kind==="responsesReasoning"?["id","type","summary","encrypted_content","status"]:p?.type==="thinking"?["type","thinking","signature"]:p?.type==="redacted_thinking"?["type","data"]:null;
        if(!p||!keys||Object.keys(p).some(k=>!keys.includes(k))||JSON.stringify(p).length>600000)throw Error("agent_response_invalid");
        if(kind==="responsesReasoning"){
          if(p.type!=="reasoning"||typeof p.id!=="string"||!/^[a-zA-Z0-9_-]{1,200}$/u.test(p.id)||p.encrypted_content!==undefined&&(typeof p.encrypted_content!=="string"||p.encrypted_content.length>256000))throw Error("agent_response_invalid");
          if(p.status!==undefined&&!["in_progress","completed","incomplete"].includes(p.status))throw Error("agent_response_invalid");
          if(p.summary!==undefined&&(!Array.isArray(p.summary)||p.summary.length>32||p.summary.some(x=>!x||x.type!=="summary_text"||typeof x.text!=="string"||x.text.length>24000||Object.keys(x).some(k=>!["type","text"].includes(k)))))throw Error("agent_response_invalid");
        }else if(keys.some(k=>typeof p[k]!=="string"||p[k].length>256000))throw Error("agent_response_invalid");
        return JSON.parse(JSON.stringify(p));
      });
    }return clean;
  }
  function responsesBuild(c,messages,system,definitions){
    const input=[];
    for(const m of messages){
      if(m.role==="tool")input.push({type:"function_call_output",call_id:m.tool_call_id,output:m.content});
      else if(m.role==="user")input.push({role:"user",content:m.content});
      else {input.push(...(historyState(m.providerData).responsesReasoning||[]));if(m.content)input.push({role:"assistant",content:m.content});
        for(const t of m.tool_calls||[])input.push({type:"function_call",call_id:t.id,name:t.function.name,arguments:t.function.arguments,...(t.providerData?.responseId?{id:t.providerData.responseId}:{})});}
    }return {url:c.baseUrl+"/responses",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.apiKey},body:{model:c.model,instructions:system,input,store:false,stream:false,include:["reasoning.encrypted_content"],tools:definitions.map(({name,description,parameters})=>({type:"function",name,description,parameters,strict:false})),tool_choice:"auto"}};
  }
  function responsesResponse(payload){
    if(payload.status==="incomplete")throw Error("agent_response_incomplete");if(!Array.isArray(payload.output)||payload.error)throw Error("agent_response_invalid");
    const reasoning=payload.output.filter(p=>p.type==="reasoning").map(p=>Object.fromEntries(Object.entries(p).filter(([k])=>["id","type","summary","encrypted_content","status"].includes(k))));
    return {content:payload.output.filter(p=>p.type==="message").flatMap(p=>p.content||[]).filter(p=>["output_text","refusal"].includes(p.type)).map(p=>p.text||p.refusal||"").join("\n"),
      tool_calls:payload.output.filter(p=>p.type==="function_call").map(p=>({id:p.call_id,type:"function",function:{name:p.name,arguments:typeof p.arguments==="string"?p.arguments:JSON.stringify(p.arguments)},...(p.id?{providerData:{responseId:p.id}}:{})})),...(reasoning.length?{providerData:historyState({responsesReasoning:reasoning})}:{})};
  }
  function build(connection,messages,system,tools,test=false){
    const result=rawBuild(connection,messages,system,tools,test);
    if(connection.toolMode==="text"){delete result.body.tools;delete result.body.tool_choice;delete result.body.toolConfig;}
    return result;
  }
  function modelRequest(connection){const c=normalize(connection,{requireModel:false});
    return {url:c.baseUrl+"/models"+(c.protocol==="gemini"?"?pageSize=1000":""),headers:c.protocol==="anthropic"?{"x-api-key":c.apiKey,"anthropic-version":"2023-06-01"}:c.protocol==="gemini"?{"x-goog-api-key":c.apiKey}:{Authorization:"Bearer "+c.apiKey}};
  }
  function models(protocol,payload){const list=protocol==="gemini"?payload.models:payload.data;if(!Array.isArray(list))throw Error("agent_response_invalid");
    const ids=[...new Set(list.filter(p=>protocol!=="gemini"||!p.supportedGenerationMethods||p.supportedGenerationMethods.includes("generateContent")).map(p=>protocol==="gemini"?String(p.name||"").replace(/^models\//u,""):p.id).filter(id=>text(id,200)))];
    if(ids.length>2000)throw Error("agent_response_invalid");return {models:ids,complete:!payload.has_more&&!payload.nextPageToken&&!payload.next_page_token};
  }
  return Object.freeze({presets,protocols:["openai","responses","anthropic","gemini"],normalize,build,response,historyState,modelRequest,models});
}
globalThis.HuayuAgentProviders=createMapAgentProviders();
