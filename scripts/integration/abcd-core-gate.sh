#!/usr/bin/env bash
# Real core acceptance, on the existing disposable topology (no production DB).
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/integration"
export TUNEX_FXP_LINKS_ENABLED=true
export TUNEX_IT_AGENT_VERSION=${TUNEX_IT_AGENT_VERSION:-0.0.0-it}
bash "$HERE/setup.sh"
python3 "$HERE/abcd-links.py"
echo "Evidence: $HERE/evidence/abcd-links-result.txt"
echo "The existing current-protocol and A00 gates remain required release checks."
