import { checkPins, invoke, pinCommand } from "./commands.ts";
import { FatalAttemptError } from "./errors.ts";
import { canonical, digest, encodeCapsule, invariant, validateEvidence } from "./kernel.ts";
import { fields } from "./research.ts";
import { discoveryContext, discoveryOrder, discoveryValid, retainDiscoveryElites, validateDiscoveryFamilies,
  validateDiscoveryProposal, validateDiscoveryReport, validateDiscoverySpec } from "./discovery.ts";
import type { DiscoveryFamily, DiscoveryProposal, DiscoveryReport, DiscoverySpec, DiscoveryTrial } from "./discovery.ts";
import { runTasks } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { HealthObserver } from "./health.ts";
import type { Capsule, Driver, Json, PinnedCommand, Task, WorkerResult } from "./types.ts";

interface Configuration { spec: DiscoverySpec; proposer: PinnedCommand; evaluator: PinnedCommand; recipeHash: string }
interface Round { index: number; runId: string; status: string; errors: { task: string; error: string | null }[] }
interface State { families: DiscoveryFamily[]; trials: DiscoveryTrial[]; rounds: Round[] }
const asJson = (v: unknown): Json => JSON.parse(canonical(v));
const configKey = "extension.discovery";
function configuration(store: Store): Configuration {
  const id = store.getMeta<string>(configKey); invariant(id, "discovery search is not initialized");
  const c = store.readArtifact(id) as unknown as Configuration; validateDiscoverySpec(c.spec);
  const contract = store.contract();
  invariant(contract.workerId === digest(c.proposer) && contract.verifierId === digest(c.evaluator) &&
    contract.environmentId === digest({ proposer: c.proposer, evaluator: c.evaluator, task: c.spec.task }), "discovery configuration drift");
  store.recipe(c.recipeHash); return c;
}
const runId = (c: Configuration, index: number) => digest({ discovery: digest(c), round: index });
/** Dedicated state root; frozen commands and protocol cannot be overwritten.
 * Candidate acceptance never promotes a harness recipe or scientific theorem. */
