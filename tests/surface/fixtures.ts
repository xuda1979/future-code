import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceController } from "../../src/harness/surface/controller.ts";
import { SurfaceJournal } from "../../src/harness/surface/journal.ts";
import type { DriverSignals, HIDAction, InteractiveSurfaceDriver, SceneFrame } from "../../src/harness/surface/protocol.ts";

export class FixtureDriver implements InteractiveSurfaceDriver {
  tick = 0; dispatches = 0; reveals = 0; signalsValue: DriverSignals = { network: [], storageChanged: false, visualDiffRatio: null, targetVisualDiffRatio: null };
  state: SceneFrame = { schema: 1, frameId: "initial", documentId: "doc", timestamp: 0, locationUri: "https://fixture.test/",
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, truncated: false,
    nodes: [{ markId: 1, ref: "input", role: "textbox", name: "Query", value: "", states: [], bbox: { x: 20, y: 20, width: 100, height: 30 }, hitTestClear: true },
      { markId: 2, ref: "button", role: "button", name: "Search", states: [], bbox: { x: 20, y: 70, width: 100, height: 30 }, hitTestClear: true }] };
  effect: (action: HIDAction, ref?: string) => void | Promise<void> = (action, ref) => {
    const node = this.state.nodes.find(n => n.ref === ref)!;
    if (action.kind === "input") node.value = action.text;
    if (action.kind === "activate") { this.state.nodes.forEach(n => { n.states = n.states.filter(s => s !== "focused"); }); node.states.push("focused"); }
  };
  async observe() { return structuredClone({ ...this.state, frameId: `frame-${++this.tick}` }); }
  async settle() { return { settled: true, elapsedMs: 0 }; }
  async beginAction() {}
  async dispatch(action: HIDAction, ref?: string) { this.dispatches++; await this.effect(action, ref); }
  async reveal() { this.reveals++; }
  async signals() { return this.signalsValue; }
  async close() {}
}
export async function fixture(work: (controller: SurfaceController, driver: FixtureDriver, journal: SurfaceJournal, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "future-surface-")), driver = new FixtureDriver(), journal = new SurfaceJournal(root, "test");
  try { await work(new SurfaceController(driver, journal), driver, journal, root); }
  finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
}
