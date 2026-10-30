# Bounded research deliberation and adversarial verifier audits

Future-Code can allocate research effort, remember checked dead ends and test
whether an acceptance command rejects known broken candidates. These mechanisms
are optional, project-neutral host primitives. Project hypotheses, experiments,
mutants and domain semantics remain operator-owned configuration or adapters.

## Three research allocation gears

Add `deliberation` to an existing `researchStrategy` with a bounded `frontier`:

```json
{
  "deliberation": {
    "familiarObservations": 2,
    "stagnationWindow": 2,
    "maxUninformative": 5,
    "maxResearchMs": 600000,
    "highImpact": false,
    "reuseProgrammeFindings": true
  }
}
```

This is a configuration fragment; retain the frozen candidates, experiments,
frontier, delegation limits and independent workflow policy described in
[research frontiers](research-frontier.md). Automatic programme lookup also
requires an explicit `researchProgramme` namespace. Existing configurations
without `deliberation` keep their original behavior and request count.

| Gear | Host-observed condition | Allocation |
|---|---|---|
| 1 | Enough distinct informative protocols and at most one eligible line | At most one research assignment |
| 2 | Other cases with limited unfamiliarity or branching | At most two assignments; adviser is instructed to prefer discriminating probes |
| 3 | Operator-declared high impact, a stagnating receipt window, or no informative protocol across at least three eligible lines | Up to the existing frontier ceiling; adviser is instructed to consider distinct approaches and independent falsification |

High impact and stagnation take precedence over familiarity. The configured
frontier, task DAG, cohort/resource caps, reservation counts and experiment
budgets always bound the effective width. This policy never adds a model,
changes inference-engine settings, invents a probe, or executes an unconfigured
tool. It runs before automatic research-child admission through both worker
delegation and the independent workflow adviser. Explicit operator-supplied
initial research tasks retain their original authority.

These gears are allocation heuristics, not MCTS, semantic memory distance,
hypothesis entropy, or a probability that a plan is correct. The current host
does not measure those quantities. Gear 3 changes available width and adviser
guidance; it does not automatically instantiate a proposer/falsifier tournament.

### Stop spending without manufacturing completion

Only independently accepted results contribute informative protocol/outcome
pairs. Replaying receipts or changing a raw-result hash without changing the
checked protocol/outcome cannot manufacture novelty. Conflicted and inconclusive
results add no informative credit. Completed jobs whose task did not pass
verification still consume measured time and count as uninformative.

The host first escalates after `stagnationWindow` trailing uninformative jobs.
It stops admitting new automatic research children after `maxUninformative`, or
when the sum of recorded completed-job durations reaches `maxResearchMs`.
Choose `maxUninformative > stagnationWindow` so escalation has an opportunity
before the stopping threshold.

`measuredMs` sums job durations, including overlapping jobs; it is not wall time,
model inference time or money. Unavailable durations remain explicitly unknown.
Live jobs are not preempted, and this is not a hard cap on already reserved work.
Existing per-job, task, objective and request budgets remain authoritative. A
stopping reason leaves research questions and failed obligations open. It never
certifies a plan, finishes an objective, or relaxes a verifier.

### Compact research dossier

The strategy snapshot exposes the effective gear and a dossier of at most eight
checked records with candidate, exact protocol/result hashes, assessment artifact
receipt and job/programme source key,
outcome and conflict flag. Refutations and contradictions receive display
priority. Counts, an omission count and an evidence-set hash make truncation
explicit. Source artifacts remain durable; the adviser need not copy exploration
transcripts into its active context. Missing or omitted evidence stays unknown.

## Checked negative knowledge across research runs

With `reuseProgrammeFindings`, the frontier retrieves current findings from the
same explicitly configured programme. Lookup uses an indexed **exact protocol
hash**, including the hypothesis, assumptions, input and code/data/environment
identities. It rechecks content hashes, live source-task acceptance, the
independent verifier's authorization of the assessment and the active dependency
closure. It does not use semantic similarity to suppress work.

A checked refutation can prune a previously explored line in a later run without
requiring a worker to rediscover or manually import the failure. Changed
constraints produce a different protocol hash and remain eligible. A different
programme or disabled lookup shares no automatic observations. Conflicts,
corruption and incomplete bounded retrieval suppress automatic expansion with
an explicit unavailable reason. Retracted or stale findings cannot suppress
new evidence collection as if they were still valid observations.