export function initializeDiscovery(store: Store, spec: DiscoverySpec, base = process.cwd()): void {
  validateDiscoverySpec(spec); spec = JSON.parse(canonical(spec));
  const proposer = pinCommand(spec.proposer, base), evaluator = pinCommand(spec.evaluator, base);
  invariant(digest(proposer) !== digest(evaluator), "discovery proposer and evaluator must be separate commands");
  const { parallelism, contextBytes, outputBytes, timeoutMs, families } = spec.search;
  // One extra lease permits recovery from a dead controller. Completed adapter
  // errors are fatal below, so a malformed result is never blindly retried.
  const recipe = { parallelism, attempts: 2, contextBytes, timeoutMs };
  const c: Configuration = { spec, proposer, evaluator, recipeHash: digest(recipe) };
  store.initialize({ schema: 1, name: spec.name, workerId: digest(proposer), verifierId: digest(evaluator),
    environmentId: digest({ proposer, evaluator, task: spec.task }), requiredChecks: ["evaluation-envelope"], slos: [],
    limits: { parallelism, attempts: 2, contextBytes, outputBytes, timeoutMs, tasks: families } }, recipe,
    undefined, { [configKey]: store.artifact(asJson(c)) });
}
function validateArtifact(c: Configuration, task: Task, raw: Json): void {
  const a = raw as any;
  if ((task.input as any).phase === "ideate") {
    fields(a, ["phase", "families"]); invariant(a.phase === "ideate", "discovery phase mismatch");
    validateDiscoveryFamilies(c.spec, { families: a.families });
  } else {
    fields(a, ["phase", "proposal", "report"]); invariant(a.phase === "trial", "discovery phase mismatch");
    validateDiscoveryProposal(c.spec, a.proposal); validateDiscoveryReport(c.spec, a.proposal.candidate, a.report);
  }
}
function discoveryDriver(c: Configuration): Driver {
  return { workerId: digest(c.proposer), verifierId: digest(c.evaluator),
    async execute(capsule, signal, control) {
      try {
      const input = capsule.task.input as any;
      if (input.phase === "ideate") {
        const raw = await invoke(c.proposer, input, c.spec.search.outputBytes, signal, control);
        const families = validateDiscoveryFamilies(c.spec, raw);
        return { artifact: asJson({ phase: "ideate", families }) };
      }
      const proposal = await invoke(c.proposer, input, c.spec.search.outputBytes, signal, control);
      validateDiscoveryProposal(c.spec, proposal);
      // The proposer sees only returned feedback, never evaluator argv, private
      // fixtures, credentials or source. Commands are trusted, not OS-sandboxed.
      const report = await invoke(c.evaluator, { phase: "evaluate", protocolHash: digest(c.spec.task), task: c.spec.task,
        candidateHash: digest(proposal.candidate), candidate: proposal.candidate }, c.spec.search.outputBytes, signal, control);
      validateDiscoveryReport(c.spec, proposal.candidate, report);
      return { artifact: asJson({ phase: "trial", proposal, report }) };
      } catch (e) { throw new FatalAttemptError(e instanceof Error ? e.message : String(e)); }
    },
    async verify(capsule: Capsule, result: WorkerResult) {
      validateArtifact(c, capsule.task, result.artifact);
      // PASS authenticates a complete evaluation, including valid rejection
      // feedback. Only all-PASS project checks make a candidate archive-eligible.
      return { artifactHash: digest(result.artifact), checks: [{ id: "evaluation-envelope", verdict: "PASS" }] };
    } };
}
function readRound(store: Store, c: Configuration, index: number) {
  const id = runId(c, index), run = store.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  if (!run) return null;
  invariant(run.recipe === c.recipeHash && run.contract === digest(store.contract()), "discovery round binding drift");
  const rows = store.db.prepare("SELECT * FROM tasks WHERE run=? ORDER BY id").all(id);
  invariant(rows.length === (index === 0 ? 1 : c.spec.search.families), "discovery round task count drift");
  const families: DiscoveryFamily[] = [], trials: DiscoveryTrial[] = [];
  for (const row of rows) {
    const task = JSON.parse(row.spec) as Task, input = task.input as any;
    invariant(input.protocolHash === digest(c.spec.task) && digest(input.task) === digest(c.spec.task) &&
      (index === 0 ? input.phase === "ideate" : input.phase === "propose" && input.round === index), "discovery task protocol drift");
    if (row.status !== "PASS") continue;
    const artifact = store.readArtifact(row.artifact), evidence = store.readArtifact(row.evidence);
    validateEvidence(store.contract(), c.recipeHash, task, artifact, evidence); validateArtifact(c, task, artifact);
    const a = artifact as any;
    if (index === 0) families.push(...a.families);
    else trials.push({ family: input.family.id, round: index, artifactHash: row.artifact,
      parent: input.parent?.candidateHash ?? null, inspirations: input.alternatives.map((a: any) => a.candidateHash),
      proposal: a.proposal as DiscoveryProposal, report: a.report as DiscoveryReport });
  }
  return { families, trials, round: { index, runId: id, status: String(run.status), errors: rows.filter(r => r.status === "FAIL" || r.status === "BLOCKED")
    .map(r => ({ task: String(r.id), error: r.error === null ? null : String(r.error) })) } };
}
function readState(store: Store, c: Configuration): State {
  const state: State = { families: [], trials: [], rounds: [] };
  for (let index = 0; index <= c.spec.search.rounds; index++) {
    const result = readRound(store, c, index); if (!result) break;
    if (index === 0) state.families = result.families;
    state.trials.push(...result.trials); state.rounds.push(result.round);
    if (result.round.status !== "PASS") break;
  }
  return state;
}
function snapshot(c: Configuration, state: State) {
  const elites = retainDiscoveryElites(c.spec, state.trials), best = [...elites].sort((a, b) => discoveryOrder(c.spec, a, b))[0] ?? null;
  const last = state.rounds.at(-1), completedRounds = state.rounds.filter(r => r.index > 0 && r.status === "PASS").length;
  return { schema: 1, protocolHash: digest(c.spec.task), phase: last?.status === "FAIL" ? "BLOCKED" :
    completedRounds === c.spec.search.rounds ? "COMPLETE" : state.families.length ? "SEARCHING" : "IDEATION",
    completedRounds, maxRounds: c.spec.search.rounds, evaluated: state.trials.length,
    rejected: state.trials.filter(t => !discoveryValid(t)).length, families: state.families, rounds: state.rounds,
    best, elites: elites.map(t => ({ family: t.family, round: t.round, candidateHash: t.report.candidateHash,
      artifactHash: t.artifactHash, metrics: t.report.metrics })),
    tokens: null, costUsd: null };
}
export function discoverySnapshot(store: Store) { const c = configuration(store); return snapshot(c, readState(store, c)); }
function tasksForRound(store: Store, c: Configuration, state: State, index: number): Task[] {
  const input = index === 0 ? [{ phase: "ideate", protocolHash: digest(c.spec.task), task: c.spec.task, familyCount: c.spec.search.families,
    budget: { contextBytes: c.spec.search.contextBytes, candidateBytes: c.spec.search.candidateBytes, outputBytes: c.spec.search.outputBytes } }] :
    state.families.map(f => discoveryContext(c.spec, f, index, state.trials));
  return input.map((context: any, i) => {
    const task: Task = { id: index === 0 ? "ideation" : state.families[i].id,
      goal: index === 0 ? "Propose distinct algorithm families from the specification." : "Submit a candidate and receive independent evaluation.",
      acceptance: ["Complete host-authenticated evaluation; candidate validity is recorded separately."],
      dependencies: [], writeScope: [`discovery/${index}/${i}`], contextBudget: c.spec.search.contextBytes, input: asJson(context) };
    // Reserve the entire encoded capsule, including fence and host envelope.
    const fits = () => { encodeCapsule({ schema: 1, runId: runId(c, index), task, contractHash: digest(store.contract()),
      recipeHash: c.recipeHash, fence: Number.MAX_SAFE_INTEGER, dependencies: [] }, c.spec.search.contextBytes); };
    for (;;) {
      task.input = asJson(context);
      try { fits(); break; }
      catch (e) { if (!context.alternatives?.length) throw e; context.alternatives.pop(); }
    }
    return task;
  });
}
/** Local computational search on Foundry tasks/leases, not a second scheduler.
 * Stable round IDs atomically deduplicate competing controllers. Unfinished
 * commands must be replay-safe; use ResearchJobs for reconciled external effects. */
export async function runDiscovery(store: Store, signal: AbortSignal = new AbortController().signal, onProgress?: HealthObserver) {
  const c = configuration(store); checkPins(c.proposer); checkPins(c.evaluator);
  const state = readState(store, c), scheduler = new Scheduler(store), driver = discoveryDriver(c);
  while (!signal.aborted) {
    const last = state.rounds.at(-1); if (last?.status === "FAIL") break;
    const index = !last ? 0 : last.status === "PASS" ? last.index + 1 : last.index;
    if (index > c.spec.search.rounds) break;
    const id = runId(c, index);
    if (!store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id))
      scheduler.start(tasksForRound(store, c, state, index), c.recipeHash, Date.now(), id);
    await runTasks(store, [], driver, { recipeHash: c.recipeHash, resumeRun: id, signal, onProgress });
    const result = readRound(store, c, index)!;
    if (index === 0) state.families = result.families;
    state.trials = state.trials.filter(t => t.round !== index).concat(result.trials);
    state.rounds = state.rounds.filter(r => r.index !== index).concat(result.round);
    if (result.round.status !== "PASS") break;
  }
  return snapshot(c, state);
}
