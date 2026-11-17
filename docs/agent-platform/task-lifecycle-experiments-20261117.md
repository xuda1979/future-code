# Task lifecycle experiments: completion, amendments and restart

This continues the [optional-work scope experiment](task-loop-root-cause-20261117.md)
after PR #113 was merged. Baseline: `12281e7a224c7a0d60e81f2858d05b8740af684d`.
The goal is to find task failures through actual artifacts and production
lifecycle decisions. A task can waste time by continuing unnecessary work, but
it can also lose productivity by retiring while requested work is missing.

## Three defects reproduced and fixed

| Trigger | Previous host behavior | Correct behavior implemented |
| --- | --- | --- |
| Rename passes; user adds README work; old completion report is rewritten and the process restarts | The new file write identity made the old report authoritative again. Host reached REVIEW with README absent. | A durable content fingerprint invalidates that old completion after genuinely new steering. The goal continues; after README is created and checked, the updated report reaches REVIEW. |
| Current configuration task says `Status: in_progress`; worklog records a historical `Status: completed` | Parser skipped the nonterminal current value and adopted historical completion. Port remained 8080 instead of requested 9090. | Only the unambiguous current status in the objective preamble controls the goal. Missing, unknown or conflicting current status prompts automatic report repair; history cannot supply completion or blocker fields. |
| A completed task is in REVIEW; user says “Also create README.md documenting the rename” | Additive action failed to reactivate durable goal tracking; the added artifact remained missing in the lifecycle reproduction. | An explicit actionable additive follow-up reopens the root with its new steering and retained evidence. Explanation/status questions leave the completed goal alone. |

The content guard survives a fresh Node process and copied/rewritten report
files. It does not replace the original write-identity guard: an ordinary
explicit pause/resume with no added work can still finish after renewed
checking and a freshly written identical report. New instructions supplied
during an operator pause invalidate stale completion while preserving the
pause itself. Duplicate normalized notes do not introduce a new content guard.

These are host lifecycle repairs. There is no new planner, classifier request,
permission question, effort reduction, goal lifetime limit or token cap.
Required milestones, immutable acceptance, operator pauses and explicit budgets
remain in force. REVIEW is the existing report handoff for independent
acceptance, not a machine-certified PASS based on model prose.

## Experiment design

[`bench-task-lifecycle.mjs`](../../scripts/bench-task-lifecycle.mjs) runs ten
scripted task lifecycles against baseline and candidate. Three fresh trials per
arm per scenario alternate execution order, for 60 trials total. The worker
performs real local file/Git actions and follows the actual production host
decision. It does not unconditionally create missing artifacts after the host
has retired a goal. A separate process independently checks persisted bytes,
JSON values, README content, remote Git contents, hook count and commit identity.

The failing artifact checks before a continuation also test the checker itself:
missing README and incorrect port must be detected. Source, fixture and checker
hashes authenticate the executed inputs. Fresh processes exercise durable state
rather than just preserving objects in memory. Unchanged control scenarios
must retain identical artifact hashes across both versions.

The three defect scenarios are deliberately selected reproductions, not a
random sample or a standard coding benchmark. Repeating deterministic trials
checks reproducibility; it does not create statistical evidence for a general
success-rate estimate. No live LLM is used, and these results do not measure
GLM, Big Pickle or Sol problem-solving speed. The earlier historical four-hour
session is not replayed here.

## Results

| Lifecycle scenario | Baseline: correct outcomes / trials | Fixed host: correct outcomes / trials |
| --- | ---: | ---: |
| New amendment, identical old report, process restart | 0 / 3 | 3 / 3 |
| Current in-progress status plus completed history | 0 / 3 | 3 / 3 |
| Explicit additive task after REVIEW | 0 / 3 | 3 / 3 |
| Verified completion without extra work | 3 / 3 | 3 / 3 |
| Required artifact deliberately missing | 3 / 3 | 3 / 3 |
| Explicit operator pause/resume | 3 / 3 | 3 / 3 |
| Continuous loop and restart | 3 / 3 | 3 / 3 |
| Finite loop reaching its checked outcome | 3 / 3 | 3 / 3 |
| Two parallel sessions and restart | 3 / 3 | 3 / 3 |
| Real local Git delivery and restart | 3 / 3 | 3 / 3 |

The baseline retired with missing required artifacts in all nine trials across
the three defect cases. The fixed host continued the requested work and the
independent artifact checks then passed. All seven control scenarios retained
their expected behavior. In the deliberately incomplete control, correct
behavior is to remain ACTIVE with an artifact FAIL; that is not a completed-task
PASS. These counts describe this selected lifecycle contract only.

Independent review also rejected an intermediate candidate that mishandled a
valid multiline objective containing a heading. That regression was corrected
before publication, with a real passing-artifact regression, then the final
experiment and affected suites were rerun against the corrected source. The
validation record keeps the rejected candidate's hash and the reason it was
not promoted; its earlier green scenario counts are not used as final evidence.

## Evidence and reproduction

The [raw trials](validation/task-lifecycle-20261117.json) retain every artifact
check, goal decision, steering, report hash, continuation counter and restart.
The [validation record](validation/task-lifecycle-validation-20261117.json)
records source hashes, regression commands, independent review and environment
skips. [Focused regressions](../../tests/correctness/goal-task-lifecycle.test.ts)
also cover malformed status authority, valid external blockers, pauses,
idempotent steering and the unchanged review/acceptance boundary.

```sh
git worktree add --detach ../future-code-task-lifecycle-baseline 12281e7a224c7a0d60e81f2858d05b8740af684d
node --experimental-strip-types scripts/bench-task-lifecycle.mjs \
  ../future-code-task-lifecycle-baseline /tmp/task-lifecycle.json 3
node --experimental-strip-types --test tests/correctness/goal-task-lifecycle.test.ts
node scripts/test-correctness.mjs
node scripts/test-commands.mjs
```

The Git experiment uses a local bare remote. It checks one real commit, one
pre-commit hook execution, exact remote file contents, a clean worktree and
restart without duplicate effects. It does not test GitHub authentication or
network failure recovery. The continuous-loop and session experiments exercise
durable lifecycle behavior; they are not weeks-long research experiments.

This round fixes the defects reproduced by these scenarios. It cannot certify
that all task-level bugs have been eliminated. The reusable runner supports
further failure-driven cases. Apply the source change by rebuilding the agent;
this PR does not deploy to existing sessions.
