import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../src/harness/foundry/store.ts";
import type { Json, Task } from "../../src/harness/foundry/types.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { LocalGitHands, readPatchArtifact, git } from "../../src/harness/foundry/swarm/workspace.ts";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";

async function accepted(store: Store): Promise<string> {
  const api = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("implemented"),
  ]);
  const result = await runSwarm(store, [task()], signal(), undefined, api.fetcher) as { status: string; id: string };
  assert.equal(result.status, "PASS"); assert.equal(api.bodies.length, 2);
  return result.id;
}
function row(store: Store, run: string) {
  return store.db.prepare("SELECT artifact,evidence,spec FROM tasks WHERE run=? AND id='a'").get(run)!;
}
function corrupt(store: Store, hash: string): void {
  writeFileSync(join(store.root, "artifacts", `${hash}.json`), "{}");
}
function substitute(store: Store, run: string): void {
  const artifact = store.readArtifact(row(store, run).artifact) as Record<string, Json>;
  const replacement = store.artifact({ ...artifact, summary: "different artifact; intact content hash" });
  store.db.prepare("UPDATE tasks SET artifact=? WHERE run=? AND id='a'").run(replacement, run);
}

test("evidence reuse: valid accepted artifact and its patch remain readable", async () => fixture(async s => {
  const run = await accepted(s); const artifact = readPatchArtifact(s, run, "a");
  assert.equal(artifact.schema, 1); assert.equal(artifact.summary, "implemented");
  assert.match(s.readArtifact(artifact.patchHash) as string, /\+42/);
}));

test("evidence reuse: content-valid replacement cannot reuse another artifact's acceptance", async () => fixture(async s => {
  const run = await accepted(s); substitute(s, run);
  assert.throws(() => readPatchArtifact(s, run, "a"), /evidence|binding|integrity/);
}));

test("evidence reuse: PASS without a proof fails closed", async () => fixture(async s => {
  const run = await accepted(s);
  s.db.prepare("UPDATE tasks SET evidence=NULL WHERE run=? AND id='a'").run(run);
  assert.throws(() => readPatchArtifact(s, run, "a"), /evidence/);
}));

test("evidence reuse: changed task specification invalidates the old proof", async () => fixture(async s => {
  const run = await accepted(s); const spec: Task = JSON.parse(row(s, run).spec);
  s.db.prepare("UPDATE tasks SET spec=? WHERE run=? AND id='a'").run(JSON.stringify({ ...spec, goal: "changed requirement" }), run);
  assert.throws(() => readPatchArtifact(s, run, "a"), /evidence|binding/);
}));

test("evidence reuse: run contract drift is not accepted", async () => fixture(async s => {
  const run = await accepted(s);
  s.db.prepare("UPDATE runs SET contract=? WHERE id=?").run("0".repeat(64), run);
  assert.throws(() => readPatchArtifact(s, run, "a"), /contract/);
}));

test("evidence reuse: missing required check invalidates even a content-valid proof", async () => fixture(async s => {
  const run = await accepted(s);
  const evidence = s.readArtifact(row(s, run).evidence) as Record<string, Json>;
  const verification = evidence.verification as Record<string, Json>;
  const replacement = s.artifact({ ...evidence, verification: { ...verification, checks: [] } });
  s.db.prepare("UPDATE tasks SET evidence=? WHERE run=? AND id='a'").run(replacement, run);
  assert.throws(() => readPatchArtifact(s, run, "a"), /evidence/);
}));

test("evidence reuse: corrupt referenced patch is rejected, not only the wrapper", async () => fixture(async s => {
  const run = await accepted(s); const artifact = readPatchArtifact(s, run, "a");
  corrupt(s, artifact.patchHash);
  assert.throws(() => readPatchArtifact(s, run, "a"), /integrity/);
}));

test("evidence reuse: cached integration revalidates task evidence", async () => fixture(async s => {
  const run = await accepted(s); await integrateSwarm(s, run, signal());
  corrupt(s, row(s, run).evidence);
  await assert.rejects(integrateSwarm(s, run, signal()), /integrity/);
}));

test("evidence reuse: cached integration revalidates referenced patch bytes", async () => fixture(async s => {
  const run = await accepted(s); const artifact = readPatchArtifact(s, run, "a");
  await integrateSwarm(s, run, signal()); corrupt(s, artifact.patchHash);
  await assert.rejects(integrateSwarm(s, run, signal()), /integrity/);
}));

test("evidence reuse: invalid artifact cannot be integrated or publish a branch", async () => fixture(async (s, cfg) => {
  const run = await accepted(s); substitute(s, run);
  await assert.rejects(integrateSwarm(s, run, signal()), /evidence|binding|integrity/);
  assert.equal((await git(cfg, cfg.spec.project, ["for-each-ref", "--format=%(refname)", `refs/heads/swarm/${run}`], signal())).trim(), "");
}));

test("evidence reuse: dependent worktree refuses corrupt parent proof", async () => fixture(async (s, cfg) => {
  const run = await accepted(s); corrupt(s, row(s, run).evidence);
  const q = new Scheduler(s); const other = q.start([task("b")]); const capsule = q.capsule(q.claim(other, "test")!);
  capsule.runId = run;
  const hands = new LocalGitHands(s, cfg, capsule, cfg.spec.agents.coder, signal(), null, ["a"]);
  try { await assert.rejects(hands.ready(), /integrity/); }
  finally { await hands.dispose(); }
}));

test("evidence reuse: unchanged cached integration does not rerun expensive checks", async () => fixture(async s => {
  const run = await accepted(s); const first = await integrateSwarm(s, run, signal());
  const original = LocalGitHands.prototype.check;
  LocalGitHands.prototype.check = async () => { throw new Error("cached result must not rerun a check"); };
  try { assert.deepEqual(await integrateSwarm(s, run, signal()), first); }
  finally { LocalGitHands.prototype.check = original; }
}));
