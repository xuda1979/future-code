# Reviewer feedback on the kernel paper (memory retention / context pruning)

Received via /goal command, 2026-09-26. Saved verbatim.

---

modify the paper according the feedback:This paper addresses the problem of memory retention and context pruning in long-horizon software agents, investigating when an agent can safely discard past execution history without compromising correctness and under which economic conditions such retirement is advantageous. The work is executed as a pre-registered, factorial, deterministic mechanism-level study ($1,176$ runs in the v2 cohort plus a 160-episode long-horizon sub-cohort) comparing seven retention policies across four registry sizes ($n \in \{128, 512, 1024, 4096\}$), three dependency structures, and two accounting regimes: Bandwidth-bound (bytes) and Round-trip-bound (bytes $+ 4,096\text{ B}$ per retrieval op).

1. Summary of Claims and Core Findings
The paper establishes a necessary and sufficient conversion rule within its deterministic execution model, alongside a regime-conditional cost payoff:

Necessity and Failure of Lossy Summaries: An agent cannot safely discard history via generic periodic summary and reset. In the frozen v2 cohort, summary-reset accepted only $28/84$ runs, accumulating $109,761$ stale reads and $385$ lost obligations due to cross-boundary information drops. Conversely, policies that convert history into typed pending obligations, verified interface bindings, and declared dependencies (frontier, verified-board, full-replay) achieved $84/84$ acceptance and passed a five-episode ground-truth capsule audit with zero defective service.  
Regime-Conditional Operations Payoff: Verified-frontier retirement yields modest byte savings ($-8.0\%$ pooled vs. observation masking, below the pre-registered $20\%$ byte-win gate). Its primary value lies in cutting on-demand retrieval operations by $44.0\%$ pooled ($45.1\%$ in the 160-episode horizon). This produces a $29.6\%$ cost reduction in the round-trip-bound regime ($84/84$ cells, $p = 10^{-25}$).  
Analytical Decision Boundary: Proposition 3 derives a closed-form break-even round-trip price:  $$c_{\rho} = \frac{\rho B_m - B_f}{o_f - \rho o_m}$$  Because frontier's submitted bytes are strictly lower than masking ($B_f < B_m$), the promotion threshold $\rho = 0.8$ is met at $c_{0.8} = 0$, meaning frontier dominates masking on operations without a byte penalty.  
Ablations and Negative Results: A demand-driven adaptive eviction variant (frontier-adaptive) was evaluated against a pre-registered $\ge 10\%$ promotion gate and formally rejected after showing $-0.0\%$ cost reduction over static frontier. Grouped certificate-tree layouts (HACT) were shown to be strictly conditional: they win in dense global updates ($87.1\%$ byte reduction) but lose to flat ledgers on sparse updates. A simple update-density heuristic ($\ge 0.5$) matched the oracle choice in $84/84$ cells ($0.0\%$ decision regret).  
2. Key Strengths
Exemplary Scientific Discipline and Open Science: The paper demonstrates exceptional rigor in pre-registration and negative reporting. Protocols were committed to git prior to v2 data generation. When proposed extensions failed—such as the null-byte threshold in v1 or the frontier-adaptive policy failing its $10\%$ gate in v2—the authors rejected the hypotheses rather than altering the framing. The transparent disclosure of v1 file-ordering provenance and a ground-truth audit deduplication bug caught during development sets a high standard for reproducible artifact design.  
Methodological Factor Separation: The factorial decomposition between retention policy ($R$) and scheduler strategy ($S$) cleanly isolates concerns. The scheduler factor achieved an $87.5\%$ reduction in makespan rounds with a measured byte leakage of exactly $0.000\%$, verifying that context-size gains were not confounded by batching behaviors.  
Rigorous Model-Level Guarantees: Proposition 1 provides a clean sufficiency proof showing that under the engine's stream invariants and reliable retrieval, frontier retirement provably guarantees zero staleness and zero obligation drop.  
Critical Exploratory Self-Stress (E6 Analysis): Rather than ignoring a strong baseline, the exploratory analysis directly confronts bounded-hier (a 64-gate recency window). The authors candidly show that below a round-trip price of $24,444\text{ B}$, bounded-hier is cheaper than frontier, but explicitly highlight the architectural trade-off: bounded-hier leaves $69.0\%$ of due obligations and $35.9\%$ of footprint reads outside its retention, delegating safety almost entirely to the underlying retrieval infrastructure.  
3. Weaknesses and Areas for Improvement
Gap Between Synthetic Mechanism and Live LLM Reasoning: The paper repeatedly emphasizes that no hosted LLM was evaluated and no real tokens were billed. While this keeps the mechanism study deterministic and reproducible, real software engineering agents do not interact via idealized state capsules:  
Prompt Semantics vs. State Tables: Language models often suffer from attention degradation, prompt distraction, or formatting drift when processing complex structured JSON/capsule formats. 
Real-World Summarization: Real LLMs do not summarize along a synthetic 4-episode boundary, nor are file edit payloads log-normally distributed around 128 bytes.  
Tool-Call Latencies: Modeling the round trip as a static additive penalty ($4,096\text{ B}$) is a coarse abstraction. In production, round trips introduce network jitter, rate limiting, and variable LLM generation latencies.  
Bifurcated Structure and Legacy Weight (Sections 6–12): There is noticeable architectural dissonance between the retirement study (Sections 1–5, 13) and the serialization/layout framework (Sections 6–12). The paper acknowledges that HACT and exact-DP compilation are no longer its core contribution (now relegated to a conditional component gated by update density). However, Sections 6–12 retain extensive theoretical machinery (e.g., Theorem 6, DP algorithms, fixed-share tracking bounds) that feels disproportionately heavy given that the primary message is "use a simple flat ledger unless update density exceeds 0.5". Streamlining or moving extensive DP recurrences into the appendix would improve narrative focus.  
Fragility of the Reliable-Retrieval Assumption: Proposition 1 relies on invariant (iii): every required read is either currently observed or fetchable. In distributed or real-world agent environments, retrieval is frequently lossy, ambiguous, or subject to search index stale-indexing. Because frontier retirement depends on fetching un-retained historical context when dependencies cross the boundary, evaluating performance under noisy or failing retrieval layers is a vital omitted negative boundary.  
Unresolved Tokenization Claims: Both requested BPE tokenizers (cl100k_base and o200k_base) were unavailable and marked UNKNOWN during serialization measurements. Given that the paper targets LLM context efficiency, padding savings measured in raw bytes do not necessarily convert to proportional BPE token savings.  
4. Evaluation and Recommendations
Evaluation Dimension
Rating
Primary Justification
Methodological Rigor
Exceptional
Pre-registered factorial design, git-frozen protocols, explicit closure rules, and strict factor separation.

