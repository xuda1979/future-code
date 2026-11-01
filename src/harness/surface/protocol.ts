/** Interactive surfaces are optional capabilities. No DOM, selector, engine or
 * project policy belongs in this contract. Marks are scoped to one observation. */
export interface BoundingBox { x: number; y: number; width: number; height: number }
export interface InteractiveNode {
  markId: number;
  /** Driver-owned identity, stable only while the same object/document exists. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  bbox: BoundingBox;
  hitTestClear: boolean;
}
export type SurfaceBlocker = "CAPTCHA" | "AUTH_WALL" | "HUMAN_CONFIRMATION" | "OUT_OF_SCOPE";
export interface SceneFrame {
  schema: 1;
  frameId: string;
  documentId: string;
  timestamp: number;
  locationUri: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  nodes: InteractiveNode[];
  truncated: boolean;
  blocker?: SurfaceBlocker;
  /** Private artifact reference, never an inline base64 image/DOM dump. */
  visualRef?: string;
}
export type HIDAction =
  | { kind: "activate"; markId?: number; coords?: { x: number; y: number }; button?: "left" | "right" }
  | { kind: "input"; markId: number; text: string; clearFirst?: boolean; cadenceMs?: number; submitKey?: "Enter" | "Tab" }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amountPx: number; markId?: number }
  | { kind: "key_chord"; keys: string[] }
  | { kind: "hover"; markId: number };
/** All marks refer to expectedFrameId, including in later steps of a batch.
 * The host rebinds through ref, never through a coincidentally reused mark. */
export interface PostCondition {
  targetFocused?: number;
  targetValue?: { markId: number; equals: string };
  targetState?: { markId: number; state: string; present: boolean };
  nodeAppearedWithText?: string;
  uriEquals?: string;
  uriChanged?: boolean;
}
export interface GuardedMicroStep { action: HIDAction; expect: PostCondition; settleTimeoutMs?: number }
export interface SurfaceBatch { expectedFrameId: string; steps: GuardedMicroStep[] }
export interface SurfaceDelta {
  uriChanged: boolean;
  focusChanged: boolean;
  nodesAdded: number;
  nodesRemoved: number;
  nodesMutated: number;
  layoutChanged: boolean;
  network: { method: string; status: number; resourceType: string }[];
  storageChanged: boolean | null;
  /** null means unmeasured, never zero. Animation/analytics are not success. */
  visualDiffRatio: number | null;
  targetVisualDiffRatio: number | null;
}
export interface SettleResult { settled: boolean; elapsedMs: number }
export interface StateDeltaReceipt {
  schema: 1;
  index: number;
  beforeFrameId: string;
  afterFrameId: string;
  ok: boolean;
  outcome: "VERIFIED" | "SILENT_NO_OP" | "POSTCONDITION_FAILED" | "SETTLE_TIMEOUT" | "STALE_TARGET" | "OCCLUDED" | "INTERVENTION" | "UNKNOWN" | "OPERATOR_RECONCILED";
  dispatched: boolean;
  silentNoOpDetected: boolean;
  settledAfterMs: number;
  deltas: SurfaceDelta;
}
export interface FrameDelta { from: string; to: string; added: number; removed: number; changed: number; locationChanged: boolean }
export interface SurfaceInterrupt {
  signal: "SIG_SURFACE_INTERVENTION";
  id: string;
  reason: SurfaceBlocker | "UNKNOWN_ACTION";
  since: number;
  frameId: string;
}
export interface SurfaceResult {
  schema: 1;
  kind: "interactive-surface";
  sessionId: string;
  ok: boolean;
  receipts: StateDeltaReceipt[];
  frame: SceneFrame;
  delta?: FrameDelta;
  interrupt?: SurfaceInterrupt;
  liveness: { paused: boolean; pausedMs: number };
  affordanceNotes?: { role: string; name: string; verb: string; settleMs: number; samples: number }[];
  trust: "OBSERVATION_NOT_ACCEPTANCE";
}
export interface DriverSignals {
  network: SurfaceDelta["network"];
  storageChanged: boolean | null;
  visualDiffRatio: number | null;
  targetVisualDiffRatio: number | null;
}
/** A driver reports observations and inputs; the kernel owns guards, receipts,
 * lease serialization, interruption and replay decisions. */
export interface InteractiveSurfaceDriver {
  observe(includeVisual: boolean): Promise<SceneFrame>;
  settle(timeoutMs: number): Promise<SettleResult>;
  beginAction(target?: InteractiveNode): Promise<void>;
  dispatch(action: HIDAction, targetRef?: string): Promise<void>;
  /** Optional pre-dispatch reflex: scroll/reobserve only, never replay a click. */
  reveal?(targetRef: string): Promise<void>;
  signals(): Promise<DriverSignals>;
  close(): Promise<void>;
}

