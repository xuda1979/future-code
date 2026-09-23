// Cross-platform test discovery: no dependency on shell wildcard expansion.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
if (process.versions.bun) throw new Error("Run this test launcher with Node >=22.13; Bun runtime support is a separate compatibility check.");
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(join(root, "tests/foundry")).filter(s => s.endsWith(".test.ts")).sort().map(s => join(root, "tests/foundry", s));
if (!tests.length) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
