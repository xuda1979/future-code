import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionRequest, ActionReply } from "../../src/harness/foundry/operations/actions.ts";
import type { SurfaceResult } from "../../src/harness/surface/protocol.ts";

/** Bridge the existing invoke_capability tool to a resident surface host.
 * execute/inspect are bound to the SAME host-generated action identity. */
export async function surfaceOperation(request: ActionRequest, endpoint: string, token: string): Promise<ActionReply> {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || token.length < 24)
    throw new Error("surface adapter requires authenticated loopback endpoint");
  const input = request.input as any;
  if (request.schema !== 1 || !["read", "execute", "inspect"].includes(request.operation) || !input || typeof input !== "object") throw new Error("invalid surface operation");
  const route = request.operation === "read" ? "observe" : request.operation;
  const batch = { expectedFrameId: input.expectedFrameId, steps: input.steps };
  const reply = await fetch(new URL(route, url), { method: "POST", headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(route === "observe" ? { includeVisual: input.includeVisual === true } : { key: request.key, batch }), signal: AbortSignal.timeout(12000) });
  if (!reply.ok) throw new Error(`surface host returned ${reply.status}`);
  const surface = await reply.json() as SurfaceResult | null;
  if (surface && input.sessionId !== undefined && surface.sessionId !== input.sessionId) throw new Error("surface session identity mismatch");
  const unknown = !surface || surface.receipts.some(r => r.outcome === "UNKNOWN");
  return { schema: 1, key: request.key, inputHash: request.inputHash, status: unknown ? "UNKNOWN" : surface?.interrupt && request.operation !== "read" ? "PENDING" : "CONFIRMED",
    result: { ...(surface ? { surface: JSON.parse(JSON.stringify(surface)) } : {}), observationOnly: true }, usage: {} };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 131072) throw new Error("surface input too large"); }
    process.stdout.write(JSON.stringify(await surfaceOperation(JSON.parse(input), process.env.SURFACE_ENDPOINT ?? "http://127.0.0.1:8754/", process.env.SURFACE_TOKEN ?? "")));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
