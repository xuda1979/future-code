import { describe, test, expect } from 'bun:test';
import { TaskBoard, buildMesh } from '../../src/hact/coordination.js';
import { defaultCostModel } from '../../src/hact/costModel.js';
import { generateInvalidations } from '../../src/hact/workload.js';
import { compactBalanced } from '../../src/hact/tree.js';
import type { Gate } from '../../src/hact/types.js';

function makeGate(id: string, module: number): Gate {
  return {
    id,
    kind: 'unit',
    module,
    checker: 'test-checker',
    readSet: [`module-${module}`],
    configHash: `config-${module}`,
  };
}

describe('TaskBoard', () => {
  test('register gates and submit evidence', () => {
    const board = new TaskBoard();
    board.registerGate(makeGate('gate-0', 0));
    board.registerGate(makeGate('gate-1', 1));
    
    expect(board.gateCount).toBe(2);
    
    board.submitEvidence('gate-0', 'PASS', 'fp0');
    board.submitEvidence('gate-1', 'PASS', 'fp1');
    
    const snap = board.snapshot();
    expect(snap.gateCount).toBe(2);
  });

  test('add and retrieve tasks', () => {
    const board = new TaskBoard();
    board.addTask({
      id: 'task-0',
      parentId: null,
      role: 'root',
      gateIds: [],
      contextChars: 1000,
      status: 'pending',
      quality: 'UNKNOWN',
      dependencyCards: [],
      depth: 0,
    });
    board.addTask({
      id: 'task-1',
      parentId: 'task-0',
      role: 'leaf',
      gateIds: ['gate-0'],
      contextChars: 500,
      status: 'pending',
      quality: 'UNKNOWN',
      dependencyCards: [],
      depth: 1,
    });

    expect(board.taskCount).toBe(2);
    expect(board.getTask('task-0')?.role).toBe('root');
    expect(board.childrenOf('task-0').length).toBe(1);
    expect(board.childrenOf(null).length).toBe(1);
  });

  test('optimizeTree produces valid tree', () => {
    const board = new TaskBoard();
    for (let i = 0; i < 16; i++) {
      board.registerGate(makeGate(`gate-${i}`, i));
    }
    
    const sets = generateInvalidations('clustered', 16, 500, 42);
    const model = defaultCostModel(8, 3, 4096);
    const result = board.optimizeTree(sets, model);
    
    expect(result.expectedBytes).toBeGreaterThanOrEqual(0);
    expect(board.currentTree).not.toBeNull();
  });

  test('selectiveRevalidation identifies dirty gates', () => {
    const board = new TaskBoard();
    for (let i = 0; i < 8; i++) {
      board.registerGate(makeGate(`gate-${i}`, i));
    }
    
    const sets = generateInvalidations('clustered', 8, 200, 42);
    const model = defaultCostModel(4, 3, 4096);
    board.optimizeTree(sets, model);
    
    const result = board.selectiveRevalidation([2, 3]);
    expect(result.mustRevalidate.has(2)).toBe(true);
    expect(result.mustRevalidate.has(3)).toBe(true);
    expect(result.canSkip.has(0)).toBe(true);
    expect(result.canSkip.has(7)).toBe(true);
  });

  test('snapshot returns deterministic status', () => {
    const board = new TaskBoard();
    for (let i = 0; i < 4; i++) {
      board.registerGate(makeGate(`gate-${i}`, i));
    }
    board.addTask({
      id: 'task-0',
      parentId: null,
      role: 'root',
      gateIds: [],
      contextChars: 0,
      status: 'done',
      quality: 'PASS',
      dependencyCards: [],
      depth: 0,
    });

    const snap1 = board.snapshot();
    const snap2 = board.snapshot();
    expect(snap1).toEqual(snap2);
    expect(snap1.taskCount).toBe(1);
    expect(snap1.taskStatuses['task-0']).toBe('done');
  });

  test('validateCoverage checks tree integrity', () => {
    const board = new TaskBoard();
    for (let i = 0; i < 4; i++) {
      board.registerGate(makeGate(`gate-${i}`, i));
      board.submitEvidence(`gate-${i}`, 'PASS', `fp${i}`);
    }
    
    const sets = generateInvalidations('independent', 4, 100, 42);
    board.optimizeTree(sets, defaultCostModel(4, 2, 4096));
    
    expect(board.validateCoverage()).toBe(true);
  });
});

describe('buildMesh', () => {
  test('creates hierarchical task mesh with bounded fan-out', () => {
    const board = buildMesh(64, 8, 3);
    
    expect(board.taskCount).toBeGreaterThan(0);
    expect(board.gateCount).toBe(64);
    
    // Check root exists
    const rootTasks = board.childrenOf(null);
    expect(rootTasks.length).toBe(1);
    expect(rootTasks[0].role).toBe('root');
  });

  test('respects fan-out limit', () => {
    const board = buildMesh(64, 4, 3);
    
    function maxChildren(taskId: string | null): number {
      const children = board.childrenOf(taskId);
      if (children.length === 0) return 0;
      let max = children.length;
      for (const c of children) {
        max = Math.max(max, maxChildren(c.id));
      }
      return max;
    }
    
    expect(maxChildren(null)).toBeLessThanOrEqual(4);
  });

  test('leaf tasks have gate assignments', () => {
    const board = buildMesh(16, 4, 2);
    
    for (const task of board.allTasks()) {
      if (task.role === 'leaf') {
        expect(task.gateIds.length).toBe(1);
      } else {
        expect(task.gateIds.length).toBe(0);
      }
    }
  });

  test('all tasks have valid parent references', () => {
    const board = buildMesh(32, 8, 3);
    
    for (const task of board.allTasks()) {
      if (task.parentId !== null) {
        const parent = board.getTask(task.parentId);
        expect(parent).toBeDefined();
      }
    }
  });

  test('tree depth does not exceed max', () => {
    const maxDepth = 2;
    const board = buildMesh(64, 4, maxDepth);
    
    for (const task of board.allTasks()) {
      expect(task.depth).toBeLessThanOrEqual(maxDepth);
    }
  });
});

describe('HACT vs Balanced Comparison', () => {
  test('HACT optimization beats balanced for clustered workload', () => {
    const n = 32;
    const model = defaultCostModel(8, 3, 4096);
    const sets = generateInvalidations('clustered', n, 2000, 42);
    
    const board = new TaskBoard();
    for (let i = 0; i < n; i++) {
      board.registerGate(makeGate(`gate-${i}`, i));
    }
    
    const hactResult = board.optimizeTree(sets, model);
    const balancedTree = compactBalanced(n, 4, 3);
    
    const { objective } = require('../../src/hact/tree.js');
    const { activationMatrix } = require('../../src/hact/tree.js');
    const p = activationMatrix(sets, n);
    
    const hactCost = objective(hactResult.tree, model, p);
    const balancedCost = objective(balancedTree, model, p);
    
    // HACT should be at least as good as balanced
    expect(hactCost).toBeLessThanOrEqual(balancedCost);
  });
});
