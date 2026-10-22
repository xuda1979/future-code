import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { objectiveStatus, superviseSwarm } from "../../src/harness/foundry/swarm/supervisor.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const patch = () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);

for (const mode of ["current", "legacy", "pending-recovery"]) test(`failed integration survives pause and reopen: ${mode}`, async () => fixture(async (s, _cfg, project) => {
  const script = scripted([patch, () => reply()]);
  let plannerCalls = 0;
  const planner = async () => { plannerCalls++; throw new DeferredAttemptError("provider", Date.now() + 60000, "provider outage"); };
  const first = new AbortController();
  const result: any = await superviseSwarm(s, { id: "durable-gate", goal: "Pass integration", tasks: [task()] },
    first.signal, health => { if (health.status === "NEEDS_ATTENTION") first.abort(); }, script.fetcher, planner);
  assert.equal(result.status, "PAUSED");
  const counter = join(dirname(project), "integration-count");
  assert.equal(readFileSync(counter, "utf8"), "x");
  if (mode === "legacy") {
    // Old supervisors kept the failure in events but overwrote the objective's
    // reason on pause. Upgrading must recover that durable failure as well.
    s.db.exec("DROP TABLE IF EXISTS swarm_objective_integration_failures");
    s.db.prepare("DELETE FROM meta WHERE key=?").run("extension.swarm.integrationFailuresMigrated");
  }
  const reopened = await Store.open(s.root);
  try {
    for (let i = 0; i < 2; i++) {
      const paused = new AbortController();
      const resumed: any = await superviseSwarm(reopened, { id: "durable-gate" }, paused.signal,
        health => { if (health.status === "NEEDS_ATTENTION") paused.abort(); }, script.fetcher, planner);
      assert.equal(resumed.status, "PAUSED");
      assert.equal(resumed.objective.run, result.objective.run);
      assert.equal(readFileSync(counter, "utf8"), "x", "restart repeated a known failed verification");
      assert.match(resumed.objective.integrationFailure.reason, /^Final integration failed:/);
      assert.equal(resumed.objective.budget.usedRequests, result.objective.budget.usedRequests);
    }
    // An explicit operator retry after repairing the environment can still
    // finish. Supervision must revalidate its receipt, without another check.
    writeFileSync(join(dirname(project), "integration-ready"), "ready");
    await integrateSwarm(reopened, result.objective.run, signal());
    reopened.db.prepare("UPDATE swarm_recovery_attempts SET retry_at=0 WHERE objective='durable-gate'").run();
    const completed: any = await superviseSwarm(reopened, { id: "durable-gate" }, signal(), undefined, script.fetcher, planner);
    assert.equal(completed.status, "PASS");
    assert.equal(completed.objective.state, "COMPLETE");
    assert.equal(readFileSync(counter, "utf8"), "xx");
    assert.equal(script.bodies.length, 2);
    assert.equal(plannerCalls, mode === "pending-recovery" ? 1 : 0, "accepted integration must take precedence over another replan");
  } finally { reopened.close(); }
}, spec => {
  const counter = join(dirname(spec.project), "integration-count");
  const ready = join(dirname(spec.project), "integration-ready");
  spec.checks.integration = { argv: [process.execPath, "-e",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'x');process.exit(fs.existsSync(${JSON.stringify(ready)})?0:1)`], replaySafe: true };
  spec.integrationChecks = ["integration"];
  spec.supervision = { reportEveryMs: 10, checkpointEveryMs: 600000, maxReplans: mode === "pending-recovery" ? 1 : 0 };
}));

test("integration recovery keeps its retry deadline across supervisor restarts", async () => fixture(async (s, _cfg, project) => {
  const script = scripted([patch, () => reply(), patch, () => reply()]);
  let plannerCalls = 0;
  const first = new AbortController();
  const initial: any = await superviseSwarm(s, { id: "deferred-gate", goal: "Pass integration", tasks: [task()] },
    first.signal, health => { if (health.status === "NEEDS_ATTENTION") first.abort(); }, script.fetcher,
    async () => { plannerCalls++; throw new DeferredAttemptError("provider", Date.now() + 60000, "provider outage"); });
  const recovery = s.db.prepare("SELECT * FROM swarm_recovery_attempts WHERE objective='deferred-gate'").get()!;
  assert.equal(recovery.state, "STARTED");
  const reopened = await Store.open(s.root);
  try {
    const paused = new AbortController();
    await superviseSwarm(reopened, { id: "deferred-gate" }, paused.signal,
      health => { if (health.status === "NEEDS_ATTENTION") paused.abort(); }, script.fetcher,
      async () => { plannerCalls++; throw new Error("retried before deadline"); });
    assert.equal(readFileSync(join(dirname(project), "integration-count"), "utf8"), "x");
    assert.deepEqual(reopened.db.prepare("SELECT * FROM swarm_recovery_attempts WHERE objective='deferred-gate'").get(), recovery);
    assert.equal(plannerCalls, 1);
    reopened.db.prepare("UPDATE swarm_recovery_attempts SET retry_at=0 WHERE objective='deferred-gate'").run();
    writeFileSync(join(dirname(project), "integration-ready"), "ready");
    const completed: any = await superviseSwarm(reopened, { id: "deferred-gate" }, signal(), undefined, script.fetcher,
      async () => { plannerCalls++; return { reason: "Repair after outage", tasks: [{ ...task(), goal: "Repair integration" }] }; });
    assert.equal(completed.status, "PASS");
    assert.notEqual(completed.objective.run, initial.objective.run);
    assert.equal(completed.objective.integrationFailure, null, "failure belongs to the old run");
    assert.equal(plannerCalls, 2);
    assert.equal(readFileSync(join(dirname(project), "integration-count"), "utf8"), "xx");
  } finally { reopened.close(); }
}, spec => {
  const counter = join(dirname(spec.project), "integration-count");
  const ready = join(dirname(spec.project), "integration-ready");
  spec.checks.integration = { argv: [process.execPath, "-e",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'x');process.exit(fs.existsSync(${JSON.stringify(ready)})?0:1)`], replaySafe: true };
  spec.integrationChecks = ["integration"];
  spec.supervision = { reportEveryMs: 10, checkpointEveryMs: 600000, maxReplans: 1 };
}));

