# Future-Code Agent Instructions

These instructions are provider-neutral and apply to coding agents connected through external LLM APIs.

## Source of truth

- Runtime source: `src/`
- Foundry kernel and scheduler: `src/harness/foundry/`
- Swarm external-API runtime: `src/harness/foundry/swarm/`
- Tests: `tests/`
- Operator documentation: `docs/agent-platform/`
- Generated patches, copied diffs, temporary build output, state databases, worktrees and benchmark output are never source of truth.

Prefer reading the smallest relevant source/test set. Do not reconstruct current behavior from historical patches or copied diffs.

## External LLM boundary

Future-Code currently treats LLMs as opaque external API services.

The host may control:
- task decomposition and dynamic DAG expansion;
- task/agent assignment;
- request concurrency and quota pools;
- prompt/context construction;
- persistent state and replay;
- tools and verification;
- recovery/replanning;
- local/remote job orchestration.

Do not assume Future-Code can control:
- provider KV caches or prefix-tree memory;
- SGLang/vLLM/llama.cpp internals;
- continuous batching or prefill scheduling;
- model placement, GPU/NPU topology or inference-engine scheduler state.

Provider prompt-cache hints may be used only as optional API features. They are not host-owned KV-cache guarantees.

## Development contract

1. Preserve the immutable acceptance boundary. A model response is never proof of correctness.
2. Add or update a focused regression test before or with behavioral changes.
3. Keep task contexts narrow and prefer durable receipts/references over copied transcripts.
4. Use bounded retries. Repeating the same failed operation without new evidence is a defect.
5. Keep external effects idempotent or explicitly reconciled before replacement work.
6. Dynamic child tasks must stay within parent authority and host-enforced depth/count limits.
7. Do not weaken checks, protected paths, budgets or verification to obtain a PASS.
8. Preserve resumability: crashes may leave durable state, never fabricated success.
9. For scheduler changes, keep `tasks` and `spawn_edges` authoritative; derived scheduler indexes must be rebuildable.
10. For large swarms, avoid full-run scans in steady-state claim/refill paths.

## Verification

For Foundry/Swarm changes, run the focused test first, then:

```sh
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

Synthetic stress tests measure scheduler/runtime behavior only. Do not present them as evidence of live-LLM productivity.
