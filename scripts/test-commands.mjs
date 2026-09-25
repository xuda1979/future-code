// Test launcher for the slash-command suite. These tests run under Node
// (not Bun) since the command modules are pure TypeScript with no Bun-
// specific imports.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const testDir = join(root, "tests/commands");
const tests = readdirSync(testDir)
  .filter(s => s.endsWith(".test.ts"))
  .sort()
  .map(s => join(testDir, s));

if (!tests.length) throw new Error("No tests discovered in tests/commands/");
console.log(`Running ${tests.length} test file(s) from tests/commands/`);
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
