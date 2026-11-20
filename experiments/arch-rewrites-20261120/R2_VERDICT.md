# R2: Composed local exploration (code-as-action) — verdict: ECONOMY PROVEN (10×/83×), architecture already present

Question (rnd_plan.md issue 2): does composing a multi-step exploration into
one locally-executed action cut model round trips and context growth versus
per-call tool turns?

## A/B (`r2-composed-exploration.mjs`, results in `r2-results.json`)

Same 5-step exploration on this repository, real tool outputs:

| Arm | Round trips | Context bytes added | Tool wall |
| --- | --- | --- | --- |
| per-call turns (Grep-iterate) | 10 | 5555 | 49 ms |
| composed single call (pipeline) | 1 | 67 | 147 ms |

**10× fewer model round trips and 82.9× smaller context growth.** Tool-only
wall is higher for the composed arm (147 vs 49 ms) — the win is in removed
MODEL round trips (each round trip costs seconds of inference plus a full
history re-read), which dominates at every realistic latency. The context
saving compounds: each round trip carries the whole conversation, so
preventing 9 round trips also prevents 9 history re-serializations.

## The architecture is already present — this is an adoption gap

The Bash tool accepts pipelines (`grep | while | sort`), so the model can
compose exploration TODAY with zero host changes. The measured gap is that
structured per-call tools (Grep/Glob/Read) are the path of least resistance
and the system prompt contains no composed-exploration guidance
(src/constants/prompts.ts has no pipeline/combine directive). The rnd_plan
proposal's "REPL native synthesis" (a sandboxed code-execution tool) would
add arbitrary local composition beyond shell pipelines — but that is a new
attack surface (arbitrary code execution as a first-class tool) and needs
its own security review; the shell already covers the measured exploration
use case.

## What would ship, in what order

1. **Cheap, provable now**: nothing in the host. A prompt-level directive
   ("for multi-step search/filter/rank, compose one bounded pipeline instead
   of iterating per-call tools; show only the condensed result") requires a
   LIVE-model A/B to prove adoption and win, which this environment cannot
   run (no live-model layer; see experiments/agent-benchmark-20261119).
2. **Later, if adoption data supports it**: a constrained "explore" micro-
   tool (declarative multi-step search DSL, not arbitrary code) keeping the
   security posture while making composition the path of least resistance.

Per the experiment-gated rule, the prompt change cannot ship unmeasured;
this verdict is the evidence package for the live A/B.
