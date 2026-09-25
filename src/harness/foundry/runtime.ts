import { FatalAttemptError } from "./errors.ts";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonical, combineMeasurements, digest, invariant, validMeasurement, verdict } from "./kernel.ts";
import { ProgressWindow } from "./productivity.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { AttemptControl, Driver, Json, Lease, Measurement, RunSummary, Task } from "./types.ts";

async function executeAttempt(scheduler: Scheduler, lease: Lease, driver: Driver, outer?: AbortSignal): Promise<void> {
  const store = scheduler.store; const controller = new AbortController(); const t0 = performance.now();
  const cancel = () => controller.abort(new Error("run cancelled"));
  outer?.addEventListener("abort", cancel, { once: true }); if (outer?.aborted) cancel();
  const unknown: Measurement = { tokens: null, costUsd: null }; let measured = unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const recipe = store.recipe(lease.recipeHash);
  const progress = new ProgressWindow(t0);
  let stage: "prepare" | "execute" | "verify" = "prepare";
  let artifactHash: string | null = null; let verificationHash: string | null = null;
  let closed = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (recipe.noProgressMs && !controller.signal.aborted) idleTimer = setTimeout(() => {
      controller.abort(new Error(`NO_PROGRESS: ${stage}; split the task or repair the adapter`));
    }, recipe.noProgressMs);
  };
  const control: AttemptControl = { progress(fingerprint) {
    if (closed || controller.signal.aborted || recipe.noProgressMs === undefined) return;
    invariant(typeof fingerprint === "string" && fingerprint.length > 0 &&
      Buffer.byteLength(fingerprint, "utf8") <= 256, "invalid progress fingerprint");
    const key = digest({ stage, fingerprint });
    if (!progress.observe(key, performance.now())) return;
    if (!scheduler.progress(lease, key)) { controller.abort(new Error("stale lease")); return; }
    armIdle();
  } };
  const work = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const capsule = scheduler.capsule(lease);
    const contract = store.contract();
    invariant(driver.verifierId === contract.verifierId && driver.workerId === contract.workerId, "driver identity mismatch");
    stage = "execute"; armIdle();
    const result = await driver.execute(capsule, controller.signal, recipe.noProgressMs === undefined ? undefined : control);
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(Buffer.byteLength(canonical(result.artifact), "utf8") <= contract.limits.outputBytes, "worker artifact exceeds output budget");
    artifactHash = digest(result.artifact);
    // A producer's success string is not an acceptance result. Verification is
    // also bounded: a hung test process cannot occupy a slot indefinitely.
    stage = "verify"; armIdle();
    const check = await driver.verify(capsule, result, controller.signal, recipe.noProgressMs === undefined ? undefined : control);
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(Buffer.byteLength(canonical(check), "utf8") <= contract.limits.outputBytes, "verifier output exceeds output budget");
    verificationHash = digest({ artifactHash: check.artifactHash, checks: check.checks });
    measured = combineMeasurements(validMeasurement(result.measurement), validMeasurement(check.measurement));
    const metrics = { ...measured, durationMs: performance.now() - t0 };
    const decision = verdict(contract, result.artifact, check, metrics);
    invariant(decision === "PASS", `verification ${decision}`);
    if (controller.signal.aborted) throw controller.signal.reason;
    const evidence = { contractHash: lease.contractHash, recipeHash: lease.recipeHash, verifierId: driver.verifierId,
      taskHash: digest(capsule.task), artifactHash: digest(result.artifact), verification: JSON.parse(canonical(check)), metrics } as Json;
    scheduler.finish(lease, result.artifact, evidence, measured);
  };
  // Abort races also cover a buggy adapter that never resolves. Its late output
  // is fenced off. Resource cancellation still requires the adapter to cooperate.
  let abortHandler: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abortHandler = () => reject(controller.signal.reason ?? new Error("aborted"));
    controller.signal.addEventListener("abort", abortHandler, { once: true });
    if (controller.signal.aborted) abortHandler();
    timer = setTimeout(() => controller.abort(new Error("attempt deadline exceeded")), Math.max(1, lease.deadline - Date.now()));
  });
  try { await Promise.race([work(), stopped]); }
  catch (e) {
    controller.abort(e);
    const reason = e instanceof Error ? e.message : String(e);
    scheduler.fail(lease, reason, measured, Date.now(), {
      // Retrying the same oversized/invalid capsule cannot repair its contract.
      retryable: !(e instanceof FatalAttemptError) && (stage !== "prepare" || !!outer?.aborted),
      fingerprint: digest({ stage, reason, artifactHash, verificationHash }),
    });
  }
  finally {
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (timer) clearTimeout(timer); if (abortHandler) controller.signal.removeEventListener("abort", abortHandler);
    outer?.removeEventListener("abort", cancel);
  }
}

