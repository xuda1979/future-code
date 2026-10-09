# Commercial release blockers and authority

The checklist is advisory, human-reviewed metadata. It cannot verify legal ownership or authorize redistribution.

| Gate | Accountable review | Required evidence |
|---|---|---|
| `source-rights` | Qualified IP counsel | File-level provenance, ownership chain, remediation of imported source |
| `dependency-rights` | Open-source compliance + counsel | Locked SBOM/third-party license terms and distribution rights |
| `security` | Independent security lead | Hardened isolation, secret handling, tenancy and abuse threat model |
| `live-evidence` | Independent evaluator | Frozen live paired-trial reports, cost source and declared limitations |
| `customer-pilot` | Named external customer sponsor | Prior-agreed verified acceptance and signed pilot outcome |

Until authorization is established, do not redistribute imported code, issue a guessed LICENSE or advertise enterprise security and general speedups. The machine output `REVIEWED_NOT_CERTIFIED` means only that reviewer/evidence/date fields are populated. It is not an approval to ship, a legal opinion, a security certification or evidence of a successful paid deployment.

All five gates begin PENDING in `release-gates.json`. The owner may update evidence links and reviewers after appropriate review; keep authoritative approvals in the actual organizational release system.
