# R2 live A/B: composed-exploration directive — verdict: WIN on adoption, economy, and correctness; NOT shipped into the system prompt yet

Follow-up to R2_VERDICT.md (offline economy: 10× round trips, 83× context
bytes). This live A/B answers the remaining question: does a prompt-level
composed-exploration directive make the live model actually compose, and
does it win end-to-end?

## Method (`r2-live-ab.mjs`, results in `r2-live-results.json`)

`future-code --print` (live GLM-5.3 via deepseek.env), same deterministic
multi-step exploration question against this repo, 3 reps per arm, 600 s
timeout per trial with one retry on zero-output transport hangs. The
directive rides in the USER prompt (no host change). Correctness is a
deep-compare of the answer JSON against locally computed ground truth
(19 files, exact counts, digest-import booleans; occurrence vs call-site
count both accepted for kernel.ts's own definition line).

Earlier 16:03 run was discarded: 3/6 trials were censored by a 300 s
timeout (baseline legitimately needs up to ~350 s) and its checker grepped
for a filename absent from ground truth, scoring every correct answer
false. Bench fixed; full rerun below.

## Results (clean run, 6/6 completed, zero hangs)

| Arm | Round trips | Tool uses | Wall (avg) | Correct | File score |
| --- | --- | --- | --- | --- | --- |
| baseline (plain question) | 18.33 | 6.67 | 110.5 s | 2/3 | 0.98 |
| treatment (+directive) | 5.00 | 1.33 | 196.8 s | 3/3 | 1.00 |

- **Adoption: 3.67× fewer model round trips** (18.33 → 5.00), **5× fewer
  tool calls** (6.67 → 1.33). The directive works: the model plans the
  search as one bounded pipeline instead of iterating Grep/Read.
- **Context economy**: every removed round trip also removes a full
  history re-serialization; combined with the offline 83× context-byte
  result, the token savings compound across the session.
- **Correctness parity or better**: treatment 3/3 fully correct vs
  baseline 2/3 (baseline rep3 dropped the double-`invariant` line in
  knowledge.ts). One rep each is a small sample — the honest claim is
  parity, not a correctness win.
- **Wall: treatment is SLOWER (196.8 vs 110.5 s)**. The single composed
  arm spans 68–288 s: one giant pipeline plus a long final answer costs
  more inference wall time than several quick tool rounds at this
  provider's latency. The win is round trips/tokens/context, not latency.

## Verdict per the experiment-gated rule

The directive measurably wins its target metric (round trips, tool calls,
context growth) with correctness parity — but it was measured riding in
the USER prompt. Shipping it into `src/constants/prompts.ts` changes the
system prompt for every session, which this A/B did not measure (system-
prompt placement could interact differently with tool-selection habits).
The one-line ship needs either (a) an A/B with the directive in the
system prompt, or (b) an operator decision that user-prompt evidence is
sufficient. Not shipped today; the evidence package is complete.
