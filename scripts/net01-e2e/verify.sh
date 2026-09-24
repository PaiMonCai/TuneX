#!/usr/bin/env bash
# NET-01 双租户真实网络 E2E —— 验证脚本（可重复）
#
# 场景（全部真实网络：真实 Socket.IO 控制面 + 真实 TCP listener + 真实 TCP 转发，
#       无 mock、无网络打桩）：
#   T1 租户 A agent 只能拿到/监听租户 A 的隧道端口，B 的端口不在其配置内
#   T2 租户 B agent 只能拿到/监听租户 B 的隧道端口，A 的端口不在其配置内
#   T3 跨租户访问被拒绝：A 的会话读 B 的隧道 -> 403/404；B 的组 token 读 A 的隧道 -> 401/403/404
#   T4 配置推送只发给对应租户：patch A 的隧道，B 的 agent 不收到新 config
#   T5 真实转发：经 A 端口 -> A 私有落地回串；经 B 端口 -> B 私有落地回串
#   T6 数据面隔离：A 端口不回 B 的落地标记，反之亦然
#
# 输出：PASS/FAIL 逐项 + 退出码（0 = 全过）；证据落 scripts/net01-e2e/evidence/。
set -uo pipefail

REPO=${REPO:-/opt/TuneX-email-auth}
HERE="$REPO/scripts/net01-e2e"
API=${API:-http://127.0.0.1:8787}
LOG_A=/tmp/net01/tenantA/agent.log
LOG_B=/tmp/net01/tenantB/agent.log
OUT="$HERE/evidence"
mkdir -p "$OUT"

PASS=0; FAIL=0; RESULTS=()
ok()  { PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1"); printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }

# ---- 判定辅助（不用 eval，避免中文括号/斜杠被 shell 误解析） -----------------
assert_eq()     { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 [实得 '$1' 期望 '$2']"; fi; }
assert_ne()     { if [[ -n "$1" && "$1" != "$2" ]]; then ok "$3"; else bad "$3 [实得 '$1']"; fi; }
assert_true()   { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
assert_false()  { if eval "$2" >/dev/null 2>&1; then bad "$1"; else ok "$1"; fi; }
# assert_absent <haystack> <needle> <label> —— 否定断言必须在**值**上做，
# 不要在「进程副作用命令」上做：否则一次运行里先 PASS 的检查就会污染后续结果。
assert_absent()   { if [[ "$1" != *"$2"* ]]; then ok "$3"; else bad "$3 [不应含 '$2']"; fi; }
assert_present()  { if [[ "$1" == *"$2"* ]]; then ok "$3"; else bad "$3 [未含 '$2']"; fi; }
assert_nonempty(){ if [[ -n "$1" ]]; then ok "$2"; else bad "$2 [为空]"; fi; }
assert_contains(){ if [[ "$1" == *"$2"* ]]; then ok "$3"; else bad "$3 [未命中 '$2']"; fi; }
assert_not_contains(){ if [[ "$1" != *"$2"* ]]; then ok "$3"; else bad "$3 [不应含 '$2']"; fi; }
assert_ge()     { if [[ "${1:-0}" -ge "$2" ]] 2>/dev/null; then ok "$3"; else bad "$3 [实得 $1 需 >= $2]"; fi; }
assert_status_in() { # <actual> <allowed...> "label"
  local actual="$1"; shift; local label="${!#}"; local allowed=("${@:1:$#-1}")
  local a; for a in "${allowed[@]}"; do
    [[ "$actual" == "$a" ]] && { ok "$label [实得 $actual]"; return; }
  done
  bad "$label [实得 $actual 期望 ${allowed[*]}]"
}
# state <tenant> <field>
state() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d[sys.argv[2]][sys.argv[3]])" "$HERE/state.json" "$1" "$2"; }
mysqlc() { docker exec net01-mysql mysql -uroot -p"$(grep MYSQL_ROOT_PASSWORD "$HERE/.env.net01" | cut -d= -f2)" \
           tunex -N -e "$1" 2>/dev/null | tail -1; }

WA=$(state tenantA listenPort); PA=39001
WB=$(state tenantB listenPort); PB=39002
TOKA=$(state tenantA token); TOKB=$(state tenantB token)
GA=$(state tenantA groupId);  GB=$(state tenantB groupId)
TA=$(state tenantA tunnelId); TB=$(state tenantB tunnelId)
WSA=$(state tenantA workspaceId); WSB=$(state tenantB workspaceId)

echo "=================================================================="
echo " NET-01 双租户真实网络 E2E"
echo " A: workspace=$WSA group=$GA tunnel=$TA listen=$WA forward=127.0.0.1:$PA token=${TOKA:0:8}..."
echo " B: workspace=$WSB group=$GB tunnel=$TB listen=$WB forward=127.0.0.1:$PB token=${TOKB:0:8}..."
echo "=================================================================="

pgrep -f "tunex-agent-net01 -s" >/dev/null || { echo "agent 进程不在，先跑 start-agents.sh" >&2; exit 2; }

# ---------------------------------------------------------------- 私有转发落地
# 两个租户各自的真实 TCP 服务（非 mock：收发真实字节，回带端口标记用于判定串台）。
python3 - "$PA" "$PB" > "$OUT/echo-targets.log" 2>&1 <<'PY' &
import socket, sys, threading
pa, pb = int(sys.argv[1]), int(sys.argv[2])
def serve(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port)); s.listen(16)
    while True:
        c, _ = s.accept()
        try: c.sendall(b"TARGET-" + str(port).encode())
        finally: c.close()
threading.Thread(target=serve, args=(pa,), daemon=True).start()
serve(pb)
PY
ECHO_PID=$!
sleep 1

# tcp_probe <port> -> 收到字节（空 = 探不到）
tcp_probe() {
  timeout 4 python3 - "$1" <<'PY'
import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=3)
    s.settimeout(3)
    data = s.recv(128)
    s.close()
    sys.stdout.write(data.decode(errors="replace").strip())
    sys.stdout.write("\n")
except Exception:
    print("")
PY
}

# ---------------------------------------------------------------- T1 租户 A 隔离
# 以「内核真实监听表」为证据源，但**必须按 PID 过滤**：
# 两个 agent 跑在同一宿主机，host 级端口表天然同时含 20001 与 21001（各自合法），
# 隔离的判定单位是「哪个进程持有哪个端口」，所以用 ss -p 的 pid/ 字段切分。
PID_A=$(cat /tmp/net01/tenantA/agent.pid 2>/dev/null || pgrep -f "NET01-A-NODE" | head -1)
PID_B=$(cat /tmp/net01/tenantB/agent.pid 2>/dev/null || pgrep -f "NET01-B-NODE" | head -1)
assert_nonempty "$PID_A" "T1a0 租户 A agent 存活（pid=$PID_A）"
assert_nonempty "$PID_B" "T2a0 租户 B agent 存活（pid=$PID_B）"
# 附加：进程命令行里带各自 token 前缀，证明两个进程确实是两个租户
CMD_A=$(tr '\0' ' ' < "/proc/$PID_A/cmdline" 2>/dev/null || true)
CMD_B=$(tr '\0' ' ' < "/proc/$PID_B/cmdline" 2>/dev/null || true)
assert_present   "$CMD_A" "-n NET01-A-NODE" "T1a2 进程 $PID_A 是租户 A 节点（cmdline 核验）"
assert_present   "$CMD_B" "-n NET01-B-NODE" "T2a2 进程 $PID_B 是租户 B 节点（cmdline 核验）"
assert_absent    "$CMD_A" "${TOKB:0:8}" "T1a3 租户 A 进程未持 B 的 token"
assert_absent    "$CMD_B" "${TOKA:0:8}" "T2a3 租户 B 进程未持 A 的 token"
SOCK_A=$(ss -ltnup 2>/dev/null | grep "pid=$PID_A," || true)
SOCK_B=$(ss -ltnup 2>/dev/null | grep "pid=$PID_B," || true)
echo "--- 租户 A 持有的监听（真实 ss，按 pid=$PID_A 过滤）:"; echo "$SOCK_A" | sed 's/^[[:space:]]*/    /'
echo "--- 租户 B 持有的监听（真实 ss，按 pid=$PID_B 过滤）:"; echo "$SOCK_B" | sed 's/^[[:space:]]*/    /'
assert_present   "$SOCK_A" ":$WA " "T1a 租户 A agent 独占监听 A 隧道端口 $WA"
assert_absent    "$SOCK_A" ":$WB " "T1b 租户 A agent 未持有 B 隧道端口 $WB"
assert_present   "$SOCK_B" ":$WB " "T2a 租户 B agent 独占监听 B 隧道端口 $WB"
assert_absent    "$SOCK_B" ":$WA " "T2b 租户 B agent 未持有 A 隧道端口 $WA"
assert_eq     "$(mysqlc "SELECT id FROM node_group WHERE token='$TOKA';")" "$GA" "T1c tenantA token 在控制面解析到组 $GA"
assert_eq     "$(mysqlc "SELECT workspace_id FROM node_group WHERE id=$GA;")" "$WSA" "T1d 入口组 $GA 归属 workspace $WSA"
assert_eq     "$(mysqlc "SELECT COUNT(*) FROM node WHERE node_group_id=$GA;")" "1" "T1e 租户 A 组节点数=1"
assert_not_contains "$(cat "$LOG_A" 2>/dev/null)" ":$WB " "T1f 租户 A agent 日志未出现 B 端口 $WB"

# ---------------------------------------------------------------- T2 租户 B 隔离
assert_eq     "$(mysqlc "SELECT id FROM node_group WHERE token='$TOKB';")" "$GB" "T2c tenantB token 在控制面解析到组 $GB"
assert_eq     "$(mysqlc "SELECT workspace_id FROM node_group WHERE id=$GB;")" "$WSB" "T2d 入口组 $GB 归属 workspace $WSB"
assert_eq     "$(mysqlc "SELECT COUNT(*) FROM node WHERE node_group_id=$GB;")" "1" "T2e 租户 B 组节点数=1"
assert_not_contains "$(cat "$LOG_B" 2>/dev/null)" ":$WA " "T2f 租户 B agent 日志未出现 A 端口 $WA"

# ---------------------------------------------------------------- T3 跨租户访问被拒绝
A_COOKIE=$(python3 - "$HERE" "$API" <<'PY'
import json, os, sys, urllib.request, urllib.error
here, api = sys.argv[1], sys.argv[2]
for line in open(f"{here}/.passwords.env"):
    k, _, v = line.strip().partition("=")
    if k: os.environ[k] = v
def post(path, body, cookie=None):
    r = urllib.request.Request(api + path, data=json.dumps(body).encode(), method="POST",
                               headers={"content-type": "application/json", **({"cookie": cookie} if cookie else {})})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}"), resp.headers.get("set-cookie")
    except urllib.error.HTTPError as e:
        return e.code, (lambda b: (json.loads(b) if b.strip() else {}))(e.read().decode()), e.headers.get("set-cookie")
st, body, sc = post("/api/auth/login", {"email": os.environ["EMAIL_A"], "password": os.environ["PW_A"]})
assert st == 200, body
print(sc.split(";")[0])
PY
)
cross_get() { # <tunnelId> <workspaceId> -> http status（带 workspace 作用域头）
  curl -s -o /dev/null -w '%{http_code}' -m 10 -H "cookie: $A_COOKIE" \
       -H "x-workspace-id: $2" "$API/api/tunnels/$1"
}
assert_status_in "$(cross_get "$TB" "$WSB")" 403 404 "T3a 租户 A 会话读租户 B 隧道 $TB 被拒"
assert_eq         "$(cross_get "$TA" "$WSA")" 200   "T3b 租户 A 会话在 own workspace 读自己的隧道 $TA 通过（对照）"

