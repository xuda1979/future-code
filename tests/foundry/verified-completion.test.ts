import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../src/harness/foundry/kernel.ts';
import { Scheduler } from '../../src/harness/foundry/scheduler.ts';
import { runTasks } from '../../src/harness/foundry/runtime.ts';
import { SwarmDriver } from '../../src/harness/foundry/swarm/driver.ts';
import { eligibleVerifiedCompletion, fullCompletionVerificationPassed, completionMaterialKey } from '../../src/harness/foundry/swarm/verifiedCompletion.ts';
import { decisionInputKey } from '../../src/harness/foundry/swarm/decisions.ts';
import { SessionJournal, type ThreadState } from '../../src/harness/foundry/swarm/session.ts';
import { validateSwarmSpec } from '../../src/harness/foundry/swarm/config.ts';
import { localGitBackend, LocalGitHands, type HandsBackend } from '../../src/harness/foundry/swarm/workspace.ts';
import { integrateSwarm } from '../../src/harness/foundry/swarm/host.ts';
import { fixture, spec, task, reply, scripted, signal } from './swarm-fixtures.ts';

const write = (content = '42\n', id = 'write') => ({ id, name: 'write_file', arguments: { path: 'src/a.txt', content } });
const check = (id = 'check') => ({ id, name: 'run_check', arguments: { name: 'behavior' } });
const enabled = (s: ReturnType<typeof spec>) => { s.agents.coder.completionPolicy = 'verified-checks'; };

test('verified completion is explicit, pinned profile configuration with named checks', () => {
  const s = spec('/tmp/project'); enabled(s); validateSwarmSpec(s);
  for (const completionPolicy of [true, false, 'always', {}, null]) {
    assert.throws(() => validateSwarmSpec({ ...s, agents: { coder: { ...s.agents.coder, completionPolicy } } } as any), /completion/i);
  }
  assert.throws(() => validateSwarmSpec({ ...s, agents: { coder: { ...s.agents.coder, tools: ['write_file'] } } }), /completion/i);
});

test('opt-in saves only the final model acknowledgment after fresh full verification; scheduler and integration still verify', async () => fixture(async (s, cfg) => {
  let verified = 0;
  const backend: HandsBackend = { ...localGitBackend, async verify(...args) { verified++; return localGitBackend.verify(...args); } };
  const mock = scripted([() => reply('', [write(), check()])]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, backend);
  const result = await runTasks(s, [task()], driver, { signal: signal() });
  assert.equal(result.status, 'PASS');
  assert.equal(mock.bodies.length, 1);
  assert.equal(verified, 2, 'probe plus fresh scheduler verification');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  assert.ok((await integrateSwarm(s, result.id, signal())).checksHash);
}, enabled));

test('default profiles still request a model summary, and unchanged baseline checks do not opt out of it', async () => {
  for (const mode of ['default', 'unchanged'] as const) await fixture(async (s, cfg) => {
    let verified = 0;
    const backend: HandsBackend = { ...localGitBackend, async verify(...args) { verified++; return localGitBackend.verify(...args); } };
    const mock = scripted([() => reply('', mode === 'default' ? [write(), check()] : [check()]), () => reply('ready for independent verification')]);
    const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher, backend), { signal: signal() });
    assert.equal(result.status, 'PASS'); assert.equal(mock.bodies.length, 2); assert.equal(verified, 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 0);
  }, s => { if (mode === 'unchanged') { enabled(s); s.checks.behavior.argv[2] = s.checks.behavior.argv[2].replace("v!=='42'", "v!=='0'"); } });
});

