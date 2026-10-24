import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runSwarm, loadSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Operations, actionEvidenceGate } from "../../src/harness/foundry/operations/actions.ts";
import { operationsTick, serveOperations } from "../../src/harness/foundry/operations/service.ts";
import { handleOperations } from "../../src/harness/foundry/operations/cli.ts";
import { handleSwarm } from "../../src/harness/foundry/swarm/cli.ts";
import type { SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";

function enable(s: SwarmSpec, lost = false): void {
  const ledger = join(s.project, "../external-ledger.json");
  const adapter = `const fs=require('node:fs');const p=${JSON.stringify(ledger)};const r=JSON.parse(fs.readFileSync(0,'utf8'));
    const a=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];
    if(r.operation==='execute'){if(a.some(x=>x.key===r.key))throw Error('duplicate commit');a.push({key:r.key,inputHash:r.inputHash});fs.writeFileSync(p,JSON.stringify(a));${lost ? "process.exit(1);" : ""}}
    const found=a.some(x=>x.key===r.key&&x.inputHash===r.inputHash);
    console.log(JSON.stringify({schema:1,key:r.key,inputHash:r.inputHash,status:found?'CONFIRMED':'UNKNOWN',result:{observed:found},usage:{units:3}}));`;
  s.operations = { schema: 1, namespace: "arbitrary-project-v1", resources: { units: { unit: "resource-units", limit: 20 } },
    timeoutMs: 2000, maxBytes: 8192, pollMs: 10, maxModelRequests: 20, maxModelRequestBytes: 1000000,
    capabilities: { advance: { adapter: { argv: [process.execPath, "-e", adapter] }, effect: "write",
      identity: ["/resource"], reserve: { units: 5 },
      input: { type: "object", properties: { resource: { type: "string", maxLength: 128 } }, required: ["resource"] } } },
    routes: { changed: [task()] } };
  s.agents.coder.tools.push("invoke_capability", "read_operations"); s.agents.coder.capabilities = ["advance"];
}
function worker(resource = "opaque-resource-1") {
  return scripted([
    body => {
      const context = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
      assert.deepEqual(context.capabilities.advance.identity, ["/resource"]);
      assert.ok(!context.capabilities.advance.adapter);
      return reply("", [{ name: "invoke_capability", arguments: { name: "advance", input: { resource } } }]);
    },
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("external observation retained; independent checks decide acceptance"),
  ]);
}

test("Swarm executes pinned external capabilities and reuses one commitment across runs", async () => fixture(async (s, cfg, project) => {
  for (let i = 0; i < 2; i++) {
    const w = worker(); const result = await runSwarm(s, [task()], signal(), undefined, w.fetcher);
    assert.equal(result.status, "PASS"); assert.equal(w.bodies.length, 3);
    assert.equal(actionEvidenceGate(s, result.id).status, "PASS");
    const accepted = s.db.prepare("SELECT evidence FROM tasks WHERE run=?").get(result.id)!;
    const evidence: any = s.readArtifact(accepted.evidence);
    assert.ok(evidence.verification.checks.some((c: any) => c.id === "operations" && c.verdict === "PASS"));
  }
  assert.equal(JSON.parse(readFileSync(join(project, "../external-ledger.json"), "utf8")).length, 1);
  assert.equal(s.db.prepare("SELECT spent FROM operations_resources").get()!.spent, 3);
  assert.equal(s.db.prepare("SELECT requests FROM operations_inference_totals").get()!.requests, 6);
}, enable));

test("a lost adapter response resumes the actual tool call without another external mutation", async () => fixture(async (s, cfg, project) => {
  const w = worker(); const result = await runSwarm(s, [task()], signal(), undefined, w.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(w.bodies.length, 3);
  assert.equal(JSON.parse(readFileSync(join(project, "../external-ledger.json"), "utf8")).length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='operations.action.unknown'").get()!.n, 1);
  assert.equal(s.db.prepare("SELECT held,spent FROM operations_resources").get()!.held, 0);
}, s => enable(s, true)));

test("service intake deduplicates events and executes through existing governed tasks", async () => fixture(async (s, cfg) => {
  const ops = new Operations(s, cfg.operations!), input = { source: "trusted-ingress", id: "1", type: "changed", payload: { resource: "opaque-resource-1" } };
  const e = ops.events.enqueue(input); assert.equal(ops.events.enqueue(input).key, e.key);
  const w = worker();
  const result: any = await operationsTick(s, signal(), (_tasks, run, sig) => runSwarm(s, [], sig, run, w.fetcher));
  assert.equal(result.status, "PROCESSED"); assert.equal(ops.events.get(e.key).status, "COMPLETE");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
  assert.equal((await operationsTick(s, signal()) as any).status, "IDLE");
  assert.equal(ops.events.enqueue(input).run, result.run);
  const persisted: any = JSON.parse(s.db.prepare("SELECT spec FROM tasks WHERE run=?").get(result.run)!.spec);
  assert.deepEqual(persisted.input.event.payload, input.payload);
  assert.deepEqual(persisted.input.configuration, task().input);
}, enable));

test("service refuses completion when action evidence disappears after task acceptance", async () => fixture(async (s, cfg) => {
  const ops = new Operations(s, cfg.operations!);
  const e = ops.events.enqueue({ source: "trusted-ingress", id: "1", type: "changed", payload: {} });
  const w = worker();
  const result: any = await operationsTick(s, signal(), async (_tasks, run, sig) => {
    const r = await runSwarm(s, [], sig, run, w.fetcher);
    const receipt = s.db.prepare("SELECT receipt FROM operations_actions").get()!.receipt;
    unlinkSync(join(s.root, "artifacts", `${receipt}.json`)); return r;
  });
  assert.equal(result.status, "NEEDS_ATTENTION"); assert.equal(result.gate.invalid, 1);
  assert.equal(ops.events.get(e.key).status, "DISPATCHED");
  assert.throws(() => ops.events.complete(e.key), /external action evidence/);
  await assert.rejects(() => integrateSwarm(s, result.run, signal()), /external action evidence/);
}, enable));

test("service inference ceilings persist across events and replacement runs", async () => fixture(async (s) => {
  const first = worker(); assert.equal((await runSwarm(s, [task()], signal(), undefined, first.fetcher)).status, "PASS");
  let calls = 0;
  const fetcher = (async () => { calls++; throw Error("must not reach provider"); }) as typeof fetch;
  const result = await runSwarm(s, [task()], signal(), undefined, fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(calls, 0);
  assert.equal(s.db.prepare("SELECT requests FROM operations_inference_totals").get()!.requests, 3);
}, s => { enable(s); s.operations!.maxModelRequests = 3; }));

test("operations CLI retains explicit authority and legacy default configurations", async () => fixture(async (s, cfg) => {
  assert.equal(loadSwarm(s).operations?.policy.namespace, cfg.operations?.policy.namespace);
  await assert.rejects(() => handleOperations(["mode", "--root", s.root, "--mode", "DRAINING"]), /allow-exec/);
  const mode: any = await handleSwarm(["operations", "mode", "--root", s.root, "--mode", "DRAINING", "--allow-exec"]);
  assert.equal(mode.mode, "DRAINING");
  const status: any = await handleOperations(["status", "--root", s.root]); assert.equal(status.mode, "DRAINING");
  const stop = new AbortController(); stop.abort();
  const end: any = await serveOperations(s, stop.signal, () => {}); assert.equal(end.status, "STOPPED");
}, enable));

test("the task verifier cannot accept missing external receipt bytes", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "test")!, c = q.capsule(lease);
  const driver = new SwarmDriver(s, cfg, worker().fetcher);
  const result = await driver.execute(c, signal());
  const receipt = s.db.prepare("SELECT receipt FROM operations_actions").get()!.receipt;
  unlinkSync(join(s.root, "artifacts", `${receipt}.json`));
  const checked = await driver.verify(c, result, signal());
  assert.equal(checked.checks.find(c => c.id === "operations")?.verdict, "UNKNOWN");
}, enable));
