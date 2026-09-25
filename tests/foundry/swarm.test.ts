import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest, canonical } from "../../src/harness/foundry/kernel.ts";
import { FatalAttemptError } from "../../src/harness/foundry/errors.ts";
import { validateSwarmSpec, validateSwarmTasks, safePath } from "../../src/harness/foundry/swarm/config.ts";
import { compactHistory, inlineReceipt, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { decodeTurn, requestBody, HttpBrain } from "../../src/harness/foundry/swarm/model.ts";
import { SessionJournal, type ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import { LocalGitHands, verifyPatch } from "../../src/harness/foundry/swarm/workspace.ts";
import { runSwarm, loadSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { handleSwarm, tokenize } from "../../src/harness/foundry/swarm/cli.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { fixture, spec, task, signal, scripted, reply } from "./swarm-fixtures.ts";
const initial = (): ThreadState => ({ history: [{ role: "user", content: "task" }], turns: 0, toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null });
function lease(store: Store, id = "a") { const q = new Scheduler(store); const run = q.start([task(id)]); const l = q.claim(run, "test")!; return { q, run, l, c: q.capsule(l) }; }

test("schema accepts a bounded pinned plan and rejects unknown authorities", () => {
  const s = spec("/tmp/repo"); validateSwarmSpec(s);
  assert.throws(() => validateSwarmSpec({ ...s, skipChecks: true } as any), /unexpected/);
  assert.throws(() => validateSwarmSpec({ ...s, agents: {} }), /roster/);
  assert.throws(() => validateSwarmSpec({ ...s, budget: { ...s.budget, maxRequests: 0 } }), /maxRequests/);
  assert.throws(() => validateSwarmSpec({ ...s, checks: { behavior: { ...s.checks.behavior, replaySafe: false } } }), /replay-safe/);
});
test("HTTP credentials in URL and accidental plaintext internet endpoints are rejected", () => {
  for (const url of ["http://example.com/v1", "https://u:p@example.com/v1", "https://example.com/v1?key=secret"]) {
    const s = spec("x"); s.agents.coder.url = url; assert.throws(() => validateSwarmSpec(s));
  }
});
test("scope traversal and undeclared roles are rejected", () => {
  for (const p of ["../src", "/etc", "src/../x", "src/.git/x", "src\\x", "x\0y"]) assert.throws(() => safePath(p));
  const s = spec("x"); assert.throws(() => validateSwarmTasks(s, [{ ...task(), agent: "administrator" }]));
  assert.throws(() => validateSwarmTasks(s, [{ ...task(), writeScope: ["checks/x"] }]));
});
test("mandatory context is never silently truncated", () => {
  assert.throws(() => compactHistory([{ role: "user", content: "x".repeat(1000) }], 100), /CONTEXT/);
});
test("compaction retains complete assistant/tool exchanges, not orphan results", () => {
  const h: Message[] = [{ role: "user", content: "immutable acceptance" },
    { role: "assistant", content: "old".repeat(1000), calls: [{ id: "one", name: "read_file", arguments: { path: "x" } }] },
    { role: "tool", callId: "one", content: "old".repeat(1000) },
    { role: "assistant", content: "recent", calls: [{ id: "two", name: "read_file", arguments: { path: "y" } }] },
    { role: "tool", callId: "two", content: "recent output" }];
  const p = compactHistory(h, 1000); assert.equal(p[0], h[0]); assert.ok(p.some(x => x.callId === "two")); assert.ok(!p.some(x => x.callId === "one"));
});
test("receipt preview labels truncation and keeps retrieval hash", () => {
  const v = JSON.parse(inlineReceipt("abc", { long: "x".repeat(5000) }, 512)); assert.equal(v.receipt, "abc"); assert.equal(v.truncated, true);
});
test("usage comes from provider metadata, never generated JSON", () => {
  assert.equal(decodeTurn("chat-completions", { choices: [{ finish_reason: "stop", message: { content: '{"tokens":0}' } }] }).tokens, null);
  assert.throws(() => decodeTurn("chat-completions", { choices: [{ finish_reason: "stop", message: { content: "done" } }], usage: { prompt_tokens: -1, completion_tokens: 2 } }), /usage/);
  assert.equal(decodeTurn("anthropic", { content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } }).tokens, 17);
});
test("malformed and duplicate tool calls cannot enter the loop", () => {
  assert.throws(() => decodeTurn("anthropic", { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "a", input: {} }, { type: "tool_use", id: "x", name: "a", input: {} }] }), /duplicate/);
  assert.throws(() => decodeTurn("chat-completions", { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }), /finish/);
});
test("both provider wire formats preserve tool IDs and paired results", () => {
  const s = spec("x"); const h: Message[] = [{ role: "user", content: "task" }, { role: "assistant", content: "", calls: [{ id: "a", name: "list_files", arguments: {} }] }, { role: "tool", callId: "a", content: "[]" }];
  const chat: any = requestBody(s.agents.coder, h, s.budget); assert.equal(chat.messages[3].tool_call_id, "a");
  const ant: any = requestBody({ ...s.agents.coder, protocol: "anthropic", promptCache: true }, h, s.budget);
  assert.equal(ant.messages[2].content[0].tool_use_id, "a"); assert.equal(ant.system[0].cache_control.type, "ephemeral");
});
test("CLI flags and quoted paths are parsed without shell evaluation", async () => {
  assert.deepEqual(tokenize('run --tasks "a b.json" --root "$HOME/x"'), ["run", "--tasks", "a b.json", "--root", "$HOME/x"]);
  assert.throws(() => tokenize("run 'open"), /quote/);
  await assert.rejects(handleSwarm(["run", "--tasks", "x"]), /allow-exec/);
  await assert.rejects(handleSwarm(["status", "--mystery"]), /unknown/);
});

