import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeEvaluation } from '../../src/commercial/evaluation.mjs';
import { checkReadiness, REQUIRED_GATES } from '../../src/commercial/readiness.mjs';
import { dashboard, run } from '../../src/commercial/cli.mjs';

const h = c => c.repeat(64);
const g = c => c.repeat(40);
function fixture({mode='live',repetitions=3,cost=2,pass=true,baselineMs=4000,candidateMs=2000}={}) {
  const trials=[];
  for (let repetition=0;repetition<repetitions;repetition++) for (const arm of ['baseline','candidate']) {
    const wallClockMs = arm === 'baseline' ? baselineMs : candidateMs;
    trials.push({schema:1,arm,repetition,mode,sourceCommit:g('a'),taskHash:h('b'),checksHash:h('c'),reportHash:h('d'),
      status:pass?'PASS':'FAIL',integration:pass?{tree:g('e')}:null,
      artifactManifest:pass?[{status:'PASS',artifact:h('f'),evidence:h('1')}]:[],
      metrics:{wallClockMs,verifiedObjectives:pass?1:0,modelRequests:mode==='live'?3:0,costUsd:mode==='live'?cost:0}});
  }
  return {schema:1,type:'future-code-real-project-evaluation',mode,repetitions,trials,
    protocolHash:h('7'),modelRequests:trials.reduce((n,t)=>n+t.metrics.modelRequests,0),
    allPass:pass,decision:!pass?'QUALITY_GATE_FAILED':mode==='replay'?'OFFLINE_BOUNDARY_ONLY':repetitions<3?'INSUFFICIENT_REPETITIONS':candidateMs<baselineMs?'OBSERVED_TIME_GAIN':'NO_OBSERVED_TIME_GAIN',
    medianWallClockMs:{baseline:baselineMs,candidate:candidateMs},
    observedSpeedup:mode==='live'&&pass?baselineMs/candidateMs:null};
}

