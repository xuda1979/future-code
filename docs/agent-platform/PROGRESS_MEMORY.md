# Durable, bounded R&D working memory (opt-in)

Long-lived external-API agents can lose older tool exchanges as their provider context fills. The durable journal already preserves receipts, but re-reading everything can cost time and tokens. Swarm profiles may now enable `save_progress` in `agents.<name>.tools` to let a worker retain one compact, structured working-memory checkpoint without modifying the objective contract.

Example model call:

```json
{"summary":"Observed a mismatch between the generated output and expected schema; hypothesis remains unverified.",
 "nextAction":"Inspect failing check details, then change only the relevant parser.",
 "receipts":["<64-character receipt returned by this thread>"]}
```

The kernel validates maximum sizes (1024 summary characters, 512 action characters, eight receipts), ensures every referenced receipt belongs to the current task, and persists the note together with the thread under the normal lease-fencing and event-journal rules. The note records the patch hash and turn at creation. It is **UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE**; it never affects independent verification, claims, the task graph, approvals, or budgets.

When the provider's encoded request exceeds its admitted context, context retirement preserves the pinned first user message and the longest contiguous suffix of complete assistant/tool groups. A single retire-and-recall notice includes the latest progress note if it fits; otherwise the generic journal pointer is used. Full receipts remain accessible via `recall`. Old retirement notices are removed from the projected history to avoid accumulating duplicate notices.

Exact per-message JSON byte accounting makes suffix selection linear in the number of messages (the previous implementation serialized every candidate suffix). This reduces local context-preparation CPU work asymptotically; actual wall-time, tokens per verified objective, and model accuracy still require matched live experiments. Nothing in this change controls opaque provider KV caches.

## Independent verification

The source-level regression suite is `tests/foundry/progress-memory.test.ts` and is discovered by `node scripts/test-swarm.mjs`. It covers long histories, exact UTF-8 budget, atomic tool exchanges, journal reopen, receipt ownership, and insufficient-space fallback. Run the full Foundry/Swarm checks before merging.

For experiments, compare matched long-horizon R&D objectives with and without `save_progress`, same model/budget/quality gate. Record time to verified acceptance, provider request bytes, tokens, and invalid or repeated tools. A synthetically shorter context is not itself a productivity result.
