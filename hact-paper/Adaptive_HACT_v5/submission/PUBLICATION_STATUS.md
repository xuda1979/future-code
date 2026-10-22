# Draft PR: raw-evidence publication is pending

The manuscript, source, tests and independent audits are published for review.
The public PR intentionally remains a draft because automatic approval review
rejected upload of the raw-observation archive and a historical release
manifest: the instruction to publish a PR
was not treated as explicit authorization to disclose that exact payload. A
content/provenance review did not lift the block. No alternate transport or
indirect publication is used to bypass it.

The concrete payloads awaiting authorization are:

- **HACT_v14_Observation_Archive.zip**, 31,138,565 bytes.
- SHA-256: `5b003c2566df152e77fef9e0af8f4caace4a446a9fa3bc5e7ce708feda65f35d`.
- All 522 original files under results/v11, v12, v13 and v14, with their
  individual paths, sizes and hashes in OBSERVATION_ARCHIVE.json.
- Mathematical/synthetic results, public-project test registries/outcomes,
  timings, logs, source hashes and environment/version metadata. Host paths and
  test-fixture strings are retained because the receipts remain byte-identical.
- The public Git transport would use the 53 indexed lossless archive parts.
  None of those parts has been published.
- The three historical byte-inventory manifests
  `historical/v11_release_manifest.json`, `historical/v12_release_manifest.json`
  and `historical/v13_release_manifest.json`. The first was rejected as
  potentially sensitive internal metadata; the set is withheld together.
  Their exact bytes and the observations are included in the complete private
  author-review package. Current release hashes still bind these missing files.
- Internal revision run notes under `.ai-loop/v11` and `.ai-loop/v12`
  also remain private in that package; they are outside the public draft's
  manuscript/code scope. Approval of the complete package would cover them too.
- The v14 release inventories (`RELEASE_MANIFEST.json`, `RELEASE_FILES.txt`,
  `OBSERVATION_ARCHIVE.json`) and historical v11–v13 release-file lists are
  likewise withheld as release metadata. The public draft retains the base
  branch's older inventories; use the complete private v14 package for the
  current byte-integrity snapshot. No partial inventory is presented as valid.

The full author-review package retains the complete archive privately. Local
verification passed all 815 HACT tests, the independent historical/current
audits and PDF checks. The archive restored all 522 original paths exactly.

Public CI requires the withheld archive and manifests. Its missing-input failure is a real
publication blocker, not a scientific test pass or an implementation regression.
The private v14 manifest still lists every observation and archive part, and
the workflow still verifies its required inputs before testing. The public
draft cannot pass the older inventory against the revised source. Do not
skip or weaken these gates. After
explicit authorization, add the exact indexed parts, rerun the complete gates
and mark the PR ready for review only after the required checks pass.

Journal submission remains subject to author review and factual declarations.
