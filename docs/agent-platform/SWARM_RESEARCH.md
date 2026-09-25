# Research-to-implementation record

Reviewed on 2026-09-25 against official public sources and repository snapshot
`77812838986c1ccefbb3b1646ef66cbf74fc2f84`. This document separates reported facts,
engineering choices, executable evidence and unimplemented ambitions. It does
not assert that the individual mechanisms are unprecedented inventions.

## Source verification

| Primary source | Supported finding | Consequence for this patch |
| --- | --- | --- |
| [Managed Agents engineering, 2026-04-08](https://www.anthropic.com/engineering/managed-agents) | Session, harness and execution environment are replaceable interfaces; persistent events are distinct from the active context. The reported latency improvement is TTFT, not a whole coding project's completion rate. | Reuse Foundry's kernel, add durable thread state and a separate HandsBackend, provision worktrees lazily. Do not transplant the vendor's reported speedup. |
| [Multiagent orchestration documentation](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration) | Isolated thread contexts can share execution resources; configured rosters have one-level delegation. The documented concurrent-thread ceiling is 25, with advisor consultations exempt. | Separate task contexts; use private coding worktrees rather than rely on a shared mutable tree. Restrict authority to a reviewed roster and fixed DAG. |
| [Internal development measurements](https://www.anthropic.com/institute/measuring-pace-of-ai-development) | About 30,000 simultaneous research/engineering agents was reported for the most-used internal platform as of August 2026. | This is not a public per-session quota or evidence that this patch can operate that fleet. No numerical scale equivalence is claimed. |
| [Messages API compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) | Server-side compaction is already available in the Messages API. | The claim that ordinary API users categorically lack compaction is incorrect. This adapter implements local reversible trimming, not that provider API. |
| [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Cache reuse requires a matching eligible prefix; provider metadata distinguishes cache reads, writes and uncached input. | Stable tool/system prefix and explicit opt-in cache hints; meter metadata, not hypothetical saved tokens. |
| [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) | Context protection and genuinely independent work can justify parallel agents; coordination can outweigh benefits. | Partition by verifiable feature outcomes. Keep tightly coupled changes together and avoid a manager conversation on every scheduler poll. |
| [Patterns and problems in multiagent systems](https://www.anthropic.com/research/multiagent-systems) | Reported experiments expose coordination difficulties and sensitivity to task/model conditions; more agents or role labels are not universally sufficient. | Bound work and communication, preserve external verification, and measure merged-tree success, not agent count. |

Public sources do not establish that the public inference stack is deliberately
"crippled", that all internal checkpoints have weaker safeguards, that public
and internal weights are identical, or that Managed Agents is a byte-for-byte
productization of one particular 30,000-agent system. These are not assumptions
in the implementation. The current docs label Managed Agents and its multiagent
surface Beta; individual ancillary features can have different preview status.

## Hypotheses and falsification

**H1: replay reduces wasted work after interruption.** A committed model reply
must be reused at the same logical step; completed tool results must not be
reissued after a recovered checkpoint. Tests inject a lost checkpoint after
reply commit, pending tool calls, stale fences and verifier failures. A durable
reply replay test must observe no extra provider call. Uncommitted remote replies
remain ambiguous and may be charged again: no general exactly-once claim.

**H2: narrower context reduces repeated transmission without corrupting tool
protocol.** Trimming must keep the task and complete recent exchanges. Older
content must remain retrievable under thread-local receipt grants. Tests check
budget overflow, paired tool IDs, explicit truncation, unauthorized receipt
access and artifact corruption. This is a correctness/availability test, not a
measurement of live coding quality or real tokenizer savings.

**H3: parallel workers reduce completion time only for compatible work.** The
controlled benchmark fixes tiny independent tasks, model delay and checker logic,
then varies only task concurrency (one/four). Its endpoint is verified integrated
completion time. It is a useful lifecycle concurrency check, but its synthetic
inference delay and task construction prevent generalization to live large-SWE
projects. Critical-path and scope controls are inherited from the upstream
productivity patch, not reintroduced here as new research contributions.

**H4: independent integration prevents false project-level completion.** Workers
can each pass on their own view while their patches conflict. A regression test
constructs exactly that case and requires no branch publication. Separate tests
reject a verifier that modifies tracked source and a pre-existing publication
branch that points elsewhere. Test coverage itself remains an operator contract:
independent processes cannot compensate for inadequate behavioral checks.

**H5: bounded inference prevents restart from resetting cost controls.** Separate
SQLite handles must respect the same request/byte reservations and per-provider
in-flight cap. Cancellation, rate-limit retries and late responses are included.
Unknown token usage cannot become zero. Limits are local/run-scoped, not global
provider-account governance or a trusted dollar budget.

## Why these mechanisms rather than more orchestration prose

The prior code already supplied a durable DAG, conflict checks, critical-path
ordering, bounded dependency views, progress watchdogs and batched admission.
The missing practical path was from the existing interactive agent to actual
model/tool execution, persistent per-worker progress and a verifiable Git
artifact. This patch fills that path while preserving the kernel's authority.

The model decides how to implement its scoped task. Code decides whether it may
call a tool, whether a request fits budgets, whether a lease is current, and
whether checks permit admission. Durable receipts let a worker recover without
asking a manager to reconstruct its conversation. Private worktrees reduce
accidental interference; independent reconstruction and final integration test
what is actually delivered. These are combined engineering mechanisms, not a
claim that an OS analogy itself accelerates inference.

## Explicitly deferred, not implemented

Multi-host ownership/consensus, global tenant/model quotas, elastic distributed
worker placement, hardened remote sandboxes, an MCP credential proxy, universal
Vault semantics, cross-session memory learning, automatic graph mutation,
recursive manager hierarchies, inference-engine KV block sharing, speculative
model decoding and accelerator-specific kernels are not delivered. Interfaces
are not counted as implementations. These require separate failure/security
models, workloads and benchmarks before promotion.

Nor does the native slash command replace all original interaction paths. It
is registered and tested as an opt-in route; end-to-end native packaging and
live-provider canaries are still required in the target deployment.

## Next evaluation contract

For the next real canary, freeze source revisions and representative tasks,
choose a single compatible deployed model, use the same external oracles, and
compare single-agent and bounded-parallel runs in alternating order. Include
planner work, queueing, tool calls, retries, failed tasks, integration and
operator repair time. Record provider usage or explicitly mark it missing.
Primary result: accepted **integrated** changes per wall time at a fixed quality
bar. Guardrails: regression rate, total cost, unmeasured calls, scope violations
and recovery behavior. Report several projects and uncertainty rather than a
single selected fast run. A "world-leading" conclusion would need comparable
public baselines and this evidence; it is not justified by the shipped fixture.
