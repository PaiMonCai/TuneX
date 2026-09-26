#!/usr/bin/env bash
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"; ENVF="$HERE/.env.wp14"; PASSF="$HERE/.passwords.env"; STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}; OUT="$HERE/evidence"; TOP="$OUT/f1-topology"; mkdir -p "$TOP"
PASS=0; FAIL=0; RESULTS=()
ok(){ PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1"); printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }
eq(){ [[ "$1" == "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 期望 '$2']"; }
nonempty(){ [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
log(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
[[ -f "$STATE" && -f "$ENVF" && -f "$PASSF" ]] || exit 2
set -a; . "$ENVF"; . "$PASSF"; set +a
st(){ python3 - "$STATE" "$@" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2:]: d=d[k]
print("" if d is None else d)
PY
}
mysqlc(){ docker exec wp14-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "$0"' "$1" 2>/dev/null | tail -1 | tr -d '\r'; }
probe(){ docker exec wp14-client sh -c "nc -w 4 '$1' '$2' </dev/null" 2>/dev/null | tr -d '\r\n' || true; }
wait_probe(){ local got=""; for _ in $(seq 1 45); do got=$(probe "$1" "$2"); [[ "$got" == "$3" ]] && { printf '%s' "$got"; return 0; }; sleep 1; done; printf '%s' "$got"; return 1; }
wait_dead(){ for _ in $(seq 1 30); do [[ -z "$(probe "$1" "$2")" ]] && return 0; sleep 1; done; return 1; }
resource_count(){ mysqlc "SELECT COUNT(*) FROM node_state_report WHERE node_id=$1 AND JSON_SEARCH(tunnels,'one','$2') IS NOT NULL;"; }
wait_resource(){ local got=""; for _ in $(seq 1 45); do got=$(resource_count "$1" "$2"); [[ "$3" == present && "${got:-0}" -gt 0 ]] && return 0; [[ "$3" == absent && "${got:-0}" -eq 0 ]] && return 0; sleep 1; done; return 1; }
wait_done(){ local p="" a="" c=""; for _ in $(seq 1 120); do p=$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$1 ORDER BY id DESC LIMIT 1;"); a=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;"); c=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;"); [[ "$p" == done && "$a" == "$1" && "$c" == "$1" ]] && return 0; [[ "$p" == failed || "$p" == degraded ]] && return 1; sleep 1; done; return 1; }
j(){ python3 - "$TOP/$1" "$2" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else d)
PY
}
PRI_WS=$(st workspaces primary id); ING_A=$(st nodes ingress id); EG_A=$(st nodes egress id); ING_B=$(st nodes ingress_secondary id); EG_B=$(st nodes egress_secondary id)
PORT=21020; NAME=v4-f1-topology; MARK=WP14-TARGET-A; HOST_A=172.31.10.20; HOST_B=172.31.10.21
LOGIN=$(python3 - "$STATE" "$PASSF" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); p=''
for line in open(sys.argv[2]):
  if line.startswith('WP14_USER_PASSWORD='): p=line.split('=',1)[1].strip().strip("'")
print(json.dumps({'email':d['user']['email'],'password':p}))
PY
)
curl -sS -m 15 -D "$TOP/login.headers" -o "$TOP/login.json" -X POST "$API/api/auth/login" -H 'content-type: application/json' -H 'x-requested-with: XMLHttpRequest' -d "$LOGIN" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$TOP/login.headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1); nonempty "$COOKIE" "F1.1 登录成功"
api_patch(){ curl -sS -m 120 -o "$TOP/$2" -w '%{http_code}' -X PATCH "$API/api/forwards/$FORWARD_ID" -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json' -d "$1" || echo 000; }
OLD=$(curl -sS "$API/api/nodes/$ING_A/forwards" -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" -H 'x-requested-with: XMLHttpRequest' | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('data',d) or [];print(next((x['id'] for x in r if x.get('name')=='$NAME'),''))" 2>/dev/null || true)
[[ -n "$OLD" ]] && curl -sS -m 60 -X DELETE "$API/api/forwards/$OLD" -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" -H 'x-requested-with: XMLHttpRequest' >/dev/null && sleep 2
log "DIRECT baseline"
CS=$(curl -sS -m 90 -o "$TOP/create.json" -w '%{http_code}' -X POST "$API/api/nodes/$ING_A/forwards" -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json' -d "{\"name\":\"$NAME\",\"listen_port\":$PORT,\"target_host\":\"target-a\",\"target_port\":3030}" || echo 000)
eq "$CS" 201 "F1.2 DIRECT 基线创建"; FORWARD_ID=$(j create.json data.id); REV=$(j create.json data.config_revision); nonempty "$FORWARD_ID" "F1.3 Forward id 返回"; eq "$(wait_probe "$HOST_A" "$PORT" "$MARK" || true)" "$MARK" "F1.4 DIRECT 数据面"
log "DIRECT -> RELAY"
S=$(api_patch "{\"mode\":\"relay\",\"egress_node_id\":$EG_A,\"target_host\":\"target-a\",\"target_port\":3030,\"expected_revision\":$REV}" t1.json); eq "$S" 200 "F1.5 DIRECT→RELAY PATCH"; R1=$(j t1.json data.config_revision); wait_done "$R1" && ok "F1.6 DIRECT→RELAY 收敛" || bad "F1.6 DIRECT→RELAY 未收敛"; eq "$(mysqlc "SELECT tunnel_mode FROM tunnel WHERE id=$FORWARD_ID;")" relay "F1.7 mode=relay"; eq "$(mysqlc "SELECT IFNULL(egress_node_id,0) FROM tunnel WHERE id=$FORWARD_ID;")" "$EG_A" "F1.8 Egress A 生效"; eq "$(wait_probe "$HOST_A" "$PORT" "$MARK" || true)" "$MARK" "F1.9 RELAY 数据面"
RID="tunex-$FORWARD_ID-egress"; wait_resource "$EG_A" "$RID" present && ok "F1.10 Egress A runtime 出现" || bad "F1.10 Egress A runtime 未出现"
log "RELAY egress A -> B"
S=$(api_patch "{\"egress_node_id\":$EG_B,\"expected_revision\":$R1}" t2.json); eq "$S" 200 "F1.11 Egress migration PATCH"; R2=$(j t2.json data.config_revision); wait_done "$R2" && ok "F1.12 Egress migration 收敛" || bad "F1.12 Egress migration 未收敛"; eq "$(mysqlc "SELECT IFNULL(egress_node_id,0) FROM tunnel WHERE id=$FORWARD_ID;")" "$EG_B" "F1.13 Egress B 生效"; eq "$(wait_probe "$HOST_A" "$PORT" "$MARK" || true)" "$MARK" "F1.14 换 Egress 后数据面"; wait_resource "$EG_B" "$RID" present && ok "F1.15 Egress B runtime 出现" || bad "F1.15 Egress B runtime 未出现"; wait_resource "$EG_A" "$RID" absent && ok "F1.16 Egress A runtime 清理" || bad "F1.16 Egress A runtime 未清理"; eq "$(mysqlc "SELECT COUNT(*) FROM node_binding WHERE ingress_node_id=$ING_A AND egress_node_id=$EG_B;")" 1 "F1.17 新 Binding 建立"
log "RELAY -> DIRECT"
S=$(api_patch "{\"mode\":\"direct\",\"egress_node_id\":null,\"target_host\":\"target-a\",\"target_port\":3030,\"expected_revision\":$R2}" t3.json); eq "$S" 200 "F1.18 RELAY→DIRECT PATCH"; R3=$(j t3.json data.config_revision); wait_done "$R3" && ok "F1.19 RELAY→DIRECT 收敛" || bad "F1.19 RELAY→DIRECT 未收敛"; eq "$(mysqlc "SELECT tunnel_mode FROM tunnel WHERE id=$FORWARD_ID;")" direct "F1.20 mode=direct"; eq "$(mysqlc "SELECT IFNULL(egress_node_id,0) FROM tunnel WHERE id=$FORWARD_ID;")" 0 "F1.21 egress 清空"; eq "$(wait_probe "$HOST_A" "$PORT" "$MARK" || true)" "$MARK" "F1.22 DIRECT 数据面恢复"; wait_resource "$EG_B" "$RID" absent && ok "F1.23 Egress B runtime 已撤" || bad "F1.23 Egress B runtime 未撤"
log "Ingress A -> B"
S=$(api_patch "{\"ingress_node_id\":$ING_B,\"expected_revision\":$R3}" t4.json); eq "$S" 200 "F1.24 Ingress migration PATCH"; R4=$(j t4.json data.config_revision); wait_done "$R4" && ok "F1.25 Ingress migration 收敛" || bad "F1.25 Ingress migration 未收敛"; eq "$(mysqlc "SELECT IFNULL(ingress_node_id,0) FROM tunnel WHERE id=$FORWARD_ID;")" "$ING_B" "F1.26 Ingress B 生效"; eq "$(wait_probe "$HOST_B" "$PORT" "$MARK" || true)" "$MARK" "F1.27 新 Ingress B 数据面"; wait_dead "$HOST_A" "$PORT" && ok "F1.28 旧 Ingress A 已退场" || bad "F1.28 旧 Ingress A 仍监听"; eq "$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND node_id=$ING_B AND port=$PORT AND status='active';")" 1 "F1.29 新 Ingress lease 唯一"; eq "$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND node_id=$ING_A AND status='active';")" 0 "F1.30 旧 Ingress lease 已释放"; eq "$(mysqlc "SELECT CONCAT(applied_revision,'|',config_revision,'|',apply_status) FROM tunnel WHERE id=$FORWARD_ID;")" "$R4|$R4|active" "F1.31 最终 ledger 收敛"
{ echo "# V4-F1 topology closure"; echo "time: $(date -Is)"; echo "forward=$FORWARD_ID revisions=$REV,$R1,$R2,$R3,$R4"; printf '%s\n' "${RESULTS[@]}"; echo "TOTAL PASS=$PASS FAIL=$FAIL"; } >"$OUT/v4-gate-topology-result.txt"
printf 'V4-F1-TOPOLOGY TOTAL: PASS=%d FAIL=%d evidence=%s\n' "$PASS" "$FAIL" "$OUT/v4-gate-topology-result.txt"
[[ "$FAIL" -eq 0 ]]
