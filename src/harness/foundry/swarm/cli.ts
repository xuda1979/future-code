import { researchStrategySnapshot } from "./researchStrategy.ts";
import { rebuildResearchAssignments } from "../researchAssignments.ts";
import { compareResearchStrategies, validateResearchComparison } from "../researchEvaluation.ts";
import { pinCommand } from "../commands.ts";
import { ResearchProgramme } from "../researchProgramme.ts";
import { formatHealth, type HealthObserver } from "../health.ts";
import { superviseSwarm, objectiveStatus } from "./supervisor.ts";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invariant, canonical } from "../kernel.ts";
import { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import { initializeSwarm, integrateSwarm, loadSwarm, runSwarm, swarmStatus } from "./host.ts";
import { ResearchJobs, type JobReply } from "./jobs.ts";
import { SessionJournal } from "./session.ts";
import { recommendExecutionLane } from "../productivityTheory.ts";
import { readObjectiveEpisode } from "../rndEpisodes.ts";
import { readLatestObjectiveReflection } from "../rndReflection.ts";
import { adjudicateClaim, claimsForGoals, claimRevalidationTask, retractClaim } from "../claims.ts";
import { readMemory, rebuildMemoryPage, type MemoryQuery } from "./memory.ts";
import type { ThreadState } from "./session.ts";
import { workflowObservation } from "../workflow.ts";
import { ProjectKnowledge, type KnowledgePack, type KnowledgePhase } from "./knowledge.ts";
import { humanKnowledgePack, readTeachingFile, type HumanInputKind } from "./humanKnowledge.ts";
import { handleOperations } from "../operations/cli.ts";
export const help = `Foundry Swarm: durable coding agents on the existing Foundry kernel
  operations help (durable project-neutral external service commands)
  init --spec FILE --allow-exec
  run --tasks FILE --allow-exec
  resume --run ID --allow-exec
  supervise --objective ID [--goal FILE --tasks FILE] --allow-exec
  objective --objective ID
  episode --objective ID
  research-strategy --run ID
  research-strategy-rebuild --run ID --allow-exec
  research-compare --spec FILE --allow-exec (matched local experiments with configured validators)
  knowledge [--finding ID --version HASH] [--task-after ID] [--limit N]
  knowledge-retract --finding ID --version HASH --reason TEXT --allow-exec
  knowledge-certificate --finding ID --version HASH [--limit N]
  knowledge-index-rebuild [--after CURSOR --limit N] --allow-exec
  experience [--hash CARD_ID] [--query TEXT --phase PHASE --after CURSOR --limit N]
  experience-import --spec PACK_JSON --allow-exec
  teach --file NOTE.md --id ID --kind request|skill|experience|knowledge --trigger TEXT --conditions TEXT [--source TEXT --tags TAG1,TAG2 --phase PHASE] --allow-exec
  experience-export --finding PACK_ID --hash CARD_ID
  experience-retire --hash CARD_ID --reason TEXT --allow-exec
  reflection --objective ID
  claims --run ID --task ID [--after CLAIM_ID]
  claim-revalidation-task --run ID --claim ID
  claim-retract --run ID --claim ID --version N --reason TEXT --allow-exec
  claim-adjudicate --run ID --claim ID --version N --evidence ID --allow-exec
  recommend --tasks FILE (advisory: direct vs supervised; no execution)
  status [--run ID] [--task-after TASK_ID]
  workflow --run ID [--task-after TASK_ID] [--limit N]
  receipt --hash HASH [--offset N] [--length N]
  events --run ID --task ID [--after N]
  memory --run ID --task ID [--memory-kind all|progress|failure] [--before CURSOR] [--patch HASH] [--failure-signature HASH] [--limit N]
  memory-rebuild --run ID --task ID [--after EVENT_SEQ] [--limit N]
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
  if (argv[0] === "operations") return handleOperations(argv.slice(1), signal);
  const cmd = argv[0] ?? "help"; if (cmd === "help") return { help };
  const opts = new Map<string, string>(); const allowed = new Set(["--root", "--spec", "--tasks", "--run", "--task", "--after", "--task-after", "--hash", "--offset", "--length", "--objective", "--goal", "--job-key", "--resolution", "--allow-exec", "--claim", "--version", "--reason", "--evidence", "--finding", "--memory-kind", "--before", "--patch", "--failure-signature", "--limit", "--query", "--phase", "--file", "--id", "--kind", "--trigger", "--conditions", "--source", "--tags"]);
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i]; invariant(allowed.has(k) && !opts.has(k), `unknown/duplicate option ${k}`);
    if (k === "--allow-exec") opts.set(k, "true");
    else { const v = argv[++i]; invariant(v && !v.startsWith("--"), `missing ${k}`); opts.set(k, v); }
  }
  const need = (k: string) => { const value = opts.get(k); invariant(value, `required ${k}`); return value; };
  invariant(["init", "run", "resume", "supervise", "objective", "episode", "reflection", "recommend", "status", "workflow", "receipt", "events", "memory", "memory-rebuild", "job-reconcile", "integrate", "claims", "claim-revalidation-task", "claim-retract", "claim-adjudicate", "knowledge", "knowledge-retract", "knowledge-certificate", "knowledge-index-rebuild", "research-strategy", "research-strategy-rebuild", "research-compare", "experience", "experience-import", "experience-export", "experience-retire", "teach"].includes(cmd), "unknown swarm command");
  if (["init", "run", "resume", "supervise", "job-reconcile", "integrate", "claim-retract", "claim-adjudicate", "knowledge-retract", "knowledge-index-rebuild", "research-strategy-rebuild", "research-compare", "experience-import", "experience-retire", "teach"].includes(cmd)) need("--allow-exec");
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
      case "research-strategy": return researchStrategySnapshot(store, loadSwarm(store), need("--run"));
      case "research-strategy-rebuild": {
        const cfg = loadSwarm(store); invariant(cfg.spec.researchStrategy, "research strategy not configured");
        rebuildResearchAssignments(store, need("--run"));
        return researchStrategySnapshot(store, cfg, need("--run"));
      }
      case "research-compare": {
        const protocol = file(need("--spec")); validateResearchComparison(protocol);
        const report = await compareResearchStrategies(protocol, pinCommand(protocol.executor, process.cwd()), signal);
        const reportHash = store.artifact(JSON.parse(canonical(report))); store.event("research.strategy.compared", { reportHash, protocolHash: report.protocolHash });
        return JSON.parse(canonical({ ...report, reportHash }));
      }
      case "knowledge": case "knowledge-retract": case "knowledge-certificate": case "knowledge-index-rebuild": {
        const cfg = loadSwarm(store); invariant(cfg.spec.researchProgramme, "research programme not configured");
        const programme = new ResearchProgramme(store, cfg.spec.researchProgramme);
        if (cmd === "knowledge-index-rebuild") return programme.rebuildProtocolIndex(
          Number(opts.get("--after") ?? 0), Number(opts.get("--limit") ?? 100));
        if (cmd === "knowledge-certificate") return programme.certificate(
          [{ id: need("--finding"), version: need("--version") }], Number(opts.get("--limit") ?? 128));
        if (cmd === "knowledge-retract") {
          programme.retract({ id: need("--finding"), version: need("--version") }, need("--reason")); return { retracted: true };
        }
        return opts.has("--finding") ? JSON.parse(canonical(programme.read({ id: need("--finding"), version: need("--version") }, true))) :
          programme.list(opts.get("--task-after"), Number(opts.get("--limit") ?? 20));
      }
      case "teach": case "experience": case "experience-import": case "experience-export": case "experience-retire": {
        const knowledge = new ProjectKnowledge(store, loadSwarm(store));
        if (cmd === "teach") {
          const path = need("--file");
          const pack = humanKnowledgePack({ id: need("--id"), kind: need("--kind") as HumanInputKind,
            source: opts.get("--source") ?? basename(path), trigger: need("--trigger"), conditions: need("--conditions"),
            phase: (opts.get("--phase") ?? "any") as KnowledgePhase,
            tags: opts.has("--tags") ? need("--tags").split(",").map(tag => tag.trim()) : [], text: readTeachingFile(path) });
          return knowledge.importPack(pack);
        }
        if (cmd === "experience-import") return knowledge.importPack(file(need("--spec")) as KnowledgePack);
        if (cmd === "experience-export") return JSON.parse(canonical(knowledge.exportPack(need("--finding"), [need("--hash")])));
        if (cmd === "experience-retire") { knowledge.retire(need("--hash"), need("--reason")); return { retired: true }; }
        if (opts.has("--hash")) return knowledge.get(undefined, need("--hash"));
        return knowledge.search(undefined, {
          ...(opts.has("--query") ? { query: need("--query") } : {}),
          ...(opts.has("--phase") ? { phase: need("--phase") as KnowledgePhase } : {}),
          after: Number(opts.get("--after") ?? 0), limit: Number(opts.get("--limit") ?? 5),
        });
      }
      case "recommend": {
        const tasks = file(need("--tasks")) as Task[];
        const cfg = loadSwarm(store);
        return JSON.parse(canonical(recommendExecutionLane(tasks, cfg.spec)));
      }
      case "status": return swarmStatus(store, opts.get("--run"), opts.get("--task-after"));
      case "workflow": return store.transaction(() => workflowObservation(store, need("--run"), {
        after: opts.get("--task-after"), limit: opts.has("--limit") ? Number(opts.get("--limit")) : undefined,
      }));
      case "receipt": {
        const offset = Number(opts.get("--offset") ?? 0); const length = Number(opts.get("--length") ?? 4096);
        invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 16384, "invalid receipt slice");
        const text = Buffer.from(canonical(store.readArtifact(need("--hash"))));
        return { hash: need("--hash"), totalBytes: text.length, offset, content: text.subarray(offset, offset + length).toString("utf8"), nextOffset: offset + length < text.length ? offset + length : null };
      }
      case "events": { const items = new SessionJournal(store).page(need("--run"), need("--task"), Number(opts.get("--after") ?? 0)); return { items }; }
      case "memory": {
        new SessionJournal(store);
        const run = need("--run"), task = need("--task");
        const row = store.db.prepare("SELECT state FROM agent_threads WHERE run=? AND task=?").get(run, task);
        const state = row ? store.readArtifact(row.state) as unknown as ThreadState : undefined;
        return JSON.parse(canonical(readMemory(store, { runId: run, task: { id: task } }, {
          kind: (opts.get("--memory-kind") ?? "all") as MemoryQuery["kind"], before: opts.get("--before"),
          patchHash: opts.get("--patch"), failureSignature: opts.get("--failure-signature"),
          limit: opts.has("--limit") ? Number(opts.get("--limit")) : undefined,
        }, state)));
      }
      case "memory-rebuild": {
        new SessionJournal(store);
        return rebuildMemoryPage(store, need("--run"), need("--task"), Number(opts.get("--after") ?? 0), Number(opts.get("--limit") ?? 100));
      }
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
