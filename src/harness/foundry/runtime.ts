import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonical, combineMeasurements, digest, invariant, validMeasurement, verdict } from "./kernel.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Driver, Json, Lease, Measurement, RunSummary, Task } from "./types.ts";

async function executeAttempt(scheduler: Scheduler, lease: Lease, driver: Driver, outer?: AbortSignal): Promise<void> {
  const store = scheduler.store; const controller = new AbortController(); const t0 = performance.now();
  const cancel = () => controller.abort(new Error("run cancelled"));
  outer?.addEventListener("abort", cancel, { once: true }); if (outer?.aborted) cancel();
  const unknown: Measurement = { tokens: null, costUsd: null }; let measured = unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const capsule = scheduler.capsule(lease);
    const contract = store.contract();
    invariant(driver.verifierId === contract.verifierId && driver.workerId === contract.workerId, "driver identity mismatch");
    const result = await driver.execute(capsule, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(Buffer.byteLength(canonical(result.artifact), "utf8") <= contract.limits.outputBytes, "worker artifact exceeds output budget");
    // A producer's success string is not an acceptance result.
    const check = await driver.verify(capsule, result, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(Buffer.byteLength(canonical(check), "utf8") <= contract.limits.outputBytes, "verifier output exceeds output budget");
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
  catch (e) { controller.abort(e); scheduler.fail(lease, e instanceof Error ? e.message : String(e), measured); }
  finally {
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
  while (!options.signal?.aborted) {
    while (active.size < recipe.parallelism && !options.signal?.aborted) {
      const lease = scheduler.claim(runId, owner); if (!lease) break;
      const promise = executeAttempt(scheduler, lease, driver, options.signal);
      active.add(promise); void promise.then(() => active.delete(promise), () => active.delete(promise));
    }
    const summary = scheduler.summary(runId);
    if (summary.status !== "RUNNING") { await Promise.all(active); return scheduler.summary(runId); }
    if (active.size) await Promise.race(active);
    else {
      // Another process holds leases, or a just-expired lease needs recovery.
      // Poll the durable scheduler, not an LLM, and never rerun verification to observe.
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await Promise.all(active);
  store.transaction(() => store.event("run.paused", { reason: "caller cancelled; resume by run id" }, runId));
  return scheduler.summary(runId);
}
