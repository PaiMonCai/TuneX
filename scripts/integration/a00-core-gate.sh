#!/usr/bin/env bash
# A00 real-core gate.
#
# This is intentionally an operator/release gate, not the lightweight PR CI:
# it builds real images and exercises the isolated Docker topology.
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/integration"
KEEP_STACK=${A00_KEEP_STACK:-1}
FRESH=${A00_FRESH:-1}

say() { printf '
\033[1;36m== %s\033[0m
' "$*"; }

if [[ "$FRESH" == "1" ]]; then
  say "A00: remove any previous disposable integration topology"
  "$HERE/teardown.sh" >/dev/null 2>&1 || true
fi

say "A00: build/provision the real MySQL/Redis/Panel/Worker/4-Agent topology"
"$HERE/setup.sh"

say "A00: released TCP/UDP data plane, retarget, suspend and restart regression"
python3 "$HERE/current-protocol.py"

say "A00: deletion cleanup + exact ingress-port reuse for DIRECT and RELAY"
python3 "$HERE/a00-delete-reuse.py"

say "A00 core network gate passed"
echo "Evidence:"
echo "  $HERE/evidence/current-protocol-result.txt"
echo "  $HERE/evidence/a00-delete-reuse-result.txt"
echo "  $HERE/evidence/current-protocol-http.json"
echo "  $HERE/evidence/a00-delete-reuse-http.json"

if [[ "$KEEP_STACK" == "0" ]]; then
  say "A00: teardown requested"
  "$HERE/teardown.sh"
else
  echo "A00_KEEP_STACK=$KEEP_STACK: topology retained for browser/status/weighted-round inspection."
fi
