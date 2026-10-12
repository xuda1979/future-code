import { invariant } from "../kernel.ts";
import type { ProcessResult } from "./process.ts";

export interface CheckReport extends Omit<ProcessResult, "code"> {
  name: string;
  /** null means the host could not obtain a process exit status. */
  code: number | null;
  error?: string;
  isolation?: "worktree";
  tree?: string;
  sourceUnchanged?: boolean;
  elapsedMs?: number;
}
export const checkPassed = (report: CheckReport): boolean => report.code === 0 && !report.error;

/** Keep configured report order, cap whole worker lifetimes, and drain every
 * launched worker even on cancellation. Final integration stops admitting new
 * checks after a failed result; per-task acceptance gathers all diagnostics. */
export async function boundedChecks(names: string[], width: number, signal: AbortSignal,
  execute: (name: string) => Promise<CheckReport>, failFast: boolean): Promise<CheckReport[]> {
  invariant(Number.isSafeInteger(width) && width >= 1 && width <= 8, "invalid verification parallelism");
  let next = 0, failed = false;
  const reports: (CheckReport | undefined)[] = new Array(names.length);
  const workers = await Promise.allSettled(Array.from({ length: Math.min(width, names.length) }, async () => {
    while (next < names.length && !(failFast && failed)) {
      signal.throwIfAborted(); const index = next++;
      try {
        const report = await execute(names[index]); reports[index] = report;
        if (!checkPassed(report)) failed = true;
      } catch (e) { failed = true; throw e; }
    }
  }));
  signal.throwIfAborted();
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return reports.filter((r): r is CheckReport => r !== undefined);
}
