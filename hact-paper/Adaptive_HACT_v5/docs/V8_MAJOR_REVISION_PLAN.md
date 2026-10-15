# V8 major-revision plan — response to the 2026-10-09 top-journal review

Review source: `~/Downloads/HACT_Top_Journal_Review_CN_20261009.docx`
(review of journal manuscript v7.0 at commit `a829bf7`). Verdict: **major
revision, then re-assess** for TSE/TOSEM. This plan maps every review point to
a concrete, checkable work item and freezes acceptance criteria before any new
experiment runs (review §10). Nothing here relabels replays as live runs; the
v5 frozen records stay the only source of primary results unless new
experiments run and are authenticated (`docs/V7_EVIDENCE_CONTRACT.md`).

The review's central demand (§1, §3, §10): **define a layout-independent
diagnostic service contract, implement a strong flat-ledger baseline with
index/compression/cache that answers the same queries, run a real-query study
on the same contract, and ablate or narrow the higher-order (completion-wave)
claim.** Title/abstract must then match the evidence (§9).

## 0. Repo assets the revision can use immediately

| Asset | Location | Use |
|---|---|---|
| Per-test archived records (12 candidates × 3 projects, incl. 9 failing trajectories) | `results/v3/fresh_checkers/{networkx,toolz,future}/*/pytest_evidence.json` | Real failure-localization and status queries for the service-equivalence study |
| Frozen synthetic seeds (27 workloads, 128/128/256 splits) | `experiments_v5/practical.py` + `experiments_v3/bench.py` | Regenerate episodes for flat-vs-tree query study and pairwise-vs-wave ablation |
| Flat-vs-tree byte table (Table `tab:v7flat`) | `paper/v7_comparison.tex` | Retire; replaced by service-equivalent comparison |
| Exact DP (`fit_frontiers`) and pairwise compiler | `ichact/frontier.py`, `ichact/layout.py`, `ichact/practical.py` | P0 ablation ladder |
| V7 live protocol (unexecuted) | `docs/V7_LIVE_EVALUATION_PROTOCOL.md` | Split into Phase 1 (real diagnostic service) / Phase 2 (agent study) per review §6 |
| 3⁴ state-machine enumeration & migration tests | `tests_v7/`, `ichact/adaptive_guard.py` | Seed the abstract-machine formalization (§8 of the review) |

Nine of the twelve archived candidates have FAIL verdicts with nonzero failed
counts, so failure-localization, incomplete-obligation, and re-run queries are
reconstructible offline — the Phase-1 query study does not need new checker
executions, but it must state that provenance boundary in every table.

## 1. Review §1 (overall judgment) — response posture

Review asks: strong same-function baselines, real diagnostic demand, results on
independent tasks, tighter theory-algorithm link; title/term changes alone will
not fix this.

**Action:** adopt the review's three-contribution focus (§4):
C1 layout-independent verification-evidence service contract with provable
invariants; C2 cost optimization that actually exploits completion-set
structure; C3 repeatable applicability-domain results against service-equal
baselines. Stable IDs, epochs, compiler, paging become supporting mechanisms.
The manuscript's front matter (title, abstract, intro) is rewritten last, after
C1–C3 have results, per §9.

## 2. Review §2 (what current evidence supports) — evidence table

Keep the review's inventory as the paper's own boundary table (unit of
analysis / replays / actual executions). Conclusions retained: learned ordering
reduces padded hierarchical evidence on frozen clustered workloads; valid
permutations + migration preserve declared verification contract; root-status
invariance is a valuable negative control. Conclusions not yet supported:
agent fix-rate, real input tokens, full-diagnosis latency, engineering
throughput. No new synthetic quantities are invented.

## 3. Review §3 (P0: service-equivalence first) — the core new work

