import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/harness/foundry/store.ts";
import { initializeSwarm } from "../../src/harness/foundry/swarm/host.ts";
import type { SwarmSpec, PinnedSwarm } from "../../src/harness/foundry/swarm/config.ts";
import type { Task } from "../../src/harness/foundry/types.ts";
export const signal = () => new AbortController().signal;
export function spec(project: string): SwarmSpec {
  return { schema: 1, name: "test-swarm", project, baseRef: "HEAD", defaultAgent: "coder",
    agents: { coder: { protocol: "chat-completions", url: "http://127.0.0.1:1/v1/chat/completions", model: "fixture-model",
      system: "Implement scoped tasks with tools. Do not claim acceptance.", tools: ["list_files", "read_file", "write_file", "edit_file", "delete_file", "run_check", "recall"], checks: ["behavior"] } },
    checks: { behavior: { argv: [process.execPath, "-e", "const fs=require('node:fs');const v=fs.readFileSync('src/a.txt','utf8').trim();if(v!=='42')process.exit(1)"], replaySafe: true } },
    integrationChecks: ["behavior"], protectedPaths: ["checks"],
    limits: { parallelism: 8, attempts: 4, contextBytes: 65536, outputBytes: 32768, timeoutMs: 60000, tasks: 10000 },
    recipe: { parallelism: 4, attempts: 3, contextBytes: 32768, timeoutMs: 20000, scheduling: "critical-path" },
    budget: { maxRequests: 100, maxRequestBytes: 10_000_000, maxTurns: 20, maxToolCalls: 40, modelConcurrency: 4,
      requestTimeoutMs: 5000, toolTimeoutMs: 5000, maxOutputTokens: 1024, maxToolOutputBytes: 65536, maxPatchBytes: 65536 } };
}
export const task = (id = "a", dependencies: string[] = []): Task => ({ id, goal: `Implement ${id}`, acceptance: ["external behavior check"],
  dependencies, writeScope: [`src/${id}.txt`], readScope: ["src"], input: { value: 42 } });
export async function fixture(fn: (store: Store, cfg: PinnedSwarm, path: string) => Promise<void>, change?: (s: SwarmSpec) => void): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "swarm-test-")); const project = join(temp, "repo"); mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/a.txt"), "0\n"); writeFileSync(join(project, "src/b.txt"), "0\n");
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "base"]);
  const store = await Store.open(join(temp, "state"));
  try { const s = spec(project); change?.(s); const cfg = await initializeSwarm(store, s, signal()); await fn(store, cfg, project); }
  finally { store.close(); rmSync(temp, { recursive: true, force: true }); }
}
export function reply(content = "done", tools: { id?: string; name: string; arguments: unknown }[] = [], usage: unknown = { prompt_tokens: 10, completion_tokens: 5 }): Response {
  return Response.json({ choices: [{ finish_reason: tools.length ? "tool_calls" : "stop", message: { role: "assistant", content,
    ...(tools.length ? { tool_calls: tools.map((t, i) => ({ id: t.id ?? `call-${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}) } }], ...(usage === undefined ? {} : { usage }) });
}
export function scripted(steps: ((body: any) => Response | Promise<Response>)[]): { fetcher: typeof fetch; bodies: any[] } {
  const bodies: any[] = [];
  const fetcher = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const step = steps[bodies.length - 1]; if (!step) throw new Error("unexpected extra model call"); return await step(body);
  }) as typeof fetch;
  return { fetcher, bodies };
}
