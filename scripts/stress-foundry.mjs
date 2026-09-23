// Synthetic scheduling/integrity exercise. This does NOT measure LLM productivity.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store, runTasks, digest } from "../src/harness/foundry/index.ts";
const count = Number(process.argv[2] ?? 1000);
if (!Number.isSafeInteger(count) || count < 10 || count > 5000) throw new Error("Use 10..5000 tasks");
const root = mkdtempSync(join(tmpdir(), "foundry-stress-")); const store = await Store.open(root);
try {
  store.initialize({ schema: 1, name: "synthetic-stress", verifierId: "arithmetic-check-v1", workerId: "synthetic-worker-v1", environmentId: "local-synthetic-v1",
    requiredChecks: ["arithmetic"], slos: [], limits: {parallelism: 8, attempts: 1, contextBytes: 8192, outputBytes: 8192, timeoutMs: 30000, tasks: count}},
    {parallelism: 8, attempts: 1, contextBytes: 8192, timeoutMs: 30000});
  const tasks = Array.from({length: count}, (_, i) => ({id:`task-${String(i).padStart(5,'0')}`, goal:"Compute a synthetic checked artifact", acceptance:["exact arithmetic"],
    dependencies:i >= 8 ? [`task-${String(i-8).padStart(5,'0')}`] : [], writeScope:[`outputs/${i}.json`], input:i}));
  let concurrent = 0; let peak = 0;
  const result = await runTasks(store, tasks, {workerId:"synthetic-worker-v1", verifierId:"arithmetic-check-v1",
    async execute(c) { concurrent++; peak=Math.max(peak,concurrent); await new Promise(r=>setTimeout(r,1)); concurrent--;
      return {artifact:{value:c.task.input*2}, measurement:{tokens:0,costUsd:0}}; },
    async verify(c,r) { return {artifactHash:digest(r.artifact), checks:[{id:"arithmetic", verdict:r.artifact.value===c.task.input+c.task.input ? "PASS":"FAIL"}], measurement:{tokens:0,costUsd:0}}; }
  });
  assert.equal(result.status,"PASS"); assert.equal(result.accepted,count); assert.equal(result.attempts,count); assert.ok(peak<=8);
  console.log(JSON.stringify({kind:"synthetic-scheduler-only",peakWorkers:peak,...result},null,2));
} finally {store.close(); rmSync(root,{recursive:true,force:true});}
