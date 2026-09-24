/**
 * Context-retirement mechanism engine (protocol amendments v1.2–v1.4).
 *
 * Every arm consumes the same temporal-persistence episode stream and
 * answers: what does the next call receive, what is fetched on demand,
 * and what does the policy lose? Correctness on an episode means every
 * required read is answered from a currently valid binding and every
 * due obligation is resolved. Bytes are measured, not estimated.
 *
 * Accounting (amendment v1.4 item 14): every needed interface costs its
 * payload s_g exactly once per call, in whatever channel delivers it.
 * Channels differ only in framing. This makes the arms comparable: no
 * arm gets free information.
 *
 * Baselines are steel-manned:
 *  - masking: identity model, focused retrieval, plain todo, no
 *    cross-call payload cache (the observation-masking design).
 *  - summary/reset: observes everything within a period; failures are
 *    (a) obligations crossing a boundary survive only via a lossy
 *    summary (seeded 50%) and (b) window overflow within a period
 *    reverts values to the summary belief, which can silently be stale
 *    for gates changed after the last reset.
 *  - flat evidence: min(full export, delta export) at the same 64 B
 *    record cost as the HACT tree, evaluated on a held-out half.
 */

import { compactBalanced } from "../../hact/tree.ts";
import { defaultCostModel } from "../../hact/costModel.ts";
import { BYTES, mulberry32 } from "./episodes.ts";
import { OBLIGATION_WINDOW } from "./stream.ts";
import type { Episode } from "./types.ts";

export const RECORD_BYTES = 64;

// ─── Shared per-run state ─────────────────────────────────────────────────

interface Obligation { gate: number; openedAt: number; dueAt: number }

interface PolicyState {
  /** gate -> payload bytes s_g of the last observed value. */
  payloads: Map<number, number>;
  /** Gates whose value is known as of `generation.get(g)`. */
  known: Set<number>;
  /** Last-observed episode per gate (for summary-belief staleness). */
  generation: Map<number, number>;
  /** Typed pending obligations (all arms track until their rule drops them). */
  pending: Obligation[];
  /** Obligations dropped before due; scored at due episode. */
  dropped: Obligation[];
  /** Last reset episode (summary-reset). */
  lastReset: number;
  /** Retained observations within the current window (summary-reset). */
  window: number[];
  /** Working set retained by the frontier. */
  frontier: Set<number>;
}

function freshState(): PolicyState {
  return {
    payloads: new Map(), known: new Set(), generation: new Map(),
    pending: [], dropped: [], lastReset: 0, window: [], frontier: new Set(),
  };
}

// ─── Arms ─────────────────────────────────────────────────────────────────

export type PolicyName =
  | "full-replay" | "masking" | "summary-reset" | "bounded-hier"
  | "verified-board" | "frontier" | "adapt-only";

export interface PolicyConfig {
  name: PolicyName;
  adaptive: boolean;
}

export interface EngineRunResult {
  contextBytes: number;
  retrievalBytes: number;
  retrievalOps: number;
  stalenessDefects: number;
  obligationLoss: number;
  accepted: boolean;
  makespanRounds: number;
  calls: number;
  opened: number; resolved: number; lost: number;
}

/** Framing constants (amendment v1.4 item 14). */
const F_FACT = 32;
const F_CAPSULE = 160;
const F_BINDING = 16;
const F_PENDING = 48;
const F_INVARIANTS = 64;
const F_SUMMARY = 96;
const F_BOARDROW = 48;
const WINDOW_BUDGET = 32;
const HIER_BUDGET = 64;
const RESET_EVERY = 4;
const HIER_PAGES = 64;

