# Cross-agent productivity evaluation for general R&D

Future-Code is a **project-agnostic** R&D runtime. The benchmark runner takes an
operator-supplied repository, pinned commit, scoped work tasks and independent
acceptance checks. No model-training pipeline, scientific domain, hardware
provider, or research repository is embedded in the runtime.

## Self-contained smoke fixture

The fixture generator copies intentionally defective research utilities into a
new standalone Git repository, commits the source, and writes a valid manifest
with that exact source commit:

    node scripts/prepare-agent-comparison-fixture.mjs --out /tmp/rnd-benchmark-setup

It contains four domain-neutral R&D failure patterns:

- verification metric counting non-boolean successes;
- artifact/experiment manifest missing provenance checks;
- incomplete generated candidates silently falling back to references;
- retrying the same external experiment and resubmitting it.

The independent verifier lives **outside** the generated Git repository; all
four cases are initially RED and pass when the relevant utility is repaired.
The fixture has no dependence on accelerator availability or project-specific
packages. It tests benchmark mechanics, **not** the performance of an R&D agent
on multi-day experiments.

## Live comparisons

Edit the generated config to specify **real installed and configured agents**.
The three adapter argv values are **deliberate placeholders** and will not
execute until replaced. Each adapter receives the frozen prompt path and isolated
worktree path, must edit *only that worktree*, and exits nonzero on failure.

    node scripts/compare-agent-productivity.mjs \
      --config /tmp/rnd-benchmark-setup/config.json \
      --out /tmp/rnd-benchmark-trials

Use the same models and compute when isolating harness quality; a separate
best-product comparison can use different models with model identities disclosed.
Give all agents the same prompt, input, allowed files, verifier and time/budget.
Include startup, orchestration, tool use, verification, and repair in wall time.
Track tokens and invoice-backed cost separately, since the current runner does
not independently authenticate external API billing.

## Evaluate a different R&D project

**No modifications to Future-Code are needed.** Copy the generated manifest
outside the repository, change "repository" and "baseCommit" to your own clean
Git checkout and commit, and replace "cases" with externally authored, frozen
R&D objectives, checks, scopes and red-control markers. Keep the independent
checker outside each agent's worktree and do not give agents write access to it.
Any domain-specific datasets or acceptance harnesses stay with the evaluation
project or a separate research adapter, never in the Future-Code runtime.

Representative real objectives include experimental design and execution,
research data QA, numerical/stochastic implementation, reproducible remote-job
management, checkpoint and restart, and publication-grade evidence review.
For long-horizon productivity, benchmark *complete accepted objectives*,
including dependency DAGs, handoffs, expensive external work, and failure recovery.

## Interpretation and safety

- The runner uses clean pinned Git worktrees, alternating ordering and
  independent red-to-green verification. It counts verified original tasks,
  not spawned subtasks, agent messages, or code volume.
- Results with missing executables, red-control failures, test alterations,
  unapproved file edits or model-budget failures are not productivity wins.
- Replay and deterministic fixture tests cannot establish live-LLM gains.
- Use at least three repeated live trials for exploratory observations, then
  expand across independently held-out projects with uncertainty estimates.
- Local worktrees are **not** a hostile-process sandbox. Trusted code only;
  use isolated VMs/containers for adversarial or third-party model workloads.
- The comparison harness itself is not a benchmark of Future-Code's general
  research competence until real Future-Code and comparator adapters are wired.
