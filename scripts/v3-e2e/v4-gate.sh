#!/usr/bin/env bash
# TuneX V4 Forward rollout integration gate (DEVELOPMENT.md §13.7 / V4-F1).
#
# This is a PROUD addition to the v3 gate: it reuses the exact same isolated
# topology started by setup.sh (MySQL / Redis / Panel / Worker / dual Agents /
# dual Targets, three separated networks). It does not build its own topology,
# does not mock any interface, and does not write business tables directly —
# every input goes through the real HTTP API and every runtime change is a real
# Agent ACK over the outbound control channel.
#
# Slice 1 scenarios:
#   S1  Forward PATCH target host/port hot swap (no listener rebuild)
#   S2  stale expected_revision -> 409 revision_conflict
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
assert_nonempty() { [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
assert_contains() { [[ "$1" == *"$2"* ]] && ok "$3" || bad "$3 [未含 '$2']"; }

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

# ---------------------------------------------------------------- fixtures
FIX="$HERE/fixtures/forward-edit.json"
FORWARD_ID=$(state forward id)
FORWARD_PORT=$(state forward listen_port)
MARK_A=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['marker_before'])")
MARK_B=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['marker_after'])")
SWAP_HOST=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['hot_swap_target_host'])")
SWAP_PORT=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['hot_swap_target_port'])")
PRI_WS=$(state workspaces primary id)

echo "=================================================================="
echo " TuneX V4 Forward Rollout Integration Gate (slice 1)"
echo " Forward tunnel=$FORWARD_ID : 172.31.10.20:$FORWARD_PORT"
echo " S1 target hot swap  -> $SWAP_HOST:$SWAP_PORT (marker $MARK_B)"
echo " S2 stale expected_revision -> 409"
echo "=================================================================="

# ---------------------------------------------------------------- login
LOGIN_PAYLOAD=$(python3 - "$STATE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps(d["user"]))
PY
)
curl -sS -m 15 -D "$OUT/v4-login.headers" -o "$OUT/v4-login.json"   -X POST "$API/api/auth/login"   -H 'content-type: application/json'   -H 'x-requested-with: XMLHttpRequest'   -d "$LOGIN_PAYLOAD" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$OUT/v4-login.headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
assert_nonempty "$COOKIE" "V4 用户会话登录成功"

api_patch() {
  local body="$1" file="$2"
  curl -sS -m 45 -o "$OUT/$file" -w '%{http_code}'     -X PATCH "$API/api/forwards/$FORWARD_ID"     -H "cookie: $COOKIE"     -H "x-workspace-id: $PRI_WS"     -H 'x-requested-with: XMLHttpRequest'     -H 'content-type: application/json'     -d "$body" || echo 000
}

api_get() {
  curl -sS -m 20 "$API/api/forwards/$FORWARD_ID"     -H "cookie: $COOKIE"     -H "x-workspace-id: $PRI_WS"     -H 'x-requested-with: XMLHttpRequest'
}

# ---------------------------------------------------------------- S1: target hot swap
GOT_BEFORE=$(wait_probe "$FORWARD_PORT" "$MARK_A" || true)
assert_eq "$GOT_BEFORE" "$MARK_A" "S1.0 热改前真实数据面读到初始 target marker"

BASELINE_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
BASELINE_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
BASELINE_SNAPSHOTS=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
assert_nonempty "$BASELINE_CFG" "S1.1 基线 config_revision 可读"

S1_STATUS=$(api_patch "{\"target_host\":\"$SWAP_HOST\",\"target_port\":$SWAP_PORT,\"expected_revision\":$BASELINE_CFG}" s1-patch.json)
assert_eq "$S1_STATUS" "200" "S1.2 PATCH target host/port 热改 HTTP 200"

S1_REV=$(python3 -c "import json;d=json.load(open('$OUT/s1-patch.json'));print(d.get('data',{}).get('config_revision'))")
S1_APPLIED=$(python3 -c "import json;d=json.load(open('$OUT/s1-patch.json'));print(d.get('data',{}).get('applied_revision'))")
S1_TARGET_HOST=$(python3 -c "import json;d=json.load(open('$OUT/s1-patch.json'));print(d.get('data',{}).get('target_host'))")
S1_TARGET_PORT=$(python3 -c "import json;d=json.load(open('$OUT/s1-patch.json'));print(d.get('data',{}).get('target_port'))")
assert_eq "$S1_TARGET_HOST" "$SWAP_HOST" "S1.3 Forward 视图 target_host 已更新"
assert_eq "$S1_TARGET_PORT" "$SWAP_PORT" "S1.4 Forward 视图 target_port 已更新"
assert_eq "$S1_APPLIED" "$S1_REV" "S1.5 Agent 已 ACK 新 revision（applied == config）"

GOT_AFTER=$(wait_probe "$FORWARD_PORT" "$MARK_B" || true)
assert_eq "$GOT_AFTER" "$MARK_B" "S1.6 真实数据面已切到新 target marker"
MARKER_LEAK=$(probe "$FORWARD_PORT")
assert_ne "$MARKER_LEAK" "$MARK_A" "S1.7 旧 target marker 不再串出"

