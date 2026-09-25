import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test",
  "tests/foundry/productivity.test.ts", "tests/foundry/swarm.test.ts", "tests/foundry/swarm-http.test.ts"], { cwd, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
