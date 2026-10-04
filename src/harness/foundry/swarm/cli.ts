import { formatHealth, type HealthObserver } from "../health.ts";
import { superviseSwarm, objectiveStatus } from "./supervisor.ts";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invariant, canonical } from "../kernel.ts";
import { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import { initializeSwarm, integrateSwarm, loadSwarm, runSwarm, swarmStatus } from "./host.ts";
import { ResearchJobs, type JobReply } from "./jobs.ts";
import { SessionJournal } from "./session.ts";
import { readObjectiveEpisode } from "../rndEpisodes.ts";
import { readLatestObjectiveReflection } from "../rndReflection.ts";
import { adjudicateClaim, claimsForGoals, claimRevalidationTask, retractClaim } from "../claims.ts";
export const help = `Foundry Swarm: durable coding agents on the existing Foundry kernel
  init --spec FILE --allow-exec
  run --tasks FILE --allow-exec
  resume --run ID --allow-exec
  supervise --objective ID [--goal FILE --tasks FILE] --allow-exec
  objective --objective ID
  episode --objective ID
  reflection --objective ID
  claims --run ID --task ID [--after CLAIM_ID]
  claim-revalidation-task --run ID --claim ID
  claim-retract --run ID --claim ID --version N --reason TEXT --allow-exec
  claim-adjudicate --run ID --claim ID --version N --evidence ID --allow-exec
  status [--run ID] [--task-after TASK_ID]
  receipt --hash HASH [--offset N] [--length N]
  events --run ID --task ID [--after N]
  job-reconcile --run ID --job-key KEY --resolution FILE --allow-exec
  integrate --run ID --allow-exec
All accept --root DIR (default .future-code/swarm).
Local worktrees isolate edits, NOT hostile processes. Use only trusted code/checks.
Run/resume call configured model endpoints and may incur charges. No background daemon is started. supervise stays attached and resumable until final checks pass or the operator pauses it.
Integrate tests the merged tree and creates refs/heads/swarm/ID; it never edits main or pushes.`;
export function tokenize(text: string): string[] {
  const out: string[] = []; let word = ""; let quote = ""; let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) out.push(word); word = ""; started = false; }
    else { word += c; started = true; }
  }
  invariant(!quote, "unterminated quote"); if (started) out.push(word); return out;
}
function file(path: string): any { invariant(statSync(path).size <= 32 * 1024 * 1024, "JSON input exceeds 32 MiB"); return JSON.parse(readFileSync(path, "utf8")); }
export async function handleSwarm(argv: string[], signal: AbortSignal = new AbortController().signal, onProgress: HealthObserver = r => console.error(formatHealth(r))): Promise<Json> {
  const cmd = argv[0] ?? "help"; if (cmd === "help") return { help };
  const opts = new Map<string, string>(); const allowed = new Set(["--root", "--spec", "--tasks", "--run", "--task", "--after", "--task-after", "--hash", "--offset", "--length", "--objective", "--goal", "--job-key", "--resolution", "--allow-exec", "--claim", "--version", "--reason", "--evidence"]);
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i]; invariant(allowed.has(k) && !opts.has(k), `unknown/duplicate option ${k}`);
    if (k === "--allow-exec") opts.set(k, "true");
    else { const v = argv[++i]; invariant(v && !v.startsWith("--"), `missing ${k}`); opts.set(k, v); }
  }
  const need = (k: string) => { const value = opts.get(k); invariant(value, `required ${k}`); return value; };
  invariant(["init", "run", "resume", "supervise", "objective", "episode", "reflection", "status", "receipt", "events", "job-reconcile", "integrate", "claims", "claim-revalidation-task", "claim-retract", "claim-adjudicate"].includes(cmd), "unknown swarm command");
  if (["init", "run", "resume", "supervise", "job-reconcile", "integrate", "claim-retract", "claim-adjudicate"].includes(cmd)) need("--allow-exec");
  const store = await Store.open(opts.get("--root") ?? resolve(".future-code", "swarm"));
  try {
    switch (cmd) {
      case "init": { const cfg = await initializeSwarm(store, file(need("--spec")), signal); return { initialized: true, root: store.root, baseCommit: cfg.baseCommit }; }
      case "run": return await runSwarm(store, file(need("--tasks")) as Task[], signal, undefined, undefined, onProgress);
      case "resume": return await runSwarm(store, [], signal, need("--run"), undefined, onProgress);
      case "supervise": {
        const goalPath = opts.get("--goal");
        if (goalPath) invariant(statSync(goalPath).size <= 16384, "goal file exceeds 16 KiB");
        return await superviseSwarm(store, { id: need("--objective"),
          ...(goalPath ? { goal: readFileSync(goalPath, "utf8") } : {}),
          ...(opts.has("--tasks") ? { tasks: file(need("--tasks")) as Task[] } : {}) }, signal, onProgress);
      }
      case "objective": return objectiveStatus(store, need("--objective"));
      case "episode": return readObjectiveEpisode(store, need("--objective"));
      case "reflection": return readLatestObjectiveReflection(store, need("--objective"));
      case "claims": return JSON.parse(canonical({ claims: claimsForGoals(store, need("--run"), [need("--task")], opts.get("--after")) }));
      case "claim-revalidation-task": return JSON.parse(canonical(claimRevalidationTask(store, need("--run"), need("--claim"))));
      case "claim-retract": return JSON.parse(canonical(retractClaim(store, need("--run"), need("--claim"), Number(need("--version")), need("--reason"))));
      case "claim-adjudicate": return JSON.parse(canonical(adjudicateClaim(store, need("--run"), need("--claim"), Number(need("--version")), need("--evidence"))));
      case "status": return swarmStatus(store, opts.get("--run"), opts.get("--task-after"));
      case "receipt": {
        const offset = Number(opts.get("--offset") ?? 0); const length = Number(opts.get("--length") ?? 4096);
        invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 16384, "invalid receipt slice");
        const text = Buffer.from(canonical(store.readArtifact(need("--hash"))));
        return { hash: need("--hash"), totalBytes: text.length, offset, content: text.subarray(offset, offset + length).toString("utf8"), nextOffset: offset + length < text.length ? offset + length : null };
      }
      case "events": { const items = new SessionJournal(store).page(need("--run"), need("--task"), Number(opts.get("--after") ?? 0)); return { items }; }
      case "job-reconcile": {
        const jobs = new ResearchJobs(new SessionJournal(store), loadSwarm(store));
        return jobs.reconcile(need("--run"), need("--job-key"), file(need("--resolution")) as JobReply);
      }
      case "integrate": return JSON.parse(JSON.stringify(await integrateSwarm(store, need("--run"), signal)));
      default: throw new Error("unreachable");
    }
  } finally { store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const c = new AbortController(); const stop = () => c.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
  handleSwarm(process.argv.slice(2), c.signal).then(value => {
    console.log(JSON.stringify(value, null, 2));
    if (c.signal.aborted) process.exitCode = 130;
    else if (value && typeof value === "object" && !Array.isArray(value) && "status" in value && value.status !== "PASS") process.exitCode = 2;
  }, e => { console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); process.exitCode = c.signal.aborted ? 130 : 1; })
    .finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
}
