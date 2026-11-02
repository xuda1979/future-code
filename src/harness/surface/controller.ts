import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FrameDelta, HIDAction, InteractiveSurfaceDriver, PostCondition, SceneFrame, StateDeltaReceipt, SurfaceBatch, SurfaceDelta, SurfaceResult } from "./protocol.ts";
import { validateBatch } from "./protocol.ts";
import { SurfaceJournal } from "./journal.ts";

const emptyDelta = (): SurfaceDelta => ({ uriChanged: false, focusChanged: false, nodesAdded: 0, nodesRemoved: 0,
  nodesMutated: 0, layoutChanged: false, network: [], storageChanged: null, visualDiffRatio: null, targetVisualDiffRatio: null });
function structural(before: SceneFrame, after: SceneFrame): SurfaceDelta {
  const a = new Map(before.nodes.map(n => [n.ref, n])), b = new Map(after.nodes.map(n => [n.ref, n]));
  const semantic = (n: SceneFrame["nodes"][number]) => JSON.stringify([n.role, n.name, n.value ?? null, [...n.states].sort()]);
  const focused = (f: SceneFrame) => f.nodes.find(n => n.states.includes("focused"))?.ref;
  return { ...emptyDelta(), uriChanged: before.locationUri !== after.locationUri, focusChanged: focused(before) !== focused(after),
    nodesAdded: after.nodes.filter(n => !a.has(n.ref)).length, nodesRemoved: before.nodes.filter(n => !b.has(n.ref)).length,
    nodesMutated: after.nodes.filter(n => a.has(n.ref) && semantic(a.get(n.ref)!) !== semantic(n)).length,
    layoutChanged: JSON.stringify(before.viewport) !== JSON.stringify(after.viewport) || after.nodes.some(n => a.has(n.ref) && JSON.stringify(a.get(n.ref)!.bbox) !== JSON.stringify(n.bbox)) };
}
function guard(expect: PostCondition, source: SceneFrame, before: SceneFrame, after: SceneFrame): boolean {
  const rebound = (mark: number) => after.nodes.find(n => n.ref === source.nodes.find(n => n.markId === mark)?.ref);
  return (expect.targetFocused === undefined || !!rebound(expect.targetFocused)?.states.includes("focused")) &&
    (expect.targetValue === undefined || rebound(expect.targetValue.markId)?.value === expect.targetValue.equals) &&
    (expect.targetState === undefined || !!rebound(expect.targetState.markId) && rebound(expect.targetState.markId)!.states.includes(expect.targetState.state) === expect.targetState.present) &&
    (expect.nodeAppearedWithText === undefined || after.nodes.some(n => n.name.includes(expect.nodeAppearedWithText!) && !before.nodes.some(p => p.ref === n.ref && p.name.includes(expect.nodeAppearedWithText!)))) &&
    (expect.uriEquals === undefined || after.locationUri === expect.uriEquals) &&
    (expect.uriChanged === undefined || (after.locationUri !== before.locationUri) === expect.uriChanged);
}
function contentUnchanged(a: SceneFrame, b: SceneFrame): boolean {
  const d = structural(a, b);
  return a.documentId === b.documentId && !d.uriChanged && !d.focusChanged && !d.layoutChanged && !d.nodesAdded && !d.nodesRemoved && !d.nodesMutated &&
    a.nodes.length === b.nodes.length && a.nodes.every(n => b.nodes.find(p => p.ref === n.ref)?.hitTestClear === n.hitTestClear);
}

/** Single owner/serialized surface lease. No automatic resend after dispatch,
 * including timeouts and zero deltas: a late external effect may still occur. */
