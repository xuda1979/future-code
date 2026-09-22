# future-code: Adaptive Agent-Management Platform

**Status:** design v0.1 (this session) | **Runtime:** TypeScript / Bun

---

## 1. Objective

`future-code` is a **large-scale agent management system framework** that is
**adaptive, flexible, self-improving, and self-monitoring.** It plays two
connected roles at once:

1. **Platform / runtime** — the framework the per-project harness runs on
   (execution, orchestration, context, monitoring, iteration).
2. **Harness-builder** — when you run `future-code` on a project, it *develops
   and improves a harness system **inside** that project*: a **customized
   harness** tailored to that specific project.

The generated, project-specific harness is itself **adaptive, flexible,
self-improving, and self-monitoring.** `future-code` is therefore both *where*
the harness runs and *what builds* the harness.

> The framework itself self-applies: future-code builds/runs/improves the
> harness that future-code itself uses — a closed, self-hosted loop.

---

## 2. Core vocabulary

| Term | Meaning |
|---|---|
| **Platform** | The `future-code` framework (runtime + builder). |
| **Target project** | Any codebase `future-code` is pointed at. |
| **Harness** | The project-local, generated system that runs/verifies/improves work in the target project. |
| **Harness manifest** | Declarative config describing one harness (its tools, gates, monitors, loops). |
| **Self-improvement** | The harness measures its own effectiveness and updates its own configuration/rules. |
| **Self-monitoring** | The harness continuously observes its own health/cost/quality and reports regressions. |

---

## 3. Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │            future-code PLATFORM               │
                 │  (meta: builds & runs the project harness)    │
                 └───────────────────────┬──────────────────────┘
                                         │  harness-dev loop
                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │                 PROJECT-SPECIFIC HARNESS                │
        │   (generated into <project>/.future-code/harness/)      │
        │                                                        │
        │   ┌──────────┬──────────┬──────────┬────────────────┐   │
        │   │ Runtime  │ Context  │ Monitor  │ Improver       │   │
        │   │ gate/run │ mgmt     │ (SLOs)   │ (self-update)  │   │
        │   └──────────┴──────────┴──────────┴────────────────┘   │
        └────────────────────────────────────────────────────────┘
```

### 3.1 Platform layers

1. **`src/harness/` — platform submodules**
   - `types.ts` — core interfaces (Manifest, HarnessSpec, Command, Gate, Monitor, Improver).
   - `registry.ts` — discovers/generates/loads project harnesses via a manifest.
   - `builder/` — the *harness-builder*: templates + customization to scaffold a per-project harness.
   - `runtime/` — loads and executes a harness against the target project (the platform as runtime).
   - `tools/` — built-in tool/gate executors the harness can reference (bash, file, test, search).

2. **Loop primitives (self-*)**
   - **Self-monitor** — health/cost/quality metrics emitted per run; SLO checks.
   - **Self-improve** — an improver reads metrics + a policy and rewrites the harness manifest / rules.
   - **Self-adapt** — runtime picks configurations (e.g. parallelism, context budget, toolset) from measured conditions.

3. **Entrypoint** — a new CLI subcommand `future-code harness <build|run|monitor|improve>`.

### 3.2 The generated harness (self-* target)

A generated harness is a small, self-contained TypeScript bundle plus a
manifest, living under `<project>/.future-code/harness/`:

```
<project>/
└── .future-code/
    └── harness/
        ├── harness.json        # manifest (adaptive config)
        ├── dist/index.js       # compiled run loop (platform executes this)
        ├── monitors/           # SLO definitions + metric emitters
        └── history/            # run logs, metric series, improvement decisions
```

It includes:
- **Run loop** — read task → apply tools/gates → record outcomes.
- **Gates** — acceptance checks (e.g. `pytest`, `bun test`, custom verify). HACT
  certificate evidence is an **optional pluggable gate**; not required.
- **Monitors** — cost, pass rate, latency, flakiness; emit structured metrics.
- **Improver** — rules that tune the harness (which gates run, parallelism,
  context budget, toolset) and, when justified, propose human-reviewed changes.

---

## 4. Self-* loop (the heart)

```
   scribe (write: draft scaffold tests for uncovered modules,
           validate in isolation, promote or quarantine)
        │
        ▼
   run ──► record metrics ──► monitor (SLO ok?)
                ▲                    │ no
                │                    ▼
        update manifest ◄── improver (propose change + rationale)
