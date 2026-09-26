# Response to the v4 review — Adaptive HACT v5.0

The paper is now **Adaptive HACT: Service-Matched Verification Evidence and
Deployment Boundaries**. The revised recommendation is simpler, and the deployment
claim is narrower. This response distinguishes completed revisions from empirical
requests that remain unfulfilled.

## R1. Block DP loses to a same-order balanced tree

**Addressed in the practical code, experiments and manuscript.** The primary
catalogue now retains the incumbent and proposes compact balanced eight-ary trees
on original and training-learned average-linkage orders. No exact or block DP is
called by `ichact.practical` or `tools/compile_practical.py`; a regression test makes
an optimizer call fail. Separate validation scores the actual complete-wave padded
costs. A tie keeps the incumbent. Exact DP remains the conditional optimum and an
offline reference/optional candidate. The block-backbone theorem and implementation
are retained only as an appendix ablation, including the adverse v4 results.

We did not transfer the old exact-layout savings to the new default. A new frozen
synthetic study has 27 workloads with disjoint 128/128/256 training, validation and
held-out draws. Clustered mean savings are 23.43%, 10.75%, and 5.56% at 128, 512 and
1,024 checks; independent and global controls provide essentially no gain. Only
three seeds occur per setting: we report observed ranges, not strong inferential
claims from thousands of correlated episodes.

Twelve archived source candidates are additionally re-aggregated under fixed8,
learned balanced and learned exact layouts. The 36 replays are not fresh checkers
or autonomous code repairs. Learned balanced has smaller evidence than original
fixed8 but remains larger than exact learned layouts on all three source projects.
This resolves the compiler's identity without asserting that the new default wins
every cost objective.

## R2. Strict-gate cost dwarfs the reported export saving

**Addressed as a corrected comparison and explicit planning model, not as a new
measured end-to-end speedup.** The introduction distinguishes: (a) root/flat status
consumers, (b) deployments already requiring protected hierarchical verification,
and (c) adoption of a strict gate where ordinary pytest previously sufficed.
For (a), no learned tree is needed. For (b), compare incremental layout costs under
an unchanged service. For (c), justify the gate independently; transmission
savings do not establish that adoption is worthwhile.

The new calculator requires codec- and service-matched inputs. It implements
`gain(q) = q * (delta_bytes / goodput - extra_per_copy) - extra_once` and requires
strictly positive gain. Missing measurements are UNKNOWN; unequal services are
INCOMPARABLE. Decimal arithmetic protects exact break-even. This accounting is
not claimed as a new theorem or a WAN latency predictor.

For the new balanced replay, compressed bytes fall from 416,046 to 299,081 across
twelve candidates. At an assumed 64 KiB/s and zero added per-copy processing, that
is 1.784744 seconds of gross service-model saving per cohort copy, **not a measured
time**. If extra work is assumed to be 0.05, 0.5 or 5 seconds per candidate, the
minimum profitable copies of that same cohort are 1, 4 and 34. One export with a
hypothetical 60 seconds of cohort overhead is plainly unattractive. These overheads
are sensitivity assumptions, not measurements transplanted from the old harness.
A new candidate each time incurs new preparation and cannot reuse this amortization.

The old 2.21-second compressed export improvement and approximately 5-second
strict-gate premium remain explicitly different-cohort historical controls.
No new deployment payback has been observed. High RTT alone does not increase
byte-dependent savings when both variants pay the same setup and request count.

## R3. Physical WAN, jitter/loss and TLS are absent

**Partially addressed; physical-WAN evaluation remains NOT RUN.** A new opt-in TLS
measurement client/receiver enforces certificate validation, hostname checking,
bounded frames, validated decompression and acknowledgment identity. Local tests
exercise cold and reused sessions, incorrect hostnames, untrusted roots, oversized
and truncated frames, and invalid acknowledgments. No insecure TLS fallback exists.

These tests are protocol compatibility tests, not WAN measurements. No authorized
pair of remote controlled hosts was available; we did not upload evidence to a
public endpoint or relabel a proxied download as a paired export experiment.
`docs/PHYSICAL_WAN_PROTOCOL.md` specifies matched payloads, cold/warm connections,
trial order, failures, path provenance and independent RTT/transport measurements.
The minimal tool leaves unobserved RTT, loss, retransmissions and IP bytes null.
An actual WAN campaign is still needed before archival claims about that regime.

TLS authenticates the configured server, not an uncompromised remote checker or
an immutable acceptance contract. The measurement receiver lacks production client
accounts and must be restricted by the operator's firewall. Attestation, consensus,
non-repudiation and OS isolation remain outside the implementation.

## R4. Actual BPE tokenizer and agent dynamics

**Partially addressed; actual public-vocabulary tokenization and live agents remain
unmeasured.** The dual-cap API invokes an explicit tokenizer on every complete
proposed UTF-8 page, including its prefix, rather than summing token counts of
fragments. It preserves whole mandatory packets and rejects overflow. A real
`tiktoken` measurement runner supports explicit `cl100k_base` and `o200k_base`,
records vocabulary/pattern fingerprints and page hashes, and excludes unobserved
provider framing and billing.

Both requested encodings returned UNKNOWN because the package was absent.
Package installation and official vocabulary retrieval failed; an alternative
connector-discovered build artifact was expired. No small invented vocabulary,
toy test counter or bytes/4 estimate was substituted. Toy-counter unit tests prove
only admission-control mechanics. There are no numerical BPE results in this paper.

Root text is identical in all twelve new layout triples (593–594 bytes), which
implies equal content token counts under any fixed deterministic tokenizer but
does not supply their numeric values. Exhaustive byte-bounded pages are 148/95/87
for fixed/balanced/exact. This is not measured LLM retrieval behavior. The artifact
still includes no live-LLM patch generation, SWE-bench or new natural-bug cohort.

## R5. Preserve provenance, negative controls and reproducibility

**Addressed.** Historical v3 and v4 observations retain their own cohort/version
identities. New v5 results comprise 27 synthetic workloads, 36 layout replays and
27 conditional planning scenarios—not an inflated number of checker successes.
There are zero v5 physical-WAN, hosted-model or fresh-source-checker trials.
The final prototype has 329 passing tests, including 76 new cases; unmodified
Future Code has 263 passing tests separately. The independent v5 audit reconstructs
costs, source identity, codec sizes, root invariance, diagnostic pages, planning
and 131 summary numeric comparisons without importing production algorithms.
The release verification records extracted-package testing and file identity.

Two scope clarifications were retained: ordering can reduce **uncompressed
hierarchical** evidence too, but compression is often the stronger baseline;
a flat final ledger is smaller because it omits intermediate diagnostic records.
The result is neither a universal logging replacement nor a reason to deploy
expensive verification solely for a modest export saving.
