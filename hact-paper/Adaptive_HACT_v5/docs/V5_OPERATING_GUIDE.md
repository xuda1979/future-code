# Adaptive HACT v5 — Operating guide

## 1. Select the appropriate service

Use a root status card when a trusted supervisor only needs the current result.
Use a flat status ledger when it needs final per-check outcomes. Require a
hierarchical diagnostic archive only when intermediate aggregation evidence is
actually needed. Changing this service is not a tree-layout performance comparison.
Adopting the strict gate from ordinary pytest is a separate engineering/security
decision; the measured byte savings do not justify its overhead by themselves.

## 2. Compile the low-cost candidate

The new default is **training-learned average-linkage order + compact balanced8**,
with incumbent retention. `tools/compile_practical.py` takes the example schema in
`examples/practical_input.json`. Training and validation must be separate epochs;
waves use the approved registry's integer indices. No mandatory input is trimmed.
Empty/malformed waves, wrong registries and packet limits are validated by the
underlying layout APIs. The candidate's semantic registry is unchanged.

```bash
python tools/compile_practical.py --input examples/practical_input.json --output /tmp/hact-candidate
```

The tool refuses an existing output directory. Inspect `selection.json` and the
actual deployment codec before installing `layout.json`. Its scores are padded
certificate bytes, not compression or latency. The library API additionally accepts
an explicit incumbent; CLI callers should integrate that policy before automating
migration from an existing non-default layout. The example CLI does not make an
automatic deployment or override the acceptance contract.

Exact DP remains a valid offline reference, especially when extra byte savings
will be delivered many times. Block DP is an ablation and is never called on this
path. Learning the order still costs seconds at 1,024 checks in the recorded host;
cache layouts and compile away from the per-agent action loop. The older CLI and
Future Code bridge can consume an approved layout. They are not replaced by an
unmeasured always-on learned controller.

## 3. Price only matching services

Use `assess_delivery` with observed application bytes for the same codec and
consistently amortized costs. The service identity should bind the acceptance
contract, cohort, diagnostic scope, codec and connection policy. A caller-supplied
name is not cryptographic proof that the services match; the operator must establish
that fact. Different names return INCOMPARABLE; missing costs/goodput return UNKNOWN.

The model assumes one nonoverlapped bottleneck and repeated copies of the same
workload. At exact equality, keep the incumbent. Do not omit preparation, hashing,
compression, migration or receiver work merely because they are inconvenient.
A new candidate incurs fresh preparation. Parallelism, cached uploads and common
handshakes change the critical path; measure them rather than adding unrelated
benchmark medians. A slow RTT alone does not prove that fewer bytes reduce latency.

The frozen `PricedWindow` is optional and chooses among precompiled layouts using
past full-wave costs. Its 64-event forecast is heuristic, not future payback proof.
Use `choose()` before `observe()` and checkpoint only at event boundaries. The
stable-ID guard revokes publication tickets on a migration, increments generation
and rebuilds; it never reuses a display-index cache as another semantic check.

## 4. Generate bounded diagnostics

```bash
python tools/export_evidence.py \
  --report results/v5/source_replay/networkx_confirm_000-learned_balanced/report.json \
  --packets results/v5/source_replay/networkx_confirm_000-learned_balanced/certificate_packets.bin \
  --mode batch_zlib --output /tmp/hact-export
```

This is a display/export of an already trusted record. It does not authorize
untrusted report JSON. Whole-epoch compression needs a finished archive; streaming
individual packets requires a different codec/latency comparison. Ordinary status
should consume `status.txt`, not all diagnostic pages by default.

## 5. Measure real content tokens when an encoding is available

`tools/measure_bpe.py` requires actual `tiktoken` and its public encoding data. It
can read the v5 36-replay cohort or the older v4 24-archive cohort. Use explicit
encoding names, save vocabulary and pretokenizer fingerprints, and retain per-page
hashes. The optional library may download a public vocabulary if not already cached.
No model endpoint or billing API is called.

```bash
python tools/measure_bpe.py --cohort v5 --encoding cl100k_base \
  --token-budget 4096 --reserved-tokens 256 --output /tmp/hact-bpe-cl100k.json
```

The 256-token reservation in this example is an **operator assumption**, not
measured provider framing. The whole supplied text is retokenized for every proposed
page: fragment counts cannot simply be summed. Mandatory packets are not truncated.
Missing package/vocabulary produces exit 2, UNKNOWN and null counts. Both actual
encoding attempts in this release failed; test-only counters are not BPE evidence.
A content token count does not include hidden prompts, generated outputs or billing.

## 6. Remote measurements require authorization

Follow `PHYSICAL_WAN_PROTOCOL.md`. The TLS tools never disable certificate or
hostname verification, require explicit upload/nonlocal-binding consent, and bound
frames, decompression and acknowledgments. Receiver access must be restricted by
the operator; there is no production client-account layer. No credentials are
searched and no public endpoint receives data by default.

The release tests local TLS behavior only. It contains no physical-WAN trial,
measured loss/RTT/retransmission series or live-model evaluation. Do not label
loopback, download timings or unverified proxy routes as those experiments.

## 7. Reproduce without changing released evidence

Run `tools/reproduce_v5.py --destination NEW_EXTERNAL_DIRECTORY`. It copies the
release, regenerates the frozen layout experiments and re-aggregates historical
check records. Original failed tokenizer attempts remain labeled historical; there
is no implicit network access. For a new tokenizer measurement use a new output
file separately. Outputs and paper claims from another host should retain their
own runtime identity and should not overwrite the original measured timings.

Run `python -m audit.check_v5` to reconstruct costs and provenance. Run
`python tools/verify_manifest.py` only in the untouched release, not the reproduction
copy whose observations have intentionally changed. To verify all tests, run
pytest at the root, and then separately in `vendor/future`. The latter is not a
substitute for the prototype suite or a new autonomous-agent benchmark.

## 8. Safety and interpretation

PASS means the complete declared checks were passed on the bound candidate under
the trusted checker assumptions. It does not prove arbitrary correctness. A
compromised checker, missing dependency, replaced reference digest or unsafe tool
execution can invalidate a broader conclusion. TLS server authentication is not
checker attestation. This is a single-host research control plane, not a production
multi-host consensus, sandbox or tamper-proof verification product.
