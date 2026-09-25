# Foundry Swarm: durable, scoped coding agents

Base reviewed: `xuda1979/future-code@77812838986c1ccefbb3b1646ef66cbf74fc2f84`.
This is an opt-in coding execution path on the **existing Foundry kernel**. It is
not another scheduler, an Anthropic Managed Agents API wrapper, or a replacement
for the ordinary interactive QueryEngine. The new native commands are registered
in `src/commands.ts`; the same host facade is callable from Node without the UI.

## 1. The execution contract

The current interactive agent plans work with `/swarm-plan`. A reviewed Task[]
becomes the fixed DAG for a run. `runTasks` and `Scheduler` own dependencies,
leases, attempts, logical read/write reservations, critical-path ordering and
acceptance. `SwarmDriver` supplies the missing model/tool loop and an independent
verifier. Agents do not get Store authority and cannot alter the DAG or spawn
recursive workers. Different tasks may select different entries in a pinned
model/tool/check roster using `task.agent`.

```
existing interactive agent (/swarm-plan): propose a bounded Task[]
                  | operator reviews and authorizes /swarm run
existing Foundry runTasks + Scheduler + immutable acceptance contract
                  | leases ready tasks, not another LLM manager loop
SwarmDriver ------+---- HttpBrain (standard model API; bounded requests)
    |             +---- SessionJournal (durable state and replay receipts)
    +-- HandsBackend ------ LocalGitHands (lazy, per-attempt worktree)
    +-- independent verifier (fresh worktree + frozen named checks)
                  |
explicit integrate: combined tree checks -> new swarm/<run> branch
```

A task's PASS is not a project's PASS. Integration reconstructs all accepted
patches once in dependency order, rejects conflicts, runs frozen integration
checks, checks for verifier source mutation, and only then publishes a new local
branch. It never checks out, merges into, resets or pushes the user's branch.

## 2. Requirements and safety boundary

The executed path was Node 22.16.0, Git 2.47.3, Linux, with built-in `node:sqlite`
and TypeScript stripping. No new npm dependencies or lockfile edits are needed
for the standalone path. The native metadata and handler have direct import
and integration tests; **the entire UI/application build was not executed**.
The existing Store selects Bun SQLite under Bun, but this release was not run
on Bun. Windows local process execution is explicitly rejected.

**A Git worktree is NOT an OS sandbox.** This backend is for trusted repositories
and trusted check commands. Model edits are scope checked, symlinks rejected,
child environment variables allowlisted, and POSIX process groups terminated
on cancellation. These controls do not contain hostile native code, prevent
all same-UID credential access, or guarantee termination of deliberately escaped
processes. Use a hardened container/VM backend before running untrusted projects.
`HandsBackend` is an identity-checked host injection point for both execution and
verification; a remote/container backend is not shipped here.

API keys are read by the harness from named environment variables and omitted
from model request bodies, logs and default child environments. Check configs
cannot allowlist a model-key variable. This is not a Vault service or a security
claim that malicious same-user processes can never read credentials.

`--allow-exec` is explicit authorization to run the configured trusted commands;
run/resume may incur model charges. Native commands are not model-invocable and
are not added to remote/bridge execution allowlists. No background daemon starts.

## 3. Start with the included coding fixture

Apply the patch, review it, and commit the source and fixture before using `HEAD`
as the base. Worktrees begin from a commit; uncommitted project changes are not
silently copied. The new harness code can run uncommitted, but the *target code*
you want agents to see must exist in `baseRef`.

Copy `examples/swarm/spec.json` to an operator-owned file and edit it. Set `project`
to an absolute Git root, choose `baseRef`, replace `YOUR_DEPLOYED_MODEL_ID` with an
actual compatible model, and set the endpoint. Relative project paths resolve
from the invocation working directory. Relative pinned check paths resolve from
the project root. The included localhost endpoint is only an example, not a
bundled model server. Do not put API secrets into JSON or prompts.

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts init \
  --root .future-code/swarm-demo --spec /absolute/path/swarm-spec.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts run \
  --root .future-code/swarm-demo --tasks examples/swarm/tasks.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts status \
  --root .future-code/swarm-demo --run RUN_ID
node --experimental-strip-types src/harness/foundry/swarm/cli.ts integrate \
  --root .future-code/swarm-demo --run RUN_ID --allow-exec
