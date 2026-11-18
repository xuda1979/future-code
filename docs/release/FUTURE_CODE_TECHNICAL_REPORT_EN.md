# Future-Code Technical Report

**Version 2.2 · November 18, 2026**

## Executive summary

Future-Code is a runtime for sustained software development and research using external LLM APIs. Its defining architectural decision is to separate **cognition** from **authority**. Models propose plans, code, tool calls, hypotheses, decompositions, and recovery ideas. A host-owned runtime decides what may execute, what state is durable, what evidence is sufficient, and when work is accepted.

This addresses the failure modes that dominate long-horizon R&D: stalled model loops, repeated failed hypotheses, duplicated remote jobs, provider outages, conflicting subagent edits, context growth, and premature success declarations. Future-Code therefore treats the model as an intelligent but replaceable component inside a governed execution protocol.

> **Models propose. Evidence decides. Future-Code enforces.**

The release comparison exposed a startup crash in the current build. After the
fix, Future-Code completed five of five independently verified CLI replays.
OpenCode and Claude Code also completed five of five. Median verified wall time
was 1.58 seconds for Future-Code, 5.60 seconds for OpenCode, and 1.07 seconds
for Claude Code. The current remote-job controller also recovered the original
job after a simulated 42-hour outage. In the new 42-trial Swarm study,
one eight-symbol scan reduced source bytes read by 87.5%. Its median time to
verified integration fell from 809.0 to 632.5 ms. Section 9 gives the scope
and the known-file control.

## 1. Core architecture

Future-Code is organized around three planes.

### Cognitive plane

External models perform open-ended reasoning, code generation, decomposition, tool planning, hypothesis formation, and recovery analysis. Different roles may use different configured models. The system does not require a single monolithic manager model.

### Sovereign control plane

The host kernel owns the state that must remain deterministic even when the model is stochastic:

- durable objectives and frozen acceptance contracts;
- task DAGs and bounded dynamic spawn edges;
- read/write scopes;
- leases and fencing generations;
- execution/model/remote-compute budgets;
- provider cooldown state;
- remote-job identity and reconciliation;
- independent verifier identity;
- final integration policy.

Model output is a `Proposal<T>`, not authority. A model's final answer cannot directly mark a task PASS, expand scope, replace a verifier, erase failure history, or redefine a frozen objective.

### Evidence plane

Evidence Fabric stores durable goals, machine observations, immutable artifacts, verifier results, claims, conflicts, adjudication records, execution episodes, and replay receipts. Workers are replaceable; goals and evidence persist.

## 2. Fast tasks and long projects need different policies

Using one runtime policy for every task is a major source of wasted time.

For a simple interactive task, latency is often dominated by unnecessary maximum reasoning, repeated API retries, proxy pacing, process startup, and heavy verification setup. The interactive path should therefore use balanced effort, bounded foreground retry, narrow context, and explicit escalation.

For multi-hour or multi-day objectives, the dominant risks are different: lost state, duplicate external work, stale leases, provider outages, integration conflicts, context explosion, and premature acceptance. Foundry/Swarm therefore uses durable state, independent verification, remote-job reconciliation, bounded recovery, and explicit final integration.

The architectural rule is:

> **Latency policy should depend on task horizon; correctness policy should not.**

The current launcher follows this direction by no longer forcing maximum effort for every request, respecting configured helper/subagent models, bounding interactive persistent retry by default, avoiding legacy request-spacing penalties on routes that do not require them, and preventing a failed stream from falling into a second complete buffered retry loop.

## 3. Sovereign Kernel

A run starts from an explicit contract covering objective, task graph, acceptance gates, budgets, scopes, protected paths, worker/checker identities, and integration policy. A model may propose actions inside that contract but cannot rewrite success when work becomes difficult.

Tasks are durable nodes. Ready tasks are leased. Lease fencing prevents a stale worker from publishing after ownership moves. Existing task specifications remain immutable; dynamic decomposition is represented by explicit spawn edges with delegation, depth, and child-count limits.

This gives the system replayable lineage and makes parallelism visible to the scheduler rather than hiding it inside nested chat loops.

A task PASS is not a project PASS. Final integration reconstructs accepted patches in dependency order, detects conflicts, checks protected verifier sources, runs frozen integration tests, and only then publishes a combined result.

## 4. Foundry and Swarm

Foundry is the governed execution kernel. Swarm adds an external-model coding loop, tools, workspaces, durable sessions, and independent verification.

Each coding task can execute in an isolated Git worktree with declared read/write scope. Context is treated as a budgeted resource: a worker receives its goal, acceptance predicates, relevant source context or authenticated dependency views, and explicit deliverable format rather than the entire project transcript.

Dynamic DAG expansion is valuable only when discovered work is genuinely independent. Future-Code therefore constrains spawning instead of equating more agents with more productivity.

