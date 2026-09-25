import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { checkPins, pinCommand } from "../commands.ts";
import { canonical, digest, invariant, validateTasks } from "../kernel.ts";
import { runTasks } from "../runtime.ts";
import { Scheduler } from "../scheduler.ts";
import { Store } from "../store.ts";
import type { Capsule, Contract, Json, Task } from "../types.ts";
import { executable, validateSwarmSpec, validateSwarmTasks, type PinnedSwarm, type SwarmSpec } from "./config.ts";
import { SwarmDriver, verifierIdentity, workerIdentity } from "./driver.ts";
import { SessionJournal } from "./session.ts";
import { git, LocalGitHands, orderedTasks } from "./workspace.ts";
const json = (value: unknown): Json => JSON.parse(canonical(value));
const KEY = "extension.swarm";
export async function initializeSwarm(store: Store, input: SwarmSpec, signal: AbortSignal): Promise<PinnedSwarm> {
  validateSwarmSpec(input);
  const spec: SwarmSpec = JSON.parse(canonical(input)); spec.project = realpathSync(resolve(spec.project));
  const cfg: PinnedSwarm = { version: 1, handsId: "local-git-posix-v1", spec, baseCommit: "", git: pinCommand({ argv: [executable("git")] }, spec.project), checks: {} };
  const root = (await git(cfg, spec.project, ["rev-parse", "--show-toplevel"], signal)).trim();
  invariant(realpathSync(root) === spec.project, "project must be the Git repository root");
  cfg.baseCommit = (await git(cfg, spec.project, ["rev-parse", "--verify", `${spec.baseRef}^{commit}`], signal)).trim();
  invariant(/^[a-f0-9]{40,64}$/.test(cfg.baseCommit), "invalid base commit");
  // Pin declared implementations. Interpreter-loaded transitive dependencies must
  // be declared by the operator; this is not hermetic environment attestation.
  for (const [name, command] of Object.entries(spec.checks)) {
    cfg.checks[name] = pinCommand({ ...command, argv: [command.argv[0] === "$NODE" ? executable("node") : command.argv[0], ...command.argv.slice(1)] }, spec.project);
    for (const p of cfg.checks[name].pins) {
      const path = relative(spec.project, p.path).replaceAll("\\", "/");
      if (path && !path.startsWith("../") && !isAbsolute(path)) spec.protectedPaths.push(path);
    }
  }
  spec.protectedPaths = [...new Set([...spec.protectedPaths, ".gitignore", ".gitattributes", ".gitmodules"])].sort();
  const contract: Contract = { schema: 1, name: spec.name, workerId: workerIdentity(cfg), verifierId: verifierIdentity(cfg),
    environmentId: digest({ project: spec.project, base: cfg.baseCommit, checks: cfg.checks }), requiredChecks: ["scope", "behavior"],
    slos: [], limits: spec.limits };
  store.initialize(contract, spec.recipe, undefined, { [KEY]: json(cfg) });
  new SessionJournal(store); return cfg;
}
export function loadSwarm(store: Store): PinnedSwarm {
  const cfg = store.getMeta<PinnedSwarm>(KEY); invariant(cfg?.version === 1, "swarm is not initialized");
  invariant(cfg.handsId === "local-git-posix-v1", "unsupported execution backend");
  validateSwarmSpec(cfg.spec); checkPins(cfg.git); Object.values(cfg.checks).forEach(checkPins);
  const c = store.contract();
  invariant(c.workerId === workerIdentity(cfg) && c.verifierId === verifierIdentity(cfg) &&
    c.environmentId === digest({ project: cfg.spec.project, base: cfg.baseCommit, checks: cfg.checks }), "swarm configuration drift");
  return cfg;
}
export async function runSwarm(store: Store, tasks: Task[], signal: AbortSignal, resumeRun?: string, fetcher?: typeof fetch): Promise<Json> {
  const cfg = loadSwarm(store);
  const actual: Task[] = resumeRun ? store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(resumeRun).map(r => JSON.parse(r.spec)) : tasks;
  validateTasks(store.contract(), actual); validateSwarmTasks(cfg.spec, actual);
  const driver = new SwarmDriver(store, cfg, fetcher);
  const summary = await runTasks(store, tasks, driver, { signal, resumeRun });
  return json({ ...summary, providerUsage: driver.journal.usage(summary.id), baseCommit: cfg.baseCommit,
    note: "Acceptance is per-task. Run integrate for cross-task checks. Monetary cost is unknown without a trusted price meter." });
}
export function swarmStatus(store: Store, run?: string, after = ""): Json {
  const cfg = loadSwarm(store);
  if (!run) return json({ active: store.active(), recipe: store.recipe(), baseCommit: cfg.baseCommit, agents: Object.keys(cfg.spec.agents),
    recentRuns: store.db.prepare("SELECT id,status,started,ended FROM runs ORDER BY started DESC LIMIT 20").all() });
  const tasks = store.db.prepare("SELECT id,status,fence,error FROM tasks WHERE run=? AND id>? ORDER BY id LIMIT 201").all(run, after);
  const page = tasks.slice(0, 200);
  return json({ ...new Scheduler(store).summary(run), providerUsage: new SessionJournal(store).usage(run),
    tasks: page, nextTaskAfter: tasks.length > 200 ? page.at(-1)!.id : null,
    taskPageLimit: 200, integrationReceipt: store.getMeta(`extension.swarm.integration.${run}`) ?? null });
}
interface IntegrationReceipt { run: string; base: string; tree: string; commit: string; branch: string; checksHash: string; binding: string }
/** Explicit host action: test the combined tree and publish a NEW branch only.
 * No checkout, merge into main, reset, push, or force update occurs here. */