test('failed, unknown and missing full gates continue the same attempt and cannot re-probe unchanged material after feedback or rechecking', async () => {
  for (const outcome of ['FAIL', 'UNKNOWN', 'MISSING', 'WRONG_ARTIFACT', 'EXTRA_UNKNOWN', 'DUPLICATE', 'MALFORMED'] as const) await fixture(async (s, cfg) => {
    let verified = 0;
    const backend: HandsBackend = { ...localGitBackend, async verify(...args) {
      const v = await localGitBackend.verify(...args);
      if (++verified === 1) {
        if (outcome === 'WRONG_ARTIFACT') return { ...v, artifactHash: '0'.repeat(64) };
        if (outcome === 'EXTRA_UNKNOWN') return { ...v, checks: [...v.checks, { id: 'additional', verdict: 'UNKNOWN' as const }] };
        if (outcome === 'DUPLICATE') return { ...v, checks: [...v.checks, v.checks[0]!] };
        if (outcome === 'MALFORMED') return { ...v, checks: [{ id: 17, verdict: 'PASS' }] } as any;
        return { ...v, checks: outcome === 'MISSING' ? v.checks.filter(c => c.id !== 'behavior') :
          v.checks.map(c => c.id === 'behavior' ? { ...c, verdict: outcome } : c) };
      }
      return v;
    } };
    const mock = scripted([() => reply('', [write(), check()]), body => {
      assert.match(JSON.stringify(body.messages), /completionVerification/);
      return reply('', [check('recheck')]);
    }, () => reply('ready for independent verification')]);
    const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher, backend), { signal: signal() });
    assert.equal(result.status, 'PASS'); assert.equal(mock.bodies.length, 3);
    assert.equal(verified, 2, 'one rejected probe, then normal fresh scheduler verification');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM attempts').get()!.n, 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  }, enabled);
});

test('queued tools drain before eligibility and later source changes require current passing check receipts', async () => fixture(async (s, cfg) => {
  const mock = scripted([() => reply('', [write('42\n', 'one'), check('first'), write('0\n', 'undo'), check('fails')]),
    () => reply('', [write('42\n', 'repair'), check('current')])]);
  const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher), { signal: signal() });
  assert.equal(result.status, 'PASS'); assert.equal(mock.bodies.length, 2);
  const state = s.readArtifact(s.db.prepare('SELECT state FROM agent_threads').get()!.state) as any;
  assert.equal(state.toolCalls, 6);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
}, enabled));

test('a later fresh scheduler failure still rejects a host-produced candidate', async () => fixture(async (s, cfg) => {
  let verified = 0;
  const backend: HandsBackend = { ...localGitBackend, async verify(...args) {
    const v = await localGitBackend.verify(...args);
    return ++verified === 2 ? { ...v, checks: v.checks.map(c => c.id === 'behavior' ? { ...c, verdict: 'FAIL' as const } : c) } : v;
  } };
  const mock = scripted([() => reply('', [write(), check()])]);
  const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher, backend), { signal: signal() });
  assert.equal(result.status, 'FAIL'); assert.equal(verified, 2); assert.equal(mock.bodies.length, 1);
}, s => { enabled(s); s.recipe.attempts = 1; }));

test('negative-control audits remain mandatory even when the exploratory named check reports success', async () => fixture(async (s, cfg) => {
  const mock = scripted([() => reply('', [write(), check()]), () => reply('candidate ready')]);
  const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher), { signal: signal() });
  assert.equal(result.status, 'FAIL'); assert.equal(mock.bodies.length, 2);
  const state = s.readArtifact(s.db.prepare('SELECT state FROM agent_threads').get()!.state) as any;
  assert.equal(state.completionProbe.status, 'FAIL');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  await assert.rejects(() => integrateSwarm(s, result.id, signal()), /all tasks must pass/);
}, s => {
  enabled(s); s.recipe.attempts = 1;
  s.checks.behavior.argv = [process.execPath, '-e', 'process.exit(0)'];
  s.checks.behavior.parallelSafe = true;
  s.checks.behavior.negativeControls = [{ id: 'reject-broken-source', expectedExitCode: 1,
    edits: [{ path: 'src/a.txt', content: 'broken\n' }] }];
}));

