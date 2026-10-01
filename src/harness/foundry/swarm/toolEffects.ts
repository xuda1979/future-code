import { invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm, ToolName } from "./config.ts";

export type ToolEffectClass = "read" | "workspace-write" | "check" | "control-plane" | "external-job";
export type ReplayPolicy = "safe" | "state-bound" | "reconcile";
export interface ToolEffectContract {
  tool: ToolName;
  effect: ToolEffectClass;
  replay: ReplayPolicy;
  idempotency: "none" | "call-id" | "spawn-request" | "job-key";
  compensation: "none" | "snapshot-rollback" | "operator-reconcile";
  risk: "low" | "medium" | "high";
  rationale: string;
}

const fixed: Partial<Record<ToolName, ToolEffectContract>> = {
  list_files: { tool: "list_files", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded project metadata read" },
  read_file: { tool: "read_file", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "bounded scoped file read" },
  recall: { tool: "recall", effect: "read", replay: "safe", idempotency: "none",
    compensation: "none", risk: "low", rationale: "durable receipt read" },
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
};

export function toolEffectContract(cfg: PinnedSwarm, tool: ToolName, args: Json): ToolEffectContract {
  if (tool === "run_check") {
    const name = (args as any)?.name;
    invariant(typeof name === "string" && cfg.spec.checks[name], "unknown check capability");
    const replaySafe = cfg.spec.checks[name].replaySafe;
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
  if (tool === "spawn_tasks")
    invariant(cfg.spec.supervision?.dynamicDAG, "spawn_tasks requires host dynamic-DAG policy");
  return contract;
}
