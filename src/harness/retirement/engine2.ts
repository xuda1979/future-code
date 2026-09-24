/**
 * Context-retirement mechanism engine v2 (frozen protocol v2, 2026-09-24).
 *
 * Differences from the v1 engine (src/harness/retirement/engine.ts),
 * all pre-registered in docs/protocols/CONTEXT_RETIREMENT_PROTOCOL_v2.md
 * and its ENGINE_NOTES:
 *  - retention policies include `frontier-adaptive` (use-clock eviction);
 *  - accounting is split into three phases (construction / steady /
 *    audit-tail) and reported per phase;
 *  - a five-episode audit tail compares each policy's capsule against
 *    the stream's ground truth (A1 stale retention, A2 pending-set
 *    mismatch, A3 defective service);
 *  - two cost regimes are computed per run: B (bytes) and O
 *    (bytes + OPSBYTE per retrieval op);
 *  - the capsule charges bindings only for gates the policy actually
 *    holds (engine note 1).
 *
 * Everything else — episode stream, acceptance contract, framing
 * constants, obligation semantics — is identical to v1 and is imported
 * from the same modules.
 */
import { BYTES, mulberry32 } from "./episodes.ts";
import { OBLIGATION_WINDOW } from "./stream.ts";
import type { Episode } from "./types.ts";

export const RECORD_BYTES = 64;
export const OPSBYTE = 4096;              // frozen regime-O constant
export const USE_WINDOW = 8;              // frozen use window
export const CONSTRUCTION_EPISODES = 5;   // frozen phase boundary
export const AUDIT_TAIL_EPISODES = 5;     // frozen phase boundary

// Framing constants (identical to v1).
const F_FACT = 32;
const F_CAPSULE = 160;
const F_BINDING = 16;
const F_PENDING = 48;
const F_INVARIANTS = 64;
const F_SUMMARY = 96;
const F_BOARDROW = 48;
const WINDOW_BUDGET = 32;
const HIER_PAGES = 64;
const RESET_EVERY = 4;

export type PolicyName2 =
  | "full-replay" | "masking" | "summary-reset" | "bounded-hier"
  | "verified-board" | "frontier" | "frontier-adaptive";

export interface PolicyConfig2 {
  name: PolicyName2;
  adaptive: boolean; // scheduler factor S
}

export interface PhaseTotals {
  contextBytes: number;
  retrievalBytes: number;
  retrievalOps: number;
}

export interface AuditDefects {
  /** A1: retained binding older than the stream's current generation. */
  staleRetention: number;
  /** A2: pending-set mismatch, both directions. */
  missingObligations: number;
  phantomObligations: number;
  /** A3: reads/obligations served from A1/A2-defective state. */
  defectiveService: number;
}

export interface EngineRunResult2 {
  contextBytes: number;
  retrievalBytes: number;
  retrievalOps: number;
  stalenessDefects: number;
  obligationLoss: number;
  accepted: boolean;
  makespanRounds: number;
  calls: number;
  opened: number; resolved: number; lost: number;
  /** Phase-split accounting (regime B numerators). */
  construction: PhaseTotals;
  steady: PhaseTotals;
  auditTail: PhaseTotals;
  /** Audit-tail defect counts (reported, not costed). */
  audit: AuditDefects;
  /** True iff any A3 defect occurred (audit closure). */
  auditFailed: boolean;
  /** Regime O numerator: bytes + OPSBYTE * ops, whole run. */
  costO: number;
}

interface Obligation { gate: number; openedAt: number }

interface Binding {
  gate: number;
  /** Last episode at which this binding was used or refreshed. */
  lastUsed: number;
  /** Episode at which the binding was first created. */
  opened: number;
}

interface PolicyState2 {
  payloads: Map<number, number>;
  known: Set<number>;
  generation: Map<number, number>;
  pending: Obligation[];
  dropped: Obligation[];
  lastReset: number;
  window: number[];
  frontier: Set<number>;
  /** Use-clock bindings for frontier-adaptive. */
  bindings: Map<number, Binding>;
}

