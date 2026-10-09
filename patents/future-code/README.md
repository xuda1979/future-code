# Future-Code patent materials

This directory contains the patent disclosure and the preliminary prior-art search report prepared on 2026-10-09.

- [INVENTION_DISCLOSURE_CN.md](INVENTION_DISCLOSURE_CN.md) — Chinese invention disclosure. Preserves all eleven top-level sections of the supplied disclosure example, including inventor/applicant fields, figures, embodiments, technical effects, claims and abstract. Six technical features (A-F); 13 suggested claims.
- [PRIOR_ART_SEARCH_CN.md](PRIOR_ART_SEARCH_CN.md) — Chinese/English-titled search report. Preserves the supplied report's Search Parameters, Categories A-E, Novelty, Patentability, Claim Matrix, Key Differences, Filing Strategy and Conclusion structure.

Editable Word exports of both documents have also been prepared for delivery to the requester. The disclosure renders to 6 A4 pages (within the 15-page ceiling); these exports are not part of the GitHub PR because the available GitHub connector in this session supports text-based file upload, whereas the Word exports are binary.

This material is a **draft for inventor review and patent counsel**, not a legal opinion, exhaustive patent search, or guarantee of patentability. Applicant, inventor, employment-related ownership and prior-publication details must be confirmed before filing. The source repository is public: assess novelty-destroying disclosure dates and publication strategy before releasing further sensitive claim details.

## Technical traceability

- Model proposal admission: `src/harness/foundry/proposals.ts`
- Runtime child-task admission: `src/harness/foundry/dynamicDag.ts`
- Remote job reconciliation: `src/harness/foundry/swarm/jobs.ts`
- API recovery: `src/harness/foundry/swarm/providerRecovery.ts`
- Goal/evidence completion: `src/harness/foundry/swarm/supervisor.ts`
- Optional HACT evidence layout: `src/hact/`

Existing release patent draft: `docs/release/FUTURE_CODE_PATENT_CN.md`, intentionally retained for history. The canonical template-aligned materials for this change are in this directory.
