/** Bound the host even when an adapter, reader or cancellation hook ignores
 * AbortSignal. A detached external call is still unknown spend, never a refund. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return; settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      if (settled) { try { late?.(value); } catch { /* Best-effort disposal of a detached response. */ } return; }
      settled = true; signal.removeEventListener("abort", abort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}
export function discardResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}
export function boundedFetch(fetcher: typeof fetch, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  init.signal.throwIfAborted();
  return abortable(Promise.resolve().then(() => { init.signal.throwIfAborted(); return fetcher(url, init); }), init.signal, discardResponse);
}
