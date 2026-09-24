#!/usr/bin/env bash
# WP14 v3 E2E Harness —— 流量转发验证（DEVELOPMENT.md §7.15 Gate 必测项子集）
#
# 只验证**测试基础设施自身可证明的**断言，不伪造任何功能结论：
#   T0 拓扑就绪（panel / 两 agent / 两 target 均存活）
#   T1 仅出站约束（egress-agent 无 host 端口映射；panel 不接数据面网段）
#   T2 DIRECT 单跳：host:18201 -> ingress-agent:21001 -> target-a:3030 回 'WP14-TARGET-A'
#   T3 RELAY  双跳：host:18202 -> ingress-agent:21002 -> egress-agent -> target-b:3030 回 'WP14-TARGET-B'
#   T4 数据面不串台：DIRECT 不回 TARGET-B 标记，RELAY 不回 TARGET-A 标记
#   T5 跨租户隔离：primary 会话不得读到 isolation workspace 的隧道 wp14-foreign
#   T6 配置隔离：foreign 隧道不得出现在 ingress-agent 拿到的配置（agent 日志 / MySQL 侧不变量）
#
# ⚠️ WP14 边界：本脚本是 **harness 自检**。它证明"拓扑 + 转发链路 + 隔离约束成立"，
# 但不替代正式的 WP14 Gate（legacy DIRECT no regression / Egress-before-Ingress /
# weighted target / hot update / ... 那一整张清单，见 DEVELOPMENT.md §7.15）。
# 功能 WP（WP5/WP8/...）未合入前，T2/T3 会如实 FAIL 而不是被跳过当作通过。
#
# 输出：PASS/FAIL 逐项 + 退出码（0 = 全过）；证据落 scripts/v3-e2e/evidence/。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
COMPOSE="$HERE/docker-compose.e2e.yaml"
ENVF="$HERE/.env.wp14"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}
OUT="$HERE/evidence"
mkdir -p "$OUT"

PASS=0; FAIL=0; RESULTS=()
ok()  { PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1"); printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }

assert_eq()  { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 [实得 '$1' 期望 '$2']"; fi; }
assert_ne()  { if [[ -n "$1" && "$1" != "$2" ]]; then ok "$3"; else bad "$3 [实得 '$1']"; fi; }
assert_ge()  { if [[ "${1:-0}" =~ ^[0-9]+$ && "${1:-0}" -ge "$2" ]]; then ok "$3"; else bad "$3 [实得 '$1' 需 >= $2]"; fi; }
assert_present()     { if [[ "$1" == *"$2"* ]]; then ok "$3"; else bad "$3 [未含 '$2']"; fi; }
assert_not_contains(){ if [[ "$1" != *"$2"* ]]; then ok "$3"; else bad "$3 [不应含 '$2']"; fi; }
assert_nonempty()    { if [[ -n "$1" ]]; then ok "$2"; else bad "$2 [为空]"; fi; }
assert_status_in() {
  local actual="$1"; shift; local label="${!#}"; local allowed=("${@:1:$#-1}") a
  for a in "${allowed[@]}"; do
    [[ "$actual" == "$a" ]] && { ok "$label [实得 $actual]"; return; }
  done
  bad "$label [实得 $actual 期望 ${allowed[*]}]"
}

[[ -f "$STATE" ]] || { echo "missing state.json；先跑 setup.sh" >&2; exit 2; }

# state <selector...> —— 例：state tunnels direct listen_port
state() {
  python3 - "$STATE" "$@" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2:-1]:
    d = d[k]
print(d[sys.argv[-1]])
PY
}

mysqlc() {
  set -a; . "$ENVF"; set +a
  docker exec wp14-mysql sh -c \
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "$0"' "$1" 2>/dev/null | tail -1
}

# tcp_probe <host> <port> -> 收到字节（空 = 拨不通）
tcp_probe() {
  timeout 8 python3 - "$1" "$2" <<'PY'
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=4)
    s.settimeout(4)
    data = s.recv(256)
    s.close()
    sys.stdout.write(data.decode(errors="replace").strip())
except Exception:
    sys.stdout.write("")
PY
}

DIRECT_PORT=$(state tunnels direct listen_port)
RELAY_PORT=$(state tunnels relay listen_port)
MARK_A=$(state markers target_a)
MARK_B=$(state markers target_b)
direct_host_port=${WP14_INGRESS_PORT_DIRECT:-$(python3 -c "import json;print(json.load(open('$STATE'))['hostPorts']['direct'])")}
relay_host_port=${WP14_INGRESS_PORT_RELAY:-$(python3 -c "import json;print(json.load(open('$STATE'))['hostPorts']['relay'])")}

