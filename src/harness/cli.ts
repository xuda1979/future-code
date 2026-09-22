/**
 * future-code harness CLI — the platform's control surface.
 * Subcommands: build | run | monitor | improve | log | selfapply | context | scribe
 *
 * These let the platform create (build), execute (run), watch (monitor),
 * tune (improve), inspect decisions (log), self-apply (selfapply), write
 * code/tests (scribe), and check context budgets (context) the
 * project-specific harness that lives inside future-code.
 */
import { build } from "./builder/index.ts";
import { describeCues } from "./builder/detect.ts";
import { loadManifest, saveManifest, hasManifest, manifestPath } from "./registry.ts";
import { run } from "./runtime/index.ts";
import { annotate, healthy, summary } from "./monitor/index.ts";
import { improve, applyProposal, shouldApply } from "./improver/index.ts";
import { recordRun, recentRuns, passRateTrend, runtimeTrend } from "./history.ts";
import { resolveBudget, boundedMonitorContext, boundedImproverContext, estimateTokens } from "./context.ts";
import { runScribe } from "./scribe/index.ts";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessManifest } from "./types.ts";

interface Ctx { project: string; verbose: boolean; scope?: string; }

function parse(): { cmd: string; args: string[]; ctx: Ctx } {
  const argv = process.argv.slice(2);
  const cmd = argv.shift() ?? "help";
  let verbose = false;
  let scope: string | undefined;
  const projectIndex = argv.indexOf("--project");
  let project = projectIndex >= 0 ? argv[projectIndex + 1] : process.cwd();
  const scopeIndex = argv.indexOf("--scope");
  if (scopeIndex >= 0) scope = argv[scopeIndex + 1];
  const skipFlag = (a: string, i: number) =>
    a === "--project" || a === "--scope" || argv[i - 1] === "--project" || argv[i - 1] === "--scope";
  const args = argv.filter((a, i) => !skipFlag(a, i));
  if (args.includes("--verbose")) verbose = true;
  return { cmd, args, ctx: { project, verbose, scope } };
}

function note(c: Ctx, msg: string): void {
  if (c.verbose) console.log(`[harness] ${msg}`);
}

async function report(c: Ctx, m: HarnessManifest, task: string): Promise<void> {
  const r = await run(m, task);
  annotate(m, r);
  const m2 = recordRun(c.project, r);
  m.runHistory = m2.runHistory;
  console.log(JSON.stringify(summary(r), null, 2));
}

