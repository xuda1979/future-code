#!/usr/bin/env node
/** Matched, fail-closed repository-edit benchmark; no simulated coding wins. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn,execFileSync} from "node:child_process";
import {existsSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {resolve,dirname,sep,join} from "node:path";
import {performance} from "node:perf_hooks";
import {pathToFileURL} from "node:url";
const sha=s=>createHash("sha256").update(s).digest("hex");
const git=(cwd,args)=>execFileSync("git",args,{cwd,encoding:"utf8",maxBuffer:4e6}).trim();
const substitute=(xs,p)=>xs.map(x=>x.replace(/\{(workspace|prompt|suite_dir|result_dir|run_id)\}/g,(_,key)=>p[key]));
const scope=s=>typeof s==="string"&&s.length>0&&!s.startsWith("/")&&!s.includes("\\")&&!s.split("/").some(p=>!p||["..",".",".git"].includes(p));
const contains=(name,dirs)=>dirs.some(p=>name===p||name.startsWith(p+"/"));
export function validateConfig(c){
 assert.equal(c.schema,1);
 assert(["live","offline-fixture"].includes(c.mode));
 assert(typeof c.repository==="string"&&c.repository.length>0);
 assert(/^[a-f0-9]{40}$/.test(c.baseCommit));
 assert(Number.isInteger(c.repetitions)&&c.repetitions>0&&c.repetitions<=20);
 assert(Array.isArray(c.agents)&&c.agents.length>=2&&c.agents.length<=8);
 assert(Array.isArray(c.cases)&&c.cases.length>0&&c.cases.length<=32);
 assert(new Set(c.agents.map(a=>a.name)).size===c.agents.length,"duplicate agents");
 assert(new Set(c.cases.map(a=>a.id)).size===c.cases.length,"duplicate cases");
 for(const a of c.agents){
  assert(/^[\w-]+$/.test(a.name));
  assert(Array.isArray(a.argv)&&a.argv.length>0&&a.argv.every(s=>typeof s==="string"&&s.length));
  assert(a.model&&a.version,"pin model and agent version");
 }
 for(const t of c.cases){
  assert(/^[\w-]+$/.test(t.id)&&["simple","medium","research"].includes(t.tier));
  assert(typeof t.instruction==="string"&&t.instruction.length>=10);
  assert(Array.isArray(t.check)&&t.check.length>0&&t.check.every(x=>typeof x==="string"));
  assert(typeof t.redMarker==="string"&&t.redMarker.length>=8);
  assert(Array.isArray(t.allowedPaths)&&t.allowedPaths.length>0&&t.allowedPaths.every(scope));
  assert(Array.isArray(t.protectedPaths)&&t.protectedPaths.length>0&&t.protectedPaths.every(scope));
  assert(Number.isInteger(t.timeoutMs)&&t.timeoutMs>=100&&t.timeoutMs<=86400000);
 }
 return c;
}
async function execute(argv,cwd,deadline,output,env={}){
 let stdout="",stderr="",error=null,timedOut=false;
 const start=performance.now();
 const child=spawn(argv[0],argv.slice(1),{cwd,shell:false,detached:process.platform!=="win32",env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});
 const bounded=(field,data)=>{if(field==="stdout")stdout=(stdout+data).slice(0,65536);else stderr=(stderr+data).slice(0,65536);};
 child.stdout.on("data",x=>bounded("stdout",x.toString()));
 child.stderr.on("data",x=>bounded("stderr",x.toString()));
 const kill=()=>{try{if(process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}};
 const timer=setTimeout(()=>{timedOut=true;kill();},deadline);
 const status=await new Promise(done=>{child.on("error",e=>{error=e.message;done(null)});child.on("close",code=>done(code))});
 clearTimeout(timer);
 writeFileSync(output+".stdout.log",stdout,{mode:0o600});
 writeFileSync(output+".stderr.log",stderr,{mode:0o600});
 return {status,timedOut,error,elapsedMs:performance.now()-start,stdout,stderr};
}
const median=xs=>{const a=[...xs].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2};
export function summarize(trials,config){
 const agents=config.agents.map(a=>{
  const rows=trials.filter(t=>t.agent===a.name),verified=rows.filter(t=>t.status==="PASS").length;
  const wallClockMs=rows.reduce((n,t)=>n+t.wallClockMs,0);
  return {agent:a.name,model:a.model,version:a.version,total:rows.length,verified,failed:rows.length-verified,
   passRate:verified/rows.length,wallClockMs,medianTrialMs:median(rows.map(r=>r.wallClockMs)),
   verifiedTasksPerHour:wallClockMs?verified*3600000/wallClockMs:null,providerTokens:null,billedUsd:null};
 });
 const eligible=config.mode==="live"&&config.repetitions>=3&&trials.every(t=>["PASS","FAIL","TIMEOUT"].includes(t.status));
 return {agents,decision:config.mode!=="live"?"OFFLINE_FIXTURE_ONLY":eligible?"OBSERVATIONAL_RESULTS_ONLY":"INSUFFICIENT_VALID_LIVE_EVIDENCE",
 claim:"No causal/general advantage established; provider usage and billing are unverified."};
}
export async function compareAgents(config,outputDir){
 validateConfig(config);
 const repo=resolve(config.repository),root=resolve(outputDir),suiteDir=resolve(config.suiteDir??process.cwd());
 assert(!existsSync(root),"output directory already exists");
 assert(root!==repo&&!root.startsWith(repo+sep),"results must be outside the source repository");
 assert.equal(git(repo,["rev-parse",config.baseCommit+"^{commit}"]),config.baseCommit);
 mkdirSync(root,{recursive:true});
 const configHash=sha(JSON.stringify(config)),trials=[];
 const flush=()=>writeFileSync(join(root,"trials.json"),JSON.stringify({configHash,trials},null,2)+"\n");
 for(let repetition=0;repetition<config.repetitions;repetition++)
 for(const task of config.cases)
 for(let i=0;i<config.agents.length;i++){
  const agent=config.agents[(i+repetition)%config.agents.length];
  const runId="r"+repetition+"-"+task.id+"-"+agent.name;
  const directory=join(root,runId),workspace=join(directory,"worktree");
  const params={run_id:runId,result_dir:directory,workspace,suite_dir:suiteDir,prompt:join(directory,"prompt.txt")};
  mkdirSync(directory,{recursive:true});
  const started=performance.now();
  const row={runId,agent:agent.name,caseId:task.id,repetition,tier:task.tier,status:"ERROR",
   redExitCode:null,agentExitCode:null,checkExitCode:null,changedPaths:[],wallClockMs:0,failure:null};
  let attached=false;
  try{
   git(repo,["worktree","add","--quiet","--detach",workspace,config.baseCommit]);attached=true;
   assert.equal(git(workspace,["status","--porcelain"]),"");
   const red=await execute(substitute(task.check,params),workspace,Math.min(30000,task.timeoutMs),join(directory,"red"),{PYTHONDONTWRITEBYTECODE:"1"});
   row.redExitCode=red.status;
   if(red.timedOut||red.error||red.status!==1||!(red.stdout+red.stderr).includes(task.redMarker)||
      git(workspace,["status","--porcelain"])!==""){
    row.status="VOID";row.failure="known failing regression not reproduced cleanly";
   }else{
    writeFileSync(params.prompt,task.instruction+"\n",{mode:0o600});
    const done=await execute(substitute(agent.argv,params),workspace,task.timeoutMs,join(directory,"agent"),{
     AGENT_BENCH_PROMPT:params.prompt,AGENT_BENCH_WORKSPACE:workspace,
     AGENT_BENCH_RESULT_DIR:directory,AGENT_BENCH_RUN_ID:runId
    });
    row.agentExitCode=done.status;
    row.changedPaths=[...new Set([
      ...git(workspace,["diff","--name-only","-z",config.baseCommit]).split("\0"),
      ...git(workspace,["ls-files","--others","--exclude-standard","-z"]).split("\0")
    ].filter(Boolean))].sort();
    const denied=row.changedPaths.filter(p=>contains(p,task.protectedPaths)||!contains(p,task.allowedPaths));
    if(denied.length){row.status="FAIL";row.failure="protected/unapproved paths modified: "+denied.join(", ")}
    else if(done.timedOut){row.status="TIMEOUT";row.failure="agent exceeded deadline"}
    else if(done.error){row.status="UNAVAILABLE";row.failure="agent executable unavailable"}
    else if(done.status!==0){row.status="FAIL";row.failure="agent exited unsuccessfully"}
    else if(!row.changedPaths.length){row.status="FAIL";row.failure="no source change"}
    else{
     const check=await execute(substitute(task.check,params),workspace,Math.min(30000,task.timeoutMs),join(directory,"check"),{PYTHONDONTWRITEBYTECODE:"1"});
     row.checkExitCode=check.status;
     row.status=!check.error&&!check.timedOut&&check.status===0?"PASS":"FAIL";
     if(row.status!=="PASS")row.failure="independent checker failed";
    }
    const diff=git(workspace,["diff","--binary",config.baseCommit]);
    writeFileSync(join(directory,"changes.patch"),diff,{mode:0o600});row.patchHash=sha(diff);
   }
  }catch(e){row.failure=String(e.message??e)}
  finally{
   if(attached)try{git(repo,["worktree","remove","--force",workspace])}catch(e){row.status="ERROR";row.failure="cleanup: "+e.message}
   row.wallClockMs=performance.now()-started;trials.push(row);flush();
  }
 }
 const summary=summarize(trials,config);
 const report={schema:1,type:"paired-real-repository-agent-evaluation",generatedAt:new Date().toISOString(),
   sourceCommit:config.baseCommit,configHash,mode:config.mode,repetitions:config.repetitions,
   cases:config.cases.map(t=>({id:t.id,tier:t.tier,instructionHash:sha(t.instruction),check:t.check,
    redMarker:t.redMarker,allowedPaths:t.allowedPaths,protectedPaths:t.protectedPaths})),...summary,trials};
 writeFileSync(join(root,"report.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--config"||args[2]!=="--out"){
  console.error("Usage: node scripts/compare-agent-productivity.mjs --config FILE --out NEW_DIR");process.exitCode=2;
 }else{
  const config=JSON.parse(readFileSync(resolve(args[1]),"utf8"));
  config.suiteDir??=dirname(resolve(args[1]));
  compareAgents(config,args[3]).then(report=>{
   console.log(JSON.stringify({decision:report.decision,agents:report.agents,report:resolve(args[3],"report.json")},null,2));
   if(report.trials.some(t=>t.status!=="PASS"))process.exitCode=2;
  },e=>{console.error(e.stack??e);process.exitCode=1});
 }
}