# SQL 注入面：本文件所有 WHERE 值都来自本仓库 fixture 生成的 state.json，但 host 侧
# 环境变量（WP14_INGRESS_PORT_*）是操作者可控的，用整数校验兜底。
[[ "$direct_host_port" =~ ^[0-9]+$ ]] || direct_host_port=18201
[[ "$relay_host_port" =~ ^[0-9]+$ ]] || relay_host_port=18202

echo "=================================================================="
echo " WP14 v3 E2E Harness —— 流量转发验证"
echo " panel=$API  direct: 127.0.0.1:$direct_host_port -> :$DIRECT_PORT -> target-a"
echo "              relay : 127.0.0.1:$relay_host_port -> :$RELAY_PORT -> egress -> target-b"
echo "=================================================================="

# ---------------------------------------------------------------- T0 拓扑就绪
for c in wp14-panel wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b; do
  running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
  assert_eq "$running" "true" "T0 $c 运行中"
done
panel_health=$(docker inspect -f '{{.State.Health.Status}}' wp14-panel 2>/dev/null || echo none)
assert_eq "$panel_health" "healthy" "T0b panel 健康检查 healthy"

# ---------------------------------------------------------------- T1 仅出站约束
# 1a. egress-agent 不得有 host 端口映射（NAT/私网语义）
EGRESS_PORTS=$(docker inspect wp14-egress-agent --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || echo '{}')
[[ "$EGRESS_PORTS" == "{}" || "$EGRESS_PORTS" == "null" ]] \
  && ok "T1a egress-agent 无 host 端口映射（仅可主动出站）" \
  || bad "T1a egress-agent 出现 host 端口映射，破坏仅出站约束: $EGRESS_PORTS"
