# HACT v14: symmetry-aware exact optimization and publication

Frozen 2026-10-22 before new v14 computations. Parent 672a00c4ba6e257bbaf8ca24c3706c9eee8f9288.
The user explicitly authorizes strengthening the paper and publishing a PR in
the public xuda1979/future-code repository. Earlier public-upload holds are
superseded by this instruction. Journal submission still awaits user review.

## Scientific question

Does completion-law symmetry permit a stronger, cheaper global layout baseline?
Under a uniform random permutation partitioned into declared batch sizes, a
semantic coverage set's expected hit count is the sum of hypergeometric hit
probabilities. More generally exchangeability makes the objective depend only
on coverage cardinalities. Derive a size-state dynamic program over all tree
shapes and leaf permutations, with O(b n^2) arithmetic operations and O(b n)
states. Use exact integer numerators with a common denominator, and validate
against independently enumerated labeled trees and all supported permutations.
No learned timings, wave-size proxy for real exchangeability, or new unproved
priority claim is allowed.

## Evaluation frozen before new results

- Exact small cases: all n<=6, fanouts 2..min(8,n), widths 1..n; independently
  enumerate literal trees and permutations for small cases. Check general
  batch-size compositions separately, including singletons and one full wave.
- Compile the uniform-eight model baseline in canonical semantic order for
  the five previously admitted public projects. Cap registry at 2,048 as before;
  preserve Packaging's resource exclusion. Archive exact scores, trees and
  measured compile time. Compare against original compact and the two frozen
  historical/refined selected layouts on the original retained runs and all
  30 admitted dispatch-shift traces, preserving losses and ties.
- This is retrospective descriptive analysis of previously inspected data,
  not a new preregistered or natural-workflow confirmatory study. Actual dispatch
  shuffling need not make completion order uniform; measured costs are reported
  even when the exchangeability model is false. No production speedup follows.
- One CPU host, no external model calls, no paid computation, no new upstream
  execution campaign. Computational budget <=30 minutes, retained new data <25MiB.

## Publication and reproducibility

Run meaningful focused and full HACT tests, independent arithmetic audits and
PDF QA. Publish a PR, preserving all existing observations. If needed, transport
large new observation files in a hash-bound lossless archive with a documented,
offline, safe/idempotent hydration step; restore their exact original paths and
verify the release manifest before any tests. Do not replace data with summaries,
change exclusions, silently omit files or use archive extraction to weaken a gate.