S1_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
S1_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
S1_DB_HOST=$(mysqlc "SELECT IFNULL(remote_host,'') FROM tunnel WHERE id=$FORWARD_ID;")
S1_DB_PORT=$(mysqlc "SELECT IFNULL(remote_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S1_DB_CFG" "$S1_REV" "S1.8 DB config_revision 与 API 返回一致"
assert_eq "$S1_DB_APPLIED" "$S1_REV" "S1.9 DB applied_revision 已收敛"
assert_eq "$S1_DB_HOST" "$SWAP_HOST" "S1.10 DB remote_host 已热改"
assert_eq "$S1_DB_PORT" "$SWAP_PORT" "S1.11 DB remote_port 已热改"

S1_SNAPSHOTS=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
assert_eq "$((S1_SNAPSHOTS - BASELINE_SNAPSHOTS))" "1" "S1.12 新 revision snapshot 恰好新增一行"

S1_ROLLOUT=$(mysqlc "SELECT CONCAT(phase,'|',IFNULL(strategy,'')) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$S1_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$S1_ROLLOUT" "done|target_hot_swap" "S1.13 rollout 记录 done / target_hot_swap"

S1_LISTEN=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
S1_LEASES=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
S1_LEASE_PORT=$(mysqlc "SELECT IFNULL(port,0) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active' ORDER BY id DESC LIMIT 1;")
assert_eq "$S1_LISTEN" "$FORWARD_PORT" "S1.14 listener 未重建（listen_port 不变）"
assert_eq "$S1_LEASE_PORT" "$FORWARD_PORT" "S1.15 durable lease 端口不变"
assert_eq "$S1_LEASES" "1" "S1.16 同一 tunnel 仍只有一条 active lease"

# ---------------------------------------------------------------- S2: stale expected_revision -> 409
BASELINE_REV="$S1_REV"
BASELINE_HOST="$SWAP_HOST"
SNAPSHOTS_BEFORE_S2="$S1_SNAPSHOTS"

# First PATCH with the CURRENT revision must succeed (proves 409 is a lock,
# not a dead lock) — it also moves the revision so the stale retry below is
# genuinely stale rather than merely equal.
S2_OK_STATUS=$(api_patch "{\"target_host\":\"target-a\",\"target_port\":3030,\"expected_revision\":$BASELINE_REV}" s2-ok.json)
assert_eq "$S2_OK_STATUS" "200" "S2.1 正确 expected_revision 的 PATCH 成功"
S2_OK_REV=$(python3 -c "import json;d=json.load(open('$OUT/s2-ok.json'));print(d.get('data',{}).get('config_revision'))")
S2_OK_HOST=$(python3 -c "import json;d=json.load(open('$OUT/s2-ok.json'));print(d.get('data',{}).get('target_host'))")
assert_eq "$S2_OK_HOST" "target-a" "S2.2 请求的目标已生效（target_host=target-a）"

GOT_S2=$(wait_probe "$FORWARD_PORT" "$MARK_A" || true)
assert_eq "$GOT_S2" "$MARK_A" "S2.3 真实数据面切回 target-a"

# Now the stale one: the browser tab that never reloaded still thinks the
# revision is BASELINE_REV.
S2_STALE_STATUS=$(api_patch "{\"target_host\":\"target-b\",\"target_port\":3030,\"expected_revision\":$BASELINE_REV}" s2-stale.json)
assert_eq "$S2_STALE_STATUS" "409" "S2.4 过期 expected_revision 被拒 HTTP 409"
S2_STALE_CODE=$(python3 -c "import json;d=json.load(open('$OUT/s2-stale.json'));print(d.get('code'))")
S2_STALE_LATEST=$(python3 -c "import json;d=json.load(open('$OUT/s2-stale.json'));print((d.get('data') or {}).get('latest_revision'))")
assert_eq "$S2_STALE_CODE" "revision_conflict" "S2.5 409 业务码 revision_conflict"
assert_eq "$S2_STALE_LATEST" "$S2_OK_REV" "S2.6 409 带回真实 latest_revision"

S2_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
S2_DB_HOST=$(mysqlc "SELECT IFNULL(remote_host,'') FROM tunnel WHERE id=$FORWARD_ID;")
S2_DB_PORT=$(mysqlc "SELECT IFNULL(remote_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
S2_DB_SNAPSHOTS=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
S2_DB_ROLLOUTS=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$BASELINE_REV;")
assert_eq "$S2_DB_CFG" "$S2_OK_REV" "S2.7 409 不推进 config_revision"
assert_eq "$S2_DB_HOST" "target-a" "S2.8 409 不改变 remote_host"
assert_eq "$S2_DB_PORT" "3030" "S2.9 409 不改变 remote_port"
assert_eq "$((S2_DB_SNAPSHOTS - SNAPSHOTS_BEFORE_S2))" "1" "S2.10 409 不写 revision snapshot"
assert_eq "$S2_DB_ROLLOUTS" "0" "S2.11 过期 revision 未创建 rollout 记账"

GOT_S2_AFTER=$(wait_probe "$FORWARD_PORT" "$MARK_A" || true)
assert_eq "$GOT_S2_AFTER" "$MARK_A" "S2.12 409 之后真实数据面仍走有效目标"

# ---------------------------------------------------------------- evidence
{
  echo "# TuneX V4 Forward Rollout Integration Gate (slice 1) Evidence"
  echo "time: $(date -Is)"
  echo "forward: tunnel=$FORWARD_ID listen_port=$FORWARD_PORT"
  echo "S1: $BASELINE_CFG -> $S1_REV target -> $SWAP_HOST:$SWAP_PORT data_plane=$GOT_AFTER rollout=$S1_ROLLOUT"
  echo "S2: ok_rev=$S2_OK_REV stale_expected=$BASELINE_REV status=409 code=$S2_STALE_CODE latest=$S2_STALE_LATEST data_plane=$GOT_S2_AFTER"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "TOTAL PASS=$PASS FAIL=$FAIL"
} >"$OUT/v4-result.txt"

echo "------------------------------------------------------------------"
printf 'V4 TOTAL: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m evidence=%s\n' "$PASS" "$FAIL" "$OUT/v4-result.txt"
[[ "$FAIL" -eq 0 ]]
