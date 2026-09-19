/**
 * Bounded hierarchical coordination with HACT certificate trees.
 *
 * Integrates the HACT certificate tree optimizer with the future-code
 * task mesh. Provides:
 * - Bounded fan-out ownership with certificate-based quality gates
 * - Selective revalidation using optimal tree structures
 * - Per-gate monotonic generations to prevent stale cache revival
 * - Deterministic status rollups (no LLM on the scheduling critical path)
 *
 * Based on FCC v1.2.0 coordination layer and HACT research.
 */

import {
  type CertNode,
  type CertTree,
  type CostModel,
  type Gate,
  type Evidence,
} from './types.js';
import { optimize, compactBalanced, validateTree, leaf, stats } from './tree.js';
import { GateRegistry, GenerationTracker } from './certificates.js';
import { activationMatrix } from './tree.js';
import { generateInvalidations } from './workload.js';
import { defaultCostModel } from './costModel.js';

/** A task in the hierarchical mesh. */
export interface MeshTask {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: 'leaf' | 'integrator' | 'root';
  readonly gateIds: readonly string[];
  readonly contextChars: number;
  readonly status: 'pending' | 'running' | 'done' | 'blocked' | 'failed';
  readonly quality: 'UNKNOWN' | 'PASS' | 'FAIL';
  readonly dependencyCards: readonly string[];
  readonly depth: number;
}

/** A task board is a projection of durable records, not an LLM conversation. */
export class TaskBoard {
  private readonly tasks = new Map<string, MeshTask>();
  private readonly children = new Map<string | null, string[]>();
  private readonly registry: GateRegistry;
  private readonly tracker: GenerationTracker;
  private tree: CertTree | null = null;
  private treeModel: CostModel | null = null;

  constructor() {
    this.registry = new GateRegistry();
    this.tracker = new GenerationTracker();
  }

  /** Register a gate with the board. */
  registerGate(gate: Gate): void {
    this.registry.register(gate);
  }

  /** Add a task to the board. */
  addTask(task: MeshTask): void {
    this.tasks.set(task.id, task);
    const siblings = this.children.get(task.parentId) ?? [];
    siblings.push(task.id);
    this.children.set(task.parentId, siblings);
  }

  /** Get a task by ID. */
  getTask(id: string): MeshTask | undefined {
    return this.tasks.get(id);
  }

