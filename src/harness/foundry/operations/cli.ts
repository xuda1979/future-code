import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, invariant } from "../kernel.ts";
import { Store } from "../store.ts";
import { loadSwarm } from "../swarm/host.ts";
import type { Json } from "../types.ts";
import { Operations } from "./actions.ts";
import { operationsTick, serveOperations } from "./service.ts";
export const operationsHelp = `Project-neutral governed operations on Foundry
  status --root DIR
  ingest --root DIR --file EVENT.json --allow-exec
  mode --root DIR --mode ACTIVE|DRAINING|PAUSED --allow-exec
  tick --root DIR --allow-exec
  serve --root DIR --allow-exec
  obligation --root DIR --file OBLIGATION.json --allow-exec
  resolve-obligation --root DIR --id ID --evidence HASH --allow-exec
  observe --root DIR --file OBSERVATION.json --allow-exec
Initialize with Swarm init and an operator-owned operations policy first.
Ingress is a trusted host boundary: authenticate incoming events before ingest.
serve stays attached; use an external process manager for persistent hosting.`;
export async function handleOperations(argv: string[], signal = new AbortController().signal): Promise<Json> {
  const cmd = argv[0] ?? "help"; if (cmd === "help") return { help: operationsHelp };
  invariant(["status", "ingest", "mode", "tick", "serve", "obligation", "resolve-obligation", "observe"].includes(cmd), "unknown operations command");
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]; invariant(["--root", "--file", "--mode", "--id", "--evidence", "--allow-exec"].includes(key) && !options.has(key), "invalid operations option");
    if (key === "--allow-exec") options.set(key, "true");
    else { const value = argv[++i]; invariant(value && !value.startsWith("--"), "missing operations option"); options.set(key, value); }
  }
  const need = (key: string) => { const v = options.get(key); invariant(v, `required ${key}`); return v; };
  if (cmd !== "status") need("--allow-exec");
  const store = await Store.open(need("--root"));
  try {
    const cfg = loadSwarm(store); invariant(cfg.operations, "operations not configured"); const ops = new Operations(store, cfg.operations);
    const input = () => { const path = need("--file"); invariant(statSync(path).size <= 65536, "operations input too large"); return JSON.parse(readFileSync(path, "utf8")); };
    if (cmd === "status") return { ...ops.snapshot() as object, events: ops.events.state(), obligations: ops.events.outstanding() } as unknown as Json;
    if (cmd === "ingest") return ops.events.enqueue(input()) as unknown as Json;
    if (cmd === "mode") return { mode: ops.events.setMode(need("--mode") as any) };
    if (cmd === "tick") return await operationsTick(store, signal);
    if (cmd === "serve") return await serveOperations(store, signal);
    if (cmd === "obligation") return ops.events.addObligation(input()) as unknown as Json;
    if (cmd === "observe") {
      const i = input(); ops.observe(i.id, i.value, i.evidenceHash, i.observedAt, i.expiresAt); return { observed: i.id };
    }
    return ops.events.resolveObligation(need("--id"), need("--evidence")) as unknown as Json;
  } finally { store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  handleOperations(process.argv.slice(2), controller.signal).then(value => console.log(canonical(value)),
    error => { console.error(error.message); process.exitCode = 1; });
}
