#!/usr/bin/env node
// Controlled task replay through production goal/context decisions. Provider
// outputs are scripted; timings and toy losses are not live-LLM/IBM results.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
const worker = join(root, 'experiments/goal-resume-20261118/adapter-worker.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['src/commands/goal/auto.ts', 'src/commands/goal/context.ts', 'src/commands/goal/actionFocus.ts',
  'src/harness/autonomyPolicy.ts', 'src/query.ts', 'src/commands/goal/workState.ts', 'src/query/goalFailureEvidence.ts'];

async function probe(source, scenario) {
  const { enableAutoGoal, decideAutoGoalContinuation, readAutoGoal } = await import(pathToFileURL(join(source, sourcePaths[0])));
  const { appendGoalRequestAnchor } = await import(pathToFileURL(join(source, sourcePaths[1])));
  const cwd = mkdtempSync(join(tmpdir(), 'goal-resume-replay-'));
  const task = 'Continue the successful adapter experiment for 120 more updates and evaluate its heldout improvement';
  const base = join(cwd, 'base.json'), prior = join(cwd, 'successful-adapter.json'), candidate = join(cwd, 'candidate.json');
  const run = (input, output, steps) => JSON.parse(execFileSync(process.execPath, [worker, input, output, String(steps)], { encoding: 'utf8' }));
  try {
    writeFileSync(base, JSON.stringify({ schema: 1, step: 0, weight: 0, bias: 0, velocityWeight: 0, velocityBias: 0 }));
    const priorResult = run(base, prior, 12), initial = run(base, join(cwd, 'base-copy.json'), 0);
    assert(priorResult.heldoutMseAfter < initial.heldoutMseAfter);
    const priorHash = hash(readFileSync(prior));
    enableAutoGoal(task, cwd);
    writeFileSync(join(cwd, '.future-code/work-state.json'), JSON.stringify({ schema: 1, goal: task, revision: 1,
      baseline: { artifact: prior, evidence: 'fixture prior heldout evaluation', contract: 'scalar-residual-adapter-v1' },
      nextAction: 'Resume the baseline artifact for exactly 120 optimizer updates and compare to the same heldout inputs.',
      metric: { name: 'toy heldout MSE', baseline: String(priorResult.heldoutMseAfter), current: 'unmeasured', nextEvaluation: 'after 120 updates' },
    }));
    const decisions = [];
    let permitted = true, recovered = false;
    if (scenario === 'authorization-recovery') {
      for (let i = 0; i < 3; i++) {
        const decision = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true,
          assistantText: 'Should I continue?', failureReceipts: [] });
        decisions.push(decision.kind);
        if (decision.kind === 'BLOCKED' || decision.kind === 'MODEL_ERROR') { permitted = false; break; }
        if (decision.kind === 'RECOVER') recovered = true;
      }
    }
    if (scenario === 'invented-observer-budget') {
      writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + task + '\nStatus: blocked\n' +
        'Blocker: the job would exceed this observer turn\nBlocker type: resources\n' +
        'Recovery attempted: checked current job configuration\n' +
        'External action required: extend the 40-minute observation slot to fit the 60-minute job\n');
      const decision = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true, failureReceipts: [] });
      decisions.push(decision.kind); permitted = decision.kind === 'CONTINUE' || decision.kind === 'RECOVER';
    }
    // Lossy summary deliberately drops the checkpoint location. The worker
    // may use only the actual fresh request projection, not this script's
    // private prior variable, to find its starting artifact.
    const messages = appendGoalRequestAnchor([{ type: 'user', isMeta: true,
      message: { content: 'Summary: working on the experiment; observer connection failed.' } }], {
      cwd, mainThread: true, makeMessage: content => ({ type: 'user', isMeta: true, message: { content } }),
    });
    const request = messages.at(-1).message.content;
    const recordLine = request.split('\n').find(line => line.startsWith('{"schema":1,"goal":'));
    const recorded = recordLine ? JSON.parse(recordLine) : null;
    const stateReachable = recorded?.baseline?.artifact === prior;
    let result = null, resumeMatchesUninterrupted = null;
    if (permitted && stateReachable) {
      result = run(recorded.baseline.artifact, candidate, 120);
      const reference = join(cwd, 'uninterrupted.json'); run(base, reference, 132);
      // Independent exact-state observation from two differently segmented
      // processes; proves optimizer history survived rather than a warm reset.
      resumeMatchesUninterrupted = readFileSync(candidate, 'utf8') === readFileSync(reference, 'utf8');
      assert(resumeMatchesUninterrupted);
      assert.equal(result.resumedAt, 12); assert.equal(result.step, 132);
      assert(result.heldoutMseAfter < result.heldoutMseBefore);
    }
    assert.equal(hash(readFileSync(prior)), priorHash, 'known-good checkpoint must not be overwritten');
    return { scenario, decisions, state: readAutoGoal(cwd).state, changedRecovery: recovered, stateReachable,
      optimizerUpdates: result ? 120 : 0, result, resumeMatchesUninterrupted, baselinePreserved: true,
      missingStateRequiresRediscovery: !stateReachable, requestBytes: Buffer.byteLength(request) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

if (process.argv[2] === '--probe') {
  process.stdout.write(JSON.stringify(await probe(resolve(process.argv[3]), process.argv[4])));
} else {
  const [baselineArg, outputArg] = process.argv.slice(2);
  assert(baselineArg && outputArg, 'usage: node scripts/bench-goal-resume.mjs BASELINE OUTPUT');
  const baseline = resolve(baselineArg), output = resolve(outputArg);
  const rows = [];
  for (const scenario of ['authorization-recovery', 'compaction-recovery', 'invented-observer-budget']) for (const [arm, source] of Object.entries({ baseline, candidate: root })) {
    const child = spawnSync(process.execPath, [self, '--probe', source, scenario], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    rows.push({ arm, ...JSON.parse(child.stdout) });
  }
  const record = { schema: 1, measurement: 'deterministic host recovery replay with real CPU optimizer subprocesses',
    limitations: ['Scripted provider decisions, not live LLM productivity.', 'Scalar residual adapter only; no Qwen/IBM result.',
      'The bounded replay does not model how a baseline model might rediscover missing state.', 'No remote daemon or accelerator accessed.'],
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(),
    candidateParent: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(Object.entries({ baseline, candidate: root }).map(([arm, source]) => [arm,
      Object.fromEntries(sourcePaths.map(path => [path, existsSync(join(source, path)) ? hash(readFileSync(join(source, path))) : null]))])),
    fixtureSha256: hash(readFileSync(worker)), rows };
  const good = rows.filter(row => row.arm === 'candidate');
  assert(good.every(row => row.optimizerUpdates === 120 && row.resumeMatchesUninterrupted && row.state === 'ACTIVE'));
  assert.deepEqual(rows.find(row => row.arm === 'baseline' && row.scenario === 'authorization-recovery').decisions,
    ['CONTINUE', 'CONTINUE', 'BLOCKED']);
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ output, rows: rows.map(({ result, ...row }) => row) }, null, 2));
}
