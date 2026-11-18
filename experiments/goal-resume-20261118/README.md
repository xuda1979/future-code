# Authorized training continuation replay

These are deterministic controller/context regressions, with scripted provider
outputs and an actual tiny CPU optimizer subprocess. They are not live-LLM
productivity experiments or quantum-model training results.

- `regressions.json`: the same 62 frozen contracts against baseline `55e0bc6`
  and the patched source. Test/source SHA-256 values are recorded. Baseline
  passes 29 and fails 33; candidate passes all 62.
- `results.json`: repeated authorization, lossy compaction and invented observer
  budget replays using the production goal/context modules.
- `adapter-worker.mjs`: dependency-free scalar residual adapter, frozen base
  coefficient, two trained coefficients and preserved momentum.

The worker receives its resume path from the actual fresh request projection,
not the replay coordinator's private checkpoint variable. The prior artifact
must remain byte-identical. Each successful continuation does 120 updates from
the 12-step prior and is checked against an independent uninterrupted 132-step
process. Toy MSE is diagnostic only; it is not a model benchmark claim.

The baseline losing the path means it needs rediscovery in this bounded replay;
it does not establish how long a live model would take or whether it would fail
the full task. No latency, token-efficiency, IBM or Qwen gain is inferred.

```sh
node scripts/bench-goal-regressions.mjs BASELINE experiments/goal-resume-20261118/regressions.json
node scripts/bench-goal-resume.mjs BASELINE experiments/goal-resume-20261118/results.json
```

Use a separate checkout at the recorded baseline commit. Scripts do not mutate
either input source tree. The reports identify candidate dirty source by hashes;
`candidateParent`/`revision` is the parent commit, not a claim that uncommitted
changes already have that revision's identity.
