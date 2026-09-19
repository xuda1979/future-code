/**
 * Cost models for HACT certificate tree optimization.
 *
 * The cost model defines the packet bytes for a node with k children,
 * the maximum tree height, and the byte cap per packet.
 */

import type { CostModel, WorkloadFamily } from './types.js';

/** Default cost model: linear packet bytes with overhead. */
export function defaultCostModel(
  maxArity = 8,
  maxHeight = 3,
  byteCap = 4096,
  baseOverhead = 128,
  perChildBytes = 64,
): CostModel {
  return {
    packetBytes: (k: number) => Math.min(baseOverhead + k * perChildBytes, byteCap),
    maxHeight,
    maxArity,
    byteCap,
  };
}

/** Linear cost model: each child adds a fixed number of bytes. */
export function linearCostModel(
  maxArity: number,
  maxHeight: number,
  perChild: number,
  overhead: number,
  byteCap: number,
): CostModel {
  return {
    packetBytes: (k: number) => Math.min(overhead + k * perChild, byteCap),
    maxHeight,
    maxArity,
    byteCap,
  };
}

/** Quadratic cost model: bytes grow quadratically with arity. */
export function quadraticCostModel(
  maxArity: number,
  maxHeight: number,
  coefficient: number,
  overhead: number,
  byteCap: number,
): CostModel {
  return {
    packetBytes: (k: number) => Math.min(overhead + coefficient * k * k, byteCap),
    maxHeight,
    maxArity,
    byteCap,
  };
}

/** Logarithmic cost model: bytes grow with log(k). */
export function logCostModel(
  maxArity: number,
  maxHeight: number,
  coefficient: number,
  overhead: number,
  byteCap: number,
): CostModel {
  return {
    packetBytes: (k: number) =>
      k <= 1 ? overhead : Math.min(overhead + coefficient * Math.log2(k), byteCap),
    maxHeight,
    maxArity,
    byteCap,
  };
}

/** Step cost model: fixed cost per arity bracket. */
export function stepCostModel(
  maxArity: number,
  maxHeight: number,
  brackets: readonly number[],
  byteCap: number,
): CostModel {
  return {
    packetBytes: (k: number) => {
      const idx = Math.min(k - 1, brackets.length - 1);
      return Math.min(brackets[Math.max(0, idx)], byteCap);
    },
    maxHeight,
    maxArity,
    byteCap,
  };
}
