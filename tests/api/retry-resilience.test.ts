/**
 * Fault-tolerance tests for the API retry layer — the "never give up"
 * contract:
 *
 *   persistent retry is ON by default, survives 429/529 and connection-level
 *   failures (network down, DNS failure, stalled socket) indefinitely with
 *   heartbeat yields, and resumes the request once service is restored.
 *   FUTURE_CODE_UNATTENDED_RETRY=0 restores bounded retry.
 */
import { test, expect, afterEach } from "bun:test";
import {
  withRetry,
  isPersistentRetryEnabled,
  isConnectionLevelError,
  CannotRetryError,
  getRetryDelay,
  getDefaultMaxRetries,
} from "../../src/services/api/withRetry.ts";
import { APIConnectionError, APIError, APIUserAbortError } from "@future/sdk";

const originalRetryEnv = process.env.FUTURE_CODE_UNATTENDED_RETRY;
const originalMaxRetries = process.env.FUTURE_CODE_MAX_RETRIES;
afterEach(() => {
  if (originalRetryEnv === undefined) delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  else process.env.FUTURE_CODE_UNATTENDED_RETRY = originalRetryEnv;
  if (originalMaxRetries === undefined) delete process.env.FUTURE_CODE_MAX_RETRIES;
  else process.env.FUTURE_CODE_MAX_RETRIES = originalMaxRetries;
});

const MODEL = "test-model";

function connError(cause?: Error): APIConnectionError {
  return new APIConnectionError({ message: "Connection error.", cause });
}

function statusError(status: number, headers?: Record<string, string>): APIError {
  return new APIError(
    status,
    { message: `HTTP ${status}` },
    `HTTP ${status}`,
    (headers ? new Headers(headers) : undefined) as never,
    undefined,
  );
}

/** Drain a withRetry generator until it returns, capturing yields. */
async function drain<T>(
  gen: AsyncGenerator<unknown, T>,
): Promise<{ value: T; yields: unknown[] }> {
  const yields: unknown[] = [];
  while (true) {
    const r = await gen.next();
    if (r.done) return { value: r.value, yields };
    yields.push(r.value);
  }
}

function fakeClient(): unknown {
  return {};
}

test("isPersistentRetryEnabled: default ON when env unset", () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  expect(isPersistentRetryEnabled()).toBe(true);
  process.env.FUTURE_CODE_UNATTENDED_RETRY = "";
  expect(isPersistentRetryEnabled()).toBe(true);
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
});

test("isPersistentRetryEnabled: opt-out via 0/false/off", () => {
  for (const v of ["0", "false", "off", "no"]) {
    const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
    process.env.FUTURE_CODE_UNATTENDED_RETRY = v;
    expect(isPersistentRetryEnabled()).toBe(false);
    if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
    else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  }
});

test("isConnectionLevelError: APIConnectionError and fetch-failed chains", () => {
  expect(isConnectionLevelError(connError())).toBe(true);
  expect(isConnectionLevelError(new TypeError("fetch failed"))).toBe(true);
  expect(
    isConnectionLevelError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      }),
    ),
  ).toBe(true);
  expect(
    isConnectionLevelError(
      new Error("wrapped", { cause: new TypeError("fetch failed") }),
    ),
  ).toBe(true);
  expect(isConnectionLevelError(new Error("unrelated"))).toBe(false);
  expect(isConnectionLevelError(statusError(400))).toBe(false);
});

test("withRetry: retries through transient connection failures until success (default env)", async () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  let failures = 3;
  const { value } = await drain(
    withRetry(
      async () => fakeClient() as never,
      async () => {
        if (failures > 0) {
          failures--;
          throw connError();
        }
        return "recovered" as never;
      },
      { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 2 },
    ),
  );
  expect(value).toBe("recovered");
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
});

test("withRetry: retries 429 persistently past maxRetries and yields heartbeats", async () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  let failures = 5; // more than maxRetries=2 — persistent mode must not stop
  // Retry-After: 1s keeps persistent waits short while still crossing the
  // heartbeat-chunking path (each wait yields ≥1 api_error system message
  // before sleeping, so the host sees activity during outages).
  const { value, yields } = await drain(
    withRetry(
      async () => fakeClient() as never,
      async () => {
        if (failures > 0) {
          failures--;
          throw statusError(429, { "retry-after": "1" });
        }
        return "ok" as never;
      },
      { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 2 },
    ),
  );
  expect(value).toBe("ok");
  // 5 persistent waits of 1s each → ≥5 heartbeat yields.
  expect(yields.length).toBeGreaterThanOrEqual(5);
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
}, 30_000); // 5×1s Retry-After waits exceed bun's 5s default — allow headroom

test("withRetry: FUTURE_CODE_UNATTENDED_RETRY=0 restores bounded retry (CannotRetryError)", async () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  process.env.FUTURE_CODE_UNATTENDED_RETRY = "0";
  let attempts = 0;
  const gen = withRetry(
    async () => fakeClient() as never,
    async () => {
      attempts++;
      throw connError();
    },
    { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 2 },
  );
  let caught: unknown = null;
  try {
    await drain(gen);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CannotRetryError);
  expect(attempts).toBe(3); // maxRetries + 1
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
});

test("withRetry: DNS-style failures (fetch failed cause chain) are retried persistently", async () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  let failures = 2;
  const { value } = await drain(
    withRetry(
      async () => fakeClient() as never,
      async () => {
        if (failures > 0) {
          failures--;
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND bad.host"), {
              code: "ENOTFOUND",
            }),
          });
        }
        return "dns-ok" as never;
      },
      { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 1 },
    ),
  );
  expect(value).toBe("dns-ok");
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
});

