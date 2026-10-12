# Indexed episodic memory

Long R&D runs need to recover earlier methods and failures without putting the
entire transcript back into the next model request. Swarm keeps three levels:

| Level | Representation | Authority |
| --- | --- | --- |
| Active working context | Immutable task capsule, recent complete exchanges, latest progress note, bounded diagnostics | Notes are unverified; task acceptance stays frozen |
| Cold episode memory | SQLite `agent_memory` index over committed note/failure descriptors and owned receipts | Historical observations about exact inputs; never a PASS |
| Shared research knowledge | Existing versioned claims, cohort findings and intervention memory | Existing source verification and independent adjudication rules apply |

The cold index adds no model calls, transcript summarizer or automatic global
memory injection. A successful short task that saves no notes and encounters no
failures writes no cold memory entries. It still pays the normal journal costs
and the small additional `recall` schema overhead.

## Record and retrieve

`save_progress` still takes `summary`, `nextAction` and owned `receipts`. The host
binds the note to the current patch and turn, retains its complete receipt, and
indexes it in the same transaction as the tool result and thread checkpoint.
The projected retirement notice refreshes when a newer note exists, including
when the request fits without another retirement.

Failed checks, tool errors, failed external jobs and independent verification failures also receive
indexed descriptors. A failure signature hashes the invocation identity,
failure kind and exact result receipt. It deliberately excludes the patch so
identical observations can be found across source revisions. It is an exact
identity, not a semantic similarity score. Full failure fixtures remain owned
receipts with source, invocation and result references.

Examples for an agent with the existing `recall` capability:

```json
{"memoryKind":"progress","limit":5}
{"memoryKind":"failure","patchHash":"HOST_PATCH_HASH","limit":3}
{"memoryKind":"failure","failureSignature":"HOST_FAILURE_SIGNATURE"}
{"memoryKind":"all","memoryBefore":"EVENT_SEQ:ORDINAL","limit":5}
```

Choose one recall mode: receipt slice, event history, or memory lookup. Mixing
modes is rejected. Selectors and cursors never grant another thread's receipts.
Results are newest first and use a stable event-sequence/ordinal cursor. Exact
kind, patch and signature selectors use SQLite indexes. At most `limit + 1`
rows are fetched, with `limit` capped at 10. The JSON result fits 2,048 UTF-8
bytes; previews can be shortened or omitted while receipt pointers remain.
Use `nextBefore` to retrieve older matches and `receipt` to expand a full note
or fixture. Returned pages are also retained as normal tool receipts.

`currentPatch` compares the recorded patch with the live patch. For failures,
`currentInput` additionally checks verification feedback, completed external
jobs and child results. Both are input identity hints, never correctness proof.
Operator reads without a saved thread have null currentness. Every read checks
the source event's content hash, index consistency and receipt ownership.

## Inspect and rebuild

These commands do not call a model or execute project checks:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts memory \
  --root /path/to/state --run RUN_ID --task TASK_ID --memory-kind failure

node --experimental-strip-types src/harness/foundry/swarm/cli.ts memory-rebuild \
  --root /path/to/state --run RUN_ID --task TASK_ID --after 0 --limit 100
```

Rebuilding reads at most 100 source events per invocation and returns
`nextAfter`, `complete` and `indexed`. Continue with `--after nextAfter` until
complete. This repairs a derived index without rewriting source events,
receipts, thread state, acceptance or scheduler tables. Cursors retain their
identity after rebuilding. Events created before this descriptor format are
left in the existing event/receipt history; rebuilding does not invent past
notes from model transcripts. An index loss requires explicit rebuilding.

## Artifact hygiene and scope

New Foundry stores create a local `.gitignore` for `state.sqlite`, its WAL/SHM
companions and `artifacts/`. Existing ignore files are preserved. The rules
apply only to generated store paths and leave unrelated source files visible.
They prevent accidental addition of untracked output; they do not untrack or
delete previously committed files. Use `--root` to place a store outside a
project checkout. Back up SQLite and content-addressed artifacts consistently.

This is prompt compaction and indexed retrieval, not disk garbage collection or
an S3 uploader. Full evidence remains available. Existing pinned `run_job`
adapters already provide an API/process boundary for SSH, cluster or other
headless execution; each adapter must implement idempotent ensure/inspect and
reconciliation semantics.
See [structured job evidence](STRUCTURED_JOB_EVIDENCE.md) for generic result
contracts and bounded remote log retrieval.

The motivating feedback also described project-specific training, candidate
sanitization, benchmark directories and numerical tests that are absent from
Future-Code's runtime. Their reported scores are not Future-Code measurements.
Those projects can supply verifiers and job adapters through the generic
interfaces. This change adds no scientific SDK migration, domain curriculum,
model training pipeline or knowledge of any individual research project.

Focused tests cover bounded UTF-8 paging, patch/current-input binding,
cross-thread ownership, atomic rollback, reopen/rebuild, tamper detection,
unverified note labels, independent rejection and the short-task fast path.
Scripted fixtures validate runtime behavior; they do not measure live-model
R&D productivity.
