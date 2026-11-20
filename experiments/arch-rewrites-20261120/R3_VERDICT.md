# R3: Falsification ledger for goal resume — verdict: KERNEL PROVEN, production wiring deferred

Question (rnd_plan.md issue 3): after an interrupt/resume, does a persisted
ledger of falsified (failed) attempt fingerprints stop the agent from
re-entering the same dead end, without breaking legitimate retries?

## A/B (deterministic, `r3-falsification-ledger.mjs`, results in `r3-results.json`)

Scenario: resumed goal; scripted agent repeats the SAME failing Bash command
for 7 turns, then diverges to a working command at turn 8. Treatment resumes
with the prior session's failure already recorded (crash + resume path).

| Metric | Baseline | Treatment (ledger) |
| --- | --- | --- |
| Command executions | 8 | 2 |
| Host interceptions of identical failing emission | 0 | 7 |
| Both arms converge to final success | yes | yes |

**Measured win: 8 → 2 executions (75% fewer wasted executions of an
identical falsified action), with identical convergence.** The interception
returns the recorded failure evidence plus a forced-divergence instruction,
so the model's context gains information instead of losing an execution.

## Why this is the right semantic, not just any dedupe

- **Scope**: ledger is keyed by (goal, revision); a steering revision or a
  new goal voids it (mirrors `GoalFailureEvidence.version()`).
- **Only failed attempts enter** — successes must be repeatable.
- **Legitimate retries must not be blocked**: rerunning `npm test` after an
  edit is correct workflow, not a dead loop. The production gate must
  intercept only when the emission is identical AND no intermediate mutating
  tool ran (no Edit/Write/apply since the recorded failure) AND the failure
  signature matches. This converts the existing SOFT rule
  ("Diagnose repeated failed actions without new evidence", auto.ts:51;
  unchanged-checkpoint stagnation reminder, auto.ts:1214) into a HARD,
  evidence-carrying host rule.
- **Bounded**: ≤16 fingerprints per goal, ≤200-byte failure digests.

## Production wiring deferred — why

Wiring the interception into `src/query.ts` + Bash result handling touches
the tool-execution hot path, where a wrong interception blocks legitimate
work (regression risk on AGENTS.md rule 4: bounded retries with new
evidence). The kernel and its A/B above prove the value; the wiring needs
its own change + regression suite (mutating-tool tracking between emission
and intercept) before it can ship under the experiment-gated rule. The
ledger module stays in this experiment directory as the reference
implementation for that change.

## Reuse note

`work-state.json` already accepts `attempts: [{action,result,next}]` (max 4,
model-maintained, advisory). The host-managed ledger is deliberately a
separate durable file (`.future-code/`-scoped) because host-enforced
interception cannot trust model-maintained state to contain the failures it
must enforce.
