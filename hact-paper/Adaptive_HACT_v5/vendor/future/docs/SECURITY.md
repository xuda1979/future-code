# Security and authority

## Authorized operations

The native worker can inspect permitted project text, write within a leased scope,
execute named administrator-configured gates, communicate with known tasks and propose
bounded delegation. It cannot select arbitrary shell commands, remove source files,
change credentials, grant permissions, alter the acceptance policy or publish to external
accounts through native tools. The supervisor can always be stopped or cancelled.

Never use this package as a way to evade an operator's shutdown or resource controls.
A daemon may remain alive in WAITING states while refusing unsafe work. OS failure,
process termination, disk failure or unrecoverable state corruption can stop it. No
software can responsibly guarantee perpetual operation or elimination of every defect.

## Trust boundary that matters

**The workspace is not a security sandbox.** Python path checks protect native tool paths
and promotion, not everything a configured program can do. Test suites can import model-
generated code; that code executes with the gate process's OS permissions. A malicious
project, test, dependency or installed CLI can access other permitted files, network,
processes and resources. A container limits host access but is not a universal security
proof; use stronger isolation for hostile inputs.

Run as a dedicated unprivileged account in an ephemeral container/VM. Mount only a
disposable project copy, not host secrets or the Docker socket. Apply memory, CPU, PID,
filesystem and egress limits outside this process. The included container/service files
are templates and were not deployed or security-certified here. Local acceptance gates
are trusted and must themselves have useful non-vacuous assertions.

## Credentials and logs

API credentials come from explicit environment-variable names, not checked-in config
values. Known supplied values and common credential patterns are redacted in worker
observations and saved gate output. This is best-effort filtering: a secret embedded in
an unusually named source file, transformed string or provider response might not be
recognized. Do not put secrets into instructions or source. Keep the project private.

Native snapshots exclude conventional secret names and sensitive directories, including
`deepseek.env` from the supplied archive. Recovered original secret values are not shipped.
No original credential was used. Transport does not forward credentials across redirects,
and health URLs must be same-origin. TLS verification is never automatically weakened.

For CLI mode, both the outer command environment allowlist and bridge `--forward-env`
must explicitly permit needed variables. Prompt-as-argument mode can expose prompt text
in local process listings; use stdin mode when the installed CLI supports it. Avoid
passing API keys as command-line arguments. The bridge does not certify proprietary
CLI behavior or sanitize its arbitrary tool capabilities.

## Review and release boundaries

A separate model endpoint can perform advisory review, but using two model invocations
is not independent experimental validation. Required reviewer endpoint names must be
distinct for truthful connection reporting. Neither a model review nor a manifest
consistency check proves correctness, novelty, factual truth or scientific validity.

No autonomous production deployment or source deletion is provided. Promotion means
local verified file integration only. Archive and manifest checks detect accidental
corruption/tampering relative to the supplied manifest; they are not a cryptographic
signature from an independently authenticated publisher.

Windows process-tree termination is not equivalent to the tested POSIX process-group
behavior. Windows execution and untrusted tool containment require additional acceptance
and a suitable Job Object/container boundary before use.

## Security checks executed versus missing

The automated suite covers traversal, symlink refusal, write scope conflicts, stale
fences, credential redaction cases, bounded subprocess output/timeouts, POSIX child
termination, authentication/Host checks, HTML escaping, TLS failure behavior, payload
and fingerprint tampering, unknown usage and budget persistence. It does not include
penetration testing, an OS sandbox assessment, a vulnerability-database audit, an
independent reviewer, or proof against every local TOCTOU race. See TEST_REPORT.md.
