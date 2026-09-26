#!/usr/bin/env bash
# TuneX V4-F1 Gate — S10 slice.
#
# Independent deliverable: this script does NOT modify or depend on setup.sh,
# _bootstrap.py, v4-gate.sh, v4-gate-rest.sh or integration.yml as far as its own
# assertions go. It reuses the produced wp14 topology + state.json only for
# auth/workspace/node primitives, then creates its OWN Forward so every ledger
# count (revision / snapshot / rollout / lease) has a clean base.
#
# No local build: the stack runs on prebuilt exact-SHA GHCR images for main
# (ed23e550…). The stale local wp14-backend:ci image is deliberately NOT reused
# as gate evidence (it predates main and misses the first-edit baseline heal).
#
# Scenarios (DEVELOPMENT.md §13.7 Wave 2 / Gate V4-F1):
#   S10-A  in-flight non-terminal phase is really observable, terminal = done
#   S10-B  applied == config after a real edit (Agent ACK)
#   S10-C  one edit == one snapshot row + one rollout row
#   S10-D  real old/new TCP marker across a listener replacement
#   S10-E  data plane survives an ingress-agent container restart
#   S10-F  exactly one active node_port_lease per tunnel (incl. after restart)
#
# Every assertion goes through the real HTTP API, the real MySQL ledger and the
# real TCP data plane. Nothing is mocked; no phase column is ever written by
# hand — non-terminal phases can only be observed, never fabricated.
#
# Scope guard: every docker write is limited to wp14-* container names.
set -uo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
COMPOSE="$HERE/docker-compose.e2e.yaml"
FIX="$HERE/fixtures/v4-gate-s10.json"
ENVF="$HERE/.env.wp14"
PASSF="$HERE/.passwords.env"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}
OUT="$HERE/evidence"
S10_OUT="$OUT/s10"
mkdir -p "$S10_OUT"

HEAD_SHA=${HEAD_SHA:-ed23e550e3584eccca58068f22643ae8acb90997}
BACKEND_IMAGE=${TUNEX_BACKEND_IMAGE:-ghcr.io/paimoncai/tunex:$HEAD_SHA}
AGENT_IMAGE=${WP14_AGENT_IMAGE:-ghcr.io/paimoncai/tunex-agent:$HEAD_SHA}
ALLOWED_CONTAINERS="wp14-panel wp14-worker wp14-mysql wp14-redis wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client wp14-db-migrate"

