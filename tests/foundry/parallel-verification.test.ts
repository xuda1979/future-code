import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { LocalGitHands, verifyPatch } from "../../src/harness/foundry/swarm/workspace.ts";
import { fixture, signal, spec, task } from "./swarm-fixtures.ts";

test("parallel verification is opt-in and requires replay-safe check contracts", () => {
  const s = spec("/example");
  s.checks.behavior.parallelSafe = true;
  s.checks.behavior.replaySafe = false;
  assert.throws(() => validateSwarmSpec(s), /parallelSafe check/);
});
test("parallel-safe checks independently validate the same frozen patch", async () =>
  fixture(async (s, cfg) => {
    const scheduler = new Scheduler(s);
    const run = scheduler.start([task()]);
    const c = scheduler.capsule(scheduler.claim(run, "worker")!);
    const hands = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
    let patch: string;
    try {
      await hands.tool({ id: "edit", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } });
      patch = await hands.snapshot();
    } finally { await hands.dispose(); }
    const verdict = await verifyPatch(s, cfg, c, { schema: 1, patchHash: patch!, summary: "test" }, signal());
    assert.deepEqual(verdict.checks.map(c => c.verdict), ["PASS", "PASS"]);
    const details = s.readArtifact(verdict.checks[1]!.detail!) as any[];
    assert.deepEqual(details.map(x => x.name), ["behavior", "secondary"]);
    assert.ok(details.every(x => x.code === 0));
  }, s => {
    s.checks.behavior.parallelSafe = true;
    s.checks.secondary = { argv: [process.execPath, "-e", "process.exit(0)"], replaySafe: true, parallelSafe: true };
    s.agents.coder.checks = ["behavior", "secondary"];
  }));
test("parallel-safe verifier fails closed on a source-mutating check", async () =>
  fixture(async (s, cfg) => {
    const scheduler = new Scheduler(s), run = scheduler.start([task()]);
    const c = scheduler.capsule(scheduler.claim(run, "worker")!);
    const hands = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
    let patch: string;
    try {
      await hands.tool({ id: "edit", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } });
      patch = await hands.snapshot();
    } finally { await hands.dispose(); }
    const verdict = await verifyPatch(s, cfg, c, { schema: 1, patchHash: patch!, summary: "test" }, signal());
    assert.equal(verdict.checks[1]!.verdict, "FAIL");
    const details = s.readArtifact(verdict.checks[1]!.detail!) as any[];
    assert.match(JSON.stringify(details), /isolated verifier mutated tracked source/);
  }, s => {
    s.checks.behavior.parallelSafe = true;
    s.checks.mutating = { argv: [process.execPath, "-e",
      "require('node:fs').writeFileSync('src/a.txt','wrong\\n')"], replaySafe: true, parallelSafe: true };
    s.agents.coder.checks = ["behavior", "mutating"];
  }));
