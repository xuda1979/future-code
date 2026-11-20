#!/usr/bin/env bash
# claude-code adapter for compare-agent-productivity runner.
set -u
cd "${AGENT_BENCH_WORKSPACE:?need workspace}" || exit 1
exec env ANTHROPIC_BASE_URL="http://127.0.0.1:8777" \
  ANTHROPIC_API_KEY="bench-dummy" \
  ANTHROPIC_MODEL="claude-sonnet-4-6" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$CLAUDE_BIN" --print --output-format json --dangerously-skip-permissions \
  --no-input "$1"
