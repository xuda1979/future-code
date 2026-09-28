/**
 * Evidence revalidation — the platform's answer to "is persisted evidence
 * still true?" Run records in harness.json say a gate passed *at record
 * time*. Files drift, gates change, commands get edited. Revalidation
 * re-executes the manifest's gates right now and classifies every persisted
 * run record against the fresh outcome:
 *
 *   fresh    — the gate still passes today
 *   flipped  — the gate passed then but fails now (evidence gone stale)
 *   missing  — the recorded gate no longer exists in the manifest
 *
 * The report is persisted next to the manifest and surfaces through the CLI
 * (`harness revalidate`) so operators can tell "verified now" from
 * "verified once".
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessManifest,
  HarnessRunRecord,
  RevalidationReport,
  RevalidationOutcome,
  GateRevalidation,
} from "../types.ts";
import { loadManifest, harnessDir } from "../registry.ts";
import { runGate } from "../runtime/index.ts";

/** Where the last revalidation report is persisted, per project. */
export const REVALIDATION_REPORT_NAME = "revalidation.json";

export function revalidationReportPath(projectRoot: string): string {
  return join(harnessDir(projectRoot), REVALIDATION_REPORT_NAME);
}

/**
 * Re-run every gate in the manifest (bounded parallelism, same as runtime)
 * and return one GateRevalidation per gate. Never throws for a failing
 * gate — a failing gate is a *result*, not an error.
 */
export async function revalidateGates(
  manifest: HarnessManifest,
): Promise<GateRevalidation[]> {
  const maxParallel = manifest.config.maxParallel || 1;
  const gateIds = manifest.gates.map((g) => g.id);
  const out: GateRevalidation[] = [];
  for (let i = 0; i < gateIds.length; i += maxParallel) {
    const batch = gateIds.slice(i, i + maxParallel);
    const results = await Promise.all(
      batch.map(async (id) => {
        const gate = manifest.gates.find((g) => g.id === id)!;
        try {
          const r = await runGate(manifest, id);
          return {
            gateId: id,
            passedNow: r.passed,
            exitCodeNow: r.exitCode,
            durationMsNow: r.durationMs,
            required: gate.required,
          } satisfies GateRevalidation;
        } catch (err) {
          // A gate whose tool is broken (command missing, bad cwd) is a
          // failed revalidation, not a crash — the operator must see it.
          return {
            gateId: id,
            passedNow: false,
            exitCodeNow: -1,
            durationMsNow: 0,
            required: gate.required,
            error: err instanceof Error ? err.message : String(err),
          } satisfies GateRevalidation;
        }
      }),
    );
    out.push(...results);
  }
  return out;
}

/**
 * Classify one persisted run record against the fresh gate outcomes.
 * A record is `fresh` when every gate it exercised still passes; `flipped`
 * when some gate that passed then fails now; `missing` when a gate it
 * exercised has been removed from the manifest.
 */
export function classifyRun(
  record: HarnessRunRecord,
  gatesNow: GateRevalidation[],
  manifest: HarnessManifest,
): { outcome: RevalidationOutcome; changed: string[] } {
  const nowById = new Map(gatesNow.map((g) => [g.gateId, g]));
  const manifestGateIds = new Set(manifest.gates.map((g) => g.id));
  const exercised = record.gateResults ?? {};
  const changed: string[] = [];

  for (const [gateId, passedThen] of Object.entries(exercised)) {
    const now = nowById.get(gateId);
    if (!now || !manifestGateIds.has(gateId)) {
      // The evidence referenced a gate that no longer exists — it cannot
      // be re-verified at all.
      return { outcome: "missing", changed: [...changed, gateId] };
    }
    if (passedThen && !now.passedNow) {
      changed.push(gateId);
    }
  }

  if (changed.length > 0) return { outcome: "flipped", changed };
  return { outcome: "fresh", changed: [] };
}

/**
 * Full revalidation pass: re-run gates, classify every persisted run record,
 * summarize, persist the report, and return it.
 */
export async function revalidate(
  projectRoot: string,
  options: { limit?: number } = {},
): Promise<RevalidationReport> {
  const manifest = loadManifest(projectRoot);
  const gates = await revalidateGates(manifest);
  const passedGates = gates.filter((g) => g.passedNow).length;

  const limit = options.limit ?? 100;
  const history = (manifest.runHistory ?? []).slice(-limit);
  const runs = history.map((rec) => {
    const { outcome, changed } = classifyRun(rec, gates, manifest);
    return {
      runId: rec.runId,
      task: rec.task,
      startedAt: rec.startedAt,
      outcome,
      changedGates: changed,
    };
  });

  const fresh = runs.filter((r) => r.outcome === "fresh").length;
  const flipped = runs.filter((r) => r.outcome === "flipped").length;
  const missing = runs.filter((r) => r.outcome === "missing").length;

  const report: RevalidationReport = {
    schema: 1,
    revalidatedAt: new Date().toISOString(),
    harnessId: manifest.harnessId,
    project: manifest.project,
    gates,
    runs,
    summary: {
      gatesTotal: gates.length,
      gatesPassedNow: passedGates,
      runsExamined: runs.length,
      runsFresh: fresh,
      runsFlipped: flipped,
      runsMissing: missing,
      evidenceStale: flipped + missing > 0 || passedGates < gates.length,
    },
  };

  persistReport(projectRoot, report);
  return report;
}

/** Persist the report beside the manifest (best-effort, never throws). */
export function persistReport(projectRoot: string, report: RevalidationReport): void {
  try {
    const dir = harnessDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(revalidationReportPath(projectRoot), JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch {
    // Persistence failure must not mask the revalidation result itself.
  }
}

/** Load the most recent persisted report, if one exists. */
export function loadReport(projectRoot: string): RevalidationReport | null {
  const p = revalidationReportPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RevalidationReport;
  } catch {
    return null;
  }
}