test('three paired live trials: verified throughput and host-reported cost',()=>{
 const r=analyzeEvaluation(fixture());
 assert.equal(r.decision,'OBSERVED_TIME_GAIN');
 assert.equal(r.observedSpeedup,2);
 assert.equal(r.arms.baseline.verifiedObjectives,3);
 assert.equal(r.arms.baseline.costPerVerifiedObjectiveUsd,2);
 assert.equal(r.arms.candidate.verifiedObjectivesPerHour,1800);
});
test('replayed data does not support model speedup or dollar efficiency',()=>{
 const r=analyzeEvaluation(fixture({mode:'replay'}));
 assert.equal(r.observedSpeedup,null);
 assert.equal(r.decision,'OFFLINE_BOUNDARY_ONLY');
 assert.equal(r.arms.candidate.costPerVerifiedObjectiveUsd,null);
 assert.match(r.disclosure,/OFFLINE FIXTURE ONLY/);
});
test('live labelled reports with zero model requests cannot claim a model speedup',()=>{
 const v=fixture();for (const t of v.trials) t.metrics.modelRequests=0;v.modelRequests=0;
 const r=analyzeEvaluation(v);assert.equal(r.decision,'NO_LIVE_MODEL_REQUESTS');assert.equal(r.observedSpeedup,null);
});
test('missing billing stays unknown, never 0',()=>{
 const v=fixture();v.trials[2].metrics.costUsd=null;
 const r=analyzeEvaluation(v);
 assert.equal(r.arms.baseline.costUsd,null);
 assert.equal(r.arms.baseline.costPerVerifiedObjectiveUsd,null);
});
test('one successful sample pair is not publishable speedup evidence',()=>{
 const r=analyzeEvaluation(fixture({repetitions:1}));
 assert.equal(r.decision,'INSUFFICIENT_REPETITIONS');
 assert.match(r.disclosure,/Insufficient/);
});
test('failed quality gates block time-win claims',()=>{
 const r=analyzeEvaluation(fixture({pass:false}));
 assert.equal(r.decision,'QUALITY_GATE_FAILED');
 assert.equal(r.arms.baseline.verifiedObjectives,0);
 assert.equal(r.arms.candidate.costPerVerifiedObjectiveUsd,null);
});
test('tampered aggregate decision and reported speedup fail closed',()=>{
 const v=fixture();v.observedSpeedup=20;
 assert.throws(()=>analyzeEvaluation(v),/speedup mismatch/);
 v.observedSpeedup=2;v.decision='OFFLINE_BOUNDARY_ONLY';
 assert.throws(()=>analyzeEvaluation(v),/unsupported report decision/);
});
test('duplicate pairs and changed check identities fail closed',()=>{
 const v=fixture();v.trials[1].repetition=0;v.trials[1].arm='baseline';
 assert.throws(()=>analyzeEvaluation(v),/duplicate trial/);
 const w=fixture();w.trials[3].checksHash=h('2');
 assert.throws(()=>analyzeEvaluation(w),/inconsistent source/);
});
test('forged PASS without integration and accepted artifacts fails closed',()=>{
 const v=fixture();v.trials[0].integration=null;
 assert.throws(()=>analyzeEvaluation(v),/unsubstantiated PASS/);
 const w=fixture();w.trials[0].artifactManifest=[];
 assert.throws(()=>analyzeEvaluation(w),/missing acceptance artifacts/);
});
test('billing, mode and request counters cannot be corrupted',()=>{
 const v=fixture();v.trials[0].metrics.costUsd=-2;
 assert.throws(()=>analyzeEvaluation(v),/invalid cost/);
 const w=fixture({mode:'replay'});w.trials[0].metrics.modelRequests=1;w.modelRequests=1;
 assert.throws(()=>analyzeEvaluation(w),/replay cannot record live requests/);
 const x=fixture();x.modelRequests=100;
 assert.throws(()=>analyzeEvaluation(x),/request sum mismatch/);
});
test('release blockers default to PENDING; self-attestation is never certification',()=>{
 const gates=REQUIRED_GATES.map(([id])=>({id,status:'PENDING',reviewer:null,reviewedAt:null,evidence:null}));
 assert.equal(checkReadiness({schema:1,gates}).status,'BLOCKED');
 const reviewed=gates.map(g=>({...g,status:'REVIEWED',reviewer:'Reviewer',reviewedAt:'2026-10-09',evidence:'https://example.org/report'}));
 const r=checkReadiness({schema:1,gates:reviewed});
 assert.equal(r.status,'REVIEWED_NOT_CERTIFIED');
 assert.match(r.notice,/not legal approval/);
 reviewed[0].reviewer='';
 assert.equal(checkReadiness({schema:1,gates:reviewed}).status,'BLOCKED');
});
test('readiness rejects incomplete or unknown release gate records',()=>{
 const gates=REQUIRED_GATES.map(([id])=>({id,status:'PENDING'}));
 assert.throws(()=>checkReadiness({schema:1,gates:[...gates,gates[0]]}),/one source-rights gate/);
 assert.throws(()=>checkReadiness({schema:1,gates:[...gates,{id:'fake',status:'REVIEWED'}]}),/unknown or duplicate/);
});
test('HTML dashboard escapes untrusted input and is network inert',()=>{
 const s=analyzeEvaluation(fixture());s.decision='<img src=x onerror=alert(1)>';
 const html=dashboard(s);
 assert.ok(!html.includes('<img src=x'));
 assert.match(html,/&lt;img src=x/);
 assert.match(html,/default-src 'none'/);
 assert.ok(!html.includes('<script'));
});
test('CLI doctor and report produce privacy-preserving local artifacts without overwriting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'future-commercial-'));
 try {
  const input=join(dir,'input.json'),out=join(dir,'output.json'),html=join(dir,'report.html');
  writeFileSync(input,JSON.stringify(fixture()));
  const result=run(['report','--input',input,'--out',out,'--html',html]);
  assert.equal(result.decision,'OBSERVED_TIME_GAIN');
  assert.equal(JSON.parse(readFileSync(out,'utf8')).decision,'OBSERVED_TIME_GAIN');
  assert.match(readFileSync(html,'utf8'),/Measurement boundaries/);
  assert.throws(()=>run(['report','--input',input,'--out',out]),/EEXIST/);
  assert.equal(run(['doctor']).status,'BLOCKED');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
