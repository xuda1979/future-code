import { canonical, digest, identifier, invariant, positive } from "./kernel.ts";
import { fields } from "./research.ts";
import type { CommandSpec, Json } from "./types.ts";

/** Project-owned representation, checks and cost model. No scientific domain is
 * interpreted here. The independently pinned evaluator supplies all metrics. */
export interface DiscoverySpec {
  schema: 1; name: string;
  task: { specification: string; interface: Json; checks: string[];
    objective: { metric: string; direction: "min" | "max" };
    axes: { metric: string; boundaries: number[] }[] };
  search: { families: number; rounds: number; migrationInterval: number; contextCandidates: number;
    contextBytes: number; candidateBytes: number; outputBytes: number; parallelism: number; timeoutMs: number };
  proposer: CommandSpec; evaluator: CommandSpec;
}
export interface DiscoveryFamily { id: string; approach: string }
export interface DiscoveryProposal { candidate: Json; notes: string[] }
export interface DiscoveryReport {
  schema: 1; protocolHash: string; candidateHash: string;
  checks: { id: string; verdict: "PASS" | "FAIL" | "UNKNOWN"; detail?: string }[];
  metrics: Record<string, number>; feedback: string;
}
export interface DiscoveryTrial {
  family: string; round: number; artifactHash: string; parent: string | null; inspirations: string[];
  proposal: DiscoveryProposal; report: DiscoveryReport;
}
const text = (s: unknown, max: number) => invariant(typeof s === "string" && s.trim().length > 0 &&
  Buffer.byteLength(s) <= max, "invalid discovery text");
const bytes = (v: unknown) => Buffer.byteLength(canonical(v));
export function validateDiscoverySpec(s: DiscoverySpec): void {
  fields(s, ["schema", "name", "task", "search", "proposer", "evaluator"]);
  invariant(s.schema === 1, "unknown discovery schema"); identifier(s.name);
  fields(s.task, ["specification", "interface", "checks", "objective", "axes"]);
  text(s.task.specification, 32768); canonical(s.task.interface);
  invariant(Array.isArray(s.task.checks) && s.task.checks.length > 0 && s.task.checks.length <= 32 &&
    new Set(s.task.checks).size === s.task.checks.length, "invalid discovery checks"); s.task.checks.forEach(identifier);
  fields(s.task.objective, ["metric", "direction"]); identifier(s.task.objective.metric);
  invariant(["min", "max"].includes(s.task.objective.direction), "invalid discovery objective");
  invariant(Array.isArray(s.task.axes) && s.task.axes.length <= 4 &&
    new Set(s.task.axes.map(a => a.metric)).size === s.task.axes.length, "invalid discovery axes");
  let cells = 1;
  for (const axis of s.task.axes) {
    fields(axis, ["metric", "boundaries"]); identifier(axis.metric);
    invariant(Array.isArray(axis.boundaries) && axis.boundaries.length <= 31 && axis.boundaries.every((b, i) =>
      Number.isFinite(b) && (i === 0 || b > axis.boundaries[i - 1])), "invalid discovery cell boundaries");
    cells *= axis.boundaries.length + 1;
  }
  invariant(cells <= 4096, "discovery archive cell ceiling exceeded");
  fields(s.search, ["families", "rounds", "migrationInterval", "contextCandidates", "contextBytes", "candidateBytes", "outputBytes", "parallelism", "timeoutMs"]);
  const limits = { families: 16, rounds: 256, migrationInterval: 256, contextCandidates: 16,
    contextBytes: 1048576, candidateBytes: 262144, outputBytes: 1048576, parallelism: 16, timeoutMs: 3600000 };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) positive(s.search[key], limits[key], `discovery ${key}`);
  invariant(s.search.parallelism <= s.search.families && s.search.contextBytes >= 2048 &&
    s.search.candidateBytes < s.search.outputBytes, "invalid discovery resource bounds");
  for (const command of [s.proposer, s.evaluator]) {
    fields(command, ["argv"], ["files", "envAllow"]);
    invariant(Array.isArray(command.argv) && command.argv.length > 0, "missing discovery command");
  }
  invariant(bytes(s) <= 262144, "discovery specification exceeds byte budget");
}
export function validateDiscoveryFamilies(s: DiscoverySpec, raw: unknown): DiscoveryFamily[] {
  fields(raw, ["families"]); const families = (raw as { families: DiscoveryFamily[] }).families;
  invariant(Array.isArray(families) && families.length === s.search.families &&
    new Set(families.map(f => f.id)).size === families.length, "invalid discovery families");
  const approaches = new Set<string>();
  for (const f of families) {
    fields(f, ["id", "approach"]); identifier(f.id); text(f.approach, 2048);
    const key = f.approach.trim().toLowerCase(); invariant(!approaches.has(key), "duplicate discovery approach"); approaches.add(key);
  }
  return families;
}
export function validateDiscoveryProposal(s: DiscoverySpec, raw: unknown): asserts raw is DiscoveryProposal {
  fields(raw, ["candidate", "notes"]); const p = raw as DiscoveryProposal;
  invariant(p.candidate !== null && bytes(p.candidate) <= s.search.candidateBytes, "candidate exceeds discovery byte budget");
  invariant(Array.isArray(p.notes) && p.notes.length <= 8, "invalid discovery notes"); p.notes.forEach(n => text(n, 512));
}
/** A complete rejected evaluation is useful feedback; an incomplete or stale
 * report is an infrastructure failure and must never acquire an archive cell. */
