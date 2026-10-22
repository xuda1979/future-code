# V12 observer-cost service ablation

Frozen before new timing executions, 2026-10-21. This is a separate follow-up
experiment motivated by the internal v12 review, not a correction or replacement
of v11 observations. All outcomes will be retained and reported.

Use the twelve cases in `results/v11/public_compiler/SERVICE_CASES.json` and the
same v11 fitted layouts without refitting. Retain the two Packaging resource
exclusions as UNKNOWN. On the ten admitted cases run three complete trajectory
repeats. Compare eight arms: the four original services (indexed ledger,
maintained-counter ledger, original HACT, selected cap-32 HACT), each with the
original instrumentation and with observational byte-count serialization
disabled. Randomize the eight-arm order within each case/repeat using a fixed
local RNG seeded 20261022. Keep all original functional work, including record
copies, validation, semantic caches, evidence digests, kernel refresh and packet
serialization, the common answer codec, and compression/decompression checks.

Disable only serialization and related counters used solely to observe bytes
scanned, updated, built or stored. Do not interpret disabled byte counters as
measurements. Preserve the original classes unchanged; new subclasses live in
`experiments_v12/observer_ablation.py`. Input snapshot/oracle preparation remains
outside the timed operations as in v11. Every semantic, wire and compressed
answer must agree with the raw-record oracle and across arms. Test foreign
snapshots and rewind behavior before the campaign. Retain raw operation timings,
arm order, semantic digests, source/input hashes and runtime inventory.

Report per-case median build+ingest+query seconds, selected-HACT/counter ratios
for both instrumentation states, paired timing-repeat ranges, and all exclusions.
Do not use statistical significance, replace the primary cap-32 layout, tune
implementations based on timings, or claim production-system speed. A correctness
failure invalidates the affected arm/case and stops promotion. Per-arm deadline:
180 seconds. CPU only; total campaign wall budget 15 minutes, new data 50 MiB.
