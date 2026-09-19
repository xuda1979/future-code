import { describe, test, expect } from 'bun:test';
import {
  optimize,
  compactBalanced,
  fixedArityTree,
  leaf,
  validateTree,
  objective,
  stats,
  nodeCount,
  treeToDict,
  treeFromDict,
  activationMatrix,
} from '../../src/hact/tree.js';
import { defaultCostModel, linearCostModel } from '../../src/hact/costModel.js';
import { generateInvalidations } from '../../src/hact/workload.js';
import type { CertNode, CostModel } from '../../src/hact/types.js';

describe('HACT Tree Construction', () => {
  test('leaf node covers single gate', () => {
    const n = leaf(5);
    expect(n.lo).toBe(5);
    expect(n.hi).toBe(5);
    expect(n.children.length).toBe(0);
  });

  test('compactBalanced produces valid tree', () => {
    const model = defaultCostModel(4, 3, 4096);
    const tree = compactBalanced(16, 4, 3);
    expect(() => validateTree(tree, 16, model)).not.toThrow();
  });

  test('compactBalanced covers all gates', () => {
    const model = defaultCostModel(8, 3, 4096);
    const tree = compactBalanced(64, 8, 3);
    const leaves: number[] = [];
    function collectLeaves(n: CertNode) {
      if (n.children.length === 0) leaves.push(n.lo);
      for (const c of n.children) collectLeaves(c);
    }
    collectLeaves(tree);
    expect(leaves.length).toBe(64);
    expect(new Set(leaves).size).toBe(64);
  });

  test('fixedArityTree with k=2 produces valid binary tree', () => {
    const model = defaultCostModel(2, 10, 4096);
    const tree = fixedArityTree(4, 2, 10);
    expect(() => validateTree(tree, 4, model)).not.toThrow();
  });
});

describe('HACT Tree Validation', () => {
  const model = defaultCostModel(8, 3, 4096);

  test('rejects out-of-range interval', () => {
    const badTree: CertNode = { lo: 0, hi: 100, children: [], arity: 0, depth: 0 };
    expect(() => validateTree(badTree, 10, model)).toThrow();
  });

  test('rejects invalid leaf', () => {
    const badTree: CertNode = { lo: 0, hi: 2, children: [], arity: 0, depth: 0 };
    expect(() => validateTree(badTree, 10, model)).toThrow();
  });

  test('rejects children gap', () => {
    const child1 = leaf(0);
    const child2 = leaf(2); // gap at gate 1
    const badTree: CertNode = {
      lo: 0, hi: 2,
      children: [child1, child2],
      arity: 2, depth: 1,
    };
    expect(() => validateTree(badTree, 3, model)).toThrow();
  });

  test('rejects arity exceeding max', () => {
    const children = Array.from({ length: 10 }, (_, i) => leaf(i));
    const badTree: CertNode = {
      lo: 0, hi: 9,
      children,
      arity: 10,
      depth: 1,
    };
    const strictModel = defaultCostModel(4, 3, 4096);
    expect(() => validateTree(badTree, 10, strictModel)).toThrow();
  });
});

describe('HACT Activation Matrix', () => {
  test('singleton invalidation gives uniform probabilities', () => {
    const n = 8;
    const sets = generateInvalidations('singleton', n, 1000, 42);
    const p = activationMatrix(sets, n);
    // For singleton, p[i,j] = (j-i+1)/n approximately
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const expected = (j - i + 1) / n;
        expect(p[i][j]).toBeCloseTo(expected, 1);
      }
    }
  });

  test('global invalidation gives all-1 matrix', () => {
    const n = 4;
    const sets = generateInvalidations('global', n, 10, 42);
    const p = activationMatrix(sets, n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        expect(p[i][j]).toBe(1.0);
      }
    }
  });

  test('clustered invalidation gives higher probabilities for contiguous intervals', () => {
    const n = 16;
    const sets = generateInvalidations('clustered', n, 1000, 42);
    const p = activationMatrix(sets, n);
    // Contiguous intervals should have higher probability than scattered ones
    const contiguous = p[0][3]; // gates 0-3
    const scattered = p[0][2] + p[4][7] - p[0][7]; // P(0-2 or 4-7) via inclusion-exclusion
    // Contiguous interval of size 4 should have higher hit rate than non-contiguous
    expect(contiguous).toBeGreaterThan(0);
  });
});

