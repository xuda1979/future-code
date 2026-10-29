import { ResearchProgramme } from "../researchProgramme.ts";
import { verifyResearch } from "./research.ts";
import { decodeSpawnChildren } from "./spawn.ts";
import { DeferredAttemptError, PersistedDeferredAttemptError } from "../continuation.ts";
import { ResearchJobs, type JobRPC } from "./jobs.ts";
import { experimentPipelineContext } from "./experimentPipeline.ts";
import { canSliceExploratoryCheckpoint, checkpointInputKey, evaluationEvidenceKey, shouldRunExploratoryCheckpoint } from "./checkpointPolicy.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { schedulerNode } from "../schedulerIndex.ts";
import { FatalAttemptError } from "../errors.ts";
import { spawnTasks } from "../dynamicDag.ts";
import type { Store } from "../store.ts";
import type { AttemptControl, Capsule, Driver, Json, Verification, WorkerResult, Lease, Measurement } from "../types.ts";
import { keys, type PinnedSwarm } from "./config.ts";
import { inlineReceipt, type Call, type ProgressCheckpoint } from "./context.ts";
import { HttpBrain } from "./model.ts";
import { MAX_CONSECUTIVE_RESPONSE_REJECTIONS, type Turn } from "./response.ts";
import { SessionJournal, type Thread } from "./session.ts";
import { localGitBackend, type HandsBackend } from "./workspace.ts";
import { toolEffectContract } from "./toolEffects.ts";
import { executeToolBatch, nextToolBatch } from "./toolBatches.ts";
import { requireAdmission, submitProposal } from "../proposals.ts";
import { claimsForGoals, proposeClaim, proposeClaimConflict, type ClaimInput } from "../claims.ts";
import { validateToolProposal } from "./toolAdmission.ts";
import { CohortBoard, type FindingInput } from "./cohorts.ts";
import { performance } from "node:perf_hooks";
import { diagnosticContext, diagnosticInputKey, pruningCandidate, recordDiagnostic } from "./diagnostics.ts";
import { failureMemory, progressMemory, readMemory, type MemoryEntry } from "./memory.ts";
import { admitDebuggingCall, finishInversion, inversionCandidate, prepareInversion } from "./debugging.ts";
import { createCombinedAbortSignal } from "../../../utils/combinedAbortSignal.ts";
import { checkpointCheck, checkpointReason } from "./evaluation.ts";
import { DECISION_GUIDANCE } from "../../decisionGuidance.ts";
import { admitDecisionCall, decisionContext } from "./decisions.ts";
import { KNOWLEDGE_NOTICE, ProjectKnowledge, type ExperienceInput, type KnowledgeQuery } from "./knowledge.ts";
import { assertResearchFrontierExpansion } from "./researchStrategy.ts";
import { assertTheoryAcceptance, theoryTaskContext } from "./theory.ts";
import { Operations, actionEvidenceGate } from "../operations/actions.ts";

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
  readonly programme: ResearchProgramme | null;
  readonly knowledge: ProjectKnowledge | null;
  readonly operations: Operations | null;
  readonly accepted?: Driver["accepted"];
  constructor(store: Store, cfg: PinnedSwarm, fetcher?: typeof fetch, backend: HandsBackend = localGitBackend,
    jobRpc?: JobRPC) {
    invariant(backend.id === cfg.handsId, "execution backend identity mismatch");
    this.store = store; this.cfg = cfg; this.backend = backend; this.jobRpc = jobRpc;
    this.workerId = workerIdentity(cfg); this.verifierId = verifierIdentity(cfg);
    this.operations = cfg.operations ? new Operations(store, cfg.operations) : null;
    this.knowledge = cfg.spec.projectKnowledge ? new ProjectKnowledge(store, cfg) : null;
    this.journal = new SessionJournal(store, this.knowledge ?? undefined); this.brain = new HttpBrain(this.journal, fetcher);
    this.cohorts = cfg.spec.coordination ? new CohortBoard(store, cfg, this.journal) : null;
    this.programme = cfg.spec.researchProgramme ? new ResearchProgramme(store, cfg.spec.researchProgramme) : null;
    const hasTheory = Object.values(cfg.spec.jobs ?? {}).some(j => j.research?.spec.schema === 2 && j.research.spec.theory);
    if (this.cohorts || this.programme || this.knowledge || hasTheory) this.accepted = (c, artifact, artifactHash, evidenceHash) => {
      if (hasTheory) assertTheoryAcceptance(store, cfg, c);
      this.cohorts?.accepted(c, artifact, artifactHash, evidenceHash);
      if (this.programme) {
        this.programme.context(c.task.knowledge ?? []);
        this.programme.accepted(c, artifactHash, evidenceHash, Object.fromEntries(Object.entries(cfg.spec.jobs ?? {}).map(([name, job]) => [name, job.research?.provides ?? name])));
      }
      this.knowledge?.accepted(c, artifact, artifactHash, evidenceHash);
    };
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
    const theoretical = theoryTaskContext(this.store, this.cfg, c, Math.floor(admittedContext / 2));
    const t = this.journal.open(c, { history: [{ role: "user", content: canonical({
      task: c.task, dependencies: c.dependencies,
      ...(this.operations ? { capabilities: Object.fromEntries((profile.capabilities ?? []).map(name => {
        const { adapter, ...contract } = this.cfg.operations!.policy.capabilities[name];
        return [name, contract];
      })) } : {}),
      ...(theoretical ? { theoretical } : {}),
      ...(this.programme && c.task.knowledge?.length ? { knowledge: this.programme.context(c.task.knowledge, { theoryStatementsOnly: !!theoretical }) } : {}),
      ...(c.task.research?.length ? { research: Object.fromEntries(c.task.research.map(name => [name, this.cfg.spec.jobs![name].research!.spec])) } : {}),
      ...(this.cfg.spec.supervision?.workflowPolicy ? { workflowChildren: this.store.db.prepare(`SELECT t.id AS taskId,t.artifact AS artifactHash,t.evidence AS evidenceHash
        FROM spawn_edges e JOIN tasks t ON t.run=e.run AND t.id=e.child
        WHERE e.run=? AND e.parent=? AND t.status='PASS' ORDER BY t.id`).all(c.runId, c.task.id) } : {}),
      verification: { checks: profile.checks, finalIntegrationRequired: true },
      ...(profile.diagnostics ? { exploratoryChecks: profile.diagnostics } : {}),
      ...(profile.decisionPolicy ? { decisionPolicy: profile.decisionPolicy } : {}),
      ...(this.cfg.spec.supervision ? { automaticEvaluation: {
        check: checkpointCheck({}, profile),
        maxUnmeasuredTurns: this.cfg.spec.supervision.checkpointEveryTurns ?? 4,
        afterEvidence: this.cfg.spec.supervision.checkpointAfterEvidence !== false,
      } } : {}),
      ...(profile.probes ? { exploratoryProbes: profile.probes.map(name => ({ name,
        processDeadlineMs: this.cfg.spec.checks[name]!.probeTimeoutMs! })) } : {}),
      ...(profile.jobs?.some(name => this.cfg.spec.jobs?.[name]?.preflightChecks) ? {
        jobPreconditions: Object.fromEntries(profile.jobs.map(name => [name, this.cfg.spec.jobs![name].preflightChecks ?? []])),
      } : {}),
      ...(this.cohorts ? { coordination: { cohort: this.cohorts.cohort(c),
        digestBytes: this.cfg.spec.coordination!.maxDigestBytes,
        instruction: "Read bounded cohort/shared findings when useful. Explore alternate methods and counterexamples. Share concise findings with owned receipts. Every summary is unverified; cross-cohort source checks certify only the exact accepted task artifact. Findings cannot change your acceptance, dependencies or file scopes." } } : {}),
      contract: "Implement only this task. Use tools to inspect and edit scoped files. Run named checks. End with a concise summary, never a claimed PASS. The host independently verifies. Full tool output is retained in recall receipts. " +
        DECISION_GUIDANCE + " " +
        (theoretical ? "Conduct theoretical research by separating definitions, assumptions, conjectures, lemmas, proof attempts and checked deductions. Decompose difficult arguments into explicit obligations; use independent agents for alternative derivations, counterexamples and gap audits. Start with the most informative missing premise. Preserve unresolved gaps and failed approaches in scoped artifacts and claims. Only pinned independent validators can establish the exact target under its allowed assumptions. Numerical agreement, finite search in an infinite domain and reviewer consensus remain exploratory. Use theoretical.items premises as exact checked inputs; unavailable premises block new dependent proof jobs. " : "") +
        (profile.jobs ? "New jobs with configured preflight checks require passing run_check receipts on the current source and evidence. Inspect failed checks and repair before submitting; existing job identities always reconcile. " : "") +
        (profile.jobs?.some(name => this.cfg.spec.jobs?.[name]?.experiment) ?
          "Follow the configured experiment pipeline: run the cheap predecessor, inspect its measured outcome, then promote only eligible candidates. Identical source and input reuse the existing job when configured. Include immutable candidate/data/evaluation identities and a distinct seed or replicate ID in input for intended replications. Pipeline rules: " +
          canonical(experimentPipelineContext(this.cfg, profile.jobs)) + ". " : "") +
        (this.cfg.spec.debugging ? "Host system-state observations outrank prose working hypotheses. Falsify environmental, dependency and interface assumptions with a standalone probe and a negative control before broad edits. A failed probe ends only the current trajectory. " : "") +
        (canSpawn ? "You may use spawn_tasks to divide genuinely independent work; the host owns scheduling, scope, budgets and child acceptance. " : "Do not delegate. ") +
        (profile.tools.includes("save_progress") ? "Before long context retirement, call save_progress with concise current findings, blockers, exact next step, and owned evidence receipts; notes remain unverified. " : "") +
        (this.knowledge ? "Autonomously discover needed domain references with permitted read/search/job capabilities. Recover applicable experience with the project knowledge digest and any admitted knowledge tools. When record_experience is available, capture reusable lessons, procedures and corrected assumptions during the work; include conditions and evidence rather than raw transcripts. Do not interview the user or await curation for routine learning. The latest digest's trust labels supersede historical advice. Expert seeds and generated lessons remain advice; only independent adjudication can validate a semantic claim, and no learned prose changes frozen checks. " : "") +
        (profile.tools.includes("run_job") ? "For independent experiments, issue every ready run_job call in one assistant turn so the host can launch them concurrently; do not wait for one experiment before proposing another independent one. " : "") +
        "Issue independent file reads in one turn, and ordered related edits together. Use run_check as a boundary when you need an intermediate diagnostic. " +
        (profile.tools.includes("search_files") ? "Locate symbols and error text with scoped search_files before reading whole files; follow continuation cursors and inspect skipped-file counts. " : "") +
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
      const memory: MemoryEntry[] = [];
      t.state.feedbackHash = feedbackHash;
      for (const check of (feedback as any).checks ?? []) {
        let report: Json = check.detail ?? `Independent ${check.id} check reported ${check.verdict}`;
        if (typeof check.detail === "string" && /^[a-f0-9]{64}$/.test(check.detail)) {
          const data = this.store.readArtifact(check.detail); const id = this.journal.receipt(c, data);
          details.push({ check: check.id, receipt: id, excerpt: inlineReceipt(id, data, 2048) });
          report = data;
        }
        if (check.verdict !== "PASS") {
          const result = toJson({ verdict: check.verdict, report });
          const diagnostic = recordDiagnostic(t, this.journal, this.cfg, { id: `verification-${check.id}`, name: "verification",
            arguments: { name: check.id } }, result, this.journal.receipt(c, result), t.state.patchHash, true);
          if (diagnostic) memory.push(failureMemory(diagnostic, t.state.turns));
        }
      }
      t.state.history.push({ role: "user", content: canonical({ repairRequired: true, feedback: inlineReceipt(receipt, feedback), details }) });
      t.state.feedbackHash = feedbackHash; t.state.output = null;
      this.journal.checkpoint(t, "verification.feedback", { receipt, ...(memory.length ? { memory } : {}) });
    }
    const originalSignal = signal;
    const deadlineController = this.cfg.spec.debugging ? new AbortController() : null;
    const combined = deadlineController ? createCombinedAbortSignal(signal, { signalB: deadlineController.signal }) : null;
    if (combined) signal = combined.signal;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = () => {
      const deadline = t.state.debugging?.deadlineAt;
      if (!deadlineController || deadline === undefined || deadlineTimer !== undefined) return;
      deadlineTimer = setTimeout(() => deadlineController.abort(new FatalAttemptError(
        "DEBUGGING_BRANCH_TIMEOUT: diagnostic trajectory exceeded its pinned wall-clock budget; retain evidence and change strategy")),
      Math.max(0, deadline - Date.now()));
    };
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
      requireAdmission(this.store, proposal, value => {
        validateToolProposal(c, this.cfg, profile, value);
        admitDecisionCall(t.state, value);
        admitDebuggingCall(t.state, this.cfg, value);
      });
      scheduleDeadline();
      return proposal.id;
    };
    const admitReply = (message: typeof t.state.history[number]) => {
      const proposal = submitProposal(this.store, "RESPONSE", message, c, `agent:${c.task.agent ?? this.cfg.spec.defaultAgent}:turn:${t.state.turns}`);
      return requireAdmission(this.store, proposal, value => {
        invariant(value.role === "assistant" && typeof value.content === "string", "invalid response proposal");
      });
    };
    const commitReply = (reply: { turn: Turn; history: typeof t.state.history }, replay: boolean) => {
      const rejected = reply.turn.rejection;
      if (rejected) {
        // The request/reply commit precedes this checkpoint. Replaying that
        // exact raw reply produces this same notice and charges no new spend.
        const receipt = this.journal.receipt(c, this.store.readArtifact(rejected.responseHash));
        t.state.history = [...reply.history, { role: "user", content: canonical({ modelResponseRejected: {
          code: rejected.code, reason: rejected.reason, receipt, effectsExecuted: false,
          instruction: "The entire response was rejected before tool admission. No calls from it executed. Return the corrected complete tool group using valid JSON object arguments, unique IDs and at most 32 calls, or a nonempty final summary. Existing scope, permissions, checks and budgets still apply.",
        } }) }];
        t.state.turns++; t.state.responseRejections = (t.state.responseRejections ?? 0) + 1;
        this.journal.checkpoint(t, "model.rejected", { code: rejected.code, receipt,
          consecutive: t.state.responseRejections, step: t.state.turns - 1 });
        control?.activity?.(replay ? "model:rejection-replay" : "model:rejected");
      } else {
        t.state.history = [...reply.history, admitReply(reply.turn.message)]; t.state.turns++;
        delete t.state.responseRejections;
        this.journal.checkpoint(t, "model.reply", reply.turn.message);
        control?.activity?.(replay ? "model:replay" : "model:reply");
      }
    };
    const jobs = this.cfg.spec.jobs ? new ResearchJobs(this.journal, this.cfg, this.jobRpc) : null;
    const enforcePruning = () => {
      const failure = t.state.diagnostics?.pruned ?? pruningCandidate(t.state, this.cfg);
      if (!failure) return;
      if (!t.state.diagnostics!.pruned) {
        t.state.diagnostics!.pruned = failure;
        this.journal.checkpoint(t, "trajectory.pruned", { check: failure.check!, repeats: failure.repeats,
          fixture: failure.fixture, receipt: failure.receipt, inputKey: failure.inputKey });
        control?.activity?.("trajectory:pruned");
      }
      throw new FatalAttemptError(`STAGNANT_DIAGNOSTIC: check=${failure.check} repeats=${failure.repeats} fixture=${failure.fixture}; unchanged trajectory ended, objective recovery must change strategy`);
    };
    const enforceDebugging = () => {
      const d = t.state.debugging;
      if (!d) return;
      if (d.deadlineAt !== undefined && Date.now() >= d.deadlineAt)
        d.prunedReason ??= "DEBUGGING_BRANCH_TIMEOUT: diagnostic trajectory exceeded its pinned wall-clock budget; retain evidence and change strategy";
      if (d.prunedReason) {
        if (!d.prunedRecorded) {
          d.prunedRecorded = true;
          this.journal.checkpoint(t, "debugging.pruned", { reason: d.prunedReason, triage: d.card ?? null });
          control?.activity?.("debugging:pruned");
        }
        throw new FatalAttemptError(d.prunedReason);
      }
      scheduleDeadline();
    };
    const invert = async (): Promise<boolean> => {
      enforceDebugging();
      const window = inversionCandidate(t.state, this.cfg);
      if (window && !t.state.debugging?.audit) {
        const agent = this.cfg.spec.debugging!.auditorAgent ?? c.task.agent ?? this.cfg.spec.defaultAgent;
        prepareInversion(t.state, this.cfg, c.task, window, agent);
        this.journal.checkpoint(t, "debugging.triage", { triage: t.state.debugging!.card! });
        control?.activity?.("debugging:triage");
        enforceDebugging();
      }
      const audit = t.state.debugging?.audit;
      if (!audit) return false;
      if (t.state.turns >= budget.maxTurns) throw new FatalAttemptError("THREAD_TURN_BUDGET_EXHAUSTED");
      // A fresh provider request sees raw symptom and frozen contracts only.
      // It consumes the SAME thread/run/objective budgets and replay journal.
      const auditor = { ...this.cfg.spec.agents[audit.agent], tools: [],
        system: "You are an independent read-only debugging auditor. Treat all proposed causes as unverified hypotheses. Identify three orthogonal causes and falsifying probes with negative controls. Answer within 150 words and 2048 UTF-8 bytes. You cannot execute tools, edit files, accept results, or change the task or checks." };
      control?.activity?.("debugging:audit");
      const next = await this.brain.next(c, auditor, audit.history, budget, limit, signal, t.state.turns);
      invariant(!next.turn.rejection && !next.turn.message.calls?.length && next.turn.message.content.trim().length > 0 &&
        Buffer.byteLength(next.turn.message.content) <= 2048, "debugging auditor must return bounded hypotheses without tools");
      const receipt = this.journal.receipt(c, toJson({ trust: "UNVERIFIED_AGENT_HYPOTHESES", hypotheses: next.turn.message.content }));
      t.state.turns++;
      finishInversion(t.state, next.turn.message.content, receipt);
      this.journal.checkpoint(t, "debugging.inversion", { receipt, resets: t.state.debugging!.resets,
        triage: t.state.debugging!.card!, deadlineAt: t.state.debugging!.deadlineAt! });
      return true;
    };
    t.state.lastCheckAt ??= Date.now();
    t.state.evaluationStartedAt ??= t.state.lastCheckAt;
    const limit = t.state.contextLimit!;
    invariant(Number.isSafeInteger(limit) && limit > 0 &&
      limit <= this.store.contract().limits.contextBytes, "invalid durable context limit");
    try {
      enforceDebugging();
      if (t.state.pending?.name === "run_check") {
        const name = t.state.pending.arguments.name as string;
        if (!this.cfg.spec.checks[name]?.replaySafe) throw new FatalAttemptError("IN_DOUBT_EFFECT: non-replay-safe check needs operator reconciliation");
      }
      for (;;) {
        signal.throwIfAborted(); this.journal.assertLease(c);
        if ((t.state.responseRejections ?? 0) >= MAX_CONSECUTIVE_RESPONSE_REJECTIONS)
          throw new FatalAttemptError("MODEL_RESPONSE_REPAIR_EXHAUSTED: three consecutive invalid model replies; retained raw receipts require a different strategy or provider configuration");
        if (t.state.output) return { artifact: toJson(t.state.output), measurement: { tokens: this.journal.usage(c.runId, c.task.id, c.fence).tokens, costUsd: null } };
        const calls = outstanding(t);
        if (calls.length) {
          const batch = nextToolBatch(calls, hands);
          if (batch) {
            await executeToolBatch({ batch, thread: t, journal: this.journal, cfg: this.cfg, signal, control,
              admit: admitCall, snapshot: () => hands.snapshot(),
              execute: call => batch.kind === "run_job" ? runJob(call) : timedTool(() => hands.tool(call)),
              executeBatch: batch.kind !== "run_job" && hands.batch
                ? calls => timedTool(() => hands.batch!(batch.kind as "read" | "workspace-write", calls)) : undefined,
            });
            continue;
          }
          // Recompute the next group after each barrier; never move jobs or
          // reads ahead of writes, checks or control-plane effects.
          {
            const call = calls[0]!;
            const beforePatch = t.state.patchHash;
            const resuming = t.state.pending?.id === call.id || t.state.pendingBatch?.includes(call.id) === true;
            if (!resuming) {
              if (t.state.toolCalls >= budget.maxToolCalls) throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
              t.state.toolCalls++;
            }
            t.state.pending = call;
            let result: Json;
            const memory: MemoryEntry[] = [];
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
                const children = decodeSpawnChildren(this.cfg.spec, c.task, a.children);
                const reason = `Spawned ${children.length} child task(s); parent resumes after independent verification`;
                const spawned = spawnTasks(this.store, c, call.id, digest(call.arguments), children, policy,
                  Date.now(), { reason, wakeAt: Date.now(), measurement: {
                    tokens: this.journal.usage(c.runId, c.task.id, c.fence).tokens, costUsd: null,
                  } }, () => assertResearchFrontierExpansion(this.store, this.cfg, c.runId, children));
                if (!spawned.complete) {
                  invariant(spawned.parentDeferred, "spawn admission did not durably yield parent");
                  throw new PersistedDeferredAttemptError("spawn", Date.now(), reason);
                }
                result = { childIds: spawned.childIds, verified: spawned.dependencies };
              } else if (call.name === "invoke_capability") {
                invariant(this.operations, "operations not configured");
                result = await timedTool(() => this.operations!.invoke(c, call.arguments.name as string,
                  call.arguments.input, profile.capabilities ?? [], signal));
              } else if (call.name === "read_operations") {
                invariant(this.operations, "operations not configured"); result = this.operations.snapshot();
              } else if (call.name === "run_job") {
                invariant(jobs, "no remote job templates configured");
                result = await runJob(call);
              } else if (call.name === "read_job_artifact") {
                invariant(jobs, "no remote job templates configured");
                result = await timedTool(() => jobs.readArtifact(c, profile, call, signal,
                  ms => control?.timing?.("remote-rpc", ms)));
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
                memory.push(progressMemory(progress, this.journal.receipt(c, toJson(progress))));
                result = { saved: true, trust: "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE", turn: progress.atTurn };
              } else if (call.name === "record_experience") {
                invariant(this.knowledge, "project knowledge not configured");
                result = this.knowledge.record(c, call.arguments as unknown as ExperienceInput, t.state.patchHash);
              } else if (call.name === "read_knowledge") {
                invariant(this.knowledge, "project knowledge not configured");
                const a = call.arguments;
                if (a.id !== undefined) {
                  keys(a, ["id"]);
                  const card = this.knowledge.get(c, a.id as string);
                  const knowledgeReceipt = this.journal.receipt(c, card);
                  result = { knowledgeReceipt, card: inlineReceipt(knowledgeReceipt, card) };
                } else result = this.knowledge.search(c, a as KnowledgeQuery,
                  Math.min(this.knowledge.policy.maxContextBytes, Math.floor(limit / 4)));
              } else if (call.name === "recall") {
                const a = call.arguments; keys(a, [], ["receipt", "offset", "length", "historyAfter", "limit",
                  "memoryKind", "memoryBefore", "patchHash", "failureSignature"]);
                if (a.memoryKind !== undefined) {
                  invariant(a.receipt === undefined && a.offset === undefined && a.length === undefined &&
                    a.historyAfter === undefined, "ambiguous recall");
                  result = toJson(readMemory(this.store, c, { kind: a.memoryKind as "all" | "progress" | "failure",
                    before: a.memoryBefore as string | undefined, patchHash: a.patchHash as string | undefined,
                    failureSignature: a.failureSignature as string | undefined, limit: a.limit as number | undefined }, t.state));
                } else if (a.receipt !== undefined) {
                  invariant(a.memoryBefore === undefined && a.patchHash === undefined && a.failureSignature === undefined, "ambiguous recall");
                  invariant(typeof a.receipt === "string" && a.historyAfter === undefined && a.limit === undefined, "ambiguous recall");
                  result = this.journal.recall(c, a.receipt, a.offset as number | undefined, a.length as number | undefined);
                } else {
                  invariant(a.memoryBefore === undefined && a.patchHash === undefined && a.failureSignature === undefined,
                    "memory selectors require memoryKind");
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
            if (admitted && ["write_file", "edit_file", "delete_file", "run_check", "run_probe"].includes(call.name)) {
              const patch = await hands.snapshot();
              if (patch !== t.state.patchHash) control?.progress(`patch:${patch}`);
              t.state.patchHash = patch;
            }
            if (admitted && ["run_check", "run_probe"].includes(call.name)) { t.state.lastCheckAt = Date.now(); control?.checked?.(); }
            const receipt = this.journal.receipt(c, result);
            if (admitted && call.name === "run_job" && ["SUCCEEDED", "FAILED", "CANCELLED"].includes((result as any)?.status))
              t.state.lastJobReceipt = receipt;
            if (admitted && call.name === "spawn_tasks" && Array.isArray((result as any)?.verified))
              t.state.lastSpawnReceipt = receipt;
            const diagnostic = recordDiagnostic(t, this.journal, this.cfg, call, result, receipt, beforePatch, admitted);
            scheduleDeadline();
            if (diagnostic) memory.push(failureMemory(diagnostic, t.state.turns));
            t.state.history.push({ role: "tool", callId: call.id, receipt, content: inlineReceipt(receipt, result) });
            t.state.pending = null;
            if (t.state.pendingBatch) {
              t.state.pendingBatch = t.state.pendingBatch.filter(id => id !== call.id);
              if (!t.state.pendingBatch.length) delete t.state.pendingBatch;
            }
            this.journal.checkpoint(t, "tool.result", { callId: call.id, receipt, patchHash: t.state.patchHash,
              ...(memory.length ? { memory } : {}),
              ...(diagnostic ? { fixture: diagnostic.fixture } : {}) });
            control?.activity?.(`completed:${call.name}`);
          }
          continue;
        }
        // Finish every admitted call/result pair (including any queued repair)
        // before ending a stagnant trajectory. Restart repeats no model spend.
        enforcePruning();
        enforceDebugging();
        if (t.state.debugging?.audit) { await invert(); continue; }
        // The provider response and thread checkpoint are separate commits.
        // After a crash, consume the saved reply under its ORIGINAL request hash
        // before adding recovery notes or periodic-check feedback.
        const replay = this.brain.replay(c, profile, t.state.history, budget, limit, t.state.turns, t.state.progress ?? null,
          diagnosticContext(t.state));
        if (replay) {
          commitReply(replay, true); continue;
        }
        // A persisted model reply without tools represents a final answer.
        const last = t.state.history.at(-1)!;
        if (last.role === "assistant" && !last.calls?.length) {
          const patchHash = t.state.patchHash ?? this.store.artifact("");
          t.state.output = { schema: 1, patchHash, summary: last.content.slice(0, 4096) };
          this.journal.checkpoint(t, "worker.output", t.state.output); continue;
        }
        if (await invert()) continue;
        if (t.state.recoveryNote) {
          t.state.history.push({ role: "user", content: t.state.recoveryNote }); delete t.state.recoveryNote;
          this.journal.checkpoint(t, "episode.recovery", { fence: c.fence });
        }
        const reason = checkpointReason(t.state, this.cfg, profile);
        const checkName = checkpointCheck(t.state, profile);
        const alreadyEvaluated = t.state.decisions?.measurements[checkName]?.inputKey === diagnosticInputKey(t.state);
        const checkpointKey = checkpointInputKey(t.state.patchHash, t.state.feedbackHash ? 1 : 0,
          evaluationEvidenceKey(t.state));
        if (reason && !t.state.debugging?.probeRequired &&
            (!alreadyEvaluated || this.cfg.spec.supervision?.checkpointCadence === "periodic") &&
            shouldRunExploratoryCheckpoint(t.state.lastExploratoryCheckpointKey, checkpointKey, this.cfg.spec.supervision?.checkpointCadence) &&
            !(t.state.history.at(-1)?.role === "assistant" && !t.state.history.at(-1)?.calls?.length)) {
          const diagnosticPaths = this.cfg.spec.checks[checkName]?.diagnosticPaths;
          let changedPaths: string[] | undefined;
          if (diagnosticPaths && hands.changedPaths) {
            try { changedPaths = await hands.changedPaths(); }
            catch { control?.activity?.("checkpoint:path-scan-unavailable"); }
          }
          if (reason !== "measurement-due" && canSliceExploratoryCheckpoint(changedPaths, diagnosticPaths,
            this.cfg.spec.supervision?.checkpointCadence, !!t.state.feedbackHash, !!(t.state.lastJobReceipt || t.state.lastSpawnReceipt))) {
            // Advisory skip: do not spend a tool call or attach a PASS receipt.
            // Persist the evaluated input key so restart cannot loop on it.
            t.state.lastExploratoryCheckpointKey = checkpointKey;
            this.journal.checkpoint(t, "checkpoint.sliced", {
              check: checkName, reason, patchHash: t.state.patchHash,
              pathsHash: digest(changedPaths), pathCount: changedPaths!.length,
            });
            control?.activity?.("checkpoint:sliced");
          } else {
          // Safe tool boundary: do not interrupt a healthy remote experiment.
          if (t.state.toolCalls >= budget.maxToolCalls) throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
          t.state.toolCalls++;
          control?.activity?.("checkpoint:check");
          const call: Call = { id: `checkpoint-${t.seq}`, name: "run_check", arguments: { name: checkName } };
          const effect = toolEffectContract(this.cfg, "run_check", call.arguments);
          this.journal.checkpoint(t, "tool.effect", { callId: call.id, ...effect });
          const beforePatch = t.state.patchHash;
          let check: Json;
          try { check = await timedTool(() => hands.tool(call)); } catch (e) { signal.throwIfAborted(); check = { error: e instanceof Error ? e.message.slice(0, 512) : "checkpoint check failed" }; }
          t.state.patchHash = await hands.snapshot();
          const receipt = this.journal.receipt(c, check); t.state.lastCheckAt = Date.now();
          const diagnostic = recordDiagnostic(t, this.journal, this.cfg, call, check, receipt, beforePatch, true);
          t.state.lastExploratoryCheckpointKey = checkpointInputKey(t.state.patchHash, t.state.feedbackHash ? 1 : 0,
            evaluationEvidenceKey(t.state));
          control?.checked?.();
          t.state.history.push({ role: "user", content: canonical({ checkpointCheck: inlineReceipt(receipt, check),
            check: checkName, reason, instruction: "Use this measured result to choose the next decision: diagnose and repair a failure, or scale only with applicable evidence. This is not final acceptance." }) });
          this.journal.checkpoint(t, "checkpoint.checked", { check: checkName, reason, receipt, patchHash: t.state.patchHash,
            ...(diagnostic ? { memory: [failureMemory(diagnostic, t.state.turns)] } : {}),
            ...(diagnostic ? { fixture: diagnostic.fixture } : {}) });
          }
        }
        enforcePruning();
        if (await invert()) continue;
        const review = decisionContext(t.state);
        if (review && t.state.decisions!.noticeKey !== digest(review)) {
          t.state.decisions!.noticeKey = digest(review); t.state.decisions!.reviews++;
          t.state.history.push({ role: "user", content: canonical({ decisionReview: review }) });
          this.journal.checkpoint(t, "decision.review", { review });
          control?.activity?.("decision:measurement-due");
        }
        if (t.state.turns >= budget.maxTurns) throw new FatalAttemptError("THREAD_TURN_BUDGET_EXHAUSTED");
        if (this.knowledge && profile.tools.includes("read_knowledge") && Math.floor(limit / 4) >= 1024) {
          // Refresh only AFTER replay and at a complete tool boundary. The
          // resulting digest is checkpointed before the request, so a crash
          // cannot replay a reply against newly learned context.
          const digest = this.knowledge.context(c, profile.checks,
            t.state.diagnostics?.failures.length ? "debugging" : "any",
            Math.min(this.knowledge.policy.maxContextBytes, Math.floor(limit / 4)));
          const content = KNOWLEDGE_NOTICE + canonical(digest);
          const previous = t.state.history.find(m => m.role === "user" && m.content.startsWith(KNOWLEDGE_NOTICE));
          if (previous?.content !== content) {
            t.state.history = t.state.history.filter(m => !(m.role === "user" && m.content.startsWith(KNOWLEDGE_NOTICE)));
            t.state.history.push({ role: "user", content });
            this.journal.checkpoint(t, "knowledge.context", { digest });
          }
        }
        this.journal.checkpoint(t, "model.intent", { step: t.state.turns });
        control?.activity?.("model:request");
        // The private workspace is required by the first tool (or final patch
        // snapshot). Prepare it while the external model is thinking, without
        // predicting tool arguments or moving side effects across barriers.
        // Drain *both* operations even on failure before disposing the worktree.
        const prewarm = hands.warmup?.() ?? Promise.resolve();
        const model = this.brain.next(c, profile, t.state.history, budget, limit, signal, t.state.turns, t.state.progress ?? null,
          diagnosticContext(t.state));
        const [modelResult, prewarmResult] = await Promise.allSettled([model, prewarm]);
        if (modelResult.status === "rejected") throw modelResult.reason;
        if (prewarmResult.status === "rejected") throw prewarmResult.reason;
        const next = modelResult.value;
        commitReply(next, false);
      }
    } catch (error) {
      // The shared signal combiner does not preserve reasons. Restore this
      // host-owned deadline classification without reclassifying cancellation.
      if (deadlineController?.signal.aborted && !originalSignal.aborted) {
        t.state.debugging!.prunedReason = String((deadlineController.signal.reason as Error).message);
        enforceDebugging();
      }
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      combined?.cleanup();
      await hands.dispose();
    }
  }
  async verify(c: Capsule, result: WorkerResult, signal: AbortSignal, control?: AttemptControl): Promise<Verification> {
    this.journal.assertLease(c);
    const verification = await this.backend.verify(this.store, this.cfg, c, result.artifact, signal);
    if (this.operations) {
      const gate = actionEvidenceGate(this.store, c.runId, c.task.id);
      verification.checks.push({ id: "operations", verdict: gate.status === "PASS" ? "PASS" : "UNKNOWN", detail: canonical(gate) });
    }
    if (this.store.contract().requiredChecks.includes("research")) verification.checks.push(await verifyResearch(this.store, this.cfg, c, signal));
    if (this.programme) {
      try { this.programme.context(c.task.knowledge ?? []); verification.checks.push({ id: "knowledge", verdict: "PASS" }); }
      catch (error) { verification.checks.push({ id: "knowledge", verdict: "FAIL", detail: String(error) }); }
    }
    signal.throwIfAborted(); this.journal.assertLease(c);
    if (verification.checks.some(check => check.verdict !== "PASS")) this.journal.feedback(c, verification);
    control?.progress(`verify:${digest(verification)}`); return verification;
  }
}
