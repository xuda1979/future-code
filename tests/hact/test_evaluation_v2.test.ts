/**
 * HACT v2 Comprehensive Evaluation
 *
 * Full evaluation comparing:
 * - HACT Exact DP
 * - HACT Greedy
 * - HACT Hybrid v1 (fixed threshold)
 * - HACT Hybrid v2 Adaptive (auto threshold)
 * - Balanced baselines (fixed-4, fixed-8)
 *
 * Across all six workload families at n=64, 128, 256, 512.
 * Includes multi-seed variance and cost model comparison.
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

const FAMILIES = ['singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'] as const;

describe('HACT v2 Comprehensive Evaluation', () => {
  test('Full comparison table: all optimizers at n=128', () => {
    const n = 128;
    const model = defaultCostModel(8, 3, 4096);
    const results: Record<string, Record<string, number>> = {};

    for (const family of FAMILIES) {
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);

      const exact = optimize(n, model, p);
      const greedy = optimizeGreedy(n, model, p);
      const hybrid = optimizeHybrid(n, model, p, 128);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const balanced4 = compactBalanced(n, 4, 3);
      const balanced8 = compactBalanced(n, 8, 3);

      results[family] = {
        exact: Math.round(objective(exact.tree, model, p)),
        greedy: Math.round(objective(greedy.tree, model, p)),
        hybrid_v1: Math.round(objective(hybrid.tree, model, p)),
        adaptive_v2: Math.round(objective(adaptive.tree, model, p)),
        balanced_4: Math.round(objective(balanced4, model, p)),
        balanced_8: Math.round(objective(balanced8, model, p)),
      };
    }

    console.log('\n========================================');
    console.log(`HACT v2 Evaluation: n=${n}, model=default(8,3,4096)`);
    console.log('========================================');
    console.table(results);
    console.log('========================================\n');

    // Verify adaptive matches or beats balanced for all workloads
    for (const family of FAMILIES) {
      expect(results[family].adaptive_v2).toBeLessThanOrEqual(results[family].balanced_8);
    }
  }, 60000); // n=128 with 6 families and 5 optimizers is compute-intensive

  test('Concentration-guided threshold selection', () => {
    const n = 256;
    const model = defaultCostModel(8, 3, 4096);
    const results: Record<string, { concentration: number; threshold: number; adaptive_bytes: number; v1_bytes: number }> = {};

    for (const family of FAMILIES) {
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);
      const c = workloadConcentration(p);
      const threshold = Math.max(48, Math.min(256, Math.round(128 + c * 120)));

      const adaptive = optimizeHybridAdaptive(n, model, p);
      const v1 = optimizeHybrid(n, model, p, 128);

      results[family] = {
        concentration: Math.round(c * 1000) / 1000,
        threshold,
        adaptive_bytes: Math.round(objective(adaptive.tree, model, p)),
        v1_bytes: Math.round(objective(v1.tree, model, p)),
      };
    }

    console.log('\n========================================');
    console.log(`Adaptive Threshold Selection (n=${n})`);
    console.log('========================================');
    console.table(results);
    console.log('========================================\n');
  }, 60000); // n=128 with 6 families, multiple optimizers

  test('Multi-seed stability at n=128', () => {
    const n = 128;
    const model = defaultCostModel(8, 3, 4096);
    const seeds = [42, 123, 456, 789, 999, 2024, 31415];
    const results: Record<string, { mean: number; stddev: number; min: number; max: number }> = {};

    for (const family of FAMILIES) {
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
      results[family] = {
        mean: Math.round(mean * 100) / 100,
        stddev: Math.round(stddev * 100) / 100,
        min: Math.round(Math.min(...reductions) * 100) / 100,
        max: Math.round(Math.max(...reductions) * 100) / 100,
      };
    }

    console.log('\n========================================');
    console.log(`Multi-Seed Stability (n=${n}, ${seeds.length} seeds)`);
    console.log('Reduction % vs balanced-8');
    console.log('========================================');
    console.table(results);
    console.log('========================================\n');
  }, 120000); // 7 seeds × 6 families × n=128 is very compute-intensive

  test('Cost model comparison at n=64', () => {
    const n = 64;
    const models: Record<string, ReturnType<typeof defaultCostModel>> = {
      'default(8,3,4096)': defaultCostModel(8, 3, 4096),
      'log(8,3,16,2,4096)': logCostModel(8, 3, 16, 2, 4096),
      'step(8,3)': stepCostModel(8, 3, [64, 128, 256, 512, 1024, 2048, 4096, 8192], 8192),
    };
    const results: Record<string, Record<string, number>> = {};

    for (const [modelName, model] of Object.entries(models)) {
      for (const family of ['clustered', 'mixed', 'global'] as const) {
        const sets = generateInvalidations(family, n, 500, 42);
        const p = activationMatrix(sets, n);
        const adaptive = optimizeHybridAdaptive(n, model, p);
        const balanced = compactBalanced(n, 8, 3);
        const key = `${modelName}/${family}`;
        results[key] = {
          adaptive: Math.round(objective(adaptive.tree, model, p)),
          balanced: Math.round(objective(balanced, model, p)),
        };
        expect(results[key].adaptive).toBeLessThanOrEqual(results[key].balanced);
      }
    }

    console.log('\n========================================');
    console.log(`Cost Model Comparison (n=${n})`);
    console.log('========================================');
    console.table(results);
    console.log('========================================\n');
  }, 30000); // n=64 with 2 cost models × 3 families

  test('Scale test: n=512 adaptive vs balanced', () => {
    const n = 512;
    const model = defaultCostModel(8, 4, 4096);
    const results: Record<string, { adaptive: number; balanced: number; reduction_pct: number }> = {};

    for (const family of ['clustered', 'mixed', 'global'] as const) {
      const sets = generateInvalidations(family, n, 300, 42);
      const p = activationMatrix(sets, n);
      const adaptive = optimizeHybridAdaptive(n, model, p);
      const balanced = compactBalanced(n, 8, 4);
      const ac = objective(adaptive.tree, model, p);
      const bc = objective(balanced, model, p);
      results[family] = {
        adaptive: Math.round(ac),
        balanced: Math.round(bc),
        reduction_pct: Math.round((bc - ac) / bc * 1000) / 10,
      };
      validateTree(adaptive.tree, n, model);
    }

    console.log('\n========================================');
    console.log(`Scale Test: n=${n}, height=4`);
    console.log('========================================');
    console.table(results);
    console.log('========================================\n');
  }, 60000); // n=512 with 3 workload families is compute-intensive
});
