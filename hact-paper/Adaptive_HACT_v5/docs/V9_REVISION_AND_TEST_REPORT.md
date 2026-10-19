# V9 revision and validation record

Date: 2026-10-19. Scope: the Python HACT research artifact, manuscript,
corrected retrospective results and evidence CI.

## Validation observed

- `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin`:
  **525 passed**, including v7, v8 and new review regressions.
- Historical manuscript consistency audit: **70 entries pass**. This retains its
  historical scope; its prior PASS did not validate the incorrect v8 prose.
- Independent v9 arithmetic/input/generated-prose audit: **5,337 checks pass**.
  The checks include repeated per-query assertions, not 5,337 independent trials.
- Independent v5 reconstruction: **27 workloads, 36 layout replays and 131
  summary numerical comparisons pass**, plus the conditional planning checks.
- Corrected service oracle: **168/168** comparisons agree with the separate
  archived-record oracle; **84** layout-invariance checks agree.
- Corrected query study: **364 paired query rows**, **24** matched traces,
  **182 real cache hits per arm**. These reuse the same 12 archived candidates.
- `latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex`: successful
  **27-page PDF**, with resolved references/citations and no overfull boxes.
  All pages were rendered and visually inspected; key result pages were checked
  separately. Standard `algorithm`/`algpseudocode` packages are required
  (`texlive-science` on Debian/Ubuntu).

## Review defects covered by new falsification cases

The initial ten public-path cases failed on the reviewed code before the fix.
Current regressions cover: descriptor-inclusive page caps on every archived
answer; oversized atomic-field rejection; complete page reconstruction; real
cache hits and invalidation; exact learned kernel order; queries independent
of reference functions and raw snapshots; dependence on the maintained flat
index; foreign identities; old/empty snapshots after full completion; replay
wave boundaries; declared/executed ID disclosure; shared implementation errors
caught by the oracle; full replay timing-field equality; and non-overwriting
measurement commands.

The manuscript audit also rejects a fraction displayed as a percentage, a
penalty relabeled an improvement, altered query rows, and inconsistent wire
measurements. It generates the exact signed interpretation consumed by LaTeX.

## Provenance and remaining limits

No v5 or v8 experiment JSON was modified. The v9 query artifacts identify every
archived input by bytes and SHA-256. The unchanged ablation is re-analyzed;
it is not relabeled a new run. Timing values are one local campaign, and arrival
values use an explicitly arithmetic link model. Current claims do not include
live-agent productivity, physical-WAN performance, billed tokens, remote
attestation or global layout optimality.

The v5 release manifest is retained at `historical/v5_release_manifest.json`.
The current manifest covers the revised source, PDF and versioned evidence;
`tools/update_manifest.py` refreshes it explicitly after reviewed edits.

The historical manifest also lists files absent from the Git publication. The
current manifest enumerates the published source and evidence; the original
manifest is retained to expose that boundary rather than fabricating missing logs.
