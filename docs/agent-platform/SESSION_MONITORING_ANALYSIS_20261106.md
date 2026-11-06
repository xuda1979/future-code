# Session Monitoring Analysis — 2026-11-06

RSI loop iteration 1: monitor all future-code sessions on this machine, analyze
status/progress/history, identify bugs and improvement opportunities for
future-code as a project-neutral tool (productivity, reliability, smartness,
insights, subagent management, token efficiency, context-window management).

## Method

Enumerated every session store on the machine:
- `~/.future/projects/` (future-code sessions, 1.7GB, all projects)
- `~/.claude/projects/` (claude-code sessions, 2.9GB, 101 projects)
- `~/.claude-mcp-cron/jobs/` (cron-spawned headless sessions)
- LaunchAgents running recurring R&D loops (cfr, penrose x2, dtfn, hds3m, qpt)
- session_keeper watchdog + its auth-probe history (66,912 log lines)

## Findings

### F1 (CRITICAL): Recurring R&D loops fail 100% with "Not logged in"

The operator's LaunchAgent-driven R&D loops invoke headless `claude --print`
sessions every 10-20 minutes. Failure counts from their own logs:

| Loop | Firings | "Not logged in" | Rate |
|---|---|---|---|
| H-DS3M flashspike | 14,799 | 11,298 | 76% |
| dtfn paper | 9,518 | 5,694 | 60% |
| claude-cron (penrose) | 6,381 | 3,793 | 59% |
| penrose bhs | 5,053 | 4,988 | 99% |
| cfr rd-loop | 472 | 471 | 100% |

Root causes (three stacked):
1. LaunchAgent environment does not inherit interactive-session auth env vars;
   the loops shell out to `claude` which then requires `/login` state that
   only exists in the interactive context.
2. The session_keeper self-healing path refreshes `claude_headless.env` from a
   live process — but today the upstream token itself is exhausted:
   bigmodel.cn returns 429 `code 1310` "weekly/monthly usage limit reached,
   resets 2026-11-10 16:40:54". 4,999 auth-FAILED lines in the keeper log.
3. Loops never verify auth before firing, so a dead credential produces
   thousands of silent no-op iterations instead of surfacing the problem once.

Impact: dozens of CPU cycles/day wasted, zero research progress from the
loops, and the operator believes 5 parallel research agents are "running"
when in fact nothing has executed since Sept (cfr) / July (hds3m first
failure).

### F2 (HIGH): Proxy usage accounting is zeroed for streamed requests

`claude_huanxin_anthropic_proxy.py` converts OpenAI-style streams into
Anthropic SSE. It reads `chunk.usage` when present, but the upstream request
body never sets `stream_options: {include_usage: true}`, so most OpenAI-
compatible upstreams omit usage chunks; recorded sessions then persist
`input_tokens: 0, output_tokens: 0` (verified across all active session
files). Token-efficiency analysis (/insights, /usage, stats-cache) is
therefore blind for GLM-5.3 traffic. The fix is one field in
`build_upstream_body` when `stream: true`.

### F3 (MEDIUM): stats-cache.json stale by 6 weeks

`~/.claude/stats-cache.json` last computed 2026-09-27. Any UI reading it
reports September activity as "current". Cache invalidation depends on the
interactive UI path; headless-only days leave it stale.

### F4 (MEDIUM): Concurrency race on goal-state files is real but bounded

While monitoring, revision counter advanced 45→48 in one second (three
supersessions) as the operator typed `/goal` variants in another terminal.
`persist()` uses atomic tmp+rename, and history shows no duplicate revisions
(no lost updates), but two same-second write bursts were observed. The
"File has been modified since read" tool error I hit is the harness
correctly detecting concurrent modification — defense works, but a
read-modify-write without file locking can still drop a supersession chain
entry under heavier interleaving.

### F5 (LOW): daemon.status.json is stale (Aug 24) and workers map is empty

`supervisorPid: 4938` refers to a supervisor that is no longer running.
Session-keeper's `daemons not ready (20653)` alerts fire every cycle against
a status file that nothing refreshes.

### F6 (LOW): ~/.future/projects has 1.7GB with no retention policy

Oldest sessions date to Jul 2026; nothing prunes them. Combined with
`file-history/` and `backups/` this grows unboundedly on a 228GB disk that
is already 74% full.

## What is healthy

- Atomic-rename state persistence: no lost updates in 47 goal-history
  entries across concurrent operator testing.
- Goal/loop machinery: quantum-gpt, a6gp, world-model sessions all carry
  ACTIVE goals with working continuation/compaction anchors (observed
  86-minute session with 231 tool calls, 3 soft errors, self-recovered).
- Cross-session context: /loop and /goal history shows the operator
  successfully driving long-horizon work across compaction boundaries.
- The harness's read-modified-file detection caught my own mid-write state
  edit and forced a re-read — exactly the intended protection.

## Recommendations (priority order)

1. **Auth-gate the loops** (external to future-code, operator action):
   make each loop script probe auth (one cheap API call) before spawning a
   session; on failure, log once and back off until the token resets
   (2026-11-10) instead of firing every 10 minutes.
2. **Fix proxy usage passthrough** (F2): add `stream_options:
   {include_usage: true}` to the upstream body when streaming; keep the
   existing `writer.usage` capture path. This restores token-efficiency
   visibility for every future-code session on this machine.
3. **Add a `/sessions` health command** to future-code: cross-project
   session table (last activity, size, stuck-detection, auth-state summary)
   so the operator can see in one command what this loop had to assemble by
   hand. (Implemented this iteration — see below.)
4. **File-lock goal-state writes** (F4): wrap read-modify-write in an
   advisory lockfile to make supersession chains fully linearizable.
5. **Prune or archive `~/.future/projects` entries older than N days**
   behind a setting (default off) to bound disk growth.

## Actions taken this iteration

- Implemented `/sessions` command (see `src/commands/sessions/`): scans
  `~/.future/projects`, reports per-project session health: latest activity
  age, session count, total size, active goal + state, and flags sessions
  that appear stuck (no transcript growth) — the exact view the operator
  needs to monitor the RSI fleet.
- Full test suite run: commands lane 119/119 pass; new sessions tests pass.