test('pure admission authenticates every current named observation and excludes feedback or timing from probe identity', () => {
  const state: ThreadState = { history: [], turns: 1, toolCalls: 1, patchHash: digest('changed source'), pending: null,
    output: null, feedbackHash: null, decisions: { writeTurns: 0, measurements: {}, reviews: 0 } };
  const receipt = digest({ code: 0 });
  state.decisions!.measurements.behavior = { name: 'behavior', receipt, code: 0, inputKey: decisionInputKey(state), atTurn: 1 };
  const profile = { completionPolicy: 'verified-checks' as const, checks: ['behavior'] };
  const owned = (hash: string) => hash === receipt;
  assert.ok(eligibleVerifiedCompletion(profile, state, owned));
  for (const mutate of [
    (s: ThreadState) => { s.pending = { id: 'pending', name: 'write_file', arguments: {} }; },
    (s: ThreadState) => { s.pendingBatch = ['queued']; },
    (s: ThreadState) => { s.decisions!.measurements.behavior.code = 1; },
    (s: ThreadState) => { s.decisions!.measurements.behavior.inputKey = digest('stale'); },
    (s: ThreadState) => { s.decisions!.measurements.behavior.receipt = digest('foreign'); },
  ]) {
    const other = structuredClone(state); mutate(other);
    assert.equal(eligibleVerifiedCompletion(profile, other, owned), null);
  }
  assert.equal(eligibleVerifiedCompletion({ ...profile, checks: ['behavior', 'missing'] }, state, owned), null);
  const key = completionMaterialKey(state);
  state.completionProbe = { materialKey: key, status: 'UNKNOWN' };
  state.feedbackHash = digest('own verification feedback'); state.lastCheckAt = Date.now();
  state.decisions!.measurements.behavior.inputKey = decisionInputKey(state);
  assert.equal(completionMaterialKey(state), key);
  assert.equal(eligibleVerifiedCompletion(profile, state, owned), null, 'fresh checks alone cannot rearm the same material');
  const artifact = { schema: 1, patchHash: state.patchHash, summary: 'candidate' };
  const report = { artifactHash: digest(artifact), checks: [{ id: 'scope', verdict: 'PASS' as const }, { id: 'behavior', verdict: 'PASS' as const }] };
  assert.equal(fullCompletionVerificationPassed(['scope', 'behavior'], artifact, report), true);
  assert.equal(fullCompletionVerificationPassed(['scope', 'behavior', 'missing'], artifact, report), false);
  assert.equal(fullCompletionVerificationPassed(['scope'], artifact, { ...report, checks: [...report.checks, { id: 'extra', verdict: 'UNKNOWN' }] }), false);
});

test('unowned or nonpassing receipt bodies cannot authorize early completion even in an injected host observation', async () => {
  for (const variant of ['unowned', 'owned-failed']) await fixture(async (s, cfg) => {
    const mock = scripted([() => reply('', [write(), check()]), () => reply('ready')]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher);
    const checkpoint = driver.journal.checkpoint.bind(driver.journal);
    driver.journal.checkpoint = (thread, kind, payload) => {
      if (kind === 'tool.result' && (payload as any).callId === 'check') {
        thread.state.decisions!.measurements.behavior.receipt = variant === 'unowned' ? 'f'.repeat(64) :
          driver.journal.receipt(thread.capsule, { code: 1, error: 'failed result' });
      }
      checkpoint(thread, kind, payload);
    };
    const result = await runTasks(s, [task()], driver, { signal: signal() });
    assert.equal(result.status, 'PASS'); assert.equal(mock.bodies.length, 2);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 0);
  }, enabled);
});

test('a passing observation followed by a queued source mutation is stale and cannot produce a host candidate', async () => fixture(async (s, cfg) => {
  const mock = scripted([() => reply('', [write('42\n', 'good'), check(), write('0\n', 'later')]), () => reply('ready')]);
  const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher), { signal: signal() });
  assert.equal(result.status, 'FAIL'); assert.equal(mock.bodies.length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 0);
}, s => { enabled(s); s.recipe.attempts = 1; }));