for (const response of ["decline", "error", "defer", "proposal"] as const) {
  test(`a stale supervisor cannot record a delayed recovery ${response}`, async () => fixture(async s => {
    const other = await Store.open(s.root);
    let expected: any; let eventCount = 0; let proposalCount = 0;
    try {
      await assert.rejects(superviseSwarm(s, { id: "lease-fence", goal: "Repair safely", tasks: [task()] },
        signal(), undefined, scripted([() => reply("no patch")]).fetcher, async () => {
          // Simulate a new controller taking over while this planner was away.
          other.db.prepare("UPDATE swarm_objectives SET owner='new-controller',lease=? WHERE id='lease-fence'")
            .run(Date.now() + 60000);
          other.db.prepare("UPDATE swarm_recovery_attempts SET detail='new controller is planning' WHERE objective='lease-fence'").run();
          expected = other.db.prepare("SELECT * FROM swarm_recovery_attempts WHERE objective='lease-fence'").get();
          eventCount = other.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n;
          proposalCount = other.db.prepare("SELECT COUNT(*) AS n FROM kernel_proposals").get()!.n;
          if (response === "error") throw new Error("late planner failure");
          if (response === "defer") throw new DeferredAttemptError("provider", Date.now() + 1000, "late provider outage");
          if (response === "proposal") return { reason: "Repair", tasks: [{ ...task(), goal: "Repair task" }] };
          return null;
        }), /stale objective supervisor/);
      assert.deepEqual(s.db.prepare("SELECT * FROM swarm_recovery_attempts WHERE objective='lease-fence'").get(), expected);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, eventCount);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM kernel_proposals").get()!.n, proposalCount);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
      assert.equal((objectiveStatus(s, "lease-fence") as any).revision, 0);
      assert.equal(s.db.prepare("SELECT owner FROM swarm_objectives WHERE id='lease-fence'").get()!.owner, "new-controller");
    } finally { other.close(); }
  }, spec => {
    spec.recipe.attempts = 1;
    spec.supervision = { reportEveryMs: 10, checkpointEveryMs: 600000, maxReplans: 1 };
  }));
}
