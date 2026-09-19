import { describe, test, expect } from 'bun:test';
import { GateRegistry, GenerationTracker } from '../../src/hact/certificates.js';
import type { Gate } from '../../src/hact/types.js';

describe('GateRegistry', () => {
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

  test('register and get gate', () => {
    const reg = new GateRegistry();
    const gate = makeGate('gate-0', 0);
    reg.register(gate);
    expect(reg.get('gate-0')).toEqual(gate);
    expect(reg.count).toBe(1);
  });

  test('duplicate registration throws', () => {
    const reg = new GateRegistry();
    reg.register(makeGate('gate-0', 0));
    expect(() => reg.register(makeGate('gate-0', 0))).toThrow();
  });

  test('submit evidence and retrieve latest', () => {
    const reg = new GateRegistry();
    reg.register(makeGate('gate-0', 0));
    
    const ev1 = reg.submit('gate-0', 'PASS', 'fp1', { result: 'ok' });
    expect(ev1.verdict).toBe('PASS');
    expect(ev1.fingerprint).toBe('fp1');
    
    const ev2 = reg.submit('gate-0', 'FAIL', 'fp2', { result: 'bad' });
    expect(reg.latest('gate-0')?.verdict).toBe('FAIL');
    
    expect(reg.history('gate-0').length).toBe(2);
  });

  test('submit to unknown gate throws', () => {
    const reg = new GateRegistry();
    expect(() => reg.submit('unknown', 'PASS', 'fp')).toThrow();
  });

  test('buildTree aggregates verdicts', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 4; i++) {
      reg.register(makeGate(`gate-${i}`, i));
    }
    reg.submit('gate-0', 'PASS', 'fp0');
    reg.submit('gate-1', 'PASS', 'fp1');
    reg.submit('gate-2', 'FAIL', 'fp2');
    reg.submit('gate-3', 'PASS', 'fp3');

    const tree = reg.buildTree(0, 3, []);
    expect(tree.verdict).toBe('FAIL');
    expect(tree.counts).toEqual([3, 1, 0]);
  });

  test('buildTree with unknown verdicts', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 3; i++) {
      reg.register(makeGate(`gate-${i}`, i));
    }
    // Only submit evidence for gate-0
    reg.submit('gate-0', 'PASS', 'fp0');
    
    const tree = reg.buildTree(0, 2, []);
    expect(tree.verdict).toBe('UNKNOWN');
    expect(tree.counts).toEqual([1, 0, 2]);
  });

  test('verifyTicket requires all pass', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 3; i++) {
      reg.register(makeGate(`gate-${i}`, i));
    }
    for (let i = 0; i < 3; i++) {
      reg.submit(`gate-${i}`, 'PASS', `fp${i}`);
    }
    const tree = reg.buildTree(0, 2, []);
    expect(reg.verifyTicket(tree)).toBe(true);
  });

  test('verifyTicket rejects if any fail', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 3; i++) {
      reg.register(makeGate(`gate-${i}`, i));
    }
    reg.submit('gate-0', 'PASS', 'fp0');
    reg.submit('gate-1', 'FAIL', 'fp1');
    reg.submit('gate-2', 'PASS', 'fp2');
    const tree = reg.buildTree(0, 2, []);
    expect(reg.verifyTicket(tree)).toBe(false);
  });

  test('checkExternalCapsule validates against canonical', () => {
    const reg = new GateRegistry();
    for (let i = 0; i < 2; i++) {
      reg.register(makeGate(`gate-${i}`, i));
      reg.submit(`gate-${i}`, 'PASS', `fp${i}`);
    }
    const capsule = reg.capsule(0, 1, [], ['hash1', 'hash2']);
    
    // Valid capsule
    const validJson = new TextEncoder().encode(JSON.stringify({
      rootHash: capsule.rootHash,
      counts: capsule.counts,
      lo: capsule.lo,
      hi: capsule.hi,
      generation: capsule.generation,
    }));
    expect(reg.checkExternalCapsule(validJson, capsule)).toBe(true);
    
    // Tampered capsule
    const tamperedJson = new TextEncoder().encode(JSON.stringify({
      rootHash: 'fake',
      counts: [2, 0, 0],
      lo: 0,
      hi: 1,
      generation: 0,
    }));
    expect(reg.checkExternalCapsule(tamperedJson, capsule)).toBe(false);
  });

  test('advanceGeneration increments generation', () => {
    const reg = new GateRegistry();
    expect(reg.currentGeneration).toBe(0);
    reg.advanceGeneration();
    expect(reg.currentGeneration).toBe(1);
    reg.advanceGeneration();
    expect(reg.currentGeneration).toBe(2);
  });
});

describe('GenerationTracker', () => {
  test('bump increments global generation', () => {
    const tracker = new GenerationTracker();
    expect(tracker.currentGlobalGeneration).toBe(0);
    const gen1 = tracker.bump('gate-0');
    expect(gen1).toBe(1);
    const gen2 = tracker.bump('gate-1');
    expect(gen2).toBe(2);
    expect(tracker.currentGlobalGeneration).toBe(2);
  });

  test('get returns 0 for unknown gate', () => {
    const tracker = new GenerationTracker();
    expect(tracker.get('unknown')).toBe(0);
  });

  test('get returns last bumped generation', () => {
    const tracker = new GenerationTracker();
    tracker.bump('gate-0'); // gen 1
    tracker.bump('gate-0'); // gen 2
    tracker.bump('gate-1'); // gen 3
    expect(tracker.get('gate-0')).toBe(2);
    expect(tracker.get('gate-1')).toBe(3);
  });

  test('stampInterval records max generation in range', () => {
    const tracker = new GenerationTracker();
    tracker.bump('gate-0'); // gen 1
    tracker.bump('gate-1'); // gen 2
    tracker.bump('gate-2'); // gen 3
    tracker.bump('gate-3'); // gen 4
    
    const gateGens = [1, 2, 3, 4];
    const stamp = tracker.stampInterval(0, 2, gateGens);
    expect(stamp).toBe(3);
  });

  test('isValidInterval detects stale stamps', () => {
    const tracker = new GenerationTracker();
    tracker.bump('gate-0'); // gen 1
    tracker.bump('gate-1'); // gen 2
    
    const gateGens = [1, 2];
    tracker.stampInterval(0, 1, gateGens);
    expect(tracker.isValidInterval(0, 1, gateGens)).toBe(true);
    
    // Bump gate-0, making the stamp stale
    tracker.bump('gate-0'); // gen 3
    const newGens = [3, 2];
    expect(tracker.isValidInterval(0, 1, newGens)).toBe(false);
  });

  test('isValidInterval returns false for unstamped interval', () => {
    const tracker = new GenerationTracker();
    expect(tracker.isValidInterval(0, 1, [0, 0])).toBe(false);
  });
});
