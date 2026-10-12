# Falsification before expanding a debugging trajectory

The existing unchanged-input pruning rule cannot detect a worker that repeatedly
edits source and then receives the same failure. The optional `debugging` policy
adds a host-observed failure window across edits, a fresh-context audit, a premise
probe gate, and a durable wall-clock limit. These govern Foundry/Swarm workers;
they do not replace the older terminal CLI's `/goal` loop.

## Enable for a project

Add this policy to a Swarm specification before initialization:

```json
{
  "debugging": {
    "maxFailedCycles": 4,
    "maxInversionResets": 1,
    "requireProbeBeforeMultiFile": true,
    "branchTimeoutMs": 300000
  }
}
```

The policy is opt-in because a universal two-second experiment or five-minute
research task would be inappropriate for many projects. Existing specifications
continue to work. Healthy single-file tasks incur no extra model request or
automatic probe. `auditorAgent` may name a configured provider profile; otherwise
the worker's profile is used with an independent context and host-owned auditor
instructions. No new model, provider URL, or credential is required.

Give writing profiles the `run_probe` tool and a separate `probes` list. Probe
names refer to operator-pinned commands in `checks`, but they are **not** added to
the profile's acceptance checks or final integration checks:

```json
{
  "agents": {
    "coder": {
      "tools": ["read_file", "write_file", "run_check", "run_probe", "recall"],
      "checks": ["behavior"],
      "probes": ["dependency_capability"]
    }
  },
  "checks": {
    "dependency_capability": {
      "argv": ["$NODE", "./checks/dependency-capability.mjs"],
      "files": ["./checks/dependency-capability.mjs"],
      "replaySafe": true,
      "probeTimeoutMs": 2000
    }
  }
}
```

These are configuration fragments; retain the required provider, task, budget,
and verification fields from the project's complete specification. The operator
must implement a relevant standalone reproduction and negative control, then pin
that command. For example, test the deployment's specific dependency operation
directly and test that an invalid input is rejected. A generic passing smoke test
does not establish an unrelated capability. Pinning protects the probe from edits
that merely make its predicate pass. Model-supplied descriptions cannot establish
that a control actually ran.

The process deadline is at most 2,000ms, including runtime startup. Worktree
preparation, RPC transport, and snapshot bookkeeping have their existing budgets;
this does not promise a two-second total tool round trip. Heavy capability probes
should be reduced to the smallest useful discriminator. Long scientific
experiments remain named durable `run_job` capabilities.

## Execution rules

| Trigger | Host behavior |
|---|---|
| First file edit | Allowed, so a narrow implementation or reproduction can proceed. |
| Expansion to a second distinct file | Requires a completed zero-exit premise probe when the policy is enabled. Admission happens before each effect, including write-batch members. |
| `run_probe(name, hypothesis, falsifyWhen, negativeControl)` | Runs only a permitted pinned command. Arbitrary shell arguments are rejected. The premise and control descriptions remain unverified hypotheses. |
| Nonzero probe exit | Ends the current trajectory and suppresses remaining proposed effects. It establishes that the probe failed, not that the feature is impossible. |
| Timeout, unknown outcome, or source-mutating probe | Ends the trajectory as inconclusive. No support observation is manufactured. |
| Named check fails across 3–8 distinct model turns | Triggers an inversion at a complete tool boundary, even when source changed. Multiple failures in one turn count once. |
| Identical outputs or A/B/A/B outputs | Labeled repeated or oscillating; other consecutive failures are labeled nonconvergent. These are observed patterns, not model confidence or entropy measurements. |
| Same check succeeds | Clears that check's window. An unrelated passing check cannot hide the failing window. |
| New feedback, child result, or remote-job evidence | Invalidates the prior evidence epoch and any probe support. Source edits alone do not erase the failure window. |
| Inversion reset | One independently budgeted provider request sees the raw first symptom, goal, acceptance, base-commit reference, protected paths, and permitted probe names. It sees no patch text, working notes, or failed-attempt transcript, and has no execution tools. |
| After the audit | Working context retains the immutable task, host state ledger and explicitly unverified auditor hypotheses. Previous theories and `save_progress` notes leave the hot context; the append-only journal remains intact. |
| Work after a reset | Requires a premise probe before edits, full checks, jobs or delegation. Automatic exploratory checkpoints wait for that probe; independent acceptance is unchanged. |
| Exhausted reset budget or branch deadline | Ends the diagnostic trajectory. The objective supervisor may propose a materially different plan under existing authority, verification, reconciliation and cumulative budgets. |

A successful probe opens a bounded implementation trajectory for the current
diagnostic/evidence epoch. Subsequent source edits do not turn it into proof about
the edited source. The next failing check invalidates that support. The ledger
exposes source currentness and retains exact result/fixture receipt references.

The diagnostic deadline starts at the first failing check, completed probe, or
admitted multi-file expansion. It survives retries and process restarts and is
never replenished by a reset or a passing unrelated check. It aborts active local
process groups and provider requests. It does **not** cancel or resubmit detached
remote research jobs; their existing reconciliation contract remains authoritative.

## Operator triage and context hygiene

`/swarm status` and attached health output show concise `TRIAGE` cards with the
check, cycle count, observed pattern and one capability question. The card is an
opportunity for disambiguation, not an invented promise that a human can fix the
problem in ten seconds. The worker first uses available probes. When the premise
cannot be established safely, existing objective attention handling stays visible
instead of silently ending or spending an unlimited retry budget.

The compact system-state ledger records **what the host observed**: exit code or
unknown outcome, receipt, source binding and turn. It does not certify the agent's
explanation. Probe descriptions and auditor explanations have explicit unverified
trust labels. Existing progress notes, cohort summaries and versioned claims
retain their own unverified labels. The ledger outranks freeform working notes;
only independent task and integration evidence can authorize acceptance.

Audits share the worker's thread-turn limit, run/objective request and byte budgets,
provider concurrency, cooldowns and exact request-body replay. A crash after an
audit response but before its checkpoint reuses the saved response. It does not
buy another model request or erase the branch deadline. Remote workers receive a
separate permitted-probe map and enforce the same process deadlines.

## Orthogonal exploration and verification

The auditor proposes three distinct architectural, environmental and dependency
causes with falsifiers and negative controls. Where the task contract permits it,
the existing dynamic DAG can schedule independent read-only diagnostic children;
their existing leases, private workspaces, depth/count limits and verification
remain authoritative. This policy does not introduce overlapping speculative
writes, automatic winner selection or unsafe patch merging. Each enabled
diagnostic trajectory has the same maximum five-minute budget.

Existing `diagnosticPaths` and on-change checkpoint selection already suppress
irrelevant **automatic exploratory** checks. Use those declarations for discovery,
the new micro-probes for premises, and complete frozen task/integration checks for
final validation. No full-suite acceptance check is removed or sliced by this policy.

## Regression evidence

`tests/foundry/debugging-guardrails.test.ts` exercises cross-patch oscillation,
short-task request parity, pre-effect multi-file gating, failed/inconclusive probes,
fresh audit isolation, replay after a lost audit checkpoint, triage visibility,
reset exhaustion, branch deadlines and remote probe deadlines. The scripted
single-file comparison uses two requests with and without the policy. This
measures host behavior; it is not a live-model productivity benchmark.

```sh
node --experimental-strip-types --test tests/foundry/debugging-guardrails.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

Use the [real-project protocol](REAL_PROJECT_EVALUATION.md) for matched live runs
and report verified time-to-goal and cost, including failed or inconclusive probes.
