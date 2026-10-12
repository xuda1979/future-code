import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { executable, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import type { ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import type { Call } from "../../src/harness/foundry/swarm/context.ts";
import { remoteWorkerFleetBackend } from "../../src/harness/foundry/swarm/workerFleet.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const endpoint = resolve("scripts/swarm-worker-agent.py"), python = executable("python3");
const write = (id: string, content = "42\n"): Call => ({ id, name: "write_file", arguments: { path: "src/a.txt", content } });
const edit = (id: string, oldText: string, newText: string): Call => ({ id, name: "edit_file", arguments: { path: "src/a.txt", oldText, newText } });
const read = (id: string, path = "src/a.txt"): Call => ({ id, name: "read_file", arguments: { path } });
const state = (s: Parameters<Parameters<typeof fixture>[0]>[0], run: string): ThreadState =>
  s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!.state) as unknown as ThreadState;
interface Fleet { log: string; marker: string; repos: string[]; roots: string[]; config: string }
function fleet(s: SwarmSpec, options: { hosts?: number; before?: string; after?: string; legacy?: boolean; rpcBytes?: number } = {}): Fleet {
  const parent = dirname(s.project), log = join(parent, "rpc.jsonl"), marker = join(parent, "fault.marker");
  const wrapper = join(parent, "worker-wrapper.py"), config = join(parent, "worker-template.json");
  // Worker templates intentionally have fewer keys than coordinator checks.
  writeFileSync(config, JSON.stringify({ checks: { behavior: { argv: s.checks.behavior.argv } } }));
  writeFileSync(wrapper, `import fcntl, json, os, subprocess, sys, time
log, marker = sys.argv[1:3]
delegate = sys.argv[3:]
raw = sys.stdin.buffer.read()
request = json.loads(raw)
with open(log, "a") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    f.write(json.dumps(request) + "\\n")
${options.before ?? ""}
p = subprocess.run(delegate, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
${options.after ?? ""}
if ${options.legacy ? "True" : "False"} and request["op"] == "prepare" and p.returncode == 0:
    reply = json.loads(p.stdout)
    reply.get("result", {}).pop("capabilities", None)
    p.stdout = json.dumps(reply).encode()
sys.stdout.buffer.write(p.stdout)
sys.stderr.buffer.write(p.stderr)
raise SystemExit(p.returncode)
`);
  const repos = Array.from({ length: options.hosts ?? 1 }, (_, i) => join(parent, `worker-repo-${i}`));
  const roots = repos.map((_r, i) => join(parent, `worker-root-${i}`));
  repos.forEach(repo => execFileSync("git", ["clone", "-q", s.project, repo]));
  roots.forEach(root => mkdirSync(root));
  s.workers = Object.fromEntries(repos.map((repo, i) => [`host-${i}`, {
    adapter: { argv: [python, wrapper, log, marker, python, endpoint, "--root", roots[i]!, "--repo", repo, "--config", config], files: [wrapper, endpoint, config] },
    maxConcurrent: 1, maxRpcBytes: options.rpcBytes ?? 2 * 1024 * 1024,
  }]));
  s.recipe.parallelism = 1;
  return { log, marker, repos, roots, config };
}
const rpcs = (f: Fleet): any[] => readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));

test("remote batches preserve admission, owned results, ordered edit errors and check barriers", async () => {
  let f: Fleet;
  await fixture(async (s, cfg, project) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const calls: Call[] = [read("a"), read("duplicate"), read("b", "src/b.txt"),
      write("start", "10\n"), { id: "denied", name: "write_file", arguments: { path: "checks/forged", content: "never" } },
      edit("ordinary-error", "absent", "never"), edit("finish", "10", "42"),
      { id: "check", name: "run_check", arguments: { name: "behavior" } }, read("after"), read("after-duplicate")];
    const mock = scripted([() => reply("", calls), body => {
      assert.deepEqual(body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id), calls.map(c => c.id));
      return reply("done");
    }]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, remoteWorkerFleetBackend), result = await d.execute(c, signal());
    const t = state(s, run), tools = t.history.filter(m => m.role === "tool");
    assert.equal(t.toolCalls, calls.length);
    assert.ok(tools.every(m => d.journal.ownsReceipt(c, m.receipt!)));
    assert.match(JSON.stringify(s.readArtifact(tools[4]!.receipt!)), /authority|protected/);
    assert.match(JSON.stringify(s.readArtifact(tools[5]!.receipt!)), /exactly one match/);
    assert.match(JSON.stringify(s.readArtifact(tools[8]!.receipt!)), /42/);
    assert.deepEqual(rpcs(f!).map(r => r.op), ["prepare", "batch", "batch", "tool", "snapshot", "batch", "dispose"]);
    const groups = rpcs(f!).filter(r => r.op === "batch");
    assert.deepEqual(groups.map(r => r.calls.map((c: Call) => c.id)), [["a", "b"], ["start", "ordinary-error", "finish"], ["after"]]);
    assert.ok((await d.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
  }, s => { f = fleet(s); });
});

