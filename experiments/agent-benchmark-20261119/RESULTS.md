# Agent Benchmark Results — 2026-11-19/20

Branch: `experimental` · Source commit at run time: `1e70d5b`. The recorded
JSONs reference a `sourceCommit`/candidate SHA of `a2937d0…`, which is not
resolvable in this repository's object store (it was a working-tree state
during the run); regenerations must record `git rev-parse HEAD` instead.

## What ran: offline CLI-replay layer

`scripts/bench-agent-cli-replay.py` (5 repetitions, rotated order, identical
prompts, scripted provider, fresh worktree + state dir per trial). Full
records: `cli-replay/evidence.json`, `cli-replay/trials/{trials,report}.json`.

| Agent | Version | Verified | Median trial (ms) | Verified tasks/hour |
| --- | --- | --- | --- | --- |
| first-compatible | Future Code v1.0 | 5/5 | 1312.6 | 2635.1 |
| baseline | Future Code v1.0 | 5/5 | 1222.5 | 2717.0 |
| candidate | Future Code v1.0 | 5/5 | 1252.2 | 2589.6 |
| claude-code | 2.1.328 | 5/5 | 907.5 | 3682.6 |
| opencode | 1.19.6 | 5/5 | 4574.9 | 752.8 |

All 25 trials PASS; prompts are byte-identical across arms (single md5).
The three future-code arms differ only by source commit (first-commit vs
main vs current); the win claim of the 2026-11-18 startup fix (0/5 → 5/5)
is NOT reproduced here — in this run all three arms pass 5/5 (the
option-registration failure from 2026-11-18 does not occur at these
commits), so the remaining difference is median agent-loop overhead, where
current future-code sits between claude-code and opencode on this fixture.

## What did not run (documented per DESIGN.md acceptance)

- **Live-model layer** (`gateway/bench_gateway.py`): harness complete and
  scanned (no secrets; upstream from `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`
  env), but no live runs recorded — `gateway/results/` is empty. Do not cite
  live numbers from this experiment.
- **Codex CLI**: no `codex` binary installed on this host.
- **Claude Code binary**: not on PATH for the live layer (only the npm
  package used by the offline replay on 2026-11-18).
- **WorkBuddy (Tencent)**: not available; unmeasured.
- **SWE-bench Verified / Terminal-Bench / Aider polyglot**: not attempted —
  require per-instance Docker images and provider keys not present here.

## Reproduction (offline layer)

~~~sh
python3 scripts/bench-agent-cli-replay.py --out /tmp/cli-replay \
  --repetitions 5 \
  --agent first-compatible=<path-to-first-commit-bin> \
  --agent baseline=<path-to-main-bin> \
  --agent candidate=<path-to-current-bin> \
  --agent claude-code=<path-to-claude> \
  --agent opencode=<path-to-opencode>
~~~

Raw per-trial logs, CLI state dirs, and the embedded fixture repo are
regenerated outputs (gitignored); the aggregated JSONs above are the record.
