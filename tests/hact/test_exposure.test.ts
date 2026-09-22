import { describe, test, expect } from 'bun:test';
import {
  canonical,
  packetObjects,
  splitPackets,
  compactPacket,
  encodeWire,
  decodeWire,
  statusPrompt,
  diagnosticPages,
  observedTokens,
} from '../../src/hact/exposure.js';

const HEX64 = 'a'.repeat(64);
const REG = HEX64;

function rowsFor(lo: number, hi: number): Record<string, unknown>[] {
  const header: Record<string, unknown> = {
    schema: 'hact-1',
    range: [lo, hi],
    registry: REG,
    instruction: 'Use trusted capsule counts only.',
  };
  const children: Record<string, unknown>[] = [];
  let cursor = lo;
  // split into two contiguous child cards (>=2 children required)
  const mid = lo + Math.floor((hi - lo + 1) / 2);
  const segs: Array<[number, number]> = [];
  if (hi - lo + 1 <= 2) {
    // force at least two children even for tiny ranges by using singleton coverage
    segs.push([lo, hi]);
  } else {
    segs.push([lo, mid - 1]);
    segs.push([mid, hi]);
  }
  for (const [a, b] of segs) {
    const pass = b - a + 1; // all pass
    children.push({
      range: [a, b],
      counts: [pass, 0, 0],
      binding: HEX64,
      evidence: HEX64,
      registry: HEX64,
    });
  }
  return [header, ...children];
}

function packetJson(lo: number, hi: number): Buffer {
  const rows = rowsFor(lo, hi);
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function makePackets(count = 2): Buffer[] {
  const packets: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const lo = i * 2;
    const hi = lo + 3;
    packets.push(packetJson(lo, hi));
  }
  return packets;
}

describe('exposure wire round-trips', () => {
  test('round-trips all modes', () => {
    for (const mode of ['padded', 'compact', 'packet_zlib', 'batch_zlib']) {
      const packets = makePackets(3);
      const w = encodeWire(packets, mode);
      const q = decodeWire(w);
      expect(q.length).toBe(packets.length);
      for (let i = 0; i < q.length; i++) {
        const a = packetObjects(q[i]).map((r) => new TextDecoder().decode(canonical(r)));
        const b = packetObjects(packets[i]).map((r) => new TextDecoder().decode(canonical(r)));
        expect(a).toEqual(b);
        expect(q[i].length).toBeLessThanOrEqual(3072);
      }
    }
  });

  test('padded mode preserves original bytes', () => {
    const packets = makePackets(2);
    const w = encodeWire(packets, 'padded');
    const q = decodeWire(w);
    expect(Buffer.compare(Buffer.from(q[0]), packetJson(0, 3))).toBe(0);
  });

  test('rejects malformed wire', () => {
    const packets = makePackets(2);
    const w = encodeWire(packets, 'batch_zlib');
    // prefix corruption
    const corrupt = Buffer.from(w);
    corrupt[0] = 0x78;
    expect(() => decodeWire(corrupt)).toThrow();
    // suffix
    expect(() => decodeWire(Buffer.concat([w, Buffer.from('x')]))).toThrow();
    // truncate
    expect(() => decodeWire(w.subarray(0, w.length - 2))).toThrow();
    // oversized
    expect(() => decodeWire(Buffer.alloc(2 * 64 * 1024 * 1024 + 1))).toThrow();
  });

  test('splitPackets recovers individual packets', () => {
    const packets = makePackets(3);
    const joined = Buffer.concat(packets);
    const split = splitPackets(joined);
    expect(split.length).toBe(3);
    expect(Buffer.compare(Buffer.from(split[0]), packetJson(0, 3))).toBe(0);
  });
});

describe('exposure packet validation', () => {
  test('rejects bad packet structures', () => {
    // bad counts
    const rows = rowsFor(0, 3);
    (rows[1] as Record<string, unknown>).counts = [0, 0, 0];
    let bad = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => packetObjects(bad)).toThrow();

    // gap in range
    const rows2 = rowsFor(0, 3);
    ((rows2[1] as Record<string, unknown>).range as number[])[0] += 1;
    bad = Buffer.from(rows2.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => packetObjects(bad)).toThrow();

    // bad registry hash
    const rows3 = rowsFor(0, 3);
    (rows3[1] as Record<string, unknown>).registry = '0'.repeat(64);
    bad = Buffer.from(rows3.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => packetObjects(bad)).toThrow();

    // extra field in header
    const rows4 = rowsFor(0, 3);
    (rows4[0] as Record<string, unknown>).extra = 1;
    bad = Buffer.from(rows4.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => packetObjects(bad)).toThrow();

    // only header, no children
    const rows5 = [rowsFor(0, 3)[0]];
    bad = Buffer.from(rows5.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => packetObjects(bad)).toThrow();
  });

  test('compactPacket re-serializes canonically', () => {
    const p = makePackets(1)[0];
    const c = compactPacket(p);
    expect(c[c.length - 1]).toBe(0x0a); // trailing newline
  });
});

describe('status prompt', () => {
  const identity = { snapshot: 'a'.repeat(64), checker: 'a'.repeat(64), environment: 'a'.repeat(64), registry_hash: 'a'.repeat(64) };
  test('verdict logic', () => {
    expect(JSON.parse(statusPrompt({ required: 9, counts: [9, 0, 0], locally_authorized: true, ...identity }).toString().split('\n')[1]).verdict).toBe('PASS');
    expect(JSON.parse(statusPrompt({ required: 9, counts: [9, 0, 0], locally_authorized: false, ...identity }).toString().split('\n')[1]).verdict).toBe('UNKNOWN');
    expect(JSON.parse(statusPrompt({ required: 9, counts: [8, 1, 0], locally_authorized: true, ...identity }).toString().split('\n')[1]).verdict).toBe('FAIL');
    expect(JSON.parse(statusPrompt({ required: 9, counts: [8, 0, 1], locally_authorized: true, ...identity }).toString().split('\n')[1]).verdict).toBe('UNKNOWN');
  });

  test('extra fields are ignored', () => {
    const a = statusPrompt({ required: 9, counts: [9, 0, 0], locally_authorized: true, ...identity, layout_id: 'b'.repeat(64), tree: { different: true } });
    expect(a.toString().split('\n').length).toBeGreaterThan(0);
    // verdict still PASS despite extra fields
    expect(JSON.parse(a.toString().split('\n')[1]).verdict).toBe('PASS');
  });

  test('missing identity is rejected', () => {
    expect(() => statusPrompt({ counts: [2, 0, 0], required: 2 })).toThrow();
  });
});

describe('diagnostic pages', () => {
  test('never truncates and respects budget', () => {
    const data = makePackets(5);
    const pages = diagnosticPages(data, 4000);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(4000);
    expect(() => diagnosticPages(data, 20)).toThrow();
  });

  test('observedTokens remains null without a bundled tokenizer', () => {
    expect(observedTokens(new TextEncoder().encode('hello world'))).toBeNull();
  });

  test('canonical serialization sorts keys', () => {
    const out = canonical({ b: 1, a: 2 });
    expect(new TextDecoder().decode(out)).toBe('{"a":2,"b":1}');
  });
});
