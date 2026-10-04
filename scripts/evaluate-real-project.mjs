#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateRealProject } from "../src/harness/foundry/projectEvaluation.ts";
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!["--baseline-spec", "--candidate-spec", "--tasks", "--repetitions", "--root", "--mode", "--replay", "--out", "--allow-exec"].includes(key) || options.has(key)) throw new Error(`unknown/duplicate ${key}`);
  if (key === "--allow-exec") options.set(key, true);
  else { const value = process.argv[++i]; if (!value || value.startsWith("--")) throw new Error(`missing ${key}`); options.set(key, value); }
}
if (!options.has("--allow-exec")) throw new Error("--allow-exec required: live trials call configured APIs; all trials execute pinned checks");
const need = key => { if (!options.has(key)) throw new Error(`required ${key}`); return options.get(key); };
const read = key => JSON.parse(readFileSync(need(key), "utf8"));
const controller = new AbortController(), stop = () => controller.abort(new Error("operator interrupted"));
process.on("SIGINT", stop); process.on("SIGTERM", stop);
try {
  const report = await evaluateRealProject({ baseline: read("--baseline-spec"), candidate: read("--candidate-spec"),
    tasks: read("--tasks"), repetitions: Number(options.get("--repetitions") ?? 3),
    root: resolve(need("--root")), mode: options.get("--mode") ?? "live", signal: controller.signal },
    options.has("--replay") ? read("--replay") : undefined);
  if (options.has("--out")) writeFileSync(resolve(options.get("--out")), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.allPass) process.exitCode = 2;
} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