# 组 token 是节点组级密钥，不是用户凭证：不能拿来读 HTTP 业务资源
ST_B_TOKEN=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "authorization: Bearer $TOKB" "$API/api/tunnels/$TA")
assert_status_in "$ST_B_TOKEN" 401 403 404 "T3c 租户 B 的组 token 读租户 A 隧道被拒"

# 跨租户建隧道：tenantA 的会话用 B 的入口组 id 建隧道 -> 必须 403
CROSS_CREATE=$(curl -s -o "$OUT/t3-cross-create.json" -w '%{http_code}' -m 10 -X POST \
  -H "cookie: $A_COOKIE" -H "x-workspace-id: $WSA" -H 'content-type: application/json' \
  -d "{\"name\":\"cross-illegal\",\"in_node_group_id\":$GB,\"tunnel_type\":\"tcp\",\"listen_port\":21099,\"forward_addresses\":[\"127.0.0.1:39999\"]}" \
  "$API/api/tunnels")
assert_status_in "$CROSS_CREATE" 400 403 404 "T3d 租户 A 会话用租户 B 入口组建隧道被拒"

# ---------------------------------------------------------------- T4 配置推送只发给对应租户
B_BEFORE=$(grep -c "config applied" "$LOG_B" 2>/dev/null || echo 0)
curl -fsS -m 10 -X PATCH -H "cookie: $A_COOKIE" -H "x-workspace-id: $WSA" \
  -H 'content-type: application/json' -d '{"name":"A-tunnel"}' "$API/api/tunnels/$TA" \
  > "$OUT/t4-patch-a.json" 2>&1
