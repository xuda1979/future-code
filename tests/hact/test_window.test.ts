import { describe, test, expect } from 'bun:test';
import { PricedWindow, type PricedWindowState } from '../../src/hact/window.js';

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

describe('PricedWindow', () => {
  test('matches frozen window reference and resume round-trips', () => {
    const rng = mulberry32(2);
    const costs: number[][] = [];
    for (let t = 0; t < 193; t++) {
      costs.push(Array.from({ length: 4 }, () => Math.floor(rng() * 100)));
    }
    const m = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 500));
    for (let i = 0; i < 4; i++) m[i][i] = 0;

    let p = new PricedWindow(m, { initial: 1 });
    let active = 1;
    let service = 0;
    let sw = 0;
    for (let t = 0; t < costs.length; t++) {
      const v = costs[t];
      if (t > 0) {
        const windowRows = costs.slice(Math.max(0, t - 64), t);
        const means = Array.from({ length: 4 }, (_, j) =>
          windowRows.reduce((s, row) => s + row[j], 0) / windowRows.length);
        let candidate = 0;
        for (let j = 1; j < 4; j++) if (means[j] < means[candidate]) candidate = j;
        if (64 * (means[active] - means[candidate]) > m[active][candidate]) {
          sw += m[active][candidate];
          active = candidate;
        }
      }
      expect(p.choose()).toBe(active);
      p.observe(v);
      service += v[active];
      if (t % 7 === 0) p = PricedWindow.resume(p.state());
    }
    expect(p.serviceBytes).toBe(service);
    expect(p.switchBytes).toBe(sw);
  });

  test('rejects invalid migration matrices', () => {
    const bad: unknown[] = [
      [[0, -1], [1, 0]],
      [[1, 2], [2, 0]],
      [[0, NaN], [2, 0]],
      [],
      [[0, 1, 2], [3, 4, 5]],
    ];
    for (const matrix of bad) {
      expect(() => new PricedWindow(matrix as number[][])).toThrow();
    }
  });

  test('invalid measurements preserve pending', () => {
    const p = new PricedWindow([[0, 2], [2, 0]]);
    p.choose();
    for (const costs of [[1], [-1, 2], [1, Infinity], [NaN, 2]]) {
      expect(() => p.observe(costs as number[])).toThrow();
    }
    p.observe([1, 2]);
    expect(p.rounds).toBe(1);
  });

  test('protocol ordering and tie behavior', () => {
    const p = new PricedWindow([[0, 0], [0, 0]], { initial: 1 });
    expect(() => p.observe([1, 2])).toThrow();
    expect(p.choose()).toBe(1);
    expect(() => p.choose()).toThrow();
    expect(() => p.state()).toThrow();
    p.observe([1, 1]);
    expect(p.choose()).toBe(1);
    p.observe([1, 1]);
    expect(p.switchCount).toBe(0);
  });

  test('rejects bad checkpoints', () => {
    const p = new PricedWindow([[0, 1], [1, 0]]);
    p.choose();
    p.observe([2, 3]);
    const s = p.state() as Record<string, unknown>;
    const badFields: Array<[string, unknown]> = [
      ['round', -1],
      ['switches', -2],
      ['history', []],
      ['service', NaN],
      ['active', 4],
      ['window', 0],
      ['schema', 'wrong'],
    ];
    for (const [field, value] of badFields) {
      const copy = { ...s, [field]: value } as unknown as PricedWindowState;
      expect(() => PricedWindow.resume(copy)).toThrow();
    }
  });
});