function require(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const finite = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
const mark = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 10000;
function keys(x: object, allowed: string[]) {
  require(x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).every(k => allowed.includes(k)), "invalid surface fields");
}
export function validateBatch(batch: SurfaceBatch): void {
  keys(batch, ["expectedFrameId", "steps"]);
  require(typeof batch.expectedFrameId === "string" && batch.expectedFrameId.length > 0 && batch.expectedFrameId.length <= 128, "expected frame required");
  require(Array.isArray(batch.steps) && batch.steps.length > 0 && batch.steps.length <= 16, "surface batch must have 1..16 steps");
  let deadlineBudget = 0;
  for (const step of batch.steps) {
    keys(step, ["action", "expect", "settleTimeoutMs"]);
    require(step.settleTimeoutMs === undefined || finite(step.settleTimeoutMs, 10000) && step.settleTimeoutMs >= 100, "invalid settle deadline");
    const a = step.action;
    require(a && typeof a === "object", "HID action required");
    if (a.kind === "activate") {
      keys(a, ["kind", "markId", "coords", "button"]);
      require((a.markId === undefined) !== (a.coords === undefined), "exactly one target or coordinate required");
      if (a.coords) { keys(a.coords, ["x", "y"]); require(finite(a.coords.x, 1) && finite(a.coords.y, 1), "coordinates must be normalized"); }
      require(a.button === undefined || ["left", "right"].includes(a.button), "invalid pointer button");
    } else if (a.kind === "input") {
      keys(a, ["kind", "markId", "text", "clearFirst", "cadenceMs", "submitKey"]);
      require(mark(a.markId) && typeof a.text === "string" && a.text.length <= 4096, "invalid input action");
      require(a.clearFirst === undefined || typeof a.clearFirst === "boolean", "invalid clearFirst");
      require(a.cadenceMs === undefined || finite(a.cadenceMs, 50), "invalid typing cadence");
      require(a.submitKey === undefined || ["Enter", "Tab"].includes(a.submitKey), "invalid submit key");
    } else if (a.kind === "scroll") {
      keys(a, ["kind", "direction", "amountPx", "markId"]);
      require(["up", "down", "left", "right"].includes(a.direction) && finite(a.amountPx, 10000) && a.amountPx > 0, "invalid scroll action");
    } else if (a.kind === "key_chord") {
      keys(a, ["kind", "keys"]);
      require(Array.isArray(a.keys) && a.keys.length > 0 && a.keys.length <= 4 && a.keys.every(k => typeof k === "string" && /^[A-Za-z0-9]+$/.test(k) && k.length <= 16), "invalid key chord");
    } else { require(a.kind === "hover", "unknown HID verb"); keys(a, ["kind", "markId"]); require(mark(a.markId), "hover target required"); }
    if ("markId" in a && a.markId !== undefined) require(mark(a.markId), "invalid mark ID");
    const e = step.expect;
    keys(e, ["targetFocused", "targetValue", "targetState", "nodeAppearedWithText", "uriEquals", "uriChanged"]);
    require(Object.keys(e).length > 0, "every surface step needs a postcondition");
    if (e.targetFocused !== undefined) require(mark(e.targetFocused), "invalid focus predicate");
    if (e.targetValue !== undefined) { keys(e.targetValue, ["markId", "equals"]); require(mark(e.targetValue.markId) && typeof e.targetValue.equals === "string" && e.targetValue.equals.length <= 4096, "invalid value predicate"); }
    if (e.targetState !== undefined) { keys(e.targetState, ["markId", "state", "present"]); require(mark(e.targetState.markId) && typeof e.targetState.state === "string" && e.targetState.state.length <= 64 && typeof e.targetState.present === "boolean", "invalid state predicate"); }
    for (const k of ["nodeAppearedWithText", "uriEquals"] as const) if (e[k] !== undefined) require(typeof e[k] === "string" && e[k].length > 0 && e[k].length <= 2048, "invalid text predicate");
    if (e.uriChanged !== undefined) require(typeof e.uriChanged === "boolean", "invalid URI predicate");
    deadlineBudget += (step.settleTimeoutMs ?? 2000) + (a.kind === "input" ? a.text.length * (a.cadenceMs ?? 0) : 0);
  }
  require(deadlineBudget <= 9000, "surface microbatch exceeds 9 second deadline budget; split the batch");
}
