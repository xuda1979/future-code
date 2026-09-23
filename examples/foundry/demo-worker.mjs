// An offline integration fixture, NOT a language model or a productivity benchmark.
// It emits a code artifact. Replace this command with your existing coding agent.
import { readFileSync } from "node:fs";
const { capsule } = JSON.parse(readFileSync(0, "utf8"));
if (capsule.task.input.operation !== "add") throw new Error("unsupported demo task");
// Fixed wait makes the parallel scheduler visible in this synthetic example.
await new Promise(resolve => setTimeout(resolve, 120));
console.log(JSON.stringify({ artifact: { code: "(a, b) => a + b", taskId: capsule.task.id } }));
