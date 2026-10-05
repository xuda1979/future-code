import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { canonical, digest, invariant } from "./kernel.ts";
import { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";
import type { SwarmSpec } from "./swarm/config.ts";
import { initializeSwarm, integrateSwarm, runSwarm } from "./swarm/host.ts";
import { git } from "./swarm/workspace.ts";

export interface ProjectEvaluationOptions {
  baseline: SwarmSpec; candidate: SwarmSpec; tasks: Task[]; repetitions: number; root: string;
  mode: "live" | "replay"; fetcher?: typeof fetch; signal: AbortSignal;
}
const json = (value: unknown): Json => JSON.parse(canonical(value));
const median = (values: number[]): number => {
  const xs = [...values].sort((a, b) => a - b), i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
};

export function validateProjectPair(baseline: SwarmSpec, candidate: SwarmSpec): void {
  // Only an operating recipe may differ. Models, prompts, budgets, tools,
  // checks, scopes and project input remain frozen across both arms.
  const comparable = (spec: SwarmSpec) => ({ ...spec, recipe: null, name: "paired-project" });
  invariant(digest(comparable(baseline)) === digest(comparable(candidate)),
    "project comparison changes model, acceptance, environment or budgets");
}

export function replayFetcher(recording: { schema: number; tasksHash: string; responses: Record<string, Json[]> },
  tasks: Task[]): typeof fetch {
  invariant(recording.schema === 1 && recording.tasksHash === digest(tasks), "replay task binding mismatch");
  const steps = new Map<string, number>();
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const packet = body.messages.find((m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("{\"contract\""));
    invariant(packet, "replay expects chat-completions task packet");
    const id = JSON.parse(packet.content).task.id, step = steps.get(id) ?? 0;
    const response = recording.responses[id]?.[step];
    invariant(response, "replay response exhausted"); steps.set(id, step + 1);
    return Response.json(response);
  }) as typeof fetch;
}

async function trial(options: ProjectEvaluationOptions, arm: "baseline" | "candidate", repetition: number) {
  const spec = options[arm], path = join(options.root, `${repetition}-${arm}`);
  invariant(!existsSync(join(path, "state.sqlite")), "evaluation trial already exists; use a fresh root");
  const started = performance.now(); const store = await Store.open(path);
  let cfg: Awaited<ReturnType<typeof initializeSwarm>> | undefined;
  let result: any = null, integration: any = null, failure: string | null = null;
  try {
    cfg = await initializeSwarm(store, spec, options.signal);
    invariant((await git(cfg, cfg.spec.project, ["status", "--porcelain"], options.signal)).trim() === "", "real-project input must be committed and clean");
    result = await runSwarm(store, options.tasks, options.signal, undefined, options.fetcher);
    if (result.status === "PASS") {
      try { integration = await integrateSwarm(store, result.id, options.signal); }
      catch (error) { failure = error instanceof Error ? error.message.slice(0, 2048) : "integration failed"; }
    }
    const usage = result.providerUsage;
    const initial = new Set(options.tasks.map(t => t.id));
    const accepted = store.db.prepare("SELECT id,artifact,evidence,status FROM tasks WHERE run=? ORDER BY id").all(result.id);
    const verifiedTasks = accepted.filter(row => initial.has(String(row.id)) && row.status === "PASS" && row.artifact && row.evidence).length;
    const complete = result.status === "PASS" && integration !== null && failure === null;
    const wallClockMs = performance.now() - started;
    const modelRequests = options.mode === "live" ? Number(usage.requests) : 0;
    const costUsd: number | null = options.mode === "replay" ? 0 : result.costUsd;
    const report = {
      schema: 1, arm, repetition, mode: options.mode, sourceCommit: cfg.baseCommit,
      taskHash: digest(options.tasks), recipeHash: result.recipeHash, contractHash: result.contractHash,
      checksHash: digest(cfg.checks), runId: result.id,
      status: complete ? "PASS" : "FAIL", integration, failure,
      metrics: { admittedTasks: initial.size, verifiedTasks, verifiedObjectives: complete ? 1 : 0,
        attempts: result.attempts, spawnedTasks: accepted.length - initial.size, wallClockMs,
        modelRequests, replayedRequests: options.mode === "replay" ? Number(usage.requests) : 0,
        requestBytes: usage.requestBytes, providerTokens: options.mode === "live" ? usage.tokens : null,
        unknownRequests: usage.unknownRequests, costUsd,
        verifiedTasksPerHour: verifiedTasks * 3_600_000 / wallClockMs,
        verifiedTasksPerModelRequest: modelRequests > 0 ? verifiedTasks / modelRequests : null,
        verifiedTasksPerUsd: costUsd !== null && costUsd > 0 ? verifiedTasks / costUsd : null },
      artifactManifest: accepted,
    };
    const reportHash = store.artifact(json(report));
    return { ...report, reportHash };
  } finally { store.close(); }
}

