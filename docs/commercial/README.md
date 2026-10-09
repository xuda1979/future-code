# Future-Code commercial preview (`commercial` branch)

**Autonomous R&D. Independently verified.** This persistent product branch builds on the current Foundry/Swarm runtime without changing `main` or silently replacing its scheduler/model entrypoints.

## Quick start

Requires Node >=22.16; no installation or API key for the offline preview:

```sh
node src/commercial/cli.mjs help
node src/commercial/cli.mjs doctor
node src/commercial/cli.mjs demo
node scripts/test-commercial.mjs
```

`doctor` reports BLOCKED (exit 2) until human-reviewed release gates are complete. `demo` summarizes **recorded offline replay**, not live agent productivity; it cannot demonstrate a speedup. The CLI does not start agents, call models, deploy to production, connect to accounts or commercialize the imported source snapshot.

## Customer evaluation with external models

1. Select a committed, clean customer project, an independent acceptance suite, and a bounded R&D objective. Run configured code only in a trusted environment or a properly hardened sandbox.
2. Prepare BASELINE.json, CANDIDATE.json and TASKS.json using the existing examples/swarm/spec.json schema. Freeze the source commit, model, prompts, tool roster, budget and acceptance checks. **Only the operating recipe may differ** between arms.
3. With customer authorization to execute checks and incur model costs, run matched trials:

```sh
node --experimental-strip-types scripts/evaluate-real-project.mjs \
  --baseline-spec BASELINE.json --candidate-spec CANDIDATE.json \
  --tasks TASKS.json --repetitions 3 --mode live \
  --root .future-code/customer-trials --out .future-code/customer-report.json --allow-exec
node src/commercial/cli.mjs report --input .future-code/customer-report.json \
  --out .future-code/customer-summary.json --html .future-code/customer-report.html
```

`report` runs offline, rejects incomplete or internally contradictory trial data, and creates private (`0600`), no-overwrite outputs. Its self-contained HTML dashboard escapes user-provided values and makes no external asset or analytics requests. The report checks **metadata consistency**, not cryptographic authenticity of external compute or independence of the verifier. Do not publish customer source commits or results without their permission.

Dollar efficiency is UNKNOWN unless all relevant live trials have complete reported costs. The existing adapter lacks invoice-backed cost accounting. An offline replay, no live model requests, unsuccessful checks or insufficient repetitions cannot justify model-productivity claims.

## Commercial distribution and product scope

**Commercial release remains BLOCKED**: the source-provenance file identifies an imported terminal source snapshot with unclear rights; the repository has no verified blanket redistribution license. Do not invent a license or assert ownership of imported components. Five human-reviewed gates are deliberately PENDING in release-gates.json; even all REVIEWED fields are self-reported metadata, not legal clearance or security certification.

This release includes a local commercial evaluation/reporting foundation, not enterprise tenancy, SaaS billing, hardened execution, authenticated Mission Control, customer support or proved superior productivity. Follow the staged [pilot protocol](PILOT_PROTOCOL.md) and [release authority checklist](RELEASE_GATES.md) before an enterprise launch.
