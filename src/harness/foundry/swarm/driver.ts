import { canonical, digest, invariant, allocateContext } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Store } from "../store.ts";
import type { AttemptControl, Capsule, Driver, Json, Task, Verification, WorkerResult } from "../types.ts";
import { keys, type PinnedSwarm } from "./config.ts";
import { inlineReceipt, type Call } from "./context.ts";
import { HttpBrain } from "./model.ts";
import { SessionJournal, type Thread } from "./session.ts";
import { localGitBackend, type HandsBackend } from "./workspace.ts";

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
  readonly store: Store; readonly cfg: PinnedSwarm; readonly backend: HandsBackend;
  private contextPlan?: { run: string; recipe: string; budgets: Map<string, number> };
  constructor(store: Store, cfg: PinnedSwarm, fetcher?: typeof fetch, backend: HandsBackend = localGitBackend) {
    invariant(backend.id === cfg.handsId, "execution backend identity mismatch");
    this.store = store; this.cfg = cfg; this.backend = backend;
    this.workerId = workerIdentity(cfg); this.verifierId = verifierIdentity(cfg);
    this.journal = new SessionJournal(store); this.brain = new HttpBrain(this.journal, fetcher);
  }
  async execute(c: Capsule, signal: AbortSignal, control?: AttemptControl): Promise<WorkerResult> {
    const profile = this.cfg.spec.agents[c.task.agent ?? this.cfg.spec.defaultAgent]; invariant(profile, "unknown agent profile");
    const t = this.journal.open(c, { history: [{ role: "user", content: canonical({
      task: c.task, dependencies: c.dependencies,
      contract: "Implement only this task. Use tools to inspect and edit scoped files. Run named checks. End with a concise summary, never a claimed PASS. The host independently verifies. Full tool output is retained in recall receipts. Do not delegate or edit infrastructure." }) }],
      turns: 0, toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null });
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
    if (this.contextPlan?.run !== c.runId || this.contextPlan.recipe !== c.recipeHash) {
      const allTasks: Task[] = this.store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(c.runId).map(r => JSON.parse(r.spec));
      this.contextPlan = { run: c.runId, recipe: c.recipeHash,
        budgets: allocateContext(allTasks, this.store.recipe(c.recipeHash), this.store.contract().limits.contextBytes) };
    }
    const limit = this.contextPlan.budgets.get(c.task.id)!;
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
          for (const call of calls) {
            const resuming = t.state.pending?.id === call.id;
            if (!resuming) {
              if (t.state.toolCalls >= budget.maxToolCalls) throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
              t.state.toolCalls++;
            }
            t.state.pending = call; this.journal.checkpoint(t, "tool.intent", call);
            let result: Json;
            try {
              invariant(profile.tools.includes(call.name as any), "tool not allowed");
              if (call.name === "recall") {
                const a = call.arguments; keys(a, [], ["receipt", "offset", "length", "historyAfter", "limit"]);
                if (a.receipt !== undefined) {
                  invariant(typeof a.receipt === "string" && a.historyAfter === undefined && a.limit === undefined, "ambiguous recall");
                  result = this.journal.recall(c, a.receipt, a.offset as number | undefined, a.length as number | undefined);
                } else {
                  invariant(a.offset === undefined && a.length === undefined && (a.limit === undefined || (Number.isInteger(a.limit) && (a.limit as number) <= 10)), "invalid history recall");
                  result = this.journal.historyPage(c, a.historyAfter as number | undefined, a.limit as number | undefined);
                }
              } else result = await hands.tool(call);
            } catch (e) {
              signal.throwIfAborted(); this.journal.assertLease(c);
              if (e instanceof FatalAttemptError) throw e;
              result = { error: e instanceof Error ? e.message.slice(0, 2048) : "tool error" };
            }
            // Snapshot even a failed tool: a trusted command may have partially edited files.
            if (["write_file", "edit_file", "delete_file", "run_check"].includes(call.name)) t.state.patchHash = await hands.snapshot();
            const receipt = this.journal.receipt(c, result);
            t.state.history.push({ role: "tool", callId: call.id, content: inlineReceipt(receipt, result) });
            t.state.pending = null; this.journal.checkpoint(t, "tool.result", { callId: call.id, receipt, patchHash: t.state.patchHash });
            control?.progress(`tool:${receipt}`);
          }
          continue;
        }
        // A persisted model reply without tools represents a final answer.
        const last = t.state.history.at(-1)!;
        if (last.role === "assistant" && !last.calls?.length) {
          const patchHash = t.state.patchHash ?? this.store.artifact("");
          t.state.output = { schema: 1, patchHash, summary: last.content.slice(0, 4096) };
          this.journal.checkpoint(t, "worker.output", t.state.output); continue;
        }
        if (t.state.turns >= budget.maxTurns) throw new FatalAttemptError("THREAD_TURN_BUDGET_EXHAUSTED");
        this.journal.checkpoint(t, "model.intent", { step: t.state.turns });
        const next = await this.brain.next(c, profile, t.state.history, budget, limit, signal, t.state.turns);
        t.state.history = [...next.history, next.turn.message]; t.state.turns++;
        this.journal.checkpoint(t, "model.reply", next.turn.message);
        control?.progress(`model:${t.state.turns}:${digest(next.turn.message)}`);
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
