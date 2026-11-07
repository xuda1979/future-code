# RSI Loop — Recursive Self-Improvement Runbook

Future-code is being used to improve future-code. This runbook makes the loop
repeatable and *measured*, so each cycle produces evidence rather than just a
commit.

## Durable automatic recipe evolution

The Foundry runtime now closes the **bounded execution-policy** loop in code:
observe recorded work → propose a candidate → run a frozen paired evaluation →
authenticate the evidence → optionally promote → consider the next hypothesis.
This works with any project adapter implementing the worker/verifier contract.

```sh
node --experimental-strip-types src/harness/foundry/cli.ts evolve \
  --protocol examples/foundry/protocol.json --allow-exec --auto-promote --max-cycles 3
```

`--max-cycles` defaults to 1 and accepts 1..100. The existing contract ceilings,
task graph, checks, objective and gain threshold stay fixed. Each cycle resumes
an unfinished matching evaluation before creating new work. A ready admission
is reused without another experiment. `--auto-promote` authorizes activation of
an admitted recipe; it does not authorize deployment or acceptance changes.

Each new evaluation persists all baseline/candidate run IDs **before execution**.
After a crash or cancellation, rerun the same `evolve` command, or resume its
specific receipt:

```sh
node --experimental-strip-types src/harness/foundry/cli.ts evaluation-resume \
  --evaluation EVALUATION_ID --allow-exec
```

Completed arms retain their run IDs, artifacts and attempt accounting. In-flight
tasks use the existing scheduler's lease fencing, reconciliation and retry rules.
Unmetered work lost to a hard crash remains unknown; recovery does not invent a
zero cost. A paused arm is never recorded as a complete pair. Resume rejects
changed protocol, contract, recipe lineage, root tasks or accepted evidence.
Concurrent resume helpers share runs; a stale receipt writer must reload after
a compare-and-swap conflict. Direct resume rejects legacy incomplete receipts
without recoverable arm bindings. Automatic evolution lists these in
`skippedEvaluations`, preserves the old evidence and can start a new evaluation.
Complete legacy receipts keep their existing validation path.

Completed trials are remembered for the exact baseline and protocol. A rejected
or unmeasurable configuration is skipped during the next automatic suggestion,
allowing another supported hypothesis to run. Explicit `evaluate` remains the
way to request another trial deliberately. A different frozen protocol has its
own trial history. `suggest --protocol FILE` exposes this same selection policy.

Dynamic child tasks may differ between arms. Admission compares the exact frozen
**root** task graph, verifies every accepted child and requires every task in a
successful run to be complete. Children contribute measured work and cost without
creating additional root-objective progress.

The command returns `evaluations`, `skippedEvaluations`, `active` and `stopReason`. Stop reasons are
`no-evidence-backed-change`, `cycle-limit`, `paused`, `unknown-evidence`, and
`awaiting-promotion`. Exit 130 means interrupted; exit 2 means unknown evidence
or a bounded call with trials but no admission; exit 0 may mean an admission or
exhausted hypotheses. Rejected hypotheses remain in the JSON even if a later
alternative succeeds. A supervisor should inspect `stopReason`, resume paused
work and wait for new workload evidence after exhaustion rather than busy-loop.

This is measured recipe optimization, not proof of open-ended recursive
intelligence improvement. General code mutation, hidden cross-project holdouts,
live-LLM productivity gains and automatic deployment are separate capabilities.
See [the RSI review](RSI_REVIEW_20261107.md) for scope and remaining gaps.

## The loop

```
  monitor ──► analyze ──► change ──► test ──► measure ──► ship ──► (repeat)
    ▲                                                                 │
    └─────────────────────────────────────────────────────────────────┘
```

One cycle, concretely:

1. **Monitor** — some future-code sessions are running and doing work. Pick a
   session (or the whole machine fleet) and ask: what is it doing, what is
   stuck, what regressed?
   - `future-code ... /sessions` — per-project session health table from inside
     the tool.
   - Read `.future-code/goal.md`, `.future-code/goal-autonomy.json`,
     `.future-code/goal-history.jsonl` in a working dir to see the active
     objective and its continuity.
2. **Analyze** — find the highest-leverage problem. Prefer problems that are
   *measurable before and after*: a failing test, a stalled loop, bytes
   written, tokens spend. Write the finding into
   `docs/agent-platform/` so the reasoning survives compaction.
3. **Change** — implement it in this source tree. Keep changes small and
   reviewable; the codebase already has strong invariants (see
   `docs/agent-platform/CORRECTNESS_GUARDRAILS.md`).
