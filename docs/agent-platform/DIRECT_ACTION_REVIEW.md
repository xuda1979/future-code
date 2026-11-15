# Keep execution focused on the next useful result

Future Code should extend a working artifact through the smallest relevant
change, test the uncertainty that matters, and retain independent acceptance.
An impressive amount of activity is not evidence that the requested outcome
has improved.

## Gaps found in the current execution path

- `decideAutoGoalContinuation` checks checkpoint changes at end-turn. A model
  that keeps calling tools never reaches that boundary. Its counter measures
  changes to the report, not changes to the actual deliverable.
- The main query uses delta continuations, which return before the standalone
  checkpoint-stagnation reminder. That reminder therefore cannot diagnose
  tool-only loops in the normal main-thread path.
- The existing general decision guidance names many useful lifecycle checks,
  but did not explicitly start with the gap from the existing best artifact
  or constrain broader infrastructure work to an observed dependency blocker.

## What changes

The shared guidance now starts from the requested outcome and existing best
verified artifact. New inputs alone do not require a new pipeline. Discovery
and plan review should resolve uncertainty that changes the next action;
environment failures should be distinguished from artifact quality.

The active main-thread request anchor also derives a small action review from
paired tool calls and results. It can appear before the model ends its turn:

| Observed pattern | Advisory response |
| --- | --- |
| At least 12 observation/planning receipts without a successful change or experiment call | Identify the remaining gap; make a small change/check or deliver the requested analysis. Explain the specific uncertainty if more discovery is needed. |
| At least 3 identical failed requests and receipts | Reconcile existing effects, diagnose a prerequisite and change the approach before an unchanged retry. |
| At least 3 identical observation requests and receipts | Review whether more polling/reading adds evidence; preserve healthy jobs and use durable waiting where supported. |

These thresholds request a review; they do not prove a stall. Deep reasoning,
long investigations, read-only work and necessary independent checks remain
valid. The model can still ignore advice; this is not a universal solution to
planning quality or provider latency.

## Boundaries and overhead

- No extra model calls, source-tree scans, retained transcript cache or new
  persistent state. At most 128 recent messages and 256 selected blocks are
  inspected. Fingerprints have separate depth, node and character budgets.
- Only actual paired receipts count. Ambiguous IDs, child-origin messages and
  unpaired results cannot establish activity. Human input bounds the window.
- Complete oversized values are not equated by a truncated prefix. Changed
  receipts clear their previous repetition count. The diagnostic exposes only
  counts, never tool inputs or output contents.
- A successful unknown tool conservatively resets the observation window.
  Shell commands and arbitrary project tools are not semantically classified;
  a successful edit is not proof of useful progress or correctness.
- Updating the current session's goal report is observation/planning activity.
  It cannot hide an observation-only loop. Other document writes can be real
  deliverables and are not globally treated as busywork.
- The review replaces the ephemeral tail only. Historical prompt prefixes,
  original tool evidence, continuation accounting and pause/review ownership
  remain intact. Compaction may retire old activity; surviving history is the
  only source for this diagnostic.
- No job cancellation, duplicate-execution suppression, permission grant,
  forced mutation, automatic completion or acceptance bypass is introduced.
  There is no domain-specific training, benchmark or scientific policy.

The revised shared guidance is 1,117 ASCII characters versus the previous
1,125, before the unchanged autonomy summary. An early longer draft failed an
existing small-context diagnostic-retention test; it was corrected without
changing that test or its context budget.

## Validation and adoption

See [the source-fingerprinted validation record](validation/direct-action-20261115.json).
The same 15 request-path regressions fail 9 cases on the pinned base and pass
all 15 after the change. They include no-end-turn loops, changing evidence,
healthy jobs, human/child/pause boundaries, malformed receipts and preservation
of goal state and complete history. This measures host behavior, not live R&D
speed or model intelligence.

Reproduce the focused tests and diagnostic-overhead measurement with:

```sh
node --experimental-strip-types --test tests/correctness/action-focus.test.ts
node --experimental-strip-types scripts/bench-action-focus.mjs
```

The normal correctness gate includes the regression file. The repository's
five required suites exercise existing acceptance, recovery, scheduling and
command behavior. A source merge alone does not update running sessions:
build/install the updated CLI and resume them to adopt it. A packaged build
was unavailable in the development environment because Bun was absent.
