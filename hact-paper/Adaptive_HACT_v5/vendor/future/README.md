# Future Code Control Plane 1.2.0

**Bounded hierarchical task mesh: many cooperating agents without one global LLM transcript.**

> **Scope of this delivery:** the supplied `future-code-V1.0-src.zip` is truncated. Its
> central directory and original application entrypoint are missing. Only 64 regular
> files and 12 directories could be recovered with valid checksums; another file is
> incomplete. This package is a new control-plane implementation, NOT a rebuilt or
> fully upgraded original TypeScript application. The original terminal UI and its
> missing tools are not included. A generic bridge can call a separately installed CLI.

## What changed in 1.2.0

Hierarchy for ownership; a scoped shared board for collaboration; deterministic code
for dispatch, leases, counters and reports. Every native request has a measured 16 KiB
default UTF-8 input ceiling. Coordinators handle at most eight direct children by default,
yield their worker slot while waiting, and resume with a fresh local context. Paged
result/evidence reads and bounded durable notes preserve access to needed detail.

The release exercises **512 leaves + 73 integrators, 64 concurrent worker slots** with a
scripted model and real runtime. This is an orchestration test, not proof of hosted-model
reasoning, speedup or software quality. See [TEST_REPORT.md](TEST_REPORT.md).

Read [the research note](docs/RESEARCH.md), [implementation/operator guide](docs/HIERARCHICAL_COORDINATION.md)
and [upgrade procedure](docs/MIGRATION.md) before using the new task hierarchy.

## Start here

Requires Python 3.11 or newer. Actual execution in this release was on Linux / Python
3.13.5; other platforms and interpreter versions need their own acceptance run.

```bash
python -m venv .venv
# Linux/macOS:
. .venv/bin/activate
# Windows PowerShell instead: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.lock
python -m pip install .
future-control --version
python examples/demo.py --output /tmp/future-control-demo
python examples/hierarchy_demo.py --output /tmp/future-control-hierarchy --leaves 512 --workers 64
```

Use an **empty** directory for the demo; it refuses to overwrite existing work. On
Windows, use a local path such as `C:\Temp\future-control-demo` instead of `/tmp/...`.
Package installation needs package-index access or a pre-populated local wheelhouse.
The release was installed and tested offline against the supplied environment's
already-installed dependencies; a fresh public-index installation was not tested.

The demo uses a local, scripted HTTP server, **not an LLM**. It exercises a real
connection, an injected 503, reconnect/retry, parallel delegation, a deliberately bad
code change, a failing executable test, correction, and final integration. It makes
no paid API calls. Inspect `/tmp/future-control-demo/.future-code/reports/` afterward.

For a read-only dashboard:

```bash
future-control --project /tmp/future-control-demo serve --port 8765
# Open http://127.0.0.1:8765 in your browser.
```

The demo deliberately stops its supervisor when complete, so its last supervisor
state is `STOPPED`; completed task and gate evidence remain visible. Set
`FUTURE_CODE_DASHBOARD_TOKEN` for Bearer authentication when using an HTTP client or
an authenticated local proxy. A normal browser cannot add a Bearer header by itself.

## Use your own model and project

Run first in a disposable copy or branch. Back up valuable source; configured
commands are trusted programs and the Python workspace is not an OS sandbox.

```bash
future-control --project /path/to/project init
# Edit /path/to/project/.future-code/config.json:
#   endpoint.url: exact /v1/chat/completions URL
#   endpoint.model: the actual served model ID, not an assumed default
#   endpoint.api_key_env: FUTURE_CODE_API_KEY
#   endpoint.health_url: optional, same-origin non-billable health route
#   gates: trusted executable test commands for YOUR project
#   required_gates: mandatory checks per software/ml/research profile
# Supply FUTURE_CODE_API_KEY through your shell or secret manager, not source files.
future-control --project /path/to/project doctor --probe
future-control --project /path/to/project submit /path/to/tasks.json
future-control --project /path/to/project run
```

`examples/http-config.json` and `examples/tasks.json` are editable examples, **not
credentials or a pre-verified endpoint**. The supplied `unit` gate runs unittest
with a nonempty-test check; configure stronger project-specific tests before release.
The model must follow the documented JSON-action protocol. No model ID, endpoint
flavor, tool-calling behavior, or real provider performance is implicitly certified.

`run` stays alive when idle or waiting for external recovery. It **does not** invent
new objectives, exceed configured budgets, defeat cancellation, ignore authentication
failures, or deploy changes to production. `run --until-idle` is explicit one-shot mode
and may exit with retry-wait or blocked tasks still present.

## What the implementation does