  /** Get children of a task. */
  childrenOf(taskId: string | null): readonly MeshTask[] {
    const ids = this.children.get(taskId) ?? [];
    return ids.map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  /** Get all tasks. */
  allTasks(): readonly MeshTask[] {
    return Array.from(this.tasks.values());
  }

  /** Get task count. */
  get taskCount(): number {
    return this.tasks.size;
  }

  /** Get gate count. */
  get gateCount(): number {
    return this.registry.count;
  }

  /** Submit evidence for a gate. */
  submitEvidence(
    gateId: string,
    verdict: 'PASS' | 'FAIL' | 'UNKNOWN',
    fingerprint: string,
    details: Record<string, unknown> = {},
  ): Evidence {
    if (verdict === 'FAIL' || verdict === 'PASS') {
      this.tracker.bump(gateId);
    }
    return this.registry.submit(gateId, verdict, fingerprint, details);
  }

  /** Optimize the certificate tree for the current gate set. */
  optimizeTree(
    invalidationHistory: readonly (readonly number[])[],
    model: CostModel = defaultCostModel(),
  ): { tree: CertNode; expectedBytes: number } {
    const n = this.registry.count;
    if (n === 0) throw new Error('No gates registered');

    const p = activationMatrix(invalidationHistory, n);
    const result = optimize(n, model, p);
    this.treeModel = model;

    // Build the certificate tree
    this.tree = this.registry.buildTree(0, n - 1, result.tree.children);
    return result;
  }

  /** Get the current certificate tree. */
  get currentTree(): CertTree | null {
    return this.tree;
  }

  /** Get the gate registry. */
  get gates(): GateRegistry {
    return this.registry;
  }

  /** Get the generation tracker. */
  get generations(): GenerationTracker {
    return this.tracker;
  }

  /** Compute selective revalidation set for a given invalidation. */
  selectiveRevalidation(invalidatedGates: readonly number[]): {
    mustRevalidate: Set<number>;
    canSkip: Set<number>;
    treeNodes: CertNode[];
  } {
    const n = this.registry.count;
    const mustRevalidate = new Set<number>();
    const canSkip = new Set<number>();
    const treeNodes: CertNode[] = [];

    // For each gate, determine if it's in the invalidation set
    for (let g = 0; g < n; g++) {
      if (invalidatedGates.includes(g)) {
        mustRevalidate.add(g);
      } else {
        canSkip.add(g);
      }
    }

    // If we have a tree, find the minimal set of nodes to revalidate
    if (this.tree) {
      function findMinimalNodes(node: CertNode): boolean {
        if (node.children.length === 0) {
          return invalidatedGates.includes(node.lo);
        }
        let anyChildDirty = false;
        for (const child of node.children) {
          if (findMinimalNodes(child)) {
            anyChildDirty = true;
          }
        }
        if (anyChildDirty) {
          treeNodes.push(node);
        }
        return anyChildDirty;
      }
      findMinimalNodes(this.tree.root);
    }

    return { mustRevalidate, canSkip, treeNodes };
  }

  /** Generate a status snapshot (deterministic, no LLM). */
  snapshot(): {
    taskCount: number;
    gateCount: number;
    treeVerdict: string;
    treeGeneration: number;
    taskStatuses: Record<string, string>;
    taskQualities: Record<string, string>;
  } {
    const taskStatuses: Record<string, string> = {};
    const taskQualities: Record<string, string> = {};
    for (const task of this.allTasks()) {
      taskStatuses[task.id] = task.status;
      taskQualities[task.id] = task.quality;
    }

    return {
      taskCount: this.tasks.size,
      gateCount: this.registry.count,
      treeVerdict: this.tree?.verdict ?? 'UNKNOWN',
      treeGeneration: this.tree?.generation ?? 0,
      taskStatuses,
      taskQualities,
    };
  }

  /** Validate the tree covers all gates. */
  validateCoverage(): boolean {
    if (!this.tree) return false;
    try {
      validateTree(this.tree.root, this.registry.count, this.treeModel ?? defaultCostModel());
      return this.registry.verifyTicket(this.tree);
    } catch {
      return false;
    }
  }
}

/** Build a hierarchical task mesh with bounded fan-out. */
export function buildMesh(
  leafCount: number,
  fanoutLimit: number,
  maxDepth: number,
): TaskBoard {
  const board = new TaskBoard();

  // Register gates for each leaf
  for (let i = 0; i < leafCount; i++) {
    board.registerGate({
      id: `gate-${i}`,
      kind: 'unit',
      module: i,
      checker: 'default-checker',
      readSet: [`module-${i}`],
      configHash: `config-${i}`,
    });
  }

  // Build tree structure
  const tree = compactBalanced(leafCount, fanoutLimit, maxDepth);

  // Create tasks from tree nodes
  function createTasks(
    node: CertNode,
    depth: number,
    parentId: string | null,
  ): string {
    const id = `task-${node.lo}-${node.hi}-d${depth}`;
    const role = node.children.length === 0 ? 'leaf' : depth === 0 ? 'root' : 'integrator';
    const gateIds = node.children.length === 0
      ? [`gate-${node.lo}`]
      : [];

    board.addTask({
      id,
      parentId,
      role: role as MeshTask['role'],
      gateIds,
      contextChars: 0,
      status: 'pending',
      quality: 'UNKNOWN',
      dependencyCards: [],
      depth,
    });

    for (const child of node.children) {
      createTasks(child, depth + 1, id);
    }

    return id;
  }

  createTasks(tree, 0, null);
  return board;
}
