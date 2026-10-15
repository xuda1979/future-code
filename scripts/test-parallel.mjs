#!/usr/bin/env node
/**
 * test-parallel.mjs — parallel regression-lane orchestrator.
 *
 * Spawns independent test "lanes" concurrently (one process per lane) to cut
 * wall-clock time, while respecting two hard-won constraints:
 *
 *  1. ISOLATION OF TIMER-SENSITIVE LANES. Two heavy bun processes running at
 *     once produced a timing flake (hact benchmarks + retirement cohorts on a
 *     shared machine). Lanes flagged `exclusive: true` run one-at-a-time in
 *     the "heavy" group; everything else runs concurrently.
 *  2. CPU BUDGET. Concurrency is capped (default: cores - 2, min 2) so we
 *     don't starve background services.
 *
 * A lane FAILS the whole run if its exit code is non-zero. Ctrl-C kills all
 * children in the lane pool. Exit code = number of failed lanes.
 *
 * Usage:
 *   node scripts/test-parallel.mjs               # full parallel sweep
 *   node scripts/test-parallel.mjs --lane hact   # single lane by id
 *   node scripts/test-parallel.mjs --list        # list lanes
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { argv } from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;

// ── Lane definitions ──────────────────────────────────────────────────────
// runner: bun | node | python
// heavy:  participates in the one-at-a-time heavy group (CPU-bound benchmark/
//         cohort arithmetic; run with reduced parallelism, never overlapping
//         with other heavy lanes).
const LANES = [
  // ── Node-based gates (light) ────────────────────────────────────────────
  { id: "correctness", runner: "node", args: ["scripts/test-correctness.mjs"],          heavy: false },
  { id: "resilience",  runner: "node", args: ["scripts/test-resilience.mjs"],           heavy: false },
  { id: "foundry",     runner: "node", args: ["scripts/test-foundry.mjs"],              heavy: false },
  { id: "swarm",       runner: "node", args: ["scripts/test-swarm.mjs"],                heavy: false },
  { id: "foundry-mjs", runner: "node", args: ["--test", "tests/foundry/agent-comparison.test.mjs",
      "tests/foundry/agent-comparison-fixture.test.mjs", "tests/foundry/productivity-theory.test.mjs"], heavy: false },
  { id: "commands",    runner: "node", args: ["scripts/test-commands.mjs"],             heavy: false },
  { id: "ops",         runner: "node", args: ["--test", "tests/ops/runtime.test.mjs"],  heavy: false },

  // ── Bun-based suites (mixed) ────────────────────────────────────────────
  // Note: tests/harness includes tests/harness/builder/detect.test.ts (its
  // extensionless imports require Bun's resolver, so it has no Node lane).
  { id: "harness",     runner: "bun",  args: ["test", "tests/harness"],                 heavy: false },
  { id: "api",         runner: "bun",  args: ["test", "tests/api"],                     heavy: false },
  { id: "hact",        runner: "bun",  args: ["test", "tests/hact"],                    heavy: true },
  { id: "retirement",  runner: "bun",  args: ["test", "tests/retirement"],              heavy: true },

  // ── Python gates (light) ───────────────────────────────────
  { id: "correctness-py", runner: "python3", args: ["-m", "unittest", "discover", "-s", "tests/correctness", "-p", "test_*.py"], heavy: false },
  { id: "research-jobs-py", runner: "python3", args: ["detect-py", "tests/research-jobs"],                              heavy: false },
];

// ── CLI ───────────────────────────────────────────────────────────────────
function listLanes() {
  console.log("Lanes (heavy lanes run one-at-a-time):");
  for (const l of LANES) console.log(`  ${l.id.padEnd(18)} ${l.runner.padEnd(9)} ${l.heavy ? "[HEAVY]" : ""} ${l.args.join(" ")}`);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
if (argv.includes("--list")) { listLanes(); process.exit(0); }
const only = flag("--lane");
if (argv.includes("--lane") && !only) { console.error("--lane requires a lane id"); process.exit(2); }

let selected = LANES;
if (only) {
  selected = LANES.filter(l => l.id === only);
  if (!selected.length) { console.error(`No lane '${only}'. Use --list.`); process.exit(2); }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
const MAX_LIGHT_CONCURRENCY = Math.max(2, cpus().length - 2);
const MAX_HEAVY_CONCURRENCY = 1; // one heavy lane at a time — see header note 1.

const t0 = Date.now();
const failures = [];
const completed = [];
let laneSeq = 0;

function runLane(lane) {
  return new Promise((resolve) => {
    const seq = ++laneSeq;
    const started = Date.now();
    const isPy = lane.runner === "python3";
    let cmd, args;
    if (isPy && lane.args[0] === "detect-py") {
      cmd = "python3"; args = ["-m", "unittest", "discover", "-s", lane.args[1], "-p", "test_*.py"];
    } else if (lane.runner === "node") {
      cmd = process.execPath; args = lane.args;
    } else if (lane.runner === "run") {
      cmd = "bun"; args = ["test", ...lane.args];
    } else {
      cmd = lane.runner; args = lane.args;
    }
    process.stdout.write(`[${seq}/${selected.length}] START ${lane.id}: ${cmd} ${args.join(" ")}\n`);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let buf = { out: "", err: "" };
    child.stdout.on("data", d => { buf.out += d; });
    child.stderr.on("data", d => { buf.err += d; });
    child.on("error", err => {
      failures.push({ lane: lane.id, code: "SPAWN_ERROR", detail: String(err) });
      resolve({ id: lane.id, ok: false, ms: Date.now() - started });
    });
    child.on("close", code => {
      const ms = Date.now() - started;
      resolve({ id: lane.id, ok: code === 0, ms });
      if (code !== 0) failures.push({ lane: lane.id, code, detail: buf.err.slice(-4000) || buf.out.slice(-4000) });
    });
  });
}

// Simple two-group scheduler: all light lanes with bounded concurrency; heavy
// lanes are serialized among themselves (but may overlap with light lanes
// only when the machine is otherwise quiet — enforced by waiting for all
// light lanes first when any heavy lane is selected).
const light = selected.filter(l => !l.heavy);
const heavy = selected.filter(l => l.heavy);

async function runGroup(lanes, maxConc) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(maxConc, lanes.length) }, async () => {
    while (i < lanes.length) {
      const lane = lanes[i++];
      results.push(await runLane(lane));
    }
  });
  await Promise.all(workers);
  return results;
}

let heavyNote = "";
if (heavy.length && light.length) {
  // Run heavy lanes AFTER all light lanes complete: keeps timer-sensitive
  // benchmark/cohort suites from competing with anything for CPU.
  heavyNote = "heavy lanes deferred until light lanes finish";
} else if (heavy.length) {
  heavyNote = "heavy-only run";
}

(async () => {
  console.log(`Lanes: ${light.length} light (max ${MAX_LIGHT_CONCURRENCY} concurrent), ${heavy.length} heavy (serialized). ${heavyNote}`);
  const lightResults = await runGroup(light, MAX_LIGHT_CONCURRENCY);
  completed.push(...lightResults);
  const heavyResults = await runGroup(heavy, MAX_HEAVY_CONCURRENCY);
  completed.push(...heavyResults);

  console.log("\n════════════════════ PARALLEL SWEEP RESULTS ════════════════════");
  for (const r of completed) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const serialEstimate = completed.reduce((s, r) => s + r.ms, 1000 * 0).valueOf();
  const serialSum = completed.reduce((s, r) => s + r.ms, 0) / 1000;
  console.log(`\n  Wall clock: ${wall}s   Sum of lane times: ${serialSum.toFixed(1)}s   Speedup: ${(serialSum / (wall || 1)).toFixed(2)}×`);
  if (failures.length) {
    console.error(`\n  ${failures.length} lane(s) FAILED:`);
    for (const f of failures) console.error(`  - ${f.lane} (exit ${f.code}):\n${(f.detail || "").trim().split("\n").slice(-25).join("\n")}`);
    process.exit(1);
  }
  console.log("\n  All lanes passed. ✅");
})();
