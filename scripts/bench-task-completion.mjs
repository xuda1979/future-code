#!/usr/bin/env node
/** Real file tasks + independent artifact checks + production goal decisions.
 * This isolates post-task host behavior; it is not a live-model timing test. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url), root = resolve(dirname(self), '..');
const sha = data => createHash('sha256').update(data).digest('hex');
const cases = ['rename', 'config', 'code-fix', 'unfinished-required'];
const sourceFiles = ['src/commands/goal/auto.ts', 'src/harness/autonomyPolicy.ts',
  'src/harness/decisionGuidance.ts', 'src/utils/autoGoalSession.ts'];
const hashes = source => Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(join(source, path)))]));
const checker = `
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [directory,kind]=process.argv.slice(1);
if(kind==='rename'||kind==='unfinished-required') {
 assert.equal(existsSync(join(directory,'old.txt')),false);
 assert.equal(readFileSync(join(directory,'new.txt'),'utf8'),'preserve these exact bytes\\n');
 if(kind==='unfinished-required') assert.equal(existsSync(join(directory,'README.md')),true,'required README work is missing');
} else if(kind==='config') {
 const value=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
 assert.deepEqual(value,{port:9090,enabled:true});
} else {
 const {sum}=await import(pathToFileURL(join(directory,'calc.mjs')));
 assert.equal(sum(7,5),12);assert.equal(sum(-3,8),5);assert.equal(sum(0,0),0);
}
process.stdout.write('INDEPENDENT_TASK_CHECK_PASS');
`;

async function probe(source, kind, limit) {
  const api = await import(pathToFileURL(join(source, 'src/commands/goal/auto.ts')));
  const directory = mkdtempSync(join(tmpdir(), 'completed-task-scope-'));
  const goal = {rename:'Rename old.txt to new.txt', config:'Set port to 9090 in config.json',
    'code-fix':'Fix sum(a,b) in calc.mjs and verify addition',
    'unfinished-required':'Rename old.txt to new.txt and update README.md'}[kind];
  let file, before;
  try {
    api.enableAutoGoal(goal, directory);
    if (kind === 'rename' || kind === 'unfinished-required') {
      writeFileSync(join(directory, 'old.txt'), 'preserve these exact bytes\n');
      file = 'new.txt'; before = sha(readFileSync(join(directory, 'old.txt')));
      renameSync(join(directory, 'old.txt'), join(directory, 'new.txt'));
    } else if (kind === 'config') {
      file = 'config.json';
      writeFileSync(join(directory, file), JSON.stringify({port:8080,enabled:true}));
      before = sha(readFileSync(join(directory, file)));
      writeFileSync(join(directory, file), JSON.stringify({port:9090,enabled:true}));
    } else {
      file = 'calc.mjs';
      writeFileSync(join(directory, file), 'export const sum=(a,b)=>a-b;\n');
      before = sha(readFileSync(join(directory, file)));
      writeFileSync(join(directory, file), 'export const sum=(a,b)=>a+b;\n');
    }
    // Separate process, independent semantic checks; no producer helper is
    // called to decide whether the requested artifact is correct.
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', checker, directory, kind],
      {encoding:'utf8',timeout:5000});
    assert.ifError(checked.error);
    assert.equal(checked.status, kind === 'unfinished-required' ? 1 : 0, checked.stderr);
    const optional = 'Benchmark all project subsystems and redesign the framework';
    const report = '# '+goal+'\nStatus: completed\n\n## Milestones\n- [x] Perform and verify the requested file change\n'+
      (kind === 'unfinished-required' ? '- [ ] Update README.md as requested\n' : '')+
      '\n## Optional future improvements\n- [ ] '+optional+'\n';
    writeFileSync(api.autoGoalReportPath(directory), report);
    const frontier = api.nextOpenMilestone(api.parseMilestoneLedger(report))?.text ?? null;
    const decisions = [];
    for (let index=0;index<limit;index++) {
      const decision = api.decideAutoGoalContinuation({cwd:directory,mainThread:true,withinTurnBudget:true,
        assistantText:'The requested file change and its independent check are complete.',toolActivity:index===0});
      decisions.push({kind:decision.kind,reason:decision.reason??null,
        requestsUnrelatedWork:typeof decision.prompt==='string'&&decision.prompt.includes(optional)});
      if(decision.kind!=='CONTINUE')break;
    }
    const final = api.readAutoGoal(directory);
    assert.equal(readFileSync(api.autoGoalReportPath(directory),'utf8'),report,'host must not rewrite completion evidence');
    return {case:kind,artifactCheck:checked.status===0?'PASS':'FAIL_REQUIRED_WORK_MISSING',
      checkerExitCode:checked.status,requestedArtifactEdits:1,independentChecks:1,
      artifact:{path:file,beforeSha256:before,afterSha256:sha(readFileSync(join(directory,file)))},
      reportSha256:sha(report),frontier,decisions,continuationsObserved:decisions.filter(d=>d.kind==='CONTINUE').length,
      extraContinuationsAfterPassingCheck:checked.status===0?decisions.filter(d=>d.kind==='CONTINUE').length:null,
      finalState:final.state,goalUnchanged:final.goal===goal,lifetimeLimit:final.maxContinuations};
  } finally { rmSync(directory,{recursive:true,force:true}); }
}

if(process.argv[2]==='--probe') {
  const [source,kind,count]=process.argv.slice(3);
  assert(cases.includes(kind));
  process.stdout.write(JSON.stringify(await probe(resolve(source),kind,Number(count))));
} else {
  const [baseline,output,samplesText='5',limitText='32']=process.argv.slice(2);
  assert(baseline&&output,'Usage: node --experimental-strip-types scripts/bench-task-completion.mjs BASELINE OUTPUT [SAMPLES] [OBSERVATION_LIMIT]');
  const samples=Number(samplesText),limit=Number(limitText);
  assert(Number.isSafeInteger(samples)&&samples>0&&samples<=20);
  assert(Number.isSafeInteger(limit)&&limit>0&&limit<=128);
  const sources={baseline:resolve(baseline),candidate:root};
  const sourceHashes=Object.fromEntries(Object.entries(sources).map(([arm,path])=>[arm,hashes(path)]));
  const fixtureHash=sha(readFileSync(self)),runs=[];
  for(let sample=0;sample<samples;sample++)for(const kind of cases) {
    const order=sample%2?['candidate','baseline']:['baseline','candidate'];
    for(const arm of order) {
      const child=spawnSync(process.execPath,['--experimental-strip-types',self,'--probe',sources[arm],kind,String(limit)],
        {encoding:'utf8',timeout:15000,maxBuffer:2_000_000});
      assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
      runs.push({sample,arm,...JSON.parse(child.stdout)});
    }
  }
  for(const [arm,path]of Object.entries(sources))assert.deepEqual(hashes(path),sourceHashes[arm],'source changed during measurement');
  assert.equal(sha(readFileSync(self)),fixtureHash,'fixture changed during measurement');
  const results={};
  for(const kind of cases) {
    const selected=runs.filter(run=>run.case===kind);
    assert.equal(new Set(selected.map(run=>run.artifact.afterSha256)).size,1,'artifact differs across arms');
    assert.equal(new Set(selected.map(run=>run.reportSha256)).size,1,'report differs across arms');
    results[kind]={};
    for(const arm of Object.keys(sources)) {
      const rows=selected.filter(run=>run.arm===arm);
      assert(rows.every(run=>run.goalUnchanged&&run.lifetimeLimit===null));
      if(kind==='unfinished-required')assert(rows.every(run=>run.artifactCheck==='FAIL_REQUIRED_WORK_MISSING'&&run.finalState==='ACTIVE'));
      else {
        assert(rows.every(run=>run.artifactCheck==='PASS'));
        if(arm==='candidate')assert(rows.every(run=>run.finalState==='REVIEW'&&run.extraContinuationsAfterPassingCheck===0&&run.frontier===null),'completed task kept running');
        else assert(rows.every(run=>run.finalState==='ACTIVE'&&run.extraContinuationsAfterPassingCheck===limit),'baseline did not reproduce the defect');
      }
      results[kind][arm]={independentlyPassed:rows.filter(run=>run.artifactCheck==='PASS').length,
        reachedReview:rows.filter(run=>run.finalState==='REVIEW').length,
        continuationsObserved:rows.map(run=>run.continuationsObserved),
        extraContinuationsAfterPassingCheck:rows.map(run=>run.extraContinuationsAfterPassingCheck),
        unrelatedFrontier:rows.every(run=>run.frontier==='Benchmark all project subsystems and redesign the framework')};
    }
  }
  const report={schema:1,kind:'REAL_ARTIFACT_AND_HOST_COMPLETION_LOOP_NOT_LIVE_MODEL_PRODUCTIVITY',
    samplesPerArm:samples,continuationObservationLimit:limit,runtime:{node:process.version,platform:process.platform,arch:process.arch},
    sources:Object.fromEntries(Object.entries(sources).map(([arm,path])=>[arm,{revision:execFileSync('git',['-C',path,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha256:sourceHashes[arm]}])),
    fixtureSha256:fixtureHash,independentCheckerSha256:sha(checker),results,runs};
  writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(results,null,2)+'\n');
}
