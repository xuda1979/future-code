/**
 * future-code harness — public surface.
 *
 * The harness is the project-specific self-improving loop: builder →
 * runtime → monitor → improver → scribe, all bounded-context.
 * future-code is where a project harness is born, built, maintained,
 * and lives.
 *
 * All agents use bounded context — the context budget enforcer ensures
 * no agent ever receives unbounded or long context.
 */
export * from "./types.ts";
export * from "./context.ts";
export * from "./registry.ts";
export * from "./history.ts";
export * from "./builder/index.ts";
export * from "./builder/detect.ts";
export * from "./runtime/index.ts";
export * from "./monitor/index.ts";
export * from "./improver/index.ts";
export * from "./scribe/index.ts";

/** Platform version (matches the repo era). */
export const PLATFORM_VERSION = "0.1.0-harness";
