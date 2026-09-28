import { test } from "node:test";
import assert from "node:assert/strict";
import { improve, shouldApply, applyProposal, widenTimeoutOnHang } from "../../src/harness/improver/index.ts";
import { annotate, evaluateSLOs, healthy, healthScore } from "../../src/harness/monitor/index.ts";

function manifest(): any {
  return { schema: 1, harnessId: "regression", project: ".", createdAt: "2026-09-28",
    tools: [{ id: "unit", command: "test", description: "unit", timeoutMs: 60000 }],
    gates: [{ id: "unit", toolId: "unit", required: true, description: "correctness" }],
    slos: [{ id: "quality", metric: "required_pass_rate", op: "gte", threshold: 1 },
      { id: "bounded-runtime", metric: "runtime_ms", op: "lte", threshold: 60000 }],
    config: { maxParallel: 1, contextBudget: 1, improvementPolicy: {} },
    improvementHistory: [], runHistory: [] };
}
function report(m: any, i = 0, passed = false): any {
  return { runId: `run-${i}`, task: "broken implementation", startedAt: "2026-09-28", durationMs: 100,
    gates: [{ gateId: "unit", toolId: "unit", required: m.gates[0].required, passed, exitCode: passed ? 0 : 1, durationMs: 100 }],
    metrics: { required_pass_rate: m.gates[0].required && !passed ? 0 : 1, runtime_ms: 100 }, sloResults: [] };
}
function proposal(changes: Record<string, unknown>, approved = false): any {
  return { id: "injected", description: "test proposal", rationale: "test", changes, approved };
}

test("repeated self-apply decisions cannot turn a broken required check green", () => {
  const m = manifest(); const original = JSON.stringify({ gates: m.gates, slos: m.slos });
  for (let i = 0; i < 8; i++) {
    const r = annotate(m, report(m, i));
    assert.equal(healthy(r), false, `broken code must stay unhealthy on iteration ${i}`);
    m.runHistory.push({ runId: r.runId, gateResults: { unit: false } });
    for (const p of improve(m, r)) if (shouldApply(m, p)) applyProposal(m, p);
    assert.equal(JSON.stringify({ gates: m.gates, slos: m.slos }), original);
  }
});

for (const approved of [false, true]) {
  for (const changes of [{ "gates.unit.required": false }, { "slos.quality.threshold": 0 },
    { "config.maxParallel": 2, "gates.unit.required": false }]) {
    test(`acceptance changes are rejected atomically (approved=${approved}, ${JSON.stringify(changes)})`, () => {
      const m = manifest(); const before = JSON.stringify(m); const p = proposal(changes, approved);
      assert.equal(shouldApply(m, p), false);
      assert.throws(() => applyProposal(m, p), /proposal|acceptance|policy/i);
      assert.equal(JSON.stringify(m), before);
      assert.equal(p.appliedAt, undefined);
    });
  }
}

test("safe execution knobs remain tunable and no-op changes do not count as progress", () => {
  const m = manifest(); const p = proposal({ "config.maxParallel": 2, "config.contextBudget": 4 });
  assert.equal(shouldApply(m, p), true); applyProposal(m, p);
  assert.equal(m.config.maxParallel, 2); assert.equal(m.config.contextBudget, 4);
  assert.equal(shouldApply(m, p), false);
  for (const changes of [{}, { "config.maxParallel": 0 }, { "config.maxParallel": 257 },
    { "config.contextBudget": Infinity }, { "config.contextBudget": "4" }, { "config.surprise": 1 },
    { "tools.missing.timeoutMs": 1000 }]) assert.equal(shouldApply(m, proposal(changes)), false);
});

test("timeout repair leaves the runtime acceptance threshold frozen", () => {
  const m = manifest(); const r = report(m); r.gates[0].timedOut = true;
  const p = widenTimeoutOnHang({ manifest: m, report: r })!;
  assert.equal(p.changes["tools.unit.timeoutMs"], 120000);
  assert.equal(Object.keys(p.changes).some(k => k.startsWith("slos.")), false);
  assert.equal(shouldApply(m, p), true); applyProposal(m, p);
  assert.equal(m.slos[1].threshold, 60000);
});

for (const value of [undefined, null, NaN, Infinity, -Infinity, "0"]) {
  test(`missing/non-finite/wrong-type measurements cannot satisfy an upper bound: ${String(value)}`, () => {
    const m = manifest(); m.slos = [{ id: "latency", metric: "latency", op: "lte", threshold: 10 }];
    const r = report(m, 0, true); r.metrics = value === undefined ? {} : { latency: value };
    const s = evaluateSLOs(m, r)[0];
    assert.equal(s.met, false); assert.equal(s.observed, null);
    assert.equal((s as any).status, "UNKNOWN");
    annotate(m, r); assert.equal(healthy(r), false);
    assert.equal(JSON.parse(JSON.stringify(s)).observed, null);
  });
}

test("a measured zero is not confused with a missing measurement", () => {
  const m = manifest(); const r = report(m, 0, true);
  m.slos = [{ id: "latency", metric: "latency", op: "lte", threshold: 0 }]; r.metrics = { latency: 0 };
  annotate(m, r); assert.equal(r.sloResults[0].observed, 0); assert.equal(healthy(r), true);
});

test("no required gates and failed required gates are not healthy, even with green SLOs", () => {
  const m = manifest(); const r = annotate(m, report(m, 0, true));
  r.gates = []; assert.equal(healthy(r), false); assert.equal(healthScore(r), 0);
  r.gates = [{ toolId: "unit", exitCode: 0, durationMs: 1, required: false, passed: true }]; assert.equal(healthy(r), false);
  r.gates = [{ toolId: "unit", exitCode: 1, durationMs: 1, required: true, passed: false }]; assert.equal(healthy(r), false);
  r.sloResults = []; assert.equal(healthy(r), false);
});
