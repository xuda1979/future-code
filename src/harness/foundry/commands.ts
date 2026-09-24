import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonical, digest, invariant, sha256 } from "./kernel.ts";
import type { AttemptControl, Capsule, CommandSpec, Driver, PinnedCommand, Verification, WorkerResult } from "./types.ts";

export function pinCommand(spec: CommandSpec, base: string): PinnedCommand {
  invariant(Array.isArray(spec.argv) && spec.argv.length > 0 && spec.argv.every(s => typeof s === "string" && !s.includes("\0")), "invalid command argv");
  const argv = spec.argv.map(arg => arg === "$RUNTIME" ? process.execPath : arg.startsWith("./") || isAbsolute(arg) ? resolve(base, arg) : arg)
    .map(arg => isAbsolute(arg) && existsSync(arg) ? realpathSync(arg) : arg);
  invariant(isAbsolute(argv[0]), "use $RUNTIME or an absolute executable path; do not rely on PATH resolution");
  const files = [...new Set([argv[0], ...argv.slice(1).filter(p => isAbsolute(p) && existsSync(p) && statSync(p).isFile()), ...(spec.files ?? []).map(p => resolve(base, p))])];
  const pins = files.map(p => ({ path: realpathSync(p), hash: sha256(readFileSync(p)) }));
  const envAllow = spec.envAllow ?? [];
  invariant(envAllow.every(s => /^[A-Z_][A-Z0-9_]*$/.test(s)), "invalid environment capability");
  // Loader and process-control variables would defeat implementation pinning.
  invariant(!envAllow.some(s => /^(NODE_OPTIONS|BUN_OPTIONS|LD_|DYLD_|PYTHONPATH)/.test(s)), "unsafe loader environment capability");
  return { argv, envAllow, files: files.map(p => realpathSync(p)), pins };
}
const verifiedPins = new Map<string, { stat: string; hash: string }>();
export function checkPins(command: PinnedCommand): void {
  invariant(command.pins.length > 0 && command.pins.some(p => p.path === realpathSync(command.argv[0])), "executable must be pinned");
  for (const pin of command.pins) {
    const st = statSync(pin.path, { bigint: true });
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const previous = verifiedPins.get(pin.path);
    // Avoid re-hashing a large runtime binary on every short worker episode.
    // A changed file identity or timestamp always causes a full hash check.
    if (previous?.stat === stamp && previous.hash === pin.hash) continue;
    invariant(sha256(readFileSync(pin.path)) === pin.hash, `command implementation changed: ${pin.path}`);
    verifiedPins.set(pin.path, { stat: stamp, hash: pin.hash });
  }
}
export function commandVerifierId(command: PinnedCommand): string { return digest(command); }

/** Non-shell, bounded subprocess adapter. Private cwd is NOT an OS sandbox. */
export async function invoke(command: PinnedCommand, input: unknown, maxBytes: number, signal: AbortSignal, control?: AttemptControl): Promise<unknown> {
  checkPins(command);
  invariant(!signal.aborted, "command cancelled");
  const payload = canonical(input);
  const cwd = mkdtempSync(join(tmpdir(), "future-foundry-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: cwd, TMPDIR: cwd, TEMP: cwd, TMP: cwd };
  for (const key of command.envAllow ?? []) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  // Needed by native Windows process creation, but do not inherit API keys.
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let failure: Error | null = null; let settled = false;
      const decoder = new StringDecoder("utf8"); let progressBuffer = "";
      const reportProgress = (chunk: Buffer, final = false) => {
        if (!control) return;
        progressBuffer += final ? decoder.end() : decoder.write(chunk);
        const lines = progressBuffer.split("\n"); progressBuffer = lines.pop()!;
        if (final && progressBuffer) { lines.push(progressBuffer); progressBuffer = ""; }
        for (const line of lines) {
          if (!line.startsWith("FUTURE_CODE_PROGRESS ")) continue;
          invariant(Buffer.byteLength(line, "utf8") <= 1024, "progress record exceeds byte budget");
          const record = JSON.parse(line.slice("FUTURE_CODE_PROGRESS ".length));
          invariant(record && typeof record.fingerprint === "string" && record.fingerprint.length > 0 &&
            Buffer.byteLength(record.fingerprint, "utf8") <= 256, "invalid progress record");
          control.progress(record.fingerprint);
        }
      };
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill("SIGKILL"));
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const abort = () => { failure = new Error("command cancelled or timed out"); kill(); };
      const collect = (chunk: Buffer, out: boolean) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { failure = new Error("command output exceeded byte budget"); kill(); return; }
        (out ? stdout : stderr).push(Buffer.from(chunk));
        // Progress still counts against the SAME aggregate output budget.
        if (!out) try { reportProgress(chunk); }
        catch (e) { failure = e instanceof Error ? e : new Error(String(e)); kill(); }
      };
      child.stdout.on("data", c => collect(c, true)); child.stderr.on("data", c => collect(c, false));
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      const done = (error: Error | null, value?: unknown) => {
        if (settled) return; settled = true; signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolvePromise(value);
      };
      child.on("error", e => done(e));
      child.stdin.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") { failure = e; kill(); } });
      child.on("close", code => {
        if (!failure) try { reportProgress(Buffer.alloc(0), true); }
        catch (e) { failure = e instanceof Error ? e : new Error(String(e)); }
        if (failure) return done(failure);
        if (code !== 0) return done(new Error(`command exit ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-4096)}`));
        try { done(null, JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
        catch { done(new Error("command must emit exactly one JSON object; empty output is not PASS")); }
      });
      child.stdin.end(payload);
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

export class CommandDriver implements Driver {
  readonly verifierId: string;
  readonly workerId: string;
  readonly worker: PinnedCommand;
  readonly checker: PinnedCommand;
  readonly maxBytes: number;
  constructor(worker: PinnedCommand, checker: PinnedCommand, maxBytes: number) {
    this.worker = worker; this.checker = checker; this.maxBytes = maxBytes;
    this.verifierId = commandVerifierId(checker); this.workerId = digest(worker);
  }
  async execute(capsule: Capsule, signal: AbortSignal, control?: AttemptControl): Promise<WorkerResult> {
    const value = await invoke(this.worker, { kind: "execute", capsule }, this.maxBytes, signal, control) as WorkerResult;
    invariant(value && Object.hasOwn(value, "artifact"), "missing worker artifact");
    canonical(value.artifact);
    // Ignore usage reported by the child. A trusted provider adapter must meter
    // tokens and money separately; zero is not a substitute for missing data.
    return { artifact: value.artifact, measurement: { tokens: null, costUsd: null } };
  }
  async verify(capsule: Capsule, result: WorkerResult, signal: AbortSignal, control?: AttemptControl): Promise<Verification> {
    const value = await invoke(this.checker, { kind: "verify", capsule, artifact: result.artifact, artifactHash: digest(result.artifact) }, this.maxBytes, signal, control) as Verification;
    invariant(value && Array.isArray(value.checks), "missing verifier evidence");
    return { artifactHash: value.artifactHash, checks: value.checks, measurement: { tokens: null, costUsd: null } };
  }
}