/** Bounded DAG execution; a different process may claim the same run safely. */
export async function runTasks(store: Store, tasks: Task[], driver: Driver,
  options: { recipeHash?: string; resumeRun?: string; signal?: AbortSignal } = {}): Promise<RunSummary> {
  invariant(driver.verifierId === store.contract().verifierId && driver.workerId === store.contract().workerId, "driver identity mismatch");
  const scheduler = new Scheduler(store);
  const runId = options.resumeRun ?? scheduler.start(tasks, options.recipeHash);
  const pinned = scheduler.summary(runId).recipeHash;
  invariant(!options.recipeHash || options.recipeHash === pinned, "resume recipe mismatch");
  if (options.resumeRun && tasks.length) {
    const actual = store.db.prepare("SELECT spec FROM tasks WHERE run=? ORDER BY id").all(runId).map(t => JSON.parse(t.spec));
    const expected = [...tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    invariant(digest(actual) === digest(expected), "resume task graph mismatch");
  }
  const recipe = store.recipe(pinned);
  const owner = randomUUID(); const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  // One listener on the caller's signal, even for hundreds of local workers.
  const cancelAll = () => { for (const c of controllers) c.abort(options.signal?.reason ?? new Error("run cancelled")); };
  options.signal?.addEventListener("abort", cancelAll, { once: true });
  let idleMs = 25;
  try {
    while (!options.signal?.aborted) {
      if (active.size < recipe.parallelism) {
        const leases = scheduler.claimMany(runId, owner, recipe.parallelism - active.size);
        for (const lease of leases) {
          const controller = new AbortController(); controllers.add(controller);
          if (options.signal?.aborted) controller.abort(options.signal.reason);
          const promise = executeAttempt(scheduler, lease, driver, controller.signal);
          active.add(promise);
          const release = () => { active.delete(promise); controllers.delete(controller); };
          void promise.then(release, release);
        }
      }
      // Do not rescan every attempt/metric just to ask whether the run ended.
      if (scheduler.status(runId) !== "RUNNING") { await Promise.all(active); return scheduler.summary(runId); }
      if (active.size) {
        idleMs = 25;
        if (active.size < recipe.parallelism) {
          // A remote worker can unlock a child while a local worker is still
          // running. Refill spare slots without waiting for that local straggler.
          const wake = new AbortController();
          try { await Promise.race([...active, idleWait(250, wake.signal)]); }
          finally { wake.abort(); }
        } else await Promise.race(active);
      }
      else {
        // Same-process completions are event-driven. Cross-process claims use
        // bounded backoff (at most 250 ms), rather than constant busy polling.
        await idleWait(idleMs, options.signal); idleMs = Math.min(250, idleMs * 2);
      }
    }
    await Promise.all(active);
    store.transaction(() => store.event("run.paused", { reason: "caller cancelled; resume by run id" }, runId));
    return scheduler.summary(runId);
  } finally {
    options.signal?.removeEventListener("abort", cancelAll);
    cancelAll(); await Promise.allSettled(active);
  }
}

function idleWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}
