import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { verifyPatch } from "../../src/harness/foundry/swarm/workspace.ts";
import { executable } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, signal, task } from "./swarm-fixtures.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const python = executable(process.env.PYTHON ?? "python3");
const adapter = resolve(repo, "adapters/chip-verification");
const files = ["verify.py", "plan.py", "runner.py", "evidence.py"].map(name => join(adapter, name));

test("chip report adversaries and optional real RTL regression", () => {
  const result = spawnSync(python, ["-m", "unittest", "discover", "-s", "tests/chip-verification", "-p", "test_*.py", "-v"],
    { cwd: repo, timeout: 60000, encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
});

test("the existing independent verifier rejects a zero-exit EDA wrapper with failing UVM evidence", async () => {
  await fixture(async (store, cfg, project) => {
    const scheduler = new Scheduler(store);
    const run = scheduler.start([task()]);
    const lease = scheduler.claim(run, "worker")!, capsule = scheduler.capsule(lease);
    // The worker's empty patch and prose cannot override the pinned chip check.
    const patchHash = store.artifact("");
    const result = await verifyPatch(store, cfg, capsule,
      { schema: 1, patchHash, summary: "All chip verification passed" }, signal());
    assert.equal(result.checks.find(c => c.id === "scope")?.verdict, "PASS");
    assert.equal(result.checks.find(c => c.id === "behavior")?.verdict, "FAIL");
    const details = store.readArtifact(result.checks.find(c => c.id === "behavior")!.detail!) as any[];
    assert.ok(details.some(row => row.stdout?.includes('"verdict": "FAIL"')), "failure must come from EDA evidence, not setup");
  }, s => {
    const project = s.project, checks = join(project, "checks");
    mkdirSync(checks, { recursive: true });
    const producer = join(checks, "eda.py");
    writeFileSync(producer, "from pathlib import Path\nPath('uvm.log').write_text('UVM_INFO [RNTST] Running test fifo_test...\\nUVM Report Summary\\nUVM_ERROR : 2\\nUVM_FATAL : 0\\n')\n");
    const plan = { schema: 1, name: "independent-chip-check", inputs: ["checks/eda.py"], maxParallel: 1,
      timeoutMs: 1500, maxOutputBytes: 4096, maxArtifactBytes: 4096,
      requirements: [{ id: "behavior", description: "No UVM errors", evidence: "simulation", cases: ["uvm"] }],
      cases: [{ id: "uvm", seeds: [1], steps: [{ argv: [python, "{project}/checks/eda.py"], timeoutMs: 1000 }],
        evidence: { format: "uvm", path: "uvm.log", testName: "fifo_test" } }], coverage: [] };
    const path = join(dirname(project), "chip-plan.json");
    writeFileSync(path, JSON.stringify(plan));
    execFileSync("git", ["-C", project, "add", "checks"]);
    execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "pinned EDA fixture"]);
    s.checks.behavior = { argv: [python, join(adapter, "verify.py"), "--plan", path], files: [...files, path, producer], replaySafe: true };
  });
});
