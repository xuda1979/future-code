import { invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm, ToolName } from "./config.ts";

export type ToolEffectClass = "read" | "workspace-write" | "check" | "control-plane" | "external-job" | "external-action";
export type ReplayPolicy = "safe" | "state-bound" | "reconcile";
export interface ToolEffectContract {
  tool: ToolName;
  effect: ToolEffectClass;
  replay: ReplayPolicy;
  idempotency: "none" | "call-id" | "spawn-request" | "job-key" | "resource-transition";
  compensation: "none" | "snapshot-rollback" | "operator-reconcile";
  risk: "low" | "medium" | "high";
  rationale: string;
}

const fixed: Partial<Record<ToolName, ToolEffectContract>> = {
  read_operations: { tool: "read_operations", effect: "read", replay: "safe", idempotency: "none", compensation: "none", risk: "low", rationale: "bounded project operations projection" },
  read_knowledge: { tool: "read_knowledge", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded project-shared cards, never source receipt authority or acceptance" },
  record_experience: { tool: "record_experience", effect: "control-plane", replay: "state-bound", idempotency: "call-id",
    compensation: "none", risk: "low", rationale: "immutable task-owned experience id and input binding; source acceptance cannot verify prose" },
  read_findings: { tool: "read_findings", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded cohort notes or accepted cross-cohort references; no private history access" },
  publish_finding: { tool: "publish_finding", effect: "control-plane", replay: "state-bound", idempotency: "call-id",
    compensation: "none", risk: "medium", rationale: "immutable task-owned finding identity; summaries remain unverified" },
  read_claims: { tool: "read_claims", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded scoped claim projection" },
  propose_claim: { tool: "propose_claim", effect: "control-plane", replay: "state-bound", idempotency: "call-id",
    compensation: "none", risk: "medium", rationale: "append a versioned hypothesis under host ownership and revision checks" },
  propose_conflict: { tool: "propose_conflict", effect: "control-plane", replay: "safe", idempotency: "call-id",
    compensation: "none", risk: "medium", rationale: "version-bound conflict identity; only independent evidence resolves it" },
  list_files: { tool: "list_files", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded project metadata read" },
  read_file: { tool: "read_file", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded scoped file read" },
  search_files: { tool: "search_files", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded literal source discovery inside readable scopes; no acceptance evidence" },
  recall: { tool: "recall", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "durable receipt read" },
  save_progress: { tool: "save_progress", effect: "control-plane", replay: "state-bound", idempotency: "call-id",
    compensation: "none", risk: "low", rationale: "durable agent-authored note; never authoritative verification evidence" },
  write_file: { tool: "write_file", effect: "workspace-write", replay: "state-bound", idempotency: "call-id",
    compensation: "snapshot-rollback", risk: "medium", rationale: "mutates private worktree; host snapshots after call" },
  edit_file: { tool: "edit_file", effect: "workspace-write", replay: "state-bound", idempotency: "call-id",
    compensation: "snapshot-rollback", risk: "medium", rationale: "literal edit is bound to prior workspace state" },
  delete_file: { tool: "delete_file", effect: "workspace-write", replay: "state-bound", idempotency: "call-id",
    compensation: "snapshot-rollback", risk: "medium", rationale: "deletes within private scoped worktree" },
  spawn_tasks: { tool: "spawn_tasks", effect: "control-plane", replay: "safe", idempotency: "spawn-request",
    compensation: "none", risk: "medium", rationale: "host persists request identity and validates DAG authority atomically" },
  run_job: { tool: "run_job", effect: "external-job", replay: "reconcile", idempotency: "job-key",
    compensation: "operator-reconcile", risk: "high", rationale: "external side effect requires stable job identity and ensure/inspect reconciliation" },
  read_job_artifact: { tool: "read_job_artifact", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded read of a terminal, task-owned job artifact; never submits or replaces work" },
};

export function toolEffectContract(cfg: PinnedSwarm, tool: ToolName, args: Json): ToolEffectContract {
  if (tool === "read_operations") invariant(cfg.operations, "operations not configured");
  if (tool === "invoke_capability") {
    const name = (args as any)?.name;
    invariant(typeof name === "string" && cfg.operations && Object.hasOwn(cfg.operations.policy.capabilities, name), "unknown external capability");
    const effect = cfg.operations.policy.capabilities[name].effect;
    return { tool, effect: effect === "read" ? "read" : "external-action", replay: effect === "read" ? "safe" : "reconcile",
      idempotency: effect === "read" ? "none" : "resource-transition", compensation: effect === "read" ? "none" : "operator-reconcile",
      risk: effect === "read" ? "low" : "high", rationale: "operator-pinned capability with durable action identity and reconciled resource usage" };
  }
  if (tool === "run_check" || tool === "run_probe") {
    const name = (args as any)?.name;
    invariant(typeof name === "string" && cfg.spec.checks[name], "unknown check capability");
    const replaySafe = cfg.spec.checks[name].replaySafe;
    if (tool === "run_probe") invariant(replaySafe && cfg.spec.checks[name].probeTimeoutMs !== undefined,
      "micro-probe needs a pinned replay-safe deadline");
    return {
      tool, effect: "check", replay: replaySafe ? "safe" : "reconcile",
      idempotency: replaySafe ? "call-id" : "none",
      compensation: replaySafe ? "none" : "operator-reconcile",
      risk: replaySafe ? "medium" : "high",
      rationale: replaySafe ? "pinned check explicitly declares replay safety" :
        "non-replay-safe subprocess requires reconciliation",
    };
  }
  const contract = fixed[tool];
  invariant(contract, "missing tool effect contract");
  if (tool === "run_job") {
    const name = (args as any)?.name;
    const job = typeof name === "string" ? cfg.spec.jobs?.[name] : undefined;
    invariant(job?.idempotentEnsure === true, "external job requires idempotent ensure contract");
  }
  if (tool === "read_job_artifact") invariant(cfg.spec.jobs, "job artifact read requires configured job templates");
  if (tool === "spawn_tasks")
    invariant(cfg.spec.supervision?.dynamicDAG, "spawn_tasks requires host dynamic-DAG policy");
  if (tool === "publish_finding" || tool === "read_findings")
    invariant(cfg.spec.coordination, "finding tools require host coordination policy");
  if (tool === "record_experience" || tool === "read_knowledge")
    invariant(cfg.spec.projectKnowledge, "knowledge tools require project knowledge policy");
  return contract;
}