export function runPolicy(cfg: PolicyConfig, episodes: Episode[], seed: number): EngineRunResult {
  const st = freshState();
  const rng = mulberry32(seed ^ 0x7a11);
  let contextBytes = 0, retrievalBytes = 0, retrievalOps = 0;
  let stalenessDefects = 0, obligationLoss = 0, makespanRounds = 0, calls = 0;
  let opened = 0, resolved = 0, lost = 0;

  for (const ep of episodes) {
    const s = (g: number): number => st.payloads.get(g) ?? 128;

    // ── Observe: every policy sees the episode's facts (values arrive
    // through the environment; the policy's *context* is what differs).
    for (const f of ep.facts) {
      const g = gateIndex(f.id);
      st.payloads.set(g, Math.max(32, f.bytes - F_FACT));
      st.known.add(g);
      st.generation.set(g, ep.index);
      if (cfg.name === "bounded-hier") st.window.push(g);
      if (cfg.name === "summary-reset") st.window.push(g);
    }

    // ── Obligations open per the stream contract.
    for (const f of ep.facts) if (f.obligation) {
      st.pending.push({ gate: gateIndex(f.id), openedAt: ep.index, dueAt: ep.index + OBLIGATION_WINDOW });
      opened++;
    }

    // ── Retention/eviction (where policies genuinely differ).
    applyEviction(cfg, st, ep, rng);

    // ── Charge the submitted context (item 14: each needed interface
    // costs its payload once per call, in the delivering channel).
    contextBytes += submitContext(cfg, st, ep, s);

    // ── Reads: each required read must be answered from a valid value.
    const currentFacts = new Set(ep.facts.map(f => gateIndex(f.id)));
    const servedFresh = new Set<number>();
    for (const g of ep.requiredReads) {
      if (currentFacts.has(g)) continue; // delivered fresh this call.
      const served = serve(cfg, st, ep, g, s);
      if (served.kind === "fetch") {
        retrievalBytes += F_FACT + s(g);
        retrievalOps += 1;
        st.known.add(g);
        st.generation.set(g, ep.index);
        servedFresh.add(g);
      } else if (served.kind === "fresh") {
        servedFresh.add(g);
      } else if (served.kind === "stale") {
        stalenessDefects++;
      }
    }

    // ── Obligations due. Resolution requires the gate to have been
    // read this episode from a valid source: a current fact, a fetch,
    // or a retained current value (served fresh).
    const due = st.pending.filter(p => p.dueAt <= ep.index);
    for (const p of due) {
      const readValidly = currentFacts.has(p.gate) || servedFresh.has(p.gate);
      if (ep.requiredReads.includes(p.gate) && readValidly) resolved++;
      else { obligationLoss++; lost++; }
      st.pending = st.pending.filter(q => q !== p);
    }
    const droppedDue = st.dropped.filter(p => p.dueAt <= ep.index);
    for (const p of droppedDue) {
      obligationLoss++; lost++;
      st.dropped = st.dropped.filter(q => q !== p);
    }

    // ── Scheduler dimension (makespan only; byte-neutral by design).
    makespanRounds += cfg.adaptive
      ? Math.max(1, Math.ceil(ep.requiredReads.length / 8))
      : Math.max(1, ep.requiredReads.length);
    calls++;
  }

  // Obligations whose due episode lies beyond the horizon stay open.
  const pendingBeyondHorizon = st.pending.filter(p => p.dueAt > episodes.length - 1).length;
  const unresolvedInHorizon = st.pending.length - pendingBeyondHorizon;
  const accepted = stalenessDefects === 0 && obligationLoss === 0 && unresolvedInHorizon === 0;

  return { contextBytes, retrievalBytes, retrievalOps, stalenessDefects, obligationLoss, accepted, makespanRounds, calls, opened, resolved, lost };
}

// ─── Eviction ─────────────────────────────────────────────────────────────

