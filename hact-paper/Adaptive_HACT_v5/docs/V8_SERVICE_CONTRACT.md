# V8 service contract — layout-independent diagnostic queries (frozen)

Status: **frozen before any V8 experiment runs** (review 2026-10-09 §3, §10).
This contract defines the equal-service comparison demanded by the review: a
fixed query semantics `Q(e, S, mode, budget)` that BOTH the hierarchical
certificate tree (HACT) and any flat-ledger baseline must answer, with
identical semantics, independent of tree node numbering or layout state.

Any representation claiming service equivalence must pass the equivalence
oracle in `experiments_v8/service_oracle.py` for every query below, on every
trajectory in the frozen corpus. Answer completeness, snapshot identity,
freshness, and missing-result disclosure are part of the answer, not
optional metadata.

## 1. Identity and scope

- `e = (candidate_id, checker_id, environment_id, registry_hash)` — the
  candidate/registry identity tuple. Taken from the archived report fields
  (`snapshot`, `checker`, `environment`, `registry_hash`).
- `S` — a semantic check set: a list of registry member IDs (stable semantic
  IDs, never tree positions), or a fixed predicate over registry members
  (e.g., `integration`, `unit`, `all`, `failing`, `unfinished`).
- `mode ∈ {status, failure_localization, coverage_proof, replay}` (§3).
- `budget` — maximum serialized bytes for one complete answer message;
  larger answers MUST be paged with an explicit page descriptor and total
  page count, never silently truncated.

## 2. Frozen query set

All queries are answered against a frozen trajectory (an ordered sequence of
trusted completion records for candidate `e`). The corpus is: the 12 archived
v5 candidates (`results/v3/fresh_checkers/*/**/pytest_evidence.json` +
`report.json`), plus any additional offline corpora added under §6 (each
addition must state provenance and must not re-use already-analyzed
candidates as "new" evidence).

| ID | Query | `S` | `mode` | Notes |
|---|---|---|---|---|
| Q1 | Full candidate status rollup | `all` | status | verdict, per-check PASS/FAIL/UNKNOWN counts, unfinished obligations |
| Q2 | Failing checks with localized context | `failing` | failure_localization | failing check IDs, their per-phase outcomes, and the smallest declared diagnostic grouping containing each failure |
| Q3 | Unfinished obligations | `unfinished` | status | obligations declared but not completed at query time |
| Q4 | Coverage proof for a declared contract | `all` | coverage_proof | the declared check set, what ran, what did not, and the resulting authorization state |
| Q5 | Replay of a completed wave | any executed wave | replay | re-derive the recorded wave's rollup from per-check records |
| Q6 | Status of a semantic subtree selection | `unit` or `integration` | status | status restricted to a predicate-defined member set — evaluated on semantic IDs, not tree nodes |

Q6 is the query that makes node-independence testable: after a layout
change, the "same subtree" question must be answered by semantic selection,
so a tree implementation may not equate "one tree node" with "one unit of
work". Both implementations report the per-semantic-check work performed.

## 3. Modes

- `status`: current rollup for `S` under snapshot identity `e`; must include
  freshness (last completed wave index/epoch) and explicit UNKNOWN disclosure
  for checks with no completed record.
- `failure_localization`: for each failing member in `S`: check ID, phase
  outcomes, wall seconds where archived, and the smallest declared grouping
  (from `report.json` tree/grouping metadata) containing it. Answers must be
  identical across representations.
- `coverage_proof`: the declared obligation set for `e`, the executed set,
  the missing set, and the authorization state under the frozen rules
  (all-declared-passed ⇒ eligible; otherwise not). "All declared checks
  passed" is never conflated with "the check set suffices for arbitrary
  program correctness".
- `replay`: given a wave index, return its recorded rollup. Re-derivation
  must be byte-identical on the semantic content (field-level equality;
  serialization may differ between representations only in declared,
  service-external framing bytes).

## 4. Snapshot, freshness, disclosure

- A query is answered against an immutable snapshot of the trajectory up to a
  stated wave/epoch; the answer carries that epoch. No answer may mix waves.
- Stale-epoch answers to a newer query are rejected with an explicit stale
  disclosure, never silently upgraded.
- Missing results (no record for a member of `S`) are disclosed as UNKNOWN
  with the member ID — never omitted.

## 5. Authentication (if required)

If any consumer requires authenticated answers: the trusted root (or other
declared authentication model) is fixed per `e`; BOTH representations
receive the same authentication capability (e.g., flat ledger authenticates
via per-answer MAC under the same root; HACT via certificate paths). No
comparison is run with authentication on one side only. Hash binding is not
claimed to be checker attestation, remote attestation, or consensus.

## 6. Baseline obligations (indexed flat ledger)

The strong baseline must provide, with costs counted (§7):
1. per-check index over the ledger (build + maintenance cost);
2. on-demand aggregation for Q1–Q6 (CPU cost measured, not assumed);
3. compression: per-answer DEFLATE and whole-ledger DEFLATE (same codec
   settings as any tree-side compression);
4. caching with declared eviction; cache hits reported;
5. paging under `budget` with the same page-descriptor semantics;
6. failure disclosure and UNKNOWN handling identical to §4.

A leaf-only ledger without these capabilities is NOT the baseline; it is the
(retired) `tab:v7flat` byte table, retained only as a storage-form sanity
check.

## 7. Cost accounting (both sides, identical rules)

Index build and maintenance; storage; aggregation CPU; encode/decode; cache
hits; round trips (logical: number of complete messages to first full
answer); paging; failure disclosure; complete-answer arrival time (from
archived per-phase timings where available; otherwise clearly marked
simulated/arithmetic, never measured-latency claims). Compression method,
connection reuse, and concurrency rules are identical across arms.

## 8. Equivalence oracle (acceptance for P0-1)

For every trajectory in the frozen corpus and every query Q1–Q6:
1. run the query on the HACT representation (original-order balanced, and
   learned layout — layout must not change the answer);
2. run the query on the indexed flat baseline;
3. compare answers field-by-field on the semantic content defined in §3;
4. PASS iff all fields equal, both disclose identical UNKNOWN sets, and both
   report the same epoch/freshness.

Acceptance standard (frozen): 12/12 archived trajectories × 6 queries
equivalent under both the original-order and learned layouts, oracle output
committed to the repo as a JSON artifact with per-query equality booleans.

## 9. Decision rule for the service study (frozen, review §1/§3)

HACT is reported as beneficial for a query family iff, at equal answer
completeness: complete-answer bytes AND complete-answer arrival time (as far
as archived timings permit; otherwise bytes only, with the limitation stated)
improve against the indexed flat ledger with all maintenance costs included.
If HACT wins only on some query families, the applicability domain is
published as the result. If HACT does not win, that negative result is
published and the necessity of maintaining the hierarchy is re-evaluated in
the discussion. The Amdahl decomposition (review §7) is reported from
measured f, never from assumed fractions.
