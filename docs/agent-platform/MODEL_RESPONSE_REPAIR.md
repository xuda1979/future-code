# Review and bounded model-response repair

Reviewed baseline: main `da22d21`, after the source-search and dispatch changes.
The review followed request decoding, journal replay, tool admission, worker
finalization, provider failover and independent acceptance. It also checked the
current architecture and recent PRs to avoid duplicating their improvements.

| Priority | Finding | Result |
|---|---|---|
| 1 | Invalid JSON in a tool's arguments aborts the attempt before the model receives a tool result or correction. An unchanged retry can ask for the same malformed operation again. Usage metadata in that completed response is discarded. | Reject the entire response before any tool admission, preserve the raw response and measured usage, and provide a bounded grammar correction in the same worker thread. |
| 1 | A blank final reply enters the final-output path. The independent verifier still governs correctness, but it can be invoked prematurely without an implementation or useful summary. | Treat whitespace-only replies without tools as rejected responses requiring correction. |
| 2 | A response can be committed before its thread checkpoint. Grammar recovery must preserve the existing exact-input replay boundary. | Replay the saved raw response under the original request binding before adding its correction notice; retain the rejection streak through worker replacement. |
| 2 | Terminal `/goal` and Foundry/Swarm still use separate execution paths. Enforced check/job policies in Swarm do not automatically govern terminal tools. | This remains a larger integration task. Use the governed entrypoint for experiments that require those policies. |
| 2 | Offline scheduler and transport fixtures do not establish scientific judgment or live R&D throughput. | Retain paired real-project trials as the criterion for promoting broader orchestration changes. |

## Runtime behavior

For ordinary Swarm worker replies, the host distinguishes repairable output
grammar mistakes from transport, configuration and capability failures.
Repairable cases include incomplete JSON argument strings, invalid argument
shapes, duplicate/invalid tool IDs, more than 32 calls, a tool stop without calls,
and empty final text. The strict decoder continues to reject these inputs.

The adapter records the original response and its supplied usage in the existing
request journal. The worker gives the model a short host-authored notice with a
fixed error code, a reason, an owned raw-response receipt, and an instruction to
resubmit the complete corrected group. Raw argument fragments and malformed
protocol messages are excluded from the conversation. None of the rejected
group's calls execute, including an otherwise valid prefix of the group.

Every rejected reply consumes a model turn. Corrective requests consume the
existing request, input-byte, context, concurrency, deadline and objective
budgets. They do not consume tool calls because no tool was admitted. After
three consecutive rejected replies, `MODEL_RESPONSE_REPAIR_EXHAUSTED` ends the
trajectory without another unchanged scheduler retry. A valid model message
clears the consecutive streak; existing total-turn/tool/request limits still
bound interleaved failures.

`model.rejected` journal events retain the code, raw receipt, step and streak.
Activity reports use `model:rejected` or `model:rejection-replay`. A crash before
or after the rejection checkpoint cannot double-charge a completed reply or
erase the saved streak. A provider call interrupted before a reply is selected
retains its recorded/unknown spend under the existing request rules.

With fallback routes, a valid response takes precedence over a grammar rejection.
Rejected routes retain their spend. If no valid route succeeds, the host selects
one rejection and makes it replayable for correction. Fencing and the existing
logical request binding prevent a late route from replacing a selected reply.

Truncated output stays terminal, including a malformed tail after otherwise
valid calls. Refusals, unsupported response blocks/stop reasons, invalid usage,
invalid outer response envelopes, oversized bodies and transport failures are
outside grammar repair. The independent debugging auditor retains its stricter
text-only contract. Repair notices cannot satisfy measurements, admit external
jobs, expand scopes, or establish task/integration acceptance.

No new tool, configuration option, dependency or remote endpoint capability is
required. The optional streak field is absent on older thread records until
needed. Update the source runtime; rebuild a compiled executable to use the
change. This implementation governs Foundry/Swarm workers, including their
remote execution backends; it does not add terminal QueryEngine controls.

## Offline comparison

The [recorded fault-injection comparison](validation/response-repair-20261015.json)
uses real Git worktrees, SQLite, task acceptance and final integration with
scripted replies. The scripted provider corrects an output-format mistake only
after receiving a host grammar notice. The repeated-malformed provider never
corrects. There is no live model or simulated network delay.

Ten trials per arm/workload ran in baseline/candidate/candidate/baseline order:

| Workload | Baseline task + integration success | Candidate task + integration success | Observation |
|---|---:|---:|---|
| Healthy known-file edit | 10/10 | 10/10 | Two requests and 9,935 encoded input bytes in both arms |
| Malformed tool argument | 0/10 | 10/10 | Candidate completes in one attempt with three requests; baseline exhausts three attempts |
| Blank final response | 0/10 | 10/10 | Candidate requests correction before finalization and independently verifies the edit |
| Repeated malformed response | 0/10 | 0/10 | Candidate stops after three rejected replies in one attempt, retaining supplied usage |

Healthy median task-plus-integration host time changes from 229.71 to 242.09 ms
in these samples. This does not establish latency equivalence or a universal
short-task improvement. Faulted baseline/candidate timings have different
outcomes and verification work; they must not be compared as speedup ratios.
The fixture demonstrates this deterministic recovery contract, not a prediction
of real model correction rates, billed tokens, cost or R&D speed.

Reproduce with the candidate script against either runtime:

```sh
git worktree add --detach /tmp/future-code-repair-baseline da22d21
node --experimental-strip-types scripts/bench-response-repair.mjs \
  --runtime-root /tmp/future-code-repair-baseline --repetitions 5
node --experimental-strip-types scripts/bench-response-repair.mjs \
  --repetitions 5
```

## Validation

All five required gates pass on Node 24.19.0. The gates ran sequentially with
CPU affinity 0–3, retaining the existing assertions and timeouts:

| Gate | Passed |
|---|---:|
| Focused response-repair regressions | 24 |
| Correctness | 62 Node + 30 Python |
| Resilience | 158 Node + 15 Python |
| Foundry | 556 |
| Swarm | 284 |
| Commands | 100 |

The suites overlap. There are no failures, cancellations or skips.

The focused regressions cover both provider protocols, actual localhost HTTP,
whole-group rejection and native tool/result pairing, owned raw receipts,
independent task/integration acceptance, crash/reopen on both sides of the
checkpoint, replacement workers, streak and cumulative budgets, valid fallback
preference, late-reply fencing, metered/unknown usage, healthy requests, and
terminal truncation/refusal/capability boundaries.

```sh
node --experimental-strip-types --test tests/foundry/response-repair.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

The validation record includes raw samples, source and test hashes, and gate
results. A dependency-complete Bun/terminal build and live-provider trials are
outside this offline validation.
