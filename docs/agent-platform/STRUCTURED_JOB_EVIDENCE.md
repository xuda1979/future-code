# Structured results and bounded remote job evidence

Long experiments need machine-readable results and inspectable evidence after a
context reset. The trusted POSIX endpoint now supports an optional JSON result
contract, bounded cold log artifacts, and an opt-in `read_job_artifact` tool.
It uses the existing named-job, SSH/stdin, SQLite, lease and receipt machinery.
The framework contains no project-specific models, datasets, training algorithms
or scientific-library rewrite rules.

## Configure the trusted endpoint

Add these fields to the **remote executable template** passed to
`scripts/research-job-agent.py --config`, not to the coordinator's `jobs` object:

```json
{
  "argv": ["/usr/bin/python3", "/opt/research/experiment.py"],
  "timeoutMs": 3600000,
  "resultMaxBytes": 32768,
  "maxLogBytes": 10485760
}
```

| Option | Contract |
|---|---|
| `resultMaxBytes` | Optional integer, 1–65,536. When present, the executable must write a UTF-8 JSON object to `FUTURE_JOB_RESULT_PATH`. Missing, malformed, duplicate-key, nonfinite, non-object or oversized results make the job `FAILED`, including after exit code 0. Symlinks and special files are rejected. |
| `maxLogBytes` | Optional integer, 1–268,435,456 **per stream**. Captures stdout/stderr prefixes to private endpoint files; continues draining and hashing all observed output after the cap. No configured cap means legacy tail-only behavior and no log files. |
| `artifacts` | Optional mapping of up to 32 flat names to `{maxBytes}`; 256 MiB aggregate ceiling per job. The child writes these names below `FUTURE_JOB_ARTIFACT_DIR`. Complete raw files are snapshotted and hashed after execution. Missing, changing, oversized, symlinked or nonregular outputs fail execution. Names cannot override stdout/stderr/result or select arbitrary paths. |

Write the result atomically before exiting. A generic experiment might emit:

```python
import json
import os
from pathlib import Path

result = Path(os.environ["FUTURE_JOB_RESULT_PATH"])
temporary = result.with_suffix(".tmp")
temporary.write_text(json.dumps({
    "metrics": {"score": 0.87, "samples": 120},
    "datasetVersion": "reviewed-v3",
    "configurationHash": "experiment-owned-configuration-reference"
}, allow_nan=False), encoding="utf-8")
temporary.replace(result)
```

Parsed data appears at `run_job.result.data`. Stdout cannot replace that result,
and a `passed: true` field cannot override a nonzero exit or independent verifier.
The result artifact preserves the exact submitted JSON bytes and their SHA-256.
Choose the coordinator's `budget.maxToolOutputBytes` large enough for the complete
JSON reply: data plus both 4 KiB tails, manifests and JSON escaping. The normal
65,536-byte budget fits typical small metric objects; the endpoint result cap is
not a promise that arbitrary JSON escapes fit that coordinator budget.

Include the endpoint script and template in the adapter's `files` pins when they
are locally available. For SSH, pin the transport wrapper/configuration and
deploy the same endpoint version remotely. Credentials stay in the operator's
explicit transport setup. `FUTURE_JOB_*` variables are reserved and cannot be
overridden through the endpoint's environment allowlist.

## Keep cold evidence outside source control

Set the endpoint's `--root` to a persistent spool outside the source tree, such
as `/srv/research/job-spool`, or beneath the project's ignored `.future-code/`
directory. Each stable job ID owns its state, structured result and bounded log
files. No raw log is added to the Git tree or copied wholesale into the prompt.

`result.artifacts.stdout` and `.stderr` contain:

- `sha256` and `bytes` for the retained prefix;
- `observedSha256` and `observedBytes` for the entire drained stream;
- `truncated`, explicitly indicating bytes that were not retained.

`result.artifacts.result` contains the SHA-256 and byte length of the exact JSON
file. Manifests are metadata about observed execution, not scientific acceptance.
An observed-stream hash does not make discarded log bytes retrievable.

This is bounded per-job retention on the existing endpoint filesystem. There is
no new S3 service, automatic upload, destructive migration or garbage collector.
Operators may use a managed persistent mount or archive the spool; they must
retain referenced evidence and define disk/retention policy for long deployments.

## Read evidence without launching another job

Grant `read_job_artifact` in the agent profile's `tools`, alongside a permitted
`jobs` list. Existing profiles that omit it keep their existing tool schema.
After `run_job` completes, use its host-owned result receipt:

```json
{
  "name": "read_job_artifact",
  "arguments": {
    "receipt": "<owned run_job result receipt>",
    "artifact": "stdout",
    "offset": 0,
    "length": 4096
  }
}
```

The artifact name must exist in the terminal manifest and be a built-in stream/result
or an operator-declared named artifact. Reads are scoped to the same run/task and still require that
job template's capability. They never call `ensure`, reserve another job slot,
or consume another external-job allowance. They do consume an ordinary tool call
and use the configured RPC deadline/output budget.

The endpoint verifies the retained file's length and SHA-256 before returning a
page. The coordinator binds the reply to the terminal receipt, job ID, artifact,
hash, byte count, requested range, canonical base64 and continuation offset.
Pages are at most 8,192 bytes. `content` is a readable UTF-8 preview;
`contentBase64` preserves exact bytes when a page splits a multibyte character.
Follow `nextOffset` to continue. A custom adapter must implement `read_artifact`
with this protocol before the new tool is granted. The adapter is trusted;
independent task/final checks remain the acceptance boundary.

## Memory after failed experiments

Terminal `FAILED` and `CANCELLED` job replies now produce `JOB_FAILED` diagnostic
descriptors in the existing bounded thread memory, for serial and batched calls.
Descriptors retain job name/status, source/input binding, a short error excerpt,
and owned result/fixture receipts. Explicit errors and stderr take precedence over
unrelated stdout and metric claims. The eight-entry checkpoint and four-entry
retirement projection survive reopen without adding another state database.

Changed source/evidence marks an old observation stale. `UNKNOWN` does not erase
a known failure; a successful reply for the exact invocation clears its active
descriptor. Remote failures cannot trigger deterministic-check pruning or grant
acceptance. Full structured data remains in cold receipts and remote artifacts,
so retirement preserves the problem without continually copying logs into context.

## Validation

```sh
python3 -m unittest discover -s tests/research-jobs -p 'test_job_evidence.py' -v
node --experimental-strip-types --test tests/foundry/job-evidence.test.ts
```

The focused tests include a real local POSIX endpoint, job/result identity,
single submission, structured metrics, bounded/truncated log capture, lossless
artifact paging, corrupt evidence, capability isolation, restart/retirement and
independent verification. Scripted model responses exercise orchestration only;
they do not establish live-model or end-to-end R&D productivity improvements.
