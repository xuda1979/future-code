import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { canonical, digest, invariant } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Capsule, Json, Task, Verification } from "../types.ts";
import type { Store } from "../store.ts";
import { inScope, keys, safePath, type AgentProfile, type PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import type { PatchArtifact } from "./session.ts";
import { runProcess, type ProcessResult } from "./process.ts";

/** Scope checks are a correctness boundary, not containment for hostile code.
 * Use a VM/container backend before granting tools to untrusted projects. */
export interface Hands {
  tool(call: Call): Promise<Json>;
  snapshot(): Promise<string>;
  dispose(): Promise<void>;
}
export async function git(cfg: PinnedSwarm, cwd: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  const result = await runProcess(cfg.git, cwd, ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", ...args], signal, cfg.spec.budget.toolTimeoutMs, Math.max(cfg.spec.budget.maxPatchBytes * 2, cfg.spec.budget.maxToolOutputBytes), input);
  invariant(result.code === 0, `git ${args[0]} failed: ${result.stderr.slice(-1000)}`);
  return result.stdout;
}
export function orderedTasks(store: Store, run: string, roots?: string[]): Task[] {
  if (roots?.length === 0) return [];
  // Independent workers must not scan a 100k-node graph to discover zero parents.
  // Ancestor queries scale with the needed closure, not the whole run.
  const rows = roots === undefined ? store.db.prepare("SELECT id,spec,status,artifact FROM tasks WHERE run=?").all(run) : [];
  const one = store.db.prepare("SELECT id,spec,status,artifact FROM tasks WHERE run=? AND id=?");
  const all = new Map(rows.map(r => [r.id, r])); const needed = new Set<string>(); const todo = roots ? [...roots] : rows.map(r => r.id);
  for (let i = 0; i < todo.length; i++) {
    const id = todo[i]; if (needed.has(id)) continue;
    const row = all.get(id) ?? one.get(run, id); invariant(row?.status === "PASS" && row.artifact, `unverified patch dependency ${id}`);
    all.set(id, row); needed.add(id); todo.push(...(JSON.parse(row.spec) as Task).dependencies);
  }
  const degrees = new Map<string, number>(); const children = new Map<string, string[]>();
  for (const id of needed) {
    const task: Task = JSON.parse(all.get(id)!.spec); degrees.set(id, task.dependencies.length);
    for (const dep of task.dependencies) { const list = children.get(dep) ?? []; list.push(id); children.set(dep, list); }
  }
  const ready = [...needed].filter(id => degrees.get(id) === 0).sort(); const result: Task[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]; result.push(JSON.parse(all.get(id)!.spec));
    for (const child of children.get(id) ?? []) { const n = degrees.get(child)! - 1; degrees.set(child, n); if (!n) ready.push(child); }
  }
  invariant(result.length === needed.size, "invalid patch dependency graph"); return result;
}
export function patchText(store: Store, hash: string, limit: number): string {
  const patch = store.readArtifact(hash); invariant(typeof patch === "string" && Buffer.byteLength(patch) <= limit, "invalid/oversized patch receipt"); return patch;
}
export function readPatchArtifact(store: Store, run: string, id: string): PatchArtifact {
  const row = store.db.prepare("SELECT status,artifact FROM tasks WHERE run=? AND id=?").get(run, id);
  invariant(row?.status === "PASS", "dependency not accepted");
  const artifact = store.readArtifact(row.artifact) as unknown as PatchArtifact;
  invariant(artifact?.schema === 1 && typeof artifact.patchHash === "string", "dependency is not a swarm patch"); return artifact;
}
export class LocalGitHands implements Hands {
  private temp: string | null = null;
  private path: string | null = null;
  private baseTree: string | null = null;
  readonly store: Store; readonly cfg: PinnedSwarm; readonly c: Capsule; readonly profile: AgentProfile;
  readonly signal: AbortSignal; readonly restore: string | null; readonly roots: string[];
  constructor(store: Store, cfg: PinnedSwarm, c: Capsule, profile: AgentProfile,
    signal: AbortSignal, restore: string | null = null, roots: string[] = c.task.dependencies) {
    this.store = store; this.cfg = cfg; this.c = c; this.profile = profile; this.signal = signal; this.restore = restore; this.roots = roots;
  }
  async ready(): Promise<string> {
    this.signal.throwIfAborted(); if (this.path) return this.path;
    const temp = mkdtempSync(join(tmpdir(), "future-swarm-worktree-")); this.temp = temp;
    const path = join(temp, "tree");
    await git(this.cfg, this.cfg.spec.project, ["worktree", "add", "--detach", path, this.cfg.baseCommit], this.signal);
    this.path = path;
    for (const task of orderedTasks(this.store, this.c.runId, this.roots)) {
      const artifact = readPatchArtifact(this.store, this.c.runId, task.id);
      const patch = patchText(this.store, artifact.patchHash, this.cfg.spec.budget.maxPatchBytes);
      if (patch) await git(this.cfg, path, ["apply", "--index", "--whitespace=nowarn", "-"], this.signal, patch);
    }
    this.baseTree = (await git(this.cfg, path, ["write-tree"], this.signal)).trim();
    if (this.restore) {
      const patch = patchText(this.store, this.restore, this.cfg.spec.budget.maxPatchBytes);
      if (patch) await git(this.cfg, path, ["apply", "--index", "--whitespace=nowarn", "-"], this.signal, patch);
    }
    return path;
  }
  private async pathFor(path: string, write: boolean): Promise<string> {
    safePath(path);
    const scopes = write ? this.c.task.writeScope : [...this.c.task.writeScope, ...(this.c.task.readScope ?? [])];
    invariant(inScope(path, scopes), "path outside task scope");
    if (write) invariant(!inScope(path, this.cfg.spec.protectedPaths), "protected path");
    const root = await this.ready(); const parts = path.split("/"); let current = root;
    for (const part of parts) {
      current = join(current, part);
      try { invariant(!lstatSync(current).isSymbolicLink(), "symlink access forbidden"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return join(root, path);
  }
  private read(path: string): string {
    const stat = lstatSync(path); invariant(stat.isFile() && stat.size <= this.cfg.spec.budget.maxToolOutputBytes, "file too large or not regular");
    const buffer = readFileSync(path); invariant(!buffer.includes(0), "binary file not supported by text tools");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
  async tool(call: Call): Promise<Json> {
    this.signal.throwIfAborted(); invariant(this.profile.tools.includes(call.name as any), "tool not permitted for this agent");
    const a = call.arguments;
    switch (call.name) {
      case "list_files": {
        keys(a, [], ["offset", "limit"]); const offset = a.offset ?? 0; const limit = a.limit ?? 100;
        invariant(Number.isSafeInteger(offset) && (offset as number) >= 0 && Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= 200, "invalid listing range");
        const path = await this.ready();
        const names = (await git(this.cfg, path, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], this.signal)).split("\0").filter(Boolean);
        const files = [...new Set(names)].filter(p => inScope(p, [...this.c.task.writeScope, ...(this.c.task.readScope ?? [])])).sort();
        return { files: files.slice(offset as number, (offset as number) + (limit as number)), total: files.length };
      }
      case "read_file": {
        keys(a, ["path"], ["start", "lines"]); const start = a.start ?? 1; const count = a.lines ?? 100;
        invariant(Number.isSafeInteger(start) && (start as number) > 0 && Number.isSafeInteger(count) && (count as number) > 0 && (count as number) <= 300, "invalid line range");
        const text = this.read(await this.pathFor(a.path as string, false)); const lines = text.split("\n");
        return { path: a.path, start, totalLines: lines.length, content: lines.slice((start as number) - 1, (start as number) - 1 + (count as number)).join("\n") };
      }
      case "write_file": case "edit_file": {
        keys(a, call.name === "write_file" ? ["path", "content"] : ["path", "oldText", "newText"]);
        const path = await this.pathFor(a.path as string, true); let content: string;
        if (call.name === "write_file") { invariant(typeof a.content === "string", "content must be text"); content = a.content; }
        else {
          invariant(typeof a.oldText === "string" && a.oldText.length > 0 && typeof a.newText === "string", "invalid literal edit");
          content = this.read(path); const at = content.indexOf(a.oldText);
          invariant(at >= 0 && content.indexOf(a.oldText, at + 1) === -1, "edit requires exactly one match");
          content = content.slice(0, at) + a.newText + content.slice(at + a.oldText.length);
        }
        invariant(!content.includes("\0") && Buffer.byteLength(content) <= this.cfg.spec.budget.maxToolOutputBytes, "file exceeds text budget");
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8");
        // Explicitly include permitted files even if .gitignore would hide them.
        await git(this.cfg, await this.ready(), ["add", "-f", "--", a.path as string], this.signal);
        return { path: a.path, bytes: Buffer.byteLength(content), changed: true };
      }
      case "delete_file": {
        keys(a, ["path"]); const path = await this.pathFor(a.path as string, true); invariant(lstatSync(path).isFile(), "not a regular file"); unlinkSync(path); return { path: a.path, deleted: true };
      }
      case "run_check": {
        keys(a, ["name"]); invariant(typeof a.name === "string" && this.profile.checks.includes(a.name), "check not permitted");
        return JSON.parse(canonical(await this.check(a.name)));
      }
      default: throw new Error("unknown filesystem tool");
    }
  }
  async check(name: string): Promise<ProcessResult> {
    const command = this.cfg.checks[name]; invariant(command, "unknown check");
    return runProcess(command, await this.ready(), [], this.signal, this.cfg.spec.budget.toolTimeoutMs, this.cfg.spec.budget.maxToolOutputBytes);
  }
  async tree(): Promise<string> {
    const path = await this.ready(); await git(this.cfg, path, ["add", "-A", "--", "."], this.signal);
    return (await git(this.cfg, path, ["write-tree"], this.signal)).trim();
  }
  async snapshot(): Promise<string> {
    const path = await this.ready(); await this.tree();
    const names = (await git(this.cfg, path, ["diff", "--cached", "--no-renames", "--name-only", "-z", this.baseTree!], this.signal)).split("\0").filter(Boolean);
    for (const name of names) {
      safePath(name); invariant(inScope(name, this.c.task.writeScope) && !inScope(name, this.cfg.spec.protectedPaths), `patch scope violation: ${name}`);
      // A trusted check could have created a symlink; never accept it silently.
      try { invariant(!lstatSync(join(path, name)).isSymbolicLink(), "symlink patch forbidden"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const patch = await git(this.cfg, path, ["diff", "--cached", "--no-ext-diff", "--no-renames", "--binary", this.baseTree!], this.signal);
    invariant(Buffer.byteLength(patch) <= this.cfg.spec.budget.maxPatchBytes, "patch exceeds budget"); return this.store.artifact(patch);
  }
  async dispose(): Promise<void> {
    if (!this.temp) return;
    const temp = this.temp; const path = this.path; this.temp = null; this.path = null;
    if (path) try { await git(this.cfg, this.cfg.spec.project, ["worktree", "remove", "--force", path], AbortSignal.timeout(10000)); }
    catch { /* Preserve an orphan for inspection; never clean the user's checkout. */ return; }
    rmSync(temp, { recursive: true, force: true });
  }
}
export async function verifyPatch(store: Store, cfg: PinnedSwarm, c: Capsule, artifact: Json, signal: AbortSignal): Promise<Verification> {
  const result = artifact as unknown as PatchArtifact;
  invariant(result?.schema === 1 && typeof result.patchHash === "string", "invalid patch artifact");
  const profile = cfg.spec.agents[c.task.agent ?? cfg.spec.defaultAgent];
  const hands = new LocalGitHands(store, cfg, c, profile, signal, result.patchHash);
  const checks: Verification["checks"] = []; const details: unknown[] = [];
  try {
    // Reconstruct independently, then compare the exact delta and its scope.
    invariant(await hands.snapshot() === result.patchHash, "candidate patch is not a canonical scoped delta");
    checks.push({ id: "scope", verdict: "PASS" }); const before = await hands.tree(); let good = true;
    for (const name of profile.checks) {
      const log = await hands.check(name); details.push({ name, ...log }); if (log.code !== 0) good = false;
    }
    if (await hands.tree() !== before) { good = false; details.push({ error: "verifier mutated tracked source" }); }
    const receipt = store.artifact(JSON.parse(canonical(details)));
    checks.push({ id: "behavior", verdict: good ? "PASS" : "FAIL", detail: receipt });
  } catch (e) {
    signal.throwIfAborted(); checks.push({ id: checks.length ? "behavior" : "scope", verdict: "FAIL", detail: e instanceof Error ? e.message.slice(0, 2000) : "verification error" });
  } finally { await hands.dispose(); }
  return { artifactHash: digest(artifact), checks, measurement: { tokens: 0, costUsd: 0 } };
}

/** Trusted host injection point. Remote/container backends must implement BOTH
 * execution and independent verification, with their identity pinned in cfg. */
export interface HandsBackend {
  id: string;
  open(store: Store, cfg: PinnedSwarm, c: Capsule, profile: AgentProfile, signal: AbortSignal, restore: string | null): Hands;
  verify(store: Store, cfg: PinnedSwarm, c: Capsule, artifact: Json, signal: AbortSignal): Promise<Verification>;
}
export const localGitBackend: HandsBackend = {
  id: "local-git-posix-v1",
  open: (store, cfg, c, profile, signal, restore) => new LocalGitHands(store, cfg, c, profile, signal, restore),
  verify: verifyPatch,
};