```

The full loop is **plan → write → run → monitor → improve**. The scribe is
the *write* half: the harness no longer only runs pre-defined gates, it
authors code (scaffold tests) itself. Scribe rules:

- **Deterministic:** scaffolds are derived from the module's exports —
  no LLM, no network; the same module always yields the same test.
- **Nothing broken ships:** every scaffold validates in an isolated copy
  of the source tree through the project's real test runner *before* any
  file enters the project; failures quarantine (with output retained),
  never promote.
- **Bounded:** the write-phase stays inside `config.scribeRoot` (the
  harness scope); its planning context is budget-truncated like every
  agent's; the audit trail (`manifest.scribeLog`) is bounded like
  `improvementHistory`.
- **No vacuous output:** type-only modules (which would yield a
  `true === true` tautology) are skipped, not scaffolded.

- **Adaptive:** runtime selects among harness configurations from live
  conditions (not hardcoded).
- **Flexible:** harness is generated/customized per project; gates/tools are
  pluggable.
- **Self-improving:** the improver changes the harness and validates the change
  against a retained baseline before adopting.
- **Self-monitoring:** SLOs with clear regression signals; failures retained, not
  silently dropped.
- **Self-writing:** the scribe drafts, validates, and promotes scaffold tests
  for uncovered modules — the harness extends what it measures.

**Honesty guardrails** (from our own review discipline):
- Metrics and claims are measured, not assumed.
- Improvements require a matched-quality comparison against the prior
  configuration; cost is counted, not hidden.
- Delete nothing irreplaceable; keep history and rationale for every change.
- Every scribe action is audited: promote, quarantine, and skip decisions
  carry their rationale in `scribeLog`.

---

## 5. Build/run model (how step b works)

`future-code` **is** the harness-builder (b). Running it on a project:

1. `future-code harness build` — analyze project (language, test runner, entry)
   → generate `<project>/.future-code/harness/` from templates + a manifest.
2. `future-code harness run "<task>"` — platform loads the harness and executes
   the run loop, applying gates and monitors.
3. `future-code harness monitor` — report SLO/metric series; flag regressions.
4. `future-code harness improve` — run the improver: propose + apply + validate
   manifest changes; keep an audit trail.
5. `future-code harness log` — view run history and improvement decisions.

The platform loops (run→monitor→improve) are the same ones the harness itself
uses, so future-code and every project harness share one self-improving pattern.

---

## 6. Scope for this session (deliverables)

Phase 1 (now):
- `docs/agent-platform/DESIGN.md` (this doc) ✅
- `src/harness/types.ts` — core interfaces
- `src/harness/registry.ts` — manifest load/save + discovery
- `src/harness/builder` — templates + `build(targetProject)` scaffold generator
- `src/harness/runtime` — `run(manifest, task)` loop with a minimal gate + monitor
- `src/harness/monitor` — metrics + SLO evaluation
- `src/harness/improver` — a first, rule-based improver with audit trail
- `src/harness/scribe` — the write-phase: deterministic scaffold tests for
  uncovered modules, validated in isolation, promoted or quarantined, fully
  audited in `manifest.scribeLog`; bounded by `config.scribeRoot`
- `src/harness/cli.ts` — `harness build|run|monitor|improve|log|scribe` subcommands
- `tests/harness/` — unit tests for builders/runtime/monitor/improver
- A **self-applied example**: build a harness for the future-code repo itself. ✅
  `bun src/harness/cli.ts selfapply` converges the repo's own ~200s test
  suite from a fresh harness in a single invocation (3 iterations: 60s kill →
  widen to 120s → 120s kill → widen to 240s → suite completes healthy).
  With the scribe, the loop is plan → write → run → monitor → improve:
  the write-phase drafted and promoted scaffold tests for previously
  uncovered platform modules (`tests/harness/registry.test.ts`,
  `tests/harness/builder/detect.test.ts`) before the run-phase measured
  them, skipped the mirrored research snapshot in `src/` via
  `scribeRoot=src/harness`, refused a vacuous scaffold for the type-only
  `types.ts`, and then converged healthy in 1 iteration (verified
  2026-09-22: `pass_rate: 1, scribeActions: 6`).

Later phases (not this session):
- HACT certificate gate integration (optional, pluggable).
- Parallel agent orchestration across projects; team/graph scheduling.
- Learned (vs. rule-based) improver after evidence justifies it.
- MCP/hosted-model integration and cost telemetry.

---

## 7. Non-goals / boundaries (honest)

- This is a research/prototype framework, not a production product.
- The improver's changes are rule-based and validated against a retained
  baseline; a learned controller is deferred until it demonstrably beats the
  deterministic policy net of training cost.
- `src/` also contains the mirrored Future Code CLI snapshot (security research).
  Our platform is a **separate, additive** module under `src/harness/` and does
  not modify that research snapshot's behavior.

---

## 8. Lifecycle framing: future-code is the home of the harness

`future-code` is the **single platform** in which the project-specific harness
is **born, built, maintained, and lives.** It is not a tool that hands off a
harness to somewhere else — every stage of the harness lifecycle stays inside
`future-code`:

| Stage | What happens | Where |
|---|---|---|
| **Born** | `future-code harness build` analyzes the project and generates the harness + manifest. | inside the project, under `<project>/.future-code/harness/` |
| **Built** | The builder customizes tools/gates/monitors from detected project cues; future-code compiles the run bundle. | inside future-code's builder + runtime |
| **Maintained** | The self-improver rewrites the manifest, keeps history, and validates changes against a retained baseline. | inside future-code's improver + registry |
| **Lives** | Every run executes on future-code's runtime; monitors watch it continuously; it is re-run, re-monitored, and re-improved in place. | inside future-code's runtime + monitor |

So the harness has no separate "production home": **its home is the
future-code platform**, which both hosts it and continuously improves it. A
project-specific harness never leaves future-code.

---

## 9. Velocity: future-code accelerates the harness lifecycle

Beyond *hosting* the harness, future-code exists to make the harness
**create, improve, and adapt faster.** The platform is a force-multiplier on
the harness development loop:

| Dimension | How future-code accelerates it |
|---|---|
| **Create faster** | Templated, cue-driven scaffolding: running `harness build` generates a tailored harness from project detection in one step, no hand-writing. |
| **Improve faster** | A self-improver that proposes + validates + records manifest changes automatically; the run→monitor→improve loop closes quickly and iteratively. |
| **Adapt faster** | Runtime reads live conditions and switches harness configuration (parallelism, gate selection, context budget) without a rebuild; the platform re-measures and re-tunes continuously. |

The measure of success is **time-to-effective-harness**: how quickly a
project goes from `future-code harness build` to a harness that is
monitoring, catching regressions, and improving itself. future-code's design
target is to minimize that time by making every lifecycle step scriptable,
measurable, and self-reinforcing.

This is also how the platform **self-applies**: future-code uses the same
accelerated loop on the future-code codebase itself, so the platform and its
harnesses improve together.
