# Future Code integration and live-evaluation boundary

## Tested path

The v3 experiment imports the exact vendored Future Code v1.2 runtime and uses its
real Supervisor, Store, HTTPBackend, worker execution, private workspace, GateSpec
and integration checks. It does not replace those components with a mock.
The loopback endpoint **does** return predetermined model actions. The SQLite and
HTTP application behavior and pytest checks are real. Nine measured episodes
complete with two concurrent workers and one HTTP 503 recovery per episode.

## GateSpec example for an installed package

Create a reviewed schema-2 contract outside the candidate first. In the trusted
runtime configuration, register a gate along these lines:

```json
{
  "argv": ["$PYTHON", "-B", "-m", "ichact.future_bridge",
           "--contract", "/work/contracts/approved.json",
           "--reports", "/work/verification-reports",
           "--layout", "/work/contracts/layout.json",
           "--timeout", "60"],
  "timeout_seconds": 90,
  "protected_inputs": ["tests", "pyproject.toml"]
}
```

Only include protected paths actually present in the reviewed project. Assign
this gate to the appropriate task and retain the runtime's own protected-path
policy. All trust material, interpreter dependencies and bridge source must be
outside agent write scopes. The gate runs with the candidate as cwd. In a
non-installed source deployment, use the bridge's pinned absolute script path,
as done by the recorded experiment.

Exit zero permits the existing gate pipeline to continue; nonzero rejects or
blocks the candidate. A gate report alone does not merge code. The actual harness
retains its additional staged-source and integration checks.

## Connecting a real hosted model: provided, NOT measured

Use the existing runtime endpoint configuration, for example an HTTPS endpoint
that the operator owns or is authorized to call, its exact model ID, and a named
credential environment variable. Do not place an API key in source or JSON.
The runtime's preexisting max_requests/max_reserved_tokens and task limits must
be set to an approved budget. Keep a kill switch and do not give test processes
access to those credentials; use a container/VM with appropriately separated
secrets and trust material.

The model must use the runtime's documented action protocol. Do not replay the
local fixture and call it a hosted-model evaluation. For a genuine study, freeze
issue IDs, acceptance tests, model version, decoding, costs, repeated seeds and
prompt contract before model runs. Compare identical issue cohorts and record
provider-reported prompt/completion tokens and request errors. Missing usage
remains UNKNOWN. Add natural historical defects or a supported SWE-bench setup;
this artifact does not supply fabricated scores for either.

## Online library path

`CoupledShare.choose()` must precede observation of the current full cost vector.
`AdaptiveGuard.migrate()` revokes old publication and prices a cold rebuild while
preserving matching evidence by stable ID. The package tests their combined
execution across changing layouts. The empirical online traces use a frozen
catalogue and exogenous completion waves. They are not a tested self-rewriting
production scheduler and do not certify arbitrary reactive-agent regret.

Recompiling a catalogue changes the learning problem. Make the new catalogue a
reviewed new control epoch and reestablish loss/migration bounds; do not claim the
existing fixed-catalogue theorem automatically extends to an unbounded sequence
of newly generated layouts.
