# Release contract

Scope: deliver a runnable control-plane companion for Future Code. The supplied ZIP
is truncated; the original TypeScript application cannot be rebuilt from it.
No missing original modules or original end-to-end behavior will be represented as tested.

Acceptance criteria:
1. Persist validated task DAGs, attempts, messages, incidents and quality evidence in SQLite.
2. Dispatch independent tasks concurrently; fence stale workers and serialize overlapping write scopes.
3. Accept bounded dynamic delegation and dependency result handoff without losing parent acceptance gates.
4. Use bounded context, tool rounds, per-task deadlines, request/token budgets and cooperative cancellation.
5. Recover transient endpoint failures with pooled HTTP, backoff and circuit breaking; keep daemon alive and idle.
6. Require explicit shutdown, approval and safety boundaries. No infinite failed operations or unlimited spend.
7. Stage edits, reject traversal/symlinks/secret paths, run trusted gates and reject stale evidence before integration.
8. Correct tool/gate failures using feedback; block repeated failures with an incident instead of declaring success.
9. Produce fixed-schema status tables with deterministic ordering and explicit UNKNOWN/staleness.
10. Clean only runtime-owned disposable workspaces; retain failure evidence and never auto-delete user source.
11. Test local network outage/recovery, process cancellation, crash/restart, concurrent scheduling and tamper cases.
12. Package exactly tested source; verify file hashes after extraction; include executed test evidence and limitations.

Risk: R2 for runtime; R3 surfaces are command execution, path handling, commit journal,
secrets, budgets and state fencing. Tests must cover these surfaces explicitly.

Authority: local source edits and local CPU tests only. No production deployment,
private endpoint calls, paid LLM calls, credential use, external account writes or destructive source cleanup.

Definition of PASS: configured checks actually executed successfully on the recorded artifact.
It never means all bugs are absent, model claims are universally true, or production is validated.

Baseline for 1.2: the runnable 1.1.0 companion passed 194 tests locally.
The original truncated TypeScript application still has no runnable baseline.
Additional 1.2 acceptance: bounded recursive ownership, 512-leaf runtime fixture,
measured byte admission, scoped/paged evidence, durable mailbox delivery and final-archive retesting.
Target: Python >=3.11, Linux primary; Windows runtime tests only when an actual Windows runner is available.