Multi-host workers may accelerate execution, but final acceptance remains coordinator-owned.

## 5. Evidence Fabric and Knowledge Protocol

A chat transcript is not automatically reliable project knowledge.

Future-Code represents durable knowledge as structured evidence:

- goals and dependency relationships;
- machine/verifier/experiment evidence with provenance;
- explicit strong-evidence conflicts;
- content-addressed artifacts;
- execution experience indexed by structural task signatures;
- host-computed resource-allocation priors.

When strong evidence conflicts, the system does not average it away. It creates an adjudication opportunity whose discriminator can be a minimal reproduction, counterexample, differential test, or discriminating experiment. The adjudication task must enter the normal admission path.

Experience records summarize verified outcomes, topology, duration/cost when observed, failure strategy, and spawning behavior. They can guide future work, but every reused strategy must still pass the current verifier.

## 6. Provider and remote-compute resilience

External API failure is modeled as a durable wait rather than a failed coding attempt.

Shared provider routes transition through healthy, open, and half-open states. During cooldown:

- no new model request is reserved for the affected pool;
- workers release capacity instead of sleeping while holding a slot;
- one controlled half-open probe tests recovery;
- an outage epoch prevents a late old success from clearing a newer outage;
- unknown provider spend remains unknown.

Remote jobs use stable identity. If the controller times out, Future-Code reconciles by job key before resubmitting. This avoids the expensive failure mode in which uncertainty becomes duplicate training or simulation.

## 7. Reflection and bounded self-improvement

Self-improvement is useful only if it cannot optimize away the acceptance contract.

Future-Code records objective episodes and can trigger reflection after stagnation, repeated failure, failed quality gates, recovery, or objective completion. Intervention memory stores strategy, context, sample count, uncertainty, and verified outcome.

The intended question is not "what critique sounds intelligent?" but:

> **Which intervention previously improved verified progress under comparable conditions?**

Interventions are advisory and may abstain. They do not gain scheduler authority and cannot alter the frozen acceptance contract.

## 8. Adaptive HACT: verification-evidence virtualization

Adaptive HACT is a research component for systems that already require bounded hierarchical diagnostic evidence.

Stable check identities and candidate/checker/environment bindings define the semantic plane. A separate layout plane can reorder and aggregate trusted records. Layout migration increments a generation fence so stale layout tickets cannot authorize current work.

The cost model uses **completion hyperedges**: the actual sets of checks that become final together. Pairwise similarity can propose an order, but pairwise statistics cannot in general determine hierarchical subtree activation cost. Final layout selection therefore replays full completion sets.

The frozen v5 artifact reports:

- 27 train/validation/held-out synthetic workloads;
- clustered held-out padded-evidence reductions of 23.43%, 10.75%, and 5.56% at 128, 512, and 1,024 checks;
- essentially zero benefit in independent/global controls;
- 36 layout replays of 12 archived source candidates;
- whole-epoch compressed reductions of 41.84% for NetworkX, 4.36% for Toolz, and 18.53% for Future Code versus fixed8;
- exhaustive diagnostic pages reduced from 148 to 95 for the practical learned layout;
- root-status text identical across every replay triple.

These are evidence-representation results, not claims that HACT improves LLM reasoning, provider billing, or physical-WAN latency.

## 9. Comparative productivity experiments

### Short repair through real CLI entry points

Each trial used a fresh Git worktree with a defect in a Python verification
metric. The independent checker reproduced the defect before each run. A
loopback provider supplied the read, edit, and completion actions. The final
checker required a correct scoped patch. All 15 successful runs produced the
same patch SHA-256. Wall time includes worktree creation, the initial check,
CLI startup and tool calls, the final check, and cleanup. Five repeats rotated
the starting arm.

| CLI and build | Verified edits | Median wall time for verified edits |
| --- | ---: | ---: |
| First commit `b1f9d18` with current dependencies | 0/5 | — |
| Main `f4dcea1` | 0/5 | — |
| Future-Code with the startup fix `2692c00` | 5/5 | 1.58 s |
| OpenCode 1.19.6 | 5/5 | 5.60 s |
| Claude Code 2.1.327 | 5/5 | 1.07 s |

