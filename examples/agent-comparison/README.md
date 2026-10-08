# Reproducible Future-Code / Claude Code / Codex comparison

This is an **evaluation instrument**, not evidence that one agent wins. The
three example defects come from xuda1979/quantum-gpt at commit
`147fe54b2c74b83ef0784c459faf95fd073428a5`. They represent score
integrity, train/evaluation manifest integrity, and evaluation leakage. They
are a starting point, not a benchmark of multi-day autonomous R&D.

## Preparation

Use Linux, Node >=22.16, Git and Python 3; clone quantum-gpt at the commit
above. Copy `quantum-gpt.live.template.json`, fill in the absolute
local repository path, exact model/version identities and **real installed**
adapter commands. These commands are **placeholders, not shipped executables**.

Every adapter must read the frozen prompt path, operate only inside the
supplied worktree, and exit nonzero on failure. The Future-Code adapter must
initialize the Swarm, run independently verified tasks, integrate them, and
apply the integrated source patch into the trial worktree. It must include its
own orchestration cost. Claude Code and Codex adapters must likewise include
startup/tool use/repair time. Use the same permitted compute and comparable
model where possible. Comparing different models is a whole-product comparison,
not a causal harness comparison. Do not use offline replay as a live baseline.

The harness:

- Runs every agent on the same pinned source, prompt, test and allowed paths.
- Requires the independent checker to reproduce a distinct known regression
  with exit status 1 before allowing the agent to work.
- Uses a fresh detached Git worktree for each trial and rotates agent order.
- Rejects modified tests, unauthorized files, no-source-change responses,
  absent executables, malformed negative controls, and timeouts as PASS.
- Counts only independently verified work, and includes setup and failure
  time in verified tasks per hour.
- Records each stdout/stderr transcript, source patch, elapsed time and result.
- Leaves missing provider billing and tokens null. Report provider-invoiced
  cost separately if you have audited billing data.

## Running

```sh
node --test tests/foundry/agent-comparison.test.mjs
node scripts/compare-agent-productivity.mjs \
  --config examples/agent-comparison/quantum-gpt.live.template.json \
  --out /tmp/quantum-gpt-agent-comparison-001
```

The output root must not exist and must be **outside** the source checkout.
Live comparisons should use 5-10+ repetitions and more than these 3 tasks.
At least 3 repetitions are required for the limited
`OBSERVATIONAL_RESULTS_ONLY` classification. The runner does **not**
claim general superiority and does not authenticate any external CLI's model
identity or API billing. Review the per-run logs. Independent graders must
remain outside the agent worktree and, for adversarial evaluations, run in a
separately secured container/VM.

For representative long-term R&D, add 8-12 held-out objectives: GRPO
low-signal root-cause diagnosis, reward correctness, checkpoint/resume,
remote-job reconciliation, real remote training preflights, and blinded
quantum-code evaluations. Pin accelerator access, datasets, budget and
numerical success criteria. Measure first verified objective completion,
research artifacts per engineer-hour/dollar, generalization, regression
rates, and recovery after injected failures. Keep initial failing and
incomplete attempts in the report; never select only successful examples.

**CI deliberately runs only offline instrumentation tests and negative
controls. It is not evidence that Future-Code beats another agent.**