for (const lostReply of [false, true]) test(`remote ${lostReply ? "lost completed reply" : "partial batch failure"} replays the full group from durable patch text`, async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const calls = [read("before"), { id: "listing", name: "list_files", arguments: {} }, edit("step", "10", "20"), edit("finish", "20", "42")];
    const mock = scripted([() => reply("", [write("anchor", "10\n")]), () => reply("", calls), () => reply("done")]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, remoteWorkerFleetBackend), result = await d.execute(c, signal());
    const t = state(s, run);
    assert.equal(t.toolCalls, 5); assert.equal(mock.bodies.length, 3); assert.equal(t.pendingBatch, undefined);
    assert.deepEqual(t.history.filter(m => m.role === "tool").map(m => m.callId), ["anchor", ...calls.map(c => c.id)]);
    const prepares = rpcs(f!).filter(r => r.op === "prepare");
    assert.equal(prepares.length, 2); assert.notEqual(prepares[0].workspace, prepares[1].workspace);
    assert.match(prepares[1].restorePatch, /\+10/); assert.doesNotMatch(prepares[1].restorePatch, /\+20|\+42/);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='worker.failed_over'").get(run)!.n, 1);
    assert.ok((await d.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => {
    s.budget.maxToolCalls = 5; s.recipe.attempts = 1;
    f = fleet(s, { hosts: 2, ...(lostReply ? { after: `if request["op"] == "batch" and request.get("kind") == "workspace-write" and len(request["calls"]) > 1 and not os.path.exists(marker):
    open(marker, "x").close()
    raise SystemExit(71)` } : { before: `if request["op"] == "batch" and request.get("kind") == "workspace-write" and len(request["calls"]) > 1 and not os.path.exists(marker):
    open(marker, "x").close()
    partial = {"schema": 1, "op": "tool", "workspace": request["workspace"], "call": request["calls"][0]}
    p = subprocess.run(delegate, input=json.dumps(partial).encode(), stdout=subprocess.PIPE)
    assert json.loads(p.stdout)["ok"]
    raise SystemExit(71)` }) });
  });
});

test("legacy workers use serial wire calls and replay all edits after a lost snapshot", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const calls = [write("start", "10\n"), edit("step", "10", "20"), edit("finish", "20", "42")];
    const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls), () => reply("done")]).fetcher, remoteWorkerFleetBackend);
    const result = await d.execute(c, signal());
    assert.equal(state(s, run).toolCalls, 3);
    const trace = rpcs(f!); assert.ok(trace.every(r => r.op !== "batch"));
    assert.deepEqual(trace.filter(r => r.op === "tool").map(r => r.call.id), [...calls, ...calls].map(c => c.id));
    assert.equal(trace.filter(r => r.op === "snapshot").length, 2);
    assert.ok((await d.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => { f = fleet(s, { hosts: 2, legacy: true, after: `if request["op"] == "snapshot" and not os.path.exists(marker):
    open(marker, "x").close()
    raise SystemExit(71)` }); s.budget.maxToolCalls = 3; });
});

