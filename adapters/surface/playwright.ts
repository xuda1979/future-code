import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Dialog, Page } from "playwright";
import type { BoundingBox, DriverSignals, HIDAction, InteractiveNode, InteractiveSurfaceDriver, SceneFrame, SettleResult } from "../../src/harness/surface/protocol.ts";

/** Engine-specific observation code stays here. No website selectors/procedures.
 * Open shadow roots are supported; opaque frames/canvases require visual input. */
export class PlaywrightSurfaceDriver implements InteractiveSurfaceDriver {
  readonly page: Page;
  readonly artifacts: string;
  private pending = new Set<unknown>();
  private network: DriverSignals["network"] = [];
  private storageBefore: string | null = null;
  private visualBefore?: { width: number; height: number; data: Buffer };
  private visualTarget?: BoundingBox;
  readonly measureVisual: boolean;
  readonly allowedOrigins?: ReadonlySet<string>;
  private dialog?: Dialog;
  private dialogEpoch = 0;
  private dialogWaiter?: () => void;
  private lastFrame?: SceneFrame;
  private onDialog: (dialog: Dialog) => void;
  private onRequest: (request: any) => void;
  private onFinished: (request: any) => void;
  private onResponse: (response: any) => void;
  constructor(page: Page, artifacts: string, measureVisual = false, allowedOrigins?: ReadonlySet<string>) {
    this.page = page; this.artifacts = artifacts; this.measureVisual = measureVisual; this.allowedOrigins = allowedOrigins;
    this.onRequest = r => { if (["xhr", "fetch", "document"].includes(r.resourceType())) this.pending.add(r); };
    this.onFinished = r => { this.pending.delete(r); };
    this.onResponse = r => { if (this.network.length < 64) this.network.push({ method: r.request().method(), status: r.status(), resourceType: r.request().resourceType() }); };
    this.onDialog = dialog => { this.dialog = dialog; this.dialogEpoch++; this.dialogWaiter?.(); };
    page.on("request", this.onRequest); page.on("requestfinished", this.onFinished); page.on("requestfailed", this.onFinished); page.on("response", this.onResponse);
    page.on("dialog", this.onDialog);
  }
  private async bounded<T>(work: Promise<T>, timeoutMs = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("SURFACE_DRIVER_TIMEOUT: browser did not answer within the observation deadline")), Math.max(1, timeoutMs));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async observe(includeVisual = false): Promise<SceneFrame> {
    if (this.dialog) {
      if (!this.lastFrame) throw new Error("native dialog before first observation requires operator handling");
      return { ...this.lastFrame, frameId: randomUUID(), timestamp: Date.now(), blocker: "HUMAN_CONFIRMATION" };
    }
    const frame = await this.bounded(this.page.evaluate(() => {
      const w = window as any;
      const state = w.__futureSurface ??= { documentId: `${Date.now()}-${Math.random()}`, ids: new WeakMap(), counter: 0, refs: new Map(), lastMutation: performance.now() };
      if (!state.observer) { state.observer = new MutationObserver(() => { state.lastMutation = performance.now(); }); state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); }
      state.refs = new Map();
      const nodes: any[] = []; let scanned = 0, visible = 0;
      const roots: (Document | ShadowRoot)[] = [document];
      for (let rootIndex = 0; rootIndex < roots.length && scanned < 12000; rootIndex++) {
        const root = roots[rootIndex], walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let raw = walker.nextNode(); raw && scanned++ < 12000; raw = walker.nextNode()) {
          const el = raw as HTMLElement;
          if (el.shadowRoot) { roots.push(el.shadowRoot); if (!state.shadows?.has(el.shadowRoot)) { (state.shadows ??= new WeakSet()).add(el.shadowRoot); state.observer.observe(el.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true }); } }
          const tag = el.tagName.toLowerCase(), role = el.getAttribute("role") ?? ({ button: "button", input: "textbox", textarea: "textbox", select: "combobox", a: "link", h1: "heading", h2: "heading", main: "main", nav: "navigation", dialog: "dialog", canvas: "canvas", iframe: "frame" } as Record<string, string>)[tag];
          if (!role && el.tabIndex < 0 && !el.onclick) continue;
          const style = getComputedStyle(el), r = el.getBoundingClientRect();
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
          visible++;
          if (nodes.length >= 160) continue;
          let id = state.ids.get(el); if (!id) { id = `${state.documentId}:${++state.counter}`; state.ids.set(el, id); }
          state.refs.set(id, el);
          const labels = [...(el as any).labels ?? []].map((label: HTMLElement) => label.innerText).join(" ");
          const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map(id => el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).getElementById(id)?.textContent ?? "" : document.getElementById(id)?.textContent ?? "").join(" ");
          const name = (el.getAttribute("aria-label") || labelled || labels || el.getAttribute("placeholder") || (tag === "input" ? el.getAttribute("value") : el.innerText) || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 240);
          const states: string[] = [];
          const focused = (el.getRootNode() as Document | ShadowRoot).activeElement;
          if (focused === el) states.push("focused");
          if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" || el.closest("[inert]")) states.push("disabled");
          for (const attr of ["expanded", "checked", "selected", "busy"]) if (el.getAttribute(`aria-${attr}`) === "true" || (attr === "checked" && (el as HTMLInputElement).checked)) states.push(attr);
          if (el.getAttribute("type") === "password" || el.getAttribute("autocomplete")?.includes("one-time-code")) states.push("sensitive");
          const x = Math.max(0, r.x), y = Math.max(0, r.y), width = Math.min(innerWidth, r.right) - x, height = Math.min(innerHeight, r.bottom) - y;
          let top = document.elementFromPoint(x + width / 2, y + height / 2);
          while (top?.shadowRoot?.elementFromPoint(x + width / 2, y + height / 2) && top.shadowRoot.elementFromPoint(x + width / 2, y + height / 2) !== top) top = top.shadowRoot.elementFromPoint(x + width / 2, y + height / 2);
          nodes.push({ markId: nodes.length + 1, ref: id, role: role ?? "control", name: states.includes("sensitive") ? "[sensitive input]" : name,
            ...("value" in el && !states.includes("sensitive") ? { value: String((el as any).value).slice(0, 4096) } : {}), states,
            bbox: { x, y, width, height }, hitTestClear: !!top && (top === el || el.contains(top)) });
        }
      }
      const text = (document.body?.innerText ?? "").slice(0, 16000);
      // Conservative hints, not a universal challenge detector. The operator
      // may set data-surface-blocker for a known protected confirmation flow.
      const explicit = document.querySelector("[data-surface-blocker]")?.getAttribute("data-surface-blocker");
      const blocker = ["CAPTCHA", "AUTH_WALL", "HUMAN_CONFIRMATION", "OUT_OF_SCOPE"].includes(explicit ?? "") ? explicit :
        /verify (that )?you are human|complete the captcha|checking your browser/i.test(text) ? "CAPTCHA" :
        nodes.some(n => n.states.includes("sensitive")) ? "AUTH_WALL" : undefined;
      const uri = new URL(location.href);
      for (const key of uri.searchParams.keys()) if (/password|token|secret|credential|authorization|api.?key|^code$|^state$|session/i.test(key)) uri.searchParams.set(key, "[redacted]");
      if (/token|secret|password|credential/i.test(uri.hash)) uri.hash = "[redacted]";
      return { schema: 1 as const, documentId: state.documentId, locationUri: uri.href,
        timestamp: Date.now(), viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, nodes,
        truncated: visible > nodes.length || scanned >= 12000, ...(blocker ? { blocker } : {}) };
    }));
    const result = { ...frame, frameId: randomUUID() } as SceneFrame;
    if (this.allowedOrigins && !this.allowedOrigins.has(new URL(this.page.url()).origin)) result.blocker = "OUT_OF_SCOPE";
    if (includeVisual) {
      mkdirSync(this.artifacts, { recursive: true, mode: 0o700 });
      // SVG SoM wraps a downsampled screenshot without mutating website DOM.
      const png = await this.page.screenshot({ scale: "css", type: "png", timeout: 2000 });
      const width = result.viewport.width, height = result.viewport.height, scale = Math.min(1, 1280 / width);
      const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      const marks = result.nodes.map(n => `<g><rect x="${n.bbox.x}" y="${n.bbox.y}" width="${n.bbox.width}" height="${n.bbox.height}" fill="none" stroke="#d22"/><text x="${n.bbox.x}" y="${n.bbox.y + 12}" font-size="12" fill="#d22">[${escape(String(n.markId))}]</text></g>`).join("");
      const path = join(this.artifacts, `${result.frameId}.svg`);
      writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" xlink:href="data:image/png;base64,${png.toString("base64")}"/>${marks}</svg>`, { mode: 0o600 });
      result.visualRef = path;
    }
    this.lastFrame = result;
    return result;
  }
  async settle(timeoutMs: number): Promise<SettleResult> {
    if (this.dialog) return { settled: true, elapsedMs: 0 };
    const started = performance.now(); let previous = "", stableSince = started;
    while (performance.now() - started < timeoutMs) {
      if (this.dialog) return { settled: true, elapsedMs: performance.now() - started };
      try {
        const sample = await this.bounded(this.page.evaluate(async () => {
          const painted = await Promise.race([new Promise<boolean>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
          const state = (window as any).__futureSurface;
          return { painted, quiet: performance.now() - (state?.lastMutation ?? 0), ready: document.readyState !== "loading",
            signature: JSON.stringify([location.href, innerWidth, innerHeight, scrollX, scrollY, [...(state?.refs?.values() ?? [])].map((el: HTMLElement) => {
              const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height, (el as HTMLInputElement).value, el.getAttribute("aria-expanded")];
            })]) };
        }), Math.min(500, timeoutMs - (performance.now() - started)));
        if (sample.signature !== previous) { previous = sample.signature; stableSince = performance.now(); }
        if (sample.painted && sample.ready && sample.quiet >= 150 && performance.now() - stableSince >= 150 && !this.pending.size)
          return { settled: true, elapsedMs: performance.now() - started };
      } catch { /* navigation can replace an execution context; deadline remains */ }
      await delay(30);
    }
    return { settled: false, elapsedMs: performance.now() - started };
  }
  private async storageHash(): Promise<string | null> {
    try {
      const values = await this.bounded(this.page.evaluate(() => [Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()]));
      const cookies = await this.bounded(this.page.context().cookies());
      return createHash("sha256").update(JSON.stringify([values, cookies])).digest("hex");
    } catch { return null; }
  }
  private async pixels(): Promise<{ width: number; height: number; data: Buffer }> {
    const { PNG } = await import("pngjs");
    return PNG.sync.read(await this.page.screenshot({ scale: "css", timeout: 2000 }));
  }
  async beginAction(target?: InteractiveNode): Promise<void> {
    this.network = []; this.storageBefore = await this.storageHash(); this.visualTarget = target?.bbox;
    this.visualBefore = this.measureVisual ? await this.pixels() : undefined;
  }
  async signals(): Promise<DriverSignals> {
    if (this.dialog) return { network: [...this.network], storageChanged: null, visualDiffRatio: null, targetVisualDiffRatio: null };
    const after = await this.storageHash();
    let visualDiffRatio: number | null = null, targetVisualDiffRatio: number | null = null;
    if (this.visualBefore) {
      const a = this.visualBefore, b = await this.pixels();
      if (a.width !== b.width || a.height !== b.height) visualDiffRatio = 1;
      else {
        let changed = 0, targetChanged = 0, targetPixels = 0;
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 4, t = this.visualTarget;
          const inside = t && x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height;
          const differs = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30;
          if (differs) changed++;
          if (inside) { targetPixels++; if (differs) targetChanged++; }
        }
        visualDiffRatio = changed / (a.width * a.height);
        targetVisualDiffRatio = targetPixels ? targetChanged / targetPixels : null;
      }
      delete this.visualBefore;
    }
    return { network: [...this.network], storageChanged: this.storageBefore === null || after === null ? null : this.storageBefore !== after, visualDiffRatio, targetVisualDiffRatio };
  }
  async reveal(ref: string): Promise<void> {
    await this.bounded(this.page.evaluate(ref => {
      const el = (window as any).__futureSurface?.refs.get(ref);
      if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }, ref));
  }
  async dispatch(action: HIDAction, ref?: string): Promise<void> {
    const interrupted = new Promise<void>(resolve => { this.dialogWaiter = resolve; });
    try { await Promise.race([this.physical(action, ref, this.dialogEpoch), interrupted]); }
    finally { delete this.dialogWaiter; }
  }
  private async physical(action: HIDAction, ref: string | undefined, epoch: number): Promise<void> {
    const current = () => { if (epoch !== this.dialogEpoch || this.dialog) throw new Error("native dialog interrupted input sequence"); };
    const target = ref ? await this.bounded(this.page.evaluate(ref => {
      const el = (window as any).__futureSurface?.refs.get(ref) as HTMLElement | undefined;
      if (!el?.isConnected || el.matches(":disabled") || el.closest("[inert]") || el.getAttribute("aria-disabled") === "true") return null;
      const b = el.getBoundingClientRect(), x = Math.max(0, b.x) + (Math.min(innerWidth, b.right) - Math.max(0, b.x)) / 2, y = Math.max(0, b.y) + (Math.min(innerHeight, b.bottom) - Math.max(0, b.y)) / 2;
      let top = document.elementFromPoint(x, y);
      while (top?.shadowRoot?.elementFromPoint(x, y) && top.shadowRoot.elementFromPoint(x, y) !== top) top = top.shadowRoot.elementFromPoint(x, y);
      return top && (top === el || el.contains(top)) ? { x, y } : null;
    }, ref)) : undefined;
    current();
    if (ref && !target) throw new Error("target changed before physical input");
    if (action.kind === "activate") {
      const p = target ?? { x: action.coords!.x * this.page.viewportSize()!.width, y: action.coords!.y * this.page.viewportSize()!.height };
      await this.page.mouse.click(p.x, p.y, { button: action.button ?? "left" });
    } else if (action.kind === "input") {
      await this.page.mouse.click(target!.x, target!.y);
      current();
      const focused = await this.bounded(this.page.evaluate(ref => { const el = (window as any).__futureSurface?.refs.get(ref); return el && (el.getRootNode() as Document | ShadowRoot).activeElement === el; }, ref!));
      if (!focused) throw new Error("input focus intercepted");
      current();
      if (action.clearFirst) await this.page.keyboard.press("ControlOrMeta+A");
      current();
      if (action.clearFirst && action.text.length === 0) await this.page.keyboard.press("Backspace");
      current();
      if (action.cadenceMs) await this.page.keyboard.type(action.text, { delay: action.cadenceMs });
      else await this.page.keyboard.insertText(action.text);
      current();
      if (action.submitKey) await this.page.keyboard.press(action.submitKey);
    } else if (action.kind === "scroll") {
      if (target) await this.page.mouse.move(target.x, target.y);
      const d = action.amountPx * (["up", "left"].includes(action.direction) ? -1 : 1);
      await this.page.mouse.wheel(["left", "right"].includes(action.direction) ? d : 0, ["up", "down"].includes(action.direction) ? d : 0);
    } else if (action.kind === "hover") await this.page.mouse.move(target!.x, target!.y);
    else await this.page.keyboard.press(action.keys.join("+"));
  }
  /** Only the authenticated human endpoint can call this. No worker HID verb
   * accepts/dismisses a native confirmation or supplies a prompt response. */
  async resolveDialog(accept: boolean): Promise<void> {
    if (!this.dialog) throw new Error("no native dialog pending");
    const dialog = this.dialog;
    if (accept) await dialog.accept(); else await dialog.dismiss();
    delete this.dialog;
  }
  async close(): Promise<void> {
    this.page.off("request", this.onRequest); this.page.off("requestfinished", this.onFinished); this.page.off("requestfailed", this.onFinished); this.page.off("response", this.onResponse);
    this.page.off("dialog", this.onDialog);
  }
}
