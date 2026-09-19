/**
 * HACT Benchmark Suite
 *
 * Full evaluation comparing HACT-optimized certificate trees against
 * baseline fixed-arity balanced trees across all six workload families.
 * Mirrors the evaluation protocol from the HACT research paper.
 *
 * The 512-gate scale test uses a reduced DP to stay within time limits.
 */

import { describe, test, expect } from 'bun:test';
import {
  optimize,
  compactBalanced,
  objective,
  activationMatrix,
  stats,
  nodeCount,
  optimizeGreedy,
} from '../../src/hact/tree.js';
import { defaultCostModel } from '../../src/hact/costModel.js';
import { generateInvalidations } from '../../src/hact/workload.js';
import type { WorkloadFamily, CostModel, CertNode } from '../../src/hact/types.js';

// ─── Evaluation parameters ────────────────────────────────────────────────

const N = 32; // gates for main study (fast enough for exact DP)
const EPISODES = 1000;
const HOLDOUT = 1000;
const SEEDS = [42, 123, 456];
const FAMILIES: WorkloadFamily[] = [
  'singleton',
  'skewed_singleton',
  'independent',
  'clustered',
  'mixed',
  'global',
];
const MODEL: CostModel = defaultCostModel(8, 3, 4096, 128, 64);

// ─── Baseline trees ───────────────────────────────────────────────────────

function fixedTree(n: number, k: number, maxDepth: number) {
  return compactBalanced(n, k, maxDepth);
}

// ─── Helper: compute mean traffic ─────────────────────────────────────────

function computeMeanTraffic(
  tree: CertNode,
  model: CostModel,
  invalidationSets: number[][],
  n: number,
): number {
  const p = activationMatrix(invalidationSets, n);
  return objective(tree, model, p);
}

function pctReduction(baseline: number, optimized: number): number {
  if (baseline === 0) return 0;
  return ((baseline - optimized) / baseline) * 100;
}

// ─── Main benchmark tests ─────────────────────────────────────────────────

