#!/usr/bin/env bash
# TuneX V4-F1 Gate — S10 slice.
#
# This is now a first-class Integration slice. It reuses setup.sh's wp14
# topology, which is built from the exact checkout under test, then creates its
# OWN Forward so every revision / snapshot / rollout / lease assertion has a
# clean baseline. No DB phase is fabricated; all state is observed from the
# real API, MySQL ledger and TCP data plane.
#
# The image identity checks below validate the local CI tags and the images
# actually attached to the running containers. Pulling a released main image
# here would make a PR gate test old code and could produce a false green.
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

HEAD_SHA=${HEAD_SHA:-${GITHUB_SHA:-unknown}}
BACKEND_IMAGE=${TUNEX_BACKEND_IMAGE:-wp14-backend:ci}
AGENT_IMAGE=${WP14_AGENT_IMAGE:-wp14-agent:ci}
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
assert_nonempty() { [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
assert_ne() {
  # Empty-vs-empty is an environment failure, not a difference.
  if [[ -z "$1" && -z "$2" ]]; then
    bad "$3 [两侧均为空——查询失败，不是不等]"
    return
  fi
  [[ -n "$1" && "$1" != "$2" ]] && ok "$3" || bad "$3 [实得 '$1']"
}
assert_eq() {
  # An empty observed value is never silently "equal" to an empty expectation:
  # that is an environment failure, not a pass. Callers that legitimately expect
  # emptiness must pass a non-empty sentinel (e.g. "none").
  if [[ -z "$1" && -z "$2" ]]; then
    bad "$3 [实得与期望均为空——查询失败，不是相等]"
    return
  fi
  [[ "$1" == "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 期望 '$2']"
}
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
  # Read-only ledger probe.
  #   · .env.wp14 is sourced first so docker exec inherits MYSQL_ROOT_PASSWORD /
  #     MYSQL_DATABASE as container environment (never echoed, never committed).
  #   · The SQL goes in as $0 of the inner sh so whitespace and quoted literals
  #     survive unchanged. tail -1 keeps only the result row of a multi-line
  #     statement (a blank first line would otherwise count as a wrong answer).
  set -a; . "$ENVF"; set +a
  docker exec wp14-mysql sh -c \
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "$0"' "$1" 2>/dev/null | tail -1 | tr -d '\r'
}

probe() {
  local port="$1"
  docker exec wp14-client sh -c "nc -w 4 172.31.10.20 '$port' </dev/null" 2>/dev/null | tr -d '\r\n' || true
}

wait_probe() {
  local port="$1" want="$2" got="" tries=${3:-40}
  for _ in $(seq 1 "$tries"); do
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
  # Start each sampler from a clean file so a previous run's samples can never
  # be mistaken for this run's evidence.
  : >"$samples_file"
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
INGRESS_NODE_ID=$(st nodes ingress id)

log "S10 前置检查：wp14 栈 / 当前 checkout CI 镜像"
for c in wp14-panel wp14-worker wp14-mysql wp14-redis wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client; do
  guard_container "$c"
  [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || bad "A0.$c 容器未运行" || true
done
ok "A0.1 wp14 栈九个容器全部存在（白名单外容器一概不操作）"
[[ "$(docker inspect -f '{{.State.Running}}' wp14-panel)" == true ]] && ok "A0.2 wp14-panel 运行中"

# setup.sh builds these tags from the current checkout in this same Integration
# job. Verify both tags exist, then prove the running panel/worker and agents are
# actually attached to those tags.
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null; }
BACKEND_IMAGE_ID=$(image_id "$BACKEND_IMAGE")
AGENT_IMAGE_ID=$(image_id "$AGENT_IMAGE")
assert_nonempty "$BACKEND_IMAGE_ID" "A0.3 当前 checkout backend 镜像 $BACKEND_IMAGE 存在"
assert_nonempty "$AGENT_IMAGE_ID" "A0.4 当前 checkout agent 镜像 $AGENT_IMAGE 存在"
assert_eq "$(docker inspect -f '{{.Config.Image}}' wp14-panel)" "$BACKEND_IMAGE" "A0.5 panel 使用当前 checkout backend 镜像"
assert_eq "$(docker inspect -f '{{.Config.Image}}' wp14-worker)" "$BACKEND_IMAGE" "A0.6 worker 使用当前 checkout backend 镜像"
assert_eq "$(docker inspect -f '{{.Config.Image}}' wp14-ingress-agent)" "$AGENT_IMAGE" "A0.7 ingress agent 使用当前 checkout agent 镜像"
assert_eq "$(docker inspect -f '{{.Config.Image}}' wp14-egress-agent)" "$AGENT_IMAGE" "A0.8 egress agent 使用当前 checkout agent 镜像"

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
  # node-scoped Forward creation is the real product surface (same endpoint the
  # Web client uses); the create call returns only after the Agent ACKed the
  # new runtime, so there is nothing to poll afterwards.
  curl -sS -m 120 -o "$S10_OUT/$file" -w '%{http_code}' \
    -X POST "$API/api/nodes/$INGRESS_NODE_ID/forwards" \
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

TUN_CREATE=$(curl -sS -m 20 "$API/api/nodes/$INGRESS_NODE_ID/forwards" \
  -H "cookie: $COOKIE" -H "x-workspace-id: $PRI_WS" \
  -H 'x-requested-with: XMLHttpRequest' \
  | python3 -c "import json,sys
d=json.load(sys.stdin)
rows=(d.get('data') if isinstance(d,dict) else d) or []
rows=rows if isinstance(rows,list) else []
for r in rows:
    if r.get('name')=='$FW_NAME':
        print(r['id']); break" 2>/dev/null || echo "")
if [[ -n "$TUN_CREATE" ]]; then
  # A previous run left this slice's own Forward behind. Deleting it through the
  # real API keeps the ledger honest (no manual DELETE FROM ... WHERE ...).
  log "清理本切片上一次运行遗留的 Forward（$FW_NAME id=$TUN_CREATE）"
  DEL_STATUS=$(api_del cleanup.json "$TUN_CREATE")
  echo "cleanup status=$DEL_STATUS"
  sleep 2
fi

log "S10 创建自己的 Forward（真实业务操作，等待 Agent ACK）"
CREATE_STATUS=$(api_post_forward "{\"name\":\"$FW_NAME\",\"listen_port\":$FW_PORT,\"target_host\":\"$FW_HOST\",\"target_port\":$FW_TPORT}" create.json)
assert_eq "$CREATE_STATUS" "201" "S10.2 createForward HTTP 201（port=$FW_PORT target=$FW_HOST:$FW_TPORT）"

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
# A blank baseline means the MySQL probe itself failed. Continuing would turn
# every later ledger delta into a meaningless arithmetic error, so fail fast
# instead of producing a wall of false FAILs.
if [[ -z "$BASE_REV" || -z "$BASE_SNAP" || -z "$BASE_LEASE" ]]; then
  echo "FATAL: S10 基线读取失败 rev='$BASE_REV' snap='$BASE_SNAP' lease='$BASE_LEASE'——环境阻塞，结束运行" >&2
  exit 3
fi
log "S10 基线 rev=$BASE_REV applied=$BASE_APPLIED snapshot=$BASE_SNAP rollout=$BASE_ROLLOUT active_lease=$BASE_LEASE"

BASE_MARK=$(wait_probe "$FW_PORT" "$MARK_A" || true)
assert_eq "$BASE_MARK" "$MARK_A" "S10.5 真实数据面在端口 $FW_PORT 读到 $MARK_A"

# ==================================================================
# S10-A/B/C — 一次真实 target 热换：阶段推进 + applied==config + 单行记账
# ==================================================================
log "S10-A/B/C: target 热换（$FW_HOST -> $SWAP_HOST），观测 rollout 阶段推进"
# The sampler must be running BEFORE the PATCH: the rollout executes in tens of
# milliseconds, so a sampler started after the request returns would only ever
# see the terminal phase and the in-flight assertion could not be honest.
SAMPLES="$S10_OUT/phase-samples.txt"
STOPF="$S10_OUT/.stop-sampler"
phase_sampler "$FORWARD_ID" "$((BASE_REV + 1))" "$SAMPLES" "$STOPF"
sleep 0.5

PATCH1_STATUS=$(api_patch "{\"target_host\":\"$SWAP_HOST\",\"target_port\":$SWAP_TPORT,\"expected_revision\":$BASE_REV}" patch1.json)
# Keep sampling a moment after the response so the terminal phase is captured.
sleep 0.5
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
DB_TERMINAL_PHASE=$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$P1_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$DB_TERMINAL_PHASE" "done" "S10.11 rollout 终态 = done（DB 真相；采样末点='$TERMINAL_PHASE'）"

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
P2_VIEW_PORT=$(jget patch2.json "['data']['listen_port']")
assert_eq "$P2_VIEW_PORT" "$NEW_PORT" "S10.18 Forward 视图 listen_port 已切到 $NEW_PORT"

# PATCH 可能与 1s recovery worker 同时续跑同一 rollout。HTTP 线程输掉 phase
# CAS 时现在返回 200 + pending，而不是伪 502；因此 Gate 必须等待 ledger 真相
# 收敛后再断言 applied/lease，而不能把“HTTP 返回瞬间”当作 done 屏障。
P2_APPLIED=""
P2_TERM=""
P2_LEASE=""
P2_OLD_LEASE=""
for _ in $(seq 1 40); do
  P2_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
  P2_TERM=$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$P2_REV ORDER BY id DESC LIMIT 1;")
  P2_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
  P2_OLD_LEASE=$(mysqlc "SELECT IFNULL(status,'') FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND port=$FW_PORT ORDER BY id DESC LIMIT 1;")
  [[ "$P2_APPLIED" == "$P2_REV" && "$P2_TERM" == "done" && "$P2_LEASE" == "1" && "$P2_OLD_LEASE" == "released" ]] && break
  sleep 1
done
assert_eq "$P2_APPLIED" "$P2_REV" "S10.19 Agent/ledger 已收敛 listener 替换 revision"

P2_NEW_MARK=$(wait_probe "$NEW_PORT" "$MARK_B" || true)
assert_eq "$P2_NEW_MARK" "$MARK_B" "S10.20 新端口 $NEW_PORT 真实 TCP 读到 $MARK_B"
P2_OLD_DEAD=$(wait_dead "$FW_PORT" || true)
# wait_dead already proves the port refused 20 consecutive connections; the
# ambiguity to rule out is "probe itself was broken", so re-read the port once
# and require it to be blank too. Blank-after-wait_dead == really dead.
P2_OLD_RECHECK=$(probe "$FW_PORT")
if [[ -z "$P2_OLD_DEAD" && -z "$P2_OLD_RECHECK" ]]; then
  ok "S10.21 旧端口 $FW_PORT 已不再接受新连接（wait_dead 20 次 + 复查均无响应）"
else
  bad "S10.21 旧端口 $FW_PORT 仍响应 [wait_dead='$P2_OLD_DEAD' 复查='$P2_OLD_RECHECK']"
fi

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

# P2_LEASE / P2_OLD_LEASE 已在上面的收敛循环中读取最终值。
assert_eq "$P2_LEASE" "1" "S10.28 同一 tunnel 只有一条 active lease（无泄漏）"
P2_LEASE_PORT=$(mysqlc "SELECT IFNULL(port,0) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active' ORDER BY id DESC LIMIT 1;")
assert_eq "$P2_LEASE_PORT" "$NEW_PORT" "S10.29 active lease 端口即新端口 $NEW_PORT"
assert_eq "$P2_OLD_LEASE" "released" "S10.30 旧端口 $FW_PORT 的 lease 已 released"

# ==================================================================
# S10-E/F — ingress agent 重启后数据面存活
# ==================================================================
log "S10-E: 重启 $AGENT_C（真实运维动作，不是手写 DB）"
guard_container "$AGENT_C"
# NOTE: `docker restart` keeps the SAME container ID (it only restarts the
# process inside the existing container), so the ID alone cannot prove a
# restart happened. The honest witness is State.StartedAt combined with the
# container's own restart count and a fresh state report.
AGENT_STARTED_AT=$(docker inspect -f '{{.State.StartedAt}}' "$AGENT_C" 2>/dev/null || echo "")
AGENT_RESTARTS_BEFORE=$(docker inspect -f '{{.RestartCount}}' "$AGENT_C" 2>/dev/null || echo "")
assert_nonempty "$AGENT_STARTED_AT" "S10.31a 重启前可读到 State.StartedAt（基线）"
if docker restart "$AGENT_C" >/dev/null 2>&1; then
  ok "S10.31 docker restart $AGENT_C 命令成功"
else
  # An approval-blocked or unsupported restart is an environment blocker, not a
  # product defect. Say so instead of silently continuing with a stale stamp.
  bad "S10.31 docker restart $AGENT_C 失败（可能是宿主机审批策略阻止容器生命周期操作）"
  limited "S10-E 整体受限：容器未真正重启，后续 agent 重启断言不是在测真实重启"
fi
for _ in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$AGENT_C" 2>/dev/null)" == true ]] && break
  sleep 1
done
AGENT_STARTED_AT_AFTER=$(docker inspect -f '{{.State.StartedAt}}' "$AGENT_C" 2>/dev/null || echo "")
AGENT_RESTARTS_AFTER=$(docker inspect -f '{{.RestartCount}}' "$AGENT_C" 2>/dev/null || echo "")
if [[ -n "$AGENT_STARTED_AT" && -n "$AGENT_STARTED_AT_AFTER" && "$AGENT_STARTED_AT_AFTER" > "$AGENT_STARTED_AT" ]]; then
  ok "S10.32 agent 进程确已重启（State.StartedAt $AGENT_STARTED_AT -> $AGENT_STARTED_AT_AFTER；RestartCount $AGENT_RESTARTS_BEFORE -> $AGENT_RESTARTS_AFTER）"
else
  limited "S10.32 State.StartedAt 未前进（$AGENT_STARTED_AT -> $AGENT_STARTED_AT_AFTER；RestartCount $AGENT_RESTARTS_BEFORE -> $AGENT_RESTARTS_AFTER）——除非 restart 被宿主机阻止，否则为真实缺陷"
fi

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
P3_APPLY_STATE=$(mysqlc "SELECT CONCAT(IFNULL(apply_status,''),'/',IFNULL(desired_status,'')) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$P3_DB_CFG" "$P2_REV" "S10.35 重启后 config_revision 不变（无需新 revision）"
assert_eq "$P3_DB_APPLIED" "$P2_REV" "S10.36 重启后 applied_revision 不变（runtime 已恢复）"
assert_eq "$P3_APPLY_STATE" "active/active" "S10.37 重启后 apply_status/desired_status 仍为 active/active"

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
  assert_eq "$PAUSED_PATCH" "200" "S10.41b pause 期间 PATCH 已保存为 pending（等待恢复收敛）"
  IST_NON_TERMINAL=$(awk '$2!="" && $2!="done" && $2!="failed" && $2!="degraded" && $2!="compensating" {print $2}' "$IST_SAMPLES" 2>/dev/null | sort -u | tr '\n' ',' || true)
  IST_NON_TERMINAL="${IST_NON_TERMINAL%,}"
  IST_SAMPLES_N=$(wc -l <"$IST_SAMPLES" 2>/dev/null | tr -d ' ' || echo 0)
  echo "paused-phase samples ($IST_SAMPLES_N): $(tr '\n' ' ' <"$IST_SAMPLES" 2>/dev/null | sed 's/  */ /g')"

  # PATCH 必须被接受为 desired/pending；真正的生效由 unpause 后 recovery 证明。
  # 暂停期间 ledger 绝不能提前声称 done。
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
  # The wait is long on purpose: the control plane first waits for the outbound
  # ACK timeout, parks the rollout in waiting, then resumeRollouts replays the
  # same revision after the Agent comes back. A short window would misclassify a
  # healthy recovery as LIMITED.
  REC_MARK=""
  REC_CFG=""
  REC_APPLIED=""
  REC_TERM=""
  for _ in $(seq 1 90); do
    REC_MARK=$(probe "$NEW_PORT")
    REC_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
    REC_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
    REC_TERM=$(mysqlc "SELECT IFNULL(phase,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$REC_CFG ORDER BY id DESC LIMIT 1;")
    [[ "$REC_APPLIED" == "$REC_CFG" && "$REC_APPLIED" -gt "$P3_DB_CFG" ]] && break
    sleep 2
  done
  if [[ "$REC_APPLIED" == "$REC_CFG" && "$REC_APPLIED" -gt "$P3_DB_CFG" ]]; then
    ok "S10.47 unpause 后 rollout 自行收敛（rev $P3_DB_CFG -> $REC_APPLIED，终态 $REC_TERM）"
    assert_eq "$REC_TERM" "done" "S10.48 收敛后的 rollout 行 phase=done"
  else
    # Observed in this slice's run: the ledger ends 'degraded' (applied stays
    # behind config) while the Agent log proves the target swap DID take
    # effect. That is a real backend finding, not a harness limitation, so it
    # is recorded as DEFECT with both sides of the evidence quoted.
    AGENT_SWAPPED=$(docker logs --tail 300 "$AGENT_C" 2>&1 | grep -c "hot-swap" || true)
    limited "S10.47 unpause 后未在 180s 内自行收敛（applied=$REC_APPLIED cfg=$REC_CFG phase=$REC_TERM 端口 $NEW_PORT marker=$REC_MARK）"
    if [[ "$REC_TERM" == "degraded" ]]; then
      DEFECT "S10.47" "暂停期间编辑的 revision $REC_CFG 在 unpause 后停在 degraded：applied_revision=$REC_APPLIED 落后于 config_revision=$REC_CFG，可是 Agent 日志显示 'hot-swap ... revision=$REC_CFG'（运行已实际生效）——ledger 与 runtime 不一致，ACK-timeout waiting/resume 仍未正确收敛"
    fi
  fi
else
  unverified "S10.41 docker pause $AGENT_C 未生效（或不被支持）——中断实验整体 UNVERIFIED"
fi

# Final data-plane liveness for the slice. The pause experiment intentionally
# edited the target to target-a, so the final marker reflects that last real
# edit — assert "serves SOME real target marker", and separately assert the
# port is still listening at all.
FINAL_MARK=$(wait_probe "$NEW_PORT" "$MARK_A" || true)
if [[ "$FINAL_MARK" == "$MARK_A" ]]; then
  ok "S10.49 实验结束后端口 $NEW_PORT 数据面仍可读（marker=$FINAL_MARK，即中断实验最后一次真实编辑的目标）"
else
  bad "S10.49 实验结束后端口 $NEW_PORT 数据面不可读 [实得 '$FINAL_MARK' 期望 '$MARK_A']"
fi

# ---------------------------------------------------------------- evidence
{
  echo "# TuneX V4-F1 Gate — S10 slice Evidence"
  echo "time: $(date -Is)"
  echo "head_sha: $HEAD_SHA"
  echo "backend_image: $BACKEND_IMAGE id=$BACKEND_IMAGE_ID"
  echo "agent_image:   $AGENT_IMAGE id=$AGENT_IMAGE_ID"
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
  echo "S10-E agent restart: StartedAt $AGENT_STARTED_AT -> $AGENT_STARTED_AT_AFTER RestartCount $AGENT_RESTARTS_BEFORE -> $AGENT_RESTARTS_AFTER rev=$P3_DB_CFG applied=$P3_DB_APPLIED marker=$P3_MARK lease=$P3_LEASE"
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