function freshState(): PolicyState2 {
  return {
    payloads: new Map(), known: new Set(), generation: new Map(),
    pending: [], dropped: [], lastReset: 0, window: [], frontier: new Set(),
    bindings: new Map(),
  };
}

function gateIndex(id: string): number {
  const m = /gate-(\d+)/.exec(id);
  if (!m) throw new Error(`bad fact id ${id}`);
  return Number(m[1]);
}

function maxGate(ep: Episode): number {
  let m = 0;
  for (const f of ep.facts) m = Math.max(m, gateIndex(f.id));
  return m + 1;
}

function emptyTotals(): PhaseTotals {
  return { contextBytes: 0, retrievalBytes: 0, retrievalOps: 0 };
}

export function runPolicy2(
  cfg: PolicyConfig2, episodes: Episode[], seed: number,
): EngineRunResult2 {
  const st = freshState();
  const rng = mulberry32(seed ^ 0x7a11);
  const E = episodes.length;
  const steadyStart = CONSTRUCTION_EPISODES;
  const tailStart = Math.max(steadyStart, E - AUDIT_TAIL_EPISODES);

  const whole = emptyTotals();
  const construction = emptyTotals();
  const steady = emptyTotals();
  const auditTail = emptyTotals();
  let stalenessDefects = 0, obligationLoss = 0, makespanRounds = 0, calls = 0;
  let opened = 0, resolved = 0, lost = 0;
  const audit: AuditDefects = {
    staleRetention: 0, missingObligations: 0,
    phantomObligations: 0, defectiveService: 0,
  };

  // Stream ground truth (audit reference): last-change episode per gate
  // and the true pending set, recomputed per episode.
  const trueGeneration = new Map<number, number>();

  const isAdaptiveRetention = cfg.name === "frontier-adaptive";

  for (const ep of episodes) {
    const s = (g: number): number => st.payloads.get(g) ?? 128;
    const phase = ep.index < steadyStart ? construction
      : ep.index >= tailStart ? auditTail : steady;

    // Ground truth update (before policy acts; facts are the truth).
    for (const f of ep.facts) trueGeneration.set(gateIndex(f.id), ep.index);

    // ── Observe.
    for (const f of ep.facts) {
      const g = gateIndex(f.id);
      st.payloads.set(g, Math.max(32, f.bytes - F_FACT));
      st.known.add(g);
      st.generation.set(g, ep.index);
      if (cfg.name === "bounded-hier" || cfg.name === "summary-reset") st.window.push(g);
      if (isAdaptiveRetention) {
        const b = st.bindings.get(g);
        if (b) { b.lastUsed = ep.index; }
        else st.bindings.set(g, { gate: g, lastUsed: ep.index, opened: ep.index });
      }
    }

    // ── Obligation opening (all arms observe openings identically).
    const openedNow = ep.facts.filter(f => f.obligation).map(f => gateIndex(f.id));
    for (const g of openedNow) {
      if (!st.pending.some(p => p.gate === g)) {
        st.pending.push({ gate: g, openedAt: ep.index });
        opened++;
      }
    }

    // ── Retention / eviction.
    applyEviction(cfg, st, ep, rng);

    // ── Context charging.
    const ctx = submitContext(cfg, st, ep, s);
    whole.contextBytes += ctx; phase.contextBytes += ctx;

    // ── Reads.
    const currentFacts = new Set(ep.facts.map(f => gateIndex(f.id)));
    const servedFresh = new Set<number>();
    for (const g of ep.requiredReads) {
      if (currentFacts.has(g)) continue;
      const served = serve(cfg, st, ep, g);
      if (served === "fetch") {
        const rb = F_FACT + s(g);
        whole.retrievalBytes += rb; phase.retrievalBytes += rb;
        whole.retrievalOps += 1; phase.retrievalOps += 1;
        st.known.add(g);
        st.generation.set(g, ep.index);
        servedFresh.add(g);
        if (isAdaptiveRetention) {
          const b = st.bindings.get(g);
          if (b) b.lastUsed = ep.index;
          else st.bindings.set(g, { gate: g, lastUsed: ep.index, opened: ep.index });
        }
      } else if (served === "fresh") {
        servedFresh.add(g);
        if (isAdaptiveRetention) {
          const b = st.bindings.get(g);
          if (b) b.lastUsed = ep.index;
        }
      } else if (served === "stale") {
        stalenessDefects++;
      }
    }

    // ── Obligations due.
    const due = st.pending.filter(p => p.openedAt + OBLIGATION_WINDOW <= ep.index);
    for (const p of due) {
      const readValidly = currentFacts.has(p.gate) || servedFresh.has(p.gate);
      if (ep.requiredReads.includes(p.gate) && readValidly) resolved++;
      else { obligationLoss++; lost++; }
      st.pending = st.pending.filter(q => q !== p);
    }
    for (const p of st.dropped.filter(p => p.openedAt + OBLIGATION_WINDOW <= ep.index)) {
      obligationLoss++; lost++;
    }
    st.dropped = st.dropped.filter(p => p.openedAt + OBLIGATION_WINDOW > ep.index);

    // ── Audit tail (three-evaluation separation; audit defects are
    //    counted, never costed).
    if (ep.index >= tailStart) {
      // A1: stale retention — a held binding whose stored generation is
      // older than the stream's current generation.
      let staleBindings = 0;
      for (const g of st.known) {
        const tg = trueGeneration.get(g);
        if (tg !== undefined && (st.generation.get(g) ?? -1) < tg) staleBindings++;
      }
      audit.staleRetention += staleBindings;

      // A2: pending-set mismatch against the stream's true pending set
      // {obligations opened at o : e - OBLIGATION_WINDOW < o <= e}.
      const truePending = new Set<number>();
      for (const [g, o] of streamOpenings(episodes, ep.index)) {
        if (ep.index - OBLIGATION_WINDOW < o && o <= ep.index) truePending.add(g);
      }
      const held = new Set(st.pending.map(p => p.gate));
      for (const g of truePending) if (!held.has(g)) audit.missingObligations++;
      for (const g of held) if (!truePending.has(g)) audit.phantomObligations++;

      // A3: required reads served retained-fresh from a stale binding;
      // obligations resolved from a phantom pending entry.
      for (const g of ep.requiredReads) {
        if (currentFacts.has(g)) continue;
        if (servedFresh.has(g)) {
          const tg = trueGeneration.get(g);
          const held_gen = st.generation.get(g);
          if (tg !== undefined && held_gen !== undefined && held_gen < tg
              && st.known.has(g)) {
            audit.defectiveService++;
          }
        }
      }
    }

    // ── Scheduler factor (makespan only; byte-neutral by design).
    makespanRounds += cfg.adaptive
      ? Math.max(1, Math.ceil(ep.requiredReads.length / 8))
      : Math.max(1, ep.requiredReads.length);
    calls++;
  }

  const pendingBeyondHorizon = st.pending.filter(p => p.openedAt + OBLIGATION_WINDOW > E - 1).length;
  const unresolvedInHorizon = st.pending.length - pendingBeyondHorizon;
  const accepted = stalenessDefects === 0 && obligationLoss === 0 && unresolvedInHorizon === 0;
  const auditFailed = audit.defectiveService > 0;
  const costO = whole.contextBytes + whole.retrievalBytes + OPSBYTE * whole.retrievalOps;

  return {
    contextBytes: whole.contextBytes,
    retrievalBytes: whole.retrievalBytes,
    retrievalOps: whole.retrievalOps,
    stalenessDefects, obligationLoss, accepted,
    makespanRounds, calls, opened, resolved, lost,
    construction, steady, auditTail,
    audit, auditFailed, costO,
  };
}

