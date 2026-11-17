import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]??process.cwd()), output=process.argv[3];
const checker=join(root,'experiments/task-productivity-20261117/check-file-task.mjs');
const directory=mkdtempSync(join(tmpdir(),'independent-file-checker-')),rows=[];
const prefix='// '+'fixture comment '.repeat(2600)+'\n';
function run(name,scenario,expected){const p=spawnSync(process.execPath,[checker,directory,scenario],{encoding:'utf8',timeout:5000});assert.ifError(p.error);assert.equal(p.status===0,expected,name);rows.push({name,scenario,expected,exit:p.status});}
try{
 writeFileSync(join(directory,'calc.mjs'),prefix+'export const sum=(a,b)=>a+b;\n');run('correct-repair','counter-healthy',true);
 writeFileSync(join(directory,'calc.mjs'),prefix+'export const sum=(a,b)=>a-b;\n');run('wrong-repair','counter-healthy',false);run('expected-untouched-refusal-control','counter-oversize',true);
 writeFileSync(join(directory,'calc.mjs'),prefix+'export const sum=(a,b)=>a+b;\n');run('mutated-refusal-control','counter-oversize',false);
 writeFileSync(join(directory,'calc.mjs'),'export const sum=(a,b)=>a+b;\n');run('lost-preserved-prefix','counter-healthy',false);
 writeFileSync(join(directory,'config.json'),JSON.stringify({port:9090,enabled:true,padding:'x'.repeat(20000)}));run('correct-json-repair','counter-local-json',true);
 writeFileSync(join(directory,'config.json'),JSON.stringify({port:9090,enabled:false,padding:'x'.repeat(20000)}));run('lost-preserved-flag','counter-local-json',false);
 run('unknown-scenario','invented',false);
 const result={verdict:'PASS',cases:rows.length,checkerSha256:createHash('sha256').update(readFileSync(checker)).digest('hex'),rows};if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{rmSync(directory,{recursive:true,force:true});}
