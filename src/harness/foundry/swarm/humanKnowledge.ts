import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { digest, identifier, invariant, sha256 } from "../kernel.ts";
import { validateKnowledgePack, type KnowledgePack, type KnowledgePhase } from "./knowledge.ts";

export const HUMAN_INPUT_KINDS = ["request", "skill", "experience", "knowledge"] as const;
export type HumanInputKind = typeof HUMAN_INPUT_KINDS[number];
export interface HumanKnowledgeInput {
  id: string;
  kind: HumanInputKind;
  source: string;
  trigger: string;
  conditions: string;
  text: string;
  phase?: KnowledgePhase;
  tags?: string[];
}
const MAX_DOCUMENT_BYTES = 64 * 1024;

/** Import is a bounded text read. Frontmatter, hooks, shell substitutions and
 * linked resources are never interpreted, executed or fetched by this path. */
export function readTeachingFile(path: string): string {
  // Nonblocking open lets the regular-file check reject FIFOs without hanging.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    invariant(stat.isFile(), "teaching input must be a regular file");
    invariant(stat.size <= MAX_DOCUMENT_BYTES, "teaching file exceeds 64 KiB");
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    invariant(length <= MAX_DOCUMENT_BYTES, "teaching file exceeds 64 KiB");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error("teaching file must be valid UTF-8"); }
    invariant(!text.includes("\0"), "teaching file contains NUL");
    return text;
  } finally { closeSync(fd); }
}

/** Adapt human Markdown/plain text to the existing immutable seed lifecycle.
 * No second memory store, model summarizer, tool grant or acceptance authority. */
export function humanKnowledgePack(input: HumanKnowledgeInput): KnowledgePack {
  identifier(input.id);
  invariant(HUMAN_INPUT_KINDS.includes(input.kind), "invalid human input kind");
  invariant(typeof input.source === "string" && !!input.source.trim(), "teaching source is required");
  invariant(typeof input.text === "string" && !!input.text.trim() && Buffer.byteLength(input.text) <= MAX_DOCUMENT_BYTES,
    "invalid teaching text; expected 1..65536 UTF-8 bytes");
  invariant(Buffer.from(input.text, "utf8").toString("utf8") === input.text, "teaching text must be valid UTF-8");
  invariant(!input.text.includes("\0"), "teaching text contains NUL");
  invariant(input.tags === undefined || Array.isArray(input.tags) && input.tags.length <= 10, "too many teaching tags");
  const metadata = { id: input.id, kind: input.kind, source: input.source, trigger: input.trigger,
    conditions: input.conditions, phase: input.phase ?? "any", tags: input.tags ?? [] };
  // The retrieval tag binds metadata AND text so parts of different versions
  // cannot be accidentally combined. The full document hash retains provenance.
  const tag = `doc-${digest({ ...metadata, text: input.text }).slice(0, 56)}`;
  const chunks: string[] = []; let chunk = "", size = 0;
  for (const character of input.text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > 1536) { chunks.push(chunk); chunk = ""; size = 0; }
    chunk += character; size += bytes;
  }
  if (chunk) chunks.push(chunk);
  const pack: KnowledgePack = { schema: 1, id: input.id,
    source: `human:${input.kind}; sha256:${sha256(input.text)}; ${input.source}`,
    entries: chunks.map((body, i) => ({ id: `${input.kind}-part-${i + 1}-of-${chunks.length}`,
      kind: input.kind === "skill" ? "procedure" : input.kind === "request" ? "constraint" : "reference",
      trigger: input.trigger, conditions: input.conditions, phase: metadata.phase,
      tags: [tag, `human-${input.kind}`, ...metadata.tags],
      lesson: `Human ${input.kind}, part ${i + 1}/${chunks.length}. Read every part in order: read_knowledge({"query":"${tag}"}); follow nextAfter.\n${body}` })) };
  validateKnowledgePack(pack); return pack;
}
