/** Process-local hints only. SQLite remains authoritative across processes. */
export class Wakeup {
  revision = 0;
  private readonly listeners = new Set<() => void>();
  notify(): void { this.revision++; for (const wake of [...this.listeners]) wake(); }
  wait(observed: number, ms: number, signal?: AbortSignal, externalChanged?: () => boolean): Promise<void> {
    if (signal?.aborted || observed !== this.revision || externalChanged?.()) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); if (poll) clearInterval(poll);
        this.listeners.delete(finish); signal?.removeEventListener("abort", finish); resolve();
      };
      const timer = setTimeout(finish, Math.max(1, ms));
      // Check a cheap SQLite generation, not the full scheduler or evidence DAG.
      const poll = externalChanged ? setInterval(() => {
        try { if (externalChanged()) finish(); } catch { finish(); }
      }, Math.min(250, Math.max(1, ms))) : undefined;
      this.listeners.add(finish); signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted || observed !== this.revision) finish();
    });
  }
}

const stores = new Map<string, { wakeup: Wakeup; references: number }>();
export function attachWakeup(root: string): { wakeup: Wakeup; release: () => void } {
  const entry = stores.get(root) ?? { wakeup: new Wakeup(), references: 0 };
  stores.set(root, entry); entry.references++;
  return { wakeup: entry.wakeup, release() {
    if (--entry.references === 0) stores.delete(root);
  } };
}
