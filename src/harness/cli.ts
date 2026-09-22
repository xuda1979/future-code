/**
 * future-code harness CLI — the platform's control surface.
 * Subcommands: build | run | monitor | improve | log | selfapply
 *
 * These let the platform create (build), execute (run), watch (monitor),
 * tune (improve), inspect decisions (log), and self-apply (selfapply) the
 * project-specific harness that lives inside future-code.
 */
import { build } from "./builder/index.ts";
import { describeCues } from "./builder/detect.ts";
import { loadManifest, saveManifest, hasManifest, manifestPath } from "./registry.ts";
import { run } from "./runtime/index.ts";
import { annotate, healthy, summary } from "./monitor/index.ts";
import { improve, applyProposal } from "./improver/index.ts";
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

async function report(_c: Ctx, m: HarnessManifest, task: string): Promise<void> {
  const r = await run(m, task);
  annotate(m, r);
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
      console.log(JSON.stringify({ runId: r.runId, healthy: healthy(r), metrics: r.metrics, sloResults: r.sloResults }, null, 2));
      break;
    }
    case "improve": {
      const m = loadManifest(ctx.project);
      const r = await run(m, "improve probe");
      annotate(m, r);
      const proposals = improve(m, r);
      for (const p of proposals) {
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
      if (m.improvementHistory && m.improvementHistory.length) {
        console.log(JSON.stringify(m.improvementHistory, null, 2));
      } else {
        console.log('no improvement decisions recorded yet');
      }
      break;
    }
    case "selfapply": {
      // future-code applies its own platform loop to itself.
      if (!hasManifest(ctx.project)) build(ctx.project, { harnessId: "future-code-harness", scope: ctx.scope ?? "tests" });
      const m = loadManifest(ctx.project);
      const r = await run(m, "self-apply");
      annotate(m, r);
      console.log(JSON.stringify({ runId: r.runId, healthy: healthy(r), metrics: r.metrics }, null, 2));
      break;
    }
    default:
      console.log("usage: harness build|run|monitor|improve|log|selfapply [--project <dir>] [--verbose]");
  }
}

if (import.meta.main) {
  void main();
}
