import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { PlaywrightSurfaceDriver } from "../../adapters/surface/playwright.ts";
import { SurfaceController } from "../../src/harness/surface/controller.ts";
import { SurfaceJournal } from "../../src/harness/surface/journal.ts";
import { serveSurface } from "../../adapters/surface/server.ts";

// Offline tests use a real Chromium and a local, deterministic website. These
// are not claims about live-LLM task success or third-party anti-bot systems.
const html = `<!doctype html><html><body>
  <label for="query">Query</label><input id="query"><button id="search">Search</button>
  <div role="status" id="status">Ready</div>
  <button id="menu" aria-expanded="false">Menu</button>
  <button id="noop">Noop</button><button id="covered">Covered</button>
  <a href="/next?q=ok">Next</a><div id="shadow"></div>
  <script>
    search.onclick=async()=>{await fetch('/event',{method:'POST'});localStorage.setItem('result',query.value);statusNode.textContent='Submitted '+query.value;};
    const statusNode=document.getElementById('status');
    menu.onclick=()=>setTimeout(()=>{menu.setAttribute('aria-expanded','true');const item=document.createElement('div');item.role='option';item.textContent='Delayed option';document.body.append(item);},350);
    const shadow=document.getElementById('shadow').attachShadow({mode:'open'});shadow.innerHTML='<button aria-label="Shadow action">Shadow</button>';
  </script></body></html>`;