Lookup reads at most four active/conflicted heads per protocol and shares the
existing 32-finding observation ceiling. Additional matches make the snapshot
unavailable rather than silently hiding possible counterevidence. Lookup never
adds knowledge authority to a child task: scientific reuse that requires exact
knowledge imports still needs the existing authorized parent/dependency links.
No acceptance check is skipped because a planning dossier contains a finding.

New publications maintain the derived protocol index atomically with acceptance.
For older stores, or to repair lost index entries, page through:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts knowledge-index-rebuild \
  --root /absolute/path/to/state --after 0 --limit 100 --allow-exec
```

Repeat using `nextAfter` until `complete` is true. Source findings remain
authoritative; this command rebuilds only the projection. A missing projection
entry does not prove absence of earlier work, so migrate before enabling lookup
on an older populated store. Reads authenticate returned entries even after an
index rebuild.

## Verifier audits against broken candidates

Add pinned negative controls to a standalone check:

```json
{
  "behavior": {
    "argv": ["$NODE", "-e", "if(require('node:fs').readFileSync('src/value.txt','utf8').trim()!=='42')process.exit(7)"],
    "replaySafe": true,
    "parallelSafe": true,
    "negativeControls": [
      {
        "id": "wrong-value",
        "expectedExitCode": 7,
        "edits": [{"path": "src/value.txt", "content": "-1\n"}]
      }
    ]
  }
}
```

At independent task verification, and again at final integration, the host:

1. Reconstructs the real candidate and requires the normal command to pass.
2. Creates a new detached worktree from that exact candidate for each control.
3. Applies only operator-pinned replacements to existing tracked regular files.
4. Requires the same pinned command to produce the exact configured nonzero
   exit status and leave the mutated tree unchanged.
5. Persists the candidate and control reports in the verification evidence and
   disposes the private worktrees before returning.

An always-passing checker fails the audit. A no-op mutation, wrong exit code,
timeout, cancellation, missing file, symlink traversal, command error or verifier
that repairs its own control cannot count as successful rejection. Protected
paths include implementations discovered during command pinning, so a control
cannot mutate its own verifier. Controls are checked only after a real candidate
passes; a failing candidate retains its ordinary failure without extra work.

Bounds: four controls per check, eight edits per control, 64 KiB of replacement
text per check, existing process deadlines/output budgets, and the admitted
verification concurrency. `parallelSafe` is required because controls must be
standalone and cannot rely on a prior check's ignored build outputs or shared
external state. Configuration, mutants and expected exit codes are frozen into
the verifier identity. Ad-hoc worker `run_check` remains exploratory and does not
issue an audit certificate or acceptance.

Operators must choose discriminating broken cases. Passing these controls
establishes sensitivity to those named defects, not universal checker correctness
or immunity to reward hacking. The host does not invent domain mutations, weaken
protected checks, or promote a model-authored test on its own.

## Relationship to the broader architecture suggestions

| Suggested layer | Current scope |
|---|---|
| Dynamic research compute, probe-before-plan and falsification | Bounded gears and dossiers build on existing pinned probes, research frontier and independent workflow review. Full tree search and adversarial plan tournaments remain future work. |
| Graveyard memory | Automatic exact-protocol checked findings across runs, with refutations and conflicts retained. Broader semantic matching remains advisory future work. |
| Speculative sandboxes | Existing task worktrees and independent patch verification already isolate candidates. This change also isolates verifier mutants. Automatic competing workspace promotion is not added. |
| Mutation-tested verifiers | Implemented with pinned negative controls and independently rerun integration audits. Automatic AST mutation is adapter work. |
| Stateful web foraging | A browser adapter/daemon, AX/visual grounding, tab graph, authenticated handoff and mutation-aware action batching still need implementation and browser integration tests. No browser capability is claimed here. |
| Tool crystallization | Existing prepared commands remain operator-pinned. Automatic helper extraction/promotion needs its own provenance and admission design. |
| Interrupt streams | Existing operations/event and early-feedback paths remain available. A new stdout/telemetry pathology watcher is not included. |
| Kernel/user-space separation | New runtime code contains no domain policy. Moving legacy adapters, workflows or papers out of this repository needs a separate compatibility migration. |

## Validation boundary

Regression tests exercise the real host paths with local processes, Git worktrees,
SQLite persistence and offline scientific fixtures. They cover cross-run
refutations, changed protocols/namespaces, retraction, index rebuild, source
acceptance loss, cost/novelty limits, weak verifiers and independent integration
audits. These tests do not establish a live-model research-productivity gain.
