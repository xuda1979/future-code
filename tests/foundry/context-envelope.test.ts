import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes, inlineReceipt } from "../../src/harness/foundry/swarm/context.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { reflectRun } from "../../src/harness/foundry/rndReflection.ts";
import { recordAttemptTiming, executionProfile } from "../../src/harness/foundry/executionProfile.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { fixture, task, scripted, reply, signal } from "./swarm-fixtures.ts";

test("inline previews obey their encoded UTF-8 limit even for quotes, escapes and multibyte text", () => {
  for (const value of ["\"\\\n\t".repeat(2000), "数学🐈".repeat(2000)]) {
    const encoded = inlineReceipt("a".repeat(64), { content: value }, 512);
    assert.ok(Buffer.byteLength(encoded, "utf8") <= 512);
    const result = JSON.parse(encoded); assert.equal(result.receipt, "a".repeat(64)); assert.equal(result.truncated, true);
  }
});

test("an oversized latest tool batch retires previews, preserves every pair and passes independent checks", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("", [{ id: "setup", name: "write_file", arguments: { path: "src/a.txt", content: "x".repeat(1900) } }]),
    () => reply("", Array.from({ length: 16 }, (_, i) => ({ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }))),
    body => {
      assert.ok(bytes(body) <= cfg.spec.recipe.contextBytes);
      const results = body.messages.filter((m: any) => m.role === "tool" && m.tool_call_id.startsWith("read-"));
      assert.equal(results.length, 16);
      for (const result of results) {
        const pointer = JSON.parse(result.content); assert.equal(pointer.retired, true);
        assert.equal((s.readArtifact(pointer.receipt) as any).content, "x".repeat(1900));
      }
      return reply("", [{ id: "fix", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready for independent verification"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(result.providerUsage.requests, 4);
  assert.equal(result.productivity.verifiedObjectives, 1); assert.equal(result.productivity.measuredAttempts, 1);
  assert.ok(result.productivity.phaseWorkerMs.verify > 0); assert.ok(result.productivity.phaseWorkerMs.toolsWithinExecute > 0);
  assert.equal(result.productivity.measurement, "HOST_TIMINGS_PARTIAL_COVERAGE_NO_LIVE_BASELINE");
}));

test("measured reflection diagnoses tool and verification cost without treating child work as objective gain", async () => fixture(async s => {
  const q = new Scheduler(s), run = q.start([task()]);
  for (let fence = 1; fence <= 3; fence++) {
    const lease = q.claim(run, "w")!; assert.equal(lease.fence, fence);
    recordAttemptTiming(s, run, "a", fence, { prepareMs: 1, executeMs: 400, verifyMs: 500,
      toolMs: 350, remoteRpcMs: 100, toolCalls: 2, remoteRpcs: 1 });
    q.fail(lease, "synthetic diagnostic failure");
  }
  const result: any = reflectRun(s, "o", run).reflection;
  assert.ok(result.findings.some((f: any) => f.code === "verification_dominated"));
  assert.ok(result.findings.some((f: any) => f.code === "tool_latency_dominated"));
  assert.equal(result.productivity.execution.verifiedObjectives, 0);
  const p = executionProfile(s, run);
  assert.equal(p.phaseWorkerMs!.remoteRpcWithinTools, 300);
  // Nested/concurrent times are not added to make a fabricated wall-clock gain.
  assert.equal(p.phaseWorkerMs!.execute, 1200); assert.equal(p.verifiedPerHour, 0);
}));

test("context fallback cannot retire inaccessible evidence or silently add a recall capability", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ id: "setup", name: "write_file", arguments: { path: "src/a.txt", content: "x".repeat(1900) } }]),
    () => reply("", Array.from({ length: 16 }, (_, i) => ({ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }))),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(result.providerUsage.requests, 2);
  const error = s.db.prepare("SELECT error FROM tasks WHERE run=?").get(result.id)!.error;
  assert.match(error, /retiring tool previews requires.*recall/);
}, spec => { spec.agents.coder.tools = spec.agents.coder.tools.filter(t => t !== "recall"); spec.recipe.attempts = 1; }));
