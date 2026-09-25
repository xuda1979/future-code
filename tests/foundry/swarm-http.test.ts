import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, task, signal, reply } from "./swarm-fixtures.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { HttpBrain } from "../../src/harness/foundry/swarm/model.ts";
import { runProcess } from "../../src/harness/foundry/swarm/process.ts";
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse, body: any) => Promise<void>, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(async (req, res) => {
    try { let body = ""; for await (const b of req) body += b; await handler(req, res, JSON.parse(body)); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try { await fn(`http://127.0.0.1:${address.port}/v1/chat/completions`); }
  finally { server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); }
}

test("actual HTTP plus standalone CLI executes a scoped code task and returns persisted usage", async () => {
  let count = 0;
  await endpoint(async (req, res, body) => {
    count++; assert.equal(req.method, "POST"); assert.equal(body.model, "fixture-model"); assert.ok(body.tools.length > 0);
    const response = body.messages.some((m: any) => m.role === "tool") ? reply("implemented")
      : reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    res.setHeader("content-type", "application/json"); res.end(await response.text());
  }, url => fixture(async (s, _cfg, project) => {
    const path = join(s.root, "tasks.json"); writeFileSync(path, JSON.stringify([task()]));
    const cli = fileURLToPath(new URL("../../src/harness/foundry/swarm/cli.ts", import.meta.url));
    const out = await promisify(execFile)(process.execPath, ["--experimental-strip-types", cli, "run", "--root", s.root, "--tasks", path, "--allow-exec"], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(out.stdout); assert.equal(result.status, "PASS"); assert.equal(result.providerUsage.requests, 2);
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
  }, s => { s.agents.coder.url = url; }));
  assert.equal(count, 2);
});
test("actual Anthropic wire format includes native tool results and API headers", async () => {
  await endpoint(async (req, res, body) => {
    assert.equal(req.headers["anthropic-version"], "2023-06-01"); assert.equal(req.headers["x-api-key"], "fixture-key");
    assert.equal(body.messages[2].content[0].type, "tool_result"); assert.equal(body.messages[2].content[0].tool_use_id, "call");
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
  }, url => fixture(async (s, cfg) => {
    const q = new Scheduler(s); const run = q.start([task()]); const c = q.capsule(q.claim(run, "worker")!);
    process.env.SWARM_HTTP_TEST_KEY = "fixture-key";
    try {
      const result = await new HttpBrain(new SessionJournal(s)).next(c, { ...cfg.spec.agents.coder, protocol: "anthropic", keyEnv: "SWARM_HTTP_TEST_KEY" },
        [{ role: "user", content: "task" }, { role: "assistant", content: "", calls: [{ id: "call", name: "list_files", arguments: {} }] }, { role: "tool", callId: "call", content: "[]" }],
        cfg.spec.budget, 32768, signal());
      assert.equal(result.turn.tokens, 12);
    } finally { delete process.env.SWARM_HTTP_TEST_KEY; }
  }, s => { s.agents.coder.url = url; }));
});
test("multiple host handles share a real HTTP concurrency admission cap", async () => {
  let active = 0; let peak = 0;
  await endpoint(async (_req, res) => {
    active++; peak = Math.max(peak, active); await delay(50); active--;
    res.setHeader("content-type", "application/json"); res.end(await reply().text());
  }, url => fixture(async (s, cfg) => {
    const q = new Scheduler(s); const run = q.start([{ ...task("a"), readScope: [] }, { ...task("b"), readScope: [] }]);
    const a = q.capsule(q.claim(run, "a")!); const b = q.capsule(q.claim(run, "b")!);
    const second = await Store.open(s.root); const budget = { ...cfg.spec.budget, modelConcurrency: 1 };
    try {
      await Promise.all([new HttpBrain(new SessionJournal(s)).next(a, cfg.spec.agents.coder, [{ role: "user", content: "a" }], budget, 32768, signal()),
        new HttpBrain(new SessionJournal(second)).next(b, cfg.spec.agents.coder, [{ role: "user", content: "b" }], budget, 32768, signal())]);
    } finally { second.close(); }
  }, s => { s.agents.coder.url = url; }));
  assert.equal(peak, 1);
});
test("stalled HTTP response bodies time out and remain unknown spend", async () => {
  await endpoint(async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"choices":'); },
    url => fixture(async (s, cfg) => {
      const q = new Scheduler(s); const run = q.start([task()]); const c = q.capsule(q.claim(run, "a")!); const j = new SessionJournal(s);
      await assert.rejects(new HttpBrain(j).next(c, cfg.spec.agents.coder, [{ role: "user", content: "a" }], { ...cfg.spec.budget, requestTimeoutMs: 50 }, 32768, signal()));
      assert.equal(j.usage(run).unknownRequests, 1);
    }, s => { s.agents.coder.url = url; }));
});
test("cancelling a real process group prevents a spawned child from writing later", async () => fixture(async (s, _cfg, project) => {
  const ready = join(s.root, "child-ready"); const effect = join(s.root, "late-effect");
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(effect)},'bad'),300)`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const cmd = pinCommand({ argv: [process.execPath, "-e", parentCode] }, project); const controller = new AbortController();
  const pending = runProcess(cmd, project, [], controller.signal, 3000, 10000).then(() => null, e => e);
  for (let n = 0; n < 100 && !existsSync(ready); n++) await delay(5);
  assert.ok(existsSync(ready), "child actually started"); controller.abort(); assert.match(String(await pending), /cancelled/);
  await delay(350); assert.equal(existsSync(effect), false);
}));
