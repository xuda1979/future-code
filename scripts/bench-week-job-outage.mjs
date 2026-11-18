// Accelerate the clock of an eight-day job. The job and link are scripted.
// Scheduling, durable deferrals, task fencing and terminal receipts use the
// supplied checkout's production code and real on-disk SQLite state.
// Usage: node scripts/bench-week-job-outage.mjs /path/to/checkout recovered|blocked
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const expected = process.argv[3];
assert.ok(expected === undefined || ['recovered', 'blocked'].includes(expected), 'expected recovered or blocked');
const load = path => import(pathToFileURL(join(runtime, path)).href);
const [{ fixture, signal, task }, { Scheduler }, { Store }, { ResearchJobs }, { SessionJournal },
  { DeferredAttemptError }, { FatalAttemptError }] = await Promise.all([
  load('tests/foundry/swarm-fixtures.ts'), load('src/harness/foundry/scheduler.ts'),
  load('src/harness/foundry/store.ts'), load('src/harness/foundry/swarm/jobs.ts'),
  load('src/harness/foundry/swarm/session.ts'), load('src/harness/foundry/continuation.ts'),
  load('src/harness/foundry/errors.ts'),
]);
const hour = 3_600_000;
const lossAt = 150 * hour;
const restoredAt = 192 * hour;
const restartHours = [120, 151];
const realNow = Date.now;
const codeDigest = createHash('sha256').update(readFileSync(join(runtime, 'src/harness/foundry/swarm/jobs.ts'))).digest('hex');

await fixture(async (admin, cfg) => {
  const start = realNow();
  let now = start;
  let controllerStore = await Store.open(admin.root);
  let scheduler = new Scheduler(controllerStore);
  const requests = [];
  let failedInspections = 0;
  let reopens = 0;
  let recoveredValue = null;
  let failure = null;
  const request = { id: 'compute-42', name: 'run_job', arguments: { name: 'compute', input: { seeds: [6, 7] } } };
  const adapter = async (_command, _cfg, message) => {
    const elapsed = now - start;
    requests.push({ elapsed, operation: message.operation, id: message.jobId, key: message.key });
    if (elapsed >= lossAt && elapsed < restoredAt) {
      failedInspections++;
      throw new Error('controlled transport outage');
    }
    const reply = { schema: 1, key: message.key, jobId: 'original-job' };
    if (elapsed >= restoredAt) return { ...reply, status: 'SUCCEEDED', result: { value: 6 * 7 } };
    return { ...reply, status: 'RUNNING', progressToken: `phase-${Math.floor(elapsed / (6 * hour))}` };
  };
  let jobs = new ResearchJobs(new SessionJournal(controllerStore), cfg, adapter);
  Date.now = () => now;
  try {
    const run = scheduler.start([task()]);
    for (let episode = 0; episode < 10_000; episode++) {
      const lease = scheduler.claim(run, `controller-${reopens}`);
      assert.ok(lease, 'durable task was not claimable at its scheduled wake');
      try {
        const reply = await jobs.execute(scheduler.capsule(lease), cfg.spec.agents.coder, request, signal());
        assert.equal(reply.status, 'SUCCEEDED');
        assert.equal(reply.result.value, 42);
        recoveredValue = reply.result.value;
        break;
      } catch (error) {
        if (!(error instanceof DeferredAttemptError)) {
          assert.ok(error instanceof FatalAttemptError && /REMOTE_JOB_RECONCILIATION_REQUIRED/.test(error.message),
            `unexpected failure: ${error}`);
          failure = 'REMOTE_JOB_RECONCILIATION_REQUIRED';
          break;
        }
        assert.equal(scheduler.defer(lease, error), true);
      }
      const wait = controllerStore.db.prepare('SELECT wake FROM task_waits WHERE run=? AND task=?').get(run, lease.taskId);
      assert.ok(wait && wait.wake > now, 'a retry must schedule a future wake');
      now = wait.wake;
      if (reopens < restartHours.length && now - start >= restartHours[reopens] * hour) {
        controllerStore.close();
        controllerStore = await Store.open(admin.root);
        scheduler = new Scheduler(controllerStore);
        jobs = new ResearchJobs(new SessionJournal(controllerStore), cfg, adapter);
        reopens++;
      }
    }
    assert.ok(recoveredValue !== null || failure, 'episode limit exceeded');
    // Verify outside the adapter: a protocol assertion thrown from inside an RPC
    // would be classified by the host as an ordinary transport failure.
    const [first, ...inspects] = requests;
    assert.ok(first && typeof first.key === 'string' && first.key.length > 0);
    assert.deepEqual(first, { elapsed: 0, operation: 'ensure', id: null, key: first.key });
    assert.ok(inspects.every(req => req.operation === 'inspect' && req.id === 'original-job' && req.key === first.key),
      'every operation after ensure must inspect the original acknowledged identity');
    assert.equal(reopens, restartHours.length);
    const row = controllerStore.db.prepare('SELECT status,progress_at,result_hash FROM research_jobs WHERE key=?').get(first.key);
    const outcome = recoveredValue === null ? 'blocked' : 'recovered';
    if (expected) assert.equal(outcome, expected);
    assert.equal(!!row.result_hash, outcome === 'recovered');
    if (row.result_hash) assert.equal(controllerStore.readArtifact(row.result_hash).result.value, 42);
    assert.equal(scheduler.summary(run).accepted, 0, 'a remote result alone must never accept the project task');
    console.log(JSON.stringify({ outcome, hostJobsSha256: codeDigest, elapsedHours: (now - start) / hour,
      lastSemanticHour: (row.progress_at - start) / hour, outageStartHour: lossAt / hour, remoteReadyHour: restoredAt / hour,
      ensures: 1, inspections: inspects.length, failedInspections, reopens, jobStatus: row.status, terminalReceipt: !!row.result_hash,
      recoveredValue, failure, taskAcceptances: 0 }));
  } finally {
    Date.now = realNow;
    controllerStore.close();
  }
}, spec => {
  spec.jobs = { compute: { adapter: { argv: [process.execPath, '-e', '0'] },
    idempotentEnsure: true, pollMs: hour, staleMs: 8 * hour, maxJobs: 1, maxConcurrent: 1 } };
  spec.agents.coder.jobs = ['compute'];
  spec.agents.coder.tools.push('run_job');
});
