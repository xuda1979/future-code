import { describe, test, expect } from 'bun:test';
import {
  optimize,
  optimizeGreedy,
  compactBalanced,
  objective,
  activationMatrix,
  validateTree,
  stats,
  nodeCount,
  leaf,
  makeNode,
  leaves,
} from '../../src/hact/tree.js';
import { GateRegistry, GenerationTracker } from '../../src/hact/certificates.js';
import { defaultCostModel, linearCostModel, quadraticCostModel } from '../../src/hact/costModel.js';
import { generateInvalidations, Rng } from '../../src/hact/workload.js';
import { TaskBoard, buildMesh } from '../../src/hact/coordination.js';
import type { Gate, CertNode, CostModel } from '../../src/hact/types.js';

describe('Edge Cases: Empty and Single', () => {
  test('optimize throws for n=0', () => {
    const model = defaultCostModel();
    const p: Float64Array[] = [];
    expect(() => optimize(0, model, p)).toThrow();
  });

  test('optimize handles n=1', () => {
    const model = defaultCostModel();
    const p = [new Float64Array([1])];
    const result = optimize(1, model, p);
    expect(result.tree.lo).toBe(0);
    expect(result.tree.hi).toBe(0);
    expect(result.expectedBytes).toBe(0);
  });

  test('optimizeGreedy throws for n=0', () => {
    const model = defaultCostModel();
    const p: Float64Array[] = [];
    expect(() => optimizeGreedy(0, model, p)).toThrow();
  });

  test('optimizeGreedy handles n=1', () => {
    const model = defaultCostModel();
    const p = [new Float64Array([1])];
    const result = optimizeGreedy(1, model, p);
    expect(result.tree.lo).toBe(0);
    expect(result.tree.hi).toBe(0);
  });

  test('compactBalanced throws for n=0', () => {
    expect(() => compactBalanced(0, 4, 3)).toThrow();
  });

  test('compactBalanced handles n=1', () => {
    const tree = compactBalanced(1, 4, 3);
    expect(tree.lo).toBe(0);
    expect(tree.hi).toBe(0);
    expect(tree.children.length).toBe(0);
  });
});

describe('Edge Cases: Boundary Conditions', () => {
  test('optimize with maxArity=2 produces binary tree', () => {
    const n = 16;
    const model = defaultCostModel(2, 5, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    function maxA(node: CertNode): number {
      if (node.children.length === 0) return 0;
      let m = node.children.length;
      for (const c of node.children) m = Math.max(m, maxA(c));
      return m;
    }
    expect(maxA(result.tree)).toBeLessThanOrEqual(2);
  });

  test('optimize with maxHeight=1 produces flat tree', () => {
    const n = 8;
    const model = defaultCostModel(8, 1, 4096);
    const sets = generateInvalidations('independent', n, 200, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    const s = stats(result.tree, model);
    expect(s.depth).toBeLessThanOrEqual(1);
  });

  test('tree with all p=0 has zero expected bytes', () => {
    const n = 8;
    const model = defaultCostModel(8, 3, 4096);
    const p: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n).fill(0));
    const result = optimize(n, model, p);
    expect(result.expectedBytes).toBe(0);
  });
});

describe('Regression: Stale Cache Revival', () => {
  test('generation tracker prevents stale cache revival', () => {
    const tracker = new GenerationTracker();
    tracker.bump('gate-0');
    tracker.bump('gate-1');
    const gens = [tracker.get('gate-0'), tracker.get('gate-1')];
    tracker.stampInterval(0, 1, gens);
    expect(tracker.isValidInterval(0, 1, gens)).toBe(true);
    tracker.bump('gate-0');
    const newGens = [tracker.get('gate-0'), tracker.get('gate-1')];
    expect(tracker.isValidInterval(0, 1, newGens)).toBe(false);
  });

  test('different trees do not revive each other', () => {
    const tracker = new GenerationTracker();
    tracker.bump('gate-0');
    tracker.bump('gate-1');
    tracker.bump('gate-2');
    tracker.bump('gate-3');
    const gens = [1, 2, 3, 4];
    tracker.stampInterval(0, 1, gens);
    tracker.stampInterval(2, 3, gens);
    expect(tracker.isValidInterval(0, 1, gens)).toBe(true);
    tracker.bump('gate-2');
    const newGens = [1, 2, 5, 4];
    expect(tracker.isValidInterval(0, 1, newGens)).toBe(true);
    expect(tracker.isValidInterval(2, 3, newGens)).toBe(false);
  });
});