test("withRetry: non-retryable 400 still fails fast even with persistent mode on", async () => {
  const prev = process.env.FUTURE_CODE_UNATTENDED_RETRY;
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  let attempts = 0;
  const gen = withRetry(
    async () => fakeClient() as never,
    async () => {
      attempts++;
      throw statusError(400);
    },
    { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 5 },
  );
  let caught: unknown = null;
  try {
    await drain(gen);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CannotRetryError);
  expect(attempts).toBe(1); // 400 is never retryable — no point
  if (prev !== undefined) process.env.FUTURE_CODE_UNATTENDED_RETRY = prev;
  else delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
});

for (const status of [408, 425, 500, 502, 503, 504, 522, 524]) {
  test(`withRetry: foreground HTTP ${status} recovers beyond the ordinary retry budget`, async () => {
    delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
    let attempts = 0;
    const result = await drain(withRetry(async () => fakeClient() as never, async () => {
      if (++attempts <= 4) throw statusError(status, { "retry-after": "0" });
      return "resumed";
    }, { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 1, querySource: "repl_main_thread" }));
    expect(result.value).toBe("resumed");
    expect(attempts).toBe(5);
    expect(result.yields.length).toBeGreaterThanOrEqual(4);
    expect(result.yields.every((y: any) => y.retryInMs >= 500)).toBe(true);
  });
}

test("raw transport faults yield heartbeats and rebuild the client before probing again", async () => {
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  let clients = 0, attempts = 0;
  const result = await drain(withRetry(async () => ({ id: ++clients }) as never, async (client: any) => {
    if (++attempts <= 3) throw Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" });
    return client.id;
  }, { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 1 }));
  expect(result.value).toBe(4);
  expect(clients).toBe(4);
  expect(result.yields.length).toBeGreaterThanOrEqual(3);
  expect(result.yields.every((y: any) => y.error instanceof APIConnectionError)).toBe(true);
});

test("long transport waits report progress every 30 seconds and can be cancelled before another probe", async () => {
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  const controller = new AbortController(); let calls = 0;
  const gen = withRetry(async () => fakeClient() as never, async () => {
    calls++;
    if (calls > 1) return "unexpected reprobe";
    throw Object.assign(new TypeError("fetch failed"), { headers: new Headers({ "retry-after": "65" }) });
  }, { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 1, signal: controller.signal });
  const first: any = (await gen.next()).value;
  const second: any = (await gen.next()).value;
  expect(first.retryInMs).toBe(65000);
  expect(second.retryInMs).toBe(35000);
  controller.abort();
  await expect(gen.next()).rejects.toBeInstanceOf(APIUserAbortError);
  expect(calls).toBe(1);
});

test("background summaries have bounded outage retries", async () => {
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY; let attempts = 0;
  await expect(drain(withRetry(async () => fakeClient() as never, async () => {
    attempts++; throw statusError(503, { "retry-after": "0" });
  }, { model: MODEL, thinkingConfig: { type: "disabled" }, maxRetries: 1, querySource: "agent_summary" })))
    .rejects.toBeInstanceOf(CannotRetryError);
  expect(attempts).toBe(2);
});

test("operator cancellation during a transport failure is surfaced as cancellation", async () => {
  const controller = new AbortController();
  await expect(drain(withRetry(async () => fakeClient() as never, async () => {
    controller.abort(); throw new TypeError("fetch failed");
  }, { model: MODEL, thinkingConfig: { type: "disabled" }, signal: controller.signal })))
    .rejects.toBeInstanceOf(APIUserAbortError);
});

test("retry delays honor dates/fractions and reject negative, partial, zero-spin and unbounded advice", () => {
  expect(getRetryDelay(1, "0.75")).toBe(750);
  expect(getRetryDelay(1, "0")).toBeGreaterThanOrEqual(500);
  expect(getRetryDelay(1, "-5")).toBeGreaterThanOrEqual(500);
  expect(getRetryDelay(1, "1garbage")).toBeLessThan(1000);
  expect(getRetryDelay(1, new Date(Date.now() + 120000).toUTCString())).toBeGreaterThan(118000);
  expect(getRetryDelay(1, "999999999999")).toBe(21600000);
  expect(getRetryDelay(1000)).toBeLessThanOrEqual(32000);
});

test("rate-limit reset advice cannot shorten a longer Retry-After directive", async () => {
  delete process.env.FUTURE_CODE_UNATTENDED_RETRY;
  const controller = new AbortController();
  const gen = withRetry(async () => fakeClient() as never, async () => {
    throw statusError(429, { "retry-after": "120",
      "future-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 5) });
  }, { model: MODEL, thinkingConfig: { type: "disabled" }, signal: controller.signal });
  expect(((await gen.next()).value as any).retryInMs).toBe(120000);
  controller.abort();
  await expect(gen.next()).rejects.toBeInstanceOf(APIUserAbortError);
});

test("invalid retry environment values cannot skip the initial request", async () => {
  for (const value of ["garbage", "-1", "1junk", "Infinity"]) {
    process.env.FUTURE_CODE_MAX_RETRIES = value;
    expect(getDefaultMaxRetries()).toBe(10);
    let calls = 0;
    const result = await drain(withRetry(async () => fakeClient() as never, async () => { calls++; return "started"; },
      { model: MODEL, thinkingConfig: { type: "disabled" } }));
    expect(result.value).toBe("started"); expect(calls).toBe(1);
  }
  process.env.FUTURE_CODE_MAX_RETRIES = "0";
  expect(getDefaultMaxRetries()).toBe(0);
});
