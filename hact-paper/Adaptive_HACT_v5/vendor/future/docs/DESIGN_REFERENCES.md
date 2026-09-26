# Primary design references

These references informed transport and evidence-design choices. They are not proof
that this implementation is conformant, secure, production-ready or fully integrated.
The executed checks are recorded separately in TEST_REPORT.md.

- HTTPX resource limits: https://www.python-httpx.org/advanced/resource-limits/
- HTTPX timeouts: https://www.python-httpx.org/advanced/timeouts/
- AWS Builders' Library, timeouts/retries/backoff with jitter:
  https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- OpenTelemetry signal taxonomy (this release does not implement an OTLP exporter):
  https://opentelemetry.io/docs/concepts/signals/
- NIST Generative AI Profile (not a certification claim):
  https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence

These transport/evidence references were recorded in the 1.1 delivery. New 1.2
coordination research, with checked versions, is in [RESEARCH.md](RESEARCH.md). No dependencies
were upgraded merely to claim use of the newest version. The environment/lock files
record concrete tested versions, not an assertion that they are currently the newest.
