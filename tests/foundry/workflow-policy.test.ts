import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { applyWorkflowProposal, workflowObservation, workflowVersions } from "../../src/harness/foundry/workflow.ts";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { WorkflowPolicyAgent, workflowPolicyMetrics } from "../../src/harness/foundry/swarm/workflowPolicy.ts";
import { decodeSpawnChildren } from "../../src/harness/foundry/swarm/spawn.ts";
import { validateSwarmSpec, type SwarmSpec, type PinnedSwarm } from "../../src/harness/foundry/swarm/config.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import type { Json } from "../../src/harness/foundry/types.ts";
import { fixture, task, reply, signal, spec } from "./swarm-fixtures.ts";

function configure(s: SwarmSpec) {
  s.agents.planner = { ...s.agents.coder, model: "workflow-model" };
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 2, maxSpawnedTasks: 8 },
    workflowPolicy: { agent: "planner", mode: "apply", minIntervalMs: 100, maxReviews: 16,
      maxOperations: 4, maxSnapshotTasks: 8, maxSnapshotBytes: 12000, maxTaskTimeoutMs: 40000,
      allowedOperations: ["expand_task", "set_task_timeout", "set_parallelism"] } };
}
function proposal(store: Store, run: string, operations: any[] = []): Json {
  const v = workflowVersions(store, run);
  return { schema: 1, expectedGraphVersion: v.graphVersion, expectedPolicyVersion: v.policyVersion,
    expectedStateVersion: v.stateVersion, reason: "Measured bottleneck warrants a bounded adjustment", operations };
}
function apply(store: Store, cfg: PinnedSwarm, run: string, key: string, value: Json) {
  return applyWorkflowProposal(store, run, key, value,
    { ...cfg.spec.supervision!.workflowPolicy!, spawn: cfg.spec.supervision!.dynamicDAG },
    (parent, children) => decodeSpawnChildren(cfg.spec, parent, children));
}
const child = (id = "prep", extra: Record<string, unknown> = {}) => ({ id,
  goal: "Implement the bounded prerequisite", acceptance: ["pinned behavior check"],
  input: null, writeScope: ["src/a.txt"], readScope: ["src"], ...extra });

test("workflow observation is byte bounded, paginated and excludes input/transcripts", async () => {
  await fixture(async store => {
    const tasks = Array.from({ length: 35 }, (_, i) => ({ ...task(`item${String(i).padStart(2, "0")}`),
      input: "PRIVATE_RAW_INPUT_SHOULD_NOT_ENTER_POLICY_CONTEXT".repeat(100) }));
    const run = new Scheduler(store).start(tasks);
    const ids: string[] = [];
    let after = "";
    do {
      const page: any = workflowObservation(store, run, { limit: 6, maxBytes: 3000, after });
      assert.ok(Buffer.byteLength(canonical(page)) <= 3000);
      assert.equal(page.counts.READY, 35);
      assert.ok(!canonical(page).includes("PRIVATE_RAW_INPUT"));
      assert.ok(page.tasks.length > 0);
      ids.push(...page.tasks.map((t: any) => t.id));
      after = page.nextAfter;
    } while (after);
    assert.deepEqual(ids, tasks.map(t => t.id));
  }, configure);
});

test("a task too wide for the observation page stays visible without losing its cursor", async () => {
  await fixture(async store => {
    const wide = { ...task("a"), writeScope: [`src/${"x".repeat(5000)}`], readScope: [] };
    const run = new Scheduler(store).start([wide, task("b")]);
    const first: any = workflowObservation(store, run, { maxBytes: 2048 });
    assert.equal(first.tasks[0].id, "a"); assert.equal(first.tasks[0].detailsOmitted, true);
    const ids = [...first.tasks.map((t: any) => t.id)];
    if (first.nextAfter) ids.push(...(workflowObservation(store, run,
      { maxBytes: 2048, after: first.nextAfter }) as any).tasks.map((t: any) => t.id));
    assert.deepEqual(ids, ["a", "b"]);
  }, configure);
});

