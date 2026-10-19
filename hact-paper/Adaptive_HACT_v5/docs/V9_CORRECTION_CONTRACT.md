# V9 correction contract and reproduction

This revision addresses the 2026-10-19 manuscript/code review. It is a
post-review protocol correction, not a preregistered new experiment. Frozen
`results/v8/*` remain unchanged as historical records. Their service-cost and
near-optimality interpretations are withdrawn in manuscript v9. Existing v5
and v7 measurements keep their original provenance.

## Query service

The Q1--Q6 semantic selections are retained, including the separate Q6a/unit
and Q6b/integration predicates. A snapshot epoch is the number of completed
waves, so completed wave indices satisfy `0 <= wave < epoch`. Old snapshots
are rebuilt from their exact prefix; foreign candidate identities are rejected.

HACT applies the layout permutation to kernel gate positions, maintains trusted
leaf records and subtree capsules, and answers status using covered capsules.
The flat service appends full per-check events and uses a persistent semantic-ID
index into that ledger. Query methods do not call the archived-record reference
answer functions. The oracle independently recomputes the answer from archived
records and compares both services to that reference, in addition to comparing
them to each other. A shared implementation error must fail the oracle.

Coverage answers disclose the declared, executed and missing semantic ID sets.
Failure localization groups by stable test-file path (a semantic grouping,
not a layout node), and includes phase outcomes and archived wall seconds.
These are trusted local queries, not authenticated membership proofs. Q6's
"unit" predicate denotes the frozen tests-directory predicate, not a new
classification of test adequacy.

Query results use a bounded FIFO cache, keyed by query ID, epoch, semantic set,
mode and replay wave. Epoch changes clear it. Every page, including page one,
carries its number and total count; descriptor/header bytes count toward the
16,384-byte cap. An indivisible item that cannot fit is rejected. A decoder
checks page order, total count and semantic reconstruction.

## Corrected retrospective measurement

The same 12 archived candidates are used; no new checker, LLM or network
execution is implied. Original and learned balanced layouts are both measured.
Q3 is explicitly added to the earlier cost workload. Each query is issued twice:
cold query cache, then warm. The seeded additional replay waves are retained;
arm execution order is independently seeded. Input-file SHA-256 hashes are
recorded. One timing campaign is descriptive host elapsed time, not a statistical
latency comparison or a CPU-instruction measurement.

Separate ledgers record:

- Compressed answer bytes crossing a *modeled* link; both sides use the same
  semantic JSON-lines framing and DEFLATE level six. Equality is a consequence
  of this service/codec policy, not discovery of a universal compression bound.
- Canonically serialized persistent state, excluding duplicate query-cache
  objects. This is a logical storage metric, not RAM footprint or wire traffic.
- Construction and ingestion/tree-maintenance elapsed time and logical update
  bytes, measured before the query trace, plus query aggregation, encoding,
  decompression and page-reconstruction elapsed time.
- Cache hits/misses and logical page messages. Messages are not measured RTTs.

Setup CPU is reported once per trajectory/layout and allocated uniformly across
that trace's queries solely in the arithmetic arrival model. It is never assigned
only to the first query family. No local storage or update bytes are added to
network bytes. Modeled arrival is archived serial completion time plus allocated
setup, measured query processing and compressed answer bytes / declared 1 MiB/s.
All such arrival entries are explicitly marked simulated/arithmetic. The strict
byte-and-time rule cannot declare a gain when answer bytes tie. The Amdahl
observed-ratio estimate and infinite-aggregation-speed ceiling are separate.

## Numerical corrections and scope

The archived ablation is re-analyzed without relabeling it a new run. Positive
`(rung4-rung2)/rung2` means a cost penalty. Rung4 uses the original order and
therefore cannot isolate tree-shape headroom relative to a learned-order tree.
Fractions in historically named `*_pct` fields must be multiplied by 100 for
percent display. The n=9 search is exhaustive only over permutations of the
fixed compact-balanced topology; its maximum observed gap is 5.93%, not 0.06%.
No global topology optimum or held-out guarantee follows from that fitted sample.

`audit/check_v9.py` imports no service, optimizer or codec implementation. It
reconstructs current result totals, signed ablation differences and Amdahl
arithmetic from committed JSON, verifies input digests and produces the exact
LaTeX result macros/table consumed by the manuscript. Its default mode verifies;
`--write` explicitly regenerates derived files. Tests deliberately corrupt prose
macros and results to verify that the audit rejects them.

## Reproduce

From `hact-paper/Adaptive_HACT_v5`:

```sh
python -m experiments_v8.service_oracle /tmp/hact-v9-equivalence.json
python -m experiments_v8.real_query_study /tmp/hact-v9-cost-study.json
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q tests_v7
python -m audit.numbers_audit
python -m audit.check_v9
python tools/verify_manifest.py
cd paper
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

Fresh timing values vary by host. Deterministic semantic digests, byte counts,
operation counts, cache events and page caps are regression checked. The
historical 70-entry audit remains a historical consistency check; it is not
claimed to have validated the original incorrect prose.