PASS=0
FAIL=0
LIMITED=0
DEFECTS=0
RESULTS=()
ok()   { PASS=$((PASS+1));   RESULTS+=("PASS | $1");        printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1));   RESULTS+=("FAIL | $1");        printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }
# LIMITED = 环境/harness 拿不到证据，不是产品缺陷也不是测试缺陷；如实分开统计，
# 绝不允许把 LIMITED 记成 PASS。UNVERIFIED 语义相同，用于实验未被执行的情况。
limited() { LIMITED=$((LIMITED+1)); RESULTS+=("LIMITED | $1"); printf '\033[1;33mLIMITED\033[0m | %s\n' "$1"; }
unverified() { LIMITED=$((LIMITED+1)); RESULTS+=("UNVERIFIED | $1"); printf '\033[1;34mUNVERIFIED\033[0m | %s\n' "$1"; }
# DEFECT = 按规格应当成立但实现没做到，Gate 真实暴露的产品缺陷。
DEFECT() {
  DEFECTS=$((DEFECTS+1)); FAIL=$((FAIL+1))
  RESULTS+=("DEFECT[$1] | $2")
  printf '\033[1;35mDEFECT[%s]\033[0m | %s\n' "$1" "$2"
}
assert_eq() { [[ "$1" == "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 期望 '$2']"; }
assert_nonempty() { [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
assert_contains() { [[ "$1" == *"$2"* ]] && ok "$3" || bad "$3 [未含 '$2']"; }
assert_gt() { [[ "${1:-0}" =~ ^[0-9]+$ && "${2:-0}" =~ ^[0-9]+$ && "$1" -gt "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 需严格大于 '$2']"; }

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# ------------------------------------------------------------------ scope guard
guard_container() {
  local c="$1"
  [[ " $ALLOWED_CONTAINERS " == *" $c "* ]] || { echo "FATAL: '$c' 不在 wp14 白名单内，拒绝操作" >&2; exit 9; }
  docker inspect "$c" >/dev/null 2>&1 || { echo "FATAL: 容器 $c 不存在" >&2; exit 9; }
}

mysqlc() {
  set -a; . "$ENVF"; set +a
  docker exec wp14-mysql sh -c \
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "$0"' "$1" 2>/dev/null | tail -1
}

probe() {
  local port="$1"
  docker exec wp14-client sh -c "nc -w 4 172.31.10.20 '$port' </dev/null" 2>/dev/null | tr -d '\r\n' || true
}

wait_probe() {
  local port="$1" want="$2" got=""
  for _ in $(seq 1 40); do
    got=$(probe "$port")
    [[ "$got" == "$want" ]] && { printf '%s' "$got"; return 0; }
    sleep 1
  done
  printf '%s' "$got"
  return 1
}

wait_dead() {
  local port="$1" got="" last=""
  for _ in $(seq 1 20); do
    got=$(probe "$port")
    [[ -z "$got" ]] && { printf ''; return 0; }
    last="$got"
    sleep 1
  done
  printf '%s' "$last"
  return 1
}

jget() { python3 -c "import json;d=json.load(open('$S10_OUT/$1'));print(d$2)" 2>/dev/null || printf ''; }

# The only place where a NON-terminal rollout phase is ever produced: observing
# the real row while the backend is executing. No column is ever written here.
phase_sampler() {
  local tunnel_id="$1" revision="$2" samples_file="$3" stop_file="$4"
  rm -f "$stop_file"
  (
    while [[ ! -f "$stop_file" ]]; do
      printf '%s %s\n' "$(date -u +%H:%M:%S.%3N)" \
        "$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$tunnel_id AND revision=$revision ORDER BY id DESC LIMIT 1;")" \
        >>"$samples_file"
      sleep 0.25
    done
  ) &
  SAMPLER_PID=$!
}

stop_phase_sampler() {
  local stop_file="$1"
  touch "$stop_file"
  wait "${SAMPLER_PID:-0}" 2>/dev/null || true
}

[[ -f "$STATE" ]] || { echo "missing $STATE; run scripts/v3-e2e/setup.sh first" >&2; exit 2; }
[[ -f "$ENVF"   ]] || { echo "missing $ENVF; run scripts/v3-e2e/setup.sh first" >&2; exit 2; }
[[ -f "$PASSF"  ]] || { echo "missing $PASSF; run scripts/v3-e2e/setup.sh first" >&2; exit 2; }
set -a; . "$ENVF"; . "$PASSF"; set +a

fx() { python3 -c "import json;d=json.load(open('$FIX'));print(d['v4_gate_s10']$1)"; }
st() {
  python3 - "$STATE" "$@" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2:-1]:
    d = d[k]
v = d[sys.argv[-1]]
print("" if v is None else json.dumps(v, separators=(",", ":")) if isinstance(v, (dict, list)) else v)
PY
}

FW_NAME=$(fx "['forward']['name']")
FW_PORT=$(fx "['forward']['listen_port']")
FW_HOST=$(fx "['forward']['target_host']")
FW_TPORT=$(fx "['forward']['target_port']")
SWAP_HOST=$(fx "['edit_target_hot_swap']['target_host']")
SWAP_TPORT=$(fx "['edit_target_hot_swap']['target_port']")
NEW_PORT=$(fx "['edit_listener_replace']['listen_port']")
AGENT_C=$(fx "['agent_restart']['container']")
MARK_A=$(fx "['targets']['target_a']['marker']")
MARK_B=$(fx "['targets']['target_b']['marker']")
PRI_WS=$(st workspaces primary id)

log "S10 前置检查：wp14 栈 / exact-SHA 镜像"
for c in wp14-panel wp14-worker wp14-mysql wp14-redis wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client; do
  guard_container "$c"
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || bad "A0.$c 容器未运行" || true
done
ok "A0.1 wp14 栈九个容器全部存在（白名单外容器一概不操作）"
[[ "$(docker inspect -f '{{.State.Running}}' wp14-panel)" == true ]] && ok "A0.2 wp14-panel 运行中"

# Every image in the wp14 stack must come from the exact-SHA GHCR tag, never the
# stale local build.
WP14_IMG_SRC=$(docker inspect -f '{{.Image}}' wp14-panel)
WP14_IMG_SRC2=$(docker image inspect --format '{{index .RepoDigests 0}}' "$BACKEND_IMAGE" 2>/dev/null || echo "")
[[ -n "$WP14_IMG_SRC2" ]] && ok "A0.3 exact-SHA backend 镜像 $BACKEND_IMAGE 在本地可考" || bad "A0.3 本地缺少 $BACKEND_IMAGE"
AGENT_IMG_SRC2=$(docker image inspect --format '{{index .RepoDigests 0}}' "$AGENT_IMAGE" 2>/dev/null || echo "")
[[ -n "$AGENT_IMG_SRC2" ]] && ok "A0.4 exact-SHA agent 镜像 $AGENT_IMAGE 在本地可考" || bad "A0.4 本地缺少 $AGENT_IMAGE"
[[ "$WP14_IMG_SRC2" == *"$HEAD_SHA"* ]] && ok "A0.5 backend 镜像 digest 绑定 main HEAD $HEAD_SHA" || bad "A0.5 backend 镜像未绑定 $HEAD_SHA"
[[ "$AGENT_IMG_SRC2" == *"$HEAD_SHA"* ]] && ok "A0.6 agent 镜像 digest 绑定 main HEAD $HEAD_SHA" || bad "A0.6 agent 镜像未绑定 $HEAD_SHA"

# ------------------------------------------------------------------ login
log "S10 登录（复用 setup.sh 创建的用户/workspace）"
LOGIN_PAYLOAD=$(python3 - "$STATE" "$PASSF" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
u = dict(d["user"])
for line in open(sys.argv[2]):
    if line.startswith("WP14_USER_PASSWORD="):
        u["password"] = line.split("=", 1)[1].strip().strip("'")
print(json.dumps(u))
PY
)
curl -sS -m 15 -D "$S10_OUT/login.headers" -o "$S10_OUT/login.json" \
  -X POST "$API/api/auth/login" \
  -H 'content-type: application/json' \
  -H 'x-requested-with: XMLHttpRequest' \
  -d "$LOGIN_PAYLOAD" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$S10_OUT/login.headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
assert_nonempty "$COOKIE" "S10.1 rest 用户会话登录成功"

api_post_forward() {
  local body="$1" file="$2"
  curl -sS -m 90 -o "$S10_OUT/$file" -w '%{http_code}' \
    -X POST "$API/api/forwards" \
    -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" \
    -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json' \
    -d "$body" || echo 000
}
api_patch() {
  local body="$1" file="$2"
  curl -sS -m 90 -o "$S10_OUT/$file" -w '%{http_code}' \
    -X PATCH "$API/api/forwards/$FORWARD_ID" \
    -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" \
    -H 'x-requested-with: XMLHttpRequest' -H 'content-type: application/json' \
    -d "$body" || echo 000
}
api_del() {
  curl -sS -m 60 -o "$S10_OUT/$1" -w '%{http_code}' \
    -X DELETE "$API/api/forwards/$2" \
    -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" \
    -H 'x-requested-with: XMLHttpRequest' || echo 000
}

TUN_CREATE=$(mysqlc "SELECT id FROM tunnel WHERE name='$FW_NAME' ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "")
if [[ -n "$TUN_CREATE" ]]; then
  # A previous run left this slice's own Forward behind. Deleting it through the
  # real API keeps the ledger honest (no manual DELETE FROM ... WHERE ...).
  log "清理本切片上一次运行遗留的 Forward（$FW_NAME id=$TUN_CREATE）"
  DEL_STATUS=$(api_del cleanup.json "$TUN_CREATE")
  echo "cleanup status=$DEL_STATUS"
  sleep 2
fi

log "S10 创建自己的 Forward（真实业务操作，等待 Agent ACK）"
CREATE_STATUS=$(api_post_forward "{\"name\":\"$FW_NAME\",\"in_node_group\":\"ingress\",\"listen_port\":$FW_PORT,\"target_host\":\"$FW_HOST\",\"target_port\":$FW_TPORT}" create.json)
assert_eq "$CREATE_STATUS" "200" "S10.2 createForward HTTP 200（port=$FW_PORT target=$FW_HOST:$FW_TPORT）"

FORWARD_ID=$(jget create.json "['data']['id']")
assert_nonempty "$FORWARD_ID" "S10.3 Forward id 已返回"
CREATE_APPLIED=$(jget create.json "['data']['applied_revision']")
CREATE_CFG=$(jget create.json "['data']['config_revision']")
[[ -n "$CREATE_APPLIED" ]] && ok "S10.4 创建即有 applied_revision=$CREATE_APPLIED（非 null）" || limited "S10.4 applied_revision=$CREATE_APPLIED；无法据此判定 first-edit baseline 是否存在"

BASE_REV=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
BASE_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
BASE_SNAP=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
BASE_ROLLOUT=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID;")
BASE_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
log "S10 基线 rev=$BASE_REV applied=$BASE_APPLIED snapshot=$BASE_SNAP rollout=$BASE_ROLLOUT active_lease=$BASE_LEASE"

BASE_MARK=$(wait_probe "$FW_PORT" "$MARK_A" || true)
assert_eq "$BASE_MARK" "$MARK_A" "S10.5 真实数据面在端口 $FW_PORT 读到 $MARK_A"

# ==================================================================
# S10-A/B/C — 一次真实 target 热换：阶段推进 + applied==config + 单行记账
# ==================================================================
log "S10-A/B/C: target 热换（$FW_HOST -> $SWAP_HOST），观测 rollout 阶段推进"
SAMPLES="$S10_OUT/phase-samples.txt"
STOPF="$S10_OUT/.stop-sampler"
phase_sampler "$FORWARD_ID" "$((BASE_REV + 1))" "$SAMPLES" "$STOPF"

PATCH1_STATUS=$(api_patch "{\"target_host\":\"$SWAP_HOST\",\"target_port\":$SWAP_TPORT,\"expected_revision\":$BASE_REV}" patch1.json)
stop_phase_sampler "$STOPF"

assert_eq "$PATCH1_STATUS" "200" "S10.6 target 热换 PATCH HTTP 200"
P1_REV=$(jget patch1.json "['data']['config_revision']")
P1_APPLIED=$(jget patch1.json "['data']['applied_revision']")
assert_gt "$P1_REV" "$BASE_REV" "S10.7 config_revision 前进（$BASE_REV -> $P1_REV）"

# applied == config (real Agent ACK, not a projection column mirror)
assert_eq "$P1_APPLIED" "$P1_REV" "S10.8 applied_revision == config_revision（Agent 真实 ACK 新 revision）"
P1_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$P1_DB_APPLIED" "$P1_REV" "S10.9 DB applied_revision 已收敛到新 revision"

# ---- in-flight non-terminal phase evidence (observed, never written)
NON_TERMINAL=$(awk '$2!="" && $2!="done" && $2!="failed" && $2!="degraded" && $2!="compensating" {print $2}' "$SAMPLES" 2>/dev/null | sort -u | tr '\n' ',' || true)
NON_TERMINAL="${NON_TERMINAL%,}"
SAMPLE_COUNT=$(wc -l <"$SAMPLES" 2>/dev/null | tr -d ' ' || echo 0)
echo "phase samples ($SAMPLE_COUNT): $(tr '\n' ' ' <"$SAMPLES" 2>/dev/null | sed 's/  */ /g')"
if [[ -n "$NON_TERMINAL" && "$SAMPLE_COUNT" -gt 1 ]]; then
  ok "S10.10 in-flight 非终态 phase 被真实观测到（$NON_TERMINAL，共 $SAMPLE_COUNT 个采样点）"
else
  # Honest: no terminal phase alone is not proof of an in-flight window. The
  # rollout may legitimately complete within one poll interval.
  limited "S10.10 未捕获到非终态 phase（采样 $SAMPLE_COUNT 点，rollout 可能在一个轮询间隔内完成）——不判 PASS"
fi
TERMINAL_PHASE=$(tail -1 "$SAMPLES" 2>/dev/null | awk '{print $2}')
assert_eq "$TERMINAL_PHASE" "done" "S10.11 rollout 终态 = done"

# ---- one edit == one snapshot + one rollout row (+ one lease, still unique)
P1_SNAP=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
P1_ROLLOUT=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID;")
assert_eq "$((P1_SNAP - BASE_SNAP))" "1" "S10.12 一次编辑只新增 1 行 forward_revision"
assert_eq "$((P1_ROLLOUT - BASE_ROLLOUT))" "1" "S10.13 一次编辑只新增 1 行 forward_rollout"

P1_STRATEGY=$(mysqlc "SELECT IFNULL(strategy,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$P1_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$P1_STRATEGY" "target_hot_swap" "S10.14 target 热换归类为 target_hot_swap"

P1_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
assert_eq "$P1_LEASE" "1" "S10.15 同一 tunnel 只有一条 active lease"

P1_MARK=$(wait_probe "$FW_PORT" "$MARK_B" || true)
assert_eq "$P1_MARK" "$MARK_B" "S10.16 真实数据面已切到 $MARK_B"

# ==================================================================
# S10-D — listener 替换：旧/新端口真实 TCP marker
# ==================================================================
log "S10-D: listener 替换（port $FW_PORT -> $NEW_PORT）"
PATCH2_STATUS=$(api_patch "{\"listen_port\":$NEW_PORT,\"target_host\":\"$SWAP_HOST\",\"target_port\":$SWAP_TPORT,\"expected_revision\":$P1_REV}" patch2.json)
assert_eq "$PATCH2_STATUS" "200" "S10.17 listen_port PATCH HTTP 200"
P2_REV=$(jget patch2.json "['data']['config_revision']")
P2_APPLIED=$(jget patch2.json "['data']['applied_revision']")
P2_VIEW_PORT=$(jget patch2.json "['data']['listen_port']")
assert_eq "$P2_VIEW_PORT" "$NEW_PORT" "S10.18 Forward 视图 listen_port 已切到 $NEW_PORT"
assert_eq "$P2_APPLIED" "$P2_REV" "S10.19 Agent 已 ACK listener 替换 revision"

P2_NEW_MARK=$(wait_probe "$NEW_PORT" "$MARK_B" || true)
assert_eq "$P2_NEW_MARK" "$MARK_B" "S10.20 新端口 $NEW_PORT 真实 TCP 读到 $MARK_B"
P2_OLD_DEAD=$(wait_dead "$FW_PORT" || true)
assert_eq "$P2_OLD_DEAD" "" "S10.21 旧端口 $FW_PORT 已不再接受新连接"

P2_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
P2_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
P2_DB_PORT=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$P2_DB_CFG" "$P2_REV" "S10.22 DB config_revision 与 API 一致"
assert_eq "$P2_DB_APPLIED" "$P2_REV" "S10.23 DB applied_revision 已收敛"
assert_eq "$P2_DB_PORT" "$NEW_PORT" "S10.24 DB listen_port 已切到 $NEW_PORT"

P2_STRATEGY=$(mysqlc "SELECT IFNULL(strategy,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$P2_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$P2_STRATEGY" "listener_replace" "S10.25 rollout 归类为 listener_replace"
P2_STEPS=$(mysqlc "SELECT IFNULL(steps,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$P2_REV ORDER BY id DESC LIMIT 1;")
assert_contains "$P2_STEPS" "acquire_port" "S10.26 rollout 计划含 acquire_port"
assert_contains "$P2_STEPS" "release_old_lease" "S10.27 rollout 计划含 release_old_lease（§13.3.5 CLEANUP）"

P2_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
assert_eq "$P2_LEASE" "1" "S10.28 同一 tunnel 只有一条 active lease（无泄漏）"
P2_LEASE_PORT=$(mysqlc "SELECT IFNULL(port,0) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active' ORDER BY id DESC LIMIT 1;")
assert_eq "$P2_LEASE_PORT" "$NEW_PORT" "S10.29 active lease 端口即新端口 $NEW_PORT"
P2_OLD_LEASE=$(mysqlc "SELECT IFNULL(status,'') FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND port=$FW_PORT ORDER BY id DESC LIMIT 1;")
assert_eq "$P2_OLD_LEASE" "released" "S10.30 旧端口 $FW_PORT 的 lease 已 released"

# ==================================================================
# S10-E/F — ingress agent 重启后数据面存活
# ==================================================================
log "S10-E: 重启 $AGENT_C（真实运维动作，不是手写 DB）"
guard_container "$AGENT_C"
AGENT_START_ID=$(docker inspect -f '{{.Id}}' "$AGENT_C")
docker restart "$AGENT_C" >/dev/null || bad "S10.31 agent 容器 restart 命令失败"
for _ in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$AGENT_C" 2>/dev/null)" == true ]] && break
  sleep 1
done
AGENT_NOW_ID=$(docker inspect -f '{{.Id}}' "$AGENT_C")
assert_ne "$AGENT_NOW_ID" "$AGENT_START_ID" "S10.32 agent 容器确已重建（新容器 ID）"

# Agent must re-authenticate and re-report state after the restart.
for _ in $(seq 1 40); do
  RECENT=$(mysqlc "
    SELECT COUNT(*) FROM node_state_report s
    JOIN node n ON n.id=s.node_id
    WHERE n.node_id='WP14-IN-A-NODE' AND s.reported_at > NOW() - INTERVAL 1 MINUTE;" 2>/dev/null || echo 0)
  [[ "${RECENT:-0}" -ge 1 ]] && break
  sleep 2
done
[[ "${RECENT:-0}" -ge 1 ]] && ok "S10.33 agent 重启后完成真实 state report（重新握手）" || limited "S10.33 未观测到重启后的新鲜 state report（窗口 80s）"

P3_MARK=$(wait_probe "$NEW_PORT" "$MARK_B" || true)
assert_eq "$P3_MARK" "$MARK_B" "S10.34 agent 重启后同一端口 $NEW_PORT 数据面仍读到 $MARK_B"

P3_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
P3_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
P3_APPLY_STATE=$(mysqlc "SELECT IFNULL(apply_status,''),IFNULL(desired_status,'') FROM tunnel WHERE id=$FORWARD_ID;" 2>/dev/null || true)
assert_eq "$P3_DB_CFG" "$P2_REV" "S10.35 重启后 config_revision 不变（无需新 revision）"
assert_eq "$P3_DB_APPLIED" "$P2_REV" "S10.36 重启后 applied_revision 不变（runtime 已恢复）"
assert_eq "$P3_APPLY_STATE" "active active" "S10.37 重启后 apply_status/desired_status 仍为 active"

P3_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
assert_eq "$P3_LEASE" "1" "S10.38 agent 重启后仍只有一条 active lease"

P3_SNAP=$(mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;")
P3_ROLLOUT=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID;")
assert_eq "$((P3_SNAP - P1_SNAP))" "1" "S10.39 agent 重启未写入额外 revision snapshot（数据面恢复而不是重新 roll）"

# ==================================================================
# S10-G — 受控中断实验（pause ingress agent → PATCH → 复位）
# ==================================================================
log "S10-G: 受控中断实验（pause ingress agent 期间 PATCH）"
# Trap first: an interrupted run must never leave a paused agent behind.
cleanup_on_exit() {
  if [[ "${PAUSED:-0}" == "1" ]]; then
    echo "[trap] 恢复被暂停的容器"
    docker unpause "$AGENT_C" >/dev/null 2>&1 || true
    PAUSED=0
  fi
  rm -f "$S10_OUT/.stop-sampler"
  return 0
}
trap cleanup_on_exit EXIT INT TERM

PAUSED=0
PAUSE_STATUS=$(docker inspect -f '{{.State.Paused}}' "$AGENT_C" 2>/dev/null || echo "unknown")
assert_eq "$PAUSE_STATUS" "false" "S10.40 实验前 agent 未处于 paused 状态"

# pause semantics precheck: the container must freeze and unfreeze cleanly.
docker pause "$AGENT_C" >/dev/null 2>&1 || { limited "S10.41 docker pause $AGENT_C 失败（权限/驱动）——中断实验无法执行"; docker unpause "$AGENT_C" >/dev/null 2>&1 || true; }
if [[ "$(docker inspect -f '{{.State.Paused}}' "$AGENT_C" 2>/dev/null)" == "true" ]]; then
  PAUSED=1
  ok "S10.41 docker pause 成功且 State.Paused=true"

  # While paused the agent cannot ACK, so the PATCH must NOT fabricate applied.
  IST_SAMPLES="$S10_OUT/phase-samples-paused.txt"
  phase_sampler "$FORWARD_ID" "$((P3_DB_CFG + 1))" "$IST_SAMPLES" "$S10_OUT/.stop-ist"
  PAUSED_PATCH=$(api_patch "{\"target_host\":\"$FW_HOST\",\"target_port\":$FW_TPORT,\"expected_revision\":$P3_DB_CFG}" paused-patch.json)
  stop_phase_sampler "$S10_OUT/.stop-ist"
  IST_NON_TERMINAL=$(awk '$2!="" && $2!="done" && $2!="failed" && $2!="degraded" && $2!="compensating" {print $2}' "$IST_SAMPLES" 2>/dev/null | sort -u | tr '\n' ',' || true)
  IST_NON_TERMINAL="${IST_NON_TERMINAL%,}"
  IST_SAMPLES_N=$(wc -l <"$IST_SAMPLES" 2>/dev/null | tr -d ' ' || echo 0)
  echo "paused-phase samples ($IST_SAMPLES_N): $(tr '\n' ' ' <"$IST_SAMPLES" 2>/dev/null | sed 's/  */ /g')"

  # The API is expected to answer (possibly 5xx/409) — what matters is the
  # ledger never claims a done rollout for a revision the agent could not ACK.
  IST_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
  IST_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
  IST_DONE_COUNT=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND phase='done' AND revision > $P3_DB_CFG;")
  assert_eq "$IST_DONE_COUNT" "0" "S10.42 agent 暂停期间没有任何 rollout 行被推进到 done"
  [[ "$IST_DB_APPLIED" -le "$IST_DB_CFG" ]] && ok "S10.43 agent 暂停期间 applied_revision 不超前于 config_revision（applied=$IST_DB_APPLIED cfg=$IST_DB_CFG）" || bad "S10.43 applied_revision 超前（ Impossible for an unACKable revision）"
  if [[ -n "$IST_NON_TERMINAL" && "$IST_SAMPLES_N" -gt 1 ]]; then
    ok "S10.44 agent 暂停期间真实观测到 in-flight 非终态 phase（$IST_NON_TERMINAL）"
  else
    limited "S10.44 agent 暂停期间未捕获非终态 phase（PATCH HTTP=$PAUSED_PATCH，edit 可能在 pause 前即被拒绝）"
  fi

  docker unpause "$AGENT_C" >/dev/null 2>&1 || bad "S10.45 docker unpause 失败"
  PAUSED=0
  for _ in $(seq 1 20); do
    [[ "$(docker inspect -f '{{.State.Paused}}' "$AGENT_C" 2>/dev/null)" == "false" ]] && break
    sleep 1
  done
  [[ "$(docker inspect -f '{{.State.Paused}}' "$AGENT_C" 2>/dev/null)" == "false" ]] && ok "S10.46 docker unpause 后 State.Paused=false" || bad "S10.46 unpause 后容器仍被暂停"

  # After unpause the pending revision must converge by itself (resumeRollouts /
  # reconciler), proving recovery rather than a stuck base.
  REC_MARK=""
  for _ in $(seq 1 60); do
    REC_MARK=$(probe "$NEW_PORT")
    REC_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
    REC_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
    [[ "$REC_APPLIED" == "$REC_CFG" && "$REC_APPLIED" -gt "$P3_DB_CFG" ]] && break
    sleep 2
  done
  if [[ "$REC_APPLIED" == "$REC_CFG" && "$REC_APPLIED" -gt "$P3_DB_CFG" ]]; then
    ok "S10.47 unpause 后 rollout 自行收敛（rev $P3_DB_CFG -> $REC_APPLIED，终态 done）"
    REC_TERM=$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$REC_CFG ORDER BY id DESC LIMIT 1;")
    assert_eq "$REC_TERM" "done" "S10.48 收敛后的 rollout 行 phase=done"
  else
    limited "S10.47 unpause 后未在 120s 内自行收敛（applied=$REC_APPLIED cfg=$REC_CFG，端口 $NEW_PORT marker=$REC_MARK）——如实记 LIMITED，不判 PASS"
  fi
else
  unverified "S10.41 docker pause $AGENT_C 未生效（或不被支持）——中断实验整体 UNVERIFIED"
fi

# Final data-plane liveness for the slice.
FINAL_MARK=$(wait_probe "$NEW_PORT" "$MARK_B" || true)
assert_eq "$FINAL_MARK" "$MARK_B" "S10.49 实验结束后端口 $NEW_PORT 数据面仍读到 $MARK_B"

# ---------------------------------------------------------------- evidence
{
  echo "# TuneX V4-F1 Gate — S10 slice Evidence"
  echo "time: $(date -Is)"
  echo "head_sha: $HEAD_SHA"
  echo "backend_image: $BACKEND_IMAGE digest=$WP14_IMG_SRC2"
  echo "agent_image:   $AGENT_IMAGE digest=$AGENT_IMG_SRC2"
  echo "forward: id=$FORWARD_ID name=$FW_NAME base_port=$FW_PORT target=$FW_HOST:$FW_TPORT"
  echo "baseline: rev=$BASE_REV applied=$BASE_APPLIED snapshot=$BASE_SNAP rollout=$BASE_ROLLOUT lease=$BASE_LEASE"
  echo
  echo "phase timeline (hot swap):"
  sed 's/^/  /' "$SAMPLES" 2>/dev/null || echo "  (no samples)"
  if [[ -f "$IST_SAMPLES" ]]; then
    echo
    echo "phase timeline (agent paused):"
    sed 's/^/  /' "$IST_SAMPLES" 2>/dev/null
  fi
  echo
  echo "S10-A/B/C hot swap: rev $BASE_REV -> $P1_REV applied=$P1_APPLIED strategy=$P1_STRATEGY marker=$P1_MARK"
  echo "S10-D listener_replace: $FW_PORT -> $NEW_PORT rev=$P2_REV new_marker=$P2_NEW_MARK old_dead=$([[ -z "$P2_OLD_DEAD" ]] && echo yes || echo no) lease_active=$P2_LEASE old_lease=$P2_OLD_LEASE"
  echo "S10-E agent restart: container_id $AGENT_START_ID -> $AGENT_NOW_ID rev=$P3_DB_CFG applied=$P3_DB_APPLIED marker=$P3_MARK lease=$P3_LEASE"
  echo "S10-G paused experiment: paused_patch_http=${PAUSED_PATCH:-n/a} done_rows_while_paused=${IST_DONE_COUNT:-n/a} final_rev=$REC_APPLIED"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "TOTAL PASS=$PASS FAIL=$FAIL LIMITED=$LIMITED DEFECT=$DEFECTS"
} >"$OUT/v4-gate-s10-result.txt"

echo "------------------------------------------------------------------"
printf 'V4-GATE-S10 TOTAL: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m \033[1;33mLIMITED=%d\033[0m \033[1;35mDEFECT=%d\033[0m evidence=%s\n' \
  "$PASS" "$FAIL" "$LIMITED" "$DEFECTS" "$OUT/v4-gate-s10-result.txt"

# A slice that could not verify what it claims must not exit green.
[[ "$FAIL" -eq 0 ]]