test("an atomic policy patch controls actual claims and future lease deadlines", async () => {
  await fixture(async (store, cfg) => {
    const q = new Scheduler(store), roots = [task("a", []), task("b", [])];
    roots.forEach(t => { t.readScope = []; });
    const run = q.start(roots), initialHash = digest(roots);
    const patch = proposal(store, run, [
      { op: "set_parallelism", parallelism: 1 },
      { op: "set_task_timeout", taskId: "a", timeoutMs: 35000 },
    ]);
    const receipt = apply(store, cfg, run, "limits", patch);
    assert.equal(receipt.verdict, "ADMIT"); assert.equal(receipt.changed, true);
    assert.equal(receipt.policyVersion, 1);
    assert.ok(receipt.snapshotHash);
    const snapshot: any = store.readArtifact(receipt.snapshotHash!);
    assert.equal(snapshot.parallelism, 1);
    assert.equal(snapshot.timeouts[0].timeout_ms, 35000);
    const claimedAt = Date.now();
    const leases = q.claimMany(run, "host", 4, claimedAt);
    assert.equal(leases.length, 1); assert.equal(leases[0].taskId, "a");
    assert.equal(leases[0].deadline, claimedAt + 35000);
    assert.equal(digest(store.db.prepare("SELECT spec FROM tasks WHERE run=? ORDER BY id").all(run)
      .map(row => JSON.parse(row.spec))), initialHash);
    assert.deepEqual(apply(store, cfg, run, "limits", patch), receipt, "replay returns the original durable receipt");
    assert.throws(() => apply(store, cfg, run, "limits", proposal(store, run)), /drift/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(run)!.n, 1);
    assert.throws(() => store.db.prepare("DELETE FROM workflow_commits WHERE run=?").run(run), /append-only/);
    const late = apply(store, cfg, run, "active-timeout", proposal(store, run,
      [{ op: "set_task_timeout", taskId: "a", timeoutMs: 40000 }]));
    assert.equal(late.verdict, "REJECT"); assert.match(late.reason, /active leases/);
    assert.equal(store.db.prepare("SELECT deadline FROM tasks WHERE run=? AND id='a'").get(run)!.deadline, leases[0].deadline);
  }, configure);
});

