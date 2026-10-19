import { digest, invariant } from "../kernel.ts";
import { ResearchProgramme, type KnowledgeRef } from "../researchProgramme.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import type { PinnedSwarm, SwarmSpec } from "./config.ts";
import { assertTheoryAcceptance } from "./theory.ts";

export interface ScientificObligation {
  id: string; input: Json; acceptance: string[]; checks: string[];
  research: string[]; knowledge: KnowledgeRef[];
}

/** Scientific target tasks remain stable acceptance anchors. Recovery can
 * change methods/dependencies, add helpers and strengthen these requirements. */
export function scientificObligations(tasks: Task[], spec: SwarmSpec): ScientificObligation[] {
  return tasks.filter(t => t.research?.length || t.knowledge?.length).map(t => ({
    id: t.id, input: t.input, acceptance: t.acceptance,
    checks: spec.agents[t.agent ?? spec.defaultAgent].checks,
    research: t.research ?? [], knowledge: t.knowledge ?? [],
  }));
}

export function assertScientificObligations(obligations: ScientificObligation[], tasks: Task[], spec: SwarmSpec): void {
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const original of obligations) {
    const task = byId.get(original.id);
    invariant(task, `missing scientific obligation task: ${original.id}`);
    invariant(original.research.every(name => task.research?.includes(name)), `missing required experiment: ${original.id}`);
    invariant(original.knowledge.every(ref => task.knowledge?.some(k => k.id === ref.id && k.version === ref.version)),
      `missing exact knowledge import: ${original.id}`);
    invariant(digest(task.input) === digest(original.input), `scientific obligation input changed: ${original.id}`);
    invariant(original.acceptance.every(a => task.acceptance.includes(a)), `scientific acceptance weakened: ${original.id}`);
    const profile = spec.agents[task.agent ?? spec.defaultAgent];
    invariant(profile && original.checks.every(check => profile.checks.includes(check)), `scientific checks weakened: ${original.id}`);
  }
}

/** Always derive from revision zero, including after a restart or an old
 * prepared recovery. The mutable current plan cannot redefine acceptance. */
export function objectiveScientificObligations(store: Store, cfg: PinnedSwarm, objective: string): ScientificObligation[] {
  const initial = store.db.prepare("SELECT plan FROM swarm_objective_revisions WHERE objective=? AND revision=0").get(objective);
  invariant(initial, "missing initial objective acceptance plan");
  return scientificObligations(store.readArtifact(String(initial.plan)) as unknown as Task[], cfg.spec);
}

/** Final-boundary validation only, never a scheduler scan or another oracle
 * invocation. Historical PASS/evidence remains intact when knowledge changes. */
export function assertRunScientificAcceptance(store: Store, cfg: PinnedSwarm, run: string, objective?: string): void {
  const supervised = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='swarm_objective_revisions'").get();
  const owner = supervised ? store.db.prepare("SELECT objective FROM swarm_objective_revisions WHERE run=?").get(run) : undefined;
  invariant(!objective || owner?.objective === objective, "objective scientific gate run mismatch");
  const scientific = cfg.spec.researchProgramme || Object.values(cfg.spec.jobs ?? {}).some(j => j.research);
  if (!scientific && !owner) return;
  const rows = store.db.prepare("SELECT spec,status FROM tasks WHERE run=? ORDER BY id").all(run);
  const tasks = rows.map(row => JSON.parse(String(row.spec)) as Task);
  if (owner) assertScientificObligations(objectiveScientificObligations(store, cfg, String(owner.objective)), tasks, cfg.spec);
  if (!scientific) return;
  const programme = cfg.spec.researchProgramme ? new ResearchProgramme(store, cfg.spec.researchProgramme) : null;
  const imports = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status !== "PASS") continue;
    const task = tasks[i];
    for (const ref of task.knowledge ?? []) {
      invariant(programme, "scientific import requires a programme");
      const key = `${ref.id}:${ref.version}`;
      if (!imports.has(key)) { programme.read(ref); imports.add(key); }
    }
    assertTheoryAcceptance(store, cfg, { runId: run, task });
  }
  if (programme) {
    // Superseded observations may remain historical results. An explicitly
    // revoked/conflicted source, or a stale current conclusion, cannot pass.
    const assessments = store.db.prepare(`SELECT a.task,a.template,a.job_key FROM research_assessments a
      JOIN tasks t ON t.run=a.run AND t.id=a.task WHERE a.run=? AND t.status='PASS'`).all(run);
    for (const a of assessments) {
      const source = digest({ run, task: String(a.task), template: String(a.template), job: String(a.job_key) });
      const finding = store.db.prepare(`SELECT k.state,k.version,h.version AS head FROM research_knowledge k
        LEFT JOIN research_knowledge_heads h ON h.programme=k.programme AND h.id=k.id
        WHERE k.programme=? AND k.source_key=?`).get(programme.policy.id, source);
      invariant(finding, "scientific result lacks programme publication");
      invariant(!["RETRACTED", "CONFLICTED"].includes(String(finding.state)) &&
        !(finding.state === "STALE" && finding.version === finding.head),
        `scientific conclusion is ${String(finding.state).toLowerCase()}: ${String(a.task)}`);
    }
  }
}
