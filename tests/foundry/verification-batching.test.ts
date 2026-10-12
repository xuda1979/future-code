import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { LocalGitHands, verifyPatch } from "../../src/harness/foundry/swarm/workspace.ts";
import { loadSwarm, runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { boundedChecks } from "../../src/harness/foundry/swarm/verification.ts";
import type { Store } from "../../src/harness/foundry/store.ts";
import type { PinnedSwarm } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, spec, task, signal, scripted, reply } from "./swarm-fixtures.ts";

const command = (code: string, parallelSafe = true) => ({ argv: [process.execPath, "-e", code], replaySafe: true, parallelSafe });
const behavior = "const fs=require('node:fs');if(fs.readFileSync('src/a.txt','utf8')!=='42\\n')process.exit(1);";
function configure(s: SwarmSpec, checks: SwarmSpec["checks"], width = 2) {
  s.verification = { parallelism: width }; s.checks = checks;
  s.agents.coder.checks = Object.keys(checks); s.integrationChecks = Object.keys(checks);
}
function ignoreOutput(s: SwarmSpec) {
  writeFileSync(join(s.project, ".gitignore"), ".verify-output\n");
  execFileSync("git", ["-C", s.project, "add", ".gitignore"]);
  execFileSync("git", ["-C", s.project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "ignore check output"]);
}
async function candidate(s: Store, cfg: PinnedSwarm) {
  const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "fixture")!, c = q.capsule(lease);
  const hands = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  try {
    await hands.tool({ id: "edit", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } });
    return { c, artifact: { schema: 1, patchHash: await hands.snapshot(), summary: "fixture" } };
  } finally { await hands.dispose(); }
}
function worktrees(project: string) {
  return execFileSync("git", ["-C", project, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").filter(l => l.startsWith("worktree "));
}
function details(s: Store, result: Awaited<ReturnType<typeof verifyPatch>>) {
  return s.readArtifact(result.checks.find(c => c.id === "behavior")!.detail!) as any[];
}

test("verification concurrency is explicit, bounded, typed and pinned", async () => {
  const s = spec("/tmp/repo"); configure(s, { behavior: command(behavior) }); validateSwarmSpec(s);
  for (const parallelism of [0, 9, 1.5, NaN, "2"]) assert.throws(() => validateSwarmSpec({ ...s, verification: { parallelism } } as any));
  assert.throws(() => validateSwarmSpec({ ...s, verification: { parallelism: 2, trustCertificates: true } } as any), /unexpected/);
  assert.throws(() => validateSwarmSpec({ ...s, checks: { behavior: { ...s.checks.behavior, parallelSafe: "yes" } } } as any), /parallelSafe/);
  await fixture(async store => {
    const cfg = store.getMeta<PinnedSwarm>("extension.swarm")!; cfg.spec.verification!.parallelism = 3;
    store.transaction(() => store.setMeta("extension.swarm", cfg as any));
    assert.throws(() => loadSwarm(store), /configuration drift/);
  }, cfg => configure(cfg, { behavior: command(behavior) }));
});

test("independent checks overlap within the cap, see the exact candidate, and have private build outputs", async () => fixture(async (s, cfg, project) => {
  const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
  assert.ok(result.checks.every(c => c.verdict === "PASS")); const reports = details(s, result);
  assert.deepEqual(reports.map(r => r.name), ["c0", "c1", "c2", "c3", "c4"]);
  assert.equal(new Set(reports.map(r => JSON.parse(r.stdout).cwd)).size, 5);
  assert.equal(new Set(reports.map(r => r.tree)).size, 1);
  assert.ok(reports.every(r => r.isolation === "worktree" && r.sourceUnchanged === true && r.elapsedMs >= 0));
  const events = readFileSync(join(project, "..", "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  let active = 0, peak = 0; for (const e of events) { active += e.event === "start" ? 1 : -1; peak = Math.max(peak, active); }
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n"); assert.equal(worktrees(project).length, 1);
}, s => {
  ignoreOutput(s); const trace = join(s.project, "..", "trace.jsonl"), checks: SwarmSpec["checks"] = {};
  for (let i = 0; i < 5; i++) {
    const name = `c${i}`, peer = `c${i % 2 ? i - 1 : i + 1}`;
    checks[name] = command(behavior + `
      const name=${JSON.stringify(name)}, trace=${JSON.stringify(trace)}, peer=${JSON.stringify(peer)};
      fs.writeFileSync('.verify-output',name);
      fs.appendFileSync(trace,JSON.stringify({event:'start',name})+'\\n');
      const timer=setInterval(()=>{
        const events=fs.readFileSync(trace,'utf8').trim().split('\\n').map(JSON.parse);
        if(name==='c4'||events.some(e=>e.event==='start'&&e.name===peer)){
          clearInterval(timer);setTimeout(()=>{
            if(fs.readFileSync('.verify-output','utf8')!==name)process.exit(2);
            fs.appendFileSync(trace,JSON.stringify({event:'end',name})+'\\n');
            console.log(JSON.stringify({cwd:process.cwd(),name}));
          },20);
        }
      },5);`);
  }
  configure(s, checks);
}));

test("unmarked checks retain the serial workspace and preserve generated prerequisites", async () => fixture(async (s, cfg, project) => {
  const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
  assert.ok(result.checks.every(c => c.verdict === "PASS")); const reports = details(s, result);
  assert.equal(reports[0].stdout, reports[1].stdout); assert.equal(worktrees(project).length, 1);
}, s => {
  ignoreOutput(s); configure(s, {
    build: command(behavior + "fs.writeFileSync('.verify-output','compiled');console.log(process.cwd());", false),
    useBuild: command(behavior + "if(fs.readFileSync('.verify-output','utf8')!=='compiled')process.exit(2);console.log(process.cwd());", false),
  });
}));

test("independence flags alone and a one-slot policy keep the original serial path", async () => {
  for (const width of [undefined, 1]) await fixture(async (s, cfg) => {
    const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
    assert.ok(result.checks.every(c => c.verdict === "PASS"));
    const reports = details(s, result); assert.equal(reports[0].stdout, reports[1].stdout); assert.ok(reports.every(r => !r.isolation));
  }, s => {
    ignoreOutput(s); configure(s, {
      first: command(behavior + "fs.writeFileSync('.verify-output','shared');console.log(process.cwd());"),
      second: command(behavior + "if(!fs.existsSync('.verify-output'))process.exit(2);console.log(process.cwd());"),
    }, width ?? 1); if (width === undefined) delete s.verification;
  });
});

test("a serial check remains an ordering barrier between independent groups", async () => fixture(async (s, cfg) => {
  const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
  assert.ok(result.checks.every(c => c.verdict === "PASS"));
  assert.deepEqual(details(s, result).map(r => r.name), ["left1", "left2", "barrier", "right1", "right2"]);
}, s => {
  const marker = join(s.project, "..", "barrier"); configure(s, {
    left1: command(behavior + `if(fs.existsSync(${JSON.stringify(marker)}))process.exit(2);`),
    left2: command(behavior + `if(fs.existsSync(${JSON.stringify(marker)}))process.exit(2);`),
    barrier: command(behavior + `fs.writeFileSync(${JSON.stringify(marker)},'done');`, false),
    right1: command(behavior + `if(!fs.existsSync(${JSON.stringify(marker)}))process.exit(2);`),
    right2: command(behavior + `if(!fs.existsSync(${JSON.stringify(marker)}))process.exit(2);`),
  });
}));

test("source mutation in a private verifier cannot certify PASS or contaminate a sibling", async () => fixture(async (s, cfg, project) => {
  const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
  assert.equal(result.checks.find(c => c.id === "behavior")!.verdict, "FAIL"); const reports = details(s, result);
  assert.match(reports[0].error, /mutated tracked source/); assert.equal(reports[0].sourceUnchanged, false);
  assert.equal(reports[1].code, 0); assert.equal(reports[1].sourceUnchanged, true);
  assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n"); assert.equal(worktrees(project).length, 1);
}, s => configure(s, {
  mutate: command(behavior + "fs.writeFileSync('src/a.txt','broken');"),
  independent: command(behavior),
})));

test("timeouts retain every named check result, drain workers, and fail acceptance", async () => fixture(async (s, cfg, project) => {
  const { c, artifact } = await candidate(s, cfg), result = await verifyPatch(s, cfg, c, artifact, signal());
  assert.equal(result.checks.find(c => c.id === "behavior")!.verdict, "FAIL"); const reports = details(s, result);
  assert.deepEqual(reports.map(r => r.name), ["timeout", "pass", "fail"]);
  assert.equal(reports[0].code, null); assert.match(reports[0].error, /deadline/);
  assert.equal(reports[1].code, 0); assert.equal(reports[2].code, 7); assert.equal(worktrees(project).length, 1);
}, s => {
  configure(s, { timeout: command("setTimeout(()=>{},10000)"), pass: command(behavior), fail: command("process.exit(7)") });
  s.budget.toolTimeoutMs = 2000;
}));

test("cancellation kills all launched checks before disposing their worktrees", async () => fixture(async (s, cfg, project) => {
  const { c, artifact } = await candidate(s, cfg), controller = new AbortController(), marker = join(project, "..", "pids");
  const poll = setInterval(() => {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim().split("\n").length === 2) controller.abort();
  }, 5);
  const deadline = setTimeout(() => controller.abort(), 10000);
  try { await assert.rejects(verifyPatch(s, cfg, c, artifact, controller.signal)); }
  finally { clearInterval(poll); clearTimeout(deadline); }
  const pids = readFileSync(marker, "utf8").trim().split("\n").map(Number); assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), (e: any) => e.code === "ESRCH");
  assert.equal(worktrees(project).length, 1);
}, s => {
  const code = `require('node:fs').appendFileSync(${JSON.stringify(join(s.project, "..", "pids"))},process.pid+'\\n');setTimeout(()=>{},20000);`;
  configure(s, { one: command(code), two: command(code) });
}));

test("integration independently checks the combined tree in private workers and caches only accepted evidence", async () => fixture(async (s, cfg, project) => {
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/b.txt", content: "42\n" } }]), () => reply(),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply(),
  ]);
  const run: any = await runSwarm(s, [{ ...task("b"), agent: "producer" }, task("a", ["b"])], signal(), undefined, mock.fetcher);
  assert.equal(run.status, "PASS"); assert.equal(run.accepted, 2);
  const integrated = await integrateSwarm(s, run.id, signal()), reports = s.readArtifact(integrated.checksHash) as any[];
  assert.deepEqual(reports.map(r => r.name), ["one", "two"]); assert.ok(reports.every(r => r.tree === integrated.tree && r.sourceUnchanged));
  const trace = readFileSync(join(project, "..", "integrations"), "utf8"); assert.equal(trace.trim().split("\n").length, 4);
  assert.equal((await integrateSwarm(s, run.id, signal())).commit, integrated.commit);
  assert.equal(readFileSync(join(project, "..", "integrations"), "utf8"), trace); assert.equal(worktrees(project).length, 1);
}, s => {
  const code = behavior + `if(fs.readFileSync('src/b.txt','utf8')!=='42\\n')process.exit(2);
    fs.appendFileSync(${JSON.stringify(join(s.project, "..", "integrations"))},process.cwd()+'\\n');`;
  configure(s, { one: command(code), two: command(code) });
  s.checks.produce = command("if(require('node:fs').readFileSync('src/b.txt','utf8')!=='42\\n')process.exit(1)", false);
  s.agents.producer = { ...s.agents.coder, checks: ["produce"] };
}));

