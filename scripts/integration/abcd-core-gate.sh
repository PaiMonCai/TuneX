#!/usr/bin/env bash
# Real core acceptance, on the existing disposable topology (no production DB).
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/integration"
export TUNEX_FXP_LINKS_ENABLED=true
export FORWARD_NATIVE_BOTH_ENABLED=true
export TUNEX_FXP_TRAFFIC_EPOCH_SECONDS=${TUNEX_FXP_TRAFFIC_EPOCH_SECONDS:-30}
export TUNEX_IT_AGENT_VERSION=${TUNEX_IT_AGENT_VERSION:-0.0.0-it}
bash "$HERE/setup.sh"
python3 "$HERE/abcd-links.py"
python3 "$HERE/native-both.py"
echo "Evidence: $HERE/evidence/abcd-links-result.txt"
echo "Evidence: $HERE/evidence/native-both-result.txt"
echo "The existing current-protocol and A00 gates remain required release checks."
