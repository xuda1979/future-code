/**
 * Deterministic episode stream shared by every arm.
 *
 * Reuses the HACT workload generators so coupling families match the
 * evidence-layout study: 'clustered', 'independent', 'global'. Each
 * episode emits invalidated gates, fresh facts (some carrying
 * unresolved obligations), and the reads a correct action requires.
 * All arms see byte-identical streams; only the context policy differs.
 */

import { generateInvalidations } from "../../hact/workload.ts";
import type { Episode, EpisodeFact } from "./types.ts";

/** Fact byte model, frozen by the protocol document. */
export const BYTES = {
  header: 64,
  fact: 32,
  summary: 96,
  capsule: 160,
  evidenceRow: 48,
} as const;

export interface EpisodeStreamSpec {
  size: number;
  family: "clustered" | "independent" | "global";
  seed: number;
  episodes: number;
}

/** Deterministic 32-bit PRNG (mulberry32) for episode composition. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the episode stream. Episode 0 establishes the full initial
 * state (all gates verified); later episodes carry the family's
 * invalidation pattern. Obligations open with a probability that
 * rises with coupling and must be resolved within a window.
 */
export function buildEpisodes(spec: EpisodeStreamSpec): Episode[] {
  const { size, family, seed, episodes } = spec;
  // Seed offset keeps family streams independent of stream composition.
  const invalidations = generateInvalidations(family, size, episodes, seed);
  const rng = mulberry32(seed ^ 0x5eed);
  const out: Episode[] = [];
  let openObligation: number | null = null;
  for (let e = 0; e < episodes; e++) {
    const invalidated = e === 0 ? Array.from({ length: size }, (_, i) => i) : invalidations[e - 1] ?? [];
    const facts: EpisodeFact[] = [];
    for (const g of invalidated) {
      // An invalidated gate re-observes as a fact; heavy coupling can
      // reopen obligations (never more than one open at a time).
      const reopensObligation = openObligation === null && rng() < 0.15;
      facts.push({
        id: `gate-${g}`,
        verified: !reopensObligation,
        bytes: BYTES.fact + (reopensObligation ? BYTES.fact : 0),
        dependsOn: coupling(g, size),
        obligation: reopensObligation,
      });
      if (reopensObligation) openObligation = g;
    }
    // The episode's task reads the invalidated gates plus one coupled
    // neighbor, so a policy that drops dependency bindings acts stale.
    const requiredReads = new Set<number>(invalidated);
    for (const g of invalidated) for (const d of coupling(g, size)) requiredReads.add(d);
    const needsObligation = openObligation !== null;
    // An open obligation is resolved by a dedicated read after opening.
    if (needsObligation && openObligation !== null) requiredReads.add(openObligation);
    out.push({
      index: e,
      invalidated,
      facts,
      requiredReads: [...requiredReads],
      needsObligation,
    });
    // Obligations close one episode after they were opened.
    if (openObligation !== null && facts.some(f => f.obligation) === false && out.length >= 2) openObligation = null;
    if (openObligation !== null && !out[out.length - 1].facts.some(f => f.obligation)) openObligation = null;
  }
  return out;
}

/** Deterministic coupling: each gate depends on its successor (wrapping). */
function coupling(g: number, n: number): number[] {
  return [(g + 1) % n];
}