test('material source change during full verification rejects that probe; a later distinct source/check may probe again', async () => fixture(async (s, cfg) => {
  let active: LocalGitHands; let verified = 0;
  const backend: HandsBackend = { ...localGitBackend,
    open(...args) { const hands = localGitBackend.open(...args); active = hands as LocalGitHands; return hands; },
    async verify(...args) {
      const result = await localGitBackend.verify(...args);
      if (++verified === 1) writeFileSync(join(await active.ready(), 'src/a.txt'), '0\n');
      return result;
    } };
  const mock = scripted([() => reply('', [write(), check()]), body => {
    assert.match(JSON.stringify(body.messages), /completionVerification/);
    return reply('', [write('42\n\n', 'changed'), check('fresh')]);
  }]);
  const result = await runTasks(s, [task()], new SwarmDriver(s, cfg, mock.fetcher, backend), { signal: signal() });
  assert.equal(result.status, 'PASS'); assert.equal(mock.bodies.length, 2); assert.equal(verified, 3);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 2);
  const review = s.db.prepare("SELECT payload FROM agent_events WHERE kind='completion.review'").get()!;
  assert.equal((s.readArtifact(review.payload) as any).status, 'UNKNOWN');
}, enabled));

test('cancellation and lease expiry after a passing full verifier cannot emit worker.output', async () => {
  for (const kind of ['cancel', 'lease']) await fixture(async (s, cfg) => {
    const abort = new AbortController();
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, 'fixture')!);
    const backend: HandsBackend = { ...localGitBackend, async verify(...args) {
      const result = await localGitBackend.verify(...args);
      if (kind === 'cancel') abort.abort(new Error('explicit cancellation'));
      else s.db.prepare('UPDATE tasks SET deadline=0 WHERE run=? AND id=?').run(c.runId, c.task.id);
      return result;
    } };
    const mock = scripted([() => reply('', [write(), check()])]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher, backend);
    await assert.rejects(() => driver.execute(c, abort.signal), kind === 'cancel' ? /explicit cancellation/ : /stale agent lease/);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='worker.output'").get()!.n, 0);
    assert.equal(mock.bodies.length, 1);
  }, enabled);
});

for (const phase of ['before', 'after']) test(`cancellation or lease expiry at the snapshot boundary ${phase} verification cannot emit worker.output`, async () => {
  for (const kind of ['cancel', 'lease']) await fixture(async (s, cfg) => {
    const abort = new AbortController();
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, 'fixture')!);
    let checksRecorded = false, verified = 0, fired = false;
    const backend: HandsBackend = { ...localGitBackend,
      open(...args) {
        const hands = localGitBackend.open(...args), snapshot = hands.snapshot.bind(hands);
        hands.snapshot = async () => {
          const hash = await snapshot();
          if (!fired && checksRecorded && (phase === 'before' ? verified === 0 : verified === 1)) {
            fired = true;
            if (kind === 'cancel') abort.abort(new Error('snapshot cancellation'));
            else s.db.prepare('UPDATE tasks SET deadline=0 WHERE run=? AND id=?').run(c.runId, c.task.id);
          }
          return hash;
        };
        return hands;
      },
      async verify(...args) { const report = await localGitBackend.verify(...args); verified++; return report; },
    };
    const mock = scripted([() => reply('', [write(), check()])]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher, backend), checkpoint = driver.journal.checkpoint.bind(driver.journal);
    driver.journal.checkpoint = (thread, event, payload) => {
      checkpoint(thread, event, payload);
      if (event === 'tool.result' && (payload as any).callId === 'check') checksRecorded = true;
    };
    await assert.rejects(() => driver.execute(c, abort.signal), kind === 'cancel' ? /snapshot cancellation/ : /stale agent lease/);
    assert.equal(fired, true, 'exercise the awaited snapshot boundary');
    assert.equal(verified, phase === 'before' ? 0 : 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='worker.output'").get()!.n, 0);
    if (phase === 'before') assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 0);
  }, enabled);
});

test('saved provider replies drain before host completion and replay consumes no extra model request', async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, 'fixture')!);
  const mock = scripted([() => reply('', [write(), check()])]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher);
  const checkpoint = driver.journal.checkpoint.bind(driver.journal); let lost = false;
  driver.journal.checkpoint = (thread, kind, payload) => {
    if (!lost && kind === 'model.reply') { lost = true; throw new Error('lost model reply checkpoint'); }
    checkpoint(thread, kind, payload);
  };
  await assert.rejects(() => driver.execute(c, signal()), /lost model reply checkpoint/);
  const replacement = new SwarmDriver(s, cfg, mock.fetcher);
  const result = await replacement.execute(c, signal());
  assert.equal(mock.bodies.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  const state = s.readArtifact(s.db.prepare('SELECT state FROM agent_threads').get()!.state) as any;
  assert.equal(state.toolCalls, 2); assert.equal(state.completionProbe.status, 'PASS');
  assert.ok((await replacement.verify(c, result, signal())).checks.every(c => c.verdict === 'PASS'));
}, enabled));

