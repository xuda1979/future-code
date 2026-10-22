# PR #76: observation publication blocks the evidence check

The manuscript, source, tests and independent audits are published for review.
The PR is open and ready for review, but its required evidence check has not
passed. On commit `e2bdb019d4692ed38c1454f1b8034573ec9682d6`, the full HACT
suite reported 772 passes, 29 failures and 14 errors. All 43 failures/errors
were missing-file errors for archived observations or the v12 independent report.
Refreshing the source-only release manifest did not restore those inputs.

The restoration helper now has a strict `--require-index` mode used by CI.
An absent observation index is a hard error before the suite runs. Manifest
refresh also refuses to proceed without that inventory. These changes preserve
all required evidence checks; they do not turn missing records into passes.

The minimum retained inputs needed to finish the fix are:

- The 53 parts under `data/observations/observations.zip.part0000` through
  `part0052`, assembled into **31,138,565 bytes** of ZIP data.
- Archive SHA-256:
  `5b003c2566df152e77fef9e0af8f4caace4a446a9fa3bc5e7ce708feda65f35d`.
- `OBSERVATION_ARCHIVE.json`, binding all part hashes and all 522 original
  files under `results/v11`, `v12`, `v13` and `v14`.
- `.ai-loop/v12/reports/independent_followups.json`, the retained numeric
  independent audit report required by the v12 tests and audit.
- Updated `RELEASE_FILES.txt` and `RELEASE_MANIFEST.json` covering the complete
  restored inputs and current source, without rebaselining any observation.

The archive contains mathematical/synthetic results, public-project test
registries and outcomes, timings, logs, source hashes and environment/version
metadata. Original host paths and test-fixture strings remain in the records
so their hashes stay unchanged. Publishing it to this public repository would
make these records publicly accessible. The full author-review package already
preserves them privately.

Automatic approval review rejected the archive upload again during this CI
repair because the request to fix checks did not explicitly authorize disclosure
of that private payload. No alternate upload transport is used. Explicit
approval to publish the inputs listed above is required before the remote
check can reproduce the complete local verification.

Historical v11–v13 release inventories and other internal revision notes are
outside this minimum CI fix and remain private. Their publication is not needed
to run the current independent audits. The public source-only manifest binds
only its listed published files; it cannot establish observation completeness.

After approval, publish the exact indexed parts and required report, refresh the
complete release inventory, and run the full suite, historical/current audits
and service/source controls. Report the remote result separately from local
validation. Do not skip or weaken these gates. Journal submission remains
subject to author review and factual declarations.
