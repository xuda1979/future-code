/**
 * Temporal-persistence episode stream (protocol amendment v1.1).
 *
 * The HACT family generators draw i.i.d. invalidation sets. Retirement
 * is a temporal question, so each episode either keeps the working set
 * (with a small shift) or redraws from the frozen family generator.
 * Marginals stay family-matched; the temporal layer is new and frozen
 * by the protocol document before any cohort data was generated.
 */

import { generateInvalidations } from "../../hact/workload.ts";
import { mulberry32 } from "./episodes.ts";
import type { Episode, EpisodeFact } from "./types.ts";

export const PERSIST = 0.6;
export const OBLIGATION_WINDOW = 6;

export interface PersistenceSpec {
  size: number;
  family: "clustered" | "independent" | "global";
  seed: number;
  episodes: number;
}

interface PendingObligation { gate: number; openedAt: number }

/**
 * Stream with persistence and obligation lifetimes. Episode 0 carries
 * the full initial state (every gate invalidated once, i.e., first
 * observation). Obligations open stochastically on invalidated gates
 * (at most two concurrently) and become required reads exactly
 * OBLIGATION_WINDOW episodes later; a policy that drops them from its
 * active context records an obligation loss.
 */
export function buildPersistenceStream(spec: PersistenceSpec): Episode[] {
  const { size, family, seed, episodes } = spec;
  const familySets = generateInvalidations(family, size, Math.max(episodes, 1), seed);
  const rng = mulberry32(seed ^ 0x1a2b3c);
  const out: Episode[] = [];
  let current: number[] = [];
  const pending: PendingObligation[] = [];
  // Payload model (amendment v1.3): lognormal per gate, frozen by seed.
  const payloadRng = mulberry32(seed ^ 0x9e3779b9);
  const payloads = new Map<number, number>();
  const spare: number[] = [];
  function normal(r: () => number): number {
    if (spare.length) return spare.pop()!;
    let u = 0, v = 0, s = 0;
    do { u = r() * 2 - 1; v = r() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare.push(v * m);
    return u * m;
  }

  // Dependency footprint (amendment v1.4 item 13): D=12 interfaces the
  // working phase reads; drawn at phase start, persisting through
  // persistence steps, redrawn on family redraw.
  const FOOTPRINT_D = 12;
  let footprint: number[] = [];

  for (let e = 0; e < episodes; e++) {
    let invalidated: number[];
    let redraw = false;
    if (e === 0) {
      invalidated = Array.from({ length: size }, (_, i) => i);
      current = familySets[0] ?? [];
      redraw = true;
    } else if (rng() < PERSIST) {
      // Persist with a small shift of the working set.
      const shift = rng() < 0.5 ? 1 : -1;
      invalidated = current.map(g => (g + shift + size) % size);
      current = invalidated;
    } else {
      const draw = familySets[e % familySets.length] ?? [];
      invalidated = [...draw];
      current = draw;
      redraw = true;
    }
    // Deduplicate, keep order for determinism.
    invalidated = [...new Set(invalidated)].sort((a, b) => a - b);

    // Obligation openings: probability per episode scaled by coupling.
    const openRate = family === "global" ? 0.0 : family === "clustered" ? 0.5 : 0.35;
    if (e > 0 && invalidated.length > 0 && pending.length < 2 && rng() < openRate) {
      const g = invalidated[Math.floor(rng() * invalidated.length)]!;
      if (!pending.some(p => p.gate === g)) pending.push({ gate: g, openedAt: e });
    }

    const openedNow = pending.filter(p => p.openedAt === e).map(p => p.gate);
    // Payload sizes: frozen lognormal per gate (median 128 B, sigma 0.8,
    // minimum 32 B), drawn once per gate at first appearance so arm-neutral.
    // Protocol amendment v1.3 item 8.
    for (const g of invalidated) if (!payloads.has(g)) {
      payloads.set(g, Math.max(32, Math.round(Math.exp(Math.log(128) + 0.8 * normal(payloadRng)))));
    }
    const facts: EpisodeFact[] = invalidated.map(g => ({
      id: `gate-${g}`,
      verified: true,
      bytes: 32 + (payloads.get(g) ?? 128),
      dependsOn: [(g + 1) % size],
      obligation: openedNow.includes(g),
    }));

    const requiredReads = new Set<number>(invalidated);
    for (const g of invalidated) requiredReads.add((g + 1) % size);

    // Dependency footprint: drawn at phase (re)draw, persists through
    // persistence steps (amendment v1.4 item 13).
    if (redraw || footprint.length === 0) {
      const pool = [...new Set([...invalidated, ...current])].sort((a, b) => a - b);
      const anchor = pool.length ? pool[Math.floor(rng() * pool.length)]! : 0;
      footprint = [];
      for (let d = 0; d < FOOTPRINT_D; d++) {
        footprint.push((anchor + d) % size);
      }
    }
    for (const g of footprint) requiredReads.add(g);

    // Resolve obligations that reach their window; they become required
    // reads. Retained in the pending set until resolved.
    const due = pending.filter(p => e - p.openedAt >= OBLIGATION_WINDOW);
    for (const p of due) requiredReads.add(p.gate);

    out.push({
      index: e,
      invalidated,
      facts,
      requiredReads: [...requiredReads],
      needsObligation: due.length > 0,
      footprint,
    });

    for (const p of due) {
      const i = pending.indexOf(p);
      if (i >= 0) pending.splice(i, 1);
    }
  }
  return out;
}