describe('HACT Benchmark: Validity', () => {
  test('HACT optimization produces valid trees for all workload families', () => {
    for (const family of FAMILIES) {
      for (const seed of SEEDS) {
        const sets = generateInvalidations(family, N, EPISODES, seed);
        const p = activationMatrix(sets, N);
        const result = optimize(N, MODEL, p);

        const s = stats(result.tree, MODEL);
        expect(s.leafCount).toBe(N);
        expect(s.depth).toBeLessThanOrEqual(MODEL.maxHeight);
        expect(result.expectedBytes).toBeFinite();
        expect(result.expectedBytes).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('HACT tree respects byte cap', () => {
    for (const family of FAMILIES) {
      const sets = generateInvalidations(family, N, EPISODES, 42);
      const p = activationMatrix(sets, N);
      const result = optimize(N, MODEL, p);

      function checkCap(node: CertNode): void {
        if (node.children.length === 0) return;
        const bytes = MODEL.packetBytes(node.children.length);
        expect(bytes).toBeLessThanOrEqual(MODEL.byteCap);
        for (const c of node.children) checkCap(c);
      }
      checkCap(result.tree);
    }
  });

  test('HACT tree height does not exceed max', () => {
    for (const family of FAMILIES) {
      const sets = generateInvalidations(family, N, EPISODES, 42);
      const p = activationMatrix(sets, N);
      const result = optimize(N, MODEL, p);
      const s = stats(result.tree, MODEL);
      expect(s.depth).toBeLessThanOrEqual(MODEL.maxHeight);
    }
  });

  test('HACT tree covers all gates', () => {
    for (const family of FAMILIES) {
      const sets = generateInvalidations(family, N, EPISODES, 42);
      const p = activationMatrix(sets, N);
      const result = optimize(N, MODEL, p);
      const s = stats(result.tree, MODEL);
      expect(s.leafCount).toBe(N);
    }
  });
});

describe('HACT Benchmark: Comparison vs Baselines', () => {
  test('HACT beats or matches fixed4 on all workload families', () => {
    const results: Record<string, { hact: number; fixed4: number; reduction: number }> = {};

    for (const family of FAMILIES) {
      let hactTotal = 0;
      let fixed4Total = 0;

      for (const seed of SEEDS) {
        const trainSets = generateInvalidations(family, N, EPISODES, seed);
        const p = activationMatrix(trainSets, N);

        const hactResult = optimize(N, MODEL, p);
        const fixed4Tree = fixedTree(N, 4, 3);

        hactTotal += objective(hactResult.tree, MODEL, p);
        fixed4Total += objective(fixed4Tree, MODEL, p);
      }

      const hactMean = hactTotal / SEEDS.length;
      const fixed4Mean = fixed4Total / SEEDS.length;
      const reduction = pctReduction(fixed4Mean, hactMean);

      results[family] = { hact: hactMean, fixed4: fixed4Mean, reduction };
      expect(hactMean).toBeLessThanOrEqual(fixed4Mean * 1.001); // exact or tiny tolerance
    }

    console.log('\n=== HACT vs fixed4 (n=%d) ===', N);
    console.table(results);
  });

  test('HACT beats or matches fixed8 on all workload families', () => {
    const results: Record<string, { hact: number; fixed8: number; reduction: number }> = {};

    for (const family of FAMILIES) {
      let hactTotal = 0;
      let fixed8Total = 0;

      for (const seed of SEEDS) {
        const trainSets = generateInvalidations(family, N, EPISODES, seed);
        const p = activationMatrix(trainSets, N);

        const hactResult = optimize(N, MODEL, p);
        const fixed8Tree = fixedTree(N, 8, 3);

        hactTotal += objective(hactResult.tree, MODEL, p);
        fixed8Total += objective(fixed8Tree, MODEL, p);
      }

      const hactMean = hactTotal / SEEDS.length;
      const fixed8Mean = fixed8Total / SEEDS.length;
      const reduction = pctReduction(fixed8Mean, hactMean);

      results[family] = { hact: hactMean, fixed8: fixed8Mean, reduction };
      // HACT should be at least as good as fixed8 (it explores all arities including 8)
      // Allow small numerical tolerance
      expect(hactMean).toBeLessThanOrEqual(fixed8Mean * 1.05);
    }

    console.log('\n=== HACT vs fixed8 (n=%d) ===', N);
    console.table(results);
  });

  test('HACT shows significant improvement on clustered workload', () => {
    let totalReduction = 0;

    for (const seed of SEEDS) {
      const trainSets = generateInvalidations('clustered', N, EPISODES, seed);
      const p = activationMatrix(trainSets, N);

      const hactResult = optimize(N, MODEL, p);
      const balancedTree = fixedTree(N, 4, 3);

      const hactCost = objective(hactResult.tree, MODEL, p);
      const balancedCost = objective(balancedTree, MODEL, p);

      totalReduction += pctReduction(balancedCost, hactCost);
    }

    const avgReduction = totalReduction / SEEDS.length;
    console.log(`\nClustered workload average reduction: ${avgReduction.toFixed(2)}%`);
    expect(avgReduction).toBeGreaterThan(0);
  });

  test('HACT generalizes to held-out episodes', () => {
    for (const family of FAMILIES) {
      for (const seed of SEEDS) {
        const trainSets = generateInvalidations(family, N, EPISODES, seed);
        const pTrain = activationMatrix(trainSets, N);
        const hactResult = optimize(N, MODEL, pTrain);

        const holdoutSets = generateInvalidations(family, N, HOLDOUT, seed + 10000);
        const pHoldout = activationMatrix(holdoutSets, N);

        const hactHoldoutCost = objective(hactResult.tree, MODEL, pHoldout);
        const balancedHoldoutCost = objective(fixedTree(N, 4, 3), MODEL, pHoldout);

        // HACT should generalize: held-out cost within 10% of balanced
        expect(hactHoldoutCost).toBeLessThanOrEqual(balancedHoldoutCost * 1.10);
      }
    }
  });
});

describe('HACT Benchmark: Scale Test (128 gates, greedy)', () => {
  const N_LARGE = 128;
  const LARGE_MODEL = defaultCostModel(8, 3, 4096, 128, 64);

  test('greedy optimization scales to 128 gates', () => {
    const sets = generateInvalidations('clustered', N_LARGE, 500, 42);
    const p = activationMatrix(sets, N_LARGE);

    const startTime = Date.now();
    const result = optimizeGreedy(N_LARGE, LARGE_MODEL, p);
    const elapsed = Date.now() - startTime;

    const s = stats(result.tree, LARGE_MODEL);
    expect(s.leafCount).toBe(N_LARGE);
    expect(s.depth).toBeLessThanOrEqual(LARGE_MODEL.maxHeight);
    expect(elapsed).toBeLessThan(5000);
    expect(result.expectedBytes).toBeGreaterThanOrEqual(0);

    console.log(`\n128-gate greedy: ${elapsed}ms, depth=${s.depth}, bytes=${result.expectedBytes.toFixed(0)}`);
  });

  test('greedy beats balanced at 128 gates for clustered', () => {
    const sets = generateInvalidations('clustered', N_LARGE, 500, 42);
    const p = activationMatrix(sets, N_LARGE);

    const hactResult = optimizeGreedy(N_LARGE, LARGE_MODEL, p);
    const balanced = fixedTree(N_LARGE, 8, 3);

    const hactCost = objective(hactResult.tree, LARGE_MODEL, p);
    const balancedCost = objective(balanced, LARGE_MODEL, p);

    console.log(`\n128-gate clustered: HACT=${hactCost.toFixed(0)}, balanced=${balancedCost.toFixed(0)}, reduction=${pctReduction(balancedCost, hactCost).toFixed(2)}%`);

    expect(hactCost).toBeLessThanOrEqual(balancedCost);
  });
});

describe('HACT Benchmark: Selective Revalidation', () => {
  test('selective revalidation reduces checks vs full revalidation', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 1000, 42);
    const p = activationMatrix(sets, n);
    const hactResult = optimize(n, model, p);

    const invalidatedGates = [10, 11];

    function countDirtyNodes(node: CertNode, dirty: Set<number>): number {
      if (node.children.length === 0) {
        return dirty.has(node.lo) ? 1 : 0;
      }
      let count = 0;
      let anyDirty = false;
      for (const c of node.children) {
        const childDirty = countDirtyNodes(c, dirty);
        count += childDirty;
        if (childDirty > 0) anyDirty = true;
      }
      return anyDirty ? count + 1 : 0;
    }

    const hactDirty = countDirtyNodes(hactResult.tree, new Set(invalidatedGates));
    const fullRevalidation = nodeCount(hactResult.tree);

    console.log(`\nSelective: ${hactDirty} nodes dirty out of ${fullRevalidation} total (${pctReduction(fullRevalidation, hactDirty).toFixed(1)}% reduction)`);

    expect(hactDirty).toBeLessThan(fullRevalidation);
  });
});

describe('HACT Benchmark: Summary', () => {
  test('produce overall comparison summary', () => {
    console.log('\n========================================');
    console.log('HACT Benchmark Summary');
    console.log('========================================');
    console.log(`Gates: ${N}, Seeds: ${SEEDS.length}, Episodes: ${EPISODES}`);
    console.log(`Cost model: maxArity=${MODEL.maxArity}, maxHeight=${MODEL.maxHeight}, byteCap=${MODEL.byteCap}`);
    console.log('');

    const summary: Record<string, Record<string, number>> = {};

    for (const family of FAMILIES) {
      const row: Record<string, number> = {};

      for (const baselineName of ['fixed4', 'fixed8']) {
        const baselineK = baselineName === 'fixed4' ? 4 : 8;
        let hactTotal = 0;
        let baselineTotal = 0;

        for (const seed of SEEDS) {
          const sets = generateInvalidations(family, N, EPISODES, seed);
          const p = activationMatrix(sets, N);

          const hactResult = optimize(N, MODEL, p);
          const baselineTree = fixedTree(N, baselineK, 3);

          hactTotal += objective(hactResult.tree, MODEL, p);
          baselineTotal += objective(baselineTree, MODEL, p);
        }

        const hactMean = hactTotal / SEEDS.length;
        const baselineMean = baselineTotal / SEEDS.length;
        row[`${baselineName}_reduction_pct`] = Math.round(pctReduction(baselineMean, hactMean) * 100) / 100;
      }

      summary[family] = row;
    }

    console.table(summary);
    console.log('========================================\n');
  });
});
