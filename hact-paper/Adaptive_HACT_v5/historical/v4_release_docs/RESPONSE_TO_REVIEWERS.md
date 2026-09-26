# Response to the second Adaptive HACT review — v4.0

September 20, 2026. The main manuscript is now **Adaptive HACT: Bounded Verification
Evidence for Bandwidth-Constrained Systems**. The original v3 source, measurements,
and response are retained and labeled historical. References below name the section
titles so they remain useful if typesetting changes page numbers.

## 1. Divergence between bytes and wall-clock time

**Response: accepted; central claim changed.** The abstract, introduction, discussion
and conclusion no longer position the method as local harness acceleration. They
lead with the unchanged source-checker time and the roughly five-second strict-gate
premium. A new section, “What Reduced Evidence Can and Cannot Buy,” distinguishes
the local aggregator, remote logging consumer and status/diagnostic supervisor.

New measurements run 288 real receiver-paced loopback TCP transfers of the 24
existing source-checker archives. The paired data, framing, two repetitions and
three rate settings were frozen before new measurements. At 64 KiB/s, compressed
exports take 6.624 versus 4.413 seconds across 12 exports, averaged over the repeats.
That is approximately 2.21 seconds over the cohort, not per candidate and not an
end-to-end agent speedup. All transfer trials remain in the data.

We added canonical JSON, per-packet DEFLATE and whole-epoch DEFLATE controls. Whole-
epoch compression reduces learned-layout byte advantages to 5.80–47.92%, depending
on the project. The low Toolz result is retained. Compression itself is a larger
immediate optimization than layout in this cohort. Epoch compression changes the
streaming service; only its post-verification archive is timed as such.

**Residual limitation:** loopback application pacing is not a physical WAN, an edge
deployment, TLS, multi-link concurrency, a lossy channel or a full agent critical
path. Compiler cost is measured separately, not hidden in the transfer savings.

## 2. Weak practical motivation for fixed-share tracking

**Response: accepted; practical and theoretical roles separated.** The main practical
method is the existing deterministic 64-event priced-window comparator. It is now a
runtime API with sequencing validation, bounded state, explicit migration accounting,
checkpoint/resume and tests. The online section states its assumption of exogenous,
full-information costs and its lack of a distribution-free switching guarantee.

The coupled fixed-share theorem and proof move to the appendix titled “Optional
Fixed-Share Tracking Analysis.” The earlier adverse results are retained. No new
adversarial example is manufactured to rescue that method's recommendation.

All 80 archived online streams, totaling 163,840 events, were replayed through the
new window API. Every action and cost matches the frozen earlier baseline, including
periodic checkpointing. This is compatibility evidence, not 80 new agent experiments.
The last-event greedy baseline still wins on the rapid-shift family; the window is
not called universally best.

## 3. Quantify the supervisor-context effect

**Response: addressed with an explicit null result and a conditional positive result.**
The root-status projection is identical for all 12 fixed/learned candidate pairs:
593–594 UTF-8 bytes, with **zero layout-induced saving**. The paper gives the simple
identity explaining why any fixed deterministic tokenizer would also yield identical
counts on these identical strings. This is an interface property, not a new theorem.

An exhaustive diagnostic reader, using complete packets and a 16,384-byte request
cap, needs 148 versus 87 pages over the cohort (41.22% fewer). The maximum observed
page is 16,364 bytes. Selective retrieval may read much less; no LLM consumed these
pages in the study. Total diagnostic traffic and maximum single-request context are
separate quantities.

**Residual limitation:** actual tokenizer/provider counts were not measured. No local
tokenizer was installed and package/vocabulary retrieval failed under the available
network environment. Counts remain null; no bytes/4 conversion or assumed model
context is used. The supplied optional hook calls an actual tokenizer when available.

## 4. Scaling and compilation frequency

**Response: optional constrained compiler added and tested, with unfavorable controls.**
We add a fixed-order, fixed-block, fixed-backbone compiler. Exact DP is restricted
to blocks of at most s checks, giving O(b n s^2) DP operations and O(b s^2) reusable
DP workspace. A proposition proves exactness only within this constrained class.
Input trace preparation and order learning are explicitly excluded from those DP
bounds and measured separately. No global approximation factor is claimed.

On 18 new frozen synthetic workloads, at 512 checks microtree fitting is about
25–26 times faster than a same-order exact DP, with 0.40–3.40% mean held-out byte
penalties. At 1,024 checks fitting takes 0.26–0.28 seconds, while ordering takes
2.84–3.20 seconds; the exact baseline was not run there. The previous 18.435-second
measurement fitted a three-proposal catalogue and is not presented as a comparable
single-DP baseline on this runtime.

The constrained compiler also loses 1.54–5.34% in held-out bytes to a balanced tree
on the same learned order across the six settings. It is therefore optional; the
operating guide retains both the balanced candidate and incumbent during selection.
Order reuse and off-hot-path compilation remain recommended.

## 5. Bandwidth-focused narrative and integrity language

**Response: accepted with a necessary correction to “tamper-proof.”** A stable-ID
verification contract with generation fencing is not a remotely authenticated or
tamper-proof protocol. We state exactly which local state must be protected and
which soundness/dependency assumptions are required. Compression and schema checks
preserve encoded records but do not make an untrusted producer truthful.

The receiver's digest is supplied by a trusted experimental reference. Replacement
of both payload and reference is outside its guarantee. No signatures, attestation,
key management, Byzantine consensus or durable external monotone counters are claimed.
The easiest adequate solution remains a root card for a trusted dashboard or a flat
final-status ledger for a simpler consumer; both are documented alternatives, not
hidden baselines.

## 6. Absence of autonomous LLM workloads

**Response: still unaddressed empirically, and made more explicit.** The retained v3
harness is real software execution driven by scripted endpoint replies. V4 adds
transport and compiler measurements, not live model generation or natural issue
resolution. No designated authorized endpoint or model budget was supplied for this
revision, and private credentials were not searched. No SWE-bench score or provider
usage is claimed. The paper's empirical claim is correspondingly a systems/evidence
claim, not a MAS reasoning or autonomous-development benchmark claim.

## Verification and release

The revised prototype has 253 passing tests (66 new relative to v3); the unmodified
Future Code suite has 263 passing tests, separately. The independent v4 auditor
reconstructs the raw records and verifies 125 numerical summary comparisons without
importing the producer codec or optimizer. The earlier v3 audit also passes.
The final archive is extracted and verified again; the external release-verification
JSON records its exact SHA-256, manifest count and extracted test output.

These changes refine rather than enlarge the unsupported claims. They do not imply
conference acceptance, universal wins, independently certified security, or an
unmeasured successful live-agent baseline.
