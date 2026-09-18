#!/usr/bin/env bash
#
# install.sh — THE one installation script for `future-code`.
#
#   1. installs Bun (if needed)
#   2. installs platform-correct dependencies
#   3. asks the user for the DeepSeek v4 flash URL + API key
#   4. compiles the standalone `future-code` binary from this repo's source
#   5. installs the `future-code` wrapper onto PATH
#
# The provided URL + API key are written to `deepseek.env` IN THIS FOLDER
# (chmod 600) and the wrapper reads that file next to itself. No credentials
# are baked into the binary or committed anywhere.
#
# Run on the target machine inside this folder:
#
#   ./install.sh
#
# The URL + API key prompts can be pre-answered via environment variables:
#
#   DEEPSEEK_BASE_URL=https://... DEEPSEEK_API_KEY=sk-... ./install.sh
#
# Idempotent — safe to re-run (reuses an existing Bun, rebuilds in place).
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> future-code installer"
echo "==> Platform: $(uname -s)/$(uname -m)"

# ─── 0. Prerequisites ────────────────────────────────────────────────────── #
if ! command -v curl >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
  echo "error: 'curl' is required (the Bun installer needs it). Install it first." >&2
  exit 2
fi

# ─── 1. Bun ──────────────────────────────────────────────────────────────── #
if ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # bun installs to ~/.bun/bin
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "error: bun not available after install" >&2; exit 2; }
echo "==> bun: $(bun --version)"

# ─── 2. Dependencies ─────────────────────────────────────────────────────── #
echo "==> Installing dependencies (platform-correct for $(uname -s)/$(uname -m))..."
bun install

# ─── 3. Prompt for the model endpoint URL + API key ──────────────────────── #
CONFIG_FILE="${PWD}/deepseek.env"

# Seed from an existing config so re-runs don't force retyping.
if [[ -f "$CONFIG_FILE" ]]; then
  set +u
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set -u
fi

echo ""
echo "==> Model endpoint configuration"
echo "    (paste the base URL and API key for the model deployment)"

# Base URL — always prompt; Enter keeps an existing value.
if [[ -n "${DEEPSEEK_BASE_URL:-}" ]]; then
  read -r -p "    Base URL [${DEEPSEEK_BASE_URL}]: " input_base
  DEEPSEEK_BASE_URL="${input_base:-$DEEPSEEK_BASE_URL}"
else
  read -r -p "    Base URL: " input_base
  DEEPSEEK_BASE_URL="${input_base:-}"
fi
if [[ -z "${DEEPSEEK_BASE_URL:-}" ]]; then
  echo "error: a base URL is required. Set DEEPSEEK_BASE_URL and re-run." >&2
  exit 2
fi

# API key — always prompt (hidden input); Enter keeps an existing key.
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  read -r -s -p "    API key (Enter keeps existing key): " input_key
  echo ""
  DEEPSEEK_API_KEY="${input_key:-$DEEPSEEK_API_KEY}"
else
  read -r -s -p "    API key: " input_key
  echo ""
  DEEPSEEK_API_KEY="${input_key:-}"
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "error: an API key is required. Set DEEPSEEK_API_KEY and re-run." >&2
  exit 2
fi

# Model name (default deepseek_v4, used by dp4/Huanxin deployments).
: "${DEEPSEEK_MODEL_NAME:=deepseek_v4}"
echo ""
read -r -p "    Model name [${DEEPSEEK_MODEL_NAME}]: " input_model
DEEPSEEK_MODEL_NAME="${input_model:-$DEEPSEEK_MODEL_NAME}"

# Optional API-gateway appcode (some Huanxin deployments require it as X-Ca-Key).
: "${DEEPSEEK_APPCODE:=}"
read -r -p "    Appcode (optional, leave blank for none): " input_appcode
DEEPSEEK_APPCODE="${input_appcode:-$DEEPSEEK_APPCODE}"

# Write config (chmod 600 — it holds a live secret).
umask 077
cat > "$CONFIG_FILE" <<EOF
# Future-code connection config — created by install.sh on $(date '+%Y-%m-%d %H:%M').
# Keep this file private (chmod 600) and out of any shared repository.
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
DEEPSEEK_MODEL_NAME=${DEEPSEEK_MODEL_NAME}
DEEPSEEK_APPCODE=${DEEPSEEK_APPCODE}
EOF
chmod 600 "$CONFIG_FILE"
echo "==> Wrote ${CONFIG_FILE} (chmod 600) — do not share this file."

# ─── 4. Compile the future-code binary ───────────────────────────────────── #
echo "==> Compiling future-code from src/entrypoints/cli-bundle.ts ..."
bun build src/entrypoints/cli-bundle.ts \
  --compile \
  --outfile=future-code \
  --target=bun

chmod +x future-code
echo "==> Built: $(pwd)/future-code"
./future-code --version || true

# ─── 4b. ripgrep (the Grep tool uses the system `rg` on plain-bun builds) ── #
if ! command -v rg >/dev/null 2>&1; then
  echo "==> warning: 'rg' (ripgrep) not found — the Grep tool will not work." >&2
  if [[ "$(id -u)" -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    apt-get install -y ripgrep || true
  elif [[ "$(id -u)" -eq 0 ]] && command -v dnf >/dev/null 2>&1; then
    dnf install -y ripgrep || true
  elif [[ "$(id -u)" -eq 0 ]] && command -v yum >/dev/null 2>&1; then
    yum install -y ripgrep || true
  else
    echo "==> (install ripgrep: apt-get/dnf install ripgrep)" >&2
  fi
fi

# ─── 5. Install the `future-code` wrapper onto PATH ──────────────────────── #
if [[ "$(id -u)" -eq 0 ]]; then
  BIN_DIR="/usr/local/bin"      # root: system-wide
else
  BIN_DIR="$HOME/.local/bin"    # non-root: user-local
fi
mkdir -p "$BIN_DIR"

chmod +x "$PWD/future-code.sh"
ln -sf "$PWD/future-code.sh" "$BIN_DIR/future-code"
ln -sf "$PWD/future-code"    "$BIN_DIR/future-code-bin"

# Make sure $BIN_DIR is on PATH for future shells (non-root case).
if [[ "$(id -u)" -ne 0 ]]; then
  PROFILE_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  for profile in "$HOME/.bashrc" "$HOME/.profile"; do
    if [[ -f "$profile" ]] && ! grep -qF "$BIN_DIR" "$profile"; then
      echo "$PROFILE_LINE" >> "$profile"
      echo "==> Added '$BIN_DIR' to PATH in $profile"
    fi
  done
fi

echo ""
echo "==> Done."
echo "    Binary:   $(pwd)/future-code"
echo "    Wrapper:  $BIN_DIR/future-code  (reads $(pwd)/deepseek.env)"
echo ""
echo "    Usage:"
echo "      future-code --print \"hi\"   # headless one-shot"
echo "      future-code                 # interactive session"
if [[ "$(id -u)" -ne 0 ]]; then
  echo ""
  echo "    Note: open a new shell (or log out/in) if '$BIN_DIR' was not on PATH yet."
fi
