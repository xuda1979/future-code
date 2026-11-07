// RSI cycle snapshot: measure the self-improvement loop so it can be
// checked objectively. Run once per RSI cycle (before and after a change is
// shipped); each run appends one JSON line to .future/rsi-cycle.jsonl.
//
// Usage (Node required; Bun is rejected):
//   node --experimental-strip-types scripts/rsi-cycle-snapshot.ts before
//   node --experimental-strip-types scripts/rsi-cycle-snapshot.ts after
//   node --experimental-strip-types scripts/rsi-cycle-snapshot.ts --dry before
// --dry skips the suite measurements and only writes the metadata row.
//
// Uses only the standard library. All three measured lanes mirror CI:
// foundry + commands under Node, and the Bun lane (hact/api/harness) with the
// retry preload the offline CI uses.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.versions.bun) {
  console.error("Run this snapshot with Node >=22.13, not Bun.");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerDir = join(root, ".future");
const ledgerFile = join(ledgerDir, "rsi-cycle.jsonl");

interface SuiteResult {
  msec: number;
  pass: boolean;
}
interface SuiteTimes {
  foundry?: SuiteResult;
  commands?: SuiteResult;
  bun_lane?: SuiteResult;
}

function runSuite(exe: string, args: string[], timeout: number, label: string): SuiteResult {
  const start = Date.now();
  console.error(`[rsi] measuring ${label}...`);
  const res = spawnSync(exe, args, { cwd: root, timeout, stdio: "ignore" });
  return { msec: Date.now() - start, pass: res.status === 0 && !res.error };
}

function dirSize(path: string): number {
  const seen = new Set<string>();
  const stack = [path];
  let bytes = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    let st;
    try { st = statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const e of entries) {
        const p = join(cur, e);
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    } else if (st.isFile()) bytes += st.size;
  }
  return bytes;
}

function gitInfo(): { head: string; dirty: boolean } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
  return { head, dirty: status.split("\n").some(l => l.trim()) };
}

async function main() {
  const started = Date.now();
  const phase = process.argv.includes("after") ? "after" : "before";
  const dry = process.argv.includes("--dry");

  // Precisely the lanes CI gates, so the snapshot reflects what the project
  // treats as "done": foundry + commands under Node, and the Bun lane
  // (hact/api/harness) with the retry preload the offline CI uses. A failed
  // lane still records its elapsed time so regressions show up in the ledger.
  const suites: SuiteTimes = {};
  if (dry) {
    console.error("[rsi] --dry requested; skipping suite measurement");
  } else {
    suites.foundry = runSuite(
      process.execPath, ["scripts/test-foundry.mjs"], 900_000, "foundry suite",
    );
    suites.commands = runSuite(
      process.execPath, ["scripts/test-commands.mjs"], 900_000, "commands suite",
    );
    const bunLane = [
      "test", "tests/hact", "tests/api", "tests/harness",
      "--preload", "./tests/api/retry-isolation.ts",
    ];
    suites.bun_lane = runSuite("bun", bunLane, 900_000, "bun lane");
  }
  const wall = Date.now() - started;

  const git = gitInfo();
  const projects = join(homedir(), ".future", "projects");
  const record = {
    ts: new Date().toISOString(),
    phase,
    git_head: git.head,
    git_dirty: git.dirty,
    suite: suites,
    wall_msec: wall,
    session_stores_bytes: existsSync(projects) ? dirSize(projects) : null,
    session_stores_mb: existsSync(projects)
      ? Math.round(dirSize(projects) / 1_048_576 * 100) / 100
      : null,
  };

  await mkdir(ledgerDir, { recursive: true });
  await appendFile(ledgerFile, JSON.stringify(record) + "\n", "utf8");
  console.error(`[rsi] appended snapshot (${phase}) to .future/rsi-cycle.jsonl`);
}

main().catch(err => { console.error(err); process.exit(1); });
