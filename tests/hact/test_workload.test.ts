import { describe, test, expect } from 'bun:test';
import { generateInvalidations, Rng, hitProbability, meanTraffic } from '../../src/hact/workload.js';
import { activationMatrix, compactBalanced, objective } from '../../src/hact/tree.js';
import { defaultCostModel } from '../../src/hact/costModel.js';
import type { WorkloadFamily } from '../../src/hact/types.js';

describe('Rng', () => {
  test('produces reproducible values for same seed', () => {
    const r1 = new Rng(42);
    const r2 = new Rng(42);
    for (let i = 0; i < 10; i++) {
      expect(r1.next()).toBe(r2.next());
    }
  });

  test('int produces values in range', () => {
    const rng = new Rng(123);
    for (let i = 0; i < 100; i++) {
      const v = rng.int(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  test('sample produces distinct elements', () => {
    const rng = new Rng(42);
    const s = rng.sample(20, 5);
    expect(s.length).toBe(5);
    expect(new Set(s).size).toBe(5);
  });

  test('bernoulli returns boolean', () => {
    const rng = new Rng(42);
    const result = rng.bernoulli(0.5);
    expect(typeof result).toBe('boolean');
  });
});

describe('Workload Generation', () => {
  const families: WorkloadFamily[] = [
    'singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'
  ];

  test.each(families)('%s produces non-empty invalidation sets', (family) => {
    const sets = generateInvalidations(family, 16, 100, 42);
    expect(sets.length).toBe(100);
    for (const s of sets) {
      expect(s.length).toBeGreaterThan(0);
    }
  });

  test('singleton invalidates exactly one gate', () => {
    const sets = generateInvalidations('singleton', 16, 100, 42);
    for (const s of sets) {
      expect(s.length).toBe(1);
    }
  });

  test('skewed_singleton favors gate 0', () => {
    const sets = generateInvalidations('skewed_singleton', 16, 1000, 42);
    const gate0Count = sets.filter(s => s.includes(0)).length;
    expect(gate0Count / 1000).toBeGreaterThan(0.7);
  });

  test('global invalidates all gates', () => {
    const sets = generateInvalidations('global', 8, 10, 42);
    for (const s of sets) {
      expect(s.length).toBe(8);
    }
  });

  test('clustered produces contiguous blocks', () => {
    const sets = generateInvalidations('clustered', 32, 100, 42);
    let contiguousCount = 0;
    for (const s of sets) {
      if (s.length > 1) {
        const sorted = [...s].sort((a, b) => a - b);
        let isContiguous = true;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] !== sorted[i - 1] + 1) {
            isContiguous = false;
            break;
          }
        }
        if (isContiguous) contiguousCount++;
      }
    }
    // Most clustered sets should be contiguous (allowing for noise)
    expect(contiguousCount).toBeGreaterThan(30);
  });

  test('reproducible with same seed', () => {
    const s1 = generateInvalidations('clustered', 16, 50, 123);
    const s2 = generateInvalidations('clustered', 16, 50, 123);
    expect(s1).toEqual(s2);
  });
});

describe('Hit Probability', () => {
  test('returns 0 for empty sets', () => {
    const p = hitProbability([], 0, 5);
    expect(p).toBe(0);
  });

  test('returns 1 for global sets', () => {
    const sets = generateInvalidations('global', 4, 10, 42);
    expect(hitProbability(sets, 0, 3)).toBe(1.0);
  });

  test('returns correct probability for singleton', () => {
    const sets = generateInvalidations('singleton', 8, 1000, 42);
    // P(hit [0,3]) = 4/8 = 0.5
    const p = hitProbability(sets, 0, 3);
    expect(p).toBeCloseTo(0.5, 1);
  });
});

describe('Mean Traffic', () => {
  test('equals objective for valid tree', () => {
    const n = 8;
    const model = defaultCostModel(4, 3, 4096);
    const sets = generateInvalidations('mixed', n, 200, 42);
    const p = activationMatrix(sets, n);
    const tree = compactBalanced(n, 4, 3);
    
    const obj = objective(tree, model, p);
    const mt = meanTraffic(tree, model.packetBytes, p);
    expect(mt).toBe(obj);
  });
});
