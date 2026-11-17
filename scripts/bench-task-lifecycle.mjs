#!/usr/bin/env node
/** Scripted real-artifact tasks through production goal lifecycle APIs.
 * No live model is used; timings cannot rank model or agent productivity. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url), candidate = resolve(dirname(self), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const scenarios = ['amendment-rewrite-restart', 'current-status-vs-history', 'post-review-amendment',
  'verified-completion', 'required-incomplete', 'pause-resume', 'continuous-loop', 'finite-loop',
  'session-isolation', 'git-delivery-restart'];
const defectCases = scenarios.slice(0, 3);
const sourcePaths = ['src/commands/goal/auto.ts', 'src/harness/autonomyPolicy.ts',
  'src/harness/decisionGuidance.ts', 'src/utils/autoGoalSession.ts', 'src/utils/autoGoalSessionId.ts',
  'src/utils/workloadContext.ts', 'src/commands/loop/task.ts', 'src/utils/permissions/interactivePrompts.ts'];
const sourceHashes = source => Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(join(source, p)))]));
const original = 'preserve the requested bytes\n';
const readme = 'The requested file is new.txt. Its bytes are preserved.\n';

// This process independently reads the persisted artifacts. It never calls
// producer helpers, goal-report parsers, or the host's acceptance functions.
const checker = `
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const [cwd,root,kind]=process.argv.slice(1);
const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
 if(['rename','amendment'].includes(kind)) {
  assert.equal(existsSync(join(cwd,'old.txt')),false);
  assert.equal(readFileSync(join(cwd,'new.txt'),'utf8'),'preserve the requested bytes\\n');
  if(kind==='amendment') {
   assert(existsSync(join(cwd,'README.md')),'required README is missing');
   assert.equal(readFileSync(join(cwd,'README.md'),'utf8'),'The requested file is new.txt. Its bytes are preserved.\\n');
  }
 } else if(kind==='sessions') {
  assert.equal(existsSync(join(cwd,'old.txt')),false);
  assert.equal(readFileSync(join(cwd,'new.txt'),'utf8'),'preserve the requested bytes\\n');
  assert.deepEqual(JSON.parse(readFileSync(join(cwd,'config.json'),'utf8')),{port:9090,enabled:true});
 } else if(kind==='git') {
  assert.equal(readFileSync(join(cwd,'change.txt'),'utf8'),'requested change\\n');
  assert.equal(git(cwd,'rev-parse','HEAD'),git(join(root,'remote.git'),'rev-parse','refs/heads/main'));
  assert.equal(git(join(root,'remote.git'),'show','refs/heads/main:change.txt'),'requested change');
  assert.equal(git(cwd,'rev-list','--count','HEAD'),'1');
  assert.equal(git(cwd,'status','--porcelain'),'');
  assert.equal(readFileSync(join(root,'hook-count'),'utf8'),'hook\\n');
 } else {
  assert.deepEqual(JSON.parse(readFileSync(join(cwd,'config.json'),'utf8')),{port:9090,enabled:true});
  if(kind==='cycles')assert.equal(readFileSync(join(cwd,'heartbeats.txt'),'utf8'),'cycle\\ncycle\\ncycle\\n');
 }
 process.stdout.write(JSON.stringify({result:'PASS'}));
} catch(error) {
 if(error.code!=='ERR_ASSERTION'&&error.code!=='ENOENT')throw error;
 process.stdout.write(JSON.stringify({result:'FAIL',detail:error.message.slice(0,200)}));process.exitCode=3;
}
`;

function child(args) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', self, ...args],
    { encoding:'utf8', timeout:20000, maxBuffer:1_000_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function apiAt(source) { return import(pathToFileURL(join(source, 'src/commands/goal/auto.ts'))); }
async function sessionAt(source) { return import(pathToFileURL(join(source, 'src/utils/autoGoalSession.ts'))); }
const decide = (api, cwd) => api.decideAutoGoalContinuation({ cwd, mainThread:true, withinTurnBudget:true,
  assistantText:'Inspect the requested artifacts and the current objective.', toolActivity:true });

async function probe(source, scenario) {
  const api = await apiAt(source), sessions = await sessionAt(source);
  const root = mkdtempSync(join(tmpdir(), 'task-lifecycle-')), cwd = join(root, 'work'); mkdirSync(cwd);
  const observations = [], checks = [];
  let requestedEdits = 0, restarts = 0, prematureReview = false, contractPass = true;
  function check(kind) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', checker, cwd, root, kind],
      {encoding:'utf8',timeout:5000});
    assert.ifError(r.error); assert([0,3].includes(r.status), r.stderr);
    const verdict = JSON.parse(r.stdout); checks.push({kind,...verdict}); return verdict.result;
  }
  function observe(label, restart = false, id = null) {
    let decision, state, reportSha256;
    if(restart) { restarts++; ({decision,state,reportSha256}=child(['--decision',source,cwd,id??''])); }
    else {
      decision=decide(api,cwd); state=api.readAutoGoal(cwd);
      reportSha256=hash(readFileSync(api.autoGoalReportPath(cwd)));
    }
    const row={label,decision:decision.kind,state:state?.state??null,
      rootObjective:state?.goal??null,steering:state?.activeSteering??[],lifetimeLimit:state?.maxContinuations??null,
      reason:decision.reason??null,totalContinuations:state?.totalContinuations??null,reportSha256};
    observations.push(row); return row;
  }
  const report = (goal,status,ledger='',tail='') => {
    const text='# '+goal+'\nStatus: '+status+'\n## Milestones\n'+ledger+tail;
    writeFileSync(api.autoGoalReportPath(cwd),text); return text;
  };
  const rename = () => { writeFileSync(join(cwd,'old.txt'),original); renameSync(join(cwd,'old.txt'),join(cwd,'new.txt')); requestedEdits++; };
  const config = port => writeFileSync(join(cwd,'config.json'),JSON.stringify({port,enabled:true}));
  try {
    let expectedCheck, finalCheck;
    if(scenario==='amendment-rewrite-restart'||scenario==='post-review-amendment') {
      const goal='Rename old.txt to new.txt'; api.enableAutoGoal(goal,cwd); rename();
      assert.equal(check('rename'),'PASS');
      const old=report(goal,'completed','- [x] Rename and independently verify the file\n');
      if(scenario==='post-review-amendment') {
        assert.equal(observe('initial-request-complete').state,'REVIEW');
        api.resumeAutoGoalFromInput('Also create README.md documenting the rename.',{cwd,mainThread:true,autoArm:true});
      } else {
        api.recordGoalSteering('Also create README.md documenting the rename.',cwd);
        assert.equal(observe('new-instruction-before-rewrite').decision,'CONTINUE');
      }
      assert.equal(check('amendment'),'FAIL');
      writeFileSync(api.autoGoalReportPath(cwd),old);
      const after=observe('old-completion-rewritten-after-amendment',true);
      prematureReview=after.state==='REVIEW';
      contractPass=!prematureReview&&after.decision==='CONTINUE';
      // The scripted worker obeys the actual host decision. A retired goal
      // cannot get missing work performed by an unconditional fixture action.
      if(after.decision==='CONTINUE') {
        writeFileSync(join(cwd,'README.md'),readme); requestedEdits++;
        assert.equal(check('amendment'),'PASS');
        report(goal,'completed','- [x] Rename and independently verify the file\n- [x] Create and verify the requested README\n');
        contractPass&&=observe('amended-request-complete',true).state==='REVIEW';
      }
      finalCheck=check('amendment'); expectedCheck='PASS';
    } else if(scenario==='current-status-vs-history') {
      const goal='Set port to 9090 in config.json'; api.enableAutoGoal(goal,cwd); config(8080);
      report(goal,'in_progress','','## Worklog\nPrevious independent task:\nStatus: completed\n');
      assert.equal(check('config'),'FAIL');
      const before=observe('current-in-progress-with-completed-history',true);
      prematureReview=before.state==='REVIEW'; contractPass=!prematureReview&&before.decision==='CONTINUE';
      if(before.decision==='CONTINUE') {
        config(9090); requestedEdits++; assert.equal(check('config'),'PASS');
        report(goal,'completed','- [x] Write and verify requested port\n');
        contractPass&&=observe('requested-config-complete').state==='REVIEW';
      }
      finalCheck=check('config'); expectedCheck='PASS';
    } else if(scenario==='required-incomplete') {
      const goal='Rename old.txt and create README.md'; api.enableAutoGoal(goal,cwd); rename();
      report(goal,'completed','- [x] Rename the file\n- [ ] Create the required README.md\n');
      assert.equal(check('amendment'),'FAIL');
      contractPass=observe('required-work-remains').decision==='CONTINUE'&&
        observe('required-work-remains-after-restart',true).state==='ACTIVE';
      finalCheck=check('amendment'); expectedCheck='FAIL';
    } else if(scenario==='session-isolation') {
      let selected='session-A'; sessions.configureAutoGoalSession(()=>selected);
      const runA=sessions.runWithAutoGoalSession(async()=>{
        await Promise.resolve(); const goal='Rename old.txt to new.txt'; api.enableAutoGoal(goal,cwd); rename();
        report(goal,'completed','- [x] Rename and verify bytes\n'); return observe('session-A-complete');
      });
      selected='session-B';
      const runB=sessions.runWithAutoGoalSession(async()=>{
        await Promise.resolve(); const goal='Set port to 9090 in config.json'; api.enableAutoGoal(goal,cwd);config(9090);requestedEdits++;
        report(goal,'completed','- [x] Update and verify config\n'); return observe('session-B-complete');
      });
      const rows=await Promise.all([runA,runB]); sessions.configureAutoGoalSession(undefined);
      const restoredA=observe('session-A-restart',true,'session-A'),restoredB=observe('session-B-restart',true,'session-B');
      contractPass=rows.every(row=>row.state==='REVIEW')&&restoredA.state==='REVIEW'&&restoredB.state==='REVIEW'&&
        restoredA.rootObjective==='Rename old.txt to new.txt'&&restoredB.rootObjective==='Set port to 9090 in config.json';
      finalCheck=check('sessions'); expectedCheck='PASS';
    } else if(scenario==='git-delivery-restart') {
      const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
      git('init','--quiet','--initial-branch=main');
      git('init','--quiet','--bare',join(root,'remote.git'));
      git('config','user.name','Task Lifecycle Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
      git('remote','add','origin',join(root,'remote.git'));
      writeFileSync(join(cwd,'.git/info/exclude'),'/.future-code/\n');
      const hookPath=join(root,'hook-count').replace(/'/g,"'\\''");
      writeFileSync(join(cwd,'.git/hooks/pre-commit'),"#!/bin/sh\nprintf 'hook\\n' >> '"+hookPath+"'\n",{mode:0o755});
      const goal='Create change.txt, verify it, commit and push to origin/main';api.enableAutoGoal(goal,cwd);
      writeFileSync(join(cwd,'change.txt'),'requested change\n');requestedEdits++;
      git('add','--','change.txt');git('commit','--quiet','-m','Apply requested change');git('push','--quiet','origin','HEAD:refs/heads/main');
      assert.equal(check('git'),'PASS');
      report(goal,'completed','- [x] Write and verify change\n- [x] Commit and verify remote delivery\n');
      contractPass=observe('delivered-request-complete').state==='REVIEW'&&
        observe('delivered-request-after-restart',true).decision==='SKIP';
      finalCheck=check('git'); expectedCheck='PASS';
    } else {
      const goal=scenario==='continuous-loop'?'/loop check config and append heartbeat':
        scenario==='finite-loop'?'/loop set port to 9090 stop: the configured port is 9090':'Set port to 9090 in config.json';
      if(scenario.endsWith('-loop'))api.resumeAutoGoalFromInput(goal,{cwd,mainThread:true,loopMode:'builtin'});
      else api.enableAutoGoal(goal,cwd);
      config(8080);
      if(scenario==='pause-resume') {
        api.pauseAutoGoal(cwd);contractPass=observe('operator-paused',true).decision==='SKIP';
        api.resumeAutoGoalFromInput('continue',{cwd,mainThread:true});
        contractPass&&=api.readAutoGoal(cwd)?.state==='ACTIVE';
      }
      config(9090);requestedEdits++;assert.equal(check('config'),'PASS');
      if(scenario==='continuous-loop') {
        let beats='';
        for(let i=0;i<3;i++) {
          beats+='cycle\n';writeFileSync(join(cwd,'heartbeats.txt'),beats);
          report(goal,'completed','- [x] Independently verify this cycle\n');
          contractPass&&=observe('cycle-'+(i+1)).decision==='CONTINUE';
        }
        contractPass&&=observe('standing-loop-after-restart',true).state==='ACTIVE';
        finalCheck=check('cycles');
      } else {
        report(goal,'completed','- [x] Set and verify requested port\n');
        contractPass&&=observe('verified-request-complete').state==='REVIEW'&&
          observe('verified-request-after-restart',true).decision==='SKIP';
        finalCheck=check('config');
      }
      expectedCheck='PASS';
    }
    contractPass&&=finalCheck===expectedCheck;
    assert(observations.length>0&&observations.every(row=>row.rootObjective&&row.lifetimeLimit===null),
      'goal authority must exist and keep its default unlimited lifetime');
    const artifacts=Object.fromEntries(['new.txt','README.md','config.json','change.txt','heartbeats.txt']
      .filter(p=>existsSync(join(cwd,p))).map(p=>[p,hash(readFileSync(join(cwd,p)))]));
    return {scenario,contractVerdict:contractPass?'PASS':'FAIL',finalArtifactCheck:finalCheck,
      expectedArtifactCheck:expectedCheck,prematureReview,requestedEdits,restarts,checks,observations,artifacts};
  } finally { sessions.configureAutoGoalSession(undefined);rmSync(root,{recursive:true,force:true}); }
}

if(process.argv[2]==='--decision') {
  const [source,cwd,id]=process.argv.slice(3),api=await apiAt(source),sessions=await sessionAt(source);
  if(id)sessions.configureAutoGoalSession(()=>id);
  process.stdout.write(JSON.stringify({decision:decide(api,cwd),state:api.readAutoGoal(cwd),
    reportSha256:hash(readFileSync(api.autoGoalReportPath(cwd)))}));
} else if(process.argv[2]==='--probe') {
  const [source,scenario]=process.argv.slice(3);assert(scenarios.includes(scenario));
  process.stdout.write(JSON.stringify(await probe(resolve(source),scenario)));
} else {
  const [baseline,output,count='3']=process.argv.slice(2),samples=Number(count);
  assert(baseline&&output,'Usage: node --experimental-strip-types scripts/bench-task-lifecycle.mjs BASELINE OUTPUT [SAMPLES=3]');
  assert(Number.isSafeInteger(samples)&&samples>0&&samples<=10);
  const sources={baseline:resolve(baseline),candidate};
  const hashes=Object.fromEntries(Object.entries(sources).map(([arm,source])=>[arm,sourceHashes(source)]));
  const fixtureSha256=hash(readFileSync(self)),runs=[];
  for(let sample=0;sample<samples;sample++)for(const scenario of scenarios)
    for(const arm of sample%2?['candidate','baseline']:['baseline','candidate'])runs.push({sample,arm,...child(['--probe',sources[arm],scenario])});
  for(const [arm,source] of Object.entries(sources))assert.deepEqual(sourceHashes(source),hashes[arm],'source changed during experiment');
  assert.equal(hash(readFileSync(self)),fixtureSha256,'fixture changed during experiment');
  const results=Object.fromEntries(scenarios.map(scenario=>[scenario,Object.fromEntries(Object.keys(sources).map(arm=>{
    const rows=runs.filter(r=>r.arm===arm&&r.scenario===scenario);
    const expected=arm==='baseline'&&defectCases.includes(scenario)?'FAIL':'PASS';
    assert(rows.every(r=>r.contractVerdict===expected),arm+' '+scenario+' differs from frozen expected behavior');
    return [arm,{trials:rows.length,passed:rows.filter(r=>r.contractVerdict==='PASS').length,
      prematureReviews:rows.filter(r=>r.prematureReview).length,artifactChecksPassed:rows.filter(r=>r.finalArtifactCheck==='PASS').length}];
  }))]));
  for(const scenario of scenarios.filter(name=>!defectCases.includes(name)))
    assert.equal(new Set(runs.filter(r=>r.scenario===scenario).map(r=>JSON.stringify(r.artifacts))).size,1,
      'unchanged guardrail artifacts must agree across both arms');
  const report={schema:1,kind:'SCRIPTED_REAL_ARTIFACT_TASK_LIFECYCLE_NOT_LIVE_MODEL_PRODUCTIVITY',
    runtime:{node:process.version,platform:process.platform,arch:process.arch},samplesPerArmPerScenario:samples,
    sources:Object.fromEntries(Object.entries(sources).map(([arm,source])=>[arm,{revision:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha256:hashes[arm]}])),
    fixtureSha256,independentCheckerSha256:hash(checker),scenarios,results,runs};
  writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(results,null,2)+'\n');
}