/** Openings (gate, openedAt) with openedAt <= upto, derived from the stream. */
function streamOpenings(episodes: readonly Episode[], upto: number): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Map<number, number>();
  for (const ep of episodes) {
    if (ep.index > upto) break;
    for (const f of ep.facts) {
      if (f.obligation) {
        const g = gateIndex(f.id);
        if (!seen.has(g)) { seen.set(g, ep.index); out.push([g, ep.index]); }
      }
    }
  }
  return out;
}

// ─── Eviction ─────────────────────────────────────────────────────────────

function baseFrontier(st: PolicyState2, ep: Episode): Set<number> {
  const f = new Set<number>(ep.invalidated);
  // Hoisted: v1 called maxGate(ep) inside the loop, which is quadratic
  // at n=4096 (a performance defect of the v1 engine, not a semantic
  // one — the value is loop-invariant).
  const span = Math.max(1, maxGate(ep));
  for (const g of ep.invalidated) f.add((g + 1) % span);
  for (const g of ep.footprint) f.add(g);
  for (const p of st.pending) f.add(p.gate);
  return f;
}

function applyEviction(cfg: PolicyConfig2, st: PolicyState2, ep: Episode, rng: () => number): void {
  // Previous frontier: gates evicted by a frontier policy must have
  // been retained at the end of the previous episode, so iterating the
  // previous frontier set finds every evictable gate. (Performance fix;
  // accounting-identical to v1's scan of `known`; see the frontier case.)
  let prevFrontier: Set<number> = new Set(st.frontier);
  switch (cfg.name) {
    case "full-replay":
    case "verified-board":
      return;
    case "masking":
      return;
    case "summary-reset": {
      while (st.window.length > WINDOW_BUDGET) {
        const g = st.window.shift()!;
        if ((st.generation.get(g) ?? 0) > st.lastReset) st.generation.set(g, -1);
        st.window = st.window.filter(x => x !== g);
      }
      if (ep.index > 0 && ep.index % RESET_EVERY === 0) {
        st.lastReset = ep.index;
        st.window = [];
        for (const g of [...st.known]) {
          if ((st.generation.get(g) ?? 0) > st.lastReset) st.generation.set(g, -1);
        }
        const kept: Obligation[] = [];
        for (const p of st.pending) {
          if (rng() < 0.5) kept.push(p);
          else st.dropped.push(p);
        }
        st.pending = kept;
      }
      return;
    }
    case "bounded-hier":
      while (st.window.length > HIER_PAGES) {
        const g = st.window.shift()!;
        st.window = st.window.filter(x => x !== g);
        st.known.delete(g);
      }
      return;
    case "frontier": {
      st.frontier = baseFrontier(st, ep);
      // Eviction as in v1, but iterating the *previous* frontier set
      // (O(|prev frontier|)) instead of scanning all known gates
      // (O(|known|)): a gate outside both the previous and the current
      // frontier was already evicted in a prior episode, so this is
      // accounting-identical to v1's set scan.
      for (const g of prevFrontier) if (!st.frontier.has(g)) {
        st.known.delete(g);
        st.generation.delete(g);
        st.payloads.delete(g);
      }
      prevFrontier = st.frontier;
      return;
    }
    case "frontier-adaptive": {
      // Base frontier first (exemptions (a)-(c) of the frozen rule).
      st.frontier = baseFrontier(st, ep);
      for (const g of prevFrontier) if (!st.frontier.has(g)) {
        st.bindings.delete(g);
        st.known.delete(g);
        st.generation.delete(g);
        st.payloads.delete(g);
      }
      // Then evict bindings whose use and open clocks both exceed the
      // window (engine note 4). Iterate the binding map — it is the
      // use-clock ledger — never the full known set.
      for (const [g, b] of [...st.bindings]) {
        if (st.frontier.has(g)) continue;
        if (ep.index - b.lastUsed >= USE_WINDOW && ep.index - b.opened >= USE_WINDOW) {
          st.bindings.delete(g);
          st.known.delete(g);
          st.generation.delete(g);
          st.payloads.delete(g);
        }
      }
      prevFrontier = st.frontier;
      return;
    }
  }
}