async function main(): Promise<void> {
  const { cmd, ctx } = parse();
  switch (cmd) {
    case "build": {
      const { manifest, cues } = build(ctx.project, { scope: ctx.scope });
      console.log(JSON.stringify({ built: true, manifest: manifestPath(ctx.project), cues: describeCues(cues), scope: ctx.scope ?? null }, null, 2));
      break;
    }
    case "run": {
      const m = loadManifest(ctx.project);
      const task = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== "run").join(" ") || "default task";
      await report(ctx, m, task);
      break;
    }
    case "monitor": {
      const m = loadManifest(ctx.project);
      const r = await run(m, "monitor check");
      annotate(m, r);
      const m2 = recordRun(ctx.project, r);
      m.runHistory = m2.runHistory;
      console.log(JSON.stringify({ runId: r.runId, healthy: healthy(r), metrics: r.metrics, sloResults: r.sloResults }, null, 2));
      break;
    }
    case "improve": {
      const m = loadManifest(ctx.project);
      const r = await run(m, "improve probe");
      annotate(m, r);
      const m2 = recordRun(ctx.project, r);
      m.runHistory = m2.runHistory;
      const proposals = improve(m, r);
      for (const p of proposals) {
        // Guardrail: never apply a proposal the policy rejects (e.g. unbounded
        // maxParallel growth) — record the veto for auditability instead.
        if (!shouldApply(m, p)) {
          note(ctx, `vetoed ${p.id}: ${p.description}`);
          console.log(JSON.stringify({ id: p.id, vetoed: true, changes: p.changes, rationale: p.rationale }, null, 2));
          continue;
        }
        const before = JSON.stringify(m.config);
        applyProposal(m, p);
        saveManifest(ctx.project, m);
        note(ctx, `applied ${p.id}: ${p.description}`);
        console.log(JSON.stringify({ id: p.id, changes: p.changes, before, after: JSON.stringify(m.config), rationale: p.rationale }, null, 2));
      }
      if (proposals.length === 0) console.log('no improvements to apply');
      break;
    }
    case "log": {
      const m = loadManifest(ctx.project);
      const runs = recentRuns(ctx.project, 10);
      const prTrend = passRateTrend(ctx.project, 10);
      const rtTrend = runtimeTrend(ctx.project, 10);
      console.log(JSON.stringify({
        improvementHistory: m.improvementHistory ?? [],
        scribeLog: m.scribeLog ?? [],
        recentRuns: runs,
        passRateTrend: prTrend,
        runtimeTrend: rtTrend,
      }, null, 2));
      break;
    }
    case "selfapply": {
      // future-code applies its own platform loop to itself. The write-phase
      // boundary is specific to future-code's own repo: src/ holds the
      // mirrored Future Code CLI snapshot (security research) which the
      // design doc forbids modifying, so when self-applying on the platform
      // itself the scribe is bounded to src/harness — the platform's own
      // module. Other projects have no such boundary and keep scribeRoot
      // unset (whole project, minus ignored dirs).
      if (!hasManifest(ctx.project)) build(ctx.project, { harnessId: "future-code-harness", scope: ctx.scope });
      const m = loadManifest(ctx.project);
      if (!m.config.scribeRoot) {
        const platformHome = join(ctx.project, "src", "harness");
        if (existsSync(platformHome) && statSync(platformHome).isDirectory()) {
          m.config.scribeRoot = "src/harness";
        }
      }
      // Write-phase: before iterating run→improve, the scribe drafts scaffold
      // tests for uncovered modules. Each promoted scaffold widens the unit
      // gate's coverage, so the run-phase measures more of the project. This
      // is the "write code" half of the platform loop: plan → write → run →
      // monitor → improve.
      try {
        const scribeOut = await runScribe(ctx.project, m, { maxModules: 3 });
        m.scribeLog = scribeOut.manifest.scribeLog;
        saveManifest(ctx.project, m);
        const promoted = scribeOut.results.filter((r) => r.outcome === "promoted").length;
        note(ctx, `scribe: planned ${scribeOut.plan.entries.length}, promoted ${promoted}, quarantined ${scribeOut.results.filter((r) => r.outcome === "quarantined").length}`);
        for (const sr of scribeOut.results) {
          note(ctx, `scribe ${sr.outcome}: ${sr.entry.module} -> ${sr.file}`);
        }
      } catch (e) {
        note(ctx, `scribe phase skipped: ${(e as Error).message}`);
      }
      // The self-apply loop iterates to convergence: run → improve → apply →
      // re-run, until the harness is healthy or a bound stops it. Bounds:
      // MAX_ITERATIONS caps total work; a no-progress iteration (nothing
      // applied that could change the outcome) stops the loop rather than
      // re-running an identical configuration forever.
      const MAX_ITERATIONS = 5;
      let iteration = 0;
      let r!: Awaited<ReturnType<typeof run>>;
      let converged = false;
      let lastRunId: string | undefined;
      while (iteration < MAX_ITERATIONS) {
        iteration++;
        r = await run(m, `self-apply (iteration ${iteration})`);
        annotate(m, r);
        const m2 = recordRun(ctx.project, r);
        m.runHistory = m2.runHistory;
        lastRunId = r.runId;
        if (healthy(r)) { converged = true; break; }
        // Unhealthy — improve, guarded, and check for forward progress.
        const proposals = improve(m, r);
        let applied = 0;
        for (const p of proposals) {
          // Guardrail: same policy as `improve` — veto unsafe proposals.
          if (!shouldApply(m, p)) {
            note(ctx, `vetoed ${p.id}: ${p.description}`);
            continue;
          }
          applyProposal(m, p);
          applied++;
          note(ctx, `auto-applied ${p.id}: ${p.description}`);
        }
        saveManifest(ctx.project, m);
        if (applied === 0) {
          // No proposal changed the harness — re-running would repeat the
          // same run identically. Stop and surface the terminal state.
          note(ctx, `iteration ${iteration}: no applicable proposals; stopping`);
          break;
        }
      }
      console.log(JSON.stringify({
        runId: lastRunId,
        healthy: healthy(r),
        converged,
        iterations: iteration,
        metrics: r.metrics,
        runHistory: (m.runHistory ?? []).length,
        scribeActions: (m.scribeLog ?? []).length,
      }, null, 2));
      break;
    }
    case "scribe": {
      // The write-phase: draft, validate, and promote scaffold tests for
      // uncovered modules. Deterministic, quarantined on failure, fully audited.
      const m = loadManifest(ctx.project);
      const maxIdx = process.argv.indexOf("--max");
      const maxModules = maxIdx >= 0 ? parseInt(process.argv[maxIdx + 1], 10) || 5 : 5;
      const rootIdx = process.argv.indexOf("--scribe-root");
      if (rootIdx >= 0) m.config.scribeRoot = process.argv[rootIdx + 1];
      const out = await runScribe(ctx.project, m, { maxModules });
      m.scribeLog = out.manifest.scribeLog;
      saveManifest(ctx.project, m);
      console.log(JSON.stringify({
        planned: out.plan.entries.length,
        skipped: out.plan.skipped.length,
        contextTokens: out.plan.contextTokens,
        results: out.results.map((r) => ({
          module: r.entry.module,
          outcome: r.outcome,
          file: r.file,
          exitCode: r.exitCode ?? null,
        })),
        scribeLog: out.manifest.scribeLog ?? [],
      }, null, 2));
      break;
    }
    case "context": {
      // Report context budget status for all agents.
      const m = loadManifest(ctx.project);
      const budget = resolveBudget(m);
      const history = (m.runHistory ?? []).slice(-10);
      const lastReport = history.length > 0 ? history[history.length - 1] : null;

      const agents = [
        { agent: "runtime", budget, used: lastReport?.metrics?.context_used ?? 0 },
        { agent: "monitor", budget, used: lastReport ? estimateTokens(boundedMonitorContext(
          { runId: lastReport.runId, task: lastReport.task, startedAt: lastReport.startedAt,
            durationMs: lastReport.durationMs, gates: [], metrics: lastReport.metrics,
            sloResults: [] },
          history, m)) : 0 },
        { agent: "improver", budget, used: lastReport ? estimateTokens(boundedImproverContext(
          { runId: lastReport.runId, task: lastReport.task, startedAt: lastReport.startedAt,
            durationMs: lastReport.durationMs, gates: [], metrics: lastReport.metrics,
            sloResults: [] },
          history, m.improvementHistory ?? [], m)) : 0 },
      ].map((a) => ({
        ...a,
        utilization: a.budget > 0 ? Math.round((a.used / a.budget) * 100) / 100 : 0,
        compliant: a.used <= a.budget,
      }));

      console.log(JSON.stringify({
        budget,
        contextBudgetMultiplier: m.config.contextBudget,
        agents,
        allCompliant: agents.every((a) => a.compliant),
      }, null, 2));
      break;
    }
    default:
      console.log("usage: harness build|run|monitor|improve|log|selfapply|context|scribe [--project <dir>] [--verbose]");
  }
}

if (import.meta.main) {
  void main();
}
