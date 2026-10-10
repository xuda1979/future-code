import { canonical, invariant } from "../kernel.ts";
import type { Capsule } from "../types.ts";
import { inScope, safePath, type AgentProfile, type PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import { definitions } from "./model.ts";
import { toolEffectContract } from "./toolEffects.ts";

/** Validate the advertised finite schema before any tool can produce effects. */
function shape(value: any, schema: any): void {
  if (!schema || !Object.keys(schema).length) { canonical(value); return; }
  if (schema.enum) invariant(schema.enum.includes(value), "invalid tool enum value");
  if (schema.type === "string") {
    invariant(typeof value === "string", "tool field must be text");
    invariant((schema.minLength === undefined || value.length >= schema.minLength) &&
      (schema.maxLength === undefined || value.length <= schema.maxLength), "tool text length out of bounds");
  }
  if (schema.type === "number" || schema.type === "integer") {
    invariant(typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)), "invalid tool number");
    invariant((schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum), "tool number out of bounds");
  }
  if (schema.type === "array") {
    invariant(Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems), "invalid tool array");
    if (schema.uniqueItems) invariant(new Set(value.map(canonical)).size === value.length, "duplicate tool item");
    for (const item of value) shape(item, schema.items);
  }
  if (schema.type === "object") {
    invariant(value && typeof value === "object" && !Array.isArray(value), "invalid tool object");
    for (const key of schema.required ?? []) invariant(Object.hasOwn(value, key), `missing tool ${key}`);
    for (const key of Object.keys(value)) {
      invariant(schema.additionalProperties !== false || Object.hasOwn(schema.properties ?? {}, key), `unexpected tool ${key}`);
      shape(value[key], schema.properties?.[key]);
    }
  }
}

export function validateToolProposal(c: Capsule, cfg: PinnedSwarm, profile: AgentProfile, call: Call): void {
  invariant(profile.tools.includes(call.name as any), "tool not allowed");
  const definition = definitions.find(def => def.name === call.name);
  invariant(definition, "unknown tool proposal");
  shape(call.arguments, definition.schema);
  toolEffectContract(cfg, call.name as any, call.arguments);
  if (["read_file", "write_file", "edit_file", "delete_file"].includes(call.name)) {
    const path = call.arguments.path as string; safePath(path);
    const write = call.name !== "read_file";
    invariant(inScope(path, write ? c.task.writeScope : [...c.task.writeScope, ...(c.task.readScope ?? [])]), "tool path outside task authority");
    if (write) invariant(!inScope(path, cfg.spec.protectedPaths), "protected tool path");
  }
  if (call.name === "run_check") invariant(profile.checks.includes(call.arguments.name as string), "check not permitted");
  if (call.name === "run_job") invariant(profile.jobs?.includes(call.arguments.name as string), "job not permitted");
}
