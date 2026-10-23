# HACT v14 validation record

2026-10-22. Local verification, distinct from GitHub Actions or human review.
Python 3.12.14, numpy 2.3.5, pytest 9.0.2, pytest-asyncio 1.3.0.

- Full HACT regression suite: **815 passed** in 123.40 seconds.
- New v14 focused suite: **35 passed**, including exact optimization,
  independent-audit tampering and offline observation-transport regressions.
- Historical gates passed: v5 audit, numbers audit, v9 audit, v10 exact
  separation, full v11 parameter generalization, strict-partition witness,
  v11 compiler audit and manuscript projection, v12 fixed-batch certificate,
  robustness replay, independent audit and projection, v13 adoption replay,
  audit, exact summary-span calculation and projection.
- V14 exact study replay, independent audit and manuscript projection passed.
  The study checks 70 cases and 74,245 global tree comparisons, all five
  admitted public projects and all 30 admitted dispatch shifts. Packaging's
  exclusion and the original six VOID schedule runs remain archived.
- Four PDFs were built with three passes in separate clean directories and
  unique job names: IEEE primary 13 pages, extended analysis 42 pages,
  attributed and blinded JSS variants 33 pages each. Final logs contain no
  undefined references/citations or overfull boxes. Rendered pages were
  visually inspected before publication.

The source includes a pull-request workflow that restores and verifies the
complete raw observation archive before running the full regression suite,
all historical/current gates and service/control recomputations. A local pass
is not reported as a remote CI pass. No Foundry or Swarm runtime code changed.
Tests are evidence of implementation conformance, not journal acceptance or
proof of natural consumer utility. See V14_REPRODUCE.md for exact commands.
