/**
 * HACT: Hyperedge-Aware Certificate Trees for Context-Bounded
 * Multi-Agent Coordination.
 *
 * This module provides:
 * - Certificate tree optimization (exact DP)
 * - Trusted certificate kernel (gate registry, evidence, generations)
 * - Cost models for packet bytes
 * - Synthetic workload generators for evaluation
 * - Integration with the future-code hierarchical coordination layer
 *
 * Research basis: HACT Research v1.0, September 18, 2026.
 * Ported from Python prototype to TypeScript for native integration.
 */

export * from './types.js';
export * from './tree.js';
export * from './certificates.js';
export * from './costModel.js';
export * from './workload.js';

/** Version string matching the research artifact. */
export const HACT_VERSION = '1.0.0';
