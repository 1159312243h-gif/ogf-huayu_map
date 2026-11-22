import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import worker from "../site/_worker.js";
import "../site/map-agent-providers.js";
import "../site/map-agent-contract.js";
const p=globalThis.HuayuAgentProviders,tools=globalThis.HuayuAgentContract.tools,originalFetch=globalThis.fetch;
const own={protocol:"openai",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"test-own-secret"};
async function request(path,body,extra={}){
  const response=await worker.fetch(new Request("https://atlas.test/api/agent/"+path,{method:"POST",headers:{Origin:"https://atlas.test","Content-Type":"application/json"},body:JSON.stringify(body),...extra}),{},{});
  return {status:response.status,body:await response.json()};
}
const call=(id="test_call")=>({id,type:"function",function:{name:"get_capabilities",arguments:"{}"}});
const message=(protocol,first=true)=>protocol==="openai"?{choices:[{finish_reason:first?"tool_calls":"stop",message:{content:first?null:"连接成功",reasoning_content:first?"": "final reasoning",...(first?{tool_calls:[call()]}:{})}}]}
  :protocol==="responses"?{status:"completed",output:[{id:"rs_1",type:"reasoning",summary:[],encrypted_content:"opaque-not-instructions"},...(first?[{id:"fc_1",type:"function_call",call_id:"test_call",name:"get_capabilities",arguments:"{}"}]:[{type:"message",role:"assistant",content:[{type:"output_text",text:"连接成功"}]}])]}
  :protocol==="anthropic"?{content:[{type:"thinking",thinking:"protocol thought",signature:"signed-value"},...(first?[{type:"tool_use",id:"test_call",name:"get_capabilities",input:{}}]:[{type:"text",text:"连接成功"}])]}
  :{candidates:[{content:{parts:first?[{functionCall:{name:"get_capabilities",args:{}},thoughtSignature:"opaque-signature"}]:[{text:"连接成功"}]}}]};
