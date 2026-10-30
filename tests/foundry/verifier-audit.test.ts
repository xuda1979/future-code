import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { LocalGitHands, verifyPatch } from "../../src/harness/foundry/swarm/workspace.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { integrateSwarm, loadSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, spec, task, signal, scripted, reply } from "./swarm-fixtures.ts";

const strong = "if(require('node:fs').readFileSync('src/a.txt','utf8').trim()!=='42')process.exit(7)";
function configure(s: SwarmSpec, code = strong) {
  s.checks.behavior = { argv: [process.execPath, "-e", code], replaySafe: true, parallelSafe: true,
    negativeControls: [{ id: "broken-value", expectedExitCode: 7, edits: [{ path: "src/a.txt", content: "-1\n" }] }] };
}
async function verify(s: any, cfg: any) {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "audit")!);
  const hands = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  try {
    await hands.tool({ id: "edit", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } });
    const artifact = { schema: 1, patchHash: await hands.snapshot(), summary: "candidate" };
    const result = await verifyPatch(s, cfg, c, artifact, signal());
    const behavior = result.checks.find(c => c.id === "behavior")!;
    return { verdict: behavior.verdict, reports: s.readArtifact(behavior.detail!) as any[] };
  } finally { await hands.dispose(); }
}
const worktrees = (project: string) => execFileSync("git", ["-C", project, "worktree", "list", "--porcelain"],
  { encoding: "utf8" }).split("\n").filter(s => s.startsWith("worktree "));

test("a strong verifier passes the candidate and rejects every pinned mutant in private worktrees", async () => fixture(async (s, cfg, project) => {
  const { verdict, reports } = await verify(s, cfg), report = reports[0];
  assert.equal(verdict, "PASS"); assert.equal(report.verifierAudit.verdict, "PASS");
  assert.equal(report.verifierAudit.required, 2);
  assert.deepEqual(report.verifierAudit.controls.map((c: any) => c.report.code), [7, 7]);
  assert.ok(report.verifierAudit.controls.every((c: any) => c.report.sourceUnchanged && c.report.tree !== report.tree));
  assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n"); assert.equal(worktrees(project).length, 1);
}, s => {
  configure(s); s.checks.behavior.negativeControls!.push({ id: "other-broken-value", expectedExitCode: 7,
    edits: [{ path: "src/a.txt", content: "0\n" }] });
}));

test("a tautological verifier cannot earn acceptance by returning zero for a broken candidate", async () => fixture(async (s, cfg) => {
  const { verdict, reports } = await verify(s, cfg);
  assert.equal(verdict, "FAIL"); assert.equal(reports[0].code, 0);
  assert.equal(reports[0].verifierAudit.verdict, "FAIL"); assert.equal(reports[0].verifierAudit.controls[0].report.code, 0);
}, s => configure(s, "process.exit(0)")));

test("an unrelated error exit and a no-op control are inconclusive audit failures", async () => {
  for (const noop of [false, true]) await fixture(async (s, cfg) => {
    const { verdict, reports } = await verify(s, cfg); assert.equal(verdict, "FAIL");
    const control = reports[0].verifierAudit.controls[0].report;
    if (noop) assert.match(control.error, /did not mutate/); else assert.equal(control.code, 9);
  }, s => {
    configure(s, strong.replace("exit(7)", "exit(9)"));
    if (noop) s.checks.behavior.negativeControls![0].edits[0].content = "42\n";
  });
});

test("a verifier that repairs the broken control cannot certify its own audit", async () => fixture(async (s, cfg) => {
  const { verdict, reports } = await verify(s, cfg); assert.equal(verdict, "FAIL");
  assert.match(reports[0].verifierAudit.controls[0].report.error, /mutated tracked source/);
}, s => configure(s, "const fs=require('node:fs');if(fs.readFileSync('src/a.txt','utf8').trim()!=='42'){fs.writeFileSync('src/a.txt','42\\n');process.exit(7)}")));

test("control timeout is a failure with cleanup, never a successful rejection", async () => fixture(async (s, cfg, project) => {
  const { verdict, reports } = await verify(s, cfg); assert.equal(verdict, "FAIL");
  const control = reports[0].verifierAudit.controls[0].report;
  assert.equal(control.code, null); assert.match(control.error, /deadline/); assert.equal(worktrees(project).length, 1);
}, s => configure(s, "if(require('node:fs').readFileSync('src/a.txt','utf8').trim()!=='42')setTimeout(()=>{},30000)")));

test("task acceptance and final integration independently rebuild their verifier audits", async () => fixture(async (s, cfg) => {
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply()]);
  const run: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher); assert.equal(run.status, "PASS");
  const integrated = await integrateSwarm(s, run.id, signal()), reports: any = s.readArtifact(integrated.checksHash);
  assert.equal(reports[0].verifierAudit.verdict, "PASS"); assert.equal(reports[0].verifierAudit.controls[0].report.code, 7);
  cfg.spec.checks.behavior.negativeControls![0].edits[0].content = "changed";
  s.transaction(() => s.setMeta("extension.swarm", cfg)); assert.throws(() => loadSwarm(s), /configuration drift/);
}, s => configure(s)));

test("audit configuration rejects protected paths, malformed exits, duplicate controls and excessive payloads", () => {
  const s = spec("/tmp/repo"); configure(s); validateSwarmSpec(s);
  for (const change of [
    (v: SwarmSpec) => { v.checks.behavior.parallelSafe = false; },
    (v: SwarmSpec) => { v.checks.behavior.negativeControls![0].edits[0].path = "checks/oracle.js"; },
    (v: SwarmSpec) => { v.checks.behavior.negativeControls![0].edits[0].path = "../outside"; },
    (v: SwarmSpec) => { v.checks.behavior.negativeControls![0].expectedExitCode = 0; },
    (v: SwarmSpec) => { v.checks.behavior.negativeControls!.push(v.checks.behavior.negativeControls![0]); },
    (v: SwarmSpec) => { v.checks.behavior.negativeControls![0].edits[0].content = "x".repeat(65537); },
  ]) { const bad = structuredClone(s); change(bad); assert.throws(() => validateSwarmSpec(bad)); }
});

test("pinning cannot silently turn a negative control into a mutation of the verifier", async () => {
  await assert.rejects(fixture(async () => assert.fail("must reject at initialization"), s => {
    configure(s); s.checks.behavior.files = ["src/a.txt"];
  }), /protected path/);
});