test("thread checkpoints persist across handles; events cannot be rewritten", async () => fixture(async (s) => {
  const { c } = lease(s); const j = new SessionJournal(s); const t = j.open(c, initial());
  t.state.turns = 1; j.checkpoint(t, "test", { progress: 1 });
  const other = await Store.open(s.root);
  try { const restored = new SessionJournal(other).open(c, initial()); assert.equal(restored.seq, 1); assert.equal(restored.state.turns, 1); }
  finally { other.close(); }
  assert.throws(() => s.db.exec("UPDATE agent_events SET kind='fake'"), /append-only/);
  assert.throws(() => s.db.exec("DELETE FROM agent_events"), /append-only/);
}));
test("stale fences cannot append a checkpoint or access a new model request", async () => fixture(async s => {
  const { c, q, l, run } = lease(s); const j = new SessionJournal(s); const t = j.open(c, initial());
  q.fail(l, "retry"); q.claim(run, "replacement");
  assert.throws(() => j.checkpoint(t, "late", {}), /stale/);
}));
test("receipts are scoped to their thread and detect artifact tampering", async () => fixture(async s => {
  const one = lease(s, "a"); const two = lease(s, "b"); const j = new SessionJournal(s);
  const hash = j.receipt(one.c, { secret: "a only" });
  assert.throws(() => j.recall(two.c, hash), /not owned/);
  assert.match(canonical(j.recall(one.c, hash)), /a only/);
  writeFileSync(join(s.root, "artifacts", `${hash}.json`), '{"corrupted":true}');
  assert.throws(() => j.recall(one.c, hash), /integrity/);
}));
test("run request budgets are transactional across SQLite handles and survive resume", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s); const b = { ...cfg.spec.budget, maxRequests: 1 };
  const id = await j.reserve(c, "provider", { task: 1 }, b, signal()); j.complete(id, null, null);
  const other = await Store.open(s.root);
  try { const j2 = new SessionJournal(other); await assert.rejects(j2.reserve(c, "provider", { task: 2 }, b, signal()), /BUDGET/);
    assert.equal(j2.usage(c.runId).unknownRequests, 1); assert.equal(j2.usage(c.runId).tokens, null); }
  finally { other.close(); }
}));
test("model permits are shared, abortable and released after completion", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s); const b = { ...cfg.spec.budget, modelConcurrency: 1 };
  const id = await j.reserve(c, "p", {}, b, signal()); const ctl = new AbortController();
  const wait = j.reserve(c, "p", {}, b, ctl.signal); setTimeout(() => ctl.abort(), 10);
  await assert.rejects(wait); assert.equal(j.usage(c.runId).requests, 1);
  j.complete(id, 3, {}); await j.reserve(c, "p", {}, b, signal()); assert.equal(j.usage(c.runId).requests, 2);
}));
test("a completed model reply is replayed after a crash without another inference call", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s); let calls = 0;
  const brain = new HttpBrain(j, (async () => { calls++; return reply(); }) as typeof fetch);
  const h: Message[] = [{ role: "user", content: "task" }];
  await brain.next(c, cfg.spec.agents.coder, h, cfg.spec.budget, 32768, signal(), 0);
  const restored = new HttpBrain(new SessionJournal(s), (async () => { throw new Error("must not call model"); }) as typeof fetch);
  await restored.next(c, cfg.spec.agents.coder, h, cfg.spec.budget, 32768, signal(), 0);
  assert.equal(calls, 1); assert.equal(j.usage(c.runId).requests, 1);
  await assert.rejects(restored.next(c, cfg.spec.agents.coder, [{ role: "user", content: "changed" }], cfg.spec.budget, 32768, signal(), 0), /drift/);
}));
test("HTTP adapter keeps credentials out of persisted requests and honors redirect rejection", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s); process.env.SWARM_FIXTURE_KEY = "test-only-never-real";
  let seen: any;
  try {
    const brain = new HttpBrain(j, (async (_url: any, init: any) => { seen = init; return reply(); }) as typeof fetch);
    await brain.next(c, { ...cfg.spec.agents.coder, keyEnv: "SWARM_FIXTURE_KEY" }, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal());
    assert.equal(seen.headers.authorization, "Bearer test-only-never-real"); assert.equal(seen.redirect, "error");
    const row = s.db.prepare("SELECT request FROM agent_requests").get()!;
    assert.ok(!canonical(s.readArtifact(row.request)).includes("test-only-never-real"));
  } finally { delete process.env.SWARM_FIXTURE_KEY; }
}));
test("rate-limit retries are metered and a shared cooldown is stored", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s); let n = 0;
  const brain = new HttpBrain(j, (async () => ++n === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : reply()) as typeof fetch);
  await brain.next(c, cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal());
  assert.equal(n, 2); assert.equal(j.usage(c.runId).unknownRequests, 1); assert.equal(j.usage(c.runId).knownTokens, 15);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_cooldowns").get()!.n, 1);
}));
test("encoded request including tools must fit the context contract before any RPC", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => { throw new Error("must not call"); }) as typeof fetch);
  await assert.rejects(brain.next(c, cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 20, signal()), /CONTEXT/);
  assert.equal(j.usage(c.runId).requests, 0);
}));

