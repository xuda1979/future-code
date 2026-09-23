# Future Code Harness Foundry

## Scope and entrypoint

This is an additive, opt-in single-host implementation under
`src/harness/foundry/`. It does not replace or modify the older
`src/harness/cli.ts`, its automatic improver, the mirrored CLI snapshot,
or HACT. Use the new entrypoint for the governed lifecycle below.
No legacy manifest is silently migrated or treated as an approved contract.

The runtime implements a project-local harness registry, immutable contracts,
versioned operating recipes, a durable dependency scheduler, bounded context
capsules, independent verification, event inspection, matched candidate
experiments, explicit promotion, and rollback. The example is a deterministic
code-artifact fixture, not a live LLM or a productivity benchmark.

## Requirements

The tested path is Node 22.16.0 on Linux, using built-in `node:sqlite` and
TypeScript type stripping. Use Node >=22.13 for that path. No package install
or change to the repository's dependency lockfile is needed to run it.
SQLite and type stripping may emit experimental-feature warnings on Node 22.

The store also selects `bun:sqlite` when invoked with Bun. That compatibility
path was implemented but not executed in the patch-authoring environment.
The full upstream suite and Windows process-tree behavior were not tested.

## Start with the included offline fixture

Run these commands from the repository root:

```sh
node scripts/test-foundry.mjs
node --experimental-strip-types src/harness/foundry/cli.ts init --spec examples/foundry/spec.json
node --experimental-strip-types src/harness/foundry/cli.ts run --tasks examples/foundry/tasks.json --allow-exec
node --experimental-strip-types src/harness/foundry/cli.ts status
node --experimental-strip-types src/harness/foundry/cli.ts events
```

Initialization pins the executable and declared implementation files, creates
`.future-code/foundry/state.sqlite`, and records a contract plus the first
admitted recipe. Run outputs and verification proofs are content-addressed
under `.future-code/foundry/artifacts/`. Keep this directory private and out of
source control. `init` refuses to overwrite an initialized harness. Use a
separate `--root DIR` for another project or experiment.

`status` and `events` read state; neither launches a test or calls a model.
`events --after SEQUENCE` paginates the durable event history. On cancellation,
the CLI prints the run ID; use `resume --run ID --allow-exec` to continue the
same pinned task graph and recipe. Expired attempts are retried only within the
frozen attempt ceiling. Failed dependencies block their descendants.

## Propose, evaluate, and promote

```sh
node --experimental-strip-types src/harness/foundry/cli.ts propose --changes examples/foundry/candidate.json
node --experimental-strip-types src/harness/foundry/cli.ts evaluate --candidate CANDIDATE_HASH --protocol examples/foundry/protocol.json --allow-exec
node --experimental-strip-types src/harness/foundry/cli.ts inspect --evaluation EVALUATION_ID
node --experimental-strip-types src/harness/foundry/cli.ts promote --evaluation EVALUATION_ID --confirm
node --experimental-strip-types src/harness/foundry/cli.ts rollback --to PREVIOUS_ADMITTED_HASH --confirm
```

Substitute the IDs returned by the preceding commands. A rejected or unknown
evaluation deliberately exits with status 2 and does not change the active
recipe. Promotion requires a complete persisted experiment, unchanged task
and recipe bindings, intact artifacts and verification evidence, all tasks
passing in both arms, and the predeclared relative improvement threshold.
Receipts are consumed; rollback does not make an old receipt reusable.
Running tasks remain pinned when the active recipe changes.

The frozen protocol identifies the task set, environment, repetition count,
objective, and minimum gain. Baseline/candidate execution order alternates.
All attempts, including failures and verifier work, contribute to reported
cost when the trusted adapter supplies a complete measurement. Evaluation
runs and rejected candidates stay in the ledger; development/evaluation spend
must be included separately in a deployment break-even calculation.

This is a local engineering admission check, not a confidence interval,
statistical significance test, hidden-holdout service, or production canary.
The demo deliberately has fixed waits, so any measured time improvement
illustrates scheduling only. Use genuinely held-out projects and an appropriate
sample-size/uncertainty protocol before claiming general productivity gains.
Failure recovery is not labeled an efficiency improvement: this first release
requires both arms to pass the fixed quality contract.

## Bounded self-improvement

After at least three successful recorded runs with independent ready tasks,
`suggest` may propose one more worker, up to the contract's ceiling:

```sh
node --experimental-strip-types src/harness/foundry/cli.ts suggest
node --experimental-strip-types src/harness/foundry/cli.ts evolve --protocol examples/foundry/protocol.json --allow-exec
```

`evolve` performs suggestion plus evaluation but does not promote by default.
`--auto-promote` explicitly authorizes promotion only if that evaluation admits
the candidate. A null suggestion, missing cost evidence, or failed comparison
never becomes a successful change. This is rule-based recipe optimization,
not arbitrary runtime rewriting, model training, or open-ended code evolution.

Only `parallelism`, `attempts`, `contextBytes`, and `timeoutMs` are mutable.
A candidate cannot delete a required check, relax an SLO, replace the verifier,
raise the contract's resource ceilings, or modify the acceptance conditions.
An authorized contract revision needs a new harness root and a new baseline.