Commander 15 rejected `-d2e` during option registration. Both Future-Code
baselines exited before sending a model request. The fix preserves the old
`-d2e` spelling and `--debug-to-stderr`. CI now compiles the actual CLI and
exercises both spellings in normal and print mode. The first commit's exact
dependency install returned 404 for seven archived `@future/*` packages.
Its unchanged source was compiled against the current dependency set, so the
first-commit startup result applies to that compatibility build. The timing
covers each client's minimal headless configuration and scripted provider.
[CLI settings, recorded results, and reproduction](../../experiments/agent-productivity-20261118/README.md#short-repair)

### First-commit mechanisms and provider latency

| Measured subsystem and workload | First commit | Later Future-Code | OpenCode provider library |
| --- | ---: | ---: | ---: |
| Serialized review context with full outputs retained on disk | 121,713 B | 35,219 B | — |
| Injected tool-fault contracts passed | 0/5 | 5/5 | — |
| One tool turn with a 200 ms hold after protocol completion | 218.59 ms | 7.67 ms | 14.10 ms |
| Twelve tool turns with the same hold per response | 2,551.79 ms | 61.25 ms | 177.56 ms |
| One tool turn with immediate socket close | 6.08 ms | 5.99 ms | 17.13 ms |

The first two rows come from the November 11 study, which used four repeats
per condition and `ac37892` as the later revision. It measured a 71.06% reduction
in serialized context and verified that every stored full tool output remained
byte-identical. The transport rows are medians of five rotated samples. They
compare the actual first-commit bridge, the `f4dcea1` bridge, and OpenCode's
`@opencode/ai@2.3.0` provider library against the same local SSE frames. Both
bridge spacing overrides were zero. All matched local read receipts agreed.
[First-commit study](../../experiments/first-commit-20261111/README.md) ·
[Transport settings and reproduction](../../experiments/agent-productivity-20261118/README.md#provider-transport)

### Recovery on an accelerated eight-day job

The test used the production scheduler, real SQLite state, a virtual clock,
and a scripted remote adapter. It reopened the controller twice and cut the
link between hour 150 and hour 192. Both versions submitted once and kept the
original acknowledged job identity.

| Controller revision | Outcome | Failed inspections | Terminal receipts |
| --- | --- | ---: | ---: |
| `4dbd9e2`, before the recovery patch | Blocked at hour 168 | 1,081 | 0 |
| `f4dcea1` | Retrieved the expected result at hour 192 | 42 | 1 |

Both arms recorded zero task acceptances. The remote result still feeds a
separate project acceptance check. The experiment measures controller behavior
under the specified fault schedule. [Recovery receipts and reproduction](../../experiments/agent-productivity-20261118/README.md#remote-job-recovery)

### Cost of source discovery and durable tool dispatch

We compared report revision `22cb45f` with tested runtime `40c9588` on the
same 192-file Git fixture. Published runtime `70f1be2` has the identical Git
tree `c6c5ecc739d0ba1aaeb331649ae1e5f6051b41f7` as that tested runtime.
Every arm received the same task, used three scripted
provider responses, and wrote its answer from actual tool results. An
independent checker rejected the initial answer, verified the task patch,
and ran again on the assembled tree. All 42 trials passed on the first
attempt. Every arm produced the same Git tree for a given workload.

| Workload and search policy | Verified runs | Median time to integration | Tool calls | Full thread-state publications |
| --- | ---: | ---: | ---: | ---: |
| Known file, parent → candidate | 6/6 → 6/6 | 551.5 → 538.0 ms | 2 → 2 | 14 → 12 |
| Eight symbols, parent → candidate with the same eight calls | 6/6 → 6/6 | 809.0 → 662.0 ms | 9 → 9 | 29 → 13 |
| Eight symbols, parent → candidate with one combined search | 6/6 → 6/6 | 809.0 → 632.5 ms | 9 → 2 | 29 → 12 |
| 24 distinct reads with 48 KiB of retained input, parent → candidate | 6/6 → 6/6 | 703.0 → 556.5 ms | 25 → 25 | 61 → 13 |

The parent already issued all eight searches in one model turn. Each search
read the same files. Combining the literals reduced file inspections from
1,536 to 192 and source bytes read from 1,580,544 to 197,568 in every
trial. The candidate finished sooner in all six pairs. For the known file,
the candidate finished sooner in three of six pairs. That timing leaves the
short-task effect unresolved. The 24-read fixture measures the cost of carrying
state through one task. Week-long project throughput still needs a field run.

Swarm now records ordered tool-effect and intent events in one SQLite
transaction before dispatch, with one complete thread snapshot for those
events. Each accepted call retains its own identity, admission record and
result receipt. A regression test interrupted that transaction on the last
intent. The backend received zero calls before restart and executed each
queued write once after restart. A separate test recovered a pending reply
from a pre-upgrade search profile with its original request hash.
[Raw trials and reproduction](../../experiments/agent-productivity-20261118/README.md#source-discovery-and-dispatch)

### Repository footprint and architecture decisions

The parent Git tree contains 5,796 tracked files totalling 219,086,528 bytes.
The `hact-paper/` subtree accounts for 173,062,102 bytes. On this fixed
inventory, the default ripgrep scan previously admitted 5,784 paths totalling
216,744,959 bytes. Narrow repository ignore rules bring that to 4,048 paths
and 58,236,159 bytes while retaining all 2,144 pre-existing `src/` paths.
These figures measure the size of eligible files. Checkout size and physical
disk traffic are separate quantities. Audit scripts and manifests remain
discoverable, and an explicit evidence search can use `rg --no-ignore` on
its directory. The chip and HACT paper CI jobs already select affected paths.
The first-commit experiment uses a loader to substitute deterministic test
dependencies. The shipping terminal query imports `StreamingToolExecutor`
directly from `src/services/tools/`. The task replay above exercises the
production Swarm driver, journal and Git workspace.

| Proposal | Release decision and evidence still needed |
| --- | --- |
| Fast start and escalation on difficulty | Coalesce durable writes at the existing dispatch boundary. The terminal already starts eligible streaming tools as complete calls arrive. Measure first useful result and cancelled work on a real endpoint before adding a resident speculative daemon. |
| Typed local actions | Ship one finite operation for a frequent pattern, searching several literals with optional context. New search profiles advertise it to local and updated remote workers. A native gateway replacement needs protocol, cancellation and reconnect parity for the deployed clients. |
| Causal state on resume | Bind restored work to its task, request and receipts. The release tests rollback and exact replay. A new contract graph would need to improve time to first useful work across multi-day restarts and preserve existing failure evidence. |
| Separate worker and verifier | Task and integration checks run independently against reconstructed source. The local worktree backend assumes trusted commands. Enforced OS isolation would require a separately tested backend and deployment-specific containment tests. |
| Competing branches and reusable operators | Independent Swarm tasks already use private worktrees. The combined search is a maintained, deterministic operator. Automatic branch racing and automatic operator promotion still need held-out tasks, conflict and cancellation tests, and total compute per accepted result. |

### Model-backed comparison and coverage

The same-model pilot started Future-Code, Claude Code, and OpenCode on a
local Qwen3-4B-Instruct-2507 model. The first recorded Future-Code and Claude
Code trials each reached their 90-second deadline while the CPU backend was
processing requests. The execution environment disconnected after the OpenCode
trial started. The complete trial matrix and an OpenCode result were unavailable.

Codex CLI 0.170.0 failed app-server initialization on the managed filesystem.
The WorkBuddy desktop client was unavailable. Tencent documents WorkBuddy and
CodeBuddy CLI as separate clients. [Tencent client documentation](https://cloud.tencent.com/document/product/1831/140223)

A general productivity ranking remains open. A broader evaluation requires
previously unseen tasks across projects, a matched-model campaign for runtime
effects, a best-available-model campaign for user outcomes, and full multi-day
objectives with independent verification. Compare accepted objectives, elapsed
time including failures, operator interventions, and verified usage and billing
where available. [Model pilot and full evaluation protocol](../../experiments/agent-productivity-20261118/README.md#model-backed-pilot)

## 10. Security and trust boundaries

Future-Code is a governed runtime, not a complete OS sandbox or Byzantine consensus system.

Git worktrees isolate source state, not hostile processes. The trusted computing base includes protected contract state and independent verification. External providers may continue computing after host cancellation, so unknown external spend remains unknown. HACT generation fencing is not remote attestation.

## 11. Differentiation

| Concern | Simple agent loop | Future-Code |
|---|---|---|
| Objective | prompt text | durable objective + frozen contract |
| Decomposition | model-local plan | host-visible DAG + bounded spawn |
| Concurrency | ad hoc calls | leases, scopes, dependencies, quotas |
| Provider outage | retry/sleep/error | durable cooldown + released capacity |
| Remote uncertainty | resubmit/lose | stable identity + reconcile-first |
| State | conversation | store + journals + artifacts + evidence |
| Success | model says done | independent verifier + integration |
| Learning | prompt edits | measured episodes + intervention memory |
| Evidence delivery | logs/context dump | optional HACT evidence plane |

The economic value is highest where failure is expensive: multi-repository changes, ML training, scientific computing, remote experiments, and long R&D objectives where a duplicated job, lost hypothesis, or premature merge costs far more than one model request.

## 12. Roadmap

Priorities for the next evaluation cycle include measuring time to the first
verified action on real endpoints, profiling the remaining Git and verifier
setup cost, and running matched live workloads across projects. Use the
known-file control when changing dispatch policy. For remote R&D, measure
time from restart to the first accepted project milestone.

Medium-term work includes stronger multi-host authority only after measurements justify it, cryptographically stronger evidence binding for high-assurance environments, learned intervention policies with explicit uncertainty, and real HACT diagnostic-retrieval/WAN studies.

## Conclusion

Future-Code is best understood as an **agent operating system for verified long-horizon work**. Models provide intelligence; the host owns authority, durable state, recovery, and evidence. The goal is two-sided: simple work should feel fast, while difficult R&D objectives should survive the failures, uncertainty, and context limits that make ordinary agent loops unreliable.
