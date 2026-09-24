# v2 Protocol Engine Notes (completion, ex ante)

**Written and committed 2026-09-24, before any v2 cohort data was
generated.** These notes complete under-specified engine details of the
frozen v2 protocol. They change no frozen constant, closure rule, arm,
or grid dimension. If any note conflicts with the frozen protocol, the
frozen protocol governs and the conflict is disclosed in the manuscript.

1. **Capsule binding membership (completes the accounting section).**
   A capsule carries an interface binding only for gates the policy has
   actually observed or fetched (a binding is a reference to a value the
   policy holds). Frontier-set members the policy has never seen are
   demands, not bindings, and are not charged the 16 B binding framing
   or a payload. This applies uniformly to `frontier` and
   `frontier-adaptive`. Rationale: the A1 audit defines a binding with
   no stored value as defective; charging bindings for never-seen gates
   would make the audit measure an accounting artifact rather than the
   retention mechanism. v1 charged all frontier-set members; v1 numbers
   are historical and are not recomputed under this rule.
2. **Long-horizon sub-cohort count.** The frozen v2 protocol states
   "42 runs" for the long-horizon grid but also states the grid
   unambiguously: 3 families × 7 seeds × 3 retention levels = 63 runs.
   The count is a typographical error in the frozen document. We run
   the grid (63 runs) and disclose the discrepancy here and in the
   manuscript rather than silently running either number.
3. **Phase boundaries for the 160-episode long-horizon runs.**
   Construction = episodes 0–4 (as frozen); audit tail = the last 5
   episodes (155–159); steady state = episodes 5–154. For the 40-episode
   main cohort this reduces exactly to the frozen 0–4 / 5–34 / 35–39.
4. **Use-clock semantics for `frontier-adaptive`.** A binding's use
   clock advances when the binding is served retained-fresh, or when
   its gate is re-observed (a fact arrives), or when it is first
   fetched (a fetch creates the binding; opened = the fetch episode).
   Eviction at end of episode: a binding outside the base frontier is
   dropped iff its last use is ≥ 8 episodes old AND it was opened ≥ 8
   episodes ago. Base-frontier members (current working set, boundary
   neighbors, dependency footprint, tracked obligations) are never
   evicted, per frozen exemptions (a)–(c).
5. **Audit comparison point.** The A2 pending-set comparison runs after
   the due-obligation resolution step of the audit episode, against the
   stream's true pending set {obligations opened at o : e − 6 < o ≤ e}.
   A1 stale-retention and phantom-binding checks run at the same point.
   A3 counts required reads served retained-fresh from an A1-defective
   binding, and obligations resolved from a phantom (A2) pending entry.
