import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandDriver, commandVerifierId, pinCommand } from "./commands.ts";
import { canonical, digest, invariant } from "./kernel.ts";
import { evaluate, loadEvaluation, promote, rollback, suggest } from "./evolution.ts";
import { runTasks } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Contract, PinnedCommand, Recipe, Task } from "./types.ts";

const usage = `Future Code Harness Foundry (single host)
  init     --spec FILE
  run      --tasks FILE --allow-exec
  resume   --run ID --allow-exec
  status   [--run ID]
  events   [--after SEQUENCE]
  propose  --changes FILE
  suggest
  evaluate --candidate HASH --protocol FILE --allow-exec
  inspect  --evaluation ID
  promote  --evaluation ID --confirm
  rollback --to HASH --confirm
  evolve   --protocol FILE --allow-exec [--auto-promote]
All commands accept --root DIR (default .future-code/foundry).
Command workers are trusted executables, not sandboxed untrusted plugins.`;
function args(argv: string[]): { command: string; options: Map<string, string> } {
  const command = argv[0] ?? "help"; const options = new Map<string, string>();
  const flags = new Set(["--allow-exec", "--confirm", "--auto-promote"]);
  const known = new Set(["--root", "--spec", "--tasks", "--run", "--after", "--changes", "--candidate", "--protocol", "--evaluation", "--to", ...flags]);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]; invariant(known.has(key) && !options.has(key), `unknown/duplicate option ${key}`);
    if (flags.has(key)) options.set(key, "true");
    else { const value = argv[++i]; invariant(value && !value.startsWith("--"), `missing value for ${key}`); options.set(key, value); }
  }
  return { command, options };
}
function json(path: string): any {
  invariant(statSync(path).size <= 32 * 1024 * 1024, "input JSON exceeds 32 MiB");
  return JSON.parse(readFileSync(path, "utf8"));
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = args(argv);
  if (command === "help") { console.log(usage); return; }
  const need = (key: string): string => { const v = options.get(key); invariant(v, `required ${key}`); return v; };
  const store = await Store.open(options.get("--root") ?? resolve(".future-code", "foundry"));
  const controller = new AbortController(); const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const driver = () => {
    need("--allow-exec");
    const cfg = store.getMeta<{ worker: PinnedCommand; checker: PinnedCommand }>("commands"); invariant(cfg, "no command adapters configured");
    const d = new CommandDriver(cfg.worker, cfg.checker, store.contract().limits.outputBytes);
    invariant(d.verifierId === store.contract().verifierId && d.workerId === store.contract().workerId, "stored command configuration drift"); return d;
  };
  try {
    switch (command) {
      case "init": {
        const spec = json(need("--spec"));
        const worker = pinCommand(spec.worker, process.cwd()); const checker = pinCommand(spec.verifier, process.cwd());
        const contract: Contract = { schema: 1, name: spec.name, environmentId: spec.environmentId,
          verifierId: commandVerifierId(checker), workerId: digest(worker), requiredChecks: spec.requiredChecks,
          slos: spec.slos ?? [], limits: spec.limits };
        const hash = store.initialize(contract, spec.recipe, { worker, checker });
        print({ active: hash, contractHash: digest(contract), root: store.root }); break;
      }
      case "run": case "resume": {
        const d = driver(); const tasks: Task[] = command === "run" ? json(need("--tasks")) : [];
        const result = await runTasks(store, tasks, d, { resumeRun: command === "resume" ? need("--run") : undefined, signal: controller.signal });
        print(result); if (result.status !== "PASS") process.exitCode = controller.signal.aborted ? 130 : 2; break;
      }
      case "status":
        print(options.has("--run") ? new Scheduler(store).summary(need("--run")) : { active: store.active(), recipe: store.recipe(), contract: store.contract() }); break;
      case "events": {
        const after = Number(options.get("--after") ?? 0); const items = store.events(after);
        print({ items, nextAfter: items.length ? items[items.length - 1].seq : after }); break;
      }
      case "propose": print({ candidate: store.propose(json(need("--changes")) as Partial<Recipe>), active: store.active() }); break;
      case "suggest": print({ candidate: suggest(store), active: store.active() }); break;
      case "evaluate": {
        const e = await evaluate(store, need("--candidate"), json(need("--protocol")), driver(), controller.signal);
        print(e); if (e.decision !== "ADMIT") process.exitCode = 2; break;
      }
      case "inspect": print(loadEvaluation(store, need("--evaluation"))); break;
      case "promote": need("--confirm"); print({ active: promote(store, need("--evaluation")) }); break;
      case "rollback": need("--confirm"); rollback(store, need("--to")); print({ active: store.active() }); break;
      case "evolve": {
        const d = driver(); const candidate = suggest(store);
        if (!candidate) { print({ proposed: false, reason: "no evidence-backed change available" }); break; }
        const e = await evaluate(store, candidate, json(need("--protocol")), d, controller.signal);
        const active = e.decision === "ADMIT" && options.has("--auto-promote") ? promote(store, e.id) : store.active();
        print({ evaluation: e, active }); if (e.decision !== "ADMIT") process.exitCode = 2; break;
      }
      default: throw new Error(`unknown command ${command}\n${usage}`);
    }
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(canonical({ error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
}
