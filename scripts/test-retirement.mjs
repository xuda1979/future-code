// Test launcher for the retirement mechanism suite. The engine imports
// the HACT modules, which use Bun-style '.js' specifiers for '.ts'
// sources; the suite therefore runs under Bun (the same runtime the
// HACT tests use: tests/hact).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(join(root, "tests/retirement")).filter(s => s.endsWith(".test.ts")).sort().map(s => join(root, "tests/retirement", s));
if (!tests.length) throw new Error("No tests discovered");
const result = spawnSync("bun", ["test", ...tests], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