test("real browser: focus, delayed UI, deltas, shadow DOM, overlays, no-op and SoM", async () => {
  const server = createServer((request, response) => { response.writeHead(200, { "content-type": request.url === "/event" ? "application/json" : "text/html" }).end(request.url === "/event" ? "{}" : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.SURFACE_BROWSER_EXECUTABLE ? { executablePath: process.env.SURFACE_BROWSER_EXECUTABLE } : {}) });
  const root = mkdtempSync(join(tmpdir(), "future-browser-")), journal = new SurfaceJournal(root, "browser"), page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const driver = new PlaywrightSurfaceDriver(page, root, true), c = new SurfaceController(driver, journal);
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    let result = await c.observe(), frame = result.frame;
    const mark = (name: string) => frame.nodes.find(n => n.name === name)!.markId;
    assert.equal(frame.nodes.find(n => n.name === "Shadow action")?.hitTestClear, true);
    const queryMark = mark("Query"), searchMark = mark("Search");
    result = await c.execute("form", { expectedFrameId: frame.frameId, steps: [
      { action: { kind: "activate", markId: queryMark }, expect: { targetFocused: queryMark } },
      { action: { kind: "input", markId: queryMark, text: "test", clearFirst: true }, expect: { targetValue: { markId: queryMark, equals: "test" } } },
      { action: { kind: "activate", markId: searchMark }, expect: { nodeAppearedWithText: "Submitted test" } },
    ] });
    assert.equal(result.ok, true); assert.equal(result.receipts[2].deltas.storageChanged, true);
    assert.ok(result.receipts[2].deltas.network.some(n => n.method === "POST" && n.status === 200));
    assert.ok(result.receipts[2].deltas.visualDiffRatio! > 0);
    frame = result.frame;
    result = await c.execute("menu", { expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: mark("Menu") }, expect: { targetState: { markId: mark("Menu"), state: "expanded", present: true }, nodeAppearedWithText: "Delayed option" } }] });
    assert.equal(result.ok, true); assert.ok(result.receipts[0].settledAfterMs >= 300);
    await page.locator("#noop").focus(); frame = (await c.observe()).frame;
    result = await c.execute("noop", { expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: mark("Noop") }, expect: { targetState: { markId: mark("Noop"), state: "expanded", present: true } }, settleTimeoutMs: 400 }] });
    assert.ok(["SILENT_NO_OP", "POSTCONDITION_FAILED"].includes(result.receipts[0].outcome));
    assert.equal(result.ok, false, "hover/focus pixels cannot verify the absent semantic state");
    await page.evaluate(() => { const b = document.getElementById("covered")!.getBoundingClientRect(), overlay = document.createElement("div"); overlay.id = "overlay"; Object.assign(overlay.style, { position: "fixed", left: b.x + "px", top: b.y + "px", width: b.width + "px", height: b.height + "px", zIndex: "99999", opacity: "0" }); document.body.append(overlay); });
    frame = (await c.observe()).frame;
    result = await c.execute("overlay", { expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: mark("Covered") }, expect: { targetFocused: mark("Covered") } }] });
    assert.equal(result.receipts[0].outcome, "OCCLUDED"); assert.equal(result.receipts[0].dispatched, false);
    const visual = await c.observe(true); assert.match(readFileSync(visual.frame.visualRef!, "utf8"), /data:image\/png;base64/);
    await page.evaluate(() => document.getElementById("overlay")!.remove()); frame = (await c.observe()).frame;
    result = await c.execute("navigate", { expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: mark("Next") }, expect: { uriChanged: true } }] });
    assert.equal(result.ok, true); assert.match(result.frame.locationUri, /next\?q=ok/);
    await page.evaluate(() => { const b = document.createElement("button"); b.textContent = "Protected confirmation"; b.onclick = () => { confirm("Human decision required"); }; document.body.append(b); });
    frame = (await c.observe()).frame;
    result = await c.execute("native-dialog", { expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: mark("Protected confirmation") }, expect: { nodeAppearedWithText: "Never happens" } }] });
    assert.equal(result.interrupt?.reason, "HUMAN_CONFIRMATION");
    await driver.resolveDialog(false);
    const ready = await c.observe(); await c.resume(ready.interrupt!.id, ready.frame.frameId);
    await page.evaluate(() => { const p = document.createElement("input"); p.type = "password"; p.value = "must-not-be-in-evidence"; document.body.append(p); });
    result = await c.observe(); assert.equal(result.interrupt?.reason, "AUTH_WALL"); assert.ok(!JSON.stringify(result).includes("must-not-be-in-evidence"));
  } finally { await c.close(); journal.close(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("resident browser profile survives host restart and reuses stored session state", async () => {
  const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end('<div role="status" id="state"></div><script>state.textContent=localStorage.getItem("session")||"fresh"</script>'));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, root = mkdtempSync(join(tmpdir(), "future-profile-"));
  const oldToken = process.env.SURFACE_TOKEN, oldOperator = process.env.SURFACE_OPERATOR_TOKEN;
  process.env.SURFACE_TOKEN = "worker".padEnd(32, "a"); process.env.SURFACE_OPERATOR_TOKEN = "operator".padEnd(32, "b");
  const config = { root: join(root, "journal"), profile: join(root, "profile"), sessionId: "persistent", startUri: origin + "/", allowedOrigins: [origin], port: 0, headless: true,
    ...(process.env.SURFACE_BROWSER_EXECUTABLE ? { executablePath: process.env.SURFACE_BROWSER_EXECUTABLE } : {}) };
  let host: Awaited<ReturnType<typeof serveSurface>> | undefined;
  try {
    host = await serveSurface(config);
    await (host.controller.driver as PlaywrightSurfaceDriver).page.evaluate(() => { localStorage.setItem("session", "persisted"); document.cookie = "session=yes; SameSite=Strict"; });
    await host.close(); host = undefined;
    host = await serveSurface(config);
    const observed = await host.controller.observe(); assert.ok(observed.frame.nodes.some(n => n.name === "persisted"));
    assert.match(await (host.controller.driver as PlaywrightSurfaceDriver).page.evaluate(() => document.cookie), /session=yes/);
    await assert.rejects(() => serveSurface(config), /EEXIST/);
  } finally {
    await host?.close();
    if (oldToken === undefined) delete process.env.SURFACE_TOKEN; else process.env.SURFACE_TOKEN = oldToken;
    if (oldOperator === undefined) delete process.env.SURFACE_OPERATOR_TOKEN; else process.env.SURFACE_OPERATOR_TOKEN = oldOperator;
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});

test("a frozen browser renderer returns a bounded observation error", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SURFACE_BROWSER_EXECUTABLE ? { executablePath: process.env.SURFACE_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage(), driver = new PlaywrightSurfaceDriver(page, tmpdir());
  try {
    await page.setContent("<button>Freeze fixture</button>"); await driver.observe(false);
    await page.evaluate(() => { setTimeout(() => { for (;;) {} }, 20); }); await delay(60);
    const started = performance.now();
    await assert.rejects(() => driver.observe(false), /SURFACE_DRIVER_TIMEOUT/);
    assert.ok(performance.now() - started < 5000);
  } finally { await driver.close(); await browser.close(); }
});
