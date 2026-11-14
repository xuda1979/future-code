# Streaming tool execution vs buffered admission — A/B benchmark (2026-11-14)

Branch: `improve/streaming-tool-execution-default` (commit 770ebac)

## Question

Does admitting tool calls the moment each `tool_use` block finishes arriving
during streaming (real `StreamingToolExecutor`, new default) beat waiting for
the full assistant message (real `runTools` in `toolOrchestration.ts`,
previous main behavior), while preserving correctness?

## Method

- Both arms run **real production code paths**; only the SDK tool generator is
  stubbed with identical simulated work (`bench-loader.mjs` isolates
  `./toolExecution.js` so both arms execute the same `__benchToolRun`).
- Stream simulation: blocks arrive every `interarrivalMs`; after the last
  block, `trailingMs` of prose streams before the message completes.
  The buffered arm models query.ts's non-streaming path (collect then `runTools`);
  the streaming arm models the streaming path (`addTool` per block, poll
  `getCompletedResults` every 100ms, drain `getRemainingResults` at end).
- 3 scenarios × 2 arms × 3 reps after a discarded warmup; medians reported.
- Built-in correctness gate per run: exactly one tool_result per admitted
  tool_use, no duplicates, else the run asserts.

## Results (medians, `data/results.json`)

| scenario  | total buffered→streaming | speedup | first result buffered→streaming | speedup |
|-----------|--------------------------|---------|---------------------------------|---------|
| readonly-4 (4×Read, safe)        | 3210→1732 ms | **1.85×** | 3210→816 ms | **3.93×** |
| serial-4 (4×Bash, effectful)     | 5918→3509 ms | **1.69×** | 3512→1116 ms | **3.15×** |
| mixed-6 (3×Read + 3×Bash)        | 7122→3861 ms | **1.84×** | 4113→916 ms | **4.49×** |

Admission latency (work start minus block arrival), max per scenario:
buffered 2406–5011 ms vs streaming 0–1750 ms. Every tool starts as soon as
its block arrives when concurrency allows; effectful tools still serialize.

## Correctness

- All runs passed the paired-result assertion (no lost, duplicated, or
  fabricated tool results in either arm).
- Offline regression gates: `streaming-tool-executor.test.ts` 9/9,
  `streaming-gate-precedence.test.ts` 9/9, full `scripts/test-correctness.mjs`
  green on the committed tree.
- Rollout control: `FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION` env kill
  switch; cached GrowthBook/Statsig gate (`tengu_streaming_tool_execution2`)
  lets the server force-off; permission checks (`canUseTool`) unchanged.

## Conclusion

1.69–1.85× lower end-to-end tool latency and 3–4.5× faster first result with
correctness preserved. The change is merged as the default with layered
kill switches.

## Reproduce

```bash
node experiments/streaming-tool-execution-20261114/bench.mjs
```