function applyEviction(cfg: PolicyConfig, st: PolicyState, ep: Episode, rng: () => number): void {
  switch (cfg.name) {
    case "full-replay":
    case "verified-board":
      return; // never evicts (growth is the cost).
    case "masking":
    case "adapt-only":
      // Identity-only memory: values are not cached across calls.
      // The environment holds them; each call re-derives from facts.
      return;
    case "summary-reset": {
      // Window budget within the period (item 15b): overflow evicts
      // observations; the value reverts to the summary belief (state
      // as of the last reset).
      while (st.window.length > WINDOW_BUDGET) {
        const g = st.window.shift()!;
        // Reverting to summary belief: if the gate changed after the
        // last reset, the believed value is stale. Mark as "believed"
        // — staleness is detected at read time.
        if ((st.generation.get(g) ?? 0) > st.lastReset) st.generation.set(g, -1);
        st.window = st.window.filter(x => x !== g);
      }
      if (ep.index > 0 && ep.index % RESET_EVERY === 0) {
        // Reset: everything reverts to the summary belief.
        st.lastReset = ep.index;
        st.window = [];
        for (const g of [...st.known]) {
          if ((st.generation.get(g) ?? 0) > st.lastReset) st.generation.set(g, -1);
        }
        // Obligations survive only via the lossy summary (item 15a).
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
      // Keep the most recent HIER_PAGES observations (pages).
      while (st.window.length > HIER_PAGES) {
        const g = st.window.shift()!;
        st.window = st.window.filter(x => x !== g);
        st.known.delete(g);
      }
      return;
    case "frontier": {
      // Frontier retirement: keep the working set (with payloads,
      // they are the retained interfaces), retire the rest.
      st.frontier = new Set(ep.invalidated);
      for (const g of ep.invalidated) st.frontier.add((g + 1) % maxGate(ep));
      for (const g of ep.footprint) st.frontier.add(g);
      for (const p of st.pending) st.frontier.add(p.gate);
      for (const g of [...st.known]) if (!st.frontier.has(g)) {
        st.known.delete(g);
        st.generation.delete(g);
        st.payloads.delete(g);
      }
      return;
    }
  }
}

/** How a required read of gate g is served, given the policy. */
function serve(cfg: PolicyConfig, st: PolicyState, ep: Episode, g: number, s: (g: number) => number): { kind: "fetch" | "fresh" | "stale" } {
  switch (cfg.name) {
    case "full-replay":
    case "verified-board":
    case "frontier":
      // Retained: fetch if the value was evicted; stale never (values
      // kept current by observation).
      return st.known.has(g) ? { kind: "fresh" } : { kind: "fetch" };
    case "bounded-hier":
      return st.known.has(g) ? { kind: "fresh" } : { kind: "fetch" };
    case "masking":
    case "adapt-only":
      // No cross-call payload cache: every non-current read is fetched.
      return { kind: "fetch" };
    case "summary-reset":
      // Known at a generation ≥ lastReset and actually observed → fresh.
      // Believed-only (generation -1) → the value may have silently
      // changed after the last reset: acting on it is staleness.
      const gen = st.generation.get(g);
      if (gen === -1) return { kind: "stale" };
      if (gen === undefined) return { kind: "fetch" };
      return { kind: "fresh" };
  }
}

// ─── Context charging ─────────────────────────────────────────────────────

function submitContext(cfg: PolicyConfig, st: PolicyState, ep: Episode, s: (g: number) => number): number {
  const h = BYTES.header;
  const current = new Set(ep.facts.map(f => gateIndex(f.id)));
  switch (cfg.name) {
    case "full-replay": {
      // Whole history with payloads (the quadratic term).
      let bytes = h;
      for (const g of st.known) bytes += F_FACT + s(g);
      return bytes;
    }
    case "verified-board": {
      // One present-state row per known gate, payload included (a
      // board row is a value row).
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
    case "adapt-only":
      // Identity-only context: current facts carry their payloads
      // (they are the call's inputs); everything else is fetched.
      let bytes = h;
      for (const f of ep.facts) bytes += F_FACT + Math.max(32, f.bytes - F_FACT);
      return bytes;
    case "summary-reset": {
      // Header + summary anchor + window observations.
      let bytes = h + F_SUMMARY;
      for (const g of st.window) bytes += F_FACT + s(g);
      return bytes;
    }
    case "frontier": {
      // Capsule: base + interface bindings (framing + payload; the
      // frontier retains interface contents) + pending + invariants.
      let bytes = h + F_CAPSULE + F_INVARIANTS;
      for (const g of st.frontier) bytes += F_BINDING + s(g);
      for (const p of st.pending) bytes += F_PENDING;
      return bytes;
    }
  }
}

function maxGate(ep: Episode): number {
  let m = 0;
  for (const f of ep.facts) m = Math.max(m, gateIndex(f.id));
  return m + 1;
}

function gateIndex(id: string): number {
  const m = /gate-(\d+)/.exec(id);
  if (!m) throw new Error(`bad fact id ${id}`);
  return Number(m[1]);
}

// ─── Evidence layouts (HACT ablation, amendment item 17) ──────────────────

export interface EvidenceLayout {
  name: "flat" | "hact";
  /** Bytes for the held-out half, given per-episode changed sets. */
  runBytes: (changes: readonly (readonly number[])[]) => number;
}

/** Flat steel-man: min(full export, delta export) per episode, 64 B records. */
export function flatLedger(registrySize: number): EvidenceLayout {
  const n = registrySize;
  return {
    name: "flat",
    runBytes: (changes) => {
      let total = BYTES.header + RECORD_BYTES * n; // construction: full ledger
      for (const ch of changes) {
        total += Math.min(BYTES.header + RECORD_BYTES * n, BYTES.header + RECORD_BYTES * ch.length);
      }
      return total;
    },
  };
}

/**
 * HACT layout: learned-order balanced8. Order is learned by spectral
 * seriation on co-invalidation affinity from the training half;
 * publication is evaluated on the held-out half. A node whose span is
 * fully changed costs packet_bytes(arity) (grouped record); uncovered
 * changed leaves cost 64 B each. One-time construction =
 * Σ_internal packet bytes.
 */
export function hactLedger(trainChanges: readonly (readonly number[])[], registrySize: number): EvidenceLayout {
  const n = registrySize;
  // Spectral seriation: order by Fiedler-like score = mean co-invalidation
  // neighbor affinity (deterministic approximation).
  const affinity = new Map<number, Map<number, number>>();
  for (const ch of trainChanges) {
    for (const a of ch) for (const b of ch) {
      if (a === b) continue;
      const row = affinity.get(a) ?? new Map();
      row.set(b, (row.get(b) ?? 0) + 1);
      affinity.set(a, row);
    }
  }
  const score = new Map<number, number>();
  for (const [a, row] of affinity) {
    let sum = 0, cnt = 0;
    for (const [, v] of row) { sum += v; cnt++; }
    score.set(a, cnt ? sum / cnt : 0);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0));
  const rank = new Map(order.map((g, i) => [g, i] as const));

  const arity = 8;
  const depth = Math.max(1, Math.ceil(Math.log(n) / Math.log(arity)));
  const tree = compactBalanced(n, arity, depth);
  const model = defaultCostModel(arity, depth, 4096);

  // Construction: one packet per internal node.
  let construction = BYTES.header;
  (function count(node: { children: { children: unknown[] }[] }): void {
    if (node.children.length) {
      construction += model.packetBytes(node.children.length);
      for (const c of node.children) count(c as { children: { children: unknown[] }[] });
    }
  })(tree as unknown as { children: { children: unknown[] }[] });

  return {
    name: "hact",
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
            // Fully-changed span: one grouped packet replaces the records.
            bytes += model.packetBytes(node.children.length);
            return;
          }
          // Partial: emit this packet? No — emit children recursively;
          // add per-leaf records for changed leaves not covered by a
          // fully-changed child.
          let leafRecords = 0;
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
          void leafRecords;
        })(tree as unknown as { lo: number; hi: number; children: { lo: number; hi: number; children: unknown[] }[] });
        total += bytes;
      }
      return total;
    },
  };
}
