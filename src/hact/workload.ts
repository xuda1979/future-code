/**
 * Synthetic workload generators for HACT evaluation.
 *
 * Generates invalidation sets that model different correlation patterns
 * in multi-agent task meshes.
 */

import type { WorkloadFamily } from './types.js';

/** PRNG state for reproducible generation. */
export class Rng {
  private state: bigint;
  private static readonly MASK64 = (1n << 64n) - 1n;

  constructor(seed: number) {
    this.state = (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & Rng.MASK64;
  }

  next(): number {
    // xorshift64 (mask to 64 bits after each operation)
    this.state = this.state & Rng.MASK64;
    this.state ^= (this.state << 13n) & Rng.MASK64;
    this.state ^= (this.state >> 7n) & Rng.MASK64;
    this.state ^= (this.state << 17n) & Rng.MASK64;
    this.state = this.state & Rng.MASK64;
    return Number(this.state & 0xffffffffn) / 0x100000000;
  }

  /** Random integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Pick k distinct elements from [0, n). */
  sample(n: number, k: number): number[] {
    if (k > n) k = n;
    const pool = Array.from({ length: n }, (_, i) => i);
    // Fisher-Yates: shuffle first k elements to the front
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.next() * (n - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k);
  }

  /** Bernoulli sample with probability p. */
  bernoulli(p: number): boolean {
    return this.next() < p;
  }
}

/** Generate invalidation sets for a given workload family. */
export function generateInvalidations(
  family: WorkloadFamily,
  n: number,
  episodes: number,
  seed: number,
): number[][] {
  const rng = new Rng(seed);
  const sets: number[][] = [];

  switch (family) {
    case 'singleton': {
      // Each episode invalidates exactly one gate, chosen uniformly
      for (let e = 0; e < episodes; e++) {
        sets.push([rng.int(0, n - 1)]);
      }
      break;
    }

    case 'skewed_singleton': {
      // Each episode invalidates one gate, but gate 0 is invalidated 80% of the time
      for (let e = 0; e < episodes; e++) {
        if (rng.bernoulli(0.8)) {
          sets.push([0]);
        } else {
          sets.push([rng.int(1, n - 1)]);
        }
      }
      break;
    }

    case 'independent': {
      // Each gate is independently invalidated with probability 0.1
      for (let e = 0; e < episodes; e++) {
        const set: number[] = [];
        for (let g = 0; g < n; g++) {
          if (rng.bernoulli(0.1)) set.push(g);
        }
        if (set.length === 0) set.push(rng.int(0, n - 1));
        sets.push(set);
      }
      break;
    }

    case 'clustered': {
      // Invalidations cluster in contiguous blocks
      const clusterSize = Math.max(2, Math.floor(n / 16));
      for (let e = 0; e < episodes; e++) {
        const start = rng.int(0, n - clusterSize);
        const len = rng.int(1, clusterSize);
        const set: number[] = [];
        for (let g = start; g < start + len && g < n; g++) {
          set.push(g);
        }
        // Occasionally add noise
        if (rng.bernoulli(0.2)) {
          set.push(rng.int(0, n - 1));
        }
        sets.push(set);
      }
      break;
    }

    case 'mixed': {
      // Mix of singleton, independent, and clustered
      for (let e = 0; e < episodes; e++) {
        const r = rng.next();
        if (r < 0.4) {
          sets.push([rng.int(0, n - 1)]);
        } else if (r < 0.7) {
          const set: number[] = [];
          for (let g = 0; g < n; g++) {
            if (rng.bernoulli(0.08)) set.push(g);
          }
          if (set.length === 0) set.push(rng.int(0, n - 1));
          sets.push(set);
        } else {
          const start = rng.int(0, n - 1);
          const len = rng.int(1, Math.min(5, n - start));
          const set: number[] = [];
          for (let g = start; g < start + len && g < n; g++) {
            set.push(g);
          }
          sets.push(set);
        }
      }
      break;
    }

    case 'global': {
      // Every gate is invalidated every time
      for (let e = 0; e < episodes; e++) {
        sets.push(Array.from({ length: n }, (_, i) => i));
      }
      break;
    }
  }

  return sets;
}

/** Compute the probability that an update set hits interval [i, j]. */
export function hitProbability(
  sets: readonly (readonly number[])[],
  i: number,
  j: number,
): number {
  if (sets.length === 0) return 0;
  let hits = 0;
  for (const set of sets) {
    for (const g of set) {
      if (g >= i && g <= j) {
        hits++;
        break;
      }
    }
  }
  return hits / sets.length;
}

/** Compute mean serialized traffic for a tree under a cost model. */
export function meanTraffic(
  tree: import('./types.js').CertNode,
  packetBytes: (k: number) => number,
  p: import('./types.js').ActivationMatrix,
): number {
  let total = 0;
  function visit(node: import('./types.js').CertNode): void {
    if (node.children.length === 0) return;
    total += p[node.lo][node.hi] * packetBytes(node.children.length);
    for (const child of node.children) visit(child);
  }
  visit(tree);
  return total;
}
