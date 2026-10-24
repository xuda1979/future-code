import { canonical, digest, invariant } from "../kernel.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { Json, RunSummary, Task } from "../types.ts";
import { loadSwarm, runSwarm } from "../swarm/host.ts";
import { Operations, actionEvidenceGate } from "./actions.ts";
import type { PinnedSwarm } from "../swarm/config.ts";

export type EpisodeRunner = (tasks: Task[], run: string, signal: AbortSignal) => Promise<RunSummary>;
/** One event becomes one bounded episode in the existing execution scheduler. */
export async function operationsTick(store: Store, signal: AbortSignal, runner?: EpisodeRunner,
  cached?: { cfg: PinnedSwarm; ops: Operations }): Promise<Json> {
  const cfg = cached?.cfg ?? loadSwarm(store); invariant(cfg.operations, "operations not configured");
  invariant(digest(store.getMeta("extension.swarm")) === digest(cfg), "service configuration drift");
  const ops = cached?.ops ?? new Operations(store, cfg.operations), mode = ops.events.mode();
  if (mode === "PAUSED") return { status: "PAUSED", state: ops.snapshot() };
  if (Object.hasOwn(cfg.operations.policy.routes ?? {}, "obligation.due")) ops.events.queueDueObligations();
  let event = ops.events.incomplete(1)[0];
  if (!event && mode === "ACTIVE") event = ops.events.due(undefined, 1)[0];
  if (!event && mode === "DRAINING") {
    for (const type of cfg.operations.policy.resolutionEvents ?? []) {
      event = ops.events.due(type, 1)[0]; if (event) break;
    }
  }
  if (!event) return { status: mode === "DRAINING" ? "DRAINING" : "IDLE", state: ops.snapshot() };
  signal.throwIfAborted();
  if (!event.run) {
    const templates = cfg.operations.policy.routes?.[event.type];
    invariant(templates, "event has no pinned route");
    const tasks = templates.map(task => ({ ...JSON.parse(canonical(task)), input: {
      configuration: task.input,
      event: { key: event.key, source: event.source, id: event.id, type: event.type, payload: event.payload,
        receivedAt: event.receivedAt },
    } } as Task));
    event = ops.events.dispatch(event.key, tasks, Date.now(), cfg.operations.policy.resolutionEvents?.includes(event.type) ?? false);
  } else if (event.status === "PREPARED") {
    event = ops.events.dispatch(event.key, store.readArtifact(event.planHash!) as unknown as Task[]);
  }
  const run = event.run!, state = new Scheduler(store).status(run);
  if (state === "FAIL") return { status: "NEEDS_ATTENTION", event: event.key, run, reason: "admitted episode failed; evidence retained" };
  const execute = runner ?? (async (_tasks, id, s) => runSwarm(store, [], s, id));
  const result = state === "PASS" ? new Scheduler(store).summary(run) : await execute([], run, signal);
  if (signal.aborted) return { status: "PAUSED", event: event.key, run };
  const gate = actionEvidenceGate(store, run);
  if (result.status !== "PASS" || gate.status !== "PASS") return { status: "NEEDS_ATTENTION", event: event.key, run, gate } as unknown as Json;
  ops.events.complete(event.key);
  return { status: "PROCESSED", event: event.key, run, gate } as unknown as Json;
}
export async function serveOperations(store: Store, signal: AbortSignal,
  report: (result: Json) => void = value => console.error(canonical(value)), runner?: EpisodeRunner): Promise<Json> {
  const cfg = loadSwarm(store); invariant(cfg.operations, "operations not configured");
  const ops = new Operations(store, cfg.operations); let idleMs = cfg.operations.policy.pollMs; let previous = "";
  while (!signal.aborted) {
    const observed = store.observeChanges();
    const result = await operationsTick(store, signal, runner, { cfg, ops });
    const fingerprint = digest(result); if (fingerprint !== previous) { report(result); previous = fingerprint; }
    if ((result as any).status === "NEEDS_ATTENTION") return result;
    if ((result as any).status === "PROCESSED") { idleMs = cfg.operations.policy.pollMs; continue; }
    const deadline = ops.events.nextDeadline();
    const wait = deadline === null ? idleMs : Math.max(1, Math.min(idleMs, deadline - Date.now()));
    await store.waitForChange(observed, wait, signal);
    idleMs = Math.min(60000, idleMs * 2);
  }
  return { status: "STOPPED", reason: "event state, external commitments and obligations retained" };
}
