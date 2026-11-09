#!/usr/bin/env node
// Offline structural measurement, not provider latency/cost or model quality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_GOAL_EXECUTION_POLICY, decideAutoGoalContinuation, enableAutoGoal } from "../src/commands/goal/auto.ts";
import { appendGoalRequestAnchor, compactGoalContinuations } from "../src/commands/goal/context.ts";

const meta = content => ({ type: "user", isMeta: true, message: { content } });
const encode = value => Buffer.from(JSON.stringify(value));
const prefix = (a, b) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };
const continuation = (cwd, promptFormat) => {
  const decision = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true, promptFormat });
  assert.equal(decision.kind, "CONTINUE"); return meta(decision.prompt);
};
const measurements = [];
for (const continuations of [1, 8, 32, 128]) {
  const root = mkdtempSync(join(tmpdir(), "bench-goal-prefix-"));
  try {
    const fullCwd = join(root, "full"), deltaCwd = join(root, "delta");
    const goal = "Deliver reliable task recovery with independent acceptance";
    enableAutoGoal(goal, fullCwd); enableAutoGoal(goal, deltaCwd);
    const full = [meta(goal)], delta = [meta(goal)];
    let fullInstructionBytes = 0, deltaInstructionBytes = 0;
    const pairsPerContinuation = 8;
    for (let turn = 0; turn < continuations; turn++) {
      const f = continuation(fullCwd, "full"), d = continuation(deltaCwd, "delta");
      fullInstructionBytes += Buffer.byteLength(f.message.content); deltaInstructionBytes += Buffer.byteLength(d.message.content);
      full.push(f); delta.push(d);
      for (let i = 0; i < pairsPerContinuation; i++) {
        const id = `check-${turn}-${i}`;
        const pair = [{ type: "assistant", message: { content: [{ type: "tool_use", id }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
            content: `Synthetic evidence ${id}\n` + "observed output\n".repeat(64) }] } }];
        full.push(...pair); delta.push(...pair);
      }
    }
    const oldView = history => appendGoalRequestAnchor(compactGoalContinuations(history, true), {
      cwd: fullCwd, mainThread: true, makeMessage: meta });
    const newView = history => appendGoalRequestAnchor(history, { cwd: deltaCwd, mainThread: true,
      makeMessage: meta, executionPolicy: AUTO_GOAL_EXECUTION_POLICY });
    const oldBefore = oldView(full), newBefore = newView(delta);
    const assistant = { type: "assistant", message: { content: "Continue with the next scoped step" } };
    const oldAfter = oldView([...full, assistant, continuation(fullCwd, "full")]);
    const newAfter = newView([...delta, assistant, continuation(deltaCwd, "delta")]);
    assert.deepEqual(newAfter.slice(1, delta.length + 1), delta, "historical prefix is unchanged");
    const evidence = history => history.filter(m => Array.isArray(m.message.content));
    assert.deepEqual(evidence(newAfter), evidence(full), "all tool pairs survive");
    const oldBytes = encode(oldBefore), newBytes = encode(newBefore);
    const oldPrefix = prefix(oldBytes, encode(oldAfter)), newPrefix = prefix(newBytes, encode(newAfter));
    measurements.push({ continuations, toolPairs: continuations * pairsPerContinuation,
      standaloneFullInstructionBytes: fullInstructionBytes, deltaInstructionBytes,
      deltaInstructionReductionPercent: +(100 * (1 - deltaInstructionBytes / fullInstructionBytes)).toFixed(2),
      invariantPolicyBytesPerRequest: Buffer.byteLength(AUTO_GOAL_EXECUTION_POLICY),
      pr93RetiredViewBytes: oldBytes.length, appendOnlyDeltaViewBytes: newBytes.length,
      pr93CommonPrefixBytes: oldPrefix, appendOnlyDeltaCommonPrefixBytes: newPrefix,
      pr93PriorViewBytesOutsideCommonPrefix: oldBytes.length - oldPrefix,
      appendOnlyPriorViewBytesOutsideCommonPrefix: newBytes.length - newPrefix,
      droppedToolResults: 0, historyRewritten: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const paths = ["src/commands/goal/auto.ts", "src/commands/goal/context.ts", "src/query.ts", "scripts/bench-goal-cache-stability.mjs"];
const hash = createHash("sha256");
for (const path of paths) hash.update(path).update(readFileSync(new URL(`../${path}`, import.meta.url)));
console.log(JSON.stringify({ schema: 1, measurement: "offline-goal-prefix-structure",
  sourceFingerprint: hash.digest("hex"), node: process.version,
  limits: "Internal message JSON and common byte prefixes, not provider-normalized HTTP bytes, billed tokens, cache hits, latency, productivity or intelligence. Actual provider cache reuse is optional and unmeasured. All evidence is synthetic.",
  measurements }, null, 2));
