# Persistent remote sessions and CLI defaults

## Start, disconnect and reconnect

Install Python 3 and tmux on the server before running `./install.sh` (for example
`sudo apt-get install python3 tmux`, or `sudo dnf install python3 tmux`).
The installed **wrapper** `future-code` protects interactive sessions automatically,
including browser shells without SSH environment variables. Existing tmux/screen
terminals remain under their existing owner. No additional model calls, prompt
text, context resets or changes to task scheduling are introduced.

```sh
future-code                         # start an interactive persistent session
future-code --sessions              # list saved session IDs and states
future-code --attach SESSION_ID     # attach to the same live process
future-code --session-status SESSION_ID
future-code --session-log SESSION_ID
future-code --stop-session SESSION_ID
```

Close the browser/SSH connection, or press tmux's `Ctrl-b` then `d` to detach.
Reconnect to the same server/account, list sessions, and attach by ID. Each start
creates a distinct session. Attach never reruns the initial prompt or command.
The reconnect command is printed before attaching. Session management works
without loading model configuration or contacting the provider.

`--foreground` explicitly ties the command to the current terminal.
`FUTURE_CODE_PERSIST=0` disables automatic wrapping. Pipes, `--print`, structured
input/output, help/version and the existing `--ops` interface keep their normal
streams and exit codes. Missing tmux produces an actionable error for persistent
starts; it does not silently run an unprotected interactive session. Launcher
session options must appear first. The raw `future-code-bin` binary does not own
a persistent terminal; use the installed wrapper for this behavior.

## Unattended commands and existing supervisors

```sh
future-code --detach --print "Complete the requested work"
future-code --detach -- node --experimental-strip-types \
  src/harness/foundry/swarm/cli.ts supervise \
  --objective research-1 --goal goal.json --tasks tasks.json --allow-exec
```

The second form runs the exact argv after `--`, without another shell parser,
in the current directory and environment. `--persist -- COMMAND ...` runs the
same way and attaches immediately. `--detach` returns a session ID; inspect its
eventual exit code with `--session-status`. A detached terminal gives the child
a PTY. For byte-exact JSON/pipeline output, keep the normal foreground `--print`
interface and use a process service manager when necessary.

tmux's independent server owns the PTY, the wrapper and the wrapper's local API
proxy. Client SIGHUP/disconnection does not reach these processes. An explicit
stop closes that session; the wrapper also forwards HUP and reaps its proxy.
Existing provider retry, objective recovery, scope, budget, verifier and
acceptance mechanisms keep their own semantics.

## State, limits and recovery

`~/.future-code/terminal/` holds one private directory per session. Override it
with `FUTURE_CODE_SESSION_DIR`. Directories must belong to the current user with
mode 700; files are created with a private umask. An atomic status file records
the ID, working directory, times, process state and exit code. The temporary argv
file is removed by the worker before launch. Credentials stay in the process
environment/config; status records never serialize the environment or prompt.
A separate tmux server for each session preserves the invoking environment
without putting credentials into tmux command lines or using stale shared-server
environment values.

Logs keep the current and previous 4 MiB chunks (at most 8 MiB per session).
Older output is discarded. Task evidence still belongs in the existing durable
store/artifact system. Completed registry entries remain available; remove a
completed session directory when its status/logs are no longer needed.

| State | Meaning |
|---|---|
| STARTING / RUNNING | Terminal command is starting or running |
| EXITED | Child exited; `exitCode` is the real code, including nonzero exits |
| FAILED | Session setup/monitor encountered an error |
| STOPPED | Operator explicitly closed the terminal session |
| UNKNOWN | Terminal server/outcome is unavailable; reconcile before replacement work |

Exit 0 is a **process result**, never proof that the research objective passed.
If the tmux server dies or the host reboots, status reports UNKNOWN for an
unfinished process. Reconcile remote jobs and use Foundry/Swarm's persisted
objective/session state to resume. This terminal layer never automatically
replays a command. Host reboot, systemd policies that kill all processes at
logout, container teardown, and expired provider credentials require the
appropriate host/service/runtime recovery; a persistent terminal alone cannot
resolve them. Use systemd/launchd/Kubernetes for restart across host/service loss.

## Default permission mode

Ordinary CLI sessions now resolve to `bypassPermissions` when neither CLI flags
nor settings choose a mode. This has the execution behavior of
`--dangerously-skip-permissions` without repeating the flag. To opt out:

```sh
future-code --permission-mode default
future-code --permission-mode plan
FUTURE_CODE_SKIP_PERMISSIONS=0 future-code
```

An explicit `--dangerously-skip-permissions` retains its previous precedence.
Explicit permission modes and `permissions.defaultMode` precede the new fallback.
`permissions.disableBypassPermissionsMode` and the existing organization
killswitch still disable bypass. Managed `FUTURE_CODE_REMOTE` sessions retain
their own default. Existing root/sandbox eligibility, first-use setup and
protected Foundry acceptance boundaries remain enforced. The launcher does not
forge sandbox flags or overwrite settings to enable bypass.

## Design review and upstream lessons

The review is based on current source, not historical patches. These are
adaptations of documented patterns, not copied upstream implementations.

| Reference | Relevant strength | Change / retained boundary in Future-Code |
|---|---|---|
| [OpenCode server](https://docs.opencode.ai/docs/server/) | UI clients and execution have separate lifetimes | A disconnected terminal client can reattach to the existing execution owner |
| [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Execution state survives client/session changes | Atomic terminal status plus existing durable objective/thread receipts; no inferred PASS |
| [Anthropic Managed Agents](https://www.anthropic.com/research/managed-agents) | Session, harness and execution environment have separate interfaces | PTY ownership contains the wrapper/proxy; terminal management is independent of model setup |
| [Anthropic long-running harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) | Incremental progress, explicit handoff and checked completion | Existing journals/checkpoints and final verification are retained; reconnect adds no context resets or blanket prompt instructions |
| [tmux](https://github.com/tmux/tmux/wiki/Getting-Started) | Proven PTY detach/attach behavior under dropped remote connections | Reuse the terminal implementation rather than create another PTY/network protocol |

Concrete review fixes: unattended permission fallback with policy precedence;
terminal/proxy ownership across client loss; HUP forwarding; controls available
without provider credentials; bounded log storage; visible launch errors;
UNKNOWN state for lost execution owners; exact argv transport; and removal of a
duplicated permission fallback branch. Feature-gated legacy daemon/background
entry points reference modules absent from this source snapshot, so this path
uses the shipped launcher and does not enable those incomplete features.

Further work needs evidence: automatic service restart with side-effect
reconciliation, redacted searchable session retention, and matched live-provider
baseline/candidate trials. Offline tests cannot establish improved reasoning,
creativity or live-model productivity. No claims of improvement on those axes are
made here; prompts, models, task budgets and scheduler policy are unchanged.

## Verification

`scripts/test-correctness.mjs` includes default-mode/precedence, log rotation and
launcher regressions. The `terminal-sessions` CI job installs tmux and requires
the real PTY integration suite (no skips), testing client disconnect with a live
proxy, reattachment to the same PID, explicit stop, nonzero exits, exact argv and
environment, missing owners, private registry files, and bounded logs. It makes
no model requests. Runners without tmux/Unix socket support report those
integration cases as skipped; they are not a substitute for the required CI job.
