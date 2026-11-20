# R1: Zero-tax startup — bounded regular-MCP connect — verdict: MEASURED WIN (2.4× tail), shipped

Question (rnd_plan.md issue 1): the headless (-p) startup path blocked on
`await connectMcpBatch(regularMcpConfigs)` — an UNBOUNDED wait on every
configured MCP server. A server that hangs or initializes slowly taxes
every single headless invocation by its full startup time.

## A/B (`r1-mcp-block-bench.mjs`, results in `r1-results.json`)

Deterministic slow stdio MCP server (30s before its initialize reply),
`future-code --print`, 3 reps per arm, real binary.

| Arm | Slow-server wall (avg) | Fast-server control (avg) |
| --- | --- | --- |
| baseline (unbounded await, env=0) | 39.7 s | 10.0 s |
| treatment (bounded 5s race) | 16.5 s | 10.9 s |

- **Slow-server: 2.4× faster, 23.2 s saved per invocation.** The residual
  16.5s (not 10s) is the slow server's process spawn + a later startup
  stage joining the still-pending connect; the unbounded tail is gone.
- **Fast-server control: +0.9 s**, inside the baseline's own run-to-run
  spread (8.1–12.1 s). No regression on healthy startup.

## The change (src/main.tsx, print-mode MCP section)

The regular batch now races a `FUTURE_CODE_MCP_CONNECT_TIMEOUT_MS` timer
(default 10 s) exactly like the future.ai batch below it (which already
used this pattern for the tengu 76s p99). On timeout, startup proceeds;
the connect promise keeps running and pushes settled servers into
headlessStore in the background (turn 2+ sees them).

- Env override: `FUTURE_CODE_MCP_CONNECT_TIMEOUT_MS=0` restores the old
  unbounded await; a larger value tolerates slower fleets.
- Semantics for single-turn -p: a server slower than the bound is not
  visible in turn 1. That is the same trade the future.ai batch already
  makes, and it is the correct default — a hung server must not tax every
  scripted invocation.

## Why this ships (experiment-gated rule)

Large and obvious: the tail win is 23 s on a scripted no-op invocation
(2.4×), the healthy-path control shows no measurable regression, and the
change mirrors an already-validated pattern in the same code path. The
A/B is deterministic (scripted server sleep), reproducible via the bench.
