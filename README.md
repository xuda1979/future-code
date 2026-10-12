# Future-Code Commercial

[中文](README.zh.md)

**Verified autonomous R&D execution**, with independent checks, durable objectives and model-provider choice.

This is the long-lived customer product branch. It contains the operational Foundry/Swarm runtime and a commercial CLI; research manuscripts, patent drafts and the large legacy terminal application are omitted from the branch's working tree.

## Requirements

Node.js >=22.16 on Linux/macOS/WSL, Git, and an authorized trusted project. No npm install, default model endpoint, API key or paid provider account is bundled.

## Local onboarding

```sh
node src/commercial/app.mjs provider add
node src/commercial/app.mjs provider list
node src/commercial/app.mjs license request
node src/commercial/app.mjs license status
```

The wizard asks for your **own** HTTPS endpoint, model, protocol, auth header and key source. Choose encrypted local vault, hidden prompt at execution time, environment secret injection, or no credentials for an authorized local service. No secret is stored in tracked configuration or printed by `provider list`. The local vault uses AES-256-GCM with scrypt and restricted file permissions; this is not a substitute for an enterprise KMS or an operating-system keychain.

The supported wire formats are `chat-completions`, `anthropic`, `responses`, and `gemini`. Additional vendors offering a compatible wire protocol may be configured by endpoint and header. Other native formats require an adapter; we do not claim universal protocol compatibility.

## Activate paid or authorized installations

Send the `license request` installation identifier to the seller. The seller signs a customer-bound, dated entitlement using an offline Ed25519 issuer. Install the delivered token privately:

```sh
node src/commercial/app.mjs license activate --file YOUR_TOKEN_FILE
node src/commercial/app.mjs license status
```

The branch deliberately starts with **no trusted issuer**. The seller must generate a real signing key, retain the private key securely, and publish/release the corresponding reviewed public trust entry before activations can work. See [License operations](docs/commercial/LICENSE_OPERATIONS.md). Offline activation cannot offer immediate revocation and is not tamper-proof DRM for a source-visible client.

## Execute a verified objective

Use the provided application spec and your saved provider profile. No endpoint or secret belongs in the spec.

```sh
node src/commercial/app.mjs init --profile primary --spec examples/swarm/spec.json --allow-exec
node src/commercial/app.mjs run --profile primary --tasks examples/swarm/tasks.json --allow-exec
node src/commercial/app.mjs status
```

The tasks fixture is a simple wiring check, not a scientific productivity benchmark. The target repository must be a committed, clean Git checkout. `--allow-exec` explicitly permits configured check commands to execute. Worktrees alone are not hardened OS sandboxes: use trusted repositories or a separately hardened worker environment.

Model commands are activation-gated via the commercial entrypoint. A source-visible client can be modified; enterprise enforcement and billing should ultimately be server-side. The core Foundry/Swarm engine also exposes developer APIs and cannot be treated as unbreakable client-side license enforcement.

## Evaluation and operational boundaries

```sh
node scripts/test-commercial.mjs
node scripts/test-swarm.mjs
node src/commercial/cli.mjs demo
```

`demo` uses a recorded **offline** replay and does not demonstrate model productivity. Live paired trials are separate, and missing billed dollars are unknown. See [Pilot guide](docs/commercial/PILOT_PROTOCOL.md).

**Not approved for commercial redistribution yet.** Source ownership and third-party distribution rights require professional review. See [Source provenance](docs/SOURCE_PROVENANCE.md) and [Launch gates](docs/commercial/RELEASE_GATES.md). No blanket LICENSE is granted by this work.
