// Shared browser/Worker adapters. Credentials never enter model messages or persistent storage.
function createMapAgentProviders() {
  "use strict";
  const presets=[
    {id:"openai",label:"OpenAI",protocol:"openai",baseUrl:"https://api.openai.com/v1"},
    {id:"deepseek",label:"DeepSeek",protocol:"openai",baseUrl:"https://api.deepseek.com/v1"},
    {id:"qwen",label:"通义千问（阿里云）",protocol:"openai",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {id:"moonshot",label:"Moonshot / Kimi",protocol:"openai",baseUrl:"https://api.moonshot.cn/v1"},
    {id:"zhipu",label:"智谱 GLM",protocol:"openai",baseUrl:"https://open.bigmodel.cn/api/paas/v4"},
    {id:"anthropic",label:"Anthropic / Claude",protocol:"anthropic",baseUrl:"https://api.anthropic.com/v1"},
    {id:"gemini",label:"Google / Gemini",protocol:"gemini",baseUrl:"https://generativelanguage.googleapis.com/v1beta"},
    {id:"custom",label:"自定义接口",protocol:"openai",baseUrl:""}
  ];
  const fail=()=>{throw Object.assign(Error("agent_configuration_invalid"),{status:400});};
  const text=(value,max)=>typeof value==="string"&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
  function normalize(value,{requireKey=true}={}) {
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["protocol","baseUrl","model","apiKey"].includes(k)))return fail();
    const {protocol}=value;if(!["openai","anthropic","gemini"].includes(protocol)||!text(value.baseUrl,2048)||!text(value.model,200))return fail();
    let url;try{url=new URL(value.baseUrl.trim());}catch{return fail();}
    const host=url.hostname.toLowerCase();
    // The shared proxy accepts public HTTPS APIs only, and never follows credential-bearing redirects.
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.port&&url.port!=="443"
      ||!host.includes(".")||/^[\d.]+$/u.test(host)||host.includes(":")
      ||/(?:^|\.)(?:localhost|local|internal|lan|home|invalid)$/u.test(host)
      ||host==="metadata.google.internal"||host.endsWith(".localhost")||url.pathname.includes("//"))return fail();
    let path=url.pathname.replace(/\/+$/u,"");
    const suffix={openai:"/chat/completions",anthropic:"/messages"}[protocol];
    if(suffix&&path.endsWith(suffix))path=path.slice(0,-suffix.length);
    if(protocol==="gemini"&&/\/models(?:\/|$)/u.test(path))return fail();
    url.pathname=path;const baseUrl=url.href.replace(/\/$/u,"");
    const result={protocol,baseUrl,model:value.model.trim()};
    if(requireKey){if(!text(value.apiKey,4096)||/\s/u.test(value.apiKey.trim()))return fail();result.apiKey=value.apiKey.trim();}
    return result;
  }
  const args=value=>{try{return JSON.parse(value);}catch{throw Error("agent_response_invalid");}};
  function geminiSchema(s) {
    const result={type:s.type.toUpperCase()};
    if(s.properties)result.properties=Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,geminiSchema(v)]));
    if(s.required?.length)result.required=s.required;
    if(s.items)result.items=geminiSchema(s.items);
    if(s.enum)result.enum=s.enum;
    return result;
  }
  function build(connection,messages,system,tools,test=false) {
    const c=normalize(connection),headers={"Content-Type":"application/json"};
    const definitions=test?tools.filter(t=>t.name==="get_capabilities"):tools;
    if(c.protocol==="openai") {
      headers.Authorization="Bearer "+c.apiKey;
      const history=messages.map(m=>{
        if(m.role==="tool")return {role:"tool",tool_call_id:m.tool_call_id,content:m.content};
        if(m.role==="user")return {role:"user",content:m.content};
        return {role:"assistant",content:m.content,
          ...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{}),
          ...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(({id,type,function:fn})=>({id,type,function:fn}))}:{})};
      });
      return {url:c.baseUrl+"/chat/completions",headers,body:{model:c.model,messages:[{role:"system",content:system},...history],
        tools:definitions.map(({name,description,parameters})=>({type:"function",function:{name,description,parameters}})),
        tool_choice:test?{type:"function",function:{name:"get_capabilities"}}:"auto"}};
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
          const content=[...(m.content?[{type:"text",text:m.content}]:[]),...(m.tool_calls||[]).map(t=>({type:"tool_use",id:t.id,name:t.function.name,input:args(t.function.arguments)}))];
          history.push({role:"assistant",content:content.length?content:[{type:"text",text:"继续"}]});
        }else history.push({role:"user",content:m.content});
      }
      return {url:c.baseUrl+"/messages",headers,body:{model:c.model,max_tokens:test?256:4096,system,messages:history,
        tools:definitions.map(({name,description,parameters})=>({name,description,input_schema:parameters})),tool_choice:test?{type:"tool",name:"get_capabilities"}:{type:"auto"}}};
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
        toolConfig:{functionCallingConfig:{mode:test?"ANY":"AUTO",...(test?{allowedFunctionNames:["get_capabilities"]}:{})}},
        generationConfig:{maxOutputTokens:test?512:4096}}};
  }
  function response(protocol,payload) {
    if(protocol==="openai"){
      const m=payload.choices?.[0]?.message;if(!m)throw Error("agent_response_invalid");
      return {content:m.content??"",tool_calls:m.tool_calls||[],...(m.reasoning_content?{reasoning_content:m.reasoning_content}:{})};
    }
    if(protocol==="anthropic"){
      if(!Array.isArray(payload.content))throw Error("agent_response_invalid");
      return {content:payload.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"),tool_calls:payload.content.filter(p=>p.type==="tool_use").map(p=>({id:p.id,type:"function",function:{name:p.name,arguments:JSON.stringify(p.input)}}))};
    }
    const parts=payload.candidates?.[0]?.content?.parts;if(!Array.isArray(parts))throw Error("agent_response_invalid");
    return {content:parts.filter(p=>typeof p.text==="string"&&!p.thought).map(p=>p.text).join("\n"),
      tool_calls:parts.filter(p=>p.functionCall).map((p,i)=>({id:"gemini_"+i,type:"function",function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})},
        ...(p.thoughtSignature?{providerData:{thoughtSignature:p.thoughtSignature}}:{})}))};
  }
  return Object.freeze({presets,normalize,build,response});
}
globalThis.HuayuAgentProviders=createMapAgentProviders();
