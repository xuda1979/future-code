# Supervised, resumable R&D on Foundry Swarm

## Purpose and boundary

This change extends the existing `src/harness/foundry/` execution path and native
`/swarm` command. It does not replace the ordinary interactive QueryEngine,
intercept every Bash/SSH command, or create a second agent scheduler. Use this
path explicitly for reviewed multi-task work and durable external experiments.

An objective stays open until all required tasks and the final integration gate
pass. Transient provider failures and external job waits are durable continuations,
not failed implementation attempts. Terminal failures trigger durable objective replanning by the configured external
API agent (or the default agent) unless `maxReplans: 0` explicitly disables it.
Omitting `maxReplans` no longer means zero recovery: the supervisor keeps trying
materially different execution graphs while the objective-wide request/byte budget
permits. True blockers such as unresolved external side effects, missing credentials,
a recovery planner that declines a safe change, or exhausted objective budget remain
visible as `NEEDS_ATTENTION`. The supervisor remains attached, emits health reports,
and can be cancelled. It cannot guarantee that an arbitrary objective is solvable or
that unavailable infrastructure returns.
It never overrides a user's stop, invents credentials, resets spending ceilings,
or blindly resubmits a remote job whose outcome is unknown.

## Apply and verify

The patch is based on upstream commit
`10886a499d4a0a1b67f6cadf997e154b9f07a0ba` (September 28, 2026).
It includes acceptance-evidence revalidation; no earlier patch is a prerequisite.

```sh
git switch -c feat/resilient-rnd 10886a499d4a0a1b67f6cadf997e154b9f07a0ba
git apply --check /absolute/path/future-code-resilient-rnd.patch
git apply /absolute/path/future-code-resilient-rnd.patch
node scripts/test-resilience.mjs
```

The authoring environment verified a SHA-matched source subset with Node 22.16,
Python 3 and Git on Linux, using `--source-subset` for the focused test launcher.
That flag excludes one registration test requiring the missing full command
registry. It is not a substitute for the full repository build/Bun/UI tests.
The remote runner uses POSIX file locks and process groups; Windows is unsupported.

## Time control: use separate clocks

These are configurable starting policies, not universal optimal values.

| Clock | Example setting | Meaning |
|---|---:|---|
| Status reporting | 30 seconds | Show controller status, task stage, activity/progress/check ages and wait reasons. No model call. |
| Model request timeout | 120 seconds | Bound one request. Transport failures become backed-off continuations; usage can remain unknown. |
| Short tool/RPC timeout | 30 seconds | Bound a file/check/remote-control RPC. A remote job's lifetime is separate. |
| Checkpoint check | 5 minutes | At the next safe boundary between tool exchanges, run the first named permitted check and retain its evidence. Not a hard real-time promise. |
| No-progress timeout | 6 minutes | End an active episode that has produced no recognized progress; preserve checkpoints and use the repair budget. A stream of heartbeats/read calls cannot reset it. |
| Local attempt deadline | 15 minutes | Bound an individual coding/verification attempt even if it keeps changing artifacts. |
| Remote job deadline | Explicit, e.g. 6 hours | Bound the actual experiment in the trusted remote template, independently of agent episodes. |
| Remote milestone age | Explicit, e.g. 15 minutes | Mark the job `remote-stalled` when no new semantic milestone appears. Inspect, do not blindly relaunch. |