test("worktrees are lazy and filesystem tools enforce scope and unique literal edits", async () => fixture(async (s, cfg, path) => {
  const { c } = lease(s); const h = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  const before = execFileSync("git", ["-C", path, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.equal((before.match(/^worktree /gm) ?? []).length, 1);
  try {
    await assert.rejects(h.tool({ id: "x", name: "write_file", arguments: { path: "src/b.txt", content: "bad" } }), /scope/);
    await h.tool({ id: "x", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } });
    await assert.rejects(h.tool({ id: "e", name: "edit_file", arguments: { path: "src/a.txt", oldText: "missing", newText: "0" } }), /one match/);
    const hash = await h.snapshot(); assert.match(s.readArtifact(hash) as string, /\+42/);
    assert.equal(readFileSync(join(path, "src/a.txt"), "utf8"), "0\n");
  } finally { await h.dispose(); }
}));
test("symlink tools are rejected before writing outside a worktree", async () => fixture(async (s, cfg, path) => {
  const { c } = lease(s); const h = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  try {
    const root = await h.ready(); symlinkSync(join(path, "src/a.txt"), join(root, "src/link"));
    await assert.rejects(h.tool({ id: "r", name: "read_file", arguments: { path: "src/link" } }), /symlink/);
    assert.equal(readFileSync(join(path, "src/a.txt"), "utf8"), "0\n");
  } finally { await h.dispose(); }
}));
test("independent verification rejects an unchanged or incorrect candidate", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const artifact = { schema: 1, patchHash: s.artifact(""), summary: "all tests pass" };
  const v = await verifyPatch(s, cfg, c, artifact, signal()); assert.ok(v.checks.some(x => x.verdict === "FAIL"));
}));
test("real code lifecycle: native tool edits, separate check, branch integration, and no checkout mutation", async () => fixture(async (s, cfg, path) => {
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply("implemented")]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(result.accepted, 1); assert.equal(result.providerUsage.requests, 2); assert.equal(result.providerUsage.tokens, 30);
  assert.equal(readFileSync(join(path, "src/a.txt"), "utf8"), "0\n");
  const integrated = await integrateSwarm(s, result.id, signal());
  assert.equal(execFileSync("git", ["-C", path, "show", `${integrated.commit}:src/a.txt`], { encoding: "utf8" }), "42\n");
  assert.equal((await integrateSwarm(s, result.id, signal())).commit, integrated.commit);
  assert.equal(execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), cfg.baseCommit);
}));
test("failed verification sends bounded evidence back for repair rather than replaying the same answer", async () => fixture(async (s) => {
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "1\n" } }]), () => reply("first attempt"),
    body => { assert.match(JSON.stringify(body.messages), /repairRequired/); return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]); }, () => reply("repaired")]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(result.attempts, 2); assert.equal(mock.bodies.length, 4);
}));
test("restart after saved worker output skips inference and only re-verifies", async () => fixture(async (s, cfg) => {
  const { c, q, l, run } = lease(s);
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply("done")]);
  const d = new SwarmDriver(s, cfg, mock.fetcher); const first = await d.execute(c, signal()); assert.ok(first.artifact);
  q.fail(l, "harness restarted before acceptance");
  const result: any = await runSwarm(s, [], signal(), run, (async () => { throw new Error("duplicate inference"); }) as typeof fetch);
  assert.equal(result.status, "PASS"); assert.equal(result.providerUsage.requests, 2);
}));
test("a prepared integration receipt cannot overwrite someone else's branch", async () => fixture(async (s, cfg, path) => {
  const mock = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply("done")]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher); const integrated = await integrateSwarm(s, r.id, signal());
  execFileSync("git", ["-C", path, "update-ref", integrated.branch, cfg.baseCommit]);
  await assert.rejects(integrateSwarm(s, r.id, signal()), /never overwrite/);
}));
test("config mutations cannot replace the immutable verifier", async () => fixture(async s => {
  const cfg: any = s.getMeta("extension.swarm"); cfg.spec.agents.coder.checks = ["not-real"];
  s.setMeta("extension.swarm", cfg); assert.throws(() => loadSwarm(s));
}));

