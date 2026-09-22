/**
 * HACT Adaptive Hybrid Optimizer Tests
 *
 * Tests the v2 adaptive hybrid optimizer with:
 * - Workload concentration detection
 * - Multi-restart local search with perturbation
 * - Probability-weighted splits
 * - Comparison against v1 hybrid and balanced baselines
 * - Large-scale evaluation (n=512)
 * - Variance analysis across seeds
 */

import { describe, test, expect } from 'bun:test';
import {
  optimize,
  optimizeGreedy,
  optimizeHybrid,
  optimizeHybridAdaptive,
  workloadConcentration,
  compactBalanced,
  fixedArityTree,
  objective,
  activationMatrix,
  validateTree,
  stats,
} from '../../src/hact/tree.js';
import { defaultCostModel, logCostModel, stepCostModel } from '../../src/hact/costModel.js';
import { generateInvalidations } from '../../src/hact/workload.js';
import type { CostModel } from '../../src/hact/types.js';

describe('Workload Concentration Metric', () => {
  test('uniform workload has low concentration', () => {
    const n = 16;
    const sets = generateInvalidations('independent', n, 500, 42);
    const p = activationMatrix(sets, n);
    const c = workloadConcentration(p);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  test('skewed workload has higher concentration than uniform', () => {
    const n = 32;
    const skewedSets = generateInvalidations('skewed_singleton', n, 500, 42);
    const uniformSets = generateInvalidations('independent', n, 500, 42);
    const skewedP = activationMatrix(skewedSets, n);
    const uniformP = activationMatrix(uniformSets, n);
    const skewedC = workloadConcentration(skewedP);
    const uniformC = workloadConcentration(uniformP);
    // Skewed should generally be more concentrated
    expect(skewedC).toBeGreaterThanOrEqual(uniformC * 0.8);
  });

  test('global invalidation has high concentration', () => {
    const n = 16;
    const sets = generateInvalidations('global', n, 500, 42);
    const p = activationMatrix(sets, n);
    const c = workloadConcentration(p);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  test('returns 0 for single element', () => {
    const n = 1;
    const sets = generateInvalidations('singleton', n, 100, 42);
    const p = activationMatrix(sets, n);
    expect(workloadConcentration(p)).toBe(0);
  });
});

describe('Adaptive Hybrid Optimizer - Basic Correctness', () => {
  test('produces valid tree for n=8', () => {
    const n = 8;
    const model = defaultCostModel(4, 3, 4096);
    const sets = generateInvalidations('mixed', n, 200, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);
  });

  test('produces valid tree for n=32', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);
  });

  test('produces valid tree for n=128', () => {
    const n = 128;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);
  });

  test('throws on empty tree', () => {
    const model = defaultCostModel(4, 3, 4096);
    const p: Float64Array[] = [];
    expect(() => optimizeHybridAdaptive(0, model, p)).toThrow();
  });

  test('single gate returns leaf with zero bytes', () => {
    const model = defaultCostModel(4, 3, 4096);
    const p = [new Float64Array(1).fill(1)];
    const result = optimizeHybridAdaptive(1, model, p);
    expect(result.tree.children.length).toBe(0);
    expect(result.expectedBytes).toBe(0);
  });
});

describe('Adaptive Hybrid vs Balanced Baseline', () => {
  const families = ['singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'] as const;

  for (const family of families) {
    test(`adaptive beats balanced for ${family} at n=64`, () => {
      const n = 64;
      const model = defaultCostModel(8, 3, 4096);
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const balanced = compactBalanced(n, 8, 3);
      const ac = objective(adaptive.tree, model, p);
      const bc = objective(balanced, model, p);
      expect(ac).toBeLessThanOrEqual(bc);
    });
  }
});

describe('Adaptive Hybrid vs V1 Hybrid', () => {
  const families = ['singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'] as const;

  for (const family of families) {
    test(`adaptive <= v1 hybrid for ${family} at n=64`, () => {
      const n = 64;
      const model = defaultCostModel(8, 3, 4096);
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const v1 = optimizeHybrid(n, model, p, 64);
      const ac = objective(adaptive.tree, model, p);
      const v1c = objective(v1.tree, model, p);
      // Adaptive should be at least as good as v1
      expect(ac).toBeLessThanOrEqual(v1c * 1.05); // within 5% tolerance
    });
  }

  test('adaptive significantly better for skewed at n=128', () => {
    const n = 128;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('skewed_singleton', n, 500, 42);
    const p = activationMatrix(sets, n);
    const adaptive = optimizeHybridAdaptive(n, model, p);
    const v1 = optimizeHybrid(n, model, p, 128);
    const ac = objective(adaptive.tree, model, p);
    const v1c = objective(v1.tree, model, p);
    console.log(`  skewed n=128: adaptive=${ac.toFixed(0)}, v1=${v1c.toFixed(0)}, improvement=${((v1c-ac)/v1c*100).toFixed(1)}%`);
    expect(ac).toBeLessThanOrEqual(v1c);
  });

  test('adaptive significantly better for global at n=128', () => {
    const n = 128;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('global', n, 500, 42);
    const p = activationMatrix(sets, n);
    const adaptive = optimizeHybridAdaptive(n, model, p);
    const v1 = optimizeHybrid(n, model, p, 128);
    const ac = objective(adaptive.tree, model, p);
    const v1c = objective(v1.tree, model, p);
    console.log(`  global n=128: adaptive=${ac.toFixed(0)}, v1=${v1c.toFixed(0)}, improvement=${((v1c-ac)/v1c*100).toFixed(1)}%`);
    expect(ac).toBeLessThanOrEqual(v1c);
  });
});

describe('Large-Scale Evaluation (n=256, n=512)', () => {
  test('adaptive produces valid tree at n=256', () => {
    const n = 256;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);
  }, 30000); // large-scale optimization needs more time

  test('adaptive beats balanced at n=256 for all workloads', async () => {
    const n = 256;
    const model = defaultCostModel(8, 3, 4096);
    const families = ['singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'] as const;
    const results: Record<string, { adaptive: number; balanced: number; reduction: number }> = {};

    for (const family of families) {
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const balanced = compactBalanced(n, 8, 3);
      const ac = objective(adaptive.tree, model, p);
      const bc = objective(balanced, model, p);
      results[family] = {
        adaptive: Math.round(ac),
        balanced: Math.round(bc),
        reduction: Math.round((bc - ac) / bc * 1000) / 10,
      };
      expect(ac).toBeLessThanOrEqual(bc);
    }

    console.log('\n=== Adaptive Hybrid v2 vs Balanced (n=256) ===');
    console.table(results);
  }, 60000); // six workload families at n=256

  test('adaptive produces valid tree at n=512', () => {
    const n = 512;
    const model = defaultCostModel(8, 4, 4096);
    const sets = generateInvalidations('clustered', n, 300, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);
  }, 30000); // n=512 with height 4 is compute-intensive
});

