/**
 * Trusted local certificate kernel; no semantic claim is inferred from prose.
 *
 * Hashes bind records, not truth. Only a trusted checker may submit Evidence.
 * These objects are not signatures or a hostile-worker proof system.
 * Each gate must declare its complete read set, including checker/config/environment
 * dependencies.
 *
 * Ported from hact/certificates.py with enhancements for TypeScript integration.
 */

import { createHash } from 'crypto';
import {
  type CertNode,
  type CertTree,
  type Evidence,
  type Gate,
} from './types.js';

/** A capsule is the canonical serialized form of a tree's evidence. */
export interface Capsule {
  readonly rootHash: string;
  readonly counts: [number, number, number];
  readonly lo: number;
  readonly hi: number;
  readonly generation: number;
  readonly evidenceHashes: readonly string[];
}

/** Registry of gates with their evidence. */
export class GateRegistry {
  private readonly gates = new Map<string, Gate>();
  private readonly evidence = new Map<string, Evidence[]>();
  private generation = 0;
  private readonly _root: string;

  constructor(rootHash: string = '') {
    this._root = rootHash;
  }

  get root(): string {
    return this._root;
  }

  register(gate: Gate): void {
    if (this.gates.has(gate.id)) {
      throw new Error(`Gate ${gate.id} already registered`);
    }
    this.gates.set(gate.id, gate);
    this.evidence.set(gate.id, []);
  }

  get(id: string): Gate | undefined {
    return this.gates.get(id);
  }

  all(): readonly Gate[] {
    return Array.from(this.gates.values());
  }

  get count(): number {
    return this.gates.size;
  }

  /** Submit evidence from a trusted checker. */
  submit(gateId: string, verdict: 'PASS' | 'FAIL' | 'UNKNOWN', fingerprint: string, details: Record<string, unknown> = {}): Evidence {
    const gate = this.gates.get(gateId);
    if (!gate) {
      throw new Error(`Unknown gate: ${gateId}`);
    }
    const ev: Evidence = {
      id: this.hashEvidence(gateId, verdict, fingerprint, this.generation),
      gateId,
      verdict,
      fingerprint,
      details,
      timestamp: Date.now(),
    };
    this.evidence.get(gateId)!.push(ev);
    return ev;
  }

  /** Get the latest evidence for a gate. */
  latest(gateId: string): Evidence | undefined {
    const list = this.evidence.get(gateId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /** Get all evidence for a gate. */
  history(gateId: string): readonly Evidence[] {
    return this.evidence.get(gateId) ?? [];
  }

  /** Advance the generation counter. */
  advanceGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Build a certificate tree from current evidence. */
  buildTree(lo: number, hi: number, children: readonly CertNode[]): CertTree {
    const gateList = Array.from(this.gates.values()).sort((a, b) => a.module - b.module);
    let pass = 0, fail = 0, unknown = 0;
    for (let i = lo; i <= hi && i < gateList.length; i++) {
      const gate = gateList[i];
      if (!gate) continue;
      const ev = this.latest(gate.id);
      if (!ev || ev.verdict === 'UNKNOWN') unknown++;
      else if (ev.verdict === 'PASS') pass++;
      else fail++;
    }
    const node: CertNode = { lo, hi, children, arity: children.length, depth: 0 };
    return {
      root: node,
      verdict: fail > 0 ? 'FAIL' : (unknown > 0 ? 'UNKNOWN' : 'PASS'),
      counts: [pass, fail, unknown],
      generation: this.generation,
    };
  }

  /** Check a returned display against the trusted record. */
  checkExternalCapsule(supplied: Uint8Array, canonical: Capsule): boolean {
    try {
      const obj = JSON.parse(new TextDecoder().decode(supplied));
      return obj.rootHash === canonical.rootHash &&
        obj.counts[0] === canonical.counts[0] &&
        obj.counts[1] === canonical.counts[1] &&
        obj.counts[2] === canonical.counts[2] &&
        obj.lo === canonical.lo &&
        obj.hi === canonical.hi &&
        obj.generation === canonical.generation;
    } catch {
      return false;
    }
  }

  /** Create a canonical capsule for the current state. */
  capsule(lo: number, hi: number, children: readonly CertNode[], evidenceHashes: readonly string[]): Capsule {
    const tree = this.buildTree(lo, hi, children);
    return {
      rootHash: this.hashTree(tree),
      counts: tree.counts,
      lo,
      hi,
      generation: this.generation,
      evidenceHashes,
    };
  }

  /** Verify a ticket claims all gates pass. */
  verifyTicket(tree: CertTree): boolean {
    return tree.verdict === 'PASS' &&
      tree.counts[0] === this.count &&
      tree.counts[1] === 0 &&
      tree.counts[2] === 0 &&
      tree.root.lo === 0 &&
      tree.root.hi === this.count - 1;
  }

  private hashEvidence(gateId: string, verdict: string, fingerprint: string, gen: number): string {
    return createHash('sha256')
      .update(`${gateId}:${verdict}:${fingerprint}:${gen}`)
      .digest('hex')
      .slice(0, 16);
  }

  private hashTree(tree: CertTree): string {
    return createHash('sha256')
      .update(JSON.stringify({
        verdict: tree.verdict,
        counts: tree.counts,
        generation: tree.generation,
        lo: tree.root.lo,
        hi: tree.root.hi,
      }))
      .digest('hex')
      .slice(0, 16);
  }
}

/** Per-gate monotonic generation tracking to prevent stale cache revival. */
export class GenerationTracker {
  private readonly generations = new Map<string, number>();
  private readonly intervalStamps = new Map<string, number>();
  private globalGeneration = 0;

  /** Record a new generation for a gate. */
  bump(gateId: string): number {
    this.globalGeneration += 1;
    this.generations.set(gateId, this.globalGeneration);
    return this.globalGeneration;
  }

  /** Get the generation for a gate. */
  get(gateId: string): number {
    return this.generations.get(gateId) ?? 0;
  }

  /** Stamp an interval [lo, hi] with the max generation in that range. */
  stampInterval(lo: number, hi: number, gateGenerations: readonly number[]): number {
    let max = 0;
    for (let i = lo; i <= hi && i < gateGenerations.length; i++) {
      max = Math.max(max, gateGenerations[i] ?? 0);
    }
    const key = `${lo}:${hi}`;
    this.intervalStamps.set(key, max);
    return max;
  }

  /** Check if an interval stamp is still valid. */
  isValidInterval(lo: number, hi: number, gateGenerations: readonly number[]): boolean {
    const key = `${lo}:${hi}`;
    const stamp = this.intervalStamps.get(key);
    if (stamp === undefined) return false;
    let max = 0;
    for (let i = lo; i <= hi && i < gateGenerations.length; i++) {
      max = Math.max(max, gateGenerations[i] ?? 0);
    }
    return stamp === max;
  }

  get currentGlobalGeneration(): number {
    return this.globalGeneration;
  }
}
