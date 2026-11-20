import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, spec, signal, reply } from "./swarm-fixtures.ts";
import type { Task } from "../../src/harness/foundry/types.ts";

// R5 end-to-end: under recipe.scheduling === "speculative-race", conflicting
// fix hypotheses run concurrently in isolated worktrees; the first verified
// PASS wins and the loser's patch never integrates.

const hypothesis = (id: string, content: string): Task => ({
  id, goal: `Fix via hypothesis ${id}`, acceptance: ["external behavior check"],
  dependencies: [], writeScope: ["src/a.txt"], readScope: ["src"], input: { content },
});

test("speculative race: conflicting hypotheses run concurrently; winner integrates, loser never does", async () => {
  await fixture(async (s, _cfg, project) => {
    // Both tasks write src/a.txt (conflicting scopes). Only content "42"
    // passes the behavior check. The mock model serves both tasks from the
    // same scripted sequence; execution order decides who wins the race.
    let served = 0;
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const taskSpec = JSON.parse(body.messages[1].content).task;
      const done = body.messages.some((m: any) => m.role === "tool");
      if (!done) {
        served++;
        return reply("", [{ name: "write_file",
          arguments: { path: "src/a.txt", content: `${taskSpec.input.content}\n` } }]);
      }
      return reply(`hypothesis ${taskSpec.id} done`);
    }) as typeof fetch;

    const winner = hypothesis("h-win", "42");
    const loser = hypothesis("h-lose", "13");
    const result: any = await runSwarm(s, [winner, loser], signal(), undefined, fetcher);
    assert.equal(served, 2, "both conflicting hypotheses were admitted concurrently");
    assert.equal(result.status, "PASS");
    const statuses = s.db.prepare("SELECT id,status FROM tasks WHERE run=? ORDER BY id").all(result.id);
    const byId = Object.fromEntries(statuses.map((r: any) => [r.id, r.status]));
    assert.equal(byId["h-win"], "PASS");
    assert.equal(byId["h-lose"], "FAIL", "the losing hypothesis was cancelled, not accepted");

    // Integration applies only the winner's patch: src/a.txt is 42.
    const integrated = await integrateSwarm(s, result.id, signal());
    assert.equal(execFileSync("git", ["-C", project, "show", `${integrated.commit}:src/a.txt`],
      { encoding: "utf8" }).trim(), "42");
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8").trim(), "0",
      "the user's checkout is never touched");
  }, s => { s.recipe.scheduling = "speculative-race"; });
});

test("serial mode still refuses to co-run conflicting hypotheses", async () => {
  await fixture(async (s, _cfg) => {
    let served = 0;
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const taskSpec = JSON.parse(body.messages[1].content).task;
      const done = body.messages.some((m: any) => m.role === "tool");
      if (!done) { served++; return reply("", [{ name: "write_file",
        arguments: { path: "src/a.txt", content: `${taskSpec.input.content}\n` } }]); }
      return reply("done");
    }) as typeof fetch;
    const a = hypothesis("serial-a", "42");
    const b = hypothesis("serial-b", "42");
    const result: any = await runSwarm(s, [a, b], signal(), undefined, fetcher);
    assert.equal(served, 2);
    // Both passed in sequence (same-file writes serialized; second patch
    // rebuilt on the first's output via verify-time worktrees). The serial
    // mode never co-admitted them: no race.lost events exist.
    const raced = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='race.lost'").get(result.id)!.n;
    assert.equal(raced, 0, "no race cancellation in serial mode");
  });
});
