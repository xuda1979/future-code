#!/usr/bin/env bash
# Repo performance measurement harness (A/B comparable).
# Usage: measure.sh <label> <output-json>
# Measures git-tree facts + latency probes relevant to rnd_plan.md issues.
set -euo pipefail
LABEL="$1"
OUT="$2"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

# warm the fs cache once so both sides measure warm
git ls-files >/dev/null 2>&1 || true

# ---- tree facts ----
TRACKED_FILES=$(git ls-files | wc -l)
TREE_BLOB_BYTES=$(git ls-tree -r -l HEAD | awk '{s+=$4} END {printf "%d", s}')
BINARYISH_FILES=$(git ls-files | grep -Ec '\.(pdf|zip|png|jpg|jpeg|gif|tar|gz|tgz|docx|xlsx|parquet|npy|bin|wasm|mp4)$' || true)
TOPLEVEL_ENTRIES=$(ls -1 | wc -l)

# blob bytes of files > 100KB (bloat concentration)
BIG_BLOB_BYTES=$(git ls-tree -r -l HEAD | awk '$4 > 100000 {s+=$4} END {printf "%d", s}')
BIG_BLOB_COUNT=$(git ls-tree -r -l HEAD | awk '$4 > 100000 {c++} END {printf "%d", c}')

# ---- latency probes (best-of-N to reduce noise) ----
timeit() { # timeit <reps> <cmd...> -> best ms (integer)
  local reps="$1"; shift
  local best=""
  for _ in $(seq 1 "$reps"); do
    local s e ms
    s=$(date +%s%N)
    "$@" >/dev/null 2>&1 || true
    e=$(date +%s%N)
    ms=$(( (e - s) / 1000000 ))
    if [ -z "$best" ] || [ "$ms" -lt "$best" ]; then best=$ms; fi
  done
  echo "$best"
}

T_STATUS=$(timeit 5 git status --porcelain)
T_LSTREE=$(timeit 5 git ls-tree -r --name-only HEAD)
# search surface: counting matches of a common symbol across tracked files
T_GREP=$(timeit 5 git grep -l "export" -- ':!*.pdf' ':!*.zip' ':!*.png')

# agent bootstrap probe: 'future-code --version'-class cold start cost is
# dominated by repo scan in some paths; measure plain ls-files parse.
T_COUNT=$(timeit 5 sh -c 'git ls-files | wc -l')

cat > "$OUT" <<EOF
{
  "label": "$LABEL",
  "timestamp": "$(date -Is)",
  "commit": "$(git rev-parse HEAD)",
  "tracked_files": $TRACKED_FILES,
  "tracked_blob_bytes": $TREE_BLOB_BYTES,
  "big_blob_bytes_gt100k": $BIG_BLOB_BYTES,
  "big_blob_count_gt100k": $BIG_BLOB_COUNT,
  "binaryish_tracked_files": $BINARYISH_FILES,
  "toplevel_entries": $TOPLEVEL_ENTRIES,
  "ms_git_status_porcelain_best5": $T_STATUS,
  "ms_git_lstree_best5": $T_LSTREE,
  "ms_git_grep_export_best5": $T_GREP,
  "ms_lsfiles_count_best5": $T_COUNT
}
EOF
echo "wrote $OUT"
