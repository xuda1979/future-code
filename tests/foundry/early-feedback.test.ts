import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { canSliceExploratoryCheckpoint } from "../../src/harness/foundry/swarm/checkpointPolicy.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { LocalGitHands, verifyPatch, type HandsBackend } from "../../src/harness/foundry/swarm/workspace.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

test("diagnostic path declarations are bounded, canonical and operator-pinned", () => {
  const s = spec("/tmp/repo");
  s.checks.behavior.diagnosticPaths = ["src/a.txt", "lib"];
  validateSwarmSpec(s);
  for (const diagnosticPaths of [[], ["src", "src"], ["../secret"], ["/absolute"], ["."],
    ["src\\file"], Array.from({ length: 129 }, (_, i) => "dir/" + i), ["a".repeat(257)]]) {
    assert.throws(() => validateSwarmSpec({ ...s, checks: { behavior: {
      ...s.checks.behavior, diagnosticPaths,
    } } }), /diagnostic|unsafe/);
  }
});

test("path scope only skips irrelevant autonomous diagnostics, never unknown or periodic inputs", () => {
  const match = ["src/main.ts", "tests/unit"];
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md"], match), true);
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md", "src/main.ts"], match), false);
  assert.equal(canSliceExploratoryCheckpoint(["src/main.ts"], match), false);
  assert.equal(canSliceExploratoryCheckpoint(["src/main.ts/child"], match), false);
  assert.equal(canSliceExploratoryCheckpoint(["src/main.tsx"], match), true);
  assert.equal(canSliceExploratoryCheckpoint([], match), false);
  assert.equal(canSliceExploratoryCheckpoint(undefined, match), false);
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md"], undefined), false);
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md"], match, "periodic"), false);
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md"], match, "on-change", true), false);
  assert.equal(canSliceExploratoryCheckpoint(["docs/readme.md"], match, "on-change", false, true), false);
});

test("local path inventory is authoritative and independent acceptance remains complete", async () =>
  fixture(async (store, cfg) => {
    const q = new Scheduler(store), run = q.start([task("b")]);
    const lease = q.claim(run, "worker")!, c = q.capsule(lease);
    const hands = new LocalGitHands(store, cfg, c, cfg.spec.agents.coder, signal());
    let patchHash: string;
    try {
      await hands.warmup();
      assert.deepEqual(await hands.changedPaths(), []);
      await hands.tool({ id: "write", name: "write_file", arguments: { path: "src/b.txt", content: "42\n" } });
      assert.deepEqual(await hands.changedPaths(), ["src/b.txt"]);
      assert.equal(canSliceExploratoryCheckpoint(await hands.changedPaths(),
        cfg.spec.checks.behavior.diagnosticPaths), true);
      patchHash = await hands.snapshot();
    } finally { await hands.dispose(); }
    // A diagnostic slice must never certify the actual task or final tree.
    const result = await verifyPatch(store, cfg, c, { schema: 1, patchHash: patchHash!, summary: "probe" }, signal());
    assert.equal(result.checks.find(c => c.id === "behavior")?.verdict, "FAIL");
  }, s => { s.checks.behavior.diagnosticPaths = ["src/a.txt"]; }));

test("local workspace prewarm starts before the external model reply, and patches still verify", async () =>
  fixture(async (store, cfg) => {
    const scheduler = new Scheduler(store), run = scheduler.start([task()]);
    const lease = scheduler.claim(run, "worker")!, c = scheduler.capsule(lease);
    let started = 0, settled = 0;
    const backend: HandsBackend = {
      id: cfg.handsId,
      open: (store, cfg, c, profile, signal, restore) => {
        const hands = new LocalGitHands(store, cfg, c, profile, signal, restore);
        return {
          warmup: async () => { started++; await hands.warmup(); settled++; },
          tool: call => hands.tool(call), snapshot: () => hands.snapshot(),
          dispose: () => hands.dispose(),
        };
      },
      verify: verifyPatch,
    };
    const { fetcher, bodies } = scripted([
      () => {
        assert.ok(started >= 1, "worktree preparation must begin before the provider reply");
        return reply("edit", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
      },
      () => reply("done"),
    ]);
    const driver = new SwarmDriver(store, cfg, fetcher, backend);
    const outcome = await driver.execute(c, signal());
    assert.equal(bodies.length, 2);
    assert.equal(started, 2);
    assert.equal(settled, 2);
    const verification = await driver.verify(c, outcome, signal());
    assert.equal(verification.checks.find(c => c.id === "behavior")?.verdict, "PASS");
  }));
