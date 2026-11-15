# Direct-action R&D review and measured continuation canary

This package separates three kinds of evidence. It does not turn a passing
unit test or a model completion claim into an R&D speedup result.

**Retention limit:** a worker restart removed the temporary raw traces after
independent auditing. Contracts, manifests, per-trial audit summaries and
verification scripts survived and are retained here. Raw replay of these two
cohorts is currently unavailable; no traces have been reconstructed. See
`retention-status.json`. New experiments use workspace checkpoints.

1. Production-source regressions and the five repository gates test correctness.
2. A deterministic host-lifecycle experiment tests recovered Git delivery.
3. Fresh live decision-policy responders test controlled engineering tasks
   through the real production request projection and separate acceptance.

## Code review and fixes

The follow-up to PR #104 fixes two independently reproduced defects:

- Equivalent goal-report paths could hide observation-only activity because
  the diagnostic compared raw path strings. Match the file tools' lexical
  expansion with an explicit cwd; leave transcript and permission checks alone.
- New trusted work could be retired by a matching completion report written
  before that instruction. Ignore that preexisting completion report while
  preserving the root, budgets, operator pauses, genuine blockers and report
  bytes. A fresh report after steering still permits REVIEW.

The runtime and regression bytes were frozen before all five local gates.
All passed: correctness 369 Node plus 36 Python passes, resilience 178 Node
plus 18 Python, Foundry 879, Swarm 557 and commands 231. There are six existing
platform/tmux skips; suite counts overlap. Packaged CLI build/install was not
verified because Bun was unavailable in the environment.

## Deterministic delivery reproduction

`delivery-recovery.mjs` uses both actual production goal modules. A matching
completed report exists before a newly queued trusted push instruction. At
end-turn the requested push has not run. Only the host's CONTINUE decision
admits the same Git delivery operation in each arm. The remote is a real local
bare repository; acceptance checks its exact ref, fresh clone, artifact bytes
and Python behavior. Budgets and report bytes are checked too.

| Host version | Independently accepted remote deliveries |
| --- | ---: |
| Base | 0/3 |
| Candidate | 3/3 |

This proves recovered work in this specific host failure condition. It makes
zero live model calls and does not establish natural failure incidence, the
duration of a reported two-week stall, or general R&D speedup. Candidate Git
pushes took about 24–37 ms locally; these are not internet GitHub timings.

## Live component experiment

The standalone Codex CLI could not initialize its app-server because its
application directory was read-only. Its configured authentication was left
alone. The live canary therefore uses fresh collaboration responders with the
same inherited parent model/effort selection. Each sees an arm-blinded packet
made by the actual base/candidate `appendGoalRequestAnchor` and stable policy.
Only workspace paths are redacted by the same substitution in both arms.

The model chooses real actions; the controller does not branch its action
policy on a warning string or supply an answer patch. The controller executes
admitted reads, edits, checks and Git commands, retaining complete receipts.
Only a frozen independently authored checker can accept the result. The
checker passed 18 positive/negative controls; the actual fixture interface
passed another eight. Scorer/dataset/log bytes are protected.

| Task | Initial state | Required outcome |
| --- | --- | --- |
| Ready Git delivery | Clean start, validated committed artifact | Publish exact HEAD and verify remote artifact |
| Extend existing task pipeline | 12 actual prior read receipts | Change default task list, preserve old evaluation/scorer |
| Recover failed evaluation | Three actual identical prerequisite failures | Repair configuration, preserve outputs, install no dependency |
| Investigate run latency | Clean read-only start | Correct complete aggregate diagnosis with unchanged files |

There are four task clusters, three repetitions, two arms and 24 trials per
cohort. The same inputs and seeded histories are authenticated within every
pair. Arm start order alternates. Maximum six model decisions, four actions
per decision and 120 seconds per response remain fixed. Failed and timed-out
trials stay in denominators. The practical improvement rule is frozen before
execution; it requires no acceptance degradation and at least 20% reductions
in both seeded model decisions and paired observed component wall time.