test('a crash after the durable probe intent preserves UNKNOWN and does not blindly probe that material again', async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, 'fixture')!);
  let verified = 0;
  const backend: HandsBackend = { ...localGitBackend, async verify(...args) { verified++; return localGitBackend.verify(...args); } };
  const mock = scripted([() => reply('', [write(), check()]), body => {
    assert.match(JSON.stringify(body.messages), /completionVerification/);
    return reply('ready for independent verification');
  }]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, backend), checkpoint = driver.journal.checkpoint.bind(driver.journal);
  let lost = false;
  driver.journal.checkpoint = (thread, kind, payload) => {
    checkpoint(thread, kind, payload);
    if (!lost && kind === 'completion.probe') { lost = true; throw new Error('lost completion probe'); }
  };
  await assert.rejects(() => driver.execute(c, signal()), /lost completion probe/);
  const replacement = new SwarmDriver(s, cfg, mock.fetcher, backend);
  const result = await replacement.execute(c, signal());
  assert.equal(verified, 0); assert.equal(mock.bodies.length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  const state = s.readArtifact(s.db.prepare('SELECT state FROM agent_threads').get()!.state) as any;
  assert.equal(state.toolCalls, 2); assert.equal(state.completionProbe.status, 'UNKNOWN');
  assert.ok((await replacement.verify(c, result, signal())).checks.every(c => c.verdict === 'PASS'));
  assert.equal(verified, 1);
}, enabled));

test('a committed host output resumes idempotently without dropping effects, new requests or another completion probe', async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, 'fixture')!);
  let verified = 0;
  const backend: HandsBackend = { ...localGitBackend, async verify(...args) { verified++; return localGitBackend.verify(...args); } };
  const mock = scripted([() => reply('', [write(), check()])]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, backend), checkpoint = driver.journal.checkpoint.bind(driver.journal);
  let lost = false;
  driver.journal.checkpoint = (thread, kind, payload) => {
    checkpoint(thread, kind, payload);
    if (!lost && kind === 'worker.output') { lost = true; throw new Error('lost output return'); }
  };
  await assert.rejects(() => driver.execute(c, signal()), /lost output return/);
  const replacement = new SwarmDriver(s, cfg, mock.fetcher, backend);
  const result = await replacement.execute(c, signal());
  assert.equal(verified, 1); assert.equal(mock.bodies.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='worker.output'").get()!.n, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='completion.probe'").get()!.n, 1);
  assert.ok((await replacement.verify(c, result, signal())).checks.every(c => c.verdict === 'PASS'));
  assert.equal(verified, 2);
}, enabled));

test('verified completion stays inside the configured tool and model-turn budgets', async () => {
  for (const boundary of ['tool', 'turn']) await fixture(async (s, cfg) => {
    const mock = scripted([() => reply('', [write(), check()])]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher);
    const result = await runTasks(s, [task()], driver, { signal: signal() });
    assert.equal(result.status, boundary === 'tool' ? 'FAIL' : 'PASS');
    assert.equal(mock.bodies.length, 1);
    const state = s.readArtifact(s.db.prepare('SELECT state FROM agent_threads').get()!.state) as any;
    assert.ok(state.toolCalls <= cfg.spec.budget.maxToolCalls);
    assert.ok(state.turns <= cfg.spec.budget.maxTurns);
    if (boundary === 'tool') assert.equal(s.db.prepare("SELECT COUNT(*) n FROM agent_events WHERE kind='worker.output'").get()!.n, 0);
  }, s => { enabled(s); s.recipe.attempts = 1; if (boundary === 'tool') s.budget.maxToolCalls = 1; else s.budget.maxTurns = 1; });
});
