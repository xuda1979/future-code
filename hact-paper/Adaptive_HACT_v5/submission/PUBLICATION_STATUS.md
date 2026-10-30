# Current review revision: v15

V15 adds the sparse compact replay, cap64 dispatch reanalysis and exclusive
CPU profiles described in `docs/V15_REVIEW_RESPONSE.md`. All 522 archived
observations and their archive/index remain unchanged. The derived v12
projection-audit receipt is refreshed for the Off/On table-column presentation;
the prior receipt is available in the immutable parent commit. This is a
review PR, not a journal submission or author-attestation record. The prior
public archive authorization is documented below.

# HACT v14 public evidence release

PR #76 contains the manuscript, source, tests and complete observation inputs
required by its evidence workflow. The author explicitly authorized public
release of the 31.1 MB archive, including its logs and host metadata, the required
v12 independent audit report and observation/release inventories.

## Exact retained inputs

- The 53 parts under `data/observations/observations.zip.part0000` through
  `part0052` assemble into **31,138,565 bytes** of ZIP data.
- Archive SHA-256:
  `5b003c2566df152e77fef9e0af8f4caace4a446a9fa3bc5e7ce708feda65f35d`.
- `OBSERVATION_ARCHIVE.json` binds every part and all **522 original files**
  under `results/v11`, `v12`, `v13` and `v14` by path, size and SHA-256.
- `.ai-loop/v12/reports/independent_followups.json` retains the numeric
  independent audit report required by the v12 tests and audit.
- `RELEASE_FILES.txt` and `RELEASE_MANIFEST.json` cover current source and every
  restored observation, including copies intentionally ignored by Git.

The observations contain mathematical/synthetic results, public-project test
registries and outcomes, timings, logs, source hashes and environment/version
metadata. Original host paths and test-fixture strings remain unchanged so
existing evidence hashes and provenance checks remain valid. This restoration
adds no checker execution or new measured result. Packaging's resource exclusion,
the six initial VOID schedule runs and the retained negative results remain.

## Verification contract

Run `python tools/hydrate_observations.py --require-index` before tests or audits.
It rejects an absent index, missing or changed archive parts, altered restored
observations, unsafe paths and symlinks. Restoration is offline and resumable.
The release-manifest check independently verifies each listed file. Manifest
refresh refuses a missing observation inventory or altered packed records;
refreshing an inventory cannot substitute for restoring required observations.

The prepared complete release passed all **818 HACT tests** and all **22 workflow
audit/control commands** locally. A clean snapshot restored all 522 original
observations, verified **3,452 release files**, passed all **38 focused v14 tests**
and passed the independent v12 audit. Remote CI status is reported separately
on [PR #76](https://github.com/xuda1979/future-code/pull/76).

Historical v11–v13 release inventories and other internal revision notes are
outside this CI repair and remain in the full author-review package. They are
not required by the current independent audits. All scientific checks and
acceptance boundaries remain intact. Journal submission remains subject to
author review and factual declarations.
