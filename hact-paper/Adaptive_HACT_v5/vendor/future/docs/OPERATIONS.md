# Operations and recovery runbook

## First deployment

Use a disposable copy of the target project, a dedicated user and an external sandbox.
Keep a reviewed Git baseline or another backup. Initialize the runtime, configure the
actual model URL/ID and environment-variable names, then define executable acceptance
gates. Protect acceptance tests, policies and frozen evaluation inputs against edits.
Run the local demo, the full regression suite, and a very small real-provider canary
before enabling larger concurrency. The hosted canary was not performed in this release.

Start with 2–4 agents and bounded tasks; increase concurrency only while observing
provider throttling, CPU, memory, filesystem throughput, workspace size and test cost.
The runtime samples disk free space; OS/container CPU/RAM monitoring remains necessary.
Use a small deadline as a decomposition signal, not as permission to kill an expensive
remote training job and blindly duplicate it.

## Continuous mode and control

`run` keeps the process alive when the queue is empty or temporarily unavailable. It
does not manufacture work to look busy. Its work remains bounded by task deadlines,
step/attempt limits, project limits and persistent request/token reservations. Reported
states include RUNNING, IDLE, WAITING_EXTERNAL, WAITING_OPERATOR, WAITING_BUDGET,
WAITING_CAPACITY, PAUSED, STOPPING and STOPPED. Stale supervisor evidence becomes UNKNOWN.

`pause` drains current tasks without dispatching new ones. `cancel TASK` interrupts that
task and eligible descendants. `stop`, SIGINT or SIGTERM requests graceful shutdown;
POSIX subprocess groups are terminated and transports are closed. A service manager can
restart genuine crashes. Stopping the service manager is the definitive way to prevent
its restart policy from launching another instance. The template uses Restart=on-failure,
not a policy that deliberately defeats a successful administrative shutdown.

`run --until-idle` exits when no task can currently run, including cooldowns and blockers.
Its zero exit requires all stored tasks to be done; exit 3 means unfinished/non-done work.
A deliberate stop of continuous mode exits zero even when unfinished work was retained,
so the included on-failure restart policy does not defeat that stop. Genuine startup or
control-plane failures remain nonzero. Do not use one-shot mode as a continuous
outage-recovery service.

## Incident decisions

| Signal | Automatic action | Operator action |
|---|---|---|
| 429, 503, transport interruption | Save checkpoint; preserve request charge; cooldown/retry within budget | Check endpoint/quotas; avoid duplicating a remote side effect |
| 401/403 | Block affected task; AUTH_REQUIRED | Correct credentials outside source, restart daemon to reload and retry with a reason |
| TLS validation failure | Refuse insecure fallback; block | Correct trust chain/hostname through a reviewed deployment change |
| Repeated invalid model output | Feed rejection back within step budget; eventually block | Reduce task/context, confirm endpoint protocol/model ability |
| Executable gate FAIL | Do not commit; give concrete feedback for a changed candidate | Inspect failing evidence and preserve acceptance criteria |
| Conflicting root edits | Reject stale publication and bound regeneration | Coordinate writers; avoid editing the same scope outside the runtime |
| Expired native worker | Fence old worker; authenticate checkpoint before resume | Inspect repeated lease expiry and snapshot/hash workload |
| Expired/interrupted external CLI | Block, retain evidence | Inspect unknown side effects before explicit retry |
| Deadline/step ceiling | Block with a decomposition signal | Split task or approve a new bound after diagnosis |
| Disk below threshold | Cancel active work and stop dispatch; retain evidence | Reclaim unrelated safe storage or expand volume; do not delete active state |
| Budget exhausted | Stop dispatch, keep service/reporting alive | Review spending; deliberately increase config ceiling and restart; explicitly retry blocked tasks |
| Prepared integration after crash | Authenticate and roll forward, else pause/block | Reconcile changed files using journal and backups; never erase the DB to force progress |

Known incidents are retained even after a later success so the audit trail is not hidden.
After verifying resolution, use `resolve ISSUE_ID --reason 'evidence and diagnosis'`.
The configured limits are loaded at daemon startup, not hot-reloaded; restart after edits.
No incident severity automatically authorizes changing credentials, frozen tests or budgets.

## Project hygiene and retention

Successful private workspaces are removed automatically after their artifacts have been
recorded. Failed attempts and payloads remain for diagnosis. `cleanup` defaults to dry-run
and is limited to eligible, marked, owned workspace directories. It does not remove user
source, data, checkpoints, tests, failed workspaces or integration evidence. Its ownership
check fails closed if a marker is absent or wrong.

The hygiene scan reports oversized/unsupported files, suspected scratch artifacts and
conflict markers. It is not semantic dead-code analysis and does not safely distinguish
all valuable experiments from disposable code. Fixing those findings requires scoped,
reviewed tasks with acceptance tests. No blind `git clean`, recursive source deletion or
unreviewed mass formatting is performed.

Storage evidence is intentionally retained rather than silently rotated away. Monitor
volume growth. To archive a completed project, stop/drain first, back up the entire
`.future-code/` directory with its configuration and project revision, verify a restore,
then apply a reviewed retention policy externally. Do not copy only a live WAL database
file and assume it is a consistent backup; use SQLite's backup API or stop the writer and
copy its complete state. No backup automation is claimed in this release.

## Deployment templates

`docker/Dockerfile` builds an unprivileged image. `docker/compose.yaml` adds CPU/memory/PID
limits and no-new-privileges. Set PROJECT_PATH to a disposable project directory and an
API credential in your deployment secret mechanism. A container's 127.0.0.1 is the
container itself, not the host; configure the actual reachable model address. Read-only
rootfs means test dependencies must be built into the image or a scoped writable volume.
The dashboard is loopback-only; do not expose it as an unauthenticated public server.

`docker/future-control.service` is a systemd template. Edit User, paths, environment-file
location and resource limits before installing it. Neither template has been started in
this environment. Their compatibility, image supply chain and isolation must be tested
on your host; no automatic production deployment is included.

## Endpoint and observability scope

The HTTP adapter does not honor HTTP_PROXY/HTTPS_PROXY implicitly and does not implement
SSH, WebSocket, MCP server lifecycle, a persistent notification channel or model failover.
Keep-alive and health polling reduce avoidable reconnects but cannot force a peer to keep
a connection open. A stale READY observation is historical, not a current availability
promise. A health GET never proves model correctness or chat-format compatibility.

JSON events and the ten deterministic tables support machine consumption. The dashboard's
Prometheus endpoint exports task counts, current active agents and open incidents; richer
latency histograms, tracing, alert routing and billing require deployment integrations.
