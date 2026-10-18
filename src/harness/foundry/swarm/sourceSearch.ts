import { canonical, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import { inScope, keys, safePath } from "./config.ts";
import { closeSync, openSync, readSync } from "node:fs";
import { performance } from "node:perf_hooks";

/** Limit the read itself even if a file grows after its size was checked. */
export function readSearchFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = []; let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(16384, maxBytes + 1 - size));
      const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
      chunks.push(buffer.subarray(0, n)); size += n;
    }
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}

export interface SearchCursor { path: string; line: number }
export interface SourceSearch {
  query: string; path?: string; limit?: number; cursor?: SearchCursor; contextLines?: number;
}
/** A cursor is an inclusive source location, not authority or a snapshot.
 * Callers must restart pagination after editing or replacing the workspace. */
export function validateSourceSearch(args: Record<string, Json>, scopes: string[]): SourceSearch {
  keys(args, ["query"], ["path", "limit", "cursor", "contextLines"]);
  invariant(typeof args.query === "string" && args.query.length > 0 &&
    Buffer.byteLength(args.query) <= 256 && Buffer.from(args.query).toString("utf8") === args.query &&
    !/[\0\r\n]/.test(args.query), "invalid search query (single-line literal, 1..256 UTF-8 bytes)");
  invariant(args.limit === undefined || (Number.isSafeInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 100), "invalid search limit");
  invariant(args.contextLines === undefined || (Number.isSafeInteger(args.contextLines) && (args.contextLines as number) >= 0 &&
    (args.contextLines as number) <= 20), "invalid search contextLines");
  if (args.path !== undefined) {
    safePath(args.path as string);
    invariant(inScope(args.path as string, scopes) || scopes.some(scope => inScope(scope, [args.path as string])), "search path outside task authority");
  }
  if (args.cursor !== undefined) {
    keys(args.cursor as object, ["path", "line"]);
    const cursor = args.cursor as unknown as SearchCursor; safePath(cursor.path);
    invariant(inScope(cursor.path, scopes) && (args.path === undefined || inScope(cursor.path, [args.path as string])), "search cursor outside task authority");
    invariant(Number.isSafeInteger(cursor.line) && cursor.line > 0, "invalid search cursor line");
  }
  return args as unknown as SourceSearch;
}

const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
interface SourceContext { startLine: number; endLine: number; content: string; truncated: boolean }
/** Reuse the already scoped, bounded file read. Whole adjacent lines fit first;
 * a huge matching line falls back to its Unicode-safe hit excerpt. */
function sourceContext(lines: string[], index: number, radius: number, excerpt: string, maxBytes: number): SourceContext {
  const desiredStart = Math.max(0, index - radius), desiredEnd = Math.min(lines.length, index + radius + 1);
  let start = index, end = index + 1, size = Buffer.byteLength(lines[index]);
  if (size > maxBytes) {
    const data = Buffer.from(excerpt); let length = Math.min(data.length, maxBytes);
    while (length > 0 && length < data.length && (data[length] & 0xc0) === 0x80) length--;
    return { startLine: start + 1, endLine: end, content: data.toString("utf8", 0, length), truncated: true };
  }
  let before = true, after = true;
  for (let distance = 1; distance <= radius; distance++) {
    const left = index - distance, right = index + distance;
    if (before && left >= desiredStart) {
      const bytes = Buffer.byteLength(lines[left]) + 1;
      if (size + bytes <= maxBytes) { start = left; size += bytes; } else before = false;
    }
    if (after && right < desiredEnd) {
      const bytes = Buffer.byteLength(lines[right]) + 1;
      if (size + bytes <= maxBytes) { end = right + 1; size += bytes; } else after = false;
    }
  }
  return { startLine: start + 1, endLine: end, content: lines.slice(start, end).join("\n"),
    truncated: start > desiredStart || end < desiredEnd };
}
/** Bounded literal search over a Git inventory. I/O callbacks enforce file size,
 * UTF-8 and symlink rules. Skip counts and continuation prevent false negatives
 * from being presented as an exhaustive scan. No check or PASS is produced. */
export async function searchSource(args: SourceSearch, inventory: string[], scopes: string[], maxOutputBytes: number,
  read: (path: string, maxBytes: number) => Promise<Buffer>, signal: AbortSignal, timeoutMs: number): Promise<Json> {
  const files = [...new Set(inventory)].filter(path => inScope(path, scopes) &&
    (args.path === undefined || inScope(path, [args.path]))).sort(compare);
  const maxFileBytes = Math.min(maxOutputBytes, 1024 * 1024), maxReadBytes = Math.min(8 * 1024 * 1024, maxFileBytes * 64);
  const deadline = performance.now() + timeoutMs;
  const result = { matches: [] as { path: string; line: number; text: string; truncated: boolean; context?: SourceContext }[],
    nextCursor: null as SearchCursor | null, scannedFiles: 0, skippedFiles: 0, bytesRead: 0 };
  const finish = (cursor: SearchCursor | null): Json => {
    result.nextCursor = cursor;
    invariant(Buffer.byteLength(canonical(result)) <= maxOutputBytes, "search response exceeds output budget");
    return result as unknown as Json;
  };
  for (const path of files) {
    signal.throwIfAborted();
    if (args.cursor && compare(path, args.cursor.path) < 0) continue;
    const start = args.cursor?.path === path ? args.cursor.line : 1;
    // Reserve the bounded length guard as well, including files that grew.
    if (result.scannedFiles >= 256 || result.bytesRead + maxFileBytes + 1 > maxReadBytes || performance.now() >= deadline)
      return finish({ path, line: start });
    result.scannedFiles++;
    let text: string;
    try {
      safePath(path);
      const data = await read(path, maxFileBytes);
      result.bytesRead += data.length;
      invariant(data.length <= maxFileBytes, "search file exceeds byte budget");
      invariant(!data.includes(0), "binary search input");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch { signal.throwIfAborted(); result.skippedFiles++; continue; }
    const lines = text.split("\n");
    for (let i = start - 1; i < lines.length; i++) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) return finish({ path, line: i + 1 });
      const at = lines[i].indexOf(args.query); if (at < 0) continue;
      // Clip context around the first literal hit, preserving Unicode scalars.
      const before = Array.from(lines[i].slice(0, at)).slice(-40).join("");
      const after = Array.from(lines[i].slice(at + args.query.length)).slice(0, 80).join("");
      const excerpt = before + args.query + after;
      result.matches.push({ path, line: i + 1, text: excerpt, truncated: excerpt !== lines[i],
        ...(args.contextLines ? { context: sourceContext(lines, i, args.contextLines, excerpt,
          Math.max(0, Math.min(8192, Math.floor(maxOutputBytes / 2) - 512))) } : {}) });
      // Include cursor/metadata and leave headroom for subsequent skip counters.
      if (result.matches.length > (args.limit ?? 20) || Buffer.byteLength(canonical({ ...result,
        nextCursor: { path, line: i + 1 } })) + 64 > maxOutputBytes) {
        result.matches.pop();
        invariant(result.matches.length > 0, "search output budget cannot fit one match; narrow the path or increase the configured output budget");
        return finish({ path, line: i + 1 });
      }
    }
  }
  return finish(null);
}
