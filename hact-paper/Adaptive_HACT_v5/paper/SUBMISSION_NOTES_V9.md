# Manuscript v9: review corrections

The manuscript is titled **Adaptive HACT: Semantics-Preserving Layouts for
Verification Evidence**. It preserves the conditional local theorem and
within-format representation results, and explicitly leaves comparative
agent-productivity benefits unestablished.

## Resolved findings

- Corrected percentage scale, penalty direction and workload-subset labels;
  the n=9 reference is restricted to permutations of one fixed topology.
- Query implementations read their own indexed ledger or kernel state. The
  learned permutation is applied to kernel positions; actual queries exercise
  FIFO caching. A separately implemented archived-record oracle detects even
  shared implementation errors.
- Paging includes all descriptors within the cap and rejects an oversized
  atomic field. Completed-wave count semantics, old-snapshot rebuilds and
  foreign-identity rejection have focused regression coverage.
- Network bytes, canonical serialized state, setup/maintenance, aggregation,
  encoding and decoding are separate resource ledgers. Setup allocation is
  independent of query order; modeled arrivals are explicitly arithmetic.
- Corrected v9 results are retained separately from unmodified v8 JSON. The
  new independent audit generates result macros, table rows and signed prose;
  tampering tests reject the errors that survived the historical 70-entry audit.
- The paper has one research-question map, a mechanism-level HMT comparison,
  and consistent abstract/conclusion scope. The old unequal-service flat table
  is removed from the current manuscript.

## Evidence boundaries

The corrected oracle has 168 matching comparisons and 84 layout-invariance
checks. The query study has 364 paired rows from the same 12 archived
candidates, not 364 independent projects or repairs. Equal answer bytes follow
from the same declared service and codec. Single-host timing is descriptive.
Prospective query-demand, held-out repository, live-agent and physical-WAN
studies remain future work. This revision does not claim journal acceptance or
a new beyond-pairwise optimizer result.

See `../docs/V9_CORRECTION_CONTRACT.md` for exact semantics and reproduction.