Honesty & Transparency
Exceptional
Formal reporting of negative results, clear labeling of post-data exploratory analyses, and disclosed implementation bugs.

Theoretical Soundness
Strong
Proposition 1 (sufficiency) and Proposition 3 (monotone break-even) are well-formulated and cleanly proved within model boundaries.

Real-World Agent Relevance
Moderate
Simulated flow model only; tokenization, LLM reasoning degradation, and provider pricing remain unmeasured.

Recommendations for the Authors
Restructure the Manuscript for Narrative Cohesion: Condense Sections 6–10 into a compact section on "Verification Substrate and Serialization." Move the full dynamic programming formulations (Theorem 6, Equations 9–12) and the optional fixed-share proofs (Theorem 9) to the appendices to keep the spotlight on the context retirement mechanism and its break-even economics.  
Stress the Retrieval Failure Boundary: In Section 5, augment Proposition 1 with a sensitivity or degradation analysis modeling non-zero retrieval failure rates ($p_{\text{fail}} > 0$). Quantifying the point at which frontier's correctness degrades relative to full-replay under unreliable tooling would directly reinforce why the conversion rule is necessary.  
Execute the Pre-Registered Live-Agent Cohort: Prioritize the pre-registered SWE-bench live cohort (Section 13.1). Measuring tool-call counts, actual billed provider tokens, and noninferiority task completion on models like Claude 3.7 Sonnet or GPT-4o will determine whether the operations advantage observed in the simulator survives live agent execution.  
This manuscript provides an uncommonly honest, disciplined, and mathematically sound systems study. It effectively debunks naïve periodic summarization and establishes an operational decision rule for memory compaction in automated software agents.

---

# Review 2 (major revision recommendation), received 2026-09-28

> Overall assessment: The updated paper has a valuable research direction, but
> major revision before submission. Most urgent issue is internal consistency.
> [Recommendations include:] Measured retrieval, context, acceptance, and
> end-to-end outcomes under matched budgets. A more focused title:
> "Verified Context Retirement: Safety Conditions and Retrieval–Memory Trade-offs".
> Bottom line: retain the idea of replacing unnecessary history with verified,
> task-relevant state. But the current paper should not yet claim a
> necessary-and-sufficient retirement rule or use its numerical thresholds as
> validated deployment guidance. The next revision should rebuild confidence in
> the simulator and its measurement boundary before adding more experiments or
> stronger claims.
