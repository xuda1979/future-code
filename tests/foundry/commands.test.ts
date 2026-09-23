import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandDriver, invoke, pinCommand } from "../../src/harness/foundry/commands.ts";
import type { Capsule, PinnedCommand } from "../../src/harness/foundry/types.ts";
import { task } from "./fixtures.ts";
async function fixture(code: string, fn: (command: PinnedCommand, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "foundry-command-")); const file = join(dir, "worker.mjs"); writeFileSync(file, code);
  try { await fn(pinCommand({ argv: [process.execPath, file] }, dir), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
test("command adapter passes JSON in a private cwd without ambient secrets", async () => fixture(`
  import { readFileSync } from 'node:fs';
  console.log(JSON.stringify({ value: JSON.parse(readFileSync(0,'utf8')), secret: process.env.FOUNDRY_TEST_SECRET !== undefined, cwd: process.cwd() }));`, async (c, dir) => {
  const previous = process.env.FOUNDRY_TEST_SECRET; process.env.FOUNDRY_TEST_SECRET = "test-only";
  try {
    const result = await invoke(c, { goal: "literal ; $(no shell)" }, 4096, AbortSignal.timeout(2000)) as any;
    assert.deepEqual(result.value, { goal: "literal ; $(no shell)" }); assert.equal(result.secret, false); assert.notEqual(result.cwd, dir);
    assert.equal(existsSync(result.cwd), false);
  } finally { if (previous === undefined) delete process.env.FOUNDRY_TEST_SECRET; else process.env.FOUNDRY_TEST_SECRET = previous; }
}));
test("exit zero with empty stdout is not an acceptance result", async () => fixture("process.exit(0);", async c => {
  await assert.rejects(invoke(c, {}, 4096, AbortSignal.timeout(2000)), /JSON/);
}));
test("nonzero exit is rejected even if stdout claims PASS", async () => fixture(`console.log('{"verdict":"PASS"}'); process.exit(3);`, async c => {
  await assert.rejects(invoke(c, {}, 4096, AbortSignal.timeout(2000)), /exit 3/);
}));
test("stdout and stderr share a bounded byte budget", async () => fixture(`process.stdout.write('x'.repeat(50000));`, async c => {
  await assert.rejects(invoke(c, {}, 1024, AbortSignal.timeout(2000)), /byte budget/);
}));
test("cancellation terminates a hanging process", async () => fixture(`setInterval(() => {}, 1000);`, async c => {
  const t = Date.now(); await assert.rejects(invoke(c, {}, 4096, AbortSignal.timeout(100)), /cancelled/); assert.ok(Date.now() - t < 2000);
}));
test("POSIX cancellation kills descendants, not just their parent", { skip: process.platform === "win32" }, async () => fixture(`
  import { readFileSync, writeFileSync } from 'node:fs';
  import { spawn } from 'node:child_process';
  const { ready, marker } = JSON.parse(readFileSync(0,'utf8'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync('+JSON.stringify(marker)+', "escaped"), 400)'], {stdio:'ignore'});
  child.on('spawn', () => writeFileSync(ready, 'ready'));
  setInterval(() => {}, 1000);`, async (c, dir) => {
  const ready = join(dir, "ready"); const marker = join(dir, "escaped"); const abort = new AbortController();
  const outcome = invoke(c, { ready, marker }, 4096, abort.signal).then(() => null, e => e);
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 10));
  const started = existsSync(ready); abort.abort(); const error = await outcome;
  assert.equal(started, true, "descendant must have actually been spawned"); assert.ok(error);
  await new Promise(r => setTimeout(r, 550)); assert.equal(existsSync(marker), false);
}));
test("changed pinned source is detected even after a cached successful call", async () => fixture("console.log('{}')", async (c, dir) => {
  await invoke(c, {}, 4096, AbortSignal.timeout(2000));
  writeFileSync(join(dir, "worker.mjs"), "console.log('{\"tampered\":true}')");
  await assert.rejects(invoke(c, {}, 4096, AbortSignal.timeout(2000)), /implementation changed/);
}));
test("a child cannot fabricate provider token or dollar measurements", async () => fixture(`console.log(JSON.stringify({ artifact: {answer:4}, measurement: {tokens:0,costUsd:0} }));`, async c => {
  const d = new CommandDriver(c, c, 4096);
  const capsule: Capsule = { schema: 1, runId: "r", task: task(), fence: 1, contractHash: "c", recipeHash: "p", dependencies: [] };
  const result = await d.execute(capsule, AbortSignal.timeout(2000)); assert.equal(result.measurement!.tokens, null); assert.equal(result.measurement!.costUsd, null);
}));
test("non-JSON input is rejected before creating an execution process", async () => fixture("console.log('{}')", async c => {
  await assert.rejects(invoke(c, undefined, 4096, AbortSignal.timeout(2000)), /JSON/);
}));
test("loader injection is not an allowed environment capability", async () => fixture("console.log('{}')", async (c, dir) => {
  assert.throws(() => pinCommand({ argv: c.argv, envAllow: ["NODE_OPTIONS"] }, dir), /unsafe loader/);
  assert.throws(() => pinCommand({ argv: ["node", "x.mjs"] }, dir), /absolute executable/);
}));
