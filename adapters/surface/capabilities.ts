import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OperationsPolicy, ValueSchema } from "../../src/harness/foundry/operations/contracts.ts";

const string = (maxLength = 128): ValueSchema => ({ type: "string", maxLength });
const integer = (maximum: number, minimum = 0): ValueSchema => ({ type: "integer", minimum, maximum });
const boolean: ValueSchema = { type: "boolean" };
const object = (properties: Record<string, ValueSchema>, required: string[] = []): ValueSchema => ({ type: "object", properties, required });
/** Generate inert capability schemas for the existing pinned operations tool.
 * Browser implementation, session identity and token names stay host-owned. */
export function surfacePolicy(sessionId: string): OperationsPolicy {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId)) throw new Error("invalid session ID");
  const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, "../..");
  const adapter = { argv: ["$NODE", "--experimental-strip-types", resolve(directory, "operations.ts")], envAllow: ["SURFACE_TOKEN", "SURFACE_ENDPOINT"],
    files: ["server.ts", "playwright.ts", "operations.ts", "capabilities.ts"].map(p => resolve(directory, p))
      .concat(["protocol.ts", "journal.ts", "controller.ts", "projection.ts"].map(p => resolve(root, "src/harness/surface", p))) };
  const session: ValueSchema = { type: "string", enum: [sessionId], maxLength: 128 };
  const mark = integer(10000, 1);
  const action = object({ kind: { type: "string", enum: ["activate", "input", "scroll", "key_chord", "hover"] }, markId: mark,
    coords: object({ x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } }, ["x", "y"]),
    button: { type: "string", enum: ["left", "right"] }, text: string(4096), clearFirst: boolean, cadenceMs: integer(50),
    submitKey: { type: "string", enum: ["Enter", "Tab"] }, direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amountPx: integer(10000, 1), keys: { type: "array", maxItems: 4, items: string(16) } }, ["kind"]);
  const expect = object({ targetFocused: mark, targetValue: object({ markId: mark, equals: string(4096) }, ["markId", "equals"]),
    targetState: object({ markId: mark, state: string(64), present: boolean }, ["markId", "state", "present"]),
    nodeAppearedWithText: string(2048), uriEquals: string(2048), uriChanged: boolean });
  return { schema: 1, namespace: `surface-${sessionId}`.slice(0, 128), resources: {}, timeoutMs: 15000, maxBytes: 1048576,
    pollMs: 1000, maxModelRequests: 1000, maxModelRequestBytes: 100000000,
    capabilities: {
      surface_observe: { adapter, effect: "read", input: object({ sessionId: session, includeVisual: boolean }, ["sessionId"]) },
      surface_act: { adapter, effect: "write", identity: ["/sessionId", "/transitionId"], reserve: {},
        input: object({ sessionId: session, transitionId: string(), expectedFrameId: string(), steps: { type: "array", maxItems: 16,
          items: object({ action, expect, settleTimeoutMs: integer(10000, 100) }, ["action", "expect"]) } }, ["sessionId", "transitionId", "expectedFrameId", "steps"]) },
    } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("usage: node --experimental-strip-types adapters/surface/capabilities.ts SESSION_ID");
  process.stdout.write(JSON.stringify(surfacePolicy(process.argv[2]), null, 2) + "\n");
}