| Capability | Implemented mechanism | Boundary |
|---|---|---|
| Self-monitoring | Durable supervisor/worker leases, progress timestamps, disk checks, endpoint observations, incidents | Not a guarantee of detecting every bug or OS failure |
| Self-correction | Rejected-action feedback, executable-gate failure feedback, revised candidates, checkpoint resume | Repeated faults, exhausted budgets and unsafe recovery block for an operator |
| Collaboration | Bounded hierarchy, scoped board/messages, paged descendant results, replace-only notes, per-cell fair share | Distributed cognition; single-host execution service, not multi-host HA |
| Parallel work | Configurable 1-256 slots; independent task execution; serialized verified integration | Exercised up to 64 slots and 585 logical tasks using scripted responses; higher concurrency unverified |
| Recovery | SQLite WAL, fences, request reservations, staged files, authenticated commit journal | Multi-file updates are recoverable, not filesystem-wide atomic transactions |
| External connections | HTTP pooling, bounded reads, timeout, jitter/backoff, cooldown, one half-open probe, optional health polling | Supports configured HTTP and CLI adapters, not arbitrary MCP/WebSocket/SSH connectors |
| Reporting | Thirteen fixed tables in JSON, Markdown and HTML; read-only HTTP status, metrics and health routes | Operational facts come from state, not model-written tables |
| Quality | Trusted executable gates, protected acceptance paths, input hashes, optional separate model reviewer | A PASS proves the named check only; model review is advisory |
| AI/research operations | Domain rules and strict experiment/research evidence-manifest validation | No real accelerator, training job, scientific result or held-out model quality was evaluated |
| Hygiene | Per-attempt staging, successful workspace cleanup, ownership checks, suspicious-file/conflict-marker scan | User source is never auto-deleted; failed workspaces and evidence require reviewed retention |

The fixed tables are **System, Tasks, Agents, Connections, Dependencies, Quality,
Incidents, Artifacts, Budget, Hygiene, Hierarchy, Contexts, Mailboxes**. Table order and columns do not change because
a model chooses a different answer style. Missing measurements remain `UNKNOWN`;
stale observations carry freshness labels. Monetary cost is `UNKNOWN` without a
billing integration. Token reservations are conservative estimates, not measured usage.

## Operator commands

```bash
future-control --project /path/to/project status
future-control --project /path/to/project status --json
future-control --project /path/to/project status --watch --interval 5
future-control --project /path/to/project pause
future-control --project /path/to/project cancel TASK_ID
future-control --project /path/to/project inspect TASK_ID
future-control --project /path/to/project retry TASK_ID --reason "diagnosis and changed condition"
future-control --project /path/to/project resume --reason "review complete"
future-control --project /path/to/project events --limit 30
future-control --project /path/to/project cleanup                  # dry run
future-control --project /path/to/project cleanup --apply          # owned eligible workspace only
future-control --project /path/to/project stop
```

Pause stops **new dispatch** and lets current work drain. Cancel stops the specified
worker and delegated descendants where safe. Stop requests graceful daemon shutdown.
Blocked tasks require explicit retry with a reason; resume alone does not reset them.
Request/token budgets persist across restarts and are not reset by task retries.

## Verification and package integrity

```bash
python -m pip install -r requirements-dev.lock
python scripts/check_source.py
python -m pytest -q --cov=future_code --cov-branch
python scripts/release.py verify --root . --manifest RELEASE-MANIFEST.json
```

See [TEST_REPORT.md](TEST_REPORT.md) for executed commands, counts, coverage and
explicit untested items. Passing local tests is not a production certification or
proof that the original application works. No third-party lint, static type-checker, vulnerability audit or independent security review is claimed.

## Navigation

| File | Purpose |
|---|---|
| [docs/RESEARCH.md](docs/RESEARCH.md) | Primary-source research and architecture tradeoffs |
| [docs/HIERARCHICAL_COORDINATION.md](docs/HIERARCHICAL_COORDINATION.md) | Hierarchy compiler, bounded contexts, scoped collaboration and scale demo |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | State machine, leases, collaboration, action protocol, recovery |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deployment, outage, auth, disk, budget, incident and backup runbooks |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, allowed actions and sandbox limitations |
| [docs/DOMAIN_PROFILES.md](docs/DOMAIN_PROFILES.md) | Software, ML and research acceptance contracts |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Truncated-source assessment and optional installed-CLI bridge |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | Delivery contract and authority boundary |
| [provenance/recovery.json](provenance/recovery.json) | Original archive checksum and per-entry recovery inventory |
| `.ai-loop/` | This release's durable engineering decisions and verification state |
| `evidence/` | Executed tests and illustrative local demo reports |

No production deployment, external account writes, hosted model calls or credential
changes were performed as part of this delivery.
