# V12 controlled dispatch-shift experiment

Frozen before execution, 2026-10-21. V12 review found that all five projects
admitted by the v11 fitting budget have identical completion orders across the
five original process runs. This follow-up tests controlled scheduling shifts;
it does not establish natural maintenance or production generalization.

Use the same clean release source trees and complete acceptance registries for
Click, Jinja, Pluggy, attrs and ExceptionGroup. Packaging remains outside the
unchanged dense fitting budget; no new model is fitted or subsampled. Freeze
hashes of the four existing layouts per project: original compact, historical
compact-selected, cap-32 selected and cap-64 selected. Cap-32 remains primary.

For each project, execute all checks in six new pytest processes: three seeds
2026102101, 2026102102, 2026102103 crossed with two policies. Primary policy
shuffles test-file groups while preserving item order inside each file. Secondary
policy uniformly shuffles individual test items, deliberately disrupting file
locality. Use Python's seeded `random.Random` shuffle; record initial collection,
scheduled order and actual completion order separately. Do not change assertions,
fixtures, status classification or selection. Preserve all observed failures,
UNKNOWN outcomes and collection/startup failures. No retry based on cost results.

Build waves from actual completions with fixed width eight and a possibly shorter
final wave. Score cold construction plus refresh packets using the frozen byte
model, independently walking literal serialized trees. Report every project's
seed/policy result and aggregate win/tie/loss counts against the frozen original
compact tree. Do not select layouts or seeds using these outcomes. Record source
and dependency inventories, full duplicate-aware distribution locations, Python,
platform, code hashes and input layout hashes before execution. Verify production
origins and unchanged source hashes after execution. Registry mismatch, incomplete
session, timeout or provenance failure yields VOID/UNKNOWN, never an imputed win.

CPU-only budget: 180 seconds per process, 20 minutes total, 100 MiB new retained
data. The existing v11 outcomes remain immutable. Negative and zero gains are
equally valid outcomes; this study has no minimum performance gate.