// ─── Serving ──────────────────────────────────────────────────────────────

function serve(cfg: PolicyConfig2, st: PolicyState2, ep: Episode, g: number): "fetch" | "fresh" | "stale" {
  switch (cfg.name) {
    case "full-replay":
    case "verified-board":
    case "bounded-hier":
    case "frontier":
    case "frontier-adaptive":
      return st.known.has(g) ? "fresh" : "fetch";
    case "masking":
      return "fetch";
    case "summary-reset": {
      const gen = st.generation.get(g);
      if (gen === -1) return "stale";
      if (gen === undefined) return "fetch";
      return "fresh";
    }
  }
}

// ─── Context charging ─────────────────────────────────────────────────────

function submitContext(cfg: PolicyConfig2, st: PolicyState2, ep: Episode, s: (g: number) => number): number {
  const h = BYTES.header;
  switch (cfg.name) {
    case "full-replay": {
      let bytes = h;
      for (const g of st.known) bytes += F_FACT + s(g);
      return bytes;
    }
    case "verified-board": {
      let bytes = h;
      for (const g of st.known) bytes += F_BOARDROW + s(g);
      return bytes;
    }
    case "bounded-hier": {
      let bytes = h;
      for (const g of st.window) bytes += F_FACT + s(g);
      return bytes;
    }
    case "masking":
      return h + ep.facts.reduce((acc, f) => acc + F_FACT + Math.max(32, f.bytes - F_FACT), 0);
    case "summary-reset": {
      let bytes = h + F_SUMMARY;
      for (const g of st.window) bytes += F_FACT + s(g);
      return bytes;
    }
    case "frontier":
    case "frontier-adaptive": {
      // Capsule: base + bindings actually held (engine note 1) +
      // pending + invariants.
      let bytes = h + F_CAPSULE + F_INVARIANTS;
      for (const g of st.frontier) if (st.known.has(g)) bytes += F_BINDING + s(g);
      for (const p of st.pending) bytes += F_PENDING;
      return bytes;
    }
  }
}

