/**
 * Fault-tolerance tests for the API retry layer — the "never give up"
 * contract:
 *
 *   persistent retry is ON by default, survives 429/529 and connection-level
 *   failures (network down, DNS failure, stalled socket) indefinitely with
 *   heartbeat yields, and resumes the request once service is restored.
 *   FUTURE_CODE_UNATTENDED_RETRY=0 restores bounded retry.
 */
import { test, expect } from "bun:test";
import {
  withRetry,
  isPersistentRetryEnabled,
  isConnectionLevelError,
  CannotRetryError,
} from "../../src/services/api/withRetry.ts";
import { APIConnectionError, APIError } from "@future/sdk";

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