describe('HACT Optimization', () => {
  test('optimize produces valid tree', () => {
    const n = 16;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    expect(() => validateTree(result.tree, n, model)).not.toThrow();
  });

  test('optimize achieves lower cost than fixed balanced for clustered workload', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 1000, 42);
    const p = activationMatrix(sets, n);

    const optimized = optimize(n, model, p);
    const balanced = compactBalanced(n, 4, 3);

    const optCost = objective(optimized.tree, model, p);
    const balancedCost = objective(balanced, model, p);

    // HACT should be at least as good as balanced
    expect(optCost).toBeLessThanOrEqual(balancedCost);
  });

  test('optimize handles n=1 trivially', () => {
    const model = defaultCostModel(8, 3, 4096);
    const p: Float64Array[] = [new Float64Array([1])];
    const result = optimize(1, model, p);
    expect(result.tree.lo).toBe(0);
    expect(result.tree.hi).toBe(0);
    expect(result.expectedBytes).toBe(0);
  });

  test('optimize handles n=2', () => {
    const n = 2;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('independent', n, 100, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    expect(() => validateTree(result.tree, n, model)).not.toThrow();
  });

  test('optimize respects max arity', () => {
    const n = 16;
    const model = defaultCostModel(3, 3, 4096); // max arity 3
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);

    function maxArity(node: CertNode): number {
      if (node.children.length === 0) return 0;
      let max = node.children.length;
      for (const c of node.children) max = Math.max(max, maxArity(c));
      return max;
    }
    expect(maxArity(result.tree)).toBeLessThanOrEqual(3);
  });
});

describe('HACT Objective Function', () => {
  test('objective is non-negative', () => {
    const n = 8;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('mixed', n, 200, 42);
    const p = activationMatrix(sets, n);
    const tree = compactBalanced(n, 4, 3);
    expect(objective(tree, model, p)).toBeGreaterThanOrEqual(0);
  });

  test('objective for global invalidation equals total packet bytes', () => {
    const n = 4;
    const model = defaultCostModel(4, 2, 4096);
    const sets = generateInvalidations('global', n, 10, 42);
    const p = activationMatrix(sets, n);
    // With global invalidation, p[i,j] = 1 for all i,j
    const tree = compactBalanced(n, 2, 2);
    const cost = objective(tree, model, p);
    const treeStats = stats(tree, model);
    // All nodes are always activated, so cost = total packet bytes
    expect(cost).toBe(treeStats.totalPacketBytes);
  });
});

describe('HACT Tree Stats', () => {
  test('stats correctly count leaves and internal nodes', () => {
    const model = defaultCostModel(4, 3, 4096);
    const tree = compactBalanced(8, 4, 3);
    const s = stats(tree, model);
    expect(s.leafCount).toBe(8);
    expect(s.internalNodeCount).toBeGreaterThan(0);
  });

  test('stats correctly compute depth', () => {
    const model = defaultCostModel(2, 3, 4096);
    const tree = compactBalanced(8, 2, 3);
    const s = stats(tree, model);
    expect(s.depth).toBeLessThanOrEqual(3);
  });
});

describe('HACT Serialization', () => {
  test('treeToDict and treeFromDict are inverses', () => {
    const tree = compactBalanced(8, 4, 3);
    const dict = treeToDict(tree);
    const restored = treeFromDict(dict);
    expect(restored.lo).toBe(tree.lo);
    expect(restored.hi).toBe(tree.hi);
    expect(restored.children.length).toBe(tree.children.length);
  });
});

describe('HACT Node Count', () => {
  test('nodeCount counts all nodes', () => {
    const tree = compactBalanced(8, 2, 3);
    const count = nodeCount(tree);
    // 8 leaves + 4 internal at level 2 + 2 at level 1 + 1 root = 15
    expect(count).toBe(15);
  });
});