/** Alternating paired real-source trials. Replay mode checks the execution and
 * acceptance pipeline only. It can never produce a live-productivity claim. */
export async function evaluateRealProject(options: ProjectEvaluationOptions,
  recording?: Parameters<typeof replayFetcher>[0]): Promise<Json> {
  validateProjectPair(options.baseline, options.candidate);
  invariant(Number.isSafeInteger(options.repetitions) && options.repetitions >= 1 && options.repetitions <= 20, "invalid project repetitions");
  invariant(options.mode === "live" || options.mode === "replay", "invalid evaluation mode");
  invariant(options.mode === "replay" ? !!recording : !recording && !options.fetcher,
    "live evaluation requires real transport; recordings and injected fetchers are replay-only");
  if (options.mode === "live") for (const profile of Object.values(options.baseline.agents)) {
    if (profile.keyEnv) invariant(process.env[profile.keyEnv], `missing credential environment ${profile.keyEnv}`);
    invariant(!profile.model.includes("YOUR_"), "configure a real model before live evaluation");
  }
  mkdirSync(options.root, { recursive: true });
  const trials = [];
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    for (const arm of repetition % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const) {
      const fetcher = options.mode === "replay" ? replayFetcher(recording!, options.tasks) : undefined;
      trials.push(await trial({ ...options, fetcher }, arm, repetition));
      // Durable incremental evidence survives interruption between arms.
      writeFileSync(join(options.root, "trials.json"), canonical(trials), { mode: 0o600 });
    }
  }
  const sourceCommits = new Set(trials.map(t => t.sourceCommit)), checks = new Set(trials.map(t => t.checksHash));
  invariant(sourceCommits.size === 1 && checks.size === 1, "project or verifier changed between trials");
  const allPass = trials.every(t => t.status === "PASS");
  const baseline = trials.filter(t => t.arm === "baseline"), candidate = trials.filter(t => t.arm === "candidate");
  const baselineMs = median(baseline.map(t => t.metrics.wallClockMs)), candidateMs = median(candidate.map(t => t.metrics.wallClockMs));
  const evidenceOnly = options.mode === "replay";
  const decision = !allPass ? "QUALITY_GATE_FAILED" : evidenceOnly ? "OFFLINE_BOUNDARY_ONLY" :
    options.repetitions < 3 ? "INSUFFICIENT_REPETITIONS" : candidateMs < baselineMs ? "OBSERVED_TIME_GAIN" : "NO_OBSERVED_TIME_GAIN";
  const listSource = (base: URL, prefix = ""): string[] => readdirSync(base, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listSource(new URL(`${entry.name}/`, base), `${prefix}${entry.name}/`) :
      entry.name.endsWith(".ts") ? [`${prefix}${entry.name}`] : []);
  const sourceFiles = listSource(new URL("./", import.meta.url)).sort();
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file,
    createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")]));
  return json({ schema: 1, type: "future-code-real-project-evaluation", mode: options.mode, decision, allPass,
    protocolHash: digest({ tasks: options.tasks, sourceCommit: trials[0].sourceCommit, checksHash: trials[0].checksHash,
      profiles: options.baseline.agents, baselineRecipe: options.baseline.recipe, candidateRecipe: options.candidate.recipe,
      budgets: options.baseline.budget, repetitions: options.repetitions }),
    generatedAt: new Date().toISOString(), sourceHashes, repetitions: options.repetitions,
    medianWallClockMs: { baseline: baselineMs, candidate: candidateMs },
    observedSpeedup: !evidenceOnly && allPass ? baselineMs / candidateMs : null,
    modelRequests: trials.reduce((sum, trial) => sum + trial.metrics.modelRequests, 0),
    limits: "Alternating observational trials on one fixed project. No causal/general productivity guarantee. Replay has zero model calls and cannot establish LLM productivity; missing live dollars remain unknown.", trials });
}
