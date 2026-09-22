import { describe, test, expect } from 'bun:test';
import { fitBlocked, layoutCost, blockCoverage, permutation, validateBlockCoverage } from '../../src/hact/blocked.js';
import { activationMatrix, optimize, leaves } from '../../src/hact/tree.js';
import { defaultCostModel } from '../../src/hact/costModel.js';

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function genEpisodes(n: number, seed: number, count: number, density: number) {
  const rng = mulberry32(seed);
  const episodes: number[][][] = [];
  for (let e = 0; e < count; e++) {
    const wave: number[] = [];
    for (let i = 0; i < n; i++) {
      if (rng() < density) wave.push(i);
    }
    episodes.push([wave]);
  }
  return episodes;
}

function exactTree(n: number, episodes: number[][][], order: number[], model: ReturnType<typeof defaultCostModel>) {
  // Transform to order positions, fit exact DP over whole registry.
  const inverse = new Map<number, number>();
  order.forEach((g, p) => inverse.set(g, p));
  const localEpisodes: number[][] = [];
  for (const ep of episodes) {
    for (const wave of ep) {
      localEpisodes.push(Array.from(new Set(wave.map((g) => inverse.get(g)!))).sort((a, b) => a - b));
    }
  }
  const p = activationMatrix(localEpisodes, n);
  return optimize(n, { ...model, maxArity: Math.min(model.maxArity, n) }, p).tree;
}

describe('fitBlocked', () => {
  test('single block equals exact optimization', () => {
    for (const n of [1, 2, 5, 8, 17, 33]) {
      const episodes = genEpisodes(n, n, 8, 0.3);
      const reg = Array.from({ length: n }, (_, i) => String(i));
      let rng2 = mulberry32(n);
      const order = Array.from({ length: n }, (_, i) => i);
      // shuffle deterministically
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng2() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const exact = exactTree(n, episodes, order, defaultCostModel());
      const blocked = fitBlocked(reg, episodes, order, { blockSize: Math.max(2, n) });
      // With a single block covering all gates, microtree should match exact.
      const exactSame = sameTreeShape(exact, blocked.tree);
      expect(exactSame).toBe(true);
    }
  });

  test('restricted block compile is not below exact on training cost', () => {
    for (const n of [7, 16, 31, 65]) {
      const episodes = genEpisodes(n, n, 7, 0.25);
      const reg = Array.from({ length: n }, (_, i) => String(i));
      let rng2 = mulberry32(n);
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng2() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const waves = episodes.map((ep) => ep[0]);
      const blocked = fitBlocked(reg, episodes, order, { blockSize: 4 });
      expect(() => validateBlockCoverage(blocked.tree, n)).not.toThrow();
      const leafPositions = leaves(blocked.tree).map((l) => l.lo).sort((a, b) => a - b);
      expect(leafPositions).toEqual(Array.from({ length: n }, (_, i) => i));
      const exact = exactTree(n, episodes, order, defaultCostModel());
      const blockedCost = layoutCost({ ...blocked }, waves, true);
      // The exact full-cost baseline uses initial full-refresh too.
      const exactCost = layoutCost({ registry: reg, order, tree: exact, model: blocked.model, blockSize: 4 }, waves, true);
      expect(blockedCost).toBeGreaterThanOrEqual(exactCost - 1e-6);
    }
  });

  test('rejects bad input', () => {
    const reg = ['a', 'b'];
    expect(() => fitBlocked(reg, [[[0]]], undefined, { blockSize: 1 })).toThrow();
    expect(() => fitBlocked(reg, [[[0]]], undefined, { blockSize: 1 as unknown as number })).toThrow();
    expect(() => fitBlocked(reg, [[[0]]], [0, 0])).toThrow();
  });

  test('rejects invalid check indices and empty training', () => {
    expect(() => fitBlocked(['a', 'b'], [], undefined)).toThrow();
    expect(() => fitBlocked(['a', 'b'], [[[4]]], undefined)).toThrow();
    expect(() => fitBlocked(['a', 'b'], [[[true as unknown as number]]], undefined)).toThrow();
  });

  test('coverage leaves one bit per leaf position in order space', () => {
    const n = 12;
    const episodes = genEpisodes(n, 99, 6, 0.4);
    const reg = Array.from({ length: n }, (_, i) => String(i));
    const order = Array.from({ length: n }, (_, i) => i);
    const blocked = fitBlocked(reg, episodes, order, { blockSize: 3 });
    const cov = blockCoverage(blocked);
    for (const [cover, price] of cov) {
      expect(typeof cover).toBe('bigint');
      expect(cover > 0n).toBe(true);
      expect(price > 0).toBe(true);
    }
  });
});

function sameTreeShape(a: { lo: number; hi: number; children: readonly { lo: number; hi: number; children: readonly unknown[] }[] }, b: { lo: number; hi: number; children: readonly { lo: number; hi: number; children: readonly unknown[] }[] }): boolean {
  if (a.lo !== b.lo || a.hi !== b.hi) return false;
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    if (!sameTreeShape(a.children[i] as never, b.children[i] as never)) return false;
  }
  return true;
}
