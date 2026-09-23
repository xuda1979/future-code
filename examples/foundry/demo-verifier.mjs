// Independent fixture checks, held outside the worker's disposable cwd.
// vm is used only for this trusted demo; it is NOT a security sandbox.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const { capsule, artifact, artifactHash } = JSON.parse(readFileSync(0, "utf8"));
const cases = [[0, 0], [2, 5], [-4, 10], [0.25, 0.75]];
let pass = artifact.taskId === capsule.task.id && typeof artifact.code === "string";
for (const [a, b] of cases) {
  try { pass = pass && runInNewContext(`(${artifact.code})(a, b)`, { a, b }, { timeout: 100 }) === a + b; }
  catch { pass = false; }
}
console.log(JSON.stringify({ artifactHash, checks: [{ id: "behavior", verdict: pass ? "PASS" : "FAIL" }] }));