The status observer being alive does not prove a worker is productive.
`activity` describes observed model/tool activity; `progress` describes a changed
patch (or another trusted adapter's new fingerprint); `check` records an actual
check attempt, not necessarily a passing check. Only independent task verification
and final integration establish acceptance. Changed patches can still be wrong.

Checkpoint checks happen at safe boundaries. They do not interrupt an in-flight
remote experiment or arbitrarily cut a model/tool response in half. Long builds,
training and simulations should be external jobs, not a many-hour `run_check`.

## Start with the supervised coding demo

Copy `examples/swarm/supervised/spec.json` to your project configuration. Set the
real `project` repository root, model endpoint/model ID and checks. The shipped
model ID is a placeholder; the included demo checks are not research validation.
Commit the intended target code: worktrees use a fixed Git commit, not uncommitted
changes. Review the task graph before execution.

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts init \
  --root .future-code/rnd --spec /absolute/path/spec.json --allow-exec

node --experimental-strip-types src/harness/foundry/swarm/cli.ts supervise \
  --root .future-code/rnd --objective research-objective-001 \
  --goal examples/swarm/supervised/goal.txt --tasks examples/swarm/tasks.json \
  --allow-exec
```

`supervise` stays in the foreground. Periodic status goes to stderr; final output
is JSON on stdout. In the native `/swarm` command the integration updates one
system status message rather than appending a new transcript entry on every tick.
The full native UI has not been built in the authoring environment.

The example fills up to eight eligible independent task slots. It retains
write/write exclusion, verified dependencies, provider concurrency and context
reservations. `snapshotReads: true` is an explicit new contract for the private
Git backend: a sibling writing its own private tree does not block a reader of
another pinned tree. It does not provide locking for external databases/devices.

Plan useful independent work with `/swarm-plan`; that reviewed DAG remains
the admitted root work. When a pinned agent profile explicitly grants
`spawn_tasks` and `supervision.dynamicDAG` is configured, the runtime may add
bounded child tasks without rewriting the parent's immutable task specification.
The host enforces roster, scope, depth and task-count ceilings; this is not
arbitrary role creation or multi-host scheduling. Increasing limits is not
evidence of higher productivity.

## Resume and inspect

After a controller crash or Ctrl-C, use the SAME root and objective ID:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts supervise \
  --root .future-code/rnd --objective research-objective-001 --allow-exec

node --experimental-strip-types src/harness/foundry/swarm/cli.ts objective \
  --root .future-code/rnd --objective research-objective-001

node --experimental-strip-types src/harness/foundry/swarm/cli.ts status \
  --root .future-code/rnd --run RUN_ID
```

Do not repeatedly call `run` or invent a new objective ID as a retry mechanism:
that creates different work and budgets. The saved plan, goal and configuration
must match on resume. A short supervisor lease prevents two owners driving the
same objective; a crash can require waiting for its 30-second lease to expire.
Worker leases continue to fence late results.

`COMPLETE` requires independently verified task outputs plus final merged-tree
checks. Integration creates a new `refs/heads/swarm/RUN_ID` branch; it does not
modify main, checkout, force-update or push. Cached evidence is revalidated.

`NEEDS_ATTENTION` explains exhausted budgets, unrecoverable protocol/configuration
problems or failed final integration. It does not silently drop the objective or
run identical failed checks forever.

Supervision performs bounded execution replanning by default. `supervision.recoveryAgent`
selects the external API profile and defaults to `defaultAgent`. `maxReplans` is
an optional lifetime cap (0 disables automatic replanning); when omitted, recovery
continues under `maxObjectiveRequests` and `maxObjectiveRequestBytes`. If those
objective-wide ceilings are omitted they default to 64 times the per-run request and
request-byte budgets. Every model request is charged at reservation time against
both the current run and the objective ledger, so creating a replacement run cannot
reset lifetime spend.

The supervisor records one durable recovery attempt per failed run, gives the
planner the frozen objective, previous task graph and bounded failure evidence,
and validates any replacement task graph against the unchanged Foundry contract
and Swarm configuration. A replacement must also have a new normalized execution
strategy signature: task-ID or ordering-only rewrites do not make the same
goal/acceptance/agent/input/scope/dependency strategy admissible again. Deferred
planner retries wake at their durable `retry_at` deadline rather than waiting for
the next status-report interval. Recovery admission is crash-reconcilable:
`STARTED -> PREPARED -> PLANNED`. The exact replacement plan and deterministic
run ID are persisted in `PREPARED` before the run is created. A restarted
supervisor can therefore create-or-adopt that same run and finish binding it
without calling the planner again. A crash while the planner is still only
`STARTED` may repeat planning under the same bounded revision, but no execution
authority or replacement run has been admitted at that point. The original
plan/run stays in `swarm_objective_revisions`; `objective` status reports the
latest revision and recovery state. Acceptance checks, protected paths and provider configuration
are not writable through the planner interface.

This mechanism is deliberately opt-in: without both a planner and
`maxReplans > 0`, the prior operator-driven `NEEDS_ATTENTION` behavior remains.
Each new run has its own per-run attempt/request ledger, so `maxReplans` is also
a hard multiplier on possible recovery spend rather than permission to retry
forever. Credential/configuration failures should normally return no recovery
plan and wait for operator repair. Explicitly running a successful `integrate`
can still resolve the final integration gate; the supervisor revalidates the
resulting receipt before accepting completion.

## Multi-host execution workers

A Swarm may configure `workers` to distribute filesystem/tool execution across
multiple machines while keeping one authoritative coordinator. This is deliberately
not distributed SQLite or multi-master acceptance:

- the coordinator owns task leases, fences, model request ledgers, objective state,
  verification evidence and final integration;
- each worker is a disposable execution accelerator with a bounded
  `maxConcurrent` workspace capacity;
- the coordinator invokes a pinned adapter command, so SSH, Kubernetes exec, a
  batch wrapper or another transport can be used without embedding transport logic
  in the scheduler;
- the supplied `scripts/swarm-worker-agent.py` endpoint reconstructs a private
  worktree from the exact base commit, verified dependency patches and the latest
  durable task patch;
- after mutating tools, the patch is snapshotted back into the coordinator's
  content-addressed store;
- if a worker disappears before a durable snapshot, the task tries the remaining
  healthy worker fleet rather than stopping after one alternate host; repeated
  worker RPC failures are tracked durably and temporarily quarantine unhealthy
  workers before later probes;
- remote diagnostic `run_check` commands come from the worker's trusted template,
  but **PASS is never accepted from a worker**. The coordinator reconstructs the
  candidate patch locally and reruns the pinned independent verifier before task
  acceptance.

Example worker fragment:

```json
{
  "workers": {
    "host-a": {
      "adapter": {
        "argv": ["/usr/bin/ssh", "-F", "/etc/future/ssh_config", "host-a",
          "/usr/bin/python3", "/opt/future/swarm-worker-agent.py",
          "--root", "/srv/future/workspaces",
          "--repo", "/srv/project",
          "--config", "/opt/future/worker-template.json"],
        "files": ["/etc/future/ssh_config"]
      },
      "maxConcurrent": 8,
      "maxRpcBytes": 8388608
    }
  }
}
```

The adapter must be non-interactive and pinned. Keep model credentials out of
worker/check environment allowlists. The remote repository must contain the pinned
`baseCommit`; repository/data synchronization remains an operator/infrastructure
responsibility. Multi-host improves wall time only when the task DAG exposes parallel
work; it does not make one serial external LLM request faster.

## External jobs: provider-neutral protocol

Add a named job template to the spec, then grant it to the agent:

```json
{
  "jobs": {
    "experiment": {
      "adapter": {
        "argv": ["/usr/bin/python3", "/opt/future-code/research-job-agent.py", "--root", "/srv/research/job-spool", "--config", "/opt/research/job-template.json"],
        "files": ["/opt/research/job-template.json"]
      },
      "idempotentEnsure": true,
      "pollMs": 30000,
      "staleMs": 900000,
      "reconcileAfterMs": 2700000,
      "maxJobs": 4,
      "maxConcurrent": 1
    }
  }
}
```

This is a fragment to merge into a complete spec. Also include `"run_job"` in the
agent's tools and `"jobs": ["experiment"]` in that profile. `maxJobs` counts all
jobs for a run/template, including failed jobs. `maxConcurrent` is shared among
runs of the template in one Store. It is not an organization-wide quota across
different roots. Unknown outcomes retain their capacity reservation.

The tool call is structured data:

```json
{"name":"run_job","arguments":{"name":"experiment","input":{"seed":7,"datasetVersion":"reviewed-version"}}}
```

The runtime persists the stable key and input binding before the RPC. The first
operation is `ensure(key)`; a lost reply repeats the SAME key. Once the returned
job ID is known, only `inspect` is sent, including after timeouts/not-found.
Adapters must really implement remote deduplication; the flag alone cannot make
an arbitrary submit endpoint safe. The supplied Python endpoint implements this
with durable records, atomic writes and a per-job execution lock.

A queued/running job saves the pending tool call and releases the local task slot.
Other independent agents can proceed. Polling is deterministic code, not model
reasoning, and does not repeatedly charge tool/model turns. `staleMs` marks a
job visibly stalled; `reconcileAfterMs` (default: three times `staleMs`, capped
at seven days) stops indefinite automatic polling and requires explicit operator
reconciliation. While a job has an unresolved remote outcome, objective-level
replacement planning is suppressed so a new run cannot accidentally duplicate
expensive external work. On a terminal reply, the original worker resumes with
the result receipt. A successful process exit is
not proof of a valid scientific result: task/final checks must validate metric,
configuration, dataset, checkpoint and artifact identities appropriate to the
experiment. The baseline artifact type is still a code patch plus receipts, not a
complete experiment-tracking product.

## Deploy the endpoint over SSH

Use `examples/swarm/supervised/remote-template.json` for the trusted remote
executable template and `remote-capability.json` for a sample SSH adapter. Replace
ALL paths/host values. Deploy `scripts/research-job-agent.py` and the template on
the remote machine yourself; this patch does not upload files or consume compute.

Configure BatchMode, explicit connection timeout, an explicit SSH config/key and
known-hosts file, and server-alive options. Preserve host-key checking. The host
subprocess deliberately uses a temporary HOME and does not automatically inherit
your normal SSH agent/config or model credentials. Put only necessary explicit
capabilities in `envAllow`; do not forward model keys to job/check processes.

The SSH adapter forwards one JSON request on stdin to the fixed endpoint and
receives one JSON reply. Model-provided `input` is never interpolated into the
shell command. The remote executable receives input via stdin and the path in
`FUTURE_JOB_INPUT_PATH`. It can atomically write `{"sequence": <step>}` to
`FUTURE_JOB_PROGRESS_PATH`; use a real completed stage/step, not wall-clock time.
The job key is available as `FUTURE_JOB_KEY`.

To resolve an UNKNOWN/stalled job after inspecting the remote scheduler, provide
a terminal adapter-shaped reply and bind it explicitly:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts job-reconcile \
  --root .future-code/rnd --run RUN_ID --job-key JOB_KEY \
  --resolution /absolute/path/reconciled-job.json --allow-exec
```

The resolution must preserve the immutable job key and job ID and use
`SUCCEEDED`, `FAILED`, or `CANCELLED`; successful reconciliation must include
the result payload. This operation records evidence and never submits remote work.

The endpoint preserves only bounded stdout/stderr tails. Large logs, checkpoints
and datasets belong in your own artifact storage. They are not automatically
transferred into a local Git worktree. Likewise, local patches are not magically
synced to remote compute: the trusted wrapper must stage and verify the intended
code/data version, using the declared inputs. For Slurm/Kubernetes/other schedulers,
implement the same ensure/inspect contract with that scheduler's stable job IDs.

The supplied endpoint runs a detached POSIX process under a trusted template. It
is not a VM/container sandbox and does not survive machine reboot by continuing
the process. A lost worker lock yields `UNKNOWN`, not a fabricated failure or
success, and NEVER starts a second experiment for that key. The operator must
reconcile lost remote workers or use a durable external scheduler adapter.
A local supervisor stop does not cancel remote compute. A remote job has its own
hard deadline; direct job cancellation/restart APIs are not implemented here.
Remote disk loss, malformed records or adapter identity drift require explicit
reconciliation rather than blind retries. RPC exit 64 marks that condition.

No aihuanxin.cn-specific API, authenticated SSH session or real accelerator was
used or tested. The implementation is intentionally generic.

## Unattended process supervision

The CLI is not a self-installing daemon. A user-managed service can relaunch the
same objective after process failure. Example policy (paths/account must be set):

```ini
[Unit]
Description=Future Code reviewed R&D objective
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/future-code
ExecStart=/absolute/path/node --experimental-strip-types /srv/future-code/src/harness/foundry/swarm/cli.ts supervise --root /srv/state/rnd --objective research-objective-001 --allow-exec
Restart=on-failure
RestartSec=35
RestartPreventExitStatus=130
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

Initialize/register the objective first. Review provider credentials and service
permissions using your normal secret management. An explicit service stop should
remain stopped. Successful objective completion exits normally, so it is not
restarted. No such service was installed during patch authoring.

## Storage, performance and rollout

New SQLite tables are additive; task acceptance, frozen plans and request ledgers
remain. DEFERRED episodes advance fencing identities without consuming the
implementation-failure budget; failures/expired episodes still count. Deferrals
still occupy disk and carry measurable usage. Status polling and deferred attempt
history can grow over long runs; monitor state disk and choose realistic intervals.
Do not share SQLite state on a network filesystem or assume this implements a
multi-host control plane. This remains the existing single-host scheduler.

Default reporting is available on the Swarm CLI. Meaningful-progress deadlines,
checkpoint checks, snapshot reads and remote jobs require explicit configuration.
An initialized root is immutable: use a fresh root for a different configuration,
not manual database edits. Back up state first. Do not roll back the executable
while new deferred runs/jobs remain active: an older runtime does not understand
the new continuations even though extra tables are harmless at rest.

Recommended rollout: focused tests -> demo -> a small held-out real task under
fixed model/quality/resource settings -> an interrupted remote-job canary -> wider
workload. Measure total time to accepted integrated output, requests, cost,
rework, human interventions and duplicate remote jobs. No live-model speedup is
claimed by this patch.

## Design sources

- Anthropic, Effective harnesses for long-running agents:
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  Incremental progress, recoverable handoffs and explicit acceptance evidence.
- OpenAI, open-source Codex orchestration with Symphony:
  https://openai.com/index/open-source-codex-orchestration-symphony/
  Goal-oriented supervision, isolated work and reconciliation rather than endless
  manager chat. This patch does not embed Symphony or claim its performance.
- Anthropic, Managed Agents events and streaming:
  https://platform.claude.com/docs/en/managed-agents/events-and-streaming
  Distinguish durable state, progress presentation and explicit paused states.

These sources motivate the design; local tests establish only the behavior
reported in the separate verification report, not universal productivity gains.

## Host-owned objective completion

Future-Code treats external LLMs as replaceable workers, not as the authority that decides
whether an R&D objective is complete. A stronger Claude, Codex, Gemini, Qwen, or other
API should improve execution quality without changing the control-plane trust boundary.

The attached objective supervisor now applies an independent completion gate after the
task scheduler reports `PASS` and again after final integration:

- every admitted task must have durable accepted artifact and verifier evidence;
- unresolved strong contradictions in Evidence Fabric block objective completion;
- final integration checks remain mandatory and immutable;
- a successful objective writes a content-addressed completion attestation binding the
  objective goal, pinned configuration, current plan, full recovery lineage, evidence
  gate result, and integration receipt;
- provider text, an agent's self-report, a session ending, or a planner decision can
  never create that attestation.

This boundary is intentionally model-agnostic. Future-Code may route work to better
external models as they appear, but it continues to own persistence, budgets, external
effect reconciliation, evidence, verification, recovery, and the final completion
decision. The product therefore does not depend on a particular model remaining weak.