test("native slash commands are registered and delegate to the same host facade", async () => {
  const { default: command, swarmPlan } = await import("../../src/commands/swarm/index.ts");
  assert.equal(command.disableModelInvocation, true); assert.equal(command.name, "swarm");
  const impl = await command.load();
  const result = await impl.call("help", { abortController: new AbortController() } as any);
  assert.equal(result.type, "text"); assert.match((result as any).value, /Foundry Swarm/);
  const prompt = await swarmPlan.getPromptForCommand("change API safely", {} as any);
  assert.match((prompt[0] as any).text, /change API safely/); assert.match((prompt[0] as any).text, /no recursive delegation/i);
  const registry = readFileSync(new URL("../../src/commands.ts", import.meta.url), "utf8");
  assert.match(registry, /import swarm, \{ swarmPlan \}/);
  assert.match(registry, /const COMMANDS[\s\S]*?\n  swarm,\n  swarmPlan,/);
});

test("late model spend is recorded but cannot publish a reply under a replacement fence", async () => fixture(async (s, cfg) => {
  const { c, q, l, run } = lease(s); const j = new SessionJournal(s); const body = { input: "old" };
  const id = await j.reserve(c, "p", body, cfg.spec.budget, signal());
  q.fail(l, "restart"); const next = q.claim(run, "next")!; const current = q.capsule(next);
  j.complete(id, 7, { answer: "late" }, 0);
  assert.equal(j.usage(run).knownTokens, 7); assert.equal(j.cached(current, 0, body), null);
}));
test("configured model credentials cannot be passed to code execution", () => {
  const s = spec("x"); s.agents.coder.keyEnv = "PRIVATE_MODEL_KEY"; s.checks.behavior.envAllow = ["PRIVATE_MODEL_KEY"];
  assert.throws(() => validateSwarmSpec(s), /credentials/);
});
test("an oversized response is aborted and recorded as unknown rather than zero spend", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => new Response('"' + 'x'.repeat(3000) + '"')) as typeof fetch);
  await assert.rejects(brain.next(c, cfg.spec.agents.coder, [{ role: "user", content: "task" }], { ...cfg.spec.budget, maxToolOutputBytes: 1000 }, 32768, signal()), /output budget/);
  assert.equal(j.usage(c.runId).unknownRequests, 1);
}));
test("truncated completions are terminal, not successful empty code artifacts", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) as typeof fetch);
  await assert.rejects(brain.next(c, cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal()), FatalAttemptError);
  assert.equal(j.usage(c.runId).knownTokens, 2);
}));
test("mandatory request budget exhaustion stops unchanged retries in the existing runtime", async () => fixture(async s => {
  let calls = 0;
  const fetcher = (async () => { calls++; return reply("", [{ name: "list_files", arguments: {} }]); }) as typeof fetch;
  const result: any = await runSwarm(s, [task()], signal(), undefined, fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(result.attempts, 1); assert.equal(calls, 1);
}, s => { s.budget.maxRequests = 1; }));
test("provider reply recovery retains all outstanding parallel tool calls", async () => fixture(async (s, cfg) => {
  const { c, q, l, run } = lease(s); const j = new SessionJournal(s); const t = j.open(c, initial());
  // Simulate a crash after the model reply and before either tool effect.
  t.state.history.push({ role: "assistant", content: "", calls: [
    { id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } },
    { id: "read", name: "read_file", arguments: { path: "src/a.txt" } },
  ] }); t.state.turns = 1; j.checkpoint(t, "model.reply", t.state.history.at(-1));
  q.fail(l, "crash");
  const mock = scripted([body => { const results = body.messages.filter((m: any) => m.role === "tool"); assert.equal(results.length, 2); assert.match(results[1].content, /42/); return reply("done"); }]);
  const r: any = await runSwarm(s, [], signal(), run, mock.fetcher); assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 1);
}));
test("working-tree side effects outside declared scope are rejected at snapshot", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const h = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  try { const path = await h.ready(); writeFileSync(join(path, "src/b.txt"), "unclaimed edit"); await assert.rejects(h.snapshot(), /scope/); }
  finally { await h.dispose(); }
}));
test("independent checker source mutation cannot produce a PASS", async () => fixture(async (s, cfg) => {
  const { c } = lease(s); const h = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal()); let hash: string;
  try { await h.tool({ id: "x", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }); hash = await h.snapshot(); }
  finally { await h.dispose(); }
  const v = await verifyPatch(s, cfg, c, { schema: 1, patchHash: hash!, summary: "done" }, signal());
  assert.equal(v.checks.find(x => x.id === "behavior")!.verdict, "FAIL");
}, s => { s.checks.behavior.argv = [process.execPath, "-e", "require('node:fs').writeFileSync('src/a.txt','mutated by verifier')"]; }));
test("per-task passing patches may still conflict; integration fails without publishing", async () => fixture(async (s, cfg, project) => {
  const mock = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body); const taskSpec = JSON.parse(body.messages[1].content).task;
    const done = body.messages.some((m: any) => m.role === "tool");
    return done ? reply("done") : reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: `${taskSpec.input.value}\n` } }]);
  }) as typeof fetch;
  const a = { ...task("one"), writeScope: ["src/a.txt"], input: { value: 1 } };
  const b = { ...task("two"), writeScope: ["src/a.txt"], input: { value: 2 } };
  const r: any = await runSwarm(s, [a, b], signal(), undefined, mock); assert.equal(r.status, "PASS");
  await assert.rejects(integrateSwarm(s, r.id, signal()), /git apply failed/);
  assert.equal(execFileSync("git", ["-C", project, "for-each-ref", "refs/heads/swarm"], { encoding: "utf8" }), "");
}, s => { s.checks.behavior.argv = [process.execPath, "-e", "if(!['1','2'].includes(require('node:fs').readFileSync('src/a.txt','utf8').trim()))process.exit(1)"]; }));