test("mixed patches roll back DAG writes, policies, graph versions and derived indexes", async () => {
  await fixture(async (store, cfg) => {
    const root = { ...task("a"), writeScope: ["src"], readScope: ["src"] };
    const run = new Scheduler(store).start([root]);
    const before = workflowVersions(store, run);
    const result = apply(store, cfg, run, "rollback", proposal(store, run, [
      { op: "expand_task", taskId: "a", children: [child()] },
      { op: "set_parallelism", parallelism: 1 },
      { op: "set_task_timeout", taskId: "a.prep", timeoutMs: 40001 },
    ]));
    assert.equal(result.verdict, "REJECT"); assert.match(result.reason, /timeout exceeds/);
    assert.equal(result.changed, false); assert.equal(result.snapshotHash, null);
    assert.deepEqual(result.childIds, []);
    assert.deepEqual(workflowVersions(store, run), before);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run=?").get(run)!.n, 1);
    for (const table of ["spawn_edges", "spawn_requests", "workflow_run_policy", "workflow_task_policy"])
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run=?`).get(run)!.n, 0);
    assert.equal(store.db.prepare("SELECT task FROM scheduler_nodes WHERE run=?").all(run).length, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='task.expanded'").get(run)!.n, 0);
    assert.equal(store.db.prepare("SELECT verdict FROM kernel_admissions WHERE proposal=?").get(result.proposalId)!.verdict, "REJECT");
  }, configure);
});

test("runtime rejects forbidden authority, scope escape, cycles, roster drift and stale state", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([{ ...task("a"), writeScope: ["src"], readScope: ["src"] }]);
    const cases = [
      [{ op: "set_verification_policy", checks: [] }],
      [{ op: "mark_pass", taskId: "a" }],
      [{ op: "set_parallelism", parallelism: 5 }],
      [{ op: "set_task_timeout", taskId: "a", timeoutMs: -1 }],
      [{ op: "set_parallelism", parallelism: 1, resourceLimit: 99 }],
      [{ op: "expand_task", taskId: "a", children: [child("bad", { writeScope: ["outside/file"] })] }],
      [{ op: "expand_task", taskId: "a", children: [child("bad", { agent: "unregistered" })] }],
      [{ op: "expand_task", taskId: "a", children: [child("x", { dependsOn: ["y"] }), child("y", { dependsOn: ["x"] })] }],
    ];
    for (const [i, ops] of cases.entries()) {
      const result = apply(store, cfg, run, `unsafe:${i}`, proposal(store, run, ops));
      assert.equal(result.verdict, "REJECT", canonical(ops));
      assert.equal(result.changed, false);
    }
    const old = proposal(store, run, [{ op: "set_parallelism", parallelism: 1 }]);
    new Scheduler(store).claim(run, "competing-host");
    const stale = apply(store, cfg, run, "stale", old);
    assert.equal(stale.verdict, "REJECT"); assert.match(stale.reason, /stale workflow snapshot/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM spawn_edges WHERE run=?").get(run)!.n, 0);
  }, configure);
});

test("operation whitelist, task limits, depth limits and lifetime review count are host enforced", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([{ ...task("a"), writeScope: ["src"], readScope: ["src"] }]);
    cfg.spec.supervision!.workflowPolicy!.allowedOperations = ["set_parallelism"];
    assert.equal(apply(store, cfg, run, "not-whitelisted", proposal(store, run,
      [{ op: "expand_task", taskId: "a", children: [child()] }])).verdict, "REJECT");
    cfg.spec.supervision!.workflowPolicy!.allowedOperations.push("expand_task");
    cfg.spec.supervision!.dynamicDAG!.maxChildrenPerTask = 1;
    assert.equal(apply(store, cfg, run, "too-many", proposal(store, run,
      [{ op: "expand_task", taskId: "a", children: [child("one"), child("two")] }])).verdict, "REJECT");
    cfg.spec.supervision!.dynamicDAG!.maxDepth = 1;
    assert.equal(apply(store, cfg, run, "first-level", proposal(store, run,
      [{ op: "expand_task", taskId: "a", children: [child()] }])).verdict, "ADMIT");
    const nested = apply(store, cfg, run, "too-deep", proposal(store, run,
      [{ op: "expand_task", taskId: "a.prep", children: [child("nested")] }]));
    assert.equal(nested.verdict, "REJECT"); assert.match(nested.reason, /depth/);
    cfg.spec.supervision!.workflowPolicy!.maxReviews = 4;
    const exhausted = apply(store, cfg, run, "exhausted", proposal(store, run));
    assert.equal(exhausted.verdict, "REJECT"); assert.match(exhausted.reason, /review limit/);
  }, configure);
});

test("external policy role expands an ordered sub-DAG and the integrated source passes pinned checks", async () => {
  await fixture(async (store, _cfg, project) => {
    let policyCalls = 0, workerCalls = 0;
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.model === "workflow-model") {
        policyCalls++; assert.equal(body.tools.length, 1);
        assert.equal(body.tools[0].function.name, "propose_workflow");
        const packet = JSON.parse(body.messages[1].content);
        const observation = packet.observation;
        assert.equal(packet.requestBudget.maxRequests, 100);
        assert.equal(packet.requestBudget.used.requests, 0);
        assert.equal(packet.requestBudget.costUsd, null);
        assert.equal(observation.tasks[0].status, "READY");
        return reply("", [{ name: "propose_workflow", arguments: {
          schema: 1, expectedGraphVersion: observation.graphVersion, expectedPolicyVersion: observation.policyVersion,
          expectedStateVersion: observation.stateVersion, reason: "Prepare and independently check the prerequisite before integration",
          operations: [{ op: "expand_task", taskId: "root", children: [child(),
            child("audit", { dependsOn: ["prep"] })] }],
        } }]);
      }
      workerCalls++;
      const packet = JSON.parse(body.messages.find((m: any) => m.role === "user" && m.content.includes('"task"')).content);
      if (packet.task.id === "root.prep" && !body.messages.some((m: any) => m.role === "tool"))
        return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
      if (packet.task.id === "root") assert.deepEqual(packet.workflowChildren.map((t: any) => t.taskId), ["root.audit", "root.prep"]);
      return reply("Scoped work complete; let the pinned verifier decide");
    }) as typeof fetch;
    const root = { ...task("root"), writeScope: ["src"], readScope: ["src"] };
    const result: any = await runSwarm(store, [root], signal(), undefined, fetcher);
    assert.equal(result.status, "PASS"); assert.equal(result.accepted, 3);
    assert.equal(policyCalls, 1); assert.equal(workerCalls, 4);
    assert.equal(result.providerUsage.requests, policyCalls + workerCalls);
    assert.equal(result.workflowPolicy.requests, 1); assert.equal(result.workflowPolicy.tokens, 15);
    assert.equal(result.workflowPolicy.decisions.ADMIT, 1);
    const integration = await integrateSwarm(store, result.id, signal());
    assert.equal(execFileSync("git", ["-C", project, "show", `${integration.commit}:src/a.txt`], { encoding: "utf8" }), "42\n");
    assert.equal((await runSwarm(store, [root], signal(), result.id, fetcher) as any).status, "PASS");
    assert.equal(policyCalls, 1, "resume neither replans completed work nor spends again");
  }, s => { configure(s); s.supervision!.workflowPolicy!.maxReviews = 1; });
});

test("competing policy hosts share one durable reservation and one metered request", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    let entered!: () => void, release!: () => void, calls = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = (async () => {
      calls++; entered(); await gate;
      return reply("", [{ name: "propose_workflow", arguments: proposal(store, run,
        [{ op: "set_parallelism", parallelism: 1 }]) }]);
    }) as typeof fetch;
    const pending = new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    await started;
    const second = await Store.open(store.root);
    try { await new WorkflowPolicyAgent(second, cfg, fetcher).review(run, signal()); }
    finally { second.close(); release(); }
    await pending;
    assert.equal(calls, 1); assert.equal(workflowVersions(store, run).parallelism, 1);
    assert.equal((workflowPolicyMetrics(store, run) as any).requests, 1);
  }, configure);
});

test("the host binds a proposal to its actual observation even if the model guesses newer versions", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    let calls = 0;
    const fetcher = (async () => {
      if (++calls === 1) new Scheduler(store).claim(run, "worker-that-started-during-review");
      return reply("", [{ name: "propose_workflow", arguments: proposal(store, run,
        calls === 1 ? [{ op: "set_parallelism", parallelism: 1 }] : []) }]);
    }) as typeof fetch;
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    const first: any = store.readArtifact(String(store.db.prepare("SELECT receipt_hash FROM workflow_reviews WHERE run=?").get(run)!.receipt_hash));
    assert.equal(first.verdict, "REJECT"); assert.match(first.reason, /host-observed input/);
    assert.equal(workflowVersions(store, run).parallelism, cfg.spec.recipe.parallelism);
    await new Promise(resolve => setTimeout(resolve, 110));
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    assert.equal(calls, 2, "stale advice must not suppress a fresh review of an unseen state");
    assert.equal((workflowPolicyMetrics(store, run) as any).decisions.ADMIT, 1);
  }, configure);
});

test("Anthropic policy requests expose only the proposal schema and share usage accounting", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, "propose_workflow");
      assert.ok(body.tools[0].input_schema); assert.ok(body.system[0].text.includes("policy adviser"));
      return Response.json({ content: [{ type: "tool_use", id: "policy-1", name: "propose_workflow", input: proposal(store, run) }],
        stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });
    }) as typeof fetch;
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    assert.equal((workflowPolicyMetrics(store, run) as any).tokens, 15);
    assert.equal((workflowPolicyMetrics(store, run) as any).decisions.ADMIT, 1);
    assert.equal(workflowVersions(store, run).policyVersion, 0, "keeping the workflow creates no new policy revision");
  }, s => { configure(s); s.agents.planner.protocol = "anthropic"; });
});

test("an unknown interrupted review is not blindly sent again on restart", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error("must not resubmit unknown work"); }) as typeof fetch;
    new WorkflowPolicyAgent(store, cfg, fetcher);
    store.db.prepare(`INSERT INTO workflow_reviews
      (run,round,owner,created,deadline,trigger_hash,request_hash,status) VALUES(?,1,'dead',0,0,?,?,'ACTIVE')`)
      .run(run, digest(workflowVersions(store, run)), store.artifact({ unknown: true }));
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    assert.equal(calls, 0);
    assert.equal(store.db.prepare("SELECT status FROM workflow_reviews WHERE run=?").get(run)!.status, "UNKNOWN");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(run)!.n, 0);
  }, configure);
});

test("observe mode records advice without mutating policy or consuming a worker lease", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    const fetcher = (async () => reply("", [{ name: "propose_workflow", arguments: proposal(store, run,
      [{ op: "set_parallelism", parallelism: 1 }]) }])) as typeof fetch;
    const controller = new WorkflowPolicyAgent(store, cfg, fetcher);
    const before = workflowVersions(store, run);
    await controller.review(run, signal());
    assert.deepEqual(workflowVersions(store, run), before);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run=?").get(run)!.n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(run)!.n, 0);
    assert.equal(new SessionJournal(store).usage(run).requests, 1);
    assert.equal(store.db.prepare("SELECT status FROM workflow_reviews WHERE run=?").get(run)!.status, "DONE");
    await new WorkflowPolicyAgent(store, cfg, fetcher).review(run, signal());
    assert.equal(new SessionJournal(store).usage(run).requests, 1, "a second host cannot repeat the same review");
  }, s => { configure(s); s.supervision!.workflowPolicy!.mode = "observe"; });
});

test("policy timeout cannot stall worker execution even when the provider ignores cancellation", async () => {
  await fixture(async (store) => {
    let policyCalls = 0;
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.model === "workflow-model") { policyCalls++; return await new Promise<Response>(() => {}); }
      if (!body.messages.some((m: any) => m.role === "tool"))
        return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
      return reply();
    }) as typeof fetch;
    const result: any = await runSwarm(store, [task()], signal(), undefined, fetcher);
    assert.equal(result.status, "PASS"); assert.equal(policyCalls, 1);
    assert.equal(store.db.prepare("SELECT status FROM workflow_reviews WHERE run=?").get(result.id)!.status, "ERROR");
    assert.equal(store.db.prepare("SELECT status FROM agent_requests WHERE run=? AND task='__workflow__'").get(result.id)!.status, "UNKNOWN");
    assert.equal(result.providerUsage.requests, 3, "failed policy spend remains in the shared run budget");
    assert.equal(result.workflowPolicy.tokens, null); assert.equal(result.workflowPolicy.costUsd, null);
  }, s => { configure(s); s.budget.requestTimeoutMs = 1000; s.supervision!.workflowPolicy!.maxReviews = 1; });
});

test("malformed policy calls and attempted worker tools cannot mutate the workflow or fail valid work", async () => {
  await fixture(async store => {
    for (const responseKind of ["worker-tool", "multiple-proposals", "truncated"]) {
      const fetcher = (async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        if (body.model === "workflow-model") {
          if (responseKind === "worker-tool") return reply("", [{ name: "write_file",
            arguments: { path: "src/a.txt", content: "forbidden policy edit" } }]);
          const packet = JSON.parse(body.messages[1].content).observation;
          const args = { schema: 1, expectedGraphVersion: packet.graphVersion,
            expectedPolicyVersion: packet.policyVersion, expectedStateVersion: packet.stateVersion,
            reason: "Retain current workflow", operations: [] };
          if (responseKind === "multiple-proposals") return reply("", [
            { name: "propose_workflow", arguments: args }, { name: "propose_workflow", arguments: args }]);
          const response = await reply("", [{ name: "propose_workflow", arguments: args }]).json();
          response.choices[0].finish_reason = "length";
          return Response.json(response);
        }
        if (!body.messages.some((m: any) => m.role === "tool")) return reply("", [{ name: "write_file",
          arguments: { path: "src/a.txt", content: "42\n" } }]);
        return reply();
      }) as typeof fetch;
      const result: any = await runSwarm(store, [task()], signal(), undefined, fetcher);
      assert.equal(result.status, "PASS", responseKind);
      assert.equal(result.workflowPolicy.reviews.ERROR, 1);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(result.id)!.n, 0);
      assert.equal(result.providerUsage.requests, 3);
    }
  }, s => { configure(s); s.supervision!.workflowPolicy!.maxReviews = 1; });
});

test("crash recovery replays a recorded policy response without another API request", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    const body: Json = { model: "workflow-model", messages: [{ role: "user",
      content: canonical({ observation: workflowVersions(store, run) }) }] };
    const journal = new SessionJournal(store);
    new WorkflowPolicyAgent(store, cfg); // installs the durable review reservation schema
    const request = await journal.reserveRun(run, "__workflow__", "fixture-pool", body, cfg.spec.budget, signal());
    const response = await reply("", [{ name: "propose_workflow", arguments: proposal(store, run,
      [{ op: "set_parallelism", parallelism: 1 }]) }]).json();
    journal.complete(request, 15, response);
    store.db.prepare(`INSERT INTO workflow_reviews
      (run,round,owner,created,deadline,trigger_hash,request_hash,status) VALUES(?,1,'dead-host',0,0,?,?,'ACTIVE')`)
      .run(run, digest(workflowVersions(store, run)), store.artifact(body));
    const second = await Store.open(store.root);
    try {
      let calls = 0;
      const agent = new WorkflowPolicyAgent(second, cfg, (async () => { calls++; throw new Error("must replay"); }) as typeof fetch);
      await agent.review(run, signal());
      assert.equal(calls, 0); assert.equal(workflowVersions(second, run).parallelism, 1);
      assert.equal(second.db.prepare("SELECT status FROM workflow_reviews WHERE run=?").get(run)!.status, "DONE");
      assert.equal(journal.usage(run).requests, 1);
    } finally { second.close(); }
  }, configure);
});

test("replaying a committed policy never treats later worker state as already reviewed", async () => {
  await fixture(async (store, cfg) => {
    const run = new Scheduler(store).start([task()]);
    const observed = workflowVersions(store, run);
    const body: Json = { model: "workflow-model", messages: [{ role: "user", content: canonical({ observation: observed }) }] };
    const patch = proposal(store, run, [{ op: "set_parallelism", parallelism: 1 }]);
    const committed = apply(store, cfg, run, "review:1", patch);
    assert.equal(committed.verdict, "ADMIT");
    new WorkflowPolicyAgent(store, cfg);
    const journal = new SessionJournal(store);
    const id = await journal.reserveRun(run, "__workflow__", "fixture-pool", body, cfg.spec.budget, signal());
    journal.complete(id, 15, await reply("", [{ name: "propose_workflow", arguments: patch }]).json());
    store.db.prepare(`INSERT INTO workflow_reviews
      (run,round,owner,created,deadline,trigger_hash,request_hash,status) VALUES(?,1,'crashed',0,0,?,?,'ACTIVE')`)
      .run(run, digest(observed), store.artifact(body));
    new Scheduler(store).claim(run, "worker-after-commit");
    assert.notEqual(digest(workflowVersions(store, run)), committed.stateHash);
    await new WorkflowPolicyAgent(store, cfg, (async () => { throw new Error("must replay"); }) as typeof fetch).review(run, signal());
    const restored = store.db.prepare("SELECT after_hash,status FROM workflow_reviews WHERE run=?").get(run)!;
    assert.equal(restored.status, "DONE"); assert.equal(restored.after_hash, committed.stateHash);
    let calls = 0;
    await new WorkflowPolicyAgent(store, cfg, (async () => {
      calls++; return reply("", [{ name: "propose_workflow", arguments: proposal(store, run) }]);
    }) as typeof fetch).review(run, signal());
    assert.equal(calls, 1, "later worker state still triggers a fresh policy review");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(run)!.n, 2);
  }, configure);
});

test("workflow configuration rejects unknown roles, unbounded resources and expansion without host authority", () => {
  const valid = spec("/tmp/repo"); configure(valid); validateSwarmSpec(valid);
  for (const [key, value] of [["agent", "unknown"], ["maxReviews", 1000], ["maxSnapshotBytes", 1000],
    ["maxTaskTimeoutMs", 60001], ["mode", "autocratic"], ["allowedOperations", ["mark_pass"]]]) {
    const s = structuredClone(valid); (s.supervision!.workflowPolicy as any)[key] = value;
    assert.throws(() => validateSwarmSpec(s), key as string);
  }
  delete valid.supervision!.dynamicDAG;
  assert.throws(() => validateSwarmSpec(valid), /dynamicDAG/);
});