export class SurfaceController {
  readonly driver: InteractiveSurfaceDriver;
  readonly journal: SurfaceJournal;
  private frame?: SceneFrame;
  private delta?: FrameDelta;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(driver: InteractiveSurfaceDriver, journal: SurfaceJournal) { this.driver = driver; this.journal = journal; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next;
  }
  private retain(frame: SceneFrame): SceneFrame {
    if (this.frame) {
      const d = structural(this.frame, frame);
      this.delta = { from: this.frame.frameId, to: frame.frameId, added: d.nodesAdded, removed: d.nodesRemoved, changed: d.nodesMutated, locationChanged: d.uriChanged };
      this.journal.retire(this.frame);
    }
    this.frame = frame;
    if (frame.blocker && !this.journal.interrupt()) this.pause(frame.blocker, frame);
    return frame;
  }
  private pause(reason: "UNKNOWN_ACTION" | NonNullable<SceneFrame["blocker"]>, frame: SceneFrame): void {
    this.journal.pause({ signal: "SIG_SURFACE_INTERVENTION", id: randomUUID(), reason, since: Date.now(), frameId: frame.frameId });
  }
  private result(receipts: StateDeltaReceipt[] = []): SurfaceResult {
    return { schema: 1, kind: "interactive-surface", sessionId: this.journal.sessionId,
      ok: !this.journal.interrupt() && receipts.every(r => r.ok), receipts, frame: this.frame!, ...(this.delta ? { delta: this.delta } : {}),
      ...(this.journal.interrupt() ? { interrupt: this.journal.interrupt() } : {}),
      affordanceNotes: this.journal.notes(this.frame!.locationUri),
      liveness: { paused: !!this.journal.interrupt(), pausedMs: this.journal.pausedMs() }, trust: "OBSERVATION_NOT_ACCEPTANCE" };
  }
  observe(includeVisual = false): Promise<SurfaceResult> {
    return this.serial(async () => { this.retain(await this.driver.observe(includeVisual)); return this.result(); });
  }
  inspect(key: string, batch: SurfaceBatch): Promise<SurfaceResult | null> {
    return this.serial(async () => {
      const stored = this.journal.inspect(key, batch);
      if (!stored?.interrupt) return stored;
      // A completed human handoff releases the wait, never claims the aborted
      // action/batch succeeded and never dispatches its unexecuted suffix.
      this.retain(await this.driver.observe(false));
      return { ...this.result(stored.receipts), ok: false };
    });
  }
  /** Operator-only: observing the barrier disappear does not auto-resume. */
  resume(interruptId: string, expectedFrameId: string): Promise<SurfaceResult> {
    return this.serial(async () => {
      if (this.journal.interrupt()?.id !== interruptId || this.frame?.frameId !== expectedFrameId) throw new Error("stale surface handoff");
      if (this.journal.interrupt()?.reason === "UNKNOWN_ACTION") throw new Error("uncertain action requires explicit operator reconciliation");
      const fresh = await this.driver.observe(false);
      if (fresh.blocker) throw new Error("surface blocker still present");
      this.retain(fresh); this.journal.resume(fresh); return this.result();
    });
  }
  /** Explicit human reconciliation releases uncertainty, never verifies the
   * intended effect. Independent task checks still own final acceptance. */
  reconcile(key: string, batch: SurfaceBatch, interruptId: string, expectedFrameId: string): Promise<SurfaceResult> {
    validateBatch(batch);
    return this.serial(async () => {
      const interrupt = this.journal.interrupt();
      if (interrupt?.id !== interruptId || interrupt.reason !== "UNKNOWN_ACTION" || this.frame?.frameId !== expectedFrameId) throw new Error("stale surface reconciliation");
      this.journal.assertAction(key, batch);
      const fresh = await this.driver.observe(false); if (fresh.blocker) throw new Error("surface blocker still present");
      this.retain(fresh); this.journal.resume(fresh);
      const result = this.result([{ schema: 1, index: 0, beforeFrameId: batch.expectedFrameId, afterFrameId: fresh.frameId,
        ok: false, outcome: "OPERATOR_RECONCILED", dispatched: true, silentNoOpDetected: false, settledAfterMs: 0, deltas: emptyDelta() }]);
      this.journal.episode("INTERVENTION_MEMORY.reconciled", { key, interruptId, afterFrameId: fresh.frameId });
      this.journal.finish(key, result); return result;
    });
  }
  execute(key: string, batch: SurfaceBatch): Promise<SurfaceResult> {
    validateBatch(batch);
    return this.serial(async () => {
      const old = this.journal.start(key, batch);
      if (!old.fresh) {
        if (old.result) return old.result;
        this.retain(await this.driver.observe(false));
        if (!this.journal.interrupt()) this.pause("UNKNOWN_ACTION", this.frame!);
        return this.result([{ schema: 1, index: 0, beforeFrameId: batch.expectedFrameId, afterFrameId: this.frame!.frameId,
          ok: false, outcome: "UNKNOWN", dispatched: true, silentNoOpDetected: false, settledAfterMs: 0, deltas: emptyDelta() }]);
      }
      if (!this.frame) this.retain(await this.driver.observe(false));
      const source = this.frame!, receipts: StateDeltaReceipt[] = [];
      for (const [index, step] of batch.steps.entries()) {
        const before = this.frame!;
        const receipt: StateDeltaReceipt = { schema: 1, index, beforeFrameId: before.frameId, afterFrameId: before.frameId,
          ok: false, outcome: "STALE_TARGET", dispatched: false, silentNoOpDetected: false, settledAfterMs: 0, deltas: emptyDelta() };
        receipts.push(receipt);
        if (this.journal.interrupt()) { receipt.outcome = "INTERVENTION"; break; }
        if (source.frameId !== batch.expectedFrameId) break;
        const action = step.action, markId = "markId" in action ? action.markId : undefined;
        const ref = source.nodes.find(n => n.markId === markId)?.ref;
        if (markId !== undefined && (!ref || this.frame!.documentId !== source.documentId)) break;
        const predicateMarks = [step.expect.targetFocused, step.expect.targetValue?.markId, step.expect.targetState?.markId].filter(n => n !== undefined);
        if (predicateMarks.some(id => !source.nodes.some(n => n.markId === id))) break;
        try {
          // Reobserve immediately before effects. Changes outside a batch require
          // deliberation; marks alone are never a freshness check.
          let fresh = await this.driver.observe(false);
          if (!contentUnchanged(before, fresh)) { this.retain(fresh); break; }
          let target = fresh.nodes.find(n => n.ref === ref);
          if (ref && (!target || target.states.includes("disabled"))) { this.retain(fresh); break; }
          if (target && !target.hitTestClear && this.driver.reveal) {
            await this.driver.reveal(ref!); fresh = await this.driver.observe(false); target = fresh.nodes.find(n => n.ref === ref);
          }
          this.retain(fresh);
          if (this.journal.interrupt()) { receipt.outcome = "INTERVENTION"; break; }
          if (ref && (!target || !target.hitTestClear)) { receipt.outcome = "OCCLUDED"; break; }
          await this.driver.beginAction(target);
          receipt.dispatched = true; // intent persisted before even an uncertain dispatch
          await this.driver.dispatch(action, ref);
          const started = performance.now(), timeout = step.settleTimeoutMs ?? 2000;
          let settled = { settled: false, elapsedMs: 0 }, after = fresh, passed = false, stableFrame: SceneFrame | undefined;
          do {
            settled = await this.driver.settle(Math.max(1, timeout - (performance.now() - started)));
            after = await this.driver.observe(false);
            if (settled.settled) stableFrame = after;
            else if (stableFrame && contentUnchanged(stableFrame, after)) settled.settled = true;
            passed = guard(step.expect, source, fresh, after);
            if (after.blocker || passed && settled.settled || !settled.settled) break;
            // A quiescent page may still have a delayed menu/timer. Poll the
            // predicate within the SAME deadline, without redispatching input.
            await delay(Math.min(30, Math.max(0, timeout - (performance.now() - started))));
          } while (performance.now() - started < timeout);
          receipt.settledAfterMs = performance.now() - started;
          this.retain(after);
          receipt.afterFrameId = after.frameId;
          receipt.deltas = { ...structural(fresh, after), ...await this.driver.signals() };
          const d = receipt.deltas;
          // Network/storage/animation alone do not establish semantic success.
          const noChange = !d.uriChanged && !d.focusChanged && !d.nodesAdded && !d.nodesRemoved && !d.nodesMutated && !d.layoutChanged &&
            !d.network.length && d.storageChanged !== true && (d.visualDiffRatio === 0 || d.visualDiffRatio === null);
          receipt.silentNoOpDetected = settled.settled && !passed && noChange;
          receipt.outcome = this.journal.interrupt() ? "INTERVENTION" : !settled.settled ? "SETTLE_TIMEOUT" : passed ? "VERIFIED" : receipt.silentNoOpDetected ? "SILENT_NO_OP" : "POSTCONDITION_FAILED";
          receipt.ok = receipt.outcome === "VERIFIED";
          if (receipt.outcome === "SETTLE_TIMEOUT" && !this.journal.interrupt()) this.pause("UNKNOWN_ACTION", after);
          if (receipt.ok && target) this.journal.learn(fresh.locationUri, target.role, target.name, action.kind, receipt.settledAfterMs);
          if (!receipt.ok) break;
        } catch {
          receipt.outcome = receipt.dispatched ? "UNKNOWN" : "STALE_TARGET";
          if (receipt.dispatched && !this.journal.interrupt()) this.pause("UNKNOWN_ACTION", this.frame!);
          break;
        }
      }
      if (receipts.length) receipts.at(-1)!.afterFrameId = this.frame!.frameId;
      const result = this.result(receipts); this.journal.finish(key, result); return result;
    });
  }
  close(): Promise<void> { return this.serial(() => this.driver.close()); }
}
