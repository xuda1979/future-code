# Configure model endpoints directly

Adding an endpoint is configuration work. It should not require a model to edit
the source catalog, inspect the repository or rebuild the application.

## Interactive use

```text
/model add My-Model https://provider.example/v1
/model My-Model
```

The first command opens a masked API-key prompt and saves the endpoint locally.
It makes no network request and leaves the selected model unchanged. The second
command checks the endpoint before switching. OpenAI chat-completions is the
default protocol; use `--protocol anthropic` for Messages-compatible endpoints.

You can also provide `--api-key-env MODEL_API_KEY` when that variable is already
exported in the CLI environment. Do not put the literal key in command arguments.
`/model list` shows saved IDs and protocols. Saved models also appear in `/model`.
Re-add the same ID to update its URL/key; subsequent requests use that saved
configuration. Saving configuration is not a claim that the provider works.

## Headless use by operators and agents

```sh
future-code --model-endpoint add My-Model https://provider.example/v1 --api-key-env MODEL_API_KEY
future-code --model-endpoint list
```

Set `MODEL_API_KEY` in the process environment first. The wrapper bypasses old
credential-file loading, persistent-session setup and proxy startup for these
commands. The binary bypasses normal CLI initialization. Both entry points use
the same local save implementation, with no inference or provider verification.
For a request to configure an endpoint, use this command instead of editing the
source catalog or rebuilding the binary for each new provider.

## Routing and validation

- Native Messages-compatible endpoints use their saved URL/key directly.
  API roots ending in `/v1` or `/v1/messages` are normalized for the SDK.
  Old OAuth tokens, API-key helpers, custom authorization headers and the old
  first-party Unix-socket tunnel are not reused for a saved endpoint.
- OpenAI endpoints use the existing local Future Code translation proxy.
  The proxy reads the selected model's saved profile on each request. The API
  root, `/v1` base, custom API prefix and full `/chat/completions` URL are accepted.
  Parallel requests retain their own URL/key. Updates need no per-model rebuild
  or proxy restart. Saved routes use TLS verification.
- Saved OpenAI endpoints require `FUTURE_BASE_URL` to point to the local
  translation proxy. A one-second capability check rejects an older proxy
  before it can route a new model to the old provider. Running the binary
  directly against a remote Messages API does not supply this translation.
- `/model` runs immediately, including while an inference request is active.
  It changes the model for subsequent requests; it does not replay or cancel
  tools already running in the active turn.
- Validation has a ten-second overall deadline, including client/auth setup,
  with zero SDK retries, one output token and thinking disabled. A failed,
  timed-out or cancelled check keeps the current model selection. Cancelling
  the menu or unmounting an inline switch also prevents late success callbacks.
- Successful validation is cached by model, provider, endpoint and credential
  identity. Replacing a URL/key invalidates the previous check. A configuration
  changed during a probe cannot be accepted using the earlier identity.
  Organization model allowlists remain in force before validation/selection.

The local translation proxy uses separate time limits for live OpenAI-compatible
SSE replies. `HUANXIN_GLM52_UPSTREAM_TIMEOUT` sets the socket timeout while
opening the upstream HTTP request (60 seconds by default).
`HUANXIN_PROXY_STREAM_IDLE_SECONDS` overrides the upstream socket read timeout
once SSE begins and inherits the opening timeout by default.
`HUANXIN_PROXY_STREAM_MAX_SECONDS` caps the live relay at 1,800 seconds by
default, including streams that keep sending heartbeats. A disconnected client
releases its live upstream socket and cancels pending streaming retries. An
upstream request already waiting for HTTP headers uses its opening timeout.

## Persistence and upgrades

Profiles live under `FUTURE_CONFIG_DIR/model-endpoints`, or
`~/.future/model-endpoints`. IDs map to SHA-256 filenames; credentials are stored
in local JSON with mode `0600`, with a `0700` directory when created. Temporary
files are private, fsynced and renamed atomically. Different model saves cannot
overwrite each other's profiles; the last completed save wins for the same ID.
Profile reads are capped at 16 KiB. Corrupt profiles are omitted from the picker
and rejected when selected explicitly. Re-add that ID to repair its profile.
Keys are not encrypted; the existing operating-system account protects them.
Keys are excluded from list/picker output, save callbacks and setup analytics.

Deploy the updated binary, wrapper and Python proxy together, then restart the
CLI/proxy once. An already-running process continues using its loaded code.
This PR does not update running sessions or a user's installed binary.

## Verification and measurement

Source inspection found three concrete delays: `/model` immediacy was disabled
for ordinary users unless an experiment enabled it; custom validation inherited
the client's ten-minute request timeout without an overall initialization
deadline; adding another endpoint had no supported local command. These are
code-level findings, not a reconstruction of the user's hours-long session.

The focused tests cover local persistence, malformed input, masked entry, denied
models, real SDK URL/key selection, credential changes, cancellation, a real
ten-second hung-validation deadline, old-proxy rejection, concurrent proxy
routing, streaming and invalid-credential failures. The broader command and
correctness suites exercise the existing guardrails as well.

Reproduce the local configuration timing with:

```sh
BUN_BIN=/path/to/bun node scripts/bench-model-config.mjs 20
```

It runs the actual installed wrapper through the Bun source entry point twenty
times, using a missing old configuration and an invalid old API. Every saved
profile is read back and checked for permissions. A loopback server counts API
requests. This measures local configuration latency, not compiled-CLI startup,
live model latency or an end-to-end agent productivity improvement.

One Linux x64 run with Node 24.22.1 and Bun 1.4.4 saved and read back 20/20
profiles, made zero API requests, and measured 55.13 ms median and 112.68 ms
95th-percentile wall time (37.64–133.25 ms range). These are observed local
component timings, with no before/after speedup ratio claimed.
