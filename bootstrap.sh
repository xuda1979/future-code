#!/usr/bin/env bash
#
# bootstrap.sh — compatibility alias for install.sh (the ONE installation
# script). Everything happens in install.sh: Bun + dependencies + cc-agent
# binary + `future` wrapper + DeepSeek config check.
#
# Run:  ./bootstrap.sh     (same as ./install.sh)
#
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/install.sh"
