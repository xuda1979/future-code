import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluate } from "../../src/harness/foundry/evolution.ts";
import { CommandDriver } from "../../src/harness/foundry/commands.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { contract, recipe, task } from "./fixtures.ts";
import type { PinnedCommand, Protocol } from "../../src/harness/foundry/types.ts";

async function fixture(fn: (store: Store, cli: (args: string[]) => { status: number | null; json: any }, protocolFile: string, p: Protocol) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "future-evolution-cli-")); const root = join(dir, "state");
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, `import {readFileSync} from 'node:fs';
    const q=JSON.parse(readFileSync(0,'utf8'));
    console.log(JSON.stringify(q.kind==='execute'?{artifact:{answer:4}}:
      {artifactHash:q.artifactHash,checks:[{id:'behavior',verdict:'PASS'}]}));`);
  const spec = join(dir, "spec.json"); const adapter = { argv: [process.execPath, worker] };
  writeFileSync(spec, JSON.stringify({ name: "rsi-cli", environmentId: contract.environmentId,
    requiredChecks: contract.requiredChecks, slos: [], limits: contract.limits,
    recipe: { ...recipe, parallelism: 1 }, worker: adapter, verifier: adapter }));
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../../src/harness/foundry/cli.ts", import.meta.url)), ...args, "--root", root],
    { encoding: "utf8", timeout: 10000 });
    assert.ok(!r.error, r.error?.message); assert.notEqual(r.status, null, r.stderr);
    return { status: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  let s: Store | undefined;
  try {
    assert.equal(cli(["init", "--spec", spec]).status, 0);
    s = await Store.open(root);
    const p: Protocol = { datasetId: "cli-holdout", environmentId: contract.environmentId,
      tasks: [task(), { ...task("b"), priority: 5 }], repetitions: 2, objective: "costUsd", minRelativeGain: 0.2 };
    const protocolFile = join(dir, "protocol.json"); writeFileSync(protocolFile, JSON.stringify(p));
    await fn(s, cli, protocolFile, p);
  } finally { s?.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("evaluation-resume CLI executes stored arms and preserves UNKNOWN for missing adapter cost", async () => fixture(async (s, cli, _file, p) => {
  const cfg = s.getMeta<{ worker: PinnedCommand; checker: PinnedCommand }>("commands")!;
  const d = new CommandDriver(cfg.worker, cfg.checker, contract.limits.outputBytes);
  const abort = new AbortController(); abort.abort();
  const pending = await evaluate(s, s.propose({ parallelism: 2 }), p, d, abort.signal);
  const resumed = cli(["evaluation-resume", "--evaluation", pending.id, "--allow-exec"]);
  assert.equal(resumed.status, 2); assert.equal(resumed.json.id, pending.id);
  assert.equal(resumed.json.decision, "UNKNOWN"); assert.equal(resumed.json.pairs.length, 2);
  const count = s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n;
  assert.equal(cli(["evaluation-resume", "--evaluation", pending.id, "--allow-exec"]).status, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, count);
}));

test("evolve CLI bounds work, remembers unmeasurable trials, and reports exhaustion", async () => fixture(async (s, cli, file, p) => {
  const cfg = s.getMeta<{ worker: PinnedCommand; checker: PinnedCommand }>("commands")!;
  const d = new CommandDriver(cfg.worker, cfg.checker, contract.limits.outputBytes);
  for (let i = 0; i < 3; i++) await runTasks(s, p.tasks, d);
  const count = s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n;
  assert.equal(cli(["evolve", "--protocol", file, "--allow-exec", "--max-cycles", "0"]).status, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, count);
  const first = cli(["evolve", "--protocol", file, "--allow-exec", "--max-cycles", "3"]);
  assert.equal(first.status, 2); assert.equal(first.json.stopReason, "unknown-evidence");
  assert.equal(first.json.evaluations.length, 1);
  const second = cli(["evolve", "--protocol", file, "--allow-exec", "--max-cycles", "3"]);
  assert.equal(second.status, 2);
  assert.notEqual(first.json.evaluation.candidateHash, second.json.evaluation.candidateHash);
  const exhausted = cli(["evolve", "--protocol", file, "--allow-exec", "--max-cycles", "3"]);
  assert.equal(exhausted.status, 0); assert.equal(exhausted.json.proposed, false);
  assert.equal(exhausted.json.stopReason, "no-evidence-backed-change");
}));
