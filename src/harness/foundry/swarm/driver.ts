import { DeferredAttemptError, PersistedDeferredAttemptError } from "../continuation.ts";
import { ResearchJobs, type JobRPC } from "./jobs.ts";
import { checkpointInputKey, shouldRunExploratoryCheckpoint } from "./checkpointPolicy.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { schedulerNode } from "../schedulerIndex.ts";
import { FatalAttemptError } from "../errors.ts";
import { spawnTasks } from "../dynamicDag.ts";
import type { Store } from "../store.ts";
import type { AttemptControl, Capsule, Driver, Json, Task, Verification, WorkerResult, Lease, Measurement } from "../types.ts";
import { keys, validateSwarmTasks, type PinnedSwarm } from "./config.ts";
import { inlineReceipt, type Call, type ProgressCheckpoint } from "./context.ts";
import { HttpBrain } from "./model.ts";
import { SessionJournal, type Thread } from "./session.ts";
import { localGitBackend, type HandsBackend } from "./workspace.ts";
import { toolEffectContract } from "./toolEffects.ts";
import { requireAdmission, submitProposal } from "../proposals.ts";
import { claimsForGoals, proposeClaim, proposeClaimConflict, type ClaimInput } from "../claims.ts";
import { validateToolProposal } from "./toolAdmission.ts";
import { CohortBoard, type FindingInput } from "./cohorts.ts";
import { performance } from "node:perf_hooks";

