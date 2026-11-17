import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]??process.cwd()),output=process.argv[3];
const {default:Future}=await import(pathToFileURL(join(root,'node_modules/@future/sdk/index.mjs')));
const {countFileReadTokens}=await import(pathToFileURL(join(root,'src/tools/FileReadTool/tokenBudget.ts')));
register(pathToFileURL(join(root,'tests/correctness/file-read-token-count-loader.mjs')),import.meta.url);
const {countTokensWithAPI}=await import(pathToFileURL(join(root,'src/services/tokenEstimation.ts')));
let requests=0, closed=false, requestPath;
const server=createServer((request,response)=>{
 requests++;requestPath=request.url;request.resume();response.on('close',()=>{closed=true;});
 // Deliberately never send count-token response; only this auxiliary service hangs.
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {port}=server.address();
const client=new Future({apiKey:'nonsecret-local-fixture',baseURL:`http://127.0.0.1:${port}`,maxRetries:1,timeout:600000});
globalThis.__fileReadTokenCountTest={provider:'firstParty',errors:[],init:async()=>client};
const start=performance.now();
try {
 const count=await countFileReadTokens('x'.repeat(30),10,countTokensWithAPI);
 const elapsedMs=performance.now()-start;
 assert.equal(count,30);assert.equal(requests,1);assert.equal(requestPath,'/v1/messages/count_tokens?beta=true');
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(closed,true,'SDK abort must close upstream socket');
 assert.deepEqual(globalThis.__fileReadTokenCountTest.errors,[]);
 const result={verdict:'PASS',count,requests,closed,elapsedMs,requestPath};
 if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
} finally {
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));delete globalThis.__fileReadTokenCountTest;
}
