/**
 * Bounded evidence export and diagnostic views. NOT a remote trust protocol.
 *
 * The receiver needs an authenticated expected digest or a trusted verifier
 * channel. A hash inside an attacker-controlled message does not authenticate
 * that message. Compression is transport-only; it never changes the semantic
 * certificate records. The research TCP receiver is an instrumented loopback
 * collector, not a deployment server.
 *
 * Ported from ichact/exposure.py (Adaptive HACT v4.0.0). The binary wire format
 * and JSON-lines packet layout are reproduced so archives produced here can be
 * decoded by the reference implementation and vice versa.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const MAGIC = 'HACTV4\r\n'; // 8 bytes
const MODES: Record<string, number> = { padded: 0, compact: 1, packet_zlib: 2, batch_zlib: 3 };
const MODE_NAMES: Record<number, string> = { 0: 'padded', 1: 'compact', 2: 'packet_zlib', 3: 'batch_zlib' };
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_PACKETS = 100000;
const HEADER_SIZE = 17; // 8 (magic) + 1 (mode) + 4 (count) + 4 (rawsize)

const HEX = '0123456789abcdef';

function isHex64(value: unknown): boolean {
  return typeof value === 'string'
    && value.length === 64
    && /^[0-9a-f]{64}$/.test(value);
}

/** Canonical JSON serialization (sort_keys, compact separators) matching the reference. */
export function canonical(value: unknown): Uint8Array {
  const text = JSON.stringify(sortKeys(value));
  return new TextEncoder().encode(text);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function utf8(u8: Uint8Array): string {
  return new TextDecoder().decode(u8);
}

/** Validate a single JSON-lines certificate packet and return its parsed rows. */
export function packetObjects(packet: Uint8Array): Record<string, unknown>[] {
  if (!(packet instanceof Uint8Array) || packet.length === 0 || packet.length > 3072) {
    throw new Error('invalid certificate packet size');
  }
  let rows: unknown[];
  try {
    rows = utf8(packet).split('\n').filter((l) => l.trim().length > 0).map((line) => JSON.parse(line));
  } catch {
    throw new Error('invalid JSON packet');
  }
  if (rows.length < 3) throw new Error('at least two child cards required');

  const h = rows[0];
  if (
    typeof h !== 'object' || h === null || Array.isArray(h)
    || Object.keys(h as Record<string, unknown>).sort().join(',') !== 'instruction,range,registry,schema'
    || (h as { schema?: unknown }).schema !== 'hact-1'
    || !isHex64((h as { registry?: unknown }).registry)
    || typeof (h as { instruction?: unknown }).instruction !== 'string'
  ) {
    throw new Error('invalid header');
  }
  const hrec = h as { range: unknown; registry: string };

  const interval = (r: unknown): [number, number] => {
    if (!Array.isArray(r) || r.length !== 2
      || !Number.isInteger(r[0]) || !Number.isInteger(r[1])
      || r[0] < 0 || r[0] > r[1]) {
      throw new Error('invalid interval');
    }
    return [r[0] as number, r[1] as number];
  };

  const [lo0, hi0] = interval(hrec.range);
  let cursor = lo0;
  for (let idx = 1; idx < rows.length; idx++) {
    const c = rows[idx];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error('invalid child');
    const keys = Object.keys(c as Record<string, unknown>).sort().join(',');
    if (keys !== 'binding,counts,evidence,range,registry') throw new Error('invalid child');
    const cr = c as Record<string, unknown>;
    const [a, b] = interval(cr.range);
    if (a !== cursor || b > hi0 || cr.registry !== hrec.registry) throw new Error('invalid partition');
    if (!Array.isArray(cr.counts) || cr.counts.length !== 3
      || cr.counts.some((v) => !Number.isInteger(v) || (v as number) < 0)
      || (cr.counts as number[]).reduce((x, y) => x + y, 0) !== b - a + 1) {
      throw new Error('invalid counts');
    }
    if (!isHex64(cr.binding) || !isHex64(cr.evidence) || !isHex64(cr.registry)) {
      throw new Error('invalid commitment');
    }
    cursor = b + 1;
  }
  if (cursor !== hi0 + 1) throw new Error('incomplete partition');
  return rows as Record<string, unknown>[];
}

/** Split a concatenated JSON-lines archive into individual packets. */
export function splitPackets(blob: Uint8Array): Uint8Array[] {
  if (!(blob instanceof Uint8Array) || blob.length === 0 || blob.length > MAX_ARCHIVE) {
    throw new Error('empty or oversized archive');
  }
  const result: Uint8Array[] = [];
  const current: Uint8Array[] = [];
  const lines = utf8(blob);
  // Split preserving line terminators so cards can be concatenated losslessly.
  const rawLines = lines.split(/(\r?\n)/);
  let buf = '';
  const flushLine = () => {
    if (buf.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(buf);
    } catch {
      throw new Error('invalid packet line');
    }
    const isHeader = typeof value === 'object' && value !== null
      && (value as { schema?: unknown }).schema === 'hact-1';
    if (isHeader) {
      if (current.length > 0) {
        result.push(Buffer.concat(current));
        current.length = 0;
      }
      current.push(Buffer.from(buf, 'utf8'));
    } else {
      if (current.length === 0) throw new Error('card without header');
      current.push(Buffer.from(buf, 'utf8'));
    }
    buf = '';
  };
  for (const part of rawLines) {
    buf += part;
    if (part.endsWith('\n')) flushLine();
  }
  flushLine();
  if (current.length > 0) result.push(Buffer.concat(current));
  if (result.length < 1 || result.length > MAX_PACKETS) throw new Error('invalid packet count');
  for (const p of result) packetObjects(p);
  return result;
}

/** Compact a packet to canonical rows joined by newlines with a trailing newline. */
export function compactPacket(packet: Uint8Array): Uint8Array {
  const rows = packetObjects(packet);
  const parts: Buffer[] = [];
  for (const row of rows) {
    parts.push(Buffer.from(canonical(row)));
    parts.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

function inflateChecked(data: Uint8Array, limit: number): Uint8Array {
  let result: Uint8Array;
  try {
    result = inflateSync(dataUri(data), { maxOutputLength: limit + 1 });
  } catch {
    throw new Error('invalid compressed payload');
  }
  if (result.length > limit) throw new Error('oversized, truncated or trailing compressed payload');
  // Node's inflateSync stops at the end of the deflate stream and ignores
  // trailing bytes. Detect trailing data by verifying the exact round-trip at
  // level 6 (the level used by encodeWire); the reference Python rejects it.
  const re = deflateSync(Buffer.from(result), { level: 6 });
  if (!re.equals(Buffer.from(dataUri(data)))) {
    throw new Error('oversized, truncated or trailing compressed payload');
  }
  return result;
}

function dataUri(u8: Uint8Array): Uint8Array {
  return u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
}

function packHeader(mode: number, count: number, rawSize: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt8(mode, 8);
  buf.writeUInt32BE(count, 9);
  buf.writeUInt32BE(rawSize, 13);
  return buf;
}

function unpackHeader(buf: Uint8Array): { magic: string; mode: number; count: number; rawSize: number } {
  const b = Buffer.from(buf.subarray(0, HEADER_SIZE));
  return {
    magic: b.toString('latin1', 0, 8),
    mode: b.readUInt8(8),
    count: b.readUInt32BE(9),
    rawSize: b.readUInt32BE(13),
  };
}

/** Encode a list of packets into a single wire archive. */
export function encodeWire(packetsInput: readonly Uint8Array[], mode = 'compact'): Uint8Array {
  if (!(mode in MODES) || packetsInput.length < 1 || packetsInput.length > MAX_PACKETS) {
    throw new Error('invalid format or count');
  }
  const modeCode = MODES[mode];
  const canonicalPackets: Uint8Array[] = [];
  for (const p of packetsInput) {
    packetObjects(p);
    canonicalPackets.push(mode === 'padded' ? p : compactPacket(p));
  }
  let rawSize = 0;
  for (const p of canonicalPackets) rawSize += 4 + p.length;
  if (rawSize > MAX_ARCHIVE) throw new Error('oversized export');

  const bodies: Buffer[] = canonicalPackets.map((p) => {
    if (mode === 'packet_zlib') return deflateSync(Buffer.from(p), { level: 6 });
    return Buffer.from(p);
  });
  const framesParts: Buffer[] = [];
  for (const body of bodies) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    framesParts.push(len, body);
  }
  let frames = Buffer.concat(framesParts);
  if (mode === 'batch_zlib') frames = deflateSync(frames, { level: 6 });
  return Buffer.concat([packHeader(modeCode, packetsInput.length, rawSize), frames]);
}

/** Decode a wire archive back into packets. */
export function decodeWire(wire: Uint8Array): Uint8Array[] {
  if (wire.length < HEADER_SIZE || wire.length > 2 * MAX_ARCHIVE) throw new Error('invalid wire size');
  const { magic, mode, count, rawSize } = unpackHeader(wire);
  if (magic !== MAGIC || !(mode in MODE_NAMES) || count < 1 || count > MAX_PACKETS
    || rawSize <= 0 || rawSize > MAX_ARCHIVE) {
    throw new Error('invalid envelope');
  }
  let body = Buffer.from(wire.subarray(HEADER_SIZE));
  if (mode === 3) body = Buffer.from(inflateChecked(body, rawSize));
  let offset = 0;
  const packets: Uint8Array[] = [];
  let actual = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > body.length) throw new Error('truncated length');
    const length = body.readUInt32BE(offset); offset += 4;
    if (length <= 0 || length > MAX_ARCHIVE || offset + length > body.length) {
      throw new Error('truncated packet');
    }
    let p = body.subarray(offset, offset + length); offset += length;
    if (mode === 2) p = inflateChecked(p, 3072);
    packetObjects(p);
    packets.push(p);
    actual += p.length + 4;
  }
  if (offset !== body.length || actual !== rawSize) throw new Error('trailing or inconsistent data');
  return packets;
}

