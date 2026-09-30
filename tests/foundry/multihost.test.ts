import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { executable } from "../../src/harness/foundry/swarm/config.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, reply, signal, task } from "./swarm-fixtures.ts";

test("multi-host worker fleet executes parallel tasks while coordinator retains verification authority", async () => {
  let workerRepos: string[] = [];
  await fixture(async (store, _cfg, project) => {
    let initial = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetcher = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      const packet = body.messages.find((m: any) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes('"task"'));
      const id = JSON.parse(packet.content).task.id as string;
      const hasToolResult = body.messages.some((m: any) => m.role === "tool");
      if (!hasToolResult) {
        initial++;
        if (initial === 2) release();
        await barrier;
        return reply("", [{ name: "write_file", arguments: { path: `src/${id}.txt`, content: "42\n" } }]);
      }
      return reply(`${id} complete`);
    }) as typeof fetch;

    const tasks = [
      { ...task("a"), readScope: [] },
      { ...task("b"), readScope: [] },
    ];
    const result: any = await runSwarm(store, tasks, signal(), undefined, fetcher);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 2);

    const claims = store.db.prepare(
      "SELECT payload FROM events WHERE run=? AND kind='worker.claimed' ORDER BY seq"
    ).all(result.id).map(row => JSON.parse(row.payload).worker);
    assert.equal(new Set(claims).size, 2, `expected two distinct workers, got ${claims.join(",")}`);

    const receipt = await integrateSwarm(store, result.id, signal());
    assert.equal(execFileSync("git", ["-C", project, "show", `${receipt.commit}:src/a.txt`], { encoding: "utf8" }), "42\n");
    assert.equal(execFileSync("git", ["-C", project, "show", `${receipt.commit}:src/b.txt`], { encoding: "utf8" }), "42\n");
  }, s => {
    const parent = dirname(s.project);
    const endpoint = resolve("scripts/swarm-worker-agent.py");
    const python = executable("python3");
    const config = join(parent, "worker-template.json");
    writeFileSync(config, JSON.stringify({ checks: {} }));
    workerRepos = [join(parent, "worker-repo-1"), join(parent, "worker-repo-2")];
    const roots = [join(parent, "worker-root-1"), join(parent, "worker-root-2")];
    workerRepos.forEach(repo => execFileSync("git", ["clone", "-q", s.project, repo]));
    roots.forEach(root => mkdirSync(root, { recursive: true }));
    s.workers = Object.fromEntries(workerRepos.map((repo, i) => [
      `host-${i + 1}`,
      {
        adapter: { argv: [python, endpoint, "--root", roots[i]!, "--repo", repo, "--config", config],
          files: [endpoint, config] },
        maxConcurrent: 1,
        maxRpcBytes: 2 * 1024 * 1024,
      },
    ]));
    s.recipe.parallelism = 2;
    s.checks.behavior = { argv: [process.execPath, "-e",
      "const fs=require('node:fs');const a=fs.readFileSync('src/a.txt','utf8').trim();const b=fs.readFileSync('src/b.txt','utf8').trim();if(a!=='42'&&b!=='42')process.exit(1)"], replaySafe: true };
    s.checks.integration = { argv: [process.execPath, "-e",
      "const fs=require('node:fs');if(fs.readFileSync('src/a.txt','utf8').trim()!=='42'||fs.readFileSync('src/b.txt','utf8').trim()!=='42')process.exit(1)"], replaySafe: true };
    s.agents.coder.checks = ["behavior"];
    s.integrationChecks = ["integration"];
  });
});
