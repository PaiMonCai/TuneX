#!/usr/bin/env bash
# TuneX v3 real integration gate.
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
ENVF="$HERE/.env.wp14"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}
OUT="$HERE/evidence"
mkdir -p "$OUT"

PASS=0
FAIL=0
RESULTS=()
ok()  { PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1"); printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }
assert_eq() { [[ "$1" == "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 期望 '$2']"; }
assert_ne() { [[ -n "$1" && "$1" != "$2" ]] && ok "$3" || bad "$3 [实得 '$1']"; }
assert_ge() { [[ "${1:-0}" =~ ^[0-9]+$ && "${1:-0}" -ge "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 需 >= $2]"; }
assert_empty() { [[ -z "$1" ]] && ok "$2" || bad "$2 [实得 '$1']"; }
assert_nonempty() { [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && ok "$3" || bad "$3 [不应含 '$2']"; }
assert_status_in() {
  local actual="$1"; shift
  local label="${!#}"
  local allowed=("${@:1:$#-1}") a
  for a in "${allowed[@]}"; do
    if [[ "$actual" == "$a" ]]; then ok "$label [实得 $actual]"; return; fi
  done
  bad "$label [实得 $actual 期望 ${allowed[*]}]"
}

[[ -f "$STATE" ]] || { echo "missing $STATE; run setup.sh first" >&2; exit 2; }

state() {
  python3 - "$STATE" "$@" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2:-1]:
    d = d[k]
v = d[sys.argv[-1]]
if v is None:
    print("")
elif isinstance(v, (dict, list)):
    print(json.dumps(v, separators=(",", ":")))
else:
    print(v)
PY
}

mysqlc() {
  set -a; . "$ENVF"; set +a
  docker exec wp14-mysql sh -c     'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "$0"' "$1" 2>/dev/null | tail -1
}

probe() {
  local port="$1"
  docker exec wp14-client sh -c "nc -w 4 172.31.10.20 '$port' </dev/null" 2>/dev/null     | tr -d '\r\n' || true
}

wait_probe() {
  local port="$1" want="$2" got=""
  for _ in $(seq 1 30); do
    got=$(probe "$port")
    [[ "$got" == "$want" ]] && { printf '%s' "$got"; return 0; }
    sleep 1
  done
  printf '%s' "$got"
  return 1
}

http_mutate() {
  local method="$1" path="$2" cookie="$3" ws="$4"
  curl -sS -m 30 -X "$method"     -H "cookie: $cookie"     -H "x-workspace-id: $ws"     -H "x-requested-with: XMLHttpRequest"     -H "content-type: application/json"     "$API$path"
}

DIRECT_ID=$(state tunnels direct id)
DIRECT_PORT=$(state tunnels direct listen_port)
RELAY_ID=$(state tunnels relay id)
RELAY_PORT=$(state tunnels relay listen_port)
RELAY_EGRESS_PORT=$(state tunnels relay egress_port)
INGRESS_NODE=$(state nodes ingress id)
EGRESS_NODE=$(state nodes egress id)
INGRESS_CRED=$(state nodes ingress credential)
MARK_A=$(state markers target_a)
MARK_B=$(state markers target_b)
PRI_WS=$(state workspaces primary id)
FOREIGN_WS=$(state workspaces isolation id)
FOREIGN_GROUP=$(state nodeGroups foreign-ingress id)

echo "=================================================================="
echo " TuneX v3 Integration Gate"
echo " DIRECT tunnel=$DIRECT_ID : 172.31.10.20:$DIRECT_PORT -> target-a"
echo " RELAY  tunnel=$RELAY_ID  : 172.31.10.20:$RELAY_PORT -> 172.31.20.20:$RELAY_EGRESS_PORT -> target-b"
echo "=================================================================="

# ---------------------------------------------------------------- T0 topology
for c in wp14-panel wp14-worker wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client; do
  running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
  assert_eq "$running" "true" "T0 $c 运行中"
done
assert_eq "$(docker inspect -f '{{.State.Health.Status}}' wp14-panel 2>/dev/null || echo none)" "healthy" "T0 panel healthy"

# ---------------------------------------------------------------- T1 outbound-only control
for c in wp14-ingress-agent wp14-egress-agent; do
  ports=$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || echo '{}')
  [[ "$ports" == "{}" || "$ports" == "null" ]] && ok "T1 $c 无 host 端口映射" || bad "T1 $c 暴露 host 端口: $ports"
  logs=$(docker logs "$c" 2>&1 || true)
  assert_not_contains "$logs" "v3 admin api listening" "T1 $c 未启动入站 admin API"
done
PANEL_NETS=$(docker inspect wp14-panel --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)
assert_not_contains "$PANEL_NETS" "wp14_ingress_data" "T1 Panel 不接入口数据网"
assert_not_contains "$PANEL_NETS" "wp14_egress_data" "T1 Panel 不接出口数据网"
assert_eq "$(docker network inspect wp14_ingress_data --format '{{.Internal}}')" "true" "T1 ingress data network internal"
assert_eq "$(docker network inspect wp14_egress_data --format '{{.Internal}}')" "true" "T1 egress data network internal"

# ---------------------------------------------------------------- T2 concrete DB state
DIRECT_ROW=$(mysqlc "SELECT CONCAT(IFNULL(ingress_node_id,0),'|',IFNULL(egress_node_id,0),'|',apply_status,'|',IFNULL(config_revision,0),'|',IFNULL(applied_revision,0)) FROM tunnel WHERE id=$DIRECT_ID;")
IFS='|' read -r D_IN D_OUT D_STATUS D_CFG D_APPLIED <<<"$DIRECT_ROW"
assert_eq "$D_IN" "$INGRESS_NODE" "T2 DIRECT 持久化 concrete ingress_node_id"
assert_eq "$D_OUT" "0" "T2 DIRECT 无 egress_node_id"
assert_eq "$D_STATUS" "active" "T2 DIRECT apply_status=active"
assert_eq "$D_CFG" "$D_APPLIED" "T2 DIRECT config_revision 已被 ACK"

RELAY_ROW=$(mysqlc "SELECT CONCAT(IFNULL(ingress_node_id,0),'|',IFNULL(egress_node_id,0),'|',IFNULL(egress_port,0),'|',apply_status,'|',IFNULL(config_revision,0),'|',IFNULL(applied_revision,0)) FROM tunnel WHERE id=$RELAY_ID;")
IFS='|' read -r R_IN R_OUT R_PORT R_STATUS R_CFG R_APPLIED <<<"$RELAY_ROW"
assert_eq "$R_IN" "$INGRESS_NODE" "T2 RELAY 持久化 concrete ingress_node_id"
assert_eq "$R_OUT" "$EGRESS_NODE" "T2 RELAY 持久化 concrete egress_node_id"
assert_eq "$R_PORT" "$RELAY_EGRESS_PORT" "T2 RELAY 持久化 egress_port"
assert_eq "$R_STATUS" "active" "T2 RELAY apply_status=active"
assert_eq "$R_CFG" "$R_APPLIED" "T2 RELAY config_revision 已被双端 ACK"

LEASE_COUNT=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id IN ($DIRECT_ID,$RELAY_ID) AND status='active';")
assert_eq "$LEASE_COUNT" "3" "T2 DIRECT 1 + RELAY 2 个 active NodePortLease"
DUP_COUNT=$(mysqlc "SELECT COUNT(*) FROM (SELECT node_id,port,COUNT(*) c FROM node_port_lease WHERE status='active' GROUP BY node_id,port HAVING c>1) x;")
assert_eq "$DUP_COUNT" "0" "T2 同一物理 Node 端口无重复 active owner"

# ---------------------------------------------------------------- T3 real data plane
GOT_A=$(wait_probe "$DIRECT_PORT" "$MARK_A" || true)
assert_eq "$GOT_A" "$MARK_A" "T3 DIRECT client -> ingress -> target-a"
GOT_B=$(wait_probe "$RELAY_PORT" "$MARK_B" || true)
assert_eq "$GOT_B" "$MARK_B" "T3 RELAY client -> ingress -> egress -> target-b"
assert_ne "$GOT_A" "$MARK_B" "T3 DIRECT 不串到 target-b"
assert_ne "$GOT_B" "$MARK_A" "T3 RELAY 不串到 target-a"

# ---------------------------------------------------------------- login for user actions
LOGIN_PAYLOAD=$(python3 - "$STATE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps(d["user"]))
PY
)
curl -sS -m 15 -D "$OUT/login.headers" -o "$OUT/login.json"   -X POST "$API/api/auth/login"   -H 'content-type: application/json'   -H 'x-requested-with: XMLHttpRequest'   -d "$LOGIN_PAYLOAD" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$OUT/login.headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
assert_nonempty "$COOKIE" "T4 用户会话登录成功"

# ---------------------------------------------------------------- T4 suspend / resume = real runtime stop/start
SUSPEND_STATUS=$(curl -sS -m 30 -o "$OUT/direct-suspend.json" -w '%{http_code}'   -X POST "$API/api/tunnels/v3/$DIRECT_ID/suspend"   -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS"   -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json')
assert_eq "$SUSPEND_STATUS" "200" "T4 DIRECT suspend API 成功"
sleep 1
assert_empty "$(probe "$DIRECT_PORT")" "T4 suspend 后 DIRECT listener 已停止"
LEASE_AFTER_SUSPEND=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$DIRECT_ID AND status='active';")
assert_eq "$LEASE_AFTER_SUSPEND" "1" "T4 suspend 保留 durable port lease"

RESUME_STATUS=$(curl -sS -m 45 -o "$OUT/direct-resume.json" -w '%{http_code}'   -X POST "$API/api/tunnels/v3/$DIRECT_ID/resume"   -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS"   -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json')
assert_eq "$RESUME_STATUS" "200" "T4 DIRECT resume API 成功"
GOT_AFTER_RESUME=$(wait_probe "$DIRECT_PORT" "$MARK_A" || true)
assert_eq "$GOT_AFTER_RESUME" "$MARK_A" "T4 resume 原端口恢复 DIRECT"
LEASE_PORT=$(mysqlc "SELECT port FROM node_port_lease WHERE tunnel_id=$DIRECT_ID AND status='active' LIMIT 1;")
assert_eq "$LEASE_PORT" "$DIRECT_PORT" "T4 resume 沿用原 NodePortLease"

# ---------------------------------------------------------------- T5 Agent restart restore
say_restart() { printf '%s\n' "--- restarting $* to prove /desired restore"; }
say_restart wp14-ingress-agent wp14-egress-agent
docker restart wp14-ingress-agent wp14-egress-agent >/dev/null
GOT_RESTART_DIRECT=$(wait_probe "$DIRECT_PORT" "$MARK_A" || true)
GOT_RESTART_RELAY=$(wait_probe "$RELAY_PORT" "$MARK_B" || true)
assert_eq "$GOT_RESTART_DIRECT" "$MARK_A" "T5 ingress Agent 重启后 DIRECT 从 desired snapshot 恢复"
assert_eq "$GOT_RESTART_RELAY" "$MARK_B" "T5 Agent 重启后 RELAY 双端恢复"

# ---------------------------------------------------------------- T6 per-node credential and server-side identity
BAD_STATUS=$(curl -s -m 10 -o "$OUT/bad-credential.json" -w '%{http_code}'   -H 'authorization: Bearer definitely-invalid-node-credential'   "$API/api/internal/node/commands" || echo 000)
assert_eq "$BAD_STATUS" "401" "T6 无效 node credential 被拒"

GOOD_STATUS=$(curl -s -m 10 -o "$OUT/good-credential.json" -w '%{http_code}'   -H "authorization: Bearer $INGRESS_CRED"   "$API/api/internal/node/commands" || echo 000)
assert_eq "$GOOD_STATUS" "200" "T6 ingress per-node credential 可认证"

DESIRED=$(curl -sS -m 10 -H "authorization: Bearer $INGRESS_CRED" "$API/api/internal/node/desired")
assert_not_contains "$DESIRED" "tunex-$RELAY_ID-egress" "T6 ingress credential 看不到 egress runtime"
[[ "$DESIRED" == *"tunex-$DIRECT_ID-direct"* && "$DESIRED" == *"tunex-$RELAY_ID-relay"* ]]   && ok "T6 desired snapshot 只包含绑定到 ingress Node 的 runtime"   || bad "T6 desired snapshot 缺少 ingress runtime: $DESIRED"

# ---------------------------------------------------------------- T7 tenant isolation
assert_ne "$PRI_WS" "$FOREIGN_WS" "T7 primary/isolation workspace 不同"
CROSS_STATUS=$(curl -sS -m 20 -o "$OUT/cross-create.json" -w '%{http_code}'   -X POST "$API/api/tunnels"   -H "cookie: $COOKIE"   -H "x-workspace-id: $PRI_WS"   -H 'x-requested-with: XMLHttpRequest'   -H 'content-type: application/json'   -d "{\"name\":\"cross-illegal\",\"in_node_group_id\":$FOREIGN_GROUP,\"tunnel_type\":\"tcp\",\"listen_port\":21199,\"forward_addresses\":[\"target-b:3030\"]}" || echo 000)
assert_status_in "$CROSS_STATUS" 403 404 "T7 primary workspace 不能使用 isolation NodeGroup"

# ---------------------------------------------------------------- T8 worker/reconciler is actually running
WORKER_RUNNING=$(docker inspect -f '{{.State.Running}}' wp14-worker 2>/dev/null || echo false)
assert_eq "$WORKER_RUNNING" "true" "T8 Reconciler worker 进程运行中"
# The recurring job is registered in BullMQ; observing the job name proves this
# deployment is not merely importing reconciler.ts without scheduling it.
for _ in $(seq 1 40); do
  WLOG=$(docker logs wp14-worker 2>&1 || true)
  [[ "$WLOG" == *"cron_reconcile_v3"* ]] && break
  sleep 1
done
[[ "${WLOG:-}" == *"cron_reconcile_v3"* ]]   && ok "T8 cron_reconcile_v3 已进入生产 worker 调度"   || bad "T8 worker 日志未观察到 cron_reconcile_v3"

# ---------------------------------------------------------------- evidence
{
  echo "# TuneX v3 Integration Gate Evidence"
  echo "time: $(date -Is)"
  echo "DIRECT: tunnel=$DIRECT_ID port=$DIRECT_PORT result=$GOT_RESTART_DIRECT"
  echo "RELAY: tunnel=$RELAY_ID ingress=$RELAY_PORT egress=$RELAY_EGRESS_PORT result=$GOT_RESTART_RELAY"
  echo "bindings: ingress_node=$INGRESS_NODE egress_node=$EGRESS_NODE"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "TOTAL PASS=$PASS FAIL=$FAIL"
} >"$OUT/verify-result.txt"

echo "------------------------------------------------------------------"
printf 'TOTAL: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m evidence=%s\n' "$PASS" "$FAIL" "$OUT/verify-result.txt"
[[ "$FAIL" -eq 0 ]]