sleep 5
B_AFTER=$(grep -c "config applied" "$LOG_B" 2>/dev/null || echo 0)
assert_eq "$B_BEFORE" "$B_AFTER" "T4a 仅 patch 租户 A 隧道，租户 B agent 未收到新 config"
A_APPLIES=$(grep -c "config applied" "$LOG_A" 2>/dev/null || echo 0)
assert_ge "$A_APPLIES" 1 "T4b 租户 A agent 已应用配置（$A_APPLIES 次）"

FIELDS=$(docker exec net01-redis redis-cli HKEYS node_group:config_hash 2>/dev/null | tr -d '\r' | sort | tr '\n' ',')
assert_contains "$FIELDS" "$GA," "T4c Redis 配置指纹含 A 组 field $GA"
assert_contains "$FIELDS" "$GB," "T4d Redis 配置指纹含 B 组 field $GB"
assert_eq "$(mysqlc "SELECT COUNT(*) FROM tunnel WHERE workspace_id=$WSA;")" "1" "T4e workspace $WSA 只有 1 条隧道"
assert_eq "$(mysqlc "SELECT COUNT(*) FROM tunnel WHERE workspace_id=$WSB;")" "1" "T4f workspace $WSB 只有 1 条隧道"
assert_eq "$(mysqlc "SELECT COUNT(*) FROM tunnel WHERE id=$TA AND workspace_id=$WSA;")" "1" "T4g 隧道 $TA 归属 A（无跨租户混放）"
assert_eq "$(mysqlc "SELECT COUNT(*) FROM tunnel WHERE id=$TB AND workspace_id=$WSB;")" "1" "T4h 隧道 $TB 归属 B（无跨租户混放）"

