/**
 * Exact microtree optimization under a fixed contiguous block backbone.
 *
 * This is NOT a global approximation guarantee. Macro topology and display
 * order are held fixed. Training hyperedges, never evaluation waves, fit each
 * microtree. The fixed-backbone block compiler is exact only inside each
 * constrained block. It may lose to a simple balanced layout; preserve that
 * baseline.
 *
 * Ported from ichact/blocked.py + ichact/layout.py (Adaptive HACT v4.0.0),
 * adapted to the TypeScript certificate-tree representation in ./tree.js.
 */

import {
  type CertNode,
  type CostModel,
} from './types.js';
import { makeNode, leaf, compactBalanced, activationMatrix, optimize } from './tree.js';
import { defaultCostModel } from './costModel.js';

export interface BlockedLayout {
  readonly registry: readonly string[];
  readonly order: readonly number[];
  readonly tree: CertNode;
  readonly model: CostModel;
  readonly blockSize: number;
}

/** Validate an exact integer registry permutation. */
export function permutation(values: readonly number[], n: number): readonly number[] {
  if (!Array.isArray(values) || values.length !== n) {
    throw new Error('layout must be an exact integer registry permutation');
  }
  const seen = new Set<number>();
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen.has(v)) {
      throw new Error('layout must be an exact integer registry permutation');
    }
    seen.add(v);
  }
  if (seen.size !== n) throw new Error('layout must be an exact integer registry permutation');
  return values;
}

interface InternalNodeSummary {
  // BigInt bitmask over canonical order positions, so n > 30 registries stay exact.
  readonly cover: bigint;
  readonly price: number; // packet bytes for this node's arity
}

function coverageOf(tree: CertNode, order: readonly number[], model: CostModel): InternalNodeSummary[] {
  const out: InternalNodeSummary[] = [];
  function visit(node: CertNode): void {
    if (node.children.length === 0) return;
    let cover = 0n;
    for (let p = node.lo; p <= node.hi && p < order.length; p++) {
      cover |= 1n << BigInt(order[p]);
    }
    out.push({ cover, price: model.packetBytes(node.children.length) });
    for (const child of node.children) visit(child);
  }
  visit(tree);
  return out;
}

/** Compute the total packet bytes of every internal node (initial full refresh). */
export function fullRefreshBytes(tree: CertNode, model: CostModel): number {
  let total = 0;
  function visit(node: CertNode): void {
    if (node.children.length === 0) return;
    total += model.packetBytes(node.children.length);
    for (const child of node.children) visit(child);
  }
  visit(tree);
  return total;
}

/**
 * Fit a block-backbone layout: each contiguous block of `blockSize` canonical
 * positions is compiled exactly from training episodes alone, then the block
 * microtrees are composed under a balanced macro topology.
 */
export function fitBlocked(
  registry: readonly string[],
  episodes: readonly (readonly (readonly number[])[])[],
  orderInput?: readonly number[],
  opts: { readonly blockSize?: number; readonly model?: CostModel; readonly maxDepth?: number } = {},
): BlockedLayout {
  const reg = Array.from(registry);
  const n = reg.length;
  if (reg.some((g) => typeof g !== 'string' || g.length === 0) || new Set(reg).size !== n) {
    throw new Error('nonempty unique semantic IDs required');
  }
  const blockSize = opts.blockSize ?? 32;
  if (!Number.isInteger(blockSize) || blockSize < 2) {
    throw new Error('block_size >= 2 required');
  }
  if (n === 0) throw new Error('nonempty registry required');
  if (!episodes || episodes.length === 0) throw new Error('training required');
  const model = opts.model ?? defaultCostModel();

  const order = permutation(orderInput ?? range(n), n);
  const inverse = new Map<number, number>();
  order.forEach((g, p) => inverse.set(g, p));

  // Validate episodes and transform canonical indices to block-local positions.
  const transformed: number[][][] = [];
  for (const episode of episodes) {
    const converted: number[][] = [];
    for (const wave of episode) {
      const local: number[] = [];
      for (const g of wave) {
        if (typeof g !== 'number' || Number.isInteger(g) === false || !inverse.has(g)) {
          throw new Error('invalid canonical check index');
        }
        local.push(inverse.get(g)!);
      }
      converted.push(Array.from(new Set(local)));
    }
    transformed.push(converted);
  }

  // Fit each contiguous block exactly with an optimal microtree.
  const microtrees: CertNode[] = [];
  for (let lo = 0; lo < n; lo += blockSize) {
    const hi = Math.min(n, lo + blockSize);
    const size = hi - lo;
    // Project waves into [0, size).
    const localEpisodes: number[][] = [];
    for (const episode of transformed) {
      for (const wave of episode) {
        const local = wave.filter((p) => p >= lo && p < hi).map((p) => p - lo);
        if (local.length > 0) localEpisodes.push(local);
      }
    }
    let micro: CertNode;
    if (size === 1 || localEpisodes.length === 0) {
      micro = leaf(lo);
    } else {
      const p = activationMatrix(localEpisodes, size);
      const result = optimize(size, boundedModel(model, size), p);
      micro = offsetTree(result.tree, lo);
    }
    microtrees.push(micro);
  }

  const macro = compactBalanced(microtrees.length, model.maxArity, Math.max(1, model.maxHeight));
  const tree = expandMacro(macro, microtrees);
  // Block-backbone composition intentionally nests a macro topology above
  // per-block microtrees, so the nominal model height is not enforced here.
  // Coverage and partition structure are still validated.
  validateBlockCoverage(tree, n);
  return { registry: reg, order, tree, model, blockSize };
}

