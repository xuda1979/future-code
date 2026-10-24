import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/harness/foundry/store.ts";
import { initializeSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { Operations } from "../../src/harness/foundry/operations/actions.ts";
import { operationsTick } from "../../src/harness/foundry/operations/service.ts";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), temp = mkdtempSync(join(tmpdir(), "future-operations-demo-"));
const previous = process.env.FUTURE_OPERATIONS_DEMO_PROVIDER;
process.env.FUTURE_OPERATIONS_DEMO_PROVIDER = join(temp, "provider.sqlite");
const store = await Store.open(join(temp, "state"));
const signal = new AbortController().signal; let requests = 0;
const scriptedProvider = (async () => {
  requests++;
  return Response.json({ choices: [{ finish_reason: requests === 1 ? "tool_calls" : "stop", message: {
    role: "assistant", content: requests === 1 ? "" : "Observed the synthetic transition; independent checks decide acceptance.",
    ...(requests === 1 ? { tool_calls: [{ id: "call-1", type: "function", function: { name: "invoke_capability", arguments: JSON.stringify({ name: "advance", input: { resource: "resource-1" } }) } }] } : {}),
  } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
}) as typeof fetch;
try {
  const spec = JSON.parse(readFileSync(join(project, "examples/operations/spec.json"), "utf8")); spec.project = project;
  const cfg = await initializeSwarm(store, spec, signal), ops = new Operations(store, cfg.operations!);
  const event = JSON.parse(readFileSync(join(project, "examples/operations/event.json"), "utf8"));
  const first = ops.events.enqueue(event); ops.events.enqueue(event);
  const result = await operationsTick(store, signal, (_tasks, run, sig) => runSwarm(store, [], sig, run, scriptedProvider));
  const idle = await operationsTick(store, signal);
  console.log(JSON.stringify({ synthetic: true, liveModelCalls: 0, scriptedRequests: requests,
    result, idle, event: ops.events.get(first.key).status, resources: ops.snapshot() }, null, 2));
} finally {
  store.close(); rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) delete process.env.FUTURE_OPERATIONS_DEMO_PROVIDER;
  else process.env.FUTURE_OPERATIONS_DEMO_PROVIDER = previous;
}
