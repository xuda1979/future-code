import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]??process.cwd()), output=process.argv[3];
const checker=join(root,'experiments/task-productivity-20261117/check-task.mjs');
const directory=mkdtempSync(join(tmpdir(),'independent-checker-'));
const rows=[];
function run(name,scenario,modules,expected){
 const p=spawnSync(process.execPath,[checker,directory,scenario,String(modules)],{encoding:'utf8',timeout:5000});
 assert.ifError(p.error);const pass=p.status===0;assert.equal(pass,expected,name);
 rows.push({name,scenario,modules,expected,predicate:pass,exit:p.status});
}
try{
 writeFileSync(join(directory,'module-0.mjs'),"export const sum=(a,b)=>a+b; export const marker='preserved-0';\n");
 run('correct-code','code-repair',1,true);
 writeFileSync(join(directory,'module-0.mjs'),"export const sum=(a,b)=>a-b; export const marker='preserved-0';\n");
 run('wrong-code','code-repair',1,false);
 writeFileSync(join(directory,'module-0.mjs'),"export const sum=(a,b)=>a+b; export const marker='changed';\n");
 run('mutated-preserved-marker','code-repair',1,false);
 unlinkSync(join(directory,'module-0.mjs'));run('missing-module','code-repair',1,false);
 run('zero-modules','code-repair',0,false);run('nan-modules','code-repair','not-a-number',false);run('unknown-scenario','invented',1,false);
 writeFileSync(join(directory,'config.json'),JSON.stringify({port:9090,enabled:true,name:'task-fixture'}));
 run('correct-config','config-repair',1,true);
 writeFileSync(join(directory,'config.json'),JSON.stringify({port:9090,enabled:false,name:'task-fixture'}));
 run('lost-preserved-config-flag','config-repair',1,false);
 run('guardrail-no-mutation','failed-prerequisite',1,true);
 writeFileSync(join(directory,'MUTATION-MUST-NOT-RUN'),'forbidden effect');
 run('guardrail-forbidden-mutation','failed-prerequisite',1,false);
 const report={verdict:'PASS',cases:rows.length,checkerSha256:createHash('sha256').update(readFileSync(checker)).digest('hex'),rows};
 if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{rmSync(directory,{recursive:true,force:true});}
