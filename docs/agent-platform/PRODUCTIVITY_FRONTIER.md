# Productivity frontier: small-task parity, long-horizon advantage

This is a **falsifiable engineering target**, not a published comparative result.
Claude Code and Codex have multi-agent features: Future-Code has no automatic speed
advantage merely because it launches parallel workers or stores a task graph.

## Select the existing path

| Workload | Future-Code path | Rationale |
|---|---|---|
| Quick question or localized interactive edit | Existing interactive / bare CLI | Do not start Foundry for a trivial query |
| One bounded local coding task with pinned checks | `swarm run` then `swarm integrate` | One worker, no objective-replanning loop; checks still required |
| Multi-file DAG, experiments, remote compute, uncertain duration | `swarm supervise` | Durable recovery, job reconciliation and final acceptance gate |

After `swarm init`, use `swarm recommend --tasks TASKS.json` to inspect a
**conservative advisory** classification. It does not execute tools, rewrite
the recipe, weaken checks or certify a performance gain. The legacy interactive
CLI and Foundry remain separate code paths; this does not automatically
convert interactive requests to supervised R&D.

## Reproducible theoretical model

W = productive sequential work hours under equal models and tools,
s = unavoidable serial fraction, k = **effective** (not nominal) workers,
O = measured coordination/verification overhead hours,
L = lost work hours from failed attempts and restart/context reconstruction,
q = probability of **independent verified objective completion**.

    T = W * [s + (1-s)/k] + O + L
    Verified-objectives/hour = q / T
    Quality-adjusted speedup = (q_F/T_F)/(q_B/T_B)

Future-Code gains time when

    W(1-s)(1/k_B - 1/k_F) + (L_B - L_F) > O_F - O_B

More agents only help when the DAG has independent width and agents deliver
verified work. Quality and model capabilities may dominate all orchestration.
When both agents can parallelize and recover equally, no significant gain follows.

```sh
node --experimental-strip-types scripts/model-productivity-frontier.mjs
node --experimental-strip-types --test tests/foundry/productivity-theory.test.mjs
```

The versioned scenario manifest under `examples/productivity/` is labelled
`UNMEASURED_HYPOTHESES`; the output says `FORECAST_ONLY_NOT_BENCHMARK`.
The cases intentionally include small-task parity, a favorable long-project
case, and a strong multi-agent competitor that can outperform Future-Code.
These forecasts are not measurements of Claude Code, Codex, or Future-Code.

## Empirical acceptance targets (not achieved claims)

- Small tasks: p50 and p90 latency <=110% of the best matched comparator,
  no lower independent acceptance rate.
- Long R&D: >=2x verified objectives/hour and no higher dollar cost per
  verified objective against **both** strong contemporary baselines.
- Use same model and model-access terms to isolate harness value; also include
  separate best-product comparisons with transparently different models.
- Freeze commits, verifiers, hardware, datasets and budget; retain failures.
  Include remote job outages, reward collapse, eval contamination, real
  checkpoint/resume, and independent research-quality review.
- Treat missing provider tokens/billing, altered checks, and contaminated task
  data as unknown or void rather than claiming success.

Pair this work with the comparative live-evaluation infrastructure in PR #27.
