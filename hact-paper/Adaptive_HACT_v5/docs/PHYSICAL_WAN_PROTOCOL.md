# Physical-WAN measurement protocol (provided, NOT EXECUTED)

## Authorization and environment

Use two hosts controlled by the operator on distinct physical network locations.
Document each host, region, provider, route/proxy/VPN characteristics, operating
system, TLS implementation, payload provenance and clock source. Do not classify
a public repository download, same-host loopback or unknown proxy as a paired WAN
export experiment. Obtain permission to transmit the evidence. Restrict receiver
access with a firewall, protect the server key and use valid certificate/hostname
verification. This minimal receiver is not a production service or mTLS access
management system.

## Freeze comparisons before running

Use the same twelve-candidate replay cohort for fixed and balanced layouts, and
optionally exact as a third arm. Freeze payload hashes, `packet_zlib` versus
`batch_zlib`, connection reuse policy, number of repetitions, retry policy,
endpoint pair, trial randomization seed and stopping criteria before any outcomes.
Canonical and compressed services must be compared separately. Do not compare a
warm connection with a cold TLS handshake or streaming with whole-epoch delivery
as though all other costs cancel. Include all failed, timed-out and retried trials.

Record actual file sizes and total application bytes. Do not assume the historical
40-byte acknowledgment: the TLS utility has a different bounded JSON acknowledgment
and reports its actual application framing. TLS record and IP overhead are not in
that field. Encode and prepare archives once for a transport-only experiment, or
explicitly include these costs in an end-to-end protocol; never mix the two.

## Example controlled receiver and consent-gated sender

Generate or provision certificates outside the research package. Do not place
private keys in the release or publish them with measurements. On the receiver:

```bash
python tools/tls_export_receiver.py --bind 0.0.0.0 --authorize-network-bind \
  --port 8443 --cert /secure/server-cert.pem --key /secure/server-key.pem \
  --connections 24 --output /measurements/receiver.jsonl
```

On the sender (replace the example host with an authorized real endpoint):

```bash
python tools/tls_export_probe.py --host YOUR_AUTHORIZED_HOST --port 8443 \
  --server-name YOUR_CERTIFICATE_HOSTNAME --ca-file /secure/trusted-ca.pem \
  --wire-file /measurements/fixed/evidence.hact \
  --authorize-upload --output /measurements/trial-000.json
```

The one-shot CLI measures a cold connection. To test reuse, an operator-controlled
runner must use the `connect`/`send_one` library with a receiver session loop and
record the policy explicitly; the provided one-shot receiver is not claimed to
run a full reuse campaign. Warm sessions are tested locally at library level only.
New output files are required. Keep command stderr and timeout/connection failures;
a lack of a successful JSON output is not an empty successful trial. Do not retry
silently until a favorable observation appears.

## Required ledgers

Report DNS+TCP connection time, TLS handshake time, negotiated version/cipher,
server-certificate fingerprint, send-to-ack time, decoded packet count and content
hash. Use application timing for application service—not TCP RTT. Record baseline
RTT and bottleneck goodput independently under a documented method. Where authorized
OS instrumentation exists, collect retransmissions/loss, kernel TCP metrics and
packet/jitter observations. Otherwise retain null values. An RFC 6349-style TCP
throughput characterization is useful background but this tool does not implement
that entire framework.

Do not use application-level rate limiting in a trial called physical-WAN natural
path measurement. Separately labeled emulation experiments may vary delay/loss,
but must not be pooled with the natural path. Run both arms under the same
congestion regime and interleave them to reduce time-of-day confounding.

## Analysis and publication boundary

Summarize per-candidate paired times and the entire cohort, confidence intervals
at the independent trial/path level, failure rate and tail latency. Distinguish
cold handshake overhead from steady-state delivery. Break down encoding, checking,
preparation, transfer, receipt/decoding and concurrency. Report the critical path
when delivery overlaps other work. Include a compression-only baseline and a root
or flat ledger only if its different delivery contract is explicit.

Only populate WAN result fields after executing this protocol. This release
contains no physical-WAN observations and no evidence that the balanced default
improves a production agent's end-to-end time.