try{
  for(const protocol of p.protocols){
    const connection={...own,protocol,baseUrl:"https://models.example/v1"};let count=0;
    globalThis.fetch=async(url,options)=>{
      count++;const body=JSON.parse(options.body);
      assert.equal(options.redirect,"manual");assert.equal(options.credentials,"omit");assert.equal(options.headers.Cookie,undefined);assert.ok(!JSON.stringify(body).includes(connection.apiKey));
      if(protocol==="openai")assert.equal(body.tool_choice,"auto");
      if(protocol==="responses"){assert.equal(body.store,false);assert.equal(body.tool_choice,"auto");if(count===2){assert.equal(body.input[1].encrypted_content,"opaque-not-instructions");assert.equal(body.input[2].call_id,"test_call");assert.equal(body.input[3].type,"function_call_output");}}
      if(protocol==="anthropic"){assert.equal(body.tool_choice.type,"auto");if(count===2){assert.equal(body.messages[1].content[0].signature,"signed-value");assert.equal(body.messages[2].content[0].tool_use_id,"test_call");}}
      if(protocol==="gemini"){assert.equal(body.toolConfig.functionCallingConfig.mode,"AUTO");if(count===2){assert.equal(body.contents[1].parts[0].thoughtSignature,"opaque-signature");assert.equal(body.contents[2].parts[0].functionResponse.name,"get_capabilities");}}
      return Response.json(message(protocol,count===1));
    };
    const test=await request("test",{connection,messages:[{role:"user",content:"PRIVATE_SENTINEL"}]});
    assert.equal(test.status,200,JSON.stringify(test));assert.equal(test.body.roundTrip,true);assert.equal(count,2);
    globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.tools,undefined);assert.equal(body.tool_choice,undefined);assert.equal(body.toolConfig,undefined);return Response.json(message(protocol,false));};
    const text=await request("test",{connection:{...connection,toolMode:"text"}});assert.equal(text.status,200);assert.equal(text.body.toolCalling,false);
  }
  // Official DeepSeek rejects a forced named tool with default thinking enabled.
  let count=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,"https://api.deepseek.com/chat/completions");const body=JSON.parse(options.body);count++;
    if(body.tool_choice!=="auto")return Response.json({error:{code:"invalid_request_error"}},{status:400});
    if(count===2)assert.equal(body.messages[2].reasoning_content,"","even an empty reasoning field must survive");
    return Response.json(message("openai",count===1));
  };
  assert.equal((await request("test",{connection:own})).status,200);assert.equal(count,2);
  const longThought="reasoning ".repeat(12000);
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:null,reasoning_content:longThought,tool_calls:[call()]}}]});
  const first=await request("chat",{connection:own,messages:[{role:"user",content:"查功能"}]});assert.equal(first.status,200);assert.equal(first.body.message.reasoning_content,longThought);
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.messages[2].reasoning_content,longThought);return Response.json(message("openai",false));};
  assert.equal((await request("chat",{connection:own,messages:[{role:"user",content:"查功能"},first.body.message,{role:"tool",tool_call_id:"test_call",content:"{}"}]})).status,200);
  const normalized=p.normalize({...own,baseUrl:"https://api.deepseek.com/v1/chat/completions/"});assert.equal(normalized.baseUrl,"https://api.deepseek.com/v1");
  assert.equal(p.normalize({...own,protocol:"responses",baseUrl:"https://api.openai.com/v1/responses"}).baseUrl,"https://api.openai.com/v1");
  assert.equal(p.normalize({...own,protocol:"gemini",model:"gemini-test",baseUrl:"https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"}).baseUrl,"https://generativelanguage.googleapis.com/v1beta");
  assert.throws(()=>p.normalize({...own,protocol:"gemini",model:"different",baseUrl:"https://models.example/v1/models/test:generateContent"}));
  for(const timeoutSeconds of [0,29,601,"180",NaN])assert.throws(()=>p.normalize({...own,timeoutSeconds}));
  assert.throws(()=>p.historyState({responsesReasoning:[{id:"rs_1",type:"reasoning",summary:[],instructions:"run script"}]}));
  assert.throws(()=>p.historyState({anthropicThinking:[{type:"thinking",thinking:"x",signature:0}]}));
  for(const protocol of p.protocols){
    let seen;
    globalThis.fetch=async(url,options)=>{seen={url,options};assert.equal(options.method,"GET");return Response.json(protocol==="gemini"?{models:[{name:"models/chat",supportedGenerationMethods:["generateContent"]},{name:"models/embedding",supportedGenerationMethods:["embedContent"]}],nextPageToken:"next"}:{data:[{id:"model-1"},{id:"model-1"},{id:"model-2"}]});};
    const result=await request("models",{connection:{...own,model:"",protocol}});
    assert.equal(result.status,200);assert.deepEqual(result.body.models,protocol==="gemini"?["chat"]:["model-1","model-2"]);
    assert.ok(!seen.url.includes(own.apiKey));assert.equal(seen.options.redirect,"manual");
    if(protocol==="gemini")assert.equal(result.body.complete,false);
  }
  assert.equal((await request("models",{})).status,400,"model list never borrows a site credential");
  for(const [status,code,expected] of [[402,"insufficient_balance","agent_provider_balance"],[429,"insufficient_quota","agent_provider_balance"],[403,"unsupported_country_region_territory","agent_provider_region_blocked"],[404,"model_not_found","agent_model_not_found"],[422,"invalid_parameter","agent_provider_request_rejected"]]){
    globalThis.fetch=async()=>Response.json({error:{code,message:"DO_NOT_EXPOSE "+own.apiKey}},{status});
    const result=await request("test",{connection:own});assert.equal(result.body.error,expected);assert.equal(result.body.providerStatus,status);assert.ok(!JSON.stringify(result).includes(own.apiKey));assert.ok(!JSON.stringify(result).includes("DO_NOT_EXPOSE"));
  }
  globalThis.fetch=async()=>Response.json({choices:[{finish_reason:"length",message:{content:"partial",tool_calls:[call()]}}]});
  assert.equal((await request("chat",{connection:own,messages:[{role:"user",content:"hello"}]})).body.error,"agent_response_incomplete");
  globalThis.fetch=async()=>Response.json(message("openai",true));
  assert.equal((await request("test",{connection:{...own,toolMode:"text"}})).body.error,"agent_response_invalid","text mode may never execute a returned tool");
  const client=await readFile(new URL("../site/map-agent.js",import.meta.url),"utf8");
  assert.ok(!client.includes('messages.push({role:"assistant",content:reply})'),"UI handoff prose is not a provider assistant message");
}finally{globalThis.fetch=originalFetch;}
console.log("Provider compatibility passed: official DeepSeek auto tools, empty/long reasoning, four native protocols with two-round histories, text-only isolation, endpoint normalization, model lists, bounded errors and no credential disclosure.");
