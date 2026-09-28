import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/harness/foundry/store.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import { executable, type PinnedSwarm } from "../../src/harness/foundry/swarm/config.ts";
import { workerIdentity, verifierIdentity } from "../../src/harness/foundry/swarm/driver.ts";
import type { Capsule } from "../../src/harness/foundry/types.ts";

export const reply = (content = "finished", calls: any[] = []) => ({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: c.id ?? `call-${i}`, type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
export const writeReply = () => reply("", [{ id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
export async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "future-replay-regression-")); const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true }); writeFileSync(join(project, "src/a.txt"), "0\n");
  const git = (args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git(["init"]); git(["add", "."]); git(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "fixture"]);
  const check = { argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('src/a.txt','utf8').trim()!=='42')process.exit(1)"], replaySafe: true };
  const cfg: PinnedSwarm = { version: 1, handsId: "local-git-posix-v1", baseCommit: git(["rev-parse", "HEAD"]),
    git: pinCommand({ argv: [executable("git")] }, project), checks: { unit: pinCommand(check, project) },
    spec: { schema: 1, name: "replay-regression", project, baseRef: "HEAD", defaultAgent: "coder",
      agents: { coder: { protocol: "chat-completions", url: "https://example.invalid/v1/chat/completions", model: "fixture", system: "Implement the scoped task.",
        tools: ["write_file", "read_file", "run_check"], checks: ["unit"] } }, checks: { unit: check }, integrationChecks: ["unit"], protectedPaths: [],
      limits: { parallelism: 2, attempts: 5, contextBytes: 32000, outputBytes: 100000, timeoutMs: 60000, tasks: 10 },
      recipe: { parallelism: 1, attempts: 3, contextBytes: 16000, timeoutMs: 30000 },
      supervision: { reportEveryMs: 1000, checkpointEveryMs: 300000 },
      budget: { maxRequests: 100, maxRequestBytes: 1000000, maxTurns: 10, maxToolCalls: 30, modelConcurrency: 2,
        requestTimeoutMs: 10000, toolTimeoutMs: 10000, maxOutputTokens: 1000, maxToolOutputBytes: 100000, maxPatchBytes: 100000 } } };
  const store = await Store.open(join(root, "store"));
  const contract = { schema: 1 as const, name: "replay-regression", workerId: workerIdentity(cfg), verifierId: verifierIdentity(cfg), environmentId: "local-fixture",
    requiredChecks: ["scope", "behavior"], slos: [], limits: cfg.spec.limits };
  const recipeHash = store.initialize(contract, cfg.spec.recipe);
  const task = { id: "a", goal: "Write 42", acceptance: ["a.txt contains 42"], dependencies: [], writeScope: ["src/a.txt"], input: null };
  const capsule: Capsule = { schema: 1, runId: "regression", task, contractHash: digest(contract), recipeHash, fence: 1, dependencies: [] };
  store.db.prepare("INSERT INTO runs(id,recipe,contract,started,status) VALUES(?,?,?,?, 'RUNNING')").run(capsule.runId, recipeHash, capsule.contractHash, Date.now());
  store.db.prepare("INSERT INTO tasks(run,id,spec,status,fence,owner,deadline) VALUES(?,?,?,'RUNNING',1,'first',?)")
    .run(capsule.runId, task.id, JSON.stringify(task), Date.now() + 600000);
  store.db.prepare("INSERT INTO attempts(run,task,fence,started,status) VALUES(?,?,1,?,'RUNNING')").run(capsule.runId, task.id, Date.now());
  return { root, store, cfg, capsule, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function reclaim(store: Store, capsule: Capsule, previous = "EXPIRED"): Capsule {
  store.transaction(() => {
    store.db.prepare("UPDATE attempts SET status=?,ended=? WHERE run=? AND task=? AND fence=?").run(previous, Date.now(), capsule.runId, capsule.task.id, capsule.fence);
    store.db.prepare("UPDATE tasks SET fence=fence+1,owner='recovery',deadline=? WHERE run=? AND id=?").run(Date.now() + 600000, capsule.runId, capsule.task.id);
    store.db.prepare("INSERT INTO attempts(run,task,fence,started,status) VALUES(?,?,?,?,'RUNNING')").run(capsule.runId, capsule.task.id, capsule.fence + 1, Date.now());
  });
  return { ...capsule, fence: capsule.fence + 1 };
}
