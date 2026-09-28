import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fixture, reclaim, reply, writeReply } from "./replay-fixture.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { HttpBrain } from "../../src/harness/foundry/swarm/model.ts";

async function crashed(response: unknown) {
  const f = await fixture(); const file = join(f.root, "crash.json");
  writeFileSync(file, JSON.stringify({ root: f.store.root, cfg: f.cfg, capsule: f.capsule, response })); f.store.close();
  const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./replay-crash-child.ts", import.meta.url)), file],
    { encoding: "utf8", timeout: 300000 });
  assert.equal(child.status, 73, child.stderr || String(child.error));
  f.store = await Store.open(join(f.root, "store"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_replies").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='model.reply'").get()!.n, 0);
  return f;
}
function state(f: Awaited<ReturnType<typeof fixture>>): any {
  return f.store.readArtifact(f.store.db.prepare("SELECT state FROM agent_threads").get()!.state);
}
for (const previous of ["EXPIRED", "FAIL", "DEFERRED"]) {
  test(`committed final reply survives process death and ${previous} with no new request`, async () => {
    const f = await crashed(reply());
    try {
      const c = reclaim(f.store, f.capsule, previous);
      const old = state(f); old.lastCheckAt = 0; // a due checkpoint must not mutate the old request
      f.store.db.prepare("UPDATE agent_threads SET state=?").run(f.store.artifact(old));
      let calls = 0;
      const driver = new SwarmDriver(f.store, f.cfg, (async () => { calls++; throw new Error("duplicate provider call"); }) as typeof fetch);
      const result: any = await driver.execute(c, AbortSignal.timeout(15000));
      assert.equal(result.artifact.summary, "finished"); assert.equal(calls, 0);
      assert.equal(state(f).turns, 1); assert.equal(driver.journal.usage(c.runId).requests, 1);
      assert.equal(driver.journal.usage(c.runId).knownTokens, 18);
      assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='checkpoint.checked'").get()!.n, 0);
      // A final model reply is not task acceptance.
      assert.equal(f.store.db.prepare("SELECT status FROM tasks").get()!.status, "RUNNING");
    } finally { f.store.close(); f.cleanup(); }
  });
}

test("committed tool call replays once, repairs real worktree, and passes independent verification", async () => {
  const f = await crashed(writeReply());
  try {
    const c = reclaim(f.store, f.capsule); let calls = 0;
    const driver = new SwarmDriver(f.store, f.cfg, (async (_url, init) => {
      calls++; const body = JSON.parse(init!.body as string);
      assert.equal(body.messages.filter((m: any) => m.role === "tool" && m.tool_call_id === "write").length, 1);
      assert.ok(body.messages.some((m: any) => typeof m.content === "string" && m.content.includes("previous episode failed")));
      return Response.json(reply());
    }) as typeof fetch);
    const result = await driver.execute(c, AbortSignal.timeout(15000));
    const verification = await driver.verify(c, result, AbortSignal.timeout(15000));
    assert.ok(verification.checks.length >= 2); assert.ok(verification.checks.every(x => x.verdict === "PASS"));
    assert.equal(calls, 1); assert.equal(driver.journal.usage(c.runId).requests, 2);
    assert.equal(state(f).turns, 2); assert.equal(state(f).toolCalls, 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='tool.result'").get()!.n, 1);
  } finally { f.store.close(); f.cleanup(); }
});

test("replay still rejects a modified request binding and never calls the model", async () => {
  const f = await crashed(reply());
  try {
    const c = reclaim(f.store, f.capsule); const old = state(f); old.history[0].content += " altered task";
    f.store.db.prepare("UPDATE agent_threads SET state=?").run(f.store.artifact(old));
    let calls = 0; const driver = new SwarmDriver(f.store, f.cfg, (async () => { calls++; return Response.json(reply()); }) as typeof fetch);
    await assert.rejects(driver.execute(c, AbortSignal.timeout(15000)), /model replay input drift/); assert.equal(calls, 0);
  } finally { f.store.close(); f.cleanup(); }
});

test("a stale lease cannot consume a cached response", async () => {
  const f = await crashed(reply());
  try {
    reclaim(f.store, f.capsule); let calls = 0;
    const driver = new SwarmDriver(f.store, f.cfg, (async () => { calls++; return Response.json(reply()); }) as typeof fetch);
    await assert.rejects(driver.execute(f.capsule, AbortSignal.timeout(15000)), /stale agent lease/); assert.equal(calls, 0);
  } finally { f.store.close(); f.cleanup(); }
});

test("cached truncated output remains fatal and cannot be converted into completion", async () => {
  const f = await crashed(reply());
  try {
    const c = reclaim(f.store, f.capsule); const raw = reply(); raw.choices[0].finish_reason = "length";
    f.store.db.prepare("UPDATE agent_replies SET response=?").run(f.store.artifact(raw));
    const d = new SwarmDriver(f.store, f.cfg, (async () => { throw new Error("unexpected model call"); }) as typeof fetch);
    await assert.rejects(d.execute(c, AbortSignal.timeout(15000)), /truncated/);
    assert.equal(state(f).output, null);
  } finally { f.store.close(); f.cleanup(); }
});
