# HACT v10: submission readiness

Assessment date: 2026-10-20. **Status: HOLD; no journal submission made.**
The user's instruction authorizes submission once the paper is sufficiently
strong. The current evidence does not yet meet that condition. Passing software
tests, improving prose, or checking a constructed mathematical example does
not establish journal-level novelty or external validity.

## Intended venue and current manuscript

IEEE Transactions on Software Engineering (TSE) is a plausible target for the
software-verification and evidence-management contribution. This is a scope
recommendation, not an acceptance prediction. The official call describes
theoretical and empirical work relevant to software construction, analysis and
management:
https://www.computer.org/digital-library/journals/ts/cfp-ieee-transactions-on-software-engineering

The current PDF is an attributed research manuscript for author review, not a
certified TSE submission file. Before submission, check the current journal
instructions and portal, including review anonymity, template, length,
supplement handling and publication charges. The detailed official author
pages returned access errors during this revision; search excerpts and an old
author-information PDF are insufficient to certify current rules. Do not use
historical 14-page limits or a guessed portal as current instructions.

Official entry points:

- https://www.computer.org/tse-author-information
- https://www.computer.org/publications/author-resources
- https://journals.ieeeauthorcenter.ieee.org/become-an-ieee-journal-author/publishing-ethics/guidelines-and-policies/submission-and-peer-review-policies/

## Improvements completed in v10

- Da Xu and Fei Wang are named in that order, with the shared affiliation
  **China Mobile Research Institute**. Da Xu is the corresponding author at
  **xudayj@chinamobile.com**. No coauthor email, ORCID, contribution role,
  funding source or institutional approval has been invented.
- A full proof strengthens the parity example to **disjoint global optimum
  sets**, allowing every valid tree shape and permutation under the actual
  packet prices. The independent exact reference uses integer numerators and
  considers 115,462 root partitions across 511 nonempty subsets per case.
  It confirms refresh optima of 3,856 and 3,936 bytes; charging one construction
  gives 8,080 and 8,160 bytes. This is a constructed analytical witness, not a
  new software workload or a scalable optimizer.
- Eight new tests include an independently written literal tree enumerator,
  all-tree optimality/count comparisons on smaller instances, and exact
  recomputation of the committed witness. The default test suite and CI now
  include this reference.
- The query study's byte equality is explicitly explained by composition of
  identical deterministic codecs. Its former strict byte-and-time decision
  rule cannot be satisfied in this protocol. The study checks semantic and
  codec conformance and describes resource costs; it does not test a
  bandwidth-superiority hypothesis.
- Candidate-start arrival and post-check query response are distinct estimands.
  Common-codec break-even depends on measured aggregation/update savings, not
  on a bandwidth saving that the protocol rules out.
- The bibliography corrects the verification-driven paper's title, expands
  the AIware authors, and corrects both the title and two author names of the
  trace-assurance reference using primary sources. The latter now cites the
  verified arXiv version rather than unverified proceedings pagination.
- Data/code availability and a specific Codex assistance disclosure are added.
  The disclosure does not assert that either named author has already approved
  the final scientific content.

## Scientific submission blockers

| Question | Current evidence | Needed to close the gap |
|---|---|---|
| Does the service solve an observed operational need? | An explicitly imposed hierarchy and retrospective queries | Independently observed demand, or a clearly motivated format requirement from an actual deployment |
| Does an index advantage survive full costs? | One local timing campaign; identical answer bytes by construction | Paired repeated setup/update/query measurements on held-out trajectories; either a useful advantage or a well-supported generalizable negative boundary |
| Does full-wave optimization improve the practical method? | An exact constructed separation; frozen direct-wave heuristic gives no gain | A same-budget, same-order/tree-shape ablation on independent workloads, or a narrower contribution explicitly dispensing with an algorithmic-superiority claim |
| Do results generalize beyond the artifact? | Twelve archived candidates in three projects; synthetic cells have three seeds | New independent projects/changes and a declared sampling frame, with the project/trajectory as the inference unit |
| Is the claimed contribution distinct from prior work? | Explicit comparison to seriation, alphabetic DP and HMT; new model-specific witness | Human technical review of the proof and positioning, including hierarchical hypergraph objectives; no unsupported “first” or hardness claim |

A strong null result can be publishable; the gate does not require forcing a
positive result. It requires a justified research question and sufficiently
independent evidence. Repeating existing rows, constructing favorable examples
or restating byte equality cannot supply that evidence.

`V10_CONFIRMATORY_PROTOCOL.md` specifies a proposed follow-up campaign. It has
**not** been preregistered or executed. The current revision adds zero new
checker trials, natural-bug cases, live-agent episodes or WAN transfers.

## Author and portal facts still needed when the science is ready

Before any submission attestation, Da Xu and Fei Wang must review and approve
the actual final manuscript and author order. Obtain Fei Wang's contact details
and any identifiers required by the selected portal; confirm actual funding,
conflicts, author contributions, related submissions and any required employer
permission. Public GitHub manuscript/artifact versions must be disclosed if
the portal requests prior dissemination. Do not assert exclusive submission,
coauthor consent, no conflicts or no funding without the authors' answers.

Do not purchase open access, accept publication charges, sign a copyright
transfer, or submit invented declarations. No journal account was created,
no editorial email was sent and no fee was committed during this revision.

## Verification record

Run from `hact-paper/Adaptive_HACT_v5`:

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python -m audit.check_v5
python -m audit.numbers_audit
python -m audit.check_v9
python -m experiments_v10.exact_separation
python tools/verify_manifest.py
```

The v9 audit covers 5,337 arithmetic/provenance/prose assertions; these are
correlated checks, not independent experiments. The v10 witness is checked
separately. The release manifest binds the final source/PDF bytes. Compilation
and rendered-page checks are recorded in the pull request. Neither an audit
count nor a CI pass is a prediction of journal acceptance.

Local validation on 2026-10-20 (Python3.12.14): **533 tests passed**. Independent v5
reconstruction, the historical 70-entry audit, the 5,337-assertion v9 audit
and exact v10 witness all passed. The test count includes the eight new
analytical-reference cases. Runtime/platform differences do not turn these
regressions into additional empirical projects or checker trials.