### 3.1 Freeze the query semantics first (Q(e, S, mode, budget))
Define, in a new `docs/V8_SERVICE_CONTRACT.md` + paper section:
- `e` — candidate/checker/environment/registry identity tuple;
- `S` — semantic check set or fixed query predicate (e.g., "all integration
  checks for candidate e and list unfinished obligations");
- `mode ∈ {status, failure-localization, coverage-proof, replay}`;
- `budget` — max bytes per complete answer message;
- snapshot, freshness, and missing-result disclosure rules — all independent
  of tree node numbering. If authenticated paths are required, fix the trusted
  root / authentication model and give the baseline the same capability.

Property to prove/test: both representations return the same semantic set for
every frozen query (equivalence oracle over the 12 archived trajectories ×
query set). A learning-time node cannot be used as the unit of work: compare
per-semantic-check work, not per-tree-node work.

### 3.2 Implement the strong flat baseline (P0)
`experiments_v8/service_baselines.py`:
- indexed flat ledger: per-check index, on-demand aggregation (status rollup,
  failure localization by grouping per-check records), compression (per-answer
  and whole-ledger DEFLATE), plus cache and index maintenance costs;
- compressed ledger variant; original-order balanced tree; learned tree — all
  answering the identical frozen query set under the same contract;
- instrument BOTH sides: index build/maintenance, storage, aggregation CPU,
  encode/decode, cache hits, round trips, paging, failure disclosure, and
  complete-answer arrival time (on the recorded per-phase timing data where
  archived; clearly marked simulated/arithmetic where not);
- identical compression methods, connection reuse, and concurrency rules.

### 3.3 Real-query study (P0)
- Query workload: derived from the 12 archived trajectories (status,
  failure-localization for the 9 failing runs, coverage proof, replay) —
  publish the query generator with fixed seeds;
- if HACT only wins on some query types, publish the applicability domain; if
  it does not win, re-evaluate whether maintaining the hierarchy is warranted
  (this outcome is acceptable and will be reported either way — review §1);
- Phase-1 external-validity requirement (review §6): new projects and new time
  periods in held-out, not re-replays of the same 12 candidates. Concretely:
  sample ≥10 additional real repositories' CI/test outcomes (offline records,
  no new live runs required) to create the query trajectory corpus, or state
  the scope limit explicitly.

### 3.4 Decision rule (frozen before running)
For each query family: HACT is reported as beneficial iff complete-answer
bytes AND complete-answer time (as far as archived timings permit) improve
against the indexed flat ledger with maintenance costs included, at equal
answer completeness; otherwise report the negative result and the explanation.
Amdahl-style decomposition (review §7): report f (fraction of total diagnostic
time in the optimized path) and the speedup ceiling 1/[(1−f)+f/s] — measured,
not assumed; the 10%/linear example stays an explicitly conditional illustration.

## 4. Review §4 (mechanism-level novelty) — positioning

- Add a direct, item-by-item comparison with Huffman–Merkle (arXiv 2608.25206)
  on: query semantics, feedback signal, migration rules, authenticated content.
  Novelty claim rests on: work triggered by joint completion of a check set;
  cost from touched ancestor packets; layout change must preserve the
  verification semantics — not merely "applied to agents."
- Reorganize contributions as C1–C3 (§1 above). Report honestly if most of
  the benefit comes from standard compression or indexing — a result that
  explains "when hierarchy helps, when flat suffices" is itself publishable
  (review §4 final paragraph).

## 5. Review §5 (P0: close the theory-algorithm gap)

- Keep Prop. `pairwise` scoped: it proves pairwise statistics do not determine
  subtree refresh cost; it does not prove global optima differ, and it is not
  an optimality/complexity theorem for the compiler.
- Implement the review's ablation ladder as `experiments_v8/higher_order_ablation.py`
  on frozen synthetic data + 12 replays:
  1. frequency order (rules out simple-frequency explanation);
  2. current cluster order (pairwise co-activity — measures the deployed method);
  3. **direct completion-wave improvement** (new): budgeted local swaps/block
     moves on the training waves, cost deltas estimated from complete training
     waves, validation decides adoption, held-out only for reporting;
  4. fixed-order exact tree DP (interval-hit weights, tree-shape optimization);
  5. small-scale exhaustive reference (gap of heuristics to best feasible layout).
- Two acceptable outcomes (frozen rule): (a) rung 3 beats rung 2 on clustered
  held-out cost → the higher-order contribution is ablation-supported; or
  (b) it does not → narrow the algorithm claim to "pairwise seriation +
  complete-wave selection" and state that gains are not yet shown to come from
  beyond-pairwise structure. Either outcome is publishable in the revised text.
- Keep O(bn³)/O(bn²) DP bounds qualified to the additive packet-cost model.

## 6. Review §6 (external validity in two phases) — protocol split