describe('Regression: Tamper Detection', () => {
  test('checkExternalCapsule rejects tampered root hash', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 4; i++) {
      reg.register({ id: `g${i}`, kind: 'unit', module: i, checker: 'c', readSet: [], configHash: 'h' });
      reg.submit(`g${i}`, 'PASS', `fp${i}`);
    }
    const cap = reg.capsule(0, 3, [], ['h1', 'h2', 'h3', 'h4']);
    const tampered = new TextEncoder().encode(JSON.stringify({
      rootHash: 'tampered', counts: [4, 0, 0], lo: 0, hi: 3, generation: 0,
    }));
    expect(reg.checkExternalCapsule(tampered, cap)).toBe(false);
  });

  test('checkExternalCapsule rejects tampered counts', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 4; i++) {
      reg.register({ id: `g${i}`, kind: 'unit', module: i, checker: 'c', readSet: [], configHash: 'h' });
      reg.submit(`g${i}`, 'PASS', `fp${i}`);
    }
    const cap = reg.capsule(0, 3, [], ['h1', 'h2', 'h3', 'h4']);
    const tampered = new TextEncoder().encode(JSON.stringify({
      rootHash: cap.rootHash, counts: [3, 1, 0], lo: 0, hi: 3, generation: 0,
    }));
    expect(reg.checkExternalCapsule(tampered, cap)).toBe(false);
  });

  test('checkExternalCapsule rejects invalid JSON', () => {
    const reg = new GateRegistry();
    const cap = reg.capsule(0, 0, [], []);
    expect(reg.checkExternalCapsule(new TextEncoder().encode('not json'), cap)).toBe(false);
  });
});

describe('Greedy vs Exact Comparison', () => {
  test('greedy is within 20% of exact for clustered', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 1000, 42);
    const p = activationMatrix(sets, n);
    const exact = optimize(n, model, p);
    const greedy = optimizeGreedy(n, model, p);
    const gap = Math.abs(greedy.expectedBytes - exact.expectedBytes) / Math.max(1, exact.expectedBytes);
    expect(gap).toBeLessThan(0.20);
  });

  test('greedy produces valid tree for all families', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const families = ['singleton', 'skewed_singleton', 'independent', 'clustered', 'mixed', 'global'] as const;
    for (const family of families) {
      const sets = generateInvalidations(family, n, 500, 42);
      const p = activationMatrix(sets, n);
      const result = optimizeGreedy(n, model, p);
      expect(() => validateTree(result.tree, n, model)).not.toThrow();
      const s = stats(result.tree, model);
      expect(s.leafCount).toBe(n);
    }
  });
});

describe('Cost Model Variations', () => {
  test('linear cost model produces valid optimization', () => {
    const n = 16;
    const model = linearCostModel(8, 3, 32, 64, 4096);
    const sets = generateInvalidations('clustered', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    expect(() => validateTree(result.tree, n, model)).not.toThrow();
  });

  test('quadratic cost model produces valid optimization', () => {
    const n = 16;
    const model = quadraticCostModel(8, 3, 4, 32, 4096);
    const sets = generateInvalidations('mixed', n, 500, 42);
    const p = activationMatrix(sets, n);
    const result = optimize(n, model, p);
    expect(() => validateTree(result.tree, n, model)).not.toThrow();
  });
});

describe('Mesh Building Edge Cases', () => {
  test('buildMesh with 1 gate', () => {
    const board = buildMesh(1, 8, 3);
    expect(board.gateCount).toBe(1);
    expect(board.taskCount).toBe(1);
  });

  test('buildMesh with fanout=1', () => {
    const board = buildMesh(4, 1, 4);
    expect(board.gateCount).toBe(4);
    for (const task of board.allTasks()) {
      expect(task.depth).toBeLessThanOrEqual(4);
    }
  });

  test('buildMesh with maxDepth=1', () => {
    const board = buildMesh(8, 8, 1);
    for (const task of board.allTasks()) {
      expect(task.depth).toBeLessThanOrEqual(1);
    }
  });
});
