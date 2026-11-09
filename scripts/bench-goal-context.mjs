#!/usr/bin/env node
// Historical PR #93 retirement comparison; not the current steady-state path.
// Use bench-goal-cache-stability.mjs for the current runtime comparison.
// Offline request-payload measurement; no provider calls or quality claims.
// Run: node --experimental-strip-types scripts/bench-goal-context.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { enableAutoGoal, takeAutoGoalContinuation } from "../src/commands/goal/auto.ts";
import { appendGoalRequestAnchor, compactGoalContinuations } from "../src/commands/goal/context.ts";

const meta = content => ({ type: "user", isMeta: true, message: { content } });
const size = messages => Buffer.byteLength(JSON.stringify(messages));
const measurements = [];
for (const continuations of [1, 8, 32, 128]) {
  const cwd = mkdtempSync(join(tmpdir(), "bench-goal-context-"));
  try {
    const goal = continuations === 1 ? "Fix the README typo" : "Deliver reliable task recovery with independent acceptance";
    enableAutoGoal(goal, cwd);
    const messages = [{ type: "user", message: { content: goal } }];
    for (let i = 0; i < continuations; i++) {
      messages.push(meta(takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })),
        { type: "assistant", message: { content: [{ type: "tool_use", id: `check-${i}`, name: "Bash", input: { command: "configured acceptance check" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `check-${i}`, content: `Measured result ${i}: source-bound test evidence retained.\n` + "observed output\n".repeat(32) }] } });
    }
    const project = () => appendGoalRequestAnchor(compactGoalContinuations(messages, true), {
      cwd, mainThread: true, makeMessage: meta,
    });
    const candidate = project();
    assert.deepEqual(candidate.filter(m => !m.isMeta), messages.filter(m => !m.isMeta));
    assert.equal(candidate.filter(m => m.isMeta).length, 2, "latest continuation + one ephemeral current anchor");
    for (let i = 0; i < 10; i++) project();
    const elapsed = [];
    for (let i = 0; i < 50; i++) { const start = performance.now(); project(); elapsed.push(performance.now() - start); }
    elapsed.sort((a, b) => a - b);
    const baselineBytes = size(messages), candidateBytes = size(candidate);
    measurements.push({ continuations, baselineBytes, candidateBytes,
      reductionPercent: +(100 * (baselineBytes - candidateBytes) / baselineBytes).toFixed(2),
      retainedToolPairs: continuations, droppedHumanMessages: 0, droppedToolResults: 0,
      projectionMedianMs: +elapsed[Math.floor(elapsed.length / 2)].toFixed(4) });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const paths = ["src/commands/goal/auto.ts", "src/commands/goal/context.ts", "src/query.ts", "scripts/bench-goal-context.mjs"];
const sourceHash = createHash("sha256");
for (const path of paths) sourceHash.update(path).update(readFileSync(new URL(`../${path}`, import.meta.url)));
console.log(JSON.stringify({ schema: 1, measurement: "offline-synthetic-goal-request-view",
  sourceFingerprint: sourceHash.digest("hex"), runtime: process.version,
  baseline: "same transcript including all host continuation reminders",
  candidate: "same human messages and tool evidence; latest host continuation plus fresh goal anchor",
  limitation: "Internal message JSON bytes before provider normalization and local projection time only. No measured HTTP bytes, live-provider latency, task throughput, reasoning or intelligence measurement. A one-continuation task adds anchor bytes.",
  measurements }, null, 2));
