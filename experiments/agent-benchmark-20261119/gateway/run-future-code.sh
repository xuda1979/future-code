#!/usr/bin/env bash
# future-code adapter for the compare-agent-productivity runner.
# Env: gateway at 127.0.0.1:8777 (Anthropic Messages via huanxin)
set -u
PROMPT_TEXT="${AGENT_BENCH_PROMPT_TEXT:-}"
PROMPT_FILE="${AGENT_BENCH_PROMPT:-}"
cd "${AGENT_BENCH_WORKSPACE:?need workspace}" || exit 1
MSG="\$1"
exec env FUTURE_BASE_URL="http://127.0.0.1:8777" \
  FUTURE_API_KEY="bench-dummy" \
  FUTURE_CODE_SIMPLE=1 \
  FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$FUTURE_BIN" --print --output-format json --no-session-persistence \
  --permission-mode acceptEdits \
  "$MSG"
