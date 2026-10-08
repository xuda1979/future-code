import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compareAgents,validateConfig,summarize} from "../../scripts/compare-agent-productivity.mjs";
const git=(cwd,args)=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"agent-compare-")),repo=join(root,"repo");
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(repo);
 git(repo,["init","-q"]);
 git(repo,["config","user.email","fixture@example.test"]);
 git(repo,["config","user.name","Fixture"]);
 writeFileSync(join(repo,"calc.cjs"),"exports.add=(a,b)=>a-b;\n");
 mkdirSync(join(repo,"tests"));
 writeFileSync(join(repo,"tests/check.cjs"),'if(require("../calc.cjs").add(3,2)!==5){console.error("BROKEN_ARITHMETIC_CONTROL");process.exit(1)}\n');
 git(repo,["add","."]);git(repo,["commit","-qm","broken baseline"]);
 const baseCommit=git(repo,["rev-parse","HEAD"]);
 const config={schema:1,mode:"offline-fixture",repository:repo,baseCommit,repetitions:1,
  cases:[{id:"repair",tier:"simple",instruction:"Repair the incorrect addition function in calc.cjs.",
    check:["node","tests/check.cjs"],redMarker:"BROKEN_ARITHMETIC_CONTROL",
    protectedPaths:["tests"],allowedPaths:["calc.cjs"],timeoutMs:3000}],
  agents:[{name:"future-code",model:"offline",version:"mock",argv:["node","-e",
    'require("node:fs").writeFileSync("calc.cjs","exports.add=(a,b)=>a+b;\\n")']},
   {name:"codex",model:"offline",version:"mock",argv:["node","-e","void 0"]}]};
 return {root,repo,config};
}
test("red/green isolated repair with tracked evidence",async t=>{
 const f=fixture(t),r=await compareAgents(f.config,join(f.root,"results"));
 assert.equal(r.decision,"OFFLINE_FIXTURE_ONLY");
 assert.deepEqual(r.trials.map(x=>x.status),["PASS","FAIL"]);
 assert(r.trials.every(x=>x.redExitCode===1));
 assert.equal(r.agents[0].verified,1);
 assert.equal(r.agents[0].billedUsd,null);
 assert.equal(readFileSync(join(f.repo,"calc.cjs"),"utf8"),"exports.add=(a,b)=>a-b;\n");
 assert.deepEqual(JSON.parse(readFileSync(join(f.root,"results","report.json"))).trials.map(x=>x.status),["PASS","FAIL"]);
 assert.throws(()=>validateConfig({...f.config,baseCommit:"main"}));
});
test("tampered independent check cannot pass",async t=>{
 const f=fixture(t);
 f.config.agents[0].argv=["node","-e",
  'const fs=require("node:fs");fs.writeFileSync("calc.cjs","exports.add=(a,b)=>a+b;\\n");fs.writeFileSync("tests/check.cjs","process.exit(0)\\n")'];
 const r=await compareAgents(f.config,join(f.root,"tampered"));
 assert.equal(r.trials[0].status,"FAIL");
 assert.match(r.trials[0].failure,/protected\/unapproved paths/);
});
test("already passing baseline must be VOID",async t=>{
 const f=fixture(t);f.config.cases[0].check=["node","-e","process.exit(0)"];
 const r=await compareAgents(f.config,join(f.root,"vacuous"));
 assert(r.trials.every(x=>x.status==="VOID"&&x.agentExitCode===null));
});
test("timeout does not count as solved",async t=>{
 const f=fixture(t);
 f.config.cases[0].timeoutMs=150;
 f.config.agents[0].argv=["node","-e","setTimeout(()=>{},5000)"];
 const r=await compareAgents(f.config,join(f.root,"timeout"));
 assert.equal(r.trials[0].status,"TIMEOUT");
 assert.equal(r.agents[0].verified,0);
});
test("fewer than 3 live reps gives no comparative finding",t=>{
 const f=fixture(t),config={...f.config,mode:"live",repetitions:2};
 const r=summarize([{agent:"future-code",status:"PASS",wallClockMs:10},
                    {agent:"codex",status:"PASS",wallClockMs:20}],config);
 assert.equal(r.decision,"INSUFFICIENT_VALID_LIVE_EVIDENCE");
});
test("uninstalled agent marked UNAVAILABLE",async t=>{
 const f=fixture(t);f.config.mode="live";f.config.repetitions=3;
 f.config.agents[0].argv=["nonexistent-agent-comparison-2026"];
 const r=await compareAgents(f.config,join(f.root,"missing"));
 assert.equal(r.decision,"INSUFFICIENT_VALID_LIVE_EVIDENCE");
 assert(r.trials.filter(x=>x.agent==="future-code").every(x=>x.status==="UNAVAILABLE"));
});
test("wrong red error is VOID",async t=>{
 const f=fixture(t);f.config.cases[0].check=["node","-e","process.exit(3)"];
 const r=await compareAgents(f.config,join(f.root,"wrong-red"));
 assert(r.trials.every(x=>x.status==="VOID"));
});
test("output within project rejected",async t=>{
 const f=fixture(t);
 await assert.rejects(compareAgents(f.config,join(f.repo,"result")),/results must be outside/);
});