```

The fixture writes `examples/swarm/output/answer.txt` and checks that it contains
42. It is an API/tool/Git lifecycle smoke, **not a realistic coding benchmark**.
Replace its checks and tasks with a representative held-out project before
judging productivity. The actual run ID is printed in the run result and is
also listed by `status` without `--run`.

The equivalent native UI workflow is:

```
/swarm help
/swarm-plan Implement the requested feature, inspect interfaces and propose independent tasks
/swarm init --root .future-code/swarm-project --spec /absolute/path/spec.json --allow-exec
/swarm run --root .future-code/swarm-project --tasks /absolute/path/tasks.json --allow-exec
/swarm status --root .future-code/swarm-project --run RUN_ID
/swarm integrate --root .future-code/swarm-project --run RUN_ID --allow-exec
```

The planning command uses the existing interactive agent. It is not a separately
benchmarked autonomous planner. Plan validation rejects structural/schema/scope
errors but cannot prove that the task decomposition or the tests are sufficient.
The operator still reviews the plan and chooses the trusted checks.

## 4. Model and tool configuration

Each roster entry pins `protocol`, full `url`, `model`, `system`, `tools` and
`checks`; `keyEnv` and `promptCache` are optional. `anthropic` uses the standard
Messages endpoint; `chat-completions` uses function-tool wire format. An existing
self-hosted server can be selected if it actually implements that protocol.
This does not prove compatibility with a particular vLLM, NPU or model deployment.

For an Anthropic profile, keep the tools/checks from the example and change:

```json
{
  "protocol": "anthropic",
  "url": "https://api.anthropic.com/v1/messages",
  "model": "OPERATOR_SELECTED_COMPATIBLE_MODEL",
  "keyEnv": "ANTHROPIC_API_KEY",
  "promptCache": true
}
```

This is a fragment, not a complete spec. A chat subscription is not assumed to
supply API credentials. HTTPS is required except loopback or explicit operator
`allowHttp` for a trusted private service. URL credentials/query strings and HTTP
redirects are rejected to avoid leaking authorization. No real provider account
was called during patch verification.

Only standard text and client function tools are supported in this adapter.
Streaming, images, signed thinking/redacted-thinking blocks, server-side tools,
provider-specific compaction and advisor protocols are **not implemented**.
Unsupported returned block types fail closed instead of silently removing data
required for a later API turn. Choose a compatible profile for the initial canary.

Tools are `list_files`, bounded `read_file`, `write_file`, exact-once-match
`edit_file`, `delete_file`, `run_check` and `recall`. There is no arbitrary shell
command supplied by the model. `run_check` accepts only a configured check name.
Trusted checks may themselves execute arbitrary code; configure them accordingly.

`$NODE` in a check's executable position resolves and pins the installed Node
binary at initialization. This matters when the native Future Code executable
is a compiled binary rather than Node. `$RUNTIME` retains the existing Foundry
meaning and should not be used as a substitute for Node in that case. Executable
and declared implementation files are hashed. Declare transitive check files in
`files`, protect test oracles, and manage external environment dependencies.
Pinning is not a hermetic environment proof.

All verification/integration checks must declare `replaySafe: true`. This is an
operator assertion, not an automatic proof of idempotence. Checks must not send
mail, deploy code, mutate external databases, or perform other unreconciled
external side effects. Code changes may include feature tests; frozen external
oracles still decide acceptance and must not be weakened to get a PASS.

## 5. State, recovery and context

The existing Foundry SQLite database and content-addressed artifact store are
reused. New tables retain thread checkpoints, append-only event records,
thread-local receipt grants, repair feedback, model request reservations, replay
records and provider cooldowns. State and event commits are fenced by the live
task lease and a compare-and-swap sequence number.

A retry restores the latest patch into a new worktree, continues outstanding
tool calls, and reuses a model response that was **durably committed** for the
same logical step and exact request body. A failed independent check supplies
bounded diagnostic receipts to a subsequent repair attempt rather than
replaying an unchanged final answer indefinitely. Turn and tool-call ceilings
span retries; run-level inference reservations also survive process restart.

This is not an exactly-once guarantee for remote effects. A provider response
lost before durable commit can require another charged request. Unknown requests
remain charged against reservations and have unknown token usage. A late old
worker may contribute usage evidence but cannot publish a replay response under
a replacement fence. Non-replay-safe interrupted effects require reconciliation;
the shipped schema forbids those effects in verification checks.

Ctrl-C terminates cooperative model requests and local child process groups.
The run remains inspectable. Resume the same fixed graph and pinned configuration:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts resume \
  --root .future-code/swarm-project --run RUN_ID --allow-exec
```

