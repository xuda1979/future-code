# Why a finished small task could keep running

## Finding

Future Code's host could turn an optional future-work note into mandatory work
after the requested task was already finished. This is a task-loop defect,
independent of model speed or the provider transport fixes in the first commit
of PR #112. It can expand a small task into unrelated research or redesign.

`parseMilestoneLedger()` previously treated every Markdown checkbox in the
session goal report as required. `goalFileOutcome()` rejected completion if any
of those checkboxes remained open. `decideAutoGoalContinuation()` then told the
model to continue that item as **requested work**. With the default unlimited
goal lifetime, the host could keep issuing continuations; its stagnation
reminder did not correct the scope error.

For example, after actually renaming a file and checking that its bytes were
preserved, this report still forced another model turn:

```markdown
# Rename old.txt to new.txt
Status: completed
## Milestones
- [x] Perform and verify the requested file change
## Optional future improvements
- [ ] Benchmark all project subsystems and redesign the framework
```

The baseline's next milestone was the unrelated benchmark/redesign. The host's
own continuation said to "Continue this requested work". The model did not
have to invent the scope expansion: the host explicitly instructed it.

The user's historical four-hour session trace was not available. This is a
reproduced cause of post-completion extra work, not proof that this particular
parser defect caused every reported delay or that the historical incident has
been replayed. The earlier provider experiment measured transport behavior,
not this task-level failure.

## Fix and preserved behavior

The ledger parser now follows section scope. Explicit optional, non-goal and
out-of-scope sections outside the required ledger do not create new required
milestones. Required Milestones/Acceptance sections and their descendants stay
required, including a nested heading that happens to say "Optional". A required
acceptance section inside optional notes also restores required authority.

Unsectioned legacy reports, unknown headings, "Next steps", bare "Backlog" and
Chinese equivalents retain their required checkboxes. The first document
title is the objective, even when the user names the objective "Optional future
improvements". English/Chinese numbered headings, Setext headings, fenced or
quoted examples, duplicate items and sibling scope changes have regressions.
Exclusion labels are deliberately conservative; an unrecognized label retains
the previous required behavior.

This changes which report notes count as requested milestones. It adds no
planner/model request, permission prompt, timeout, goal/token limit or model
effort reduction. It applies to small edits and completed milestones in long
projects. Unfinished required work and standing loops keep running. The
existing independent-acceptance boundary is unchanged: `REVIEW` is a completion
report awaiting acceptance, never a fabricated verified success.

## Reproduction and evidence

[`bench-task-completion.mjs`](../../scripts/bench-task-completion.mjs) performs
three actual small file tasks: a rename, a JSON configuration edit and an
arithmetic code fix. A separate Node process checks each artifact's semantics.
Both arms receive identical artifacts and goal reports, then execute the real
production goal-completion decision repeatedly. A fourth case deliberately
leaves a requested README update undone; its independent checker must fail
and the goal must remain active in both arms.

The comparator baseline is `169a169127909ea9e738750e81aacb174f0b031b`, the first
published commit of PR #112. Thus this comparison includes the earlier
transport/recovery changes in **both** arms and isolates the added scope fix.
Five trials per arm alternate execution order, for 40 total trials. The
32-continuation observation limit belongs only to the experiment; it is not
installed as a goal cap. No optional benchmark/redesign is actually executed.

| Actual artifact task | Independent checker | Baseline: unnecessary continuations after PASS | Fixed host: unnecessary continuations after PASS |
| --- | --- | ---: | ---: |
| Rename with exact byte preservation | PASS, all 10 trials | 32 in each of 5 trials; remained ACTIVE | 0 in all 5 trials; reached REVIEW |
| Change JSON port, preserve enabled flag | PASS, all 10 trials | 32 in each of 5 trials; remained ACTIVE | 0 in all 5 trials; reached REVIEW |
| Fix addition; positive/negative/zero checks | PASS, all 10 trials | 32 in each of 5 trials; remained ACTIVE | 0 in all 5 trials; reached REVIEW |
| Rename plus required README update left undone | FAIL, all 10 trials | Required README work remained ACTIVE | Required README work remained ACTIVE |

The negative control's continuations are necessary work, not extra work after
a passing check. They are recorded separately as observed continuations.
The current `main` merge of PR #112 (`534a00682ed23b15f585232a0c129869c09d5249`)
has the exact same Git tree as the measured baseline. The source hashes pin
the uncommitted candidate independently of its checkout's parent revision.

See the [raw trials, source and checker hashes](validation/task-completion-scope-20261117.json)
and the [regressions](../../tests/correctness/goal-milestone-scope.test.ts).
Counts measure unnecessary host requests after artifact checking, not live
model latency, an end-to-end speed ratio, or human productivity. A full-model
comparison still needs the same task, endpoint/model settings and independent
acceptance checks; it must include all validation and failed runs.

Final local checks and executed input hashes are in the
[follow-up validation record](validation/task-completion-validation-20261117.json).
The independent reviewer reproduced the real rename before and after the fix
and checked that required milestones, standing loops and acceptance semantics
remain intact. This PR does not deploy to existing sessions; the agent must be
rebuilt from the merged source before the running binary receives the fix.

```sh
git worktree add --detach ../future-code-pr112-before 169a169127909ea9e738750e81aacb174f0b031b
node --experimental-strip-types scripts/bench-task-completion.mjs \
  ../future-code-pr112-before /tmp/task-completion-scope.json 5 32
node --experimental-strip-types --test tests/correctness/goal-milestone-scope.test.ts
node scripts/test-correctness.mjs
node scripts/test-commands.mjs
```

The broader [OpenCode/Future Code comparison](opencode-comparison-20261117.md)
covers provider flow, context, parallel tools, effort, retries, durable work,
verification and autonomy. Efficient completion means finishing the authorized
objective once its evidence is ready while preserving the work and checks
actually required for it.
