# Research note: bounded hierarchical coordination with a shared task board

Release: 1.2.0. Research checked on 2026-09-18. This is a design synthesis, not a
reproduction of the papers' model-quality benchmarks. Actual package measurements
are in `../TEST_REPORT.md` and `../evidence/v1.2/`.

## Decision

Use **hierarchy for decomposition and accountability, a scoped shared board for
collaboration, and deterministic code for scheduling, leases, monitoring and numerical
aggregation**. Do not send every worker transcript to a single LLM. Do not replace that
bottleneck with an unrestricted all-agent chatroom.

The implementation is a *hierarchical task mesh*. Its reasoning is distributed across
small task-local contexts, while its durable execution control remains a single-host
Python/SQLite service. These are different meanings of decentralization. It does not
provide distributed consensus, multi-host workers or high availability.

## Primary sources and implications

| Source | Relevant evidence or engineering observation | Decision taken here | Qualification |
|---|---|---|---|
| Kim et al., *Towards a Science of Scaling Agent Systems*, arXiv:2512.08296v3, revised 2026-04-08 [R1] | Controlled comparisons across 260 configurations show that coordination and task structure matter; added agents can incur overhead and propagate errors. | Bound parallelism; preserve explicit dependencies and verification; do not assume more agents improve quality. | A cross-benchmark result is not a prediction of this package's speed or accuracy. |
| Mao and Mirhoseini, *Decentralized Multi-Agent Systems with Shared Context*, arXiv:2606.10662v1, 2026-06-09 [R2] | DeLM uses asynchronous task claiming, shared compact updates and selective expansion of evidence rather than routing every update through one controller. | Keep durable results outside prompts; let related agents fetch small result pages, including descendant evidence when needed. | DeLM is a preprint and uses model-based verification for claims. This package does not reproduce its benchmark gains or claim all summaries are verified. |
| Anthropic, *Building a C compiler with a team of parallel Claudes*, 2026-02-05 [R3] | The engineering account describes 16 agents, task locks, fresh sessions, and the importance of tests. It also reports that agents stalled on shared bottlenecks until work was made independently testable. | Keep one writer per scope; use fresh task contexts and executable gates. Parallelize independent failure surfaces, not duplicate attempts on one shared file. | This is a reported experiment, not a universal scalability guarantee. |
| Anthropic, *Effective context engineering for AI agents*, 2025-09-29 [R4] | Recommends high-signal context, just-in-time retrieval, durable notes and separate subagent contexts; aggressive compaction can lose needed detail. | Preserve exact authority/acceptance fields; replace bounded working notes; retain tool artifacts; expose paginated references instead of repeatedly summarizing summaries. | A small context alone does not establish that the model has the information it needs. |

## Comparison of candidate designs

**A single manager with hundreds of direct workers.** Easy to express, but every report,
clarification and reassignment competes for the same model context and inference time.
Even concise reports accumulate. Adding a larger context window does not remove the
single integration path or guarantee relevance.

**A strict hierarchy.** Limits each manager's direct reports and permits independent
branches. However, forcing every question through all ancestors creates routing latency,
and repeated prose summaries can lose qualifications. A root still needs a bounded
final synthesis and real cross-component integration checks.

**An unrestricted self-organizing swarm.** Can discover work opportunistically, but
requires coordination over ownership, duplicate work, inconsistent assumptions and
termination. With N agents, an all-to-all directed communication pattern permits
N(N-1) sender/recipient pairs. This is a combinatorial observation, not measured
network traffic for any paper or this package.

**The selected hybrid.** Local coordinators split work into small groups. Idle execution
slots claim ready work from the durable queue without consulting a global LLM. Peers
and dependency endpoints exchange bounded findings. A parent can selectively inspect
its descendants, but does not automatically receive their histories. Native workers
cannot broadcast to an arbitrary project-wide list. Numerical status is computed by
code, not recursively paraphrased by models.

## Why eight direct children?

Eight is a configurable engineering default, **not an experimentally established optimum**.
A starting range of four to eight is a local design heuristic for keeping task packets
small; choose fewer for tightly coupled work. Measure your own model, repository,
acceptance tests, rate limits and cost before increasing concurrency.

For a complete eight-way tree with 512 leaf tasks, the structure contains 64 local
integrators, eight regional integrators and one root: 585 logical tasks in total.
There are three parent/child edges from root to leaf. Every integrator handles at most
eight direct child cards, regardless of how many descendants those cards represent.
Logical tasks are not simultaneous model sessions: the included scale run used 64
concurrent execution slots.

If a compact child card has size s and the fan-out is b, direct-report information is
bounded by b*s before the overall request ceiling. A flat manager instead receives
N*s if all N reports are included. This only bounds **per-request representation**.
It does not bound the total evidence needed for a hard synthesis problem, eliminate
serial work, or prove that a fixed-width summary preserves every relevant fact.

The software therefore keeps explicit omission counts, unverified-summary labels,
artifact references, deterministic subtree counts and selective descendant reads.
A named executable check supplies evidence for its tested scope; it never certifies
all natural-language claims. Missing evidence stays UNKNOWN.

## What would constitute a model-quality evaluation?

The local fixtures test mechanics only. To compare architectures on your actual system,
freeze a set of representative tasks with protected acceptance tests and compare a
single-agent baseline, flat coordination and the bounded hybrid under the same model,
request/token budget and tools. Record success rate, final acceptance failures, elapsed
time, provider usage, coordination-only calls, merge conflicts and human interventions.
Repeat over seeds/tasks; report uncertainty and failures, not only successful anecdotes.

Start with independent modules, then include coupled interfaces and sequential tasks.
An architecture that wins on independent shards may lose on a shared compiler bottleneck
or one indivisible proof. No hosted-model comparison of this kind was performed here.

## References

[R1] https://arxiv.org/abs/2512.08296v3

[R2] https://arxiv.org/html/2606.10662v1

[R3] https://www.anthropic.com/engineering/building-c-compiler

[R4] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
