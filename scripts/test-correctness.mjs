#!/usr/bin/env node
/** Offline correctness regression gate; no package install or paid API calls. */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13) || process.platform === "win32") {
  console.error("Use Node >=22.13 on Linux/macOS/WSL (node:sqlite and POSIX process groups required).");
  process.exit(1);
}
function gate(command, args, timeout) {
  console.error(`\nGATE ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", timeout, env: process.env });
  if (result.error || result.signal || result.status !== 0) {
    console.error(result.error?.message ?? `Gate failed: status=${result.status}, signal=${result.signal ?? "none"}`);
    process.exit(result.status && result.status > 0 ? result.status : 1);
  }
}
gate(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1",
  "tests/correctness/acceptance.test.ts", "tests/correctness/replay.test.ts",
  "tests/correctness/response-liveness.test.ts",
  "tests/correctness/remote-response-liveness.test.ts",
  "tests/correctness/permission-delivery.test.ts",
  "tests/correctness/token-estimation-anchor.test.ts"], 900000);
const python = process.env.PYTHON ?? "python3";
gate(python, ["-m", "unittest", "discover", "-s", "tests/correctness", "-p", "test_*.py", "-v"], 60000);
gate(python, ["-m", "unittest", "discover", "-s", "tests/research-jobs", "-p", "test_*.py", "-v"], 120000);
console.error("\nCorrectness gates passed. This is not a full Bun/CLI or live-provider certification.");
