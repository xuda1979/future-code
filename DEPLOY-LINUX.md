# Deploying to a Linux Server

This folder is fully self-contained. Copy it to the Linux server and run
**one** script — `./install.sh` — which:

1. installs Bun (if needed) and platform-correct dependencies,
2. compiles the native Linux `cc-agent` binary from this source,
3. installs the `future` wrapper onto PATH so `future -p deepseek` connects
   to DeepSeek's official API for its models.

No `future` binary is ever used — only this source.

## What to copy
Everything in this folder EXCEPT generated/transient artifacts. Simplest:

    rsync -az --exclude node_modules \
          --exclude cc-agent \
          /path/to/future-code-main/ user@server:/opt/cc-agent/

If rsync is unavailable, `tar` the folder the same way.

`node_modules` and the prebuilt `cc-agent` are **excluded** on purpose:
- `node_modules` contains Mac-only native binaries (sharp/@img darwin). The
  server must generate its OWN via `bun install` inside `install.sh`.
- `cc-agent` is a Mac Mach-O binary; the server builds its own Linux ELF.

## Required files that MUST be copied (build-critical)
  install.sh               # THE one installation script (bun + build + wrapper)
  future.sh                # the `future` wrapper (installed onto PATH)
  deepseek.env             # DeepSeek URL + API key (read from this folder)
  package.json             # dependency manifest (vendors internal @ant stub)
  bun.lock                 # dependency lockfile (platform-aware)
  tsconfig.json            # src/* path aliases
  bunfig.toml              # MACRO.VERSION define
  src/                     # the agent source (incl. local stub modules)
  vendor/                  # local replacement for internal @ant package
  build.sh                 # optional: rebuild-only convenience
  start-*.sh               # optional: cmri/huanxin launchers
  future_huanxin_future_proxy.py   # optional: ONLY cmri/huanxin need it

## On the server
    cd /opt/cc-agent
    ./install.sh            # bun + deps + cc-agent + `future` wrapper

    future -p deepseek                                    # interactive
    future -p deepseek -m deepseek-v4-pro                 # pick a model
    future -p deepseek -m deepseek-v4-flash --print "hi"  # headless one-shot
    future -P deepseek -p "hi"                            # print mode
    cc-agent --version                                    # bare binary

`-p <provider>` selects the provider (like the multi-provider `future`
wrapper); a `-p` followed by anything that is not `deepseek` falls through
unchanged as print mode. With no `-p`, the provider defaults to DeepSeek.

## Notes
- **DeepSeek is direct**: its endpoint speaks the Future API, so the
  server needs NO python3 and NO local proxy — just `future -p deepseek`.
- **ripgrep**: the Grep tool uses a system `rg` on plain-bun builds;
  `install.sh` installs it (apt/dnf/yum) when run as root, otherwise warns.
- **URL + API key**: both live in `deepseek.env` in this folder. `install.sh`
  chmods it to 600 — keep it private and do not commit it to any shared
  repository.
- `install.sh` is idempotent (safe to re-run); `bootstrap.sh` is now just an
  alias for it.
- Bun's lockfile is platform-aware: `bun install` on the server pulls Linux
  native deps (e.g. @img/sharp-linux-*) automatically.
- The `@ant/future-for-chrome-mcp` internal package is satisfied by the
  repo-local `vendor/` directory via a `file:` dependency — no npm needed.