interface StatusReport {
  required: number;
  counts: [number, number, number];
  locally_authorized?: boolean | undefined;
  snapshot?: string | undefined;
  checker?: string | undefined;
  environment?: string | undefined;
  registry_hash?: string | undefined;
  [key: string]: unknown;
}

/** Layout-invariant presentation of a TRUSTED local report. Not authorization. */
export function statusPrompt(report: StatusReport): Uint8Array {
  const required = report.required;
  const counts = report.counts;
  if (!Number.isInteger(required) || required < 1
    || !Array.isArray(counts) || counts.length !== 3
    || counts.some((v) => !Number.isInteger(v) || v < 0)
    || counts.reduce((x, y) => x + y, 0) !== required) {
    throw new Error('invalid status counts');
  }
  for (const k of ['snapshot', 'checker', 'environment', 'registry_hash'] as const) {
    if (!isHex64(report[k])) throw new Error('identity missing');
  }
  const authorized = report.locally_authorized === true;
  const verdict = counts[1] > 0 ? 'FAIL'
    : (counts[0] === required && counts[2] === 0 && authorized ? 'PASS' : 'UNKNOWN');

  const card: Record<string, unknown> = {
    snapshot: report.snapshot,
    checker: report.checker,
    environment: report.environment,
    registry_hash: report.registry_hash,
    schema: 'hact-status-1',
    required,
    counts,
    verdict,
    authorization: 'trusted-local-report; revalidate at commit',
    provider_tokens: null,
  };

  const prefix = 'Report only the recorded verification state. PASS means the declared checks, not arbitrary program correctness.\n';
  return Buffer.concat([
    Buffer.from(prefix, 'utf8'),
    Buffer.from(canonical(card)),
    Buffer.from('\n', 'utf8'),
  ]);
}

const DIAG_PREFIX = 'DIAGNOSTIC EVIDENCE. Counts are recorded facts, not a new authorization. Do not infer missing results.\n';

/** Produce diagnostic pages under a byte budget; never truncate a mandatory packet. */
export function diagnosticPages(packets: readonly Uint8Array[], budget = 16384): Uint8Array[] {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('positive byte budget required');
  const prefix = Buffer.from(DIAG_PREFIX, 'utf8');
  const pages: Uint8Array[] = [];
  let body = Buffer.from(prefix);
  for (const raw of packets) {
    const p = Buffer.from(compactPacket(raw));
    if (prefix.length + p.length > budget) {
      throw new Error('mandatory packet cannot fit; never truncate');
    }
    if (body.length + p.length > budget) {
      pages.push(body);
      body = Buffer.from(prefix);
    }
    body = Buffer.concat([body, p]);
  }
  if (body.length > prefix.length) pages.push(body);
  return pages;
}

/**
 * Optional real tokenizer; unavailable remains null, never an estimate of
 * characters/4. Returns null because no provider tokenizer is bundled; a real
 * tokenizer measurement must be captured separately.
 */
export function observedTokens(_text: Uint8Array): number | null {
  return null;
}
