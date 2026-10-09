# Compiled startup regression

Run `bun test tests/startup/compiled-startup.test.ts` with Bun >=1.2 and Node >=22.13.
No package installation, model credentials or paid API calls are needed.

The suite compiles an asset-free native executable that imports the production
`bundledMode`, sandbox adapter, ripgrep resolver, executable lookup and shell
integration. Every scenario runs in a fresh process with an empty executable
PATH, except the positive cases which provide a small test `rg` executable.
The shell-function case supplies an exported function without an executable.

Unrelated settings, telemetry, sandbox-runtime and CLI integrations are replaced
by `dependencies.ts` through a test-only build plugin because this source
snapshot depends on unavailable internal `@future/*` packages. The fixture is
not a full REPL or a sandbox enforcement test. `failIfUnavailable` coverage
checks that dependency failures produce a reason and retain the required flag
for the existing REPL/print startup guards.

The baseline reproduced the reported `ripgrepCommand -> checkDependencies ->
isSandboxingEnabled` startup crash with zero embedded files. Tests cover safe
status queries, disabled/unsupported/excluded sandbox checks, custom sandbox
commands, explicit search failures, working executable spawning and opt-in
embedded applet configuration. Compiled-mode detection is also checked against
ordinary Bun and Node source execution. CI runs on Linux and macOS with Bun
1.2.23 (legacy virtual-URL detection) and 1.4.2 (standalone runtime flag).

For a dependency-complete checkout, rebuild the actual CLI with `./build.sh`.
An `rg` shell function or alias is insufficient for the dedicated Grep/Glob
tools; install a ripgrep executable on PATH. A missing executable no longer
prevents startup with sandboxing disabled, and `/doctor` reports it. If sandbox
is enabled, dependency failures are reported through the existing unavailable
sandbox handling; `sandbox.failIfUnavailable: true` continues to refuse startup.