4. **Test** — the project has **no single runner**; it has lanes, each with its
   own launcher. Do NOT run a bare `bun test tests/` sweep — it runs foundry
   tests under Bun where the harness expects Node ≥22.13, producing hundreds of
   spurious failures. Run the lanes that your change can affect:
   - `scripts/test-commands.mjs`        (slash commands, Node)
   - `scripts/test-foundry.mjs`         (core foundry, Node)
   - `scripts/test-correctness.mjs`     (correctness gates, Node + python)
   - `scripts/test-resilience.mjs`      (resilience, Node)
   - `scripts/test-surfaces.mjs`        (UI surfaces)
   - Bun lane: `bun test tests/hact tests/api tests/harness --preload ./tests/api/retry-isolation.ts`
   - CI runs these plus `scripts/test-swarm.mjs` / `test-retirement.mjs`.
5. **Measure** — snapshot the ledger before and after the change:
   - `node --experimental-strip-types scripts/rsi-cycle-snapshot.ts before`
   - (implement the change, test it)
   - `node --experimental-strip-types scripts/rsi-cycle-snapshot.ts after`
   Each appends one JSON line to `.future/rsi-cycle.jsonl` with per-lane suite
   times (pass/fail + msec), git head, and the size of `~/.future/projects`.
   These rows are telemetry, not an improvement admission: suite timing and
   store size alone cannot establish causality or a productivity gain. Failed
   lanes record exit/signal/error details and make the script exit 1 after
   appending the row. Session-store symlinks are excluded from byte counts.
   `--dry` skips the
   suites (metadata-only) for a quick smoke check. Run it with **Node**, never
   Bun — the node-lane launchers are Node-only and `process.execPath` would
   resolve to the Bun binary.
6. **Ship** — commit to a task branch, push, and open a reviewable PR with the
   relevant checks and evidence. Merge and deployment follow the task's granted
   authority. For an authorized deployment:
   - `./build.sh` — rebuild `./future-code`
   - `./install.sh` — full install (prompts for credential URLs; safe to re-run,
     idempotent). Rebuild and re-run the session that had the problem, then
     confirm the symptom is gone.

## Decisions made on 2026-11-06

- **Rejected: a unified `make test`.** The repo already has 8 launchers and 5
  CI workflows that gate every lane; the only gap was a local *sweep* spelled
  wrong (`bun test tests/` against Node-only tests). Adding a meta-runner
  would duplicate CI and add maintenance cost.
- **Adopted: a measured ledger.** `.future/rsi-cycle.jsonl` (see
  `scripts/rsi-cycle-snapshot.ts`). The loop currently measures suite times and
  session-store bytes; extend it as new signals prove useful (e.g. token spend,
  /sessions health at snapshot time).
- **Recorded: 2026-11-04 fix for a stale GitHub Action (`actions/setup-node@v3 → v4`).**
  Kept in CI history; not re-applied.
- **Known friction (external to this repo):** LaunchAgent R&D loops fail with
  "Not logged in" because headless auth is broken upstream (429 until
  ~2026-11-10). See `SESSION_MONITORING_ANALYSIS_20261106.md` F1. Not a
  future-code bug; track until the upstream token resets.
- **Known deploy drift:** the machine's `~/.local/bin/future-code-bin` was
  holding stale processes (fixed binaries are stale-to-nonexistent); a
  committed change is not a deployed change. Verify the installed revision when
  deployment is in scope.

## Hard rules

- Never commit a change that does not pass its lane's tests. The canonical
  definition of "green" is the CI workflow for the lanes you touched.
- Never drift back to a superseded goal (the goal ledger lists them) just
  because it was larger or more famous.
- When a lane fails for an environmental reason (e.g. no network, wrong
  runtime), record the diagnosis in the runbook notes rather than silently
  skipping the lane. Do not silence a real failure with `--no-verify`.
- A code-changing cycle should end with a task-branch commit and PR with a concise
  subject that names the *effect* (e.g. "Fix heartbeat timeout in canonical
  lane") rather than the mechanism.

## Fresh-start recipe

For a new RSI worker in a fresh checkout of this repo:

```
git clone <this repo> future-code && cd future-code
bun install
./build.sh                                   # produces ./future-code
node --experimental-strip-types scripts/rsi-cycle-snapshot.ts before   # baseline ledger entry
# ... run the loop steps above ...
node --experimental-strip-types scripts/rsi-cycle-snapshot.ts after    # effect measured
./install.sh                                 # deploy (prompts for endpoint)
```

The repo is self-contained: launchers, workflows, and this runbook all live in
`scripts/`, `.github/workflows/`, `docs/agent-platform/`.