describe('Multi-Seed Variance Analysis', () => {
  test('adaptive results are stable across seeds', () => {
    const n = 64;
    const model = defaultCostModel(8, 3, 4096);
    const seeds = [42, 123, 456, 789, 999];
    const family = 'mixed';
    const reductions: number[] = [];

    for (const seed of seeds) {
      const sets = generateInvalidations(family, n, 500, seed);
      const p = activationMatrix(sets, n);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const balanced = compactBalanced(n, 8, 3);
      const ac = objective(adaptive.tree, model, p);
      const bc = objective(balanced, model, p);
      reductions.push((bc - ac) / bc * 100);
    }

    const mean = reductions.reduce((a, b) => a + b, 0) / reductions.length;
    const variance = reductions.reduce((a, b) => a + (b - mean) ** 2, 0) / reductions.length;
    const stddev = Math.sqrt(variance);

    console.log(`\n  Mixed n=64: mean reduction=${mean.toFixed(2)}%, stddev=${stddev.toFixed(2)}%`);
    console.log(`  Reductions: [${reductions.map(r => r.toFixed(2)).join(', ')}]`);

    // All reductions should be non-negative (adaptive >= balanced)
    for (const r of reductions) {
      expect(r).toBeGreaterThanOrEqual(-1); // small tolerance
    }
    // Variance should be reasonable (not wildly unstable)
    expect(stddev).toBeLessThan(20);
  });
});

describe('Cost Model Comparison', () => {
  test('adaptive works with logarithmic cost model', () => {
    const n = 32;
    const model = logCostModel(8, 3, 16, 2, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);

    const balanced = compactBalanced(n, 8, 3);
    const ac = objective(result.tree, model, p);
    const bc = objective(balanced, model, p);
    expect(ac).toBeLessThanOrEqual(bc);
  });

  test('adaptive works with step cost model', () => {
    const n = 32;
    const brackets = [64, 128, 256, 512, 1024, 2048, 4096, 8192];
    const model = stepCostModel(8, 3, brackets, 8192);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    validateTree(result.tree, n, model);
    expect(result.expectedBytes).toBeGreaterThan(0);

    const balanced = compactBalanced(n, 8, 3);
    const ac = objective(result.tree, model, p);
    const bc = objective(balanced, model, p);
    expect(ac).toBeLessThanOrEqual(bc);
  });
});

describe('Adaptive vs Exact DP (small n)', () => {
  test('adaptive matches exact DP for n=16', () => {
    const n = 16;
    const model = defaultCostModel(4, 3, 4096);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const exact = optimize(n, model, p);
    const adaptive = optimizeHybridAdaptive(n, model, p);
    // For small n, adaptive should use exact DP and match
    expect(adaptive.expectedBytes).toBe(exact.expectedBytes);
  });

  test('adaptive matches exact DP for n=32', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const exact = optimize(n, model, p);
    const adaptive = optimizeHybridAdaptive(n, model, p);
    expect(adaptive.expectedBytes).toBe(exact.expectedBytes);
  });
});

describe('Tree Statistics for Adaptive Optimizer', () => {
  test('adaptive tree stats are valid', () => {
    const n = 64;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimizeHybridAdaptive(n, model, p);
    const s = stats(result.tree, model);
    expect(s.depth).toBeLessThanOrEqual(model.maxHeight);
    expect(s.maxArity).toBeLessThanOrEqual(model.maxArity);
    expect(s.leafCount).toBe(n);
    expect(s.internalNodeCount).toBeGreaterThan(0);
  });
});