test("cancelled remote edits leave no partial receipts and resume at the exact tool budget", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "first")!, c = q.capsule(lease);
    const controller = new AbortController(), calls = [edit("step", "10", "20"), edit("finish", "20", "42")];
    const first = new SwarmDriver(s, cfg, scripted([() => reply("", [write("anchor", "10\n")]), () => reply("", calls)]).fetcher, remoteWorkerFleetBackend);
    const execution = first.execute(c, controller.signal);
    const observed = execution.then(() => { throw new Error("expected cancellation"); }, e => e);
    const deadline = Date.now() + 5000;
    while (!existsSync(f!.marker) && Date.now() < deadline) await delay(10);
    assert.ok(existsSync(f!.marker)); controller.abort(); await observed;
    const interrupted = state(s, run);
    assert.equal(interrupted.toolCalls, 3); assert.deepEqual(interrupted.pendingBatch, ["step", "finish"]);
    assert.deepEqual(interrupted.history.filter(m => m.role === "tool").map(m => m.callId), ["anchor"]);
    assert.match(String(s.readArtifact(interrupted.patchHash!)), /\+10/);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_worker_health").get()!.n, 1);
    assert.equal(s.db.prepare("SELECT failures FROM swarm_worker_health").get()!.failures, 0, "cancellation is not worker failure");
    q.fail(lease, "coordinator restarted"); const next = q.capsule(q.claim(run, "replacement")!);
    const mock = scripted([() => reply("recovered")]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, remoteWorkerFleetBackend), result = await d.execute(next, signal());
    assert.equal(state(s, run).toolCalls, 3); assert.equal(mock.bodies.length, 1);
    assert.ok((await d.verify(next, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => {
    s.budget.maxToolCalls = 3;
    f = fleet(s, { before: `if request["op"] == "batch" and request.get("kind") == "workspace-write" and len(request["calls"]) > 1 and not os.path.exists(marker):
    partial = {"schema": 1, "op": "tool", "workspace": request["workspace"], "call": request["calls"][0]}
    p = subprocess.run(delegate, input=json.dumps(partial).encode(), stdout=subprocess.PIPE)
    assert json.loads(p.stdout)["ok"]
    open(marker, "x").close()
    time.sleep(10)` });
  });
});

test("replacement under the same fence starts clean and old disposal cannot release its lease", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const first = remoteWorkerFleetBackend.open(s, cfg, c, cfg.spec.agents.coder, signal(), null);
    await first.tool(write("unpublished", "20\n"));
    const replacement = remoteWorkerFleetBackend.open(s, cfg, c, cfg.spec.agents.coder, signal(), null);
    try {
      assert.equal((await replacement.tool(read("fresh")) as any).content, "0\n");
      await first.dispose();
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_worker_leases").get()!.n, 1);
      const prepares = rpcs(f!).filter(r => r.op === "prepare");
      assert.notEqual(prepares[0].workspace, prepares[1].workspace);
    } finally { await replacement.dispose(); }
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_worker_leases").get()!.n, 0);
  }, s => { f = fleet(s); });
});

test("aggregate read replies are split to preserve the pinned RPC byte ceiling", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const calls = [0, 1, 2].map(i => read(`read-${i}`, `src/evidence${i}.txt`)); calls.push(write("finish"));
    const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls), () => reply("done")]).fetcher, remoteWorkerFleetBackend);
    const result = await d.execute(c, signal());
    assert.deepEqual(rpcs(f!).filter(r => r.op === "batch" && r.kind === "read").map(r => r.calls.length), [1, 1, 1]);
    const receipts = state(s, run).history.filter(m => m.role === "tool").slice(0, 3);
    assert.ok(receipts.every(m => (s.readArtifact(m.receipt!) as any).content.length === 6000));
    assert.ok((await d.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => {
    for (let i = 0; i < 3; i++) writeFileSync(join(s.project, `src/evidence${i}.txt`), "\x01".repeat(6000));
    execFileSync("git", ["-C", s.project, "add", "."]);
    execFileSync("git", ["-C", s.project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "read evidence"]);
    s.budget.maxToolOutputBytes = 8192; s.budget.maxPatchBytes = 4096;
    f = fleet(s, { rpcBytes: 65536 });
  });
});

test("remote batches over budget cause no worker RPC or file effects", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const d = new SwarmDriver(s, cfg, scripted([() => reply("", [write("first"), write("second")])]).fetcher, remoteWorkerFleetBackend);
    await assert.rejects(d.execute(c, signal()), /THREAD_TOOL_BUDGET_EXHAUSTED/);
    assert.equal(existsSync(f!.log), false);
  }, s => { f = fleet(s); s.budget.maxToolCalls = 1; });
});

test("a full 32-call group preserves accounting across the next turn", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const calls = Array.from({ length: 33 }, (_, i) => write(`write-${i}`, i === 32 ? "42\n" : "10\n"));
    const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls.slice(0, 32)), () => reply("", calls.slice(32)), () => reply("done")]).fetcher, remoteWorkerFleetBackend);
    const result = await d.execute(c, signal()), t = state(s, run);
    assert.equal(t.toolCalls, 33);
    assert.deepEqual(t.history.filter(m => m.role === "tool").map(m => m.callId), calls.map(c => c.id));
    assert.deepEqual(rpcs(f!).filter(r => r.op === "batch").map(r => r.calls.length), [32, 1]);
    assert.equal(rpcs(f!).filter(r => r.op === "tool").length, 0);
    assert.ok((await d.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => { f = fleet(s); s.budget.maxToolCalls = 33; });
});

