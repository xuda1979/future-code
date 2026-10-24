import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { builtinDomainPacks, type DomainPack } from "../../src/harness/foundry/evidenceFabric.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { loadSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

const projectPack = (): DomainPack => ({
  schema: 1, name: "project-evidence-v1", goalKinds: ["task"],
  evidenceKinds: ["independent-verification"], validators: ["pinned-check"],
  adjudicators: ["discriminator"], success: { minimumStrength: 1, requireMachineEvidence: true },
});
const custom = (s: ReturnType<typeof spec>) => { s.domainPack = projectPack(); };

test("Swarm accepts bounded project evidence packs while retaining named presets", () => {
  const s = spec("/tmp/repo"); validateSwarmSpec(s);
  for (const p of builtinDomainPacks()) validateSwarmSpec({ ...s, domainPack: p.name as any });
  assert.throws(() => validateSwarmSpec({ ...s, domainPack: "unknown-project" as any }), /unknown evidence domain pack/);
  validateSwarmSpec({ ...s, domainPack: projectPack() });
  for (const invalid of [null, [], {}, { ...projectPack(), tools: ["grant-authority"] },
    { ...projectPack(), success: { minimumStrength: 1, skipChecks: true } },
    { ...projectPack(), evidenceKinds: ["x", "x"] },
    { ...projectPack(), validators: ["x".repeat(65536)] }])
    assert.throws(() => validateSwarmSpec({ ...s, domainPack: invalid as any }));
});

test("project evidence pack drives real governed tasks and remains pinned across reopen", async () => fixture(async (store, cfg) => {
  const pack = projectPack();
  assert.equal(store.getMeta("extension.evidenceDomain"), pack.name);
  assert.deepEqual(cfg.spec.domainPack, pack);
  const row = store.db.prepare("SELECT hash,json FROM fabric_domain_packs WHERE name=?").get(pack.name)!;
  assert.equal(row.hash, digest(pack)); assert.equal(row.json, canonical(pack));
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(store, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS");
  assert.equal(store.db.prepare("SELECT domain,status FROM fabric_goals WHERE run=? AND id='a'").get(result.id)!.domain, pack.name);
  const reopened = await Store.open(store.root);
  try { assert.deepEqual(loadSwarm(reopened), cfg); }
  finally { reopened.close(); }
}, custom));

test("changes to the caller's original pack do not mutate initialized authority", async () => {
  const original = projectPack();
  await fixture(async (store, cfg) => {
    original.success.minimumStrength = .1;
    original.validators.push("changed");
    assert.deepEqual(cfg.spec.domainPack, projectPack());
    assert.deepEqual(loadSwarm(store).spec.domainPack, projectPack());
  }, s => { s.domainPack = original; });
});

test("changed or missing registered project-pack bytes fail closed", async () => {
  for (const mutate of [
    (store: Store) => store.db.prepare("UPDATE fabric_domain_packs SET json=? WHERE name=?")
      .run(canonical({ ...projectPack(), goalKinds: ["changed"] }), projectPack().name),
    (store: Store) => store.db.prepare("UPDATE fabric_domain_packs SET hash=? WHERE name=?")
      .run("0".repeat(64), projectPack().name),
    (store: Store) => store.db.prepare("DELETE FROM fabric_domain_packs WHERE name=?").run(projectPack().name),
  ]) await fixture(async store => { mutate(store); assert.throws(() => loadSwarm(store), /evidence pack.*drift/); }, custom);
});

test("a project-pack config cannot change the frozen acceptance identity", async () => fixture(async (store, cfg) => {
  const changed = structuredClone(cfg);
  (changed.spec.domainPack as DomainPack).success.minimumStrength = .1;
  store.setMeta("extension.swarm", changed);
  const altered = changed.spec.domainPack as DomainPack;
  store.db.prepare("UPDATE fabric_domain_packs SET json=?,hash=? WHERE name=?")
    .run(canonical(altered), digest(altered), altered.name);
  assert.throws(() => loadSwarm(store), /configuration drift/);
}, custom));

test("legacy preset choices preserve the stored config representation", async () => fixture(async (store, cfg) => {
  assert.equal(cfg.spec.domainPack, undefined);
  assert.equal(store.getMeta("extension.evidenceDomain"), "software-engineering");
  assert.deepEqual(loadSwarm(store), cfg);
  const run = new Scheduler(store).start([task()]);
  assert.equal(store.db.prepare("SELECT domain FROM fabric_goals WHERE run=?").get(run)!.domain, "software-engineering");
}));

test("project evidence preferences cannot bypass independent task checks", async () => fixture(async store => {
  const mock = scripted(Array.from({ length: 20 }, () => () => reply("The task is complete.")));
  const result: any = await runSwarm(store, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL");
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='a'").get(result.id)!.status, "FAIL");
}, s => {
  s.domainPack = { ...projectPack(), success: { minimumStrength: .01, requireMachineEvidence: false } };
}));