export const workerIdentity = (cfg: PinnedSwarm): string => digest({ adapter: "foundry-swarm-worker-v1", cfg });
export const verifierIdentity = (cfg: PinnedSwarm): string => digest({ adapter: "foundry-swarm-independent-checks-v1", cfg });
const toJson = (v: unknown): Json => JSON.parse(canonical(v));
function outstanding(t: Thread): Call[] {
  for (let i = t.state.history.length - 1; i >= 0; i--) {
    const message = t.state.history[i];
    if (message.role === "assistant") {
      const done = new Set(t.state.history.slice(i + 1).filter(m => m.role === "tool").map(m => m.callId));
      return (message.calls ?? []).filter(c => !done.has(c.id));
    }
  }
  return [];
}
/** The model chooses tools, not leases or acceptance. Foundry remains the scheduler. */
export class SwarmDriver implements Driver {
  readonly workerId: string; readonly verifierId: string;
  readonly journal: SessionJournal; readonly brain: HttpBrain;
  readonly store: Store; readonly cfg: PinnedSwarm; readonly backend: HandsBackend; readonly jobRpc?: JobRPC;
  readonly cohorts: CohortBoard | null;
  readonly accepted?: Driver["accepted"];
  constructor(store: Store, cfg: PinnedSwarm, fetcher?: typeof fetch, backend: HandsBackend = localGitBackend,
    jobRpc?: JobRPC) {
    invariant(backend.id === cfg.handsId, "execution backend identity mismatch");
    this.store = store; this.cfg = cfg; this.backend = backend; this.jobRpc = jobRpc;
    this.workerId = workerIdentity(cfg); this.verifierId = verifierIdentity(cfg);
    this.journal = new SessionJournal(store); this.brain = new HttpBrain(this.journal, fetcher);
    this.cohorts = cfg.spec.coordination ? new CohortBoard(store, cfg, this.journal) : null;
    if (this.cohorts) this.accepted = (c, artifact, artifactHash, evidenceHash) =>
      this.cohorts!.accepted(c, artifact, artifactHash, evidenceHash);
  }
  measurement(lease: Lease): Measurement {
    return { tokens: this.journal.usage(lease.runId, lease.taskId, lease.fence).tokens, costUsd: null };
  }
  async execute(c: Capsule, signal: AbortSignal, control?: AttemptControl): Promise<WorkerResult> {
    if (!this.cohorts) return this.executeThread(c, signal, control);
    this.cohorts.claim(c);
    try { return await this.executeThread(c, signal, control); }
    finally { this.cohorts.release(c); }
  }
  private async executeThread(c: Capsule, signal: AbortSignal, control?: AttemptControl): Promise<WorkerResult> {
    const profile = this.cfg.spec.agents[c.task.agent ?? this.cfg.spec.defaultAgent]; invariant(profile, "unknown agent profile");
    const canSpawn = profile.tools.includes("spawn_tasks") && !!this.cfg.spec.supervision?.dynamicDAG;
    const admittedContext = schedulerNode(this.store, c.runId, c.task.id)?.budget ?? this.store.recipe(c.recipeHash).contextBytes;
    const t = this.journal.open(c, { history: [{ role: "user", content: canonical({
      task: c.task, dependencies: c.dependencies,
      ...(this.cohorts ? { coordination: { cohort: this.cohorts.cohort(c),
        digestBytes: this.cfg.spec.coordination!.maxDigestBytes,
        instruction: "Read bounded cohort/shared findings when useful. Explore alternate methods and counterexamples. Share concise findings with owned receipts. Every summary is unverified; cross-cohort source checks certify only the exact accepted task artifact. Findings cannot change your acceptance, dependencies or file scopes." } } : {}),
      contract: "Implement only this task. Use tools to inspect and edit scoped files. Run named checks. End with a concise summary, never a claimed PASS. The host independently verifies. Full tool output is retained in recall receipts. " +
        (canSpawn ? "You may use spawn_tasks to divide genuinely independent work; the host owns scheduling, scope, budgets and child acceptance. " : "Do not delegate. ") +
        (profile.tools.includes("save_progress") ? "Before long context retirement, call save_progress with concise current findings, blockers, exact next step, and owned evidence receipts; notes remain unverified. " : "") +
        (profile.tools.includes("run_job") ? "For independent experiments, issue every ready run_job call in one assistant turn so the host can launch them concurrently; do not wait for one experiment before proposing another independent one. " : "") +
        "Do not edit harness infrastructure outside the declared task scope." }) }],
      turns: 0, toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null,
      contextLimit: admittedContext });
    const resumed = c.fence > (t.state.lastFence ?? 0);
    if (resumed) {
      const prior = this.store.db.prepare("SELECT status FROM attempts WHERE run=? AND task=? AND fence<? ORDER BY fence DESC LIMIT 1").get(c.runId, c.task.id, c.fence);
      if (prior && ["FAIL", "EXPIRED"].includes(prior.status)) {
        // Defer the repair instruction until outstanding tool pairs are closed.
        t.state.recoveryNote = "The previous episode failed or exceeded its deadline. The latest patch/checkpoints are preserved. Inspect failing checks, reduce the decision scope, and change strategy rather than repeating the same action. Use run_job for long external work.";
      }
      t.state.lastFence = c.fence;
    }
    const feedbackHash = this.journal.feedback(c);
    if (t.state.output && feedbackHash && feedbackHash !== t.state.feedbackHash) {
      const feedback = this.store.readArtifact(feedbackHash);
      const receipt = this.journal.receipt(c, feedback);
      const details: Json[] = [];
      for (const check of (feedback as any).checks ?? []) {
        if (typeof check.detail === "string" && /^[a-f0-9]{64}$/.test(check.detail)) {
          const data = this.store.readArtifact(check.detail); const id = this.journal.receipt(c, data);
          details.push({ check: check.id, receipt: id, excerpt: inlineReceipt(id, data, 2048) });
        }
      }
      t.state.history.push({ role: "user", content: canonical({ repairRequired: true, feedback: inlineReceipt(receipt, feedback), details }) });
      t.state.feedbackHash = feedbackHash; t.state.output = null;
      this.journal.checkpoint(t, "verification.feedback", { receipt });
    }
    const hands = this.backend.open(this.store, this.cfg, c, profile, signal, t.state.patchHash);
    const budget = this.cfg.spec.budget;
    const timedTool = async <T>(work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try { return await work(); } finally { control?.timing?.("tool", Math.max(0, performance.now() - started)); }
    };
    const runJob = (call: Call) => timedTool(() => jobs!.execute(c, profile, call, signal,
      ms => control?.timing?.("remote-rpc", ms)));
    const admitCall = (call: Call) => {
      const kind = call.name === "spawn_tasks" ? "SPAWN" : call.name === "propose_claim" ? "CLAIM" :
        call.name === "propose_conflict" ? "CONFLICT" : "TOOL_CALL";
      const proposal = submitProposal(this.store, kind, call, c, `agent:${c.task.agent ?? this.cfg.spec.defaultAgent}:turn:${t.state.turns}`);
      requireAdmission(this.store, proposal, value => validateToolProposal(c, this.cfg, profile, value));
      return proposal.id;
    };
    const admitReply = (message: typeof t.state.history[number]) => {
      const proposal = submitProposal(this.store, "RESPONSE", message, c, `agent:${c.task.agent ?? this.cfg.spec.defaultAgent}:turn:${t.state.turns}`);
      return requireAdmission(this.store, proposal, value => {
        invariant(value.role === "assistant" && typeof value.content === "string", "invalid response proposal");
      });
    };
    const jobs = this.cfg.spec.jobs ? new ResearchJobs(this.journal, this.cfg, this.jobRpc) : null;
    t.state.lastCheckAt ??= Date.now();
    const limit = t.state.contextLimit!;
    invariant(Number.isSafeInteger(limit) && limit > 0 &&
      limit <= this.store.contract().limits.contextBytes, "invalid durable context limit");
    try {
      if (t.state.pending?.name === "run_check") {
        const name = t.state.pending.arguments.name as string;
        if (!this.cfg.spec.checks[name]?.replaySafe) throw new FatalAttemptError("IN_DOUBT_EFFECT: non-replay-safe check needs operator reconciliation");
      }
      for (;;) {
        signal.throwIfAborted(); this.journal.assertLease(c);
        if (t.state.output) return { artifact: toJson(t.state.output), measurement: { tokens: this.journal.usage(c.runId, c.task.id, c.fence).tokens, costUsd: null } };
        const calls = outstanding(t);
        if (calls.length) {
          const remoteBatch = calls.filter(call => call.name === "run_job");
          if (remoteBatch.length > 1) {
            invariant(jobs, "no remote job templates configured");
            const alreadyPending = new Set(t.state.pendingBatch ?? []);
            const fresh = remoteBatch.filter(call => !alreadyPending.has(call.id));
            invariant(t.state.toolCalls + fresh.length <= budget.maxToolCalls,
              "THREAD_TOOL_BUDGET_EXHAUSTED");
            t.state.toolCalls += fresh.length;
            t.state.pending = null;
            t.state.pendingBatch = remoteBatch.map(call => call.id);
            for (const call of remoteBatch) admitCall(call);
            for (const call of fresh) {
              invariant(profile.tools.includes(call.name as any), "tool not allowed");
              const effect = toolEffectContract(this.cfg, call.name as any, call.arguments);
              this.journal.checkpoint(t, "tool.effect", { callId: call.id, ...effect });
              this.journal.checkpoint(t, "tool.intent", call);
            }
            this.journal.checkpoint(t, "tool.batch.intent", {
              kind: "run_job", callIds: t.state.pendingBatch,
            });
            control?.activity?.(`remote-batch:launch:${remoteBatch.length}`);
            const outcomes = await Promise.allSettled(
              remoteBatch.map(runJob)
            );
            const deferred: DeferredAttemptError[] = [];
            let terminalError: Error | null = null;
            const stillPending: string[] = [];
            for (let i = 0; i < outcomes.length; i++) {
              const call = remoteBatch[i]!;
              const outcome = outcomes[i]!;
              if (outcome.status === "rejected") {
                const error = outcome.reason;
                if (error instanceof DeferredAttemptError) {
                  deferred.push(error); stillPending.push(call.id); continue;
                }
                if (error instanceof FatalAttemptError) {
                  terminalError ??= error; continue;
                }
                const result: Json = { error: error instanceof Error ? error.message.slice(0, 2048) : "tool error" };
                const receipt = this.journal.receipt(c, result);
                t.state.history.push({ role: "tool", callId: call.id, receipt, content: inlineReceipt(receipt, result) });
                this.journal.checkpoint(t, "tool.result", { callId: call.id, receipt, patchHash: t.state.patchHash });
                continue;
              }
              const result = outcome.value;
              const receipt = this.journal.receipt(c, result);
              t.state.lastJobReceipt = receipt;
              t.state.history.push({ role: "tool", callId: call.id, receipt, content: inlineReceipt(receipt, result) });
              this.journal.checkpoint(t, "tool.result", { callId: call.id, receipt, patchHash: t.state.patchHash });
            }
            if (stillPending.length) t.state.pendingBatch = stillPending;
            else delete t.state.pendingBatch;
            this.journal.checkpoint(t, "tool.batch.result", {
              completed: remoteBatch.length - stillPending.length,
              pending: stillPending,
            });
            if (terminalError) throw terminalError;
            if (deferred.length) {
              const wakeAt = Math.min(...deferred.map(error => error.wakeAt));
              const capacity = deferred.find(error => error.capacity);
              throw new DeferredAttemptError("remote-job", wakeAt,
                capacity?.message ?? `${stillPending.length} remote experiment(s) still running; batch resume scheduled`, capacity?.capacity);
            }
            control?.activity?.(`remote-batch:completed:${remoteBatch.length}`);
            continue;
          }
          for (const call of calls) {
            const resuming = t.state.pending?.id === call.id || t.state.pendingBatch?.includes(call.id) === true;
            if (!resuming) {
              if (t.state.toolCalls >= budget.maxToolCalls) throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
              t.state.toolCalls++;
            }
            t.state.pending = call;
            let result: Json;
            let admitted = false;
            control?.activity?.(`tool:${call.name}`);
            try {
              const proposalId = admitCall(call);
              admitted = true;
              const effect = toolEffectContract(this.cfg, call.name as any, call.arguments);
              this.journal.checkpoint(t, "tool.effect", { callId: call.id, proposalId, ...effect });
              this.journal.checkpoint(t, "tool.intent", call);
              if (call.name === "spawn_tasks") {
                const policy = this.cfg.spec.supervision?.dynamicDAG;
                invariant(policy, "dynamic DAG spawning is not configured");
                const a = call.arguments; keys(a, ["children"]);
                invariant(Array.isArray(a.children) && a.children.length > 0, "spawn_tasks requires children");
                const rawChildren = (a.children as unknown[]).map(item => {
                  invariant(item && typeof item === "object" && !Array.isArray(item), "invalid spawned child");
                  const raw = item as Record<string, any>;
                  keys(raw, ["id", "goal", "acceptance", "input", "writeScope", "readScope"],
                    ["dependsOn", "agent", "priority", "estimatedDurationMs", "contextBudget"]);
                  invariant(typeof raw.id === "string" && raw.id.length > 0, "invalid child id");
                  return raw;
                });
                const localIds = new Set(rawChildren.map(raw => raw.id as string));
                invariant(localIds.size === rawChildren.length, "duplicate spawned child id");
                const children: Task[] = rawChildren.map(raw => {
                  const dependsOn = raw.dependsOn ?? [];
                  invariant(Array.isArray(dependsOn) && dependsOn.length <= policy.maxChildrenPerTask &&
                    dependsOn.every((id: unknown) => typeof id === "string") &&
                    new Set(dependsOn).size === dependsOn.length, "invalid spawned child dependencies");
                  for (const id of dependsOn as string[]) invariant(localIds.has(id) && id !== raw.id,
                    "spawned child dependency must name another child in this batch");
                  const child: Task = { id: `${c.task.id}.${raw.id}`, goal: raw.goal, acceptance: raw.acceptance,
                    dependencies: [...c.task.dependencies, ...(dependsOn as string[]).map(id => `${c.task.id}.${id}`)],
                    writeScope: raw.writeScope, readScope: raw.readScope, input: raw.input };
                  const agent = raw.agent ?? c.task.agent;
                  if (agent !== undefined) child.agent = agent;
                  if (raw.priority !== undefined) child.priority = raw.priority;
                  if (raw.estimatedDurationMs !== undefined) child.estimatedDurationMs = raw.estimatedDurationMs;
                  if (raw.contextBudget !== undefined) child.contextBudget = raw.contextBudget;
                  if (c.task.dependencyViews !== undefined)
                    child.dependencyViews = JSON.parse(canonical(c.task.dependencyViews));
                  return child;
                });
                validateSwarmTasks(this.cfg.spec, children);
                const reason = `Spawned ${children.length} child task(s); parent resumes after independent verification`;
                const spawned = spawnTasks(this.store, c, call.id, digest(call.arguments), children, policy,
                  Date.now(), { reason, wakeAt: Date.now(), measurement: {
                    tokens: this.journal.usage(c.runId, c.task.id, c.fence).tokens, costUsd: null,
                  } });
                if (!spawned.complete) {
                  invariant(spawned.parentDeferred, "spawn admission did not durably yield parent");
                  throw new PersistedDeferredAttemptError("spawn", Date.now(), reason);
                }
                result = { childIds: spawned.childIds, verified: spawned.dependencies };
              } else if (call.name === "run_job") {
                invariant(jobs, "no remote job templates configured");
                result = await runJob(call);
              } else if (call.name === "propose_claim") {
                result = toJson(proposeClaim(this.store, c.runId, c.task.id, call.arguments as unknown as ClaimInput, proposalId));
              } else if (call.name === "propose_conflict") {
                const a = call.arguments;
                result = { conflictId: proposeClaimConflict(this.store, c.runId, c.task.id,
                  a.leftClaim as string, a.rightClaim as string, proposalId), status: "OPEN" };
              } else if (call.name === "read_claims") {
                const a = call.arguments;
                const claims = claimsForGoals(this.store, c.runId, [c.task.id, ...c.task.dependencies], a.after as string | undefined, a.limit as number | undefined);
                result = toJson({ claims, nextAfter: claims.at(-1)?.id ?? a.after ?? "" });
              } else if (call.name === "publish_finding") {
                invariant(this.cohorts, "cohort coordination is not configured");
                result = this.cohorts.publish(c, call.arguments as unknown as FindingInput, t.state.patchHash);
              } else if (call.name === "read_findings") {
                invariant(this.cohorts, "cohort coordination is not configured");
                const a = call.arguments;
                result = this.cohorts.read(c, a.audience as "cohort" | "shared", a.after as number | undefined,
                  a.limit as number | undefined, limit);
              } else if (call.name === "save_progress") {
                const a = call.arguments;
                const receipts = a.receipts as string[];
                invariant(receipts.every(hash => this.journal.ownsReceipt(c, hash)), "unowned progress receipt");
                const progress: ProgressCheckpoint = { summary: a.summary as string,
                  nextAction: a.nextAction as string, receipts,
                  patchHash: t.state.patchHash, atTurn: t.state.turns };
                t.state.progress = progress;
                result = { saved: true, trust: "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE", turn: progress.atTurn };
              } else if (call.name === "recall") {
                const a = call.arguments; keys(a, [], ["receipt", "offset", "length", "historyAfter", "limit"]);
                if (a.receipt !== undefined) {
                  invariant(typeof a.receipt === "string" && a.historyAfter === undefined && a.limit === undefined, "ambiguous recall");
                  result = this.journal.recall(c, a.receipt, a.offset as number | undefined, a.length as number | undefined);
                } else {
                  invariant(a.offset === undefined && a.length === undefined && (a.limit === undefined || (Number.isInteger(a.limit) && (a.limit as number) <= 10)), "invalid history recall");
                  result = this.journal.historyPage(c, a.historyAfter as number | undefined, a.limit as number | undefined);
                }
              } else result = await timedTool(() => hands.tool(call));
            } catch (e) {
              signal.throwIfAborted();
              // Atomic spawn deferral intentionally invalidates the current lease
              // in the same transaction that admitted children.
              if (e instanceof PersistedDeferredAttemptError) throw e;
              this.journal.assertLease(c);
              if (e instanceof FatalAttemptError || e instanceof DeferredAttemptError) throw e;
              result = { error: e instanceof Error ? e.message.slice(0, 2048) : "tool error" };
            }
            // Snapshot even a failed tool: a trusted command may have partially edited files.
            if (admitted && ["write_file", "edit_file", "delete_file", "run_check"].includes(call.name)) {
              const patch = await hands.snapshot();
              if (patch !== t.state.patchHash) control?.progress(`patch:${patch}`);
              t.state.patchHash = patch;
            }
            if (admitted && call.name === "run_check") { t.state.lastCheckAt = Date.now(); control?.checked?.(); }
            const receipt = this.journal.receipt(c, result);
            if (admitted && call.name === "run_job") t.state.lastJobReceipt = receipt;
            t.state.history.push({ role: "tool", callId: call.id, receipt, content: inlineReceipt(receipt, result) });
            t.state.pending = null; this.journal.checkpoint(t, "tool.result", { callId: call.id, receipt, patchHash: t.state.patchHash });
            control?.activity?.(`completed:${call.name}`);
          }
          continue;
        }
        // The provider response and thread checkpoint are separate commits.
        // After a crash, consume the saved reply under its ORIGINAL request hash
        // before adding recovery notes or periodic-check feedback.
        const replay = this.brain.replay(c, profile, t.state.history, budget, limit, t.state.turns, t.state.progress ?? null);
        if (replay) {
          t.state.history = [...replay.history, admitReply(replay.turn.message)]; t.state.turns++;
          this.journal.checkpoint(t, "model.reply", replay.turn.message);
          control?.activity?.("model:replay"); continue;
        }
        // A persisted model reply without tools represents a final answer.
        const last = t.state.history.at(-1)!;
        if (last.role === "assistant" && !last.calls?.length) {
          const patchHash = t.state.patchHash ?? this.store.artifact("");
          t.state.output = { schema: 1, patchHash, summary: last.content.slice(0, 4096) };
          this.journal.checkpoint(t, "worker.output", t.state.output); continue;
        }
        if (t.state.recoveryNote) {
          t.state.history.push({ role: "user", content: t.state.recoveryNote }); delete t.state.recoveryNote;
          this.journal.checkpoint(t, "episode.recovery", { fence: c.fence });
        }
        const checkEvery = this.cfg.spec.supervision?.checkpointEveryMs;
        const checkpointKey = checkpointInputKey(t.state.patchHash, t.state.feedbackHash ? 1 : 0,
          digest({ feedback: t.state.feedbackHash, jobReceipt: t.state.lastJobReceipt ?? null }));
        if (checkEvery && shouldRunExploratoryCheckpoint(t.state.lastExploratoryCheckpointKey, checkpointKey, this.cfg.spec.supervision?.checkpointCadence) &&
            !(t.state.history.at(-1)?.role === "assistant" && !t.state.history.at(-1)?.calls?.length) && Date.now() - t.state.lastCheckAt! >= checkEvery) {
          // Safe tool boundary: do not interrupt a healthy remote experiment.
          if (t.state.toolCalls >= budget.maxToolCalls) throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
          t.state.toolCalls++;
          control?.activity?.("checkpoint:check");
          const call: Call = { id: `checkpoint-${t.seq}`, name: "run_check", arguments: { name: profile.checks[0] } };
          const effect = toolEffectContract(this.cfg, "run_check", call.arguments);
          this.journal.checkpoint(t, "tool.effect", { callId: call.id, ...effect });
          let check: Json;
          try { check = await timedTool(() => hands.tool(call)); } catch (e) { signal.throwIfAborted(); check = { error: e instanceof Error ? e.message.slice(0, 512) : "checkpoint check failed" }; }
          t.state.patchHash = await hands.snapshot();
          const receipt = this.journal.receipt(c, check); t.state.lastCheckAt = Date.now();
          t.state.lastExploratoryCheckpointKey = checkpointInputKey(t.state.patchHash, t.state.feedbackHash ? 1 : 0,
            digest({ feedback: t.state.feedbackHash, jobReceipt: t.state.lastJobReceipt ?? null }));
          control?.checked?.();
          t.state.history.push({ role: "user", content: canonical({ checkpointCheck: inlineReceipt(receipt, check), instruction: "Use this diagnostic to choose a smaller next step. This is not final acceptance." }) });
          this.journal.checkpoint(t, "checkpoint.checked", { receipt, patchHash: t.state.patchHash });
        }
        if (t.state.turns >= budget.maxTurns) throw new FatalAttemptError("THREAD_TURN_BUDGET_EXHAUSTED");
        this.journal.checkpoint(t, "model.intent", { step: t.state.turns });
        control?.activity?.("model:request");
        const next = await this.brain.next(c, profile, t.state.history, budget, limit, signal, t.state.turns, t.state.progress ?? null);
        t.state.history = [...next.history, admitReply(next.turn.message)]; t.state.turns++;
        this.journal.checkpoint(t, "model.reply", next.turn.message);
        control?.activity?.("model:reply");
      }
    } finally { await hands.dispose(); }
  }
  async verify(c: Capsule, result: WorkerResult, signal: AbortSignal, control?: AttemptControl): Promise<Verification> {
    this.journal.assertLease(c);
    const verification = await this.backend.verify(this.store, this.cfg, c, result.artifact, signal);
    signal.throwIfAborted(); this.journal.assertLease(c);
    if (verification.checks.some(check => check.verdict !== "PASS")) this.journal.feedback(c, verification);
    control?.progress(`verify:${digest(verification)}`); return verification;
  }
}
