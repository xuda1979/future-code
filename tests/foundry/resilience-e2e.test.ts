import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fixture, signal, task, reply, scripted } from "./swarm-fixtures.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { superviseSwarm } from "../../src/harness/foundry/swarm/supervisor.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import type { SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";

const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const agent = fileURLToPath(new URL("../../scripts/research-job-agent.py", import.meta.url));
function localJob(s: SwarmSpec) {
  const temp = dirname(s.project); const counter = join(temp, "remote-executions"); const cfg = join(temp, "job.json");
  const code = `import time;from pathlib import Path;p=Path(${JSON.stringify(counter)});p.write_text(p.read_text()+'x' if p.exists() else 'x');time.sleep(0.6);print('measured fixture result')`;
  writeFileSync(cfg, JSON.stringify({ argv: [python, "-c", code], timeoutMs: 5000 }));
  s.jobs = { simulation: { adapter: { argv: [python, agent, "--root", join(temp, "remote-jobs"), "--config", cfg] }, idempotentEnsure: true, pollMs: 60, staleMs: 10000, maxJobs: 5, maxConcurrent: 1 } };
  s.agents.coder.jobs = ["simulation"]; s.agents.coder.tools.push("run_job");
  s.supervision = { reportEveryMs: 20, checkpointEveryMs: 600000, snapshotReads: true };
  s.recipe.parallelism = 1;
}

test("real job subprocess + Swarm yields its sole slot without extra model calls", async () => fixture(async (s, cfg, project) => {
  const order: string[] = []; const counts = new Map<string, number>(); const health: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string); const id = JSON.parse(body.messages[1].content).task.id;
    const n = (counts.get(id) ?? 0) + 1; counts.set(id, n); order.push(`${id}:${n}`);
    if (n === 1) return reply("", [
      ...(id === "a" ? [{ id: "job", name: "run_job", arguments: { name: "simulation", input: { seed: 7 } } }] : []),
      { id: "write", name: "write_file", arguments: { path: `src/${id}.txt`, content: "42\n" } },
    ]);
    return reply("done");
  }) as typeof fetch;
  const result: any = await runSwarm(s, [task("a"), task("b")], signal(), undefined, fetcher, r => health.push(r));
  assert.equal(result.status, "PASS"); assert.equal(result.providerUsage.requests, 4);
  assert.ok(order.indexOf("b:2") < order.indexOf("a:2"), order.join(","));
  assert.ok(health.some(r => r.waiting > 0));
  assert.equal(readFileSync(join(dirname(project), "remote-executions"), "utf8"), "x");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='FAIL'").get()!.n, 0);
  const j = new SessionJournal(s);
  const aState: any = s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE task='a'").get()!.state);
  assert.equal(aState.toolCalls, 2, "resuming the pending job must not charge a second tool call");
  assert.equal(j.usage(result.id).requests, 4);
}, s => {
  localJob(s);
  s.checks.behavior.argv = [process.execPath, "-e", "const f=require('node:fs');if(!['src/a.txt','src/b.txt'].some(p=>f.readFileSync(p,'utf8').trim()==='42'))process.exit(1)"];
}));

test("pausing supervision does not kill a remote job; same objective resumes it once", async () => fixture(async (s, cfg, project) => {
  const ctl = new AbortController(); const script = scripted([
    () => reply("", [{ id: "job", name: "run_job", arguments: { name: "simulation", input: { seed: 7 } } },
      { id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("complete"),
  ]);
  const first: any = await superviseSwarm(s, { id: "remote-restart", goal: "Complete the experiment and the checked code", tasks: [task()] }, ctl.signal,
    r => { if (r.waiting) ctl.abort(); }, script.fetcher);
  assert.equal(first.status, "PAUSED"); assert.equal(script.bodies.length, 1);
  const second: any = await superviseSwarm(s, { id: "remote-restart" }, signal(), undefined, script.fetcher);
  assert.equal(second.status, "PASS"); assert.equal(second.objective.run, first.objective.run);
  assert.equal(script.bodies.length, 2); assert.equal(readFileSync(join(dirname(project), "remote-executions"), "utf8"), "x");
}, localJob));

test("checkpoint cadence runs a real named check between model rounds", async () => fixture(async (s, cfg) => {
  const script = scripted([
    () => reply("", [{ id: "read", name: "read_file", arguments: { path: "src/a.txt" } }]),
    body => { assert.ok(body.messages.some((m: any) => m.content?.includes?.("checkpointCheck"))); return reply("", [{ id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]); },
    () => reply("done"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, script.fetcher);
  assert.equal(result.status, "PASS");
  const row = s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='checkpoint.checked'").get()!;
  assert.ok(row.n > 0); assert.equal(script.bodies.length, 3);
}, s => { s.supervision = { reportEveryMs: 20, checkpointEveryMs: 1 }; }));

test("per-task PASS cannot satisfy an objective with a failing integration gate", async () => fixture(async (s, cfg, project) => {
  const ctl = new AbortController(); let needsAttention = 0;
  const script = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply()]);
  const result: any = await superviseSwarm(s, { id: "final-gate", goal: "must pass integration", tasks: [task()] }, ctl.signal,
    r => { if (r.status === "NEEDS_ATTENTION") { needsAttention++; ctl.abort(); } }, script.fetcher);
  assert.equal(result.status, "PAUSED"); assert.equal(needsAttention, 1);
  assert.equal(s.db.prepare("SELECT status FROM tasks").get()!.status, "PASS");
  const refs = execFileSync("git", ["-C", project, "for-each-ref", "--format=%(refname)", "refs/heads/swarm"], { encoding: "utf8" }); assert.equal(refs.trim(), "");
}, s => { s.checks.integration = { argv: [process.execPath, "-e", "process.exit(1)"], replaySafe: true }; s.integrationChecks = ["integration"]; }));
