# V7 journal experiment and evidence contract

The **frozen v5 records** are the only source of primary results unless new experiments explicitly run and are authenticated. V7 analyses must never relabel replays as live verification.

## Baselines and matched services

1. Original-order balanced eight-ary certificate layout.
2. Train-fitted pairwise learned layout selected on held-out-independent validation.
3. Train-fitted marginal-frequency order with identical balanced tree.
4. Eight deterministic random layouts, reporting median and *hindsight best* separately (the latter is NOT a deployable selector).
5. A canonical flat leaf-event ledger with per-wave and whole-stream DEFLATE; **different functionality** from a hierarchical certificate stream. This control establishes when a simpler representation dominates but must not be interpreted as a service-equivalent winner.
6. Root-only status control, which is layout invariant and lacks diagnostics.

## Fidelity, tests, exclusions

- Exactly 27 synthetic rows, 12 archived source cases, each with fixed train/validation/held-out split or authenticated recorded checker output.
- Reject missing or duplicated check IDs, tampered evidence hash, mismatched v5 score, layout disagreement on the root, and overwrite of previously produced outputs.
- No model API calls, no WAN calls, no newly executed source checker and no actual provider token costs in offline replay.
- Numerical byte comparison is not a causal claim about agent success, wall time, billed tokens, or physical network speed.
- Compute uncertainty over independent seeds or independent project instances; do not bootstrap individual events as if they were independent projects.
- The success gate for a *top-journal submission* remains a matched live experiment with actual diagnostic consumers, model usage accounting, and measured end-to-end quality with preregistered outcomes.

## Reproduction

From `hact-paper/Adaptive_HACT_v5`:

```bash
PYTHONPATH=. python -m pytest -q tests_v7
PYTHONPATH=. python -m experiments_v7.strong_baselines --output /tmp/hact-v7-comparisons.json
```

The output file must not already exist. CI stores it as an artifact. No default credentials, model endpoints or remote services are accessed.
