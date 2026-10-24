# Generic operations example

This example uses a synthetic external SQLite provider, an independently pinned
read-only checker and a project-owned evidence pack. It contains no domain facts
or live commerce integration.

Run the complete offline lifecycle from the repository root with Node >=22.16:

```sh
node --experimental-strip-types examples/operations/demo.ts
```

The script makes no external model/API call. It uses two scripted model responses,
executes a real pinned adapter subprocess, independently checks the provider
database, deduplicates the event and reports IDLE without another model request.
The temporary provider and state are removed after the exercise.

For a configured external model, copy `spec.json`, set its provider/model/keyEnv,
retain an absolute project root, and initialize a fresh state. Keep the fixture
provider path identical for its adapter and independent checker:

```sh
export FUTURE_OPERATIONS_DEMO_PROVIDER="$PWD/.future-code/operations-demo/provider.sqlite"
node --experimental-strip-types src/harness/foundry/swarm/cli.ts init --root .future-code/operations-demo/state --spec YOUR_SPEC.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations ingest --root .future-code/operations-demo/state --file examples/operations/event.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations serve --root .future-code/operations-demo/state --allow-exec
```

Replace the synthetic adapter/checker with authorized project integrations and
independent acceptance checks before live use. Configure the account/resource
identity, resource units, ceilings, knowledge and substantive policies for that
project. Passing this example establishes the runtime lifecycle, not live-model
ability, business profit or physical-system safety.