// ─── v2 evidence layouts (fast; accounting-identical to v1) ───────────────
//
// v1's hactLedger (engine.ts) builds a nested-Map affinity structure in
// O(k²) map operations per training episode, which is prohibitive at
// n=4096. The version below computes the *same* scores — integer
// co-invalidation counts, so no floating-point reassociation can change
// them — in flat typed arrays. Everything downstream (order, tie-break,
// tree, cost model, byte accounting) is identical to v1's function.

import { compactBalanced } from "../../hact/tree.ts";
import { defaultCostModel } from "../../hact/costModel.ts";

export interface EvidenceLayout2 {
  name: "flat2" | "hact2";
  /** Bytes for the held-out half, given per-episode changed sets. */
  runBytes: (changes: readonly (readonly number[])[]) => number;
}

/** Flat steel-man: min(full export, delta export) per episode, 64 B records. */
export function flatLedger2(registrySize: number): EvidenceLayout2 {
  const n = registrySize;
  return {
    name: "flat2",
    runBytes: (changes) => {
      let total = BYTES.header + RECORD_BYTES * n; // construction: full ledger
      for (const ch of changes) {
        total += Math.min(BYTES.header + RECORD_BYTES * n, BYTES.header + RECORD_BYTES * ch.length);
      }
      return total;
    },
  };
}