- Phase 1 (real diagnostic service study): collect provenance-tagged check
  completion trajectories + actual diagnostic needs from real CI / bug-fix /
  multi-stage integration. Trajectories must cover failures, timeouts,
  unfinished obligations, concurrent completion, recovery. Same query
  sequences against indexed flat ledger, compressed ledger, original-order
  balanced tree, learned tree. Measure complete-answer time and all
  maintenance costs. New projects/periods held out (see §3.3).
- Phase 2 (real long-horizon agent study — only if productivity claims are
  retained): same external LLM API, tool permissions, context budget, and an
  independent final verifier; only the evidence representation/retrieval
  service varies. Tasks must genuinely require multi-round verification.
  Pilot first (variance/feasibility), then fix N: starting points 6–10 repos,
  40–60 tasks, 3–5 paired repetitions per task (suggestions, not thresholds);
  formal N from target effect, clustering correlation, and power.
- Keep the review's frozen-elements table (task sampling, allocation, model
  & tools, uniform quality, result provenance). Do not score offline waves as
  full counterfactuals once layout changes what the agent sees — report the
  controlled-representation study and the end-to-end agent study separately.

## 7. Review §7 (metrics and statistics)

- Primary metric per line of research: evidence-service study — time-to-complete
  the same diagnostic task (+ answer completeness, stale-result rejections);
  agent study — tasks passing a fixed verifier ÷ total wall-clock, with
  completion rate, failures, timeouts.
- Metric/statistics table from the review adopted verbatim: bytes/pages
  (distinguish padded, canonical JSON, per-packet, stream, whole-batch
  compression); query latency (median/p95/timeout, cold vs warm); engineering
  throughput (all assigned tasks and total time, unfinished retained); model
  tokens & cost (offline BPE only explains text; billing/usage from real API
  logs); uncertainty (cluster by independent task/project; paired effects and
  intervals); heterogeneity (query type, locality, failure density, project
  size, drift).
- Keep the existing discipline: 3 seeds per synthetic cell are not turned into
  high-precision CIs; nested repetitions in Phase 2 handled with correlated
  structure. Keep the gain/break-even model as a conditional model, separated
  from experiments; replace with actual critical path, request counts, and
  queueing time when Phase 1 data exists.

## 8. Review §8 (scalability and correctness evidence)

- Full-pipeline measurement without DP: affinity build, clustering, candidate
  evaluation, index maintenance — runtime, peak memory, maintenance cost vs
  (checks, waves, total members). Add measured points at 1024, 4096, and
  larger registries; state the scale ceiling if resources are insufficient.
- Sensitivity analysis for the parameter set {window 64, batch 8, header
  512B, slot 320B, cap 3072B}: re-derive feasible fanout whenever packet
  parameters change so compared trees remain legal (no invalid-tree
  comparisons).
- Measure time-window refresh, concurrent completion, different streaming
  compression boundaries. Whole-batch compression waits for the whole batch —
  do not share the "latency benefit" interpretation with online per-packet
  delivery.
- Formalize the safety theorem as abstract state-machine refinement
  (`docs/V8_STATE_MACHINE.md` + paper section): abstract machine over
  registry, epochs, records, conflict set, authorization state; prove the
  concrete tree, permutations, cache, and tickets preserve the abstract
  projection; define safety and eventual result usability separately. Keep
  the existing 3⁴ enumeration as small-scale counterexample checking; prefer
  stateful-sequence/concurrency/recovery verification or small model checking
  over line-by-line unit-test accumulation.
- Keep the two distinctions the review requires: "all declared checks passed"
  ≠ "check set suffices for arbitrary program correctness"; hash binding ≠
  checker attestation / remote attestation / distributed consensus.

## 9. Review §9 (structure and wording)

- Main line re-ordered: real diagnostic demand → fixed service contract →
  cost model → semantics-preserving mechanisms → optimization method →
  service-equal experiments → applicability domain. Merge the v7 "additional
  audit" into the main experimental questions; move version history, window
  negatives, exact-DP derivation, reproduction details to appendices.
- Introduction opens with a real trajectory showing when evidence delivery is
  on the critical path; one running failure-diagnosis example threads the
  paper. Architecture figure shows who produces trusted records, who consumes
  diagnostics, who maintains derived layouts, who owns final authorization;
  "virtualization" corresponds to an explicit interface + invariants.
