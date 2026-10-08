import test from 'node:test';
import assert from 'node:assert/strict';
import {predictProductivity, recommendExecutionLane} from '../../src/harness/foundry/productivityTheory.ts';
const arm = (workers, coordinationHours, lostWorkHours, verifiedCompletionProbability = 1) =>
  ({workers, coordinationHours, lostWorkHours, verifiedCompletionProbability});
const sample = {workHours: 100, serialFraction: 0.2,
  baseline: arm(1, 1, 20), futureCode: arm(5, 8, 2)};
test('serial and parallel bounds are transparent', () => {
  const result = predictProductivity(sample);
  assert.equal(result.baselineHours, 121);
  assert.equal(result.futureCodeHours, 46);
  assert.equal(result.speedup, 121 / 46);
  assert(Math.abs(result.breakEven.breakEvenMarginHours - 75) < 1e-9);
  assert.equal(result.breakEven.futureFasterByTime, true);
  assert.equal(result.target2x, 'CONDITIONAL_GE_2X');
});
test('equal orchestration and capability give no inherent speedup', () => {
  const result = predictProductivity({...sample, baseline: arm(4, 4, 5), futureCode: arm(4, 4, 5)});
  assert.equal(result.speedup, 1);
  assert.equal(result.qualityAdjustedSpeedup, 1);
  assert.equal(result.target2x, 'NOT_DEMONSTRATED');
});
test('a capable competitor can win and 2x is not automatic', () => {
  const result = predictProductivity({...sample, baseline: arm(8, 1, 1), futureCode: arm(4, 10, 6)});
  assert(result.speedup < 1);
  assert.equal(result.target2x, 'NOT_DEMONSTRATED');
});
test('small task parity depends on extra coordination, not agent counts', () => {
  const result = predictProductivity({workHours: 60/3600, serialFraction: 1,
    baseline: arm(1, 0.2/3600, 0), futureCode: arm(1, 1.2/3600, 0)});
  assert(result.futureCodeHours / result.baselineHours < 1.02);
  assert.equal(result.target2x, 'NOT_DEMONSTRATED');
});
test('quality-adjusted speedup can differ from time speedup', () => {
  const r = predictProductivity({...sample, baseline: arm(1,1,20,0.95), futureCode: arm(5,8,2,0.20)});
  assert(r.speedup > 2);
  assert(r.qualityAdjustedSpeedup < 1);
  assert.equal(r.target2x, 'NOT_DEMONSTRATED');
});
test('unknown baseline quality cannot create a false ratio', () => {
  const r = predictProductivity({...sample, baseline: arm(1,1,20,0)});
  assert.equal(r.qualityAdjustedSpeedup, null);
  assert.equal(r.target2x, 'UNKNOWN_BASELINE_QUALITY');
});
test('invalid assumptions fail closed', () => {
  assert.throws(() => predictProductivity({...sample, serialFraction: -0.3}), /serialFraction/);
  assert.throws(() => predictProductivity({...sample, futureCode: arm(0,1,1)}), /workers/);
  assert.throws(() => predictProductivity({...sample, futureCode: arm(4,-1,1)}), /coordinationHours/);
  assert.throws(() => predictProductivity({...sample, baseline: arm(4,1,1,1.5)}), /verifiedCompletionProbability/);
});
const spec = {defaultAgent:'coder',agents:{coder:{tools:['read_file','edit_file','run_check']}},recipe:{timeoutMs:300000}};
const task = {id:'fix',dependencies:[],estimatedDurationMs:20000};
test('simple bounded local task uses existing direct path', () => {
  assert.equal(recommendExecutionLane([task],spec).lane,'direct');
});
test('research DAG and multi-agent tools require supervision', () => {
  assert.equal(recommendExecutionLane([task, {...task, id:'second'}],spec).lane,'supervised');
  assert.equal(recommendExecutionLane([{...task,estimatedDurationMs:400000}],spec).lane,'supervised');
  assert.equal(recommendExecutionLane([task],{...spec,jobs:{remote:{}}}).lane,'supervised');
  assert.equal(recommendExecutionLane([task],{...spec,agents:{coder:{tools:['run_job']}}}).lane,'supervised');
  assert.equal(recommendExecutionLane([task],{...spec,agents:{coder:{tools:['spawn_tasks']}}}).lane,'supervised');
});
test('unconfigured agent and malformed estimates are rejected', () => {
  assert.throws(() => recommendExecutionLane([{...task,agent:'missing'}],spec),/not configured/);
  assert.throws(() => recommendExecutionLane([{...task,estimatedDurationMs:-3}],spec),/estimatedDurationMs/);
});
