# RSI Loop — Recursive Self-Improvement Runbook

Future-code is being used to improve future-code. This runbook makes the loop
repeatable and *measured*, so each cycle produces evidence rather than just a
commit.

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
   The diff between the two lines is this cycle's *effect*. `--dry` skips the
   suites (metadata-only) for a quick smoke check. Run it with **Node**, never
   Bun — the node-lane launchers are Node-only and `process.execPath` would
   resolve to the Bun binary.
6. **Ship** — commit on `main`, push (`git push`). Then deploy, because a
   committed fix is not a *used* fix:
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
  committed change is not a deployed change. Always end with build+install.

## Hard rules

- Never commit a change that does not pass its lane's tests. The canonical
  definition of "green" is the CI workflow for the lanes you touched.
- Never drift back to a superseded goal (the goal ledger lists them) just
  because it was larger or more famous.
- When a lane fails for an environmental reason (e.g. no network, wrong
  runtime), record the diagnosis in the runbook notes rather than silently
  skipping the lane. Do not silence a real failure with `--no-verify`.
- Every cycle should end `git add` + `git commit` + `git push` with a concise
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