/** Validate interval coverage and contiguous partition structure without a height bound. */
export function validateBlockCoverage(tree: CertNode, n: number): void {
  if (n < 1) throw new Error('unsupported gate count');
  if (tree.lo !== 0 || tree.hi !== n - 1) throw new Error('root does not cover registry');
  (function visit(node: CertNode): void {
    if (!(node.lo >= 0) || !(node.hi >= 0) || !(node.lo <= node.hi) || node.hi >= n) {
      throw new Error('invalid interval');
    }
    if (node.children.length === 0) {
      if (node.lo !== node.hi) throw new Error('non-singleton leaf');
      return;
    }
    let end = node.lo;
    for (const child of node.children) {
      if (child.lo !== end) throw new Error('overlap or missing coverage');
      end = child.hi + 1;
    }
    if (end !== node.hi + 1) throw new Error('children do not partition parent');
    for (const child of node.children) visit(child);
  })(tree);
}

function range(n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function boundedModel(model: CostModel, size: number): CostModel {
  // optimize() requires maxArity >= 2 and <= size; clamp to the block size.
  return {
    packetBytes: model.packetBytes,
    maxHeight: model.maxHeight,
    maxArity: Math.min(model.maxArity, size),
    byteCap: model.byteCap,
  };
}

function offsetTree(node: CertNode, offset: number): CertNode {
  if (node.children.length === 0) {
    return leaf(node.lo + offset);
  }
  return makeNode(
    node.lo + offset,
    node.hi + offset,
    node.children.map((c) => offsetTree(c, offset)),
    node.depth,
  );
}

function expandMacro(macro: CertNode, blocks: readonly CertNode[]): CertNode {
  if (macro.children.length === 0) {
    // Singleton macro group is promoted to the block microtree directly.
    return blocks[macro.lo];
  }
  const children = macro.children.map((c) => expandMacro(c, blocks));
  return makeNode(children[0].lo, children[children.length - 1].hi, children, macro.depth);
}

/**
 * Cost of running the layout over a set of completion waves. `initial=true`
 * also charges a full refresh (all internal nodes once).
 */
export function layoutCost(
  layout: BlockedLayout,
  waves: readonly (readonly number[])[],
  initial = true,
): number {
  const cov = coverageOf(layout.tree, layout.order, layout.model);
  let total = initial ? fullRefreshBytes(layout.tree, layout.model) : 0;
  for (const wave of waves) {
    let mask = 0n;
    for (const i of wave) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= layout.registry.length) {
        throw new Error('unknown canonical obligation index');
      }
      mask |= 1n << BigInt(i);
    }
    for (const node of cov) {
      if ((mask & node.cover) !== 0n) total += node.price;
    }
  }
  return total;
}

/** Block coverage as a list of [bigint bitmask, packet-bytes] for each internal node. */
export function blockCoverage(layout: BlockedLayout): ReadonlyArray<readonly [bigint, number]> {
  return coverageOf(layout.tree, layout.order, layout.model).map((s) => [s.cover, s.price] as const);
}