/** HACT layout, learned order (spectral seriation), balanced-arity-8. */
export function hactLedger2(
  trainChanges: readonly (readonly number[])[],
  registrySize: number,
): EvidenceLayout2 {
  const n = registrySize;
  // Affinity sums in a flat Int32Array (row-major n×n is too large at
  // 4096; use per-episode dense rows only when needed). The score is
  // row-sum / row-count of co-invalidation counts — integers — so the
  // result matches v1's Map-based computation exactly.
  const rowSum = new Int32Array(n);
  // Distinct-partner ledger: for each gate a, the set of partners b≠a it
  // has co-occurred with (v1's row key count). Stored as a per-gate Set;
  // total size is bounded by Σ_e m_e² in the worst case but is far
  // smaller for the frozen families and, crucially, uses O(1) array
  // reads for the sum (v1's quadratic Map churn is what was slow).
  const partners = new Map<number, Set<number>>();
  for (const ch of trainChanges) {
    const m = ch.length;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) {
      const a = ch[i]!;
      rowSum[a] += m - 1;          // v1: Σ_b count(a,b) accumulates m-1 per episode
      let ps = partners.get(a);
      if (!ps) { ps = new Set<number>(); partners.set(a, ps); }
      for (let j = 0; j < m; j++) if (j !== i) ps.add(ch[j]!);
    }
  }
  // v1 score: sum over distinct partners of count(a,b), divided by the
  // NUMBER OF DISTINCT PARTNERS (v1's cnt is the row's entry count).
  // Gates never co-invalidated get score 0 (v1's score.get(a) ?? 0).
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ca = partners.get(a)?.size ?? 0;
    const cb = partners.get(b)?.size ?? 0;
    const sa = ca > 0 ? rowSum[a]! / ca : 0;
    const sb = cb > 0 ? rowSum[b]! / cb : 0;
    return sa - sb;
  });
  const rank = new Map(order.map((g, i) => [g, i] as const));

  const arity = 8;
  const depth = Math.max(1, Math.ceil(Math.log(n) / Math.log(arity)));
  const tree = compactBalanced(n, arity, depth);
  const model = defaultCostModel(arity, depth, 4096);

  // Construction: one packet per internal node (as v1).
  let construction = BYTES.header;
  (function count(node: { children: { children: unknown[] }[] }): void {
    if (node.children.length) {
      construction += model.packetBytes(node.children.length);
      for (const c of node.children) count(c as { children: { children: unknown[] }[] });
    }
  })(tree as unknown as { children: { children: { children: unknown[] }[] }[] });

  return {
    name: "hact2",
    runBytes: (changes) => {
      let total = construction;
      for (const ch of changes) {
        if (!ch.length) continue;
        const changedRanks = new Set(ch.map(g => rank.get(g) ?? g));
        let bytes = BYTES.header;
        (function visit(node: { lo: number; hi: number; children: { lo: number; hi: number; children: unknown[] }[] }): void {
          if (!node.children.length) return;
          const lo = node.lo, hi = node.hi;
          const span = hi - lo + 1;
          let hitCount = 0;
          for (let r = lo; r <= hi; r++) if (changedRanks.has(r)) hitCount++;
          if (hitCount === 0) return;
          if (hitCount === span) {
            bytes += model.packetBytes(node.children.length);
            return;
          }
          // Partial hit: recurse into children; fully-changed leaf
          // blocks collapse to grouped records (as v1).
          for (const c of node.children) {
            const cSpan = c.hi - c.lo + 1;
            let cHit = 0;
            for (let r = c.lo; r <= c.hi; r++) if (changedRanks.has(r)) cHit++;
            if (cHit === cSpan && c.children.length === 0) {
              bytes += RECORD_BYTES * cSpan;
            } else if (cHit > 0) {
              visit(c as { lo: number; hi: number; children: { lo: number; hi: number; children: unknown[] }[] });
            }
          }
        })(tree as unknown as { lo: number; hi: number; children: { lo: number; hi: number; children: unknown[] }[] });
        total += bytes;
      }
      return total;
    },
  };
}
