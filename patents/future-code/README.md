# Future-Code patent materials

This directory holds the **reviewed** Chinese invention disclosure and preliminary prior-art search report, following the supplied documents' original top-level chapter structure.

- [INVENTION_DISCLOSURE_CN.md](INVENTION_DISCLOSURE_CN.md): eleven original top-level sections, three diagram source blocks, thirteen proposed claims; inventor names **许达、王飞** (listed in supplied order; final order and ownership require confirmation).
- [PRIOR_ART_SEARCH_CN.md](PRIOR_ART_SEARCH_CN.md): original twelve top-level sections including sources A-E, risk analysis, claim matrix and filing strategy. Includes closer adverse prior art from Temporal's October 8, 2026 Pi-agent recovery publication, autonomous testing and patent-family correction.

Key corrections in this review:
- Remote jobs rely on a pinned adapter's **idempotent ensure(key)** and **inspect(jobId)** contract, not an unsupported claim of global exactly-once semantics; `UNKNOWN` remains unresolved.
- The API recovery implementation uses `agent_provider_health`, `agent_provider_admissions`, `agent_provider_waits`, not an invented `provider_circuits` table.
- Claim 1 focuses on proposal authority binding + remote job identity + independent objective completion gate; generic DAG, leases, retries, verification and HACT alone are not asserted as novel.
- Prior-art risks and patent-family overlap are disclosed; neither novelty nor non-obviousness or freedom-to-operate has been established.

Editable DOCX exports of this revision were generated separately and visually checked for requester delivery. The disclosure occupies **5 A4 pages**, and the search report **6 A4 pages**. The connected GitHub writer supports only UTF-8 text; binary DOCX files are **not** part of the PR.

## Implementation traceability

- Proposal authorization: `src/harness/foundry/proposals.ts`
- Atomic dynamic children: `src/harness/foundry/dynamicDag.ts`
- Research jobs and idempotent adapter: `src/harness/foundry/swarm/jobs.ts`
- Shared provider recovery: `src/harness/foundry/swarm/providerRecovery.ts`
- Host objective evidence gate: `src/harness/foundry/swarm/supervisor.ts`
- Optional HACT evidence export: `src/hact/`

**Important:** These are technical drafts for inventor/counsel review, not a formal patentability/FTO opinion. Applicant ownership, inventor contribution/order, actual earliest public disclosure, prior art status and the applicability of any grace period must be checked before filing. The older `docs/release/FUTURE_CODE_PATENT_CN.md` is retained for historical traceability.
