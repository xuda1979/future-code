#!/usr/bin/env node
/** Real repository source + independent checker; scripted responses, ZERO live model calls. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { evaluateRealProject } from "../src/harness/foundry/projectEvaluation.ts";
import { digest } from "../src/harness/foundry/kernel.ts";
const repo = fileURLToPath(new URL("../", import.meta.url));
const dest = resolve(process.argv[2] ?? join(repo, ".future-code", "real-project-demo"));
// Pin the real defective input revision so the example remains reproducible
// after this fix is merged. An optional third CLI argument selects another base.
const base = process.argv[3] ?? "aa7f326c0895cdf6782910d0e73645872d724d11";
mkdirSync(dest, { recursive: true });
const project = join(dest, "input-project");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, project]);
execFileSync("git", ["-C", project, "checkout", "--quiet", "--detach", base]);
const negative = spawnSync(process.execPath, ["--experimental-strip-types", join(repo, "examples/productivity/verify-context.mjs")],
  { cwd: project, encoding: "utf8" });
if (negative.error || negative.status !== 1 || !negative.stderr.includes("Missing expected exception"))
  throw new Error("input revision must reproduce the frozen receipt-budget regression before any trial");
writeFileSync(join(dest, "negative-control.json"), JSON.stringify({ sourceCommit: base, status: negative.status,
  reproduced: true, outputHash: digest(negative.stderr) }, null, 2) + "\n");
const tasks = JSON.parse(readFileSync(new URL("../examples/productivity/tasks.json", import.meta.url), "utf8"));
const original = 'export function inlineReceipt(receipt: string, value: Json, limit = 2048): string {\n';
const replacement = original + '  invariant(Number.isSafeInteger(limit) && limit > 0, "invalid inline receipt limit");\n';
const response = (content, calls = []) => ({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content,
  ...(calls.length ? { tool_calls: calls.map((call, i) => ({ id: `recorded-${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) } }] });
const recording = { schema: 1, tasksHash: digest(tasks), responses: { "receipt-budget": [
  response("", [{ name: "edit_file", arguments: { path: tasks[0].writeScope[0], oldText: original, newText: replacement } }]),
  response("Invalid limits rejected; independent checker decides acceptance."),
] } };
const spec = { schema: 1, name: "real-source-replay", project, baseRef: base, defaultAgent: "coder",
  agents: { coder: { protocol: "chat-completions", url: "http://127.0.0.1:1/v1/chat/completions", model: "offline-recorded-response",
    system: "Fix the scoped regression. Do not edit checks or claim acceptance.", tools: ["read_file", "edit_file", "run_check", "recall"], checks: ["receipt-budget"] } },
  checks: { "receipt-budget": { argv: [process.execPath, "--experimental-strip-types", join(repo, "examples/productivity/verify-context.mjs")],
    files: [join(repo, "examples/productivity/verify-context.mjs")], replaySafe: true } },
  integrationChecks: ["receipt-budget"], protectedPaths: ["tests", "scripts", "examples"],
  limits: { parallelism: 8, attempts: 2, contextBytes: 65536, outputBytes: 65536, timeoutMs: 60000, tasks: 32 },
  recipe: { parallelism: 1, attempts: 1, contextBytes: 16384, timeoutMs: 30000 },
  budget: { maxRequests: 8, maxRequestBytes: 262144, maxTurns: 4, maxToolCalls: 4, modelConcurrency: 4,
    requestTimeoutMs: 5000, toolTimeoutMs: 5000, maxOutputTokens: 1024, maxToolOutputBytes: 65536, maxPatchBytes: 65536 } };
// Both recipes face the same one-task regression. This demonstrates quality and
// instrumentation, never a claim that extra parallelism accelerates this task.
const report = await evaluateRealProject({ baseline: spec, candidate: { ...spec, recipe: { ...spec.recipe, parallelism: 4 } },
  tasks, repetitions: 3, mode: "replay", root: join(dest, "trials"), signal: AbortSignal.timeout(120000) }, recording);
writeFileSync(join(dest, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(dest, "recording.json"), JSON.stringify(recording, null, 2) + "\n");
console.log(JSON.stringify({ report: join(dest, "report.json"), decision: report.decision, allPass: report.allPass,
  modelRequests: report.modelRequests, trials: report.trials.length }, null, 2));
if (!report.allPass) process.exitCode = 2;
