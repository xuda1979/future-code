import { canonical, invariant } from "../kernel.ts";
import { pinCommand } from "../commands.ts";
import type { CommandSpec, Json, PinnedCommand, Task } from "../types.ts";

/** Project-authored schemas are inert data. No references, code or coercion. */
export interface ValueSchema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
  properties?: Record<string, ValueSchema>;
  required?: string[];
  items?: ValueSchema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
}
export interface CapabilitySpec {
  adapter: CommandSpec;
  effect: "read" | "write";
  input: ValueSchema;
  /** JSON pointers identifying an external resource/transition, not a run/call. */
  identity?: string[];
  /** Maximum held until terminal, verified actual usage is available. */
  reserve?: Record<string, number>;
  requires?: string[];
  purpose?: "initiate" | "resolve";
}
export interface OperationsPolicy {
  schema: 1;
  namespace: string;
  resources: Record<string, { unit: string; limit: number }>;
  capabilities: Record<string, CapabilitySpec>;
  routes?: Record<string, Task[]>;
  resolutionEvents?: string[];
  timeoutMs: number;
  maxBytes: number;
  pollMs: number;
  maxModelRequests: number;
  maxModelRequestBytes: number;
}
export interface PinnedOperations {
  policy: OperationsPolicy;
  adapters: Record<string, PinnedCommand>;
}
export function operationName(x: unknown): asserts x is string {
  invariant(typeof x === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(x) &&
    !["constructor", "prototype", "__proto__"].includes(x), "invalid operations name");
}
export function integer(x: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts x is number {
  invariant(Number.isSafeInteger(x) && Number(x) >= minimum && Number(x) <= maximum, "invalid operations integer");
}
function fields(x: object, allowed: string[]): void {
  invariant(x && typeof x === "object" && !Array.isArray(x), "operations object required");
  invariant(Object.keys(x).every(k => allowed.includes(k)), "unknown operations field");
}
export function validateValueSchema(s: ValueSchema, depth = 0): void {
  invariant(depth < 9, "operations schema too deep");
  fields(s, ["type", "properties", "required", "items", "enum", "minimum", "maximum", "maxLength", "maxItems"]);
  invariant(["object", "array", "string", "integer", "number", "boolean", "null"].includes(s.type), "invalid schema type");
  if (s.properties !== undefined) {
    invariant(s.type === "object" && Object.keys(s.properties).length <= 64, "invalid schema properties");
    for (const [k, v] of Object.entries(s.properties)) { operationName(k); validateValueSchema(v, depth + 1); }
  }
  if (s.required !== undefined) invariant(s.type === "object" && Array.isArray(s.required) &&
    new Set(s.required).size === s.required.length && s.required.every(k => Object.hasOwn(s.properties ?? {}, k)), "invalid required fields");
  if (s.type === "array") { invariant(s.items, "array items required"); validateValueSchema(s.items, depth + 1); }
  else invariant(s.items === undefined && s.maxItems === undefined, "array-only schema field");
  if (s.maxItems !== undefined) integer(s.maxItems, 0, 1024);
  if (s.maxLength !== undefined) { invariant(s.type === "string", "string-only schema field"); integer(s.maxLength, 0, 65536); }
  for (const key of ["minimum", "maximum"] as const) if (s[key] !== undefined)
    invariant(["integer", "number"].includes(s.type) && Number.isFinite(s[key]), "invalid numeric schema bound");
  invariant(s.minimum === undefined || s.maximum === undefined || s.minimum <= s.maximum, "inverted schema bounds");
  if (s.enum !== undefined) invariant(Array.isArray(s.enum) && s.enum.length > 0 && s.enum.length <= 64, "invalid schema enum");
}
export function validateValue(v: Json, s: ValueSchema): void {
  if (s.enum) invariant(s.enum.some(x => canonical(x) === canonical(v)), "value outside schema enum");
  if (s.type === "object") {
    invariant(v !== null && typeof v === "object" && !Array.isArray(v), "object input required");
    invariant((s.required ?? []).every(k => Object.hasOwn(v, k)), "missing capability input");
    for (const k of Object.keys(v)) {
      invariant(Object.hasOwn(s.properties ?? {}, k), "unexpected capability input");
      validateValue(v[k], s.properties![k]);
    }
  } else if (s.type === "array") {
    invariant(Array.isArray(v) && v.length <= (s.maxItems ?? 64), "invalid array input");
    for (const x of v) validateValue(x, s.items!);
  } else if (s.type === "string") invariant(typeof v === "string" && v.length <= (s.maxLength ?? 4096), "invalid string input");
  else if (s.type === "integer" || s.type === "number") {
    invariant(typeof v === "number" && Number.isFinite(v) && (s.type !== "integer" || Number.isSafeInteger(v)), "invalid numeric input");
    invariant((s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum), "numeric input outside bounds");
  } else invariant(s.type === "null" ? v === null : typeof v === "boolean", "invalid scalar input");
}
export function pointer(input: Json, path: string): Json {
  invariant(typeof path === "string" && /^\/(?:[^~]|~[01])*$/.test(path), "invalid identity pointer");
  let value = input;
  for (const p of path.slice(1).split("/").map(x => x.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    invariant(value !== null && typeof value === "object" && Object.hasOwn(value, p), "identity field missing");
    value = (value as any)[p];
  }
  invariant((typeof value === "string" && value.length > 0 && value.length <= 512) ||
    typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)), "identity must be a bounded scalar");
  return value;
}
export function validateOperations(p: OperationsPolicy): void {
  fields(p, ["schema", "namespace", "resources", "capabilities", "routes", "resolutionEvents", "timeoutMs", "maxBytes", "pollMs", "maxModelRequests", "maxModelRequestBytes"]);
  invariant(p.schema === 1, "invalid operations schema"); operationName(p.namespace);
  integer(p.timeoutMs, 10, 300000); integer(p.maxBytes, 1024, 1048576); integer(p.pollMs, 10, 3600000);
  integer(p.maxModelRequests, 1, 100000000); integer(p.maxModelRequestBytes, 1, 1000000000000);
  invariant(p.resources && !Array.isArray(p.resources) && Object.keys(p.resources).length <= 32, "invalid operations resources");
  for (const [name, r] of Object.entries(p.resources)) {
    operationName(name); fields(r, ["unit", "limit"]); operationName(r.unit); integer(r.limit);
  }
  invariant(p.capabilities && !Array.isArray(p.capabilities) && Object.keys(p.capabilities).length > 0 &&
    Object.keys(p.capabilities).length <= 64, "invalid operations capabilities");
  for (const [name, c] of Object.entries(p.capabilities)) {
    operationName(name); fields(c, ["adapter", "effect", "input", "identity", "reserve", "requires", "purpose"]);
    invariant(c.effect === "read" || c.effect === "write", "invalid capability effect"); validateValueSchema(c.input);
    invariant(c.adapter && Array.isArray(c.adapter.argv) && c.adapter.argv.length > 0, "missing capability adapter");
    fields(c.adapter, ["argv", "envAllow", "files"]);
    if (c.effect === "write") invariant(Array.isArray(c.identity) && c.identity.length > 0 && c.identity.length <= 8 &&
      new Set(c.identity).size === c.identity.length && c.identity.every(s => typeof s === "string" && /^\/(?:[^~]|~[01])*$/.test(s)), "write capability needs stable identity pointers");
    else invariant(c.identity === undefined && c.reserve === undefined && c.purpose === undefined && c.requires === undefined, "read capability cannot reserve or mutate");
    if (c.purpose !== undefined) invariant(["initiate", "resolve"].includes(c.purpose), "invalid capability purpose");
    for (const [r, amount] of Object.entries(c.reserve ?? {})) { invariant(Object.hasOwn(p.resources, r), "unknown reserved resource"); integer(amount, 1, p.resources[r].limit); }
    if (c.requires !== undefined) invariant(Array.isArray(c.requires) && c.requires.length <= 32 && c.requires.every(x => { operationName(x); return true; }), "invalid observation prerequisites");
  }
  if (p.routes) {
    invariant(!Array.isArray(p.routes) && Object.keys(p.routes).length <= 64, "invalid event routes");
    for (const [event, tasks] of Object.entries(p.routes)) { operationName(event); invariant(Array.isArray(tasks) && tasks.length > 0, "empty event route"); }
  }
  if (p.resolutionEvents !== undefined) invariant(Array.isArray(p.resolutionEvents) && new Set(p.resolutionEvents).size === p.resolutionEvents.length &&
    p.resolutionEvents.every(k => Object.hasOwn(p.routes ?? {}, k)), "unknown resolution event route");
  invariant(Buffer.byteLength(canonical(p)) <= 262144, "operations policy too large");
}
export function pinOperations(policy: OperationsPolicy, project: string, node: string): PinnedOperations {
  validateOperations(policy);
  const copy = JSON.parse(canonical(policy)) as OperationsPolicy;
  return { policy: copy, adapters: Object.fromEntries(Object.entries(copy.capabilities).map(([k, c]) => [k,
    pinCommand({ ...c.adapter, argv: [c.adapter.argv[0] === "$NODE" ? node : c.adapter.argv[0], ...c.adapter.argv.slice(1)] }, project)])) };
}
