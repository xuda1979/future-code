import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPins } from "../commands.ts";
import { invariant } from "../kernel.ts";
import type { PinnedCommand } from "../types.ts";
export interface ProcessResult { code: number; stdout: string; stderr: string }
/** A bounded process group, NOT a security sandbox. Executables are trusted. */
export async function runProcess(command: PinnedCommand, cwd: string, args: string[], signal: AbortSignal,
  timeoutMs: number, maxBytes: number, input?: string): Promise<ProcessResult> {
  checkPins(command); signal.throwIfAborted();
  if (process.platform === "win32") throw new Error("Local worktree backend currently requires POSIX process groups");
  const home = mkdtempSync(join(tmpdir(), "future-swarm-home-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, TMP: home, TEMP: home,
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const name of command.envAllow ?? []) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  try { return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command.argv[0], [...command.argv.slice(1), ...args], { cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let error: Error | null = null; let size = 0; const out: Buffer[] = []; const err: Buffer[] = [];
    const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const abort = () => { error = new Error("process cancelled"); kill(); };
    const timer = setTimeout(() => { error = new Error("process deadline exceeded"); kill(); }, timeoutMs);
    const collect = (buf: Buffer, list: Buffer[]) => {
      size += buf.length;
      if (size > maxBytes) { error = new Error("process output exceeded budget"); kill(); }
      else list.push(Buffer.from(buf));
    };
    child.stdout.on("data", b => collect(b, out)); child.stderr.on("data", b => collect(b, err));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    child.on("error", e => { error = e; });
    child.stdin.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") { error = e; kill(); } });
    child.on("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) return reject(error);
      try { invariant(Number.isInteger(code), "process exited without status");
        resolve({ code: code!, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      } catch (e) { reject(e); }
    });
    child.stdin.end(input);
  }); } finally { rmSync(home, { recursive: true, force: true }); }
}
