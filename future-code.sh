#!/usr/bin/env bash
set -uo pipefail
#
# future-code.sh — the `future-code` command installed by install.sh.
#
# Reads the model endpoint URL + API key from `deepseek.env` (created by
# install.sh), launches a local Future->OpenAI proxy when the endpoint is
# OpenAI-compatible, and runs the source-built `future-code` binary against
# it. No URLs or API keys are hardcoded here or in the binary.
#
# Usage:
#   future-code --print "hi"   # headless one-shot
#   future-code                # interactive session
# --------------------------------------------------------------------------- #
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:$PATH"

# ─── Locate this folder even when invoked through a symlink on PATH ──────── #
resolve_symlink() {
  local target="$1" link
  while [[ -L "$target" ]]; do
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *) target="$(dirname "$target")/$link" ;;
    esac
  done
  printf '%s\n' "$target"
}
SOURCE_FILE="$(resolve_symlink "${BASH_SOURCE[0]}")"
case "$SOURCE_FILE" in
  /*) ;;
  *) SOURCE_FILE="$PWD/$SOURCE_FILE" ;;
esac
SCRIPT_DIR="$(cd "$(dirname "$SOURCE_FILE")" && pwd -P)"

# ─── 1. Load config (URL + API key live in this folder) ──────────────────── #
CONFIG_FILE="${FUTURE_CODE_CONFIG_FILE:-${SCRIPT_DIR}/deepseek.env}"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "error: config file not found: $CONFIG_FILE" >&2
  echo "       Run ./install.sh in $SCRIPT_DIR to set the URL + API key." >&2
  exit 2
fi
set +u
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set -u

API_KEY="${FUTURE_CODE_API_KEY:-${DEEPSEEK_API_KEY:-}}"
BASE_URL="${FUTURE_CODE_BASE_URL:-${DEEPSEEK_BASE_URL:-http://172.23.31.2/token}}"
MODEL="${FUTURE_CODE_MODEL:-${DEEPSEEK_MODEL_NAME:-GLM-5.3}}"
APPCODE="${FUTURE_CODE_APPCODE:-${DEEPSEEK_APPCODE:-}}"
MAX_INPUT_CHARS="${FUTURE_CODE_MAX_INPUT_CHARS:-${MAX_INPUT_CHARS:-440000}}"

if [[ -z "$API_KEY" ]]; then
  echo "error: API key is not set in $CONFIG_FILE" >&2
  exit 2
fi
if [[ -z "$BASE_URL" ]]; then
  echo "error: Base URL is not set in $CONFIG_FILE" >&2
  exit 2
fi

# ─── 2. Find the source-built binary + proxy script ──────────────────────── #
BIN="${FUTURE_CODE_BIN:-${SCRIPT_DIR}/future-code}"
if [[ ! -x "$BIN" ]]; then
  echo "error: binary '$BIN' not found." >&2
  echo "       Run ./install.sh in $SCRIPT_DIR to build it." >&2
  exit 2
fi
PROXY_SCRIPT="${SCRIPT_DIR}/future_huanxin_future_proxy.py"
PROXY_PID=""
PROXY_PORT=""

cleanup_proxy() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" >/dev/null 2>&1 || true
}
trap cleanup_proxy EXIT INT TERM

free_local_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# ─── 3. Decide direct vs proxied and launch accordingly ──────────────────── #
# If the upstream is Future-compatible (path ends in /future), talk to
# it directly. Otherwise route through the local Future->OpenAI proxy
# (e.g. Huanxin dp4 deployments, which speak the OpenAI chat API).
case "$BASE_URL" in
  */future)
    DIRECT=1
    ;;
  *)
    DIRECT=0
    ;;
esac

if [[ "$DIRECT" -eq 0 ]]; then
  if [[ ! -f "$PROXY_SCRIPT" ]]; then
    echo "error: proxy script not found at $PROXY_SCRIPT" >&2
    exit 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 is required to proxy the OpenAI-compatible endpoint" >&2
    exit 2
  fi
  PROXY_PORT="$(free_local_port)"
  LOG_FILE="${TMPDIR:-/tmp}/future-code-proxy-${PROXY_PORT}.log"
  AUTH="Bearer"
  if [[ -n "$APPCODE" ]]; then
    APPCODE_ARG=(--appcode "$APPCODE")
  else
    APPCODE_ARG=()
  fi
  echo "future-code: starting local proxy on port $PROXY_PORT (log: $LOG_FILE)" >&2
  python3 "$PROXY_SCRIPT" \
    --host 127.0.0.1 --port "$PROXY_PORT" \
    --upstream-url "$BASE_URL" \
    --upstream-token "$AUTH $API_KEY" \
    --model-name "$MODEL" \
    --max-input-chars "$MAX_INPUT_CHARS" \
    "${APPCODE_ARG[@]+"${APPCODE_ARG[@]}"}" >"$LOG_FILE" 2>&1 &
  PROXY_PID=$!
  ENDPOINT="http://127.0.0.1:${PROXY_PORT}"
  local_key="local-proxy"
  echo "future-code: waiting for proxy to be ready..." >&2
  ready=0
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" -eq 0 ]]; then
    echo "error: local proxy did not become ready (see $LOG_FILE)" >&2
    exit 1
  fi
  echo "future-code: proxy ready on $ENDPOINT" >&2
else
  ENDPOINT="$BASE_URL"
  local_key="$API_KEY"
  echo "future-code: connecting directly to $ENDPOINT" >&2
fi

echo "future-code: binary=$BIN" >&2

# ─── 4. Launch the binary ────────────────────────────────────────────────── #
export FUTURE_CODE_PROVIDER_MANAGED_BY_HOST=1
export FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"
export FUTURE_BASE_URL="$ENDPOINT"
export FUTURE_API_KEY="$local_key"
export FUTURE_AUTH_TOKEN="$local_key"
export FUTURE_MODEL="$MODEL"
export FUTURE_SMALL_FAST_MODEL="$MODEL"
export FUTURE_DEFAULT_HAIKU_MODEL="$MODEL"
export FUTURE_DEFAULT_SONNET_MODEL="$MODEL"
export FUTURE_DEFAULT_OPUS_MODEL="$MODEL"
export FUTURE_CODE_SUBAGENT_MODEL="$MODEL"
export FUTURE_CODE_EFFORT_LEVEL="max"
exec "$BIN" --model "$MODEL" --effort max "$@"
