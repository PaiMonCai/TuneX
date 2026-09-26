#!/usr/bin/env bash
# TuneX V4-F1 Gate — rest slice (DEVELOPMENT.md §13.7 scenarios 3-6).
#
# Independent deliverable: this script does NOT modify or depend on the e2e
# branch's v4-gate.sh, setup.sh, _bootstrap.py or integration.yml. It reuses
# the same isolated topology and state.json those produce (MySQL / Redis /
# Panel / Worker / dual Agents / dual Targets / client) and adds the four
# scenarios the first slice did not cover:
#
#   S3  listen_port change  -> listener_replace rollout, real new-port data plane
#   S4  multi-field edit    -> ONE revision snapshot / ONE rollout row
#   S5  update failure      -> old applied revision keeps serving
#   S6  suspended edit      -> save desired only, resume applies latest revision
#
# Every assertion goes through the real HTTP API, the real MySQL ledger and the
# real TCP data plane. Nothing is mocked and no business table is written
# directly: the S5 failure is injected by asking for a port that a *real*
# other Forward already holds, so portPool/port_conflict rejects it.
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
DEFECTS=0
RESULTS=()
ok()  { PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '\033[1;32mPASS\033[0m | %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1"); printf '\033[1;31mFAIL\033[0m | %s\n' "$1"; }
# 与 FAIL 的区别：FAIL = 我们的脚本/环境没做到；DEFECT = 按规格应当成立但实现
# 没做到，是 Gate 真实暴露的后端缺陷。两者都让退出码非 0，但报告分开统计，
# 避免把产品缺陷混同于测试失误。
DEFECT() {
  DEFECTS=$((DEFECTS+1)); FAIL=$((FAIL+1))
  RESULTS+=("DEFECT[$1] | $2")
  printf '\033[1;35mDEFECT[%s]\033[0m | %s\n' "$1" "$2"
}
assert_eq() { [[ "$1" == "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 期望 '$2']"; }
assert_ne() { [[ -n "$1" && "$1" != "$2" ]] && ok "$3" || bad "$3 [实得 '$1']"; }
assert_nonempty() { [[ -n "$1" ]] && ok "$2" || bad "$2 [为空]"; }
assert_contains() { [[ "$1" == *"$2"* ]] && ok "$3" || bad "$3 [未含 '$2']"; }
# 数值严格递增：revision 号允许因 suspend bump 而跳号，因此断言「前进」而不是
# 「恰好 +1」——跳号本身是已记录行为（suspend 不写 snapshot），不是缺陷。
assert_gt() { [[ "${1:-0}" =~ ^[0-9]+$ && "${2:-0}" =~ ^[0-9]+$ && "$1" -gt "$2" ]] && ok "$3" || bad "$3 [实得 '$1' 需严格大于 '$2']"; }

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

wait_dead() {
  local port="$1" got="" last=""
  for _ in $(seq 1 15); do
    got=$(probe "$port")
    [[ -z "$got" ]] && { printf ''; return 0; }
    last="$got"
    sleep 1
  done
  printf '%s' "$last"
  return 1
}

jget() { python3 -c "import json,sys;d=json.load(open('$OUT/$1'));print(d$2)" 2>/dev/null || printf ''; }

# ---------------------------------------------------------------- fixtures
FIX="$HERE/fixtures/forward-edit.json"
RFIX="$HERE/fixtures/v4-gate-rest.json"
FORWARD_ID=$(state forward id)
FORWARD_PORT=$(state forward listen_port)
PRI_WS=$(state workspaces primary id)

MARK_A=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['marker_before'])")
MARK_B=$(python3 -c "import json;print(json.load(open('$FIX'))['v4_forward']['marker_after'])")
S3_PORT=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s3_listen_port']['new_port'])")
S4_PORT=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s4_multi_field']['listen_port'])")
S4_HOST=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s4_multi_field']['target_host'])")
S4_MARK=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s4_multi_field']['expected_marker_after'])")
S6_A_HOST=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s6_suspended_resume']['first_edit']['target_host'])")
S6_B_HOST=$(python3 -c "import json;print(json.load(open('$RFIX'))['v4_gate_rest']['s6_suspended_resume']['second_edit']['target_host'])")
S6_MARK_A="$MARK_A"
S6_MARK_B="$MARK_B"

echo "=================================================================="
echo " TuneX V4-F1 Gate — rest slice (S3 listen_port / S4 multi-field /"
echo " S5 failure-old-runtime / S6 suspended-edit+resume)"
echo " Forward tunnel=$FORWARD_ID current listen_port=$FORWARD_PORT"
echo "=================================================================="

# ---------------------------------------------------------------- login
LOGIN_PAYLOAD=$(python3 - "$STATE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps(d["user"]))
PY
)
curl -sS -m 15 -D "$OUT/rest-login.headers" -o "$OUT/rest-login.json"   -X POST "$API/api/auth/login"   -H 'content-type: application/json'   -H 'x-requested-with: XMLHttpRequest'   -d "$LOGIN_PAYLOAD" >/dev/null
COOKIE=$(grep -i '^set-cookie:' "$OUT/rest-login.headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
assert_nonempty "$COOKIE" "R0.1 rest 用户会话登录成功"

api_patch() {
  local body="$1" file="$2"
  curl -sS -m 60 -o "$OUT/$file" -w '%{http_code}'     -X PATCH "$API/api/forwards/$FORWARD_ID"     -H "cookie: $COOKIE"     -H "x-workspace-id: $PRI_WS"     -H 'x-requested-with: XMLHttpRequest'     -H 'content-type: application/json'     -d "$body" || echo 000
}

api_action() {
  local action="$1" file="$2"
  curl -sS -m 60 -o "$OUT/$file" -w '%{http_code}'     -X POST "$API/api/forwards/$FORWARD_ID/$action"     -H "cookie: $COOKIE"     -H "x-workspace-id: $PRI_WS"     -H 'x-requested-with: XMLHttpRequest'     -H 'content-type: application/json' || echo 000
}

api_get() {
  curl -sS -m 20 "$API/api/forwards/$FORWARD_ID"     -H "cookie: $COOKIE"     -H "x-workspace-id: $PRI_WS"     -H 'x-requested-with: XMLHttpRequest' || echo '{}'
}

cur_rev() { mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;"; }
cur_applied() { mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;"; }
snapshot_count() { mysqlc "SELECT COUNT(*) FROM forward_revision WHERE tunnel_id=$FORWARD_ID;"; }
rollout_count() { mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID;"; }
cur_state() { mysqlc "SELECT CONCAT_WS('|',IFNULL(desired_status,''),IFNULL(apply_status,''),IFNULL(remote_host,'')) FROM tunnel WHERE id=$FORWARD_ID;"; }

# ---------------------------------------------------------------- reset
# 多次重跑会残留下一次运行的中间态（suspended / 未收敛的 revision 漂移）。
# 若直接开始断言，S3 会读到「suspended 无 listener、applied 落后十几版」的脏
# 状态，从而把环境残留误报成产品缺陷。因此每个场景前先把 Forward 收敛回一个
# **真实干净**的基线：
#   1) 目标固定为 target-a（fixture base）；2) resume 把 runtime 拉起来。
# 全部通过真实 HTTP + 真实 Agent 完成，不使用任何 stub/mock。
BASE_REV=$(cur_rev)
BASE_APPLIED=$(cur_applied)
BASE_SNAPSHOTS=$(snapshot_count)
assert_nonempty "$BASE_REV" "R0.2 基线 config_revision 可读"

RESET_STATUS=$(api_patch "{\"target_host\":\"$MARK_A\",\"target_port\":3030,\"expected_revision\":$BASE_REV}" r0-reset.json)
RESET_REV=$(jget r0-reset.json "['data']['config_revision']")
echo
echo "---------- R0: 收敛到干净基线 ----------"
if [[ "$RESET_STATUS" == "409" ]]; then
  # revision 漂移时 409 是预期行为：重新读取最新 revision 再试一次。
  RESET_LATEST=$(jget r0-reset.json "['error']['details','latest_revision']")
  RESET_LATEST=${RESET_LATEST:-$(cur_rev)}
  bad "R0.3a reset PATCH 409（revision 漂移 $BASE_REV -> $RESET_LATEST，重试）"
  RESET_STATUS=$(api_patch "{\"target_host\":\"$MARK_A\",\"target_port\":3030,\"expected_revision\":$RESET_LATEST}" r0-reset2.json)
  RESET_REV=$(jget r0-reset2.json "['data']['config_revision']")
fi
assert_eq "$RESET_STATUS" "200" "R0.3reset reset PATCH 成功（目标回到 $MARK_A）"

# resume：把可能残留的 suspended/inactive 重新拉起成 active runtime。
BASE_STATE=$(cur_state)
if [[ "$BASE_STATE" != "active|active|$MARK_A" ]]; then
  RESUME_STATUS=$(api_action resume r0-resume.json)
  assert_eq "$RESUME_STATUS" "200" "R0.4 基线 resume 成功（拉起真实 runtime）"
fi
assert_eq "$(cur_state)" "active|active|$MARK_A" "R0.5 基线状态干净（desired=active apply=active target=$MARK_A）"

# 等待真实数据面在新端口上监听（否则 S3.1 读不到 marker 是环境未收敛）。
BASE_REV=$(cur_rev)
BASE_APPLIED=$(cur_applied)
BASE_SNAPSHOTS=$(snapshot_count)
BASE_STATE=$(cur_state)
if [[ "$BASE_STATE" != "active|active|$MARK_A" ]]; then
  bad "R0.6 收敛后 desired/apply 仍未回到 active（state=$BASE_STATE）"
else
  ok "R0.6 收敛后 desired/apply=active（rev=$BASE_REV applied=$BASE_APPLIED snapshots=$BASE_SNAPSHOTS）"
fi
FORWARD_PORT=$(state forward listen_port)

# ================================================================
# S3 — listen port 修改（§13.3.4「Listen Port」/ §13.3.5 listener_replace）
# ================================================================
echo
echo "---------- S3: listen port 修改 ----------"
S3_BEFORE_PROBE=$(wait_probe "$FORWARD_PORT" "$MARK_A" || true)
assert_eq "$S3_BEFORE_PROBE" "$MARK_A" "S3.1 基线数据面读到 target marker（旧端口 $FORWARD_PORT）"

S3_STATUS=$(api_patch "{\"listen_port\":$S3_PORT,\"expected_revision\":$BASE_REV}" s3-patch.json)
assert_eq "$S3_STATUS" "200" "S3.2 PATCH listen_port HTTP 200"

S3_REV=$(jget s3-patch.json "['data']['config_revision']")
S3_VIEW_PORT=$(jget s3-patch.json "['data']['listen_port']")
S3_APPLIED=$(jget s3-patch.json "['data']['applied_revision']")
assert_eq "$S3_VIEW_PORT" "$S3_PORT" "S3.3 Forward 视图 listen_port 已切到新端口"
assert_eq "$S3_APPLIED" "$S3_REV" "S3.4 Agent 已 ACK 新 revision（applied == config）"

S3_NEW_PROBE=$(wait_probe "$S3_PORT" "$MARK_A" || true)
assert_eq "$S3_NEW_PROBE" "$MARK_A" "S3.5 真实数据面在新端口 $S3_PORT 读到 marker"

S3_DEAD=$(wait_dead "$FORWARD_PORT" || true)
assert_eq "$S3_DEAD" "" "S3.6 旧端口 $FORWARD_PORT 已不再接受新连接（drain/cleanup 生效）"

S3_DB_PORT=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
S3_DB_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
S3_DB_CFG=$(mysqlc "SELECT IFNULL(config_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S3_DB_PORT" "$S3_PORT" "S3.7 DB tunnel.listen_port 已切到新端口"
assert_eq "$S3_DB_CFG" "$S3_REV" "S3.8 DB config_revision 与 API 一致"
assert_eq "$S3_DB_APPLIED" "$S3_REV" "S3.9 DB applied_revision 已收敛"

S3_SNAP_NOW=$(snapshot_count)
assert_eq "$((S3_SNAP_NOW - BASE_SNAPSHOTS))" "1" "S3.10 listener 重建只新增 1 行 revision snapshot"

S3_STRATEGY=$(mysqlc "SELECT IFNULL(strategy,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$S3_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$S3_STRATEGY" "listener_replace" "S3.11 rollout 分类为 listener_replace"

S3_NEW_LEASE=$(mysqlc "SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active';")
S3_NEW_LEASE_PORT=$(mysqlc "SELECT IFNULL(port,0) FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND status='active' ORDER BY id DESC LIMIT 1;")
S3_OLD_LEASE=$(mysqlc "SELECT IFNULL(status,'') FROM node_port_lease WHERE tunnel_id=$FORWARD_ID AND port=$FORWARD_PORT ORDER BY id DESC LIMIT 1;")
assert_eq "$S3_NEW_LEASE_PORT" "$S3_PORT" "S3.12 新端口持有 active lease"

# §13.3.5 CLEANUP 要求旧端口租约释放。**如实断言**：若本次 listener 重建之前
# 该 Forward 已有过一次成功 apply（forward_revision ≥ 2 行），`applied` 快照可
# 解析，plan 会生成 release_old_lease，旧 lease 必须变为 released 且 active 只
# 剩一条。若这是该 Forward 的**第一次**编辑（createForward 未写 snapshot /
# 未置 applied_revision ⇒ plan.applied === null），buildSteps 的
# `hasPreviousRuntime` 为 false ⇒ DRAIN/CLEANUP 整段被跳过，旧 lease 仍 active。
# 后一种情况是本 Gate 真实暴露的后端缺陷（见实施报告 D1），断言必须 FAIL 而
# 不是被静默改判通过。
S3_SNAP_TOTAL=$(snapshot_count)
S3_OLD_STEPS=$(mysqlc "SELECT IFNULL(steps,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$S3_REV ORDER BY id DESC LIMIT 1;")
if [[ "$S3_SNAP_TOTAL" -ge 2 ]] && [[ "$S3_OLD_STEPS" == *"release_old_lease"* ]]; then
  assert_eq "$S3_OLD_LEASE" "released" "S3.13 旧端口 lease 已释放（无泄漏）"
  assert_eq "$S3_NEW_LEASE" "1" "S3.14 同一 tunnel 只有一条 active lease"
else
  DEFECT "S3.13" "旧端口 lease 未释放（实得 status=$S3_OLD_LEASE）；plan 未生成 release_old_lease（snapshots=$S3_SNAP_TOTAL）——§13.3.5 CLEANUP 被 buildSteps 的 hasPreviousRuntime=false 跳过，属真实缺陷 D1"
  DEFECT "S3.14" "同一 tunnel 存在 $S3_NEW_LEASE 条 active lease（期望 1）——与 D1 同根：首次编辑无 applied 快照 ⇒ 旧端口租约泄漏"
fi

assert_contains "$S3_OLD_STEPS" "acquire_port" "S3.15 rollout 计划含 acquire_port（先落地新端口）"
# 有 applied 快照时 release_old_lease 必须在计划里；首次编辑时如实记缺陷。
if [[ "$S3_OLD_STEPS" == *"release_old_lease"* ]]; then
  ok "S3.16 rollout 计划含 release_old_lease（后释放旧端口）"
else
  DEFECT "S3.16" "rollout 计划缺 release_old_lease 步骤（§13.3.5 CLEANUP 未计划）——同 D1"
fi

echo "S3_PORT_AFTER=$S3_PORT" >>"$OUT/rest-state.env"

# ================================================================
# S4 — multi-field single revision（§13.3.4「多字段同时改」）
# ================================================================
echo
echo "---------- S4: 多字段同时改 = 一个 revision ----------"
S4_REV_BEFORE=$(cur_rev)
S4_SNAP_BEFORE=$(snapshot_count)
S4_ROLLOUT_BEFORE=$(rollout_count)
S4_PORT_NOW=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")

# 目标端口：故意换到另一个空闲端口，同时改 target + name。
# 用 S4_PORT（与 S3 端口不同）证明 multi-field 与 S3 是两次独立 rollout。
S4_STATUS=$(api_patch "{\"target_host\":\"$S4_HOST\",\"target_port\":3030,\"listen_port\":$S4_PORT,\"name\":\"v4-gate-direct-mf\",\"expected_revision\":$S3_REV}" s4-patch.json)
assert_eq "$S4_STATUS" "200" "S4.1 一次 PATCH 改 target+port+name HTTP 200"

S4_REV=$(jget s4-patch.json "['data']['config_revision']")
assert_eq "$S4_REV" "$((S4_REV_BEFORE + 1))" "S4.2 config_revision 只前进 1（一次编辑 = 一个 revision）"

S4_SNAP_AFTER=$(snapshot_count)
S4_ROLLOUT_AFTER=$(rollout_count)
assert_eq "$((S4_SNAP_AFTER - S4_SNAP_BEFORE))" "1" "S4.3 forward_revision 只新增 1 行（不是 4 行）"
assert_eq "$((S4_ROLLOUT_AFTER - S4_ROLLOUT_BEFORE))" "1" "S4.4 forward_rollout 只新增 1 行"

S4_ROW=$(mysqlc "SELECT CONCAT(target_host,':',IFNULL(target_port,''),'|',listen_port,'|',name) FROM forward_revision WHERE tunnel_id=$FORWARD_ID AND revision=$S4_REV;")
assert_eq "$S4_ROW" "$S4_HOST:3030|$S4_PORT|v4-gate-direct-mf" "S4.5 单个 snapshot 内四字段全部为新值（无中间半配置）"

S4_DB_HOST=$(mysqlc "SELECT IFNULL(remote_host,'') FROM tunnel WHERE id=$FORWARD_ID;")
S4_DB_PORT=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S4_DB_HOST" "$S4_HOST" "S4.6 DB remote_host 已更新"
assert_eq "$S4_DB_PORT" "$S4_PORT" "S4.7 DB listen_port 已更新"

S4_MARK_GOT=$(wait_probe "$S4_PORT" "$S4_MARK" || true)
assert_eq "$S4_MARK_GOT" "$S4_MARK" "S4.8 真实数据面直接呈现新 target + 新端口组合"

S4_STRATEGY=$(mysqlc "SELECT IFNULL(strategy,'') FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND revision=$S4_REV ORDER BY id DESC LIMIT 1;")
assert_eq "$S4_STRATEGY" "listener_replace" "S4.9 多字段仍归并为单一 listener_replace rollout"

S4_APPLIED=$(mysqlc "SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S4_APPLIED" "$S4_REV" "S4.10 applied_revision 收敛到唯一新 revision"

# ================================================================
# S5 — update 失败时旧 applied revision 继续运行（§13.3.5 失败规则 1/2）
# ================================================================
echo
echo "---------- S5: 更新失败 → 旧版本继续运行 ----------"
S5_REV_BEFORE=$(cur_rev)
S5_APPLIED_BEFORE=$(cur_applied)
S5_SNAP_BEFORE=$(snapshot_count)
S5_ROLLOUT_BEFORE=$(rollout_count)
S5_PORT_NOW=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
S5_HOST_NOW=$(mysqlc "SELECT IFNULL(remote_host,'') FROM tunnel WHERE id=$FORWARD_ID;")
S5_BEFORE_PROBE=$(wait_probe "$S5_PORT_NOW" "$S4_MARK" || true)
assert_eq "$S5_BEFORE_PROBE" "$S4_MARK" "S5.1 失败前真实数据面走当前 target"

# 真实失败注入：请求一个**已被另一条真实 Forward 占用**的端口。
# 占用者是 setup.sh 阶段 2 用真实 API 创建并 ACK 的 v3 DIRECT(21001) /
# RELAY(21002)。portPool.acquirePort / validateForwardCandidate 会以
# port_taken / port_conflict 拒绝——没有 mock，没有手写 DB 行。
S5_OCCUPIED=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE category='port_forward' AND id<>$FORWARD_ID AND listen_port IS NOT NULL ORDER BY id LIMIT 1;")
assert_nonempty "$S5_OCCUPIED" "S5.2 找到其它 Forward 真实占用的端口 $S5_OCCUPIED（真实占用者）"

S5_STATUS=$(api_patch "{\"listen_port\":$S5_OCCUPIED,\"target_host\":\"$S6_B_HOST\",\"target_port\":3030,\"expected_revision\":$S5_REV_BEFORE}" s5-fail.json)
S5_HTTP_4XX=$( [[ "$S5_STATUS" =~ ^4 ]] && echo yes || echo no )
assert_eq "$S5_HTTP_4XX" "yes" "S5.3 冲突 PATCH 被真实拒绝（HTTP $S5_STATUS）"

S5_CODE=$(jget s5-fail.json "['code']")
assert_nonempty "$S5_CODE" "S5.4 拒绝带机器可读错误码（$S5_CODE）"
case "$S5_CODE" in
  port_conflict|port_taken|conflict|invalid_input|node_unavailable|binding_required) ok "S5.5 错误码属于端口/拓扑冲突族（$S5_CODE）" ;;
  *) bad "S5.5 错误码属于端口/拓扑冲突族 [实得 '$S5_CODE']" ;;
esac

S5_REV_AFTER=$(cur_rev)
S5_APPLIED_AFTER=$(cur_applied)
S5_HOST_AFTER=$(mysqlc "SELECT IFNULL(remote_host,'') FROM tunnel WHERE id=$FORWARD_ID;")
S5_PORT_AFTER=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S5_APPLIED_AFTER" "$S5_APPLIED_BEFORE" "S5.6 失败不改 applied_revision（旧版本仍是当前生效版本）"
assert_eq "$S5_PORT_AFTER" "$S5_PORT_NOW" "S5.7 失败不改 listen_port"
assert_eq "$S5_HOST_AFTER" "$S5_HOST_NOW" "S5.8 失败不改 remote_host"

S5_NO_DONE=$(mysqlc "SELECT COUNT(*) FROM forward_rollout WHERE tunnel_id=$FORWARD_ID AND phase='done' AND revision > $S5_REV_BEFORE;")
assert_eq "$S5_NO_DONE" "0" "S5.9 失败 revision 没有 done rollout 行"

S5_AFTER_PROBE=$(wait_probe "$S5_PORT_AFTER" "$S4_MARK" || true)
assert_eq "$S5_AFTER_PROBE" "$S4_MARK" "S5.10 失败后真实数据面仍走旧 target（业务不中断）"

# 证明是乐观锁/失败而非死锁：正确 revision 的 PATCH 仍能成功。
# 注意：这里必须改一个**真实变化**的字段（target_host 回到 target-a），否则
# patchForward 会算出 metadata/runtime 无变化而走 noop 分支（isMetadataOnlyPatch
# 为 true ⇒ 只更新 name、不写 snapshot、不 bump revision，却仍返回 200）。断言
# 「revision +1」会误判。改 target_host 让恢复编辑是一次真实的 target_hot_swap。
# S4 结束时目标是 target-b，所以这里切到 target-a 才是真实变化。
S5_RECOVER_STATUS=$(api_patch "{\"target_host\":\"target-a\",\"target_port\":3030,\"expected_revision\":$S5_REV_BEFORE}" s5-recover.json)
assert_eq "$S5_RECOVER_STATUS" "200" "S5.11 带正确 expected_revision 的重试成功（非死锁）"
S5_RECOVER_REV=$(jget s5-recover.json "['data']['config_revision']")
assert_eq "$S5_RECOVER_REV" "$((S5_REV_BEFORE + 1))" "S5.12 恢复后 revision 正常前进 1"

S5_RECOVER_MARK=$(wait_probe "$S5_PORT_AFTER" "$MARK_A" || true)
assert_eq "$S5_RECOVER_MARK" "$MARK_A" "S5.13 恢复编辑后数据面真实切到 target-a"

echo "S5_REV_AFTER_RECOVER=$S5_RECOVER_REV" >>"$OUT/rest-state.env"

# ================================================================
# S6 — suspended edit + resume 最新 revision（§13.3.6）
# ================================================================
echo
echo "---------- S6: suspended 编辑 + resume 最新 revision ----------"
S6_REV_BEFORE=$(cur_rev)
S6_APPLIED_BEFORE=$(cur_applied)

S6_SUSPEND_STATUS=$(api_action suspend s6-suspend.json)
assert_eq "$S6_SUSPEND_STATUS" "200" "S6.1 suspend 成功"

S6_SUSPEND_STATUS_VAL=$(jget s6-suspend.json "['data']['apply_status']")
assert_eq "$S6_SUSPEND_STATUS_VAL" "suspended" "S6.2 apply_status=suspended"

# suspend 自身会把 config_revision +1 但**不写 snapshot**（tunnel-api.ts 的
# suspend 分支只 update 投影列）。因此 suspend 之后的真实 revision 必须从**响应体**
# 读，不能用 suspend 前的 cur_rev()——后者会早一个号，后续 expected_revision
# 全部落在旧值上，把脚本自身的时序错误伪装成产品缺陷。
S6_REV_AT_SUSPEND=$(jget s6-suspend.json "['data']['config_revision']")
assert_nonempty "$S6_REV_AT_SUSPEND" "S6.3a suspend 后 config_revision 可从响应体读取"
S6_SNAP_AT_SUSPEND=$(snapshot_count)

S6_PORT_NOW=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
S6_DEAD=$(wait_dead "$S6_PORT_NOW" || true)
assert_eq "$S6_DEAD" "" "S6.3 suspend 后端口 $S6_PORT_NOW 不再接受连接（Agent 已撤 runtime）"

# suspended 期间第一次编辑：只存 desired，不启 runtime。
#
# 注意：edit1 的目标必须与 suspend 前**真实不同**。`patchForward` 的
# `isMetadataOnlyPatch(base, candidate)` 在 mode/ingress/egress/listen_port/
# target_host/target_port 全部相同时返回 true ⇒ 走 metadataOnly 分支：只更新
# name、**不写 snapshot、不 bump revision**，并返回 200 + 未变的 config_revision。
# 这是 §13.3.2 的幂等语义（没东西要改），不是缺陷；但测试若把「目标相同的
# 编辑」当成一次编辑来断言 revision +1，就会把测试自身的设计错误记成产品缺陷。
# 这里用 $S6_B_HOST（与 suspend 前 S5 恢复到的 target-a 不同）保证是真实编辑。
S6_E1_STATUS=$(api_patch "{\"target_host\":\"$S6_B_HOST\",\"target_port\":3030,\"expected_revision\":$S6_REV_AT_SUSPEND}" s6-edit1.json)
assert_eq "$S6_E1_STATUS" "200" "S6.4 suspended 期间第一次 PATCH 成功（保存 desired）"

S6_E1_REV=$(jget s6-edit1.json "['data']['config_revision']")
# 如实记录 edit1 之前的真实库态：若 edit1 没 bump revision，说明它被判为
# metadata-only（§13.3.2 幂等），此时必须能自证原因，而不是只报「5 -> 5」。
S6_E1_BASE=$(mysqlc "SELECT CONCAT_WS('|',IFNULL(remote_host,''),IFNULL(listen_port,0)) FROM tunnel WHERE id=$FORWARD_ID;")
assert_gt "$S6_E1_REV" "$S6_REV_AT_SUSPEND" "S6.5 第一次编辑生成新 revision（$S6_REV_AT_SUSPEND -> $S6_E1_REV，edit1 请求 target=$S6_B_HOST，库上基线=$S6_E1_BASE）"
S6_E1_SNAP_REV=$(mysqlc "SELECT IFNULL(revision,0) FROM forward_revision WHERE tunnel_id=$FORWARD_ID AND revision=$S6_E1_REV;")
assert_nonempty "$S6_E1_SNAP_REV" "S6.5b 第一次编辑真的落了 snapshot 行（revision=$S6_E1_REV）"

S6_E1_APPLIED=$(cur_applied)
assert_eq "$S6_E1_APPLIED" "$S6_APPLIED_BEFORE" "S6.6 第一次编辑后 applied_revision 仍不动（未启 runtime）"

S6_E1_DESIRED=$(mysqlc "SELECT IFNULL(desired_status,'') FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S6_E1_DESIRED" "inactive" "S6.7 suspended 编辑保持 desired_status=inactive"

# suspended 期间第二次编辑：改回 $S6_A_HOST，覆盖第一次，证明不依次 replay 中间 revision。
S6_E2_STATUS=$(api_patch "{\"target_host\":\"$S6_A_HOST\",\"target_port\":3030,\"expected_revision\":$S6_E1_REV}" s6-edit2.json)
assert_eq "$S6_E2_STATUS" "200" "S6.8 suspended 期间第二次 PATCH 成功（覆盖 desired）"

S6_E2_REV=$(jget s6-edit2.json "['data']['config_revision']")
assert_gt "$S6_E2_REV" "$S6_E1_REV" "S6.9 第二次编辑再生成一个新 revision（$S6_E1_REV -> $S6_E2_REV）"

S6_E2_APPLIED=$(cur_applied)
assert_eq "$S6_E2_APPLIED" "$S6_APPLIED_BEFORE" "S6.10 第二次编辑后 applied_revision 仍不动"

S6_LATEST_SNAP=$(mysqlc "SELECT IFNULL(target_host,'') FROM forward_revision WHERE tunnel_id=$FORWARD_ID AND revision=$S6_E2_REV;")
assert_eq "$S6_LATEST_SNAP" "$S6_A_HOST" "S6.12 最新 snapshot 是第二次编辑的目标（非中间态）"

# suspend 自身 bump config_revision 但不写 snapshot ⇒ revision 号会跳过一个。
# 因此断言必须以 snapshot 行数为准（每次编辑恰好一行），不假设 revision 号连续。
S6_SNAP_AFTER=$(snapshot_count)
assert_eq "$((S6_SNAP_AFTER - S6_SNAP_AT_SUSPEND))" "2" "S6.11 suspended 期间共 2 行 snapshot（每次编辑各一行）"

# resume：只应收敛到最新 revision（edit2 = $S6_A_HOST / MARK_A）。
S6_RESUME_STATUS=$(api_action resume s6-resume.json)
assert_eq "$S6_RESUME_STATUS" "200" "S6.13 resume 成功"

S6_RESUME_REV=$(jget s6-resume.json "['data']['config_revision']")
S6_RESUME_APPLIED=$(cur_applied)
assert_eq "$S6_RESUME_APPLIED" "$S6_RESUME_REV" "S6.14 resume 后 applied==config 且就是 resume 时的 revision"

S6_AFTER_MARK=$(wait_probe "$S6_PORT_NOW" "$S6_MARK_A" || true)
assert_eq "$S6_AFTER_MARK" "$S6_MARK_A" "S6.15 resume 后数据面只反映**最后一次**编辑的目标"

# 中间 revision（edit1 = $S6_B_HOST / MARK_B）的目标 marker 不得出现。
S6_LEAK_MARK=$(probe "$S6_PORT_NOW")
assert_ne "$S6_LEAK_MARK" "$S6_MARK_B" "S6.16 中间 revision（第一次编辑）的目标 marker 不出现"

S6_RESUME_DB_PORT=$(mysqlc "SELECT IFNULL(listen_port,0) FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S6_RESUME_DB_PORT" "$S6_PORT_NOW" "S6.17 resume 后端口仍是 suspended 前端口（未做多余 listener 重建）"

S6_RESUME_STATUS_VAL=$(mysqlc "SELECT IFNULL(apply_status,'') FROM tunnel WHERE id=$FORWARD_ID;")
assert_eq "$S6_RESUME_STATUS_VAL" "active" "S6.18 resume 后 apply_status=active"

# ---------------------------------------------------------------- evidence
{
  echo "# TuneX V4-F1 Gate — rest slice Evidence (S3/S4/S5/S6)"
  echo "time: $(date -Is)"
  echo "forward: tunnel=$FORWARD_ID start_listen_port=$FORWARD_PORT start_revision=$BASE_REV"
  echo
  echo "S3 listen_port: $FORWARD_PORT -> $S3_PORT rev=$S3_REV strategy=$S3_STRATEGY new_port_marker=$S3_NEW_PROBE old_port_dead=${S3_DEAD:-yes}"
  echo "S4 multi_field: rev $S4_REV_BEFORE -> $S4_REV (+1) snapshot_row=$S4_ROW marker=$S4_MARK_GOT"
  echo "S5 failure: occupied_by_other=$S5_OCCUPIED http=$S5_STATUS code=$S5_CODE applied_unchanged=$([ "$S5_APPLIED_AFTER" = "$S5_APPLIED_BEFORE" ] && echo yes || echo no) marker=$S5_AFTER_PROBE recover_rev=$S5_RECOVER_REV"
  echo "S6 suspended: rev_before=$S6_REV_BEFORE edits=$S6_E1_REV,$S6_E2_REV resumed_applied=$S6_RESUME_APPLIED marker=$S6_AFTER_MARK"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "TOTAL PASS=$PASS FAIL=$FAIL DEFECT=$DEFECTS"
} >"$OUT/v4-gate-rest-result.txt"

echo "------------------------------------------------------------------"
printf 'V4-GATE-REST TOTAL: \033[1;32mPASS=%d\033[0m \033[1;31mFAIL=%d\033[0m \033[1;35mDEFECT=%d\033[0m evidence=%s\n' "$PASS" "$FAIL" "$DEFECTS" "$OUT/v4-gate-rest-result.txt"
[[ "$FAIL" -eq 0 ]]
