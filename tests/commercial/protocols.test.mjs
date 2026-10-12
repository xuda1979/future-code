import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestBody, decodeTurn, providerHeaders } from '../../src/harness/foundry/swarm/model.ts';
import { validateSwarmSpec } from '../../src/harness/foundry/swarm/config.ts';
const budget={maxOutputTokens:256};
const history=[{role:'user',content:'perform a bounded task'}];
const profile=protocol=>({protocol,url:'https://model.invalid/api',model:'chosen-model',
  system:'Verify all results.',tools:['read_file','run_check'],checks:['behavior'],auth:{scheme:'raw',header:'x-user-key'},keyEnv:'FC_TEST_KEY'});
test('multiple provider protocols have distinct valid request bodies',()=>{
 for(const protocol of ['chat-completions','anthropic','responses','gemini']){
  const body=requestBody(profile(protocol),history,budget);
  if(protocol==='chat-completions'){assert.equal(body.model,'chosen-model');assert.equal(body.messages[1].content,history[0].content)}
  if(protocol==='anthropic'){assert.equal(body.system[0].text,'Verify all results.');assert.equal(body.messages[0].role,'user')}
  if(protocol==='responses'){assert.equal(body.instructions,'Verify all results.');assert.equal(body.input[0].role,'user')}
  if(protocol==='gemini'){assert.equal(body.systemInstruction.parts[0].text,'Verify all results.');assert.equal(body.contents[0].role,'user')}
 }
});
test('response adapters decode tool calls without claiming correctness',()=>{
 const openai={status:'completed',output:[{type:'function_call',name:'read_file',call_id:'id-1',arguments:'{"path":"README.md"}'}],usage:{input_tokens:8,output_tokens:4}};
 const r=decodeTurn('responses',openai);
 assert.equal(r.message.calls[0].name,'read_file');assert.equal(r.tokens,12);
 const google={candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'run_check',args:{name:'behavior'}}}]}}],usageMetadata:{promptTokenCount:11,candidatesTokenCount:5}};
 const g=decodeTurn('gemini',google);
 assert.equal(g.message.calls[0].arguments.name,'behavior');assert.equal(g.tokens,16);
});
test('unsupported provider output blocks and malformed tool calls fail closed',()=>{
 assert.throws(()=>decodeTurn('responses',{status:'completed',output:[{type:'undocumented'}]}),/Unsupported/);
 assert.throws(()=>decodeTurn('gemini',{candidates:[{finishReason:'UNKNOWN',content:{parts:[]}}]}),/unsupported/);
});
test('header injection is restricted and API secrets are not returned without configuration',()=>{
 process.env.FC_TEST_KEY='example-temporary-secret';
 try{
  const h=providerHeaders('responses',profile('responses'));assert.equal(h['x-user-key'],'example-temporary-secret');
  assert.equal(providerHeaders('anthropic',{url:'https://example.invalid',model:'m'} )['anthropic-version'],'2023-06-01');
  assert.throws(()=>providerHeaders('responses',{url:'https://example.invalid',model:'m',keyEnv:'FC_TEST_KEY',auth:{scheme:'raw',header:'cookie'}}),/invalid provider authentication/);
  assert.equal(providerHeaders('chat-completions',{url:'https://example.invalid',model:'m',auth:{scheme:'none',header:'authorization'}}).authorization,undefined);
 }finally{delete process.env.FC_TEST_KEY}
});
test('provider schema permits new wire protocols but disallows credential forwarding to checks',()=>{
 const check={argv:[process.execPath,'-e','process.exit(0)'],replaySafe:true};
 const base={schema:1,name:'local-commercial',project:'.',baseRef:'HEAD',defaultAgent:'a',
  agents:{a:{...profile('responses'),system:'test',tools:['read_file'],checks:['behavior']}},
  checks:{behavior:check},integrationChecks:['behavior'],protectedPaths:['private'],
  limits:{parallelism:2,attempts:1,contextBytes:65536,outputBytes:32768,timeoutMs:60000,tasks:2},
  recipe:{parallelism:1,attempts:1,contextBytes:32768,timeoutMs:30000},
  budget:{maxRequests:4,maxRequestBytes:262144,maxTurns:4,maxToolCalls:8,modelConcurrency:1,
    requestTimeoutMs:10000,toolTimeoutMs:10000,maxOutputTokens:128,maxToolOutputBytes:65536,maxPatchBytes:65536}};
 assert.doesNotThrow(()=>validateSwarmSpec(base));
 assert.throws(()=>validateSwarmSpec({...base,checks:{behavior:{...check,envAllow:['FC_TEST_KEY']}}}),/model credentials may not be forwarded/);
});
