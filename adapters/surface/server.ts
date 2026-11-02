import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, openSync, closeSync, unlinkSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SurfaceController } from "../../src/harness/surface/controller.ts";
import { SurfaceJournal } from "../../src/harness/surface/journal.ts";
import { PlaywrightSurfaceDriver } from "./playwright.ts";

const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Resident host, authenticated loopback only. Workers cannot resume a human
 * gate. No browser is created per tool call and no endpoint executes JS/CSS. */
export function surfaceServer(controller: SurfaceController, token: string, operatorToken: string): Server {
  if (token.length < 24 || operatorToken.length < 24 || same(token, operatorToken)) throw new Error("distinct surface worker/operator tokens of at least 24 characters required");
  return createServer(async (request, response) => {
    try {
      const operator = ["/resume", "/dialog", "/reconcile"].includes(request.url ?? "");
      if (!same(request.headers.authorization ?? "", `Bearer ${operator ? operatorToken : token}`)) { response.writeHead(401).end(); return; }
      if (request.method !== "POST" || request.headers.origin) { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      request.setTimeout(15000, () => request.destroy());
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 131072) throw new Error("surface request too large"); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      if (request.url === "/observe") result = await controller.observe(input.includeVisual === true);
      else if (request.url === "/execute") result = await controller.execute(input.key, input.batch);
      else if (request.url === "/inspect") result = await controller.inspect(input.key, input.batch);
      else if (request.url === "/resume") result = await controller.resume(input.interruptId, input.expectedFrameId);
      else if (request.url === "/reconcile") result = await controller.reconcile(input.key, input.batch, input.interruptId, input.expectedFrameId);
      else if (request.url === "/dialog") {
        if (controller.journal.interrupt()?.id !== input.interruptId || typeof input.accept !== "boolean" || !(controller.driver instanceof PlaywrightSurfaceDriver)) throw new Error("invalid native dialog handoff");
        await controller.driver.resolveDialog(input.accept); result = await controller.observe();
      }
      else { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "surface request failed" }));
    }
  });
}

export interface SurfaceHostConfig {
  root: string; profile: string; sessionId: string; startUri: string;
  allowedOrigins: string[]; port: number; headless?: boolean; executablePath?: string;
  measureVisual?: boolean;
}
export async function serveSurface(config: SurfaceHostConfig): Promise<{ server: Server; controller: SurfaceController; close(): Promise<void> }> {
  if (!config || !/^[A-Za-z0-9_.-]{1,128}$/.test(config.sessionId) || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length ||
      !Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("invalid surface host configuration");
  const allowed = new Set(config.allowedOrigins.map(uri => { const u = new URL(uri); if (!["https:", "http:"].includes(u.protocol) || u.origin !== uri) throw new Error("explicit HTTP(S) origins required"); return u.origin; }));
  if (!allowed.has(new URL(config.startUri).origin)) throw new Error("start URI outside surface lease scope");
  const token = process.env.SURFACE_TOKEN ?? "", operatorToken = process.env.SURFACE_OPERATOR_TOKEN ?? "";
  if (token.length < 24 || operatorToken.length < 24 || token === operatorToken) throw new Error("configure distinct SURFACE_TOKEN and SURFACE_OPERATOR_TOKEN");
  const root = resolve(config.root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const bindingPath = join(root, "surface-binding.json"), cookiePath = join(root, "private-cookies.json");
  const binding = JSON.stringify({ sessionId: config.sessionId, profile: resolve(config.profile), origins: [...allowed].sort() });
  if (existsSync(bindingPath) && readFileSync(bindingPath, "utf8") !== binding) throw new Error("surface profile/session authority drift; use a separate state directory");
  // An abandoned lock requires the operator to verify the old host has exited.
  // Never steal a profile or run a second host against an uncertain session.
  const lockPath = join(root, "surface-host.lock"), lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, sessionId: config.sessionId }));
  let context: any, journal: SurfaceJournal | undefined, controller: SurfaceController | undefined, server: Server | undefined;
  try {
    writeFileSync(bindingPath, binding, { mode: 0o600 });
    const { chromium } = await import("playwright");
    context = await chromium.launchPersistentContext(resolve(config.profile), { headless: config.headless ?? false,
      viewport: { width: 1280, height: 800 }, serviceWorkers: "block", ...(config.executablePath ? { executablePath: config.executablePath } : {}) });
    // Chromium can discard session cookies on normal exit even with a persistent
    // profile. Keep those credentials private to the lease, outside evidence.
    if (existsSync(cookiePath)) await context.addCookies(JSON.parse(readFileSync(cookiePath, "utf8")));
    // Operator scope is enforced before requests, including redirects/popups.
    // This is an origin boundary, not authorization to submit arbitrary forms.
    await context.route("**/*", async (route: any) => {
      const url = new URL(route.request().url());
      if (!["http:", "https:"].includes(url.protocol) || !allowed.has(url.origin)) await route.abort("blockedbyclient");
      else await route.continue();
    });
    const page = context.pages()[0] ?? await context.newPage();
    if (page.url() === "about:blank" || !allowed.has(new URL(page.url()).origin))
      await page.goto(config.startUri, { waitUntil: "domcontentloaded", timeout: 15000 });
    journal = new SurfaceJournal(root, config.sessionId);
    controller = new SurfaceController(new PlaywrightSurfaceDriver(page, join(root, "visuals"), config.measureVisual === true, allowed), journal);
    server = surfaceServer(controller, token, operatorToken);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(config.port, "127.0.0.1", resolve); });
    return { server, controller, async close() {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      try {
        await controller!.close();
        writeFileSync(cookiePath + ".tmp", JSON.stringify(await context.cookies()), { mode: 0o600 }); renameSync(cookiePath + ".tmp", cookiePath);
      } finally { await context.close(); journal!.close(); closeSync(lock); unlinkSync(lockPath); }
    } };
  } catch (error) {
    server?.close(); await context?.close(); journal?.close(); closeSync(lock); unlinkSync(lockPath); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[process.argv.indexOf("--config") + 1];
    if (!process.argv.includes("--config") || !path) throw new Error("usage: node --experimental-strip-types adapters/surface/server.ts --config CONFIG.json");
    const host = await serveSurface(JSON.parse(readFileSync(path, "utf8")));
    console.error(JSON.stringify({ surfaceHost: host.server.address(), sessionId: host.controller.journal.sessionId }));
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (!stopping) { stopping = true; host.close().then(() => process.exit(0), () => process.exit(1)); } });
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
