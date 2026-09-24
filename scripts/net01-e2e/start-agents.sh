#!/usr/bin/env bash
# NET-01 双租户 E2E —— 启动两个相互隔离的 agent 实例
#
# 每个 agent：
#   · 独立 workspace（state.json 里两个不同 workspaceId）
#   · 独立入口节点组（不同 token → Socket.IO 鉴权后进入不同 room node_group/<id>）
#   · 独立 node_id / 日志 / 工作目录（/tmp/net01/{A,B}）
#   · 各自监听自己组的端口（A:20001, B:21001），转发目标各自不同
# 两个 agent 都是**真实网络**（本机 Socket.IO + 真实 TCP listener），无 mock。
#
# 依赖 config/license 密钥与 SITE_URL 来自 scripts/net01-e2e/.env.net01。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/net01-e2e"
AGENT_BIN=${AGENT_BIN:-/tmp/tunex-agent-net01}
SITE_URL=${SITE_URL:-http://127.0.0.1:8788}

[[ -x "$AGENT_BIN" ]] || { echo "building agent..."; (cd "$REPO/agent" && go build -o "$AGENT_BIN" .); }
[[ -f "$HERE/state.json" ]] || { echo "missing state.json；先跑 bootstrap-tenants.sh" >&2; exit 1; }

set -a; . "$HERE/.env.net01"; set +a

stop_stale() {
  pkill -f "tunex-agent-net01 -s" 2>/dev/null || true
  sleep 0.3
}
stop_stale

start_agent() {
  local ten="$1" node_id port
  IFS='|' read -r node_id token port <<<"$(python3 - "$HERE/state.json" "$ten" <<'PY'
import json,sys
st=json.load(open(sys.argv[1]))[sys.argv[2]]
print(f"{st['email'].split('@')[0].upper()}-NODE|{st['token']}|{st['listenPort']}")
PY
)"
  mkdir -p "/tmp/net01/$ten"
  echo "start $ten node_id=$node_id port=$port"
  TUNEX_CONFIG_KEY="$TUNEX_CONFIG_KEY" TUNEX_LICENSE_KEY="$TUNEX_LICENSE_KEY" \
    "$AGENT_BIN" -s "$SITE_URL" -t "$token" -n "$node_id" -i 127.0.0.1 -d \
    > "/tmp/net01/$ten/agent.log" 2>&1 &
  echo $! > "/tmp/net01/$ten/agent.pid"
}

start_agent tenantA
start_agent tenantB
sleep 8

echo "--- pids ---"; pgrep -af "tunex-agent-net01 -s" || true
echo "--- listening (租户端口) ---"
ss -ltnp 2>/dev/null | grep -E ":(20001|21001)\b" || echo "(尚未监听)"
echo "--- logs (tail) ---"
tail -n 6 "/tmp/net01/tenantA/agent.log"; echo "..."; tail -n 6 "/tmp/net01/tenantB/agent.log"
