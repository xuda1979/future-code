#!/usr/bin/env bash
# opencode adapter for compare-agent-productivity runner (OpenAI chat).
set -u
cd "${AGENT_BENCH_WORKSPACE:?need workspace}" || exit 1
exec env OPENAI_BASE_URL="http://127.0.0.1:8777/v1" \
  OPENAI_API_KEY="bench-dummy" \
  OPENAI_MODEL="GLM-5.3" \
  "$OPENCODE_BIN" run "$1" --model GLM-5.3
