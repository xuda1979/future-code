#!/usr/bin/env bash
#
# build.sh — Build the standalone `future-code` binary from this repo's source.
#
# Portable: works on macOS and Linux. Run it on the TARGET platform so Bun
# compiles a native binary for that platform (macOS -> Mach-O, Linux -> ELF).
#
# Requirements:
#   * Bun >= 1.2  (https://bun.sh — install with: curl -fsSL https://bun.sh/install | bash)
#
# Output: ./future-code  (a standalone, self-contained executable)
#
# This build NEVER uses the installed `future` binary — only this source.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# 1. Ensure bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 2
fi
echo "==> Using bun: $(bun --version)"

# 2. Install dependencies (platform-correct native binaries for THIS machine).
#    Skipped when node_modules is already populated: the internal @future/*
#    registry aliases cannot resolve against public npm, so a re-install
#    breaks offline/intranet builds even though dependencies are complete.
if [[ -d node_modules/@future/sdk ]]; then
  echo "==> Dependencies already installed (node_modules present); skipping 'bun install'."
  echo "    (Delete node_modules to force a fresh install.)"
else
  echo "==> Installing dependencies (platform-correct for $(uname -s)/$(uname -m))..."
  bun install
fi

# 3. Compile the standalone agent from source
echo "==> Compiling future-code from src/entrypoints/cli-bundle.ts ..."
bun build src/entrypoints/cli-bundle.ts \
  --compile \
  --outfile=future-code \
  --target=bun

chmod +x future-code
echo "==> Done."
echo "    Binary: $(pwd)/future-code ($(file -b future-code | cut -d, -f1-2))"
echo "    Verify: ./future-code --version"
