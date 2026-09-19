/**
 * HACT: Hyperedge-Aware Certificate Trees
 *
 * Core type definitions for context-bounded multi-agent coordination.
 * Ported from the HACT research prototype (Python) to TypeScript.
 *
 * The dynamic program optimizes communication bytes, not model intelligence,
 * task makespan, or gate execution cost. All intervals are inclusive and zero-indexed.
 */

/** A gate is a named quality check with declared read sets and a checker. */
export interface Gate {
  readonly id: string;
  readonly kind: 'unit' | 'integration' | 'static' | 'custom';
  readonly module: number;
  readonly other?: number;
  readonly checker: string;
  readonly readSet: readonly string[];
  readonly configHash: string;
}

/** Evidence is a trusted record produced by a checker, not a model claim. */
export interface Evidence {
  readonly id: string;
  readonly gateId: string;
  readonly verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly fingerprint: string;
  readonly details: Record<string, unknown>;
  readonly timestamp: number;
}

/** A certificate node covers an interval [lo, hi] of gates. */
export interface CertNode {
  readonly lo: number;
  readonly hi: number;
  readonly children: readonly CertNode[];
  readonly arity: number;
  readonly depth: number;
}

/** A certificate tree root with aggregate verdict. */
export interface CertTree {
  readonly root: CertNode;
  readonly verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly counts: [number, number, number]; // [pass, fail, unknown]
  readonly generation: number;
}

/** Cost model for packet bytes per fan-out arity. */
export interface CostModel {
  /** Packet bytes for a node with k children. */
  packetBytes: (k: number) => number;
  /** Maximum tree height. */
  maxHeight: number;
  /** Maximum fan-out per node. */
  maxArity: number;
  /** Byte cap per packet. */
  byteCap: number;
}

/** Invalidation set: which gates are dirty after an update. */
export type InvalidationSet = ReadonlySet<number>;

/** Activation matrix: probability that gate i is activated. */
export type ActivationRow = Float64Array;
export type ActivationMatrix = Float64Array[];

/** Workload family for synthetic evaluation. */
export type WorkloadFamily =
  | 'singleton'
  | 'skewed_singleton'
  | 'independent'
  | 'clustered'
  | 'mixed'
  | 'global';

/** Result of tree optimization. */
export interface OptimizationResult {
  readonly tree: CertTree;
  readonly expectedBytes: number;
  readonly height: number;
  readonly arityDistribution: readonly number[];
}

/** Measurement record for a single evaluation run. */
export interface Measurement {
  readonly seed: number;
  readonly condition: string;
  readonly meanBytes: number;
  readonly height: number;
  readonly driftMeanBytes?: number;
  readonly tree: CertTree;
}

/** Stats for a tree under a cost model. */
export interface TreeStats {
  readonly depth: number;
  readonly leafCount: number;
  readonly internalNodeCount: number;
  readonly maxArity: number;
  readonly totalPacketBytes: number;
  readonly fanoutHistogram: readonly number[];
}
