# Agent Benchmark Design — experimental vs main vs first-commit vs industrial agents

Date: 2026-11-19 · Branch: `experimental` · Author: Future Code session (autonomous run)

## Objective

Produce a technical report comparing Future-Code `experimental` against:
1. Future-Code `main` (94cbe20)
2. Future-Code first commit (b1f9d18)
3. OpenCode (industrial agent CLI)
4. Codex CLI (OpenAI)
5. Claude Code (Anthropic)
6. WorkBuddy (Tencent) — availability to be verified; documented honestly if absent

on industrial agent benchmarks (whole-agent CLI benchmarks, not bare-LLM ones).

## Benchmarks

| Benchmark | Type | Feasible here | Rationale |
|---|---|---|---|
| Repo-native verified-repair suite (`scripts/compare-agent-productivity.mjs` + `examples/agent-comparison` fixture) | Agent CLI, scripted provider, zero live model calls | Yes | Deterministic, offline, prior baseline exists (2026-11-18 report) |
| Live-model verified-repair pilot (same 4 fixture cases, real model through loopback gateway) | Agent CLI, live model | Yes (GLM-5.3 via proxy; same-model fairness) | Measures real agent loop quality, not just startup |
| SWE-bench Verified subset | Public industrial | Docker OK, but no GPU/local model serving; harness requires per-instance images + Anthropic/OpenAI keys | Document as infeasible with evidence if attempts fail |
| Terminal-Bench | Public industrial | Same constraints as SWE-bench | Same |
| Aider polyglot | Public industrial | Requires model inference at scale; aider CLI absent | Same |

## Fairness protocol

- Same model (GLM-5.3) and same endpoint for every agent, via a loopback translation
  gateway per client protocol (Anthropic Messages for future-code/claude-code;
  OpenAI Chat Completions for codex/opencode; verified by request receipts).
- Same prompts (fixture-generated), same worktrees, same checker, same deadlines,
  rotated agent order per repetition, fresh state dir per trial.
- Wall time measured by the runner: worktree creation + red control + agent run +
  green check + cleanup. Failed/timeout trials count in throughput.
- Versions pinned and recorded. Model temperature 0, output ceiling pinned.

## Acceptance for this report

- Every number in the report must come from an executed run recorded under
  `experiments/agent-benchmark-20261119/results/` (JSON) with a regeneration command.
- No synthetic stress numbers presented as live-LLM evidence (AGENTS.md rule).
- Unavailable agents/benchmarks documented with exact failure evidence.