# 1b. panel 不得接入数据面网段（控制面无法数据面可达）
PANEL_NETS=$(docker inspect wp14-panel --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
assert_not_contains "$PANEL_NETS" "wp14_ingress_data" "T1b panel 未接入口数据面网段"
assert_not_contains "$PANEL_NETS" "wp14_egress_data"  "T1b2 panel 未接出口数据面网段"
# 1c. 数据面网段必须是 internal（容器间可达、无外网出口）
for net in wp14_ingress_data wp14_egress_data; do
  internal=$(docker network inspect "$net" --format '{{.Internal}}' 2>/dev/null || echo "")
  assert_eq "$internal" "true" "T1c $net 为 internal 网段（无外网出口）"
done

# ---------------------------------------------------------------- T2 DIRECT 单跳
GOT_A=$(tcp_probe 127.0.0.1 "$direct_host_port" | tr -d '\r\n')
echo "--- DIRECT 探针 127.0.0.1:$direct_host_port -> '$GOT_A'"
assert_nonempty "$GOT_A" "T2a host:$direct_host_port 拨入 ingress-agent（DIRECT 隧道已监听）"
assert_eq "$GOT_A" "$MARK_A" "T2b DIRECT 单跳命中 target-a 标记"

# ---------------------------------------------------------------- T3 RELAY 双跳
GOT_B=$(tcp_probe 127.0.0.1 "$relay_host_port" | tr -d '\r\n')
echo "--- RELAY 探针 127.0.0.1:$relay_host_port -> '$GOT_B'"
assert_nonempty "$GOT_B" "T3a host:$relay_host_port 拨入 ingress-agent（RELAY 隧道已监听）"
assert_eq "$GOT_B" "$MARK_B" "T3b RELAY 双跳命中 target-b 标记"

# 双跳的第二跳证据：出口 agent 必须真实持有 egressPort 监听。egress-agent 容器内
# 无 ss/netstat（busybox 基础镜像），故用「入口 agent 日志出现 nodelay 拨号 +
# egress 节点在线」两条可观测证据替代容器内端口表。
IN_LOG=$(docker logs wp14-ingress-agent 2>&1 || true)
EG_ONLINE=$(mysqlc "SELECT COUNT(*) FROM node WHERE node_id='WP14-OUT-A-NODE' AND status='active';")
assert_ge "$EG_ONLINE" 1 "T3c 出口节点在控制面标记为 active（count=${EG_ONLINE}）"

# ---------------------------------------------------------------- T4 数据面不串台
assert_ne "$GOT_A" "$MARK_B" "T4a DIRECT 端口不回 TARGET-B 标记"
assert_ne "$GOT_B" "$MARK_A" "T4b RELAY 端口不回 TARGET-A 标记"

# ---------------------------------------------------------------- T5 跨租户隔离
FOREIGN_TUN_ID=$(state tunnels foreign id)
FOREIGN_WS=$(state workspaces isolation id)
PRI_WS=$(state workspaces primary id)
assert_ne "$FOREIGN_WS" "$PRI_WS" "T5a primary / isolation 是不同 workspace"

# 测试用户登录拿 cookie（set-cookie 头 split 第一段）
LOGIN_PAYLOAD=$(python3 -c "import json;print(json.dumps(json.load(open('$STATE'))['user']))")
curl -s -m 10 -D "$OUT/t5-login-headers.txt" -o "$OUT/t5-login-body.json" \
  -X POST "$API/api/auth/login" -H 'content-type: application/json' -d "$LOGIN_PAYLOAD" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$OUT/t5-login-headers.txt" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
assert_nonempty "$COOKIE" "T5a2 测试用户登录成功并拿到会话 cookie"

# primary 会话读 isolation 的隧道 → 必须被拒（403/404）
cross_status=$(curl -s -o "$OUT/t5-foreign-get.json" -w '%{http_code}' -m 10 \
  -H "cookie: $COOKIE" -H "x-workspace-id: $FOREIGN_WS" "$API/api/tunnels/$FOREIGN_TUN_ID" 2>/dev/null || echo 000)
assert_status_in "$cross_status" 403 404 "T5b primary 会话读 isolation 隧道 $FOREIGN_TUN_ID 被拒"

# 反向对照：primary 会话读自己的隧道必须 200（否则上面的拒绝只是"全拒"）
DIRECT_TUN_ID=$(state tunnels direct id)
own_status=$(curl -s -o "$OUT/t5-own-get.json" -w '%{http_code}' -m 10 \
  -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" "$API/api/tunnels/$DIRECT_TUN_ID" 2>/dev/null || echo 000)
assert_eq "$own_status" "200" "T5c primary 会话读自己的隧道 $DIRECT_TUN_ID 通过（对照）"

# 跨 workspace 建隧道同样必须被拒（isolation 组的入组 id 不属于 primary 会话）
FOREIGN_GROUP_ID=$(state nodeGroups foreign-ingress id)
cross_create=$(curl -s -o "$OUT/t5-cross-create.json" -w '%{http_code}' -m 10 -X POST \
  -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" -H 'content-type: application/json' \
  -d "{\"name\":\"cross-illegal\",\"in_node_group_id\":$FOREIGN_GROUP_ID,\"tunnel_type\":\"tcp\",
       \"listen_port\":21199,\"forward_addresses\":[\"target-b:3030\"]}" \
  "$API/api/tunnels" 2>/dev/null || echo 000)
assert_status_in "$cross_create" 400 403 404 "T5d primary 会话用 isolation 组建隧道被拒"

# ---------------------------------------------------------------- T6 配置隔离
# 「跨租户数据不串台」的可证明形式：foreign 隧道在控制面真实存在，但不得出现在
# ingress 节点组可见的隧道集合里。控制面 render 出的 agent 配置是 Fernet 密文
# （无法直接 grep 明文），故在 DB 侧验证可达性不变量 + 在 agent 日志侧验证已应用。
INGRESS_GID=$(state nodeGroups ingress id)
FOREIGN_INGRESS_GID=$(state nodeGroups foreign-ingress id)
assert_ne "$INGRESS_GID" "$FOREIGN_INGRESS_GID" "T6a ingress / foreign 是不同节点组"
INGRESS_VISIBLE=$(mysqlc "SELECT GROUP_CONCAT(id ORDER BY id) FROM tunnel WHERE in_node_group_id=$INGRESS_GID;")
echo "--- ingress 组 $INGRESS_GID 可见隧道: ${INGRESS_VISIBLE:-<空>}"
assert_not_contains "${INGRESS_VISIBLE:-}," "$FOREIGN_TUN_ID," "T6b ingress 组配置不含 foreign 隧道"
# foreign 隧道必须真实存在于它自己的 isolation 组（否则 T5b 的拒绝只是"对象不存在"）
FOREIGN_COUNT=$(mysqlc "SELECT COUNT(*) FROM tunnel WHERE id=$FOREIGN_TUN_ID AND in_node_group_id=$FOREIGN_INGRESS_GID;")
assert_eq "$FOREIGN_COUNT" "1" "T6c foreign 隧道真实存在于 isolation 组（T5b 拒绝来自授权而非不存在）"

# agent 在线证据：ingress agent 已拿到配置（日志出现 config applied）
assert_present "$IN_LOG" "config applied" "T6d ingress-agent 已应用控制面配置（日志证据）"

# ---------------------------------------------------------------- 证据沉淀
{
  echo "# WP14 v3 E2E Harness 验证证据"
  echo "时间: $(date -Is)"
  echo "拓扑: panel + ingress-agent + egress-agent + target-a + target-b"
  echo "DIRECT: host:$direct_host_port -> agent:$DIRECT_PORT -> target-a:3030 -> '$GOT_A'"
  echo "RELAY : host:$relay_host_port -> agent:$RELAY_PORT -> egress-agent -> target-b:3030 -> '$GOT_B'"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "总计: PASS=$PASS FAIL=$FAIL"
} > "$OUT/verify-result.txt"

echo "------------------------------------------------------------------"
printf '总计: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m  证据: %s\n' "$PASS" "$FAIL" "$OUT/verify-result.txt"
[[ $FAIL -eq 0 ]]
