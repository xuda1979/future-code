# Runtime improvement priorities

Future-Code controls task state, provider admission, bounded context, tool
authority and independent verification. External models remain API services.
Improvements should shorten time to independently accepted work, survive faults,
and preserve that boundary.

| Proposed direction | Assessment and implementation decision |
|---|---|
| Causal context virtual memory | Exact tool receipts and progress/failure memory already preserve observations beyond active context. Automatic symbol-triggered restoration needs a reliable symbol-to-receipt index, bounded insertion and input-version checks. External APIs do not expose arbitrary KV-cache page pinning. Preserve exact receipts before adding this index. |
| Dataflow tool execution | Dependent discovery calls can cost extra model turns. `search_files.contextLines` now performs a bounded search plus surrounding-code inspection in one call, locally and on the Python worker. A general graph executor would additionally need per-node admission, budget charging, cancellation and durable replay; it should not bypass existing tool gates. |
| Copy-on-write speculation | Private Git worktrees already isolate candidate files. Filesystem snapshots alone do not snapshot open sockets, external jobs, interpreter memory or provider KV state. Backend-specific snapshots require capability checks and reconciliation. No sub-10ms whole-environment guarantee is established. |
| Symbol certificates and proof-carrying patches | A hash binds evidence to inputs; it does not prove program correctness. Dynamic imports, reflection, generated code and external state prevent assuming an exact universal dependency graph. Symbol slicing may optimize exploratory checks; independent acceptance must remain complete unless the operator supplies a sound coverage contract. |
| Bayesian falsification | Choosing a discriminating micro-probe is useful. Information gain needs explicit hypotheses, calibrated priors and outcome likelihoods; arbitrary debugging does not guarantee logarithmic convergence. Existing bounded falsification probes, negative observations and independent evaluation remain the starting point. |
| Adaptive compute allocation and liveness | Reward must come from host-observed accepted outcomes, with missing costs explicit; tool activity or model confidence is insufficient. The existing contextual intervention recommendations remain advisory. The immediate fix makes retry waits, probe scheduling and the model-idle watchdog agree, preventing a healthy recovery loop from being stopped as idle work. |

The shipped changes address observable bottlenecks: premature termination during
an outage, silent retry waits, concurrent failures inflating backoff, peers
sleeping past a failed probe, remote cancellation during known backoff, blackholed
requests exhausting a single reconnect, and an avoidable search/read round trip. They keep
the existing scheduler, receipts, budgets, file scopes and acceptance checks.

See [provider recovery](PROVIDER_RECOVERY.md) and
[source discovery](SOURCE_SEARCH.md) for behavior and configuration. Controlled
fault tests establish recovery semantics; they do not establish live-model R&D
speedups or scientific discovery performance. The larger directions need
separate measured experiments before becoming default runtime policy.