### Original cohort — EXP-0104

The coordinator prepared one batch before immediately dispatching its
responders. Recorded coordinator observations showed roughly 90 seconds had
elapsed before several launches. Eight deadlines expired. All original raw
records are retained; no timeout difference is attributed to policy quality.

| Arm | Accepted | Timeout | Seeded decisions | Seeded tool actions |
| --- | ---: | ---: | ---: | ---: |
| Base | 7/12 | 5 | 17 | 29 |
| Candidate | 9/12 | 3 | 17 | 29 |

The frozen improvement rule is **not met**. Seeded decisions improved by 0%;
timing is additionally coordinator-confounded. Independent verification
checked all 65 delivered views, raw responses, action/receipt matching,
metrics and protected hashes, freshly reaccepted all 16 accepted artifacts,
and detected three deliberate evidence alterations. The pre-spawn delay
observations come from the coordinator; the first schema has no independently
recorded exact launch times.

### Protocol confirmation — EXP-0105

The registered confirmation uses the exact same treatment, checker, tasks,
input bytes, acceptance and practical improvement rule. A dedicated
coordinator prepares each request only immediately before launching its fresh
responder, with at most four active responders. Launch intervals from request
ready time to spawn acknowledgment are recorded separately. A spawn
acknowledgment is not proven model inference start.

Confirmation results are recorded separately in the independent confirmation
report; they never replace the unfavorable original cohort. Reusing these
four tasks does not create new independent task clusters or held-out policy
evidence. No runtime policy was tuned after observing either cohort.

| Confirmation result | Base | Candidate |
| --- | ---: | ---: |
| Independently accepted tasks | 12/12 | 12/12 |
| Fresh responder decision jobs | 41 | 35 |
| Controller tool actions | 87 | 65 |
| Seeded-case decisions | 20 | 18 |

Observed median paired wall time fell 12.15%; seeded decisions fell 10%.
Both are below the frozen 20% requirements, so the practical speedup rule is
**not met**. Overall decisions fell 14.63% and tool actions fell 25.29%; these
are descriptive component results, not authenticated provider API-call or
token counts. All 24 accepted artifacts passed fresh independent checking.

The post-hoc Git diagnostic separates a successful push returning from final
verified completion: median push-return bounds were 64.301 versus 59.123
seconds, while the Git subprocesses themselves took 23.7–119.5 ms. This does
not establish precise server-update timestamps or explain a production
hours-long wait. It is not a replacement success metric for the failed
predeclared threshold.

## Scope and reproduction

- This is a live decision-policy **component canary**, not the installed CLI,
  a public standard benchmark score, or a production scientific training run.
- Exact backend revision, provider token usage and billing are UNKNOWN. The
  model selection and reasoning configuration were inherited unchanged.
- Complete nested responder tool traces are unavailable. Responders were
  permitted only protocol/request reads and a response write; compliance at
  that provider-trace level cannot be independently certified.
- Observed component wall time includes dispatch and file-based response
  capture. Tool, checker and request-response time are retained separately.
- All task and scorer data are synthetic project fixtures. The domain-neutral
  runtime contains none of their scientific or benchmark policy.

To reproduce, check out the source version whose hashes match the contract,
choose a new disposable lab path, and keep the same provider selection and
response protocol:

```sh
export FUTURE_CODE_CANARY_LAB=/tmp/future-code-canary-new-run
python3 experiments/direct-action-rnd-20261115/harness.py setup
python3 experiments/direct-action-rnd-20261115/calibrate_fixtures.py
python3 experiments/direct-action-rnd-20261115/harness.py prepare TRIAL_ID
# Send the exact request and responder.txt to the fixed live provider.
# Preserve its raw JSON response at the requested response path.
python3 experiments/direct-action-rnd-20261115/harness.py ingest TRIAL_ID
```

Repeat through the frozen decision budget, retaining every failure. The
controller intentionally has no fabricated-provider fallback. Read
`contract.json`, `confirmation-contract.json`, both task manifests and the
independent verifier reports for the exact inputs and interpretation.