# ---------------------------------------------------------------- T5 真实转发
GOT_A=$(tcp_probe "$WA" | tr -d '\r\n')
GOT_B=$(tcp_probe "$WB" | tr -d '\r\n')
assert_eq "$GOT_A" "TARGET-$PA" "T5a 经租户 A 端口 $WA 转发到 A 私有落地 127.0.0.1:$PA"
assert_eq "$GOT_B" "TARGET-$PB" "T5b 经租户 B 端口 $WB 转发到 B 私有落地 127.0.0.1:$PB"

# ---------------------------------------------------------------- T6 数据面隔离
assert_ne "$GOT_A" "TARGET-$PB" "T6a A 端口不回 B 的落地标记（数据面无串台）"
assert_ne "$GOT_B" "TARGET-$PA" "T6b B 端口不回 A 的落地标记（数据面无串台）"

# ---------------------------------------------------------------- 证据沉淀
grep -E "listening|config applied" "$LOG_A" > "$OUT/tenantA-services.txt" 2>/dev/null || true
grep -E "listening|config applied" "$LOG_B" > "$OUT/tenantB-services.txt" 2>/dev/null || true
assert_not_contains "$(cat "$OUT/tenantA-services.txt" 2>/dev/null)" ":$WB " "T6c 租户 A 实际服务清单无 B 端口"
assert_not_contains "$(cat "$OUT/tenantB-services.txt" 2>/dev/null)" ":$WA " "T6d 租户 B 实际服务清单无 A 端口"

kill $ECHO_PID 2>/dev/null || true
{
  echo "# NET-01 双租户 E2E 验证证据"
  echo "时间: $(date -Is)"
  echo "A: workspace=$WSA group=$GA tunnel=$TA listen=$WA token=${TOKA:0:8}..."
  echo "B: workspace=$WSB group=$GB tunnel=$TB listen=$WB token=${TOKB:0:8}..."
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "总计: PASS=$PASS FAIL=$FAIL"
} > "$OUT/verify-result.txt"

echo "------------------------------------------------------------------"
printf '总计: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m  证据: %s\n' "$PASS" "$FAIL" "$OUT/verify-result.txt"
[[ $FAIL -eq 0 ]]