test("example spec is valid but does not silently choose an operator's model", () => {
  const sample = JSON.parse(readFileSync(new URL("../../examples/swarm/spec.json", import.meta.url), "utf8"));
  validateSwarmSpec(sample);
  assert.equal(sample.agents.coder.model, "YOUR_DEPLOYED_MODEL_ID");
  assert.equal(sample.checks.behavior.argv[0], "$NODE");
});
test("execution backends must match the pinned identity", async () => fixture(async (s, cfg) => {
  const backend = { id: "unapproved", open() { throw new Error("must not execute"); }, async verify() { throw new Error("must not verify"); } };
  assert.throws(() => new SwarmDriver(s, cfg, undefined, backend), /backend identity mismatch/);
}));
test("NODE token resolves an actual Node executable for native command checks", async () => fixture(async (_s, cfg) => {
  assert.notEqual(cfg.checks.behavior.argv[0], "$NODE");
  assert.match(execFileSync(cfg.checks.behavior.argv[0], ["--version"], { encoding: "utf8" }), /^v\d+/);
}, s => { s.checks.behavior.argv[0] = "$NODE"; }));
test("status pages large task graphs without executing agents", async () => fixture(async s => {
  const run = new Scheduler(s).start(Array.from({ length: 201 }, (_, i) => task(`task-${String(i).padStart(3, "0")}`)));
  const first: any = await handleSwarm(["status", "--root", s.root, "--run", run]);
  assert.equal(first.tasks.length, 200); assert.equal(first.nextTaskAfter, "task-199");
  const second: any = await handleSwarm(["status", "--root", s.root, "--run", run, "--task-after", first.nextTaskAfter]);
  assert.equal(second.tasks.length, 1); assert.equal(second.nextTaskAfter, null); assert.equal(second.attempts, 0);
}));
test("host receipt inspection has bounded slices and no model calls", async () => fixture(async s => {
  const hash = s.artifact({ long: "x".repeat(5000) });
  const page: any = await handleSwarm(["receipt", "--root", s.root, "--hash", hash, "--length", "100"]);
  assert.equal(Buffer.byteLength(page.content), 100); assert.equal(page.nextOffset, 100);
  await assert.rejects(handleSwarm(["receipt", "--root", s.root, "--hash", hash, "--length", "99999"]), /slice/);
}));
