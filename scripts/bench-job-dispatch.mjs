// Compare one checked experiment-dispatch task with a two-second polling fallback.
// The model and remote occupancy are scripted. The jobs, workspace, SQLite
// continuation, and task and integration checks execute locally.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Pass a checkout path to replay the same task against another runtime.
const runtime = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const load = path => import(pathToFileURL(resolve(runtime, path)).href);
const [{ fixture, task, reply, scripted, signal }, { Scheduler }, { SwarmDriver },
  { ResearchJobs }, { Store }, { SessionJournal }, { runTasks }, { integrateSwarm }] = await Promise.all([
  load('tests/foundry/swarm-fixtures.ts'), load('src/harness/foundry/scheduler.ts'),
  load('src/harness/foundry/swarm/driver.ts'), load('src/harness/foundry/swarm/jobs.ts'),
  load('src/harness/foundry/store.ts'), load('src/harness/foundry/swarm/session.ts'),
  load('src/harness/foundry/runtime.ts'), load('src/harness/foundry/swarm/host.ts'),
]);

await fixture(async (store, cfg, project) => {
  const scheduler = new Scheduler(store);
  const run = scheduler.start([task()]);
  const busy = scheduler.start([task('b')]);
  const holder = scheduler.capsule(scheduler.claim(busy, 'holder'));
  const templateNames = ['first', 'second'];
  const job = (name, seed) => ({ id: `job-${seed}`, name: 'run_job', arguments: { name, input: { seed } } });
  const controller = new AbortController();
  const adapter = (request, status, result) => ({
    schema: 1, key: request.key, jobId: request.key, status, ...(result ? { result } : {}),
  });
  const holderJobs = new ResearchJobs(new SessionJournal(store), cfg, async (_cmd, _cfg, request) =>
    adapter(request, 'RUNNING'));
  for (const name of templateNames)
    await assert.rejects(holderJobs.execute(holder, cfg.spec.agents.coder, job(name, 0), signal()),
      { name: 'DeferredAttemptError' });

  const peer = await Store.open(store.root);
  const peerJobs = new ResearchJobs(new SessionJournal(peer), cfg);
  const release = template => {
    const row = store.db.prepare('SELECT key FROM research_jobs WHERE run=? AND template=?').get(busy, template);
    return peerJobs.reconcile(busy, row.key, adapter(row, 'SUCCEEDED', { complete: true }));
  };
  const waitFor = async predicate => {
    const end = performance.now() + 12000;
    while (performance.now() < end) {
      const observed = store.observeChanges();
      if (predicate()) return;
      await store.waitForChange(observed, 50, controller.signal);
    }
    throw new Error('Fixture failed to reach the scheduled task state');
  };

  const mock = scripted([
    () => reply('', [job('first', 4), job('second', 6)]),
    body => {
      const evidence = body.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
      assert.match(evidence, /"seed":4,"value":19/);
      assert.match(evidence, /"seed":6,"value":23/);
      return reply('', [{ id: 'write', name: 'write_file', arguments: { path: 'src/a.txt', content: '42\n' } }]);
    },
    () => reply('Checked both job outputs and wrote their sum'),
  ]);
  let releasedAt, readyAt, nextWakeMs;
  const rpc = [];
  const driver = new SwarmDriver(store, cfg, mock.fetcher, undefined, async (_cmd, _cfg, request) => {
    const { seed } = request.input;
    assert.equal(request.operation, 'ensure');
    rpc.push(seed);
    if (seed === 6) readyAt = performance.now();
    const output = execFileSync(process.execPath,
      ['-e', 'console.log(2 * Number(process.argv[1]) + 11)', String(seed)], { encoding: 'utf8' });
    return adapter(request, 'SUCCEEDED', { seed, value: Number(output) });
  });

  const started = performance.now();
  const completed = runTasks(store, [], driver, { resumeRun: run, signal: controller.signal });
  void completed.catch(() => {}); // Observe an early failure while waiting for deferral.
  const deferrals = () => store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run=? AND status='DEFERRED'").get(run).n;
  try {
    await waitFor(() => deferrals() >= 1);
    releasedAt = performance.now();
    release('second');
    nextWakeMs = Math.max(0, Number(store.db.prepare('SELECT wake FROM task_waits WHERE run=?').get(run).wake) - Date.now());
    await waitFor(() => deferrals() >= 2 && readyAt !== undefined);
    release('first');
    const summary = await completed;
    assert.equal(summary.status, 'PASS');
    assert.equal(summary.accepted, 1);
    assert.deepEqual(rpc, [6, 4]);
    assert.equal(mock.bodies.length, 3);
    const integrated = await integrateSwarm(store, run, signal());
    assert.equal(execFileSync('git', ['-C', project, 'show', `${integrated.commit}:src/a.txt`], { encoding: 'utf8' }), '42\n');
    console.log(JSON.stringify({ dispatchMs: readyAt - releasedAt, nextWakeMs,
      verifiedTaskMs: performance.now() - started, requests: mock.bodies.length, jobRPCs: rpc.length, accepted: summary.accepted }));
  } finally {
    controller.abort();
    await completed.catch(() => {});
    peer.close();
  }
}, cfg => {
  const capacity = { adapter: { argv: [process.execPath, '-e', 'process.exit(0)'] },
    idempotentEnsure: true, pollMs: 2000, staleMs: 20000, maxJobs: 4, maxConcurrent: 1 };
  cfg.jobs = { first: { ...capacity }, second: { ...capacity } };
  cfg.agents.coder.jobs = ['first', 'second'];
  cfg.agents.coder.tools.push('run_job');
});
