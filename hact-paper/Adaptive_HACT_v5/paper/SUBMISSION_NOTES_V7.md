# HACT v7 journal-readiness audit

## Status: NOT READY for a defensible top-journal productivity claim

The revised manuscript includes a new, CI-tested retrospective strong-baseline analysis. The empirical record is still a frozen v5 source/experiment cohort. This makes the evidence story more informative, but it does **not** fill the critical external-validity gap: no live long-horizon agent has been shown to benefit from the hierarchy under matched functionality and quality.

### Completed in the current PR

- [x] Formalize hierarchical evidence versus flat final-state service boundaries.
- [x] Add a train-derived marginal-frequency ordering baseline.
- [x] Add deterministic random layouts and label the hindsight-only best as an oracle.
- [x] Preserve all failure/incomplete archived checker cases, hash-verify input evidence.
- [x] Retrospectively audit 27 synthetic workloads and 12 source cases in isolated GitHub Actions.
- [x] Add adversarial state/permutation/migration tests for the local trusted guard.
- [x] Write and freeze an evaluation protocol for the missing prospective study.
- [x] Document flat-ledger negative results, including unequal service functionality.

### Critical blockers before credible submission to TSE/TOSEM

- [ ] Execute the preregistered live agent study across independently selected tasks and repositories with at least three paired repetitions, frozen verifier, and provider usage accounting.
- [ ] Implement an indexed flat-ledger query API answering **the same hierarchical diagnostic questions**, with all on-demand aggregation and cache/index maintenance costs included.
- [ ] Record physical (not loopback) multi-host WAN outcomes if any WAN speedup claim is retained.
- [ ] Validate DOI, authors, acknowledgments, funding, institutional approval, license/data-rights, and selected venue rules.
- [ ] Coordinate any patent application with manuscript disclosure timing.
- [ ] Conduct independent theoretical review; especially evaluate trusted-checker and atomic-generation assumptions.
- [ ] Run third-party, clean-room artifact replication or journal-required artifact evaluation.

### Claims permitted now

With appropriate citations to the frozen release: retrospective hierarchical-encoding byte and diagnostic-page savings in workloads with structured completion locality; deterministic train/validation/holdout comparisons against random and marginal-frequency layouts; safety of the declared local guard under stated trust assumptions.

### Claims not permitted now

Universal productivity gain over Claude/Codex, reduced model reasoning cost, billed-token savings without provider receipts, WAN improvement, unqualified cryptographic proof, agent solve-rate improvement, zero regressions in production, or top-journal acceptance.

## Reproduce

Run the GitHub Actions workflow `HACT journal evidence audit` on this PR. It executes all v7 property tests and publishes `hact-v7-strong-baselines`, a structured JSON result with score and provenance checks. These records are archived replay and do not constitute new external checker/LLM executions.