When a process dies completely, the existing lease deadline must expire before a
replacement can reclaim it. This release does not shorten deadlines by guessing
that another process is dead. Exhausted tasks are terminal; new scopes/acceptance
or a different decomposition need a new reviewed run, not a hidden contract edit.

The model sees the immutable task capsule and recent **complete** tool exchanges.
Older material is retained, not erased. `recall` retrieves bounded thread-local
receipt slices and history pages. Large outputs have explicit truncation markers
and receipt hashes. This is reversible context trimming, not a lossy LLM summary.
Mandatory instructions, acceptance and dependency inputs never silently truncate.
The full encoded provider request (including system and tool schemas) must fit
the admitted context allocation.

Prefix structure is stable; Anthropic system-prefix cache hints are opt-in.
Cache hits depend on the provider, model and minimum prefix length. This code
neither owns nor shares physical KV cache and does not claim zero-prefill forks.

Inspect without calling a model:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts events \
  --root .future-code/swarm-project --run RUN_ID --task TASK_ID --after 0
node --experimental-strip-types src/harness/foundry/swarm/cli.ts receipt \
  --root .future-code/swarm-project --hash RECEIPT_HASH --offset 0 --length 4096
```

Status returns at most 200 tasks plus `nextTaskAfter`. Request another page with
`--task-after TASK_ID`. Event pages use sequence cursors. Keep the state directory
private, backed up as a consistent SQLite/artifact pair, and out of source control.
Logs and source content are not automatically secret-redacted.

## 6. Concurrency, budgets and measurements

Foundry's existing task concurrency and logical read/write reservations remain
in force. Separate worktrees do not justify ignoring declared interface conflicts.
Use dependency paths for shared schemas. Independent work should usually use
narrow read scopes too: declaring the whole `src` tree read-only will deliberately
serialize it against every writer under `src`.

`modelConcurrency` bounds in-flight RPCs per model endpoint/model group **within
one run and Store**. Multiple processes sharing that Store honor the same limit.
It is not an account-wide or cross-run rate limiter. HTTP 429/503/529 cooldowns
are shared within that ledger; request attempts still consume durable budgets.
The number of calls and aggregate serialized request bytes have run-level caps.
Per-thread turn/tool caps and per-RPC/tool deadlines give additional limits.

These byte limits are not token limits or dollar caps. `providerUsage` records
provider metadata tokens, `knownTokens`, `unknownRequests`, and reservations.
Missing usage is null rather than zero. Anthropic cache read/creation tokens are
included in total input accounting. Model JSON that claims its own cost is ignored.
There is no trusted currency price meter, so costUsd is unknown. The older Foundry
`progressDensity` retains its budget-based meaning and is not relabeled as billed
token efficiency. Planning calls made in the interactive UI are not included in
the worker-run ledger; include them in a real end-to-end evaluation.

The implementation accepts bounded plans up to the existing contract ceilings,
not an empirically validated 30,000-agent cluster. SQLite is a local single-host
control plane. There is no distributed consensus, autoscaling fleet, remote
worker service, universal MCP proxy, Vault, cross-session learning/Dreaming,
recursive delegation or self-modifying orchestrator in this patch. A second
process can cooperate through the existing Store/host API; the CLI does not
create or manage a daemon fleet.

## 7. Tests and evaluation

```sh
node scripts/test-swarm.mjs
node --experimental-strip-types scripts/bench-swarm.mjs
```

The test launcher runs the unchanged productivity tests plus new lifecycle,
provider protocol, real localhost HTTP, native command facade, real Git,
independent verification, fault injection and cancellation tests. The benchmark
compares one vs four workers in the **same patched runtime**: 12 independent tiny
file edits, a fixed 80 ms simulated model delay, three alternating-order pairs,
real worktrees, real external checks and real integration branch publication.
Setup/initialization, the interactive planner and live inference are excluded.
It is neither a before/after upstream comparison nor a live Claude productivity
claim. Raw data must report acceptance and request counts alongside time.

A production canary should use a fixed base commit, reviewed tasks, frozen
external checks, the same model and decoding settings, alternating run order,
more than one project, failure/retry accounting and the final merged-tree pass
rate. Report accepted integrated changes per wall time and per measured cost;
include planner time, model queue time, tests, failed attempts and integration.
Do not promote merely because more agents were busy or the mock fixture sped up.

For source rollback, use a dedicated feature branch and revert its patch commit.
Do not discard unrelated local changes. Preserve or retire the new state root
explicitly; never overwrite an old contract as part of rollback.