## Connect an actual coding agent

Use a trusted command wrapper implementing the protocol, or implement the
exported `Driver` host interface. The runtime does not guess your existing
coding CLI's flags, streaming format, model endpoint, or authentication scheme.

Worker stdin is one JSON object:

```json
{"kind":"execute","capsule":{"schema":1,"runId":"...","task":{"id":"...","goal":"...","acceptance":["..."],"dependencies":[],"writeScope":["src/module.ts"],"input":{}},"contractHash":"...","recipeHash":"...","fence":1,"dependencies":[]}}
```

Worker stdout must contain exactly one JSON object:

```json
{"artifact":{"patch":"your unified diff, or another verifiable result"}}
```

The independently configured verifier receives `kind: "verify"`, the capsule,
artifact, and host-computed `artifactHash`. It returns:

```json
{"artifactHash":"the supplied hash","checks":[{"id":"behavior","verdict":"PASS","detail":"the independently executed checks"}]}
```

For real coding work, the verifier should apply the patch to an isolated pinned
checkout and run independently maintained checks. The current runtime stores
accepted artifacts; it does not apply or merge them into the user's checkout.
A git-worktree executor and serialized integration queue are separate adapters
to implement and validate before granting repository-write authority.

Use an absolute executable path or `$RUNTIME` in command specifications.
Arguments starting `./` resolve from the repository root at initialization.
List all relevant implementation/dependency-lock files in `files`; direct
absolute file arguments and the executable are automatically pinned. A changed
pin causes failure, not silent adoption. Add only necessary credentials to
`envAllow`; they are read from the invoking environment, not written into the
specification. Loader-injection variables are not allowed. This pinning is
an integrity check on declared local files, not complete dependency attestation.

The generic command adapter ignores token/cost figures emitted by the child.
It reports these as `null`, so it can evaluate latency but cannot claim dollar
or token savings. To optimize those objectives, implement a trusted host-side
provider meter in `Driver.execute` and `Driver.verify`. Include all retries,
reviewer calls, cached-token accounting, and actual provider charges. Missing
measurement remains unknown; failed calls with unknown billing make the run's
aggregate unknown. There is no hard provider-spending enforcement in this MVP.

## Execution and context guarantees

SQLite `BEGIN IMMEDIATE` transactions enforce per-run concurrency, dependency
readiness, logical overlapping-write-scope exclusion, and fencing across
coordinators sharing the same local database. Leases have fixed deadlines;
late completions cannot overwrite the current owner. Task results are checked
again at admission and proof bindings are rechecked at recipe promotion.
Artifacts are fully written and fsynced before their metadata can become PASS.
The event history is stored outside agent context and never truncated to keep
a prompt short.

Each worker gets a fresh task capsule, including only its mandatory task and
verified dependency artifacts. UTF-8 byte budgets are enforced exactly; they
are not billed token counts. Oversized mandatory context fails explicitly and
requires decomposition or an admitted larger budget; it is never silently
truncated. Context retirement is implicit at task boundaries. Selective
retrieval, semantic compression, automatic task splitting, and learned model
routing are not implemented in this release.

## Trust boundary and operational limits

The kernel, database, host adapters, and verifier are trusted. Do not expose
`Store`, SQL access, `Scheduler.finish`, or promotion authority to an LLM.
Commands run in disposable private working directories with a restricted
environment and bounded captured output. This is NOT an OS/container sandbox:
a malicious executable running as the same user can still access host files,
network resources, or the database. Logical write scopes do not enforce
filesystem permissions. Use process/container isolation with separate identities,
network restrictions, and scoped credentials before accepting untrusted agents.
The demo verifier's `vm` use is also not a security boundary.

POSIX cancellation kills the process group; the Windows fallback uses
`taskkill /T /F` and requires separate target-platform verification. Custom
adapters must cooperate with AbortSignal to release resources; fencing protects
acceptance but cannot forcibly stop arbitrary in-process JavaScript.

This is a single-host scheduler, not distributed consensus or a global
cross-project worker pool. SQLite WAL should reside on local storage, not a
shared network filesystem. Capacity is limited per run; different runs need
an external global quota until a pool manager is added. The scheduler currently
scans a run's task rows, so benchmark larger graphs before scaling it further.
No live-model efficiency, multi-tenant security, or production readiness claim
is implied by the tests.

## Validation and synthetic scale exercise

```sh
node scripts/test-foundry.mjs
node --experimental-strip-types scripts/stress-foundry.mjs 1000
```

The tests cover contract validation, missing evidence, false success, immutable
lineage, scopes, independent database connections, lease expiry, stale results,
retry accounting, context overflow, timeout/cancellation, command output limits,
pin tampering, promotion/rollback, and independent verification. The stress
script checks 1,000 synthetic DAG tasks with eight worker slots. It is not
1,000 simultaneous LLM agents or a measured token-saving experiment.

To remove this additive implementation after stopping its processes, reverse
the patch with `git apply -R`. That does not delete project state; preserve the
SQLite database, WAL/SHM companions, and artifacts when taking a consistent
backup, or use SQLite's backup facilities. Never delete the only evidence copy.