- Title: adopt review's suggestion
  *"Adaptive HACT for Cost-Aware Delivery of Verification Evidence"* unless
  real agent gains are added, in which case re-center on long-horizon agentic
  software engineering. Abstract conclusions paragraph per review draft,
  updated with the new Phase-1 numbers.
- Wording fixes: "preregistered" → "pre-specified retrospective analysis"
  unless methods were frozen with verifiable timestamps before results access;
  "independent audit" limited to independent-arithmetic code path; third-party
  reproduction reported separately; keep "exact under fixed ordering and
  declared packet model", "authorization sound under trusted local boundary",
  "re-analysis of frozen data".

## 10. Review §10 — P0/P1 backlog with frozen acceptance criteria

Acceptance criteria are frozen NOW, before experiments (review §10 preamble).

### P0 (decide whether the main claims stand)

| # | Item | Deliverable & completion standard |
|---|---|---|
| P0-1 | Define the equal service | `docs/V8_SERVICE_CONTRACT.md`: frozen query set, snapshot/integrity/authentication contract; both representations pass the same semantic equivalence oracle on all 12 archived trajectories |
| P0-2 | Strong flat baseline | `experiments_v8/service_baselines.py`: indexed ledger with on-demand aggregation, compression, cache; build & maintenance costs counted on both sides |
| P0-3 | Real-query study | Query study on new project trajectories + real queries; complete costs, failures, and no-benefit cases all published |
| P0-4 | Higher-order ablation | Ablation ladder (§5) run on frozen data; either rung-3 gain over rung-2 demonstrated, or algorithmic-novelty claim narrowed |
| P0-5 | Title/abstract match evidence | Retitled manuscript + abstract; agent-efficiency language removed or supported by a quality-matched real agent study |
| P0-6 | Audit theory and numbers | Assumptions, proofs, independent statistical units, and every number's provenance re-verified; numbered-claims audit table in the repo |

### P1 (expand applicability / completeness)

| # | Item | Deliverable & completion standard |
|---|---|---|
| P1-1 | Scale & drift | Time holdout, project holdout, concurrency, refresh strategies; parameter-sensitivity analysis incl. re-derived fanouts |
| P1-2 | State-machine formalization | `docs/V8_STATE_MACHINE.md` + paper section: abstract machine, refinement proof, separate safety/usability definitions |
| P1-3 | Reproduction & presentation | Third-party clean-environment reproduction attempted and reported separately; unified body text; version residue and references cleaned |

### Submission gate (frozen)
Practical value: repeatable HACT benefit over the strong baseline on
pre-defined important diagnostic services (covering maintenance costs), or an
explanatory negative result with stated applicability domain. Novelty: at
least one mechanism/method supported by independent experiment or clear
theorem, distinguished item-by-item from prior work. Credibility: all
candidates and failures traceable; statistics match independent units;
semantic contract layout-invariant. If benefits appear only in heavily padded
synthetic packets or exhaustive paging, the research question is re-adjusted
before submission; if the real complete-diagnostic service benefits but agent
throughput barely moves, report as an evidence-infrastructure paper without
packaging byte savings as productivity gains.

## 11. Sequencing (what code runs first)

1. `docs/V8_SERVICE_CONTRACT.md` (P0-1) — no experiments; pure contract.
2. Equivalence oracle + `experiments_v8/service_baselines.py` (P0-2) over the
   12 archived trajectories; extend corpus with new-project offline records
   for the holdout requirement (P0-3 Phase-1 minimum).
3. `experiments_v8/higher_order_ablation.py` (P0-4) on frozen seeds + replays.
4. Numbers audit script (P0-6) regenerating every manuscript number from
   frozen artifacts.
5. Rewrite paper sections in review-§9 order; title/abstract last (P0-5).
6. P1 items interleaved only after P0-2/P0-3 land.

## 12. Out of scope / explicitly not claimed (unchanged)

No relabeling of replays as live verification; no new checker executions,
LLM trials, WAN trials, or BPE measurements until they actually run; hosted
inference, tokenizers, hidden prompts not mixed across arms; the v5 frozen
records remain the only primary-results source (`V7_EVIDENCE_CONTRACT.md`).