export function validateDiscoveryReport(s: DiscoverySpec, candidate: Json, raw: unknown): asserts raw is DiscoveryReport {
  fields(raw, ["schema", "protocolHash", "candidateHash", "checks", "metrics", "feedback"]);
  const r = raw as DiscoveryReport;
  invariant(r.schema === 1 && r.protocolHash === digest(s.task) && r.candidateHash === digest(candidate), "discovery evaluator binding mismatch");
  invariant(Array.isArray(r.checks) && r.checks.length === s.task.checks.length &&
    new Set(r.checks.map(c => c.id)).size === r.checks.length, "incomplete discovery evaluator checks");
  for (const c of r.checks) {
    fields(c, ["id", "verdict"], ["detail"]);
    invariant(s.task.checks.includes(c.id) && ["PASS", "FAIL", "UNKNOWN"].includes(c.verdict), "invalid discovery evaluator checks");
    if (c.detail !== undefined) text(c.detail, 1024);
  }
  invariant(r.metrics && typeof r.metrics === "object" && !Array.isArray(r.metrics) &&
    Object.keys(r.metrics).length <= 32, "invalid discovery metrics");
  for (const [id, value] of Object.entries(r.metrics)) { identifier(id); invariant(Number.isFinite(value), "discovery metrics must be finite"); }
  if (r.checks.every(c => c.verdict === "PASS")) for (const id of [s.task.objective.metric, ...s.task.axes.map(a => a.metric)])
    invariant(Object.hasOwn(r.metrics, id), "missing discovery objective or axis metric");
  text(r.feedback, 4096); invariant(bytes(r) <= s.search.outputBytes, "discovery report exceeds byte budget");
}
export const discoveryValid = (t: DiscoveryTrial) => t.report.checks.every(c => c.verdict === "PASS");
export function discoveryCell(s: DiscoverySpec, t: DiscoveryTrial): string {
  return s.task.axes.map(a => a.boundaries.filter(b => t.report.metrics[a.metric] >= b).length).join(":");
}
export function discoveryOrder(s: DiscoverySpec, a: DiscoveryTrial, b: DiscoveryTrial): number {
  const delta = a.report.metrics[s.task.objective.metric] - b.report.metrics[s.task.objective.metric];
  return (s.task.objective.direction === "min" ? delta : -delta) || a.round - b.round || a.artifactHash.localeCompare(b.artifactHash);
}
/** MAP-Elites selection within protected algorithm families. Cell boundaries are
 * frozen before search. Inferior global scores can still preserve useful designs. */
export function retainDiscoveryElites(s: DiscoverySpec, trials: DiscoveryTrial[]): DiscoveryTrial[] {
  const cells = new Map<string, DiscoveryTrial>();
  for (const t of trials) {
    validateDiscoveryProposal(s, t.proposal); validateDiscoveryReport(s, t.proposal.candidate, t.report);
    if (!discoveryValid(t)) continue;
    const key = `${t.family}/${discoveryCell(s, t)}`, old = cells.get(key);
    if (!old || discoveryOrder(s, t, old) < 0) cells.set(key, t);
  }
  return [...cells.values()];
}
const view = (t: DiscoveryTrial) => ({ family: t.family, candidateHash: t.report.candidateHash, artifactHash: t.artifactHash,
  candidate: t.proposal.candidate, metrics: t.report.metrics, checks: t.report.checks, feedback: t.report.feedback, notes: t.proposal.notes });
/** Fresh bounded sessions, with one local parent and optional archived programs.
 * Core task and parent are never silently truncated to make context fit. */
export function discoveryContext(s: DiscoverySpec, family: DiscoveryFamily, round: number, history: DiscoveryTrial[]) {
  const trials = history.filter(t => t.round < round), elites = retainDiscoveryElites(s, trials);
  const local = elites.filter(t => t.family === family.id).sort((a, b) => discoveryCell(s, a).localeCompare(discoveryCell(s, b)) || discoveryOrder(s, a, b));
  const previous = trials.filter(t => t.family === family.id).at(-1);
  const parent = local.length ? local[(round - 1) % local.length] : previous;
  const migrate = round > 1 && (round - 1) % s.search.migrationInterval === 0;
  const alternatives = elites.filter(t => t !== parent && (t.family === family.id || migrate))
    .sort((a, b) => Number(b.family !== family.id) - Number(a.family !== family.id) || discoveryOrder(s, a, b))
    .slice(0, s.search.contextCandidates).map(view);
  const context = { phase: "propose", protocolHash: digest(s.task), task: s.task, family, round,
    budget: { contextBytes: s.search.contextBytes, candidateBytes: s.search.candidateBytes, outputBytes: s.search.outputBytes },
    parent: parent ? view(parent) : null, alternatives,
    previous: previous ? { candidateHash: previous.report.candidateHash, checks: previous.report.checks,
      feedback: previous.report.feedback, notes: previous.proposal.notes } : null };
  while (bytes(context) > s.search.contextBytes && context.alternatives.length) context.alternatives.pop();
  invariant(bytes(context) <= s.search.contextBytes, "CONTEXT_OVERFLOW: discovery task and parent exceed context budget");
  return context;
}
