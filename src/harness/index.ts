/**
 * future-code agent-management platform — public API.
 *
 * Exposes the harness-builder, registry, runtime, self-monitor, and
 * self-improver so the platform (and any larger orchestrator) can create,
 * run, watch, and tune project-specific harnesses. future-code is where a
 * project harness is born, built, maintained, and lives.
 */
export * from "./types.ts";
export * from "./registry.ts";
export * from "./builder/index.ts";
export * from "./builder/detect.ts";
export * from "./runtime/index.ts";
export * from "./monitor/index.ts";
export * from "./improver/index.ts";

/** Platform version (matches the repo era). */
export const PLATFORM_VERSION = "0.1.0-harness";