export async function integrateSwarm(store: Store, run: string, signal: AbortSignal): Promise<IntegrationReceipt> {
  const cfg = loadSwarm(store); const summary = new Scheduler(store).summary(run);
  invariant(summary.status === "PASS", "all tasks must pass before integration");
  const ordered = orderedTasks(store, run);
  const binding = digest({ run, cfg, recipe: summary.recipeHash,
    artifacts: store.db.prepare("SELECT id,artifact,evidence FROM tasks WHERE run=? ORDER BY id").all(run) });
  const key = `extension.swarm.integration.${run}`;
  let receipt = store.getMeta<IntegrationReceipt>(key);
  const publish = async (value: IntegrationReceipt) => {
    invariant(value.binding === binding, "integration input drift");
    // Revalidate stored evidence and commit object before publishing after a crash.
    store.readArtifact(value.checksHash);
    invariant((await git(cfg, cfg.spec.project, ["rev-parse", `${value.commit}^{tree}`], signal)).trim() === value.tree, "integration commit drift");
    const refs = (await git(cfg, cfg.spec.project, ["for-each-ref", "--format=%(objectname)", value.branch], signal)).trim();
    if (!refs) await git(cfg, cfg.spec.project, ["update-ref", value.branch, value.commit, "0".repeat(value.commit.length)], signal);
    else invariant(refs === value.commit, "integration branch already points elsewhere; never overwrite it");
    store.transaction(() => store.event("swarm.integrated", value, run)); return value;
  };
  if (receipt) return publish(receipt);
  const c: Capsule = { schema: 1, runId: run, task: { id: "integration", goal: "Integrate accepted patches", acceptance: ["all integration checks"],
    dependencies: [], writeScope: [], input: null }, fence: 0, recipeHash: summary.recipeHash, contractHash: summary.contractHash, dependencies: [] };
  const hands = new LocalGitHands(store, cfg, c, cfg.spec.agents[cfg.spec.defaultAgent], signal, null, ordered.map(t => t.id));
  try {
    const path = await hands.ready(); const tree = await hands.tree(); const reports: Json[] = [];
    for (const name of cfg.spec.integrationChecks) {
      invariant(cfg.spec.checks[name].replaySafe, "integration checks must be explicitly replay-safe");
      const report = await hands.check(name); reports.push(json({ name, ...report }));
      invariant(report.code === 0, `integration check failed: ${name}; receipt=${store.artifact(json(reports))}`);
    }
    invariant(await hands.tree() === tree, "integration verifier mutated tracked source");
    const checksHash = store.artifact(json(reports));
    const commit = (await git(cfg, path, ["-c", "user.name=Future Code Swarm", "-c", "user.email=swarm@localhost",
      "commit-tree", tree, "-p", cfg.baseCommit, "-m", `Verified swarm ${run}`], signal)).trim();
    const proposed: IntegrationReceipt = { run, base: cfg.baseCommit, tree, commit, branch: `refs/heads/swarm/${run}`, checksHash, binding };
    receipt = store.transaction(() => {
      const previous = store.getMeta<IntegrationReceipt>(key);
      if (previous) { invariant(previous.binding === binding && previous.tree === tree, "concurrent integration mismatch"); return previous; }
      store.setMeta(key, proposed); store.event("swarm.integration.prepared", proposed, run); return proposed;
    });
    return await publish(receipt);
  } finally { await hands.dispose(); }
}