test("a worker's forged patch cannot bypass independent scope verification", async () => {
  await fixture(async (s, _cfg, project) => {
    const result = await runSwarm(s, [task()], signal(), undefined,
      scripted([() => reply("", [write("first", "10\n"), edit("finish", "10", "42")]), () => reply("done")]).fetcher);
    assert.equal(result.status, "FAIL"); assert.equal(result.accepted, 0);
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
  }, s => { s.recipe.attempts = 1; fleet(s, { after: `if request["op"] == "batch" and request.get("kind") == "workspace-write":
    reply = json.loads(p.stdout)
    reply["patch"] = reply["patch"].replace("src/a.txt", "checks/forged.txt")
    p.stdout = json.dumps(reply).encode()` }); });
});

test("an exhausted fleet preserves the whole batch for a bounded later attempt", async () => {
  let f: Fleet;
  await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "worker")!, c = q.capsule(lease);
    const calls = [write("start", "10\n"), edit("step", "10", "20"), edit("finish", "20", "42")];
    const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls)]).fetcher, remoteWorkerFleetBackend);
    await assert.rejects(d.execute(c, signal()), /command exit 71/);
    const interrupted = state(s, run);
    assert.equal(interrupted.patchHash, null); assert.equal(interrupted.toolCalls, 3);
    assert.deepEqual(interrupted.pendingBatch, calls.map(c => c.id));
    assert.equal(interrupted.history.filter(m => m.role === "tool").length, 0);
    assert.equal(rpcs(f!).filter(r => r.op === "batch").length, 2);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_worker_leases").get()!.n, 0);
    q.fail(lease, "fleet recovered"); const next = q.capsule(q.claim(run, "replacement")!);
    const recovery = new SwarmDriver(s, cfg, scripted([() => reply("recovered")]).fetcher, remoteWorkerFleetBackend);
    const result = await recovery.execute(next, signal());
    assert.equal(state(s, run).toolCalls, 3);
    assert.ok((await recovery.verify(next, result, signal())).checks.every(check => check.verdict === "PASS"));
  }, s => {
    s.budget.maxToolCalls = 3;
    f = fleet(s, { hosts: 2, before: `if request["op"] == "batch":
    with open(marker, "a+") as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        n = int(counter.read() or "0") + 1
        counter.seek(0)
        counter.truncate()
        counter.write(str(n))
    if n <= 2:
        for call in request["calls"][:2]:
            partial = {"schema": 1, "op": "tool", "workspace": request["workspace"], "call": call}
            p = subprocess.run(delegate, input=json.dumps(partial).encode(), stdout=subprocess.PIPE)
            assert json.loads(p.stdout)["ok"]
        raise SystemExit(71)` });
  });
});

test("worker read batch uses at most four slots and rejects mixed effects before execution", () => {
  const result = JSON.parse(execFileSync(python, ["-c", `import importlib.util, json, threading, time, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
active = peak = executed = 0
lock = threading.Lock()
gate = threading.Event()
def tool(root, template, request):
    global active, peak, executed
    with lock:
        executed += 1
        active += 1
        peak = max(peak, active)
        if active == 4: gate.set()
    assert gate.wait(2), "reads were serialized"
    time.sleep(.01)
    with lock: active -= 1
    return {"ok": True, "result": request["call"]["id"]}
worker.tool = tool
calls = [{"id": str(i), "name": "read_file", "arguments": {"path": "src/a.txt"}} for i in range(9)]
reply = worker.batch(Path("unused"), {}, {"workspace": "a" * 64, "kind": "read", "calls": calls})
assert [r["result"] for r in reply["result"]["results"]] == [str(i) for i in range(9)]
assert peak == 4 and executed == 9
for invalid in [calls + [{"id": "check", "name": "run_check", "arguments": {}}], calls * 4, [calls[0], calls[0]]]:
    try:
        worker.batch(Path("unused"), {}, {"workspace": "a" * 64, "kind": "read", "calls": invalid})
        raise AssertionError("invalid batch was executed")
    except ValueError: pass
assert executed == 9
print(json.dumps({"peak": peak, "executed": executed}))
`, endpoint], { encoding: "utf8" }));
  assert.deepEqual(result, { peak: 4, executed: 9 });
});