test("failed integration drains its group, skips later checks and publishes no acceptance receipt or branch", async () => fixture(async (s, cfg, project) => {
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply()]);
  const run: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher); assert.equal(run.status, "PASS");
  await assert.rejects(integrateSwarm(s, run.id, signal()), /integration check failed: fail/);
  assert.equal(s.getMeta(`extension.swarm.integration.${run.id}`), undefined);
  assert.ok(!existsSync(join(project, "..", "later"))); assert.equal(worktrees(project).length, 1);
  assert.equal(execFileSync("git", ["-C", project, "for-each-ref", "--format=%(refname)", "refs/heads/swarm"], { encoding: "utf8" }), "");
}, s => {
  configure(s, {
    behavior: command(behavior, false), fail: command("process.exit(9)"),
    sibling: command(behavior + "setTimeout(()=>{},50)"),
    later: command(behavior + `fs.writeFileSync(${JSON.stringify(join(s.project, "..", "later"))},'should not run');`, false),
  }); s.agents.coder.checks = ["behavior"]; s.integrationChecks = ["fail", "sibling", "later"];
}));

test("admitted check names remain in the immutable task prompt through context retirement", async () => fixture(async s => {
  let mandatory: string;
  const mock = scripted([
    body => {
      mandatory = body.messages[1].content;
      assert.deepEqual(JSON.parse(mandatory).verification, { checks: ["one", "two"], finalIntegrationRequired: true });
      return reply("", [{ id: "setup", name: "write_file", arguments: { path: "src/a.txt", content: "x".repeat(1900) } }]);
    },
    () => reply("", Array.from({ length: 16 }, (_, i) => ({ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }))),
    body => {
      assert.equal(body.messages[1].content, mandatory);
      assert.ok(body.messages.some((m: any) => m.role === "tool" && JSON.parse(m.content).retired === true));
      return reply("", [{ id: "fix", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply(),
  ]);
  const run: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(run.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks WHERE run=?").all(run.id)));
}, s => { configure(s, { one: command(behavior, false), two: command(behavior, false) }); }));

test("integration stops queued checks after a failure and drains a launched sibling", async () => {
  const started: string[] = [], ended: string[] = [];
  const reports = await boundedChecks(["fail", "sibling", "queued1", "queued2"], 2, signal(), async name => {
    started.push(name);
    if (name === "sibling") await new Promise(resolve => setTimeout(resolve, 20));
    ended.push(name); return { name, code: name === "fail" ? 1 : 0, stdout: "", stderr: "" };
  }, true);
  assert.deepEqual(started, ["fail", "sibling"]); assert.deepEqual(ended, started);
  assert.deepEqual(reports.map(r => r.name), started);
});

test("a host worker exception prevents further admission while launched workers drain", async () => {
  const started: string[] = []; let drained = false;
  await assert.rejects(boundedChecks(["error", "sibling", "queued"], 2, signal(), async name => {
    started.push(name);
    if (name === "error") throw new Error("host failure");
    await new Promise(resolve => setTimeout(resolve, 20)); drained = true;
    return { name, code: 0, stdout: "", stderr: "" };
  }, true), /host failure/);
  assert.deepEqual(started, ["error", "sibling"]); assert.ok(drained);
});
