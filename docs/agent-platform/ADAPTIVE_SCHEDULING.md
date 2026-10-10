# Evidence-conditioned scheduling for long R&D projects

An opt-in Foundry recipe can use `"scheduling": "adaptive-critical-path"` to prioritize
the longest **measured** downstream branch rather than always relying on a
planner's initial estimates. The default `priority` and existing
`critical-path` modes are unchanged. The interactive short-task CLI never
starts this scheduler.

The host reuses previously persisted `fabric_experience` rows only when:

- the source task **passed independent verification** and has persisted artifacts;
- the source run's immutable contract matches the current contract;
- the evidence domain and task-experience signature match;
- at least **three** successful samples exist, within 90 days; and
- the host-measured duration fits the admitted attempt budget.

At most 2,048 recent rows are read per recomputation and only the newest
nine durations per signature are included. The robust median is used for tasks
without an explicit duration estimate. Unmatched tasks fall back to a one-unit
estimate. Explicit estimates always win. Historical evidence only influences
task **priority ordering**; it never changes scope, dependencies, budgets,
authority, attempts, or independent verifier decisions.

### When it runs

Graphs of fewer than eight tasks bypass historical lookup entirely. Larger
graphs rerank at 3, 6, 12, 24, 48 ... accepted-task milestones, avoiding a
full DAG reindex on every completion. Rebuilding uses authoritative
`tasks` and `spawn_edges` plus the same immutable recipe; the
derived scheduler index is safely reconstructed after crashes.

Use the normal Foundry recipe admission workflow. Existing recipes are
content-addressed; changes require a new recipe, not mutation of an active
one.

### Limits and acceptance

These are scheduling heuristics, not proven speedups. History is only as good
as signature comparability: temporal drift, different datasets within a
single domain, worktree or hardware load, and unrecorded provider changes can
hurt estimates. Require matched baseline, verified objective completion,
wall time and cost per accepted objective before promoting this policy.

For comparable runs benchmark `priority`, `critical-path` and
`adaptive-critical-path`, with separate small-task (<8 tasks) and
long-DAG slices. Evaluate p50/p90 wall time, verified completion rate,
total model requests, and dollars per verified objective. Guardrail:
no small-task regression and no acceptance-rate drop. Revert by admitting a
recipe with `"scheduling": "critical-path"` or `"priority"`.
