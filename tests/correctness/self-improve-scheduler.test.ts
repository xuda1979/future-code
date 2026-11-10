import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./self-improve-loader.mjs', import.meta.url);
const scheduler = await import('../../src/services/selfImprove/scheduler.ts');

test('background read failures never terminate foreground work, and later ticks recover', () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick!: () => void, checks = 0, cleared = 0, unref = 0;
  const diagnostics: string[] = [];
  (globalThis as any).__selfImproveSchedulerCheck = () => {
    checks++;
    if (checks < 3) throw new Error('ledger temporarily unreadable');
    return { started: false, reason: 'not due' };
  };
  (globalThis as any).__selfImproveDebug = (text: string) => diagnostics.push(text);
  (globalThis as any).setInterval = (callback: () => void, ms: number) => {
    assert.equal(ms, 60_000); tick = callback; return { unref: () => { unref++; } };
  };
  (globalThis as any).clearInterval = () => { cleared++; };
  try {
    assert.doesNotThrow(() => scheduler.armSelfImproveScheduler());
    assert.equal(scheduler.isSelfImproveSchedulerArmed(), true);
    assert.equal(checks, 1); assert.equal(unref, 1);
    assert.doesNotThrow(() => tick()); assert.doesNotThrow(() => tick());
    assert.equal(checks, 3); assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0]!, /ledger temporarily unreadable/);
    scheduler.armSelfImproveScheduler(); assert.equal(checks, 3, 'arming twice cannot start duplicate loops');
    scheduler.disarmSelfImproveScheduler(); scheduler.disarmSelfImproveScheduler();
    assert.equal(cleared, 1); assert.equal(scheduler.isSelfImproveSchedulerArmed(), false);
  } finally {
    scheduler.disarmSelfImproveScheduler(); globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
    delete (globalThis as any).__selfImproveSchedulerCheck; delete (globalThis as any).__selfImproveDebug;
  }
});
