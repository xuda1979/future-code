import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEvidence } from "../../src/harness/foundry/evidenceFabric.ts";
import { formatHealth, type HealthReport } from "../../src/harness/foundry/health.ts";
import { superviseSwarm } from "../../src/harness/foundry/swarm/supervisor.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const patch = () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);

for (const phase of ["before-integration", "after-integration"] as const) {
  test(`missing acceptance evidence triggers recovery ${phase} without a continue prompt`, { timeout: 30000 }, async () => fixture(async s => {
    const script = scripted([patch, () => reply(), patch, () => reply()]);
    let injected = false, replans = 0;
    const removeReceipt = (run: string) => {
      if (injected) return;
      injected = true;
      s.db.prepare("UPDATE tasks SET evidence=NULL WHERE run=? AND id='a'").run(run);
    };
    const event = s.event.bind(s);
    s.event = (...args) => {
      const result = event(...args);
      if (phase === "after-integration" && args[0] === "swarm.integrated") removeReceipt(String(args[2]));
      return result;
    };
    const result: any = await superviseSwarm(s, { id: "evidence-recovery", goal: "Implement and verify", tasks: [task()] },
      signal(), health => {
        if (phase === "before-integration" && health.status === "RUNNING" && health.counts.PASS === 1)
          removeReceipt(health.runId);
      }, script.fetcher, async context => {
        replans++;
        assert.match(context.reason, /0\/1 tasks have durable accepted evidence/);
        assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_objective_completions").get()!.n, 0);
        return { reason: "Rebuild the missing verification receipt with a fresh execution and check",
          tasks: [{ ...task(), goal: "Reexecute and independently verify the missing receipt" }] };
      });
    assert.ok(injected);
    assert.equal(replans, 1);
    assert.equal(script.bodies.length, 4);
    assert.equal(result.status, "PASS");
    assert.equal(result.objective.evidenceGate.status, "PASS");
    assert.equal(result.objective.revision, 1);
    assert.ok(result.completion.attestation);
  }, spec => { spec.supervision = { maxReplans: 1, reportEveryMs: 10, checkpointEveryMs: 600000 }; }));
}

test("a replacement run cannot hide an unresolved evidence conflict", { timeout: 30000 }, async () => fixture(async s => {
  let injected = false, replans = 0;
  const controller = new AbortController();
  const script = scripted([patch, () => reply()]);
  const result: any = await superviseSwarm(s, { id: "conflict", goal: "Verify the implementation", tasks: [task()] },
    controller.signal, health => {
      if (!injected && health.status === "RUNNING" && health.counts.PASS === 1) {
        injected = true;
        recordEvidence(s, { run: health.runId, goal: "a", task: "a", kind: "counterexample", verdict: "FAIL",
          strength: 1, source: "independent-adversarial-check" });
      }
      if (health.status === "NEEDS_ATTENTION") {
        assert.match(formatHealth(health), /unresolved conflict/);
        controller.abort();
      }
    }, script.fetcher, async () => { replans++; return { reason: "Must not discard conflict", tasks: [task()] }; });
  assert.ok(injected);
  assert.equal(replans, 0);
  assert.equal(result.objective.evidenceGate.status, "BLOCKED");
  assert.equal(result.objective.completion, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
}));

test("a conflict arriving during recovery planning is rechecked before replacement admission", { timeout: 30000 }, async () => fixture(async s => {
  const controller = new AbortController();
  let injected = false, replans = 0;
  const script = scripted([patch, () => reply()]);
  const result: any = await superviseSwarm(s, { id: "late-conflict", goal: "Verify without dropping evidence", tasks: [task()] },
    controller.signal, health => {
      if (!injected && health.status === "RUNNING" && health.counts.PASS === 1) {
        injected = true;
        s.db.prepare("UPDATE tasks SET evidence=NULL WHERE run=? AND id='a'").run(health.runId);
      }
      if (health.status === "NEEDS_ATTENTION") controller.abort();
    }, script.fetcher, async context => {
      replans++;
      recordEvidence(s, { run: context.runId, goal: "a", task: "a", kind: "counterexample", verdict: "FAIL",
        strength: 1, source: "late-independent-check" });
      return { reason: "Rebuild missing evidence", tasks: [{ ...task(), goal: "Recheck missing receipt" }] };
    });
  assert.equal(replans, 1);
  assert.equal(result.objective.evidenceGate.status, "BLOCKED");
  assert.equal(result.objective.recovery.state, "FAILED");
  assert.match(result.objective.recovery.detail, /Acceptance evidence changed during recovery/);
  assert.equal(result.objective.completion, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
}, spec => { spec.supervision = { maxReplans: 1, reportEveryMs: 10, checkpointEveryMs: 600000 }; }));

test("objective errors and failed recovery stay visible ahead of truncated worker diagnostics", { timeout: 30000 }, async () => fixture(async s => {
  const controller = new AbortController();
  let blocked: HealthReport | undefined;
  const result: any = await superviseSwarm(s, { id: "provider-blocker", goal: "Complete all work",
    tasks: Array.from({ length: 9 }, (_, i) => task(`worker-${i}`)) }, controller.signal, health => {
      if (health.status === "NEEDS_ATTENTION") { blocked = health; controller.abort(); }
    }, (async () => reply("no implementation")) as typeof fetch,
    async () => { throw new Error("Recovery model HTTP 401; credentials require external renewal"); });
  assert.equal(result.status, "PAUSED");
  assert.ok(blocked);
  assert.equal(blocked.tasks.length, 10);
  assert.equal(blocked.tasks[0].id, "objective");
  assert.match(formatHealth(blocked), /Recovery FAILED: Recovery model HTTP 401/);
  assert.match(formatHealth(blocked), /credentials require external renewal/);
  assert.equal(result.objective.recovery.state, "FAILED");
  assert.equal(result.objective.completion, null);
}, spec => {
  spec.recipe.attempts = 1;
  spec.supervision = { maxReplans: 1, reportEveryMs: 10, checkpointEveryMs: 600000 };
}));
