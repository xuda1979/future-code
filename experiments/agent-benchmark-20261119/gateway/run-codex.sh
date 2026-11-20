#!/usr/bin/env bash
# codex adapter for compare-agent-productivity runner (Responses wire).
set -u
cd "${AGENT_BENCH_WORKSPACE:?need workspace}" || exit 1
exec env CODEX_HOME="${CODEX_HOME:-$1.codex}" \
  "$CODEX_BIN" -c "model_providers.bench.name=bench" \
  -c "model_providers.bench.base_url=http://127.0.0.1:8777" \
  -c "model_providers.bench.wire_api=responses" \
  -c "model_provider=bench" -c "model=GLM-5.3" \
  -c "model_providers.bench.env_key=BENCH_GW_KEY" \
  exec --skip-git-repo-check --ephemeral --json "$1"
