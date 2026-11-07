import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(fn: (root: string, home: string, env: NodeJS.ProcessEnv) => void): void {
  const root = mkdtempSync(join(tmpdir(), "future-rsi-snapshot-"));
  const scripts = join(root, "scripts"); const home = join(root, "home"); const bin = join(root, "bin");
  for (const dir of [scripts, home, bin]) mkdirSync(dir);
  // Exercise the exact production CLI in a fixture repository with cheap lanes.
  copyFileSync(new URL("../../scripts/rsi-cycle-snapshot.ts", import.meta.url), join(scripts, "rsi-cycle-snapshot.ts"));
  writeFileSync(join(scripts, "test-foundry.mjs"), "process.exit(7);\n");
  writeFileSync(join(scripts, "test-commands.mjs"), "process.exit(0);\n");
  writeFileSync(join(bin, "bun"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  try { fn(root, home, { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function row(root: string): any {
  return JSON.parse(readFileSync(join(root, ".future/rsi-cycle.jsonl"), "utf8").trim());
}

test("RSI snapshot records failed lanes and returns failure to an automatic caller", () => fixture((root, _home, env) => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/rsi-cycle-snapshot.ts", "after"],
    { cwd: root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  const record = row(root);
  assert.equal(record.suite.foundry.pass, false); assert.equal(record.suite.foundry.exitCode, 7);
  assert.equal(record.suite.commands.pass, true); assert.equal(record.suite.bun_lane.pass, true);
  assert.match(result.stderr, /foundry suite failed: exit=7/);
}));

test("dry RSI snapshot skips suites and does not follow cyclic session-store symlinks", () => fixture((root, home, env) => {
  const projects = join(home, ".future/projects"); mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "session"), "12345");
  symlinkSync(projects, join(projects, "cycle"), "dir");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/rsi-cycle-snapshot.ts", "--dry", "before"],
    { cwd: root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(row(root).session_stores_bytes, 5);
  assert.deepEqual(row(root).suite, {});
}));
